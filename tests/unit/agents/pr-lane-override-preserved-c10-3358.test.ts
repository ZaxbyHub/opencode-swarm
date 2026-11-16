// AC10 (trace 3358-3337-3341; #3337 AC2, preserving): PR-review lanes keep
// the override after the activation-signal restructuring.
//
// Pins:
// - DEFAULT critic agent in a 'swarm-pr-review:critic' lane: the effective
//   instruction set — the UNION of the agent system prompt
//   (createCriticAgent('m').config.prompt) and the controller-composed lane
//   prompt (applyPrWorkflowPromptContract via _test_exports in
//   src/tools/dispatch-lanes.ts) — contains an instruction that suspends the
//   default PLAN REVIEW structure and requires the [CRITIC] rows. Asserted
//   against the union so the check holds whether the clause lives in the
//   agent prompt or in the lane prompt.
// - DEFAULT reviewer agent in a 'swarm-pr-review:reviewer' lane: the union
//   contains the Stage-B suspension (the STRUCTURED VERDICT LINE task row
//   gives way to the lane's live row contract).
//
// Assertions are phrasing-robust (intent words: suspend / does not apply /
// emit only, and the row markers), never exact sentences.
//
// GREEN at base and after the fix.
import { describe, expect, test } from 'bun:test';
import * as criticModule from '../../../src/agents/critic.js';
import * as reviewerModule from '../../../src/agents/reviewer.js';
import { _test_exports } from '../../../src/tools/dispatch-lanes.js';

type AgentFactory = (
	model: string,
	customPrompt?: string,
) => { config?: { prompt?: string } };

const criticMod = criticModule as unknown as {
	createCriticAgent?: AgentFactory;
};
const reviewerMod = reviewerModule as unknown as {
	createReviewerAgent?: AgentFactory;
};

function defaultCriticSystemPrompt(): string {
	expect(typeof criticMod.createCriticAgent).toBe('function');
	const prompt = criticMod.createCriticAgent?.('m')?.config?.prompt;
	expect(typeof prompt).toBe('string');
	expect((prompt ?? '').length).toBeGreaterThan(0);
	return prompt ?? '';
}

function defaultReviewerSystemPrompt(): string {
	expect(typeof reviewerMod.createReviewerAgent).toBe('function');
	const prompt = reviewerMod.createReviewerAgent?.('m')?.config?.prompt;
	expect(typeof prompt).toBe('string');
	expect((prompt ?? '').length).toBeGreaterThan(0);
	return prompt ?? '';
}

function composedLanePrompt(
	mode: string,
	lane: {
		id: string;
		agent: string;
		prompt: string;
		workflow_lane: string;
		review_item_ids: string[];
	},
): string {
	const result = _test_exports.applyPrWorkflowPromptContract([lane], {
		mode,
		prHeadSha: 'a'.repeat(40),
		revisionDigest: 'b'.repeat(64),
	});
	expect(result.ok).toBe(true);
	if (!result.ok) {
		throw new Error(`contract rejected: ${result.errors.join('; ')}`);
	}
	const prompt = result.lanes[0]?.prompt ?? '';
	expect(prompt.length).toBeGreaterThan(0);
	return prompt;
}

// Intent-word matchers: the suspension may be worded as "suspended", "does
// not apply", or "emit only"; the row contracts are matched by marker.
const SUSPENSION_INTENT = /suspend|does not apply|do not apply|emit only/i;

describe('AC10 — PR-review lane override still applies (preserving)', () => {
	test('critic lane: effective set suspends the default PLAN REVIEW structure', () => {
		const system = defaultCriticSystemPrompt();
		const composed = composedLanePrompt('swarm-pr-review:critic', {
			id: 'critic-c10-3358',
			agent: 'critic',
			prompt:
				'Caller-authored challenge prompt for the assigned reviewer claim.',
			workflow_lane: 'critic-chunk-1',
			review_item_ids: ['c1'],
		});
		const effective = `${system}\n\n${composed}`;
		expect(effective).toMatch(SUSPENSION_INTENT);
	});

	test('critic lane: effective set requires the [CRITIC] rows for assigned ids', () => {
		const system = defaultCriticSystemPrompt();
		const composed = composedLanePrompt('swarm-pr-review:critic', {
			id: 'critic-c10-3358',
			agent: 'critic',
			prompt:
				'Caller-authored challenge prompt for the assigned reviewer claim.',
			workflow_lane: 'critic-chunk-1',
			review_item_ids: ['c1'],
		});
		const effective = `${system}\n\n${composed}`;
		expect(effective).toMatch(/\[CRITIC\]|\bCRITIC row\b/i);
		expect(effective).toContain('assigned_item_ids:');
	});

	test('reviewer lane: effective set suspends the Stage-B STRUCTURED VERDICT LINE row', () => {
		const system = defaultReviewerSystemPrompt();
		const composed = composedLanePrompt('swarm-pr-review:reviewer', {
			id: 'reviewer-c10-3358',
			agent: 'reviewer',
			prompt:
				'Caller-authored classification prompt for the assigned candidates.',
			workflow_lane: 'reviewer-chunk-1',
			review_item_ids: ['r1'],
		});
		const effective = `${system}\n\n${composed}`;
		expect(effective).toMatch(SUSPENSION_INTENT);
		// The suspended mandate is named, and the lane's live row contract is present.
		expect(effective).toContain('STRUCTURED VERDICT LINE');
		expect(effective).toMatch(/\[REVIEWED\]/);
	});
});
