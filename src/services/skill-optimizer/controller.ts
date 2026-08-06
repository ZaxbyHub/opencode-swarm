/**
 * Serial controller (Workstream C, issue #1822).
 *
 * One project run + one target skill at a time, enforced by a cross-process
 * lock with a stale-lock policy (inherited from `file-locks.ts` — 5 min stale
 * TTL). The round flow:
 *
 *   acquireRunLock (project-wide) → acquireSkillLock (<slug>)
 *     → freeze baseline (contentHash + snapshot)
 *     → deterministic seed (Workstream A)
 *     → draft constrained candidate (Workstream B)
 *     → static smoke → smoke_validated
 *     → evaluateCandidateV1 (split:'test') → validation_running
 *       → decision.status → accepted_pending_approval | rejected | inconclusive
 *   release (reverse order)
 *
 * Caps (enforced): max_rounds (draft/smoke retries before a validation),
 * max_transient_retries (infra-retries before inconclusive), deadband
 * (forwarded to the promotion policy), convergence_non_improvements (K
 * draft/smoke non-progress stops). A completed validation (accept/reject/
 * inconclusive) is terminal — the held-out set is single-use. Not enforced in
 * v1: max_candidates_per_round (one candidate per round), max_tokens_per_round
 * /spend accounting, a wall-clock round timer (max_round_time_ms is forwarded
 * only as a per-task validation timeout), max_rejections and
 * max_inconclusive_rounds (declared in the schema for forward-compatibility
 * with a future multi-validation loop, but unused now that a single run
 * performs at most one validation).
 *
 * Transient infra failures → inconclusive with bounded retry
 * (`max_transient_retries`, default 5) BEFORE counting as a rejection.
 * Non-transient failures → hard stop + `telemetry.loopDetected` + a
 * `NON-TRANSIENT STOP` advisory (does NOT mutate the active skill).
 *
 * A test-set result NEVER auto-generates a round — `claimHeldOutTest`
 * (`split:'test'`) throws `TestAlreadyConsumedError` on reuse. A single `run`
 * therefore performs AT MOST ONE validation; draft/smoke retries are the only
 * looped steps, and a completed validation (accept/reject/inconclusive) stops
 * the loop. A re-test requires a fresh task set, i.e. a new `run`.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import type { SkillOptConfig } from '../../config/schema.js';
import type {
	EvaluationCandidateV1,
	EvaluationRunV1,
	PromotionDecisionV1,
} from '../../evaluation/contracts.js';
import type { EvaluationModelDispatcher } from '../../evaluation/model-dispatcher.js';
import { evaluateCandidateV1 } from '../../evaluation/public-api.js';
import { tryAcquireLock } from '../../parallel/file-locks.js';
import { emit as emitTelemetry } from '../../telemetry.js';
import {
	buildGeneratorInputs,
	draftCandidate,
	type GeneratorInputs,
} from './candidates.js';
import { deterministicSeed } from './deterministic-seed.js';
import { currentCandidateState, recordTransition } from './lifecycle.js';
import { readIncumbentContent, validateSkillSmoke } from './smoke.js';
import { computeContentHash, mintCandidateId, writeArtifact } from './store.js';

const PROJECT_LOCK_PATH = path.join(
	'.swarm',
	'evolution',
	'skills',
	'.run.lock',
);
const CONVERGENCE_FILE = path.join(
	'.swarm',
	'evolution',
	'skills',
	'.convergence.json',
);

export type Origin = 'command:skill-opt:run' | 'command:skill-opt:plan';

export interface RunRoundInput {
	directory: string;
	skillSlug: string;
	config: SkillOptConfig;
	/** Caller's session ID (for telemetry). */
	sessionId?: string;
	/** Evaluation dispatcher from CommandContext.evaluationModelDispatcher. */
	dispatcher?: EvaluationModelDispatcher;
	/** Model IDs to evaluate against. */
	models: string[];
	/** Evidence to seed the draft (if absent, the deterministic seed is used). */
	seedEvidence?: GeneratorInputs['eligibleEvidence'];
	/** Held-out task IDs the generator must not see (leakage defense). */
	claimedTestTaskIds?: ReadonlySet<string>;
	/** Test task fixtures for validation (assembled by the command layer). */
	validationTasks: unknown[];
	/**
	 * The root directory the evaluation substrate resolves task paths against
	 * (instructionPath, environment.path, scorer argv). This is where the
	 * command layer materialized the fixture files — NOT the project root.
	 * (F1 fix: previously the controller passed input.directory, causing
	 * file-not-found on every real validation.)
	 */
	inputRoot: string;
	/** Baseline + candidate EvaluationCandidateV1 builders are derived from content. */
	baselineModel: string;
	candidateModel: string;
	/** AbortSignal for cooperative cancellation. */
	abortSignal?: AbortSignal;
	/** Origin for lifecycle events. */
	origin: Origin;
	/** Dry-run: if true, plan only, do not execute validation. */
	dryRun?: boolean;
}

