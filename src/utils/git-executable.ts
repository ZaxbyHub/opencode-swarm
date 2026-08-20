/**
 * Single source of truth for "what absolute path do we invoke for git."
 *
 * Issue #2236 hardening (F1/F4/F5) — this module is NOT the fix for #2236
 * (that was a stale worktree `cwd`, fixed elsewhere). It closes a real
 * latent defect class the issue also asked for: `gitExec()`-style call
 * sites spawn the slash-less name `git` while passing an explicit `env`
 * object, and on POSIX there is no absolute-path candidate that would make
 * PATH resolution unnecessary. See
 * `.agents/issue-traces/2236-gitexec-enoent-posix-spawn/07-approved-plan.md`
 * sections F1, F4, F5.
 *
 * Candidate order (built as ONE list and probed in a single pass — do NOT
 * rely on a first-match-only PATH scan to order anything; on a darwin host
 * with `PATH=/usr/bin:/bin` that would return the xcode-select
 * `/usr/bin/git` shim before the homebrew candidates that exist precisely
 * to avoid it):
 *
 *   1. explicit override — `OPENCODE_SWARM_GIT_BINARY` env var, else the
 *      value registered via `setGitBinaryOverride` (config `git.binary`);
 *   2. platform absolute candidates (darwin/linux/win32 — see
 *      `platformCandidates`);
 *   3. ALL PATH matches for `git` (every PATH entry is scanned, not just
 *      the first hit);
 *   4. bare `'git'` LAST, as an unprobed terminal fallback so a host that
 *      works today via plain PATH resolution does not regress.
 *
 * Each non-bare candidate is validated once with `git --version` (bounded
 * timeout, explicit cwd) before being accepted — this rejects a macOS
 * `/usr/bin/git` xcode-select shim that exists on disk but fails with
 * `xcrun: error: invalid active developer path`, and it compensates for
 * `isExecutableFile`'s missing `X_OK` check
 * (`src/utils/external-tool-runner.ts`).
 *
 * Bounded probing (AGENTS.md invariant 1 — plugin init is fast and
 * side-effect-minimal): per-probe timeout 250ms, total first-resolution
 * budget 1000ms. When the budget is exhausted before every candidate has
 * been tried, the remaining candidates are skipped and today's bare `'git'`
 * behavior is returned rather than declared a failure — we genuinely do not
 * know whether an untried candidate would have worked. Only when EVERY
 * candidate has been definitively probed and rejected do we throw
 * `GitBinaryMissingError` (F5) — at that point a bare `'git'` spawn would
 * hit the exact same PATH entries and fail identically, so throwing an
 * actionable error is not a regression.
 *
 * Caching: a successful resolution is memoized for the process lifetime. A
 * failure (either "budget exhausted, using bare fallback" or "every
 * candidate rejected") is memoized with a 60s TTL, then re-probed. Without
 * any negative cache a git-less host would pay the full probe budget on
 * every call; a permanent negative cache would mean a host that installs
 * git mid-session stays broken until restart.
 */
import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { advisoryWarn } from '../services/warning-buffer.js';
import { GitBinaryMissingError } from './git-binary-missing-error.js';

/** Env var escape hatch — a blocked user can set this without editing files. */
export const GIT_BINARY_ENV_VAR = 'OPENCODE_SWARM_GIT_BINARY';

const PER_PROBE_TIMEOUT_MS = 250;
const TOTAL_BUDGET_MS = 1000;
const NEGATIVE_CACHE_TTL_MS = 60_000;
const BARE_GIT = 'git';
const PROBE_MAX_BUFFER_BYTES = 64 * 1024;

const WINDOWS_PATH_EXTENSIONS = ['.exe', '.cmd', '.bat'];

export type GitResolutionCandidateSource = 'override' | 'platform' | 'path';

export interface GitResolutionAttempt {
	source: GitResolutionCandidateSource;
	candidate: string;
	accepted: boolean;
	/** Rejection reason; absent when `accepted` is true. */
	reason?: string;
}

export interface GitResolutionDescription {
	/** Whether the most recent probe cycle produced a validated absolute path. */
	resolved: boolean;
	resolvedPath?: string;
	attempts: GitResolutionAttempt[];
	overrideValue?: string;
	overrideSource?: 'env' | 'config';
}

interface Candidate {
	source: GitResolutionCandidateSource;
	path: string;
}

interface ProbeOutcome {
	accepted: boolean;
	reason?: string;
}

type ProbeCycleResult =
	| { outcome: 'accepted'; path: string }
	| { outcome: 'exhausted-budget' }
	| { outcome: 'all-rejected' };

