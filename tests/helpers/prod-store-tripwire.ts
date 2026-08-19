/**
 * Production-store tripwire for the opencode-swarm test suite (issue #2033).
 *
 * Problem: platform-global knowledge stores (Windows
 * `%LOCALAPPDATA%\opencode-swarm\Data\shared-learnings.jsonl` + `links/`, XDG data roots on
 * macOS/Linux) are resolved from live env vars (`src/knowledge/hive-paths.ts`,
 * `src/hooks/knowledge-link.ts`). Tests isolate by redirecting those env vars, but the
 * isolation is a per-suite convention with no enforcement — PR #1847's intermediate revision
 * wrote 12 `"Test lesson …"` fixtures into the real hive store (2026-07-14), and un-redirected
 * Windows runs created real `links/test-cohort`, `links/nocopy-cohort`, and
 * `links/linked-worktree` dirs as recently as 2026-08-14/15.
 *
 * This module captures the REAL store paths at process start (before any test redirects env)
 * and installs fail-closed filesystem guards that throw when a test attempts to read or mutate
 * anything under the real data dir. Under redirected env everything resolves to temp dirs and
 * traffic passes through untouched, so hermetic suites are unaffected.
 *
 * Loaded via `bunfig.toml [test] preload` so the capture happens with pristine env in every
 * `bun test` invocation. The fs guards use the mandatory spread-real `mock.module` pattern
 * (AGENTS.md invariant 7) and additionally wrap `globalThis.Bun.write`, which does NOT route
 * through `node:fs` under Bun (the `bunWrite` shim, `src/utils/bun-compat.ts`). The final
 * `renameSync` of `atomicWriteFile` (`src/evidence/task-file.ts`) remains covered by the
 * node:fs guards as a backstop.
 *
 * Internal file access uses function values captured at module load (never the live bindings)
 * so this module's own fingerprinting cannot trip its own guards after `mock.module` lands.
 */

import { mock } from 'bun:test';
import { createHash } from 'node:crypto';
import * as realFs from 'node:fs';
import * as realFsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveLinkBaseDir } from '../../src/hooks/knowledge-link.js';
import { resolveHiveDataDir } from '../../src/knowledge/hive-paths.js';

// Capture function values before any mock is installed (internal use only).
const {
	appendFileSync: fsAppendFileSync,
	readFileSync: fsReadFileSync,
	readdirSync: fsReaddirSync,
	realpathSync: fsRealpathSync,
	rmSync: fsRmSync,
	statSync: fsStatSync,
} = realFs;
const {
	appendFile: fspAppendFile,
	copyFile: fspCopyFile,
	open: fspOpen,
	readFile: fspReadFile,
	rename: fspRename,
	rm: fspRm,
	truncate: fspTruncate,
	unlink: fspUnlink,
	writeFile: fspWriteFile,
} = realFsp;

/** Fixed file names inside the platform data dir that belong to the production stores. */
const REAL_STORE_FILES = [
	'shared-learnings.jsonl',
	'shared-learnings-rejected.jsonl',
	'shared-knowledge-events.jsonl',
] as const;

/** Directories inside the platform data dir that belong to the production stores. */
const REAL_STORE_DIRS = ['links', 'quarantine-backups'] as const;

interface StoreFileFingerprint {
	size: number;
	mtimeMs: number;
	sha256: string | null;
}

interface TripwireState {
	dataDir: string;
	linkBaseDir: string;
	normalizedDataDir: string;
	violations: string[];
	files: Map<string, StoreFileFingerprint>;
	dirs: Map<string, string[]>;
	guardInstalled: boolean;
}

const globalKey = '__SWARM_PROD_STORE_TRIPWIRE__';

declare global {
	// eslint-disable-next-line no-var
	var __SWARM_PROD_STORE_TRIPWIRE__: TripwireState | undefined;
}

function normalizeForCompare(p: string): string {
	const resolved = path.resolve(p);
	// Case-fold on win32 AND darwin — both ship case-insensitive filesystems
	// (NTFS default; APFS default), so a case-only path variant would evade a
	// case-sensitive compare (PR review CC-m4).
	return process.platform === 'win32' || process.platform === 'darwin'
		? resolved.toLowerCase()
		: resolved;
}

