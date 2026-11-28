/**
 * Shared atomic-write residue surface (issue #2035): read-only inventory,
 * gated recoverable quarantine, manifest-backed rollback, and the ONE
 * formatter every reporting surface (close clean stage, close dry-run,
 * config doctor, diagnose) renders from — so close and doctor report the
 * same inventory from a shared implementation by construction.
 *
 * Safety contract (issue #2035 reqs 4-7):
 *  - The scanner never traverses outside the canonical project `.swarm/`
 *    root, never follows symlinks (Dirent + lstat only), never infers
 *    ownership from content, and never reads content except a bounded
 *    sha256 at quarantine time.
 *  - Quarantine MOVES (never deletes) only verified stale residue: exact
 *    registered-grammar match with an instance token, age ≥
 *    RESIDUE_STALE_AGE_MS, git-untracked, non-symlink, no active lock,
 *    size ≤ RESIDUE_HASH_MAX_BYTES, parsed target present, and unchanged
 *    (mtime+size) between scan and move (TOCTOU re-check — a lockless
 *    writer still filling its temp mutates these).
 *  - Everything else — recent, active, tracked, ambiguous, constant-name,
 *    malformed, unmatched, outside-root — is PRESERVED and reported.
 *  - Rollback is exact, manifest-verified, and idempotent.
 */

import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { listActiveLocks } from '../parallel/file-locks';
import { telemetry } from '../telemetry';
import {
	atomicWriteSwarmFileSync,
	matchTempGrammar,
	parseTargetBasename,
	type SwarmTempGrammar,
} from '../utils/atomic-write';
import { bunSpawnSync } from '../utils/bun-compat';

/** Age gate: a temp older than this is "old". 30 min exceeds any legitimate
 * single bounded write (≤256 MiB + AV/rename-retry adds seconds), while still
 * catching session-old residue at close time. */
export const RESIDUE_STALE_AGE_MS = 30 * 60_000;
/** Bounded scan: stop (and report `truncated`) beyond this many entries. */
export const MAX_RESIDUE_SCAN_ENTRIES = 20_000;
/** Bounded scan depth below `.swarm/`. */
export const RESIDUE_SCAN_DEPTH = 8;
/** Hash/move bound per residue file. Larger candidates are reported only. */
export const RESIDUE_HASH_MAX_BYTES = 128 * 1024 * 1024;
/** `.swarm/` immediate-child subtrees the scanner never descends into. */
export const RESIDUE_SKIP_DIRS: readonly string[] = Object.freeze([
	'archive',
	'quarantine',
	'locks',
]);

export interface ResidueEntry {
	/** Path relative to the `.swarm/` root (never absolute — no path leak). */
	relPath: string;
	grammarId: string;
	grammarEra: SwarmTempGrammar['era'];
	bytes: number;
	mtimeMs: number;
	ageMs: number;
	isSymlink: boolean;
	tracked: 'tracked' | 'untracked' | 'unknown';
	lockHeld: boolean;
	proposedAction: 'quarantine' | 'report_only';
	reasons: readonly string[];
}

export interface ResidueInventorySummary {
	matched: number;
	eligible: number;
	ambiguous: number;
	totalBytes: number;
	oldestAgeMs: number;
}

export interface ResidueInventory {
	swarmRoot: string;
	scannedEntries: number;
	truncated: boolean;
	/** Oldest first. Constant-name grammar hits are included only when stale. */
	entries: readonly ResidueEntry[];
	summary: ResidueInventorySummary;
	gitState: 'ok' | 'unknown';
}

interface ScanItem {
	relPath: string;
	grammar: SwarmTempGrammar;
	isSymlink: boolean;
	bytes: number;
	mtimeMs: number;
}

/**
 * Test seam (repo `_internals` convention — never mock.module). `now` drives
 * age math; `queryTracked`/`activeLockTargets` isolate the git/lock signals.
 */
export const _internals = {
	now: (): number => Date.now(),
	/** Rename seam for the per-entry guarded move (PRR-005 regression tests). */
	renameResidueEntry: (from: string, to: string): void => {
		fs.renameSync(from, to);
	},
	linkResidueCopy: (from: fs.PathLike, to: fs.PathLike): void => {
		fs.linkSync(from, to);
	},
	copyResidueFile: (
		from: fs.PathLike,
		to: fs.PathLike,
		mode?: number,
	): void => {
		fs.copyFileSync(from, to, mode);
	},
	unlinkResidueCopy: (target: fs.PathLike): void => {
		fs.unlinkSync(target);
	},
	lstatResidue: (target: fs.PathLike): fs.Stats => fs.lstatSync(target),
	mkdirPublishParent: (target: string): void => {
		fs.mkdirSync(target, { recursive: true });
	},
	statQuarantineBatch: (target: fs.PathLike): fs.Stats => fs.statSync(target),
	readBatchDirectory: (target: string): fs.Dirent[] =>
		fs.readdirSync(target, { withFileTypes: true }),
	openResidueTemp: (target: string): number =>
		fs.openSync(
			target,
			fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
			0o600,
		),
	removeDrainedBatch: (target: string): void => {
		fs.rmSync(target, { recursive: true, force: true });
	},
	mkdirResidueParent: (target: string): void => {
		fs.mkdirSync(target, { recursive: true });
	},

	writeRollbackMarker: (
		batchAbs: string,
		marker: string,
		content: string,
	): void => {
		fs.writeFileSync(path.join(batchAbs, marker), content, 'utf-8');
	},
	queryTracked: (
		projectRoot: string,
		swarmRoot: string,
	): { tracked: Set<string> | undefined } => {
		// ONE bounded git call per scan: array-form, explicit cwd, stdin
		// ignored, 5s timeout. Failure (not a repo / git unavailable / not a
		// worktree-recognized path) maps to `undefined` = unknown = fail-closed.
		// -c core.quotepath=false: git C-QUOTES non-ASCII paths by default
		// (e.g. "\346\226\260..."), which path.resolve would misparse and the
		// tracked-set membership would miss — a TRACKED non-ASCII file would
		// then be quarantined (execution-verified, PR review PRR-013).
		// envOverrides=null deletes GIT_* redirectors (PRR-026): an inherited
		// GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE would silently retarget the
		// query at another repository.
		const result = bunSpawnSync(
			[
				'git',
				'-c',
				'core.quotepath=false',
				'ls-files',
				'--',
				swarmRoot.split(path.sep).join('/'),
			],
			{
				cwd: projectRoot,
				stdin: 'ignore',
				timeout: 5_000,
				envOverrides: {
					GIT_DIR: null,
					GIT_WORK_TREE: null,
					GIT_INDEX_FILE: null,
				},
			},
		);
		if (result.exitCode !== 0) return { tracked: undefined };
		const out = new TextDecoder().decode(result.stdout);
		const tracked = new Set<string>();
		for (const line of out.split(/\r?\n/)) {
			const t = line.trim();
			// git ls-files prints paths RELATIVE TO CWD even for absolute
			// pathspecs — resolve every line against the repo cwd so set
			// membership checks against absolute candidate paths succeed.
			if (t) tracked.add(path.normalize(path.resolve(projectRoot, t)));
		}
		return { tracked };
	},
	activeLockTargets: (directory: string): Set<string> => {
		// KNOWN LIMITATION (PR review PRR-008): locks whose .meta sidecar is
		// missing report only their hashed sentinel path (the original target
		// is unrecoverable), so a meta-less active lock can never match a
		// residue candidate's target. The staleness gate (≥30 min) is the
		// primary defense against racing a live writer; this signal only adds
		// precision for well-formed locks.
		const targets = new Set<string>();
		for (const lock of listActiveLocks(directory)) {
			targets.add(path.normalize(path.resolve(directory, lock.filePath)));
		}
		return targets;
	},
	sha256File: (absPath: string): string => {
		const hash = createHash('sha256');
		const fd = fs.openSync(absPath, 'r');
		try {
			const chunk = Buffer.alloc(1024 * 1024);
			for (;;) {
				// eslint-disable-next-line n/no-sync
				const read = fs.readSync(fd, chunk, 0, chunk.byteLength, null);
				if (read === 0) break;
				hash.update(chunk.subarray(0, read));
			}
		} finally {
			fs.closeSync(fd);
		}
		return hash.digest('hex');
	},
};

function collectCandidates(swarmRoot: string): {
	items: ScanItem[];
	scannedEntries: number;
	truncated: boolean;
} {
	const items: ScanItem[] = [];
	let scannedEntries = 0;
	let truncated = false;
	const walk = (relDir: string, depth: number): void => {
		if (truncated) return;
		const absDir =
			relDir === '' ? swarmRoot : path.join(swarmRoot, ...relDir.split('/'));
		let dirents: fs.Dirent[];
		try {
			dirents = fs.readdirSync(absDir, { withFileTypes: true });
		} catch {
			return; // unreadable subtree — not residue signal
		}
		for (const dirent of dirents) {
			if (++scannedEntries > MAX_RESIDUE_SCAN_ENTRIES) {
				truncated = true;
				return;
			}
			if (relDir === '' && RESIDUE_SKIP_DIRS.includes(dirent.name)) continue;
			const rel = relDir === '' ? dirent.name : `${relDir}/${dirent.name}`;
			if (dirent.isDirectory() && !dirent.isSymbolicLink()) {
				if (depth + 1 <= RESIDUE_SCAN_DEPTH) walk(rel, depth + 1);
				continue;
			}
			// Files AND symlinks whose basename matches a registered grammar
			// become candidates; symlink candidates are reported ineligible.
			const grammar = matchTempGrammar(dirent.name);
			if (!grammar) continue;
			let bytes = 0;
			let mtimeMs = 0;
			if (!dirent.isSymbolicLink()) {
				try {
					const st = fs.lstatSync(path.join(swarmRoot, ...rel.split('/')));
					if (!st.isFile()) continue;
					bytes = st.size;
					mtimeMs = st.mtimeMs;
				} catch {
					continue; // vanished mid-scan
				}
			}
			items.push({
				relPath: rel,
				grammar,
				isSymlink: dirent.isSymbolicLink(),
				bytes,
				mtimeMs,
			});
		}
	};
	walk('', 0);
	return { items, scannedEntries, truncated };
}

