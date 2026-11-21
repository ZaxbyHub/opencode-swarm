import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { loadContextMap } from '../../src/context-map/persistence';
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
 * r12 (async lifecycle F2): the context-map post-agent update must treat a
 * native-async Task dispatch's RUNNING PLACEHOLDER as a dispatch boundary —
 * the child has only STARTED. Writing the task summary at that moment marked
 * the task completed the instant it was launched; the real summary belongs to
 * the trusted terminal, which the background completion observer now writes.
 */
describe('context map: running placeholder is not a completion (F2)', () => {
	let directory = '';

	beforeEach(() => {
		resetSwarmState();
		directory = createKnowledgeProject();
	});

	afterEach(() => {
		resetSwarmState();
		safeRmRecursive(directory);
	});

	test('a running placeholder writes no context-map task summary', async () => {
		const plugin = await bootKnowledgeHost(directory, {
			context_map: { enabled: true },
		});
		const after = plugin.hooks['tool.execute.after'];
		const session = ensureAgentSession(
			'placeholder-context-parent',
			'critic',
			directory,
		);
		session.currentTaskId = '1.1';
		session.delegationActive = true;
		swarmState.activeAgent.set('placeholder-context-parent', 'critic');

		await after(
			{
				tool: 'Task',
				sessionID: 'placeholder-context-parent',
				callID: 'background-critic-call',
			},
			{
				state: 'running',
				output:
					'<task id="background-critic" state="running">Background task started</task>',
				metadata: { background: true, jobId: 'background-critic' },
			},
		);

		const map = loadContextMap(directory);
		expect(map?.task_history['1.1']).toBeUndefined();
	});

	test('a foreground terminal result still writes the context-map summary', async () => {
		const plugin = await bootKnowledgeHost(directory, {
			context_map: { enabled: true },
		});
		const after = plugin.hooks['tool.execute.after'];
		const session = ensureAgentSession(
			'foreground-context-parent',
			'coder',
			directory,
		);
		session.currentTaskId = '1.1';
		session.delegationActive = true;
		swarmState.activeAgent.set('foreground-context-parent', 'coder');

		await after(
			{
				tool: 'Task',
				sessionID: 'foreground-context-parent',
				callID: 'foreground-coder-call',
			},
			{ state: 'completed', output: 'implemented the fix' },
		);

		const map = loadContextMap(directory);
		expect(map?.task_history['1.1']).toBeDefined();
		// r14 audit repair (P1-5), pinned since r17 test hygiene: a single
		// child completion is NOT a whole-task release. The sync handoff
		// writes the same NON-FINAL 'pending' status as the background
		// observer; the terminal 'approved' promotion happens only at the
		// authoritative release point (update_task_status →
		// promoteContextMapTaskRelease). The pre-r14 'approved' expectation
		// here was stale and failed identically on unmodified HEAD.
		expect(map?.task_history['1.1']?.final_status).toBe('pending');
	});
});