export interface RunRoundResult {
	candidateId: string;
	decidedState: string;
	decision?: PromotionDecisionV1;
	run?: EvaluationRunV1;
	stopped: boolean;
	stopReason?: string;
	error?: string;
	/** True when a non-transient validation failure hard-stopped this round.
	 * The optimization loop must stop immediately (AGENTS.md invariant #9). */
	hardStop?: boolean;
}

/** DI seam for lock + telemetry injection (AGENTS.md invariant #7). */
export const _internals = {
	tryAcquireLock,
	emitTelemetry,
	evaluateCandidateV1,
};

/**
 * Acquire the project-wide run lock. Returns a release function or null if the
 * lock is held (caller surfaces a `locked` JSON error). Stale locks are cleaned
 * by proper-lockfile after the 5-min TTL.
 */
async function acquireProjectLock(
	directory: string,
): Promise<(() => Promise<void>) | null> {
	const result = await _internals.tryAcquireLock(
		directory,
		PROJECT_LOCK_PATH,
		'skill-opt-controller',
		'project-run',
	);
	if (!result.acquired) return null;
	return async () => {
		if (result.lock._release) {
			try {
				await result.lock._release();
			} catch {
				// Release failure is non-fatal; proper-lockfile TTL cleans up.
			}
		}
	};
}

async function acquireSkillLock(
	directory: string,
	skillSlug: string,
): Promise<(() => Promise<void>) | null> {
	const lockPath = path.join(
		'.swarm',
		'evolution',
		'skills',
		skillSlug,
		'.skill.lock',
	);
	const result = await _internals.tryAcquireLock(
		directory,
		lockPath,
		'skill-opt-controller',
		`skill-${skillSlug}`,
	);
	if (!result.acquired) return null;
	return async () => {
		if (result.lock._release) {
			try {
				await result.lock._release();
			} catch {
				// non-fatal
			}
		}
	};
}

/** Execute a single optimization round for one skill. */
export async function runOptimizationRound(
	input: RunRoundInput,
): Promise<RunRoundResult> {
	const candidateId = mintCandidateId();

	// 1. Acquire locks in documented order: project-wide FIRST, then per-skill.
	//    Release in REVERSE order (critic M6).
	const releaseProject = await acquireProjectLock(input.directory);
	if (!releaseProject) {
		return {
			candidateId,
			decidedState: 'discovered',
			stopped: true,
			stopReason: 'project-run-locked',
		};
	}
	const releaseSkill = await acquireSkillLock(input.directory, input.skillSlug);
	if (!releaseSkill) {
		await releaseProject();
		return {
			candidateId,
			decidedState: 'discovered',
			stopped: true,
			stopReason: `skill-locked:${input.skillSlug}`,
		};
	}

	try {
		return await runRoundLocked(input, candidateId);
	} finally {
		// Release in reverse order.
		await releaseSkill();
		await releaseProject();
	}
}

