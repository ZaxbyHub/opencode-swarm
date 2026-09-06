import { promises as fs } from 'node:fs';
import path from 'node:path';
import { closeGroupCommitWriter } from '../../db/group-commit-writer';
import { closeProjectDb } from '../../db/project-db';
import { isLinked } from '../../hooks/knowledge-link';
import { clearAllScopes } from '../../scope/scope-persistence';
import { quarantineSwarmResidue } from '../../services/swarm-residue';
import { REPO_MEMORY_FILENAME } from '../../tools/repo-graph/indexed-storage';
import { atomicWriteSwarmFile } from '../../utils/atomic-write';
import { log } from '../../utils/logger';
import {
	ACTIVE_STATE_DIRS_TO_CLEAN,
	ACTIVE_STATE_TO_CLEAN,
	KNOWLEDGE_FAMILY_ARTIFACTS,
	TERMINAL_STATE_FILES,
} from './constants.js';
import type { CleanStageResult, CloseStageContext } from './context.js';
import { removeSqliteSidecarsAfterClose } from './db-helpers.js';
import { _internals } from './internals.js';

export async function runCleanStage(
	ctx: CloseStageContext,
): Promise<CleanStageResult> {
	let configBackupsRemoved = 0;
	const cleanedFiles: string[] = [];

	// Only delete active-state files that were successfully copied to the archive.
	// This prevents data loss when a partial archive succeeds for some files but
	// fails for others — only the backed-up files are safe to remove.
	const linkedKnowledgeShared = isLinked(ctx.directory);
	if (linkedKnowledgeShared) {
		// Defensive check: if the archive stage unexpectedly backed up a shared
		// knowledge-family artifact (indicates a bug in runArchiveStage), warn so
		// operators can diagnose. The artifact is still NOT deleted (guard below).
		for (const artifact of KNOWLEDGE_FAMILY_ARTIFACTS) {
			if (ctx.archivedActiveStateFiles.has(artifact)) {
				ctx.warnings.push(
					`[link-guard] Shared knowledge artifact "${artifact}" appears in ` +
						'the archive set while this worktree is linked — archive stage ' +
						'should have skipped it. Artifact will NOT be deleted.',
				);
			}
		}
	}
	if (ctx.archivedActiveStateFiles.size > 0) {
		for (const artifact of ACTIVE_STATE_TO_CLEAN) {
			// Never delete cohort-shared knowledge state from a single worktree's
			// close (it was deliberately not archived above; peers may be active).
			if (linkedKnowledgeShared && KNOWLEDGE_FAMILY_ARTIFACTS.has(artifact)) {
				continue;
			}
			if (!ctx.archivedActiveStateFiles.has(artifact)) {
				const reason = ctx.archiveFailureReasons?.get(artifact);
				if ((TERMINAL_STATE_FILES as readonly string[]).includes(artifact)) {
					// Terminal plan-state is removed unconditionally below (resurrection
					// prevention), so it is NOT preserved here even though archiving failed.
					// Warn accurately that the forensic copy is missing but the file is still
					// removed — do not claim it was "preserved" (the removal contradicts that).
					ctx.warnings.push(
						reason
							? `${artifact} was not archived (${reason}); removing it anyway to prevent CLOSED-plan resurrection next session — no archive copy retained.`
							: `${artifact} was not archived; removing it anyway to prevent CLOSED-plan resurrection next session — no archive copy retained.`,
					);
					continue;
				}
				// This file was NOT successfully archived — do not delete it.
				// Only warn when a genuine archive failure was recorded (e.g. EBUSY,
				// EPERM, ENOSPC) so operators can diagnose without digging into logs.
				// Absent optional files (ENOENT during the archive stage) have no
				// recorded reason — they were simply never present, so we skip
				// silently rather than spuriously warning about a "preserved" file
				// that never existed.
				if (reason) {
					ctx.warnings.push(
						`Preserved ${artifact} because it was not successfully archived: ${reason}.`,
					);
				}
				continue;
			}
			const filePath = path.join(ctx.swarmDir, artifact);
			// For swarm.db, close the cached project-db connection for this
			// directory BEFORE unlinking. On Windows a long-lived WAL-mode
			// connection holds a file lock that makes fs.unlink fail with EBUSY
			// (swarm-pr-review F-005). closeProjectDb also checkpoints the
			// cached connection on close, but the archive stage already took a
			// transactionally consistent VACUUM INTO snapshot, so any checkpoint
			// here is redundant for the archive. The close is best-effort and
			// never throws into the clean stage.
			if (artifact === 'swarm.db') {
				try {
					await _internals.closeSnapshotCoordinationInitialization(
						ctx.directory,
					);
				} catch (error) {
					const reason = error instanceof Error ? error.message : String(error);
					ctx.warnings.push(
						`Preserved swarm.db because snapshot coordination did not settle: ${reason}.`,
					);
					// Never unlink a database while an initializer may still be using it.
					continue;
				}
				// #2480: flush+close the group-commit writer FIRST (mirrors the
				// dispose/exit paths), then the DB handle. Closing only the
				// handle would leave the cached writer bound to a dead handle —
				// every post-close insight/phase-report write in this process
				// would then fail (fail-open, i.e. silently lost learning).
				try {
					closeGroupCommitWriter(ctx.directory);
				} catch {
					// best-effort — the unlink below will surface any real failure
				}
				try {
					closeProjectDb(ctx.directory);
				} catch {
					// best-effort — the unlink below will surface any real failure
				}
			}
			// For repo-memory.sqlite (issue #1534), close the cached repo-memory
			// connection for this directory BEFORE unlinking, mirroring the
			// swarm.db Windows EBUSY guard above. Best-effort and never throws
			// into the clean stage.
			if (artifact === REPO_MEMORY_FILENAME) {
				try {
					_internals.closeRepoMemory(ctx.directory);
				} catch {
					// best-effort — the unlink below will surface any real failure
				}
			}
			try {
				await _internals.unlinkActiveStateFileWithRetry(filePath);
				cleanedFiles.push(artifact);
			} catch (err) {
				const errno = (err as NodeJS.ErrnoException)?.code;
				if (errno === 'ENOENT') {
					// File already absent — expected after archive-first cleanup; silent skip.
				} else {
					const reason = err instanceof Error ? err.message : String(err);
					ctx.warnings.push(
						`Failed to clean active-state file ${artifact} [${errno ?? 'unknown'}]: ${reason}`,
					);
				}
			}
			// #2483: immediately after the swarm.db unlink, drop its -wal/-shm
			// sidecar paths (reversing #1692 — see removeSqliteSidecarsAfterClose).
			if (artifact === 'swarm.db') {
				removeSqliteSidecarsAfterClose(ctx.swarmDir);
			}
		}
	} else {
		ctx.warnings.push(
			'Skipped active-state cleanup because no active-state files were archived. Files preserved to prevent data loss.',
		);
	}

	for (const artifact of ctx.archivedActiveStateFiles) {
		if (
			!/^post-mortem-[^/\\]+\.md$/.test(artifact) &&
			!/^drift-report-phase-\d+\.json$/.test(artifact)
		) {
			continue;
		}
		try {
			await fs.unlink(path.join(ctx.swarmDir, artifact));
			cleanedFiles.push(artifact);
		} catch (err) {
			const errno = (err as NodeJS.ErrnoException)?.code;
			if (errno !== 'ENOENT') {
				const reason = err instanceof Error ? err.message : String(err);
				ctx.warnings.push(
					`Failed to clean active-state file ${artifact} [${errno ?? 'unknown'}]: ${reason}`,
				);
			}
		}
	}

	// Delete directories that were successfully archived
	// Uses archive-first-guard: only delete directories we confirmed are in the archive
	for (const dirName of ACTIVE_STATE_DIRS_TO_CLEAN) {
		if (!ctx.archivedActiveStateDirs.has(dirName)) {
			// Directory was NOT archived — do not delete
			continue;
		}
		const dirPath = path.join(ctx.swarmDir, dirName);
		try {
			await fs.rm(dirPath, { recursive: true, force: true });
			cleanedFiles.push(`${dirName}/`);
		} catch {
			// Per-directory failure is non-blocking
		}
	}

	// Remove stale config-backup-*.json files AND ledger sibling files
	// (plan-ledger.archived-*.jsonl and plan-ledger.backup-*.jsonl) that
	// savePlan creates during identity-mismatch reinitialization. Without
	// this sweep, those siblings accumulate forever in .swarm/, undermining
	// the same "clean slate for next session" invariant that motivates the
	// plan-ledger.jsonl removal in ACTIVE_STATE_TO_CLEAN above. The primary
	// plan-ledger.jsonl is already archived into the bundle by stage 2, so
	// these stale siblings are pure noise and safe to delete here.
	try {
		const swarmFiles = await fs.readdir(ctx.swarmDir);
		const configBackups = swarmFiles.filter(
			(f) => f.startsWith('config-backup-') && f.endsWith('.json'),
		);
		for (const backup of configBackups) {
			try {
				await fs.unlink(path.join(ctx.swarmDir, backup));
				configBackupsRemoved++;
			} catch (err) {
				const errno = (err as NodeJS.ErrnoException)?.code;
				if (errno === 'ENOENT') {
					// Stale backup already absent — silent skip.
				} else {
					const reason = err instanceof Error ? err.message : String(err);
					ctx.warnings.push(
						`Failed to clean config-backup ${backup} [${errno ?? 'unknown'}]: ${reason}`,
					);
				}
			}
		}
		const ledgerSiblings = swarmFiles.filter(
			(f) =>
				(f.startsWith('plan-ledger.archived-') ||
					f.startsWith('plan-ledger.backup-')) &&
				f.endsWith('.jsonl'),
		);
		for (const sibling of ledgerSiblings) {
			try {
				await fs.unlink(path.join(ctx.swarmDir, sibling));
			} catch (err) {
				const errno = (err as NodeJS.ErrnoException)?.code;
				if (errno === 'ENOENT') {
					// Stale ledger sibling already absent — silent skip.
				} else {
					const reason = err instanceof Error ? err.message : String(err);
					ctx.warnings.push(
						`Failed to clean ledger sibling ${sibling} [${errno ?? 'unknown'}]: ${reason}`,
					);
				}
			}
		}
	} catch (err) {
		const errno = (err as NodeJS.ErrnoException)?.code;
		if (errno === 'ENOENT') {
			// swarmDir absent — nothing to clean; silent skip.
		} else {
			const reason = err instanceof Error ? err.message : String(err);
			ctx.warnings.push(
				`Failed to read ${ctx.swarmDir} for stale-file cleanup [${errno ?? 'unknown'}]: ${reason}`,
			);
		}
	}

	// Remove SWARM_PLAN checkpoint artifacts written by writeCheckpoint().
	// Cleans the new .swarm/plan-export/ location, the canonical .swarm/
	// location, and any legacy root-level artifacts from pre-7.0 sessions.
	// These are redundant copies of plan.json/plan.md (already archived)
	// and should not be left behind.
	let swarmPlanFilesRemoved = 0;
	const candidates = [
		path.join(ctx.directory, '.swarm', 'plan-export', 'SWARM_PLAN.json'),
		path.join(ctx.directory, '.swarm', 'plan-export', 'SWARM_PLAN.md'),
		path.join(ctx.directory, '.swarm', 'SWARM_PLAN.json'),
		path.join(ctx.directory, '.swarm', 'SWARM_PLAN.md'),
		path.join(ctx.directory, 'SWARM_PLAN.json'),
		path.join(ctx.directory, 'SWARM_PLAN.md'),
	];
	for (const candidate of candidates) {
		try {
			await fs.unlink(candidate);
			swarmPlanFilesRemoved++;
		} catch (err: unknown) {
			if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
				ctx.warnings.push(
					`Failed to remove ${candidate}: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}
	}

	// Atomic-write residue (issue #2035): discover candidates by REGISTERED
	// temp grammars (never substring heuristics), QUARANTINE verified stale
	// residue — a recoverable, manifest-backed move; automatic destructive
	// deletion is out of scope — and preserve + report everything else
	// (recent, active, tracked, symlink, constant-name, ambiguous). This
	// replaces the pre-#2035 blind `.tmp.`-prefix unlink sweep, which missed
	// every grammar current writers produce and removed files without gates.
	let residueQuarantined = 0;
	let residuePreserved = 0;
	try {
		const residue = await quarantineSwarmResidue(ctx.directory, {
			trigger: 'close',
		});
		residueQuarantined = residue.quarantined;
		residuePreserved = residue.preserved.length;
		if (residue.quarantined > 0 && residue.batchRelDir) {
			cleanedFiles.push(
				`${residue.quarantined} stale temp file(s) → ${residue.batchRelDir}/`,
			);
			ctx.warnings.push(
				`Quarantined ${residue.quarantined} stale atomic-write temp file(s) to .swarm/${residue.batchRelDir}/ (recoverable; rollback: /swarm config doctor --rollback-residue-quarantine).`,
			);
		}
		if (residue.preserved.length > 0) {
			const sample = residue.preserved
				.slice(0, 5)
				.map((p) => `\`${p.relPath}\``)
				.join(', ');
			ctx.warnings.push(
				`Preserved ${residue.preserved.length} residue candidate(s) in place (recent/active/tracked/ambiguous): ${sample}${residue.preserved.length > 5 ? ' …' : ''}.`,
			);
		}
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		// Honest about partial outcomes (PR review PRR-005): an abort here can
		// occur after some entries already moved, so do not claim all were
		// preserved. Quarantine itself now guards each entry's move, so this
		// path only triggers on inventory/telemetry-level failures.
		ctx.warnings.push(
			`Atomic-write residue quarantine failed (status of individual candidates unknown — inspect .swarm/quarantine/): ${reason}`,
		);
	}

	// Terminal-state removal (finalize knowledge-preservation fix): unconditionally
	// remove plan.json + plan-ledger.jsonl so the next session cannot resurrect the
	// CLOSED plan. loadPlan Step 1 and replayFromLedger have NO terminal-status filter
	// (see the CRITICAL note on ACTIVE_STATE_TO_CLEAN above), so a surviving terminal
	// plan.json OR ledger is materialized back into an active plan next session.
	//
	// Why here, unconditionally: the align stage's `git clean` previously deleted these
	// as a backstop even when the archive-first guard preserved them (archive failure).
	// Now that align only cleans an explicit build-artifact allowlist
	// (GITIGNORED_BUILD_ARTIFACTS) and no longer touches `.swarm/`, the clean stage must
	// own terminal-state removal itself. This is behavior-preserving for these two files
	// (the old blanket clean removed them regardless of archive success). They are copied
	// into the archive bundle first in stage 2 (ARCHIVE_ARTIFACTS), so the forensic trail
	// is retained whenever archiving succeeds; the ENOENT branch below covers the case
	// where the archive-gated cleanup already removed them.
	for (const terminalFile of TERMINAL_STATE_FILES) {
		try {
			await fs.unlink(path.join(ctx.swarmDir, terminalFile));
			if (!cleanedFiles.includes(terminalFile)) {
				cleanedFiles.push(terminalFile);
			}
		} catch (err) {
			const errno = (err as NodeJS.ErrnoException)?.code;
			if (errno === 'ENOENT') {
				// Already removed by the archive-gated cleanup above — expected; silent skip.
			} else {
				const reason = err instanceof Error ? err.message : String(err);
				ctx.warnings.push(
					`Failed to remove terminal-state file ${terminalFile} [${errno ?? 'unknown'}]: ${reason}`,
				);
			}
		}
	}

	// #519 (v6.71.1): clear persisted declare_scope files so the next session
	// starts without inherited scope. Scope files are ephemeral state; they are
	// not archived because they contain no forensic signal not already captured
	// by plan.json:files_touched.
	clearAllScopes(ctx.directory);

	// Reset context.md so new sessions start fresh
	const contextPath = path.join(ctx.swarmDir, 'context.md');
	const contextContent = [
		'# Context',
		'',
		'## Status',
		`Session closed after: ${ctx.projectName}`,
		`Closed: ${new Date().toISOString()}`,
		`Finalization: ${ctx.isForced ? 'forced' : ctx.planAlreadyDone ? 'plan-already-done' : 'normal'}`,
		'No active plan. Next session starts fresh.',
		'',
	].join('\n');
	// Reset context.md so new sessions start fresh. Written through the
	// canonical atomic helper (issue #2035): contained target, registered
	// temp grammar, exact own-temp cleanup, cache invalidation.
	try {
		await atomicWriteSwarmFile(contextPath, contextContent);
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		ctx.warnings.push(`Failed to reset context.md: ${msg}`);
		log('[close-command] Failed to write context.md:', error);
	}

	return {
		cleanedFiles,
		configBackupsRemoved,
		swarmPlanFilesRemoved,
		residueQuarantined,
		residuePreserved,
	};
}
