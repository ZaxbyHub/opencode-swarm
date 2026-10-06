/**
 * Epic v2 C2 — `epic_next_wave`: the single, idempotent way forward while an
 * epic is open. It replaces `epic_decide_phase`, `epic_plan_waves` and
 * `epic_record_divergence`.
 *
 * Each call, in order:
 *   1. refuses unless Epic is enabled by config and an epic is open for the
 *      current plan (`epic-disabled-by-config`, `epic-state-unreadable`,
 *      `epic-orphaned`, `no-open-epic`);
 *   2. blocks `epic-branch-mismatch` when HEAD left the epic branch (M-e);
 *   3. with a wave active — advance rule: the wave closes when every task is
 *      resolved (plan status completed — already gated by
 *      `update_task_status` — or closed, or removed from the plan) and none
 *      has a merge-back failure recorded since the wave was issued.
 *      Otherwise: `blocked` (`task-blocked`, `merge-failed`, `plan-revised`
 *      when an unresolved task moved to another phase — the wave is aborted)
 *      or `in-progress` (the same wave; idempotent). A closable wave is
 *      closed (`wave-close.ts`) and the call continues to the next wave;
 *   4. phases are iterations: the current phase is the first phase not
 *      recorded complete by `phase_complete`; a pending task in a complete
 *      phase
 *      blocks (`task-reopened` when the epic had resolved it, else
 *      `plan-revised`);
 *   5. every current-phase task resolved → `phase-ready-for-review` (then
 *      `epic_phase_review` → `phase_complete`); every phase complete →
 *      `epic-complete`;
 *   6. otherwise selects the next wave (`wave-select.ts` over the component
 *      planner `components.ts`, with the planning signals of
 *      `planning-signals.ts`; past waves of the phase age its components):
 *      `declare-scopes`,
 *      `blocked` (`predecessor-missing`, `task-blocked`, `git-failed`,
 *      `dirty-baseline`), or `dispatch` — a multi-task wave must pass THE
 *      wave verdict (`gate-policy.ts`, the call the delegation gate repeats
 *      at dispatch); the wave (frozen declared scopes, base HEAD) is
 *      CAS-written into the epic record (token-guarded) and returned with
 *      dispatch instructions.
 *
 * Git epics (Epic v2 C3): every task's work is committed before the task
 * completes (its coder's worktree lands as a merge commit; non-coder writes
 * become residue commits). Closing a wave first commits any residue still
 * attributed to its tasks, then records each task's commit and mirrors it to
 * `refs/swarm/epics/<epicKey>/tasks/<id>` (`markers.ts`). A completed
 * dependency outside the batch is satisfied by that ref being an ancestor of
 * HEAD (or by having been completed before the epic started). Before a new
 * wave, TRACKED changes block `dirty-baseline`; untracked files are only
 * reported.
 */

import { DEFAULT_LEAN_TURBO_CONFIG } from '../config/constants.js';
import { loadPluginConfigWithMeta as loadPluginConfigWithMeta_import } from '../config/index.js';
import type { Plan } from '../config/plan-schema.js';
import type { PluginConfig } from '../config/schema.js';
import { _internals as gitBranchInternals } from '../git/branch.js';
import { runSerializedWithMergeBacks } from '../hooks/delegation-gate/worktree-isolation.js';
import { readLedgerEvents as readLedgerEvents_import } from '../plan/ledger.js';
import { loadPlanJsonOnly as loadPlanJsonOnly_import } from '../plan/manager.js';
import * as logger from '../utils/logger.js';
import { getCoChangeData as getCoChangeData_import } from './cochange-source.js';
import {
	EPIC_MODE_CONFIG_DISABLED_MESSAGE,
	isEpicModeConfigEnabled,
} from './config-gate.js';
import { resolveEpicDeclaredScopes as resolveEpicDeclaredScopes_import } from './declared-scopes.js';
import { checkEpicBranch as checkEpicBranch_import } from './epic-branch.js';
import { computeEpicWaveVerdict as computeEpicWaveVerdict_import } from './gate-policy.js';
import { loadEpicLearningView as loadEpicLearningView_import } from './learning-store.js';
import {
	type EpicRecordV1,
	type EpicWaveRecord,
	getOpenEpic as getOpenEpic_import,
	inspectEpic as inspectEpic_import,
	isEpicPhaseDone,
	updateEpicRecord as updateEpicRecord_import,
} from './lifecycle.js';
import {
	epicTaskRef,
	isCommitAncestorOfHead as isCommitAncestorOfHead_import,
	syncEpicRefs as syncEpicRefs_import,
} from './markers.js';
import { relevantMergeFailureForProject as relevantMergeFailureForProject_import } from './merge-epoch.js';
import {
	buildDispatchInstructions,
	type EpicClosedWaveSummary,
	type EpicNextWaveResult,
	type EpicWaveView,
	epicPhaseFixPath,
	predecessorMessage,
	refused,
	summarizeClosedWave,
	syncPhaseRecords,
	toWaveView,
} from './next-wave-format.js';
import { loadEpicPlanningSignals } from './planning-signals.js';
import {
	classifyDirtyBaseline,
	commitTaskResidue as commitTaskResidue_import,
	listDirtyEntries as listDirtyEntries_import,
} from './residue-commit.js';
import { EPIC_LANDING_INDEX_STAGE } from './task-landing.js';
import {
	applyWaveClose,
	collectTaskAttribution as collectTaskAttribution_import,
	computeWaveClose as computeWaveClose_import,
	recordEpicWaveLearning as recordEpicWaveLearning_import,
	releaseWaveAttribution as releaseWaveAttribution_import,
} from './wave-close.js';
import { selectNextEpicWave } from './wave-select.js';

