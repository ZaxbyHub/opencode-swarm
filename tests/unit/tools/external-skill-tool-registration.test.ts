import { describe, expect, test } from 'bun:test';
import * as toolsIndex from '../../../src/tools/index';
import { TOOL_MANIFEST } from '../../../src/tools/manifest';
import {
	TOOL_METADATA,
	TOOL_NAME_SET,
	TOOL_NAMES,
	type ToolName,
} from '../../../src/tools/tool-metadata';

const EXTERNAL_SKILL_TOOLS = [
	'external_skill_discover',
	'external_skill_list',
	'external_skill_inspect',
	'external_skill_promote',
	'external_skill_reject',
	'external_skill_delete',
	'external_skill_revoke',
] as const;

const DISABLED_MESSAGE =
	'External skill curation is not enabled. Set external_skills.curation_enabled to true in your opencode config.';

describe('External Skill Curation Tool Registrations', () => {
	describe('1 — Tool names in TOOL_NAMES and TOOL_NAME_SET', () => {
		for (const tool of EXTERNAL_SKILL_TOOLS) {
			test(`${tool} is in TOOL_NAMES`, () => {
				expect(TOOL_NAMES).toContain(tool);
			});

			test(`${tool} is in TOOL_NAME_SET`, () => {
				expect(TOOL_NAME_SET.has(tool as ToolName)).toBe(true);
			});
		}

		test('TOOL_NAMES contains exactly 7 external_skill_* entries', () => {
			const externalSkillNames = TOOL_NAMES.filter((n) =>
				n.startsWith('external_skill_'),
			);
			expect(externalSkillNames).toHaveLength(7);
		});

		test('TOOL_NAME_SET has exactly 7 external_skill_* entries', () => {
			const externalSkillNames = [...TOOL_NAME_SET].filter((n) =>
				n.startsWith('external_skill_'),
			);
			expect(externalSkillNames).toHaveLength(7);
		});
	});

	describe('2 — TOOL_METADATA entries have correct shape', () => {
		for (const tool of EXTERNAL_SKILL_TOOLS) {
			test(`${tool} has description field`, () => {
				expect(TOOL_METADATA[tool]).toHaveProperty('description');
				expect(typeof TOOL_METADATA[tool].description).toBe('string');
				expect(TOOL_METADATA[tool].description.length).toBeGreaterThan(0);
			});

			test(`${tool} has agents: []`, () => {
				expect(TOOL_METADATA[tool]).toHaveProperty('agents');
				expect(TOOL_METADATA[tool].agents).toEqual([]);
			});
		}

		test('all 7 tools mention curation_enabled in their description', () => {
			for (const tool of EXTERNAL_SKILL_TOOLS) {
				expect(TOOL_METADATA[tool].description).toContain(
					'external_skills.curation_enabled',
				);
			}
		});
	});

	describe('3 — TOOL_MANIFEST entries are thunks returning ToolDefinition', () => {
		for (const tool of EXTERNAL_SKILL_TOOLS) {
			test(`${tool} exists in TOOL_MANIFEST`, () => {
				expect(TOOL_MANIFEST).toHaveProperty(tool);
			});

			test(`${tool} is a function (thunk)`, () => {
				expect(typeof TOOL_MANIFEST[tool as keyof typeof TOOL_MANIFEST]).toBe(
					'function',
				);
			});

			test(`${tool}() returns a non-null object with description`, () => {
				const definition = TOOL_MANIFEST[tool as keyof typeof TOOL_MANIFEST]();
				expect(definition).not.toBeNull();
				expect(typeof definition).toBe('object');
				expect(definition).toHaveProperty('description');
			});
		}
	});

	describe('4 — Exports from src/tools/index.ts', () => {
		for (const tool of EXTERNAL_SKILL_TOOLS) {
			const exportName = tool;
			test(`${exportName} is exported from src/tools/index`, () => {
				expect(toolsIndex).toHaveProperty(exportName);
			});

			test(`${exportName} export is an object (tool definition)`, () => {
				const exported = (toolsIndex as Record<string, unknown>)[exportName];
				expect(typeof exported).toBe('object');
				expect(exported).not.toBeNull();
				// A valid tool definition has description, args, and execute
				expect(exported).toHaveProperty('description');
				expect(exported).toHaveProperty('args');
				expect(exported).toHaveProperty('execute');
			});
		}
	});

	describe('5 — execute() returns the disabled message', () => {
		for (const tool of EXTERNAL_SKILL_TOOLS) {
			test(`${tool} execute() returns disabled message string`, async () => {
				const handler = TOOL_MANIFEST[tool as keyof typeof TOOL_MANIFEST]();
				// execute is a method on the returned tool definition
				const result = await handler.execute({}, '/fake/directory');
				expect(result).toBe(DISABLED_MESSAGE);
			});
		}
	});

	describe('6 — Tool name pattern: external_skill_(discover|list|inspect|promote|reject|delete|revoke)', () => {
		const VALID_PATTERNS = [
			'external_skill_discover',
			'external_skill_list',
			'external_skill_inspect',
			'external_skill_promote',
			'external_skill_reject',
			'external_skill_delete',
			'external_skill_revoke',
		];

		test.each(VALID_PATTERNS)('%s matches the expected pattern', (name) => {
			expect(
				/^external_skill_(discover|list|inspect|promote|reject|delete|revoke)$/.test(
					name,
				),
			).toBe(true);
		});

		test('no other external_skill_* tools exist beyond the 7 expected', () => {
			const allExternalSkillTools = TOOL_NAMES.filter((n) =>
				n.startsWith('external_skill_'),
			);
			expect(allExternalSkillTools.sort()).toEqual(VALID_PATTERNS.sort());
		});
	});
});
