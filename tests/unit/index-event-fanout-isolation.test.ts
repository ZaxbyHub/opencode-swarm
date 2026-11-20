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

	test('P1-4: a permanently hanging consumer cannot block the fan-out', async () => {
		const ran: string[] = [];
		const startedAt = Date.now();
		await dispatchEventConsumerIsolated(
			'hanging-consumer',
			() =>
				new Promise<void>(() => {
					// Never settles — the audit's `prWorkflowResponseGate.event`
					// shape.
				}),
			50,
		);
		const elapsed = Date.now() - startedAt;
		// The wait was bounded by the deadline (plus scheduling slack), not
		// the hung promise.
		expect(elapsed).toBeLessThan(2_000);
		// The failure is VISIBLE through the deferred warning buffer.
		expect(
			getDeferredWarnings().some((w) =>
				w.includes("'hanging-consumer' failed and was isolated"),
			),
		).toBe(true);
		// The consumer behind it still runs.
		await dispatchEventConsumerIsolated('after-hang', () => {
			ran.push('after-hang');
		}, 1_000);
		expect(ran).toEqual(['after-hang']);
	});

	test('P1-4: a consumer settling late after the deadline reports its late failure without an unhandled rejection', async () => {
		let lateReject: ((error: Error) => void) | undefined;
		const dispatched = dispatchEventConsumerIsolated(
			'late-settling-consumer',
			() =>
				new Promise<void>((_resolve, reject) => {
					lateReject = reject;
				}),
			50,
		);
		await dispatched;
		clearDeferredWarnings();
		// The abandoned consumer rejects AFTER the fan-out moved on.
		expect(lateReject).toBeDefined();
		lateReject?.(new Error('late boom'));
		// Give the observation chain a microtask turn to report.
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		expect(
			getDeferredWarnings().some((w) =>
				w.includes("'late-settling-consumer (late)'"),
			),
		).toBe(true);
	});

	test('P1-4: a consumer that settles after the deadline but successfully reports nothing', async () => {
		let lateResolve: (() => void) | undefined;
		const dispatched = dispatchEventConsumerIsolated(
			'late-ok-consumer',
			() =>
				new Promise<void>((resolve) => {
					lateResolve = resolve;
				}),
			50,
		);
		await dispatched;
		clearDeferredWarnings();
		lateResolve?.();
		await Promise.resolve();
		await Promise.resolve();
		// A late SUCCESS is not a failure — no warning beyond the deadline
		// notice that was already reported at timeout time.
		expect(
			getDeferredWarnings().some((w) => w.includes('(late)')),
		).toBe(false);
	});

	test('P1-4: several events fan out concurrently without serializing on a hung sibling', async () => {
		// Two event-hook invocations in flight: the first carries a hung
		// independent consumer; the second (a fresh event, e.g. a completion)
		// must not wait behind it.
		const hung = dispatchEventConsumerIsolated(
			'hung-sibling',
			() => new Promise<void>(() => {}),
			50,
		);
		const healthy = dispatchEventConsumerIsolated(
			'concurrent-healthy',
			async () => {
				await Promise.resolve();
			},
			1_000,
		);
		await Promise.all([hung, healthy]);
		expect(
			getDeferredWarnings().some((w) => w.includes("'hung-sibling'")),
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
