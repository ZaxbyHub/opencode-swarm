import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	findByCorrelationId,
	recordPendingDelegation,
} from '../../src/background/pending-delegations';
import {
	dispatchEventConsumerIsolated,
	reportEventConsumerFailure,
	resetEventConsumerFailureRegistryForTests,
} from '../../src/index';
import {
	clearDeferredWarnings,
	getDeferredWarnings,
} from '../../src/services/warning-buffer.js';
import {
	ensureAgentSession,
	resetSwarmState,
	swarmState,
} from '../../src/state';
import {
	bootKnowledgeHost,
	createKnowledgeProject,
} from '../helpers/knowledge-real-host';
import { safeRmRecursive } from '../helpers/safe-test-dir';

/**
 * r13 (async lifecycle F5): the `event` hook's consumers are isolated — a
 * throwing sibling consumer must neither starve the durable background
 * completion observer nor disappear silently.
 */
describe('event fan-out isolation (F5)', () => {
	beforeEach(() => {
		resetEventConsumerFailureRegistryForTests();
		clearDeferredWarnings();
	});

	afterEach(() => {
		resetEventConsumerFailureRegistryForTests();
		clearDeferredWarnings();
	});

	test('a throwing consumer does not prevent subsequent consumers from running', async () => {
		const ran: string[] = [];
		await dispatchEventConsumerIsolated('failing-consumer', () => {
			ran.push('failing');
			throw new Error('boom');
		});
		await dispatchEventConsumerIsolated('healthy-consumer', () => {
			ran.push('healthy');
		});
		expect(ran).toEqual(['failing', 'healthy']);
	});

	test('the failure is surfaced through the deferred warning buffer, not swallowed', async () => {
		await dispatchEventConsumerIsolated('visible-consumer', () => {
			throw new Error('surfaces visibly');
		});
		const warnings = getDeferredWarnings();
		const match = warnings.find((w) =>
			w.includes("'visible-consumer' failed and was isolated"),
		);
		expect(match).toBeDefined();
		expect(match).toContain('surfaces visibly');
	});

	test('the per-consumer cooldown rate-limits repeated failures without blocking later first reports', () => {
		reportEventConsumerFailure('cooldown-consumer', new Error('first'));
		expect(
			getDeferredWarnings().some((w) => w.includes("'cooldown-consumer'")),
		).toBe(true);
		clearDeferredWarnings();
		// Within the cooldown window: contained, not re-reported.
		reportEventConsumerFailure('cooldown-consumer', new Error('second'));
		expect(
			getDeferredWarnings().some((w) => w.includes("'cooldown-consumer'")),
		).toBe(false);
		// A DIFFERENT consumer still reports on its first failure.
		reportEventConsumerFailure('other-consumer', new Error('other'));
		expect(
			getDeferredWarnings().some((w) => w.includes("'other-consumer'")),
		).toBe(true);
	});

	test('async consumers are awaited and isolated equally', async () => {
		const ran: string[] = [];
		await dispatchEventConsumerIsolated('async-failing', async () => {
			await Promise.resolve();
			throw new Error('async boom');
		});
		await dispatchEventConsumerIsolated('async-healthy', async () => {
			await Promise.resolve();
			ran.push('healthy');
		});
		expect(ran).toEqual(['healthy']);
		expect(
			getDeferredWarnings().some((w) => w.includes("'async-failing'")),
		).toBe(true);
	});
});

describe('event hook delivers trusted completions through the isolated fan-out (F5 integration)', () => {
	let directory = '';

	beforeEach(() => {
		resetSwarmState();
		resetEventConsumerFailureRegistryForTests();
		clearDeferredWarnings();
		directory = createKnowledgeProject();
	});

	afterEach(() => {
		resetSwarmState();
		resetEventConsumerFailureRegistryForTests();
		clearDeferredWarnings();
		safeRmRecursive(directory);
	});

	test('a synthetic background completion is durably processed via plugin.hooks.event', async () => {
		const plugin = await bootKnowledgeHost(directory, {
			hooks: { background_subagents: true },
		});
		const session = ensureAgentSession('fanout-parent', 'architect', directory);
		swarmState.activeAgent.set('fanout-parent', 'architect');
		await recordPendingDelegation(directory, {
			correlationId: 'fanout-explorer',
			jobId: 'fanout-job',
			subagentSessionId: 'fanout-explorer',
			parentSessionId: 'fanout-parent',
			callID: 'fanout-call',
			normalizedAgent: 'explorer',
			swarmPrefixedAgent: 'explorer',
			planTaskId: null,
			evidenceTaskId: null,
		});

		await plugin.hooks.event({
			event: {
				type: 'message.part.updated',
				properties: {
					part: {
						type: 'text',
						synthetic: true,
						sessionID: 'fanout-parent',
						text:
							'<task id="fanout-explorer" state="completed">\n' +
							'<task_result>explored</task_result>\n</task>',
					},
				},
			},
		});

		// The isolated observer dispatch durably claimed and settled the
		// completion, and the parent advisory was queued.
		const record = findByCorrelationId(directory, 'fanout-explorer');
		expect(record?.status).toBe('completed');
		expect(record?.terminalResult).toBeDefined();
		expect(session.pendingAdvisoryMessages?.length).toBeGreaterThan(0);
	});
});