async function runRoundLocked(
	input: RunRoundInput,
	candidateId: string,
): Promise<RunRoundResult> {
	const incumbent = readIncumbentContent(input.directory, input.skillSlug);
	const baselineHash = computeContentHash(incumbent);

	// discovered → drafted
	await recordTransition({
		directory: input.directory,
		skillSlug: input.skillSlug,
		candidateId,
		toState: 'discovered',
		eventType: 'discover',
		actor: input.sessionId ?? 'unknown',
		origin: input.origin,
		reason: 'optimization round started',
		contentHashBefore: baselineHash,
		contentHashAfter: baselineHash,
	});

	// Freeze baseline snapshot.
	writeArtifact(
		input.directory,
		input.skillSlug,
		candidateId,
		'baseline.md',
		incumbent,
	);

	// Deterministic seed (Workstream A) + constrained draft (Workstream B).
	const seed =
		input.seedEvidence !== undefined
			? input.seedEvidence
			: (await deterministicSeed({ directory: input.directory })).evidence;
	const counterexamples: string[] = []; // sourced from the rejection ledger by the command layer if available
	const generatorInputs = buildGeneratorInputs({
		baselineContent: incumbent,
		eligibleEvidence: seed,
		counterexamples,
		budget: input.config,
		claimedTestTaskIds: input.claimedTestTaskIds ?? new Set(),
	});
	const candidate = draftCandidate(generatorInputs);

	// discovered → drafted (the draft step always runs; equivalence is decided
	// from the drafted state). Persist the Workstream B artifact metadata
	// (metric + risks) in the event payload (final critic FI7).
	await recordTransition({
		directory: input.directory,
		skillSlug: input.skillSlug,
		candidateId,
		toState: 'drafted',
		eventType: 'draft',
		actor: input.sessionId ?? 'unknown',
		origin: input.origin,
		reason: candidate.rationale,
		contentHashBefore: baselineHash,
		contentHashAfter: computeContentHash(candidate.content),
		payload: {
			metric: candidate.metric,
			risks: candidate.risks,
			diffSummary: candidate.diffSummary,
		},
	});

	// Equivalent-patch stop: if the draft equals the baseline, stop convergence.
	if (candidate.content === incumbent) {
		await recordTransition({
			directory: input.directory,
			skillSlug: input.skillSlug,
			candidateId,
			toState: 'rejected',
			eventType: 'equivalent-patch',
			actor: input.sessionId ?? 'unknown',
			origin: input.origin,
			reason: 'drafted candidate is identical to baseline (convergence)',
			contentHashBefore: baselineHash,
			contentHashAfter: computeContentHash(candidate.content),
		});
		return {
			candidateId,
			decidedState: 'rejected',
			stopped: true,
			stopReason: 'equivalent-patch',
		};
	}

	writeArtifact(
		input.directory,
		input.skillSlug,
		candidateId,
		'candidate.md',
		candidate.content,
	);

	if (input.dryRun) {
		return {
			candidateId,
			decidedState: 'drafted',
			stopped: false,
			stopReason: 'dry-run',
		};
	}

	// drafted → smoke_validated
	const smoke = await validateSkillSmoke({
		directory: input.directory,
		skillSlug: input.skillSlug,
		candidateContent: candidate.content,
		incumbentContent: incumbent,
	});
	if (!smoke.ok) {
		await recordTransition({
			directory: input.directory,
			skillSlug: input.skillSlug,
			candidateId,
			toState: 'rejected',
			eventType: 'smoke-failed',
			actor: input.sessionId ?? 'unknown',
			origin: input.origin,
			reason: smoke.notes.join('; '),
			contentHashBefore: baselineHash,
			contentHashAfter: computeContentHash(candidate.content),
		});
		return {
			candidateId,
			decidedState: 'rejected',
			stopped: false,
			stopReason: `smoke:${smoke.verdict}`,
		};
	}
	await recordTransition({
		directory: input.directory,
		skillSlug: input.skillSlug,
		candidateId,
		toState: 'smoke_validated',
		eventType: 'smoke-passed',
		actor: input.sessionId ?? 'unknown',
		origin: input.origin,
		reason: smoke.notes.join('; '),
		contentHashBefore: baselineHash,
		contentHashAfter: computeContentHash(candidate.content),
	});

	// smoke_validated → validation_running
	await recordTransition({
		directory: input.directory,
		skillSlug: input.skillSlug,
		candidateId,
		toState: 'validation_running',
		eventType: 'validation-start',
		actor: input.sessionId ?? 'unknown',
		origin: input.origin,
		reason: 'PR1 validation via evaluateCandidateV1 (split:test)',
		contentHashBefore: baselineHash,
		contentHashAfter: computeContentHash(candidate.content),
	});

	// Assemble the substrate inputs and run validation with bounded transient retry.
	const decision = await runValidationWithTransientRetry(
		input,
		candidate.content,
		incumbent,
	);

	const toState =
		decision.status === 'accept'
			? 'accepted_pending_approval'
			: decision.status === 'reject'
				? 'rejected'
				: 'inconclusive';

	await recordTransition({
		directory: input.directory,
		skillSlug: input.skillSlug,
		candidateId,
		toState,
		eventType: `validation-${decision.status}`,
		actor: input.sessionId ?? 'unknown',
		origin: input.origin,
		reason: decision.reasons.join('; '),
		contentHashBefore: baselineHash,
		contentHashAfter: computeContentHash(candidate.content),
		evidenceRefs: decision.runId ? [decision.runId] : [],
		payload: {
			deadband: decision.deadband,
			baselineRunId: decision.baselineRunId,
			historicalBestRunId: decision.historicalBestRunId,
		},
	});

	return {
		candidateId,
		decidedState: toState,
		decision: decision.raw,
		run: decision.run,
		stopped: toState === 'rejected' || toState === 'inconclusive',
		stopReason: `decision:${decision.status}`,
		hardStop: decision.hardStop === true,
	};
}

