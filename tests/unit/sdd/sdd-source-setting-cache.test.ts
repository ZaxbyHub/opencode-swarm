/**
 * #3354 AC6 (acceptance check C6): `readSddSourceSetting` must not re-read
 * unchanged config files on every call — a rewrite that preserves the file's
 * mtime (and byte size) must be invisible to the reader, while a real mtime
 * bump must still be honored.
 *
 * The mtime-preserved rewrite is the discriminating observable for "unchanged
 * files are not re-read": RED at base (every call re-stats/re-reads, so the
 * new content is observed), GREEN after the fix (an mtime-keyed cache returns
 * the first read's value). The mtime-bump leg pins that the cache is not a
 * stale-forever cache; it is checked in the same test after the first
 * assertion so the whole test is red at base exactly once.
 *
 * FIX-SURFACE NOTE (test isolation): the fix must expose a cache reset via
 * the existing `_internals` seam in src/config/loader.ts (e.g.
 * `_internals.resetSddSourceCache()`), the same convention as
 * resetUnknownTopLevelKeyWarning/resetGatesAdvisoryDedup. This file calls it
 * defensively through optional chaining so it compiles at base, where the
 * export does not exist yet.
 *
 * Fixture adapted from the trace probe probe-3354-cache.ts.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { _internals, readSddSourceSetting } from '../../../src/config/loader';
import { clearDeferredWarnings } from '../../../src/services/warning-buffer';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

let tempDir: string;
let xdgDir: string;
let savedEnv: string | undefined;
let savedXdg: string | undefined;

function writeProject(content: string): string {
	const abs = path.join(tempDir, 'project', '.opencode', 'opencode-swarm.json');
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, content, 'utf-8');
	return abs;
}

/** Reset the post-fix sdd-source cache via the `_internals` seam. The seam is
 * mandatory now — deleting it from the loader must fail this suite (bot-minor
 * 5: an optional-chained call would let the seam be deleted vacuously). */
function resetSddSourceCacheIfPresent(): void {
	const reset = (
		_internals as {
			resetSddSourceCache?: () => void;
		}
	).resetSddSourceCache;
	if (typeof reset !== 'function') {
		throw new Error(
			'_internals.resetSddSourceCache is missing (seam deleted?)',
		);
	}
	reset();
}

beforeEach(() => {
	tempDir = canonicalMkdtemp('sdd-setting-cache-');
	xdgDir = path.join(tempDir, '.xdg-config');
	fs.mkdirSync(path.join(xdgDir, 'opencode'), { recursive: true });
	savedEnv = process.env.SWARM_SDD_SOURCE;
	savedXdg = process.env.XDG_CONFIG_HOME;
	delete process.env.SWARM_SDD_SOURCE;
	process.env.XDG_CONFIG_HOME = xdgDir;
	_internals.resetUnknownTopLevelKeyWarning();
	_internals.resetGatesAdvisoryDedup();
	resetSddSourceCacheIfPresent();
	clearDeferredWarnings();
});

