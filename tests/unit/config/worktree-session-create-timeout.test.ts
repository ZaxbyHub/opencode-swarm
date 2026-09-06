import { describe, expect, test } from 'bun:test';
import { DEFAULT_WORKTREE_ISOLATION_CONFIG } from '../../../src/config/constants';
import { WorktreeIsolationConfigSchema } from '../../../src/config/schema';
import { resolveWorktreeIsolationConfig } from '../../../src/config/worktree-isolation-config';

describe('worktree.session_create_timeout_ms (issue #2599)', () => {
	test('defaults to 30000 and mirrors DEFAULT_WORKTREE_ISOLATION_CONFIG', () => {
		const parsed = WorktreeIsolationConfigSchema.parse({});
		expect(parsed.session_create_timeout_ms).toBe(30_000);
		expect(DEFAULT_WORKTREE_ISOLATION_CONFIG.session_create_timeout_ms).toBe(
			30_000,
		);
	});

	test('accepts the documented bounds (1000..120000, inclusive edges)', () => {
		expect(
			WorktreeIsolationConfigSchema.safeParse({
				session_create_timeout_ms: 1000,
			}).success,
		).toBe(true);
		expect(
			WorktreeIsolationConfigSchema.safeParse({
				session_create_timeout_ms: 120000,
			}).success,
		).toBe(true);
	});

	test('rejects 0, non-integers, and out-of-range values', () => {
		for (const bad of [0, 999, 120001, 1500.5, 30_000.5]) {
			expect(
				WorktreeIsolationConfigSchema.safeParse({
					session_create_timeout_ms: bad,
				}).success,
			).toBe(false);
		}
	});

	test('override survives PluginConfig-style resolution', () => {
		const resolved = resolveWorktreeIsolationConfig({
			worktree: { policy: 'auto', session_create_timeout_ms: 45_000 },
		} as Parameters<typeof resolveWorktreeIsolationConfig>[0]);
		expect(resolved.session_create_timeout_ms).toBe(45_000);
	});

	test('absent override resolves to the default', () => {
		const resolved = resolveWorktreeIsolationConfig({
			worktree: { policy: 'auto' },
		} as Parameters<typeof resolveWorktreeIsolationConfig>[0]);
		expect(resolved.session_create_timeout_ms).toBe(30_000);
	});

	test('lean-turbo synthesis resolves to the default (worktree_isolation is a boolean flag, not a knob surface — BOT-2 refuted)', () => {
		const resolved = resolveWorktreeIsolationConfig({
			worktree: undefined,
			turbo: {
				strategy: 'lean',
				lean: { merge_strategy: 'merge', worktree_isolation: true },
			},
		} as unknown as Parameters<typeof resolveWorktreeIsolationConfig>[0]);
		expect(resolved.session_create_timeout_ms).toBe(30_000);
	});
});
