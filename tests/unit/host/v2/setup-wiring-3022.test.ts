import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	clearV2AgentTransformSurface,
	hasV2AgentTransformSurface,
} from '../../../../src/host/v2/model-apply';
import { openCodeSwarmV2Setup } from '../../../../src/host/v2/setup';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../../helpers/tmpdir';

/**
 * Issue #3022 review round 1 (implementation-review finding 2): the four
 * wiring lines that make AC3/AC4 actually run — setup's
 * `registerV2AgentTransformSurface(ctx)`, setup's
 * `deferredV2StartupModelPreflight(directory)` invocation, and index.ts's two
 * `applyV2AgentModelOverride(...)` call sites — were mutation-proof (deleting
 * any left every test green). This suite pins them two ways:
 *
 * 1. FUNCTIONAL: a real `openCodeSwarmV2Setup` run against a fake v2 ctx must
 *    leave the agent-transform surface REGISTERED (and clear it on cleanup).
 * 2. SOURCE-CONTRACT: the wiring call lines must exist verbatim in
 *    src/host/v2/setup.ts and src/index.ts (same pin style as
 *    event-name-contract-3022.test.ts) so deletion of any wiring line fails a
 *    test even where a functional harness cannot reach.
 */

function fakeCtx(directory: string): {
	ctx: unknown;
	transforms: number;
} {
	const state = { transforms: 0 };
	const registration = { dispose: async () => {} };
	const makeTransform = () => {
		state.transforms += 1;
		return async (fn: (editor: unknown) => void) => {
			fn({ update: () => {}, remove: () => {}, list: () => [] });
			return registration;
		};
	};
	const ctx = {
		location: { directory },
		agent: { transform: makeTransform() },
		command: { transform: makeTransform() },
		tool: { transform: makeTransform(), hook: async () => registration },
		session: { hook: async () => registration },
		event: {},
	};
	return { ctx, transforms: state.transforms };
}

describe('#3022 v2 setup wiring (functional)', () => {
	afterEach(() => {
		clearV2AgentTransformSurface();
	});

	test('openCodeSwarmV2Setup registers the agent-transform surface and cleanup clears it', async () => {
		const dir = canonicalMkdtemp('v2-setup-wiring-');
		const { ctx } = fakeCtx(dir);
		const cleanup = await openCodeSwarmV2Setup(ctx as never, {
			runInit: async () => ({}) as never,
		});
		expect(hasV2AgentTransformSurface()).toBe(true);
		await cleanup();
		expect(hasV2AgentTransformSurface()).toBe(false);
		await removeTreeWithRetry(dir);
	});

	test('a ctx without the agent domain leaves the surface unset (still fail-open)', async () => {
		const dir = canonicalMkdtemp('v2-setup-wiring-noagent-');
		const cleanup = await openCodeSwarmV2Setup(
			{ location: { directory: dir } } as never,
			{ runInit: async () => ({}) as never },
		);
		expect(hasV2AgentTransformSurface()).toBe(false);
		await cleanup();
		await removeTreeWithRetry(dir);
	});
});

describe('#3022 v2 setup + advance wiring (source contract)', () => {
	const setupSrc = fs.readFileSync(
		path.resolve(import.meta.dir, '../../../../src/host/v2/setup.ts'),
		'utf-8',
	);
	const indexSrc = fs.readFileSync(
		path.resolve(import.meta.dir, '../../../../src/index.ts'),
		'utf-8',
	);

	test('setup registers the agent-transform surface', () => {
		// #2910 W5 re-pin: the call is token-carrying (per-instance owner
		// scoping — a setup's cleanup clears only its own surface).
		expect(setupSrc).toContain(
			'registerV2AgentTransformSurface(ctx, ownerToken);',
		);
	});

	test('setup runs the startup roster preflight inline at its tail, withTimeout-bounded (C6 scan)', () => {
		expect(setupSrc).toContain('await withTimeout(');
		expect(setupSrc).toContain('deferredV2StartupModelPreflight(directory),');
	});

	test('both index.ts session.error advance arms apply the advanced model on v2', () => {
		const calls = indexSrc.match(/void applyV2AgentModelOverride\(/g) ?? [];
		expect(calls.length).toBe(2);
		// Both call sites key on the exact registered agent name.
		expect(
			indexSrc.match(
				/applyV2AgentModelOverride\(\n\s+routeModel\.exactAgentName,/g,
			)?.length,
		).toBe(2);
	});

	test('index.ts injects the fresh-tables builder into the v2 setup deps (PRR-046)', () => {
		// The default export's setup block must pass buildV2RegistrationTables
		// — deleting the injection silently no-ops the production refresh
		// (the dep is optional, so tsc and every other test stay green).
		expect(indexSrc).toContain('buildV2RegistrationTables,');
	});
});
