/**
 * The lean-turbo phase critic's direct SDK dispatch reads the provider error
 * OpenCode records on the assistant message (`info.error`): `session.prompt`
 * answers HTTP 200 with the failure there and no text, so it must throw (for
 * the caller's failover classifier) instead of returning an empty response.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as os from 'node:os';
import { swarmState } from '../../../../src/state';
import { _internals } from '../../../../src/turbo/lean/integration';
import { isTransientProviderError } from '../../../../src/utils/provider-error-classification';

const originalClient = swarmState.opencodeClient;
afterEach(() => {
	swarmState.opencodeClient = originalClient;
});

const PACKAGE = {
	phase: 1,
	sessionID: 'test-session',
	reviewerVerdict: 'APPROVED' as const,
	reviewerMissing: false,
	safetyConcerns: [],
	laneSummaries: [],
	filesChanged: [],
	testResults: { totalLanes: 0, completedLanes: 0, failedLanes: 0 },
	degradationSummary: {
		totalDegraded: 0,
		resolvedDegraded: 0,
		pendingDegraded: 0,
	},
};

describe('defaultDispatchCriticAgent — provider error on the assistant message', () => {
	test('a 429 recorded as info.error throws a transient error', async () => {
		swarmState.opencodeClient = {
			session: {
				create: async () => ({ data: { id: 'critic-sess' } }),
				prompt: async () => ({
					data: {
						info: {
							error: {
								name: 'APIError',
								data: { statusCode: 429, message: 'Rate limit exceeded' },
							},
						},
						parts: [],
					},
				}),
				delete: async () => ({}),
			},
		} as never;
		let thrown: unknown;
		try {
			await _internals.dispatchCriticAgent(os.tmpdir(), PACKAGE, 'critic', 0);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(Error);
		const message = (thrown as Error).message;
		expect(message).toContain('HTTP 429');
		expect(isTransientProviderError(message)).toBe(true);
	});
});
