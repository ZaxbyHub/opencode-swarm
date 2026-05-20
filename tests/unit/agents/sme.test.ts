import { describe, expect, test } from 'bun:test';
import { createSMEAgent } from '../../../src/agents/sme';

const TEST_MODEL = 'test-model';

describe('sme.ts — SME agent factory', () => {
	// ============================================================
	// TEST 1: Basic agent creation returns valid config
	// ============================================================
	describe('createSMEAgent returns valid agent definition', () => {
		test('agent has name "sme"', () => {
			const agent = createSMEAgent(TEST_MODEL);
			expect(agent.name).toBe('sme');
		});

		test('agent description contains "subject matter expert"', () => {
			const agent = createSMEAgent(TEST_MODEL);
			expect(agent.description.toLowerCase()).toContain(
				'subject matter expert',
			);
		});

		test('agent uses the provided model', () => {
			const agent = createSMEAgent('my-custom-model');
			expect(agent.config.model).toBe('my-custom-model');
		});

		test('agent has temperature 0.2', () => {
			const agent = createSMEAgent(TEST_MODEL);
			expect(agent.config.temperature).toBe(0.2);
		});
	});

	// ============================================================
	// TEST 2: Tools are read-only (write:false, edit:false, patch:false)
	// ============================================================
	describe('tools configuration — read-only SME', () => {
		test('tools.write is false', () => {
			const agent = createSMEAgent(TEST_MODEL);
			expect(agent.config.tools.write).toBe(false);
		});

		test('tools.edit is false', () => {
			const agent = createSMEAgent(TEST_MODEL);
			expect(agent.config.tools.edit).toBe(false);
		});

		test('tools.patch is false', () => {
			const agent = createSMEAgent(TEST_MODEL);
			expect(agent.config.tools.patch).toBe(false);
		});

		test('all three tools are false simultaneously', () => {
			const agent = createSMEAgent(TEST_MODEL);
			expect(agent.config.tools.write).toBe(false);
			expect(agent.config.tools.edit).toBe(false);
			expect(agent.config.tools.patch).toBe(false);
		});

		test('tools object has exactly three properties: write, edit, patch', () => {
			const agent = createSMEAgent(TEST_MODEL);
			expect(Object.keys(agent.config.tools).sort()).toEqual([
				'edit',
				'patch',
				'write',
			]);
		});
	});

	// ============================================================
	// TEST 3: Default prompt contains required sections
	// ============================================================
	describe('default prompt content verification', () => {
		test('prompt contains IDENTITY section', () => {
			const agent = createSMEAgent(TEST_MODEL);
			expect(agent.config.prompt).toContain('IDENTITY');
		});

		test('prompt contains RESEARCH PROTOCOL section', () => {
			const agent = createSMEAgent(TEST_MODEL);
			expect(agent.config.prompt).toContain('RESEARCH PROTOCOL');
		});

		test('prompt contains CONFIDENCE section', () => {
			const agent = createSMEAgent(TEST_MODEL);
			// CONFIDENCE CALIBRATION or RESEARCH DEPTH & CONFIDENCE
			const hasConfidenceSection =
				agent.config.prompt.includes('CONFIDENCE CALIBRATION') ||
				agent.config.prompt.includes('CONFIDENCE');
			expect(hasConfidenceSection).toBe(true);
		});

		test('prompt contains DOMAIN CHECKLISTS section', () => {
			const agent = createSMEAgent(TEST_MODEL);
			expect(agent.config.prompt).toContain('DOMAIN CHECKLISTS');
		});

		test('prompt contains OUTPUT FORMAT section', () => {
			const agent = createSMEAgent(TEST_MODEL);
			expect(agent.config.prompt).toContain('OUTPUT FORMAT');
		});

		test('prompt contains VERBOSITY CONTROL section', () => {
			const agent = createSMEAgent(TEST_MODEL);
			expect(agent.config.prompt).toContain('VERBOSITY CONTROL');
		});

		test('prompt contains RESEARCH CACHING section', () => {
			const agent = createSMEAgent(TEST_MODEL);
			expect(agent.config.prompt).toContain('RESEARCH CACHING');
		});

		test('prompt contains SME identity instructions', () => {
			const agent = createSMEAgent(TEST_MODEL);
			expect(agent.config.prompt).toContain('SME');
			expect(agent.config.prompt).toContain('Subject Matter Expert');
		});
	});

	// ============================================================
	// TEST 4: customPrompt replaces default prompt entirely
	// ============================================================
	describe('customPrompt replaces default prompt', () => {
		test('customPrompt is used as-is when provided', () => {
			const customPrompt = 'Completely custom SME prompt content';
			const agent = createSMEAgent(TEST_MODEL, customPrompt);
			expect(agent.config.prompt).toBe(customPrompt);
		});

		test('customPrompt replaces default prompt completely', () => {
			const customPrompt = 'My domain-specific guidance prompt';
			const agent = createSMEAgent(TEST_MODEL, customPrompt);
			expect(agent.config.prompt).not.toContain('IDENTITY');
			expect(agent.config.prompt).not.toContain('RESEARCH PROTOCOL');
			expect(agent.config.prompt).toBe(customPrompt);
		});

		test('customPrompt takes precedence over customAppendPrompt', () => {
			const customPrompt = 'Full replacement prompt';
			const appendPrompt = 'This should be ignored';
			const agent = createSMEAgent(TEST_MODEL, customPrompt, appendPrompt);
			expect(agent.config.prompt).toBe(customPrompt);
			expect(agent.config.prompt).not.toContain(appendPrompt);
		});
	});

	// ============================================================
	// TEST 5: customAppendPrompt appends to default prompt
	// ============================================================
	describe('customAppendPrompt appends to default prompt', () => {
		test('customAppendPrompt is appended to default prompt', () => {
			const appendPrompt = 'Additional domain context for this session';
			const agent = createSMEAgent(TEST_MODEL, undefined, appendPrompt);
			expect(agent.config.prompt).toContain(appendPrompt);
			expect(agent.config.prompt).toContain('IDENTITY');
			expect(agent.config.prompt).toContain('RESEARCH PROTOCOL');
		});

		test('customAppendPrompt is ignored when customPrompt is provided', () => {
			const customPrompt = 'Full replacement';
			const appendPrompt = 'Should be ignored';
			const agent = createSMEAgent(TEST_MODEL, customPrompt, appendPrompt);
			expect(agent.config.prompt).toBe(customPrompt);
			expect(agent.config.prompt).not.toContain(appendPrompt);
		});

		test('appended prompt contains both base sections and appended content', () => {
			const appendPrompt = 'SESSION_APPEND_MARKER';
			const agent = createSMEAgent(TEST_MODEL, undefined, appendPrompt);
			const prompt = agent.config.prompt;
			// Should have base sections
			expect(prompt).toContain('IDENTITY');
			expect(prompt).toContain('RESEARCH PROTOCOL');
			// Should have appended content at the end
			expect(prompt).toContain(appendPrompt);
		});
	});

	// ============================================================
	// TEST 6: Agent definition shape matches AgentDefinition type
	// ============================================================
	describe('agent definition shape', () => {
		test('agent has name property', () => {
			const agent = createSMEAgent(TEST_MODEL);
			expect(typeof agent.name).toBe('string');
		});

		test('agent has description property', () => {
			const agent = createSMEAgent(TEST_MODEL);
			expect(typeof agent.description).toBe('string');
		});

		test('agent has config with model, temperature, prompt, and tools', () => {
			const agent = createSMEAgent(TEST_MODEL);
			expect(typeof agent.config.model).toBe('string');
			expect(typeof agent.config.temperature).toBe('number');
			expect(typeof agent.config.prompt).toBe('string');
			expect(typeof agent.config.tools).toBe('object');
		});
	});

	// ============================================================
	// TEST 7: Prompt is a non-empty string
	// ============================================================
	describe('prompt constant properties', () => {
		test('default prompt is a non-empty string', () => {
			const agent = createSMEAgent(TEST_MODEL);
			expect(typeof agent.config.prompt).toBe('string');
			expect(agent.config.prompt.length).toBeGreaterThan(0);
		});

		test('customPrompt must be a non-empty string when provided', () => {
			const customPrompt = 'x';
			const agent = createSMEAgent(TEST_MODEL, customPrompt);
			expect(agent.config.prompt).toBe(customPrompt);
		});
	});
});
