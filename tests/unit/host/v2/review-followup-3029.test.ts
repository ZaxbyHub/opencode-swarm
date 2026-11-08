import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isTransientProviderFailureText } from '../../../../src/hooks/guardrails/messages-transform';
import {
	applyV2AgentModelOverride,
	clearV2AgentTransformSurface,
	registerV2AgentTransformSurface,
} from '../../../../src/host/v2/model-apply';
import {
	advancePendingTaskModelRoute,
	bindPendingTaskModelRouteChild,
	clearAllTaskModelRoutingState,
	registerPendingTaskModelRoute,
} from '../../../../src/models/task-model-routing';

/**
 * Issue #3029 posted-review follow-up pins (comment 5955916625):
 *
 * F-003 — `advancePendingTaskModelRoute` must return the NORMALIZED chain's
 *   modelString. fallbackIndex counts positions in `normalizeModelChain`
 *   output (deduped, parse-filtered); indexing the raw fallback list by it
 *   mismaps when a fallback duplicates the primary or fails to parse.
 * F-004(b) — the pump's identity-seeding call site in src/host/v2/events.ts
 *   is pinned by source contract (the loop calls
 *   `seedSessionIdentityFromEnvelope(envelope)` before mapping).
 * F-004(d) — negative control: model-unavailable tool text must NOT fire the
 *   guardrails transient-provider advisory (`isTransientProviderFailureText`).
 * F-002 — each apply's host registration is held per agent (host dispose is
 *   the transform's undo path, so a DIFFERENT agent's registration is never
 *   disposed); cleanup disposes all. The host-global apply is narrowed to
 *   sticky-appropriate error classes (isStickyModelError).
 * Round 2 — the sticky gate and the Task-route arm's adoption of the
 *   normalized chain modelString are pinned at their src/index.ts call sites.
 */
const ROSTER_SAFE = 'opencode/mimo-v2.6-flash-free';

describe('#3029 F-003 — advance returns the normalized chain modelString', () => {
	afterEach(() => {
		clearAllTaskModelRoutingState();
	});

	test('duplicate-of-primary and unparseable fallbacks never appear in the applied model', () => {
		// One shared deterministic clock: pruneRoutes evicts any route whose
		// updatedAt lags the advance-time `now` past the TTL.
		const NOW = 1_800_000_000_000;
		registerPendingTaskModelRoute(
			{
				parentSessionID: 'fb-parent',
				invocationID: 'fb-inv',
				callID: 'fb-call',
				role: 'coder',
				actionDigest: 'fb-digest',
			},
			NOW,
		);
		const bound = bindPendingTaskModelRouteChild(
			{
				parentSessionID: 'fb-parent',
				callID: 'fb-call',
				childSessionID: 'fb-child',
			},
			NOW,
		);
		expect(bound?.childSessionID).toBe('fb-child');

		// Raw fallback list: [dup-of-primary, unparseable, valid, dup, valid2].
		// Normalized chain: [valid, valid2] — the applied model must come from
		// the normalized chain, never the failing primary, 'garbage', or a
		// raw-index mismap of it.
		const advanced = advancePendingTaskModelRoute({
			childSessionID: 'fb-child',
			role: 'coder',
			actionDigest: 'fb-digest',
			primaryModel: 'opencode/primary',
			fallbackModels: [
				'opencode/primary',
				'garbage',
				'opencode/valid',
				'opencode/valid',
				'opencode/valid2',
			],
			now: NOW,
		});
		expect(advanced?.accepted).toBe(true);
		expect(advanced?.modelString).toBeDefined();
		expect(advanced?.modelString).not.toBe('opencode/primary');
		expect(advanced?.modelString).not.toBe('garbage');
		expect(['opencode/valid', 'opencode/valid2']).toContain(
			advanced?.modelString,
		);
	});
});

describe('#3029 F-004(d) — guardrails advisory negative control', () => {
	test('model-unavailable tool text does not fire the transient-provider advisory', () => {
		expect(
			isTransientProviderFailureText('Error: Model unavailable: opencode/x'),
		).toBe(false);
		expect(
			isTransientProviderFailureText(
				'SessionRunnerModel.ModelUnavailableError raised for opencode/y',
			),
		).toBe(false);
		// Positive control: genuine provider-unavailable text still fires.
		expect(
			isTransientProviderFailureText('provider unavailable: ECONNRESET'),
		).toBe(true);
	});
});