/** True when the target path lies under the captured REAL platform data dir. */
export function isRealStoreTarget(target: string | URL): boolean {
	const state = globalThis[globalKey];
	if (!state) return false;
	const candidate =
		typeof target === 'string'
			? target
			: target.protocol === 'file:'
				? target.pathname
				: '';
	if (!candidate) return false;
	const normalized = normalizeForCompare(candidate);
	return (
		normalized === state.normalizedDataDir ||
		normalized.startsWith(state.normalizedDataDir + path.sep)
	);
}

function recordViolation(
	label: string,
	target: string | URL,
	mode: 'mutation' | 'read',
): never {
	const state = globalThis[globalKey];
	const message =
		`PROD-STORE TRIPWIRE: ${mode} of real platform knowledge store blocked ` +
		`(${label} → ${String(target)}). Tests must redirect platform roots (LOCALAPPDATA/` +
		`XDG_DATA_HOME/HOME) via createIsolatedTestEnv() or explicit env redirection — ` +
		`issue #2033.`;
	if (state) state.violations.push(message);
	throw new Error(message);
}

function checkTarget(
	label: string,
	target: string | URL | undefined,
	mode: 'mutation' | 'read',
): void {
	if (target !== undefined && isRealStoreTarget(target)) {
		recordViolation(label, target, mode);
	}
}

function pathArg(v: unknown): string | URL | undefined {
	return typeof v === 'string' || v instanceof URL ? v : undefined;
}

const TRIPWIRE_MARKER = '__swarmTripwireGuarded';

function markGuarded(fn: unknown): void {
	try {
		(fn as { __swarmTripwireGuarded?: boolean }).__swarmTripwireGuarded = true;
	} catch {
		/* non-extensible function — marker best-effort */
	}
}

/** Wrap a sync/callback fs function so real-store targets throw before the call. */
function guardSync<A extends unknown[]>(
	fn: (...args: A) => unknown,
	label: string,
	mode: 'mutation' | 'read',
	pickPath: (args: A) => string | URL | undefined,
): (...args: A) => unknown {
	const wrapped = (...args: A) => {
		checkTarget(label, pickPath(args), mode);
		return fn(...args);
	};
	markGuarded(wrapped);
	return wrapped;
}

/** open-style variant: the mode (mutation vs read) derives from the flags argument. */
function guardOpen<A extends unknown[]>(
	fn: (...args: A) => unknown,
	label: string,
	pickPath: (args: A) => string | URL | undefined,
): (...args: A) => unknown {
	const wrapped = (...args: A) => {
		checkTarget(label, pickPath(args), openMode(args[1]));
		return fn(...args);
	};
	markGuarded(wrapped);
	return wrapped;
}

/** Wrap a promise fs function so real-store targets throw before the call. */
function guardPromise<A extends unknown[]>(
	fn: (...args: A) => Promise<unknown>,
	label: string,
	mode: 'mutation' | 'read',
	pickPath: (args: A) => string | URL | undefined,
): (...args: A) => Promise<unknown> {
	const wrapped = async (...args: A) => {
		checkTarget(label, pickPath(args), mode);
		return fn(...args);
	};
	markGuarded(wrapped);
	return wrapped;
}

/** open-style flags → violation mode (write-ish flags count as mutations). */
function openMode(flags: unknown): 'mutation' | 'read' {
	if (typeof flags !== 'string' || flags.length === 0) return 'mutation';
	return /[wa+]/.test(flags) ? 'mutation' : 'read';
}

function fingerprintFile(absPath: string): StoreFileFingerprint {
	try {
		const st = fsStatSync(absPath);
		let sha256: string | null = null;
		try {
			sha256 = createHash('sha256')
				.update(fsReadFileSync(absPath))
				.digest('hex');
		} catch {
			sha256 = null;
		}
		return { size: st.size, mtimeMs: st.mtimeMs, sha256 };
	} catch {
		return { size: -1, mtimeMs: -1, sha256: null };
	}
}

