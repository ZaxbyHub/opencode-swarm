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
	queryTracked: (
		projectRoot: string,
		swarmRoot: string,
	): { tracked: Set<string> | undefined } => {
		// ONE bounded git call per scan: array-form, explicit cwd, stdin
		// ignored, 5s timeout. Failure (not a repo / git unavailable / not a
		// worktree-recognized path) maps to `undefined` = unknown = fail-closed.
		const result = bunSpawnSync(
			['git', 'ls-files', '--', swarmRoot.split(path.sep).join('/')],
			{ cwd: projectRoot, stdin: 'ignore', timeout: 5_000 },
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

function validateRelPath(rel: string, what: string): string {
	if (
		!rel ||
		path.isAbsolute(rel) ||
		// biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally matching control chars to reject them (doctor.ts precedent)
		rel.split('/').some((s) => s === '..' || s === '' || /[\0-\x1f]/.test(s))
	) {
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
		const storedAbs = path.join(batchAbs, ...entry.relPath.split('/'));
		fs.mkdirSync(path.dirname(storedAbs), { recursive: true });
		fs.renameSync(abs, storedAbs);
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
		atomicWriteSwarmFileSync(
			path.join(batchAbs, 'manifest.json'),
			`${JSON.stringify(manifest, null, 2)}\n`,
		);
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
	status: 'restored' | 'already-restored' | 'collision' | 'missing-copy';
}

export interface RollbackResult {
	batchRelDir: string;
	items: readonly RollbackOutcomeItem[];
	/** True when every manifest entry resolved and the batch dir was removed. */
	drained: boolean;
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
	const selected = batchId
		? (batches.find((b) => b === batchId || b.endsWith(`-${batchId}`)) ??
			(() => {
				throw new Error(`Quarantine batch not found: ${batchId}`);
			})())
		: batches[batches.length - 1]!;
	const batchAbs = path.join(swarmRoot, 'quarantine', selected);
	const manifestPath = path.join(batchAbs, 'manifest.json');
	let manifest: QuarantineManifest;
	try {
		manifest = JSON.parse(
			fs.readFileSync(manifestPath, 'utf-8'),
		) as QuarantineManifest;
	} catch {
		throw new Error(
			`Quarantine batch has no readable manifest.json: ${selected}`,
		);
	}
	if (manifest.schema_version !== 1 || !Array.isArray(manifest.entries)) {
		throw new Error(
			`Quarantine manifest has an unsupported shape: ${selected}`,
		);
	}
	const items: RollbackOutcomeItem[] = [];
	let allResolved = true;
	for (const entry of manifest.entries) {
		const originalRel = validateRelPath(
			entry.original_rel_path,
			'original_rel_path',
		);
		const storedRel = validateRelPath(entry.stored_rel_path, 'stored_rel_path');
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
	}
	return {
		batchRelDir: path.posix.join('quarantine', selected),
		items,
		drained: allResolved,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared formatter (close dry-run + doctor render the SAME lines)
// ─────────────────────────────────────────────────────────────────────────────

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
		// neutralize backticks (markdown code-span breakout) the same way
		// src/commands/doctor.ts sanitizes untrusted strings.
		const safeRel = e.relPath.replace(/`/g, "'");
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
