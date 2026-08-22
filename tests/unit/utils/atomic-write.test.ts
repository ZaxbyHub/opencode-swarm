/**
 * Issue #2035 — canonical atomic-write helper + temp-grammar registry.
 *
 * Covers: registry invariants (derived from the SUT, never hand-literal),
 * containment contract, atomic write semantics (temp grammar, own-temp
 * cleanup, prior-target preservation, fsync ordering, Windows retry, bounded
 * write), concurrency, and the WRITER_CLASSIFICATION ratchet that makes
 * "no unregistered temp constructor" machine-checked.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_internals,
	assertSwarmContainedTarget,
	assertWellFormedTargetPath,
	atomicWriteSwarmFile,
	atomicWriteSwarmFileSync,
	MAX_SWARM_ANCESTOR_DEPTH,
	matchTempGrammar,
	parseTargetBasename,
	SWARM_TEMP_GRAMMARS,
	WRITER_CLASSIFICATION,
} from '../../../src/utils/atomic-write';

let projectDir: string;
let swarmDir: string;
// NOTE: the WRITER_CLASSIFICATION ratchet and the PRR-019 persisted-contract
// pin live in tests/unit/utils/atomic-write-ratchet.test.ts (FR-006 cap).

beforeEach(() => {
	projectDir = mkdtempSync(path.join(os.tmpdir(), 'atomic-write-'));
	swarmDir = path.join(projectDir, '.swarm');
	mkdirSync(swarmDir, { recursive: true });
});

afterEach(() => {
	rmSync(projectDir, { recursive: true, force: true });
});

// ── Registry ────────────────────────────────────────────────────────────────

describe('SWARM_TEMP_GRAMMARS registry', () => {
	test('ids are unique and derived from the registry itself', () => {
		const ids = SWARM_TEMP_GRAMMARS.map((g) => g.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids).toContain('canonical-v1');
		expect(ids).toContain('dot-tmp-prefix-legacy');
	});

	test('every grammar lists at least one producer citation', () => {
		for (const g of SWARM_TEMP_GRAMMARS) {
			expect(g.producers.length).toBeGreaterThan(0);
		}
	});

	test('constant-token grammars are never quarantine-eligible', () => {
		for (const g of SWARM_TEMP_GRAMMARS) {
			if (g.token === 'constant' && g.id !== 'dot-tmp-prefix-legacy') {
				expect(g.quarantineEligible).toBe(false);
			}
		}
	});

	test('representative residue basenames classify to the owning grammar', () => {
		const cases: Array<[string, string | undefined]> = [
			// canonical (produced by this helper — derived below, not asserted blind)
			// current instance-token forms from the census
			['context.md.tmp.1710000000.123456789', 'target-suffix-tmp-num-alnum'],
			['evidence.json.tmp.1710000000.4321', 'target-suffix-tmp-num-alnum'],
			[
				'handoff.md.tmp.0f6c3e29-fc00-4a1b-9d3d-a1b2c3d4e5f6',
				'target-suffix-tmp-uuid',
			],
			[
				'gate.json.tmp.4242.0f6c3e29-fc00-4a1b-9d3d-a1b2c3d4e5f6',
				'target-suffix-tmp-pid-uuid',
			],
			['skills.tmp.4242.1710000000.json', 'target-suffix-tmp-num-num-json'],
			['state.json.tmp.1710000000', 'target-suffix-tmp-token'],
			['state.json.tmp.a1b2c3d4e5', 'target-suffix-tmp-token'],
			['skill.md.tmp-4242-1710000000', 'target-suffix-tmp-dash'],
			['quota.json.tmp-4242', 'target-suffix-tmp-dash-num'],
			[
				'ledger.jsonl.4242.0f6c3e29-fc00-4a1b-9d3d-a1b2c3d4e5f6.tmp',
				'target-dot-pid-uuid-tmp',
			],
			[
				'.context.md.4242.1710000000.3.a1b2c3d4.tmp',
				'dot-numeric-instance-tmp',
			],
			[
				'.review.md.0f6c3e29-fc00-4a1b-9d3d-a1b2c3d4e5f6.tmp',
				'dot-uuid-instance-tmp',
			],
			['.tmp-issue-reference.json-1710000000-4242', 'tmp-prefix-named'],
			['plan.json.rebuild.1710000000.abc123', 'target-rebuild-close'],
			['plan.md.close.1710000000.abc123', 'target-rebuild-close'],
			['scope.json.migration-4242', 'target-migration-pid'],
			['.tmp.legacy-residue', 'dot-tmp-prefix-legacy'],
			['.drift-report.json.tmp', 'dot-constant-tmp'],
			['checkpoint-log.jsonl.tmp', 'target-constant-tmp'],
		];
		for (const [name, expectedId] of cases) {
			expect(matchTempGrammar(name)?.id).toBe(expectedId);
		}
	});

	test('adversarial near-misses match NO grammar (preserved untouched)', () => {
		const nearMisses = [
			'context.md.tmp.', // trailing dot — no token
			'CONTEXT.MD.TMP.1710000000.123', // case variant (grammars are case-sensitive)
			'context.md.tmp.1710000000.123.md.bak', // trailing extra segment
			'.tmp', // bare marker, no payload
			'normal.json', // unrelated
			'notes:stream.tmp.1.2.jsonl', // ADS-style colon breaks every suffix
			'x.json.tmp..k3j9a', // empty first token segment
			'x.json.tmp.1710000000.', // empty second token segment
		];
		for (const name of nearMisses) {
			expect(matchTempGrammar(name)).toBeUndefined();
		}
	});

	test('review-receipt producer form classifies to the two-token family', () => {
		// review-receipt builds a `<epoch-ms>.<base36-random>` two-token temp
		// — toString(36) of a Math.random() value ALWAYS starts with '0' (the
		// fractional '0.xxx' form), so the second token is [0-9a-z]+ and the
		// two-token family owns it; this pins that invariant against a future
		// grammar reorder.
		expect(matchTempGrammar('review.json.tmp.1710000000.0k3j9a7f')?.id).toBe(
			'target-suffix-tmp-num-alnum',
		);
	});

	test('parseTargetBasename extracts the owning target for suffix grammars', () => {
		expect(parseTargetBasename('context.md.tmp.1710000000.123456789')).toBe(
			'context.md',
		);
		expect(
			parseTargetBasename(
				'handoff.md.tmp.0f6c3e29-fc00-4a1b-9d3d-a1b2c3d4e5f6',
			),
		).toBe('handoff.md');
		expect(parseTargetBasename('.tmp.legacy')).toBeNull();
	});
});

// ── WRITER_CLASSIFICATION ratchet ───────────────────────────────────────────

describe('assertSwarmContainedTarget', () => {
	test('accepts a target directly under .swarm and reports the root', () => {
		const target = path.join(swarmDir, 'context.md');
		const c = assertSwarmContainedTarget(target);
		expect(path.normalize(c.swarmRoot)).toBe(path.normalize(swarmDir));
		expect(path.normalize(c.projectRoot)).toBe(path.normalize(projectDir));
	});

	test('accepts a nested target (nearest .swarm ancestor within depth)', () => {
		const target = path.join(swarmDir, 'evidence', 'retro-1', 'evidence.json');
		expect(() => assertSwarmContainedTarget(target)).not.toThrow();
	});

	test('rejects a target outside any .swarm root', () => {
		expect(() =>
			assertSwarmContainedTarget(path.join(projectDir, 'out.json')),
		).toThrow(/escapes \.swarm root|not under a project \.swarm root/i);
	});

	test('rejects relative paths, globs, env-var forms, ~, and control chars', () => {
		expect(() => assertWellFormedTargetPath('relative/out.json')).toThrow(
			/absolute/i,
		);
		expect(() =>
			assertWellFormedTargetPath(path.join(swarmDir, 'a*b.json')),
		).toThrow(/glob/i);
		expect(() => assertWellFormedTargetPath(`${swarmDir}$HOME/x.json`)).toThrow(
			/environment-variable/i,
		);
		expect(() =>
			assertWellFormedTargetPath(`${swarmDir}%USERPROFILE%`),
		).toThrow(/environment-variable/i);
		expect(() =>
			assertWellFormedTargetPath(path.join(swarmDir, '~', 'x.json')),
		).toThrow(/home-dir/i);
		expect(() => assertWellFormedTargetPath(`${swarmDir}\x01x`)).toThrow(
			/control characters/i,
		);
	});

	test('rejects a symlinked .swarm root', () => {
		rmSync(projectDir, { recursive: true, force: true });
		const realProject = mkdtempSync(path.join(os.tmpdir(), 'aw-real-'));
		const linkedProject = mkdtempSync(path.join(os.tmpdir(), 'aw-link-'));
		mkdirSync(path.join(realProject, '.swarm'), { recursive: true });
		try {
			symlinkSync(
				path.join(realProject, '.swarm'),
				path.join(linkedProject, '.swarm'),
				'dir',
			);
		} catch {
			rmSync(realProject, { recursive: true, force: true });
			rmSync(linkedProject, { recursive: true, force: true });
			projectDir = realProject;
			swarmDir = path.join(realProject, '.swarm');
			return; // symlink creation unavailable on this platform/config
		}
		expect(() =>
			assertSwarmContainedTarget(path.join(linkedProject, '.swarm', 'x.json')),
		).toThrow(/symlink\/reparse|not a real directory/i);
		rmSync(realProject, { recursive: true, force: true });
		rmSync(linkedProject, { recursive: true, force: true });
	});

	test('gives up beyond MAX_SWARM_ANCESTOR_DEPTH without a .swarm', () => {
		let deep = projectDir;
		for (let i = 0; i < MAX_SWARM_ANCESTOR_DEPTH + 2; i++) {
			deep = path.join(deep, `d${i}`);
		}
		expect(() => assertSwarmContainedTarget(path.join(deep, 'x.json'))).toThrow(
			/not under a project \.swarm root/i,
		);
	});
});

// ── Writer semantics ────────────────────────────────────────────────────────

describe('atomicWriteSwarmFile', () => {
	test('writes content, leaves zero residue, and the temp was canonical-v1', async () => {
		const renames: Array<{ src: string; dest: string }> = [];
		const realRename = _internals.renameSync;
		_internals.renameSync = ((src: string, dest: string) => {
			renames.push({ src, dest });
			return realRename(src, dest);
		}) as typeof _internals.renameSync;
		try {
			const target = path.join(swarmDir, 'out.json');
			await atomicWriteSwarmFile(target, '{"a":1}');
			expect(readFileSync(target, 'utf-8')).toBe('{"a":1}');
			expect(readdirSync(swarmDir)).toEqual(['out.json']);
			expect(renames).toHaveLength(1);
			const tempBasename = path.basename(renames[0]!.src);
			expect(tempBasename).toMatch(/^out\.json\.[0-9a-f]{32}\.tmp$/);
			expect(matchTempGrammar(tempBasename)?.id).toBe('canonical-v1');
			expect(path.dirname(renames[0]!.src)).toBe(
				path.dirname(renames[0]!.dest),
			);
		} finally {
			_internals.renameSync = realRename;
		}
	});

	test('creates missing parent directories and overwrites atomically', async () => {
		const target = path.join(swarmDir, 'evidence', 'retro-9', 'evidence.json');
		await atomicWriteSwarmFile(target, 'first');
		await atomicWriteSwarmFile(target, 'second');
		expect(readFileSync(target, 'utf-8')).toBe('second');
		expect(
			readdirSync(path.join(swarmDir, 'evidence', 'retro-9')).filter((f) =>
				f.includes('.tmp'),
			),
		).toHaveLength(0);
	});

	test('Uint8Array payloads round-trip byte-exact', async () => {
		const target = path.join(swarmDir, 'bytes.bin');
		const payload = new Uint8Array([0, 1, 2, 255, 254]);
		await atomicWriteSwarmFile(target, payload);
		expect(Array.from(readFileSync(target))).toEqual(Array.from(payload));
	});

	test('fsync runs BEFORE rename (ordering)', async () => {
		const calls: string[] = [];
		const realFsync = _internals.fsyncSync;
		const realRename = _internals.renameSync;
		_internals.fsyncSync = ((fd: number) => {
			calls.push('fsync');
			return realFsync(fd);
		}) as typeof _internals.fsyncSync;
		_internals.renameSync = ((src: string, dest: string) => {
			calls.push('rename');
			return realRename(src, dest);
		}) as typeof _internals.renameSync;
		try {
			await atomicWriteSwarmFile(path.join(swarmDir, 'order.json'), '{}');
			expect(calls.indexOf('fsync')).toBeGreaterThanOrEqual(0);
			expect(calls.indexOf('fsync')).toBeLessThan(calls.lastIndexOf('rename'));
		} finally {
			_internals.fsyncSync = realFsync;
			_internals.renameSync = realRename;
		}
	});

	test('persistent rename failure: temp cleaned, PRIOR target preserved, error propagates', async () => {
		const target = path.join(swarmDir, 'keep.json');
		await atomicWriteSwarmFile(target, 'previous');
		const realRename = _internals.renameSync;
		_internals.renameSync = (() => {
			throw Object.assign(new Error('EPERM: locked'), { code: 'EPERM' });
		}) as typeof _internals.renameSync;
		try {
			await expect(atomicWriteSwarmFile(target, 'new')).rejects.toThrow(
				'EPERM: locked',
			);
		} finally {
			_internals.renameSync = realRename;
		}
		expect(readFileSync(target, 'utf-8')).toBe('previous');
		expect(readdirSync(swarmDir)).toEqual(['keep.json']);
	});

	test('transient EPERM on first rename is retried to success', async () => {
		const target = path.join(swarmDir, 'retry.json');
		const realRename = _internals.renameSync;
		let calls = 0;
		_internals.renameSync = ((src: string, dest: string) => {
			if (++calls === 1) {
				throw Object.assign(new Error('EPERM: transient'), { code: 'EPERM' });
			}
			return realRename(src, dest);
		}) as typeof _internals.renameSync;
		try {
			await atomicWriteSwarmFile(target, 'data');
		} finally {
			_internals.renameSync = realRename;
		}
		expect(readFileSync(target, 'utf-8')).toBe('data');
		expect(readdirSync(swarmDir)).toEqual(['retry.json']);
	});

	test('bounded write: payload above the override cap is rejected without touching the target', async () => {
		const target = path.join(swarmDir, 'cap.json');
		await expect(
			atomicWriteSwarmFile(target, 'x'.repeat(16), { maxBytes: 8 }),
		).rejects.toThrow(/byte bound/);
		expect(readdirSync(swarmDir)).toEqual([]);
	});

	test('N concurrent writers to the same target leave zero residue and a complete file', async () => {
		const target = path.join(swarmDir, 'concurrent.json');
		await Promise.all(
			Array.from({ length: 12 }, (_, i) =>
				atomicWriteSwarmFile(target, `payload-${i}`),
			),
		);
		expect(readFileSync(target, 'utf-8')).toMatch(/^payload-\d+$/);
		expect(readdirSync(swarmDir)).toEqual(['concurrent.json']);
	});

	test('sync variant mirrors the async core', () => {
		const target = path.join(swarmDir, 'sync.json');
		atomicWriteSwarmFileSync(target, 'sync-data');
		expect(readFileSync(target, 'utf-8')).toBe('sync-data');
		expect(readdirSync(swarmDir)).toEqual(['sync.json']);
	});
});

// ── PR-feedback round: PRR-019 persisted-contract pin ───────────────────────
