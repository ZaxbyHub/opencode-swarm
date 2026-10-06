/**
 * Epic v2 C3 — how an epic task's coder work reaches the epic branch.
 *
 * Two seams in shared code rely on this module, both Epic-gated and both
 * costing exactly one `existsSync` (the epic sentinel) when no epic is open:
 *
 *   - `finishStandardWorktreeDispatch` (worktree-isolation.ts) asks
 *     {@link epicCommitLandingFor}: for a task of the open epic, on the epic
 *     branch, the lane lands as a real merge commit
 *     (`git merge --no-ff --no-edit -m <message>`, see `src/worktree/merge.ts`)
 *     whose message is `swarm(task <id>): <description>` + the plan's
 *     `Swarm-Plan:` trailer — instead of the default squash-unstaged landing.
 *     The work is therefore COMMITTED before `update_task_status(completed)`,
 *     so a rework coder (whose worktree is cut from HEAD) starts from it and
 *     its own landing no longer overlaps uncommitted bytes (critic B2).
 *   - the delegation gate's Epic dispatch policy (`gate-policy.ts`, C4)
 *     isolates every coder of an open git epic in a worktree (policy treated
 *     as `required`), whatever `parallelization_enabled`, the session's
 *     concurrency override or the preset say; when isolation cannot be
 *     provided the dispatch is refused with
 *     {@link epicIsolationDegradedMessage} instead of running un-isolated in
 *     the main tree (M-b).
 *
 * Non-git epics run serially in the main tree (one task per wave, M-i) and
 * never reach the landing seam's Epic branch.
 */

import * as logger from '../utils/logger.js';
import { checkEpicBranch as checkEpicBranch_import } from './epic-branch.js';
import { gitExecOnce as gitExecOnce_import } from './git-once.js';
import {
	type EpicPlanTaskRef,
	type EpicRecordV1,
	epicSentinelExists as epicSentinelExists_import,
	getOpenEpic as getOpenEpic_import,
	readPlanTaskRef as readPlanTaskRef_import,
} from './lifecycle.js';
import { formatEpicTaskCommitMessage } from './plan-key.js';

/** DI seam (AGENTS.md invariant 7). Restore in `afterEach`. */
export const _internals = {
	epicSentinelExists: epicSentinelExists_import,
	getOpenEpic: getOpenEpic_import,
	readPlanTaskRef: readPlanTaskRef_import,
	checkEpicBranch: checkEpicBranch_import,
	gitExecOnce: gitExecOnce_import,
};

/** An open epic and one of its plan's tasks. */
export interface EpicTaskContext {
	epic: EpicRecordV1;
	task: EpicPlanTaskRef;
}

/**
 * The open epic and the task, when `taskId` is a task of the plan the open
 * epic is bound to; otherwise null. Sentinel first: one `existsSync` and
 * nothing else when no epic is open. Unreadable lifecycle state counts as
 * "no epic" here (Epic behaviour is off until repaired; `/swarm epic
 * status` reports it).
 */
export function resolveEpicTaskContext(
	directory: string,
	taskId: string | null | undefined,
): EpicTaskContext | null {
	if (!_internals.epicSentinelExists(directory)) return null;
	if (typeof taskId !== 'string' || taskId.trim().length === 0) return null;
	let epic: EpicRecordV1 | null;
	try {
		epic = _internals.getOpenEpic(directory);
	} catch {
		return null;
	}
	if (!epic) return null;
	const task = _internals.readPlanTaskRef(directory, taskId);
	return task ? { epic, task } : null;
}

/** The landing options an epic task's worktree merge-back uses. */
export interface EpicLandingOptions {
	commitLanding: true;
	landingCommitMessage: string;
}

/**
 * The epic task must NOT be landed now: a committed merge requires the
 * primary index to match HEAD, so unrelated staged entries would make it
 * fail (and could be swept into the merge). `message` starts with
 * `EPIC_LANDING_INDEX_DIRTY` and carries the remedy.
 */
