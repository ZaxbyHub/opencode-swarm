import { describe, expect, it } from 'bun:test';
import type { HandoffData } from '../../../src/services/handoff-service.js';
import { formatHandoffMarkdown } from '../../../src/services/handoff-service.js';

describe('formatHandoffMarkdown execution profile', () => {
	it('renders every execution-profile durability field', () => {
		const data: HandoffData = {
			generated: '2026-08-12T00:00:00.000Z',
			currentPhase: null,
			currentTask: null,
			incompleteTasks: [],
			pendingQA: null,
			activeAgent: null,
			recentDecisions: [],
			delegationState: null,
			execution_profile: {
				parallelization_enabled: true,
				max_concurrent_tasks: 2,
				council_parallel: false,
				locked: true,
				auto_proceed: true,
				commit_after_each_completed_task: true,
			},
		};

		const markdown = formatHandoffMarkdown(data);
		expect(markdown).toContain('Auto Proceed');
		expect(markdown).toContain('Commit After Each Completed Task');
	});
});
