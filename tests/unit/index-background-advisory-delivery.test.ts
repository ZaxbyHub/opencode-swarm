import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	findByCorrelationId,
	recordPendingDelegation,
} from '../../src/background/pending-delegations';
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

describe('durable background advisory delivery', () => {
	let directory = '';

	beforeEach(() => {
		resetSwarmState();
		directory = createKnowledgeProject();
	});

	afterEach(() => {
		resetSwarmState();
		safeRmRecursive(directory);
	});

	test('keeps delivery pending until a later host transform reflects the advisory', async () => {
		const plugin = await bootKnowledgeHost(directory, {
			hooks: { background_subagents: true },
		});
		const session = ensureAgentSession('parent', 'architect', directory);
		swarmState.activeAgent.set('parent', 'architect');
		await recordPendingDelegation(directory, {
			correlationId: 'explorer-session',
			jobId: 'explorer-job',
			subagentSessionId: 'explorer-session',
			parentSessionId: 'parent',
			callID: 'explorer-call',
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
						sessionID: 'parent',
						text:
							'<task id="explorer-session" state="completed">\n' +
							'<task_result>done</task_result>\n</task>',
					},
				},
			},
		});
		expect(
			findByCorrelationId(directory, 'explorer-session')?.advisoryInbox?.state,
		).toBe('pending');
		expect(session.pendingAdvisoryMessages).toHaveLength(1);

		const output = {
			messages: [
				{
					info: {
						role: 'user',
						agent: 'architect',
						sessionID: 'parent',
					},
					parts: [{ type: 'text', text: 'continue' }],
				},
			],
		};
		await plugin.hooks['experimental.chat.messages.transform']({}, output);

		const deliveredText = output.messages
			.flatMap((message) => message.parts)
			.map((part) => part.text ?? '')
			.join('\n');
		expect(deliveredText).toContain('[BACKGROUND COMPLETION');
		expect(deliveredText).toContain('explorer task unknown completed');
		expect(session.pendingAdvisoryMessages).toEqual([]);
		expect(
			findByCorrelationId(directory, 'explorer-session')?.advisoryInbox?.state,
		).toBe('pending');

		// The hook cannot prove delivery before returning. The next host-provided
		// history is the durable receipt boundary.
		await plugin.hooks['experimental.chat.messages.transform']({}, output);
		expect(
			findByCorrelationId(directory, 'explorer-session')?.advisoryInbox?.state,
		).toBe('delivered');
	});
});
