/**
 * Result shapes and architect-facing text of `epic_next_wave` (Epic v2 C2).
 * Pure: no I/O. The procedure lives in these responses (the banner only
 * says "call epic_next_wave and do exactly what its status says").
 */

import type { Plan } from '../config/plan-schema.js';
import type {
	EpicPhaseRecord,
	EpicTaskOutcome,
	EpicWaveRecord,
} from './lifecycle.js';
import type { EpicPredecessorProblem } from './wave-select.js';

export interface EpicWaveView {
	seq: number;
	phase: number;
	kind: EpicWaveRecord['kind'];
	taskIds: string[];
	files: Record<string, string[]>;
	tasks: { taskId: string; description: string; files: string[] }[];
	issuedAt: string;
}

/** What the call just closed (present on results that follow a close). */
export interface EpicClosedWaveSummary {
	seq: number;
	phase: number;
	taskIds: string[];
	resolutions: Record<string, EpicTaskOutcome['resolution']>;
	closeHead: string | null;
	/** Tasks with undeclared writes (session or single-task git attribution). */
	divergence: { taskId: string; undeclared: string[] }[];
	/** Wave-level undeclared files no task's attribution explains. */
	waveUndeclared: string[];
}

export type EpicNextWaveRefusal =
	| 'no-open-epic'
	| 'epic-orphaned'
	| 'epic-state-unreadable'
	| 'epic-disabled-by-config';

export type EpicNextWaveBlockReason =
	| 'task-blocked'
	| 'merge-failed'
	| 'landing-index-dirty'
	| 'git-failed'
	| 'dirty-baseline'
	| 'predecessor-missing'
	| 'plan-revised'
	| 'task-reopened'
	| 'epic-branch-mismatch';

type WithClosed = { closedWave?: EpicClosedWaveSummary };

export type EpicNextWaveResult =
	| ({
			status: 'dispatch';
			wave: EpicWaveView;
			instructions: string;
	  } & WithClosed)
	| ({
			status: 'declare-scopes';
			phase: number;
			tasks: { taskId: string; suggestedFiles: string[] }[];
			message: string;
	  } & WithClosed)
	| ({
			status: 'in-progress';
			wave: EpicWaveView;
			waitingOn: { taskId: string; state: string }[];
			message: string;
	  } & WithClosed)
	| ({
			status: 'blocked';
			reason: EpicNextWaveBlockReason;
			details: Record<string, unknown>;
			message: string;
	  } & WithClosed)
	| ({
			status: 'phase-ready-for-review';
			phase: number;
			message: string;
	  } & WithClosed)
	| ({ status: 'epic-complete'; message: string } & WithClosed)
	| { status: 'refused'; reason: EpicNextWaveRefusal; message: string };

/**
 * How review findings are fixed while an epic is open (C4): coders run only
 * through waves, so a fix is a NEW pending task of the phase — `epic_next_wave`
 * then runs it as a fix wave (scopes, landing commit, refs, outcomes) and
 * returns `phase-ready-for-review` again.
 */
export function epicPhaseFixPath(phase: number): string {
	return `While an epic is open, coders run only through epic waves, so do NOT re-dispatch coders for completed tasks: ${epicPhaseFixSteps(phase)}`;
}

/** The fix-task steps of {@link epicPhaseFixPath} on their own. */
export function epicPhaseFixSteps(phase: number): string {
	return `add each fix as a NEW pending task of phase ${phase} with save_plan (a description and its files_touched; get plan-critic approval if your project requires it after a plan change), then call epic_next_wave — it asks you to declare_scope the new task(s) and issues a fix wave. When the fix wave is done, epic_next_wave returns phase-ready-for-review again; then re-run epic_phase_review({ phase: ${phase} }).`;
}

export function refused(
	reason: EpicNextWaveRefusal,
	message: string,
): EpicNextWaveResult {
	return { status: 'refused', reason, message };
}

export function toWaveView(wave: EpicWaveRecord, plan: Plan): EpicWaveView {
	const describe = (taskId: string): string => {
		for (const phase of plan.phases) {
			const task = (phase.tasks ?? []).find((t) => t.id === taskId);
			if (task) return task.description;
		}
		return '(no longer in the plan)';
	};
	return {
		seq: wave.seq,
		phase: wave.phase,
		kind: wave.kind,
		taskIds: [...wave.taskIds],
		files: wave.files,
		tasks: wave.taskIds.map((taskId) => ({
			taskId,
			description: describe(taskId),
			files: [...(wave.files[taskId] ?? [])],
		})),
		issuedAt: wave.issuedAt,
	};
}