interface CacheSuccess {
	kind: 'success';
	path: string;
}
interface CacheFailure {
	kind: 'failure';
	mode: 'fallback' | 'missing';
	error?: GitBinaryMissingError;
	expiresAt: number;
}
type CacheEntry = CacheSuccess | CacheFailure;

/**
 * Module state. Deliberately NOT initialized by calling anything at import
 * time — `resolveGitExecutable()`/`resolveGitExecutableAsync()` are lazy,
 * memoized on first call (AGENTS.md invariant 1).
 */
let cache: CacheEntry | null = null;
let lastAttempts: GitResolutionAttempt[] = [];
let configuredOverride: string | undefined;
let inFlightAsync: Promise<string> | null = null;

function unique(values: string[]): string[] {
	return [...new Set(values.filter(Boolean))];
}

function envOverride(): string | undefined {
	const raw = _internals.env()[GIT_BINARY_ENV_VAR];
	return raw && raw.trim() !== '' ? raw : undefined;
}

/** Env wins over config — it is the escape hatch a blocked user can set. */
function effectiveOverride(): string | undefined {
	return envOverride() ?? configuredOverride;
}

function overrideSource(): 'env' | 'config' | undefined {
	if (envOverride() !== undefined) return 'env';
	if (configuredOverride !== undefined) return 'config';
	return undefined;
}

function isAbsoluteForPlatform(
	candidate: string,
	platform: NodeJS.Platform,
): boolean {
	return platform === 'win32'
		? path.win32.isAbsolute(candidate)
		: path.posix.isAbsolute(candidate);
}

/**
 * Copied from `windowsGitCandidates()` in `src/git/branch.ts:32-46` per the
 * approved plan (F1) — that file is owned by another lane in this change and
 * must not be edited here.
 */
function windowsPlatformCandidates(): string[] {
	const env = _internals.env();
	const roots = unique([
		env.ProgramFiles ?? '',
		env['ProgramFiles(x86)'] ?? '',
		env.LOCALAPPDATA ? `${env.LOCALAPPDATA}\\Programs` : '',
	]);
	const installed = roots.flatMap((root) => [
		`${root}\\Git\\cmd\\git.exe`,
		`${root}\\Git\\bin\\git.exe`,
	]);
	return unique(installed);
}

function platformCandidates(platform: NodeJS.Platform): string[] {
	if (platform === 'darwin') {
		return ['/opt/homebrew/bin/git', '/usr/local/bin/git', '/usr/bin/git'];
	}
	if (platform === 'win32') {
		return windowsPlatformCandidates();
	}
	// linux and other POSIX platforms
	return ['/usr/bin/git', '/usr/local/bin/git', '/bin/git'];
}

function pathDelimiterFor(platform: NodeJS.Platform): string {
	return platform === 'win32' ? ';' : ':';
}

/**
 * Manual join (not `node:path`'s `join`, which is bound to the HOST
 * platform's separator regardless of the `platform` we are simulating) so
 * the POSIX candidate-building branch produces POSIX-shaped paths even when
 * this code runs on a Windows host, and vice versa.
 */
function joinDirAndName(
	dir: string,
	name: string,
	platform: NodeJS.Platform,
): string {
	const sep = platform === 'win32' ? '\\' : '/';
	const trimmed = dir.replace(/[\\/]+$/, '');
	return trimmed ? `${trimmed}${sep}${name}` : `${sep}${name}`;
}

/** ALL PATH matches for `git` — not just the first hit. */
function pathCandidates(platform: NodeJS.Platform): string[] {
	const pathValue = _internals.env().PATH ?? '';
	if (!pathValue) return [];
	const dirs = pathValue.split(pathDelimiterFor(platform)).filter(Boolean);
	const names =
		platform === 'win32'
			? [...WINDOWS_PATH_EXTENSIONS.map((ext) => `git${ext}`), 'git']
			: ['git'];
	const out: string[] = [];
	for (const dir of dirs) {
		for (const name of names) {
			out.push(joinDirAndName(dir, name, platform));
		}
	}
	return unique(out);
}

