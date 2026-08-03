import { beforeEach, describe, expect, it } from 'bun:test';
import { resolveAgentConflict } from '../hooks/conflict-resolution';
import { ensureAgentSession, resetSwarmState } from '../state';

const SESSION_ID = 'test-conflict-session';

beforeEach(() => {
	resetSwarmState();
});

describe('resolveAgentConflict', () => {
	it('pushes CONFLICT DETECTED advisory when rejectionCount < 3', () => {
		ensureAgentSession(SESSION_ID, 'architect');

		resolveAgentConflict({
			sessionID: SESSION_ID,
			phase: 1,
			taskId: 'task-1',
			sourceAgent: 'reviewer',
			targetAgent: 'coder',
			conflictType: 'feedback_rejection',
			rejectionCount: 2,
			summary: 'Reviewer rejected coder output twice',
		});

		const session = ensureAgentSession(SESSION_ID);
		expect(session.pendingAdvisoryMessages).toBeDefined();
		const msgs = session.pendingAdvisoryMessages ?? [];
		expect(msgs.length).toBe(1);
		expect(msgs[0]).toContain('CONFLICT DETECTED');
		expect(msgs[0]).toContain('reviewer');
		expect(msgs[0]).toContain('coder');
		expect(msgs[0]).toContain('task-1');
	});

	it('pushes CONFLICT ESCALATION advisory when rejectionCount >= 3', () => {
		ensureAgentSession(SESSION_ID, 'architect');

		resolveAgentConflict({
			sessionID: SESSION_ID,
			phase: 2,
			taskId: 'task-2',
			sourceAgent: 'coder',
			targetAgent: 'reviewer',
			conflictType: 'retry_spiral',
			rejectionCount: 3,
			summary: 'Three failed cycles',
		});

		const session = ensureAgentSession(SESSION_ID);
		const msgs = session.pendingAdvisoryMessages ?? [];
		expect(msgs.length).toBe(1);
		expect(msgs[0]).toContain('CONFLICT ESCALATION');
		expect(msgs[0]).toContain('coder');
		expect(msgs[0]).toContain('reviewer');
		expect(msgs[0]).toContain('task-2');
		expect(msgs[0]).toContain('SOUNDING_BOARD');
	});

	it('uses soundingboard resolutionPath when rejectionCount >= 3', () => {
		ensureAgentSession(SESSION_ID, 'architect');

		resolveAgentConflict({
			sessionID: SESSION_ID,
			phase: 1,
			taskId: 'task-3',
			sourceAgent: 'architect',
			targetAgent: 'critic',
			conflictType: 'quality_gate_dispute',
			rejectionCount: 5,
			summary: 'Five cycles',
		});

		const session = ensureAgentSession(SESSION_ID);
		const msgs = session.pendingAdvisoryMessages ?? [];
		expect(msgs[0]).toContain('CONFLICT ESCALATION');
	});

	it('no-ops cleanly when session does not exist', () => {
		// No session created — should not throw
		expect(() => {
			resolveAgentConflict({
				sessionID: 'nonexistent-session',
				phase: 1,
				sourceAgent: 'coder',
				targetAgent: 'reviewer',
				conflictType: 'feedback_rejection',
				rejectionCount: 0,
				summary: 'No session test',
			});
		}).not.toThrow();
	});

	it('defaults rejectionCount to 0 when not provided (self_resolve path)', () => {
		ensureAgentSession(SESSION_ID, 'architect');

		resolveAgentConflict({
			sessionID: SESSION_ID,
			phase: 1,
			sourceAgent: 'test_engineer',
			targetAgent: 'coder',
			conflictType: 'scope_disagreement',
			summary: 'No rejectionCount provided',
		});

		const session = ensureAgentSession(SESSION_ID);
		const msgs = session.pendingAdvisoryMessages ?? [];
		expect(msgs.length).toBe(1);
		expect(msgs[0]).toContain('CONFLICT DETECTED');
	});

	// Issue #1976 — within-turn advisory dedupe regression coverage. The
	// dedupeKey (conflict:taskId:rejections) must be embedded in the message
	// body so pushAdvisory's key-presence dedupe actually matches.
	describe('within-turn advisory dedupe (issue #1976)', () => {
		it('suppresses byte-identical re-fires of the SAME (task, level) within a turn', () => {
			ensureAgentSession(SESSION_ID, 'architect');

			// Same taskId + same rejectionCount (2) twice in one turn.
			for (let i = 0; i < 3; i++) {
				resolveAgentConflict({
					sessionID: SESSION_ID,
					phase: 1,
					taskId: 'task-dedup',
					sourceAgent: 'reviewer',
					targetAgent: 'coder',
					conflictType: 'feedback_rejection',
					rejectionCount: 2,
					summary: 'Repeated identical conflict',
				});
			}

			const session = ensureAgentSession(SESSION_ID);
			const msgs = session.pendingAdvisoryMessages ?? [];
			// Three identical calls → one advisory (within-turn dedupe).
			expect(msgs.length).toBe(1);
			expect(msgs[0]).toContain('CONFLICT DETECTED');
		});

		it('lets genuine escalation (2 → 3) survive dedupe', () => {
			ensureAgentSession(SESSION_ID, 'architect');

			// Same task, escalating rejectionCount: level 2 then level 3.
			resolveAgentConflict({
				sessionID: SESSION_ID,
				phase: 1,
				taskId: 'task-escalate',
				sourceAgent: 'reviewer',
				targetAgent: 'coder',
				conflictType: 'feedback_rejection',
				rejectionCount: 2,
				summary: 'Second rejection',
			});
			resolveAgentConflict({
				sessionID: SESSION_ID,
				phase: 1,
				taskId: 'task-escalate',
				sourceAgent: 'reviewer',
				targetAgent: 'coder',
				conflictType: 'feedback_rejection',
				rejectionCount: 3,
				summary: 'Third rejection',
			});

			const session = ensureAgentSession(SESSION_ID);
			const msgs = session.pendingAdvisoryMessages ?? [];
			// Distinct levels → distinct dedupeKeys → both enqueued.
			expect(msgs.length).toBe(2);
			expect(msgs.some((m) => m.includes('CONFLICT DETECTED'))).toBe(true);
			expect(msgs.some((m) => m.includes('CONFLICT ESCALATION'))).toBe(true);
		});

		it('does not collapse distinct tasks sharing a rejection level', () => {
			ensureAgentSession(SESSION_ID, 'architect');

			resolveAgentConflict({
				sessionID: SESSION_ID,
				phase: 1,
				taskId: 'task-A',
				sourceAgent: 'reviewer',
				targetAgent: 'coder',
				conflictType: 'feedback_rejection',
				rejectionCount: 2,
				summary: 'Conflict on task A',
			});
			resolveAgentConflict({
				sessionID: SESSION_ID,
				phase: 1,
				taskId: 'task-B',
				sourceAgent: 'reviewer',
				targetAgent: 'coder',
				conflictType: 'feedback_rejection',
				rejectionCount: 2,
				summary: 'Conflict on task B',
			});

			const session = ensureAgentSession(SESSION_ID);
			const msgs = session.pendingAdvisoryMessages ?? [];
			// Distinct taskIds → distinct dedupeKeys → both enqueued.
			expect(msgs.length).toBe(2);
		});
	});
});
