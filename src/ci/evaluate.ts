/**
 * Host-decoupled advisory gate evaluation (issue #2497).
 *
 * Composes the EXISTING authoritative readers — never a reimplementation —
 * to answer "did this checked-out repo's swarm work satisfy its gates?" with
 * honest per-check dispositions (pass / fail / no_data / corrupt / error per
 * the #2470 tri-state evidence semantics; "no data" is NEVER a pass).
 *
 * Read classes (empirically verified against the repo's readers):
 *  - Direct file reads on the evaluated directory: `loadPlanJsonOnly`
 *    (pure parse), `readTaskEvidenceState` / `deriveRequiredGates` /
 *    `hasPassedAllGates` (pure `.swarm/evidence` reads), `loadEvidence` /
 *    `listEvidenceTaskIds` (pure bundle reads), and the shared
 *    evidence-quality computation in `src/ci/quality-checks.ts`.
 *  - Shadow-copy reads: `isPlanCriticApproved` and
 *    `getProfileLookupForIdentity` are mediated by the ledger/profile SQLite
 *    store; opening it creates WAL sidecars (and may run the legacy-jsonl
 *    import), which would MUTATE the evaluated repo. They therefore run
 *    against a discarded temp copy of `.swarm/` so the advisory run is
 *    strictly read-only for the repo (frozen check C7). The copy is bounded
 *    and removed in cleanup.
 *
 * Host-decoupling contract: no host client handle, no live plugin session
 * state, no subprocess, no config load — a scrubbed CI environment
 * (env -i, no TTY, no opencode binary) is the supported operating mode.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { closeProjectDb } from '../db/project-db.js';
import {
	DEFAULT_QA_GATES,
	getEffectiveGates,
	getProfileLookupForIdentity,
	type QaGates,
} from '../db/qa-gate-profile.js';
import {
	deriveRequiredGates,
	readTaskEvidenceState,
} from '../gate-evidence.js';
import { isPlanCriticApproved } from '../hooks/delegation-gate.js';
import { loadPlanJsonOnly } from '../plan/manager.js';
import { invalidateCachedArtifact } from '../utils/swarm-artifact-cache.js';
import {
	CI_QUALITY_THRESHOLDS,
	computeEvidenceQualitySummary,
} from './quality-checks.js';

/** Workflow snapshot states that count as terminal success for a task.
 * Derived from WORKFLOW_STATE_RANK in src/gate-evidence.ts, where
 * 'complete' (8) and 'closed' (7) are the only terminal-success ranks; any
 * other state (rework_required, reviewer_run, coder_delegated, ...) means
 * the task is not demonstrably finished and must not pass vacuously. */
export const TERMINAL_SUCCESS_STATES = ['complete', 'closed'] as const;

/** Upper bound for the `.swarm/` shadow copy. A repo whose durable state is
 * larger than this skips the DB-mediated reads (reported as not_evaluable)
 * rather than copying unbounded data into a temp dir. */
export const MAX_SHADOW_COPY_BYTES = 512 * 1024 * 1024;

/** Maximum number of filesystem entries examined by one shadow-copy census. */
export const MAX_SHADOW_COPY_ENTRIES = 100_000;

export type AdvisoryCiGateStatus =
	| 'pass'
	| 'fail'
	| 'no_data'
	| 'corrupt'
	| 'error';

export interface AdvisoryCiGateRow {
	name: string;
	status: AdvisoryCiGateStatus;
	detail?: string;
}

export interface AdvisoryCiTaskEntry {
	task_id: string;
	evidence_state: 'valid' | 'missing' | 'corrupt' | 'error';
	required_gates: string[];
	missing_gates: string[];
	workflow_state?: string;
	satisfied: boolean;
}

