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
			warnings.push(
				`skipped backup of ${sanitizeDiagnosticText(rel)} (path validation failed)`,
			);
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
				`failed to back up ${sanitizeDiagnosticText(rel)}: ${sanitizeDiagnosticText(err instanceof Error ? err.message : String(err))}`,
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
					`failed to prune old backup ${sanitizeDiagnosticText(stale.name)}: ${sanitizeDiagnosticText(err instanceof Error ? err.message : String(err))}`,
				);
			}
		}
	} catch (err) {
		warnings.push(
			`failed to prune old reset backups: ${sanitizeDiagnosticText(err instanceof Error ? err.message : String(err))}`,
		);
	}
}

/** One entry of the rollback backup's `recovery.json` manifest (#3763). */
export interface RecoveryManifestEntry {
	/**
	 * Staged (index) state captured before the destructive reset. A gitlink
	 * (mode 160000) has no blob — the recorded sha stands in for the capture
	 * (#3763 feedback round, FB-003).
	 */
	index?: { mode: string; bytes?: string; sha?: string; gitlink?: boolean };
	/** Working-tree state captured (or recorded as deleted) before reset. */
	worktree:
		| { kind: 'file'; bytes: string }
		| { kind: 'symlink'; bytes: string; target: string }
		| { kind: 'gitlink'; sha: string }
		| { kind: 'deleted' };
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
	/**
	 * Dirty paths captured as gitlink (submodule) pointers — no worktree
	 * bytes exist to copy and no deletion occurred; the restore gate counts
	 * them as honestly covered (FB-003, #3763 feedback round).
	 */
	gitlinkPaths: string[];
	/** True iff every capture step completed: copies, index capture, manifest. */
	recoveryComplete: boolean;
}

/**
 * A measured relative path that would escape the project root when joined
 * (FB-018/019, #3763 feedback round). Mirrors the discipline of
 * `isOutOfRootRelativePath` in rollback-gate.ts, additionally rejecting
 * platform-absolute and backslash-qualified forms: this is an exported sink,
 * so containment is enforced here and not only at callers.
 */
export function isUnsafeDirtyRelPath(rel: string): boolean {
	if (rel === '' || rel.startsWith('/') || rel.includes('\0')) return true;
	// FB-018 (#3763 feedback round, platform-aware, round-4 mixed-separator
	// fix): git porcelain uses '/' as the separator, so on POSIX a backslash
	// is a literal filename byte and `a\..\b` is ONE harmless component
	// (path.join keeps it whole) — split on '/' only there and do NOT
	// blanket-reject. On Windows BOTH '/' and '\' separate path components,
	// so the `..` scan must split on the UNION — separate single-separator
	// splits let a mixed form like `a\../..\x` traverse above the root
	// without any split yielding an exact `..` segment.
	const segments = path.sep === '\\' ? rel.split(/[\\/]/) : rel.split('/');
	if (segments.includes('..')) return true;
	if (path.sep === '\\' && path.win32.isAbsolute(rel)) return true;
	return false;
}

/**
 * FB-019 (#3763 feedback round): confirm the RESOLVED location of a path
 * stays inside the project root. `resolved` is realpathSync-ed, which
 * collapses every intermediate symlinked component — an in-root path routed
 * through a symlinked parent to an outside directory is rejected. Fails
 * closed on any resolution error.
 */
function isPathWithinRoot(directory: string, src: string): boolean {
	return resolveWithinRoot(directory, src) !== null;
}

/**
 * FB-019: symlink/leaf-safe containment — resolve only the PARENT directory
 * (so a final symlink is not dereferenced away) and confirm it is inside the
 * root. Returns the parent's realpath, or null if it escapes / cannot be
 * resolved (caller fails closed).
 */
function resolveParentWithinRoot(
	directory: string,
	src: string,
): string | null {
	return resolveWithinRoot(directory, path.dirname(src));
}

function resolveWithinRoot(directory: string, target: string): string | null {
	try {
		const root = fs.realpathSync(directory);
		const resolved = fs.realpathSync(target);
		// FB-NEW-SCAN (round 3): do not double the separator when the root IS
		// a filesystem root (`/`, `C:\`) — otherwise every descendant fails the
		// startsWith check and legitimate backups wrongly refuse.
		const base = root.endsWith(path.sep) ? root : root + path.sep;
		return resolved === root || resolved.startsWith(base) ? resolved : null;
	} catch {
		return null;
	}
}

/**
 * Bound and control-character-collapse repo-controlled text before it reaches
 * warnings/diagnostic strings (FB-021; same house discipline as
 * `formatExcludedRecord` in rollback-gate.ts, inlined to avoid a new
 * import edge between the command modules).
 */