/** The step-by-step text returned with every `dispatch`. */
export function buildDispatchInstructions(wave: EpicWaveView): string {
	const n = wave.taskIds.length;
	const kind =
		wave.kind === 'exclusive'
			? 'exclusive — this task runs alone (it touches a global, protected, or historically hot file, or has no usable scope)'
			: wave.kind === 'serial-component'
				? 'serial-component — this task belongs to a densely coupled cluster of tasks that run one per wave, and no other ready task could join it'
				: 'parallel — the tasks have disjoint declared scopes (at most one task per densely coupled cluster)';
	return [
		`Wave ${wave.seq} of phase ${wave.phase} (${kind}): ${n} task(s) — ${wave.taskIds.join(', ')}.`,
		'1. Tell the user, in one sentence, which tasks this wave runs and why.',
		n === 1
			? '2. Dispatch ONE Task(subagent_type="coder") for it.'
			: `2. Dispatch ${n} SEPARATE Task(subagent_type="coder") calls, ALL in ONE assistant message (one per taskId) so they run concurrently. Never bundle several task ids into one Task; never split the wave across messages.`,
		'   Each coder prompt: the task id, its description and acceptance criteria, and its declared scope (`wave.tasks[].files`) — the coder writes only inside that scope.',
		"   The scopes are FROZEN for this wave: the gate admits a coder only for a task of this wave whose declared scope stays inside its `wave.tasks[].files` (otherwise EPIC_WAVE_SCOPE_DRIFT) — do not widen a scope now. Declared files written in the main tree (tests, docs) are committed on the epic branch as the task's residue; each coder runs in its own git worktree and its work lands as a commit when it returns.",
		"3. As each coder returns, run that task's per-task QA — Stage A `pre_check_batch` with `files` set to THAT task's files (a wave runs several tasks, so each Stage A run is credited by its files to the one task whose frozen scope owns them; no files or mixed tasks ⇒ credited to none), then Stage B `reviewer` + `test_engineer` (per its tier) — then `update_task_status(<taskId>, completed)`. Per-task QA is never waived. A returned coder's work is already committed on the epic branch (`swarm(task <id>): …`), so the working tree stays clean: point the reviewer and test_engineer at the task's declared files and that commit, not at uncommitted changes. If QA fails, send the task back to its coder (it starts from the committed work and the tests) and repeat the QA. If a task cannot be finished, tell the user and mark it blocked (or closed if the user drops it).",
		'4. When every task of this wave is completed (or closed), call `epic_next_wave` again — it closes the wave (records outcomes and divergence) and issues the next one.',
	].join('\n');
}

export function summarizeClosedWave(
	wave: EpicWaveRecord,
	outcomes: EpicTaskOutcome[],
): EpicClosedWaveSummary {
	const resolutions: Record<string, EpicTaskOutcome['resolution']> = {};
	for (const outcome of outcomes)
		resolutions[outcome.taskId] = outcome.resolution;
	return {
		seq: wave.seq,
		phase: wave.phase,
		taskIds: [...wave.taskIds],
		resolutions,
		closeHead: wave.closeHead ?? null,
		divergence: outcomes
			.filter((o) => o.undeclared.length > 0)
			.map((o) => ({ taskId: o.taskId, undeclared: o.undeclared })),
		waveUndeclared: wave.undeclared ?? [],
	};
}

const PREDECESSOR_WHY: Record<EpicPredecessorProblem['why'], string> = {
	removed: 'is no longer in the plan',
	closed: 'was closed (its work will never exist)',
	'later-phase': 'belongs to a later phase',
	'not-committed':
		'is completed but its commit is not on the epic branch (no epic task ref, or the ref is no longer reachable from HEAD — e.g. it was completed outside a wave, or a rebase/amend rewrote its commit)',
	cycle: 'forms a dependency cycle',
};

export function predecessorMessage(
	problems: EpicPredecessorProblem[],
	planKey: string,
): string {
	const lines = problems
		.slice(0, 10)
		.map(
			(p) =>
				`${p.taskId} depends on ${p.dependency}, which ${PREDECESSOR_WHY[p.why]}`,
		);
	const more = problems.length > 10 ? ` (+${problems.length - 10} more)` : '';
	const committedHint = problems.some((p) => p.why === 'not-committed')
		? ` For a task whose work IS on the epic branch, ask the user to run \`/swarm epic status --repair-refs\` (it re-adopts the task's commit: its \`swarm(task <id>): …\` commit with the trailer \`Swarm-Plan: ${planKey}\`, else the newest commit touching its declared files); if its work is missing, re-run the task.`
		: '';
	return `These tasks can never run as planned: ${lines.join('; ')}${more}. Tell the user and fix the plan — drop or correct the dependency (save_plan), or close the dependent task (update_task_status closed).${committedHint} Then call epic_next_wave.`;
}

/**
 * Phase bookkeeping: the current phase takes `currentStatus` (`active` while
 * waves run, `review` once every task is resolved). A phase recorded
 * `complete` (by `phase_complete`) is never downgraded. Returns the SAME
 * object when nothing changes (callers skip the write).
 */
export function syncPhaseRecords(
	phases: Record<string, EpicPhaseRecord>,
	currentPhase: number,
	currentStatus: 'active' | 'review',
): Record<string, EpicPhaseRecord> {
	const key = String(currentPhase);
	const prior = phases[key];
	if (prior?.status === currentStatus || prior?.status === 'complete') {
		return phases;
	}
	return {
		...phases,
		[key]: {
			status: currentStatus,
			reviewRuns: prior?.reviewRuns ?? 0,
			verdicts: prior?.verdicts ?? [],
		},
	};
}