/** Read-only inventory of registered-grammar residue under `<directory>/.swarm`. */
export async function inventorySwarmResidue(
	directory: string,
): Promise<ResidueInventory> {
	const swarmRoot = path.normalize(path.resolve(directory, '.swarm'));
	if (!fs.existsSync(swarmRoot)) {
		return {
			swarmRoot,
			scannedEntries: 0,
			truncated: false,
			entries: [],
			summary: {
				matched: 0,
				eligible: 0,
				ambiguous: 0,
				totalBytes: 0,
				oldestAgeMs: 0,
			},
			gitState: 'unknown',
		};
	}
	const rootStat = fs.lstatSync(swarmRoot);
	if (rootStat.isSymbolicLink()) {
		throw new Error(`Refusing to scan a symlinked .swarm root: ${swarmRoot}`);
	}
	const projectRoot = path.dirname(swarmRoot);
	const { tracked } = _internals.queryTracked(projectRoot, swarmRoot);
	const lockTargets = _internals.activeLockTargets(directory);
	const { items, scannedEntries, truncated } = collectCandidates(swarmRoot);
	const now = _internals.now();

	const entries: ResidueEntry[] = [];
	for (const item of items) {
		const ageMs = Math.max(0, now - item.mtimeMs);
		// Constant-name grammars are reported only when stale (inventory noise
		// gate — fresh constant temps are indistinguishable from user files).
		if (
			item.grammar.token === 'constant' &&
			item.grammar.id !== 'dot-tmp-prefix-legacy'
		) {
			if (ageMs < RESIDUE_STALE_AGE_MS) continue;
		}
		const abs = path.normalize(
			path.join(swarmRoot, ...item.relPath.split('/')),
		);
		const reasons: string[] = [];
		if (!item.grammar.quarantineEligible) reasons.push('constant-name-grammar');
		if (ageMs < RESIDUE_STALE_AGE_MS) reasons.push('recent');
		let trackedState: ResidueEntry['tracked'];
		if (tracked === undefined) {
			trackedState = 'unknown';
			if (item.grammar.quarantineEligible)
				reasons.push('tracked-state-unknown');
		} else {
			trackedState = tracked.has(abs) ? 'tracked' : 'untracked';
			if (trackedState === 'tracked') reasons.push('git-tracked');
		}
		if (item.isSymlink) reasons.push('symlink');
		const lockHeld =
			lockTargets.has(abs) ||
			(item.grammar.parsesTarget
				? lockTargets.has(
						path.normalize(
							path.join(
								path.dirname(abs),
								parseTargetBasename(item.relPath.split('/').pop() ?? '') ?? '',
							),
						),
					)
				: false);
		if (lockHeld) reasons.push('active-lock');
		if (item.bytes > RESIDUE_HASH_MAX_BYTES) reasons.push('oversize');
		if (item.grammar.quarantineEligible && item.grammar.parsesTarget) {
			const targetBasename = parseTargetBasename(
				item.relPath.split('/').pop() ?? '',
			);
			if (targetBasename) {
				const targetAbs = path.join(path.dirname(abs), targetBasename);
				let targetOk = false;
				try {
					targetOk = fs.lstatSync(targetAbs).isFile();
				} catch {
					targetOk = false;
				}
				if (!targetOk) reasons.push('target-absent');
			}
		}
		entries.push({
			relPath: item.relPath,
			grammarId: item.grammar.id,
			grammarEra: item.grammar.era,
			bytes: item.bytes,
			mtimeMs: item.mtimeMs,
			ageMs,
			isSymlink: item.isSymlink,
			tracked: trackedState,
			lockHeld,
			proposedAction:
				item.grammar.quarantineEligible && reasons.length === 0
					? 'quarantine'
					: 'report_only',
			reasons,
		});
	}
	entries.sort((a, b) => b.ageMs - a.ageMs); // oldest first
	const eligible = entries.filter((e) => e.proposedAction === 'quarantine');
	return {
		swarmRoot,
		scannedEntries,
		truncated,
		entries,
		summary: {
			matched: entries.length,
			eligible: eligible.length,
			ambiguous: entries.length - eligible.length,
			totalBytes: entries.reduce((sum, e) => sum + e.bytes, 0),
			oldestAgeMs: entries[0]?.ageMs ?? 0,
		},
		gitState: tracked === undefined ? 'unknown' : 'ok',
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Quarantine + rollback
// ─────────────────────────────────────────────────────────────────────────────

export interface QuarantineManifestEntry {
	original_rel_path: string;
	stored_rel_path: string;
	sha256: string;
	bytes: number;
	mtime_ms: number;
	grammar_id: string;
	reason: string;
}

export interface QuarantineManifest {
	/**
	 * Manifest format version. Forward-compat POLICY (PR review PRR-009):
		 * rollback never interprets a version it does not know. Each batch tries all recovery surfaces, so a supported recovery surface remains usable even when its primary declares an unsupported version. However, DEFAULT selection hard-rejects when any readable batch has only unsupported manifest versions; this prevents a downgrade from silently skipping a v2 batch and rolling back another batch. Explicit selection also rejects an unsupported-only batch, naming its version.

	 */
	schema_version: 1;
	batch_id: string;
	created_at: string;
	trigger: string;
	entries: QuarantineManifestEntry[];
}

export interface QuarantineOutcomeItem {
	relPath: string;
	status: 'quarantined' | 'preserved';
	reasons: readonly string[];
}

export interface QuarantineResult {
	inventory: ResidueInventory;
	/** Batch dir relative to `.swarm/` — undefined when nothing was moved. */
	batchRelDir?: string;
	quarantined: number;
	/** report_only entries preserved at their original location. */
	preserved: readonly QuarantineOutcomeItem[];
}

/**
 * Failure classes for a manifest/scan rel path. `traversal`, `empty-segment`
 * and `absolute` indicate a MANIPULATED manifest (tamper class — the whole
 * call must abort); `control-char` is a bad-filename DATA defect that the
 * rollback path can skip-and-report (issue #3836 D1).
 */
type ResidueRelPathDefect =
	| 'traversal'
	| 'empty-segment'
	| 'absolute'
	| 'control-char';

/**
 * Non-throwing classifier sharing the exact predicate `validateRelPath`
 * rejects on (so the two can never drift). Tamper classes take priority over
 * `control-char` when a path mixes defects.
 */
function classifyRelPathDefect(rel: string): ResidueRelPathDefect | null {
	if (!rel) return 'empty-segment';
	if (path.isAbsolute(rel)) return 'absolute';
	const segments = rel.split('/');
	if (segments.some((s) => s === '..')) return 'traversal';
	if (segments.some((s) => s === '')) return 'empty-segment';
	// C0 + DEL + C1 (Unicode Cc) — aligned with the renderer's corpus
	// (issue #3836 D2; previously C0 only, which let DEL/C1 pass).
	if (segments.some((s) => /[\p{Cc}]/u.test(s))) return 'control-char';
	return null;
}

function validateRelPath(rel: string, what: string): string {
	if (classifyRelPathDefect(rel) !== null) {
		throw new Error(
			`unsafe ${what} in quarantine manifest: ${JSON.stringify(rel)}`,
		);
	}
	return rel;
}

/**
 * True when the given path holds a manifest surface the rollback reader would
 * ACCEPT: it parses, its schema version is the supported one, and its entries
 * are an array. Existence alone is not enough — the reader skips a surface it
 * cannot read or parse, so a promise of "normal rollback" must be based on a
 * surface that actually works.
 */
function isUsableManifestSurface(absPath: string): boolean {
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(absPath, 'utf-8'));
	} catch {
		return false;
	}
	if (parsed === null || typeof parsed !== 'object') return false;
	const version = (parsed as { schema_version?: unknown }).schema_version;
	if (version !== 1) return false;
	return Array.isArray((parsed as { entries?: unknown }).entries);
}

/**
 * Remove a batch directory ONLY when it holds nothing but owned metadata.
 *
 * The batch directory is created by the quarantine and is normally empty at
 * the two no-move points (the aborted intent write and the "nothing
 * qualified" case). A concurrent writer can place foreign content there
 * between the mkdir and the cleanup, so the removal must use the SAME
 * ownership classification the compensation path uses — an unconditional
 * recursive delete would remove that foreign content.
 */
function removeBatchDirIfOnlyOwnedMetadata(batchAbs: string): void {
	try {
		if (!batchDirContainsOnlyMetadata(batchAbs)) return;
		fs.rmSync(batchAbs, { recursive: true, force: true });
	} catch {
		/* best-effort removal of an owned-metadata-only dir */
	}
}

