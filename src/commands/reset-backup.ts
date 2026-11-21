import * as fs from 'node:fs';
import * as path from 'node:path';
import { validateSwarmPath } from '../hooks/utils';

/**
 * Result of an auto-backup taken before a destructive /swarm reset or
 * /swarm reset-session. Fail-open by contract: any per-entry failure is
 * recorded as a warning and never thrown.
 */
export interface ResetBackupResult {
	/** Absolute path of the backup directory, or null if nothing was backed up. */
	backupDir: string | null;
	/** Relative names actually copied into the backup. */
	copied: string[];
	/** Non-fatal warnings (source unreadable, prune failure, etc.). */
	warnings: string[];
}

/** How many backup directories to retain under .swarm/reset-backups/. */
export const RESET_BACKUP_RETENTION = 5;

/** Which `.swarm/` subdirectory a backup family lands under (#2946). */
export type ResetBackupsRoot = 'reset-backups' | 'rollback-backups';

/**
 * Copy the swarm-state entries a reset is about to delete into a durable,
 * timestamped directory under `.swarm/reset-backups/` (or
 * `.swarm/rollback-backups/` for rollback restores, #2946) BEFORE deletion,
 * so the user can recover by copying the files back. The backup directory is
 * not part of any reset deletion set, so it survives the reset.
 *
 * This deliberately does NOT use the git checkpoint tool: that tool excludes
 * `.swarm/` (`git add ... :!.swarm/`) — i.e. it excludes exactly the state a
 * reset destroys — and would commit unrelated working-tree changes to the
 * user's branch. A direct file copy of the deleted state is the faithful,
 * non-surprising backup. (#1692)
 *
 * @param directory  project root (contains `.swarm/`)
 * @param kind       backup label prefix ('reset' | 'reset-session' | 'rollback')
 * @param relEntries entries relative to `.swarm/` to back up (files or dirs)
 * @param opts       backups root override (rollback restores use 'rollback-backups')
 */
