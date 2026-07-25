/**
 * Real-time knowledge admission (issue #1821, Workstream B).
 *
 * `admitCandidate` takes ONE insight candidate all the way into the swarm
 * knowledge store; `drainSessionQueue` runs a bounded batch of them for a live
 * session. Together they close the loop that previously required a phase
 * boundary: a lesson learned at step 3 becomes retrievable at step 40 of the
 * same session.
 *
 * ## The bounding rule (read before touching the await graph)
 *
 * `withTimeout` (`src/utils/timeout.ts`) is a `Promise.race`. A race does NOT
 * cancel the loser. Racing the knowledge-store transaction would therefore be
 * actively harmful: the "timed out" admission keeps running, keeps holding the
 * `.swarm/` directory lock, and the next drain blocks on that lock while the
 * caller has already been told the work finished. So:
 *
 * - the `transactKnowledge` call is NEVER raced or timed out;
 * - only genuinely cancellable work (the optional LLM screening call) is
 *   bounded, via `AbortSignal.timeout(...)` + `isAbortError`, mirroring
 *   `micro-reflector.ts`;
 * - `max_drain_wall_time_ms` is enforced BETWEEN candidates — it stops the
 *   drain from STARTING new work, and never interrupts work in flight.
 *
 * Concurrency uses `p-limit` (an existing dependency, see
 * `src/evaluation/runner.ts`) rather than a hand-rolled limiter.
 */

import pLimit from 'p-limit';
import type { KnowledgeConfig } from '../config/schema.js';
import { isAbortError } from '../hooks/abort-utils.js';
import type { CuratorLLMDelegate } from '../hooks/curator.js';
import { insightCandidateToEntry } from '../hooks/knowledge-curator.js';
import {
	findActiveSwarmNearDuplicate,
	isActiveSwarmKnowledgeEntry,
	reinforceSwarmKnowledgeEntry,
} from '../hooks/knowledge-reinforcement.js';
import {
	resolveSwarmKnowledgePath,
	transactKnowledge,
} from '../hooks/knowledge-store.js';
import type { SwarmKnowledgeEntry } from '../hooks/knowledge-types.js';
import {
	validateActionability,
	validateActionableFields,
} from '../hooks/knowledge-validator.js';
import type { InsightCandidate } from '../hooks/micro-reflector.js';
import {
	insightAdmissionMarker,
	isTaskTool,
	resolveInsightCandidateId,
	unionInsightMarker,
} from '../hooks/micro-reflector.js';
import { warn } from '../utils/logger.js';
import type { QueuedCandidate } from './candidate-queue.js';
import {
	computeArrivalVelocity,
	computeDrainSize,
	getQueueDepth,
	getQueueStats,
	MAX_CANDIDATE_DRAIN_ATTEMPTS,
	recordRetry,
	requeueCandidate,
	reserveLlmBudget,
	takeDrainBatch,
} from './candidate-queue.js';
import type { LearningProvenanceV1 } from './provenance.js';
import { stampLearningProvenance } from './provenance.js';

/** Outcome of a single admission attempt. */
export type AdmissionOutcome = 'admitted' | 'reinforced' | 'rejected';

export interface AdmissionResult {
	outcome: AdmissionOutcome;
	/** Present only for `rejected`, and on the two non-rejected paths for tracing. */
	reason?: string;
	/** Id of the entry created or reinforced. */
	entryId?: string;
	/** The `insight:<id>` marker this candidate is identified by. */
	marker: string;
	/** Validated provenance record for the write. */
	provenance?: LearningProvenanceV1;
}

/** Everything `admitCandidate` needs that is not the candidate itself. */
export interface AdmissionDeps {
	knowledgeConfig: KnowledgeConfig;
	projectName: string;
	/**
	 * Phase recorded in the entry's `confirmed_by`. NOTE: this value is NOT used
	 * for idempotency — the fold-in resolves phase numbers differently across its
	 * five callers, which is exactly why D1 keys on candidate identity instead.
	 */
	phaseNumber: number;
	sessionID?: string;
	/** Optional screening delegate. Absent → admission runs with no LLM call. */
	llmDelegate?: CuratorLLMDelegate;
	/** Per-candidate LLM deadline. 0 or absent disables the bound (and the call). */
	llmTimeoutMs?: number;
	/** Per-session LLM ceilings. Absent → no screening call is made. */
	llmBudget?: { maxLlmCallsPerSession: number; maxTokensPerSession: number };
	/**
	 * Milliseconds left in the enclosing drain's wall-clock budget. Supplied by
	 * `drainSessionQueue` so a screening call can never outlive the budget that
	 * is supposed to bound the whole drain. Absent → unbounded by the drain.
	 */
	remainingBudgetMs?: () => number;
	/** Called after a write actually changed the store — bumps injector caches. */
	onKnowledgeChanged?: () => void;
	/** Injectable clock/path seams for tests. */
	now?: () => number;
	resolveKnowledgePath?: (directory: string) => string;
}