interface ValidationOutcome {
	status: 'accept' | 'reject' | 'inconclusive';
	reasons: string[];
	deadband: number;
	runId?: string;
	baselineRunId?: string;
	historicalBestRunId?: string;
	raw?: PromotionDecisionV1;
	run?: EvaluationRunV1;
	/** True when a non-transient failure caused this outcome — the loop must
	 * stop immediately rather than retry (AGENTS.md invariant #9 hard stop). */
	hardStop?: boolean;
}

/**
 * Run validation with bounded transient retry. Transient infra failures
 * (timeouts, infra failures) retry up to `max_transient_retries` (default 5)
 * BEFORE becoming `inconclusive`. Non-transient failures hard-stop.
 */
async function runValidationWithTransientRetry(
	input: RunRoundInput,
	candidateContent: string,
	baselineContent: string,
): Promise<ValidationOutcome> {
	let transientRetries = 0;
	const maxRetries = input.config.max_transient_retries;
	while (true) {
		try {
			const baseline: EvaluationCandidateV1 = {
				v: 1,
				id: `${input.skillSlug}-baseline`,
				kind: 'skill',
				payloadPath: 'baseline.md',
				model: input.baselineModel,
				contentHash: computeContentHash(baselineContent),
			};
			const candidate: EvaluationCandidateV1 = {
				v: 1,
				id: `${input.skillSlug}-candidate-${randomUUID().slice(0, 8)}`,
				kind: 'skill',
				payloadPath: 'candidate.md',
				model: input.candidateModel,
				contentHash: computeContentHash(candidateContent),
			};
			if (!input.dispatcher) {
				throw new Error(
					'no evaluation dispatcher available (cannot run validation)',
				);
			}
			// Note: validationTasks are validated/typed at the command layer. Here we
			// trust the command layer passed valid EvaluationTaskV1[] for split:'test'.
			const { createModelEvaluationExecutor } = await import(
				'../../evaluation/runner.js'
			);
			const executor = createModelEvaluationExecutor(
				input.dispatcher,
				input.sessionId,
			);
			const result = await _internals.evaluateCandidateV1({
				projectRoot: input.directory,
				inputRoot: input.inputRoot,
				tasks: input.validationTasks as never,
				baseline,
				candidate,
				split: 'test',
				seed: randomUUID(),
				models: input.models,
				budgets: {
					maxTasks: input.config.max_validations_per_round * 6,
					maxRepetitions: 1,
					maxConcurrency: 1,
					maxTaskTimeMs: input.config.max_round_time_ms,
					maxRetries: input.config.max_transient_retries,
					maxOutputBytes: 512 * 1024,
				},
				executor,
				abortSignal: input.abortSignal,
				policy: { deadband: input.config.deadband },
			});
			return {
				status: result.decision.status,
				reasons: result.decision.reasons,
				deadband: result.decision.deadband,
				runId: result.run.runId,
				baselineRunId: result.decision.lineage.baselineRunId,
				historicalBestRunId: result.decision.lineage.historicalBestRunId,
				raw: result.decision,
				run: result.run,
			};
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			const errName = err instanceof Error ? err.name : '';
			// TestAlreadyConsumedError: the held-out task set was already claimed by
			// a prior validation. This is NOT transient (it will never succeed on
			// retry with the same set) and NOT a non-transient hard-stop fault — it
			// is a TERMINAL inconclusive. The caller must mint a fresh task set
			// (a new candidate) to re-test. This enforces the issue's "test-set
			// result cannot generate another round" invariant without mislabeling
			// the collision as a hard-stop fault (final critic FC2).
			if (
				errName === 'TestAlreadyConsumedError' ||
				message.includes('TestAlreadyConsumed') ||
				message.includes('test-already-consumed')
			) {
				return {
					status: 'inconclusive',
					reasons: [
						`held-out-test-set-already-consumed: ${message.slice(0, 160)}`,
					],
					deadband: input.config.deadband,
				};
			}
			const isTransient =
				message.includes('timeout') ||
				message.includes('infrastructure_failure') ||
				message.includes('temporarily unavailable') ||
				message.includes('503') ||
				message.includes('429');
			if (isTransient && transientRetries < maxRetries) {
				transientRetries++;
				await new Promise((r) => setTimeout(r, 200 * 2 ** transientRetries));
				continue;
			}
			if (isTransient) {
				// Exhausted transient retries → inconclusive (does NOT mutate skill).
				return {
					status: 'inconclusive',
					reasons: [
						`transient-infra-failure-after-${transientRetries}-retries: ${message.slice(0, 160)}`,
					],
					deadband: input.config.deadband,
				};
			}
			// Non-transient → hard stop. Emit telemetry + advisory; do not mutate skill.
			// Reuses the existing 'loop_detected' event (AGENTS.md invariant #9:
			// a non-transient hard stop emits telemetry.loopDetected).
			_internals.emitTelemetry?.('loop_detected', {
				skillSlug: input.skillSlug,
				reason: message.slice(0, 160),
				source: 'skill-opt-controller',
			});
			return {
				status: 'inconclusive',
				reasons: [`non-transient-hard-stop: ${message.slice(0, 160)}`],
				deadband: input.config.deadband,
				hardStop: true,
			};
		}
	}
}

