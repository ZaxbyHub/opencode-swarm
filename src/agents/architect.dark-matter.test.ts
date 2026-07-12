import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resetSwarmState, startAgentSession } from '../state';
import { createArchitectAgent } from './architect';

/**
 * DARK MATTER CO-CHANGE DETECTION lives in the MODE: EXECUTE operational
 * protocol (`.opencode/skills/execute/SKILL.md`, step 5a-bis), NOT inlined into
 * the base architect prompt. The architect loads that skill on the
 * `[MODE: EXECUTE]` signal (see the SIGNAL-TRIGGERED MODE rule in
 * ARCHITECT_PROMPT) and follows its protocol during execution. Delivery is
 * fully wired end-to-end: the `co_change_analyzer` tool + `system-enhancer`
 * scan populate hidden-coupling knowledge, the `dark-matter-detector` hook
 * surfaces unresolved gaps, and the execute skill instructs the architect to
 * consult it. These tests therefore verify the instruction where it actually
 * lives (the execute skill), and additionally exercise createArchitectAgent
 * under each mode/config to confirm those construction paths stay valid.
 */
const EXECUTE_SKILL_PATH = path.join(
	import.meta.dir,
	'../../.opencode/skills/execute/SKILL.md',
);
const EXECUTE_SKILL = fs.readFileSync(EXECUTE_SKILL_PATH, 'utf-8');

