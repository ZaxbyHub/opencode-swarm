import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createArchitectAgent } from '../../../src/agents/architect';

/**
 * RETROSPECTIVE GATE VERIFICATION TESTS (Task 1.2)
 *
 * Tests for the RETROSPECTIVE GATE section added to ARCHITECT_PROMPT:
 * - Section exists and contains expected content
 * - Positioned BEFORE MODE: PHASE-WRAP
 * - Contains warning strings and path instructions
 * - Contains retro bundle example with required fields
 * - No regressions on single-brace templates
 * - createArchitectAgent returns correct structure
 */

describe('RETROSPECTIVE GATE Verification (Task 1.2)', () => {
	const prompt = createArchitectAgent('test-model').config.prompt;
	const phaseWrapSkill = readFileSync(
		join(process.cwd(), '.opencode/skills/phase-wrap/SKILL.md'),
		'utf-8',
	);

	test('1. ARCHITECT_PROMPT contains "## ⛔ RETROSPECTIVE GATE"', () => {
		expect(prompt).toContain('## ⛔ RETROSPECTIVE GATE');
	});

	test('2. "## ⛔ RETROSPECTIVE GATE" appears BEFORE "### MODE: PHASE-WRAP"', () => {
		const retroGateIndex = prompt!.indexOf('## ⛔ RETROSPECTIVE GATE');
		const phaseWrapIndex = prompt!.indexOf('### MODE: PHASE-WRAP');

		expect(retroGateIndex).not.toBe(-1);
		expect(phaseWrapIndex).not.toBe(-1);
		expect(retroGateIndex).toBeLessThan(phaseWrapIndex);
	});

	test('3. ARCHITECT_PROMPT contains the warning string "RETROSPECTIVE_MISSING"', () => {
		expect(prompt).toContain('RETROSPECTIVE_MISSING');
	});

	test('4. ARCHITECT_PROMPT points to phase-wrap as retrospective source of truth', () => {
		expect(prompt).toContain('file:.opencode/skills/phase-wrap/SKILL.md');
		expect(prompt).toContain('follow its RETROSPECTIVE GATE section');
	});

	test('5. phase-wrap skill contains retro-{N} path instruction', () => {
		expect(phaseWrapSkill).toContain('retro-{N}');
	});

	test('6. phase-wrap skill contains "verdict": "pass" in the retro bundle example', () => {
		expect(phaseWrapSkill).toContain('"verdict": "pass"');
	});

	test('7. phase-wrap skill contains "type": "retrospective" in the retro bundle example', () => {
		expect(phaseWrapSkill).toContain('"type": "retrospective"');
	});

	test('8. phase-wrap skill contains "phase_number" field reference', () => {
		expect(phaseWrapSkill).toContain('"phase_number"');
	});

	test('9. ARCHITECT_PROMPT does NOT contain single-brace {AGENT_PREFIX} (no regression)', () => {
		// The correct form is double-brace {{AGENT_PREFIX}}
		// Single-brace {AGENT_PREFIX} is a regression bug
		expect(prompt).not.toMatch(/(?<!\{)\{AGENT_PREFIX\}(?!\})/);
	});

	test('10. ARCHITECT_PROMPT does NOT contain single-brace {SWARM_ID} (no regression)', () => {
		// The correct form is double-brace {{SWARM_ID}}
		// Single-brace {SWARM_ID} is a regression bug
		expect(prompt).not.toMatch(/(?<!\{)\{SWARM_ID\}(?!\})/);
	});

	test('11. createArchitectAgent("gpt-4") returns an object with name: "architect"', () => {
		const agent = createArchitectAgent('gpt-4');
		expect(agent).toBeDefined();
		expect(agent.name).toBe('architect');
		expect(agent.config).toBeDefined();
		expect(agent.config.prompt).toBeDefined();
	});
});
