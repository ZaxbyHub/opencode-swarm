import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import {
	findByCorrelationId,
	recordPendingDelegationDetailed,
} from '../../../src/background/pending-delegations.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';
import { initializeGitRepository } from '../helpers/git-repository.js';

let directory = '';

beforeEach(async () => {
	directory = canonicalMkdtemp('pending-pr-review-identity-');
	await initializeGitRepository(directory);
});

afterEach(async () => {
	await fs.rm(directory, { recursive: true, force: true });
});

function input(mode: string) {
	return {
		correlationId: 'correlation-session',
		jobId: null,
		subagentSessionId: 'different-child-session',
		parentSessionId: 'controller-session',
		callID: 'dispatch-call',
		normalizedAgent: 'explorer',
		swarmPrefixedAgent: 'explorer',
		planTaskId: null,
		evidenceTaskId: null,
		mode,
	};
}

describe('PR-review delegation child identity (#2469 / PRREVIEW-12)', () => {
	test('rejects a review row whose correlation id is not its authenticated child session', async () => {
		const outcome = await recordPendingDelegationDetailed(
			directory,
			input('swarm-pr-review:base'),
		);

		expect(outcome).toEqual({ status: 'failed', record: null });
		expect(findByCorrelationId(directory, 'correlation-session')).toBeNull();
	});

	test('keeps legacy non-review rows readable under the explicit compatibility policy', async () => {
		const outcome = await recordPendingDelegationDetailed(
			directory,
			input('advisory'),
		);

		expect(outcome.status).toBe('recorded');
		expect(
			findByCorrelationId(directory, 'correlation-session')?.subagentSessionId,
		).toBe('different-child-session');
	});
});