/** Bounded estimate of the tokens one screening call costs. */
const SCREENING_TOKEN_ESTIMATE = 400;

/** Hard cap on the screening prompt, mirroring `MICRO_PROMPT_INPUT_CAP`. */
const SCREENING_PROMPT_CAP = 1200;

/**
 * Union a marker list into an entry's existing `source_knowledge_ids`.
 *
 * `reinforceSwarmKnowledgeEntry` does NOT write `source_knowledge_ids`, so
 * stamping only on the append path would leave every reinforcement unmarked and
 * the fold-in would re-confirm it. Both branches call this.
 */
function unionSourceKnowledgeIds(
	entry: SwarmKnowledgeEntry,
	ids: string[],
): void {
	// Routed through the bounded helper so a long-lived entry reinforced by many
	// distinct candidates cannot grow `source_knowledge_ids` forever — the store's
	// write normalization deliberately skips this field.
	let next = entry.source_knowledge_ids;
	for (const id of ids) next = unionInsightMarker(next, id);
	entry.source_knowledge_ids = next ?? [];
}

/** True when an ACTIVE entry in `entries` already carries `marker`. */
export function findActiveEntryWithMarker(
	entries: SwarmKnowledgeEntry[],
	marker: string,
): SwarmKnowledgeEntry | undefined {
	// The active filter is applied HERE on purpose: callers hand us raw entry
	// arrays (snapshots hold archived/retracted entries too), and only an active
	// entry can have been confirmed by a real admission.
	return entries.find(
		(entry) =>
			isActiveSwarmKnowledgeEntry(entry) &&
			(entry.source_knowledge_ids ?? []).includes(marker),
	);
}

/** Build the bounded ADMIT/REJECT screening prompt. */
export function buildScreeningPrompt(candidate: InsightCandidate): string {
	return [
		'A subagent proposed this durable procedural lesson for the shared knowledge store.',
		'Answer with exactly one word: ADMIT or REJECT.',
		'REJECT when the lesson is task-specific trivia, a transient environment failure, or not generalizable.',
		'',
		`LESSON: ${candidate.lesson}`,
		`CATEGORY: ${candidate.category}`,
		`SCOPE: agents=${(candidate.applies_to_agents ?? []).join(',')} tools=${(
			candidate.applies_to_tools ?? []
		).join(',')}`,
	]
		.join('\n')
		.slice(0, SCREENING_PROMPT_CAP);
}

/**
 * Run the optional screening call under a real cancellation deadline.
 *
 * Returns `true` (admit) when there is no delegate, no budget, or the model
 * answers anything other than REJECT — screening is a filter, not a gate, and
 * must fail OPEN so an LLM outage cannot silently stop all learning.
 * Cancellation propagates to the caller so a timeout is retried rather than
 * being misread as a rejection.
 */
async function screenCandidate(
	candidate: InsightCandidate,
	deps: AdmissionDeps,
): Promise<boolean> {
	const perCandidateMs = deps.llmTimeoutMs ?? 0;
	if (!deps.llmDelegate || perCandidateMs <= 0 || !deps.sessionID) return true;
	if (!deps.llmBudget) return true;
	// The screening deadline is the SMALLER of the per-candidate timeout and the
	// drain's REMAINING wall-clock budget. Without this the drain's budget is
	// unenforceable: it is only checked between candidates, so N candidates each
	// burning a full `per_candidate_llm_timeout_ms` (default 60 s, doubled by the
	// default single retry) would block `tool.execute.after` for minutes while the
	// nominal budget is 10 s. Bounding a CANCELLABLE call this way is safe — it is
	// the knowledge-store transaction that must never be raced.
	const remainingMs = deps.remainingBudgetMs?.() ?? Number.POSITIVE_INFINITY;
	const timeoutMs = Math.min(perCandidateMs, Math.max(0, remainingMs));
	if (timeoutMs <= 0) return true; // no budget left to screen with — admit unscreened
	if (
		!reserveLlmBudget(deps.sessionID, SCREENING_TOKEN_ESTIMATE, deps.llmBudget)
	) {
		// Budget exhausted → admit without screening rather than dropping a lesson.
		return true;
	}
	// Only cancellable work is bounded. AbortSignal.timeout genuinely aborts the
	// underlying request, unlike a Promise.race wrapper.
	const response = await deps.llmDelegate(
		'',
		buildScreeningPrompt(candidate),
		AbortSignal.timeout(timeoutMs),
	);
	return !/\bREJECT\b/i.test(response ?? '');
}

