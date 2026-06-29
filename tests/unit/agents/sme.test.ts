import { describe, expect, test } from 'bun:test';
import { createSMEAgent } from '../../../src/agents/sme';

const TEST_MODEL = 'test-model';

describe('sme.ts — SME agent factory', () => {
	// ============================================================
	// PARAMETERIZED TEST 1: Core agent properties
	// Covers: name="sme", description contains "subject matter expert",
	//         model passthrough, temperature=0.2
	// ============================================================
	describe('createSMEAgent returns valid agent definition', () => {
		test.each([
			{
				label: 'name equals sme',
				check: (agent: ReturnType<typeof createSMEAgent>) => agent.name,
				expected: 'sme',
				matcher: 'toBe' as const,
			},
			{
				label: 'description contains subject matter expert',
				check: (agent: ReturnType<typeof createSMEAgent>) =>
					agent.description.toLowerCase(),
				expected: 'subject matter expert',
				matcher: 'toContain' as const,
			},
			{
				label: 'temperature equals 0.2',
				check: (agent: ReturnType<typeof createSMEAgent>) =>
					agent.config.temperature,
				expected: 0.2,
				matcher: 'toBe' as const,
			},
		])('$label', ({ check, expected, matcher }) => {
			const agent = createSMEAgent(TEST_MODEL);
			expect(check(agent))[matcher](expected);
		});

		test('agent uses the provided model', () => {
			const agent = createSMEAgent('my-custom-model');
			expect(agent.config.model).toBe('my-custom-model');
		});
	});

	// ============================================================
	// PARAMETERIZED TEST 2: Tools are read-only (write=false, edit=false, patch=false)
	// Covers all 5 original tool tests: 3 individual + combined + exact keys
	// ============================================================
	describe('tools configuration — read-only SME', () => {
		test.each([
			{ tool: 'write', expected: false },
			{ tool: 'edit', expected: false },
			{ tool: 'patch', expected: false },
		])('tools.$tool is $expected', ({ tool, expected }) => {
			const agent = createSMEAgent(TEST_MODEL);
			expect(agent.config.tools[tool]).toBe(expected);
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
	// PARAMETERIZED TEST 3: Default prompt contains required sections
	// Covers all 8 original section tests in a single parameterized block
	// ============================================================
	describe('default prompt content verification', () => {
		test.each([
			{ section: 'IDENTITY' },
			{ section: 'RESEARCH PROTOCOL' },
			{ section: 'CONFIDENCE' },
			{ section: 'DOMAIN CHECKLISTS' },
			{ section: 'OUTPUT FORMAT' },
			{ section: 'VERBOSITY CONTROL' },
			{ section: 'RESEARCH CACHING' },
			{ section: 'SME identity instructions', check: 'contains' },
		])('prompt contains $section section', ({ section }) => {
			const agent = createSMEAgent(TEST_MODEL);
			if (section === 'CONFIDENCE') {
				const hasConfidenceSection =
					agent.config.prompt.includes('CONFIDENCE CALIBRATION') ||
					agent.config.prompt.includes('CONFIDENCE');
				expect(hasConfidenceSection).toBe(true);
			} else if (section === 'SME identity instructions') {
				expect(agent.config.prompt).toContain('SME');
				expect(agent.config.prompt).toContain('Subject Matter Expert');
			} else {
				expect(agent.config.prompt).toContain(section);
			}
		});
	});

	// ============================================================
	// PARAMETERIZED TEST 4: customPrompt and customAppendPrompt behavior
	// Covers 4 scenarios: customPrompt as-is, customPrompt replaces default,
	// customAppendPrompt appends, precedence (customPrompt > customAppendPrompt)
	// ============================================================
	describe('customPrompt and customAppendPrompt override logic', () => {
		test.each([
			{
				label: 'customPrompt is used as-is when provided',
				prompt: 'Completely custom SME prompt content',
				customPrompt: 'Completely custom SME prompt content',
				appendPrompt: undefined,
				expectPrompt: 'Completely custom SME prompt content',
			},
			{
				label: 'customPrompt replaces default prompt completely',
				prompt: 'My domain-specific guidance prompt',
				customPrompt: 'My domain-specific guidance prompt',
				appendPrompt: undefined,
				expectPrompt: 'My domain-specific guidance prompt',
				notContains: ['IDENTITY', 'RESEARCH PROTOCOL'],
			},
			{
				label: 'customAppendPrompt is appended to default prompt',
				prompt: 'Additional domain context for this session',
				customPrompt: undefined,
				appendPrompt: 'Additional domain context for this session',
				contains: [
					'IDENTITY',
					'RESEARCH PROTOCOL',
					'Additional domain context for this session',
				],
			},
			{
				label: 'customPrompt takes precedence over customAppendPrompt',
				prompt: 'Full replacement prompt',
				customPrompt: 'Full replacement prompt',
				appendPrompt: 'This should be ignored',
				expectPrompt: 'Full replacement prompt',
				notContains: ['This should be ignored'],
			},
		])('$label', ({
			customPrompt,
			appendPrompt,
			expectPrompt,
			contains,
			notContains,
		}) => {
			const agent = createSMEAgent(TEST_MODEL, customPrompt, appendPrompt);
			if (expectPrompt !== undefined) {
				expect(agent.config.prompt).toBe(expectPrompt);
			}
			if (contains) {
				for (const text of contains) {
					expect(agent.config.prompt).toContain(text);
				}
			}
			if (notContains) {
				for (const text of notContains) {
					expect(agent.config.prompt).not.toContain(text);
				}
			}
		});
	});

	// ============================================================
	// NON-PARAMETERIZED: Agent definition shape and prompt properties
	// (These are single assertions, not worth parameterizing)
	// ============================================================
	describe('agent definition shape', () => {
		test('agent has name, description, and config properties', () => {
			const agent = createSMEAgent(TEST_MODEL);
			expect(typeof agent.name).toBe('string');
			expect(typeof agent.description).toBe('string');
			expect(typeof agent.config.model).toBe('string');
			expect(typeof agent.config.temperature).toBe('number');
			expect(typeof agent.config.prompt).toBe('string');
			expect(typeof agent.config.tools).toBe('object');
		});
	});

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
