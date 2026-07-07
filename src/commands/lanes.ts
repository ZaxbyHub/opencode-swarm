/**
 * /swarm lanes command — lists active, awaiting-merge, and conflicted worktree lanes.
 *
 * FR-105: SC-114, SC-115, SC-116, SC-117
 */

import {
	awaitingMergeByCallID,
	standardWorktreeByCallID,
} from '../hooks/delegation-gate/worktree-isolation';
import {
	getAllWorktreeMergeFailures,
	initDurableStatusPath,
	type WorktreeMergeFailure,
} from '../hooks/delegation-gate/worktree-merge-status';

/**
 * Lane record shape for machine-parseable output (--json).
 */
export interface LaneRecord {
	state: 'active' | 'awaiting-merge' | 'conflicted';
	laneId: string;
	branch: string;
	worktreePath: string;
	taskId: string;
	planTaskId?: string;
	parentSessionID: string;
	mergeStrategy: 'merge' | 'rebase' | 'cherry-pick';
	mergeOutcome?: WorktreeMergeFailure;
	recoveryHint: string;
}

/**
 * Build a one-line recovery hint from merge failure data.
 */
function buildRecoveryHint(
	failure: WorktreeMergeFailure | undefined,
	worktreePath: string,
): string {
	if (!failure) return '';
	if (failure.stage === 'conflict') {
		return `Merge conflict at ${worktreePath}. Resolve manually, then re-run merge.`;
	}
	if (failure.outcome === 'partial') {
		return `Partial merge preserved at ${worktreePath}. Stage and commit, then re-run merge.`;
	}
	return `Merge-back failed at stage "${failure.stage}" (${failure.message}). Manual review required.`;
}

/**
 * Returns a deterministic ordering value for lane states.
 */
const STATE_ORDER: Record<LaneRecord['state'], number> = {
	active: 0,
	'awaiting-merge': 1,
	conflicted: 2,
};

/**
 * Handle the `/swarm lanes` command.
 *
 * Reads authoritative in-flight state from `standardWorktreeByCallID` and
 * merge failure records from `worktree-merge-status.ts`. Produces two
 * output formats controlled by the `--json` flag:
 *
 * - Human-readable (default): grouped by state with one-line summaries.
 * - Machine-parseable (--json): stable-order array of `LaneRecord` objects.
 *
 * @param directory - Project root directory (used to init the durable status path)
 * @param args      - Command arguments; `--json` selects machine-parseable output
 */
export function handleLanesCommand(directory: string, args: string[]): string {
	// Idempotent init of the durable merge-status path so getWorktreeMergeFailure
	// can read persisted failures on first call after plugin restart.
	try {
		initDurableStatusPath(directory);
	} catch {
		// Non-fatal: in-memory map still works; durable backup may be absent in tests.
	}

	const useJson = args.includes('--json');
	const lanes: LaneRecord[] = [];

	// SC-114: active lanes — dispatches still running (coder has not yet returned).
	for (const [callID, dispatch] of standardWorktreeByCallID) {
		lanes.push({
			state: 'active',
			laneId: callID,
			branch: dispatch.handle.branchName,
			worktreePath: dispatch.handle.worktreePath,
			taskId: dispatch.taskId,
			planTaskId: dispatch.planTaskId,
			parentSessionID: dispatch.parentSessionID,
			mergeStrategy: dispatch.mergeStrategy,
			mergeOutcome: undefined,
			recoveryHint: '',
		});
	}

	// SC-115: awaiting-merge lanes — coder returned, merge-back in progress.
	// Any merge-status entry for this taskId is from a PREVIOUS attempt and is
	// stale (the current retry is in-flight). Do NOT surface it.
	for (const [callID, record] of awaitingMergeByCallID) {
		lanes.push({
			state: 'awaiting-merge',
			laneId: callID,
			branch: record.branch,
			worktreePath: record.worktreePath,
			taskId: record.taskId,
			planTaskId: record.planTaskId,
			parentSessionID: record.parentSessionID,
			mergeStrategy: record.mergeStrategy,
			mergeOutcome: undefined,
			recoveryHint:
				'Merge-back in progress; check `/swarm status` for the latest.',
		});
	}

	// SC-116: conflicted lanes — merge-back completed with partial/failed outcome.
	// We iterate the in-memory failuresByTask map via a dedicated exported accessor.
	// For each failure, check it does NOT already appear in awaitingMergeByCallID
	// (which would mean merge-back is still in-flight and the record is stale).
	for (const [taskId, failure] of getAllWorktreeMergeFailures()) {
		// Find any awaiting-merge entry that matches this taskId — if found,
		// the merge is still in progress and this failure is stale (from a prior attempt).
		let isStale = false;
		for (const record of awaitingMergeByCallID.values()) {
			const recordKey = record.planTaskId ?? record.taskId;
			if (recordKey === taskId) {
				isStale = true;
				break;
			}
		}
		if (isStale) continue;

		// Use worktreePath/branch from the extended failure record when available;
		// fall back to an empty string for pre-extension durable records.
		const worktreePath = failure.worktreePath ?? '';
		const branch = failure.branch ?? '';

		lanes.push({
			state: 'conflicted',
			laneId: taskId, // taskId is the stable lane identifier for conflicted records
			branch,
			worktreePath,
			taskId,
			planTaskId: undefined,
			parentSessionID: '',
			mergeStrategy: 'merge',
			mergeOutcome: failure,
			recoveryHint: buildRecoveryHint(failure, worktreePath),
		});
	}

	// SC-117: deterministic ordering — by state group (active → awaiting-merge → conflicted),
	// then by laneId lexically within each group.
	lanes.sort(
		(a, b) =>
			STATE_ORDER[a.state] - STATE_ORDER[b.state] ||
			a.laneId.localeCompare(b.laneId),
	);

	if (useJson) {
		return JSON.stringify({ lanes, totalCount: lanes.length }, null, 2);
	}

	// Human-readable text format
	const lines: string[] = [];
	const byState: Record<string, LaneRecord[]> = {};
	for (const l of lanes) {
		const group = byState[l.state];
		if (group) {
			group.push(l);
		} else {
			byState[l.state] = [l];
		}
	}

	for (const state of ['active', 'awaiting-merge', 'conflicted'] as const) {
		const group = byState[state] ?? [];
		lines.push(`## ${state} (${group.length})`);
		if (group.length === 0) {
			lines.push('  (none)');
		} else {
			for (const lane of group) {
				const outcome = lane.mergeOutcome
					? ` [${lane.mergeOutcome.outcome} @ ${lane.mergeOutcome.stage}]`
					: '';
				lines.push(
					`  - ${lane.laneId} task=${lane.taskId} branch=${lane.branch}${outcome}`,
				);
				lines.push(`    worktree=${lane.worktreePath}`);
				if (lane.recoveryHint) lines.push(`    hint: ${lane.recoveryHint}`);
			}
		}
		lines.push('');
	}
	lines.push(`Total: ${lanes.length} lanes`);
	return lines.join('\n');
}
