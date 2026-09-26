import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createIsolatedTestEnv } from '../../tests/helpers/isolated-test-env';
import { canonicalMkdtemp } from '../../tests/helpers/tmpdir';
import type { PluginConfig } from '../config/schema';
import {
	resolvePlanParallelizationFlag,
	runConfigDoctor,
	runConfigDoctorWithFixes,
} from '../services/config-doctor';

/**
 * Issue #2901 — the `worktree-isolation-baseline-active` advisory is keyed on
 * the settings that actually drive parallel dispatch: the plan execution
 * profile's `parallelization_enabled` plus the top-level `worktree.policy`.
 * The dark `parallelization` config block no longer triggers it on its own.
 *
 * Split from src/services/config-doctor.test.ts (over-cap under FR-006); the
 * two re-keyed #1552 policy-required / policy-disabled cases stay there.
 */

let cleanupEnv: (() => void) | undefined;
let tempDir: string;

function createTestConfigObj(
	overrides: Record<string, unknown> = {},
): PluginConfig {
	return {
		max_iterations: 5,
		config_format_version: 3,
		qa_retry_limit: 3,
		inject_phase_reminders: true,
		...overrides,
	} as PluginConfig;
}

beforeEach(() => {
	cleanupEnv = createIsolatedTestEnv().cleanup;
	tempDir = canonicalMkdtemp('worktree-advisory-2901-');
});

afterEach(() => {
	cleanupEnv?.();
	cleanupEnv = undefined;
});

describe('worktree-isolation advisory re-key (issue #2901)', () => {
	it('dark parallelization config alone no longer triggers the advisory', () => {
		const config = createTestConfigObj({
			parallelization: {
				enabled: true,
				maxConcurrentTasks: 2,
				evidenceLockTimeoutMs: 60000,
				max_coders: 3,
				max_reviewers: 2,
			},
		});

		// No plan flag supplied (no plan available): the dark block must not
		// produce the "already active" assurance on its own.
		const result = runConfigDoctor(config, tempDir);

		expect(
			result.findings.some(
				(f) => f.id === 'worktree-isolation-baseline-active',
			),
		).toBe(false);
	});

	it('plan execution profile plus default worktree policy triggers the advisory', () => {
		const config = createTestConfigObj({
			worktree: {
				policy: 'auto',
				merge_strategy: 'merge',
				deps_strategy: 'skip',
			},
		});

		const result = runConfigDoctor(config, tempDir, true);

		expect(
			result.findings.some(
				(f) => f.id === 'worktree-isolation-baseline-active',
			),
		).toBe(true);
	});

	it('plan execution profile with parallelization disabled does not trigger the advisory', () => {
		const config = createTestConfigObj({
			worktree: {
				policy: 'auto',
				merge_strategy: 'merge',
				deps_strategy: 'skip',
			},
		});

		const result = runConfigDoctor(config, tempDir, false);

		expect(
			result.findings.some(
				(f) => f.id === 'worktree-isolation-baseline-active',
			),
		).toBe(false);
	});

	it('resolvePlanParallelizationFlag returns null without a plan and feeds the async entry', async () => {
		const config = createTestConfigObj({
			parallelization: {
				enabled: true,
				maxConcurrentTasks: 2,
				evidenceLockTimeoutMs: 60000,
				max_coders: 3,
				max_reviewers: 2,
			},
		});

		// tempDir has no .swarm/plan.json, so the flag resolves to null and
		// the dark-key config must not trigger the advisory through the
		// async entry either.
		expect(await resolvePlanParallelizationFlag(tempDir)).toBeNull();

		const { result } = await runConfigDoctorWithFixes(tempDir, config, false);
		expect(
			result.findings.some(
				(f) => f.id === 'worktree-isolation-baseline-active',
			),
		).toBe(false);
	});
});
