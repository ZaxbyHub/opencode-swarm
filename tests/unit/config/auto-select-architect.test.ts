/**
 * Tests for auto_select_architect config logic.
 *
 * Covers:
 * 1. stripKnownSwarmPrefix — suffix-based canonical role extraction
 * 2. PluginConfigSchema parsing for auto_select_architect field
 *
 * The full config: hook (build/plan disabling) requires plugin initialization
 * and is tested in the integration test for task 2.3.
 */
import { describe, expect, test } from 'bun:test';
import {
	PluginConfigSchema,
	stripKnownSwarmPrefix,
} from '../../../src/config/schema';

// ─── stripKnownSwarmPrefix ──────────────────────────────────────────────────

describe('stripKnownSwarmPrefix — suffix-based role extraction', () => {
	// Required cases from task spec
	test.each([
		['mega_architect', 'architect'],
		['local_coder', 'coder'],
		['architect', 'architect'], // no prefix — unchanged
		['unknown_agent', 'unknown_agent'], // no known suffix
	])('%s -> %s', (input, expected) => {
		expect(stripKnownSwarmPrefix(input)).toBe(expected);
	});

	test('handles case-insensitive prefix stripping', () => {
		expect(stripKnownSwarmPrefix('MEGA_ARCHITECT')).toBe('architect');
		expect(stripKnownSwarmPrefix('Local_Coder')).toBe('coder');
	});

	test('handles dash and space separators', () => {
		expect(stripKnownSwarmPrefix('mega-architect')).toBe('architect');
		expect(stripKnownSwarmPrefix('local coder')).toBe('coder');
	});
});

// ─── auto_select_architect schema parsing ───────────────────────────────────

describe('PluginConfigSchema — auto_select_architect field', () => {
	test('auto_select_architect: true parses to true', () => {
		const result = PluginConfigSchema.safeParse({
			auto_select_architect: true,
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.auto_select_architect).toBe(true);
		}
	});

	test('auto_select_architect: "mega_architect" parses to the string', () => {
		const result = PluginConfigSchema.safeParse({
			auto_select_architect: 'mega_architect',
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.auto_select_architect).toBe('mega_architect');
		}
	});

	test('auto_select_architect: "" (empty string) parses to false', () => {
		const result = PluginConfigSchema.safeParse({
			auto_select_architect: '',
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.auto_select_architect).toBe(false);
		}
	});

	test('auto_select_architect: undefined stays undefined (field absent)', () => {
		const result = PluginConfigSchema.safeParse({});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.auto_select_architect).toBeUndefined();
		}
	});

	test('auto_select_architect: false parses to false', () => {
		const result = PluginConfigSchema.safeParse({
			auto_select_architect: false,
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.auto_select_architect).toBe(false);
		}
	});

	test('auto_select_architect: whitespace-only string parses to false', () => {
		const result = PluginConfigSchema.safeParse({
			auto_select_architect: '   ',
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.auto_select_architect).toBe(false);
		}
	});

	test('auto_select_architect: string is trimmed', () => {
		const result = PluginConfigSchema.safeParse({
			auto_select_architect: '  mega_architect  ',
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.auto_select_architect).toBe('mega_architect');
		}
	});
});
