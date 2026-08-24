/**
 * Issue #2102 contract C — `council.finalCompletionPolicy` + `freshnessMaxAgeHours`
 * schema surface. Missing/default policy is the strict legacy requirement;
 * quorum is an explicit, bounded opt-in.
 */

import { describe, expect, test } from 'bun:test';
import {
	CouncilConfigSchema,
	PluginConfigSchema,
} from '../../../src/config/schema';

describe('council.finalCompletionPolicy schema', () => {
	test('council config without the field defaults to all_required', () => {
		const parsed = CouncilConfigSchema.parse({ enabled: true });
		expect(parsed.finalCompletionPolicy).toEqual({ mode: 'all_required' });
	});

	test('empty council object defaults to all_required', () => {
		const parsed = CouncilConfigSchema.parse({});
		expect(parsed.finalCompletionPolicy).toEqual({ mode: 'all_required' });
	});

	test('explicit all_required parses without minimumMembers', () => {
		const parsed = CouncilConfigSchema.parse({
			finalCompletionPolicy: { mode: 'all_required' },
		});
		expect(parsed.finalCompletionPolicy).toEqual({ mode: 'all_required' });
	});

	test('quorum with a valid bounded minimum parses', () => {
		for (const minimumMembers of [3, 4, 5]) {
			const parsed = CouncilConfigSchema.parse({
				finalCompletionPolicy: { mode: 'quorum', minimumMembers },
			});
			expect(parsed.finalCompletionPolicy).toEqual({
				mode: 'quorum',
				minimumMembers,
			});
		}
	});

	test('quorum without minimumMembers is rejected', () => {
		const result = CouncilConfigSchema.safeParse({
			finalCompletionPolicy: { mode: 'quorum' },
		});
		expect(result.success).toBe(false);
	});

	test.each([
		2,
		6,
		3.5,
		'4',
	])('quorum minimumMembers %p is rejected', (minimumMembers) => {
		const result = CouncilConfigSchema.safeParse({
			finalCompletionPolicy: { mode: 'quorum', minimumMembers },
		});
		expect(result.success).toBe(false);
	});

	test('unknown modes are rejected', () => {
		const result = CouncilConfigSchema.safeParse({
			finalCompletionPolicy: { mode: 'sometimes' },
		});
		expect(result.success).toBe(false);
	});

	test('nests under the top-level plugin config', () => {
		const parsed = PluginConfigSchema.parse({
			council: {
				enabled: true,
				finalCompletionPolicy: { mode: 'quorum', minimumMembers: 4 },
				freshnessMaxAgeHours: 48,
			},
		});
		expect(parsed.council?.finalCompletionPolicy).toEqual({
			mode: 'quorum',
			minimumMembers: 4,
		});
		expect(parsed.council?.freshnessMaxAgeHours).toBe(48);
	});
});

describe('council.freshnessMaxAgeHours schema', () => {
	test('defaults to 24', () => {
		expect(CouncilConfigSchema.parse({}).freshnessMaxAgeHours).toBe(24);
	});

	test.each([1, 24, 168, 720])('%d hours is accepted', (hours) => {
		expect(
			CouncilConfigSchema.parse({ freshnessMaxAgeHours: hours })
				.freshnessMaxAgeHours,
		).toBe(hours);
	});

	test.each([0, -1, 721, 1.5, '24'])('%p is rejected', (hours) => {
		expect(
			CouncilConfigSchema.safeParse({ freshnessMaxAgeHours: hours }).success,
		).toBe(false);
	});
});

describe('deprecated fields keep parse compatibility', () => {
	test('parallelTimeoutMs still parses in-range values', () => {
		expect(
			CouncilConfigSchema.parse({ parallelTimeoutMs: 60_000 })
				.parallelTimeoutMs,
		).toBe(60_000);
	});

	test('escalateOnMaxRounds still parses strings (inert)', () => {
		expect(
			CouncilConfigSchema.parse({
				escalateOnMaxRounds: 'https://hooks.example.invalid/x',
			}).escalateOnMaxRounds,
		).toBe('https://hooks.example.invalid/x');
	});
});
