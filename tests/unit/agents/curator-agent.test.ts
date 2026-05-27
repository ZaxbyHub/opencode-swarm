import {
	type CuratorRole,
	createCuratorAgent,
} from '../../../src/agents/curator-agent';
import {
	CURATOR_INIT_PROMPT,
	CURATOR_PHASE_PROMPT,
} from '../../../src/agents/explorer';

const TEST_MODEL = 'test-model';

describe('curator-agent.ts', () => {
	// ============================================================
	// TEST 1: Verify createCuratorAgent returns correct prompt based on role
	// ============================================================
	describe('createCuratorAgent prompt selection by role', () => {
		test('role=curator_init (explicit) -> prompt is CURATOR_INIT_PROMPT', () => {
			const agent = createCuratorAgent(
				TEST_MODEL,
				undefined,
				undefined,
				'curator_init',
			);
			expect(agent.config.prompt).toBe(CURATOR_INIT_PROMPT);
		});

		test('role=curator_phase (explicit) -> prompt is CURATOR_PHASE_PROMPT', () => {
			const agent = createCuratorAgent(
				TEST_MODEL,
				undefined,
				undefined,
				'curator_phase',
			);
			expect(agent.config.prompt).toBe(CURATOR_PHASE_PROMPT);
		});

		test('no role (default) -> prompt is CURATOR_INIT_PROMPT', () => {
			const agent = createCuratorAgent(TEST_MODEL);
			expect(agent.config.prompt).toBe(CURATOR_INIT_PROMPT);
		});

		test('curator prompts keep raw docs/search output in evidence cache', () => {
			expect(CURATOR_INIT_PROMPT).toContain('concise durable facts only');
			expect(CURATOR_INIT_PROMPT).toContain('evidence-cache refs');
			expect(CURATOR_PHASE_PROMPT).toContain('concise durable facts only');
			expect(CURATOR_PHASE_PROMPT).toContain('evidence-cache refs');
		});
	});

	// ============================================================
	// TEST 2: Verify agent name is set correctly based on role
	// ============================================================
	describe('createCuratorAgent name selection by role', () => {
		test('curator_init -> name "curator_init"', () => {
			const agent = createCuratorAgent(
				TEST_MODEL,
				undefined,
				undefined,
				'curator_init',
			);
			expect(agent.name).toBe('curator_init');
		});

		test('curator_phase -> name "curator_phase"', () => {
			const agent = createCuratorAgent(
				TEST_MODEL,
				undefined,
				undefined,
				'curator_phase',
			);
			expect(agent.name).toBe('curator_phase');
		});
	});

	// ============================================================
	// TEST 3: Verify agent description contains expected content per role
	// ============================================================
	describe('createCuratorAgent description verification', () => {
		test('curator_init description contains "session start"', () => {
			const agent = createCuratorAgent(
				TEST_MODEL,
				undefined,
				undefined,
				'curator_init',
			);
			expect(agent.description).toContain('session start');
		});

		test('curator_phase description contains "phase boundaries"', () => {
			const agent = createCuratorAgent(
				TEST_MODEL,
				undefined,
				undefined,
				'curator_phase',
			);
			expect(agent.description).toContain('phase boundaries');
		});

		test('curator_init description contains "Curator (Init)"', () => {
			const agent = createCuratorAgent(
				TEST_MODEL,
				undefined,
				undefined,
				'curator_init',
			);
			expect(agent.description).toContain('Curator (Init)');
		});

		test('curator_phase description contains "Curator (Phase)"', () => {
			const agent = createCuratorAgent(
				TEST_MODEL,
				undefined,
				undefined,
				'curator_phase',
			);
			expect(agent.description).toContain('Curator (Phase)');
		});
	});

	// ============================================================
	// TEST 4: Verify tools configuration (read-only: write:false, edit:false, patch:false)
	// ============================================================
	describe('createCuratorAgent tools configuration', () => {
		test('curator_init has tools with write:false, edit:false, patch:false', () => {
			const agent = createCuratorAgent(
				TEST_MODEL,
				undefined,
				undefined,
				'curator_init',
			);

			expect(agent.config.tools.write).toBe(false);
			expect(agent.config.tools.edit).toBe(false);
			expect(agent.config.tools.patch).toBe(false);
		});

		test('curator_phase has tools with write:false, edit:false, patch:false', () => {
			const agent = createCuratorAgent(
				TEST_MODEL,
				undefined,
				undefined,
				'curator_phase',
			);

			expect(agent.config.tools.write).toBe(false);
			expect(agent.config.tools.edit).toBe(false);
			expect(agent.config.tools.patch).toBe(false);
		});
	});

	// ============================================================
	// TEST 5: Verify temperature is 0.1
	// ============================================================
	describe('createCuratorAgent temperature', () => {
		test('curator_init has temperature 0.1', () => {
			const agent = createCuratorAgent(
				TEST_MODEL,
				undefined,
				undefined,
				'curator_init',
			);
			expect(agent.config.temperature).toBe(0.1);
		});

		test('curator_phase has temperature 0.1', () => {
			const agent = createCuratorAgent(
				TEST_MODEL,
				undefined,
				undefined,
				'curator_phase',
			);
			expect(agent.config.temperature).toBe(0.1);
		});
	});

	// ============================================================
	// TEST 6: Verify model is passed through correctly
	// ============================================================
	describe('createCuratorAgent model passthrough', () => {
		test('uses the provided model', () => {
			const agent = createCuratorAgent('my-custom-model');
			expect(agent.config.model).toBe('my-custom-model');
		});

		test('different models are used per role', () => {
			const initAgent = createCuratorAgent(
				'model-a',
				undefined,
				undefined,
				'curator_init',
			);
			const phaseAgent = createCuratorAgent(
				'model-b',
				undefined,
				undefined,
				'curator_phase',
			);

			expect(initAgent.config.model).toBe('model-a');
			expect(phaseAgent.config.model).toBe('model-b');
		});
	});

	// ============================================================
	// TEST 7: Verify customPrompt replaces default prompt
	// ============================================================
	describe('createCuratorAgent customPrompt replacement', () => {
		test('customPrompt replaces CURATOR_INIT_PROMPT for curator_init role', () => {
			const customPrompt = 'Custom prompt content';
			const agent = createCuratorAgent(
				TEST_MODEL,
				customPrompt,
				undefined,
				'curator_init',
			);

			expect(agent.config.prompt).toBe(customPrompt);
			expect(agent.config.prompt).not.toBe(CURATOR_INIT_PROMPT);
		});

		test('customPrompt replaces CURATOR_PHASE_PROMPT for curator_phase role', () => {
			const customPrompt = 'Custom phase prompt content';
			const agent = createCuratorAgent(
				TEST_MODEL,
				customPrompt,
				undefined,
				'curator_phase',
			);

			expect(agent.config.prompt).toBe(customPrompt);
			expect(agent.config.prompt).not.toBe(CURATOR_PHASE_PROMPT);
		});

		test('customPrompt replaces default prompt when no role specified (default curator_init)', () => {
			const customPrompt = 'Custom default prompt';
			const agent = createCuratorAgent(TEST_MODEL, customPrompt);

			expect(agent.config.prompt).toBe(customPrompt);
			expect(agent.config.prompt).not.toBe(CURATOR_INIT_PROMPT);
		});
	});

	// ============================================================
	// TEST 8: Verify customAppendPrompt appends to role prompt
	// ============================================================
	describe('createCuratorAgent customAppendPrompt', () => {
		test('customAppendPrompt appends to CURATOR_INIT_PROMPT when role=curator_init', () => {
			const appendPrompt = 'Appended content';
			const agent = createCuratorAgent(
				TEST_MODEL,
				undefined,
				appendPrompt,
				'curator_init',
			);

			expect(agent.config.prompt).toBe(
				`${CURATOR_INIT_PROMPT}\n\n${appendPrompt}`,
			);
		});

		test('customAppendPrompt appends to CURATOR_PHASE_PROMPT when role=curator_phase', () => {
			const appendPrompt = 'Appended phase content';
			const agent = createCuratorAgent(
				TEST_MODEL,
				undefined,
				appendPrompt,
				'curator_phase',
			);

			expect(agent.config.prompt).toBe(
				`${CURATOR_PHASE_PROMPT}\n\n${appendPrompt}`,
			);
		});

		test('customAppendPrompt appends to CURATOR_INIT_PROMPT when using default role', () => {
			const appendPrompt = 'Appended default content';
			const agent = createCuratorAgent(TEST_MODEL, undefined, appendPrompt);

			expect(agent.config.prompt).toBe(
				`${CURATOR_INIT_PROMPT}\n\n${appendPrompt}`,
			);
		});
	});

	// ============================================================
	// TEST 9: Verify customPrompt + customAppendPrompt together
	// ============================================================
	describe('createCuratorAgent customPrompt with customAppendPrompt', () => {
		test('customPrompt and customAppendPrompt are concatenated when both provided', () => {
			const customPrompt = 'Custom prompt';
			const appendPrompt = 'Appended content';
			const agent = createCuratorAgent(TEST_MODEL, customPrompt, appendPrompt);

			// Both are concatenated, customAppendPrompt is not ignored
			expect(agent.config.prompt).toBe(`${customPrompt}\n\n${appendPrompt}`);
		});

		test('customPrompt and customAppendPrompt are concatenated for curator_phase', () => {
			const customPrompt = 'Custom prompt';
			const appendPrompt = 'Appended content';
			const agent = createCuratorAgent(
				TEST_MODEL,
				customPrompt,
				appendPrompt,
				'curator_phase',
			);

			// Both are concatenated
			expect(agent.config.prompt).toBe(`${customPrompt}\n\n${appendPrompt}`);
		});
	});

	// ============================================================
	// TEST 10: Verify CuratorRole type exports
	// ============================================================
	describe('CuratorRole type export verification', () => {
		test('CuratorRole is exported and contains both roles', () => {
			const roles: CuratorRole[] = ['curator_init', 'curator_phase'];

			expect(roles).toHaveLength(2);
			expect(roles).toContain('curator_init');
			expect(roles).toContain('curator_phase');
		});
	});

	// ============================================================
	// TEST 11: Verify prompt constants are exported and non-empty
	// ============================================================
	describe('prompt constant exports verification', () => {
		test('CURATOR_INIT_PROMPT and CURATOR_PHASE_PROMPT are exported and non-empty', () => {
			expect(typeof CURATOR_INIT_PROMPT).toBe('string');
			expect(typeof CURATOR_PHASE_PROMPT).toBe('string');

			expect(CURATOR_INIT_PROMPT.length).toBeGreaterThan(0);
			expect(CURATOR_PHASE_PROMPT.length).toBeGreaterThan(0);
		});

		test('each prompt is distinct (no aliasing)', () => {
			expect(CURATOR_INIT_PROMPT).not.toBe(CURATOR_PHASE_PROMPT);
		});

		test('CURATOR_INIT_PROMPT contains CURATOR_INIT mode marker', () => {
			expect(CURATOR_INIT_PROMPT).toContain('CURATOR_INIT mode');
		});

		test('CURATOR_PHASE_PROMPT contains CURATOR_PHASE mode marker', () => {
			expect(CURATOR_PHASE_PROMPT).toContain('CURATOR_PHASE mode');
		});
	});

	// ============================================================
	// TEST 12: Verify CURATOR_INIT_PROMPT contains required sections
	// ============================================================
	describe('CURATOR_INIT_PROMPT content verification', () => {
		test('contains required sections', () => {
			const requiredSections = [
				'BRIEFING:',
				'CONTRADICTIONS:',
				'OBSERVATIONS:',
				'KNOWLEDGE_STATS:',
			];

			for (const section of requiredSections) {
				expect(CURATOR_INIT_PROMPT).toContain(section);
			}
		});
	});

	// ============================================================
	// TEST 13: Verify CURATOR_PHASE_PROMPT contains required sections
	// ============================================================
	describe('CURATOR_PHASE_PROMPT content verification', () => {
		test('contains required sections', () => {
			const requiredSections = [
				'PHASE_DIGEST:',
				'COMPLIANCE:',
				'OBSERVATIONS:',
				'EXTENDED_DIGEST:',
			];

			for (const section of requiredSections) {
				expect(CURATOR_PHASE_PROMPT).toContain(section);
			}
		});
	});

	// ============================================================
	// EDGE CASE TESTS
	// ============================================================
	describe('edge case handling', () => {
		test('empty model string still returns valid config', () => {
			const agent = createCuratorAgent('');
			expect(agent.config.model).toBe('');
			expect(agent.name).toBe('curator_init');
		});

		test('empty customPrompt uses role prompt instead', () => {
			const agent = createCuratorAgent(TEST_MODEL, '');
			// Empty string is falsy, so customPrompt branch is skipped — uses default role prompt
			expect(agent.config.prompt).toBe(CURATOR_INIT_PROMPT);
		});

		test('whitespace-only customPrompt is treated as custom', () => {
			const agent = createCuratorAgent(TEST_MODEL, '   ');
			// Non-empty string IS truthy, so it replaces the prompt
			expect(agent.config.prompt).toBe('   ');
		});
	});

	// ============================================================
	// KNOWLEDGE BASE CONTEXT TESTS
	// ============================================================
	describe('knowledge base context in prompts', () => {
		test('curator_init prompt contains knowledge-related instructions', () => {
			const agent = createCuratorAgent(
				TEST_MODEL,
				undefined,
				undefined,
				'curator_init',
			);
			const prompt = agent.config.prompt;
			// Verify prompt contains knowledge-related instructions
			const hasKnowledgeRef = prompt.toLowerCase().includes('knowledge');
			expect(hasKnowledgeRef).toBe(true);
		});

		test('curator_phase prompt handles knowledge consolidation', () => {
			const agent = createCuratorAgent(
				TEST_MODEL,
				undefined,
				undefined,
				'curator_phase',
			);
			const prompt = agent.config.prompt;
			// Verify prompt contains consolidation/curation instructions
			const hasConsolidate = prompt.toLowerCase().includes('consolidat');
			expect(hasConsolidate).toBe(true);
		});
	});
});