function listDirEntries(absPath: string): string[] {
	try {
		return fsReaddirSync(absPath).sort();
	} catch {
		return [];
	}
}

/**
 * Capture the real store paths + fingerprints and install the fs guards. Called from the
 * bunfig test preload with pristine env; idempotent so suites may also import it safely.
 */
export function installProdStoreTripwire(): void {
	if (globalThis[globalKey]) return;

	const dataDir = resolveHiveDataDir();
	const linkBaseDir = resolveLinkBaseDir();

	const files = new Map<string, StoreFileFingerprint>();
	for (const name of REAL_STORE_FILES) {
		files.set(name, fingerprintFile(path.join(dataDir, name)));
	}
	const dirs = new Map<string, string[]>();
	for (const name of REAL_STORE_DIRS) {
		dirs.set(name, listDirEntries(path.join(dataDir, name)));
	}
	// Top-level listing of the data dir itself (defense in depth): catches a stray
	// file/dir created directly under Data/ under a name outside the fixed sets. The
	// fs guards throw at write time; this closes the residual afterAll blind spot.
	dirs.set('.', listDirEntries(dataDir));

	globalThis[globalKey] = {
		dataDir,
		linkBaseDir,
		normalizedDataDir: normalizeForCompare(dataDir),
		violations: [],
		files,
		dirs,
		guardInstalled: false,
	};

	installFsGuards();
}

/**
 * Probe whether the tripwire's node:fs guards are currently installed: the live module's
 * appendFileSync carries the tripwire marker. A foreign suite's own mock.module('node:fs')
 * does NOT count as armed — and must never be clobbered by a re-arm.
 */
export async function probeTripwireGuardsArmed(): Promise<boolean> {
	const state = globalThis[globalKey];
	if (!state) return false;
	// Dynamic import reads the ESM registry (where mock.module installs); createRequire
	// would return the pristine CJS view and never observe the guards.
	const live = (await import('node:fs')) as {
		appendFileSync?: { __swarmTripwireGuarded?: boolean };
	};
	return live.appendFileSync?.__swarmTripwireGuarded === true;
}

/** True when the live node:fs is the PRISTINE real module (guards were stripped). */
async function liveIsPristineFs(): Promise<boolean> {
	const live = (await import('node:fs')) as { appendFileSync?: unknown };
	return live.appendFileSync === realFs.appendFileSync;
}

/**
 * Re-install the fs guards ONLY when the live module is the pristine real fs — i.e.
 * someone stripped our mock (mock.restore semantics changing, registry reset). If
 * another suite installed its OWN node:fs mock, that mock is intentional and is left
 * in place (its own cleanup convention governs it). Idempotent.
 */
export async function ensureTripwireGuardsArmed(): Promise<void> {
	const state = globalThis[globalKey];
	if (!state) return;
	if (await probeTripwireGuardsArmed()) return;
	if (!(await liveIsPristineFs())) return;
	state.guardInstalled = false;
	installFsGuards();
}

