import * as fs from 'node:fs';
import * as path from 'node:path';
import { SWARM_WORKTREE_DIR_NAME } from '../config/constants';
import { appendCoreEventSync } from '../events/core-events';
import {
	commitGateReleaseBatch,
	queryLiveMemberships,
} from '../hooks/knowledge-receipt-ledger';
import { clearTrajectoryStep } from '../hooks/trajectory-logger';
import { validateSwarmPath } from '../hooks/utils';
import { resetPrmSessionState } from '../prm';
import { sanitizeDiagnosticText } from '../scope/path-identity.js';
import {
	beginSnapshotCoordinationReset,
	type SnapshotCoordinationResetGuard,
} from '../session/snapshot-coordination-init.js';
import {
	clearSnapshotRows,
	clearSnapshotSessionOwnerships,
} from '../session/snapshot-store.js';
import { swarmState } from '../state';
import { recoverStaleCoderSettlements } from '../workflow/coder-settlement.js';
import {
	cleanupOrphanedBranches,
	type OrphanCleanupResult,
} from '../worktree/merge';
import {
	backupSwarmStateBeforeReset,
	type ResetBackupResult,
} from './reset-backup';

/**
 * _internals DI seam for testing reset-session without spawning real git processes.
 * Production code calls `_internals.cleanupOrphanedBranches(...)` so tests can
 * replace the function on this object without touching the real worktree/merge
 * module. Mutations are file-scoped and trivially restorable via afterEach.
 */
export const _internals: {
	cleanupOrphanedBranches: (
		directory: string,
		activeSessionIds: string[],
	) => Promise<OrphanCleanupResult>;
	backupSwarmStateBeforeReset: (
		directory: string,
		kind: 'reset' | 'reset-session',
		relEntries: string[],
	) => ResetBackupResult;
	recoverStaleCoderSettlements: typeof recoverStaleCoderSettlements;
	queryLiveMemberships: typeof queryLiveMemberships;
	commitGateReleaseBatch: typeof commitGateReleaseBatch;
	beginSnapshotCoordinationReset: typeof beginSnapshotCoordinationReset;
	releaseKnowledgeGateObligations: (
		directory: string,
		sessionID: string,
	) => Promise<string[]>;
} = {
	cleanupOrphanedBranches,
	backupSwarmStateBeforeReset,
	recoverStaleCoderSettlements,
	queryLiveMemberships,
	commitGateReleaseBatch,
	beginSnapshotCoordinationReset,
	releaseKnowledgeGateObligations: releaseKnowledgeGateObligations,
};

function errorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}

/**
 * Durably release every pending knowledge-application gate obligation for the
 * invoking session (issue #2398). Before this existed, `/swarm reset-session`
 * cleared no knowledge-gate state, so a session whose architect was stuck on
 * unacknowledged critical directives stayed blocked even after an explicit
 * operator reset. Only the invoking session's `architect_directive`
 * memberships without an application marker or an effective gate release are
 * touched; the knowledge store, its history, and every other session are
 * preserved. The summary line and the audit event count only durably
 * committed releases — rejections and failures surface as their own warning
 * lines so a partial release is never overstated. Returns best-effort result
 * lines; never throws.
 */