function buildCandidates(platform: NodeJS.Platform): Candidate[] {
	const override = effectiveOverride();
	const overrideCandidate: Candidate[] = override
		? [{ source: 'override', path: override }]
		: [];

	const seen = new Set<string>(overrideCandidate.map((c) => c.path));
	const rest: Candidate[] = [];
	for (const p of platformCandidates(platform)) {
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

/**
 * Validate one candidate. A stat pre-check produces portable, deterministic
 * rejection reasons ("no such file", "is a directory") without depending on
 * OS-specific errno mapping from a failed exec; the `git --version` spawn is
 * what actually decides usability (rejects a broken shim, closes the
 * missing `X_OK` check of `isExecutableFile`).
 *
 * NOTE: a `.cmd`/`.bat` shim on Windows will stat as a regular file and can
 * still fail this probe (the Node subprocess API cannot directly launch a
 * Windows command shim without `shell: true`) — see
 * `src/sast/semgrep.ts:76-78` for the identical, deliberate tradeoff. That
 * is correct behavior, not a bug to special-case: a candidate this module
 * cannot successfully invoke is not a usable candidate.
 */
function probeCandidate(
	candidatePath: string,
	platform: NodeJS.Platform,
): ProbeOutcome {
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
			// AGENTS.md invariant 3: bound stdio explicitly. `git --version`
			// output is a single short line; this is defense-in-depth against a
			// misbehaving candidate that dumps unexpected output before failing.
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
			reason: `git --version returned ${statusDescription}`,
		};
	}
	return { accepted: true };
}

/**
 * Pure computation of one probe cycle, structured as a generator so the sync
 * and async drivers below can share IDENTICAL logic — the async driver just
 * yields to the event loop between `yield` points, the sync driver drains
 * immediately. This is what makes `resolveGitExecutableAsync()` genuinely
 * non-blocking rather than `async` sugar around the same synchronous loop.
 */
function* probeCycle(
	candidates: Candidate[],
	platform: NodeJS.Platform,
	attempts: GitResolutionAttempt[],
): Generator<void, ProbeCycleResult, void> {
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
			reason: result.reason,
		});

		if (candidate.source === 'override' && !result.accepted) {
			// Invalid override behavior (F4, carry-forward item i): NOT fatal,
			// does NOT silently win. Skip with a single warning and continue
			// down the candidate list.
			advisoryWarn(
				`[opencode-swarm] git.binary override "${candidate.path}" is unusable (${result.reason}); falling back to automatic git resolution.`,
			);
		}

		if (result.accepted) {
			return { outcome: 'accepted', path: candidate.path };
		}

		yield;
	}

	return budgetExceeded
		? { outcome: 'exhausted-budget' }
		: { outcome: 'all-rejected' };
}

function driveSync(
	gen: Generator<void, ProbeCycleResult, void>,
): ProbeCycleResult {
	let step = gen.next();
	while (!step.done) {
		step = gen.next();
	}
	return step.value;
}

async function driveAsync(
	gen: Generator<void, ProbeCycleResult, void>,
): Promise<ProbeCycleResult> {
	let step = gen.next();
	while (!step.done) {
		// Real event-loop yield (macrotask), not a microtask — a synchronous
		// spawnSync loop cannot be interrupted by an outer withTimeout wrapper,
		// which is exactly why the init path needs this async entry point
		// (AGENTS.md invariant 1).
		await _internals.yieldToEventLoop();
		step = gen.next();
	}
	return step.value;
}

function buildMissingErrorMessage(
	attempts: GitResolutionAttempt[],
	override: string | undefined,
): string {
	const lines = attempts.map(
		(a) =>
			`  - [${a.source}] ${a.candidate}: ${a.accepted ? 'ok' : (a.reason ?? 'rejected')}`,
	);
	const overrideNote = override
		? `The configured override "${override}" was also rejected — see above.`
		: `No override is configured. Set the ${GIT_BINARY_ENV_VAR} environment variable, or the "git.binary" config value, to point at a working git executable.`;
	return [
		'git executable could not be resolved on this host. Candidates tried:',
		...(lines.length > 0
			? lines
			: ['  (no candidates were found for this platform)']),
		overrideNote,
	].join('\n');
}

/** Read the cache, expiring a stale negative entry in place. */
function readCache(): CacheEntry | null {
	if (cache === null) return null;
	if (cache.kind === 'success') return cache;
	if (_internals.now() < cache.expiresAt) return cache;
	cache = null;
	return null;
}

function applyProbeResult(
	result: ProbeCycleResult,
	attempts: GitResolutionAttempt[],
): { path: string } | { error: GitBinaryMissingError } {
	lastAttempts = attempts;

	if (result.outcome === 'accepted') {
		cache = { kind: 'success', path: result.path };
		return { path: result.path };
	}
	if (result.outcome === 'exhausted-budget') {
		cache = {
			kind: 'failure',
			mode: 'fallback',
			expiresAt: _internals.now() + NEGATIVE_CACHE_TTL_MS,
		};
		return { path: BARE_GIT };
	}

	// 'all-rejected' — every candidate was definitively probed and rejected.
	// A bare `'git'` spawn would hit the exact same PATH entries and fail
	// identically, so this is not a regression; throw the actionable error.
	const error = new GitBinaryMissingError(
		buildMissingErrorMessage(attempts, effectiveOverride()),
	);
	cache = {
		kind: 'failure',
		mode: 'missing',
		error,
		expiresAt: _internals.now() + NEGATIVE_CACHE_TTL_MS,
	};
	return { error };
}

