/**
 * Plan-schema external-evidence refinements (issue #3422, issue #3432 review
 * PRR-008), split out of plan-schema.test.ts for the FR-006 cap: the
 * persistence-boundary non-vacuity rules — anchors must carry an
 * expectation, and an external_git declaration must pin 1..16 anchors.
 */
import { describe, expect, it } from 'bun:test';
import { TaskSchema } from '../../../src/config/plan-schema';

describe('TaskSchema external-evidence refinements (issue #3432 review PRR-008)', () => {
	it('external_git without evidence_anchors is refused', () => {
		const task = {
			id: '1.1',
			phase: 1,
			description: 'Commit and push',
			evidence_class: 'external_git' as const,
		};
		const result = TaskSchema.safeParse(task);
		expect(result.success).toBe(false);
	});

	it('external_git with an empty evidence_anchors array is refused', () => {
		const task = {
			id: '1.1',
			phase: 1,
			description: 'Commit and push',
			evidence_class: 'external_git' as const,
			evidence_anchors: [],
		};
		const result = TaskSchema.safeParse(task);
		expect(result.success).toBe(false);
	});

	it('an anchor with neither expect nor expect_prefix is refused (non-vacuity)', () => {
		const task = {
			id: '1.1',
			phase: 1,
			description: 'Commit and push',
			evidence_class: 'external_git' as const,
			evidence_anchors: [{ command: 'git rev-list --count HEAD' }],
		};
		const result = TaskSchema.safeParse(task);
		expect(result.success).toBe(false);
	});

	it('a legacy task with no external-evidence fields still parses', () => {
		const result = TaskSchema.safeParse({
			id: '1.1',
			phase: 1,
			description: 'Test',
		});
		expect(result.success).toBe(true);
	});
});
