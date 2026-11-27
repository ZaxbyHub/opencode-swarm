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

import { createHash } from 'node:crypto';
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
	 * rollback hard-rejects any version it does not know — a FUTURE schema
	 * bump MUST ship its own reader/migration before (or with) the writer,
	 * because payloads on disk are only recoverable through a manifest the
	 * current code can parse. Deliberate design: a partial-reader migration
	 * is more dangerous than a readable "unsupported manifest shape" error
	 * naming the version. Mixed-version operation is therefore unsafe by
	 * construction across schema bumps: downgrade with v2 batches present
	 * blocks rollback of those batches until the newer plugin returns.
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

function sha256Bounded(absPath: string): string | undefined {
	try {
		return _internals.sha256File(absPath);
	} catch {
		return undefined;
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
		const storedAbs = path.join(batchAbs, ...entry.relPath.split('/'));
		try {
			fs.mkdirSync(path.dirname(storedAbs), { recursive: true });
			_internals.renameResidueEntry(abs, storedAbs);
		} catch (moveErr) {
			const code = (moveErr as NodeJS.ErrnoException)?.code ?? 'unknown';
			preserved.push({
				relPath: entry.relPath,
				status: 'preserved',
				reasons: [`move-failed:${code}`],
			});
			continue;
		}
		manifest.entries.push({
			original_rel_path: entry.relPath,
			stored_rel_path: path.posix.join('quarantine', batchId, entry.relPath),
			sha256: sha,
			bytes: entry.bytes,
			mtime_ms: entry.mtimeMs,
			grammar_id: entry.grammarId,
			reason: 'stale-atomic-write-temp',
		});
		moved.push({ relPath: entry.relPath, status: 'quarantined', reasons: [] });
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
		} catch (manifestErr) {
			const summary = compensateQuarantineBatch(swarmRoot, manifest);
			publishRecoveryManifest(swarmRoot, batchAbs, batchId, manifest, summary);
			const strandedList =
				summary.uncompensated.length > 0
					? ` Stranded entries (retained in the batch for normal rollback): ${summary.uncompensated.join(', ')}.`
					: '';
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
		// failed cleanup can never abort (or crash) the quarantine run.
		try {
			fs.rmSync(batchAbs, { recursive: true, force: true });
		} catch {
			/* best-effort removal of an empty dir */
		}
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
		| 'skipped';
	/**
	 * Present on `skipped` items only (mirrors `QuarantineOutcomeItem`).
	 * Optional — the existing restored/collision/missing-copy item shape is
	 * pinned by tests/unit/services/swarm-residue-quarantine.test.ts and must
	 * stay key-identical.
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
}

/** Manifest surface names (#3951 recovery design). */
const BATCH_MANIFEST = 'manifest.json';
const BATCH_RECOVERY_MANIFEST = 'manifest.recovery.json';
const ROLLBACK_ATTEMPTED_MARKER = 'rollback.attempted';

/** Parent-sibling recovery surface: `.swarm/quarantine/<batchId>.recovery.json`. */
function parentSiblingRecoveryPath(swarmRoot: string, batchId: string): string {
	return path.join(swarmRoot, 'quarantine', `${batchId}.recovery.json`);
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
		try {
			storedExists = fs.lstatSync(storedAbs).isFile();
		} catch {
			storedExists = false;
		}
		let originalExists = false;
		try {
			originalExists = fs.lstatSync(originalAbs).isFile();
		} catch {
			originalExists = false;
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
					fs.unlinkSync(storedAbs);
					restored.push(entry.original_rel_path);
				} catch {
					uncompensated.push(entry.original_rel_path);
				}
			} else {
				collisions.push(entry.original_rel_path); // never overwrite
			}
			continue;
		}
		try {
			fs.mkdirSync(path.dirname(originalAbs), { recursive: true });
			// Shared rename seam (raw-rename ratchet #2969): also the injection
			// point for reverse-move-failure tests of this compensation.
			_internals.renameResidueEntry(storedAbs, originalAbs);
			restored.push(entry.original_rel_path);
		} catch {
			uncompensated.push(entry.original_rel_path);
		}
	}
	return { restored, uncompensated, collisions };
}

