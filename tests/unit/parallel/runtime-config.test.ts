import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { PluginConfig } from '../../../src/config';
import { resolveStandardParallelizationConfig } from '../../../src/parallel/runtime-config';

let dirs: string[] = [];

function tempProject(): string {
	const dir = mkdtempSync(path.join(tmpdir(), 'swarm-parallel-config-'));
	dirs.push(dir);
	mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	return dir;
}

function writePlan(dir: string, executionProfile?: unknown): void {
	writeFileSync(
		path.join(dir, '.swarm', 'plan.json'),
		JSON.stringify({
			title: 'test',
			phases: [],
			...(executionProfile ? { execution_profile: executionProfile } : {}),
		}),
	);
}

afterEach(() => {
	for (const dir of dirs) {
		rmSync(dir, { recursive: true, force: true });
	}
	dirs = [];
});

describe('resolveStandardParallelizationConfig', () => {
	test('absent config preserves current Stage B barrier but disables coder fan-out', () => {
		const dir = tempProject();
		writePlan(dir);

		const result = resolveStandardParallelizationConfig(undefined, dir);

		expect(result.source).toBe('current-default');
		expect(result.stageBParallelEnabled).toBe(true);
		expect(result.taskFanoutEnabled).toBe(false);
		expect(result.maxConcurrentTasks).toBe(1);
	});

	test('missing plan.json falls back to current default when no global config exists', () => {
		const dir = tempProject();

		const result = resolveStandardParallelizationConfig(undefined, dir);

		expect(result.source).toBe('current-default');
		expect(result.stageBParallelEnabled).toBe(true);
		expect(result.taskFanoutEnabled).toBe(false);
		expect(result.maxConcurrentTasks).toBe(1);
	});

	test('malformed plan.json falls back to current default without throwing', () => {
		const dir = tempProject();
		writeFileSync(path.join(dir, '.swarm', 'plan.json'), '{not-json');

		const result = resolveStandardParallelizationConfig(undefined, dir);

		expect(result.source).toBe('current-default');
		expect(result.stageBParallelEnabled).toBe(true);
		expect(result.taskFanoutEnabled).toBe(false);
		expect(result.maxConcurrentTasks).toBe(1);
	});

	test('explicit disabled config disables standard parallel behavior', () => {
		const dir = tempProject();
		writePlan(dir);

		const result = resolveStandardParallelizationConfig(
			{ parallelization: { enabled: false } } as PluginConfig,
			dir,
		);

		expect(result.source).toBe('global-config');
		expect(result.stageBParallelEnabled).toBe(false);
		expect(result.taskFanoutEnabled).toBe(false);
		expect(result.maxConcurrentTasks).toBe(1);
	});

	test('explicit enabled config resolves concurrency and evidence lock timeout', () => {
		const dir = tempProject();
		writePlan(dir);

		const result = resolveStandardParallelizationConfig(
			{
				parallelization: {
					enabled: true,
					maxConcurrentTasks: 3,
					evidenceLockTimeoutMs: 1234,
					max_coders: 3,
					max_reviewers: 2,
				},
			} as PluginConfig,
			dir,
		);

		expect(result.source).toBe('global-config');
		expect(result.stageBParallelEnabled).toBe(true);
		expect(result.taskFanoutEnabled).toBe(true);
		expect(result.maxConcurrentTasks).toBe(3);
		expect(result.evidenceLockTimeoutMs).toBe(1234);
	});

	test('locked disabled plan profile overrides global enabled config', () => {
		const dir = tempProject();
		writePlan(dir, {
			parallelization_enabled: false,
			max_concurrent_tasks: 4,
			locked: true,
		});

		const result = resolveStandardParallelizationConfig(
			{
				parallelization: {
					enabled: true,
					maxConcurrentTasks: 4,
					evidenceLockTimeoutMs: 60000,
					max_coders: 3,
					max_reviewers: 2,
				},
			} as PluginConfig,
			dir,
		);

		expect(result.source).toBe('locked-profile');
		expect(result.stageBParallelEnabled).toBe(false);
		expect(result.taskFanoutEnabled).toBe(false);
		expect(result.maxConcurrentTasks).toBe(1);
	});

	test('locked enabled plan profile uses stricter max concurrency', () => {
		const dir = tempProject();
		writePlan(dir, {
			parallelization_enabled: true,
			max_concurrent_tasks: 2,
			locked: true,
		});

		const result = resolveStandardParallelizationConfig(
			{
				parallelization: {
					enabled: true,
					maxConcurrentTasks: 5,
					evidenceLockTimeoutMs: 60000,
					max_coders: 3,
					max_reviewers: 2,
				},
			} as PluginConfig,
			dir,
		);

		expect(result.source).toBe('locked-profile');
		expect(result.stageBParallelEnabled).toBe(true);
		expect(result.taskFanoutEnabled).toBe(true);
		expect(result.maxConcurrentTasks).toBe(2);
	});

	test('locked enabled plan profile can enable parallelization when global config is absent', () => {
		const dir = tempProject();
		writePlan(dir, {
			parallelization_enabled: true,
			max_concurrent_tasks: 2,
			locked: true,
		});

		const result = resolveStandardParallelizationConfig(undefined, dir);

		expect(result.source).toBe('locked-profile');
		expect(result.stageBParallelEnabled).toBe(true);
		expect(result.taskFanoutEnabled).toBe(true);
		expect(result.maxConcurrentTasks).toBe(2);
	});

	test('global disabled config is a hard cap over locked enabled plan profile', () => {
		const dir = tempProject();
		writePlan(dir, {
			parallelization_enabled: true,
			max_concurrent_tasks: 4,
			locked: true,
		});

		const result = resolveStandardParallelizationConfig(
			{ parallelization: { enabled: false } } as PluginConfig,
			dir,
		);

		expect(result.source).toBe('global-config');
		expect(result.stageBParallelEnabled).toBe(false);
		expect(result.taskFanoutEnabled).toBe(false);
		expect(result.maxConcurrentTasks).toBe(1);
	});

	test('invalid locked plan profile is ignored instead of producing NaN limits', () => {
		const dir = tempProject();
		writePlan(dir, {
			parallelization_enabled: true,
			max_concurrent_tasks: 'not-a-number',
			locked: true,
		});

		const result = resolveStandardParallelizationConfig(undefined, dir);

		expect(result.source).toBe('current-default');
		expect(Number.isFinite(result.maxConcurrentTasks)).toBe(true);
		expect(result.maxConcurrentTasks).toBe(1);
	});
});
