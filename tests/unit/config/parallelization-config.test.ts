import { describe, expect, test } from 'bun:test';
import {
	ParallelizationConfigSchema,
	PluginConfigSchema,
	WorktreeIsolationConfigSchema,
} from '../../../src/config/schema';

describe('ParallelizationConfigSchema', () => {
	test('defaults: enabled is false', () => {
		const result = ParallelizationConfigSchema.parse({});
		expect(result.enabled).toBe(false);
	});

	test('defaults: maxConcurrentTasks is 1 (serial)', () => {
		const result = ParallelizationConfigSchema.parse({});
		expect(result.maxConcurrentTasks).toBe(1);
	});

	test('defaults: evidenceLockTimeoutMs is 60000', () => {
		const result = ParallelizationConfigSchema.parse({});
		expect(result.evidenceLockTimeoutMs).toBe(60000);
	});

	test('accepts explicit enabled: true (for future use)', () => {
		const result = ParallelizationConfigSchema.parse({ enabled: true });
		expect(result.enabled).toBe(true);
	});

	test('accepts custom maxConcurrentTasks', () => {
		const result = ParallelizationConfigSchema.parse({ maxConcurrentTasks: 4 });
		expect(result.maxConcurrentTasks).toBe(4);
	});

	test('accepts custom evidenceLockTimeoutMs', () => {
		const result = ParallelizationConfigSchema.parse({
			evidenceLockTimeoutMs: 30000,
		});
		expect(result.evidenceLockTimeoutMs).toBe(30000);
	});

	test('rejects maxConcurrentTasks below 1', () => {
		expect(() =>
			ParallelizationConfigSchema.parse({ maxConcurrentTasks: 0 }),
		).toThrow();
	});

	test('rejects evidenceLockTimeoutMs below 1000', () => {
		expect(() =>
			ParallelizationConfigSchema.parse({ evidenceLockTimeoutMs: 500 }),
		).toThrow();
	});
});

describe('PluginConfigSchema — parallelization field', () => {
	test('parallelization is optional — absent by default', () => {
		const result = PluginConfigSchema.parse({});
		expect(result.parallelization).toBeUndefined();
	});

	test('parallelization field accepts default-off config object', () => {
		const result = PluginConfigSchema.parse({
			parallelization: { enabled: false },
		});
		expect(result.parallelization?.enabled).toBe(false);
		expect(result.parallelization?.maxConcurrentTasks).toBe(1);
		expect(result.parallelization?.evidenceLockTimeoutMs).toBe(60000);
	});

	test('no production branching: default-absent parallelization is falsy', () => {
		const result = PluginConfigSchema.parse({});
		// Prove that no code can accidentally activate parallel execution
		// via the default-parsed config.
		expect(result.parallelization?.enabled).toBeUndefined();
		// Defensive check: if someone reads .enabled on the absent field,
		// they get undefined (falsy), not true.
		const enabled = result.parallelization?.enabled;
		expect(enabled).toBeFalsy();
	});
});

describe('WorktreeIsolationConfigSchema', () => {
	test('defaults to auto isolation with merge strategy and no custom directory', () => {
		const result = WorktreeIsolationConfigSchema.parse({});
		expect(result.policy).toBe('auto');
		expect(result.merge_strategy).toBe('merge');
		expect(result.deps_strategy).toBe('skip');
		expect(result.worktree_dir).toBeUndefined();
	});

	test('accepts required policy with rebase merge-back', () => {
		const result = WorktreeIsolationConfigSchema.parse({
			policy: 'required',
			merge_strategy: 'rebase',
			worktree_dir: '.swarm-worktrees',
		});
		expect(result.policy).toBe('required');
		expect(result.merge_strategy).toBe('rebase');
		expect(result.worktree_dir).toBe('.swarm-worktrees');
	});

	test('rejects invalid policy values', () => {
		expect(() =>
			WorktreeIsolationConfigSchema.parse({ policy: 'best-effort' }),
		).toThrow();
	});
});

describe('PluginConfigSchema — worktree isolation field', () => {
	test('worktree field is optional and absent by default', () => {
		const result = PluginConfigSchema.parse({});
		expect(result.worktree).toBeUndefined();
	});

	test('worktree field parses standard parallel isolation policy', () => {
		const result = PluginConfigSchema.parse({
			worktree: {
				policy: 'required',
				merge_strategy: 'cherry-pick',
				deps_strategy: 'copy',
			},
		});
		expect(result.worktree?.policy).toBe('required');
		expect(result.worktree?.merge_strategy).toBe('cherry-pick');
		expect(result.worktree?.deps_strategy).toBe('copy');
	});
});
