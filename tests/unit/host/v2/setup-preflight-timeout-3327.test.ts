/**
 * #3350 AC1 (PR #3327 follow-up) — a failed or degraded v2 startup-preflight
 * config read must be operator-visible through the deferred-warning buffer.
 *
 * DEFECT (base 8e5cfd387, src/host/v2/setup.ts deferredV2StartupModelPreflight
 * catch arm ~L50-L54): the only failure surface is the OPENCODE_SWARM_DEBUG-
 * gated log(). A config read that exceeds the preflight budget, or resolves
 * with a degraded ConfigLoadResult, silently drops the roster preflight — the
 * v1 path uses advisoryWarn for the same event class.
 *
 * DECLARED SEAM (check-author amendment, plan-critic CHECK_WRONG mandate): the
 * original unreadable-config driver never reached the code under change —
 * src/config/loader.ts swallows read failures and returns a SUCCESS-shaped
 * ConfigLoadResult (configHadErrors:true), and the preflight catch only sees
 * timeouts/throws. Both failure arms are therefore driven through a declared
 * _internals seam that src/host/v2/setup.ts must export:
 *
 *   export const _internals = {
 *     registrationTimeoutMs: V2_REGISTRATION_TIMEOUT_MS,
 *     preflightConfigTimeoutMs: V2_PREFLIGHT_CONFIG_TIMEOUT_MS,
 *     loadConfig: loadPluginConfigWithMetaAsync,
 *   };
 *
 * deferredV2StartupModelPreflight must read BOTH timeouts and the loader
 * through _internals AT CALL TIME (a module-load capture would freeze the test
 * override out). Until that seam exists, every seam-driven arm below is RED
 * with a MISSING SEAM error naming _internals.preflightConfigTimeoutMs and
 * _internals.loadConfig.
 *
 * CONTRACT pinned on the implementer (addDeferredWarning — the
 * operator-reachable channel per the #3022 AC4 precedent; log() alone is
 * invisible in production):
 *  - TIMEOUT arm: a config read exceeding the LIVE budget records EXACTLY ONE
 *    deferred warning naming the preflight and the live budget value (the
 *    seam-pinned 30ms, not a hardcoded 2000), with no duplicates.
 *  - DEGRADED arm: a load resolving with configHadErrors:true (the REAL
 *    ConfigLoadResult field — src/config/loader.ts; the spelling is pinned
 *    below against getSafeDefaultConfigLoadResult) records EXACTLY ONE
 *    preflight warning.
 *  - CONTROL: a clean load records NO preflight warning. The real-filesystem
 *    clean-workspace control uses no seam and stays green at base AND under
 *    the fix.
 *
 * No mock.module; plain-object fakes only.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	type ConfigLoadResult,
	getSafeDefaultConfigLoadResult,
} from '../../../../src/config/loader';
import * as v2Setup from '../../../../src/host/v2/setup';
import type { V1HooksSubset } from '../../../../src/host/v2/types';
import {
	clearDeferredWarnings,
	getDeferredWarnings,
} from '../../../../src/services/warning-buffer';
import { resetSwarmState } from '../../../../src/state';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../../helpers/tmpdir';

/** The declared test seam src/host/v2/setup.ts must export (see header). */
interface V2SetupInternals {
	registrationTimeoutMs: number;
	preflightConfigTimeoutMs: number;
	loadConfig: (directory: string) => Promise<ConfigLoadResult>;
}

function internalsOf(): Partial<V2SetupInternals> | undefined {
	return (v2Setup as { _internals?: Partial<V2SetupInternals> })._internals;
}

/**
 * Seam guard: fails with a MISSING SEAM error (instead of a confusing
 * downstream timeout/no-warning failure) until setup.ts exports the seam.
 */
function requireSeam(): V2SetupInternals {
	const internals = internalsOf();
	const shape = internals
		? `registrationTimeoutMs:${typeof internals.registrationTimeoutMs}, preflightConfigTimeoutMs:${typeof internals.preflightConfigTimeoutMs}, loadConfig:${typeof internals.loadConfig}`
		: 'no _internals export at all';
	if (
		!internals ||
		typeof internals.registrationTimeoutMs !== 'number' ||
		typeof internals.preflightConfigTimeoutMs !== 'number' ||
		typeof internals.loadConfig !== 'function'
	) {
		throw new Error(
			`MISSING SEAM: src/host/v2/setup.ts must export _internals = { registrationTimeoutMs, preflightConfigTimeoutMs, loadConfig } with _internals.preflightConfigTimeoutMs (number) and _internals.loadConfig (function, defaulting to loadPluginConfigWithMetaAsync), read at call time by deferredV2StartupModelPreflight (got: ${shape})`,
		);
	}
	return internals as V2SetupInternals;
}

