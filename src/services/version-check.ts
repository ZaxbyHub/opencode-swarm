/**
 * Background staleness check for the npm `opencode-swarm@latest` tag.
 *
 * Motivation: opencode caches plugins indefinitely under
 * `~/.cache/opencode/packages/` with no staleness check (issue #675). Users who
 * never re-run `bunx opencode-swarm install` silently keep running an old
 * version forever. This module fires a single fire-and-forget check at plugin
 * startup, throttled to once per 24h via a tiny on-disk cache, and emits one
 * deferred warning when a newer version is available.
 *
 * Hard rules:
 * - Never blocks plugin init. All work runs after a microtask.
 * - Never throws to callers. Network failures, parse failures, missing dirs:
 *   all swallowed silently.
 * - Single in-process latch prevents duplicate checks per session.
 * - Disabled by `version_check: false` in opencode-swarm.json.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const NPM_REGISTRY_URL = 'https://registry.npmjs.org/opencode-swarm/latest';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const FETCH_TIMEOUT_MS = 5_000;

interface VersionCheckCache {
	checkedAt: number;
	npmLatest: string | null;
}

let _checkLatched = false;

function cacheDir(): string {
	const xdg = process.env.XDG_CACHE_HOME;
	const base = xdg && xdg.length > 0 ? xdg : join(homedir(), '.cache');
	return join(base, 'opencode-swarm');
}

function cacheFile(): string {
	return join(cacheDir(), 'version-check.json');
}

export function readVersionCache(): VersionCheckCache | null {
	try {
		const path = cacheFile();
		if (!existsSync(path)) return null;
		const raw = readFileSync(path, 'utf-8');
		const parsed = JSON.parse(raw) as Partial<VersionCheckCache>;
		if (typeof parsed?.checkedAt !== 'number') return null;
		const npmLatest =
			typeof parsed.npmLatest === 'string' ? parsed.npmLatest : null;
		return { checkedAt: parsed.checkedAt, npmLatest };
	} catch {
		return null;
	}
}

function writeVersionCache(entry: VersionCheckCache): void {
	try {
		const dir = cacheDir();
		mkdirSync(dir, { recursive: true });
		writeFileSync(cacheFile(), JSON.stringify(entry, null, 2), 'utf-8');
	} catch {
		// Cache write failures are non-fatal — we'll just re-check sooner.
	}
}

/**
 * Compare two semver-ish version strings. Returns 1 if `a > b`, -1 if `a < b`,
 * 0 if equal. Treats prerelease tags as lower than the release. Pure function.
 */
export function compareVersions(a: string, b: string): number {
	const [aBase, aPre] = a.split('-', 2);
	const [bBase, bPre] = b.split('-', 2);
	const aParts = aBase.split('.').map((n) => Number.parseInt(n, 10) || 0);
	const bParts = bBase.split('.').map((n) => Number.parseInt(n, 10) || 0);
	const len = Math.max(aParts.length, bParts.length);
	for (let i = 0; i < len; i++) {
		const av = aParts[i] ?? 0;
		const bv = bParts[i] ?? 0;
		if (av > bv) return 1;
		if (av < bv) return -1;
	}
	if (aPre && !bPre) return -1;
	if (!aPre && bPre) return 1;
	if (aPre && bPre) return aPre < bPre ? -1 : aPre > bPre ? 1 : 0;
	return 0;
}

async function fetchLatestVersion(signal: AbortSignal): Promise<string | null> {
	try {
		const res = await fetch(NPM_REGISTRY_URL, {
			signal,
			headers: { Accept: 'application/json' },
		});
		if (!res.ok) return null;
		const body = (await res.json()) as { version?: unknown };
		return typeof body.version === 'string' ? body.version : null;
	} catch {
		return null;
	}
}

/**
 * Schedule a one-shot, fully detached version check. Returns immediately.
 * Emits a deferred warning via `emitWarning` when a newer version is found.
 *
 * @param runningVersion The version of the currently-loaded plugin.
 * @param emitWarning Callback used to surface the staleness notice.
 * @param now Time source — overridable for tests.
 * @param fetchImpl Fetcher — overridable for tests.
 */
export function scheduleVersionCheck(
	runningVersion: string,
	emitWarning: (msg: string) => void,
	options?: {
		now?: () => number;
		fetchImpl?: (signal: AbortSignal) => Promise<string | null>;
	},
): void {
	if (_checkLatched) return;
	_checkLatched = true;
	const now = options?.now ?? (() => Date.now());
	const fetchImpl = options?.fetchImpl ?? fetchLatestVersion;

	queueMicrotask(() => {
		runVersionCheck(runningVersion, emitWarning, now, fetchImpl).catch(() => {
			// Detached: never propagate errors back to the host.
		});
	});
}

async function runVersionCheck(
	runningVersion: string,
	emitWarning: (msg: string) => void,
	now: () => number,
	fetchImpl: (signal: AbortSignal) => Promise<string | null>,
): Promise<void> {
	const cached = readVersionCache();
	const t = now();

	// Honor 24h throttle, but still emit a warning from cached value if it
	// already shows a newer version than we're running.
	if (cached && t - cached.checkedAt < CHECK_INTERVAL_MS) {
		if (cached.npmLatest) {
			maybeWarn(runningVersion, cached.npmLatest, emitWarning);
		}
		return;
	}

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	let npmLatest: string | null = null;
	try {
		npmLatest = await fetchImpl(controller.signal);
	} finally {
		clearTimeout(timeout);
	}

	writeVersionCache({ checkedAt: t, npmLatest });

	if (npmLatest) {
		maybeWarn(runningVersion, npmLatest, emitWarning);
	}
}

function maybeWarn(
	runningVersion: string,
	npmLatest: string,
	emitWarning: (msg: string) => void,
): void {
	if (compareVersions(npmLatest, runningVersion) > 0) {
		emitWarning(
			`[opencode-swarm] Update available: ${runningVersion} → ${npmLatest}. ` +
				'OpenCode caches plugins indefinitely. Run `bunx opencode-swarm update` to refresh.',
		);
	}
}

/**
 * Test-only: reset the in-process latch so a subsequent schedule call runs.
 */
export function _resetVersionCheckLatchForTests(): void {
	_checkLatched = false;
}
