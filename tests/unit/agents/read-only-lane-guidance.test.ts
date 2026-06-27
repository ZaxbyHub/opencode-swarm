import { describe, expect, test } from 'bun:test';
import { createArchitectAgent } from '../../../src/agents/architect';
import { createCoderAgent } from '../../../src/agents/coder';
import {
	DOMAIN_EXPERT_COUNCIL_PROMPT,
	GENERALIST_COUNCIL_PROMPT,
	SKEPTIC_COUNCIL_PROMPT,
} from '../../../src/agents/council-prompts';
import {
	AUTONOMOUS_OVERSIGHT_PROMPT,
	createCriticAgent,
} from '../../../src/agents/critic';
import { createExplorerAgent } from '../../../src/agents/explorer';
import { createResearcherAgent } from '../../../src/agents/researcher';
import { createReviewerAgent } from '../../../src/agents/reviewer';
import { createSMEAgent } from '../../../src/agents/sme';

const laneGuidanceNeedles = [
	'READ-ONLY ADVISORY LANE CONTEXT',
	'dispatch_lanes',
	'dispatch_lanes_async',
	'knowledge_add',
	'doc_scan',
	'Return findings for the architect to synthesize',
];

function expectLaneGuidance(prompt: string): void {
	for (const needle of laneGuidanceNeedles) {
		expect(prompt).toContain(needle);
	}
}

describe('read-only lane prompt guidance', () => {
	test('lane-capable standard agents mention read-only lane restrictions', () => {
		const prompts = [
			createExplorerAgent('test-model').config.prompt ?? '',
			createReviewerAgent('test-model').config.prompt ?? '',
			createSMEAgent('test-model').config.prompt ?? '',
			createResearcherAgent('test-model').config.prompt ?? '',
		];

		for (const prompt of prompts) {
			expectLaneGuidance(prompt);
		}
	});

	test('lane-capable critic variants mention read-only lane restrictions', () => {
		const prompts = [
			createCriticAgent('test-model', undefined, undefined, 'plan_critic')
				.config.prompt ?? '',
			createCriticAgent('test-model', undefined, undefined, 'sounding_board')
				.config.prompt ?? '',
			createCriticAgent(
				'test-model',
				undefined,
				undefined,
				'phase_drift_verifier',
			).config.prompt ?? '',
			createCriticAgent(
				'test-model',
				undefined,
				undefined,
				'hallucination_verifier',
			).config.prompt ?? '',
			createCriticAgent(
				'test-model',
				undefined,
				undefined,
				'architecture_supervisor',
			).config.prompt ?? '',
			AUTONOMOUS_OVERSIGHT_PROMPT,
		];

		for (const prompt of prompts) {
			expectLaneGuidance(prompt);
		}
	});

	test('council lane prompts keep no-tools rule and mention lane restrictions', () => {
		for (const prompt of [
			GENERALIST_COUNCIL_PROMPT,
			SKEPTIC_COUNCIL_PROMPT,
			DOMAIN_EXPERT_COUNCIL_PROMPT,
		]) {
			expect(prompt).toContain('You have no tools');
			expectLaneGuidance(prompt);
		}
	});
});

describe('web research ownership wording', () => {
	test('DEEP_RESEARCH scopes architect ownership to mode-specific web_fetch coordination', () => {
		const prompt =
			createArchitectAgent('test-model', undefined, undefined, undefined, {
				enabled: true,
				general: { enabled: true },
			}).config.prompt ?? '';
		const deepResearchStart = prompt.indexOf('### MODE: DEEP_RESEARCH');
		const codebaseReviewStart = prompt.indexOf('### MODE: CODEBASE_REVIEW');
		expect(deepResearchStart).toBeGreaterThan(-1);
		expect(codebaseReviewStart).toBeGreaterThan(deepResearchStart);
		const section = prompt.slice(deepResearchStart, codebaseReviewStart);

		expect(section).toContain('In MODE: DEEP_RESEARCH');
		expect(section).toContain('own `web_fetch`');
		expect(section).toContain('Outside DEEP_RESEARCH');
		expect(section).toContain(
			'SME and researcher prompts may use `web_search`',
		);
	});
});

describe('write-capable agents do not receive read-only lane guidance', () => {
	test('coder agent prompt excludes read-only lane guidance', () => {
		const prompt = createCoderAgent('test-model').config.prompt ?? '';
		expect(prompt).not.toContain('READ-ONLY ADVISORY LANE CONTEXT');
	});

	test('architect agent prompt excludes read-only lane guidance', () => {
		const prompt =
			createArchitectAgent('test-model', undefined, undefined, undefined, {
				enabled: true,
				general: { enabled: true },
			}).config.prompt ?? '';
		expect(prompt).not.toContain('READ-ONLY ADVISORY LANE CONTEXT');
	});
});
