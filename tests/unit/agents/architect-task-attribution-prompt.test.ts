import { describe, expect, it } from 'bun:test';
import { createArchitectAgent } from '../../../src/agents/architect';
import { resolveTaskId } from '../../../src/hooks/task-id-resolver';

describe('Architect prompt — task attribution guidance', () => {
	it('requires numeric task identity on task-scoped delegations', () => {
		const prompt = createArchitectAgent('test-model').config.prompt ?? '';

		expect(prompt).toContain('TASK ATTRIBUTION');
		expect(prompt).toContain(
			'alone on a standalone `TASK:` line (for example, `TASK: 1.1`)',
		);
		expect(prompt).not.toContain('TASK: 1.1 —');
		expect(prompt).toContain(
			'task_id` to the same numeric value as a tool argument',
		);
		expect(prompt).toContain('Plan-level critics');
		// Lane child session ids returned in a Task result must never be
		// reused as another agent's task_id (TASK_SESSION_RESUME_MISMATCH).
		expect(prompt).toContain(
			"`task_id` holds the plan task id only; never copy a `ses_…` id returned in a Task\nresult into another agent's dispatch.",
		);

		const shippedExample = /for example, `(TASK: \d+\.\d+(?:\.\d+)*)`/.exec(
			prompt,
		)?.[1];
		expect(shippedExample).toBe('TASK: 1.1');
		expect(
			resolveTaskId(
				{ prompt: shippedExample },
				{ policy: 'attribution', knownPlanTaskIds: new Set(['1.1']) },
			),
		).toEqual({ status: 'resolved', taskId: '1.1', source: 'marker' });
	});
});
