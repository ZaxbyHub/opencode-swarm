/**
 * #3350 AC2 (PR #3327 follow-up) — behavioural pin of the v2 cleanup dispose
 * budgets (PRESERVING: green at base AND head).
 *
 * GAP (issue evidence item 2): the dispose budgets in src/host/v2/setup.ts
 * (per-registration dispose, v1 dispose) were pinned only by static
 * source-regex tests in tests/unit/host/v2/setup-registration-budget-3327.test.ts
 * — a regex-only pin survives semantically equivalent rewrites. This file
 * closes that gap with behaviour: a dispose that takes measurably longer than
 * zero but far under the generous 60 s budget must be AWAITED to completion by
 * cleanup, with no dispose-budget failure surfaced.
 *
 * MUTANT COVERAGE NOTE (per the issue's stability guidance,
 * docs/testing/test-stability.md): the 3_500 mutant (V2_SETUP_TIMEOUT_MS
 * lowered to 3_500) is covered by the Phase 4 named-mutant probe; this file
 * deliberately avoids multi-second sleeps. It DOES carry a fast deterministic
 * sub-budget mutant-killer: a 150 ms registration dispose must complete BEFORE
 * cleanup() resolves, which kills any mutant that lowers the dispose budget
 * below 150 ms (e.g. to 100 ms — withTimeout would abandon the dispose and
 * cleanup would return while disposeDone is still false).
 *
 * No mock.module; plain-object fakes only.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { clearV2AgentTransformSurface } from '../../../../src/host/v2/model-apply';
import { openCodeSwarmV2Setup } from '../../../../src/host/v2/setup';
import type { V1HooksSubset } from '../../../../src/host/v2/types';
import {
	clearDeferredWarnings,
	getDeferredWarnings,
} from '../../../../src/services/warning-buffer';
import { resetSwarmState } from '../../../../src/state';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../../helpers/tmpdir';

interface Registration {
	dispose: () => Promise<void>;
}

/** Build a fast fake v2 Context; `slowRegistration` replaces the tool.transform result. */
function buildCtx(
	directory: string,
	slowRegistration?: Registration,
): Record<string, unknown> {
	const registration = (): Registration => ({ dispose: async () => {} });
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
				return Promise.resolve(slowRegistration ?? registration());
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

const disposeWarnings = () =>
	getDeferredWarnings().filter((w) => /dispose/i.test(w));

const tempDirs: string[] = [];

afterEach(async () => {
	clearV2AgentTransformSurface();
	resetSwarmState();
	clearDeferredWarnings();
	for (const dir of tempDirs.splice(0)) {
		await removeTreeWithRetry(dir);
	}
});

describe('#3350 AC2 dispose budgets (behavioural pin, preserving)', () => {
	test('a 150ms registration dispose completes within the generous cleanup budget and surfaces no dispose-budget warning (kills a sub-150ms budget mutant)', async () => {
		const dir = canonicalMkdtemp('v2-dispose-budget-3350-');
		tempDirs.push(dir);
		let disposeDone = false;
		const slowRegistration: Registration = {
			dispose: async () => {
				await Bun.sleep(150);
				disposeDone = true;
			},
		};
		const cleanup = await openCodeSwarmV2Setup(
			buildCtx(dir, slowRegistration) as never,
			{ runInit: async () => makeHooks() },
		);

		await cleanup();

		// cleanup() must AWAIT the 150ms dispose (generous 60s budget): if the
		// budget were lowered below 150ms, withTimeout would reject, cleanup
		// would proceed, and disposeDone would still be false here.
		expect(disposeDone).toBe(true);
		expect(disposeWarnings()).toEqual([]);
	}, 15_000);

	test('a ~50ms v1 dispose completes with no dispose-budget warning', async () => {
		const dir = canonicalMkdtemp('v2-v1dispose-budget-3350-');
		tempDirs.push(dir);
		let v1DisposeDone = false;
		const hooks = {
			config: (c: Record<string, unknown>) => {
				c.agent = {};
				c.command = {};
			},
			dispose: async () => {
				await Bun.sleep(50);
				v1DisposeDone = true;
			},
		} as unknown as V1HooksSubset;
		const cleanup = await openCodeSwarmV2Setup(buildCtx(dir) as never, {
			runInit: async () => hooks,
		});

		await cleanup();

		expect(v1DisposeDone).toBe(true);
		expect(disposeWarnings()).toEqual([]);
	}, 15_000);
});