/** Read convergence state (non-improvement count) for the K-stop check. */
export function readConvergenceState(directory: string): {
	nonImprovements: number;
} {
	const file = path.join(directory, CONVERGENCE_FILE);
	if (!existsSync(file)) return { nonImprovements: 0 };
	try {
		return JSON.parse(readFileSync(file, 'utf8')) as {
			nonImprovements: number;
		};
	} catch {
		return { nonImprovements: 0 };
	}
}

/** Update convergence state after a round. */
export function writeConvergenceState(
	directory: string,
	nonImprovements: number,
): void {
	const dir = path.dirname(path.join(directory, CONVERGENCE_FILE));
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(
		path.join(directory, CONVERGENCE_FILE),
		JSON.stringify({ nonImprovements }),
		'utf8',
	);
}

export interface OptimizationLoopResult {
	rounds: RunRoundResult[];
	stopped: boolean;
	stopReason: string;
}

/**
 * Drive optimization rounds until a cap or stop condition is hit (reviewer CR3).
 *
 * IMPORTANT — held-out test set is single-use (final critic FC2): a validation
 * call consumes the `split:'test'` task set (`claimHeldOutTest` throws
 * `TestAlreadyConsumedError` on reuse). Therefore a single `run` performs AT
 * MOST ONE validation; the loop's rounds are draft-and-smoke retries that can
 * loop without consuming the held-out set (equivalent-patch, smoke-fail,
 * draft-fail). Once a round reaches validation (accept/reject/inconclusive),
 * the loop STOPS — a re-validation requires a fresh task set, i.e. a new `run`.
 *
 * Caps + stop conditions (all from `config`):
 *   - `max_rounds`: hard cap on draft-and-smoke retries before a validation.
 *   - `convergence_non_improvements`: K consecutive non-accept results stops.
 *   - any non-transient hard stop, equivalent-patch, lock, or completed
 *     validation stops immediately.
 *
 * Each round is a fresh candidate (mintCandidateId inside runOptimizationRound).
 * A test-set result NEVER auto-generates a round — only this explicit loop does.
 */