/**
 * Admit one candidate into the swarm knowledge store.
 *
 * Order: shape gate → actionability gate → near-duplicate lookup → reinforce or
 * append, all inside ONE `transactKnowledge` so the dedup decision and the
 * write cannot be separated by a concurrent writer.
 */
export async function admitCandidate(
	directory: string,
	candidate: InsightCandidate,
	deps: AdmissionDeps,
): Promise<AdmissionResult> {
	const candidateId = resolveInsightCandidateId(candidate);
	const marker = insightAdmissionMarker(candidateId);
	const now = deps.now ?? (() => Date.now());

	// Gate 1 — shape. The candidate may have come off disk, so re-apply the same
	// allowlist/length/injection checks the micro-reflector applied at write time.
	const shape = validateActionableFields({
		applies_to_agents: candidate.applies_to_agents,
		applies_to_tools: candidate.applies_to_tools,
		required_actions: candidate.required_actions,
		forbidden_actions: candidate.forbidden_actions,
		verification_checks: candidate.verification_checks,
		triggers: candidate.triggers,
		directive_priority: candidate.directive_priority,
	});
	if (!shape.valid) {
		return { outcome: 'rejected', reason: 'invalid_shape', marker };
	}

	// Gate 2 — Layer-5 actionability. Same floor the curator enforces.
	const actionability = validateActionability({
		applies_to_agents: candidate.applies_to_agents,
		applies_to_tools: candidate.applies_to_tools,
		required_actions: candidate.required_actions,
		forbidden_actions: candidate.forbidden_actions,
		verification_checks: candidate.verification_checks,
	});
	if (!actionability.actionable) {
		return {
			outcome: 'rejected',
			reason: actionability.reason ?? 'unactionable',
			marker,
		};
	}

	// Gate 3 — optional LLM screening. Throws on cancellation; the drain treats
	// that as a retryable outcome rather than a rejection.
	if (!(await screenCandidate(candidate, deps))) {
		return { outcome: 'rejected', reason: 'screened_out', marker };
	}

	const provenance = stampLearningProvenance(
		{
			mechanism:
				candidate.source?.kind === 'prm_pattern'
					? 'prm_pattern'
					: 'micro_reflection',
			sourceKnowledgeIds: [marker],
			sourceTaskIds: candidate.source?.task_id
				? [candidate.source.task_id]
				: [],
			sourceEvidenceRefs: candidate.source_refs ?? [],
		},
		{
			sessionId: deps.sessionID,
			agentRole: candidate.source?.agent,
			producedAt: new Date(now()).toISOString(),
		},
	);

	const knowledgePath = (
		deps.resolveKnowledgePath ?? resolveSwarmKnowledgePath
	)(directory);
	const entry = insightCandidateToEntry(
		candidate,
		deps.projectName,
		deps.phaseNumber,
		deps.knowledgeConfig,
	);
	// Fold the validated provenance into the entry's EXISTING fields. No
	// KnowledgeEntry schema change is involved: `source_knowledge_ids` carries the
	// admission marker, `source_refs` carries the evidence pointers.
	unionSourceKnowledgeIds(entry, provenance.sourceKnowledgeIds);
	if (provenance.sourceEvidenceRefs.length > 0) {
		const refs = new Set([
			...(entry.source_refs ?? []),
			...provenance.sourceEvidenceRefs,
		]);
		entry.source_refs = [...refs];
	}

	let outcome: AdmissionOutcome = 'rejected';
	let reason: string | undefined = 'no_change';
	let entryId: string | undefined;

	// NEVER wrap this in withTimeout — see the module header. A raced transaction
	// keeps the directory lock while the caller believes it finished.
	await transactKnowledge<SwarmKnowledgeEntry>(knowledgePath, (current) => {
		// Idempotency: another admission (or a fold-in) already recorded this exact
		// candidate. Do nothing — re-confirming would inflate confidence.
		if (findActiveEntryWithMarker(current, marker)) {
			outcome = 'rejected';
			reason = 'already_admitted';
			return null;
		}
		const duplicate = findActiveSwarmNearDuplicate(
			entry.lesson,
			current,
			deps.knowledgeConfig.dedup_threshold,
		);
		if (duplicate) {
			const result = reinforceSwarmKnowledgeEntry(duplicate, {
				phase_number: deps.phaseNumber,
				confirmed_at: new Date(now()).toISOString(),
				project_name: deps.projectName,
			});
			// Stamp the marker even when the phase was already confirmed: the goal is
			// to record that THIS candidate has been accounted for, which is true
			// either way, and leaving it unmarked would let the fold-in confirm it
			// again under a different phase number.
			unionSourceKnowledgeIds(duplicate, [marker]);
			outcome = 'reinforced';
			reason = result.reason;
			entryId = duplicate.id;
			return current;
		}
		current.push(entry);
		outcome = 'admitted';
		reason = undefined;
		entryId = entry.id;
		return current;
	});

	if (outcome !== 'rejected') deps.onKnowledgeChanged?.();
	return { outcome, reason, entryId, marker, provenance };
}

