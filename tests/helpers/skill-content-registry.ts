import { expect } from 'bun:test';

type SkillConcept = {
	required: RegExp[];
	forbidden?: RegExp[];
};

const SKILL_CONCEPTS = {
	softSpecGateBranches: {
		required: [/NO effective spec/i, /\bEXISTS\b/i],
	},
	softSpecGateNoSpecChoices: {
		required: [/Create a spec first/i, /Skip and plan directly/i],
	},
	softSpecGateSpecAlignment: {
		required: [/FR-###/i, /gold-plating/i],
	},
	softSpecGateNonBlocking: {
		required: [
			/proceed to the steps below exactly as before|do NOT modify any planning behavior/i,
		],
		forbidden: [
			/cannot proceed/i,
			/must have spec/i,
			/planning is blocked/i,
			/blocked until/i,
		],
	},
	planTraceability: {
		required: [/TRACEABILITY CHECK/i, /FR-###/i, /gold-plating/i],
	},
	planTraceabilityHeader: {
		required: [/TRACEABILITY CHECK/i],
	},
	planTraceabilityNoSpecSkip: {
		required: [
			/TRACEABILITY CHECK[\s\S]*(no effective spec.*skip|skip this check silently)/i,
		],
	},
	specifyQaGateSelection: {
		required: [
			/5b\.\s+\*\*QA GATE SELECTION/i,
			/## Pending QA Gate Selection/i,
			/Do NOT call `set_qa_gates` yet/i,
			/reviewer/i,
			/test_engineer/i,
			/sme_enabled/i,
			/critic_pre_plan/i,
			/sast_enabled/i,
			/council_mode/i,
			/hallucination_guard/i,
			/\.swarm\/context\.md/i,
			/MODE: PLAN[\s\S]*set_qa_gates/i,
		],
	},
} satisfies Record<string, SkillConcept>;

export type SkillConceptName = keyof typeof SKILL_CONCEPTS;

export function expectSkillConcept(
	content: string,
	conceptName: SkillConceptName,
): void {
	const concept = SKILL_CONCEPTS[conceptName];
	for (const pattern of concept.required) {
		expect(content).toMatch(pattern);
	}
	for (const pattern of concept.forbidden ?? []) {
		expect(content).not.toMatch(pattern);
	}
}
