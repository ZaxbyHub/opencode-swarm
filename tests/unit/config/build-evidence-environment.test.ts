import { describe, expect, test } from 'bun:test';
import { BuildEvidenceSchema } from '../../../src/config/evidence-schema';

describe('BuildEvidenceSchema environment diagnostics (#2303)', () => {
	test('parses structured environment_unavailable details', () => {
		const result = BuildEvidenceSchema.safeParse({
			task_id: 'build',
			type: 'build',
			timestamp: '2026-08-30T00:00:00.000Z',
			agent: 'build_check',
			verdict: 'skip',
			summary: 'runtime unavailable',
			runs: [],
			files_scanned: 0,
			runs_count: 0,
			failed_count: 0,
			environment_unavailable: [
				{
					ecosystem: 'node',
					code: 'environment_unavailable',
					reason: 'Package manager not available',
					required_commands: ['bun', 'npm'],
				},
			],
		});

		expect(result.success).toBe(true);
	});
});
