import { describe, expect, test } from 'bun:test';
import { createResearcherAgent } from '../../../src/agents/researcher';

const TEST_MODEL = 'test-model';

describe('researcher.ts — Researcher agent factory', () => {
	// ============================================================
	// TEST 1: Basic agent creation returns valid config
	// ============================================================
	describe('createResearcherAgent returns valid agent definition', () => {
		test('agent has name "researcher"', () => {
			const agent = createResearcherAgent(TEST_MODEL);
			expect(agent.name).toBe('researcher');
		});

		test('agent description mentions research', () => {
			const agent = createResearcherAgent(TEST_MODEL);
			expect(agent.description.toLowerCase()).toContain('research');
		});

		test('agent description mentions read-only', () => {
			const agent = createResearcherAgent(TEST_MODEL);
			expect(agent.description.toLowerCase()).toContain('read-only');
		});

		test('agent uses the provided model', () => {
			const agent = createResearcherAgent('my-custom-model');
			expect(agent.config.model).toBe('my-custom-model');
		});

		test('agent has temperature 0.1 (precision-focused)', () => {
			const agent = createResearcherAgent(TEST_MODEL);
			expect(agent.config.temperature).toBe(0.1);
		});
	});

	// ============================================================
	// TEST 2: Tools are read-only (all write tools disabled)
	// ============================================================
	describe('tools configuration — read-only researcher', () => {
		test('tools.write is false', () => {
			const agent = createResearcherAgent(TEST_MODEL);
			expect(agent.config.tools.write).toBe(false);
		});

		test('tools.edit is false', () => {
			const agent = createResearcherAgent(TEST_MODEL);
			expect(agent.config.tools.edit).toBe(false);
		});

		test('tools.patch is false', () => {
			const agent = createResearcherAgent(TEST_MODEL);
			expect(agent.config.tools.patch).toBe(false);
		});

		test('tools.apply_patch is false', () => {
			const agent = createResearcherAgent(TEST_MODEL);
			expect((agent.config.tools as Record<string, unknown>).apply_patch).toBe(
				false,
			);
		});

		test('tools.create_file is false', () => {
			const agent = createResearcherAgent(TEST_MODEL);
			expect((agent.config.tools as Record<string, unknown>).create_file).toBe(
				false,
			);
		});
	});

	// ============================================================
	// TEST 3: Prompt content — key sections present
	// ============================================================
	describe('prompt content', () => {
		test('prompt contains IDENTITY section', () => {
			const agent = createResearcherAgent(TEST_MODEL);
			expect(agent.config.prompt).toContain('## IDENTITY');
		});

		test('prompt contains RESEARCH PROTOCOL section', () => {
			const agent = createResearcherAgent(TEST_MODEL);
			expect(agent.config.prompt).toContain('## RESEARCH PROTOCOL');
		});

		test('prompt contains multi-source search strategy', () => {
			const agent = createResearcherAgent(TEST_MODEL);
			expect(agent.config.prompt).toContain('multi-source');
		});

		test('prompt mentions web_search tool', () => {
			const agent = createResearcherAgent(TEST_MODEL);
			expect(agent.config.prompt).toContain('web_search');
		});

		test('prompt mentions confidence levels', () => {
			const agent = createResearcherAgent(TEST_MODEL);
			expect(agent.config.prompt).toContain('HIGH');
			expect(agent.config.prompt).toContain('MEDIUM');
			expect(agent.config.prompt).toContain('LOW');
		});

		test('prompt mentions EVIDENCE_REFS output field', () => {
			const agent = createResearcherAgent(TEST_MODEL);
			expect(agent.config.prompt).toContain('EVIDENCE_REFS');
		});

		test('prompt contains OUTPUT FORMAT section', () => {
			const agent = createResearcherAgent(TEST_MODEL);
			expect(agent.config.prompt).toContain('## OUTPUT FORMAT');
		});

		test('prompt contains SECURITY RULES section', () => {
			const agent = createResearcherAgent(TEST_MODEL);
			expect(agent.config.prompt).toContain('SECURITY RULES');
		});

		test('prompt contains caching instructions', () => {
			const agent = createResearcherAgent(TEST_MODEL);
			expect(agent.config.prompt).toContain('SEARCH CACHING');
		});

		test('prompt references academic sources (arXiv)', () => {
			const agent = createResearcherAgent(TEST_MODEL);
			expect(agent.config.prompt).toContain('arxiv.org');
		});

		test('prompt references GitHub search strategy', () => {
			const agent = createResearcherAgent(TEST_MODEL);
			expect(agent.config.prompt).toContain('github.com');
		});
	});

	// ============================================================
	// TEST 4: Custom prompt override
	// ============================================================
	describe('custom prompt handling', () => {
		test('customPrompt replaces default prompt', () => {
			const customPrompt = 'CUSTOM_PROMPT_CONTENT';
			const agent = createResearcherAgent(TEST_MODEL, customPrompt);
			expect(agent.config.prompt).toBe(customPrompt);
		});

		test('customAppendPrompt appends to default prompt', () => {
			const appendPrompt = 'APPEND_MARKER_STRING';
			const agent = createResearcherAgent(TEST_MODEL, undefined, appendPrompt);
			expect(agent.config.prompt).toContain('## IDENTITY');
			expect(agent.config.prompt).toContain(appendPrompt);
		});

		test('customPrompt takes precedence over customAppendPrompt', () => {
			const customPrompt = 'OVERRIDE_PROMPT';
			const appendPrompt = 'APPEND_PROMPT';
			const agent = createResearcherAgent(
				TEST_MODEL,
				customPrompt,
				appendPrompt,
			);
			expect(agent.config.prompt).toBe(customPrompt);
			expect(agent.config.prompt).not.toContain(appendPrompt);
		});
	});

	// ============================================================
	// TEST 5: Agent definition shape (specific values)
	// ============================================================
	describe('agent definition shape (specific values)', () => {
		test('agent has name property', () => {
			const agent = createResearcherAgent(TEST_MODEL);
			expect(typeof agent.name).toBe('string');
			expect(agent.name).toBe('researcher');
		});

		test('agent description matches the documented contract', () => {
			const agent = createResearcherAgent(TEST_MODEL);
			expect(agent.description).toBe(
				'Automated multi-source research specialist. Searches the web, GitHub, official docs, and academic sources, then synthesises findings with citations. Read-only.',
			);
		});

		test('agent config.tools has all 9 write-tool flags set to false', () => {
			const agent = createResearcherAgent(TEST_MODEL);
			const writeToolKeys = [
				'write',
				'edit',
				'patch',
				'apply_patch',
				'create_file',
				'insert',
				'replace',
				'append',
				'prepend',
			];
			for (const key of writeToolKeys) {
				expect((agent.config.tools as Record<string, unknown>)[key]).toBe(
					false,
				);
			}
		});

		test('prompt does not contain template placeholder markers', () => {
			const agent = createResearcherAgent(TEST_MODEL);
			// Ensure no unrendered template placeholders remain in the default prompt.
			// Square-bracket placeholder text is used in the INPUT FORMAT guidance but should
			// not appear as unfilled template variables.
			expect(agent.config.prompt).not.toMatch(/\{\{[^}]+\}\}/);
			expect(agent.config.prompt).not.toMatch(/\$\{[^}]+\}/);
		});
	});
});