export function backupSwarmStateBeforeReset(
	directory: string,
	kind: 'reset' | 'reset-session' | 'rollback',
	relEntries: string[],
	opts?: { backupsRoot?: ResetBackupsRoot },
): ResetBackupResult {
	const warnings: string[] = [];
	const copied: string[] = [];

	const swarmDir = path.join(directory, '.swarm');
	try {
		const stat = fs.lstatSync(swarmDir);
		// Refuse to operate on a redirected .swarm/ (symlink/junction), matching
		// the safety posture of handleCloseCommand.
		if (stat.isSymbolicLink() || !stat.isDirectory()) {
			warnings.push(
				'backup skipped: .swarm is a symlink or not a directory — nothing was backed up',
			);
			return { backupDir: null, copied, warnings };
		}
	} catch {
		// .swarm/ absent (ENOENT) or unstattable — nothing to back up, but the
		// caller must know the safety net is absent (#2976 review F-3).
		warnings.push(
			'backup skipped: .swarm directory is missing — nothing was backed up',
		);
		return { backupDir: null, copied, warnings };
	}

	// Deterministic, filesystem-safe timestamp; ISO strings sort chronologically.
	const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
	const backupsRoot = path.join(swarmDir, opts?.backupsRoot ?? 'reset-backups');
	const backupDir = path.join(backupsRoot, `${kind}-${timestamp}`);

	let backupDirCreated = false;
	const ensureBackupDir = (): void => {
		if (!backupDirCreated) {
			fs.mkdirSync(backupDir, { recursive: true });
			backupDirCreated = true;
		}
	};

	for (const rel of relEntries) {
		let src: string;
		try {
			src = validateSwarmPath(directory, rel);
		} catch {
			warnings.push(`skipped backup of ${rel} (path validation failed)`);
			continue;
		}
		if (!fs.existsSync(src)) continue;
		try {
			ensureBackupDir();
			const dest = path.join(backupDir, rel);
			fs.mkdirSync(path.dirname(dest), { recursive: true });
			// Recursive copy handles both files and directories (e.g. summaries/,
			// session/, plan-export/SWARM_PLAN.json).
			fs.cpSync(src, dest, { recursive: true });
			copied.push(rel);
		} catch (err) {
			warnings.push(
				`failed to back up ${rel}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	if (copied.length === 0) {
		// Nothing existed to back up — remove the empty dir if we created one.
		if (backupDirCreated) {
			try {
				fs.rmSync(backupDir, { recursive: true, force: true });
			} catch {
				// best-effort
			}
		}
		return { backupDir: null, copied, warnings };
	}

	pruneOldResetBackups(backupsRoot, warnings, path.basename(backupDir));
	return { backupDir, copied, warnings };
}

/**
 * Backup-directory names are `<kind>-<ISO>` where kind itself contains
 * dashes (`reset`, `reset-session`, `rollback`, `rollback-git`), so a raw
 * lexical sort compares the PREFIX before the timestamp and ranks
 * `rollback-git-*` ("g") above any digit-led older timestamp — a freshly
 * created `rollback-<ISO>` backup could be pruned in the same call that
 * made it (#2976 review F-4; the same shape pre-existed between
 * `reset-session-` and `reset-`). Sort on the TIMESTAMP suffix instead:
 * `toISOString().replace(/[:.]/g, '-')` always yields 17 digits, so the
 * digit-run compares correctly as a fixed-length string. The directory
 * created by the current call is never a prune candidate.
 */
const BACKUP_KIND_PREFIXES = [
	'reset-session-',
	'rollback-git-',
	'rollback-',
	'reset-',
] as const;

function backupTimestampSortKey(name: string): string {
	for (const prefix of BACKUP_KIND_PREFIXES) {
		if (name.startsWith(prefix)) {
			return name.slice(prefix.length).replace(/\D/g, '');
		}
	}
	return '';
}

function pruneOldResetBackups(
	backupsRoot: string,
	warnings: string[],
	keepDirName?: string,
): void {
	try {
		const entries = fs
			.readdirSync(backupsRoot, { withFileTypes: true })
			.filter((e) => e.isDirectory())
			.map((e) => ({ name: e.name, key: backupTimestampSortKey(e.name) }))
			.sort((a, b) =>
				a.key === b.key
					? b.name.localeCompare(a.name)
					: b.key.localeCompare(a.key),
			);
		for (const stale of entries.slice(RESET_BACKUP_RETENTION)) {
			// Belt and braces: the directory this call just created ranks
			// newest under the timestamp sort, so it is never in this tail —
			// but never delete it even if a future ranking change would.
			if (stale.name === keepDirName) continue;
			try {
				fs.rmSync(path.join(backupsRoot, stale.name), {
					recursive: true,
					force: true,
				});
			} catch (err) {
				warnings.push(
					`failed to prune old backup ${stale.name}: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}
	} catch (err) {
		warnings.push(
			`failed to prune old reset backups: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

/** One entry of the rollback backup's `recovery.json` manifest (#3763). */
export interface RecoveryManifestEntry {
	/** Staged (index) state captured before the destructive reset. */
	index?: { mode: string; bytes: string };
	/** Working-tree state captured (or recorded as deleted) before reset. */
	worktree: { kind: 'file'; bytes: string } | { kind: 'deleted' };
}

/** The `recovery.json` manifest written at the rollback-backup root. */
export interface RecoveryManifest {
	entries: Record<string, RecoveryManifestEntry>;
}

/**
 * Rollback-specific backup result (#3763 AC3/AC4): carries the exact set of
 * recorded deletions and an explicit recovery-completeness flag so the
 * restore gate can fail closed on ANY incompleteness (critic round 1
 * blocker 3) instead of inferring safety from aggregate counts.
 */
export interface TrackedBackupResult extends ResetBackupResult {
	/** Dirty paths recorded as deletions in recovery.json (exact set). */
	recordedDeletions: string[];
	/** True iff every capture step completed: copies, index capture, manifest. */
	recoveryComplete: boolean;
}

/**
 * Test seam (repo `_internals` convention): the manifest writer is injectable
 * so tests can deterministically fail the recovery manifest AFTER successful
 * file copies (#3763 — the fail-closed refusal must not depend on filesystem
 * permission races).
 */
export const _internals: {
	writeRecoveryManifest: typeof writeRecoveryManifest;
} = {
	writeRecoveryManifest,
};

function writeRecoveryManifest(
	backupDir: string,
	manifest: RecoveryManifest,
): void {
	fs.writeFileSync(
		path.join(backupDir, 'recovery.json'),
		JSON.stringify(manifest, null, 2),
		'utf8',
	);
}

/**
 * Back up the current bytes of each dirty tracked file a git-checkpoint
 * rollback is about to destroy via `git reset --hard` (#2946), plus the
 * staged (index) bytes and mode and deletion records (#3763 AC3/AC4).
 *
 * Layout: `.swarm/rollback-backups/rollback-git-<ISO>/` with
 * `tracked/<repo-rel-path>` (working bytes), `index/<repo-rel-path>` (staged
 * blob bytes), and `recovery.json` (the manifest mapping each dirty path to
 * what was captured). Deletion-only dirty paths are RECORDED in the manifest
 * (`worktree.kind === "deleted"`) so a restore can proceed honestly over
 * them instead of refusing with "nothing was backed up" (#3763 AC4).
 *
 * Per-entry failures are warnings AND flip `recoveryComplete` to false — the
 * caller's gate refuses the destructive reset (AC5 preserved: a writer
 * failure yields `backupDir: null` or an incomplete result, never a
 * half-covered destruction).
 */
export function backupTrackedChangesBeforeRollback(
	directory: string,
	repoRelPaths: string[],
	opts?: {
		captureIndexEntry?: (input: {
			backupDir: string;
			rel: string;
		}) => { mode: string } | null;
	},
): TrackedBackupResult {
	const warnings: string[] = [];
	const copied: string[] = [];
	const recordedDeletions: string[] = [];
	const entries: Record<string, RecoveryManifestEntry> = {};
	let incomplete = false;

	const swarmDir = path.join(directory, '.swarm');
	try {
		const stat = fs.lstatSync(swarmDir);
		if (stat.isSymbolicLink() || !stat.isDirectory()) {
			warnings.push(
				'backup skipped: .swarm is a symlink or not a directory — nothing was backed up',
			);
			return {
				backupDir: null,
				copied,
				warnings,
				recordedDeletions,
				recoveryComplete: false,
			};
		}
	} catch {
		warnings.push(
			'backup skipped: .swarm directory is missing — nothing was backed up',
		);
		return {
			backupDir: null,
			copied,
			warnings,
			recordedDeletions,
			recoveryComplete: false,
		};
	}

	const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
	const backupsRoot = path.join(swarmDir, 'rollback-backups');
	const backupDir = path.join(backupsRoot, `rollback-git-${timestamp}`);

	let backupDirCreated = false;
	const ensureBackupDir = (): void => {
		if (!backupDirCreated) {
			fs.mkdirSync(backupDir, { recursive: true });
			backupDirCreated = true;
		}
	};

	const dirty: string[] = repoRelPaths.filter((rel) => rel !== '');

	if (dirty.length > 0) {
		try {
			ensureBackupDir();
		} catch (err) {
			warnings.push(
				`failed to create rollback backup directory: ${err instanceof Error ? err.message : String(err)}`,
			);
			return {
				backupDir: null,
				copied,
				warnings,
				recordedDeletions,
				recoveryComplete: false,
			};
		}
	}

	for (const rel of dirty) {
		const src = path.join(directory, rel);
		const entry: RecoveryManifestEntry = {
			worktree: fs.existsSync(src)
				? { kind: 'file', bytes: `tracked/${rel}` }
				: { kind: 'deleted' },
		};
		if (!fs.existsSync(src)) {
			recordedDeletions.push(rel);
		} else {
			try {
				const dest = path.join(backupDir, 'tracked', rel);
				fs.mkdirSync(path.dirname(dest), { recursive: true });
				fs.cpSync(src, dest, { recursive: true });
				copied.push(rel);
			} catch (err) {
				incomplete = true;
				warnings.push(
					`failed to back up ${rel}: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}
		if (opts?.captureIndexEntry) {
			try {
				const captured = opts.captureIndexEntry({ backupDir, rel });
				if (captured) {
					entry.index = { mode: captured.mode, bytes: `index/${rel}` };
				}
			} catch (err) {
				incomplete = true;
				warnings.push(
					`failed to capture index state for ${rel}: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}
		entries[rel] = entry;
	}

	if (dirty.length > 0) {
		try {
			_internals.writeRecoveryManifest(backupDir, { entries });
		} catch (err) {
			incomplete = true;
			warnings.push(
				`failed to write recovery manifest: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	if (dirty.length === 0) {
		if (backupDirCreated) {
			try {
				fs.rmSync(backupDir, { recursive: true, force: true });
			} catch {
				// best-effort
			}
		}
		return {
			backupDir: null,
			copied,
			warnings,
			recordedDeletions,
			recoveryComplete: false,
		};
	}

	pruneOldResetBackups(backupsRoot, warnings, path.basename(backupDir));
	return {
		backupDir,
		copied,
		warnings,
		recordedDeletions,
		recoveryComplete: !incomplete,
	};
}
