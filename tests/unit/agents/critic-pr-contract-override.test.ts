/**
 * PR-contract override activation contract (issues #3310 → #3337).
 *
 * The #3310 design suspended the critic agent's default PLAN REVIEW
 * structure by appending a conditional instruction to the STATIC prompt,
 * activated when the model judged the literal phrase
 * "CONTROLLER-BOUND PR WORKFLOW CONTRACT" present in its prompt — a
 * content-controlled activation channel. #3337 closed it: the static critic
 * and reviewer prompts carry no workflow instructions at all, and the
 * dispatch controller composes a mode-scoped protocol clause into the
 * lane's contract block (modeProtocolClause in src/tools/dispatch-lanes.ts)
 * — structural activation, controller-authored only.
 *
 * RED at the #3337 base (static override + literal-phrase trigger), GREEN
 * after the fix; the reviewer legs pin the reviewer-side residual trigger
 * removed the same way.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	createCriticAgent,
	PLAN_CRITIC_PROMPT,
} from '../../../src/agents/critic.js';
import { createReviewerAgent } from '../../../src/agents/reviewer.js';
import { _test_exports as dispatchTestExports } from '../../../src/tools/dispatch-lanes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SKILL_PATH = join(
	__dirname,
	'../../../.opencode/skills/swarm-pr-review/SKILL.md',
);

const PR_CONTRACT_BLOCK = 'CONTROLLER-BOUND PR WORKFLOW CONTRACT';
const OVERRIDE_MARKER = 'PR-REVIEW LANE OVERRIDE';

/**
 * The critic-dispatch instruction: the SKILL.md paragraph that carries both
 * the `swarm-pr-review:critic` mode and `review_item_ids` (the Phase 8
 * dispatch paragraph). `review_item_ids` discriminates it from the
 * dispatch-mode namespace table and the COVERAGE GATE alignment paragraph,
 * which mention the mode string but never the item IDs.
 */
function criticDispatchParagraph(skill: string): string | undefined {
	return skill
		.split(/\n\s*\n/)
		.find(
			(paragraph) =>
				paragraph.includes('swarm-pr-review:critic') &&
				paragraph.includes('review_item_ids'),
		);
}

function defaultCriticPrompt(): string {
	const agent = createCriticAgent('test-model');
	return agent.config.prompt;
}

type ContractLane = Parameters<
	typeof dispatchTestExports.applyPrWorkflowPromptContract
>[0][number];
type ContractOptions = Parameters<
	typeof dispatchTestExports.applyPrWorkflowPromptContract
>[1];

const laneFor = (mode: string): ContractLane => {
	const isFeedback = mode.startsWith('swarm-pr-feedback:');
	return {
		id: 'lane-3337',
		agent: mode.endsWith(':reviewer')
			? 'reviewer'
			: mode.endsWith(':critic')
				? 'critic'
				: 'explorer',
		prompt: 'challenge the assigned findings',
		workflow_lane: mode.slice(mode.indexOf(':') + 1),
		...(isFeedback
			? { feedback_item_ids: ['f1'] }
			: { review_item_ids: ['c1'] }),
	} as ContractLane;
};

const optionsFor = (mode: string): ContractOptions =>
	({
		mode,
		prHeadSha: 'a'.repeat(40),
		revisionDigest: 'b'.repeat(64),
	}) as ContractOptions;

function composedPrompt(mode: string): string {
	const result = dispatchTestExports.applyPrWorkflowPromptContract(
		[laneFor(mode)],
		optionsFor(mode),
	);
	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error(result.errors.join('; '));
	return result.lanes[0].prompt;
}