afterEach(() => {
	if (savedEnv === undefined) delete process.env.SWARM_SDD_SOURCE;
	else process.env.SWARM_SDD_SOURCE = savedEnv;
	if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
	else process.env.XDG_CONFIG_HOME = savedXdg;
	_internals.resetUnknownTopLevelKeyWarning();
	_internals.resetGatesAdvisoryDedup();
	resetSddSourceCacheIfPresent();
	clearDeferredWarnings();
	fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('#3354 AC6: unchanged config files are not re-read (mtime-keyed cache)', () => {
	test('a rewrite that preserves mtime is not observed; a real mtime bump is', () => {
		const projDir = path.join(tempDir, 'project');
		// The documented freshness contract is mtime+size, so the
		// mtime-preserved rewrite below must ALSO preserve SIZE: the shorter
		// 'speckit' payload is padded with one trailing space (JSON tolerates
		// trailing whitespace) to byte-match the 'openspec' payload.
		const cfgPath = writeProject(
			JSON.stringify({ sdd: { source: 'speckit' } }) + ' ',
		);

		(
			_internals as { resetRawConfigReadAttempts?: () => void }
		).resetRawConfigReadAttempts?.();
		const r1 = readSddSourceSetting(projDir);
		expect(r1.source).toBe('speckit');
		// B2-M2/PRR-002: the counter must be LIVE (the first call reads the files)
		// so the no-re-read assertion below actually discriminates.
		expect(
			(
				_internals as { getRawConfigReadAttempts?: () => number }
			).getRawConfigReadAttempts?.(),
		).toBeGreaterThan(0);

		// Same byte length, new content, mtime (and atime) pinned to the
		// previously stat'ed values: an mtime+size-keyed cache must keep r1's
		// value (sub-millisecond utimes truncation is absorbed by the key's
		// whole-millisecond flooring in configStatKey).
		const st = fs.statSync(cfgPath);
		fs.writeFileSync(
			cfgPath,
			JSON.stringify({ sdd: { source: 'openspec' } }),
			'utf-8',
		);
		expect(fs.statSync(cfgPath).size).toBe(st.size);
		fs.utimesSync(cfgPath, st.atime, st.mtime);

		const readsAfterFirst =
			(
				_internals as { getRawConfigReadAttempts?: () => number }
			).getRawConfigReadAttempts?.() ?? 0;
		const r2 = readSddSourceSetting(projDir);
		expect(r2.source).toBe(r1.source);
		// AC6 directly observed: the unchanged second call does not re-read.
		expect(
			(
				_internals as { getRawConfigReadAttempts?: () => number }
			).getRawConfigReadAttempts?.(),
		).toBe(readsAfterFirst);

		// A strictly later mtime (original + 5 s, so coarse-granularity
		// filesystems cannot fold it back onto the preserved timestamp) must
		// invalidate the cache and surface the real change.
		const bumped = new Date(st.mtime.getTime() + 5000);
		fs.utimesSync(cfgPath, bumped, bumped);
		const r3 = readSddSourceSetting(projDir);
		expect(r3.source).toBe('openspec');
	});

	test('impl-review round-2 Q1: a mid-process XDG_CONFIG_HOME change cannot serve a stale entry', () => {
		// Two user-config roots with IDENTICAL file stats (equal size via one
		// padding space, pinned identical mtime) but DIFFERENT sources: a
		// stat-only cache key collides exactly here and would return root A's
		// value for root B; the key carries the resolved user config path, so
		// switching XDG for the same project directory re-reads.
		// No project config: the USER config supplies the source on every leg.
		const projDir = path.join(tempDir, 'project-xdg-switch');
		fs.mkdirSync(path.join(projDir, '.opencode'), { recursive: true });

		const xdgA = path.join(tempDir, 'xdg-a');
		const xdgB = path.join(tempDir, 'xdg-b');
		for (const root of [xdgA, xdgB]) {
			fs.mkdirSync(path.join(root, 'opencode'), { recursive: true });
		}
		fs.writeFileSync(
			path.join(xdgA, 'opencode', 'opencode-swarm.json'),
			JSON.stringify({ sdd: { source: 'openspec' } }),
			'utf-8',
		);
		const stA = fs.statSync(path.join(xdgA, 'opencode', 'opencode-swarm.json'));
		fs.writeFileSync(
			path.join(xdgB, 'opencode', 'opencode-swarm.json'),
			JSON.stringify({ sdd: { source: 'speckit' } }) + ' ',
			'utf-8',
		);
		expect(
			fs.statSync(path.join(xdgB, 'opencode', 'opencode-swarm.json')).size,
		).toBe(stA.size);
		fs.utimesSync(
			path.join(xdgB, 'opencode', 'opencode-swarm.json'),
			stA.atime,
			stA.mtime,
		);

		process.env.XDG_CONFIG_HOME = xdgA;
		const fromA = readSddSourceSetting(projDir);
		expect(fromA.source).toBe('openspec');
		expect(fromA.origin).toBe('user');

		process.env.XDG_CONFIG_HOME = xdgB;
		const fromB = readSddSourceSetting(projDir);
		expect(fromB.source).toBe('speckit');
		expect(fromB.origin).toBe('user');

		// And switching to a root with NO user config yields no source rather
		// than a cached one.
		const xdgEmpty = path.join(tempDir, 'xdg-empty');
		fs.mkdirSync(xdgEmpty, { recursive: true });
		process.env.XDG_CONFIG_HOME = xdgEmpty;
		const fromEmpty = readSddSourceSetting(projDir);
		expect(fromEmpty.source).toBeUndefined();
	});

	test('PRR-001: the 64-entry FIFO bound actually evicts (oldest directory re-reads)', () => {
		const counter = _internals as {
			resetRawConfigReadAttempts?: () => void;
			getRawConfigReadAttempts?: () => number;
		};
		// 65 distinct project roots, each with a distinct config: the first
		// root must be evicted by the time the 65th is cached, observable as a
		// re-read (counter increase) while the most-recent root stays cached.
		const roots: string[] = [];
		for (let i = 0; i < 65; i += 1) {
			const dir = path.join(tempDir, `fifo-${String(i).padStart(2, '0')}`);
			fs.mkdirSync(path.join(dir, '.opencode'), { recursive: true });
			fs.writeFileSync(
				path.join(dir, '.opencode', 'opencode-swarm.json'),
				JSON.stringify({ sdd: { source: 'speckit' } }),
				'utf-8',
			);
			roots.push(dir);
		}
		counter.resetRawConfigReadAttempts?.();
		const baseline = counter.getRawConfigReadAttempts?.() ?? 0;
		for (const dir of roots) readSddSourceSetting(dir);
		const afterAll = counter.getRawConfigReadAttempts?.() ?? 0;
		// All 65 roots missed (1 read each — this fixture has no user config,
		// so only the project file is read per root).
		expect(afterAll).toBeGreaterThan(baseline + 64);
		// Warm: the most recent root does not re-read.
		const warmMark = counter.getRawConfigReadAttempts?.() ?? 0;
		readSddSourceSetting(roots[64]);
		expect(counter.getRawConfigReadAttempts?.() ?? 0).toBe(warmMark);
		// Evicted: root 0 (oldest) re-reads after the cache wrapped past it.
		readSddSourceSetting(roots[0]);
		expect(counter.getRawConfigReadAttempts?.() ?? 0).toBeGreaterThan(warmMark);
	});
});