export type { EpicNextWaveResult } from './next-wave-format.js';

/** DI seam (AGENTS.md invariant 7). Restore in `afterEach`. */
export const _internals = {
	loadPluginConfigWithMeta: loadPluginConfigWithMeta_import,
	loadPlanJsonOnly: loadPlanJsonOnly_import,
	readLedgerEvents: readLedgerEvents_import,
	getOpenEpic: getOpenEpic_import,
	inspectEpic: inspectEpic_import,
	updateEpicRecord: updateEpicRecord_import,
	checkEpicBranch: checkEpicBranch_import,
	listDirtyEntries: listDirtyEntries_import,
	commitTaskResidue: commitTaskResidue_import,
	collectTaskAttribution: collectTaskAttribution_import,
	syncEpicRefs: syncEpicRefs_import,
	isCommitAncestorOfHead: isCommitAncestorOfHead_import,
	/** One writer of the primary checkout's index at a time (merge-back queue). */
	serializeWithMergeBacks: <T>(task: () => T | Promise<T>): Promise<T> =>
		runSerializedWithMergeBacks(task),
	readHead: (directory: string): string | null => {
		try {
			const head = gitBranchInternals
				.gitExec(['rev-parse', 'HEAD'], directory)
				.trim();
			return /^[0-9a-f]{7,64}$/.test(head) ? head : null;
		} catch {
			return null;
		}
	},
	resolveEpicDeclaredScopes: resolveEpicDeclaredScopes_import,
	relevantMergeFailureForProject: relevantMergeFailureForProject_import,
	loadEpicLearningView: loadEpicLearningView_import,
	getCoChangeData: getCoChangeData_import,
	computeWaveClose: computeWaveClose_import,
	recordEpicWaveLearning: recordEpicWaveLearning_import,
	releaseWaveAttribution: releaseWaveAttribution_import,
	computeEpicWaveVerdict: computeEpicWaveVerdict_import,
	now: (): number => Date.now(),
};

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isTaskResolved(status: string | undefined): boolean {
	return status === 'completed' || status === 'closed';
}

type PlanTask = Plan['phases'][number]['tasks'][number];

function findTask(
	plan: Plan,
	taskId: string,
): { task: PlanTask; phaseId: number } | null {
	for (const phase of plan.phases) {
		const task = (phase.tasks ?? []).find((t) => t.id === taskId);
		if (task) return { task, phaseId: phase.id };
	}
	return null;
}

async function describeNoEpic(directory: string): Promise<EpicNextWaveResult> {
	let inspection: ReturnType<typeof inspectEpic_import> | null = null;
	try {
		inspection = _internals.inspectEpic(directory);
	} catch {
		inspection = null;
	}
	if (inspection?.record && inspection.orphanReason) {
		return refused(
			'epic-orphaned',
			`The open epic \`${inspection.record.epicKey}\` no longer matches the current plan (${inspection.orphanReason}). Ask the user to run \`/swarm epic status\`, then \`/swarm epic close --abandon\`; until then run tasks per-task serially.`,
		);
	}
	if (inspection?.record?.status === 'closing') {
		return refused(
			'no-open-epic',
			`Epic \`${inspection.record.epicKey}\` is closing (an interrupted \`/swarm epic close\`). Ask the user to rerun \`/swarm epic close\`.`,
		);
	}
	return refused(
		'no-open-epic',
		'No epic is open for the current plan. Only the user opens one (`/swarm epic start`); until then run tasks per-task serially.',
	);
}

