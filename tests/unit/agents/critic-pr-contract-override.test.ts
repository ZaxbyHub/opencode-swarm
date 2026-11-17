/**
 * AC14 (issue #3310) — PR critic dispatch names exactly one PR critic agent.
 * Issue #3358 AC1 moved the PR-contract override OFF the agent: the default
 * critic prompt is PR-free (no phrase-activated clause a quoted plan could
 * trigger), and the suspension of the default PLAN REVIEW structure is a
 * controller-authored clause (`CRITIC_PROTOCOL_SELECTION_CLAUSE`) that
 * `applyPrWorkflowPromptContract` injects into every bound
 * swarm-pr-review:critic lane's controller-bound block.
 *
 * #3337 completed the same move for the remaining consumer modes: the static
 * critic and reviewer prompts carry no workflow instructions at all, and the
 * dispatch controller composes a mode-scoped PROTOCOL SELECTION clause into
 * the lane's contract block for every verdict mode — the two PR_REVIEW
 * phases, the three ordered PR_FEEDBACK gates, and the PR_FEEDBACK
 * verification lane — so activation is structural and controller-authored
 * only. This suite pins the agent-side half (static prompts stay PR-free;
 * the PLAN REVIEW mandate survives for non-workflow critics) and the
 * controller-side half (each mode's clause names its own row family;
 * discovery lanes get none).
 *
 * SKILL.md's critic-dispatch instruction (~:1265, the paragraph that carries
 * `swarm-pr-review:critic` mode and `review_item_ids`) names EXACTLY ONE PR
 * critic agent — the base `critic` agent — and never `critic_finding_validator`
 * (whose builder emits a strict-JSON prompt, not `[CRITIC]` rows).
 */

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	createCriticAgent,
	PLAN_CRITIC_PROMPT,
} from '../../../src/agents/critic.js';
import { createReviewerAgent } from '../../../src/agents/reviewer.js';
import {
	_test_exports,
	CRITIC_PROTOCOL_SELECTION_CLAUSE,
} from '../../../src/tools/dispatch-lanes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SKILL_PATH = join(
	__dirname,
	'../../../.opencode/skills/swarm-pr-review/SKILL.md',
);
const AGENTS_DIR = join(__dirname, '../../../src/agents');

const PR_CONTRACT_BLOCK = 'CONTROLLER-BOUND PR WORKFLOW CONTRACT';

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
	typeof _test_exports.applyPrWorkflowPromptContract
>[0][number];
type ContractOptions = Parameters<
	typeof _test_exports.applyPrWorkflowPromptContract
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
	const result = _test_exports.applyPrWorkflowPromptContract(
		[laneFor(mode)],
		optionsFor(mode),
	);
	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error(result.errors.join('; '));
	return result.lanes[0].prompt;
}