async function releaseKnowledgeGateObligations(
	directory: string,
	sessionID: string,
): Promise<string[]> {
	const results: string[] = [];
	let live: Awaited<ReturnType<typeof queryLiveMemberships>>;
	try {
		live = await _internals.queryLiveMemberships(directory, {
			session_id: sessionID,
			include_terminal: true,
		});
	} catch (err) {
		return [
			`⚠️ Knowledge gate state not cleared: receipt authority unavailable (${errorMessage(err)})`,
		];
	}
	if (!live.ok) {
		return [
			`⚠️ Knowledge gate state not cleared: receipt authority unavailable (${live.code})`,
		];
	}
	// Deliberately broader than the gate's own predicate (which releases only
	// critical memberships in the current phase/task scope): the reset is the
	// operator's full architect-directive obligation wipe for this session,
	// so non-critical and out-of-scope pending memberships are released too.
	const pending = live.memberships.filter(
		(membership) =>
			membership.exposure_kind === 'architect_directive' &&
			!membership.application_marker &&
			membership.gate_release?.membership_event_id !==
				membership.membership_event_id,
	);
	if (pending.length === 0) {
		return ['⏭️ No pending knowledge gate obligations for this session'];
	}
	const byTrace = new Map<string, typeof pending>();
	for (const membership of pending) {
		const group = byTrace.get(membership.trace_id) ?? [];
		group.push(membership);
		byTrace.set(membership.trace_id, group);
	}
	// Only durably committed releases count toward the summary and the audit
	// event — idempotent re-releases and rejected items must not inflate the
	// operator-facing evidence (PR review PRR-002 on #2398).
	let committedCount = 0;
	const releasedPairs: string[] = [];
	for (const [traceId, group] of byTrace) {
		const committed = await _internals.commitGateReleaseBatch(directory, {
			trace_id: traceId,
			session_id: sessionID,
			items: group.map((membership) => ({
				entry_id: membership.entry_id,
				source: 'application_gate_session_reset_release',
				reason: '/swarm reset-session operator escape (#2398)',
			})),
		});
		if (!committed.ok) {
			results.push(
				`⚠️ Failed to release knowledge gate obligations on trace ${sanitizeDiagnosticText(traceId, 64)}: ${committed.code}`,
			);
			continue;
		}
		committedCount += committed.committed.length;
		for (const item of committed.committed) {
			releasedPairs.push(`${traceId}/${item.entry_id}`);
		}
		if (committed.rejected.length > 0) {
			results.push(
				`⚠️ Partially released trace ${sanitizeDiagnosticText(traceId, 64)}: ${committed.rejected
					.map((item) => item.reason)
					.join('; ')}`,
			);
		}
	}
	if (committedCount === 0) {
		return results;
	}
	if (committedCount < pending.length) {
		results.push(
			`⚠️ Released ${committedCount} of ${pending.length} pending knowledge gate obligation(s) — ${pending.length - committedCount} not released; see warnings above`,
		);
	} else {
		results.push(
			`✅ Released ${committedCount} pending knowledge gate obligation(s) for this session`,
		);
	}
	try {
		appendCoreEventSync(directory, {
			timestamp: new Date().toISOString(),
			event: 'knowledge_application_gate_session_reset_clear',
			sessionID,
			released_pairs: releasedPairs,
		});
	} catch {
		/* best-effort audit — the durable ledger release above is the authority */
	}
	return results;
}

/**
 * Handles the /swarm reset-session command.
 * Deletes only the session state file (.swarm/session/state.json)
 * and clears in-memory agent sessions. Preserves plan, evidence,
 * and knowledge for continuity across sessions — but DOES release this
 * session's pending knowledge-application gate obligations (issue #2398) so
 * the reset is a real escape from an enforce-mode lockout.
 */