/** Run one `epic_next_wave` step for `directory` (see the module header). */
export async function runEpicNextWave(
	directory: string,
	sessionID: string | undefined,
): Promise<EpicNextWaveResult> {
	let config: PluginConfig;
	try {
		config = _internals.loadPluginConfigWithMeta(directory).config;
	} catch {
		return refused(
			'epic-disabled-by-config',
			EPIC_MODE_CONFIG_DISABLED_MESSAGE,
		);
	}
	if (!isEpicModeConfigEnabled(config)) {
		return refused(
			'epic-disabled-by-config',
			EPIC_MODE_CONFIG_DISABLED_MESSAGE,
		);
	}
	let epic: EpicRecordV1 | null;
	try {
		epic = _internals.getOpenEpic(directory);
	} catch (error) {
		return refused(
			'epic-state-unreadable',
			`${errorText(error)}. Ask the user to run \`/swarm epic status\` (diagnose) or \`/swarm epic close --abandon\` (repair); until then run tasks per-task serially.`,
		);
	}
	if (!epic) return describeNoEpic(directory);

	const branch = _internals.checkEpicBranch(directory, epic);
	if (!branch.ok) {
		return {
			status: 'blocked',
			reason: 'epic-branch-mismatch',
			details: { expected: branch.expected, actual: branch.actual },
			message: branch.message,
		};
	}
	let plan: Plan | null;
	try {
		plan = await _internals.loadPlanJsonOnly(directory);
	} catch {
		plan = null;
	}
	if (!plan) {
		return refused(
			'epic-orphaned',
			'The plan could not be loaded, so the open epic cannot be matched to it. Ask the user to run `/swarm epic status`.',
		);
	}

	// 3. Active wave: advance rule.
	let closedWave: EpicClosedWaveSummary | undefined;
	if (epic.activeWaveSeq !== null) {
		const advanced = await advanceActiveWave(
			directory,
			sessionID,
			config,
			epic,
			plan,
		);
		if ('result' in advanced) return advanced.result;
		epic = advanced.epic;
		closedWave = advanced.closedWave;
	}
	const withClosed = (result: EpicNextWaveResult): EpicNextWaveResult =>
		closedWave && result.status !== 'refused'
			? { ...result, closedWave }
			: result;

	// 4. Completed phases must stay complete.
	const reopened: string[] = [];
	const revised: string[] = [];
	for (const phase of plan.phases) {
		if (!isEpicPhaseDone(epic, phase)) continue;
		for (const task of phase.tasks ?? []) {
			if (isTaskResolved(task.status)) continue;
			(epic.tasks[task.id] ? reopened : revised).push(task.id);
		}
	}
	if (reopened.length > 0) {
		return withClosed({
			status: 'blocked',
			reason: 'task-reopened',
			details: { taskIds: reopened },
			message: `Task(s) ${reopened.join(', ')} were completed in an already-complete phase and are now open again. Epic runs phases in order, so they cannot join a new wave. Coders cannot be dispatched for them (no wave can contain them). Tell the user, then close each one (update_task_status closed) — or close it and re-add the remaining work as a NEW task in the current phase (save_plan), which the next wave runs; then call epic_next_wave.`,
		});
	}
	if (revised.length > 0) {
		return withClosed({
			status: 'blocked',
			reason: 'plan-revised',
			details: { taskIds: revised },
			message: `Task(s) ${revised.join(', ')} are open in a phase the epic already completed (added or reopened in the plan after its phase_complete). Epic runs phases in order. Ask the user whether to move them into the current or a later phase (save_plan) or close them; then call epic_next_wave.`,
		});
	}

	// 5. Phase gating.
	const current = plan.phases.find((phase) => !isEpicPhaseDone(epic, phase));
	if (!current) {
		return withClosed({
			status: 'epic-complete',
			message:
				'Every phase is complete. Tell the user the epic can be closed with `/swarm epic close` (it lands the epic branch and writes the report with the epic scorecard; `/swarm epic report` shows the scorecard before closing).',
		});
	}
	if ((current.tasks ?? []).every((task) => isTaskResolved(task.status))) {
		syncPhases(directory, epic, current.id, 'review');
		return withClosed({
			status: 'phase-ready-for-review',
			phase: current.id,
			message: `Every task of phase ${current.id} is resolved and all its waves are closed. Call epic_phase_review({ phase: ${current.id} }) ONCE — it dispatches the phase reviewer, then (if it approves) the phase critic. Both APPROVED → run the normal PHASE-WRAP (load the phase-wrap skill: dispatch the docs agent, write the retrospective with write_retro, …) → phase_complete({ phase: ${current.id} }) → epic_next_wave. Otherwise: ${epicPhaseFixPath(current.id)}`,
		});
	}

	// 6. Next wave.
	return withClosed(
		await issueNextWave(directory, config, epic, plan, current.id),
	);
}

type AdvanceOutcome =
	| { result: EpicNextWaveResult }
	| { epic: EpicRecordV1; closedWave: EpicClosedWaveSummary | undefined };

