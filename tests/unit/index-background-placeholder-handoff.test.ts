import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
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

describe('Task handoff distinguishes a background placeholder from completion', () => {
	let directory = '';

	beforeEach(async () => {
		resetSwarmState();
		directory = createKnowledgeProject();
	});

	afterEach(() => {
		resetSwarmState();
		safeRmRecursive(directory);
	});

	test('running placeholder restores architect continuation without a completion advisory', async () => {
		const plugin = await bootKnowledgeHost(directory);
		const after = plugin.hooks['tool.execute.after'];
		const session = ensureAgentSession(
			'placeholder-parent',
			'reviewer',
			directory,
		);
		session.currentTaskId = '1.1';
		session.delegationActive = true;
		swarmState.activeAgent.set('placeholder-parent', 'reviewer');

		await after(
			{
				tool: 'Task',
				sessionID: 'placeholder-parent',
				callID: 'background-reviewer-call',
			},
			{
				state: 'running',
				output:
					'<task id="background-reviewer" state="running">Background task started</task>',
				metadata: { background: true, jobId: 'background-reviewer' },
			},
		);

		expect(swarmState.activeAgent.get('placeholder-parent')).toBe('architect');
		expect(session.delegationActive).toBe(false);
		expect(session.pendingAdvisoryMessages ?? []).toEqual([]);
	});

	test('foreground terminal result still publishes pipeline continuation', async () => {
		const plugin = await bootKnowledgeHost(directory);
		const after = plugin.hooks['tool.execute.after'];
		const session = ensureAgentSession(
			'foreground-parent',
			'reviewer',
			directory,
		);
		session.currentTaskId = '1.1';
		session.taskWorkflowStates.set('1.1', 'coder_delegated');
		session.delegationActive = true;
		swarmState.activeAgent.set('foreground-parent', 'reviewer');

		await after(
			{
				tool: 'Task',
				sessionID: 'foreground-parent',
				callID: 'foreground-reviewer-call',
			},
			{ state: 'completed', output: 'review passed' },
		);

		expect(swarmState.activeAgent.get('foreground-parent')).toBe('architect');
		expect(session.delegationActive).toBe(false);
		expect(session.pendingAdvisoryMessages).toHaveLength(1);
		expect(session.pendingAdvisoryMessages?.[0]).toContain('[PIPELINE]');
		expect(session.pendingAdvisoryMessages?.[0]).toContain('reviewer');
	});
});
