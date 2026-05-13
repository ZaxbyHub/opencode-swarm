import { describe, expect, test } from 'bun:test';
import {
	ParallelizationConfigSchema,
	PluginConfigSchema,
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
