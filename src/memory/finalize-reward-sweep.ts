/**
 * B.6 — Deterministic negative-terminal reward sweep at session finalize.
 *
 * This is the RELIABLE negative learning signal (resolved design decision C-6),
 * the deterministic counterpart to A.4's positive terminal reward
 * (APPROVE→complete→1.0). At `/swarm close`, every task left non-complete is
 * stamped `close_reason='session_terminated'` (see `guaranteeAllPlansComplete`
 * in `src/commands/close.ts`). The memories recalled into those non-completed
 * tasks earn a NEGATIVE terminal reward (0.0) so their learned utility (q-value)
 * drifts DOWN via the shared EMA mechanism and, once it crosses
 * `qLearning.suppressionThreshold`, they are suppressed from future default
 * recall (FR-001 negative terminal; FR-006 makes suppression functional;
 * SC-007 end-to-end).
 *
 * ── Attribution / why we DISCOVER the runId rather than assume the finalize
 *    session ──────────────────────────────────────────────────────────────
 * `applyCouncilReward` lists recall bundles by `runId` at the provider level
 * (`listRecallUsage({ runId })`) BEFORE narrowing them by `unitId` in memory.
 * Recall usage is recorded with `runId = context.runId ?? context.sessionID` —
 * i.e. the WORK session that performed the recall. Finalize, however, may run
 * in a DIFFERENT session (plans persist across sessions via the ledger, and
 * `/swarm close` can run in a separate process — the reason close has a
 * cross-process `readEarliestSessionStart` fallback). So passing the finalize
 * session id as `runId` would make the provider-level filter miss the task's
 * bundles entirely and the sweep would be a silent no-op — unacceptable for a
 * "reliable" signal. Passing an empty `runId` (which disables the provider
 * filter) is also wrong: it would let UNTAGGED bundles from unrelated sessions
 * be penalized once per swept task (blast-radius / disjointness violation).
 *
 * Therefore, for each closed task we FIRST discover the real run id(s) that
 * recalled memories into it via `listRecallUsage({ unitId: taskId })` (the B.1
 * bundle-identity join key), then invoke `applyCouncilReward` once per
 * (task, runId) with `reward = 0.0` and `unitId = taskId`. Within each runId,
 * `applyCouncilReward`'s unitId narrowing keeps this task's tagged bundles plus
 * that run's untagged bundles (the documented B.2 run_id fallback) — exactly
 * symmetric to how A.4 rewards those same bundles on completion.
 *
 * ── Correctness invariants ────────────────────────────────────────────────
 * - Disjointness: only `closedTaskIds` (non-complete tasks) are swept, so a
 *   memory recalled into a COMPLETED task is never penalized. When a completed
 *   task and a closed task share one work session, the per-runId
 *   `applyCouncilReward` call still lists the whole session's bundles but its
 *   `unitId` narrowing excludes the completed task's tagged bundle (its
 *   `unitId` differs), so the completed task's memory is untouched. A memory
 *   recalled into BOTH a completed and a non-completed task legitimately gets
 *   +1.0 (A.4) and 0.0 (this sweep) for the two DIFFERENT tasks — not a
 *   double-penalty.
 * - Cross-finalize idempotency: the sweep holds NO persistent per-task
 *   "rewarded" flag (unlike A.4's `session.taskCouncilApproved.rewarded`). It
 *   does not need one — a task closed on a prior finalize already has status
 *   `'closed'`, so `guaranteeAllPlansComplete` does not re-close it and it is
 *   NOT present in `closedTaskIds` on a subsequent finalize. (Finalize also
 *   removes `plan.json`/`plan-ledger.jsonl`, so a re-run short-circuits with an
 *   empty task set.) Within a single sweep we additionally dedupe `taskId`.
 *   Two intentional multiplicity sources are accepted, both a consequence of
 *   reusing the mandated shared reward path rather than a bug:
 *     1. A memory recalled into the SAME closed task across MULTIPLE work
 *        sessions receives one 0.0 EMA step PER runId (`applyCouncilReward`
 *        dedupes within a runId, not across our per-runId calls). The
 *        dominant one-runId-per-task case is exactly A.4-symmetric; the
 *        multi-session case is marginally more aggressive.
 *     2. An UNTAGGED (`unit_id == null`) bundle in a runId SHARED by N closed
 *        tasks is penalized once PER closed task that shares that runId: each
 *        per-task `applyCouncilReward` call re-keeps the same untagged bundle
 *        via the documented B.2 run_id fallback (an untagged bundle is kept
 *        regardless of which task's unitId is being narrowed for), so a
 *        memory recalled only in that untagged bundle earns N separate 0.0
 *        steps for N closed tasks in the same session, not one.
 * - Persistence ordering: the caller invokes this sweep BEFORE the destructive
 *   git alignment stage, and the memory store lives at `.swarm/memory/` (not in
 *   finalize's clean allowlists and not touched by align's `dist`-scoped
 *   clean), so the reward writes survive finalize.
 * - Non-blocking: the ENTIRE sweep is wrapped in try/catch that logs and
 *   continues. A sweep failure NEVER throws into finalize and never alters
 *   finalize's task/archival/align behavior — it only records rewards.
 *
 * NOTE: `applyCouncilReward`'s `verdictLabel` option lets this sweep label its
 * reward events with the true reason instead of the misleading default
 * `'APPROVE'`. Sweep events are persisted as
 * `{ verdict: 'session_terminated', reward: 0.0 }` (see the `applyCouncilReward`
 * call below).
 */

import type { MemoryConfig } from '../config/schema';
import { log as debugLog } from '../utils/logger';
import { createConfiguredMemoryProvider } from './gateway';
import { applyCouncilReward } from './reward-capture';