async function advanceActiveWave(
	directory: string,
	sessionID: string | undefined,
	config: PluginConfig,
	epic: EpicRecordV1,
	plan: Plan,
): Promise<AdvanceOutcome> {
	const seq = epic.activeWaveSeq;
	const wave = epic.waves.find((w) => w.seq === seq);
	if (!wave || wave.status !== 'issued') {
		// Dangling pointer (should not happen): clear it and plan afresh.
		const repaired = _internals.updateEpicRecord(
			directory,
			epic.epicKey,
			(record) =>
				record.activeWaveSeq === seq
					? { ...record, activeWaveSeq: null }
					: record,
			epic.token,
		);
		if (!repaired) return { result: await describeNoEpic(directory) };
		return { epic: repaired, closedWave: undefined };
	}

	const blocked: string[] = [];
	const waiting: { taskId: string; state: string }[] = [];
	const moved: { taskId: string; phase: number }[] = [];
	for (const taskId of wave.taskIds) {
		const found = findTask(plan, taskId);
		if (!found) continue; // removed ⇒ resolved
		const status = found.task.status;
		if (isTaskResolved(status)) continue;
		if (found.phaseId !== wave.phase) {
			moved.push({ taskId, phase: found.phaseId });
		} else if (status === 'blocked') {
			blocked.push(taskId);
		} else {
			waiting.push({ taskId, state: status ?? 'pending' });
		}
	}
	if (moved.length > 0) {
		const reason = `plan revised: ${moved.map((m) => `${m.taskId} moved to phase ${m.phase}`).join(', ')}`;
		const aborted = _internals.updateEpicRecord(
			directory,
			epic.epicKey,
			(record) =>
				record.activeWaveSeq === wave.seq
					? {
							...record,
							activeWaveSeq: null,
							waves: record.waves.map((w) =>
								w.seq === wave.seq
									? { ...w, status: 'aborted' as const, abortReason: reason }
									: w,
							),
						}
					: record,
			epic.token,
		);
		if (!aborted) return { result: await describeNoEpic(directory) };
		return {
			result: {
				status: 'blocked',
				reason: 'plan-revised',
				details: { waveSeq: wave.seq, moved },
				message: `Wave ${wave.seq} was aborted: ${reason}. Let any coder still running for its tasks finish, tell the user, then call epic_next_wave to plan again.`,
			},
		};
	}
	if (blocked.length > 0) {
		return {
			result: {
				status: 'blocked',
				reason: 'task-blocked',
				details: { waveSeq: wave.seq, taskIds: blocked },
				message: `Wave ${wave.seq} cannot close: task(s) ${blocked.join(', ')} are blocked. Tell the user why, then fix each one (re-dispatch its coder, run Stage A/B, update_task_status completed) or close it with update_task_status(closed) if the user drops it; then call epic_next_wave.`,
			},
		};
	}

	const issuedMs = Date.parse(wave.issuedAt);
	const sinceMs = Number.isFinite(issuedMs) ? issuedMs : 0;
	const failures: {
		taskId: string;
		outcome: string;
		stage: string;
		message: string;
		at: number | null;
	}[] = [];
	for (const taskId of wave.taskIds) {
		// Closed (dropped) and removed tasks' work is not expected to land,
		// so a stranded worktree of theirs does not hold the wave.
		if (findTask(plan, taskId)?.task.status !== 'completed') continue;
		const failure = _internals.relevantMergeFailureForProject(
			directory,
			taskId,
			sinceMs,
		);
		if (failure) {
			failures.push({
				taskId,
				outcome: failure.outcome,
				stage: failure.stage,
				message: failure.message,
				at: failure.completedAt ?? failure.queuedAt ?? null,
			});
		}
	}
	if (failures.length > 0) {
		recordMergeFailureSnapshots(directory, epic, wave.seq, failures);
		const indexDirty = failures.filter(
			(f) => f.stage === EPIC_LANDING_INDEX_STAGE,
		);
		if (indexDirty.length > 0) {
			return {
				result: {
					status: 'blocked',
					reason: 'landing-index-dirty',
					details: { waveSeq: wave.seq, failures },
					message: `Wave ${wave.seq} cannot close: ${indexDirty.map((f) => f.message).join(' ')} Tell the user exactly which staged files to unstage.`,
				},
			};
		}
		return {
			result: {
				status: 'blocked',
				reason: 'merge-failed',
				details: { waveSeq: wave.seq, failures },
				message: `Wave ${wave.seq} cannot close: the worktree merge-back of ${failures.map((f) => `${f.taskId} (${f.outcome} at '${f.stage}')`).join(', ')} did not land, so that work is not in the epic branch. Tell the user; resolve the preserved worktree (\`/swarm lanes\`) and re-dispatch the task — a clean merge-back clears the record. If the work did land, the user can clear it with \`/swarm epic clear-merge-failure <taskId> --confirm\`. Then call epic_next_wave.`,
			},
		};
	}
	if (waiting.length > 0) {
		return {
			result: {
				status: 'in-progress',
				wave: toWaveView(wave, plan),
				waitingOn: waiting,
				message: `Wave ${wave.seq} is still running — waiting on ${waiting.map((w) => `${w.taskId} (${w.state})`).join(', ')}. Let each running coder finish; do not re-dispatch a task whose coder may still be running. If you are certain no coder was ever dispatched for a waiting task, dispatch it (one Task per taskId, in one message). After each coder returns run Stage A (pre_check_batch) → Stage B (reviewer + test_engineer) → update_task_status(completed). Then call epic_next_wave.`,
			},
		};
	}

	// Closable. Git: first commit residue still attributed to the wave's
	// completed tasks (a missed or failed after-hook residue commit), so the
	// close HEAD and the task commits include it.
	if (epic.git.isRepo) {
		// Serialized with worktree merge-backs: one writer of the primary
		// checkout's index at a time.
		const residue = await _internals.serializeWithMergeBacks(() =>
			commitWaveResidue(directory, sessionID, epic, wave, plan),
		);
		if (residue) return { result: residue };
	}
	// Compute, CAS-close, then (only if this call closed it) mirror the refs,
	// update the learning posterior and release attribution.
	const nowIso = new Date(_internals.now()).toISOString();
	const computation = await _internals.computeWaveClose({
		directory,
		epic,
		wave,
		plan,
		sessionID,
		nowIso,
	});
	let closedHere = false;
	const updated = _internals.updateEpicRecord(
		directory,
		epic.epicKey,
		(record) => {
			const next = applyWaveClose(record, wave.seq, computation, nowIso);
			closedHere = next !== record;
			return next;
		},
		epic.token,
	);
	if (!updated) return { result: await describeNoEpic(directory) };
	const closedRecord = updated.waves.find((w) => w.seq === wave.seq) ?? wave;
	// AFTER the close is committed and only by the call that closed the
	// wave. The outcomes are in the record, so a crash between the CAS above
	// and the learning update is caught up before the next wave is planned
	// (idempotent per wave seq) — never blocks.
	if (closedHere) {
		if (updated.git.isRepo) {
			try {
				_internals.syncEpicRefs(directory, updated);
			} catch (error) {
				// The record holds the commits; predecessor evidence re-syncs
				// (and blocks `git-failed` if git stays broken).
				logger.warn(
					`[epic/next-wave] refs for wave ${wave.seq} not written yet: ${errorText(error)}`,
				);
			}
		}
		_internals.recordEpicWaveLearning({ directory, config, record: updated });
		_internals.releaseWaveAttribution(directory, sessionID, wave.taskIds);
	}
	return {
		epic: updated,
		closedWave: summarizeClosedWave(closedRecord, computation.outcomes),
	};
}

