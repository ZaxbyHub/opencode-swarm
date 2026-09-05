/**
 * Single source of truth for "what absolute path do we invoke for gh" — the
 * gh twin of `resolveGitExecutable()` in `src/utils/git-executable.ts`
 * (issue #2476 AC1 / source issue #2262).
 *
 * The pre-fix resolver (`resolveGhBinaryCandidates` in
 * `src/tools/gh-evidence.ts` + `resolveExecutableFromPath`) put the bare
 * name FIRST, so a full PATH scan for `gh` beat every ProgramFiles absolute
 * candidate; accepted any stat-able regular file (a 20-byte text file named
 * gh.exe passed); and had no `gh --version` behavioral probe, no budget, and
 * no cache. That matters MORE than the git case: `gh` runs with the user's
 * GitHub token, so a hijack is credential theft in addition to code
 * execution.
 *
 * Contract (mirrors git-executable.ts; deviations called out inline):
 *
 *   1. explicit override — the `OPENCODE_SWARM_GH_BINARY` env var ONLY.
 *      There is deliberately NO config-file `gh.binary` key: the config path
 *      is the attack surface `enforceGitBinaryProvenance` exists to strip
 *      for git, and gh never had one. Env-only keeps every override
 *      user-controlled by construction.
 *   2. platform absolute candidates (win32 ProgramFiles/LOCALAPPDATA — the
 *      set `resolveGhBinaryCandidates` already knew — plus darwin/linux
 *      install locations, which the old resolver lacked entirely);
 *   3. ALL PATH matches for `gh` (win32: `.exe`/`.cmd`/`.bat` variants);
 *   4. bare `'gh'` LAST, unprobed, so a host that works via plain PATH
 *      lookup never regresses.
 *
 * Each non-bare candidate must be ABSOLUTE and is validated once with
 * `gh --version` (bounded, explicit cwd) whose output must match
 * GH_VERSION_PATTERN — exit 0 alone does not accept a candidate. NOT AN
 * ANTI-TAMPERING CONTROL (a hostile program can print `gh version 2.x`); it
 * stops ACCIDENTS — a non-gh that merely exits 0, a broken shim. The
 * trust-boundary control is that no repository-controlled value can name a
 * candidate at all (env-only override).
 *
 * Bounded probing (AGENTS.md invariant 1): per-probe timeout 250 ms, total
 * first-resolution budget 1000 ms. gh resolution is LAZY (tool/ghExec call
 * paths, never plugin init), so the sync API below is sufficient — there is
 * no init-path need for an async variant.
 *
 * NEVER throws: both non-accepting outcomes (budget exhausted, every
 * candidate rejected) return the bare `'gh'` fallback, memoized with a 60 s
 * TTL so a host that installs gh mid-session recovers (same rationale as
 * git-executable.ts — a slash-less spawn does not resolve against the PATH
 * this module enumerates, so "gh is missing" is not a state this resolver
 * may report).
 */
import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { advisoryWarn } from '../services/warning-buffer.js';

/** Env var escape hatch — a blocked user can set this without editing files. */
export const GH_BINARY_ENV_VAR = 'OPENCODE_SWARM_GH_BINARY';

const PER_PROBE_TIMEOUT_MS = 250;
const TOTAL_BUDGET_MS = 1000;
const NEGATIVE_CACHE_TTL_MS = 60_000;
const BARE_GH = 'gh';
const PROBE_MAX_BUFFER_BYTES = 64 * 1024;
const PROBE_OUTPUT_EXCERPT_CHARS = 60;

const WINDOWS_PATH_EXTENSIONS = ['.exe', '.cmd', '.bat'];

/**
 * `gh --version` prints `gh version 2.74.0 (2025-...)` — a fixed format
 * string in gh's own root command. Same accident-not-attacker contract as
 * `GIT_VERSION_PATTERN` (see git-executable.ts); anchored to the first line.
 */
