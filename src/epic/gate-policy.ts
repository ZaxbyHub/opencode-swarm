/**
 * Epic v2 C4 — the delegation gate's single source of truth while an epic is
 * open: coder dispatch is admitted ONLY for a task of the ACTIVE wave, and
 * the wave's parallelism is decided from the scopes FROZEN into the wave
 * record when `epic_next_wave` issued it (never from live bindings, which
 * expire and follow plan revisions — critic M4).
 *
 * {@link computeEpicWaveVerdict} is THE verdict call: `epic_next_wave`
 * asserts it is `all_disjoint` before it issues a multi-task wave, and the
 * gate recomputes exactly the same call over the wave's unresolved tasks
 * to decide `parallel`. The two can therefore never disagree.
 *
 * {@link resolveEpicDispatchPolicy} returns `null` when no epic is open for
 * the current plan — the gate then runs its normal (non-Epic) logic,
 * untouched. The gate calls it only after its own synchronous sentinel
 * check (one `existsSync`), so Epic-off costs nothing more. Everything here
 * is synchronous: no await, no microtask.
 *
 * Out of scope by construction (documented in docs/modes.md): PR-feedback
 * coders (the gate returns before this seam — they carry no plan task), and
 * reviewer / test_engineer / other agents (never routed through coder
 * admission).
 */

import * as path from 'node:path';
import type { Plan } from '../config/plan-schema.js';
import {
	type ComputeParallelVerdictOptions,
	computeParallelVerdict as computeParallelVerdict_import,
	type ParallelVerdict,
} from '../plan/parallel-verdict.js';
import { scopeContains } from '../scope/scope-binding.js';
import type { CoChangeEntry } from '../tools/co-change-analyzer.js';
import { isEpicModeConfigEnabledForDirectory as isEpicModeConfigEnabledForDirectory_import } from './config-gate.js';
import { checkEpicBranch as checkEpicBranch_import } from './epic-branch.js';
import {
	type EpicRecordV1,
	type EpicWaveRecord,
	epicSentinelExists as epicSentinelExists_import,
	getOpenEpic as getOpenEpic_import,
	inspectEpic as inspectEpic_import,
} from './lifecycle.js';
import { epicPhaseFixSteps } from './next-wave-format.js';

/** DI seam (AGENTS.md invariant 7). Restore in `afterEach`. */
export const _internals = {
	epicSentinelExists: epicSentinelExists_import,
	isEpicModeConfigEnabledForDirectory:
		isEpicModeConfigEnabledForDirectory_import,
	getOpenEpic: getOpenEpic_import,
	inspectEpic: inspectEpic_import,
	checkEpicBranch: checkEpicBranch_import,
	computeParallelVerdict: computeParallelVerdict_import,
};

export type EpicDispatchRejectCode =
	| 'EPIC_NO_ACTIVE_WAVE'
	| 'EPIC_TASK_NOT_IN_ACTIVE_WAVE'
	| 'EPIC_TASK_UNKNOWN'
	| 'EPIC_WAVE_SCOPE_DRIFT'
	| 'EPIC_STATE_UNREADABLE'
	| 'EPIC_CLOSING'
	| 'EPIC_BRANCH_MISMATCH';

export type EpicDispatchPolicy =
	| {
			kind: 'allow';
			/** Concurrent coders of this wave are allowed (slot cap = maxConcurrent). */
			parallel: boolean;
			/** The coder runs in an isolated git worktree (degradation refused). */
			isolate: boolean;
			/** The epic's wave width (`record.config.maxParallel`). */
			maxConcurrent: number;
	  }
	| { kind: 'reject'; code: EpicDispatchRejectCode; message: string };

/** The frozen part of a wave the verdict is computed from. */
export type EpicWaveScopes = Pick<EpicWaveRecord, 'files' | 'cochange'>;

/** A frozen wave pair as the verdict helper's co-change entry. */
function toCoChangeEntry(
	pair: NonNullable<EpicWaveRecord['cochange']>['pairs'][number],
): CoChangeEntry {
	return {
		fileA: pair.fileA,
		fileB: pair.fileB,
		npmi: pair.npmi,
		coChangeCount: pair.coChangeCount,
		// Not consulted by the conflict predicate (`epicPairConflict`).
		lift: 0,
		hasStaticEdge: false,
		totalCommits: 0,
		commitsA: 0,
		commitsB: 0,
	};
}

/** The verdict options for a wave's frozen scopes (exported for parity tests). */
export function epicWaveVerdictOptions(
	plan: Plan,
	wave: EpicWaveScopes,
): ComputeParallelVerdictOptions {
	return {
		plan,
		scopes: wave.files,
		useCochange: !!wave.cochange,
		...(wave.cochange
			? {
					cochangePairs: wave.cochange.pairs.map(toCoChangeEntry),
					cochangeThreshold: wave.cochange.threshold,
				}
			: {}),
	};
}

