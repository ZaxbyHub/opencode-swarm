/**
 * Schema tests for `council.minimumMembers`.
 *
 * Covers:
 *  - validation range [1, 5]
 *  - default value (3) when omitted
 *  - coexistence with requireAllMembers (stricter wins)
 */

import { describe, expect, test } from 'bun:test';
import { CouncilConfigSchema } from '../../../src/config/schema';

describe('council.minimumMembers schema', () => {
	test('defaults to 3 when omitted', () => {
		const parsed = CouncilConfigSchema.parse({ enabled: true });
		expect(parsed.minimumMembers).toBe(3);
	});

	test('accepts 1 as the minimum value (effectively disables quorum)', () => {
		const parsed = CouncilConfigSchema.parse({
			enabled: true,
			minimumMembers: 1,
		});
		expect(parsed.minimumMembers).toBe(1);
	});

	test('accepts 5 as the maximum value (matches requireAllMembers semantics)', () => {
		const parsed = CouncilConfigSchema.parse({
			enabled: true,
			minimumMembers: 5,
		});
		expect(parsed.minimumMembers).toBe(5);
	});

	test('rejects 0', () => {
		expect(() =>
			CouncilConfigSchema.parse({ enabled: true, minimumMembers: 0 }),
		).toThrow();
	});

	test('rejects 6', () => {
		expect(() =>
			CouncilConfigSchema.parse({ enabled: true, minimumMembers: 6 }),
		).toThrow();
	});

	test('rejects non-integer values', () => {
		expect(() =>
			CouncilConfigSchema.parse({ enabled: true, minimumMembers: 2.5 }),
		).toThrow();
	});

	test('coexists with requireAllMembers — both fields validate', () => {
		const parsed = CouncilConfigSchema.parse({
			enabled: true,
			requireAllMembers: true,
			minimumMembers: 2,
		});
		// Both fields are accepted; the stricter constraint (requireAllMembers)
		// is applied at runtime in the tool, not here.
		expect(parsed.requireAllMembers).toBe(true);
		expect(parsed.minimumMembers).toBe(2);
	});
});
