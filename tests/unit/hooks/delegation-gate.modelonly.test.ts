import { describe, expect, it } from 'bun:test';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import { ensureAgentSession } from '../../../src/state';
import {
	findSystemMessage,
	findUserMessage,
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
// Task 2.6: Delegation Warnings Model-Only Tests
// Verifies delegation warnings remain model-only (in system messages)
// and no delegation debug text leaks into visible output
// ============================================
describe('Task 2.6: delegation warnings model-only (no visible debug leakage)', () => {
	// Helper to find system messages containing warnings
	const findSystemWarnings = (messages: {
		messages: TestMessageWithParts[];
	}) => {
		return messages.messages.filter((m) => m.info?.role === 'system');
	};

	// Helper to get user message text
	const getUserText = (messages: { messages: TestMessageWithParts[] }) => {
		const userMsg = messages.messages.find((m) => m.info?.role === 'user');
		return userMsg?.parts?.[0]?.text ?? '';
	};

	it('[NEXT] guidance should be in system message only, NOT in visible user message', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, process.cwd());
		const sessionID = 'model-only-test-1';

		// Setup session with lastGateOutcome
		const session = ensureAgentSession(sessionID);
		session.lastGateOutcome = {
			gate: 'pre_check_batch',
			taskId: '2.1',
			passed: true,
			timestamp: Date.now() - 1000,
		};

		const messages = makeMessages(
			'TASK: Continue implementation',
			undefined,
			sessionID,
		);

		await hook.messagesTransform({}, messages);

		// User message should NOT contain [NEXT] guidance
		const userText = getUserText(messages);
		expect(userText).not.toContain('[NEXT]');
		expect(userText).not.toContain('[Last gate:');
		expect(userText).toBe('TASK: Continue implementation');

		// [NEXT] guidance should be in system message
		const systemMessages = findSystemWarnings(messages);
		expect(systemMessages.length).toBeGreaterThan(0);
		const hasNextGuidance = systemMessages.some((m) =>
			m.parts?.some((p) => p.text?.includes('[NEXT]')),
		);
		expect(hasNextGuidance).toBe(true);
	});

	it('[DELEGATION VIOLATION] should be in system message only, NOT in visible user message', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, process.cwd());
		const sessionID = 'model-only-test-2';

		// Setup session with architect writes
		const session = ensureAgentSession(sessionID);
		session.architectWriteCount = 3;

		// Non-coder message with task ID different from last coder delegation
		const messages = makeMessages(
			'TASK: Fix validation',
			'architect',
			sessionID,
		);

		await hook.messagesTransform({}, messages);

		// User message should NOT contain [DELEGATION VIOLATION]
		const userText = getUserText(messages);
		expect(userText).not.toContain('[DELEGATION VIOLATION]');
		expect(userText).toContain('TASK: Fix validation');

		// [DELEGATION VIOLATION] should be in system message
		const systemMessages = findSystemWarnings(messages);
		const hasDelegationViolation = systemMessages.some((m) =>
			m.parts?.some((p) => p.text?.includes('[DELEGATION VIOLATION]')),
		);
		expect(hasDelegationViolation).toBe(true);
	});

	it('⚠️ BATCH DETECTED warning should be in system message only, NOT in visible user message', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, process.cwd());
		const sessionID = 'model-only-test-3';

		// Setup session for [NEXT] guidance
		const session = ensureAgentSession(sessionID);
		session.lastGateOutcome = {
			gate: 'pre_check_batch',
			taskId: '1.1',
			passed: true,
			timestamp: Date.now() - 1000,
		};

		// Oversized coder delegation to trigger batch warning
		const longText =
			'coder\nTASK: Add validation\nINPUT: ' +
			'a'.repeat(4000) +
			'\nFILE: src/test.ts';
		const messages = makeMessages(longText, 'architect', sessionID);

		await hook.messagesTransform({}, messages);

		// User message should NOT contain ⚠️ BATCH DETECTED
		const userText = getUserText(messages);
		expect(userText).not.toContain('⚠️ BATCH DETECTED');
		expect(userText).not.toContain('exceeds recommended size');

		// Batch warning should be in system message
		const systemMessages = findSystemWarnings(messages);
		const hasBatchWarning = systemMessages.some((m) =>
			m.parts?.some((p) => p.text?.includes('⚠️ BATCH DETECTED')),
		);
		expect(hasBatchWarning).toBe(true);
	});

	it('⚠️ PROTOCOL VIOLATION warning should be in system message only, NOT in visible user message', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, process.cwd());
		const sessionID = 'model-only-test-4';

		// Setup session with QA skip scenario
		const session = ensureAgentSession(sessionID);
		session.lastGateOutcome = {
			gate: 'test_engineer',
			taskId: '1.1',
			passed: true,
			timestamp: Date.now() - 1000,
		};
		session.qaSkipCount = 0;
		session.qaSkipTaskIds = [];

		// Setup delegation chain with coder → coder (no QA)
		swarmState.delegationChains.set(sessionID, [
			{ from: 'architect', to: 'mega_coder', timestamp: 1 },
			{ from: 'mega_coder', to: 'architect', timestamp: 2 },
			{ from: 'architect', to: 'mega_coder', timestamp: 3 }, // Second coder without QA
		]);

		const messages = makeMessages(
			'mega_coder\nTASK: 1.2\nFILE: src/foo.ts\nINPUT: do stuff\nOUTPUT: modified file',
			'architect',
			sessionID,
		);

		await hook.messagesTransform({}, messages);

		// User message should NOT contain ⚠️ PROTOCOL VIOLATION
		const userText = getUserText(messages);
		expect(userText).not.toContain('⚠️ PROTOCOL VIOLATION');
		expect(userText).not.toContain('QA gate was skipped');

		// Protocol violation warning should be in system message
		const systemMessages = findSystemWarnings(messages);
		const hasProtocolViolation = systemMessages.some((m) =>
			m.parts?.some((p) => p.text?.includes('⚠️ PROTOCOL VIOLATION')),
		);
		expect(hasProtocolViolation).toBe(true);
	});

	it('Multiple warnings should all be consolidated in system messages, not visible in user output', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, process.cwd());
		const sessionID = 'model-only-test-5';

		// Setup session with lastGateOutcome
		const session = ensureAgentSession(sessionID);
		session.lastGateOutcome = {
			gate: 'reviewer',
			taskId: '2.1',
			passed: false,
			timestamp: Date.now() - 1000,
		};

		// Oversized coder delegation with multiple issues
		const longText =
			'coder\nTASK: Add validation\nFILE: src/auth.ts\nFILE: src/login.ts\nINPUT: ' +
			'a'.repeat(4000);
		const messages = makeMessages(longText, 'architect', sessionID);

		await hook.messagesTransform({}, messages);

		// User message should NOT contain any warnings
		const userText = getUserText(messages);
		expect(userText).not.toContain('⚠️');
		expect(userText).not.toContain('[NEXT]');
		expect(userText).not.toContain('[Last gate:');
		expect(userText).not.toContain('[DELEGATION VIOLATION]');
		expect(userText).not.toContain('Multiple FILE:');

		// All warnings should be in system messages
		const systemMessages = findSystemWarnings(messages);
		expect(systemMessages.length).toBeGreaterThan(0);

		// System messages should contain guidance
		const allSystemText = systemMessages
			.map((m) => m.parts?.[0]?.text ?? '')
			.join('\n');
		expect(allSystemText).toContain('[NEXT]');
	});

	it('Original task text should be preserved unchanged in user message (no debug prefix/suffix)', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, process.cwd());
		const sessionID = 'model-only-test-6';

		// Setup session
		const session = ensureAgentSession(sessionID);
		session.lastGateOutcome = {
			gate: 'pre_check',
			taskId: '1.1',
			passed: true,
			timestamp: Date.now(),
		};

		const originalTaskText =
			'coder\nTASK: Implement feature X\nFILE: src/feature.ts\nINPUT: Do the thing';
		const messages = makeMessages(originalTaskText, 'architect', sessionID);

		await hook.messagesTransform({}, messages);

		// User message should contain original text unchanged (just the task, no debug info)
		const userText = getUserText(messages);
		expect(userText).toContain('TASK: Implement feature X');
		expect(userText).toContain('FILE: src/feature.ts');
		expect(userText).toContain('INPUT: Do the thing');

		// Should NOT have any debug prefixes
		expect(userText).not.toMatch(/^⚠️/);
		expect(userText).not.toMatch(/^\[/);
	});

	it('No delegation debug text should leak when sessionID is null (no system guidance injected)', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, process.cwd());

		// Large message but no sessionID - should still not leak debug info
		const largeText = 'TASK: ' + 'a'.repeat(5000);
		const messages = makeMessages(largeText, 'architect', null);

		await hook.messagesTransform({}, messages);

		// User message should have original text unchanged
		const userText = getUserText(messages);
		expect(userText).not.toContain('[NEXT]');
		expect(userText).not.toContain('[DELEGATION VIOLATION]');
		expect(userText).toBe(largeText);

		// Model-only guidance ([NEXT], [DELEGATION VIOLATION]) should NOT be injected without sessionID
		const systemMessages = findSystemWarnings(messages);
		const allSystemText = systemMessages
			.map((m) => m.parts?.[0]?.text ?? '')
			.join('\n');
		expect(allSystemText).not.toContain('[NEXT]');
		expect(allSystemText).not.toContain('[DELEGATION VIOLATION]');
		// Batch warning may be present in system messages (model-only) for oversized content
	});

	it('Combined test: both [NEXT] guidance and batch warnings in separate system messages', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, process.cwd());
		const sessionID = 'model-only-test-7';

		// Setup session
		const session = ensureAgentSession(sessionID);
		session.lastGateOutcome = {
			gate: 'test_engineer',
			taskId: '3.1',
			passed: true,
			timestamp: Date.now() - 500,
		};

		// Oversized delegation to trigger batch warning
		const longText =
			'coder\nTASK: Task 3.2\nFILE: src/main.ts\nINPUT: ' + 'x'.repeat(4500);
		const messages = makeMessages(longText, 'architect', sessionID);

		await hook.messagesTransform({}, messages);

		// User message: no warnings visible
		const userText = getUserText(messages);
		expect(userText).not.toContain('⚠️');
		expect(userText).not.toContain('[NEXT]');
		expect(userText).not.toContain('[Last gate:');

		// System messages: should have both [NEXT] guidance AND batch warning
		const systemMessages = findSystemWarnings(messages);
		expect(systemMessages.length).toBeGreaterThanOrEqual(2);

		const allSystemText = systemMessages
			.map((m) => m.parts?.[0]?.text ?? '')
			.join('\n');
		expect(allSystemText).toContain('[NEXT]');
		expect(allSystemText).toContain(
			'[Last gate: test_engineer PASSED for task 3.1]',
		);
		expect(allSystemText).toContain('⚠️ BATCH DETECTED');
	});
});

// Import swarmState for the test that uses it
import { swarmState } from '../../../src/state';
