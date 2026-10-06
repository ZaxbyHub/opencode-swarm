/**
 * "Feature disabled ⇒ identical to before" guarantee for Epic mode.
 * File: tests/unit/epic/disabled-passthrough.test.ts
 *
 * When `epic.cochange.enabled: false` (the default), the call site does
 * not fetch co-change pairs and passes `[]` to `epicPairConflict`. This file
 * verifies that under that condition the function reduces EXACTLY to the
 * path-only verdict that Lean Turbo would produce on its own — i.e. Epic-mode
 * code, when not opted into, has zero behavioral effect.
 *
 * This is the explicit acceptance criterion from design notes §15.7.
 */
import { describe, expect, test } from 'bun:test';
import {
	type CoChangeThreshold,
	epicPairConflict,
} from '../../../src/epic/cochange-conflict';
import {
	normalizePath,
	pathsConflict,
} from '../../../src/turbo/lean/conflicts';

const THRESHOLD: CoChangeThreshold = { npmi: 0.6, minCoChanges: 5 };

/**
 * Reduces (scopeA, scopeB) to the same boolean Lean Turbo's pair check would.
 * Lean Turbo's planner normalizes scope paths before calling `pathsConflict`
 * (see `src/turbo/lean/planner.ts:getValidatedFiles`); this helper mirrors
 * that so the comparison is apples-to-apples.
 */
function pathOnlyConflict(scopeA: string[], scopeB: string[]): boolean {
	const a = scopeA.map(normalizePath);
	const b = scopeB.map(normalizePath);
	return a.some((x) => b.some((y) => pathsConflict(x, y)));
}

/** Fixtures of scope pairs that exercise every path-conflict branch. */
const fixtures: Array<{ name: string; a: string[]; b: string[] }> = [
	{ name: 'identical single file', a: ['src/foo.ts'], b: ['src/foo.ts'] },
	{ name: 'disjoint files', a: ['src/a.ts'], b: ['src/b.ts'] },
	{
		name: 'parent/child directory',
		a: ['src/auth/'],
		b: ['src/auth/login.ts'],
	},
	{
		name: 'sibling files (no overlap)',
		a: ['src/auth/login.ts'],
		b: ['src/auth/logout.ts'],
	},
	{
		name: 'similar prefix but not segment match',
		a: ['src/authentication.ts'],
		b: ['src/auth/login.ts'],
	},
	{ name: 'multi-file overlap', a: ['src/a.ts', 'src/b.ts'], b: ['src/b.ts'] },
	{ name: 'multi-file disjoint', a: ['src/a.ts', 'src/c.ts'], b: ['src/b.ts'] },
	{ name: 'both empty', a: [], b: [] },
	{ name: 'one empty', a: ['src/a.ts'], b: [] },
	{
		name: 'windows-style paths normalize',
		a: ['src\\auth\\login.ts'],
		b: ['src\\auth\\login.ts'],
	},
];

describe('disabled passthrough — epicPairConflict with no co-change data', () => {
	for (const f of fixtures) {
		test(`fixture: ${f.name}`, () => {
			const v = epicPairConflict(f.a, f.b, [], THRESHOLD);
			expect(v.conflict).toBe(pathOnlyConflict(f.a, f.b));
			// When no cochange data is supplied, the verdict can never be
			// 'cochange' or 'both' — reason must be 'path' or 'none'.
			expect(v.reason === 'path' || v.reason === 'none').toBe(true);
			expect(v.evidence.cochangePairs).toEqual([]);
		});
	}
});

describe('disabled passthrough — config default leaves the signal off', () => {
	test('EpicConfigSchema defaults shape: cochange.enabled false, threshold conservative', async () => {
		// Import lazily so this test stands alone even if schema imports change.
		const { EpicConfigSchema } = await import('../../../src/config/schema');
		const parsed = EpicConfigSchema.safeParse({});
		expect(parsed.success).toBe(true);
		if (!parsed.success) return;
		// `cochange` is itself optional — omitted by default — so an empty
		// `epic` block is valid. When present, defaults must be conservative.
		const withDefaults = EpicConfigSchema.safeParse({ cochange: {} });
		expect(withDefaults.success).toBe(true);
		if (!withDefaults.success) return;
		expect(withDefaults.data.cochange?.enabled).toBe(false);
		expect(withDefaults.data.cochange?.threshold).toBe(0.6);
		expect(withDefaults.data.cochange?.min_co_changes).toBe(5);
	});

	test('EpicConfigSchema rejects unknown keys (strict mode) — typos surface, not silently default', async () => {
		const { EpicConfigSchema } = await import('../../../src/config/schema');
		// Typo at the top level.
		expect(
			EpicConfigSchema.safeParse({ cochnage: { enabled: true } }).success,
		).toBe(false);
		// Typo inside the cochange block (the case that historically passes
		// silently and uses the default — exactly what `.strict()` prevents).
		expect(
			EpicConfigSchema.safeParse({ cochange: { thresholds: 0.7 } }).success,
		).toBe(false);
	});

	test('EpicConfigSchema enforces threshold bounds [-1, 1]', async () => {
		const { EpicConfigSchema } = await import('../../../src/config/schema');
		expect(
			EpicConfigSchema.safeParse({ cochange: { threshold: 1.5 } }).success,
		).toBe(false);
		expect(
			EpicConfigSchema.safeParse({ cochange: { threshold: -1.5 } }).success,
		).toBe(false);
		expect(
			EpicConfigSchema.safeParse({ cochange: { threshold: 0 } }).success,
		).toBe(true);
	});
});

describe('co-change analyzer _internals contract (catches upstream renames)', () => {
	test('the analyzer still exports the primitives the Epic source composes', async () => {
		// This is a contract test: if a future upstream change renames or
		// removes `parseGitLog` / `buildCoChangeMatrix` on the analyzer's
		// `_internals`, the Epic-mode source breaks at runtime but our
		// stub-based unit tests would still pass. This test directly imports
		// the real analyzer and asserts the surface we depend on.
		const analyzer = await import('../../../src/tools/co-change-analyzer');
		expect(typeof analyzer._internals).toBe('object');
		expect(typeof analyzer._internals.parseGitLog).toBe('function');
		expect(typeof analyzer._internals.buildCoChangeMatrix).toBe('function');
	});
});