/**
 * True when a drained batch still holds a stored copy of one of its entries.
 *
 * A batch is drained when its entries were restored and their stored copies
 * consumed. A stored copy that is still present means the quarantine that owns
 * the batch is IN FLIGHT — it has not finished moving — so the durable drained
 * marker is not yet authoritative for it. Only the PRESENCE of a stored copy is
 * inspected; nothing is read or moved.
 */
function drainedBatchHasStoredCopy(
	swarmRoot: string,
	entries: QuarantineManifest['entries'],
): boolean {
	for (const entry of entries) {
		try {
			if (
				fs.existsSync(path.join(swarmRoot, ...entry.stored_rel_path.split('/')))
			) {
				return true;
			}
		} catch {
			/* a probe failure is not evidence of an in-flight batch */
		}
	}
	return false;
}

function sha256Bounded(absPath: string): string | undefined {
	try {
		return _internals.sha256File(absPath);
	} catch {
		return undefined;
	}
}

/**
 * Detect a non-empty strict prefix left by an interrupted publish. This reads
 * no more than the destination size; arbitrary differing content remains a collision.
 */
function removeOwnFile(absPath: string): void {
	try {
		fs.unlinkSync(absPath);
	} catch {
		/* best-effort cleanup of a temp or partial exclusive publish */
	}
}

function publishStoredCopyExclusively(
	storedAbs: string,
	originalAbs: string,
): { status: 'published' | 'collision' | 'failed'; code?: string } {
	const failure = (err: unknown): { status: 'failed'; code: string } => ({
		status: 'failed',
		code: (err as NodeJS.ErrnoException)?.code ?? 'unknown',
	});
	try {
		_internals.mkdirPublishParent(path.dirname(originalAbs));
	} catch (err) {
		return failure(err);
	}
	let tempPath: string;
	try {
		tempPath = `${originalAbs}.${randomBytes(16).toString('hex')}.tmp`;
	} catch (err) {
		return failure(err);
	}
	let fd: number | undefined;
	let ownsTemp = false;
	try {
		fd = _internals.openResidueTemp(tempPath);
		ownsTemp = true;
	} catch (err) {
		return failure(err);
	}
	try {
		const sourceFd = fs.openSync(storedAbs, 'r');
		try {
			const buffer = Buffer.alloc(64 * 1024);
			for (;;) {
				const read = fs.readSync(sourceFd, buffer, 0, buffer.length, null);
				if (read === 0) break;
				let written = 0;
				while (written < read) {
					written += fs.writeSync(fd, buffer, written, read - written);
				}
			}
		} finally {
			fs.closeSync(sourceFd);
		}
		fs.fsyncSync(fd);
	} catch (err) {
		if (fd !== undefined) {
			try {
				fs.closeSync(fd);
			} catch {
				/* best-effort close */
			}
		}
		if (ownsTemp) removeOwnFile(tempPath);
		return failure(err);
	}

	try {
		fs.closeSync(fd);
	} catch (err) {
		if (ownsTemp) removeOwnFile(tempPath);
		return failure(err);
	}

	try {
		_internals.copyResidueFile(
			tempPath,
			originalAbs,
			fs.constants.COPYFILE_EXCL,
		);
		return { status: 'published' };
	} catch (err) {
		const code = (err as NodeJS.ErrnoException)?.code ?? 'unknown';
		if (code === 'EEXIST') return { status: 'collision', code };
		// A destination pathname is not an ownership token: after a failed
		// exclusive copy, another writer may already have replaced our partial
		// bytes. Leave it untouched; the stored payload and unresolved manifest
		// entry remain authoritative for a later rollback.
		return failure(err);
	} finally {
		if (ownsTemp) removeOwnFile(tempPath);
	}
}

/**
 * Quarantine verified stale residue (moves only — never deletes). Callers
 * that can mutate pass an explicit trigger; `dryRun: true` returns the exact
 * plan without touching the filesystem (preview/confirmation path).
 */
