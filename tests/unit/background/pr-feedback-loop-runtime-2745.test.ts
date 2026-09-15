import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { OpencodeClient } from '@opencode-ai/sdk';
import {
	_internals,
	getPrFeedbackLoopRuntime,
	type PrFeedbackLoopRuntimeOptions,
	registerPrFeedbackLoopRuntime,
} from '../../../src/background/pr-feedback-loop-runtime.js';
import { acquirePrFeedbackBackgroundLease } from '../../../tests/helpers/pr-feedback-background-lease';

const rootA = 'C:\\workspace\\pr-feedback-a';
const rootB = 'C:\\workspace\\pr-feedback-b';
const clientA = { name: 'client-a' } as unknown as OpencodeClient;
const clientB = { name: 'client-b' } as unknown as OpencodeClient;

const originalSnapshot = _internals.getPRPollSnapshot;
const originalDispatch = _internals.dispatchEphemeralAgent;
const originalCanonical = _internals.canonicalRootKeyFresh;
const originalCanonicalAsync = _internals.canonicalRootKeyFreshAsync;
let releaseBackground: (() => void) | null = null;

beforeEach(async () => {
	releaseBackground = await acquirePrFeedbackBackgroundLease();
});

afterEach(() => {
	try {
		_internals.getPRPollSnapshot = originalSnapshot;
		_internals.dispatchEphemeralAgent = originalDispatch;
		_internals.canonicalRootKeyFresh = originalCanonical;
		_internals.canonicalRootKeyFreshAsync = originalCanonicalAsync;
		// The registry cleanup tests own their registrations. This extra cleanup is
		// only a defensive reset for a failed assertion that could otherwise leak
		// into the next test in Bun's shared process.
		const activeA = getPrFeedbackLoopRuntime(rootA);
		const activeB = getPrFeedbackLoopRuntime(rootB);
		if (activeA)
			registerPrFeedbackLoopRuntime({
				client: clientA,
				directory: rootA,
				config: {} as PrFeedbackLoopRuntimeOptions['config'],
				agentNames: [],
				resolveSessionAgent: () => undefined,
			})();
		if (activeB)
			registerPrFeedbackLoopRuntime({
				client: clientB,
				directory: rootB,
				config: {} as PrFeedbackLoopRuntimeOptions['config'],
				agentNames: [],
				resolveSessionAgent: () => undefined,
			})();
	} finally {
		releaseBackground?.();
		releaseBackground = null;
	}
});

function options(
	directory: string,
	client: OpencodeClient,
	activeAgent: string | undefined = 'mega_coder',
): PrFeedbackLoopRuntimeOptions {
	return {
		client,
		directory,
		config: {} as PrFeedbackLoopRuntimeOptions['config'],
		agentNames: ['mega_coder', 'mega_critic_oversight'],
		resolveSessionAgent: () => activeAgent,
	};
}