/**
 * Resolve the git executable to invoke. Lazy and memoized on first call —
 * nothing is probed at module load. Synchronous; bounded by
 * `TOTAL_BUDGET_MS`. Prefer `resolveGitExecutableAsync()` on any path that
 * runs before plugin init resolves (AGENTS.md invariant 1).
 */
export function resolveGitExecutable(): string {
	const cached = readCache();
	if (cached) {
		if (cached.kind === 'success') return cached.path;
		if (cached.mode === 'fallback') return BARE_GIT;
		throw cached.error ?? new GitBinaryMissingError();
	}

	const platform = _internals.platform();
	const attempts: GitResolutionAttempt[] = [];
	const candidates = buildCandidates(platform);

	const result = driveSync(probeCycle(candidates, platform, attempts));
	const applied = applyProbeResult(result, attempts);
	if ('error' in applied) throw applied.error;
	return applied.path;
}

/**
 * Async counterpart. Shares one in-flight resolution across concurrent
 * callers (the `semgrepAvailabilityProbe` precedent in
 * `src/sast/semgrep.ts`) and yields to the event loop between candidate
 * probes so a slow probe budget never blocks the event loop for the full
 * 1000ms in one tick.
 */
export async function resolveGitExecutableAsync(): Promise<string> {
	const cached = readCache();
	if (cached) {
		if (cached.kind === 'success') return cached.path;
		if (cached.mode === 'fallback') return BARE_GIT;
		throw cached.error ?? new GitBinaryMissingError();
	}

	if (inFlightAsync) return inFlightAsync;

	const platform = _internals.platform();
	const attempts: GitResolutionAttempt[] = [];
	const candidates = buildCandidates(platform);

	const run = (async (): Promise<string> => {
		const result = await driveAsync(probeCycle(candidates, platform, attempts));
		const applied = applyProbeResult(result, attempts);
		if ('error' in applied) throw applied.error;
		return applied.path;
	})();

	inFlightAsync = run;
	try {
		return await run;
	} finally {
		if (inFlightAsync === run) inFlightAsync = null;
	}
}

/** Exported for tests and called by `setGitBinaryOverride` on change. */
export function resetGitExecutableCache(): void {
	cache = null;
	lastAttempts = [];
	inFlightAsync = null;
}

/**
 * Registers the config-sourced override (`git.binary`). The environment
 * variable `OPENCODE_SWARM_GIT_BINARY` always takes precedence when set —
 * this only registers the config fallback. Resets the cache ONLY when the
 * value actually changes, so a repeat/multi-swarm init does not discard an
 * already-memoized good resolution.
 */
export function setGitBinaryOverride(value?: string): void {
	const normalized = value && value.trim() !== '' ? value : undefined;
	if (normalized === configuredOverride) return;
	configuredOverride = normalized;
	resetGitExecutableCache();
}

/**
 * Diagnostic surface: which candidates were tried in the most recent probe
 * cycle and why each was rejected. Safe to call before any resolution has
 * happened (returns an empty attempts list) — it never triggers a probe
 * itself.
 */
export function describeGitResolution(): GitResolutionDescription {
	const cached = cache;
	return {
		resolved: cached?.kind === 'success',
		resolvedPath: cached?.kind === 'success' ? cached.path : undefined,
		attempts: [...lastAttempts],
		overrideValue: effectiveOverride(),
		overrideSource: overrideSource(),
	};
}

/**
 * DI seam for testability (repo convention — see `src/sast/semgrep.ts`).
 * `platform`/`env` let tests drive every platform branch regardless of the
 * host OS running the test. `now`/`yieldToEventLoop` make the TTL, budget,
 * and async-yield behavior deterministically testable without real sleeps.
 */
export const _internals: {
	spawnSync: typeof spawnSync;
	platform: () => NodeJS.Platform;
	env: () => NodeJS.ProcessEnv;
	now: () => number;
	yieldToEventLoop: () => Promise<void>;
} = {
	spawnSync,
	platform: () => process.platform,
	env: () => process.env,
	now: () => Date.now(),
	yieldToEventLoop: () => new Promise((resolve) => setTimeout(resolve, 0)),
};