describe('#3029 F-004(b) — pump identity-seeding call site contract', () => {
	test('the event pump calls seedSessionIdentityFromEnvelope before mapping', () => {
		const source = fs.readFileSync(
			path.resolve(import.meta.dir, '../../../../src/host/v2/events.ts'),
			'utf-8',
		);
		expect(source).toContain('seedSessionIdentityFromEnvelope(envelope);');
		// The call must precede the mapping (identity is seeded for unmapped
		// identity-bearing envelopes too).
		const seedAt = source.indexOf('seedSessionIdentityFromEnvelope(envelope);');
		// #3401: the map call now carries the pump's tool-name lookup; the
		// ordering pin (seed precedes map) is preserved against the new shape.
		const mapAt = source.indexOf(
			'const mapped = mapV2EventToV1(envelope, lookupToolNameForDispatch);',
		);
		expect(seedAt).toBeGreaterThan(-1);
		expect(mapAt).toBeGreaterThan(seedAt);
	});
});

describe('#3029 F-002 — apply registration lifecycle (per-agent keyed)', () => {
	afterEach(() => {
		clearV2AgentTransformSurface();
	});

	const makeCtx = (disposals: string[]) => {
		let counter = 0;
		return {
			agent: {
				transform: async (fn: (editor: unknown) => void) => {
					fn({ update: () => {}, remove: () => {} });
					counter += 1;
					const id = `reg-${counter}`;
					return {
						dispose: async () => {
							disposals.push(id);
						},
					};
				},
			},
		} as never;
	};

	test('re-applying the same agent disposes only its own registration', async () => {
		const disposals: string[] = [];
		registerV2AgentTransformSurface(makeCtx(disposals));
		await applyV2AgentModelOverride('coder', ROSTER_SAFE);
		await applyV2AgentModelOverride('coder', 'opencode/big-pickle');
		// reg-1 (coder) was replaced by reg-2 (coder): exactly one disposal,
		// and no OTHER agent's registration was ever touched.
		expect(disposals).toEqual(['reg-1']);
		clearV2AgentTransformSurface();
		// clearV2AgentTransformSurface disposes detached; yield a microtask.
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(disposals).toEqual(['reg-1', 'reg-2']);
	});

	test("another agent's apply never disposes the first agent's registration", async () => {
		const disposals: string[] = [];
		registerV2AgentTransformSurface(makeCtx(disposals));
		await applyV2AgentModelOverride('coder', ROSTER_SAFE);
		await applyV2AgentModelOverride('test_engineer', ROSTER_SAFE);
		// Host dispose() is the transform's UNDO path: disposing agent A's
		// registration while applying for agent B would revert A's sticky
		// model rewrite (the #3022 regression class). Both must stay live.
		expect(disposals).toEqual([]);
		clearV2AgentTransformSurface();
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(disposals).toEqual(['reg-1', 'reg-2']);
	});
});

describe('#3029 review round 2 — sticky gate + normalized modelString call-site pins', () => {
	/**
	 * Source-contract pins (repo-idiomatic, mirroring setup-wiring-3022):
	 * the behavioral predicates live inside the index.ts session.error arms,
	 * which no harness drives end-to-end, so the gate and the adoption of the
	 * normalized-chain modelString are pinned at their call sites.
	 */
	test('both session.error arms gate the v2 apply on isStickyModelError', () => {
		const source = fs.readFileSync(
			path.resolve(import.meta.dir, '../../../../src/index.ts'),
			'utf-8',
		);
		// Arm 1 (Task-route) names the gate variable; arm 2 (no-route/primary)
		// calls the predicate inline. Both apply only under the sticky gate.
		expect(source).toContain(
			'const stickyEligible = isStickyModelError(errorSignal);',
		);
		expect(source).toContain('if (isStickyModelError(errorSignal)) {');
	});

	test('the Task-route arm applies the normalized chain modelString', () => {
		const source = fs.readFileSync(
			path.resolve(import.meta.dir, '../../../../src/index.ts'),
			'utf-8',
		);
		// The apply must consume advancePendingTaskModelRoute's normalized
		// modelString (via chainModel), not a raw-list fallbackIndex lookup.
		const chainAt = source.indexOf(
			'const chainModel = routedAdvance.modelString;',
		);
		expect(chainAt).toBeGreaterThan(-1);
		// #3331: the routed arm resolves the registered roster key inside the
		// same sticky-apply block (the gate sits between chainModel and the
		// call), so the window spans to the apply invocation.
		const applyAt = source.indexOf('void applyV2AgentModelOverride(', chainAt);
		expect(applyAt).toBeGreaterThan(chainAt);
		// Pin the ACTUAL argument shape — a toContain('chainModel') here is a
		// tautology because the window starts at a string literal containing
		// the token (implementation-review round 3).
		const window = source.slice(chainAt, applyAt + 120);
		expect(window).toMatch(
			/void applyV2AgentModelOverride\(\s*registeredName,\s*chainModel\s*\)/,
		);
	});
});
