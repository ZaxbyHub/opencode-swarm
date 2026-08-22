import { describe, expect, test } from 'bun:test';
import { _test_exports } from '../../../src/tools/dispatch-lanes.js';

const PR_HEAD_SHA = 'abc123';
const REVISION_DIGEST = 'revision-1';

function contractOptions(mode: string) {
	return {
		mode,
		prHeadSha: PR_HEAD_SHA,
		revisionDigest: REVISION_DIGEST,
	};
}

function baseLane(overrides: Record<string, unknown> = {}) {
	return {
		id: 'lane-1',
		agent: 'explorer',
		prompt: 'Caller-authored prompt',
		...overrides,
	};
}

function contractedPrompt(
	mode: string,
	laneOverrides: Record<string, unknown> = {},
): string {
	const contracted = _test_exports.applyPrWorkflowPromptContract(
		[baseLane(laneOverrides)],
		contractOptions(mode),
	);
	expect(contracted.ok).toBe(true);
	if (!contracted.ok) throw new Error('expected prompt contract');
	return contracted.lanes[0].prompt;
}

describe('pr-review lane response budget derivation (#2276)', () => {
	test('scales the budget with the lane kind and owned workload', () => {
		const { prReviewLaneResponseBudgetChars } = _test_exports;
		expect(
			prReviewLaneResponseBudgetChars('swarm-pr-review:base', baseLane()),
		).toBe(18_000);
		expect(
			prReviewLaneResponseBudgetChars('swarm-pr-review:micro', baseLane()),
		).toBe(12_000);
		// Consolidated micro lanes (depth tiers S/M — the only lanes the dispatch
		// gate allows to declare owned_workflow_lanes besides base) scale with
		// the owned-lane count, floored at one owner and capped at the ceiling.
		expect(
			prReviewLaneResponseBudgetChars('swarm-pr-review:micro', {
				owned_workflow_lanes: [
					'correctness-state',
					'security-trust',
					'reliability-performance',
				],
			}),
		).toBe(16_000);
		expect(
			prReviewLaneResponseBudgetChars('swarm-pr-review:micro', {
				owned_workflow_lanes: [
					'intent-architecture',
					'correctness-state',
					'tests-falsifiability',
					'security-trust',
					'reliability-performance',
					'compatibility-delivery',
				],
			}),
		).toBe(18_000);
		// Council lanes are flat: the dispatch gate forbids
		// owned_workflow_lanes on council/reviewer/critic lanes outright.
		expect(
			prReviewLaneResponseBudgetChars('swarm-pr-review:council', baseLane()),
		).toBe(12_000);
		// Reviewer/critic budgets scale with the assigned item count…
		expect(
			prReviewLaneResponseBudgetChars('swarm-pr-review:reviewer', {
				review_item_ids: ['C-1', 'C-2'],
			}),
		).toBe(9_000);
		expect(
			prReviewLaneResponseBudgetChars('swarm-pr-review:critic', {
				review_item_ids: ['C-1'],
			}),
		).toBe(7_500);
		// …monotonically…
		expect(
			prReviewLaneResponseBudgetChars('swarm-pr-review:reviewer', {
				review_item_ids: ['C-1', 'C-2', 'C-3', 'C-4'],
			}),
		).toBe(12_000);
		// …and the ceiling kicks in before the budget can reach the preview cap.
		expect(
			prReviewLaneResponseBudgetChars('swarm-pr-review:reviewer', {
				review_item_ids: Array.from(
					{ length: 12 },
					(_, index) => `C-${index + 1}`,
				),
			}),
		).toBe(18_000);
	});

	test('modes outside swarm-pr-review:* have no derived budget', () => {
		const { prReviewLaneResponseBudgetChars } = _test_exports;
		expect(
			prReviewLaneResponseBudgetChars('swarm-pr-feedback:verification', {
				feedback_item_ids: ['F-1'],
			}),
		).toBeUndefined();
		expect(
			prReviewLaneResponseBudgetChars('swarm-pr-feedback:stage-b-reviewer', {}),
		).toBeUndefined();
	});
});