/**
 * Commit, as residue, the dirty paths attributed to the wave's completed
 * tasks (declared scope or session write attribution). Returns a `blocked`
 * result when git fails (the wave stays open; retry), else null.
 */
function commitWaveResidue(
	directory: string,
	sessionID: string | undefined,
	epic: EpicRecordV1,
	wave: EpicWaveRecord,
	plan: Plan,
): EpicNextWaveResult | null {
	let dirty: ReturnType<typeof _internals.listDirtyEntries>;
	try {
		dirty = _internals.listDirtyEntries(directory);
	} catch (error) {
		return gitFailed(
			`Cannot read the working tree before closing wave ${wave.seq} (git status failed: ${errorText(error)}).`,
			error,
		);
	}
	for (const taskId of wave.taskIds) {
		if (dirty.length === 0) break;
		if (findTask(plan, taskId)?.task.status !== 'completed') continue;
		const result = _internals.commitTaskResidue({
			directory,
			epic,
			taskId,
			label: 'residue',
			candidates: _internals.collectTaskAttribution(
				directory,
				sessionID,
				taskId,
			),
			scopes: wave.files[taskId] ?? [],
			dirty,
		});
		if (result.status === 'failed') {
			return gitFailed(
				`Wave ${wave.seq} cannot close: task ${taskId}'s uncommitted files (${result.files.slice(0, 5).join(', ')}) could not be committed on the epic branch (${result.error}).`,
				result.error,
			);
		}
		if (result.status === 'committed') {
			const done = new Set(result.files);
			dirty = dirty.filter((entry) => !done.has(entry.path));
		}
	}
	return null;
}

function gitFailed(what: string, error: unknown): EpicNextWaveResult {
	return {
		status: 'blocked',
		reason: 'git-failed',
		details: { error: errorText(error) },
		message: `${what} Usually transient (a git lock) — call epic_next_wave again. If git stays broken, tell the user to repair the repository.`,
	};
}