export const GH_VERSION_PATTERN = /^gh version \d+\.\d+/;

function excerptProbeOutput(raw: string): string {
	return raw
		.slice(0, PROBE_OUTPUT_EXCERPT_CHARS)
		.replace(/[^\x20-\x7E]/g, ' ')
		.trim();
}

export type GhResolutionCandidateSource = 'override' | 'platform' | 'path';

export interface GhResolutionAttempt {
	source: GhResolutionCandidateSource;
	candidate: string;
	accepted: boolean;
	/** Rejection reason; absent when `accepted` is true. */
	reason?: string;
}

export interface GhResolutionDescription {
	resolved: boolean;
	resolvedPath?: string;
	attempts: GhResolutionAttempt[];
	overrideValue?: string;
}

interface CacheSuccess {
	kind: 'success';
	path: string;
}
interface CacheFallback {
	kind: 'fallback';
	expiresAt: number;
}
type CacheEntry = CacheSuccess | CacheFallback;

/** Module state — lazy, memoized on first call (AGENTS.md invariant 1).
 * Bounded: success cache holds ONE entry per process; the fallback cache
 * expires after NEGATIVE_CACHE_TTL_MS; lastAttempts is replaced wholesale
 * each probe cycle and bounded by the candidate-list length. */
let cache: CacheEntry | null = null;
let lastAttempts: GhResolutionAttempt[] = [];
let cacheGeneration = 0;

/**
 * Windows install locations, kept in one place so the legacy
 * `resolveGhBinaryCandidates` export in gh-evidence.ts can share the set.
 * Paths are built with native separators via path.join by the caller.
 */
export function windowsGhAbsoluteCandidates(env: NodeJS.ProcessEnv): string[] {
	const candidates: string[] = [];
	const push = (...parts: string[]): void => {
		const candidate = path.join(...parts);
		if (!candidates.includes(candidate)) candidates.push(candidate);
	};
	if (env.ProgramFiles) {
		push(env.ProgramFiles, 'GitHub CLI', 'gh.exe');
	}
	if (env['ProgramFiles(x86)']) {
		push(env['ProgramFiles(x86)'], 'GitHub CLI', 'gh.exe');
	}
	if (env.LOCALAPPDATA) {
		push(env.LOCALAPPDATA, 'GitHub CLI', 'gh.exe');
		push(env.LOCALAPPDATA, 'Programs', 'GitHub CLI', 'gh.exe');
	}
	return candidates;
}

function platformCandidates(
	platform: NodeJS.Platform,
	env: NodeJS.ProcessEnv,
): string[] {
	if (platform === 'win32') {
		return windowsGhAbsoluteCandidates(env);
	}
	if (platform === 'darwin') {
		return ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh'];
	}
	// linux and other POSIX platforms
	return ['/usr/bin/gh', '/usr/local/bin/gh', '/bin/gh'];
}

function isAbsoluteForPlatform(
	candidate: string,
	platform: NodeJS.Platform,
): boolean {
	return platform === 'win32'
		? path.win32.isAbsolute(candidate)
		: path.posix.isAbsolute(candidate);
}

function joinDirAndName(
	dir: string,
	name: string,
	platform: NodeJS.Platform,
): string {
	const sep = platform === 'win32' ? '\\' : '/';
	const trimmed = dir.replace(/[\\/]+$/, '');
	return trimmed ? `${trimmed}${sep}${name}` : `${sep}${name}`;
}

/** ALL PATH matches for `gh` — not just the first hit. */
function pathCandidates(platform: NodeJS.Platform): string[] {
	const pathValue = _internals.env().PATH ?? '';
	if (!pathValue) return [];
	const dirs = pathValue
		.split(platform === 'win32' ? ';' : ':')
		.filter(Boolean);
	const names =
		platform === 'win32'
			? [...WINDOWS_PATH_EXTENSIONS.map((ext) => `gh${ext}`), 'gh']
			: ['gh'];
	const out: string[] = [];
	for (const dir of dirs) {
		for (const name of names) {
			const candidate = joinDirAndName(dir, name, platform);
			if (!out.includes(candidate)) out.push(candidate);
		}
	}
	return out;
}

