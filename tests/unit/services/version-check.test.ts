/**
 * Tests for the npm staleness check (issue #675).
 *
 * The service runs detached at plugin startup, throttled to once per 24h via
 * an on-disk cache, and emits a single deferred warning when a newer version
 * is published on npm. Network failures are silent.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	_internals,
	_resetVersionCheckLatchForTests,
	compareVersions,
	fetchLatestVersion,
	isStrictSemver,
	readVersionCache,
	scheduleVersionCheck,
} from '../../../src/services/version-check';

async function flushMicrotasks(): Promise<void> {
	// Two awaits are enough for queueMicrotask + the awaited fetch resolution.
	await new Promise((r) => setTimeout(r, 5));
	await new Promise((r) => setTimeout(r, 5));
}

describe('compareVersions', () => {
	test('greater patch', () => {
		expect(compareVersions('6.86.8', '6.86.7')).toBe(1);
	});
	test('greater minor outranks lesser patch', () => {
		expect(compareVersions('6.87.0', '6.86.99')).toBe(1);
	});
	test('equal versions', () => {
		expect(compareVersions('6.86.7', '6.86.7')).toBe(0);
	});
	test('lesser version', () => {
		expect(compareVersions('6.84.2', '6.86.7')).toBe(-1);
	});
	test('release outranks prerelease of the same base', () => {
		expect(compareVersions('6.87.0', '6.87.0-rc.1')).toBe(1);
		expect(compareVersions('6.87.0-rc.1', '6.87.0')).toBe(-1);
	});
	test('non-numeric segments degrade to 0', () => {
		// Defensive: should not throw on malformed input.
		expect(() => compareVersions('not-a-version', '6.86.7')).not.toThrow();
	});
});

describe('scheduleVersionCheck', () => {
	let cacheHome: string;

	beforeEach(async () => {
		cacheHome = await mkdtemp(join(tmpdir(), 'oc-swarm-vcheck-'));
		process.env.XDG_CACHE_HOME = cacheHome;
		_resetVersionCheckLatchForTests();
	});

	afterEach(async () => {
		delete process.env.XDG_CACHE_HOME;
		if (existsSync(cacheHome)) {
			await rm(cacheHome, { recursive: true, force: true });
		}
	});

	test('emits a warning when npm has a newer version', async () => {
		const warnings: string[] = [];
		scheduleVersionCheck(
			'6.84.2',
			(m) => {
				warnings.push(m);
			},
			{
				now: () => 1_000_000_000_000,
				fetchImpl: async () => '6.86.7',
			},
		);
		await flushMicrotasks();

		expect(warnings.length).toBe(1);
		expect(warnings[0]).toContain('6.84.2 → 6.86.7');
		expect(warnings[0]).toContain('bunx opencode-swarm update');

		// Cache file written.
		const cache = readVersionCache();
		expect(cache).not.toBeNull();
		expect(cache?.npmLatest).toBe('6.86.7');
		expect(cache?.checkedAt).toBe(1_000_000_000_000);
	});

	test('emits no warning when running version is already current', async () => {
		const warnings: string[] = [];
		scheduleVersionCheck('6.86.7', (m) => warnings.push(m), {
			now: () => 1_000_000_000_000,
			fetchImpl: async () => '6.86.7',
		});
		await flushMicrotasks();
		expect(warnings).toEqual([]);
	});

	test('emits no warning when running version is ahead of npm', async () => {
		const warnings: string[] = [];
		scheduleVersionCheck('7.0.0', (m) => warnings.push(m), {
			now: () => 1_000_000_000_000,
			fetchImpl: async () => '6.86.7',
		});
		await flushMicrotasks();
		expect(warnings).toEqual([]);
	});

	test('skips network when cache is < 24h old', async () => {
		// Pre-seed the cache with a recent check.
		const dir = join(cacheHome, 'opencode-swarm');
		await mkdir(dir, { recursive: true });
		writeFileSync(
			join(dir, 'version-check.json'),
			JSON.stringify({
				checkedAt: 1_000_000_000_000,
				npmLatest: '6.86.7',
			}),
		);

		const warnings: string[] = [];
		let fetchCalls = 0;
		scheduleVersionCheck('6.84.2', (m) => warnings.push(m), {
			now: () => 1_000_000_000_000 + 60 * 60 * 1000, // +1h
			fetchImpl: async () => {
				fetchCalls += 1;
				return '999.0.0';
			},
		});
		await flushMicrotasks();

		expect(fetchCalls).toBe(0);
		// Cached value still triggers warning since running version is stale.
		expect(warnings.length).toBe(1);
		expect(warnings[0]).toContain('6.84.2 → 6.86.7');
	});

	test('refetches when cache is > 24h old', async () => {
		const dir = join(cacheHome, 'opencode-swarm');
		await mkdir(dir, { recursive: true });
		writeFileSync(
			join(dir, 'version-check.json'),
			JSON.stringify({
				checkedAt: 1_000_000_000_000,
				npmLatest: '6.86.7',
			}),
		);

		const warnings: string[] = [];
		let fetchCalls = 0;
		scheduleVersionCheck('6.84.2', (m) => warnings.push(m), {
			now: () => 1_000_000_000_000 + 25 * 60 * 60 * 1000, // +25h
			fetchImpl: async () => {
				fetchCalls += 1;
				return '6.87.0';
			},
		});
		await flushMicrotasks();

		expect(fetchCalls).toBe(1);
		expect(warnings.length).toBe(1);
		expect(warnings[0]).toContain('6.84.2 → 6.87.0');
		expect(readVersionCache()?.npmLatest).toBe('6.87.0');
	});

	test('network failure is silent — no warning, no throw', async () => {
		const warnings: string[] = [];
		expect(() => {
			scheduleVersionCheck('6.84.2', (m) => warnings.push(m), {
				now: () => 1_000_000_000_000,
				fetchImpl: async () => null,
			});
		}).not.toThrow();
		await flushMicrotasks();
		expect(warnings).toEqual([]);
		// Cache is still written so we don't hammer the network on every start.
		const cache = readVersionCache();
		expect(cache?.npmLatest).toBeNull();
	});

	test('is idempotent within a single process — second call is a no-op', async () => {
		let calls = 0;
		const fetchImpl = async () => {
			calls += 1;
			return '6.86.7';
		};
		scheduleVersionCheck('6.84.2', () => {}, {
			now: () => 1_000_000_000_000,
			fetchImpl,
		});
		scheduleVersionCheck('6.84.2', () => {}, {
			now: () => 1_000_000_000_000,
			fetchImpl,
		});
		await flushMicrotasks();
		expect(calls).toBe(1);
	});
});

describe('readVersionCache', () => {
	let cacheHome: string;

	beforeEach(async () => {
		cacheHome = await mkdtemp(join(tmpdir(), 'oc-swarm-vcheck-read-'));
		process.env.XDG_CACHE_HOME = cacheHome;
	});

	afterEach(async () => {
		delete process.env.XDG_CACHE_HOME;
		if (existsSync(cacheHome)) {
			await rm(cacheHome, { recursive: true, force: true });
		}
	});

	test('returns null when no cache file exists', () => {
		expect(readVersionCache()).toBeNull();
	});

	test('returns null when cache file is corrupt JSON', async () => {
		const dir = join(cacheHome, 'opencode-swarm');
		await mkdir(dir, { recursive: true });
		writeFileSync(join(dir, 'version-check.json'), '{not-json');
		expect(readVersionCache()).toBeNull();
	});

	test('returns null when checkedAt is missing or wrong type', async () => {
		const dir = join(cacheHome, 'opencode-swarm');
		await mkdir(dir, { recursive: true });
		writeFileSync(
			join(dir, 'version-check.json'),
			JSON.stringify({ npmLatest: '1.2.3' }),
		);
		expect(readVersionCache()).toBeNull();
	});

	test('returns the cached entry when valid', async () => {
		const dir = join(cacheHome, 'opencode-swarm');
		await mkdir(dir, { recursive: true });
		writeFileSync(
			join(dir, 'version-check.json'),
			JSON.stringify({ checkedAt: 42, npmLatest: '1.2.3' }),
		);
		const entry = readVersionCache();
		expect(entry).toEqual({ checkedAt: 42, npmLatest: '1.2.3' });
	});
});

describe('fetchLatestVersion — strict response validation (#1270-4)', () => {
	const realFetch = _internals.fetch;

	afterEach(() => {
		// Restore the DI seam so the real global fetch is reinstated. The seam
		// is file-scoped state; leaving a mock in place would corrupt other
		// suites in the shared test-runner process.
		_internals.fetch = realFetch;
	});

	// Minimal Response-shaped fake: fetchLatestVersion only reads `.ok`,
	// `.headers.get(...)`, and `.text()`. Using a plain object keeps the test
	// deterministic and avoids runtime-specific Response/Content-Length quirks.
	function fakeResponse(opts: {
		ok?: boolean;
		contentType?: string | null;
		contentLength?: string | null;
		body: string;
	}): Response {
		const headers = new Map<string, string>();
		if (opts.contentType != null) headers.set('content-type', opts.contentType);
		if (opts.contentLength != null)
			headers.set('content-length', opts.contentLength);
		return {
			ok: opts.ok ?? true,
			headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
			text: async () => opts.body,
		} as unknown as Response;
	}

	const signal = new AbortController().signal;

	test('accepts a well-formed JSON response with a strict semver', async () => {
		_internals.fetch = async () =>
			fakeResponse({
				contentType: 'application/json; charset=utf-8',
				body: JSON.stringify({ version: '6.86.7' }),
			});
		expect(await fetchLatestVersion(signal)).toBe('6.86.7');
	});

	test('accepts the npm install-v1 +json content-type variant', async () => {
		_internals.fetch = async () =>
			fakeResponse({
				contentType: 'application/vnd.npm.install-v1+json',
				body: JSON.stringify({ version: '7.0.0-rc.1' }),
			});
		expect(await fetchLatestVersion(signal)).toBe('7.0.0-rc.1');
	});

	test('rejects a non-JSON content-type (HTML error page)', async () => {
		_internals.fetch = async () =>
			fakeResponse({
				contentType: 'text/html; charset=utf-8',
				body: '<!doctype html><html><body>502 Bad Gateway</body></html>',
			});
		expect(await fetchLatestVersion(signal)).toBeNull();
	});

	test('rejects a text/plain content-type', async () => {
		_internals.fetch = async () =>
			fakeResponse({
				contentType: 'text/plain',
				body: JSON.stringify({ version: '6.86.7' }),
			});
		expect(await fetchLatestVersion(signal)).toBeNull();
	});

	test('rejects an oversized body via advertised content-length', async () => {
		_internals.fetch = async () =>
			fakeResponse({
				contentType: 'application/json',
				contentLength: String(5 * 1024 * 1024), // 5 MiB > 256 KiB cap
				body: JSON.stringify({ version: '6.86.7' }),
			});
		expect(await fetchLatestVersion(signal)).toBeNull();
	});

	test('rejects an oversized actual body even without a content-length header', async () => {
		const huge = `{"version":"6.86.7","pad":"${'x'.repeat(300 * 1024)}"}`;
		_internals.fetch = async () =>
			fakeResponse({ contentType: 'application/json', body: huge });
		expect(await fetchLatestVersion(signal)).toBeNull();
	});

	test('rejects a non-semver version string', async () => {
		_internals.fetch = async () =>
			fakeResponse({
				contentType: 'application/json',
				body: JSON.stringify({ version: 'latest' }),
			});
		expect(await fetchLatestVersion(signal)).toBeNull();
	});

	test('rejects a version field that is not a string', async () => {
		_internals.fetch = async () =>
			fakeResponse({
				contentType: 'application/json',
				body: JSON.stringify({ version: { major: 6 } }),
			});
		expect(await fetchLatestVersion(signal)).toBeNull();
	});

	test('rejects a non-ok HTTP status', async () => {
		_internals.fetch = async () =>
			fakeResponse({
				ok: false,
				contentType: 'application/json',
				body: JSON.stringify({ version: '6.86.7' }),
			});
		expect(await fetchLatestVersion(signal)).toBeNull();
	});

	test('returns null (never throws) when fetch itself rejects', async () => {
		_internals.fetch = async () => {
			throw new Error('network down');
		};
		let result: string | null = 'unset';
		await expect(
			(async () => {
				result = await fetchLatestVersion(signal);
			})(),
		).resolves.toBeUndefined();
		expect(result).toBeNull();
	});
});

describe('isStrictSemver (#1270-4)', () => {
	test('accepts the live package.json version (guards against over-strict regex)', () => {
		const pkg = JSON.parse(
			readFileSync(
				join(import.meta.dir, '..', '..', '..', 'package.json'),
				'utf-8',
			),
		) as { version: string };
		// If this fails, the strict regex would silently reject a legitimate
		// npm `latest` response and disable update checks for everyone.
		expect(isStrictSemver(pkg.version)).toBe(true);
	});

	test('accepts standard release and prerelease forms', () => {
		expect(isStrictSemver('6.86.7')).toBe(true);
		expect(isStrictSemver('7.0.0-rc.1')).toBe(true);
		expect(isStrictSemver('1.2.3+build.5')).toBe(true);
	});

	test('rejects dist-tags, ranges, partials, and junk', () => {
		expect(isStrictSemver('latest')).toBe(false);
		expect(isStrictSemver('^6.86.7')).toBe(false);
		expect(isStrictSemver('6.86')).toBe(false);
		expect(isStrictSemver('')).toBe(false);
		expect(isStrictSemver('6.86.7 ')).toBe(false);
		expect(isStrictSemver(42 as unknown)).toBe(false);
	});
});

// Sanity: the package.json `version` parses cleanly.
test('package.json version compares cleanly to itself', () => {
	const pkg = JSON.parse(
		readFileSync(
			join(import.meta.dir, '..', '..', '..', 'package.json'),
			'utf-8',
		),
	) as { version: string };
	expect(compareVersions(pkg.version, pkg.version)).toBe(0);
});