let dir: string;
let savedPreflightConfigTimeoutMs: number | undefined;
let savedLoadConfig: V2SetupInternals['loadConfig'] | undefined;

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

const preflightWarnings = () =>
	getDeferredWarnings().filter((w) => /preflight/i.test(w));

/** Minimal working runInit — the shared init core is out of scope for #3350. */
const runInit = async (): Promise<V1HooksSubset> => makeHooks();

async function runSetup(): Promise<() => Promise<void>> {
	return v2Setup.openCodeSwarmV2Setup(buildFastCtx(dir) as never, { runInit });
}

beforeEach(() => {
	clearDeferredWarnings();
	dir = canonicalMkdtemp('v2-pf3350-');
});

afterEach(async () => {
	const internals = internalsOf();
	if (internals) {
		if (savedPreflightConfigTimeoutMs !== undefined) {
			internals.preflightConfigTimeoutMs = savedPreflightConfigTimeoutMs;
		}
		if (savedLoadConfig !== undefined) {
			internals.loadConfig = savedLoadConfig;
		}
	}
	savedPreflightConfigTimeoutMs = undefined;
	savedLoadConfig = undefined;
	resetSwarmState();
	clearDeferredWarnings();
	await removeTreeWithRetry(dir);
});

describe('#3350 AC1 startup preflight failure visibility (declared seam)', () => {
	test('TIMEOUT arm: config read exceeding the live budget records exactly one preflight warning naming the live budget (base: MISSING SEAM -> red)', async () => {
		const internals = requireSeam();
		savedPreflightConfigTimeoutMs = internals.preflightConfigTimeoutMs;
		savedLoadConfig = internals.loadConfig;
		// Live budget pinned to 30ms: the warning must name the value the
		// preflight ACTUALLY enforced (30ms through the seam), proving both the
		// call-time timeout read and budget interpolation — a hardcoded "2000"
		// in the message fails this match.
		internals.preflightConfigTimeoutMs = 30;
		internals.loadConfig = () => new Promise<ConfigLoadResult>(() => {});

		const cleanup = await runSetup();
		try {
			const warnings = preflightWarnings();
			// EXACTLY ONE preflight warning — no duplicate advisories.
			expect(warnings).toHaveLength(1);
			expect(warnings[0]).toMatch(/30\s?ms/);
		} finally {
			await cleanup();
		}
	}, 15_000);

	test('DEGRADED arm: a resolved-but-degraded load (configHadErrors) records exactly one preflight warning (base: MISSING SEAM -> red)', async () => {
		// Spelling pin: ConfigLoadResult's degradation field is configHadErrors
		// (src/config/loader.ts, "True when a config file existed but could not
		// be loaded"). The stub below must spell it identically or this arm
		// silently degrades into the clean control.
		const probe = getSafeDefaultConfigLoadResult();
		expect(Object.hasOwn(probe, 'configHadErrors')).toBe(true);
		expect(probe.configHadErrors).toBe(false);

		const internals = requireSeam();
		savedLoadConfig = internals.loadConfig;
		internals.loadConfig = async () => ({
			...getSafeDefaultConfigLoadResult(),
			configHadErrors: true,
		});

		const cleanup = await runSetup();
		try {
			expect(preflightWarnings()).toHaveLength(1);
		} finally {
			await cleanup();
		}
	}, 15_000);

	test('CONTROL (stub): a clean load records no preflight warning (base: MISSING SEAM -> red)', async () => {
		const internals = requireSeam();
		savedLoadConfig = internals.loadConfig;
		internals.loadConfig = async () => getSafeDefaultConfigLoadResult();

		const cleanup = await runSetup();
		try {
			expect(preflightWarnings()).toEqual([]);
		} finally {
			await cleanup();
		}
	}, 15_000);

	test('CONTROL (real workspace): a clean workspace records no preflight failure warning (green both ends)', async () => {
		// No seam usage: a workspace with no config at all must run the
		// preflight cleanly (ENOENT is a normal absent config, not a failure)
		// and record no preflight-named warning — at base AND under the fix.
		const cleanup = await runSetup();
		try {
			expect(preflightWarnings()).toEqual([]);
		} finally {
			await cleanup();
		}
	}, 15_000);
});
