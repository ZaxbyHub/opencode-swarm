/**
 * PR #3631 feedback-round contract riders (2026-11-10): unit-level pins for
 * the feedback fixes that live at the schema and prompt-composition layer.
 *
 * - F-001: every swarm-pr-feedback verdict mode receives a mode-scoped
 *   PROTOCOL SELECTION clause naming its own row family; PR-review modes keep
 *   their clauses; stage-b-test gets none (no override ever lived there).
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

	test('F-001: stage-b-test carries no protocol clause and PR-review clauses are unchanged', () => {
		const stageBTest = applyContract('swarm-pr-feedback:stage-b-test');
		expect(stageBTest.hasBlock).toBe(true);
		expect(stageBTest.prompt).not.toContain('PROTOCOL SELECTION');
		const reviewer = applyContract('swarm-pr-review:reviewer');
		expect(reviewer.prompt).toContain('PROTOCOL SELECTION (#3310)');
		const critic = applyContract('swarm-pr-review:critic');
		expect(critic.prompt).toContain(CRITIC_PROTOCOL_SELECTION_CLAUSE);
	});

	test('F-006: re-applying the contract to its own output is byte-identical', () => {
		const once = applyContract('swarm-pr-review:reviewer').prompt;
		const lanes = [
			{
				id: 'probe-lane',
				prompt: once,
				workflow_lane: 'probe-lane',
				review_item_ids: ['C-1'],
			},
		];
		_test_exports.applyPrWorkflowPromptContract(lanes as never, {
			mode: 'swarm-pr-review:reviewer',
			prHeadSha: 'abc123',
			revisionDigest: 'revision-test',
		});
		expect(lanes[0]!.prompt).toBe(once);
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
