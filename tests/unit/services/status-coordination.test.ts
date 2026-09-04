import { describe, expect, test } from 'bun:test';
import {
	formatStatusMarkdown,
	type StatusData,
} from '../../../src/services/status-service.js';

function baseStatus(): StatusData {
	return {
		hasPlan: true,
		currentPhase: 'Phase 1',
		completedTasks: 0,
		totalTasks: 1,
		agentCount: 1,
		isLegacy: false,
		turboMode: false,
		contextBudgetPct: null,
		compactionCount: 0,
		lastSnapshotAt: null,
	};
}

describe('/swarm status SQLite coordination visibility (#2481)', () => {
	test('renders uncertain readiness and the safe recovery command', () => {
		const output = formatStatusMarkdown({
			...baseStatus(),
			coordination: {
				state: 'timed_out',
				attemptId: 7,
				generation: 2,
				settled: false,
				error: 'coordination initialization timed out',
			},
		});

		expect(output).toContain('SQLite coordination');
		expect(output).toContain('timed_out (unsettled)');
		expect(output).toContain('/swarm recover --coordination');
	});
});