/**
 * Negative terminal reward for memories recalled into non-completed
 * (`session_terminated`) tasks. On the [0,1] utility scale, 0.0 is the minimum:
 * the EMA step `q ← (1-η)·q + η·0` strictly decreases any positive q toward 0.
 */
export const FINALIZE_NEGATIVE_TERMINAL_REWARD = 0.0;

export interface FinalizeRewardSweepArgs {
	/** Project root; the memory store lives under `<directory>/.swarm/memory/`. */
	directory: string;
	/**
	 * Task ids stamped `close_reason='session_terminated'` this finalize
	 * (`ctx.guaranteeResult.closedTaskIds`). Deduped defensively inside.
	 */
	closedTaskIds: readonly string[];
	/**
	 * Resolved `config.memory` (already parsed via `PluginConfigSchema`). When
	 * absent or `enabled !== true` the sweep is a complete no-op.
	 */
	memoryConfig: MemoryConfig | undefined;
	/** ISO 8601 timestamp for the reward events; defaults to now. */
	timestamp?: string;
}

export interface FinalizeRewardSweepResult {
	/** True once the sweep loop actually ran (memory enabled + tasks present). */
	swept: boolean;
	/** Count of closed tasks that had at least one memory rewarded. */
	tasksSwept: number;
	/** Total EMA steps applied (summed across tasks and their run ids). */
	memoriesRewarded: number;
	/** Count of (task, runId) `applyCouncilReward` invocations performed. */
	runIdsProcessed: number;
}

/**
 * Apply the deterministic negative terminal reward (0.0) to memories recalled
 * into the given non-completed tasks. See the module header for the full
 * attribution model and correctness invariants. Never throws.
 */
export async function runFinalizeRewardSweep(
	args: FinalizeRewardSweepArgs,
): Promise<FinalizeRewardSweepResult> {
	const result: FinalizeRewardSweepResult = {
		swept: false,
		tasksSwept: 0,
		memoriesRewarded: 0,
		runIdsProcessed: 0,
	};

	// Non-blocking envelope: a sweep failure must NEVER change finalize's
	// task/archival/align behavior or throw. It only records rewards.
	try {
		const { directory, memoryConfig } = args;

		// (1) Skip the whole sweep when memory is disabled (no-op).
		if (memoryConfig?.enabled !== true) {
			return result;
		}

		// (4) Dedupe by taskId (belt-and-suspenders — closedTaskIds is already
		// disjoint from completed tasks, which preserves the disjointness that
		// keeps A.4's +1.0 and this 0.0 from colliding on the same task).
		const taskIds = [
			...new Set(
				args.closedTaskIds.filter(
					(id): id is string => typeof id === 'string' && id.length > 0,
				),
			),
		];
		if (taskIds.length === 0) {
			return result;
		}

		const timestamp = args.timestamp ?? new Date().toISOString();
		const provider = _internals.createConfiguredMemoryProvider(
			directory,
			memoryConfig,
		);
		try {
			result.swept = true;
			for (const taskId of taskIds) {
				// Discover the real run id(s) that recalled memories into this task
				// via the B.1 bundle-identity join key. `applyCouncilReward` gates on
				// runId at the provider level, so we must reward under the ACTUAL
				// recording run id(s), not the finalize session id.
				const bundles =
					(await provider.listRecallUsage?.({ unitId: taskId })) ?? [];

				// (5) Skip silently when a closed task has no recall bundle.
				if (bundles.length === 0) {
					continue;
				}

				const runIds = new Set<string>();
				for (const bundle of bundles) {
					if (typeof bundle.runId === 'string' && bundle.runId.length > 0) {
						runIds.add(bundle.runId);
					}
				}
				if (runIds.size === 0) {
					// Bundles tagged with this unitId but no runId. Do NOT pass an
					// empty runId to applyCouncilReward — that disables the provider's
					// runId filter and would penalize untagged bundles from unrelated
					// sessions (disjointness violation). The recall injector always
					// records a runId, so this is a defensive no-op.
					debugLog(
						`[memory:finalize-sweep] task ${taskId} has recall bundles without a runId; ` +
							'skipping to avoid over-penalizing unrelated untagged memories',
					);
					continue;
				}

				let taskRewarded = 0;
				for (const runId of runIds) {
					const { memoriesRewarded } = await _internals.applyCouncilReward(
						provider,
						{
							runId,
							unitId: taskId,
							reward: FINALIZE_NEGATIVE_TERMINAL_REWARD,
							eta: memoryConfig.qLearning.learningRate,
							initialQValue: memoryConfig.qLearning.initialQValue,
							// Thread the full q-learning config so B.5 soft-propagation
							// reads propagationFraction / fanoutCap / windowDays.
							qLearning: memoryConfig.qLearning,
							timestamp,
							verdictLabel: 'session_terminated',
						},
					);
					taskRewarded += memoriesRewarded;
					result.runIdsProcessed++;
				}
				if (taskRewarded > 0) {
					result.tasksSwept++;
					result.memoriesRewarded += taskRewarded;
				}
			}
		} finally {
			await provider.close?.();
		}
	} catch (err) {
		debugLog(
			`[memory:finalize-sweep] skipped after error: ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
	}

	return result;
}

/**
 * DI seam (AGENTS.md invariant 7 — DI over `mock.module`). Tests override these
 * to inject a throwing provider (non-blocking assertion) or to count/observe
 * calls. Restore in `afterEach`.
 */
export const _internals = {
	createConfiguredMemoryProvider,
	applyCouncilReward,
};