function installFsGuards(): void {
	const state = globalThis[globalKey];
	if (!state || state.guardInstalled) return;
	state.guardInstalled = true;

	// node:fs — spread-real is mandatory (scripts/check-mock-cleanup.sh Check 2); only the
	// guarded functions are overridden. Callback-style functions use the sync wrapper (a
	// synchronous throw before the call is correct for both forms).
	mock.module('node:fs', () => {
		const wrapped: Record<string, unknown> = { ...realFs };
		wrapped.appendFileSync = guardSync(
			realFs.appendFileSync,
			'fs.appendFileSync',
			'mutation',
			(a) => pathArg(a[0]),
		);
		wrapped.writeFileSync = guardSync(
			realFs.writeFileSync,
			'fs.writeFileSync',
			'mutation',
			(a) => pathArg(a[0]),
		);
		wrapped.renameSync = guardSync(
			realFs.renameSync,
			'fs.renameSync',
			'mutation',
			(a) => pathArg(a[1]),
		);
		wrapped.rmSync = guardSync(realFs.rmSync, 'fs.rmSync', 'mutation', (a) =>
			pathArg(a[0]),
		);
		wrapped.unlinkSync = guardSync(
			realFs.unlinkSync,
			'fs.unlinkSync',
			'mutation',
			(a) => pathArg(a[0]),
		);
		wrapped.truncateSync = guardSync(
			realFs.truncateSync,
			'fs.truncateSync',
			'mutation',
			(a) => pathArg(a[0]),
		);
		wrapped.copyFileSync = guardSync(
			realFs.copyFileSync,
			'fs.copyFileSync',
			'mutation',
			(a) => pathArg(a[1]),
		);
		wrapped.appendFile = guardSync(
			realFs.appendFile,
			'fs.appendFile',
			'mutation',
			(a) => pathArg(a[0]),
		);
		wrapped.writeFile = guardSync(
			realFs.writeFile,
			'fs.writeFile',
			'mutation',
			(a) => pathArg(a[0]),
		);
		wrapped.rename = guardSync(realFs.rename, 'fs.rename', 'mutation', (a) =>
			pathArg(a[1]),
		);
		wrapped.rm = guardSync(realFs.rm, 'fs.rm', 'mutation', (a) =>
			pathArg(a[0]),
		);
		wrapped.unlink = guardSync(realFs.unlink, 'fs.unlink', 'mutation', (a) =>
			pathArg(a[0]),
		);
		wrapped.truncate = guardSync(
			realFs.truncate,
			'fs.truncate',
			'mutation',
			(a) => pathArg(a[0]),
		);
		wrapped.copyFile = guardSync(
			realFs.copyFile,
			'fs.copyFile',
			'mutation',
			(a) => pathArg(a[1]),
		);
		wrapped.openSync = guardOpen(realFs.openSync, 'fs.openSync', (a) =>
			pathArg(a[0]),
		);
		wrapped.open = guardOpen(realFs.open, 'fs.open', (a) => pathArg(a[0]));
		wrapped.readFileSync = guardSync(
			realFs.readFileSync,
			'fs.readFileSync',
			'read',
			(a) => pathArg(a[0]),
		);
		wrapped.readFile = guardSync(realFs.readFile, 'fs.readFile', 'read', (a) =>
			pathArg(a[0]),
		);
		return wrapped;
	});

	// node:fs/promises — promise surface.
	mock.module('node:fs/promises', () => {
		const wrapped: Record<string, unknown> = { ...realFsp };
		wrapped.appendFile = guardPromise(
			fspAppendFile,
			'fs/promises.appendFile',
			'mutation',
			(a) => pathArg(a[0]),
		);
		wrapped.writeFile = guardPromise(
			fspWriteFile,
			'fs/promises.writeFile',
			'mutation',
			(a) => pathArg(a[0]),
		);
		wrapped.rename = guardPromise(
			fspRename,
			'fs/promises.rename',
			'mutation',
			(a) => pathArg(a[1]),
		);
		wrapped.rm = guardPromise(fspRm, 'fs/promises.rm', 'mutation', (a) =>
			pathArg(a[0]),
		);
		wrapped.unlink = guardPromise(
			fspUnlink,
			'fs/promises.unlink',
			'mutation',
			(a) => pathArg(a[0]),
		);
		wrapped.truncate = guardPromise(
			fspTruncate,
			'fs/promises.truncate',
			'mutation',
			(a) => pathArg(a[0]),
		);
		wrapped.copyFile = guardPromise(
			fspCopyFile,
			'fs/promises.copyFile',
			'mutation',
			(a) => pathArg(a[1]),
		);
		wrapped.readFile = guardPromise(
			fspReadFile,
			'fs/promises.readFile',
			'read',
			(a) => pathArg(a[0]),
		);
		wrapped.open = guardOpen(fspOpen, 'fs/promises.open', (a) => pathArg(a[0]));
		return wrapped;
	});

	// Bun.write bypasses node:fs under Bun (src/utils/bun-compat.ts bunWrite). Wrap it so
	// even the temp-file creation step of an atomic write to the real dir cannot land.
	// Bun.write is writable-but-non-configurable, so plain assignment is the supported
	// mutation; defineProperty would silently fail.
	const bunGlobal = globalThis.Bun as
		| { write?: (p: string | URL | number, d: unknown) => Promise<number> }
		| undefined;
	if (bunGlobal?.write) {
		const realWrite = bunGlobal.write.bind(bunGlobal);
		const guardedWrite = (
			p: string | URL | number,
			d: unknown,
		): Promise<number> => {
			const target = typeof p === 'string' || p instanceof URL ? p : undefined;
			checkTarget('Bun.write', target, 'mutation');
			return realWrite(p, d);
		};
		try {
			bunGlobal.write = guardedWrite;
		} catch {
			/* assignment refused — the renameSync backstop still covers atomic writes */
		}
	}
}

