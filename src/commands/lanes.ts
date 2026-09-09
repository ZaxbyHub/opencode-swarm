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
import {
	scanWorktreeRecoveryAuthoritiesForRecovery,
	type WorktreeRecoveryAuthorityRecord,
	type WorktreeRecoveryClaimState,
	type WorktreeRecoveryStatus,
	type WorktreeRecoveryStrategy,
} from '../hooks/delegation-gate/worktree-recovery-authority';

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
	recovery?: LaneRecoveryView;
	manualRecoveryHint?: string;
	recoveryHint: string;
}

export interface LaneRecoveryView {
	authorityStatus: WorktreeRecoveryStatus | 'unsupported-legacy' | 'uncertain';
	generation?: number;
	originalCallID?: string;
	parentSessionId?: string;
	reservationId?: string;
	canonicalBranch?: string;
	canonicalPath?: string;
	laneBranch?: string;
	lanePath?: string;
	strategy?: WorktreeRecoveryStrategy;
	claim?: LaneRecoveryClaimView;
	redispatchStatus:
		| 'available'
		| 'claimed'
		| 'manual-only'
		| 'unsupported-legacy'
		| 'uncertain';
}

export interface LaneRecoveryClaimView {
	claimantCallID: string;
	claimantSessionId: string;
	childSessionId: string;
	claimRevision: number;
	attempt: number;
	leaseState: 'claimed';
}

function renderRecoveryIdentity(recovery: LaneRecoveryView): string {
	const parts = [`status=${recovery.authorityStatus}`];
	if (recovery.generation !== undefined) {
		parts.unshift(`generation=${recovery.generation}`);
	}
	if (recovery.parentSessionId) {
		parts.push(`parentSession=${recovery.parentSessionId}`);
	}
	if (recovery.originalCallID) {
		parts.push(`originalCall=${recovery.originalCallID}`);
	}
	if (recovery.reservationId) {
		parts.push(`reservation=${recovery.reservationId}`);
	}
	if (recovery.strategy) {
		parts.push(`strategy=${recovery.strategy}`);
	}
	return parts.join(' ');
}

function toClaimView(claim: WorktreeRecoveryClaimState): LaneRecoveryClaimView {
	return {
		claimantCallID: claim.claimantCallID,
		claimantSessionId: claim.claimantSessionId,
		childSessionId: claim.childSessionId,
		claimRevision: claim.claimRevision,
		attempt: claim.attempt,
		leaseState: 'claimed',
	};
}

function selectRecoveryAuthority(
	authorities: WorktreeRecoveryAuthorityRecord[],
	taskId: string,
	failure: WorktreeMergeFailure,
): WorktreeRecoveryAuthorityRecord | undefined {
	const taskMatches = authorities.filter(
		(authority) => authority.immutable.taskId === taskId,
	);
	if (taskMatches.length === 0) return undefined;

	let narrowed = taskMatches;
	if (failure.branch) {
		const branchMatches = narrowed.filter(
			(authority) => authority.immutable.laneBranch === failure.branch,
		);
		if (branchMatches.length > 0) narrowed = branchMatches;
	}
	if (failure.worktreePath) {
		const pathMatches = narrowed.filter(
			(authority) => authority.immutable.lanePath === failure.worktreePath,
		);
		if (pathMatches.length > 0) narrowed = pathMatches;
	}

	return [...narrowed].sort(
		(left, right) =>
			right.immutable.generation - left.immutable.generation ||
			right.immutable.createdAt - left.immutable.createdAt,
	)[0];
}

function buildRecoveryView(
	directory: string,
	taskId: string,
	failure: WorktreeMergeFailure,
): LaneRecoveryView | undefined {
	const scan = scanWorktreeRecoveryAuthoritiesForRecovery(directory);
	if (scan.status === 'unsupported-legacy') {
		return {
			authorityStatus: 'unsupported-legacy',
			redispatchStatus: 'unsupported-legacy',
		};
	}
	if (scan.status === 'uncertain') {
		return {
			authorityStatus: 'uncertain',
			redispatchStatus: 'uncertain',
		};
	}
	const authority = selectRecoveryAuthority(scan.authorities, taskId, failure);
	if (!authority) return undefined;
	return {
		authorityStatus: authority.status,
		generation: authority.immutable.generation,
		originalCallID: authority.immutable.originalCallID,
		parentSessionId: authority.immutable.parentSessionId,
		reservationId: authority.immutable.reservationId,
		canonicalBranch: authority.immutable.canonicalBranch,
		canonicalPath: authority.immutable.canonicalPath,
		laneBranch: authority.immutable.laneBranch,
		lanePath: authority.immutable.lanePath,
		strategy: authority.immutable.strategy,
		claim: authority.claim ? toClaimView(authority.claim) : undefined,
		redispatchStatus:
			authority.status === 'claimed'
				? 'claimed'
				: authority.status === 'finalized'
					? 'manual-only'
					: 'available',
	};
}

/**
 * Build a one-line recovery hint from merge failure data.
 */
function buildManualRecoveryHint(
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

function buildRecoveryHint(
	failure: WorktreeMergeFailure | undefined,
	worktreePath: string,
	recovery?: LaneRecoveryView,
): string {
	if (!failure) return '';
	if (recovery?.redispatchStatus === 'available') {
		return `Re-dispatch the exact same task in parent session ${recovery.parentSessionId} to claim generation ${recovery.generation} instead of allocating a new lane.`;
	}
	if (recovery?.redispatchStatus === 'claimed' && recovery.claim) {
		return `Same-task recovery is already claimed by ${recovery.claim.claimantCallID}; wait for that claimant to settle or cancel it before retrying again.`;
	}
	if (recovery?.redispatchStatus === 'unsupported-legacy') {
		return 'Same-task redispatch is unavailable because only legacy recovery metadata was found; use manual lane recovery for this preserved worktree.';
	}
	if (recovery?.redispatchStatus === 'uncertain') {
		return 'Same-task redispatch is unavailable until the recovery metadata is repaired; use manual lane recovery for this preserved worktree.';
	}
	return buildManualRecoveryHint(failure, worktreePath);
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
		const recovery = buildRecoveryView(directory, taskId, failure);

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
			manualRecoveryHint: buildManualRecoveryHint(failure, worktreePath),
			recovery,
			recoveryHint: buildRecoveryHint(failure, worktreePath, recovery),
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
				if (lane.recovery) {
					lines.push(`    recovery: ${renderRecoveryIdentity(lane.recovery)}`);
					if (lane.recovery.claim) {
						lines.push(
							`    claimant: call=${lane.recovery.claim.claimantCallID} session=${lane.recovery.claim.claimantSessionId} child=${lane.recovery.claim.childSessionId} revision=${lane.recovery.claim.claimRevision} attempt=${lane.recovery.claim.attempt}`,
						);
					}
					if (lane.recoveryHint) {
						lines.push(`    redispatch: ${lane.recoveryHint}`);
					}
					if (
						lane.manualRecoveryHint &&
						lane.recovery.redispatchStatus !== 'available' &&
						lane.recovery.redispatchStatus !== 'claimed'
					) {
						lines.push(`    hint: ${lane.manualRecoveryHint}`);
					}
				} else if (lane.recoveryHint) {
					lines.push(`    hint: ${lane.recoveryHint}`);
				}
			}
		}
		lines.push('');
	}
	lines.push(`Total: ${lanes.length} lanes`);
	return lines.join('\n');
}
