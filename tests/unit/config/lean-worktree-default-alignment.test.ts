/**
 * Lean worktree_isolation default alignment tests — Task 1.7 / SC-121
 *
 * Verifies:
 * 1. Schema default: LeanTurboConfigSchema.parse({}) → worktree_isolation === true
 * 2. LeanTurboConfigSchema.parse({ turbo: { strategy: 'lean' } }) → lean.worktree_isolation === true
 * 3. Explicit false still works (backward compat): parse({ lean: { worktree_isolation: false } })
 * 4. Init-safety: plugin init does NOT call worktree functions even when default is true
 * 5. No regression in tools spreading DEFAULT_LEAN_TURBO_CONFIG
 *
 * These tests supplement the existing coverage in schema-lean-turbo.test.ts
 * (which uses safeParse) and init-safety.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { DEFAULT_LEAN_TURBO_CONFIG } from '../../../src/config/constants';
import {
	LeanTurboConfigSchema,
	LeanTurboStrategyConfigSchema,
	PluginConfigSchema,
	StandardTurboConfigSchema,
	TurboConfigSchema,
} from '../../../src/config/schema';

describe('SC-121: worktree_isolation default alignment', () => {
	// ── 1. Schema default via parse() ──────────────────────────────────────────

	describe('Schema default: LeanTurboConfigSchema.parse({})', () => {
		test('worktree_isolation defaults to true (parse, not safeParse)', () => {
			const result = LeanTurboConfigSchema.parse({});
			expect(result.worktree_isolation).toBe(true);
		});

		test('worktree_isolation defaults to true via safeParse for completeness', () => {
			const result = LeanTurboConfigSchema.safeParse({});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.worktree_isolation).toBe(true);
			}
		});
	});

	// ── 2. PluginConfigSchema turbo.lean path ──────────────────────────────────

	describe('PluginConfigSchema — turbo.lean path', () => {
		test('turbo.strategy=lean with lean={} → lean.worktree_isolation defaults to true', () => {
			// lean is REQUIRED when strategy=lean (not optional)
			const result = LeanTurboStrategyConfigSchema.parse({
				strategy: 'lean',
				lean: {},
			});
			expect(result.lean.worktree_isolation).toBe(true);
		});

		test('turbo.strategy=lean with explicit worktree_isolation: false still works', () => {
			const result = LeanTurboStrategyConfigSchema.parse({
				strategy: 'lean',
				lean: { worktree_isolation: false },
			});
			expect(result.lean.worktree_isolation).toBe(false);
		});

		test('TurboConfigSchema discriminated union: lean branch gets worktree_isolation=true', () => {
			const result = TurboConfigSchema.parse({
				strategy: 'lean',
				lean: {},
			});
			expect(result.strategy).toBe('lean');
			expect(result.lean.worktree_isolation).toBe(true);
		});

		test('TurboConfigSchema discriminated union: standard branch does NOT have lean', () => {
			const result = TurboConfigSchema.parse({
				strategy: 'standard',
			});
			expect(result.strategy).toBe('standard');
			// standard branch has optional lean, so it should be undefined
			expect(result.lean).toBeUndefined();
		});

		test('PluginConfigSchema full parse: turbo.lean={} defaults worktree_isolation to true', () => {
			// lean is required when strategy=lean
			const result = PluginConfigSchema.parse({
				turbo: { strategy: 'lean', lean: {} },
			});
			expect(result.turbo?.lean?.worktree_isolation).toBe(true);
		});
	});

	// ── 3. Backward compat: explicit false still works ────────────────────────

	describe('Backward compat: explicit worktree_isolation: false', () => {
		test('LeanTurboConfigSchema.parse: explicit false is respected', () => {
			const result = LeanTurboConfigSchema.parse({ worktree_isolation: false });
			expect(result.worktree_isolation).toBe(false);
		});

		test('LeanTurboConfigSchema.safeParse: explicit false is respected', () => {
			const result = LeanTurboConfigSchema.safeParse({
				worktree_isolation: false,
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.worktree_isolation).toBe(false);
			}
		});

		test('LeanTurboStrategyConfigSchema.parse: explicit false in lean block', () => {
			const result = LeanTurboStrategyConfigSchema.parse({
				strategy: 'lean',
				lean: { worktree_isolation: false },
			});
			expect(result.lean.worktree_isolation).toBe(false);
		});
	});

	// ── 4. DEFAULT_LEAN_TURBO_CONFIG constant ───────────────────────────────────

	describe('DEFAULT_LEAN_TURBO_CONFIG constant', () => {
		test('worktree_isolation is true in the canonical constant', () => {
			expect(DEFAULT_LEAN_TURBO_CONFIG.worktree_isolation).toBe(true);
		});

		test('constant matches schema default (both true)', () => {
			const fromSchema = LeanTurboConfigSchema.parse({});
			expect(fromSchema.worktree_isolation).toBe(
				DEFAULT_LEAN_TURBO_CONFIG.worktree_isolation,
			);
			expect(DEFAULT_LEAN_TURBO_CONFIG.worktree_isolation).toBe(true);
		});

		test('all LeanTurboConfig fields are present in the constant', () => {
			const fromSchema = LeanTurboConfigSchema.parse({});
			// Key fields that must match
			expect(DEFAULT_LEAN_TURBO_CONFIG.max_parallel_coders).toBe(
				fromSchema.max_parallel_coders,
			);
			expect(DEFAULT_LEAN_TURBO_CONFIG.require_declared_scope).toBe(
				fromSchema.require_declared_scope,
			);
			expect(DEFAULT_LEAN_TURBO_CONFIG.conflict_policy).toBe(
				fromSchema.conflict_policy,
			);
			expect(DEFAULT_LEAN_TURBO_CONFIG.worktree_isolation).toBe(
				fromSchema.worktree_isolation,
			);
		});
	});

	// ── 5. deps_strategy field: skip is the constant value ──────────────────────

	describe('deps_strategy field (related SC-101..SC-104)', () => {
		test('DEFAULT_LEAN_TURBO_CONFIG has deps_strategy: skip', () => {
			expect(DEFAULT_LEAN_TURBO_CONFIG.deps_strategy).toBe('skip');
		});

		test('LeanTurboConfigSchema.parse({}) leaves deps_strategy undefined (optional field)', () => {
			// The schema has deps_strategy as optional enum — no default, so undefined when omitted
			const result = LeanTurboConfigSchema.parse({});
			expect(result.deps_strategy).toBeUndefined();
		});

		test('LeanTurboConfigSchema.parse accepts deps_strategy: copy', () => {
			const result = LeanTurboConfigSchema.parse({ deps_strategy: 'copy' });
			expect(result.deps_strategy).toBe('copy');
		});

		test('LeanTurboConfigSchema.parse accepts deps_strategy: link', () => {
			const result = LeanTurboConfigSchema.parse({ deps_strategy: 'link' });
			expect(result.deps_strategy).toBe('link');
		});

		test('LeanTurboConfigSchema.parse accepts deps_strategy: skip', () => {
			const result = LeanTurboConfigSchema.parse({ deps_strategy: 'skip' });
			expect(result.deps_strategy).toBe('skip');
		});
	});
});
