/**
 * PR #3631 feedback-round contract riders (2026-11-10): unit-level pins for
 * the feedback fixes that live at the schema and prompt-composition layer.
 *
 * - F-001: every swarm-pr-feedback verdict mode receives a mode-scoped
 *   PROTOCOL SELECTION clause naming its own row family; PR-review modes keep
 *   their clauses. Originally stage-b-test got none (no override ever lived
 *   there); issue #3645 supersedes that pin — the stage-b-test lane now MUST
 *   carry a clause suspending the test_engineer prompt's static [TESTED]
 *   mandate (see the amended F-001 stage-b-test leg below).
 * - F-002: a transport-legal critic DOWNGRADED|NONE row is refused (its
 *   truthful post-critic projection CONFIRMED+NONE is exactly the pair the
 *   write boundary refuses), with DISPROVED|NONE still legal and the contract
 *   card stating the rule.
 * - PRR-01 disposition: an OMITTED severity on a CONFIRMED record is already
 *   rejected by the #2279 aggregated validator (pr-workflow-gate.ts
 *   reportSeverity, "an OMITTED severity is a mismatch, never a skip"); the
 *   write schema deliberately rejects only explicit NONE so the one-rejection
 *   aggregated contract and the documented error ordering survive. This suite
 *   pins that division (schema refuses NONE; the aggregated gate owns
 *   omission).
 * - F-008: the committed-replay args schema reads the durable record shape
 *   (accepting CONFIRMED+NONE) while the write schema refuses it; the
 *   replay-identity key treats an absent severity as the NONE the writers
 *   coerce at persistence.
 * - F-007: an EMPTY critic.md leaves the verifiable built-in prompt active,
 *   so provenance must not report a replacement.
 * - F-006: re-applying the contract to its own composed output is
 *   byte-identical (the strip removes the exact composition separator).
 */
import { describe, expect, test } from 'bun:test';
import {
	createCriticAgent,
	PLAN_CRITIC_PROMPT,
} from '../../../src/agents/critic.js';
import {
	buildPrReviewContractCard,
	PrReviewCriticVerdictFieldsSchema,
	PrReviewFindingSchema,
	WritePrReviewArtifactArgsSchema,
	WritePrReviewArtifactCommittedReplayArgsSchema,
} from '../../../src/background/pr-review-contract.js';
import {
	_test_exports,
	CRITIC_PROTOCOL_SELECTION_CLAUSE,
} from '../../../src/tools/dispatch-lanes.js';

/**
 * Apply the PR workflow prompt contract the way the dispatcher does —
 * (lanes, options), reading the returned lane objects (the mapper returns
 * `{...lane, prompt}` copies rather than mutating in place).
 */
function applyContract(mode: string): { hasBlock: boolean; prompt: string } {
	const lanes = [
		{
			id: 'probe-lane',
			prompt: 'Settle the assigned item.',
			workflow_lane: 'probe-lane',
			review_item_ids: ['C-1'],
		},
	];
	const result = _test_exports.applyPrWorkflowPromptContract(lanes as never, {
		mode,
		prHeadSha: 'abc123',
		revisionDigest: 'revision-test',
	}) as { ok: boolean; lanes?: Array<{ prompt: string }> };
	if (!result.ok || !result.lanes?.[0]) {
		throw new Error(`contract application failed for ${mode}`);
	}
	const first = result.lanes[0]!;
	return {
		hasBlock: first.prompt.includes('[CONTROLLER-BOUND PR WORKFLOW CONTRACT]'),
		prompt: first.prompt,
	};
}

