import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveWorktreeRepoOwnership } from '../config/lane-context';
import { appendCoreEventSync } from '../events/core-events';
import { clearSessionActionCircuits } from '../failures/action-circuit.js';
import { resolveWorktreeEnumerationBases } from '../hooks/init-orphan-recovery';
import {
	commitGateReleaseBatch,
	queryLiveMemberships,
} from '../hooks/knowledge-receipt-ledger';
import { clearTrajectoryStep } from '../hooks/trajectory-logger';
import { validateSwarmPath } from '../hooks/utils';
import { listLiveLaneOwners } from '../parallel/lane-owners';
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
import { SNAPSHOT_PROJECTION_FILE } from '../session/snapshot-writer.js';
import { swarmState } from '../state';
import { recoverStaleCoderSettlements } from '../workflow/coder-settlement.js';
import { isPathUnderSwarmWorktreeBase } from '../worktree/core';
import {
	cleanupOrphanedBranches,
	type OrphanCleanupResult,
} from '../worktree/merge';
import { probeGitMarker, removeOwnedWorktreeDir } from '../worktree/ownership';
import {
	executeDestructivePurge,
	issueConfirmToken,
	type PurgeCandidate,
	previewDestructivePurge,
} from './destructive-purge';
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
	removeOwnedWorktreeDir: typeof removeOwnedWorktreeDir;
	listLiveLaneOwners: typeof listLiveLaneOwners;
	backupSwarmStateBeforeReset: (
		directory: string,
		kind: 'reset' | 'reset-session',
		relEntries: string[],
	) => ResetBackupResult;
	recoverStaleCoderSettlements: typeof recoverStaleCoderSettlements;
	queryLiveMemberships: typeof queryLiveMemberships;
	commitGateReleaseBatch: typeof commitGateReleaseBatch;
	beginSnapshotCoordinationReset: typeof beginSnapshotCoordinationReset;
	clearSnapshotRows: typeof clearSnapshotRows;
	releaseKnowledgeGateObligations: (
		directory: string,
		sessionID: string,
	) => Promise<string[]>;
} = {
	cleanupOrphanedBranches,
	removeOwnedWorktreeDir,
	listLiveLaneOwners,
	backupSwarmStateBeforeReset,
	recoverStaleCoderSettlements,
	queryLiveMemberships,
	commitGateReleaseBatch,
	beginSnapshotCoordinationReset,
	clearSnapshotRows,
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
	args: string[],
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
		if (snapshotResetGuard.closeError) {
			if (snapshotResetGuard.priorUnsettled) {
				results.push(
					`❌ Snapshot coordination close timed out; reset aborted to avoid racing an in-flight initializer: ${errorMessage(snapshotResetGuard.closeError)}`,
				);
				snapshotResetGuard.release();
				return results.join('\n');
			}
			throw snapshotResetGuard.closeError;
		}
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
	let snapshotAuthorityCleared = false;
	try {
		const removed = _internals.clearSnapshotRows(directory);
		snapshotAuthorityCleared = true;
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

	// The projection is a compatibility input for a future initializer, so it
	// must be removed explicitly and independently of the generic session-file
	// cleanup below. Keep the reset guard closed if this deletion fails.
	let snapshotProjectionCleared = true;
	try {
		const projectionPath = validateSwarmPath(
			directory,
			SNAPSHOT_PROJECTION_FILE,
		);
		if (fs.existsSync(projectionPath)) {
			fs.unlinkSync(projectionPath);
			results.push(`✅ Deleted .swarm/${SNAPSHOT_PROJECTION_FILE}`);
		}
	} catch (err) {
		snapshotProjectionCleared = false;
		results.push(
			`❌ Failed to delete ${SNAPSHOT_PROJECTION_FILE}: ${errorMessage(err)}`,
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
	let legacySnapshotCleared = true;
	try {
		statePath = validateSwarmPath(directory, 'session/state.json');
		if (fs.existsSync(statePath)) {
			fs.unlinkSync(statePath);
			results.push('✅ Deleted .swarm/session/state.json');
		} else {
			results.push('⏭️ state.json not found (already clean)');
		}
	} catch {
		legacySnapshotCleared = false;
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
		if (
			file === 'state.json' ||
			file === path.basename(SNAPSHOT_PROJECTION_FILE)
		)
			continue; // handled separately
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

	// #2471 (absorbing #1896 row 4): release THIS session's guardrail action
	// circuits with the state they key. The lifecycle handler clears these on
	// session.deleted events this command never emits, so without this a
	// "reset" session's blocking circuits linger until their 30-minute TTL.
	// Scoped to the invoking session only — other sessions' circuits are not
	// ours to clear (AGENTS invariant 8). The clear is audited internally as
	// reason 'session'.
	if (sessionID) {
		clearSessionActionCircuits(sessionID);
		results.push(
			'✅ Released this session\u2019s guardrail circuit(s) (audited; re-delegate to re-arm)',
		);
	}

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
	// Keep the closing guard installed when the authoritative delete failed. A
	// later initializer must not re-import stale rows while the operator retries
	// reset-session. Successful SQLite + projection cleanup is the only point at
	// which it is safe to admit new coordination work.
	if (
		snapshotResetGuard &&
		snapshotAuthorityCleared &&
		snapshotProjectionCleared &&
		legacySnapshotCleared
	) {
		snapshotResetGuard.release();
	}

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

	// Issue #2527: the pre-fix code rmSync'd the ENTIRE parent-level shared
	// base — destroying sibling projects' lanes and uncommitted work with a
	// success line. Now: enumerate THIS project's own base, never delete a
	// lane owned by a different repository, and require the shared two-step
	// confirm token (issue #2508 primitive) for anything that would destroy
	// uncommitted or live-owned work. Clean own lanes still go without
	// confirmation (today's UX for the common case).
	try {
		if (preserveWorktrees) {
			results.push('⏭️ Skipped worktree reclamation (see above)');
		} else {
			const confirmArg = args.find((a) => a.startsWith('--confirm='));
			const confirmToken = confirmArg
				? confirmArg.slice('--confirm='.length)
				: undefined;
			// Same enumeration scope as init orphan recovery (default project
			// base + every configured worktree_dir override) so the two
			// destructive entry points cannot disagree about what is in scope.
			const candidates: string[] = [];
			for (const base of resolveWorktreeEnumerationBases(directory)) {
				if (!fs.existsSync(base)) continue;
				for (const sessionEntry of fs.readdirSync(base, {
					withFileTypes: true,
				})) {
					if (!sessionEntry.isDirectory()) continue;
					const sessionDir = path.join(base, sessionEntry.name);
					for (const laneEntry of fs.readdirSync(sessionDir, {
						withFileTypes: true,
					})) {
						if (laneEntry.isDirectory()) {
							candidates.push(path.join(sessionDir, laneEntry.name));
						}
					}
				}
			}
			if (candidates.length === 0) {
				results.push('⏭️ No worktree lanes to reclaim');
			} else {
				const livePaths = new Set(
					_internals
						.listLiveLaneOwners(directory)
						.live.map((owner) => owner.lanePath),
				);
				// Foreign and ownership-unprovable lanes are NEVER deletable —
				// with or without a token. A `.git`-less remnant is ours only
				// INSIDE the default project worktree base (ours by
				// construction); under a configured `worktree_dir` override —
				// which may point anywhere — ownership of a bare directory
				// cannot be proven, so it is preserved and reported.
				const own: string[] = [];
				const foreign: string[] = [];
				const unprovable: string[] = [];
				for (const candidate of candidates) {
					const marker = probeGitMarker(path.join(candidate, '.git'));
					if (marker === 'uncertain') {
						unprovable.push(candidate);
						continue;
					}
					if (marker === 'gitless') {
						if (isPathUnderSwarmWorktreeBase(candidate, directory)) {
							own.push(candidate);
						} else {
							unprovable.push(candidate);
						}
						continue;
					}
					const ownership = resolveWorktreeRepoOwnership(candidate, directory);
					if (ownership.owned) {
						own.push(candidate);
					} else {
						foreign.push(candidate);
					}
				}
				for (const lane of foreign) {
					results.push(
						`ℹ️ Preserved "${lane}" — owned by a different repository; never deleted by this project.`,
					);
				}
				for (const lane of unprovable) {
					results.push(
						`ℹ️ Preserved "${lane}" — ownership unprovable (git-less outside the project worktree base, or unreadable metadata); never deleted by this project.`,
					);
				}

				if (confirmToken) {
					// Operator echoed the exact confirmation: purge the full
					// own scope through the shared primitive (single-use token,
					// set-digest bound). Belt-and-suspenders: every scope
					// member must be a proven-owned `.git`-bearing lane or a
					// git-less remnant inside the project base — the classifier
					// above already guarantees this, so a violation is a bug
					// and the candidate is dropped rather than purged.
					const purgeScope = own.filter(
						(lane) =>
							probeGitMarker(path.join(lane, '.git')) === 'present' ||
							isPathUnderSwarmWorktreeBase(lane, directory),
					);
					const scope: PurgeCandidate[] = purgeScope.map((lane) => ({
						path: lane,
						reason: 'confirmed reset-session purge',
					}));
					const execution = executeDestructivePurge(
						own[0] ?? '',
						directory,
						confirmToken,
						{ candidates: scope },
					);
					if (execution.ok) {
						results.push(
							`✅ Removed ${execution.purged?.length ?? 0} confirmed worktree lane(s)`,
						);
					} else {
						results.push(`⚠️ Confirmed purge rejected: ${execution.reason}`);
					}
				} else {
					// No token: delete clean own lanes only (git itself refuses
					// dirty worktrees — that refusal is a stop, never an
					// escalation); live-owned and dirty-refused lanes are
					// preserved and surfaced with the confirm token.
					let removedCount = 0;
					const preservedOwn: string[] = [];
					for (const lane of own) {
						if (livePaths.has(lane)) {
							preservedOwn.push(lane);
							continue;
						}
						const outcome = await _internals.removeOwnedWorktreeDir(
							lane,
							directory,
						);
						if (outcome.status === 'removed') {
							removedCount++;
						} else {
							preservedOwn.push(lane);
						}
					}
					if (removedCount > 0) {
						results.push(`✅ Removed ${removedCount} clean worktree lane(s)`);
					}
					if (preservedOwn.length > 0) {
						const scope: PurgeCandidate[] = preservedOwn.map((lane) => ({
							path: lane,
							reason: 'uncommitted or live-owned work',
						}));
						// Disclosure: show the operator exactly what a confirmed
						// purge would destroy (dirty vs live is indistinguishable
						// from a bare count) before arming the token.
						const preview = previewDestructivePurge(
							preservedOwn[0],
							directory,
							{ candidates: scope },
						);
						for (const line of preview.previewLines) {
							results.push(`   ${line}`);
						}
						const token = issueConfirmToken(preservedOwn[0], directory, {
							candidates: scope,
						});
						results.push(
							`🔐 Preserved ${preservedOwn.length} lane(s) containing uncommitted or live work. ` +
								'Destroying them requires confirmation: re-run /swarm reset-session with ' +
								`--confirm=${token} (valid 15 minutes).`,
						);
					}
				}
			}
		}
	} catch (err) {
		results.push(`⚠️ Failed to reclaim worktree lanes: ${errorMessage(err)}`);
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
