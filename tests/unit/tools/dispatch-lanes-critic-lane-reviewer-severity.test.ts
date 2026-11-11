// Issue #3310 AC13 — critic lanes must see the reviewer severity per item.
//
// The critic-mode CONTROLLER-BOUND PR WORKFLOW CONTRACT renders
// assigned_item_ids but no per-item reviewer severity, so a critic lane
// re-derives severity from scratch instead of challenging the reviewer's
// calibrated one. The fix adds an option to applyPrWorkflowPromptContract
// carrying per-item reviewer severities, following the orderUnstableItemIds
// precedent: an optional option rendered only when supplied; unspecified
// renders nothing extra (byte-shape compat).
//
// FROZEN INPUT SURFACE (the implementer must build exactly this):
//   options.reviewerSeverities?: Record<string, string>
//     — maps ASSIGNED item id -> the reviewer severity token for that item
//       (e.g. { c1: 'HIGH', c2: 'LOW' }); single-token values.
//   Rendering contract: for mode 'swarm-pr-review:critic', when supplied,
//   the CONTROLLER-BOUND block renders each assigned item's reviewer
//   severity on its OWN line, `reviewer_severity: c1=HIGH`, while
//   assigned_item_ids keeps the bare ids (#3358 AC8 superseded the original
//   same-line `c1 (HIGH)` shape: a verbatim copy of that decorated token
//   voided the lane). When the option is absent (or explicitly undefined),
//   the block renders exactly as before — no severity text is added.
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

const criticLane: ContractLane = {
	id: 'critic-3310-sev',
	agent: 'critic',
	prompt: 'Caller-authored critic prompt',
	workflow_lane: 'critic-chunk-1',
	review_item_ids: ['c1', 'c2'],
};

const criticOptions = (extra: Record<string, unknown> = {}) =>
	({
		mode: 'swarm-pr-review:critic',
		prHeadSha: 'abc123',
		revisionDigest: 'revision-1',
		...extra,
	}) as ContractOptions;

function contractedPrompt(options: ContractOptions): string {
	const result = _test_exports.applyPrWorkflowPromptContract(
		[criticLane],
		options,
	);
	if (!result.ok) {
		throw new Error(`contract rejected: ${result.errors.join('; ')}`);
	}
	const prompt = result.lanes[0]?.prompt ?? '';
	if (prompt === '') throw new Error('contract returned no prompt');
	return prompt;
}

describe('critic-lane reviewer severity rendering (issue #3310 AC13)', () => {
	test('renders each assigned item id together with its reviewer severity on its own line', () => {
		const prompt = contractedPrompt(
			criticOptions({ reviewerSeverities: { c1: 'HIGH', c2: 'LOW' } }),
		);
		// Id/severity pairing on one reviewer_severity line each (the [^\n]*
		// window forbids a severity stranded on another line).
		expect(prompt).toContain('reviewer_severity: c1=HIGH');
		expect(prompt).toContain('reviewer_severity: c2=LOW');
		// The assigned ids still render bare inside the controller block.
		expect(prompt).toContain('assigned_item_ids: c1, c2');
	});

	test('absent reviewerSeverities keeps the pre-fix block byte-shape (backward compat)', () => {
		const prompt = contractedPrompt(criticOptions());
		expect(prompt).toContain('assigned_item_ids: c1, c2');
		expect(prompt).not.toContain('reviewer_severity');
		expect(prompt).not.toMatch(/reviewer\s+severity/i);
	});

	test('explicit undefined reviewerSeverities is exactly absent', () => {
		const prompt = contractedPrompt(
			criticOptions({ reviewerSeverities: undefined }),
		);
		expect(prompt).toContain('assigned_item_ids: c1, c2');
		expect(prompt).not.toContain('reviewer_severity');
		expect(prompt).not.toMatch(/reviewer\s+severity/i);
	});
});