export async function quarantineSwarmResidue(
	directory: string,
	options?: { trigger?: string; dryRun?: boolean },
): Promise<QuarantineResult> {
	const inventory = await inventorySwarmResidue(directory);
	const eligible = inventory.entries.filter(
		(e) => e.proposedAction === 'quarantine',
	);
	const preserved = inventory.entries
		.filter((e) => e.proposedAction === 'report_only')
		.map((e) => ({
			relPath: e.relPath,
			status: 'preserved' as const,
			reasons: e.reasons,
		}));
	if (options?.dryRun || eligible.length === 0) {
		return { inventory, quarantined: 0, preserved };
	}
	const swarmRoot = inventory.swarmRoot;
	const batchId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random()
		.toString(36)
		.slice(2, 10)}`;
	const batchAbs = path.join(swarmRoot, 'quarantine', batchId);
	fs.mkdirSync(batchAbs, { recursive: true });
	const manifest: QuarantineManifest = {
		schema_version: 1,
		batch_id: batchId,
		created_at: new Date().toISOString(),
		trigger: options?.trigger ?? 'manual',
		entries: [],
	};
	const moved: QuarantineOutcomeItem[] = [];
	// The planned entries — the write-ahead record's content. Collected (and
	// hashed) BEFORE anything moves, written to the intent surface, and only
	// then moved.
	const plannedEntries: QuarantineManifest['entries'] = [];
	for (const entry of eligible) {
		// Move-path name guard (issue #3836 D4): validate the residue name with
		// the SAME grammar the rollback manifest trusts BEFORE any rename. An
		// unsafe-named entry moved into the batch would be recorded raw in
		// manifest.json — the exact stranding class the rollback containment
		// (D1) has to repair. Such entries are NOT moved: they are preserved in
		// place and reported (consistent with the #3542/#3542-adjacent stance
		// that unverifiable names are never auto-mutated), so no manifest
		// record exists for them.
		if (classifyRelPathDefect(entry.relPath) !== null) {
			preserved.push({
				relPath: entry.relPath,
				status: 'preserved',
				reasons: ['unsafe-name'],
			});
			continue;
		}
		const abs = path.join(swarmRoot, ...entry.relPath.split('/'));
		// TOCTOU re-check: still a regular file, same size and mtime as scanned.
		try {
			const st = fs.lstatSync(abs);
			if (
				!st.isFile() ||
				st.size !== entry.bytes ||
				st.mtimeMs !== entry.mtimeMs
			) {
				preserved.push({
					relPath: entry.relPath,
					status: 'preserved',
					reasons: ['changed-since-scan'],
				});
				continue;
			}
		} catch {
			preserved.push({
				relPath: entry.relPath,
				status: 'preserved',
				reasons: ['vanished'],
			});
			continue;
		}
		const sha = sha256Bounded(abs);
		if (!sha) {
			preserved.push({
				relPath: entry.relPath,
				status: 'preserved',
				reasons: ['hash-failed'],
			});
			continue;
		}
		// Per-entry guarded move (PR review PRR-005): a concurrent process
		// winning this same entry makes our rename throw ENOENT, and EXDEV /
		// EPERM / antivirus locks can surface here too. An UNGUARDED throw
		// would abort the loop mid-batch with the manifest still unwritten —
		// stranding already-moved payloads in a manifest-less batch dir that
		// sorts LAST and then poisons every DEFAULT rollback ("no readable
		// manifest") until a newer batch exists. Guarding per entry and
		// continuing keeps the manifest authoritative over everything that
		// DID move; the failed entry simply stays in place, reported as
		// preserved.
		// WRITE-AHEAD RECORD (#3951 AC2, clause 1). The durable record of where
		// each file is going is written BEFORE the file moves, so a file is
		// never moved without a durable record of its origin. The record is a
		// manifest-shaped INTENT surface (`manifest.intent.json`) holding the
		// planned entries; the authoritative `manifest.json` is written after the
		// moves with the entries that actually moved.
		//
		// The intent is the surface that makes the correlated multi-failure
		// case recoverable through NORMAL rollback: if the manifest write, the
		// compensation and BOTH fallback recovery-manifest writes all fail,
		// the intent is still on disk and the rollback can restore the payload.
		plannedEntries.push({
			original_rel_path: entry.relPath,
			stored_rel_path: path.posix.join('quarantine', batchId, entry.relPath),
			sha256: sha,
			bytes: entry.bytes,
			mtime_ms: entry.mtimeMs,
			grammar_id: entry.grammarId,
			reason: 'stale-atomic-write-temp',
		});
	}
	// Write the intent BEFORE any file moves. If it cannot be written, NOTHING
	// has moved yet, so the quarantine aborts with every candidate still at its
	// original path — AC2 clause 1 holds by construction, including under a
	// read-only or full filesystem.
	if (plannedEntries.length > 0) {
		const intent: QuarantineManifest = {
			...manifest,
			entries: plannedEntries,
		};
		try {
			atomicWriteSwarmFileSync(
				path.join(batchAbs, BATCH_INTENT_MANIFEST),
				`${JSON.stringify(intent, null, 2)}\n`,
			);
		} catch (intentErr) {
			// Nothing was moved — the batch dir holds no payload. Remove it
			// best-effort so no empty batch can be selected later, and rethrow
			// the original error. The removal is OWNERSHIP-GUARDED: a concurrent
			// writer could have placed foreign content in the freshly created
			// batch directory, and an unconditional recursive delete would remove
			// it without the classification the compensation path uses.
			removeBatchDirIfOnlyOwnedMetadata(batchAbs);
			throw new Error(
				`${intentErr instanceof Error ? intentErr.message : String(intentErr)} — quarantine batch ${batchId} aborted before any file was moved (batch dir ${batchAbs}).`,
			);
		}
	}
	// Move the planned entries. The manifest records only what actually moved;
	// a failed move leaves the file in place, reported as preserved, and the
	// intent still lists it (its original path still holds the content).
	for (const planned of plannedEntries) {
		const abs = path.join(swarmRoot, ...planned.original_rel_path.split('/'));
		const storedAbs = path.join(
			batchAbs,
			...planned.original_rel_path.split('/'),
		);
		// TOCTOU re-check: still a regular file, same size and mtime as hashed.
		try {
			const st = fs.lstatSync(abs);
			if (
				!st.isFile() ||
				st.size !== planned.bytes ||
				st.mtimeMs !== planned.mtime_ms
			) {
				preserved.push({
					relPath: planned.original_rel_path,
					status: 'preserved',
					reasons: ['changed-since-scan'],
				});
				continue;
			}
		} catch {
			preserved.push({
				relPath: planned.original_rel_path,
				status: 'preserved',
				reasons: ['vanished'],
			});
			continue;
		}
		try {
			fs.mkdirSync(path.dirname(storedAbs), { recursive: true });
			_internals.renameResidueEntry(abs, storedAbs);
		} catch (moveErr) {
			const code = (moveErr as NodeJS.ErrnoException)?.code ?? 'unknown';
			preserved.push({
				relPath: planned.original_rel_path,
				status: 'preserved',
				reasons: [`move-failed:${code}`],
			});
			continue;
		}
		manifest.entries.push(planned);
		moved.push({
			relPath: planned.original_rel_path,
			status: 'quarantined',
			reasons: [],
		});
	}
	let batchRelDir: string | undefined;
	if (manifest.entries.length > 0) {
		// Manifest via the canonical helper: its transient temp lives inside
		// the skipped quarantine subtree, so the next scan cannot see it.
		//
		// #3951 AC5 — a manifest persistence failure after the renames must
		// not strand the moved payloads in a manifest-less batch that sorts
		// LAST and poisons every DEFAULT rollback. On failure: compensate with
		// collision-safe reverse moves (never overwrite a recreated original),
		// publish a recovery manifest on two fallback surfaces (in-batch
		// `manifest.recovery.json`, then parent-sibling
		// `<batchId>.recovery.json`), and rethrow the ORIGINAL error with the
		// compensation summary — the operator keeps the honest failure AND a
		// normally-recoverable batch.
		try {
			atomicWriteSwarmFileSync(
				path.join(batchAbs, 'manifest.json'),
				`${JSON.stringify(manifest, null, 2)}\n`,
			);
			// The authoritative manifest is on disk, so the write-ahead intent
			// has served its purpose. Remove it best-effort: the batch dir holds
			// only owned metadata afterwards. A failed removal is harmless — the
			// intent is an owned metadata name and the reader prefers
			// manifest.json.
			try {
				fs.rmSync(path.join(batchAbs, BATCH_INTENT_MANIFEST), {
					force: true,
				});
			} catch {
				/* best-effort removal of the superseded intent */
			}
		} catch (manifestErr) {
			const summary = compensateQuarantineBatch(swarmRoot, manifest);
			// A FULLY COMPENSATED batch has nothing left to recover: every moved
			// entry is back at its original path and its stored copy is gone. It
			// must not stay selectable for the default rollback — otherwise the
			// next default call picks this newer failed batch (its write-ahead
			// intent is still readable) instead of an older valid batch, and
			// #3951 AC2's second clause is broken. The durable drained marker
			// says exactly that: the entries are restored, the stored copies are
			// consumed. It is written BEFORE the recovery publication, which
			// removes the batch dir when it holds only owned metadata.
			if (
				summary.uncompensated.length === 0 &&
				summary.collisions.length === 0
			) {
				let marked = false;
				try {
					_internals.writeRollbackMarker(
						batchAbs,
						ROLLBACK_DRAINED_MARKER,
						`${JSON.stringify({ at: new Date().toISOString(), batchId, compensated: true })}\n`,
					);
					marked = true;
				} catch {
					/* best-effort: the marker only affects default selection */
				}
				if (!marked) {
					// The durable marker could not be written, so the batch would
					// stay SELECTABLE (its write-ahead intent is still readable)
					// and the next default rollback would pick it instead of an
					// older valid batch. The batch has nothing to recover, so
					// removing the intent makes it UNREADABLE — the default
					// selection then skips it. Either signal is enough; both
					// failing needs two independent failures on the same
					// directory.
					try {
						fs.rmSync(path.join(batchAbs, BATCH_INTENT_MANIFEST), {
							force: true,
						});
					} catch {
						/* best-effort: the batch stays selectable only if both fail */
					}
				}
			}
			const recoveryPublished = publishRecoveryManifest(
				swarmRoot,
				batchAbs,
				batchId,
				manifest,
				summary,
			);
			// The write-ahead intent surface is what makes the stranded entries
			// recoverable through NORMAL rollback: it was written before the
			// moves, so it survives a manifest-write failure, a failed
			// compensation and a failed fallback publication alike. The promise
			// in the error text is bound to that surface being USABLE — not to
			// its mere existence: the rollback reader skips a surface it cannot
			// read or parse, so an unreadable intent would leave the payload
			// unrecoverable and the promise would be false.
			const intentUsable = isUsableManifestSurface(
				path.join(batchAbs, BATCH_INTENT_MANIFEST),
			);
			const recoverable = recoveryPublished || intentUsable;
			const stranded = [...summary.uncompensated, ...summary.collisions];
			const strandedList =
				stranded.length === 0
					? ''
					: recoverable
						? ` Stranded entries (retained in the batch for normal rollback): ${stranded.join(', ')}.`
						: ` Stranded entries (retained under the batch directory for MANUAL recovery): ${stranded.join(', ')}. Batch directory: ${batchAbs}.`;
			const collisionList =
				summary.collisions.length > 0
					? ` Collision-kept entries (stored copy retained, differing original preserved): ${summary.collisions.join(', ')}.`
					: '';
			throw new Error(
				`${manifestErr instanceof Error ? manifestErr.message : String(manifestErr)} — quarantine batch ${batchId} compensated: ${summary.restored.length} restored, ${summary.uncompensated.length} uncompensated, ${summary.collisions.length} collision-kept (batch dir ${batchAbs}).${strandedList}${collisionList}`,
			);
		}
		batchRelDir = path.posix.join('quarantine', batchId);
	} else {
		// Nothing qualified — remove the empty batch dir best-effort so a
		// failed cleanup can never abort (or crash) the quarantine run. The
		// removal is OWNERSHIP-GUARDED for the same reason as the aborted
		// intent write above: a concurrent writer could have placed foreign
		// content in the freshly created batch directory.
		removeBatchDirIfOnlyOwnedMetadata(batchAbs);
	}
	try {
		telemetry.residueHealth({
			trigger: options?.trigger ?? 'manual',
			scanned: inventory.scannedEntries,
			matched: inventory.summary.matched,
			eligible: inventory.summary.eligible,
			ambiguous: inventory.summary.ambiguous,
			quarantined: manifest.entries.length,
			preserved: preserved.length,
			total_bytes: inventory.summary.totalBytes,
			oldest_age_ms: inventory.summary.oldestAgeMs,
			grammar_counts: Object.fromEntries(
				Object.entries(
					inventory.entries.reduce<Record<string, number>>((acc, e) => {
						acc[e.grammarId] = (acc[e.grammarId] ?? 0) + 1;
						return acc;
					}, {}),
				).sort(),
			),
		});
	} catch {
		// telemetry must never block quarantine/close
	}
	return {
		inventory,
		batchRelDir,
		quarantined: manifest.entries.length,
		preserved,
	};
}

export interface RollbackOutcomeItem {
	relPath: string;
	status:
		| 'restored'
		| 'already-restored'
		| 'collision'
		| 'missing-copy'
		| 'unresolved'
		| 'skipped';
	/**
		 * Present on non-standard outcomes only (skipped or retained duplicate).
		 * Optional — ordinary restored/collision/missing-copy item shape is pinned
		 * by tests/unit/services/swarm-residue-quarantine.test.ts and stays key-identical.

	 */
	reasons?: readonly string[];
}

export interface RollbackResult {
	batchRelDir: string;
	items: readonly RollbackOutcomeItem[];
	/** True when every manifest entry resolved and the batch dir was removed. */
	drained: boolean;
	/**
	 * #3951 — batches skipped by default selection because NO manifest
	 * surface was readable (payload retained under .swarm/quarantine/<id>/
	 * for manual recovery). Optional for backward compatibility.
	 */
	skippedBatches?: string[];
	/**
	 * #3951 — true when the batch directory exists after rollback cleanup.
	 * Optional for backward compatibility.
	 */
	batchDirRetained?: boolean;
	/**
	 * Why a drained batch directory remains on disk, when established.
	 *
	 * `owned-metadata-retained` covers BOTH ways owned metadata can survive a
	 * drain: the removal was attempted and failed, and the removal was skipped
	 * because a parent-sibling recovery manifest was present at decision time.
	 * The two are not distinguishable after the fact (the sibling is removed
	 * once the drain marker is written), and both are truthfully reported by
	 * "its owned metadata was not removed" — so they share one reason.
	 */
	batchDirRetentionReason?:
		| 'foreign-content'
		| 'sibling-recovery-present'
		| 'metadata-scan-failed'
		| 'owned-metadata-retained'
		| 'in-flight-batch';
	/** True when removing owned metadata from a drained batch failed. */
	batchDirCleanupFailed?: boolean;
	/** True when a retained drained directory could not persist its drain marker. */
	drainedMarkerWriteFailed?: boolean;
	/** Default selection found only previously drained batches. */
	nothingToRestore?: boolean;
	/** Batch ids whose readable manifest surfaces declare an unsupported version. */
	unsupportedBatches?: Array<{ batchId: string; version: string }>;
}

/** Manifest surface names (#3951 recovery design). */
const BATCH_MANIFEST = 'manifest.json';
const BATCH_RECOVERY_MANIFEST = 'manifest.recovery.json';
/**
 * The write-ahead INTENT surface (#3951 AC2). It records the planned entries
 * BEFORE any file moves, so a moved file always has a durable record of its
 * origin. It is manifest-shaped (the same schema), so the rollback reader can
 * use it directly when the authoritative manifest is unreadable.
 */
const BATCH_INTENT_MANIFEST = 'manifest.intent.json';
const ROLLBACK_ATTEMPTED_MARKER = 'rollback.attempted';
const ROLLBACK_DRAINED_MARKER = 'rollback.drained';

/** Parent-sibling recovery surface: `.swarm/quarantine/<batchId>.recovery.json`. */
function parentSiblingRecoveryPath(swarmRoot: string, batchId: string): string {
	return path.join(swarmRoot, 'quarantine', `${batchId}.recovery.json`);
}

/**
 * Directory-content guard for the post-compensation cleanup (#3951 review
 * round 1): destructive removal is allowed only when EVERY file under the
 * batch dir is a known metadata artifact (manifest surfaces, the rollback
 * attempt marker, or atomic-write temp leftovers for them). Any other file —
 * payload that raced back in, or a foreign file — blocks the cleanup; the
 * empty-of-payload summary alone cannot establish safety.
 */
type BatchDirectoryClassification =
	| 'only-metadata'
	| 'foreign-content'
	| 'unknown';

/**
 * True when the subtree under `dir` contains only directories — no file, no
 * symlink, and nothing that could not be read.
 *
 * The quarantine stores a nested residue's copy under
 * `quarantine/<batchId>/<relPath>` and creates the parent folders with
 * `mkdirSync(..., { recursive: true })`. After the rollback unlinks the stored
 * file, those folders remain but hold nothing — they are the plugin's own
 * structure, not foreign content. The walk is bounded by the scanner's own
 * depth limit; a deeper or unreadable subtree is NOT proven empty and is
 * treated as foreign by the caller.
 */
function subtreeHoldsOnlyDirectories(dir: string, depth: number): boolean {
	if (depth > RESIDUE_SCAN_DEPTH) return false;
	let entries: fs.Dirent[];
	try {
		entries = _internals.readBatchDirectory(dir);
	} catch {
		return false;
	}
	for (const entry of entries) {
		if (entry.isSymbolicLink()) return false;
		if (entry.isDirectory()) {
			if (!subtreeHoldsOnlyDirectories(path.join(dir, entry.name), depth + 1)) {
				return false;
			}
			continue;
		}
		return false;
	}
	return true;
}

function classifyBatchDirectory(
	batchAbs: string,
): BatchDirectoryClassification {
	const METADATA_NAMES = new Set([
		BATCH_MANIFEST,
		BATCH_RECOVERY_MANIFEST,
		BATCH_INTENT_MANIFEST,
		ROLLBACK_ATTEMPTED_MARKER,
		ROLLBACK_DRAINED_MARKER,
	]);
	// Atomic-write temps ONLY in their documented grammar
	// `<target>.<hex32>.tmp` (the grammar registry entry is
	// src/utils/atomic-write.ts:76) — a bare prefix match would admit foreign
	// lookalikes such as `manifest.json.operator-notes.txt` (round-3 review probe).
	const METADATA_TEMP =
		/^(manifest\.json|manifest\.recovery\.json|manifest\.intent\.json)\.[0-9a-f]{32}\.tmp$/;
	let hasForeignContent = false;
	let scanFailed = false;
	const walk = (dir: string, isBatchRoot: boolean): void => {
		let entries: fs.Dirent[];
		try {
			entries = _internals.readBatchDirectory(dir);
		} catch {
			scanFailed = true;
			return;
		}
		if (!isBatchRoot && entries.length > 0) {
			// A root manifest-name directory is a known fault-injection artifact,
			// but its contents have no established plugin ownership. Recursive
			// removal would otherwise delete arbitrary files nested beneath it.
			hasForeignContent = true;
			return;
		}
		for (const entry of entries) {
			if (entry.isDirectory()) {
				// Only an empty directory occupying a manifest name at the batch
				// root is the atomic-write fault-injection artifact. Any other
				// directory, including any directory below that artifact, is foreign.
				if (
					isBatchRoot &&
					(entry.name === BATCH_MANIFEST ||
						entry.name === BATCH_RECOVERY_MANIFEST)
				) {
					walk(path.join(dir, entry.name), false);
					continue;
				}
				if (isBatchRoot) {
					// A directory at the batch root whose whole subtree contains
					// ONLY directories is structure the quarantine itself
					// created for a NESTED residue (the stored copy's parent
					// folders), which the rollback emptied. It holds nothing to
					// preserve, so it is not foreign content and the batch can
					// still be removed. A subtree holding any file or symlink has
					// unestablished ownership and stays foreign; so does a subtree
					// that cannot be read.
					if (subtreeHoldsOnlyDirectories(path.join(dir, entry.name), 1)) {
						continue;
					}
					hasForeignContent = true;
					continue;
				}
				hasForeignContent = true;
				continue;
			}
			// Owned names and the atomic-write temp grammar are metadata only at
			// the batch root; matching basenames deeper in the tree are foreign.
			const isMetadata =
				isBatchRoot &&
				(METADATA_NAMES.has(entry.name) || METADATA_TEMP.test(entry.name));
			if (!isMetadata) hasForeignContent = true;
		}
	};
	walk(batchAbs, true);
	if (scanFailed) return 'unknown';
	return hasForeignContent ? 'foreign-content' : 'only-metadata';
}

function batchDirContainsOnlyMetadata(batchAbs: string): boolean {
	return classifyBatchDirectory(batchAbs) === 'only-metadata';
}

/**
 * #3951 AC5 — collision-safe compensation for a batch whose manifest write
 * failed after the renames. Mirrors rollbackResidueQuarantine's per-entry
 * semantics: absent original → reverse-rename; present original → sha-compare
 * (identical = already-restored, stored copy dropped; differing = collision,
 * stored copy KEPT and reported, never overwritten). A reverse-move failure
 * records the entry as uncompensated (never aborts the loop).
 */
function compensateQuarantineBatch(
	swarmRoot: string,
	manifest: QuarantineManifest,
): {
	restored: string[];
	uncompensated: string[];
	collisions: string[];
} {
	const restored: string[] = [];
	const uncompensated: string[] = [];
	const collisions: string[] = [];
	for (const entry of manifest.entries) {
		const originalAbs = path.join(
			swarmRoot,
			...entry.original_rel_path.split('/'),
		);
		const storedAbs = path.join(swarmRoot, ...entry.stored_rel_path.split('/'));
		let storedExists = false;
		let inspectionError: string | undefined;
		try {
			storedExists = _internals.lstatResidue(storedAbs).isFile();
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
				inspectionError = (err as NodeJS.ErrnoException).code ?? 'unknown';
			}
		}
		let originalExists = false;
		try {
			originalExists = _internals.lstatResidue(originalAbs).isFile();
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
				inspectionError ??= (err as NodeJS.ErrnoException).code ?? 'unknown';
			}
		}
		if (inspectionError) {
			uncompensated.push(entry.original_rel_path);
			continue;
		}
		if (!storedExists) {
			// The stored copy is gone: either already moved back or lost
			// elsewhere — classify by the original's presence.
			if (originalExists) restored.push(entry.original_rel_path);
			else uncompensated.push(entry.original_rel_path);
			continue;
		}
		if (originalExists) {
			const currentSha = sha256Bounded(originalAbs);
			const storedSha = sha256Bounded(storedAbs);
			if (
				currentSha !== undefined &&
				storedSha !== undefined &&
				currentSha === storedSha
			) {
				// Identical content already at the original — drop the stored copy.
				try {
					_internals.unlinkResidueCopy(storedAbs);
					restored.push(entry.original_rel_path);
				} catch {
					uncompensated.push(entry.original_rel_path);
				}
			} else {
				collisions.push(entry.original_rel_path);
			}
			continue;
		}
		try {
			_internals.mkdirResidueParent(path.dirname(originalAbs));
		} catch {
			uncompensated.push(entry.original_rel_path);
			continue;
		}
		try {
			_internals.linkResidueCopy(storedAbs, originalAbs);
		} catch (linkErr) {
			if ((linkErr as NodeJS.ErrnoException).code === 'EEXIST') {
				collisions.push(entry.original_rel_path);
				continue;
			}
			const fallback = publishStoredCopyExclusively(storedAbs, originalAbs);
			if (fallback.status === 'collision') {
				collisions.push(entry.original_rel_path);
				continue;
			}
			if (fallback.status === 'failed') {
				uncompensated.push(entry.original_rel_path);
				continue;
			}
		}
		try {
			_internals.unlinkResidueCopy(storedAbs);
			restored.push(entry.original_rel_path);
		} catch {
			uncompensated.push(entry.original_rel_path);
		}
	}
	return { restored, uncompensated, collisions };
}

/**
 * #3951 AC5 — publish a recovery manifest on the fallback surfaces when
 * compensation leaves anything in the batch (uncompensated or collision-kept),
 * so normal rollback can restore/report it. Two surfaces, tried in order:
 * in-batch `manifest.recovery.json`, then the parent-sibling (the primary
 * failure mode — an unwritable/blocking name INSIDE the batch dir — cannot
 * also block the parent). Best-effort: a failure on both surfaces leaves the
 * batch dir as-is; the rethrown quarantine error names the batch and entries.
 *
 * Review round 1 (implementation review): the recovery manifest carries ONLY
 * the unresolved entries — entries compensation already restored have no
 * stored copy left, so listing them would make rollback report `missing-copy`
 * forever and the batch could never drain. When NOTHING remains, the (now
 * payload-free) batch dir is removed best-effort — guarded by an actual
 * directory-content check so a FOREIGN file dropped into the batch dir is
 * never recursively deleted (the summary alone cannot establish that).
 */
function publishRecoveryManifest(
	swarmRoot: string,
	batchAbs: string,
	batchId: string,
	manifest: QuarantineManifest,
	summary: {
		restored: string[];
		uncompensated: string[];
		collisions: string[];
	},
): boolean {
	const remaining = summary.uncompensated.length + summary.collisions.length;
	if (remaining === 0) {
		if (batchDirContainsOnlyMetadata(batchAbs)) {
			try {
				fs.rmSync(batchAbs, { recursive: true, force: true });
			} catch {
				/* best-effort removal of the metadata-only batch dir */
			}
		}
		return true;
	}
	const recoveryManifest: QuarantineManifest = {
		...manifest,
		entries: manifest.entries.filter(
			(entry) =>
				summary.uncompensated.includes(entry.original_rel_path) ||
				summary.collisions.includes(entry.original_rel_path),
		),
	};
	const serialized = `${JSON.stringify(recoveryManifest, null, 2)}\n`;
	try {
		atomicWriteSwarmFileSync(
			path.join(batchAbs, BATCH_RECOVERY_MANIFEST),
			serialized,
		);
		return true;
	} catch {
		/* fall through to the parent-sibling surface */
	}
	try {
		atomicWriteSwarmFileSync(
			parentSiblingRecoveryPath(swarmRoot, batchId),
			serialized,
		);
		return true;
	} catch {
		/* both recovery surfaces failed — the rethrown error names the batch */
		return false;
	}
}

function listQuarantineBatches(swarmRoot: string): string[] {
	const quarantineRoot = path.join(swarmRoot, 'quarantine');
	try {
		return fs
			.readdirSync(quarantineRoot, { withFileTypes: true })
			.filter((d) => d.isDirectory() && !d.isSymbolicLink())
			.map((d) => d.name)
			.sort();
	} catch {
		return [];
	}
}

/**
 * Roll back a quarantine batch (default: latest). Idempotent and
 * order-independent across batches: an occupied original is compared by
 * checksum — identical copies are dropped (already restored), differing
 * content is left in place and reported as a collision, never overwritten.
 *
 * Per-entry containment (issue #3836 D1): a manifest entry whose path fields
 * carry ONLY control characters (C0/DEL/C1) is SKIPPED and reported once
 * (`status: 'skipped'`, reason `unsafe-name`) instead of aborting the whole
 * call — the batch is retained (`drained: false`) so the valid siblings
 * still restore and the poisoned stored copy is left byte-unchanged. The
 * tamper class (traversal / empty segment / absolute path / root escape) is
 * still a HARD REJECT: those indicate a manipulated manifest, not a bad
 * filename, and keep the whole-call abort contract.
 */
export async function rollbackResidueQuarantine(
	directory: string,
	batchId?: string,
): Promise<RollbackResult> {
	const swarmRoot = path.normalize(path.resolve(directory, '.swarm'));
	const batches = listQuarantineBatches(swarmRoot);
	if (batches.length === 0) {
		throw new Error('No quarantine batches found under .swarm/quarantine/');
	}
	// #3951 AC5 — three-surface manifest resolution (primary, in-batch
	// recovery, parent-sibling recovery) for BOTH default and explicit
	// selection: a batch whose primary manifest write failed but whose
	// recovery manifest published is a fully normal rollback target.
	const skippedBatches = new Set<string>();
	const unsupportedByBatch = new Map<string, string>();
	const readManifest = (b: string): QuarantineManifest | null => {
		const batchDir = path.join(swarmRoot, 'quarantine', b);
		const surfaces = [
			path.join(batchDir, BATCH_MANIFEST),
			path.join(batchDir, BATCH_RECOVERY_MANIFEST),
			parentSiblingRecoveryPath(swarmRoot, b),
			// The write-ahead INTENT surface (#3951 AC2). It is the LAST
			// fallback: it records the PLANNED entries, so an entry that never
			// moved is reported against its original path rather than as a lost
			// payload.
			path.join(batchDir, BATCH_INTENT_MANIFEST),
		];
		let unsupportedVersion: string | undefined;
		for (const surface of surfaces) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(fs.readFileSync(surface, 'utf-8'));
			} catch {
				// A broken or absent surface does not hide a later recovery surface.
				continue;
			}
			const version =
				parsed !== null && typeof parsed === 'object'
					? (parsed as { schema_version?: unknown }).schema_version
					: undefined;
			if (version !== 1) {
				unsupportedVersion ??= String(version ?? 'unknown');
				continue;
			}
			if (!Array.isArray((parsed as { entries?: unknown }).entries)) continue;
			unsupportedByBatch.delete(b);
			return parsed as QuarantineManifest;
		}
		if (unsupportedVersion !== undefined) {
			unsupportedByBatch.set(b, unsupportedVersion);
		}
		skippedBatches.add(b);
		return null;
	};
	const hasDrainedMarker = (b: string): boolean => {
		try {
			fs.statSync(
				path.join(swarmRoot, 'quarantine', b, ROLLBACK_DRAINED_MARKER),
			);
			return true;
		} catch {
			return false;
		}
	};
	const hasAttemptMarker = (b: string): boolean => {
		try {
			fs.statSync(
				path.join(swarmRoot, 'quarantine', b, ROLLBACK_ATTEMPTED_MARKER),
			);
			return true;
		} catch {
			return false;
		}
	};
	let selected: string | undefined;

	if (batchId) {
		selected =
			batches.find((b) => b === batchId || b.endsWith(`-${batchId}`)) ??
			(() => {
				throw new Error(`Quarantine batch not found: ${batchId}`);
			})();
	} else {
		// Exclude drained batches before attempt preference and fallback.
		const readable = batches
			.slice()
			.reverse()
			.filter((b) => readManifest(b) !== null);
		const candidates = readable.filter((b) => !hasDrainedMarker(b));
		for (const b of batches) {
			readManifest(b);
		}
		if (unsupportedByBatch.size > 0) {
			const unsupportedBatches = [...unsupportedByBatch.entries()].map(
				([unsupportedId, version]) => ({ batchId: unsupportedId, version }),
			);
			const [{ batchId: unsupportedBatch, version }] = unsupportedBatches;
			const error = new Error(
				`Quarantine batch has unsupported manifest version ${version}: ${unsupportedBatch}`,
			) as Error & {
				unsupportedBatches: typeof unsupportedBatches;
			};
			error.unsupportedBatches = unsupportedBatches;
			throw error;
		}
		if (candidates.length > 0) {
			selected = candidates.find((b) => !hasAttemptMarker(b)) ?? candidates[0]!;
		} else if (batches.some(hasDrainedMarker)) {
			const drained = batches.find(hasDrainedMarker)!;
			// A drained batch whose stored copy is STILL PRESENT is IN FLIGHT: a
			// quarantine in another process is still moving it. The sibling
			// recovery surface must not be removed under it, and the batch must
			// not be reported as drained-and-nothing-to-restore.
			const inFlight = drainedBatchHasStoredCopy(
				swarmRoot,
				readManifest(drained)?.entries ?? [],
			);
			if (!inFlight) {
				try {
					fs.rmSync(parentSiblingRecoveryPath(swarmRoot, drained), {
						force: true,
					});
				} catch {
					/* drained batches no longer need their sibling recovery surface */
				}
			}
			return {
				batchRelDir: path.posix.join('quarantine', drained),
				items: [],
				drained: !inFlight,
				batchDirRetained: true,
				nothingToRestore: !inFlight,
				...(inFlight
					? {
							batchDirRetentionReason: 'in-flight-batch' as const,
						}
					: {}),
				skippedBatches: [...skippedBatches].filter(
					(b) => !unsupportedByBatch.has(b),
				),
				unsupportedBatches: [...unsupportedByBatch.entries()].map(
					([unsupportedBatch, version]) => ({
						batchId: unsupportedBatch,
						version,
					}),
				),
			};
		} else if (readable.length > 0) {
			selected = readable[0]!;
		} else {
			if (unsupportedByBatch.size > 0) {
				const [unsupportedBatch, version] = unsupportedByBatch.entries().next()
					.value!;
				throw new Error(
					`Quarantine batch has unsupported manifest version ${version}: ${unsupportedBatch}`,
				);
			}
			throw new Error(
				`Quarantine batch has no readable manifest surface (manifest.json, ${BATCH_INTENT_MANIFEST}, ${BATCH_RECOVERY_MANIFEST}, <batchId>.recovery.json): ${batches.join(', ')}`,
			);
		}
	}

	if (selected === undefined) {
		throw new Error('No quarantine batch remains to restore');
	}
	const batchAbs = path.join(swarmRoot, 'quarantine', selected);
	if (hasDrainedMarker(selected)) {
		// The marker is the durable authority: entries were already restored and
		// their stored copies consumed. Reuse manifest names only for the stable
		// already-restored result shape; never inspect or mutate their current paths.
		const drainedManifest =
			batchId === undefined ? null : readManifest(selected);
		// A batch can be IN FLIGHT: a quarantine in one process (close or
		// doctor) can be moving entries while a rollback in another process
		// reads the write-ahead record. Such a batch still holds a stored copy,
		// so the marker is not yet authoritative for it — reporting its entries
		// as already-restored would hide a payload that is still in the batch.
		// The stored copies are therefore checked (their PRESENCE only; they are
		// never read or moved) and an entry whose copy is still present is
		// reported unresolved instead.
		const inFlight = new Set<string>();
		for (const entry of drainedManifest?.entries ?? []) {
			try {
				if (
					fs.existsSync(
						path.join(swarmRoot, ...entry.stored_rel_path.split('/')),
					)
				) {
					inFlight.add(entry.original_rel_path);
				}
			} catch {
				/* a probe failure is not evidence of an in-flight batch */
			}
		}
		// A retained drained directory still needs a truthful retention reason,
		// and the drain's own metadata cleanup may still be outstanding: it is
		// SKIPPED when a parent-sibling recovery manifest is present and it can
		// FAIL outright. The reason is RE-DERIVED from the directory's CURRENT
		// state, because the cause that kept the original drain from removing it
		// is not recoverable afterwards (the sibling recovery manifest is removed
		// once the drain marker is written). Only the batch's own entries are
		// listed; the restored files are never inspected or mutated.
		let retainedReason: RollbackResult['batchDirRetentionReason'];
		let cleanupFailed = false;
		if (fs.existsSync(batchAbs)) {
			const classification = classifyBatchDirectory(batchAbs);
			if (classification === 'foreign-content') {
				retainedReason = 'foreign-content';
			} else if (classification === 'unknown') {
				retainedReason = 'metadata-scan-failed';
			} else if (
				fs.existsSync(parentSiblingRecoveryPath(swarmRoot, selected))
			) {
				retainedReason = 'sibling-recovery-present';
			} else {
				// Only owned metadata is left: finish the drain by removing it.
				// The classification guard is the same one the drain itself
				// uses, so foreign content is never removed.
				try {
					_internals.removeDrainedBatch(batchAbs);
				} catch {
					cleanupFailed = true;
					retainedReason = 'owned-metadata-retained';
				}
			}
		}
		const retained = fs.existsSync(batchAbs);
		return {
			batchRelDir: path.posix.join('quarantine', selected),
			items:
				drainedManifest?.entries.map((entry) =>
					inFlight.has(entry.original_rel_path)
						? {
								relPath: entry.original_rel_path,
								status: 'unresolved' as const,
								reasons: ['in-flight-batch:stored-copy-present'],
							}
						: {
								relPath: entry.original_rel_path,
								status: 'already-restored' as const,
							},
				) ?? [],
			drained: inFlight.size === 0,
			batchDirRetained: retained,
			...(cleanupFailed ? { batchDirCleanupFailed: true } : {}),
			...(inFlight.size > 0
				? { batchDirRetentionReason: 'in-flight-batch' as const }
				: retainedReason
					? { batchDirRetentionReason: retainedReason }
					: {}),
			nothingToRestore: batchId === undefined,
			skippedBatches: [...skippedBatches].filter(
				(b) => !unsupportedByBatch.has(b),
			),
			unsupportedBatches: [...unsupportedByBatch.entries()].map(
				([unsupportedBatch, version]) => ({
					batchId: unsupportedBatch,
					version,
				}),
			),
		};
	}
	const manifest = readManifest(selected);
	if (manifest === null) {
		const unsupportedVersion = unsupportedByBatch.get(selected);
		if (unsupportedVersion !== undefined) {
			throw new Error(
				`Quarantine batch has unsupported manifest version ${unsupportedVersion}: ${selected}`,
			);
		}
		throw new Error(
			`Quarantine batch has no readable manifest surface (manifest.json, ${BATCH_INTENT_MANIFEST}, ${BATCH_RECOVERY_MANIFEST}, <batchId>.recovery.json): ${selected}`,
		);
	}

	const items: RollbackOutcomeItem[] = [];
	let allResolved = true;
	for (const entry of manifest.entries) {
		// Classify BOTH path fields BEFORE any per-entry action (mixed-poison
		// rule, symmetric in BOTH directions: a tamper-class defect — traversal,
		// empty segment, or absolute path — in EITHER field is a hard reject,
		// never a skip, even when the OTHER field's only defect is a control
		// char. So control-char original_rel_path + traversal stored_rel_path
		// rejects, and traversal original_rel_path + control-char
		// stored_rel_path rejects just the same. Control chars in BOTH fields
		// stay a single skip-and-report below — neither direction of the mix
		// upgrades or downgrades the other's class).
		const defects = [
			classifyRelPathDefect(entry.original_rel_path),
			classifyRelPathDefect(entry.stored_rel_path),
		];
		if (defects.some((d) => d !== null && d !== 'control-char')) {
			// Tamper class — re-run the throwing validators so the whole-call
			// error is the canonical pre-#3836 message (pinned by
			// tests/unit/services/swarm-residue-quarantine.test.ts). The
			// classifier shares the validator's predicate, so one of these
			// always throws; the trailing escape-guard throw keeps this branch
			// total so a tamper entry can never fall through to a skip.
			validateRelPath(entry.original_rel_path, 'original_rel_path');
			validateRelPath(entry.stored_rel_path, 'stored_rel_path');
			throw new Error(`Quarantine manifest path escapes its root: ${selected}`);
		}
		if (defects.some((d) => d !== null)) {
			// Control-char-only data defect: skip-and-report. relPath is a
			// JSON.stringify-style escaped SAFE rendering — the Cc-neutralized
			// name, quoted and escaped, so no raw control byte ever reaches a
			// downstream render sink while the report still identifies the
			// entry. The poisoned stored copy is left byte-unchanged.
			items.push({
				relPath: JSON.stringify(neutralizeResidueName(entry.original_rel_path)),
				status: 'skipped',
				reasons: ['unsafe-name'],
			});
			allResolved = false;
			continue;
		}
		const originalRel = entry.original_rel_path;
		const storedRel = entry.stored_rel_path;
		const originalAbs = path.join(swarmRoot, ...originalRel.split('/'));
		const storedAbs = path.join(swarmRoot, ...storedRel.split('/'));
		// Manifest paths must stay under their owning roots (tamper guard).
		if (
			!originalAbs.startsWith(swarmRoot + path.sep) ||
			!storedAbs.startsWith(batchAbs + path.sep)
		) {
			throw new Error(`Quarantine manifest path escapes its root: ${selected}`);
		}
		if (!fs.existsSync(storedAbs)) {
			if (fs.existsSync(originalAbs)) {
				const currentSha = sha256Bounded(originalAbs);
				if (currentSha === entry.sha256) {
					items.push({ relPath: originalRel, status: 'already-restored' });
					continue;
				}
				items.push({ relPath: originalRel, status: 'collision' });
				allResolved = false;
				continue;
			}
			items.push({ relPath: originalRel, status: 'missing-copy' });

			allResolved = false;
			continue;
		}
		if (fs.existsSync(originalAbs)) {
			const currentSha = sha256Bounded(originalAbs);
			if (currentSha === entry.sha256) {
				try {
					_internals.unlinkResidueCopy(storedAbs); // identical content already restored
					items.push({ relPath: originalRel, status: 'already-restored' });
				} catch (err) {
					const code = (err as NodeJS.ErrnoException).code ?? 'unknown';
					items.push({
						relPath: originalRel,
						status: 'unresolved',
						reasons: [`stored-copy-retained:${code}`],
					});
					allResolved = false;
				}
			} else {
				items.push({ relPath: originalRel, status: 'collision' });
				allResolved = false;
			}

			continue;
		}
		try {
			_internals.mkdirResidueParent(path.dirname(originalAbs));
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code ?? 'unknown';
			items.push({
				relPath: originalRel,
				status: 'unresolved',
				reasons: [`restore-path-failed:${code}`],
			});
			allResolved = false;
			continue;
		}
		// Prefer a no-replace hard link. Filesystems without hard-link support
		// use the same exclusive-copy fallback as compensation below.
		try {
			_internals.linkResidueCopy(storedAbs, originalAbs);
		} catch (linkErr) {
			const code = (linkErr as NodeJS.ErrnoException).code ?? 'unknown';
			if (code === 'EEXIST') {
				items.push({ relPath: originalRel, status: 'collision' });
				allResolved = false;
				continue;
			}
			const fallback = publishStoredCopyExclusively(storedAbs, originalAbs);
			if (fallback.status === 'collision') {
				items.push({ relPath: originalRel, status: 'collision' });
				allResolved = false;
				continue;
			}
			if (fallback.status === 'failed') {
				if (fs.existsSync(originalAbs)) {
					items.push({ relPath: originalRel, status: 'collision' });
				} else {
					items.push({
						relPath: originalRel,
						status: 'unresolved',
						reasons: [
							`restore-publish-failed:${fallback.code ?? 'unknown'}:payload-remains-in-quarantine`,
						],
					});
				}
				allResolved = false;
				continue;
			}
		}
		try {
			_internals.unlinkResidueCopy(storedAbs);
			items.push({ relPath: originalRel, status: 'restored' });
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code ?? 'unknown';
			items.push({
				relPath: originalRel,
				status: 'unresolved',
				reasons: [`stored-copy-retained:${code}`],
			});
			allResolved = false;
		}
	}
	if (allResolved) {
		// Foreign content or a sibling recovery surface blocks deletion; the
		// owned marker distinguishes this safely drained directory from an
		// unresolved batch on the next call.
		let batchDirRetained = false;
		let batchDirCleanupFailed = false;
		let batchDirRetentionReason: RollbackResult['batchDirRetentionReason'];
		let drainedMarkerWriteFailed = false;
		let drainedMarkerWritten = false;
		let batchExists = false;
		let batchStatError: string | undefined;
		try {
			_internals.statQuarantineBatch(batchAbs);
			batchExists = true;
			batchDirRetained = true;
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code ?? 'unknown';
			if (code !== 'ENOENT') batchStatError = code;
		}

		if (!batchExists && batchStatError === undefined) {
			// Cleanup removed the directory: a missing batch needs no marker.
			return {
				batchRelDir: path.posix.join('quarantine', selected),
				items,
				drained: true,
				batchDirRetained: false,
				skippedBatches: [...skippedBatches].filter(
					(b) => !unsupportedByBatch.has(b),
				),
				unsupportedBatches: [...unsupportedByBatch.entries()].map(
					([unsupportedBatch, version]) => ({
						batchId: unsupportedBatch,
						version,
					}),
				),
			};
		}

		if (batchStatError !== undefined) {
			items.push({
				relPath: path.posix.join('quarantine', selected),
				status: 'unresolved',
				reasons: [`restore-batch-stat-failed:${batchStatError}`],
			});
			allResolved = false;
		} else if (batchExists) {
			try {
				_internals.writeRollbackMarker(
					batchAbs,
					ROLLBACK_DRAINED_MARKER,
					`${JSON.stringify({ at: new Date().toISOString(), batchId: selected })}\n`,
				);
				drainedMarkerWritten = true;
				const classification = classifyBatchDirectory(batchAbs);
				if (classification === 'foreign-content') {
					batchDirRetentionReason = 'foreign-content';
				} else if (classification === 'unknown') {
					batchDirRetentionReason = 'metadata-scan-failed';
				} else if (
					fs.existsSync(parentSiblingRecoveryPath(swarmRoot, selected))
				) {
					batchDirRetentionReason = 'sibling-recovery-present';
				} else {
					try {
						_internals.removeDrainedBatch(batchAbs);
					} catch {
						batchDirCleanupFailed = true;
						batchDirRetentionReason = 'owned-metadata-retained';
					}
				}
			} catch {
				// Any marker failure, including ENOENT after stat, is a failed drain.
				drainedMarkerWriteFailed = true;
				allResolved = false;
			}
		}

		if (drainedMarkerWritten) {
			try {
				fs.rmSync(parentSiblingRecoveryPath(swarmRoot, selected), {
					force: true,
				});
			} catch {
				/* best-effort */
			}
		}
		if (!allResolved && batchId === undefined) {
			try {
				fs.writeFileSync(
					path.join(batchAbs, ROLLBACK_ATTEMPTED_MARKER),
					`${JSON.stringify({ at: new Date().toISOString(), batchId: selected, unresolved: items.filter((i) => i.status === 'collision' || i.status === 'skipped' || i.status === 'unresolved' || i.status === 'missing-copy').length })}\n`,
					'utf-8',
				);
			} catch {
				/* best-effort default-selection advancement */
			}
		}

		batchDirRetained = batchDirCleanupFailed || fs.existsSync(batchAbs);
		return {
			batchRelDir: path.posix.join('quarantine', selected),
			items,
			drained: allResolved,
			batchDirRetained,
			...(batchDirCleanupFailed ? { batchDirCleanupFailed: true } : {}),
			...(batchDirRetentionReason ? { batchDirRetentionReason } : {}),
			drainedMarkerWriteFailed,
			skippedBatches: [...skippedBatches].filter(
				(b) => !unsupportedByBatch.has(b),
			),
			unsupportedBatches: [...unsupportedByBatch.entries()].map(
				([unsupportedBatch, version]) => ({
					batchId: unsupportedBatch,
					version,
				}),
			),
		};
	} else if (batchId === undefined) {
		// Default-path advancement marker (#3951): record unresolved attempts,
		// including failed drained-marker writes, so the next default selection
		// can reach an older supported batch. Explicit selection ignores it.

		try {
			fs.writeFileSync(
				path.join(batchAbs, ROLLBACK_ATTEMPTED_MARKER),
				`${JSON.stringify({ at: new Date().toISOString(), batchId: selected, unresolved: items.filter((i) => i.status === 'collision' || i.status === 'skipped' || i.status === 'unresolved' || i.status === 'missing-copy').length })}\n`,

				'utf-8',
			);
		} catch {
			/* best-effort advancement bookkeeping */
		}
	}
	return {
		batchRelDir: path.posix.join('quarantine', selected),
		items,
		drained: allResolved,
		skippedBatches: [...skippedBatches].filter(
			(b) => !unsupportedByBatch.has(b),
		),
		unsupportedBatches: [...unsupportedByBatch.entries()].map(
			([unsupportedBatch, version]) => ({ batchId: unsupportedBatch, version }),
		),
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared formatter (close dry-run + doctor render the SAME lines)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The ONE neutralizer for residue-derived names/relPaths interpolated into
 * any render sink (issue #3836 D3): strips every Unicode Cc control char
 * (C0 + DEL + C1 — issue #3542: injected rows and terminal-polluting escape
 * sequences, the class PR #3533 fixed in doctor-store-integrity's safeName)
 * and neutralizes backticks (markdown code-span breakout) the same way
 * src/commands/doctor.ts sanitizes untrusted strings. Every mutation-path
 * surface that interpolates `relPath`/readdir names routes through this.
 */
export function neutralizeResidueName(name: string): string {
	return name.replace(/[\p{Cc}]/gu, '').replace(/`/g, "'");
}

