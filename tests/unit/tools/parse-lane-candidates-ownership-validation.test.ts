import { describe, expect, test } from 'bun:test';
import { parse_lane_candidates } from '../../../src/tools/parse-lane-candidates';

async function callTool(args: Record<string, unknown>): Promise<string> {
	return (
		parse_lane_candidates as unknown as {
			execute: (
				input: unknown,
				context: { directory: string },
			) => Promise<string>;
		}
	).execute(args, { directory: process.cwd() });
}

describe('parse_lane_candidates ownership argument validation', () => {
	test.each([
		[
			'owned set without its primary lane',
			{
				expected_family: 'base_explorer',
				expected_lanes: ['intent-architecture'],
			},
			'expected_lane is required',
		],
		[
			'cross-family ownership flags',
			{
				expected_family: 'micro_lane',
				expected_lane: 'correctness-state',
			},
			'micro_lane ownership cannot include',
		],
		[
			'base ownership without a family binding',
			{ expected_lane: 'correctness-state' },
			'base ownership fields require expected_family base_explorer',
		],
		[
			'micro ownership without a family binding',
			{ expected_micro_lane: 'concurrency-state' },
			'micro ownership fields require expected_family micro_lane',
		],
	] as const)('rejects %s at the public tool boundary', async (_name, invalidFlags, message) => {
		const result = await callTool({
			output_ref: `L1:${'a'.repeat(64)}:${'b'.repeat(64)}:${'c'.repeat(64)}`,
			...invalidFlags,
		});
		const parsed = JSON.parse(result);
		expect(parsed.failure_class).toBe('invalid_args');
		expect(parsed.errors.join('; ')).toContain(message);
	});
});
