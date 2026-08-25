import { afterEach, describe, expect, test } from 'bun:test';
import {
	advancePendingTaskModelRoute,
	bindPendingTaskModelRouteChild,
	clearPendingTaskModelRoutesForSession,
	getTaskModelRoutingStateSnapshot,
	registerPendingTaskModelRoute,
	resetTaskModelRoutingStateForTests,
	resolveTaskChatModelOverride,
} from '../../../src/models/task-model-routing';

afterEach(() => {
	resetTaskModelRoutingStateForTests();
});

const CHAIN = {
	primaryModel: 'prov/primary',
	fallbackModels: ['prov/fb1', 'prov/fb2'],
};

describe('task model routing', () => {
	test('advances the exact parent task route from a child provider failure and resolves a fallback override', async () => {
		registerPendingTaskModelRoute({
			parentSessionID: 'parent-1',
			invocationID: 'invoke-1',
			callID: 'call-1',
			role: 'coder',
			actionDigest: 'digest-1',
			swarmID: 'swarm-a',
		});
		bindPendingTaskModelRouteChild({
			parentSessionID: 'parent-1',
			callID: 'call-1',
			childSessionID: 'child-1',
		});

		const advanced = advancePendingTaskModelRoute({
			childSessionID: 'child-1',
			role: 'coder',
			actionDigest: 'digest-1',
			...CHAIN,
		});
		expect(advanced).toMatchObject({
			accepted: true,
			exhausted: false,
			fallbackIndex: 1,
		});

		const resolved = await resolveTaskChatModelOverride({
			childSessionID: 'child-1',
			role: 'coder',
			...CHAIN,
		});
		expect(resolved).toMatchObject({
			status: 'override',
			modelString: 'prov/fb1',
			fallbackIndex: 1,
		});
		expect(resolved.model).toEqual({
			providerID: 'prov',
			modelID: 'fb1',
		});
	});

	test('fails closed on mismatched role or action digest', () => {
		registerPendingTaskModelRoute({
			parentSessionID: 'parent-1',
			invocationID: 'invoke-1',
			callID: 'call-1',
			role: 'coder',
			actionDigest: 'digest-1',
		});
		bindPendingTaskModelRouteChild({
			parentSessionID: 'parent-1',
			callID: 'call-1',
			childSessionID: 'child-1',
		});

		expect(
			advancePendingTaskModelRoute({
				childSessionID: 'child-1',
				role: 'reviewer',
				actionDigest: 'digest-1',
				...CHAIN,
			}),
		).toBeUndefined();
		expect(
			advancePendingTaskModelRoute({
				childSessionID: 'child-1',
				role: 'coder',
				actionDigest: 'digest-2',
				...CHAIN,
			}),
		).toBeUndefined();
	});

	test('uses a bounded parent lookup only when there is one unambiguous pending route', async () => {
		registerPendingTaskModelRoute({
			parentSessionID: 'parent-1',
			invocationID: 'invoke-1',
			callID: 'call-1',
			role: 'coder',
			actionDigest: 'digest-1',
		});
		const resolution = await resolveTaskChatModelOverride({
			childSessionID: 'child-unknown',
			role: 'coder',
			actionDigest: 'digest-1',
			...CHAIN,
			lookupParentSessionID: async () => 'parent-1',
		});

		expect(resolution.status).toBe('primary');
	});

	test('fails closed on ambiguous parent lookups', async () => {
		for (const callID of ['call-1', 'call-2']) {
			registerPendingTaskModelRoute({
				parentSessionID: 'parent-1',
				invocationID: `invoke-${callID}`,
				callID,
				role: 'coder',
				actionDigest: callID,
			});
		}

		const resolution = await resolveTaskChatModelOverride({
			childSessionID: 'child-unknown',
			role: 'coder',
			...CHAIN,
			lookupParentSessionID: async () => 'parent-1',
		});
		expect(resolution.status).toBe('ambiguous');
	});

	test('clears pending routes and scoped selections for one session', async () => {
		registerPendingTaskModelRoute({
			parentSessionID: 'parent-1',
			invocationID: 'invoke-1',
			callID: 'call-1',
			role: 'coder',
			actionDigest: 'digest-1',
		});
		bindPendingTaskModelRouteChild({
			parentSessionID: 'parent-1',
			callID: 'call-1',
			childSessionID: 'child-1',
		});
		advancePendingTaskModelRoute({
			childSessionID: 'child-1',
			role: 'coder',
			actionDigest: 'digest-1',
			...CHAIN,
		});

		registerPendingTaskModelRoute({
			parentSessionID: 'parent-2',
			invocationID: 'invoke-2',
			callID: 'call-2',
			role: 'reviewer',
			actionDigest: 'digest-2',
		});

		clearPendingTaskModelRoutesForSession('parent-1');

		const snapshot = getTaskModelRoutingStateSnapshot();
		expect(snapshot.routes).toEqual([
			expect.objectContaining({
				parentSessionID: 'parent-2',
				callID: 'call-2',
			}),
		]);
		expect(snapshot.scopedSelections).toEqual([]);
	});
});