function formatAge(ms: number): string {
	if (ms <= 0) return '0s';
	const minutes = Math.floor(ms / 60_000);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return `${hours}h`;
	return `${Math.floor(hours / 24)}d`;
}

/** Bounded human rendering of an inventory (≤ maxEntries detail lines). */
export function formatResidueInventoryLines(
	inv: ResidueInventory,
	options?: { maxEntries?: number },
): string[] {
	const maxEntries = options?.maxEntries ?? 10;
	const s = inv.summary;
	const lines: string[] = [];
	lines.push(
		`- Matched registered temp grammars: ${s.matched} file(s), ${s.totalBytes} byte(s), oldest ${formatAge(s.oldestAgeMs)} old`,
	);
	lines.push(
		`- Eligible for quarantine (stale ≥ ${Math.round(RESIDUE_STALE_AGE_MS / 60_000)}m, untracked, unlocked, non-symlink): ${s.eligible}; preserved/ambiguous: ${s.ambiguous}${inv.gitState === 'unknown' ? ' (git tracked-state unknown — nothing quarantined)' : ''}`,
	);
	const byGrammar = new Map<string, { count: number; bytes: number }>();
	for (const e of inv.entries) {
		const g = byGrammar.get(e.grammarId) ?? { count: 0, bytes: 0 };
		g.count++;
		g.bytes += e.bytes;
		byGrammar.set(e.grammarId, g);
	}
	for (const [id, g] of [...byGrammar.entries()].sort(
		(a, b) => b[1].count - a[1].count,
	)) {
		lines.push(`  - ${id}: ${g.count} file(s), ${g.bytes} byte(s)`);
	}
	for (const e of inv.entries.slice(0, maxEntries)) {
		const flags = [
			`${formatAge(e.ageMs)} old`,
			e.tracked === 'tracked' ? 'git-tracked' : e.tracked,
			e.isSymlink ? 'symlink' : null,
			e.lockHeld ? 'locked' : null,
			...e.reasons,
		].filter(Boolean);
		// relPath comes from readdir and may contain adversarial characters —
		// route through the shared neutralizer (issue #3542 semantics, pinned
		// byte-identical by swarm-residue-control-char-names.test.ts).
		const safeRel = neutralizeResidueName(e.relPath);
		lines.push(
			`  - \`${safeRel}\` [${e.grammarId}] → ${e.proposedAction === 'quarantine' ? 'would quarantine' : 'preserve'} (${flags.join(', ')})`,
		);
	}
	if (inv.entries.length > maxEntries) {
		lines.push(
			`  - … ${inv.entries.length - maxEntries} more (bounded report)`,
		);
	}
	if (inv.truncated) {
		lines.push(
			`  - scan truncated at ${MAX_RESIDUE_SCAN_ENTRIES} entries — inventory is partial`,
		);
	}
	return lines;
}