export interface AdvisoryCiReport {
	version: 1;
	verdict: 'pass' | 'fail';
	/** Evaluation exits come from the runtime; `cancelled`/`deadline`/`error`
	 * are emitted by the command layer when evaluation never completed, so
	 * every `version: 1` payload shares one shape regardless of exit code. */
	exit_reason:
		| 'all_gates_passed'
		| 'plan_missing'
		| 'plan_corrupt'
		| 'no_tasks'
		| 'gate_violations'
		| 'cancelled'
		| 'deadline'
		| 'error';
	gates: AdvisoryCiGateRow[];
	tasks: AdvisoryCiTaskEntry[];
	plan: {
		present: boolean;
		title?: string;
		swarm?: string;
		task_count: number;
	};
	environment: {
		mode: 'advisory';
		tty: boolean;
		host: 'none';
	};
	gate_profile: 'default' | 'profile';
	effective_gates: QaGates;
	/** Enabled gates that have no durable whole-plan reader are listed here
	 * rather than silently omitted or vacuously passed. */
	not_evaluated: Array<{ name: string; reason: string }>;
	/** Checks that cannot be evaluated headless (live plugin state). */
	not_evaluable: Array<{ name: string; reason: string }>;
	counts: {
		pass: number;
		fail: number;
		no_data: number;
		corrupt: number;
		error: number;
	};
}

export interface EvaluateAdvisoryCiOptions {
	directory: string;
	/** Captured once before any output; the report channel is stdout. */
	tty: boolean;
	journal?: (type: string, detail?: string) => void;
	registerCleanup?: (fn: () => void) => void;
}

interface PlanLike {
	title?: string;
	swarm?: string;
	phases?: Array<{
		tasks?: Array<{
			id: string;
			status?: string;
		}>;
	}>;
}

function countStatuses(rows: AdvisoryCiGateRow[]): AdvisoryCiReport['counts'] {
	const counts = { pass: 0, fail: 0, no_data: 0, corrupt: 0, error: 0 };
	for (const row of rows) counts[row.status]++;
	return counts;
}

function removeShadowRoot(shadowRoot: string): void {
	try {
		fs.rmSync(shadowRoot, { recursive: true, force: true });
	} catch {
		// Best-effort cleanup; the OS reclaims the temp directory eventually.
	}
}

const SHADOW_COPY_CHUNK_BYTES = 64 * 1024;

function copyFileBounded(
	source: string,
	destination: string,
	remainingBytes: number,
): number | null {
	let sourceFd: number | undefined;
	let destinationFd: number | undefined;
	let copiedBytes = 0;
	try {
		sourceFd = fs.openSync(source, 'r');
		destinationFd = fs.openSync(destination, 'w');
		const buffer = Buffer.allocUnsafe(
			Math.min(SHADOW_COPY_CHUNK_BYTES, remainingBytes + 1),
		);
		while (true) {
			const bytesRead = fs.readSync(sourceFd, buffer, 0, buffer.length, null);
			if (bytesRead === 0) return copiedBytes;
			if (bytesRead > remainingBytes - copiedBytes) return null;
			let written = 0;
			while (written < bytesRead) {
				const bytesWritten = fs.writeSync(
					destinationFd,
					buffer,
					written,
					bytesRead - written,
				);
				if (bytesWritten <= 0) {
					throw new Error('shadow-copy write made no progress');
				}
				written += bytesWritten;
			}
			copiedBytes += bytesRead;
		}
	} finally {
		// This helper writes a transient OS-temp path through an open descriptor.
		// Invalidate explicitly so the scanner and read-your-own-write contract do
		// not depend on the copy target remaining below the evaluated project root.
		invalidateCachedArtifact(destination);
		if (destinationFd !== undefined) {
			try {
				fs.closeSync(destinationFd);
			} catch {
				// Preserve the original copy error, if any.
			}
		}
		if (sourceFd !== undefined) {
			try {
				fs.closeSync(sourceFd);
			} catch {
				// Preserve the original copy error, if any.
			}
		}
	}
}

function isClosedDirectoryError(error: unknown): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		(error as { code?: unknown }).code === 'ERR_DIR_CLOSED'
	);
}

/** Copy `.swarm/` into a fresh temp dir for DB-mediated reads. Returns null
 * when `.swarm` is absent or exceeds the copy budget. */