export function sanitizeDiagnosticText(value: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional sanitization of untrusted path bytes
	const collapsed = value.replace(/[\x00-\x1f\x7f]+/g, ' ').trim();
	return collapsed.length > 200 ? `${collapsed.slice(0, 200)}…` : collapsed;
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
		}) => { mode: string; gitlink?: boolean; sha?: string } | null;
		/**
		 * Git-authoritative confirmation that a path is a DELETION (#3763
		 * feedback round, FB-001): the restore backup only records
		 * `worktree.kind === 'deleted'` when the caller's fresh porcelain read
		 * reports the path with a D in either XY column. A path that is simply
		 * not visible to `fs` (permission-error stat failure, or a name
		 * corrupted by lossy decoding of non-UTF-8 bytes) is NOT a deletion —
		 * without confirmation it flips `recoveryComplete` false and the
		 * restore gate refuses. This closes the window where restore used to
		 * proceed "backed up" while nothing was actually captured.
		 */
		confirmDeletion?: (rel: string) => boolean;
		/**
		 * FB-003 round 4: test seam for the worktree lstat so the
		 * unreadable-existing-entry (EACCES-class) fail-closed branch is
		 * exercisable on hosts without POSIX permission semantics. Defaults to
		 * `fs.lstatSync`; production callers never pass it.
		 */
		lstatImpl?: (src: string) => fs.Stats;
	},
): TrackedBackupResult {
	const warnings: string[] = [];
	const copied: string[] = [];
	const recordedDeletions: string[] = [];
	const gitlinkPaths: string[] = [];
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
				gitlinkPaths,
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
			gitlinkPaths,
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

	// FB-017 (#3763 feedback round): the recorded-deletions/copied sets are
	// documented exact sets — deduplicate the measured input so a repeated
	// path cannot be processed (and recorded) twice.
	const dirty: string[] = [
		...new Set(repoRelPaths.filter((rel) => rel !== '')),
	];

	if (dirty.length > 0) {
		try {
			ensureBackupDir();
		} catch (err) {
			warnings.push(
				`failed to create rollback backup directory: ${sanitizeDiagnosticText(err instanceof Error ? err.message : String(err))}`,
			);
			return {
				backupDir: null,
				copied,
				warnings,
				recordedDeletions,
				gitlinkPaths,
				recoveryComplete: false,
			};
		}
	}

	for (const rel of dirty) {
		// FB-018/019 (#3763 feedback round): containment is enforced HERE,
		// not only at the callers — this is an exported sink. A measured
		// relative path that escapes the project root never reaches the
		// filesystem joins below.
		if (isUnsafeDirtyRelPath(rel)) {
			incomplete = true;
			warnings.push(
				`refused dirty path outside the project root: ${sanitizeDiagnosticText(rel)}`,
			);
			continue;
		}
		const src = path.join(directory, rel);
		// FB-003 (#3763 feedback round): capture the STAGED (index) state
		// FIRST. A gitlink (submodule pointer, mode 160000) shows up in the
		// worktree as a DIRECTORY; classifying it before the index read made a
		// normal initialized submodule mark the capture incomplete and refuse
		// the whole restore. Recognizing the gitlink here lets restore proceed.
		let captured:
			| { mode: string; gitlink?: boolean; sha?: string }
			| null
			| undefined;
		let captureError: string | null = null;
		if (opts?.captureIndexEntry) {
			try {
				captured = opts.captureIndexEntry({ backupDir, rel });
			} catch (err) {
				captureError = err instanceof Error ? err.message : String(err);
			}
		}
		const entry: RecoveryManifestEntry = { worktree: { kind: 'deleted' } };
		// FB-001 / M-CON-001 / FB-003 round 3 (#3763 feedback round): ONE
		// lstat per path drives ALL classification. The gitlink shortcut is
		// gated on the WORKTRIE actually being a directory (a submodule
		// checkout) or absent — an index gitlink whose worktree entry has
		// been replaced by a regular file (typechange) must fall through to
		// the byte-copying branches, never be reported covered unbacked.
		let stat: fs.Stats | null = null;
		let absent = false;
		let statErrored = false;
		try {
			stat = (opts?.lstatImpl ?? fs.lstatSync)(src);
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code === 'ENOENT' || code === 'ENOTDIR') absent = true;
			else statErrored = true;
		}
		// FB-003 round 4 (#3763 feedback round): gitlink coverage requires the
		// worktree be a genuine directory (submodule checkout) or CONFIRMED
		// absent (ENOENT/ENOTDIR) — an unreadable existing entry (EACCES, etc.)
		// is NOT "absent" and must never take the shortcut unbacked.
		const worktreeIsDirLike =
			absent || (stat !== null && stat.isDirectory() && !stat.isSymbolicLink());
		if (captured?.gitlink && worktreeIsDirLike) {
			// A dirty submodule pointer has no worktree bytes to back up (the
			// reset only moves the pointer and never recurses into the
			// submodule), so record its sha honestly and classify the
			// worktree as a gitlink — NOT a deletion, NOT a copy failure.
			entry.worktree = { kind: 'gitlink', sha: captured.sha ?? '' };
			entry.index = { mode: captured.mode, sha: captured.sha, gitlink: true };
			gitlinkPaths.push(rel);
		} else if (statErrored) {
			// FB-003 round 4: an existing-but-unreadable worktree entry is
			// neither a confirmed deletion nor a safe gitlink — fail closed.
			incomplete = true;
			warnings.push(
				`cannot stat worktree entry for ${sanitizeDiagnosticText(rel)} — restore refused until it is resolved`,
			);
		} else {
			if (absent || stat === null) {
				if (opts?.confirmDeletion?.(rel)) {
					recordedDeletions.push(rel);
				} else {
					incomplete = true;
					warnings.push(
						`cannot confirm worktree state for ${sanitizeDiagnosticText(rel)} — refusing to treat it as deleted`,
					);
				}
			} else if (stat.isSymbolicLink()) {
				// FB-022: a symlink records its kind and target so manual
				// recovery can rebuild it faithfully. An unreadable target
				// FAILS CLOSED. FB-019 round 3: the PARENT is containment-
				// checked (intermediate symlinked directories cannot route
				// the copy outside the root) while the final link itself is
				// copied WITHOUT dereferencing (dereference:false).
				if (resolveParentWithinRoot(directory, src) === null) {
					incomplete = true;
					warnings.push(
						`refused to back up ${sanitizeDiagnosticText(rel)} — parent resolves outside the project root`,
					);
				} else {
					let target: string | null = null;
					try {
						target = fs.readlinkSync(src);
					} catch (err) {
						incomplete = true;
						warnings.push(
							`cannot read symlink target for ${sanitizeDiagnosticText(rel)}: ${sanitizeDiagnosticText(err instanceof Error ? err.message : String(err))}`,
						);
					}
					if (target !== null) {
						entry.worktree = {
							kind: 'symlink',
							bytes: `tracked/${rel}`,
							target,
						};
						try {
							const dest = path.join(backupDir, 'tracked', rel);
							fs.mkdirSync(path.dirname(dest), { recursive: true });
							// FB-022 round 3: copy the LINK, not its target —
							// dereference:false preserves the symlink and
							// verbatimSymlinks keeps the recorded target
							// string identical for faithful manual recovery.
							fs.cpSync(src, dest, {
								dereference: false,
								verbatimSymlinks: true,
							});
							copied.push(rel);
						} catch (err) {
							incomplete = true;
							warnings.push(
								`failed to back up ${sanitizeDiagnosticText(rel)}: ${sanitizeDiagnosticText(err instanceof Error ? err.message : String(err))}`,
							);
						}
					}
				}
			} else if (stat.isFile()) {
				// FB-019: realpath containment — never follow an in-root
				// symlinked intermediate component out of the project root.
				if (!isPathWithinRoot(directory, src)) {
					incomplete = true;
					warnings.push(
						`refused to back up ${sanitizeDiagnosticText(rel)} — resolved path escapes the project root`,
					);
				} else {
					entry.worktree = { kind: 'file', bytes: `tracked/${rel}` };
					try {
						const dest = path.join(backupDir, 'tracked', rel);
						fs.mkdirSync(path.dirname(dest), { recursive: true });
						fs.cpSync(src, dest, { dereference: false });
						copied.push(rel);
					} catch (err) {
						incomplete = true;
						warnings.push(
							`failed to back up ${sanitizeDiagnosticText(rel)}: ${sanitizeDiagnosticText(err instanceof Error ? err.message : String(err))}`,
						);
					}
				}
			} else {
				// Directory (or fifo/socket/device) where a tracked file was
				// expected and the index is not a gitlink: not a deletion,
				// not copyable bytes — refuse.
				incomplete = true;
				warnings.push(
					`unexpected non-regular worktree entry for ${sanitizeDiagnosticText(rel)} — restore refused until it is resolved`,
				);
			}
			if (captureError !== null) {
				incomplete = true;
				warnings.push(
					`failed to capture index state for ${sanitizeDiagnosticText(rel)}: ${sanitizeDiagnosticText(captureError)}`,
				);
			} else if (captured?.gitlink) {
				// FB-003 typechange (index gitlink, non-directory worktree):
				// the capture seam recorded a sha, wrote no blob — represent
				// the index honestly as a gitlink, never a phantom bytes path.
				entry.index = {
					mode: captured.mode,
					sha: captured.sha,
					gitlink: true,
				};
			} else if (captured) {
				entry.index = { mode: captured.mode, bytes: `index/${rel}` };
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
				`failed to write recovery manifest: ${sanitizeDiagnosticText(err instanceof Error ? err.message : String(err))}`,
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
			gitlinkPaths,
			recoveryComplete: false,
		};
	}

	pruneOldResetBackups(backupsRoot, warnings, path.basename(backupDir));
	return {
		backupDir,
		copied,
		warnings,
		recordedDeletions,
		gitlinkPaths,
		recoveryComplete: !incomplete,
	};
}
