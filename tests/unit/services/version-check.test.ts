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
	_resetVersionCheckLatchForTests,
	compareVersions,
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