export async function handleResetSessionCommand(
	directory: string,
	_args: string[],
	sessionID?: string,
): Promise<string> {
	const results: string[] = [];

	// Keep a closing guard through snapshot/projection deletion. A plain close
	// would delete its entry before the rows are cleared, letting a concurrent
	// request start a fresh initializer against pre-reset data (#2481).
	let snapshotResetGuard: SnapshotCoordinationResetGuard | undefined;
	try {
		snapshotResetGuard =
			await _internals.beginSnapshotCoordinationReset(directory);
		if (snapshotResetGuard.closeError) throw snapshotResetGuard.closeError;
	} catch (err) {
		results.push(
			`⚠️ Snapshot coordination close failed (continuing with reset): ${errorMessage(err)}`,
		);
	}

	// Auto-backup the session state we are about to delete BEFORE deletion, so it
	// can be recovered by copying files back. Fail-open. #1692
	try {
		const backup = _internals.backupSwarmStateBeforeReset(
			directory,
			'reset-session',
			['session'],
		);
		if (backup.backupDir && backup.copied.length > 0) {
			const rel = path.relative(directory, backup.backupDir);
			results.push(
				`📦 Backed up session state to ${rel}/ (restore by copying files back into .swarm/session/)`,
			);
		}
		for (const w of backup.warnings) {
			results.push(`⚠️ Backup warning: ${w}`);
		}
	} catch (err) {
		results.push(
			`⚠️ Auto-backup failed (continuing with reset): ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	// Delete the SQLite authority before removing its backed-up compatibility
	// projection. This is a single FULL transaction and remains a no-op for
	// projects that have not opened swarm.db yet.
	try {
		const removed = clearSnapshotRows(directory);
		results.push(
			removed > 0
				? `✅ Deleted ${removed} authoritative session snapshot row(s)`
				: '⏭️ SQLite session snapshot already clean',
		);
	} catch (err) {
		results.push(
			`❌ Failed to clear SQLite session snapshot: ${errorMessage(err)}`,
		);
	}

	// Resolve the state.json path once and reuse it below. Previously this
	// path was validated a second time (unguarded) to derive sessionDir,
	// which meant a validateSwarmPath failure (e.g. .swarm resolving via a
	// symlink, or a permission/EACCES error while resolving the real path)
	// was reported gracefully here but then thrown again uncaught below,
	// crashing the whole best-effort cleanup. Reusing statePath keeps the
	// "report and continue" contract consistent for both steps.
	let statePath: string | undefined;
	try {
		statePath = validateSwarmPath(directory, 'session/state.json');
		if (fs.existsSync(statePath)) {
			fs.unlinkSync(statePath);
			results.push('✅ Deleted .swarm/session/state.json');
		} else {
			results.push('⏭️ state.json not found (already clean)');
		}
	} catch {
		// Justification: best-effort session cleanup — state.json may be
		// locked by an active session, path validation may fail, or the
		// file may be concurrently removed. The report records the
		// failure; reset-session continues to clean remaining files when
		// a safe sessionDir could still be resolved above.
		results.push('❌ Failed to delete state.json');
	}

	// Clean all files in .swarm/session/ except state.json.
	// Only proceed if statePath was resolved successfully above — if
	// validateSwarmPath threw, there is no validated sessionDir to clean,
	// so skip this step instead of re-validating (and re-throwing).
	const sessionDir = statePath ? path.dirname(statePath) : undefined;
	let sessionFiles: string[] = [];
	if (sessionDir && fs.existsSync(sessionDir)) {
		try {
			sessionFiles = fs.readdirSync(sessionDir);
		} catch (err) {
			results.push(`❌ Failed to read session directory: ${errorMessage(err)}`);
		}
	}
	// If sessionDir doesn't exist, sessionFiles stays [] — nothing to clean, no error

	for (const file of sessionFiles) {
		if (file === 'state.json') continue; // handled separately
		const filePath = path.join(sessionDir as string, file);
		try {
			if (!fs.existsSync(filePath)) continue;
			if (!fs.lstatSync(filePath).isFile()) continue;
			fs.unlinkSync(filePath);
			results.push(`✓ Deleted ${file}`);
		} catch (err) {
			results.push(`❌ Failed to delete ${file}: ${errorMessage(err)}`);
		}
	}

	// Clear in-memory agent sessions
	const sessionCount = swarmState.agentSessions.size;
	for (const [sessionId, session] of swarmState.agentSessions) {
		resetPrmSessionState(session, sessionId);
		clearTrajectoryStep(sessionId);
	}
	swarmState.agentSessions.clear();
	clearSnapshotSessionOwnerships();
	results.push(`✅ Cleared ${sessionCount} in-memory agent session(s)`);

	// Clear delegation chains to prevent stale coder_delegated detection
	const chainCount = swarmState.delegationChains.size;
	swarmState.delegationChains.clear();
	results.push(`✅ Cleared ${chainCount} delegation chain(s)`);

	// Clear activeAgent alongside the sessions it is keyed by. With
	// agentSessions cleared above, any surviving entry is an orphan no sweep
	// can ever reclaim, and the snapshot writer would persist it forever.
	const activeAgentCount = swarmState.activeAgent.size;
	swarmState.activeAgent.clear();
	results.push(`✅ Cleared ${activeAgentCount} active-agent mapping(s)`);
	// All paths that can rehydrate or republish the old snapshot are now past
	// their destructive inputs. Let future requests initialize normally.
	snapshotResetGuard?.release();

	// Issue #2398: reset-session is the operator's documented escape from the
	// knowledge-application enforcement gate. Durably release THIS session's
	// pending architect-directive obligations and clear the gate's in-memory
	// denial/shown state (process-wide, like the clears above). Other
	// sessions' obligations and the knowledge store itself are preserved.
	if (sessionID) {
		try {
			results.push(
				...(await _internals.releaseKnowledgeGateObligations(
					directory,
					sessionID,
				)),
			);
		} catch (err) {
			results.push(`⚠️ Knowledge gate state not cleared: ${errorMessage(err)}`);
		}
	} else {
		results.push(
			'⚠️ Knowledge gate obligations not released: no session context on this invocation',
		);
	}
	swarmState.gateDenialCounts.clear();
	swarmState.currentCriticalShownIds.clear();
	results.push('✅ Cleared in-memory knowledge gate denial state');

	// Issue #2268: recover stale coder settlements. reset-session already
	// clears every session's in-process state process-wide, so it is the
	// operator's quiescence assertion: a DISPATCHED settlement WAL whose
	// completion never arrived (host killed mid-dispatch, cancelled Task,
	// gate denial on the reporter's pre-#2214 build) is settled here instead
	// of wedging every future dispatch with CODER_DISPATCH_IN_PROGRESS.
	// Runs BEFORE the .swarm-worktrees removal below so worktree-carrying
	// settlements can still reconcile their merges. Fail-open per task.
	let preserveWorktrees = false;
	try {
		const { results: settlementResults, truncated } =
			await _internals.recoverStaleCoderSettlements(directory, {
				force: true,
			});
		if (settlementResults.length === 0) {
			results.push('⏭️ No coder settlements to recover');
		}
		for (const outcome of settlementResults) {
			switch (outcome.outcome) {
				case 'recovered':
					results.push(
						`✅ Recovered coder settlement ${outcome.taskId} (${
							outcome.accepted
								? 'changes attributed'
								: 'no workspace change to attribute'
						})`,
					);
					break;
				case 'already_terminal':
					results.push(
						`⏭️ Coder settlement ${outcome.taskId} already ${outcome.state}`,
					);
					break;
				case 'owned_in_process':
					results.push(
						`ℹ️ Coder settlement ${outcome.taskId} still registered in flight (${sanitizeDiagnosticText(
							outcome.transitionId,
						)}) — its dispatch may be genuinely running; not force-recovered`,
					);
					break;
				case 'owned_by_live_foreign_pid':
					results.push(
						`ℹ️ Coder settlement ${outcome.taskId} owned by live process pid ${outcome.processId} (another OpenCode instance) — not touched; run /swarm recover there after closing it`,
					);
					break;
				case 'unreadable_wal':
					results.push(
						`⚠️ Coder settlement WAL ${outcome.taskId} is unreadable — inspect .swarm/coder-settlements/${outcome.taskId}.json`,
					);
					break;
				case 'error':
					results.push(
						`⚠️ Coder settlement ${outcome.taskId} recovery failed: ${sanitizeDiagnosticText(
							outcome.message,
							512,
						)}`,
					);
					break;
				default:
					results.push(
						`⚠️ Coder settlement ${(outcome as { taskId: string }).taskId}: unknown outcome`,
					);
					break;
			}
		}
		if (truncated) {
			results.push(
				'⚠️ More settlement WALs exist than the recovery scan cap (200) — older settlements were NOT recovered. Re-run /swarm reset-session after the tasks above are settled.',
			);
		}
		// reset-session always recovers with force, so mirror /swarm recover
		// --force's heads-up when any in-process ownership key had to be
		// released: a genuinely still-running dispatch's late completion will
		// fail settlement with CODER_SETTLEMENT_IDEMPOTENCY_CONFLICT.
		const forcedRecovered = settlementResults.filter(
			(outcome) => outcome.outcome === 'recovered' && outcome.forced,
		).length;
		if (forcedRecovered > 0) {
			results.push(
				`⚠️ Released in-process ownership for ${forcedRecovered} dispatch(es) before recovery — if any was genuinely still running, its completion will report CODER_SETTLEMENT_IDEMPOTENCY_CONFLICT (safe to ignore; the settlement is already recovered).`,
			);
		}
		// PR review PRR-012: a worktree-carrying settlement whose recovery
		// errored still references its worktree — deleting .swarm-worktrees/
		// now would strand the WAL (scopedObservedFiles would read null from
		// the deleted worktree and every later recovery throws
		// CODER_SETTLEMENT_RECOVERY_UNCERTAIN). 'unreadable_wal' also
		// triggers preservation: an unparseable WAL may reference a worktree,
		// which cannot be known without parsing it. Preserve the worktrees
		// and tell the operator; branch cleanup below still runs.
		preserveWorktrees = settlementResults.some(
			(outcome) =>
				outcome.outcome === 'error' || outcome.outcome === 'unreadable_wal',
		);
		if (preserveWorktrees) {
			results.push(
				'⚠️ Preserved .swarm-worktrees/ because at least one settlement recovery failed — a worktree referenced by an unsettled WAL would become unrecoverable if deleted. Resolve the failures above (re-run /swarm reset-session or /swarm recover) before clearing worktrees.',
			);
		}
	} catch (err) {
		// Reviewer round: the whole recovery call throwing leaves the
		// settlement state unknown — same stranding risk as a per-task error,
		// so preserve the worktrees here too.
		preserveWorktrees = true;
		results.push(
			`⚠️ Coder settlement recovery failed (continuing with reset): ${errorMessage(err)}`,
		);
	}

	// Best-effort: clean stale worktree directories and orphan branches
	const worktreesDir = path.resolve(
		path.dirname(directory),
		SWARM_WORKTREE_DIR_NAME,
	);
	try {
		if (fs.existsSync(worktreesDir)) {
			if (preserveWorktrees) {
				results.push('⏭️ Skipped .swarm-worktrees/ removal (see above)');
			} else {
				fs.rmSync(worktreesDir, { recursive: true, force: true });
				results.push('✅ Removed .swarm-worktrees/ directory');
			}
		}
	} catch (err) {
		results.push(`⚠️ Failed to remove .swarm-worktrees/: ${errorMessage(err)}`);
	}

	try {
		const branchResult = await _internals.cleanupOrphanedBranches(
			directory,
			[],
		);
		if (branchResult.removed.length > 0) {
			results.push(
				`✅ Removed ${branchResult.removed.length} orphan swarm-lane branch(es)`,
			);
		}
		if (branchResult.errors.length > 0) {
			results.push(
				`⚠️ Failed to remove ${branchResult.errors.length} branch(es): ${branchResult.errors.map((e) => e.error).join('; ')}`,
			);
		}
		// #1657: surface preserved recovery branches + fail-safe state so the
		// user running /swarm reset-session knows why some branches were skipped.
		if (
			branchResult.skippedRecoveryBranches &&
			branchResult.skippedRecoveryBranches.length > 0
		) {
			results.push(
				`ℹ️ Preserved ${branchResult.skippedRecoveryBranches.length} branch(es) with unresolved merge-back recovery records (run /swarm status to inspect)`,
			);
		}
		if (branchResult.recoveryReadError) {
			results.push(
				`⚠️ Skipped all lane-branch deletions: .swarm/recovery/ was unreadable (fail-safe). Resolve or clear corrupt recovery records and re-run.`,
			);
		}
	} catch (err) {
		results.push(`⚠️ Failed to cleanup orphan branches: ${errorMessage(err)}`);
	}

	return [
		'## Session State Reset',
		'',
		...results,
		'',
		'Session state cleared. Plan, evidence, and knowledge preserved.',
		'',
		'**All circuit breakers and revision limits have been cleared.** You can continue in this session — fresh state will be initialized automatically on the next tool call.',
	].join('\n');
}