describe('issue #2745 production runtime boundary', () => {
	it('uses the lexical key immediately and promotes physical aliases after init', async () => {
		const physicalRoot = 'physical-pr-feedback-root';
		const syncCanonical = mock(() => physicalRoot);
		const asyncCanonical = mock(async () => physicalRoot);
		_internals.canonicalRootKeyFresh = syncCanonical;
		_internals.canonicalRootKeyFreshAsync = asyncCanonical;

		const registration = registerPrFeedbackLoopRuntime(options(rootA, clientA));
		// Exact-directory lookup must not need physical canonicalization before
		// the post-resolution promotion runs.
		expect(getPrFeedbackLoopRuntime(rootA)).not.toBeNull();
		// The current resolver refreshes the physical key at lookup time while
		// retaining the lexical registration as the init-time fallback.
		expect(syncCanonical).toHaveBeenCalledTimes(1);
		expect(asyncCanonical).not.toHaveBeenCalled();

		await registration.promote();
		expect(asyncCanonical).toHaveBeenCalledTimes(1);
		// An alias with no direct lexical registration resolves through the
		// promoted physical identity without changing the init-time path.
		expect(getPrFeedbackLoopRuntime(rootB)).toBe(
			getPrFeedbackLoopRuntime(rootA),
		);
		registration();
	});

	it('newer physical-alias promotion replaces older owner and stale cleanup is inert', async () => {
		const physicalRoot = 'shared-physical-pr-feedback-root';
		_internals.canonicalRootKeyFresh = mock(() => physicalRoot);
		_internals.canonicalRootKeyFreshAsync = mock(async () => physicalRoot);

		const older = registerPrFeedbackLoopRuntime(options(rootA, clientA));
		await older.promote();
		const newer = registerPrFeedbackLoopRuntime(options(rootB, clientB));
		await newer.promote();

		// Promotion uses registration sequence, not task completion order, so
		// the newer physical owner wins and the old disposer cannot remove it.
		expect(getPrFeedbackLoopRuntime(rootA)).toBe(
			getPrFeedbackLoopRuntime(rootB),
		);
		older();
		expect(getPrFeedbackLoopRuntime(rootB)).not.toBeNull();
		newer();
		expect(getPrFeedbackLoopRuntime(rootA)).toBeNull();
	});

	it('does not let an older async promotion overwrite a newer physical owner', async () => {
		const physicalRoot = 'shared-physical-pending-root';
		_internals.canonicalRootKeyFresh = mock(() => physicalRoot);
		const resolvers = new Map<string, (key: string) => void>();
		_internals.canonicalRootKeyFreshAsync = mock(
			(directory: string) =>
				new Promise<string>((resolve) => {
					resolvers.set(directory, resolve);
				}),
		);

		const older = registerPrFeedbackLoopRuntime(options(rootA, clientA));
		const olderPromotion = older.promote();
		const newer = registerPrFeedbackLoopRuntime(options(rootB, clientB));
		const newerPromotion = newer.promote();
		resolvers.get(rootB)?.(physicalRoot);
		await newerPromotion;
		resolvers.get(rootA)?.(physicalRoot);
		await olderPromotion;

		expect(getPrFeedbackLoopRuntime(rootA)).toBe(
			getPrFeedbackLoopRuntime(rootB),
		);
		newer();
	});

	it('keeps roots isolated and stale cleanup cannot remove a replacement', async () => {
		const observedRoots: string[] = [];
		_internals.getPRPollSnapshot = async (_number, _repo, cwd) => {
			observedRoots.push(cwd);
			return {
				status: { headRefOid: cwd === rootA ? 'head-a' : 'head-b' },
			} as never;
		};

		const cleanupA = registerPrFeedbackLoopRuntime(options(rootA, clientA));
		const cleanupB = registerPrFeedbackLoopRuntime(options(rootB, clientB));
		const replacementCleanupA = registerPrFeedbackLoopRuntime(
			options(rootA, clientB),
		);

		cleanupA();
		expect(getPrFeedbackLoopRuntime(rootA)).not.toBeNull();
		expect(
			await getPrFeedbackLoopRuntime(rootA)!.evaluateCurrentHead(
				'C:\\foreign',
				'owner/repo',
				1,
			),
		).toBe('head-a');
		expect(observedRoots).toEqual([rootA]);

		replacementCleanupA();
		cleanupB();
		expect(getPrFeedbackLoopRuntime(rootA)).toBeNull();
		expect(getPrFeedbackLoopRuntime(rootB)).toBeNull();
	});

	it('uses the owning root for authenticated head evaluation and fails closed', async () => {
		let call: { number: number; repo: string; cwd: string } | undefined;
		_internals.getPRPollSnapshot = async (number, repo, cwd) => {
			call = { number, repo, cwd };
			return { status: { headRefOid: 'abc123' } } as never;
		};
		const cleanup = registerPrFeedbackLoopRuntime(options(rootA, clientA));

		expect(
			await getPrFeedbackLoopRuntime(rootA)!.evaluateCurrentHead(
				'C:\\untrusted-caller-root',
				'owner/repo',
				2745,
			),
		).toBe('abc123');
		expect(call).toEqual({ number: 2745, repo: 'owner/repo', cwd: rootA });

		_internals.getPRPollSnapshot = async () => {
			throw new Error('gh unavailable');
		};
		expect(
			await getPrFeedbackLoopRuntime(rootA)!.evaluateCurrentHead(
				rootA,
				'owner/repo',
				2745,
			),
		).toBeNull();
		cleanup();
	});

	it('dispatches a read-only prefixed critic and accepts only exact APPROVED', async () => {
		const requests: Array<
			Parameters<typeof _internals.dispatchEphemeralAgent>[0]
		> = [];
		_internals.dispatchEphemeralAgent = async (request) => {
			requests.push(request);
			return {
				status: 'completed',
				agentName: request.agentName,
				text: 'VERDICT: APPROVED\nREASONING: coherent',
				durationMs: 1,
				promptBytes: 1,
				responseBytes: 1,
			};
		};
		const cleanup = registerPrFeedbackLoopRuntime(options(rootA, clientA));
		const result = await getPrFeedbackLoopRuntime(rootA)!.dispatchOversight({
			directory: rootA,
			sessionID: 'session-a',
			eventType: 'pr.ci.failed',
			actionClass: 'fix_ci',
			repoFullName: 'owner/repo',
			prNumber: 2745,
			head: 'abc123',
		});

		expect(result).toEqual({
			dispatched: true,
			verdict: 'APPROVED',
			decision: 'approve',
		});
		expect(requests).toHaveLength(1);
		expect(requests[0]?.client).toBe(clientA);
		expect(requests[0]?.directory).toBe(rootA);
		expect(requests[0]?.parentSessionId).toBe('session-a');
		expect(requests[0]?.agentName).toBe('mega_critic_oversight');
		expect(requests[0]?.readOnlyTools.write).toBe(false);
		expect(requests[0]?.readOnlyTools.edit).toBe(false);
		expect(requests[0]?.prompt).toContain('UNTRUSTED PR FEEDBACK METADATA');

		_internals.dispatchEphemeralAgent = async (request) => ({
			status: 'completed',
			agentName: request.agentName,
			text: 'VERDICT: DISAPPROVED\nREASONING: no',
			durationMs: 1,
			promptBytes: 1,
			responseBytes: 1,
		});
		const denied = await getPrFeedbackLoopRuntime(rootA)!.dispatchOversight({
			directory: rootA,
			sessionID: 'session-a',
			eventType: 'pr.ci.failed',
			actionClass: 'fix_ci',
			repoFullName: 'owner/repo',
			prNumber: 2745,
			head: 'abc123',
		});
		expect(denied).toEqual({
			dispatched: true,
			verdict: 'NEEDS_REVISION',
			decision: 'pending',
		});
		cleanup();
	});

	it('does not dispatch without a current session agent or matching critic', async () => {
		const cleanup = registerPrFeedbackLoopRuntime(options(rootA, clientA, ''));
		const result = await getPrFeedbackLoopRuntime(rootA)!.dispatchOversight({
			directory: rootA,
			sessionID: 'missing',
			eventType: 'pr.ci.failed',
			actionClass: 'fix_ci',
			repoFullName: 'owner/repo',
			prNumber: 2745,
			head: 'abc123',
		});
		expect(result).toEqual({
			dispatched: false,
			verdict: 'unavailable',
			decision: 'pending',
		});
		cleanup();
	});
});
