/**
 * #3350 AC4+AC5 — registration budget drivable under a FAST pinned budget
 * (fake-clock replacement for the wall-clock window tests) + the
 * `pending.length > 0` guard's FALSE arm covered.
 *
 * DECLARED-SEAM CONTRACT (binding): src/host/v2/setup.ts must export
 * `_internals = { registrationTimeoutMs: <number> }` and read the
 * registration-stage budget through it AT CALL TIME (AGENTS.md invariant 7;
 * precedent: PRR-002 dispatchTimeoutMs in agents-commands.ts). No fake-timer
 * infra exists; test-stability.md forbids wall-clock windows — the seam
 * removes them. Reconcile the V2_REGISTRATION_TIMEOUT_MS source-regex pins in
 * setup-registration-budget-3327.test.ts in the same PR.
 *
 * AC5: test 2 covers the guard's false arm once the seam lands — closing AC5
 * as "keep guard with test". At base both tests fail fast (MISSING SEAM).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { clearV2AgentTransformSurface } from '../../../../src/host/v2/model-apply';
import * as setupMod from '../../../../src/host/v2/setup';
import type { V1HooksSubset } from '../../../../src/host/v2/types';
import {
	clearDeferredWarnings,
	getDeferredWarnings,
} from '../../../../src/services/warning-buffer';
import { resetSwarmState } from '../../../../src/state';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../../helpers/tmpdir';

const FAST_BUDGET_MS = 50;
const SETUP_CEILING_MS = 5_000;

type Seam = { registrationTimeoutMs: number };

function seamOf(): Seam | undefined {
	const seam = (setupMod as unknown as { _internals?: Seam })._internals;
	return typeof seam?.registrationTimeoutMs === 'number' ? seam : undefined;
}

function requireSeam(): Seam {
	const seam = seamOf();
	if (seam === undefined)
		throw new Error(
			'MISSING SEAM: src/host/v2/setup.ts does not export _internals.registrationTimeoutMs (#3350 AC4 declared seam); export it and read the registration budget through it at call time.',
		);
	return seam;
}

/** Fast fake v2 Context; `stallAgent` makes the agent transform never settle. */
function buildCtx(directory: string, stallAgent: boolean) {
	const registration = () => ({ dispose: async () => {} });
	const transformWith =
		(editor: unknown) => async (fn: (e: unknown) => void) => {
			fn(editor);
			return registration();
		};
	const agentEditor = { update: () => {}, remove: () => {}, list: () => [] };
	const addEditor = { add: () => {} };
	return {
		location: { directory },
		agent: {
			transform: stallAgent
				? () => new Promise<never>(() => {})
				: transformWith(agentEditor),
			reload: async () => {},
		},
		command: { transform: transformWith(addEditor), reload: async () => {} },
		tool: {
			transform: async (fn: (e: unknown) => void) =>
				transformWith(addEditor)(fn),
			hook: async () => registration(),
		},
		session: { hook: async () => registration() },
		event: {},
	};
}

const makeHooks = (): V1HooksSubset =>
	({
		config: (c: Record<string, unknown>) =>
			void Object.assign(c, { agent: {}, command: {} }),
		dispose: async () => {},
	}) as unknown as V1HooksSubset;

const pendingWarnings = () =>
	getDeferredWarnings().filter((w) => w.includes('still pending'));

let dir: string;
let savedBudget: number | undefined;

beforeEach(() => {
	clearDeferredWarnings();
	dir = canonicalMkdtemp('v2-reg-fakeclock-3350-');
	const seam = seamOf();
	if (seam !== undefined) {
		savedBudget = seam.registrationTimeoutMs;
		seam.registrationTimeoutMs = FAST_BUDGET_MS;
	}
});

afterEach(async () => {
	const seam = seamOf();
	if (seam !== undefined && savedBudget !== undefined)
		seam.registrationTimeoutMs = savedBudget;
	savedBudget = undefined;
	clearV2AgentTransformSurface();
	resetSwarmState();
	clearDeferredWarnings();
	await removeTreeWithRetry(dir);
});

describe('#3350 AC4+AC5 fake-clock registration budget', () => {
	const deps = { runInit: async () => makeHooks() } as never;

	test('stalled domain resolves at the pinned fast budget and is named with it (base: MISSING SEAM -> red)', async () => {
		requireSeam();
		let ceilingTimer: ReturnType<typeof setTimeout> | undefined;
		const start = performance.now();
		const ceiling = new Promise<never>((_, reject) => {
			ceilingTimer = setTimeout(
				() => reject(new Error('fake-clock pin ineffective; setup hung')),
				SETUP_CEILING_MS,
			);
		});
		let cleanup: () => Promise<void>;
		try {
			cleanup = await Promise.race([
				setupMod.openCodeSwarmV2Setup(buildCtx(dir, true) as never, deps),
				ceiling,
			]);
		} finally {
			if (ceilingTimer !== undefined) clearTimeout(ceilingTimer);
		}
		expect(performance.now() - start).toBeLessThan(SETUP_CEILING_MS);
		const warnings = pendingWarnings();
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain('agent/command');
		expect(warnings[0]).toContain(`${FAST_BUDGET_MS}ms`);
		await cleanup();
	}, 15_000);

	test('no pending domain = no warning (AC5 false arm; base: MISSING SEAM -> red)', async () => {
		requireSeam();
		const cleanup = await setupMod.openCodeSwarmV2Setup(
			buildCtx(dir, false) as never,
			deps,
		);
		expect(pendingWarnings()).toEqual([]);
		await cleanup();
	}, 15_000);
});