describe('critic PR-contract override (AC14, issue #3310; #3358 AC1; #3337)', () => {
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

	test('default critic prompt is PR-free; the controller critic lane block carries the suspension', () => {
		expect(defaultCriticPrompt()).not.toContain(PR_CONTRACT_BLOCK);
		// The exported constant is the registration surface — pin it too so a
		// future re-append cannot ride an import mismatch.
		expect(PLAN_CRITIC_PROMPT).not.toContain(PR_CONTRACT_BLOCK);
		const applied = _test_exports.applyPrWorkflowPromptContract(
			[
				{
					id: 'critic-lane-3358',
					agent: 'critic',
					prompt: 'Challenge the assigned reviewer verdicts.',
					workflow_lane: 'critic-chunk-1',
					review_item_ids: ['c1'],
				},
			],
			{
				mode: 'swarm-pr-review:critic',
				prHeadSha: 'a'.repeat(40),
				revisionDigest: 'b'.repeat(64),
			},
		);
		expect(applied.ok).toBe(true);
		const lanePrompt = applied.ok ? (applied.lanes[0]?.prompt ?? '') : '';
		const blockStart = lanePrompt.lastIndexOf(`[${PR_CONTRACT_BLOCK}]`);
		expect(blockStart).toBeGreaterThanOrEqual(0);
		const block = lanePrompt.slice(blockStart);
		expect(block).toContain(CRITIC_PROTOCOL_SELECTION_CLAUSE);
		// the clause must suspend the default output structure ...
		expect(CRITIC_PROTOCOL_SELECTION_CLAUSE).toMatch(/does not apply/i);
		// ... and emit only [CRITIC] rows under the contract
		expect(CRITIC_PROTOCOL_SELECTION_CLAUSE).toMatch(/\[CRITIC\]/);
	});

	test('the static reviewer prompt carries no contract-phrase trigger (#3337)', () => {
		const reviewer = createReviewerAgent('test-model');
		expect(reviewer.config.prompt).not.toContain(PR_CONTRACT_BLOCK);
		expect(reviewer.config.prompt).not.toContain(
			CRITIC_PROTOCOL_SELECTION_CLAUSE,
		);
		// The Stage-B mandate itself stays intact for non-workflow reviewers.
		expect(reviewer.config.prompt).toMatch(/STRUCTURED VERDICT LINE/);
	});

	test('no agent prompt source names the controller-bound contract block (#3358 recurrence guard)', () => {
		const offenders = readdirSync(AGENTS_DIR)
			.filter((name) => name.endsWith('.ts'))
			.filter((name) =>
				readFileSync(join(AGENTS_DIR, name), 'utf-8').includes(
					PR_CONTRACT_BLOCK,
				),
			);
		expect(offenders).toEqual([]);
	});

	test('the PR_FEEDBACK verification lane carries the Stage-B suspension clause (#3337)', () => {
		const verification = composedPrompt('swarm-pr-feedback:verification');
		expect(verification).toContain('[FEEDBACK-VERIFIED]');
		expect(verification).toMatch(/does not apply to this lane/);
	});

	test('discovery (base) composed prompts carry no protocol clause', () => {
		// Base/micro lanes also need settlement provenance (batch_id) in the
		// options; without it the contract refuses the request outright.
		const result = _test_exports.applyPrWorkflowPromptContract(
			[laneFor('swarm-pr-review:base')],
			{
				...optionsFor('swarm-pr-review:base'),
				batchId: 'batch-base',
			},
		);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error(result.errors.join('; '));
		expect(result.lanes[0].prompt).not.toContain('PROTOCOL SELECTION');
	});

	test('producer-side scoping: the clauses live in the controller, never in an agent prompt', () => {
		// With the static prompts clean, quoting a clause phrase in plan or
		// spec text cannot activate anything: the only producer of a
		// suspension instruction is the controller's contract composition,
		// which the plan text never enters. Pin the producer side — every
		// mode key is dispatched from dispatch-lanes.ts ...
		const source = readFileSync(
			join(__dirname, '../../../src/tools/dispatch-lanes.ts'),
			'utf-8',
		);
		expect(source).toContain(CRITIC_PROTOCOL_SELECTION_CLAUSE);
		for (const mode of [
			'swarm-pr-feedback:stage-b-reviewer',
			'swarm-pr-feedback:closeout-reviewer',
			'swarm-pr-feedback:closeout-critic',
			'swarm-pr-feedback:verification',
		]) {
			expect(source).toContain(mode);
		}
		// ... and never in the agent prompt sources.
		for (const agentFile of ['critic.ts', 'reviewer.ts']) {
			const agentSource = readFileSync(join(AGENTS_DIR, agentFile), 'utf-8');
			expect(agentSource).not.toContain('PROTOCOL SELECTION');
		}
	});

	test('the PLAN REVIEW default structure mandate survives', () => {
		expect(defaultCriticPrompt()).toMatch(/Begin directly with PLAN REVIEW/);
	});

	test('default critic agent keeps the base critic identity', () => {
		const agent = createCriticAgent('test-model');
		expect(agent.name).toBe('critic');
	});
});
