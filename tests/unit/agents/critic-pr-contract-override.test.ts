/**
 * AC14 (issue #3310) — PR critic dispatch names exactly one PR critic agent.
 * Issue #3358 AC1 moved the PR-contract override OFF the agent: the default
 * critic prompt is PR-free (no phrase-activated clause a quoted plan could
 * trigger), and the suspension of the default PLAN REVIEW structure is a
 * controller-authored clause (`CRITIC_PROTOCOL_SELECTION_CLAUSE`) that
 * `applyPrWorkflowPromptContract` injects into every bound
 * swarm-pr-review:critic lane's controller-bound block.
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
import { createCriticAgent } from '../../../src/agents/critic.js';
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

describe('critic PR-contract override (AC14, issue #3310; #3358 AC1)', () => {
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

	test('the PLAN REVIEW default structure mandate survives', () => {
		expect(defaultCriticPrompt()).toMatch(/Begin directly with PLAN REVIEW/);
	});

	test('default critic agent keeps the base critic identity', () => {
		const agent = createCriticAgent('test-model');
		expect(agent.name).toBe('critic');
	});
});