export async function runOptimizationLoop(
	input: RunRoundInput,
): Promise<OptimizationLoopResult> {
	const rounds: RunRoundResult[] = [];
	let nonImprovements = readConvergenceState(input.directory).nonImprovements;

	for (let round = 0; round < input.config.max_rounds; round++) {
		const result = await runOptimizationRound(input);
		rounds.push(result);

		// Immediate stops.
		if (result.stopReason === 'equivalent-patch') {
			writeConvergenceState(input.directory, ++nonImprovements);
			return {
				rounds,
				stopped: true,
				stopReason: 'equivalent-patch-convergence',
			};
		}
		if (
			result.stopReason?.startsWith('skill-locked') ||
			result.stopReason === 'project-run-locked'
		) {
			return { rounds, stopped: true, stopReason: result.stopReason };
		}
		if (result.stopReason?.startsWith('smoke:')) {
			// Smoke failure did not consume the held-out set — retry drafting.
			writeConvergenceState(input.directory, ++nonImprovements);
			if (nonImprovements >= input.config.convergence_non_improvements) {
				return {
					rounds,
					stopped: true,
					stopReason: `convergence-non-improvements:${nonImprovements}`,
				};
			}
			continue;
		}
		// Non-transient hard stop → stop immediately (AGENTS.md invariant #9).
		if (result.hardStop) {
			return { rounds, stopped: true, stopReason: 'non-transient-hard-stop' };
		}

		// A completed validation (accept/reject/inconclusive) consumed the
		// held-out set. The loop STOPS here — re-validation needs a fresh task
		// set (a new `run`). This is the honest v1 contract: one validation
		// per run; draft/smoke retries are the only looped steps.
		if (
			result.decidedState === 'accepted_pending_approval' ||
			result.decidedState === 'rejected' ||
			result.decidedState === 'inconclusive'
		) {
			if (result.decidedState !== 'accepted_pending_approval') {
				writeConvergenceState(input.directory, ++nonImprovements);
			} else {
				nonImprovements = 0;
				writeConvergenceState(input.directory, nonImprovements);
			}
			return {
				rounds,
				stopped: true,
				stopReason:
					result.decidedState === 'accepted_pending_approval'
						? 'accepted-pending-approval'
						: `validation-terminal:${result.decidedState}`,
			};
		}
	}

	return {
		rounds,
		stopped: true,
		stopReason: `max-rounds:${input.config.max_rounds}`,
	};
}

/** Re-export current state helper for the command layer. */
export { currentCandidateState };