function recordMergeFailureSnapshots(
	directory: string,
	epic: EpicRecordV1,
	seq: number,
	failures: {
		taskId: string;
		outcome: string;
		stage: string;
		message: string;
		at: number | null;
	}[],
): void {
	try {
		_internals.updateEpicRecord(
			directory,
			epic.epicKey,
			(record) => {
				const wave = record.waves.find((w) => w.seq === seq);
				if (!wave) return record;
				const merged = { ...(wave.mergeFailures ?? {}) };
				let changed = false;
				for (const f of failures) {
					const prior = merged[f.taskId];
					if (
						prior &&
						prior.outcome === f.outcome &&
						prior.stage === f.stage &&
						prior.at === f.at
					) {
						continue;
					}
					merged[f.taskId] = {
						outcome: f.outcome,
						stage: f.stage,
						message: f.message.slice(0, 500),
						at: f.at,
					};
					changed = true;
				}
				if (!changed) return record;
				return {
					...record,
					waves: record.waves.map((w) =>
						w.seq === seq ? { ...w, mergeFailures: merged } : w,
					),
				};
			},
			epic.token,
		);
	} catch {
		// Snapshot is outcome evidence only; the block itself is what matters.
	}
}

function syncPhases(
	directory: string,
	epic: EpicRecordV1,
	currentPhase: number,
	currentStatus: 'active' | 'review',
): void {
	const next = syncPhaseRecords(epic.phases, currentPhase, currentStatus);
	if (next === epic.phases) return;
	try {
		_internals.updateEpicRecord(
			directory,
			epic.epicKey,
			(record) => ({
				...record,
				phases: syncPhaseRecords(record.phases, currentPhase, currentStatus),
			}),
			epic.token,
		);
	} catch {
		// Bookkeeping only; the result still tells the architect what to do.
	}
}

/**
 * Tasks completed BEFORE the epic started. `/swarm epic start` refuses a
 * dirty tree, so their work is in HEAD even though the epic recorded no
 * commit (task ref) for them — they need none as predecessor evidence. A task
 * counts when the epic never resolved it in a wave and either its phase was
 * already finished at start, or its last transition to `completed` in the
 * plan ledger predates the start (or it was saved completed, with no
 * transition at all).
 */
export async function completedBeforeEpic(
	directory: string,
	epic: EpicRecordV1,
	plan: Plan,
): Promise<Set<string>> {
	const started = Date.parse(epic.startedAt);
	let events: Awaited<ReturnType<typeof readLedgerEvents_import>> = [];
	try {
		events = await _internals.readLedgerEvents(directory);
	} catch {
		events = [];
	}
	const lastCompleted = new Map<string, number>();
	for (const event of events) {
		if (
			event.event_type === 'task_status_changed' &&
			event.to_status === 'completed' &&
			typeof event.task_id === 'string'
		) {
			const at = Date.parse(event.timestamp);
			if (Number.isFinite(at)) lastCompleted.set(event.task_id, at);
		}
	}
	const result = new Set<string>();
	for (const phase of plan.phases) {
		const atStart = epic.phases[String(phase.id)]?.completeAtStart === true;
		for (const task of phase.tasks ?? []) {
			if (task.status !== 'completed' || epic.tasks[task.id]) continue;
			const at = lastCompleted.get(task.id);
			if (
				atStart ||
				at === undefined ||
				(Number.isFinite(started) && at < started)
			) {
				result.add(task.id);
			}
		}
	}
	return result;
}

