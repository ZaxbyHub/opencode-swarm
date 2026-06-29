import { describe, expect, it } from 'bun:test';
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
	makeConfig,
	makeMessages,
} from './_delegation-gate-helpers';

// ============================================
// Task 4.1 — Progressive Task Disclosure Tests
// ============================================
describe('Task 4.1 — progressive task disclosure (task window trimming)', () => {
	// Helper to set currentTaskId in session
	const setCurrentTaskId = (sessionID: string, taskId: string | null) => {
		const session = ensureAgentSession(sessionID);
		session.currentTaskId = taskId;
	};

	it('no trimming when 5 or fewer tasks present', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, process.cwd());
		const sessionID = 'test-session-task-window-1';

		// No sessionID to skip preamble injection
		// Exactly 5 task lines - should NOT be trimmed
		const taskList = [
			'- [ ] 1.1: Task one',
			'- [ ] 1.2: Task two',
			'- [x] 1.3: Task three',
			'- [ ] 1.4: Task four',
			'- [ ] 1.5: Task five',
		].join('\n');

		setCurrentTaskId(sessionID, '1.3');
		const messages = makeMessages(taskList, undefined, null);
		const originalText = getPrimaryText(messages);

		await hook.messagesTransform({}, messages);

		// Text should NOT be modified
		expect(getPrimaryText(messages)).toBe(originalText);
		expect(getPrimaryText(messages)).not.toContain('[Task window:');
		expect(getPrimaryText(messages)).not.toContain('tasks hidden');
	});

	it('trims task list when more than 5 tasks and current task in middle', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, process.cwd());
		const sessionID = 'test-session-task-window-2';

		// 10 tasks, current is 1.5 (index 4)
		// Window: 1.3 to 1.8 (indexes 2-7, 6 tasks total)
		// Hidden: 2 before, 2 after
		const taskList = [
			'- [ ] 1.1: Task one',
			'- [ ] 1.2: Task two',
			'- [ ] 1.3: Task three',
			'- [x] 1.4: Task four',
			'- [ ] 1.5: Task five',
			'- [ ] 1.6: Task six',
			'- [ ] 1.7: Task seven',
			'- [ ] 1.8: Task eight',
			'- [ ] 1.9: Task nine',
			'- [ ] 1.10: Task ten',
		].join('\n');

		setCurrentTaskId(sessionID, '1.5');
		const messages = makeMessages(taskList, undefined, sessionID);

		await hook.messagesTransform({}, messages);

		// System message should contain [NEXT] guidance
		const systemMsg = findSystemMessage(messages);
		expect(systemMsg?.parts[0].text).toContain('[NEXT]');

		// User message should contain trimmed task list
		const userMsg = findUserMessage(messages);
		const resultText = userMsg?.parts[0].text ?? '';

		// Should contain hidden marker before
		expect(resultText).toContain('[...2 tasks hidden...]');
		// Should show the visible window tasks
		expect(resultText).toContain('1.3: Task three');
		expect(resultText).toContain('1.4: Task four');
		expect(resultText).toContain('1.5: Task five');
		expect(resultText).toContain('1.6: Task six');
		expect(resultText).toContain('1.7: Task seven');
		expect(resultText).toContain('1.8: Task eight');
		// Should contain hidden marker after
		expect(resultText).toContain('[...2 tasks hidden...]');
		// Should contain the window annotation
		expect(resultText).toContain('[Task window: showing 6 of 10 tasks]');
		// Should NOT contain hidden tasks
		expect(resultText).not.toContain('1.1: Task one');
		expect(resultText).not.toContain('1.2: Task two');
		expect(resultText).not.toContain('1.9: Task nine');
		expect(resultText).not.toContain('1.10: Task ten');
	});

	it('no trimming when currentTaskId is null', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, process.cwd());
		const sessionID = 'test-session-task-window-3';

		// More than 5 tasks but currentTaskId is null - no sessionID to skip preamble
		const taskList = [
			'- [ ] 1.1: Task one',
			'- [ ] 1.2: Task two',
			'- [ ] 1.3: Task three',
			'- [ ] 1.4: Task four',
			'- [ ] 1.5: Task five',
			'- [ ] 1.6: Task six',
			'- [ ] 1.7: Task seven',
		].join('\n');

		setCurrentTaskId(sessionID, null);
		const messages = makeMessages(taskList, undefined, null);

		await hook.messagesTransform({}, messages);

		// With null sessionID, messages[0] is still the user message
		// Text should NOT be modified when currentTaskId is null
		expect(getPrimaryText(messages)).not.toContain('[Task window:');
	});

	it('trims correctly when current task is near the start', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, process.cwd());
		const sessionID = 'test-session-task-window-4';

		// 10 tasks, current is 1.2 (index 1)
		// Window: 1.0 to 1.4 (indexes 0-4, but clamped: 0-4)
		// Hidden: 0 before, 5 after
		const taskList = [
			'- [ ] 1.1: Task one',
			'- [ ] 1.2: Task two',
			'- [ ] 1.3: Task three',
			'- [ ] 1.4: Task four',
			'- [ ] 1.5: Task five',
			'- [ ] 1.6: Task six',
			'- [ ] 1.7: Task seven',
			'- [ ] 1.8: Task eight',
			'- [ ] 1.9: Task nine',
			'- [ ] 1.10: Task ten',
		].join('\n');

		setCurrentTaskId(sessionID, '1.2');
		const messages = makeMessages(taskList, undefined, sessionID);

		await hook.messagesTransform({}, messages);

		const resultText = getPrimaryText(messages);

		// Should NOT have hidden marker before (window clamped at start)
		expect(resultText).not.toMatch(
			/\[\.\.\.\d+ tasks hidden\.\.\.\]\n- \[ \] 1\.1/,
		);
		// Should show visible window (5 tasks: 1.1-1.5)
		expect(resultText).toContain('1.1: Task one');
		expect(resultText).toContain('1.2: Task two');
		expect(resultText).toContain('1.3: Task three');
		expect(resultText).toContain('1.4: Task four');
		expect(resultText).toContain('1.5: Task five');
		// Should have hidden marker after
		expect(resultText).toContain('[...5 tasks hidden...]');
		// Should show correct count
		expect(resultText).toContain('[Task window: showing 5 of 10 tasks]');
		// Should NOT contain hidden tasks
		expect(resultText).not.toContain('1.6: Task six');
		expect(resultText).not.toContain('1.7: Task seven');
		expect(resultText).not.toContain('1.8: Task eight');
		expect(resultText).not.toContain('1.9: Task nine');
		expect(resultText).not.toContain('1.10: Task ten');
	});

	it('trims correctly when current task is near the end', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, process.cwd());
		const sessionID = 'test-session-task-window-5';

		// 10 tasks, current is 1.9 (index 8)
		// Window: 1.7 to 1.10 (indexes 6-9, clamped: 6-9)
		// Hidden: 6 before, 0 after
		const taskList = [
			'- [ ] 1.1: Task one',
			'- [ ] 1.2: Task two',
			'- [ ] 1.3: Task three',
			'- [ ] 1.4: Task four',
			'- [ ] 1.5: Task five',
			'- [ ] 1.6: Task six',
			'- [ ] 1.7: Task seven',
			'- [ ] 1.8: Task eight',
			'- [ ] 1.9: Task nine',
			'- [ ] 1.10: Task ten',
		].join('\n');

		setCurrentTaskId(sessionID, '1.9');
		const messages = makeMessages(taskList, undefined, sessionID);

		await hook.messagesTransform({}, messages);

		// System message should contain [NEXT] guidance
		const systemMsg = findSystemMessage(messages);
		expect(systemMsg?.parts[0].text).toContain('[NEXT]');

		// User message should contain trimmed task list
		const resultText = getPrimaryText(messages);

		// Should have hidden marker before
		expect(resultText).toContain('[...6 tasks hidden...]');
		// Should show visible window (4 tasks: 1.7-1.10)
		expect(resultText).toContain('1.7: Task seven');
		expect(resultText).toContain('1.8: Task eight');
		expect(resultText).toContain('1.9: Task nine');
		expect(resultText).toContain('1.10: Task ten');
		// Should NOT have hidden marker after (window clamped at end)
		expect(resultText).not.toMatch(/1\.10.*\n\[\.\.\.\d+ tasks hidden\.\.\.\]/);
		// Should show correct count
		expect(resultText).toContain('[Task window: showing 4 of 10 tasks]');
		// Should NOT contain hidden tasks
		expect(resultText).not.toContain('1.1: Task one');
		expect(resultText).not.toContain('1.2: Task two');
		expect(resultText).not.toContain('1.3: Task three');
		expect(resultText).not.toContain('1.4: Task four');
		expect(resultText).not.toContain('1.5: Task five');
		expect(resultText).not.toContain('1.6: Task six');
	});

	it('handles currentTaskId not found in task list gracefully', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, process.cwd());
		const sessionID = 'test-session-task-window-6';

		// 10 tasks, but currentTaskId is 9.9 (not in list)
		const taskList = [
			'- [ ] 1.1: Task one',
			'- [ ] 1.2: Task two',
			'- [ ] 1.3: Task three',
			'- [ ] 1.4: Task four',
			'- [ ] 1.5: Task five',
			'- [ ] 1.6: Task six',
			'- [ ] 1.7: Task seven',
			'- [ ] 1.8: Task eight',
			'- [ ] 1.9: Task nine',
			'- [ ] 1.10: Task ten',
		].join('\n');

		setCurrentTaskId(sessionID, '9.9');
		const messages = makeMessages(taskList, undefined, sessionID);

		// Should not throw
		await hook.messagesTransform({}, messages);

		const resultText = getPrimaryText(messages);

		// When current task not found, currentIdx = -1
		// windowStart = Math.max(0, -1 - 2) = Math.max(0, -3) = 0
		// windowEnd = Math.min(9, -1 + 3) = Math.min(9, 2) = 2
		// Shows first 3 tasks with hidden marker after
		expect(resultText).toContain('[...7 tasks hidden...]');
		expect(resultText).toContain('1.1: Task one');
		expect(resultText).toContain('1.2: Task two');
		expect(resultText).toContain('1.3: Task three');
		expect(resultText).toContain('[Task window: showing 3 of 10 tasks]');
	});

	it('preserves text before and after task list', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, process.cwd());
		const sessionID = 'test-session-task-window-7';

		// Set up session with currentTaskId for task window trimming
		setCurrentTaskId(sessionID, '1.4');

		// Need sessionID in message for task window trimming to work
		// This will also add the [NEXT] guidance as model-only system message (not visible)
		const prefixText = 'Here is the current task list:\n\n';
		const suffixText = '\n\nPlease review and proceed.';
		const taskList = [
			'- [ ] 1.1: Task one',
			'- [ ] 1.2: Task two',
			'- [ ] 1.3: Task three',
			'- [ ] 1.4: Task four',
			'- [ ] 1.5: Task five',
			'- [ ] 1.6: Task six',
			'- [ ] 1.7: Task seven',
		].join('\n');

		const messages = makeMessages(
			prefixText + taskList + suffixText,
			undefined,
			sessionID,
		);

		await hook.messagesTransform({}, messages);

		// Find the user message (visible message)
		const userMessage = messages.messages.find((m) => m.info.role === 'user');
		const userText = userMessage?.parts[0]?.text ?? '';

		// [NEXT] guidance should be model-only (in system message), NOT visible in user message
		expect(userText).not.toContain('[DELIBERATE:');
		// After [NEXT] guidance, the prefix should appear
		expect(userText).toContain(prefixText);
		// Suffix should be preserved at the end
		expect(userText).toEndWith(suffixText);
		// The task window should be in the middle
		expect(userText).toContain('[Task window: showing 6 of 7 tasks]');
		expect(userText).toContain('[...1 tasks hidden...]');

		// Verify [NEXT] guidance is in a system message (model-only)
		const systemMessages = messages.messages.filter(
			(m) => m.info.role === 'system',
		);
		expect(systemMessages.length).toBeGreaterThan(0);
		const hasNextGuidance = systemMessages.some((m) =>
			m.parts.some((p) => p.text?.includes('[NEXT]')),
		);
		expect(hasNextGuidance).toBe(true);
	});

	it('works with mega_architect agent', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, process.cwd());
		const sessionID = 'test-session-task-window-8';

		// Using mega_architect should also work (architect prefix stripped)
		const taskList = [
			'- [ ] 1.1: Task one',
			'- [ ] 1.2: Task two',
			'- [ ] 1.3: Task three',
			'- [ ] 1.4: Task four',
			'- [ ] 1.5: Task five',
			'- [ ] 1.6: Task six',
			'- [ ] 1.7: Task seven',
		].join('\n');

		setCurrentTaskId(sessionID, '1.4');
		const messages = makeMessages(taskList, 'mega_architect', sessionID);

		await hook.messagesTransform({}, messages);

		const resultText = getPrimaryText(messages);
		expect(resultText).toContain('[Task window: showing 6 of 7 tasks]');
	});

	it('does not trim for non-architect agents', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, process.cwd());
		const sessionID = 'test-session-task-window-9';

		const taskList = [
			'- [ ] 1.1: Task one',
			'- [ ] 1.2: Task two',
			'- [ ] 1.3: Task three',
			'- [ ] 1.4: Task four',
			'- [ ] 1.5: Task five',
			'- [ ] 1.6: Task six',
			'- [ ] 1.7: Task seven',
		].join('\n');

		setCurrentTaskId(sessionID, '1.4');
		const messages = makeMessages(taskList, 'coder', sessionID); // Non-architect agent
		const originalText = getPrimaryText(messages);

		await hook.messagesTransform({}, messages);

		// Text should NOT be modified for non-architect
		expect(getPrimaryText(messages)).toBe(originalText);
		expect(getPrimaryText(messages)).not.toContain('[Task window:');
	});

	it('handles different task list formats (checked, unchecked, plain)', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, process.cwd());
		const sessionID = 'test-session-task-window-10';

		// Mixed format: - [x] checked, - [ ] unchecked, - plain
		// currentTaskId = '1.4' (index 3)
		// Window: indexes [1, 6] = 6 tasks: 1.2-1.7
		const taskList = [
			'- [x] 1.1: Completed task',
			'- [ ] 1.2: Pending task',
			'- 1.3: Plain task',
			'- [x] 1.4: Another completed',
			'- [ ] 1.5: Another pending',
			'- [ ] 1.6: More pending',
			'- [ ] 1.7: Even more',
		].join('\n');

		setCurrentTaskId(sessionID, '1.4');
		const messages = makeMessages(taskList, undefined, sessionID);

		await hook.messagesTransform({}, messages);

		const resultText = getPrimaryText(messages);

		// Should detect and trim all formats
		expect(resultText).toContain('[Task window: showing 6 of 7 tasks]');
		// Window shows 1.2-1.7 (1.1 is hidden)
		expect(resultText).toContain('[...1 tasks hidden...]');
		// Visible window should have these tasks
		expect(resultText).toContain('[ ] 1.2: Pending task');
		expect(resultText).toMatch(/- 1\.3: Plain task/);
		expect(resultText).toContain('[x] 1.4: Another completed');
		expect(resultText).toContain('[ ] 1.5: Another pending');
		expect(resultText).toContain('[ ] 1.6: More pending');
		expect(resultText).toContain('[ ] 1.7: Even more');
		// Hidden task should not be visible
		expect(resultText).not.toContain('[x] 1.1: Completed task');
	});
});