function createShadowCopy(
	directory: string,
	maxBytes = MAX_SHADOW_COPY_BYTES,
): string | null {
	const swarmDir = path.join(directory, '.swarm');
	if (!fs.existsSync(swarmDir)) return null;
	let total = 0;
	let entriesSeen = 0;
	const files: string[] = [];
	let budgetExceeded = false;
	const walk = (dir: string) => {
		let directoryHandle: fs.Dir | undefined;
		let traversalError: unknown;
		let closeError: unknown;
		try {
			directoryHandle = fs.opendirSync(dir);
			while (true) {
				const entry = directoryHandle.readSync();
				if (entry === null) break;
				entriesSeen++;
				if (entriesSeen > MAX_SHADOW_COPY_ENTRIES) {
					budgetExceeded = true;
					break;
				}
				const src = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					walk(src);
					if (budgetExceeded) break;
					continue;
				}
				if (!entry.isFile()) continue;
				const size = fs.statSync(src).size;
				total += size;
				if (total > maxBytes) {
					budgetExceeded = true;
					break;
				}
				files.push(src);
			}
		} catch (error) {
			traversalError = error;
			throw error;
		} finally {
			if (directoryHandle !== undefined) {
				try {
					directoryHandle.closeSync();
				} catch (error) {
					if (!isClosedDirectoryError(error) && traversalError === undefined) {
						closeError = error;
					}
				}
			}
		}
		if (closeError !== undefined) throw closeError;
	};
	walk(swarmDir);
	if (budgetExceeded) return null;
	const shadowRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-ci-shadow-'));
	try {
		const shadowSwarm = path.join(shadowRoot, '.swarm');
		fs.mkdirSync(shadowSwarm, { recursive: true });
		let copiedBytes = 0;
		for (const src of files) {
			const rel = path.relative(directory, src);
			const dest = path.join(shadowRoot, rel);
			fs.mkdirSync(path.dirname(dest), { recursive: true });
			const copied = _internals.copyFileBounded(
				src,
				dest,
				maxBytes - copiedBytes,
			);
			if (copied === null) {
				removeShadowRoot(shadowRoot);
				return null;
			}
			copiedBytes += copied;
		}
		return shadowRoot;
	} catch (error) {
		removeShadowRoot(shadowRoot);
		throw error;
	}
}

export const _internals = {
	computeEvidenceQualitySummary,
	copyFileBounded,
	createShadowCopy,
};

/** Gates whose only durable record lives in live plugin state; advisory CI
 * reports them instead of fabricating a pass. */
const NOT_EVALUABLE: Array<{ name: string; reason: string }> = [
	{
		name: 'agent_error_rate',
		reason:
			'requires the plugin live in-process tool-aggregate state; not reconstructible headless',
	},
	{
		name: 'hard_limit_hits',
		reason:
			'requires the plugin live in-process agent-session state; not reconstructible headless',
	},
];

/** Gate-profile flags that have no durable whole-plan reader the advisory
 * evaluator could call; they are reported, never silently passed. */
const NOT_EVALUATED_REASONS: Record<string, string> = {
	drift_check:
		'enforced inline by the write-drift-evidence flow; no standalone durable whole-plan reader',
	sast_enabled:
		'recorded per-task in evidence bundles; not a whole-plan gate row',
	sme_enabled: 'advisory SME pass has no durable whole-plan verdict artifact',
	council_mode:
		'council gating is per-task through checkCouncilGate at completion time',
	mutation_test:
		'mutation gate runs in the evolution harness, not the advisory path',
	phase_council:
		'phase councils run interactively; no durable whole-plan verdict',
	final_council:
		'final council runs interactively; no durable whole-plan verdict',
	hallucination_guard:
		'stream-time guard; no durable whole-plan verdict artifact',
};