describe('PR #3631 feedback contract riders', () => {
	test('F-001: each feedback verdict mode gets its own protocol clause with the right row marker', () => {
		const cases: Array<{
			mode: string;
			marker: string;
			agentDefault: string;
		}> = [
			{
				mode: 'swarm-pr-feedback:stage-b-reviewer',
				marker: '[STAGE-B-REVIEW]',
				agentDefault: 'STRUCTURED VERDICT LINE',
			},
			{
				mode: 'swarm-pr-feedback:closeout-reviewer',
				marker: '[CLOSEOUT-REVIEW]',
				agentDefault: 'STRUCTURED VERDICT LINE',
			},
			{
				mode: 'swarm-pr-feedback:closeout-critic',
				marker: '[CLOSEOUT-CRITIC]',
				agentDefault: 'PLAN REVIEW',
			},
		];
		for (const { mode, marker, agentDefault } of cases) {
			const { hasBlock, prompt } = applyContract(mode);
			expect(hasBlock).toBe(true);
			expect(prompt).toContain('PROTOCOL SELECTION (feedback');
			expect(prompt).toContain(marker);
			expect(prompt).toContain('does not apply to this lane');
			expect(prompt).toContain(agentDefault);
		}
	});

	test('F-001 (amended per #3645): stage-b-test carries the [TESTED] suspension clause', () => {
		// Originally this leg pinned "stage-b-test gets no protocol clause".
		// Issue #3645 supersedes that: the test_engineer prompt's static
		// "STRUCTURED VERDICT LINE (MANDATORY)" section keeps mandating
		// task-keyed [TESTED] rows the feedback gate never settles, so the
		// composed stage-b-test prompt must now carry the suspension clause.
		// RED at base (no stage-b-test arm in FEEDBACK_VERDICT_PROTOCOL_CLAUSES).
		const stageBTest = applyContract('swarm-pr-feedback:stage-b-test');
		expect(stageBTest.hasBlock).toBe(true);
		expect(stageBTest.prompt).toContain('PROTOCOL SELECTION');
		expect(stageBTest.prompt).toContain('Do not emit a [TESTED]');
		expect(stageBTest.prompt).toContain('[STAGE-B-TEST]');
		const reviewer = applyContract('swarm-pr-review:reviewer');
		expect(reviewer.prompt).toContain('PROTOCOL SELECTION (#3310)');
		const critic = applyContract('swarm-pr-review:critic');
		expect(critic.prompt).toContain(CRITIC_PROTOCOL_SELECTION_CLAUSE);
	});

	test('F-006: re-applying the contract to its own output is byte-identical', () => {
		// The mapper RETURNS new lane objects ({...lane, prompt}); the input
		// array is never mutated, so the assertion must read the returned lane.
		const once = applyContract('swarm-pr-review:reviewer').prompt;
		const lanes = [
			{
				id: 'probe-lane',
				prompt: once,
				workflow_lane: 'probe-lane',
				review_item_ids: ['C-1'],
			},
		];
		const second = _test_exports.applyPrWorkflowPromptContract(lanes as never, {
			mode: 'swarm-pr-review:reviewer',
			prHeadSha: 'abc123',
			revisionDigest: 'revision-test',
		}) as { ok: boolean; lanes?: Array<{ prompt: string }> };
		expect(second.ok).toBe(true);
		expect(second.lanes?.[0]?.prompt).toBe(once);
	});

	test('F-002: DOWNGRADED|NONE is refused with the DISPROVED remedy named', () => {
		const parsed = PrReviewCriticVerdictFieldsSchema.safeParse([
			'[CRITIC]',
			'C-1',
			'DOWNGRADED',
			'NONE',
			'rationale text',
			'suggested change',
		]);
		expect(parsed.success).toBe(false);
		if (!parsed.success) {
			expect(
				parsed.error.issues.some((issue) =>
					issue.message.includes('DOWNGRADED critic severity must not be NONE'),
				),
			).toBe(true);
			expect(
				parsed.error.issues.some((issue) =>
					issue.message.includes('DISPROVED'),
				),
			).toBe(true);
		}
	});

	test('F-002: legal terminal rows stay legal', () => {
		expect(
			PrReviewCriticVerdictFieldsSchema.safeParse([
				'[CRITIC]',
				'C-1',
				'DOWNGRADED',
				'LOW',
				'rationale text',
				'suggested change',
			]).success,
		).toBe(true);
		expect(
			PrReviewCriticVerdictFieldsSchema.safeParse([
				'[CRITIC]',
				'C-1',
				'DISPROVED',
				'NONE',
				'rationale text',
				'suggested change',
			]).success,
		).toBe(true);
		expect(
			PrReviewCriticVerdictFieldsSchema.safeParse([
				'[CRITIC]',
				'C-1',
				'UPHELD',
				'NONE',
				'rationale text',
				'suggested change',
			]).success,
		).toBe(false);
	});

	test('F-002: the contract card states the rule lanes see', () => {
		const card = buildPrReviewContractCard();
		expect(card).toContain('never CRITICAL or NONE');
		expect(card).toContain('DISPROVED (severity NONE), not DOWNGRADED at NONE');
	});

	test('PRR-01 disposition: the schema refuses explicit NONE; omission stays with the aggregated gate', () => {
		const base = {
			finding_id: 'C-1',
			status: 'CONFIRMED' as const,
			file_line: 'file.ts:1',
			evidence: 'evidence text',
			next_action: 'report' as const,
			risk_impact: 'ORDINARY' as const,
			risk_tags: [] as string[],
		};
		// Explicit NONE on CONFIRMED: refused by the write schema (#3310 rule).
		expect(
			PrReviewFindingSchema.safeParse({ ...base, severity: 'NONE' }).success,
		).toBe(false);
		// A valid severity with the required risk metadata parses.
		expect(
			PrReviewFindingSchema.safeParse({ ...base, severity: 'LOW' }).success,
		).toBe(true);
		// CONFIRMED without risk metadata is refused by the #2383 refine.
		expect(
			PrReviewFindingSchema.safeParse({
				...base,
				severity: 'LOW',
				risk_impact: undefined,
				risk_tags: undefined,
			}).success,
		).toBe(false);
		// Non-CONFIRMED records stay terse (severity still optional).
		expect(
			PrReviewFindingSchema.safeParse({
				...base,
				status: 'PENDING' as const,
				next_action: 'route_to_reviewer' as const,
				risk_impact: undefined,
				risk_tags: undefined,
			}).success,
		).toBe(true);
	});

	test('F-008: the committed-replay schema reads what the write schema refuses', () => {
		const findingsArgs = {
			kind: 'findings' as const,
			pr_head_sha: 'abc123',
			boundary: 'post_critic' as const,
			records: [
				{
					finding_id: 'C-1',
					status: 'CONFIRMED' as const,
					file_line: 'file.ts:1',
					evidence: 'evidence text',
					next_action: 'report' as const,
					severity: 'NONE' as const,
					risk_impact: 'ORDINARY' as const,
					risk_tags: [] as string[],
				},
			],
		};
		expect(
			WritePrReviewArtifactArgsSchema.safeParse(findingsArgs).success,
		).toBe(false);
		expect(
			WritePrReviewArtifactCommittedReplayArgsSchema.safeParse(findingsArgs)
				.success,
		).toBe(true);
	});

	test('F-007: an empty custom prompt leaves the built-in critic prompt active', () => {
		const builtin = createCriticAgent('model-x', '', undefined);
		const custom = createCriticAgent('model-x', 'custom body', undefined);
		expect(builtin.config.prompt).toBe(PLAN_CRITIC_PROMPT);
		expect(custom.config.prompt).toBe('custom body');
	});
});

