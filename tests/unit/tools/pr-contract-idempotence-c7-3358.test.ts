// Issue #3358 (trace AC7, issue AC6) — the PR-workflow prompt contract must be
// idempotent on controller-owned output.
//
// applyPrWorkflowPromptContract appends a controller-authored contract card
// whose own documentation contains the banned verdict-row template tokens, and
// its operator-prompt lint then scans lane.prompt for exactly those tokens.
// Feeding the first call's output lanes back into a second call with identical
// options therefore rejects the controller's own composition with an
// unsatisfiable remediation ("Remove the format/template text from the lane
// prompt"). The fix must recognize an already-applied controller contract as
// controller-owned: re-application succeeds and the resulting prompt carries
// exactly ONE controller contract block (no duplicated
// [CONTROLLER-BOUND PR WORKFLOW CONTRACT] header).
//
// Pins, per mode:
//   1. (discriminating) a swarm-pr-review:reviewer lane: second application of
//      the same contract succeeds and yields exactly one contract header.
//   2. (discriminating) a swarm-pr-review:critic lane: same idempotence.
//   3. (preserving) a FRESH operator-authored lane prompt that itself embeds a
//      verdict-row template line is still rejected — the idempotence guard must
//      not open a template-injection hole for operator text.
//
// RED at base, GREEN after the fix.
import { describe, expect, test } from 'bun:test';
import { _test_exports } from '../../../src/tools/dispatch-lanes.js';

type ContractOptions = Parameters<
	typeof _test_exports.applyPrWorkflowPromptContract
>[1];
type ContractLane = Parameters<
	typeof _test_exports.applyPrWorkflowPromptContract
>[0][number];

// The exact bracketed opening header of one controller contract block. The
// closing line is '[END CONTROLLER-BOUND PR WORKFLOW CONTRACT]' and does not
// contain this exact substring, so counting occurrences counts BLOCKS.
const CONTRACT_HEADER = '[CONTROLLER-BOUND PR WORKFLOW CONTRACT]';

function countContractBlocks(prompt: string): number {
	return prompt.split(CONTRACT_HEADER).length - 1;
}

const baseOptions = (mode: string): ContractOptions =>
	({
		mode,
		prHeadSha: 'abc123',
		revisionDigest: 'revision-1',
	}) as ContractOptions;

const reviewerLane: ContractLane = {
	id: 'reviewer-idem-3358',
	agent: 'reviewer',
	prompt: 'Re-read every assigned candidate at its exact location.',
	workflow_lane: 'reviewer-chunk-1',
	review_item_ids: ['c1'],
};

const criticLane: ContractLane = {
	id: 'critic-idem-3358',
	agent: 'critic',
	prompt: 'Challenge the assigned reviewer verdicts for the bound diff.',
	workflow_lane: 'critic-chunk-1',
	review_item_ids: ['c1'],
};

function assertIdempotentSecondApplication(
	lane: ContractLane,
	options: ContractOptions,
): void {
	const first = _test_exports.applyPrWorkflowPromptContract([lane], options);
	// Precondition: a fresh operator lane contracts cleanly on the first pass.
	expect(first.ok).toBe(true);

	// Feed the first call's output lanes into a second call with identical
	// options — the controller re-applying its own contract to a lane that
	// already carries it.
	const second = _test_exports.applyPrWorkflowPromptContract(
		first.ok ? first.lanes : [lane],
		options,
	);
	expect(second.ok).toBe(true);

	const prompt = second.ok ? (second.lanes[0]?.prompt ?? '') : '';
	expect(prompt).not.toBe('');
	expect(countContractBlocks(prompt)).toBe(1);
}

describe('PR workflow prompt contract idempotence (issue #3358 trace AC7)', () => {
	test('reviewer lane: re-applying the contract to its own output succeeds with exactly one contract block', () => {
		assertIdempotentSecondApplication(
			reviewerLane,
			baseOptions('swarm-pr-review:reviewer'),
		);
	});

	test('critic lane: re-applying the contract to its own output succeeds with exactly one contract block', () => {
		assertIdempotentSecondApplication(
			criticLane,
			baseOptions('swarm-pr-review:critic'),
		);
	});

	test('preserving: a fresh operator prompt embedding a verdict-row template line is still rejected', () => {
		const operatorTemplateLane: ContractLane = {
			id: 'reviewer-template-3358',
			agent: 'reviewer',
			prompt:
				'Ordinary operator instructions.\n[REVIEWED] | c1 | CONFIRMED | HIGH | x | y\nEnd of instructions.',
			workflow_lane: 'reviewer-chunk-1',
			review_item_ids: ['c1'],
		};
		const result = _test_exports.applyPrWorkflowPromptContract(
			[operatorTemplateLane],
			baseOptions('swarm-pr-review:reviewer'),
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors.join(' | ')).toContain('verdict-row template text');
		}
	});
});