export async function evaluateAdvisoryCi(
	options: EvaluateAdvisoryCiOptions,
): Promise<AdvisoryCiReport> {
	const { directory, tty } = options;
	const journal = options.journal ?? (() => {});
	const externalRegisterCleanup = options.registerCleanup;
	let directShadowCleanup: (() => void) | undefined;
	const directShadowCleanups: Array<() => void> = [];
	const registerCleanup = (fn: () => void) => {
		if (externalRegisterCleanup) externalRegisterCleanup(fn);
		else {
			directShadowCleanups.push(fn);
			directShadowCleanup ??= () => {
				for (const cleanup of directShadowCleanups.splice(0)) {
					try {
						cleanup();
					} catch {
						// Direct callers have no runtime cleanup supervisor; one failed
						// best-effort cleanup must not hide the evaluation result or
						// prevent later callbacks from running.
					}
				}
			};
		}
	};
	const gates: AdvisoryCiGateRow[] = [];
	const tasks: AdvisoryCiReport['tasks'] = [];

	const planPath = path.join(directory, '.swarm', 'plan.json');
	const planExists = fs.existsSync(planPath);
	const plan = planExists ? await loadPlanJsonOnly(directory) : null;

	if (planExists && !plan) {
		gates.push({
			name: 'plan',
			status: 'corrupt',
			detail: '.swarm/plan.json exists but failed schema validation',
		});
		return finishReport({
			gates,
			tasks,
			planMeta: { present: true, task_count: 0 },
			tty,
			exit_reason: 'plan_corrupt',
			effectiveGates: { ...DEFAULT_QA_GATES },
			gateProfile: 'default',
		});
	}
	if (!plan) {
		gates.push({
			name: 'plan',
			status: 'no_data',
			detail: '.swarm/plan.json is missing — nothing to evaluate is not a pass',
		});
		return finishReport({
			gates,
			tasks,
			planMeta: { present: false, task_count: 0 },
			tty,
			exit_reason: 'plan_missing',
			effectiveGates: { ...DEFAULT_QA_GATES },
			gateProfile: 'default',
		});
	}

	const planLike = plan as unknown as PlanLike;
	const planTasks: Array<{ id: string; status?: string }> = [];
	for (const phase of planLike.phases ?? []) {
		for (const task of phase.tasks ?? []) planTasks.push(task);
	}
	journal('plan_loaded', `${planTasks.length} tasks`);

	if (planTasks.length === 0) {
		gates.push({ name: 'plan', status: 'pass' });
		gates.push({
			name: 'plan tasks',
			status: 'no_data',
			detail: 'plan contains no tasks — nothing demonstrably gated',
		});
		return finishReport({
			gates,
			tasks,
			planMeta: {
				present: true,
				title: planLike.title,
				swarm: planLike.swarm,
				task_count: 0,
			},
			tty,
			exit_reason: 'no_tasks',
			effectiveGates: { ...DEFAULT_QA_GATES },
			gateProfile: 'default',
		});
	}

	// --- shadow copy for DB-mediated reads (gate profile + plan critic) ----
	let shadowDir: string | null = null;
	try {
		shadowDir = createShadowCopy(directory);
	} catch {
		shadowDir = null;
	}
	if (shadowDir) {
		const cleanupShadow = () => {
			try {
				closeProjectDb(shadowDir as string);
			} finally {
				// SQLite must release WAL/SHM handles before the temp tree is
				// removed (especially on Windows). Removal remains best-effort
				// even if the cached DB is already closed or unavailable.
				removeShadowRoot(shadowDir as string);
			}
		};
		try {
			registerCleanup(cleanupShadow);
		} catch (error) {
			try {
				cleanupShadow();
			} catch {
				// Preserve the cleanup-registration failure; the shadow root has
				// still received a best-effort removal attempt above.
			}
			throw error;
		}
	}

	try {
		// --- effective gate set (R2: default fallback, honest reporting) -------
		const identity = {
			swarm: planLike.swarm ?? 'local',
			title: planLike.title ?? '',
		};
		let effectiveGates: QaGates = { ...DEFAULT_QA_GATES };
		let gateProfile: 'default' | 'profile' = 'default';
		if (shadowDir) {
			const lookup = getProfileLookupForIdentity(shadowDir, identity);
			if (lookup && 'profile' in lookup && lookup.profile) {
				effectiveGates = getEffectiveGates(lookup.profile, {});
				gateProfile = 'profile';
			}
		}
		journal('gate_profile', gateProfile);

		gates.push({ name: 'plan', status: 'pass' });

		// --- plan-critic gate (critic_pre_plan) --------------------------------
		if (effectiveGates.critic_pre_plan) {
			if (shadowDir) {
				const approved = await isPlanCriticApproved(shadowDir);
				gates.push({
					name: 'plan_critic',
					status: approved ? 'pass' : 'fail',
					detail: approved
						? 'plan-critic APPROVED snapshot matches the current plan structure'
						: 'no plan_critic_gate APPROVED snapshot matching the current plan (critic_pre_plan is enabled)',
				});
			} else {
				gates.push({
					name: 'plan_critic',
					status: 'error',
					detail:
						'ledger snapshot read unavailable: durable state exceeds the shadow-copy budget',
				});
			}
		}

		// --- per-task gates (tri-state evidence, terminal workflow) ------------
		for (const task of planTasks) {
			try {
				const state = await readTaskEvidenceState(directory, task.id);
				if (state.kind === 'ok') {
					const evidence = state.evidence;
					const required = [...evidence.required_gates];
					const satisfiedKeys = Object.keys(evidence.gates ?? {});
					const missing = required.filter((g) => !satisfiedKeys.includes(g));
					const workflowState = evidence.workflow?.state;
					const terminal = TERMINAL_SUCCESS_STATES.includes(
						workflowState as (typeof TERMINAL_SUCCESS_STATES)[number],
					);
					const satisfied = missing.length === 0 && terminal;
					tasks.push({
						task_id: task.id,
						evidence_state: 'valid',
						required_gates: required,
						missing_gates: missing,
						workflow_state: workflowState,
						satisfied,
					});
					gates.push({
						name: `task ${task.id} gates`,
						status: satisfied ? 'pass' : 'fail',
						detail: satisfied
							? `all required gates satisfied; workflow ${workflowState}`
							: missing.length > 0
								? `missing gate evidence: ${missing.join(', ')}${terminal ? '' : `; workflow state ${workflowState} is not terminal`}`
								: `workflow state ${workflowState} is not a terminal-success state`,
					});
				} else if (state.kind === 'missing') {
					const required = deriveRequiredGates('coder');
					tasks.push({
						task_id: task.id,
						evidence_state: 'missing',
						required_gates: required,
						missing_gates: [...required],
						satisfied: false,
					});
					gates.push({
						name: `task ${task.id} gates`,
						status: 'no_data',
						detail: 'no durable task-gate evidence recorded',
					});
				} else if (state.kind === 'unparseable') {
					const required = deriveRequiredGates('coder');
					tasks.push({
						task_id: task.id,
						evidence_state: 'corrupt',
						required_gates: required,
						missing_gates: [...required],
						satisfied: false,
					});
					gates.push({
						name: `task ${task.id} gates`,
						status: 'corrupt',
						detail:
							'task-gate evidence exists but cannot be parsed (#2470 tri-state)',
					});
				} else {
					tasks.push({
						task_id: task.id,
						evidence_state: 'error',
						required_gates: deriveRequiredGates('coder'),
						missing_gates: deriveRequiredGates('coder'),
						satisfied: false,
					});
					gates.push({
						name: `task ${task.id} gates`,
						status: 'error',
						detail: `evidence reader returned unexpected state ${JSON.stringify((state as { kind?: string }).kind)}`,
					});
				}
			} catch (error) {
				tasks.push({
					task_id: task.id,
					evidence_state: 'error',
					required_gates: deriveRequiredGates('coder'),
					missing_gates: deriveRequiredGates('coder'),
					satisfied: false,
				});
				gates.push({
					name: `task ${task.id} gates`,
					status: 'error',
					detail: error instanceof Error ? error.message : String(error),
				});
			}
		}

		// --- evidence-quality thresholds (shared with benchmark) ---------------
		const summary = await _internals.computeEvidenceQualitySummary(directory);
		const q = summary.qualityMetrics;
		const qualityRows: Array<[string, boolean | null, number | null, string]> =
			[
				[
					'review_pass_rate',
					summary.reviewPassRate === null
						? null
						: summary.reviewPassRate >= CI_QUALITY_THRESHOLDS.review_pass_rate,
					summary.reviewPassRate,
					`>= ${CI_QUALITY_THRESHOLDS.review_pass_rate}% over ${summary.totalReviews} reviews`,
				],
				[
					'test_pass_rate',
					summary.testPassRate === null
						? null
						: summary.testPassRate >= CI_QUALITY_THRESHOLDS.test_pass_rate,
					summary.testPassRate,
					`>= ${CI_QUALITY_THRESHOLDS.test_pass_rate}% over ${summary.testsPassed + summary.testsFailed} tests`,
				],
				[
					'quality_budget.complexity_delta',
					q.hasEvidence
						? q.complexityDelta <= CI_QUALITY_THRESHOLDS.max_complexity_delta
						: null,
					q.hasEvidence ? q.complexityDelta : null,
					`<= ${CI_QUALITY_THRESHOLDS.max_complexity_delta}`,
				],
				[
					'quality_budget.public_api_delta',
					q.hasEvidence
						? q.publicApiDelta <= CI_QUALITY_THRESHOLDS.max_public_api_delta
						: null,
					q.hasEvidence ? q.publicApiDelta : null,
					`<= ${CI_QUALITY_THRESHOLDS.max_public_api_delta}`,
				],
				[
					'quality_budget.duplication_ratio',
					q.hasEvidence
						? q.duplicationRatio <= CI_QUALITY_THRESHOLDS.max_duplication_ratio
						: null,
					q.hasEvidence ? q.duplicationRatio : null,
					`<= ${CI_QUALITY_THRESHOLDS.max_duplication_ratio}%`,
				],
				[
					'quality_budget.test_to_code_ratio',
					q.hasEvidence
						? q.testToCodeRatio >= CI_QUALITY_THRESHOLDS.min_test_to_code_ratio
						: null,
					q.hasEvidence ? q.testToCodeRatio : null,
					`>= ${CI_QUALITY_THRESHOLDS.min_test_to_code_ratio}%`,
				],
			];
		for (const [name, passed, value, threshold] of qualityRows) {
			gates.push({
				name,
				status: passed === null ? 'no_data' : passed ? 'pass' : 'fail',
				detail:
					passed === null
						? `no evidence data (${threshold}); not a pass`
						: `value ${value} ${threshold}`,
			});
		}

		const report = finishReport({
			gates,
			tasks,
			planMeta: {
				present: true,
				title: planLike.title,
				swarm: planLike.swarm,
				task_count: planTasks.length,
			},
			tty,
			exit_reason: 'gate_violations',
			effectiveGates,
			gateProfile,
		});
		return report;
	} finally {
		directShadowCleanup?.();
	}
}

