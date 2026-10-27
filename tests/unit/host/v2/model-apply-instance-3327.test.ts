/**
 * #3352 AC3 (PR #3327 follow-up) — the v2 agent-transform surface must be
 * owned per setup instance, not held in module globals.
 *
 * DEFECT (base 8e5cfd387, src/host/v2/model-apply.ts): `registeredTransform`
 * (L30) and `registrationsByAgent` (L45) are module globals, and the cleanup
 * returned by openCodeSwarmV2Setup calls the UNCONDITIONAL global
 * `clearV2AgentTransformSurface()` (setup.ts L355). One instance's cleanup
 * therefore destroys every other live instance's surface (and a later
 * registerV2AgentTransformSurface overwrites the earlier instance's
 * transform).
 *
 * CONTRACT this file pins on the implementer, observed entirely through the
 * PUBLIC setup/cleanup seam (no dependency on the post-fix internal API):
 *  1. When two setup instances are live, the cleanup of instance A must NOT
 *     clear the transform surface registered by instance B
 *     (hasV2AgentTransformSurface() stays true after A's cleanup).
 *  2. After BOTH instances clean up, no surface remains (no leak).
 *  3. Single-instance behaviour is unchanged: cleanup clears its own surface.
 *
 * No mock.module; plain-object fakes only (fast-ctx pattern from
 * setup-registration-budget-3327.test.ts / adapter-lifecycle.test.ts).
 */

import { afterEach, describe, expect, test } from 'bun:test';
import {
	clearV2AgentTransformSurface,
	hasV2AgentTransformSurface,
} from '../../../../src/host/v2/model-apply';
import { openCodeSwarmV2Setup } from '../../../../src/host/v2/setup';
import type { V1HooksSubset } from '../../../../src/host/v2/types';
import { clearDeferredWarnings } from '../../../../src/services/warning-buffer';
import { resetSwarmState } from '../../../../src/state';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../../helpers/tmpdir';

/** A fast, fully-resolving fake v2 Context (every domain registers instantly). */
function buildFastCtx(directory: string): Record<string, unknown> {
	const registration = () => ({ dispose: async () => {} });
	const agentEditor = {
		update: () => {},
		remove: () => {},
		list: () => [],
	};
	return {
		location: { directory },
		agent: {
			transform: async (fn: (editor: unknown) => void) => {
				fn(agentEditor);
				return registration();
			},
			reload: async () => {},
		},
		command: {
			transform: async (fn: (editor: { add: () => void }) => void) => {
				fn({ add: () => {} });
				return registration();
			},
			reload: async () => {},
		},
		tool: {
			transform: (fn: (editor: { add: () => void }) => void) => {
				fn({ add: () => {} });
				return Promise.resolve(registration());
			},
			hook: async () => registration(),
		},
		session: { hook: async () => registration() },
		event: {},
	};
}

const makeHooks = (): V1HooksSubset =>
	({
		config: (c: Record<string, unknown>) => {
			c.agent = {};
			c.command = {};
		},
		dispose: async () => {},
	}) as unknown as V1HooksSubset;

const tempDirs: string[] = [];

const runSetup = async (suffix: string) => {
	const dir = canonicalMkdtemp(`v2-mapply-instance-${suffix}-`);
	tempDirs.push(dir);
	return openCodeSwarmV2Setup(buildFastCtx(dir) as never, {
		runInit: async () => makeHooks(),
	});
};

afterEach(async () => {
	clearV2AgentTransformSurface();
	resetSwarmState();
	clearDeferredWarnings();
	for (const dir of tempDirs.splice(0)) {
		await removeTreeWithRetry(dir);
	}
});

describe('#3352 model-apply surface: per-instance ownership', () => {
	test("one instance's cleanup must not clear another live instance's surface (base: global clear -> red)", async () => {
		const cleanupA = await runSetup('a');
		const cleanupB = await runSetup('b');
		// Both instances registered an agent transform surface.
		expect(hasV2AgentTransformSurface()).toBe(true);

		// Instance A tears down. B is still live, so its surface must survive —
		// at base cleanupA calls the module-global clearV2AgentTransformSurface()
		// and B's surface is destroyed (hasV2AgentTransformSurface() false).
		await cleanupA();
		expect(hasV2AgentTransformSurface()).toBe(true);

		// After BOTH instances clean up, nothing leaks.
		await cleanupB();
		expect(hasV2AgentTransformSurface()).toBe(false);
	});

	test('single-instance cleanup still clears its own surface (preserving; green both ends)', async () => {
		const cleanup = await runSetup('single');
		expect(hasV2AgentTransformSurface()).toBe(true);
		await cleanup();
		expect(hasV2AgentTransformSurface()).toBe(false);
	});

	test('a later instance re-registering after an earlier cleanup leaves a live surface (ordering sanity; green both ends)', async () => {
		const cleanupFirst = await runSetup('first');
		await cleanupFirst();
		expect(hasV2AgentTransformSurface()).toBe(false);
		// A NEW setup after a full cleanup re-establishes the surface.
		const cleanupSecond = await runSetup('second');
		expect(hasV2AgentTransformSurface()).toBe(true);
		await cleanupSecond();
		expect(hasV2AgentTransformSurface()).toBe(false);
	});
});