describe('PR-contract override activation (#3310 → #3337)', () => {
	test('SKILL.md critic dispatch names exactly the base `critic` agent', () => {
		const paragraph = criticDispatchParagraph(
			readFileSync(SKILL_PATH, 'utf-8'),
		);
		expect(paragraph).toBeDefined();
		expect(paragraph ?? '').toMatch(/`critic`/);
	});

	test('SKILL.md critic dispatch never names critic_finding_validator or the phase verifiers', () => {
		const paragraph = criticDispatchParagraph(
			readFileSync(SKILL_PATH, 'utf-8'),
		);
		expect(paragraph).toBeDefined();
		expect(paragraph ?? '').not.toMatch(/critic_finding_validator/);
		expect(paragraph ?? '').not.toMatch(
			/critic_drift_verifier|critic_hallucination_verifier/,
		);
	});

	test('the static critic prompt carries NO workflow override or contract-phrase trigger (#3337)', () => {
		const prompt = defaultCriticPrompt();
		expect(prompt).not.toContain(OVERRIDE_MARKER);
		expect(prompt).not.toContain(PR_CONTRACT_BLOCK);
		// The exported constant is the registration surface — pin it too so a
		// future re-append cannot ride an import mismatch.
		expect(PLAN_CRITIC_PROMPT).not.toContain(OVERRIDE_MARKER);
		expect(PLAN_CRITIC_PROMPT).not.toContain(PR_CONTRACT_BLOCK);
	});

	test('the static reviewer prompt carries no contract-phrase trigger (#3337)', () => {
		const reviewer = createReviewerAgent('test-model');
		expect(reviewer.config.prompt).not.toContain(PR_CONTRACT_BLOCK);
		// The Stage-B mandate itself stays intact for non-workflow reviewers.
		expect(reviewer.config.prompt).toMatch(/STRUCTURED VERDICT LINE/);
	});

	test('override is additive-inverse-safe: the PLAN REVIEW default structure mandate survives', () => {
		expect(defaultCriticPrompt()).toMatch(/Begin directly with PLAN REVIEW/);
	});

	test('default critic agent keeps the base critic identity', () => {
		const agent = createCriticAgent('test-model');
		expect(agent.name).toBe('critic');
	});

	test('the controller-composed PR critic contract carries the override clause (#3337)', () => {
		const prompt = composedPrompt('swarm-pr-review:critic');
		expect(prompt).toContain(OVERRIDE_MARKER);
		expect(prompt).toContain('[CRITIC]');
		expect(prompt).toMatch(/Begin directly with PLAN REVIEW/);
		expect(prompt).toMatch(/get_approved_plan/);
	});

	test('discovery (base) composed prompts carry no override clause', () => {
		expect(composedPrompt('swarm-pr-review:base')).not.toContain(
			OVERRIDE_MARKER,
		);
	});

	test('the three ordered PR_FEEDBACK gates carry their mode-scoped clauses', () => {
		const stageB = composedPrompt('swarm-pr-feedback:stage-b-reviewer');
		expect(stageB).toContain('[STAGE-B-REVIEW]');
		expect(stageB).toMatch(/does not apply to this lane/);

		const closeoutReview = composedPrompt(
			'swarm-pr-feedback:closeout-reviewer',
		);
		expect(closeoutReview).toContain('[CLOSEOUT-REVIEW]');
		expect(closeoutReview).toMatch(/does not apply to this lane/);

		const closeoutCritic = composedPrompt('swarm-pr-feedback:closeout-critic');
		expect(closeoutCritic).toContain(OVERRIDE_MARKER);
		expect(closeoutCritic).toContain('[CLOSEOUT-CRITIC]');
	});

	test('a plan quoting the contract phrase has no structural effect: no clause source exists in the static prompts', () => {
		// With the static prompts clean, quoting the phrase in plan or spec
		// text cannot activate anything: the only producer of a suspension
		// instruction is the controller's contract composition, which the
		// plan text never enters. Pin the producer-side scoping: the override
		// marker appears in dispatch-lanes.ts exactly inside the
		// modeProtocolClause switch (critic and closeout-critic arms).
		const source = readFileSync(
			join(__dirname, '../../../src/tools/dispatch-lanes.ts'),
			'utf-8',
		);
		const occurrences = source.split(OVERRIDE_MARKER).length - 1;
		expect(occurrences).toBeGreaterThanOrEqual(2);
		// ...and never in the agent prompt sources.
		const criticSource = readFileSync(
			join(__dirname, '../../../src/agents/critic.ts'),
			'utf-8',
		);
		expect(criticSource).not.toContain(OVERRIDE_MARKER);
	});
});