async function issueNextWave(
	directory: string,
	config: PluginConfig,
	epic: EpicRecordV1,
	plan: Plan,
	phaseId: number,
): Promise<EpicNextWaveResult> {
	const phase = plan.phases.find((p) => p.id === phaseId);
	const batchIds = (phase?.tasks ?? [])
		.filter((task) => !isTaskResolved(task.status) && task.status !== 'blocked')
		.map((task) => task.id);
	const liveScopes = _internals.resolveEpicDeclaredScopes(
		directory,
		plan,
		batchIds,
	);

	// Predecessor evidence (git only): a completed dependency outside the
	// batch is satisfied when it was completed before the epic started, or
	// its task ref (mirrored from the epic record) is an ancestor of HEAD.
	let isCommitted: (taskId: string) => boolean = () => true;
	if (epic.git.isRepo) {
		const needed = new Set<string>();
		for (const task of phase?.tasks ?? []) {
			if (!batchIds.includes(task.id)) continue;
			for (const dep of task.depends ?? []) {
				if (
					!batchIds.includes(dep) &&
					findTask(plan, dep)?.task.status === 'completed'
				) {
					needed.add(dep);
				}
			}
		}
		if (needed.size > 0) {
			try {
				const preEpic = await completedBeforeEpic(directory, epic, plan);
				const refs = _internals.syncEpicRefs(directory, epic);
				const committed = new Set<string>();
				for (const dep of needed) {
					if (preEpic.has(dep)) {
						committed.add(dep);
						continue;
					}
					const sha = refs.get(epicTaskRef(epic.epicKey, dep));
					if (sha && _internals.isCommitAncestorOfHead(directory, sha)) {
						committed.add(dep);
					}
				}
				isCommitted = (taskId) => committed.has(taskId);
			} catch (error) {
				return gitFailed(
					`Cannot verify that completed predecessor tasks are on the epic branch: reading or writing the epic's task refs failed (${errorText(error)}).`,
					error,
				);
			}
		}
	}

	// Plan with every closed wave learned: catch up an update a crash lost
	// between a wave's close and its learning step (idempotent per wave seq;
	// nothing pending ⇒ one posterior read, no write).
	_internals.recordEpicWaveLearning({ directory, config, record: epic });
	const signals = await loadEpicPlanningSignals(
		directory,
		config,
		{
			loadLearningView: _internals.loadEpicLearningView,
			getCoChangeData: _internals.getCoChangeData,
			now: _internals.now,
		},
		{ epicKey: epic.epicKey, token: epic.token },
	);
	const cochange = signals.cochange;
	const selection = selectNextEpicWave({
		directory,
		plan,
		phaseId,
		liveScopes,
		maxParallel: epic.config.maxParallel,
		leanConfig: { ...DEFAULT_LEAN_TURBO_CONFIG, ...(config.turbo?.lean ?? {}) },
		isCommitted,
		hotFiles: signals.hotFiles,
		coWrites: signals.coWrites,
		cochange,
		densityThreshold: signals.densityThreshold,
		waveHistory: epic.waves.filter((wave) => wave.phase === phaseId),
	});
	switch (selection.kind) {
		case 'none':
			// Unreachable: the caller only plans a phase with unresolved tasks.
			return {
				status: 'phase-ready-for-review',
				phase: phaseId,
				message: `Phase ${phaseId} has no task left to run. Call epic_phase_review({ phase: ${phaseId} }).`,
			};
		case 'task-blocked':
			return {
				status: 'blocked',
				reason: 'task-blocked',
				details: { taskIds: selection.taskIds },
				message: `No task of phase ${phaseId} can run: ${selection.taskIds.join(', ')} ${selection.taskIds.length === 1 ? 'is' : 'are'} blocked and the rest depend on ${selection.taskIds.length === 1 ? 'it' : 'them'}. Tell the user why; fix each blocked task through the per-task flow, or close it (update_task_status closed) if the user drops it. Then call epic_next_wave.`,
			};
		case 'predecessor-missing':
			return {
				status: 'blocked',
				reason: 'predecessor-missing',
				details: { problems: selection.problems },
				message: predecessorMessage(selection.problems, epic.planKey),
			};
		case 'declare-scopes':
			return {
				status: 'declare-scopes',
				phase: phaseId,
				tasks: selection.tasks,
				message: `Before the next wave, call declare_scope once per task — one taskId per call — with the exact files each will touch, including the test files the test_engineer will write for it (start from suggestedFiles; keep scopes tight and disjoint; add replace_existing: true when re-declaring): ${selection.tasks.map((t) => t.taskId).join(', ')}. Then call epic_next_wave.`,
			};
		case 'wave':
			break;
	}
	const waveCochange = cochange
		? { pairs: selection.cochangePairs, threshold: cochange.threshold }
		: null;
	const waveTaskIds = assertWaveDisjoint(
		directory,
		plan,
		selection.taskIds,
		selection.files,
		waveCochange,
	);

	let untrackedNote = '';
	if (epic.git.isRepo) {
		const baseline = settleDirtyBaseline(directory);
		if ('result' in baseline) return baseline.result;
		untrackedNote = baseline.untrackedNote;
	}

	const nowIso = new Date(_internals.now()).toISOString();
	const baseHead = epic.git.isRepo ? _internals.readHead(directory) : null;
	let issued: EpicWaveRecord | null = null;
	let existing: EpicWaveRecord | null = null;
	const updated = _internals.updateEpicRecord(
		directory,
		epic.epicKey,
		(record) => {
			issued = null;
			existing = null;
			if (record.activeWaveSeq !== null) {
				existing =
					record.waves.find((w) => w.seq === record.activeWaveSeq) ?? null;
				return record;
			}
			const seq = record.waves.reduce((max, w) => Math.max(max, w.seq), 0) + 1;
			const wave: EpicWaveRecord = {
				seq,
				phase: phaseId,
				kind: selection.waveKind,
				taskIds: waveTaskIds,
				files: pickFiles(selection.files, waveTaskIds),
				cochange: waveCochange,
				components: selection.components,
				baseHead,
				issuedAt: nowIso,
				status: 'issued',
			};
			issued = wave;
			return {
				...record,
				waves: [...record.waves, wave],
				activeWaveSeq: seq,
				phases: syncPhaseRecords(record.phases, phaseId, 'active'),
			};
		},
		epic.token,
	);
	if (!updated) return describeNoEpic(directory);
	const concurrent = existing as EpicWaveRecord | null;
	if (!issued && concurrent) {
		return {
			status: 'in-progress',
			wave: toWaveView(concurrent, plan),
			waitingOn: concurrent.taskIds.map((taskId) => ({
				taskId,
				state: findTask(plan, taskId)?.task.status ?? 'removed',
			})),
			message: `Wave ${concurrent.seq} was issued concurrently and is in progress. Finish its tasks, then call epic_next_wave.`,
		};
	}
	const wave = issued as EpicWaveRecord | null;
	if (!wave) return describeNoEpic(directory);
	const view: EpicWaveView = toWaveView(wave, plan);
	return {
		status: 'dispatch',
		wave: view,
		instructions: `${buildDispatchInstructions(view)}${untrackedNote}`,
	};
}

