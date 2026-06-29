import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import {
	ensureAgentSession,
	resetSwarmState,
	swarmState,
} from '../../../src/state';
import {
	findSystemMessage,
	findUserMessage,
	getPrimaryText,
	getSystemWarningText,
	makeConfig,
	makeMessages,
} from './_delegation-gate-helpers';

// ============================================
// QA Skip Hard-Block Enforcement Tests (v6.17)
// ============================================
describe('QA skip hard-block enforcement', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	afterEach(() => {
		resetSwarmState();
	});

	it('first coder delegation issues warning not error: After one coder delegation with no reviewer/test_engineer, a second coder delegation injects a warning into a system message but does NOT throw', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, process.cwd());

		// Setup delegation chain with 2 coder delegations (architect→coder→architect→coder)
		// This simulates the case where the first coder delegation happened, and now architect is delegating to coder again without QA
		swarmState.delegationChains.set('test-session', [
			{ from: 'architect', to: 'mega_coder', timestamp: 1 },
			{ from: 'mega_coder', to: 'architect', timestamp: 2 },
			{ from: 'architect', to: 'mega_coder', timestamp: 3 }, // Second coder without reviewer in between
		]);

		// Setup session with initial state
		const session = ensureAgentSession('test-session');
		session.qaSkipCount = 0;
		session.qaSkipTaskIds = [];
		session.lastCoderDelegationTaskId = '1.1';

		const msgText =
			'mega_coder\nTASK: 1.2\nFILE: src/foo.ts\nINPUT: do stuff\nOUTPUT: modified file';
		const messages = makeMessages(msgText, 'architect');

		// Should NOT throw - call directly without expect().resolves
		await hook.messagesTransform({}, messages);

		// System message should contain [NEXT] guidance
		const systemMsg = findSystemMessage(messages);
		expect(systemMsg?.parts[0].text).toContain('[NEXT]');

		// Warning is now in a system message (model-only), not in user message text
		const systemWarningText = getSystemWarningText(messages);
		expect(systemWarningText).toContain('⚠️ PROTOCOL VIOLATION');
		expect(systemWarningText).toContain(
			'Previous coder task completed, but QA gate was skipped',
		);
		// User message text should be unchanged
		const userMsg = findUserMessage(messages);
		expect(userMsg?.parts[0].text).toBe(msgText);

		// Should increment qaSkipCount
		expect(session.qaSkipCount).toBe(1);

		// Should track the skipped task ID
		expect(session.qaSkipTaskIds).toEqual(['1.2']);
	});

	it('second consecutive coder delegation throws hard-block Error: After two coder delegations without reviewer/test_engineer, a third coder delegation throws an Error', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, process.cwd());

		// Setup delegation chain with multiple coder delegations without reviewer/test_engineer
		swarmState.delegationChains.set('test-session', [
			{ from: 'architect', to: 'mega_coder', timestamp: 1 },
			{ from: 'mega_coder', to: 'architect', timestamp: 2 },
			{ from: 'architect', to: 'mega_coder', timestamp: 3 }, // First skip (task 1.2)
			{ from: 'mega_coder', to: 'architect', timestamp: 4 },
			{ from: 'architect', to: 'mega_coder', timestamp: 5 }, // Second skip (task 1.3) - this should throw
		]);

		// Setup session with one QA skip already counted
		const session = ensureAgentSession('test-session');
		session.qaSkipCount = 1; // Already skipped once
		session.qaSkipTaskIds = ['1.2']; // Previous skipped task
		session.lastCoderDelegationTaskId = '1.2';

		const messages = makeMessages(
			'mega_coder\nTASK: 1.3\nFILE: src/foo.ts\nINPUT: do stuff\nOUTPUT: modified file',
			'architect',
		);

		// Should throw Error with "QA GATE ENFORCEMENT"
		await expect(hook.messagesTransform({}, messages)).rejects.toThrow(
			'QA GATE ENFORCEMENT',
		);
	});

	it('thrown error message names skipped task IDs: The thrown error message contains the task IDs that were skipped', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, process.cwd());

		swarmState.delegationChains.set('test-session', [
			{ from: 'architect', to: 'mega_coder', timestamp: 1 },
			{ from: 'mega_coder', to: 'architect', timestamp: 2 },
			{ from: 'architect', to: 'mega_coder', timestamp: 3 },
			{ from: 'mega_coder', to: 'architect', timestamp: 4 },
			{ from: 'architect', to: 'mega_coder', timestamp: 5 },
		]);

		const session = ensureAgentSession('test-session');
		session.qaSkipCount = 1;
		session.qaSkipTaskIds = ['1.2', '1.3']; // Multiple skipped tasks
		session.lastCoderDelegationTaskId = '1.3';

		const messages = makeMessages(
			'mega_coder\nTASK: 1.4\nFILE: src/foo.ts\nINPUT: do stuff\nOUTPUT: modified file',
			'architect',
		);

		// Should throw Error containing the skipped task IDs
		await expect(hook.messagesTransform({}, messages)).rejects.toThrow(
			'1.2, 1.3',
		);
		await expect(hook.messagesTransform({}, messages)).rejects.toThrow(
			'Skipped tasks: [1.2, 1.3]',
		);
	});

	it('reviewer delegation resets counter so next coder does not throw: After reviewer delegation detected in toolAfter, qaSkipCount resets and next coder can proceed without throw', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, process.cwd());

		// Setup: previous QA skip state
		swarmState.delegationChains.set('test-session', [
			{ from: 'architect', to: 'mega_coder', timestamp: 1 },
			{ from: 'mega_coder', to: 'architect', timestamp: 2 },
			{ from: 'architect', to: 'mega_coder', timestamp: 3 },
			{ from: 'mega_coder', to: 'architect', timestamp: 4 },
			{ from: 'architect', to: 'reviewer', timestamp: 5 },
			{ from: 'reviewer', to: 'architect', timestamp: 6 },
			{ from: 'architect', to: 'test_engineer', timestamp: 7 }, // Both reviewer AND test_engineer required for reset
		]);

		const session = ensureAgentSession('test-session');
		session.qaSkipCount = 2;
		session.qaSkipTaskIds = ['1.2', '1.3'];
		session.lastCoderDelegationTaskId = '1.3';

		// Simulate toolAfter detecting reviewer delegation
		const toolAfterInput = {
			tool: 'tool.execute.Task',
			sessionID: 'test-session',
			callID: 'call-123',
		};
		const toolAfterOutput = {};
		await hook.toolAfter(toolAfterInput, toolAfterOutput);

		// Counter should be reset
		expect(session.qaSkipCount).toBe(0);
		expect(session.qaSkipTaskIds).toEqual([]);

		// Now add a new coder delegation - should NOT throw
		swarmState.delegationChains.set('test-session', [
			{ from: 'architect', to: 'mega_coder', timestamp: 1 },
			{ from: 'mega_coder', to: 'architect', timestamp: 2 },
			{ from: 'architect', to: 'mega_coder', timestamp: 3 },
			{ from: 'mega_coder', to: 'architect', timestamp: 4 },
			{ from: 'architect', to: 'reviewer', timestamp: 5 },
			{ from: 'reviewer', to: 'architect', timestamp: 6 },
			{ from: 'architect', to: 'test_engineer', timestamp: 7 },
			{ from: 'test_engineer', to: 'architect', timestamp: 8 },
			{ from: 'architect', to: 'mega_coder', timestamp: 9 }, // New coder after both reviewer AND test_engineer
		]);

		const messages = makeMessages(
			'mega_coder\nTASK: 2.1\nFILE: src/foo.ts\nINPUT: do stuff\nOUTPUT: modified file',
			'architect',
		);

		// Should NOT throw - call directly without expect().resolves
		await hook.messagesTransform({}, messages);

		// Should NOT warn — coder follows valid QA chain (reviewer + test_engineer), no skip detected
		expect(getPrimaryText(messages)).not.toContain('⚠️ PROTOCOL VIOLATION');
	});

	it('test_engineer delegation resets counter so next coder does not throw: Same as above but for test_engineer', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, process.cwd());

		// Setup: previous QA skip state
		swarmState.delegationChains.set('test-session', [
			{ from: 'architect', to: 'mega_coder', timestamp: 1 },
			{ from: 'mega_coder', to: 'architect', timestamp: 2 },
			{ from: 'architect', to: 'mega_coder', timestamp: 3 },
			{ from: 'mega_coder', to: 'architect', timestamp: 4 },
			{ from: 'architect', to: 'reviewer', timestamp: 5 },
			{ from: 'reviewer', to: 'architect', timestamp: 6 },
			{ from: 'architect', to: 'test_engineer', timestamp: 7 }, // Both reviewer AND test_engineer required for reset
		]);

		const session = ensureAgentSession('test-session');
		session.qaSkipCount = 2;
		session.qaSkipTaskIds = ['1.2', '1.3'];
		session.lastCoderDelegationTaskId = '1.3';

		// Simulate toolAfter detecting test_engineer delegation
		const toolAfterInput = {
			tool: 'tool.execute.Task',
			sessionID: 'test-session',
			callID: 'call-123',
		};
		const toolAfterOutput = {};
		await hook.toolAfter(toolAfterInput, toolAfterOutput);

		// Counter should be reset
		expect(session.qaSkipCount).toBe(0);
		expect(session.qaSkipTaskIds).toEqual([]);

		// Now add a new coder delegation - should NOT throw
		swarmState.delegationChains.set('test-session', [
			{ from: 'architect', to: 'mega_coder', timestamp: 1 },
			{ from: 'mega_coder', to: 'architect', timestamp: 2 },
			{ from: 'architect', to: 'mega_coder', timestamp: 3 },
			{ from: 'mega_coder', to: 'architect', timestamp: 4 },
			{ from: 'architect', to: 'reviewer', timestamp: 5 },
			{ from: 'reviewer', to: 'architect', timestamp: 6 },
			{ from: 'architect', to: 'test_engineer', timestamp: 7 },
			{ from: 'test_engineer', to: 'architect', timestamp: 8 },
			{ from: 'architect', to: 'mega_coder', timestamp: 9 }, // New coder after both reviewer AND test_engineer
		]);

		const messages = makeMessages(
			'mega_coder\nTASK: 2.1\nFILE: src/foo.ts\nINPUT: do stuff\nOUTPUT: modified file',
			'architect',
		);

		// Should NOT throw - call directly without expect().resolves
		await hook.messagesTransform({}, messages);

		// Should NOT warn — coder follows valid QA chain (reviewer + test_engineer), no skip detected
		expect(getPrimaryText(messages)).not.toContain('⚠️ PROTOCOL VIOLATION');
	});
});