describe('controller-appended prompt budget block (#2276)', () => {
	test('every swarm-pr-review:* mode carries its derived budget line', () => {
		expect(
			contractedPrompt('swarm-pr-review:base', {
				workflow_lane: 'intent-architecture',
			}),
		).toContain('final_response_char_budget: 18000');
		expect(
			contractedPrompt('swarm-pr-review:micro', {
				workflow_lane: 'api-schema-migrations',
			}),
		).toContain('final_response_char_budget: 12000');
		const consolidatedMicroPrompt = contractedPrompt('swarm-pr-review:micro', {
			workflow_lane: 'correctness-state',
			owned_workflow_lanes: ['correctness-state', 'security-trust'],
		});
		expect(consolidatedMicroPrompt).toContain(
			'final_response_char_budget: 14000',
		);
		const councilPrompt = contractedPrompt('swarm-pr-review:council', {
			workflow_lane: 'correctness-state',
		});
		expect(councilPrompt).toContain('final_response_char_budget: 12000');
		const reviewerPrompt = contractedPrompt('swarm-pr-review:reviewer', {
			workflow_lane: 'review-chunk-1',
			review_item_ids: ['C-1', 'C-2'],
		});
		expect(reviewerPrompt).toContain('final_response_char_budget: 9000');
		expect(reviewerPrompt).toContain(
			'no more than 9000 characters of substantive output',
		);
		const criticPrompt = contractedPrompt('swarm-pr-review:critic', {
			workflow_lane: 'critic-chunk-1',
			review_item_ids: ['C-1', 'C-2', 'C-3'],
		});
		expect(criticPrompt).toContain('final_response_char_budget: 10500');
		// At least two distinct sizes are directly observable in the prompts.
		expect(new Set(['18000', '12000', '14000', '9000', '10500']).size).toBe(5);
	});

	test('budget paragraph reserves terminal-row headroom and uncaps investigation', () => {
		const prompt = contractedPrompt('swarm-pr-review:base', {
			workflow_lane: 'intent-architecture',
		});
		expect(prompt).toContain(
			'Only your final response is bounded: keep the complete final response at or below 18000 characters.',
		);
		expect(prompt).toContain(
			'Investigation and tool-call volume are NOT capped by this budget.',
		);
		expect(prompt).toContain(
			'must always fit inside the budget with room to spare',
		);
		expect(prompt).toContain('Verify each target exactly once.');
		expect(prompt).toContain(
			'The moment analysis is complete, emit the terminal rows immediately.',
		);
	});

	test('swarm-pr-feedback:* blocks keep the flat cap and carry no budget line', () => {
		for (const mode of [
			'swarm-pr-feedback:verification',
			'swarm-pr-feedback:stage-b-reviewer',
			'swarm-pr-feedback:closeout-critic',
		]) {
			const prompt = contractedPrompt(mode, {
				workflow_lane: 'stage-b-reviewer',
			});
			expect(prompt).toContain(
				'no more than 12000 characters of substantive output',
			);
			expect(prompt).not.toContain('final_response_char_budget');
		}
	});
});

describe('controller-appended shell rules paragraph (#2276)', () => {
	const SHELL_RULE_SENTENCES = [
		'run ONE standalone command per shell call',
		'no pipes, no &&/||/; composition, no redirects, no command substitution, no backslash- or caret-escaped double quotes',
		'up to three leading cd <dir> && prefixes',
		'a trailing 2>&1 (reads only)',
		'a literal | inside a double-quoted gh api --jq value',
		'Prefer the Read, Glob, and Grep tools for file inspection',
	];

	test('present in every swarm-pr-review:* mode block', () => {
		const prompts = [
			contractedPrompt('swarm-pr-review:base', {
				workflow_lane: 'intent-architecture',
			}),
			contractedPrompt('swarm-pr-review:micro', {
				workflow_lane: 'api-schema-migrations',
			}),
			contractedPrompt('swarm-pr-review:council', {
				workflow_lane: 'correctness-state',
			}),
			contractedPrompt('swarm-pr-review:reviewer', {
				workflow_lane: 'review-chunk-1',
				review_item_ids: ['C-1'],
			}),
			contractedPrompt('swarm-pr-review:critic', {
				workflow_lane: 'critic-chunk-1',
				review_item_ids: ['C-1'],
			}),
		];
		for (const prompt of prompts) {
			expect(prompt).toContain('Read-only shell rules');
			for (const sentence of SHELL_RULE_SENTENCES) {
				expect(prompt).toContain(sentence);
			}
		}
	});

	test('present in swarm-pr-feedback:* blocks (same classifier governs both gates)', () => {
		for (const mode of [
			'swarm-pr-feedback:verification',
			'swarm-pr-feedback:stage-b-reviewer',
		]) {
			const prompt = contractedPrompt(mode, {
				workflow_lane: 'stage-b-reviewer',
			});
			expect(prompt).toContain('Read-only shell rules');
			for (const sentence of SHELL_RULE_SENTENCES) {
				expect(prompt).toContain(sentence);
			}
		}
	});
});

// The ledger→collect-receipt projection of `salvaged_workflow_lane_recoveries`
// (kind `truncated-preview-durable-artifact`) is already pinned end-to-end
// through `executeDispatchLanesAsync` by #2272's
// dispatch-lanes-pr-review-verdict-transport-recovery.test.ts (:172-185,
// :274-287) — a second unit-level pin here would duplicate that coverage with
// a type-bypassing record literal (implementation-review finding 2).
