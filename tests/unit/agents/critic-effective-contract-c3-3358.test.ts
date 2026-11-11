// AC3 (trace 3358-3337-3341; #3358 AC2): a PR-review critic lane's EFFECTIVE
// instruction set must carry the PR-contract suspension even when the critic
// agent is configured with a customPrompt.
//
// Pins:
// - createCriticAgent treats customPrompt as a complete replacement, so the
//   agent system prompt of a configured critic carries no PR-lane override of
//   its own. The effective instruction set a PR-review critic lane runs under
//   is the UNION of (a) the agent system prompt and (b) the controller-composed
//   lane prompt produced by applyPrWorkflowPromptContract (mode
//   'swarm-pr-review:critic', reachable via _test_exports in
//   src/tools/dispatch-lanes.ts). That union must itself carry the
//   PR-contract suspension — an instruction that suspends the agent's default
//   output structure and requires emitting only the [CRITIC] verdict rows for
//   the assigned item ids — so admission of the lane is meaningful regardless
//   of which prompt surface the agent model privileges.
//
// RED at base, GREEN after the fix.
import { describe, expect, test } from 'bun:test';
import * as criticModule from '../../../src/agents/critic.js';
import { _test_exports } from '../../../src/tools/dispatch-lanes.js';

type CriticFactory = (
	model: string,
	customPrompt?: string,
) => { config?: { prompt?: string } };

const criticMod = criticModule as unknown as {
	createCriticAgent?: CriticFactory;
};

const applyPrWorkflowPromptContract =
	_test_exports.applyPrWorkflowPromptContract;

// The customPrompt is a complete replacement: at base it contains zero
// PR-review instructions, which is exactly the admission hazard.
const CUSTOM_PROMPT = `CUSTOM PROMPT — operator-authored review instructions with no PR lane text at all.`;

function customCriticSystemPrompt(): string {
	expect(typeof criticMod.createCriticAgent).toBe('function');
	const agent = criticMod.createCriticAgent?.('m', CUSTOM_PROMPT);
	const prompt = agent?.config?.prompt;
	expect(typeof prompt).toBe('string');
	return prompt ?? '';
}

function composedCriticLanePrompt(): string {
	const result = applyPrWorkflowPromptContract(
		[
			{
				id: 'critic-c3-3358',
				agent: 'critic',
				prompt:
					'Caller-authored challenge prompt for the assigned reviewer claim.',
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
	expect(result.ok).toBe(true);
	if (!result.ok) {
		throw new Error(`contract rejected: ${result.errors.join('; ')}`);
	}
	expect(result.lanes).toHaveLength(1);
	const prompt = result.lanes[0]?.prompt ?? '';
	expect(prompt.length).toBeGreaterThan(0);
	return prompt;
}

// Phrasing-robust intent match: the suspension may be worded as "suspended",
// "does not apply", "do not apply", or "emit only" — but the union must say,
// in some wording, that the default structure gives way to the PR rows.
const SUSPENSION_INTENT = /suspend|does not apply|do not apply|emit only/i;
const CRITIC_ROW_REQUIREMENT = /\[CRITIC\]|\bCRITIC row\b/i;

describe('AC3 — effective prompt of a customPrompt critic PR lane carries the contract (#3358 AC2)', () => {
	test('seam: applyPrWorkflowPromptContract admits the critic lane', () => {
		const composed = composedCriticLanePrompt();
		expect(composed).toContain('assigned_item_ids:');
	});

	test('seam: customPrompt critic system prompt is the complete replacement', () => {
		const system = customCriticSystemPrompt();
		expect(system).toBe(CUSTOM_PROMPT);
	});

	test('customPrompt critic: effective instruction set suspends the default output structure', () => {
		const effective = `${customCriticSystemPrompt()}\n\n${composedCriticLanePrompt()}`;
		// The union itself must carry the suspension wording — the agent side
		// is a bare customPrompt and cannot be relied on to supply it.
		expect(effective).toMatch(SUSPENSION_INTENT);
	});

	test('customPrompt critic: effective instruction set requires the [CRITIC] row format for assigned ids', () => {
		const effective = `${customCriticSystemPrompt()}\n\n${composedCriticLanePrompt()}`;
		expect(effective).toMatch(CRITIC_ROW_REQUIREMENT);
		expect(effective).toContain('assigned_item_ids:');
	});
});
