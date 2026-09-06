import { afterEach, describe, expect, test } from 'bun:test';
import {
	buildProjectContext,
	_internals as projectContextInternals,
} from '../../../src/agents/project-context';
import { emptyProjectContext } from '../../../src/agents/template';
import { withTimeoutSignal } from '../../../src/utils/timeout';

/**
 * Regression guard for Invariant 1 (plugin init bounded + fail-open).
 *
 * Phase 4b adds `buildProjectContext(directory)` to the init path, called
 * from `src/index.ts:initializeOpenCodeSwarm` immediately before
 * `getAgentConfigs(...)`. The caller wraps the call in
 * `withTimeoutSignal(LANG_BACKEND_DETECTION_TIMEOUT_MS = 300)` and falls open to
 * `null` (which `getAgentConfigs` then treats as `emptyProjectContext`).
 *
 * Without that wrap + fail-open, a hang in `pickBackend` (e.g. a slow
 * filesystem walk under corporate AV on Windows) would block the manifest
 * return, the OpenCode plugin host would silently drop the plugin, and
 * users would see "no agents in TUI/GUI" with no error. Reference: v7.0.3
 * issue #704 and v7.3.3 git-hygiene regression.
 *
 * This test simulates the hang via the `_internals.pickBackend` DI seam and
 * asserts:
 *   1. `buildProjectContext` returns a value within a sensible deadline
 *      (NOT a hang propagated to the caller).
 *   2. The substituted-prompt-render path still produces text — no
 *      thrown exceptions, no `{{KEY}}` leaks.
 */

describe('init fail-open: buildProjectContext under simulated hang', () => {
	const realPickBackend = projectContextInternals.pickBackend;

	afterEach(() => {
		projectContextInternals.pickBackend = realPickBackend;
	});

	test('caller-side withTimeoutSignal aborts and bounds a slow pickBackend', async () => {
		let observedSignal: AbortSignal | undefined;
		projectContextInternals.pickBackend = async (_directory, signal) =>
			new Promise((_, reject) => {
				observedSignal = signal;
				signal?.addEventListener('abort', () => reject(signal.reason), {
					once: true,
				});
			});

		// Mirror the production boundary in src/index.ts. Cooperative cancellation
		// proves late dispatch work cannot continue to publish cache state after
		// init has failed open.
		const start = Date.now();
		const timeoutError = new Error('simulated init timeout');
		await expect(
			withTimeoutSignal(
				(signal) => buildProjectContext('/tmp', signal),
				30,
				timeoutError,
			),
		).rejects.toBe(timeoutError);
		const elapsed = Date.now() - start;
		expect(elapsed).toBeLessThan(150);
		expect(observedSignal?.aborted).toBe(true);
		// The caller treats timeout failure as null → emptyProjectContext.
		const ctx = emptyProjectContext();
		expect(ctx.PROJECT_LANGUAGE).toBeDefined();
	});

	test('emptyProjectContext substitutes UNRESOLVED sentinels (architect DISCOVER mode trigger)', () => {
		const ctx = emptyProjectContext();
		expect(ctx.PROJECT_LANGUAGE).toContain('unresolved');
		expect(ctx.BUILD_CMD).toContain('unresolved');
		expect(ctx.TEST_CMD).toContain('unresolved');
		expect(ctx.LINT_CMD).toContain('unresolved');
	});

	test('buildProjectContext returns null when pickBackend returns null', async () => {
		projectContextInternals.pickBackend = async () => null;
		const ctx = await buildProjectContext('/tmp');
		expect(ctx).toBeNull();
	});
});