/**
 * THE wave verdict: `computeParallelVerdict` over `taskIds` with the wave's
 * frozen scopes (and frozen co-change pairs when the wave recorded them).
 * Used by `epic_next_wave` at issue and by the gate at dispatch.
 */
export function computeEpicWaveVerdict(
	directory: string,
	plan: Plan,
	wave: EpicWaveScopes,
	taskIds: string[],
): ParallelVerdict {
	return _internals.computeParallelVerdict(
		directory,
		taskIds,
		epicWaveVerdictOptions(plan, wave),
	);
}

function reject(
	code: EpicDispatchRejectCode,
	message: string,
): EpicDispatchPolicy {
	return { kind: 'reject', code, message };
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function findPlanTask(
	plan: Plan,
	taskId: string,
): Plan['phases'][number]['tasks'][number] | null {
	for (const phase of plan.phases) {
		const task = (phase.tasks ?? []).find((t) => t.id === taskId);
		if (task) return task;
	}
	return null;
}

function isResolved(status: string | undefined): boolean {
	return status === 'completed' || status === 'closed';
}

function list(items: readonly string[], max = 8): string {
	const shown = items.slice(0, max).join(', ');
	return items.length > max ? `${shown}, …` : shown;
}

/**
 * The open epic's dispatch policy for a coder of `incomingTaskId` whose
 * live declared scope is `liveBindingFiles`; `null` when no epic is open for
 * this plan (sentinel absent, no open row, Epic disabled by config, or the
 * epic is orphaned/closing).
 */
export function resolveEpicDispatchPolicy(
	directory: string,
	plan: Plan,
	incomingTaskId: string | null | undefined,
	liveBindingFiles: readonly string[] | null | undefined,
): EpicDispatchPolicy | null {
	if (!_internals.epicSentinelExists(directory)) return null;
	// Config first: with Epic disabled by config a leftover sentinel (even
	// over a corrupt row) never gates dispatch — Epic is off.
	if (!_internals.isEpicModeConfigEnabledForDirectory(directory)) return null;
	let epic: EpicRecordV1 | null;
	try {
		epic = _internals.getOpenEpic(directory, plan);
	} catch (error) {
		return reject(
			'EPIC_STATE_UNREADABLE',
			`Epic Mode is enabled and an epic sentinel exists, but the epic's lifecycle state is unreadable (${errorText(error)}). Coder dispatch is refused (fail closed) until it is repaired, because it cannot be told whether the coder belongs to an epic wave. Remedy: ask the user to run \`/swarm epic status\` (diagnose) and \`/swarm epic close --abandon\` (repair).`,
		);
	}
	if (!epic) {
		// `getOpenEpic` returns null for any row that is not `open` — including a
		// `closing` row left by an interrupted close. That silently ungated
		// dispatch for the whole window between `markEpicClosing` and
		// `deleteEpicState`, which is exactly the window in which a dispatched
		// coder would settle with no Epic context. Refuse while the epic is
		// closing, mirroring the next-wave gate in `describeNoEpic`
		// (`src/epic/next-wave.ts`).
		let closingKey: string | null = null;
		try {
			const record = _internals.inspectEpic(directory, null).record;
			if (record?.status === 'closing') closingKey = record.epicKey;
		} catch (error) {
			return reject(
				'EPIC_STATE_UNREADABLE',
				`Epic Mode is enabled and an epic sentinel exists, but the epic's lifecycle state could not be read to determine whether a close is in progress (${errorText(error)}). Coder dispatch is refused (fail closed). Remedy: ask the user to run \`/swarm epic status\` (diagnose) and \`/swarm epic close --abandon\` (repair).`,
			);
		}
		if (closingKey !== null) {
			return reject(
				'EPIC_CLOSING',
				`Epic \`${closingKey}\` is closing (an interrupted \`/swarm epic close\`), so a coder dispatched now would settle with no Epic context and merge back onto the branch the close is stepping off. Remedy: ask the user to rerun \`/swarm epic close\`.`,
			);
		}
		return null;
	}

	const branch = _internals.checkEpicBranch(directory, epic);
	if (!branch.ok) {
		return reject(
			'EPIC_BRANCH_MISMATCH',
			branch.message.replace(/^EPIC_BRANCH_MISMATCH:\s*/, ''),
		);
	}

	const taskId =
		typeof incomingTaskId === 'string' ? incomingTaskId.trim() : '';
	if (taskId.length === 0 || !findPlanTask(plan, taskId)) {
		return reject(
			'EPIC_TASK_UNKNOWN',
			`${taskId ? `task ${taskId} is` : 'the coder dispatch names no task that is'} not a task of the plan epic \`${epic.epicKey}\` runs, so it cannot be dispatched while the epic is open. Remedy: call epic_next_wave and dispatch only the task ids of the wave it returns.`,
		);
	}

	const wave =
		epic.activeWaveSeq === null
			? undefined
			: epic.waves.find(
					(w) => w.seq === epic.activeWaveSeq && w.status === 'issued',
				);
	if (!wave) {
		const inReview = Object.entries(epic.phases)
			.filter(([, record]) => record.status === 'review')
			.map(([phase]) => Number(phase))
			.filter((phase) => Number.isFinite(phase));
		const reviewNote =
			inReview.length > 0
				? ` Phase ${inReview[0]} is in review: to fix review findings, ${epicPhaseFixSteps(inReview[0])}`
				: '';
		return reject(
			'EPIC_NO_ACTIVE_WAVE',
			`no wave of epic \`${epic.epicKey}\` is active, so the coder for task ${taskId} is refused. Remedy: call epic_next_wave — it closes the finished wave and issues the next one — and dispatch only the tasks it returns.${reviewNote}`,
		);
	}
	if (!wave.taskIds.includes(taskId)) {
		return reject(
			'EPIC_TASK_NOT_IN_ACTIVE_WAVE',
			`task ${taskId} is not in the active wave ${wave.seq} (tasks: ${list(wave.taskIds)}). While an epic is open, coders run only for the active wave's tasks. Remedy: dispatch the wave's tasks, finish each (Stage A → Stage B → update_task_status(completed)), then call epic_next_wave for the next wave.`,
		);
	}

	// Containment, the predicate the write gates enforce: a frozen directory
	// covers every file beneath it.
	const frozen = wave.files[taskId] ?? [];
	const extra = (liveBindingFiles ?? []).filter(
		(file) => !scopeContains(frozen, file),
	);
	if (extra.length > 0) {
		return reject(
			'EPIC_WAVE_SCOPE_DRIFT',
			`task ${taskId}'s declared scope has path(s) outside the scope frozen when wave ${wave.seq} was issued (outside: ${list(extra)}; frozen: ${list(frozen)}). The wave's parallel safety was proven on the frozen scope, and a frozen scope never grows. Remedy, one of: (1) re-declare the task within the frozen scope (declare_scope replace_existing: true, no FILE: line outside it) and dispatch again; (2) if the task genuinely needs the extra paths, finish it within the frozen scope or close it (update_task_status closed), and add the extra work as a NEW pending task of the current phase (save_plan) — epic_next_wave plans it into a later wave with its own scope; (3) ask the user to end the epic (\`/swarm epic close --abandon\`).`,
		);
	}

	const isolate = epic.git.isRepo && epic.config.isolation === 'worktree';
	const unresolved = wave.taskIds.filter((id) => {
		const task = findPlanTask(plan, id);
		return task !== null && !isResolved(task.status);
	});
	let parallel = false;
	// Concurrent coders only in isolated git worktrees (M-i / critic M3:
	// never a concurrent main-tree writer).
	if (isolate && unresolved.includes(taskId) && unresolved.length >= 2) {
		try {
			parallel =
				computeEpicWaveVerdict(directory, plan, wave, unresolved).verdict ===
				'all_disjoint';
		} catch {
			parallel = false; // fail safe: serial within the wave
		}
	}
	return {
		kind: 'allow',
		parallel,
		isolate,
		maxConcurrent: Math.max(1, epic.config.maxParallel),
	};
}

// ─── Stage A attribution in a parallel wave ──────────────────────────────────

export type EpicGateAttribution =
	/** No open epic, no active wave, or a single-task wave: upstream behaviour. */
	| { kind: 'none' }
	/** Exactly one task of the active wave owns every checked file. */
	| { kind: 'task'; taskId: string }
	/** Fail closed: credit no task, and tell the architect why. */
	| { kind: 'unattributable'; message: string };

/**
 * The wave task a gate-tool run (`pre_check_batch`, …) belongs to while an
 * epic is open.
 *
 * Upstream credits a gate run to the session's single `currentTaskId`, which
 * holds whichever coder returned last. In a multi-task wave every Stage A run
 * would then be credited to that one task: the task whose files were checked
 * never reaches Stage B, and another task gets credit for a check it never
 * had. Epic knows each wave task's frozen scope, so it credits the run to the
 * ONE active-wave task whose frozen scope contains every checked file
 * (containment as the write gates enforce it: a frozen directory covers the
 * files beneath it). No files, no owner, several owners, or unreadable epic
 * state credit nothing (fail closed). Sentinel-first: one `existsSync` when
 * Epic is off.
 */
export function resolveEpicGateTaskAttribution(
	directory: string,
	files: readonly string[] | null,
): EpicGateAttribution {
	if (!_internals.epicSentinelExists(directory)) return { kind: 'none' };
	let epic: EpicRecordV1 | null;
	try {
		epic = _internals.getOpenEpic(directory);
	} catch (error) {
		return {
			kind: 'unattributable',
			message: `EPIC STAGE A ATTRIBUTION: the epic's lifecycle state is unreadable (${errorText(error)}), so this gate run cannot be credited to a wave task. Ask the user to run \`/swarm epic status\` (diagnose) or \`/swarm epic close --abandon\` (repair).`,
		};
	}
	if (!epic || epic.activeWaveSeq === null) return { kind: 'none' };
	const wave = epic.waves.find(
		(w) => w.seq === epic.activeWaveSeq && w.status === 'issued',
	);
	if (!wave || wave.taskIds.length < 2) return { kind: 'none' };

	const scopes = wave.taskIds
		.map((id) => `${id}: ${list(wave.files[id] ?? [])}`)
		.join('; ');
	const checked = (files ?? []).filter((file) => file.trim() !== '');
	if (checked.length === 0) {
		return {
			kind: 'unattributable',
			message: `EPIC STAGE A ATTRIBUTION: wave ${wave.seq} runs ${wave.taskIds.length} tasks at once, and this gate run names no files, so it cannot be credited to one task. Re-run it with \`files\` set to ONE task's changed files (frozen scopes — ${scopes}).`,
		};
	}
	const relative = checked.map((file) =>
		path.isAbsolute(file) ? path.relative(directory, file) : file,
	);
	const owners = wave.taskIds.filter((id) =>
		relative.every((file) => scopeContains(wave.files[id] ?? [], file)),
	);
	if (owners.length === 1) return { kind: 'task', taskId: owners[0] };
	return {
		kind: 'unattributable',
		message:
			owners.length === 0
				? `EPIC STAGE A ATTRIBUTION: no task of wave ${wave.seq} owns every checked file (${list(relative)}), so this gate run is credited to no task. Run the gate once per task, with \`files\` limited to that task's frozen scope (${scopes}).`
				: `EPIC STAGE A ATTRIBUTION: the checked files (${list(relative)}) fall inside the frozen scope of several wave-${wave.seq} tasks (${list(owners)}), so this gate run is credited to no task. Run it with files only one task owns (${scopes}).`,
	};
}

export type EpicPrFeedbackConflict = {
	code: 'EPIC_PR_FEEDBACK_SCOPE_OVERLAP' | 'EPIC_STATE_UNREADABLE';
	message: string;
};

/**
 * Review F-007: a PR-feedback coder is admitted outside the wave gate (its
 * authority is the authenticated PR-feedback declaration, not a plan task),
 * so nothing stopped it from writing files a running wave task owns. While
 * an epic has an ISSUED wave, refuse a PR-feedback coder whose declared files
 * overlap any of that wave's frozen task scopes — in either direction (a
 * declared directory that contains a frozen file overlaps too). Null when
 * there is no overlap, no issued wave, or no open epic; unreadable epic state
 * fails closed. Sentinel-first: one `existsSync` when Epic is off.
 */
export function resolveEpicPrFeedbackConflict(
	directory: string,
	declaredFiles: readonly string[] | null | undefined,
): EpicPrFeedbackConflict | null {
	if (!_internals.epicSentinelExists(directory)) return null;
	let epic: EpicRecordV1 | null;
	try {
		epic = _internals.getOpenEpic(directory);
	} catch (error) {
		return {
			code: 'EPIC_STATE_UNREADABLE',
			message: `the open epic's lifecycle state is unreadable (${errorText(error)}), so this PR-feedback coder cannot be checked against the running wave (fail closed). Ask the user to run \`/swarm epic status\`.`,
		};
	}
	if (!epic || epic.activeWaveSeq === null) return null;
	const wave = epic.waves.find(
		(w) => w.seq === epic.activeWaveSeq && w.status === 'issued',
	);
	if (!wave) return null;
	const declared = (declaredFiles ?? [])
		.filter((file) => file.trim() !== '')
		.map((file) =>
			path.isAbsolute(file) ? path.relative(directory, file) : file,
		);
	const owners: string[] = [];
	for (const taskId of wave.taskIds) {
		const frozen = wave.files[taskId] ?? [];
		const overlaps = declared.some(
			(file) =>
				scopeContains(frozen, file) ||
				frozen.some((entry) => scopeContains([file], entry)),
		);
		if (overlaps) owners.push(taskId);
	}
	if (owners.length === 0) return null;
	return {
		code: 'EPIC_PR_FEEDBACK_SCOPE_OVERLAP',
		message: `this PR-feedback coder's declared files (${list(declared)}) overlap the frozen scope of wave-${wave.seq} task(s) ${list(owners)}, which may be writing them right now. Let the wave finish (epic_next_wave closes it), then dispatch the PR-feedback coder.`,
	};
}