function finishReport(args: {
	gates: AdvisoryCiGateRow[];
	tasks: AdvisoryCiTaskEntry[];
	planMeta: AdvisoryCiReport['plan'];
	tty: boolean;
	exit_reason: AdvisoryCiReport['exit_reason'];
	effectiveGates: QaGates;
	gateProfile: 'default' | 'profile';
}): AdvisoryCiReport {
	const counts = countStatuses(args.gates);
	const allPassed = args.gates.length > 0 && counts.pass === args.gates.length;
	const verdict: AdvisoryCiReport['verdict'] = allPassed ? 'pass' : 'fail';
	const exit_reason = allPassed ? 'all_gates_passed' : args.exit_reason;
	const not_evaluated: AdvisoryCiReport['not_evaluated'] = [];
	for (const [flag, reason] of Object.entries(NOT_EVALUATED_REASONS)) {
		if ((args.effectiveGates as unknown as Record<string, boolean>)[flag]) {
			not_evaluated.push({ name: flag, reason });
		}
	}
	return {
		version: 1,
		verdict,
		exit_reason,
		gates: args.gates,
		tasks: args.tasks,
		plan: args.planMeta,
		environment: { mode: 'advisory', tty: args.tty, host: 'none' },
		gate_profile: args.gateProfile,
		effective_gates: args.effectiveGates,
		not_evaluated,
		not_evaluable: [...NOT_EVALUABLE],
		counts,
	};
}