export interface EpicLandingRefusal {
	refused: true;
	stage: typeof EPIC_LANDING_INDEX_STAGE;
	message: string;
}

/** Merge-failure stage recorded for an {@link EpicLandingRefusal}. */
export const EPIC_LANDING_INDEX_STAGE = 'epic-landing-index';

/**
 * Staged entries in the primary checkout (one single-attempt
 * `git diff --cached --name-only -z`). Throws when git fails.
 */
function stagedPaths(directory: string): string[] {
	return _internals
		.gitExecOnce(['diff', '--cached', '--name-only', '-z'], directory)
		.split('\0')
		.filter((file) => file.length > 0);
}

/**
 * Landing override for a worktree coder of `planTaskId`: a committed landing
 * with the Epic task message when the task belongs to the open git epic and
 * HEAD is on the epic's branch. Undefined otherwise — the caller keeps its
 * own (default) landing. A branch mismatch also yields undefined: the work
 * must never be COMMITTED onto a foreign branch; `epic_next_wave` blocks
 * `epic-branch-mismatch` until HEAD is back.
 */
export function epicCommitLandingFor(
	directory: string,
	planTaskId: string | null | undefined,
): EpicLandingOptions | EpicLandingRefusal | undefined {
	const context = resolveEpicTaskContext(directory, planTaskId);
	if (!context || !context.epic.git.isRepo) return undefined;
	const branch = _internals.checkEpicBranch(directory, context.epic);
	if (!branch.ok) {
		logger.criticalWarn(
			`[epic] task ${context.task.id} lands WITHOUT a commit: ${branch.message}`,
		);
		return undefined;
	}
	let staged: string[];
	try {
		staged = stagedPaths(directory);
	} catch (error) {
		return {
			refused: true,
			stage: EPIC_LANDING_INDEX_STAGE,
			message: `EPIC_LANDING_INDEX_DIRTY: task ${context.task.id} was not landed because the primary checkout's index could not be read (${error instanceof Error ? error.message : String(error)}); the lane is preserved. Remedy: make sure \`git diff --cached\` works and shows nothing, then re-dispatch the task (or recover the lane with \`/swarm lanes\`) and call epic_next_wave.`,
		};
	}
	if (staged.length > 0) {
		const shown = staged.slice(0, 10).join(' ');
		return {
			refused: true,
			stage: EPIC_LANDING_INDEX_STAGE,
			message: `EPIC_LANDING_INDEX_DIRTY: task ${context.task.id} was not landed because the primary checkout has ${staged.length} staged change(s) unrelated to the landing (${shown}${staged.length > 10 ? ' …' : ''}); a landing merge commit requires a clean index. The lane is preserved. Remedy: unstage them (\`git restore --staged -- ${shown}\`), then re-dispatch the task (or recover the lane with \`/swarm lanes\`) and call epic_next_wave.`,
		};
	}
	return {
		commitLanding: true,
		landingCommitMessage: formatEpicTaskCommitMessage(
			context.task.id,
			context.epic.planKey,
			context.task.description,
		),
	};
}

/**
 * Refusal text for an epic coder whose worktree dispatch could not be set
 * up. It wraps ANY error of that setup (isolation, provisioning, lifecycle
 * lock, …), so the original error is quoted verbatim.
 */
export function epicIsolationDegradedMessage(
	taskId: string,
	reason: string,
): string {
	return `EPIC_ISOLATION_DEGRADED: task ${taskId} belongs to the open epic, whose coders must run in an isolated git worktree, but the worktree dispatch could not be set up. Original error: ${reason} The coder was NOT dispatched (it never runs un-isolated in the main tree). Remedy: fix the cause named above and retry the dispatch (worktree.policy must not be "disabled"; a transient provisioning or lock failure usually clears on retry), or ask the user to end the epic with \`/swarm epic close --abandon\`.`;
}