/** The subset of a `tool.execute.after` input the drain adapter reads. */
export interface RealtimeAdmissionInput {
	tool: unknown;
	sessionID?: unknown;
}

/**
 * `tool.execute.after` adapter for real-time admission.
 *
 * Called UNCONDITIONALLY from the plugin hook chain and SELF-GATES here, in
 * this order:
 *
 *   1. non-`Task` tool  → return immediately (mirrors `micro-reflector.ts`);
 *   2. feature disabled → return;
 *   3. no session id    → return;
 *   4. empty queue      → return (an O(1) `Map.get(...).length` probe).
 *
 * Only past gate 4 does anything touch the filesystem. This ordering is the
 * contract that keeps the hook off the hot path: it is awaited on EVERY tool
 * call, so the non-`Task` path must cost a single string comparison and
 * perform NO knowledge-store read, write, or lock acquisition.
 *
 * `resolveDeps` is a FACTORY, not a value, so resolving the plan (project name
 * and phase number) happens only after all four gates pass.
 */
export async function realtimeAdmissionAfter(
	directory: string,
	input: RealtimeAdmissionInput,
	config: RealtimeAdmissionConfig | undefined,
	resolveDeps: () => AdmissionDeps | Promise<AdmissionDeps>,
): Promise<DrainSummary | undefined> {
	if (!isTaskTool(input.tool)) return undefined;
	if (!config?.enabled) return undefined;
	const sessionID =
		typeof input.sessionID === 'string' && input.sessionID.length > 0
			? input.sessionID
			: undefined;
	if (!sessionID) return undefined;
	if (getQueueDepth(sessionID) === 0) return undefined;
	const deps = await resolveDeps();
	return drainSessionQueue(directory, sessionID, config, deps);
}

/** Per-drain tallies. */
export interface DrainSummary {
	attempted: number;
	admitted: number;
	reinforced: number;
	rejected: number;
	/** Candidates put back because the wall-clock budget ran out first. */
	deferred: number;
	/** Candidates abandoned after exhausting their retry budget. */
	failed: number;
	retries: number;
}

function emptySummary(): DrainSummary {
	return {
		attempted: 0,
		admitted: 0,
		reinforced: 0,
		rejected: 0,
		deferred: 0,
		failed: 0,
		retries: 0,
	};
}

/** `learning.realtime_admission`, as consumed by the drain. */
export type RealtimeAdmissionConfig = {
	enabled: boolean;
	max_queue_size: number;
	min_drain: number;
	max_drain: number;
	drain_depth_factor: number;
	drain_velocity_factor: number;
	max_llm_calls_per_session: number;
	max_tokens_per_session: number;
	max_concurrent_admissions: number;
	max_retries_per_candidate: number;
	per_candidate_llm_timeout_ms: number;
	max_drain_wall_time_ms: number;
	supersede_nudge: boolean;
};

/**
 * Drain a bounded, adaptively-sized batch of a session's pending candidates.
 *
 * Bounds, in the order they apply:
 *   1. `computeDrainSize` caps how many candidates are claimed at all;
 *   2. `p-limit` caps how many run concurrently;
 *   3. `max_retries_per_candidate` caps rework per candidate;
 *   4. `max_drain_wall_time_ms` stops NEW candidates from starting.
 *
 * Never throws: a drain is best-effort background work behind a live tool call.
 */
