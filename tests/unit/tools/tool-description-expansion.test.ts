/**
 * Verification test for Task 1.6 — tool description expansion.
 * Ensures the 7 specified tools have descriptions >= 40 characters
 * with actionable detail (not generic words).
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { TOOL_METADATA } from '../../../src/tools/tool-metadata';

const TARGET_TOOLS = [
	'syntax_check',
	'imports',
	'lint',
	'secretscan',
	'build_check',
	'symbols',
	'checkpoint',
] as const;

const MIN_LENGTH = 40;

let metadata: typeof TOOL_METADATA;

beforeAll(() => {
	const entries = Object.entries(TOOL_METADATA);
	if (entries.length === 0) {
		throw new Error('TOOL_METADATA is empty — tool registration may be broken');
	}
	metadata = Object.fromEntries(entries) as typeof TOOL_METADATA;
});

describe('Task 1.6 — tool description expansion', () => {
	for (const toolName of TARGET_TOOLS) {
		test(`${toolName}: description length >= ${MIN_LENGTH} chars`, () => {
			const meta = metadata[toolName];
			expect(meta).toBeDefined();
			expect(typeof meta.description).toBe('string');
			expect(meta.description.length).toBeGreaterThanOrEqual(MIN_LENGTH);
		});

		test(`${toolName}: description contains actionable detail`, () => {
			const desc = metadata[toolName].description;
			// Descriptions should have multiple words (not just "check X" style)
			expect(desc.split(' ').length).toBeGreaterThan(5);
			// Should not be generic/template-like
			expect(desc).not.toMatch(
				/^(check|scan|run|find|get|set|update|delete) [a-z]+$/i,
			);
		});

		test(`${toolName}: agents array is present and non-empty`, () => {
			const meta = metadata[toolName];
			expect(Array.isArray(meta.agents)).toBe(true);
			expect(meta.agents.length).toBeGreaterThan(0);
		});
	}

	// NOTE: Task 1.6 only required expanding 7 specific tools.
	// Other tools may have shorter descriptions — that is out of scope for this task.

	test('TOOL_METADATA structure unchanged (has description and agents)', () => {
		for (const [name, meta] of Object.entries(metadata)) {
			expect(meta).toHaveProperty('description');
			expect(meta).toHaveProperty('agents');
			expect(typeof meta.description).toBe('string');
			expect(Array.isArray(meta.agents)).toBe(true);
		}
	});
});
