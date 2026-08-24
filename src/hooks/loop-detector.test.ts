import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { ensureAgentSession, resetSwarmState, swarmState } from '../state';
import { detectLoop } from './loop-detector';

const SESSION_ID = 'test-session-loop-detector';

function taskArgs(
	subagentType: string,
	firstKey?: Record<string, unknown>,
): Record<string, unknown> {
	return {
		subagent_type: subagentType,
		...(firstKey ?? { taskId: 'task-1' }),
	};
}

describe('loop-detector', () => {
	beforeEach(() => {
		resetSwarmState();
		ensureAgentSession(SESSION_ID, 'test-agent');
	});

	afterEach(() => {
		resetSwarmState();
	});

	// ─────────────────────────────────────────────────────────────
	// Required test cases from plan task 2.3
	// ─────────────────────────────────────────────────────────────

	describe('required cases', () => {
		it('1. No loop when 3 different Task delegations occur (count stays at 1 each)', () => {
			// Different subagent_type → different hash → no loop
			const r1 = detectLoop(
				SESSION_ID,
				'Task',
				taskArgs('coder', { taskId: 't1' }),
			);
			expect(r1.looping).toBe(false);
			expect(r1.count).toBe(1);

			const r2 = detectLoop(
				SESSION_ID,
				'Task',
				taskArgs('reviewer', { taskId: 't2' }),
			);
			expect(r2.looping).toBe(false);
			expect(r2.count).toBe(1);

			const r3 = detectLoop(
				SESSION_ID,
				'Task',
				taskArgs('explorer', { taskId: 't3' }),
			);
			expect(r3.looping).toBe(false);
			expect(r3.count).toBe(1);
		});

		it('2. Loop detected when same (Task, coder) pattern repeats 3 times', () => {
			const args = taskArgs('coder', { taskId: 'same-task' });

			const r1 = detectLoop(SESSION_ID, 'Task', args);
			expect(r1.looping).toBe(false);
			expect(r1.count).toBe(1);

			const r2 = detectLoop(SESSION_ID, 'Task', args);
			expect(r2.looping).toBe(false);
			expect(r2.count).toBe(2);

			const r3 = detectLoop(SESSION_ID, 'Task', args);
			expect(r3.looping).toBe(true);
			expect(r3.count).toBe(3);
			// Issue #2103 workstream B: the pattern is now a semantic digest
			// `Task:<role>#[taskId?]:<argDigest>` — assert the stable prefix.
			expect(r3.pattern).toMatch(/^Task:coder:/);
		});

		it('3. Loop counter resets when a different pattern intervenes (A, A, B, A → count back to 1)', () => {
			const argsA = taskArgs('coder', { taskId: 'task-a' });
			const argsB = taskArgs('reviewer', { taskId: 'task-b' });

			// A, A
			detectLoop(SESSION_ID, 'Task', argsA);
			const r2 = detectLoop(SESSION_ID, 'Task', argsA);
			expect(r2.count).toBe(2);
			expect(r2.looping).toBe(false);

			// B (intervening pattern breaks consecutive chain)
			detectLoop(SESSION_ID, 'Task', argsB);

			// A again → count resets to 1
			const r4 = detectLoop(SESSION_ID, 'Task', argsA);
			expect(r4.looping).toBe(false);
			expect(r4.count).toBe(1);
		});

		it('4. Circuit breaker threshold: 5 consecutive identical → count === 5', () => {
			const args = taskArgs('coder', { taskId: 'loop-task' });

			for (let i = 1; i <= 5; i++) {
				const r = detectLoop(SESSION_ID, 'Task', args);
				expect(r.count).toBe(i);
				expect(r.looping).toBe(i >= 3);
			}
		});

		it('5. Non-delegation tools (bash, read, write) are not tracked → always returns { looping: false, count: 0 }', () => {
			const tools = ['bash', 'read', 'write', 'edit', 'grep'] as const;

			for (const tool of tools) {
				const r = detectLoop(SESSION_ID, tool, { command: 'echo hello' });
				expect(r.looping).toBe(false);
				expect(r.count).toBe(0);
				expect(r.pattern).toBe('');
			}

			// Also verify session state exists (loopDetectionWindow initialized to [] by ensureAgentSession)
			const session = swarmState.agentSessions.get(SESSION_ID);
			expect(session?.loopDetectionWindow).toEqual([]);
		});
	});

	// ─────────────────────────────────────────────────────────────
	// Additional adversarial cases
	// ─────────────────────────────────────────────────────────────

	describe('adversarial cases', () => {
		it('6. Session not found → safe default returned (no throw)', () => {
			const r = detectLoop('non-existent-session', 'Task', taskArgs('coder'));
			expect(r.looping).toBe(false);
			expect(r.count).toBe(0);
			expect(r.pattern).toBe('');
		});

		it('7. null args → handled gracefully', () => {
			// Should not throw, should treat as noargs
			const r = detectLoop(SESSION_ID, 'Task', null);
			expect(r.looping).toBe(false);
			expect(r.count).toBe(1);
			expect(r.pattern).toMatch(/^Task:unknown:/);
		});

		it('8. Array args → handled gracefully (not treated as Record)', () => {
			// Arrays are not Records, so should be treated as undefined args
			const r = detectLoop(SESSION_ID, 'Task', ['coder', 'task-1'] as unknown);
			expect(r.looping).toBe(false);
			// Array is not a proper object, so argsRecord becomes undefined
			// digest becomes Task:unknown:<empty-args digest>
			expect(r.pattern).toMatch(/^Task:unknown:/);
			expect(r.count).toBe(1);
		});

		it('9. Window capped at 10 → only last 10 entries retained', () => {
			// Use 12 entries to verify window caps at 10
			const argsDifferent = (n: number) =>
				taskArgs('coder', { taskId: `t${n}` });

			for (let i = 1; i <= 12; i++) {
				detectLoop(SESSION_ID, 'Task', argsDifferent(i));
			}

			const session = swarmState.agentSessions.get(SESSION_ID);
			expect(session?.loopDetectionWindow?.length).toBe(10);
		});

		it('10. Consecutive count resets correctly in the middle of a long sequence', () => {
			// A, A, A (count=3, looping), B (count=1), A (count=1)
			// Use different subagent_type so hashes differ
			const argsA = { taskId: 'a-task', subagent_type: 'coder' };
			const argsB = { taskId: 'b-task', subagent_type: 'reviewer' };

			detectLoop(SESSION_ID, 'Task', argsA); // 1
			detectLoop(SESSION_ID, 'Task', argsA); // 2
			const r3 = detectLoop(SESSION_ID, 'Task', argsA); // 3 — loop detected
			expect(r3.looping).toBe(true);
			expect(r3.count).toBe(3);

			detectLoop(SESSION_ID, 'Task', argsB); // B breaks chain

			const r5 = detectLoop(SESSION_ID, 'Task', argsA); // fresh count = 1
			expect(r5.looping).toBe(false);
			expect(r5.count).toBe(1);
		});
	});

	// ─────────────────────────────────────────────────────────────
	// Edge cases & invariants
	// ─────────────────────────────────────────────────────────────

	describe('edge cases', () => {
		it('undefined args treated as noargs', () => {
			const r = detectLoop(SESSION_ID, 'Task', undefined);
			expect(r.pattern).toMatch(/^Task:unknown:/);
			expect(r.count).toBe(1);
		});

		it('different firstArgKey creates different hash', () => {
			// Different first key (subagent_type comes second, so first key differs)
			const args1 = { taskId: 't1', subagent_type: 'coder' };
			const args2 = { file: 'src/foo.ts', subagent_type: 'coder' };

			const r1 = detectLoop(SESSION_ID, 'Task', args1);
			const r2 = detectLoop(SESSION_ID, 'Task', args2);

			expect(r1.pattern).toMatch(/^Task:coder:/);
			expect(r2.pattern).toMatch(/^Task:coder:/);
			expect(r1.pattern).not.toBe(r2.pattern);
		});

		it('first arg key is empty string when args is empty object', () => {
			const r = detectLoop(SESSION_ID, 'Task', { subagent_type: 'coder' });
			expect(r.pattern).toMatch(/^Task:coder:/);
			expect(r.count).toBe(1);
		});

		it('repeated calls accumulate in window correctly', () => {
			const args = { taskId: 'test-task', subagent_type: 'test-engineer' };

			detectLoop(SESSION_ID, 'Task', args);
			detectLoop(SESSION_ID, 'Task', args);
			detectLoop(SESSION_ID, 'Task', args);
			detectLoop(SESSION_ID, 'Task', args);
			detectLoop(SESSION_ID, 'Task', args);

			const session = swarmState.agentSessions.get(SESSION_ID);
			expect(session?.loopDetectionWindow?.length).toBe(5);
			expect(
				session?.loopDetectionWindow?.every((e) =>
					e.hash.startsWith('Task:test-engineer:'),
				),
			).toBe(true);
		});

		it('mixed patterns maintain correct window', () => {
			const argsA = { taskId: 'a', subagent_type: 'coder' };
			const argsB = { taskId: 'b', subagent_type: 'reviewer' };
			const argsC = { taskId: 'c', subagent_type: 'explorer' };

			detectLoop(SESSION_ID, 'Task', argsA);
			detectLoop(SESSION_ID, 'Task', argsA);
			detectLoop(SESSION_ID, 'Task', argsB);
			detectLoop(SESSION_ID, 'Task', argsB);
			detectLoop(SESSION_ID, 'Task', argsC);

			const session = swarmState.agentSessions.get(SESSION_ID);
			expect(session?.loopDetectionWindow?.length).toBe(5);

			// Last entry should be C
			const last = session?.loopDetectionWindow?.at(-1);
			expect(last?.hash?.startsWith('Task:explorer:')).toBe(true);
		});
	});
});