/** Captured real store roots (from process start). */
export function getRealStorePaths(): { dataDir: string; linkBaseDir: string } {
	const state = globalThis[globalKey];
	if (!state)
		throw new Error(
			'prod-store tripwire not installed (bunfig preload missing?)',
		);
	return { dataDir: state.dataDir, linkBaseDir: state.linkBaseDir };
}

/** Throws listing any recorded violations (belt-and-braces for afterAll checks). */
export function assertNoTripwireViolations(): void {
	const state = globalThis[globalKey];
	if (!state) return;
	if (state.violations.length > 0) {
		throw new Error(
			`PROD-STORE TRIPWIRE violations recorded:\n${state.violations.join('\n')}`,
		);
	}
}

/**
 * Clear recorded violations. Intended ONLY for the tripwire's own regression suite, whose
 * probes intentionally trip the guards: without this, those expected violations would leak
 * into later test files' afterAll `assertNoTripwireViolations()` checks (Bun runs all test
 * files in one process). Production suites must never call this.
 */
export function clearTripwireViolations(): void {
	const state = globalThis[globalKey];
	if (!state) return;
	state.violations.length = 0;
}

/**
 * Verify the real production stores are byte-identical to process start. Throws with a
 * per-file drift report. Called from afterAll in store-touching suites.
 */
export function verifyRealStoresUnchanged(): void {
	const state = globalThis[globalKey];
	if (!state) return;
	// A stripped guard would let a later mutation slip through undetected by the fs
	// layer — re-arm first (only when the live module is pristine) so this
	// verification is a true bookend. Fire-and-forget: the fingerprint comparison
	// below is the authoritative bookend; the awaited global afterEach owns re-arming.
	void ensureTripwireGuardsArmed();
	const problems: string[] = [];
	for (const name of REAL_STORE_FILES) {
		const before = state.files.get(name);
		const after = fingerprintFile(path.join(state.dataDir, name));
		if (before && after.sha256 !== null && before.sha256 !== null) {
			if (before.sha256 !== after.sha256) {
				problems.push(`${name}: content hash changed`);
			}
		} else if (
			before &&
			(before.size !== after.size || before.mtimeMs !== after.mtimeMs)
		) {
			problems.push(`${name}: size/mtime changed`);
		}
	}
	for (const name of REAL_STORE_DIRS) {
		const before = state.dirs.get(name) ?? [];
		const after = listDirEntries(path.join(state.dataDir, name));
		if (before.join('\n') !== after.join('\n')) {
			problems.push(`${name}: directory listing changed`);
		}
	}
	{
		const before = state.dirs.get('.') ?? [];
		const after = listDirEntries(state.dataDir);
		if (before.join('\n') !== after.join('\n')) {
			problems.push('data-dir top-level listing changed');
		}
	}
	if (problems.length > 0) {
		throw new Error(
			`PROD-STORE TRIPWIRE: real store drift detected:\n${problems.join('\n')}`,
		);
	}
}

/** Test helper: a realpath'd temp dir guaranteed outside the real data dir (AGENTS.md). */
export function createTripwireSafeDir(prefix: string): {
	dir: string;
	cleanup: () => void;
} {
	const dir = fsRealpathSync(
		realFs.mkdtempSync(path.join(os.tmpdir(), prefix)),
	);
	return {
		dir,
		cleanup: () => {
			try {
				fsRmSync(dir, {
					recursive: true,
					force: true,
					maxRetries: 5,
					retryDelay: 100,
				});
			} catch {
				/* best effort */
			}
		},
	};
}