function envOverride(): string | undefined {
	const raw = _internals.env()[GH_BINARY_ENV_VAR];
	return raw && raw.trim() !== '' ? raw : undefined;
}

interface Candidate {
	source: GhResolutionCandidateSource;
	path: string;
}

function buildCandidates(platform: NodeJS.Platform): Candidate[] {
	const override = envOverride();
	const overrideCandidate: Candidate[] = override
		? [{ source: 'override', path: override }]
		: [];

	const seen = new Set<string>(overrideCandidate.map((c) => c.path));
	const rest: Candidate[] = [];
	for (const p of platformCandidates(platform, _internals.env())) {
		if (seen.has(p)) continue;
		seen.add(p);
		rest.push({ source: 'platform', path: p });
	}
	for (const p of pathCandidates(platform)) {
		if (seen.has(p)) continue;
		seen.add(p);
		rest.push({ source: 'path', path: p });
	}
	return [...overrideCandidate, ...rest];
}

function probeCandidate(
	candidatePath: string,
	platform: NodeJS.Platform,
): { accepted: true } | { accepted: false; reason: string } {
	if (!isAbsoluteForPlatform(candidatePath, platform)) {
		return { accepted: false, reason: 'not an absolute path' };
	}

	let stat: fs.Stats;
	try {
		stat = fs.statSync(candidatePath);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException)?.code;
		if (code === 'ENOENT') return { accepted: false, reason: 'no such file' };
		return {
			accepted: false,
			reason: `cannot stat (${code ?? 'unknown error'})`,
		};
	}
	if (stat.isDirectory()) {
		return { accepted: false, reason: 'is a directory' };
	}
	if (!stat.isFile()) {
		return { accepted: false, reason: 'not a regular file' };
	}

	let result: SpawnSyncReturns<Buffer>;
	try {
		result = _internals.spawnSync(candidatePath, ['--version'], {
			cwd: os.tmpdir(),
			stdio: ['ignore', 'pipe', 'ignore'],
			windowsHide: true,
			timeout: PER_PROBE_TIMEOUT_MS,
			maxBuffer: PROBE_MAX_BUFFER_BYTES,
		});
	} catch (err) {
		return {
			accepted: false,
			reason: `spawn threw: ${err instanceof Error ? err.message : String(err)}`,
		};
	}

	if (result.error) {
		return { accepted: false, reason: `spawn failed: ${result.error.message}` };
	}
	if (result.status !== 0) {
		const statusDescription =
			result.status !== null
				? `exit ${result.status}`
				: `signal ${result.signal ?? 'unknown'}`;
		return {
			accepted: false,
			reason: `gh --version returned ${statusDescription}`,
		};
	}

	const versionOutput = (result.stdout ?? '').toString().trim();
	if (!GH_VERSION_PATTERN.test(versionOutput)) {
		const excerpt = excerptProbeOutput(versionOutput);
		return {
			accepted: false,
			reason: excerpt
				? `not gh: --version printed "${excerpt}"`
				: 'not gh: --version printed nothing',
		};
	}
	return { accepted: true };
}

type ProbeCycleResult =
	| { outcome: 'accepted'; path: string }
	| { outcome: 'exhausted-budget' }
	| { outcome: 'all-rejected' };