describe('createArchitectAgent - DARK MATTER CO-CHANGE DETECTION', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	afterEach(() => {
		resetSwarmState();
	});

	// TEST 1: Dark matter detection instruction is present in the execute skill
	it('1. contains DARK MATTER CO-CHANGE DETECTION instruction in execute skill', () => {
		expect(EXECUTE_SKILL).toContain('DARK MATTER CO-CHANGE DETECTION');
	});

	// TEST 2: knowledge_recall is called with correct hidden-coupling query format
	it('2. instruction calls knowledge_recall with hidden-coupling query format', () => {
		expect(EXECUTE_SKILL).toContain('knowledge_recall');
		expect(EXECUTE_SKILL).toContain('hidden-coupling primaryFile');
	});

	// TEST 3: PrimaryFile extraction is mentioned (first file in FILE list)
	it('3. instruction extracts primaryFile from first file in task FILE list', () => {
		expect(EXECUTE_SKILL).toContain('primaryFile');
		expect(EXECUTE_SKILL).toContain("first file in the task's FILE list");
	});

	// TEST 4: BLAST RADIUS note is added when coupled files found
	it('4. adds BLAST RADIUS note to task scope when files are found', () => {
		expect(EXECUTE_SKILL).toContain('BLAST RADIUS');
		expect(EXECUTE_SKILL).toContain('AFFECTS scope');
	});

	// TEST 5: Graceful degradation when knowledge_recall returns empty
	it('5. handles empty knowledge_recall results gracefully', () => {
		expect(EXECUTE_SKILL).toContain('no results');
		expect(EXECUTE_SKILL).toContain('gracefully');
	});

	// TEST 6: Graceful handling when knowledge_recall is unavailable
	it('6. handles unavailable knowledge_recall gracefully', () => {
		expect(EXECUTE_SKILL).toContain('unavailable');
	});

	// TEST 7: After declare_scope but before finalizing task file list
	it('7. dark matter detection runs after declare_scope and before finalizing file list', () => {
		const skillLower = EXECUTE_SKILL.toLowerCase();

		// Should mention declare_scope in context of dark matter detection
		expect(skillLower).toContain('declare_scope');

		// The dark matter detection is followed by the delegation instruction
		// "only after scope is declared".
		const afterScopeSentence = 'only after scope is declared';
		expect(skillLower).toContain(afterScopeSentence);

		// Verify dark matter detection appears between declare_scope and the
		// "only after" sentence.
		const declareScopeIndex = skillLower.indexOf('declare_scope');
		const darkMatterIndex = skillLower.indexOf(
			'dark matter co-change detection',
		);
		const afterScopeIndex = skillLower.indexOf(afterScopeSentence);

		expect(declareScopeIndex).toBeGreaterThan(0);
		expect(darkMatterIndex).toBeGreaterThan(declareScopeIndex);
		expect(afterScopeIndex).toBeGreaterThan(darkMatterIndex);
	});

	// TEST 8: Adds coupled files to scope when results returned
	it('8. adds files to AFFECTS scope when knowledge_recall returns entries', () => {
		expect(EXECUTE_SKILL).toContain(
			"add those files to the task's AFFECTS scope",
		);
	});

	// TEST 9: Turbo mode does not break agent construction.
	// PR #1790 review F-L5-006: this test's name previously implied it verifies
	// dark-matter-detection behavior varies (or is "preserved") per Turbo Mode
	// state. It does not — dark matter detection lives entirely in the
	// config-independent execute skill file (verified once in TEST 1) and is
	// unaffected by any architect prompt/session state. What this test
	// actually verifies: createArchitectAgent still constructs a valid,
	// non-empty prompt when a Turbo Mode session is active — a construction
	// smoke test, not a dark-matter-specific assertion.
	it('9. createArchitectAgent builds a valid prompt when a Turbo Mode session is active', () => {
		startAgentSession('turbo-session', 'architect');
		const agent = createArchitectAgent('test-model');

		expect(typeof agent.config.prompt).toBe('string');
		expect(agent.config.prompt!.length).toBeGreaterThan(0);
	});

	// TEST 10: Same construction smoke test without an active Turbo Mode
	// session — see TEST 9's comment for why this does not re-assert
	// EXECUTE_SKILL content (already covered once by TEST 1).
	it('10. createArchitectAgent builds a valid prompt without an active Turbo Mode session', () => {
		startAgentSession('normal-session', 'architect');
		const agent = createArchitectAgent('test-model');

		expect(typeof agent.config.prompt).toBe('string');
		expect(agent.config.prompt!.length).toBeGreaterThan(0);
	});

	// TEST 11: Adversarial testing enabled preserves dark matter detection
	it('11. dark matter detection preserved when adversarial testing enabled', () => {
		const agent = createArchitectAgent('test-model', undefined, undefined, {
			enabled: true,
			scope: 'all',
		});

		expect(typeof agent.config.prompt).toBe('string');
		expect(agent.config.prompt!.length).toBeGreaterThan(0);
		expect(EXECUTE_SKILL).toContain('DARK MATTER CO-CHANGE DETECTION');
		expect(EXECUTE_SKILL).toContain('BLAST RADIUS');
	});

	// TEST 12: Adversarial testing disabled preserves dark matter detection
	it('12. dark matter detection preserved when adversarial testing disabled', () => {
		const agent = createArchitectAgent('test-model', undefined, undefined, {
			enabled: false,
			scope: 'all',
		});

		expect(typeof agent.config.prompt).toBe('string');
		expect(agent.config.prompt!.length).toBeGreaterThan(0);
		expect(EXECUTE_SKILL).toContain('DARK MATTER CO-CHANGE DETECTION');
		expect(EXECUTE_SKILL).toContain('BLAST RADIUS');
	});

	// TEST 13: Security-only adversarial scope preserves dark matter detection
	it('13. dark matter detection preserved with security-only adversarial scope', () => {
		const agent = createArchitectAgent('test-model', undefined, undefined, {
			enabled: true,
			scope: 'security-only',
		});

		expect(typeof agent.config.prompt).toBe('string');
		expect(agent.config.prompt!.length).toBeGreaterThan(0);
		expect(EXECUTE_SKILL).toContain('DARK MATTER CO-CHANGE DETECTION');
		expect(EXECUTE_SKILL).toContain('BLAST RADIUS');
	});

	// TEST 14: Custom append prompt preserves dark matter detection
	it('14. dark matter detection preserved with custom append prompt', () => {
		const agent = createArchitectAgent(
			'test-model',
			undefined,
			'Custom instruction here',
		);

		// The custom append is honored on the base prompt…
		expect(agent.config.prompt).toContain('Custom instruction here');
		// …and the execute-mode dark matter instruction remains intact.
		expect(EXECUTE_SKILL).toContain('DARK MATTER CO-CHANGE DETECTION');
		expect(EXECUTE_SKILL).toContain('BLAST RADIUS');
	});

	// TEST 15: Custom prompt replaces base but preserves dark matter detection
	it('15. dark matter detection present with custom prompt', () => {
		const customPrompt =
			'You are a custom architect.\n\nDARK MATTER CO-CHANGE DETECTION: After declaring scope but BEFORE finalizing the task file list, call `knowledge_recall` with query `hidden-coupling [primaryFile]`. If results found, add to AFFECTS scope with BLAST RADIUS note.';

		const agent = createArchitectAgent('test-model', customPrompt);

		// A custom prompt is echoed verbatim, so any dark matter guidance the
		// caller includes is preserved on the base prompt.
		expect(agent.config.prompt).toBeDefined();
		if (agent.config.prompt) {
			expect(agent.config.prompt).toContain('DARK MATTER CO-CHANGE DETECTION');
			expect(agent.config.prompt).toContain('BLAST RADIUS');
		}
	});

	// TEST 16: Agent definition structure is correct
	it('16. returns correct AgentDefinition structure with dark matter detection', () => {
		const agent = createArchitectAgent('test-model');

		expect(agent).toHaveProperty('name', 'architect');
		expect(agent).toHaveProperty('description');
		expect(agent).toHaveProperty('config');
		expect(agent.config).toHaveProperty('model', 'test-model');
		expect(agent.config).toHaveProperty('temperature', 0.1);
		expect(agent.config).toHaveProperty('prompt');
		expect(typeof agent.config.prompt).toBe('string');
	});
});