/**
 * Epic v2 C4 — the issue-time half of the gate's single source of truth: a
 * multi-task wave is issued only when THE wave verdict
 * (`computeEpicWaveVerdict`, the exact call the delegation gate repeats at
 * dispatch over the wave's frozen scopes) is `all_disjoint`. The selection
 * already excludes path and co-change conflicts, so a failure here is a
 * planner bug: the wave is narrowed to its first task in the verdict's
 * serial order (the others return in a later wave) — never issued as a
 * parallel wave the gate would then serialize. Returns the task ids to issue.
 */
function assertWaveDisjoint(
	directory: string,
	plan: Plan,
	taskIds: string[],
	files: Record<string, string[]>,
	cochange: EpicWaveRecord['cochange'],
): string[] {
	if (taskIds.length < 2) return taskIds;
	let verdict: ReturnType<typeof computeEpicWaveVerdict_import>;
	try {
		verdict = _internals.computeEpicWaveVerdict(
			directory,
			plan,
			{ files, cochange },
			taskIds,
		);
	} catch (error) {
		logger.criticalWarn(
			`[epic/next-wave] wave verdict failed (${errorText(error)}); issuing ${taskIds[0]} alone`,
		);
		return [taskIds[0]];
	}
	if (verdict.verdict === 'all_disjoint') return taskIds;
	const first = verdict.suggestedSerialOrder[0] ?? taskIds[0];
	logger.criticalWarn(
		`[epic/next-wave] wave selection [${taskIds.join(', ')}] is not provably disjoint (${verdict.verdict}); issuing ${first} alone`,
	);
	return [first];
}

function pickFiles(
	files: Record<string, string[]>,
	taskIds: readonly string[],
): Record<string, string[]> {
	const picked: Record<string, string[]> = Object.create(null);
	for (const id of taskIds) picked[id] = files[id] ?? [];
	return picked;
}

/**
 * The working tree before a new wave (X1 `dirty-baseline`). The closing
 * wave's residue was already committed, so nothing dirty belongs to a task:
 * a TRACKED change blocks the wave; untracked files are only reported
 * (worktree coders do not see them).
 */
function settleDirtyBaseline(
	directory: string,
): { result: EpicNextWaveResult } | { untrackedNote: string } {
	let dirty: ReturnType<typeof _internals.listDirtyEntries>;
	try {
		dirty = _internals.listDirtyEntries(directory);
	} catch (error) {
		return {
			result: gitFailed(
				`Cannot check the working tree before the next wave (git status failed: ${errorText(error)}).`,
				error,
			),
		};
	}
	if (dirty.length === 0) return { untrackedNote: '' };
	const classified = classifyDirtyBaseline(dirty);
	const tracked = classified.unattributedTracked;
	if (tracked.length > 0) {
		return {
			result: {
				status: 'blocked',
				reason: 'dirty-baseline',
				details: { files: tracked.slice(0, 20), total: tracked.length },
				message: `The working tree has ${tracked.length} uncommitted change(s) to tracked files outside .swarm/ that no epic task declared (${tracked.slice(0, 5).join(', ')}${tracked.length > 5 ? ', …' : ''}) — manual edits or undeclared writes. Coders need a clean baseline. Tell the user and ask them to commit (on the epic branch) or discard them; then call epic_next_wave.`,
			},
		};
	}
	const untracked = classified.unattributedUntracked;
	if (untracked.length === 0) return { untrackedNote: '' };
	return {
		untrackedNote: `\nNote: ${untracked.length} untracked file(s) outside .swarm/ belong to no task (${untracked.slice(0, 5).join(', ')}${untracked.length > 5 ? ', …' : ''}). They stay uncommitted and the wave's worktree coders do not see them; tell the user in one sentence (commit, ignore, or delete them).`,
	};
}
