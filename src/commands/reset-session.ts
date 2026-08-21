import * as fs from 'node:fs';
import * as path from 'node:path';
import { SWARM_WORKTREE_DIR_NAME } from '../config/constants';
import { clearTrajectoryStep } from '../hooks/trajectory-logger';
import { validateSwarmPath } from '../hooks/utils';
import { resetPrmSessionState } from '../prm';
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
} = {
	cleanupOrphanedBranches,
	backupSwarmStateBeforeReset,
};

function errorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}

/**
 * Handles the /swarm reset-session command.
 * Deletes only the session state file (.swarm/session/state.json)
 * and clears in-memory agent sessions. Preserves plan, evidence,
 * and knowledge for continuity across sessions.
 */
export async function handleResetSessionCommand(
	directory: string,
	_args: string[],
): Promise<string> {
	const results: string[] = [];

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

	// Issue #2268: recover stale coder settlements. reset-session already
	// clears every session's in-process state process-wide, so it is the
	// operator's quiescence assertion: a DISPATCHED settlement WAL whose
	// completion never arrived (host killed mid-dispatch, cancelled Task,
	// gate denial on the reporter's pre-#2214 build) is settled here instead
	// of wedging every future dispatch with CODER_DISPATCH_IN_PROGRESS.
	// Runs BEFORE the .swarm-worktrees removal below so worktree-carrying
	// settlements can still reconcile their merges. Fail-open per task.
	try {
		const settlementResults = await recoverStaleCoderSettlements(directory, {
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
						`ℹ️ Coder settlement ${outcome.taskId} still registered in flight (${outcome.transitionId}) — its dispatch may be genuinely running; not force-recovered`,
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
						`⚠️ Coder settlement ${outcome.taskId} recovery failed: ${outcome.message}`,
					);
					break;
				default:
					results.push(
						`⚠️ Coder settlement ${(outcome as { taskId: string }).taskId}: unknown outcome`,
					);
					break;
			}
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
	} catch (err) {
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
			fs.rmSync(worktreesDir, { recursive: true, force: true });
			results.push('✅ Removed .swarm-worktrees/ directory');
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