function probeCycle(
	candidates: Candidate[],
	platform: NodeJS.Platform,
	attempts: GhResolutionAttempt[],
): ProbeCycleResult {
	const start = _internals.now();
	let budgetExceeded = false;

	for (const candidate of candidates) {
		if (_internals.now() - start > TOTAL_BUDGET_MS) {
			budgetExceeded = true;
			break;
		}
		const result = probeCandidate(candidate.path, platform);
		attempts.push({
			source: candidate.source,
			candidate: candidate.path,
			accepted: result.accepted,
			reason: result.accepted ? undefined : result.reason,
		});
		if (candidate.source === 'override' && !result.accepted) {
			// Parity with git-executable.ts (PRR-006): a rejected operator
			// override must not fall through silently.
			advisoryWarn(
				`[opencode-swarm] ${GH_BINARY_ENV_VAR} override "${candidate.path}" is unusable (${result.reason}); falling back to automatic gh resolution.`,
			);
		}
		if (result.accepted) {
			return { outcome: 'accepted', path: candidate.path };
		}
	}

	return budgetExceeded
		? { outcome: 'exhausted-budget' }
		: { outcome: 'all-rejected' };
}

function readCache(): CacheEntry | null {
	if (cache === null) return null;
	if (cache.kind === 'success') return cache;
	if (_internals.now() < cache.expiresAt) return cache;
	cache = null;
	return null;
}

function applyProbeResult(
	result: ProbeCycleResult,
	attempts: GhResolutionAttempt[],
	generation: number,
): string {
	if (generation !== cacheGeneration) {
		// Stale cycle (cache reset mid-probe): hand the caller what WAS
		// validated, leave cache/lastAttempts untouched — mirrors
		// git-executable.ts's abandoned-probe guard.
		return result.outcome === 'accepted' ? result.path : BARE_GH;
	}
	lastAttempts = attempts;
	if (result.outcome === 'accepted') {
		cache = { kind: 'success', path: result.path };
		return result.path;
	}
	cache = {
		kind: 'fallback',
		expiresAt: _internals.now() + NEGATIVE_CACHE_TTL_MS,
	};
	return BARE_GH;
}

/**
 * Resolve the gh executable to invoke. Lazy, memoized, bounded by
 * TOTAL_BUDGET_MS, never throws. Returns a validated absolute path or the
 * bare `'gh'` fallback.
 */
export function resolveGhExecutable(): string {
	const cached = readCache();
	if (cached) return cached.kind === 'success' ? cached.path : BARE_GH;

	const platform = _internals.platform();
	const attempts: GhResolutionAttempt[] = [];
	const generation = cacheGeneration;
	const candidates = buildCandidates(platform);

	const result = probeCycle(candidates, platform, attempts);
	return applyProbeResult(result, attempts, generation);
}

/** Exported for tests; clears the memoized cache (and bumps the generation). */
export function resetGhExecutableCache(): void {
	cache = null;
	lastAttempts = [];
	cacheGeneration++;
}

/**
 * TEST-ONLY seam — NOT a production API, do not call from `src/`. Pre-seeds
 * the resolver cache with an explicit "success" entry so
 * `resolveGhExecutable()` returns `value` with zero probe spawns. Distinct
 * from gh-evidence.ts's `__seedGhBinaryForTests` (which pins only that
 * wrapper's legacy layer): neither bypasses the other.
 */
export function __seedGhExecutableForTests(value: string): void {
	cache = { kind: 'success', path: value };
}

/** Diagnostic surface: candidates tried in the most recent probe cycle. */
export function describeGhResolution(): GhResolutionDescription {
	const cached = cache;
	return {
		resolved: cached?.kind === 'success',
		resolvedPath: cached?.kind === 'success' ? cached.path : undefined,
		attempts: [...lastAttempts],
		overrideValue: envOverride(),
	};
}

/**
 * DI seam for testability (repo convention — see git-executable.ts).
 * `platform`/`env` let tests drive every platform branch regardless of the
 * host OS; `now` makes the TTL and budget deterministically testable.
 */
export const _internals: {
	spawnSync: typeof spawnSync;
	platform: () => NodeJS.Platform;
	env: () => NodeJS.ProcessEnv;
	now: () => number;
} = {
	spawnSync,
	platform: () => process.platform,
	env: () => process.env,
	now: () => Date.now(),
};
