import { describe, expect, it } from 'bun:test';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import { ensureAgentSession } from '../../../src/state';
import {
	findSystemMessage,
	getPrimaryText,
	getSystemWarningText,
	makeConfig,
	makeMessages,
} from './_delegation-gate-helpers';

// Type for message structure
type TestMessageWithParts = {
	info: { role: string; agent?: string; sessionID?: string };
	parts: Array<{ type: string; text?: string }>;
};

// ============================================
// Task 4.2: Model-Only [NEXT] Guidance Tests (replaces visible deliberation preamble)
// ============================================
describe('Task 4.2: model-only [NEXT] guidance injection (replaces visible deliberation)', () => {
	// Helper to find system message containing [NEXT] guidance
	const findSystemGuidance = (messages: {
		messages: TestMessageWithParts[];
	}) => {
		return messages.messages.find(
			(m) =>
				m.info?.role === 'system' &&
				m.parts?.some((p) => p.text?.includes('[NEXT]')),
		);
	};

	// Helper to get user message text
	const getUserText = (messages: { messages: TestMessageWithParts[] }) => {
		const userMsg = messages.messages.find((m) => m.info?.role === 'user');
		return userMsg?.parts?.[0]?.text ?? '';
	};

	it('null lastGateOutcome → [NEXT] guidance injected as model-only system message', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, process.cwd());
		const sessionID = 'deliberation-test-1';

		// Setup session with no lastGateOutcome (null)
		const session = ensureAgentSession(sessionID);
		session.lastGateOutcome = null;

		// Message with sessionID but no prior gate
		const messages = makeMessages(
			'TASK: Start the implementation',
			undefined,
			sessionID,
		);

		await hook.messagesTransform({}, messages);

		// [NEXT] guidance should be in a system message (model-only), NOT visible in user message
		const userText = getUserText(messages);
		expect(userText).not.toContain('[DELIBERATE:');
		expect(userText).toBe('TASK: Start the implementation');

		// Verify [NEXT] guidance is in a system message
		const guidanceMsg = findSystemGuidance(messages);
		expect(guidanceMsg).toBeDefined();
		expect(guidanceMsg?.parts[0]?.text).toContain('[NEXT]');
		expect(guidanceMsg?.parts[0]?.text).toContain('Begin the first plan task');
	});

	it('passed gate → [NEXT] guidance with PASSED status in system message', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, process.cwd());
		const sessionID = 'deliberation-test-2';

		// Setup session with a passed gate outcome
		const session = ensureAgentSession(sessionID);
		session.lastGateOutcome = {
			gate: 'pre_check_batch',
			taskId: '2.1',
			passed: true,
			timestamp: Date.now() - 1000,
		};

		const messages = makeMessages(
			'TASK: Continue to next task',
			undefined,
			sessionID,
		);

		await hook.messagesTransform({}, messages);

		// User message should NOT contain deliberation preamble
		const userText = getUserText(messages);
		expect(userText).not.toContain('[DELIBERATE:');
		expect(userText).toContain('TASK: Continue to next task');

		// [NEXT] guidance should be in system message
		const guidanceMsg = findSystemGuidance(messages);
		expect(guidanceMsg).toBeDefined();
		expect(guidanceMsg?.parts[0]?.text).toContain(
			'[Last gate: pre_check_batch PASSED for task 2.1]',
		);
		expect(guidanceMsg?.parts[0]?.text).toContain('[NEXT]');
	});

	it('failed gate → [NEXT] guidance with FAILED status in system message', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, process.cwd());
		const sessionID = 'deliberation-test-3';

		// Setup session with a failed gate outcome
		const session = ensureAgentSession(sessionID);
		session.lastGateOutcome = {
			gate: 'reviewer',
			taskId: '3.1',
			passed: false,
			timestamp: Date.now() - 1000,
		};

		const messages = makeMessages(
			'TASK: Fix the failing task',
			undefined,
			sessionID,
		);

		await hook.messagesTransform({}, messages);

		// User message should NOT contain deliberation preamble
		const userText = getUserText(messages);
		expect(userText).not.toContain('[DELIBERATE:');
		expect(userText).toContain('TASK: Fix the failing task');

		// [NEXT] guidance should be in system message
		const guidanceMsg = findSystemGuidance(messages);
		expect(guidanceMsg).toBeDefined();
		expect(guidanceMsg?.parts[0]?.text).toContain(
			'[Last gate: reviewer FAILED for task 3.1]',
		);
		expect(guidanceMsg?.parts[0]?.text).toContain('[NEXT]');
	});

	it('original text unchanged - [NEXT] guidance in separate system message', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, process.cwd());
		const sessionID = 'deliberation-test-4';

		// Setup session with passed gate
		const session = ensureAgentSession(sessionID);
		session.lastGateOutcome = {
			gate: 'test_engineer',
			taskId: '1.2',
			passed: true,
			timestamp: Date.now() - 1000,
		};

		const originalText = 'do the thing';
		const messages = makeMessages(originalText, undefined, sessionID);

		await hook.messagesTransform({}, messages);

		// User message should have original text unchanged
		const userText = getUserText(messages);
		expect(userText).not.toContain('[DELIBERATE:');
		expect(userText).toBe(originalText);

		// [NEXT] guidance should be in system message
		const guidanceMsg = findSystemGuidance(messages);
		expect(guidanceMsg).toBeDefined();
		expect(guidanceMsg?.parts[0]?.text).toContain('[NEXT]');
	});

	it('no sessionID → no [NEXT] guidance (original text unchanged)', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, process.cwd());

		// Message without sessionID
		const messages = {
			messages: [
				{
					info: { role: 'user' as const, agent: undefined },
					parts: [{ type: 'text', text: 'TASK: Do something' }],
				},
			],
		};
		const originalText = getPrimaryText(messages);

		await hook.messagesTransform({}, messages);

		// Text should be unchanged
		expect(getPrimaryText(messages)).toBe(originalText);
		expect(getPrimaryText(messages)).not.toContain('[DELIBERATE:');

		// No system messages should be added
		const systemMessages = messages.messages.filter(
			(m) => m.info?.role === 'system',
		);
		expect(systemMessages.length).toBe(0);
	});

	it('non-coder delegation also gets [NEXT] guidance (runs before isCoderDelegation check)', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, process.cwd());
		const sessionID = 'deliberation-test-6';

		// Setup session with a passed gate
		const session = ensureAgentSession(sessionID);
		session.lastGateOutcome = {
			gate: 'pre_check_batch',
			taskId: '1.1',
			passed: true,
			timestamp: Date.now() - 1000,
		};

		// Non-coder delegation (reviewer)
		const messages = makeMessages(
			'reviewer\nTASK: Review the code\nFILE: src/main.ts',
			'architect',
			sessionID,
		);

		await hook.messagesTransform({}, messages);

		// User message should NOT contain deliberation preamble
		const userText = getUserText(messages);
		expect(userText).not.toContain('[DELIBERATE:');

		// [NEXT] guidance should still be in system message
		const guidanceMsg = findSystemGuidance(messages);
		expect(guidanceMsg).toBeDefined();
		expect(guidanceMsg?.parts[0]?.text).toContain(
			'[Last gate: pre_check_batch PASSED for task 1.1]',
		);
		expect(guidanceMsg?.parts[0]?.text).toContain('[NEXT]');
	});
});
