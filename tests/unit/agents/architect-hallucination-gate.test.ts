import { describe, expect, test } from 'bun:test';
import {
	buildQaGateSelectionDialogue,
	createArchitectAgent,
} from '../../../src/agents/architect';
import { PHASE_WRAP_PROTOCOL } from './architect-mode-skill-helpers';

describe('Architect prompt: hallucination_guard gate enforcement', () => {
	const prompt = createArchitectAgent('test-model').config.prompt;

	const getPhaseWrapSection = (): string => {
		expect(prompt).toContain('### MODE: PHASE-WRAP');
		expect(prompt).toContain('file:.opencode/skills/phase-wrap/SKILL.md');
		return PHASE_WRAP_PROTOCOL;
	};

	describe('PHASE-WRAP step 5.55', () => {
		test('step 5.55 exists in PHASE-WRAP section', () => {
			const section = getPhaseWrapSection();
			expect(section).toContain('5.55');
		});

		test('step 5.55 references critic_hallucination_verifier', () => {
			const section = getPhaseWrapSection();
			expect(section).toContain('critic_hallucination_verifier');
		});

		test('step 5.55 references write_hallucination_evidence tool', () => {
			const section = getPhaseWrapSection();
			expect(section).toContain('write_hallucination_evidence');
		});

		test('step 5.55 appears between step 5.5 and step 5.6', () => {
			const section = getPhaseWrapSection();
			const pos55 = section.indexOf('5.5.');
			const pos555 = section.indexOf('5.55.');
			const pos56 = section.indexOf('5.6.');
			expect(pos55).toBeGreaterThanOrEqual(0);
			expect(pos555).toBeGreaterThan(pos55);
			expect(pos56).toBeGreaterThan(pos555);
		});

		test('step 5.55 mentions hallucination_guard gate flag', () => {
			const section = getPhaseWrapSection();
			expect(section).toContain('hallucination_guard');
		});

		test('step 5.55 instructs STOP if verifier returns NEEDS_REVISION', () => {
			const section = getPhaseWrapSection();
			// Find the actual header line, not a reference to the step number
			const step555Start = section.indexOf('5.55. **Hallucination');
			const step56Start = section.indexOf('\n5.6.', step555Start);
			const step555Text =
				step56Start > step555Start
					? section.slice(step555Start, step56Start)
					: section.slice(step555Start);
			expect(step555Text).toContain('NEEDS_REVISION');
			expect(step555Text.toUpperCase()).toContain('STOP');
		});

		test('step 5.55 contains plugin enforcement note', () => {
			const section = getPhaseWrapSection();
			expect(section).toContain('BLOCKED');
			expect(section).toContain('runtime hooks');
		});
	});

	describe('PHASE-WRAP step 5.6 (mandatory gate evidence)', () => {
		test('step 5.6 mentions hallucination-guard.json', () => {
			const section = getPhaseWrapSection();
			const pos56 = section.indexOf('5.6.');
			const pos6 = section.indexOf('\n6.', pos56);
			const step56Text =
				pos6 > pos56 ? section.slice(pos56, pos6) : section.slice(pos56);
			expect(step56Text).toContain('hallucination-guard.json');
		});

		test('step 5.6 notes hallucination-guard is conditional on gate being enabled', () => {
			const section = getPhaseWrapSection();
			const pos56 = section.indexOf('5.6.');
			const pos6 = section.indexOf('\n6.', pos56);
			const step56Text =
				pos6 > pos56 ? section.slice(pos56, pos6) : section.slice(pos56);
			// Should mention that it's only required when gate is enabled
			expect(step56Text.toLowerCase()).toMatch(
				/only required|when.*hallucination_guard.*enabled/,
			);
		});
	});

	describe('buildQaGateSelectionDialogue: behavioral-mandatory language', () => {
		for (const mode of ['BRAINSTORM', 'SPECIFY', 'PLAN'] as const) {
			test(`${mode} dialogue contains hallucination_guard`, () => {
				const dialogue = buildQaGateSelectionDialogue(mode);
				expect(dialogue).toContain('hallucination_guard');
			});

			test(`${mode} dialogue includes mandatory enforcement language`, () => {
				const dialogue = buildQaGateSelectionDialogue(mode);
				expect(dialogue).toMatch(/REJECT phase completion|mandatory per-phase/);
			});

			test(`${mode} dialogue references critic_hallucination_verifier`, () => {
				const dialogue = buildQaGateSelectionDialogue(mode);
				expect(dialogue).toContain('critic_hallucination_verifier');
			});
		}
	});
});
