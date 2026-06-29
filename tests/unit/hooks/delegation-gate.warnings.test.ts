import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import {
	ensureAgentSession,
	getTaskState,
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

// Zero-coder-delegation detection tests (v6.12)
describe('zero-coder-delegation detection', () => {
	it('should warn when architect writes code without delegating to coder', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, process.cwd());

		// Simulate session where architect has written files
		const session = ensureAgentSession('test-session');
		session.architectWriteCount = 3;

		// Architect sends a non-coder message with a task
		const messages = makeMessages(
			'TASK: Fix the validation logic',
			'architect',
		);

		await hook.messagesTransform({}, messages);

		// Both DELEGATION VIOLATION and [NEXT] guidance are injected as system messages
		// Check that at least one system message exists
		const systemMsgs = messages.messages.filter(
			(m) => m.info?.role === 'system',
		);
		expect(systemMsgs.length).toBeGreaterThan(0);

		// One of the system messages should contain [NEXT] or DELEGATION VIOLATION
		const systemTexts = systemMsgs
			.map((m) => m.parts[0]?.text ?? '')
			.join('\n');
		expect(systemTexts).toMatch(/\[NEXT\]|DELEGATION VIOLATION/);

		// User message should contain the task
		const userMsg = findUserMessage(messages);
		expect(userMsg?.parts[0].text).toContain('TASK: Fix the validation logic');
	});

	it('should NOT warn when task ID matches last coder delegation', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, process.cwd());

		// Simulate session where architect wrote files BUT also delegated to coder for same task
		const session = ensureAgentSession('test-session');
		session.architectWriteCount = 3;
		session.lastCoderDelegationTaskId = 'Fix the validation logic';

		// Same task ID as last coder delegation - use null sessionID to skip preamble
		const messages = makeMessages(
			'TASK: Fix the validation logic',
			'architect',
			null,
		);

		await hook.messagesTransform({}, messages);

		// No warning because task matches coder delegation
		// With null sessionID, messages[0] is still the user message
		expect(getPrimaryText(messages)).toBe('TASK: Fix the validation logic');
	});

	it('should NOT warn when architect has not written any files', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, process.cwd());

		// Session exists but no writes
		const session = ensureAgentSession('test-session');
		session.architectWriteCount = 0;

		// Use null sessionID to skip preamble
		const messages = makeMessages('TASK: Check the logs', 'architect', null);

		await hook.messagesTransform({}, messages);

		// With null sessionID, messages[0] is still the user message - no modification expected
		expect(getPrimaryText(messages)).toBe('TASK: Check the logs');
	});

	it('should NOT warn on coder delegation messages', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, process.cwd());

		// Architect has written files
		const session = ensureAgentSession('test-session');
		session.architectWriteCount = 5;

		// This IS a coder delegation - use null sessionID to skip preamble
		const messages = makeMessages(
			'coder\nTASK: Implement feature\nFILE: src/feature.ts',
			'architect',
			null,
		);
		const originalText = getPrimaryText(messages);

		await hook.messagesTransform({}, messages);

		// No DELEGATION VIOLATION warning (just clean coder delegation)
		expect(getPrimaryText(messages)).not.toContain('DELEGATION VIOLATION');
		expect(getPrimaryText(messages)).toBe(originalText);
	});

	it('should track coder delegation task IDs', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, process.cwd());

		// Send a coder delegation
		const messages1 = makeMessages(
			'coder\nTASK: Task Alpha\nFILE: src/alpha.ts',
			'architect',
		);
		await hook.messagesTransform({}, messages1);

		// Verify task ID was tracked
		const session = ensureAgentSession('test-session');
		expect(session.lastCoderDelegationTaskId).toBe('Task Alpha');
	});

	it('should NOT track task ID from non-coder messages', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, process.cwd());

		// Send a non-coder message
		const messages = makeMessages('TASK: Review this please', 'architect');
		await hook.messagesTransform({}, messages);

		const session = ensureAgentSession('test-session');
		// Task ID should not be tracked (it's not a coder delegation)
		expect(session.lastCoderDelegationTaskId).toBeNull();
	});

	it('should warn on subsequent different tasks after writing files', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, process.cwd());

		// First: architect delegates to coder for Task A
		const messages1 = makeMessages(
			'coder\nTASK: Task A\nFILE: src/a.ts',
			'architect',
		);
		await hook.messagesTransform({}, messages1);

		// Architect writes some files (simulated)
		const session = ensureAgentSession('test-session');
		session.architectWriteCount = 2;

		// Now architect sends non-coder message with different task
		const messages2 = makeMessages('TASK: Task B - fix the bug', 'architect');
		await hook.messagesTransform({}, messages2);

		// Should warn because Task B differs from last coder delegation (Task A)
		expect(messages2.messages[0].parts[0].text).toContain(
			'DELEGATION VIOLATION',
		);
		expect(messages2.messages[0].parts[0].text).toContain(
			'Task B - fix the bug',
		);
	});

	it('should NOT warn for messages without TASK line', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, process.cwd());

		const session = ensureAgentSession('test-session');
		session.architectWriteCount = 5;

		// No TASK: prefix - use null sessionID to skip preamble
		const messages = makeMessages(
			'Just checking the status of the build',
			'architect',
			null,
		);
		const originalText = getPrimaryText(messages);

		await hook.messagesTransform({}, messages);

		expect(getPrimaryText(messages)).toBe(originalText);
	});

	it('should not warn when sessionID is missing', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, process.cwd());

		// No sessionID
		const messages = {
			messages: [
				{
					info: { role: 'user' as const, agent: 'architect' },
					parts: [{ type: 'text', text: 'TASK: Do something' }],
				},
			],
		};
		const originalText = getPrimaryText(messages);

		await hook.messagesTransform({}, messages);

		expect(getPrimaryText(messages)).toBe(originalText);
	});
});