describe('issue #3645: stage-b-test carries the [TESTED] mandate suspension', () => {
	test('stage-b-test composed lane prompt carries a PROTOCOL SELECTION clause naming the suspended mandate', () => {
		// #3645 AC3: FEEDBACK_VERDICT_PROTOCOL_CLAUSES
		// (src/tools/dispatch-lanes.ts) has four sibling arms —
		// stage-b-reviewer, closeout-reviewer, closeout-critic, and
		// verification — each naming its row family and the phrase "does not
		// apply to this lane", but NO stage-b-test arm. The test_engineer
		// agent prompt carries a static "STRUCTURED VERDICT LINE (MANDATORY)"
		// section mandating [TESTED] | task-<taskId> rows, so a stage-b-test
		// lane without a suspension clause keeps emitting task-keyed [TESTED]
		// rows the feedback gate never settles. DISCRIMINATING — RED at
		// base; the fix adds the stage-b-test clause naming its [STAGE-B-TEST]
		// row family and the suspended mandate.
		const { hasBlock, prompt } = applyContract(
			'swarm-pr-feedback:stage-b-test',
		);
		expect(hasBlock).toBe(true);
		expect(prompt).toContain('PROTOCOL SELECTION');
		expect(prompt).toContain('does not apply to this lane');
		expect(prompt).toContain('Do not emit a [TESTED]');
		expect(prompt).toContain('[STAGE-B-TEST]');
		expect(prompt).toContain('[STAGE-B-TEST] | <item_id> | PASS');
		// The clause must name the suspended mandate: the test_engineer
		// prompt's "STRUCTURED VERDICT LINE (MANDATORY)" [TESTED] section.
		expect(prompt).toContain('STRUCTURED VERDICT LINE');
	}, 60_000);
});
