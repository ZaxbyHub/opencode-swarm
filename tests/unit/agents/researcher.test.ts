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
			expect(
				(agent.config.tools as Record<string, unknown>).create_file,
			).toBe(false);
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
			const agent = createResearcherAgent(TEST_MODEL, customPrompt, appendPrompt);
			expect(agent.config.prompt).toBe(customPrompt);
			expect(agent.config.prompt).not.toContain(appendPrompt);
		});
	});

	// ============================================================
	// TEST 5: Agent definition shape
	// ============================================================
	describe('agent definition shape', () => {
		test('agent has name property', () => {
			const agent = createResearcherAgent(TEST_MODEL);
			expect(typeof agent.name).toBe('string');
		});

		test('agent has description property', () => {
			const agent = createResearcherAgent(TEST_MODEL);
			expect(typeof agent.description).toBe('string');
		});

		test('agent has config with model, temperature, prompt, and tools', () => {
			const agent = createResearcherAgent(TEST_MODEL);
			expect(typeof agent.config.model).toBe('string');
			expect(typeof agent.config.temperature).toBe('number');
			expect(typeof agent.config.prompt).toBe('string');
			expect(typeof agent.config.tools).toBe('object');
		});
	});
});