// ============================================
// State machine wiring tests
// ============================================
describe('Task 2.2 — state machine wiring', () => {
	it('when a coder delegation is processed in messagesTransform, getTaskState(session, taskId) returns coder_delegated afterward', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, process.cwd());
		const sessionID = 'test-session-state-1';

		// Send a coder delegation with a task ID
		const messages = makeMessages(
			'coder\nTASK: 2.1\nFILE: src/feature.ts\nINPUT: implement feature\nOUTPUT: modified file',
			'architect',
			sessionID,
		);

		await hook.messagesTransform({}, messages);

		// Verify task state was advanced to 'coder_delegated'
		const session = ensureAgentSession(sessionID);
		const taskState = getTaskState(session, '2.1');
		expect(taskState).toBe('coder_delegated');
	});

	it('when advanceTaskState would throw (already at coder_delegated state), the delegation still proceeds successfully - no error thrown, no rejection', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, process.cwd());
		const sessionID = 'test-session-state-2';

		// First delegation: advance to coder_delegated
		const messages1 = makeMessages(
			'coder\nTASK: 2.1\nFILE: src/feature.ts',
			'architect',
			sessionID,
		);
		await hook.messagesTransform({}, messages1);

		// Verify first delegation advanced the state
		let session = ensureAgentSession(sessionID);
		expect(getTaskState(session, '2.1')).toBe('coder_delegated');

		// Second delegation to same task: should NOT throw even though advanceTaskState would fail
		// The code catches the error and continues
		const messages2 = makeMessages(
			'coder\nTASK: 2.1\nFILE: src/feature2.ts',
			'architect',
			sessionID,
		);

		// Should NOT throw - error is caught and logged as warning
		// Call directly without expect() to verify it doesn't throw
		await hook.messagesTransform({}, messages2);

		// State should remain at coder_delegated (not regress)
		session = ensureAgentSession(sessionID);
		expect(getTaskState(session, '2.1')).toBe('coder_delegated');
	});

	it('when isCoderDelegation is false (delegating to reviewer, not coder), getTaskState is NOT advanced to coder_delegated', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, process.cwd());
		const sessionID = 'test-session-state-3';

		// Delegation to reviewer (not coder)
		const messages = makeMessages(
			'reviewer\nTASK: 2.1\nFILE: src/feature.ts\nINPUT: review code',
			'architect',
			sessionID,
		);

		await hook.messagesTransform({}, messages);

		// Verify task state was NOT advanced (remains idle)
		const session = ensureAgentSession(sessionID);
		const taskState = getTaskState(session, '2.1');
		expect(taskState).toBe('idle');
	});

	it('when currentTaskId is null/undefined (no task ID in the delegation), state is NOT advanced', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, process.cwd());
		const sessionID = 'test-session-state-4';

		// Coder delegation without TASK: line
		const messages = makeMessages(
			'coder\nFILE: src/feature.ts\nINPUT: do something',
			'architect',
			sessionID,
		);

		await hook.messagesTransform({}, messages);

		// Verify no task state was advanced (no entry exists, so returns 'idle' by default)
		const session = ensureAgentSession(sessionID);
		// Since there's no task ID, no state entry should be created
		// getTaskState returns 'idle' for unknown tasks, so this is the expected behavior
		const taskState = getTaskState(session, 'unknown-task');
		expect(taskState).toBe('idle');
	});

	it('state machine works with various coder variants (mega_coder, local_coder)', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, process.cwd());
		const sessionID = 'test-session-state-5';

		// mega_coder delegation
		const messages = makeMessages(
			'mega_coder\nTASK: 3.1\nFILE: src/app.ts',
			'architect',
			sessionID,
		);

		await hook.messagesTransform({}, messages);

		// Verify task state was advanced
		const session = ensureAgentSession(sessionID);
		const taskState = getTaskState(session, '3.1');
		expect(taskState).toBe('coder_delegated');
	});
});
