import { describe, expect, test } from 'bun:test';
import { isHiveEligible } from '../../../src/hooks/hive-promoter';
import type { SwarmKnowledgeEntry } from '../../../src/hooks/knowledge-types';

function makeEntry(status: SwarmKnowledgeEntry['status']): SwarmKnowledgeEntry {
	return {
		id: `entry-${status}`,
		tier: 'swarm',
		lesson: 'Use bounded subprocesses with explicit cwd',
		category: 'process',
		tags: ['hive-fast-track'],
		scope: 'global',
		confidence: 0.9,
		status,
		confirmed_by: [
			{
				phase_number: 1,
				confirmed_at: '2026-01-01T00:00:00.000Z',
				project_name: 'project-a',
			},
			{
				phase_number: 2,
				confirmed_at: '2026-01-02T00:00:00.000Z',
				project_name: 'project-a',
			},
			{
				phase_number: 3,
				confirmed_at: '2026-01-03T00:00:00.000Z',
				project_name: 'project-a',
			},
		],
		retrieval_outcomes: {
			applied_count: 3,
			succeeded_after_count: 3,
			failed_after_count: 0,
		},
		schema_version: 2,
		created_at: '2026-01-01T00:00:00.000Z',
		updated_at: '2026-01-03T00:00:00.000Z',
		project_name: 'project-a',
		hive_eligible: true,
	};
}

describe('isHiveEligible inactive status guard', () => {
	test('allows otherwise eligible active entries', () => {
		expect(isHiveEligible(makeEntry('candidate'), 90)).toBe(true);
	});

	for (const status of [
		'archived',
		'quarantined',
		'quarantined_unactionable',
	] as const) {
		test(`rejects ${status} entries even when fast-track and confirmed`, () => {
			expect(isHiveEligible(makeEntry(status), 90)).toBe(false);
		});
	}
});
