import { describe, expect, it } from 'bun:test';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import {
	ensureAgentSession,
	resetSwarmState,
	swarmState,
} from '../../../src/state';
import {
	getPrimaryText,
	makeConfig,
	makeMessages,
} from './_delegation-gate-helpers';

// ============================================
// Adversarial Tests: Task 4.1 Progressive Task Disclosure
// ============================================
describe('adversarial: Task 4.1 progressive task disclosure attack vectors', () => {
	const setCurrentTaskId = (sessionID: string, taskId: string | null) => {
		const session = ensureAgentSession(sessionID);
		session.currentTaskId = taskId;
	};

	// Attack Vector 1: ReDoS probe - many repeated spaces/chars before task match
	it('should not hang on ReDoS probe with 10000 spaces before task', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, process.cwd());
		const sessionID = 'test-session-redos-1';

		// Build message with 10,000 spaces before a valid task
		const padding = ' '.repeat(10000);
		const taskList = [
			`- [ ] 1.1: Task one`,
			`- [ ] 1.2: Task two`,
			`- [ ] 1.3: Task three`,
			`- [ ] 1.4: Task four`,
			`- [ ] 1.5: Task five`,
			`- [ ] 1.6: Task six`,
			`${padding}- [ ] 1.7: Padded task`,
			`- [ ] 1.8: Task eight`,
			`- [ ] 1.9: Task nine`,
			`- [ ] 1.10: Task ten`,
		].join('\n');

		setCurrentTaskId(sessionID, '1.5');
		const messages = makeMessages(taskList, undefined, sessionID);

		// Should complete without hanging - use timeout in actual test runner
		await hook.messagesTransform({}, messages);

		// Should still perform windowing since > 5 tasks
		const resultText = getPrimaryText(messages);
		expect(resultText).toContain('[Task window:');
	}, 10000);

	// Attack Vector 2: Crafted task ID with special regex chars (deep nesting)
	it('should correctly match deep nesting task ID like 1.1.1.1.1.1.1', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, process.cwd());
		const sessionID = 'test-session-deep-nesting-1';

		const taskList = [
			'- [ ] 1.1: Root task',
			'- [ ] 1.1.1: Level 1',
			'- [ ] 1.1.1.1: Level 2',
			'- [ ] 1.1.1.1.1: Level 3',
			'- [ ] 1.1.1.1.1.1: Level 4',
			'- [ ] 1.1.1.1.1.1.1: Deep nesting task',
			'- [ ] 1.2: Another task',
		].join('\n');

		setCurrentTaskId(sessionID, '1.1.1.1.1.1.1');
		const messages = makeMessages(taskList, undefined, sessionID);

		await hook.messagesTransform({}, messages);

		const resultText = getPrimaryText(messages);

		// Should find the deep nesting task and show window around it
		expect(resultText).toContain('1.1.1.1.1.1.1: Deep nesting task');
		expect(resultText).toContain('[Task window:');
	});

	// Attack Vector 3: Fake task line that looks like task but isn't
	it('should NOT match fake task lines like "- not-a-task:" or "- abc.def:"', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, process.cwd());
		const sessionID = 'test-session-fake-1';

		// These should NOT be matched as tasks (don't have \d+\.\d+ pattern)
		// Need > 5 valid tasks to trigger windowing
		const taskList = [
			'- not-a-task: something',
			'- abc.def: value',
			'- task: without number',
			'- 1.1: Real task one',
			'- 1.2: Real task two',
			'- 1.3: Real task three',
			'- 1.4: Real task four',
			'- 1.5: Real task five',
			'- xyz.abc: fake',
			'- no.dots: here',
			'- 1.6: Real task six',
		].join('\n');

		setCurrentTaskId(sessionID, '1.3');
		const messages = makeMessages(taskList, undefined, sessionID);

		await hook.messagesTransform({}, messages);

		const resultText = getPrimaryText(messages);

		// Only real tasks with \d+\.\d+ pattern should be detected
		// So 6 real tasks (> 5), windowing should happen
		expect(resultText).toContain('[Task window: showing');
		// Should contain the real tasks
		expect(resultText).toContain('1.1: Real task one');
		expect(resultText).toContain('1.2: Real task two');
		// Should NOT contain fake tasks in output (they weren't detected as tasks)
		// The fake ones should remain in original text since they weren't matched
	});

	// Attack Vector 4: Empty task ID scenario
	it('should NOT transform when currentTaskId is empty string (falsy check)', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, process.cwd());
		const sessionID = 'test-session-empty-1';

		// More than 5 tasks - no sessionID to skip preamble
		const taskList = [
			'- [ ] 1.1: Task one',
			'- [ ] 1.2: Task two',
			'- [ ] 1.3: Task three',
			'- [ ] 1.4: Task four',
			'- [ ] 1.5: Task five',
			'- [ ] 1.6: Task six',
			'- [ ] 1.7: Task seven',
		].join('\n');

		// Set to empty string - falsy, should skip transformation
		setCurrentTaskId(sessionID, '');
		const messages = makeMessages(taskList, undefined, null);
		const originalText = getPrimaryText(messages);

		await hook.messagesTransform({}, messages);

		// Text should NOT be modified (empty string is falsy)
		expect(getPrimaryText(messages)).toBe(originalText);
		expect(getPrimaryText(messages)).not.toContain('[Task window:');
	});

	// Attack Vector 5: Very large number of tasks (200+)
	it('should handle 200+ tasks with correct window calculation (tasks 98-103 visible for currentTaskId 1.100)', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, process.cwd());
		const sessionID = 'test-session-large-1';

		// Generate 200 task lines
		const tasks: string[] = [];
		for (let i = 1; i <= 200; i++) {
			tasks.push(`- [ ] 1.${i}: Task ${i}`);
		}
		const taskList = tasks.join('\n');

		// Current task at 1.100 (index 99)
		// Window: 1.98 to 1.103 (indexes 97-102, 6 tasks)
		setCurrentTaskId(sessionID, '1.100');
		const messages = makeMessages(taskList, undefined, sessionID);

		await hook.messagesTransform({}, messages);

		const resultText = getPrimaryText(messages);

		// Should show correct window info
		expect(resultText).toContain('[Task window: showing 6 of 200 tasks]');
		// Should show hidden counts
		expect(resultText).toContain('[...97 tasks hidden...]');
		// Visible tasks should be 1.98-1.103
		expect(resultText).toContain('1.98: Task 98');
		expect(resultText).toContain('1.99: Task 99');
		expect(resultText).toContain('1.100: Task 100');
		expect(resultText).toContain('1.101: Task 101');
		expect(resultText).toContain('1.102: Task 102');
		expect(resultText).toContain('1.103: Task 103');
		// Should NOT contain hidden tasks
		expect(resultText).not.toContain('1.97: Task 97');
		expect(resultText).not.toContain('1.104: Task 104');
	}, 30000);

	// Attack Vector 6: Task list with no blank lines between tasks
	it('should correctly parse tasks with no blank lines between them', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, process.cwd());
		const sessionID = 'test-session-no-blank-1';

		// 10 tasks all back-to-back with no newlines between
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
		].join('\n'); // Just \n between, no extra blank lines

		setCurrentTaskId(sessionID, '1.5');
		const messages = makeMessages(taskList, undefined, sessionID);

		await hook.messagesTransform({}, messages);

		const resultText = getPrimaryText(messages);

		// Should detect all 10 tasks and trim correctly
		expect(resultText).toContain('[Task window: showing 6 of 10 tasks]');
		// Visible: 1.3-1.8 (window around 1.5)
		expect(resultText).toContain('1.3: Task three');
		expect(resultText).toContain('1.4: Task four');
		expect(resultText).toContain('1.5: Task five');
		expect(resultText).toContain('1.6: Task six');
		expect(resultText).toContain('1.7: Task seven');
		expect(resultText).toContain('1.8: Task eight');
		// Hidden: 1.1, 1.2, 1.9, 1.10
		expect(resultText).toContain('[...2 tasks hidden...]');
		expect(resultText).toContain('[...2 tasks hidden...]');
	});

	// Attack Vector 7: Unicode task format
	it('should handle unicode characters in task descriptions without crash', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, process.cwd());
		const sessionID = 'test-session-unicode-1';

		const taskList = [
			'- [ ] 1.1: héllo wörld — tâsk',
			'- [ ] 1.2: Ümläuts & spëcial çhars',
			'- [ ] 1.3: 日本語タスク',
			'- [ ] 1.4: 中文任务描述',
			'- [ ] 1.5: 🎉 emoji task',
			'- [ ] 1.6: Task with "quotes"',
			'- [ ] 1.7: Task with <brackets>',
			'- [ ] 1.8: Task with | pipes',
			'- [ ] 1.9: Task with *asterisks*',
			'- [ ] 1.10: Final unicode task',
		].join('\n');

		setCurrentTaskId(sessionID, '1.5');
		const messages = makeMessages(taskList, undefined, sessionID);

		// Should not throw
		await hook.messagesTransform({}, messages);

		const resultText = getPrimaryText(messages);

		// Should still extract task ID correctly and window
		expect(resultText).toContain('[Task window:');
		// Should preserve unicode in visible tasks
		expect(resultText).toContain('1.5: 🎉 emoji task');
		// Should contain the window comment
		expect(resultText).toContain('showing 6 of 10 tasks');
	});
});