export async function drainSessionQueue(
	directory: string,
	sessionID: string,
	config: RealtimeAdmissionConfig,
	deps: AdmissionDeps,
): Promise<DrainSummary> {
	const summary = emptySummary();
	if (!config.enabled) return summary;
	const now = deps.now ?? (() => Date.now());

	const stats = getQueueStats(sessionID);
	if (stats.depth === 0) return summary;

	const velocity = computeArrivalVelocity(stats, now());
	const size = computeDrainSize(stats.depth, velocity, {
		minDrain: config.min_drain,
		maxDrain: config.max_drain,
		drainDepthFactor: config.drain_depth_factor,
		drainVelocityFactor: config.drain_velocity_factor,
	});
	if (size <= 0) return summary;

	const batch = takeDrainBatch(sessionID, size);
	if (batch.length === 0) return summary;
	summary.attempted = batch.length;

	const startedAt = now();
	const wallTimeMs = Math.max(0, Number(config.max_drain_wall_time_ms) || 0);
	const deadline =
		wallTimeMs > 0 ? startedAt + wallTimeMs : Number.POSITIVE_INFINITY;
	const budgetExhausted = (): boolean => now() >= deadline;

	const maxRetries = Math.max(
		0,
		Math.floor(Number(config.max_retries_per_candidate) || 0),
	);
	const limit = pLimit(
		Math.max(1, Math.floor(Number(config.max_concurrent_admissions) || 1)),
	);

	const admissionDeps: AdmissionDeps = {
		...deps,
		sessionID,
		llmTimeoutMs:
			config.max_llm_calls_per_session > 0
				? (deps.llmTimeoutMs ?? config.per_candidate_llm_timeout_ms)
				: 0,
		llmBudget: deps.llmBudget ?? {
			maxLlmCallsPerSession: config.max_llm_calls_per_session,
			maxTokensPerSession: config.max_tokens_per_session,
		},
		remainingBudgetMs: () => deadline - now(),
	};

	/**
	 * Put a candidate back for the next drain, or abandon it once it has been
	 * claimed `MAX_CANDIDATE_DRAIN_ATTEMPTS` times. `takeDrainBatch` stamps
	 * `attempts`, so a session whose wall-clock budget always expires cannot
	 * bounce the same candidate between drains forever.
	 */
	const deferOrAbandon = (item: QueuedCandidate): void => {
		if (item.attempts >= MAX_CANDIDATE_DRAIN_ATTEMPTS) {
			summary.failed++;
			warn(
				`[learning-admission] candidate abandoned after ${item.attempts} drain attempt(s) without completing`,
			);
			return;
		}
		requeueCandidate(sessionID, item, { maxQueueSize: config.max_queue_size });
		summary.deferred++;
	};

	await Promise.all(
		batch.map((item) =>
			limit(async () => {
				// Wall-clock check happens HERE, before any work starts for this
				// candidate — never mid-flight. A deferred candidate goes back to the
				// front of the queue and is retried by the next drain.
				if (budgetExhausted()) {
					deferOrAbandon(item);
					return;
				}
				for (let attempt = 0; ; attempt++) {
					try {
						const result = await admitCandidate(
							directory,
							item.candidate,
							admissionDeps,
						);
						if (result.outcome === 'admitted') summary.admitted++;
						else if (result.outcome === 'reinforced') summary.reinforced++;
						else summary.rejected++;
						return;
					} catch (err) {
						// A cancelled screening call and a transport blip are both
						// retryable; anything past the retry budget is abandoned so the
						// queue cannot spin on a permanently failing candidate.
						if (attempt >= maxRetries) {
							// Retries exhausted for THIS drain. Hand the candidate back to
							// the queue rather than dropping it: the dominant failure here
							// is a transient `ELOCKED` from the shared `.swarm/` directory
							// lock (proper-lockfile gives up after ~1.7 s), which a later
							// drain will sail through. `deferOrAbandon` still enforces
							// MAX_CANDIDATE_DRAIN_ATTEMPTS, so a permanently failing
							// candidate is abandoned rather than looping forever.
							warn(
								`[learning-admission] candidate failed after ${
									attempt + 1
								} attempt(s): ${
									isAbortError(err)
										? 'cancelled'
										: err instanceof Error
											? err.message
											: String(err)
								}`,
							);
							deferOrAbandon(item);
							return;
						}
						summary.retries++;
						recordRetry(sessionID);
						// A retry is NEW work — re-check the wall clock before starting it.
						if (budgetExhausted()) {
							deferOrAbandon(item);
							return;
						}
					}
				}
			}),
		),
	);

	return summary;
}