/**
 * #3951 AC5 — publish the in-memory manifest on the recovery surfaces when
 * compensation leaves anything in the batch (uncompensated or collision-kept),
 * so normal rollback can restore/report it. Two surfaces, tried in order:
 * in-batch `manifest.recovery.json`, then the parent-sibling (the primary
 * failure mode — an unwritable/blocking name INSIDE the batch dir — cannot
 * also block the parent). Best-effort: a failure on both surfaces leaves the
 * batch dir as-is; the rethrown quarantine error names the batch and entries.
 * When NOTHING remains in the batch, remove the (now payload-free) batch dir
 * best-effort instead — never a recursive delete with payload present.
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
): void {
	const remaining = summary.uncompensated.length + summary.collisions.length;
	const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
	if (remaining === 0) {
		try {
			fs.rmSync(batchAbs, { recursive: true, force: true });
		} catch {
			/* best-effort removal of the now payload-free batch dir */
		}
		return;
	}
	try {
		atomicWriteSwarmFileSync(
			path.join(batchAbs, BATCH_RECOVERY_MANIFEST),
			serialized,
		);
		return;
	} catch {
		/* fall through to the parent-sibling surface */
	}
	try {
		atomicWriteSwarmFileSync(
			parentSiblingRecoveryPath(swarmRoot, batchId),
			serialized,
		);
	} catch {
		/* both recovery surfaces failed — the rethrown error names the batch */
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
	const skippedBatches: string[] = [];
	const readManifest = (b: string): QuarantineManifest | null => {
		const batchDir = path.join(swarmRoot, 'quarantine', b);
		const surfaces = [
			path.join(batchDir, BATCH_MANIFEST),
			path.join(batchDir, BATCH_RECOVERY_MANIFEST),
			parentSiblingRecoveryPath(swarmRoot, b),
		];
		for (const surface of surfaces) {
			try {
				const parsed = JSON.parse(
					fs.readFileSync(surface, 'utf-8'),
				) as QuarantineManifest;
				if (parsed.schema_version !== 1 || !Array.isArray(parsed.entries)) {
					throw new Error(`Quarantine manifest has an unsupported shape: ${b}`);
				}
				return parsed;
			} catch {
				// try the next surface
			}
		}
		skippedBatches.push(b);
		return null;
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
	let selected: string;
	if (batchId) {
		selected =
			batches.find((b) => b === batchId || b.endsWith(`-${batchId}`)) ??
			(() => {
				throw new Error(`Quarantine batch not found: ${batchId}`);
			})();
	} else {
		// Collision-aware default advancement (#3951, plan v4 option (a)):
		// prefer the newest readable batch WITHOUT an attempt marker so a
		// collision-kept newest batch cannot starve older valid batches;
		// when every readable batch is marked, fall back to the newest
		// readable (today's behavior — a visible report, never a no-op).
		const readable = batches
			.slice()
			.reverse()
			.filter((b) => readManifest(b) !== null);
		if (readable.length === 0) {
			throw new Error(
				`Quarantine batch has no readable manifest surface (manifest.json, ${BATCH_RECOVERY_MANIFEST}, <batchId>.recovery.json): ${batches.join(', ')}`,
			);
		}
		selected = readable.find((b) => !hasAttemptMarker(b)) ?? readable[0]!;
		// readManifest above pushed skipped entries for non-readable batches;
		// reset so only the FINAL skipped set (recomputed below for accuracy)
		// is reported when the selected batch also fails late.
		skippedBatches.length = 0;
		for (const b of batches) {
			if (b !== selected) readManifest(b);
		}
	}
	const batchAbs = path.join(swarmRoot, 'quarantine', selected);
	const manifest = readManifest(selected);
	if (manifest === null) {
		throw new Error(
			`Quarantine batch has no readable manifest surface (manifest.json, ${BATCH_RECOVERY_MANIFEST}, <batchId>.recovery.json): ${selected}`,
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
			items.push({ relPath: originalRel, status: 'missing-copy' });
			allResolved = false;
			continue;
		}
		if (fs.existsSync(originalAbs)) {
			const currentSha = sha256Bounded(originalAbs);
			if (currentSha === entry.sha256) {
				fs.unlinkSync(storedAbs); // identical content already restored
				items.push({ relPath: originalRel, status: 'already-restored' });
			} else {
				items.push({ relPath: originalRel, status: 'collision' }); // never overwrite
				allResolved = false;
			}
			continue;
		}
		fs.mkdirSync(path.dirname(originalAbs), { recursive: true });
		fs.renameSync(storedAbs, originalAbs);
		items.push({ relPath: originalRel, status: 'restored' });
	}
	if (allResolved) {
		try {
			fs.rmSync(batchAbs, { recursive: true, force: true });
		} catch {
			// best-effort cleanup; payloads are already restored
		}
		// The drained batch's parent-sibling recovery manifest is orphaned
		// metadata once the batch dir is gone — remove it too (#3951).
		try {
			fs.rmSync(parentSiblingRecoveryPath(swarmRoot, selected), {
				force: true,
			});
		} catch {
			/* best-effort */
		}
	} else if (batchId === undefined) {
		// Default-path advancement marker (#3951 plan v4): record that THIS
		// default attempt left the batch unresolved, so the NEXT default
		// selects a different readable batch instead of re-reporting the same
		// collision forever. Explicit batchId calls ignore the marker.
		// Marker-write failure degrades to today's re-selection behavior.
		try {
			fs.writeFileSync(
				path.join(batchAbs, ROLLBACK_ATTEMPTED_MARKER),
				`${JSON.stringify({ at: new Date().toISOString(), batchId: selected, unresolved: items.filter((i) => i.status === 'collision' || i.status === 'skipped').length })}\n`,
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
		skippedBatches,
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
