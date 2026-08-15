import { describe, expect, test } from 'bun:test';
import type { LaneOutputArtifact } from '../../../src/background/lane-output-store.js';
import type {
	BackgroundDelegationRecord,
	BackgroundDelegationResult,
} from '../../../src/background/pending-delegations.js';
import {
	formatPrReviewLaneValidationFailure,
	type PrReviewDiscoveryLaneValidationInput,
	type PrReviewLaneValidationPredicate,
	validatePrReviewDiscoveryLaneCompletion,
} from '../../../src/hooks/pr-workflow-gate.js';

const DIGEST = 'a'.repeat(64);
const REF = `L1:${'b'.repeat(64)}:${'c'.repeat(64)}:${DIGEST}`;
const LANE = 'correctness-state';
const HEADER =
	'[CANDIDATE] | candidate_id | lane | severity | category | file:line | claim | evidence_summary | impact_context | confidence';
const TEXT = `${HEADER}\nC-1 | ${LANE} | HIGH | correctness | src/a.ts:1 | claim | evidence | impact | HIGH`;

function validInput(): PrReviewDiscoveryLaneValidationInput {
	const record: BackgroundDelegationRecord = {
		schemaVersion: 3,
		correlationId: 'child-1',
		jobId: null,
		subagentSessionId: 'child-1',
		parentSessionId: 'parent-1',
		callID: 'call-1',
		normalizedAgent: 'explorer',
		swarmPrefixedAgent: 'explorer',
		planTaskId: null,
		evidenceTaskId: null,
		status: 'pending',
		createdAt: 2_000,
		updatedAt: 2_000,
		batchId: 'batch-1',
		laneId: 'lane-1',
		mode: 'swarm-pr-review:base',
		workflowLane: LANE,
		workspace: {
			directory: '/project',
			gitHead: 'head-1',
			dirtyHash: null,
			prHeadSha: 'head-1',
			scope: 'complete PR diff base-1...head-1',
		},
	};
	const result: BackgroundDelegationResult = {
		text: TEXT,
		chars: TEXT.length,
		truncated: false,
		digest: DIGEST,
		outputRef: REF,
	};
	const artifact: LaneOutputArtifact = {
		schemaVersion: 1,
		ref: REF,
		batchId: 'batch-1',
		laneId: 'lane-1',
		agent: 'explorer',
		role: 'explorer',
		sessionId: 'child-1',
		parentSessionId: 'parent-1',
		mode: 'swarm-pr-review:base',
		workflowLane: LANE,
		prHeadSha: 'head-1',
		gitHead: 'head-1',
		revisionDigest: 'revision-1',
		scope: 'complete PR diff base-1...head-1',
		source: 'collect_lane_results',
		text: TEXT,
		chars: TEXT.length,
		bytes: TEXT.length,
		digest: DIGEST,
		createdAt: '2026-08-08T00:00:00.000Z',
		updatedAt: '2026-08-08T00:00:00.000Z',
	};
	return {
		record,
		result,
		artifact,
		expected: {
			mode: 'swarm-pr-review:base',
			workflowLane: LANE,
			prHeadSha: 'head-1',
			gitHead: 'head-1',
			revisionDigest: 'revision-1',
			reviewScope: 'complete PR diff base-1...head-1',
		},
	};
}

type MutationCase = {
	predicate: PrReviewLaneValidationPredicate;
	mutate(input: PrReviewDiscoveryLaneValidationInput): void;
};

const CASES = [
	{
		predicate: 'record.workflow_lane',
		mutate: (i) => (i.record.workflowLane = 'wrong'),
	},
	{
		predicate: 'record.owned_workflow_lanes',
		mutate: (i) => (i.record.ownedWorkflowLanes = ['wrong']),
	},
	{ predicate: 'record.mode', mutate: (i) => (i.record.mode = 'wrong') },
	{
		predicate: 'record.pr_head_sha',
		mutate: (i) => (i.record.workspace!.prHeadSha = 'wrong'),
	},
	{
		predicate: 'record.git_head',
		mutate: (i) => (i.record.workspace!.gitHead = 'wrong'),
	},
	{
		predicate: 'result.output_degraded',
		mutate: (i) => (i.result.outputDegraded = true),
	},
	{
		predicate: 'result.transcript_incomplete',
		mutate: (i) => (i.result.transcriptIncomplete = true),
	},
	{ predicate: 'result.truncated', mutate: (i) => (i.result.truncated = true) },
	{ predicate: 'result.chars', mutate: (i) => (i.result.chars = 0) },
	{ predicate: 'result.digest', mutate: (i) => (i.result.digest = ' ') },
	{ predicate: 'result.output_ref', mutate: (i) => (i.result.outputRef = ' ') },
	{ predicate: 'artifact.readable', mutate: (i) => (i.artifact = null) },
	{
		predicate: 'artifact.ref',
		mutate: (i) =>
			(i.artifact!.ref = `L1:${'d'.repeat(64)}:${'e'.repeat(64)}:${DIGEST}`),
	},
	{
		predicate: 'artifact.batch_id',
		mutate: (i) => (i.artifact!.batchId = 'wrong'),
	},
	{
		predicate: 'artifact.lane_id',
		mutate: (i) => (i.artifact!.laneId = 'wrong'),
	},
	{ predicate: 'artifact.mode', mutate: (i) => (i.artifact!.mode = 'wrong') },
	{
		predicate: 'artifact.session_id',
		mutate: (i) => (i.artifact!.sessionId = 'wrong'),
	},
	{
		predicate: 'artifact.parent_session_id',
		mutate: (i) => (i.artifact!.parentSessionId = 'wrong'),
	},
	{ predicate: 'artifact.agent', mutate: (i) => (i.artifact!.agent = 'wrong') },
	{ predicate: 'artifact.role', mutate: (i) => (i.artifact!.role = 'wrong') },
	{
		predicate: 'artifact.source',
		mutate: (i) => (i.artifact!.source = 'dispatch_lanes'),
	},
	{
		predicate: 'artifact.workflow_lane_record',
		mutate: (i) => (i.artifact!.workflowLane = 'wrong'),
	},
	{
		predicate: 'artifact.workflow_lane_expected',
		mutate: (i) => {
			i.expected.checkWorkflowLane = false;
			i.record.workflowLane = 'wrong';
			i.artifact!.workflowLane = 'wrong';
		},
	},
	{
		predicate: 'artifact.pr_head_sha',
		mutate: (i) => (i.artifact!.prHeadSha = 'wrong'),
	},
	{
		predicate: 'artifact.git_head',
		mutate: (i) => (i.artifact!.gitHead = 'wrong'),
	},
	{
		predicate: 'artifact.revision_digest',
		mutate: (i) => (i.artifact!.revisionDigest = 'wrong'),
	},
	{
		predicate: 'record.scope',
		mutate: (i) => (i.record.workspace!.scope = 'wrong'),
	},
	{ predicate: 'artifact.scope', mutate: (i) => (i.artifact!.scope = 'wrong') },
	{
		predicate: 'artifact.digest',
		mutate: (i) => (i.artifact!.digest = 'f'.repeat(64)),
	},
	{ predicate: 'artifact.chars', mutate: (i) => (i.artifact!.chars += 1) },
	{
		predicate: 'discovery.header',
		mutate: (i) => (i.artifact!.text = 'plain prose'),
	},
	{
		predicate: 'discovery.row',
		mutate: (i) =>
			(i.artifact!.text = `${HEADER}\nC-1 | ${LANE} | INVALID | correctness | src/a.ts:1 | claim | evidence | impact | HIGH`),
	},
	{
		predicate: 'discovery.coverage',
		mutate: (i) => (i.artifact!.text = HEADER),
	},
] as const satisfies readonly MutationCase[];

const BATCH_ONLY_PREDICATES = [
	'batch.validated_at',
	'batch.expected_lane_unique',
	'record.missing',
	'record.duplicate_lane',
	'record.subagent_session_id',
	'record.duplicate_subagent_session_id',
	'record.forbidden_subagent_session_id',
	'record.created_at',
	'record.status',
] as const satisfies readonly PrReviewLaneValidationPredicate[];

type CoveredPredicate =
	| (typeof CASES)[number]['predicate']
	| (typeof BATCH_ONLY_PREDICATES)[number]
	| 'discovery.duplicate_evidence';
const ALL_PREDICATES_ARE_COVERED: [
	Exclude<PrReviewLaneValidationPredicate, CoveredPredicate>,
	Exclude<CoveredPredicate, PrReviewLaneValidationPredicate>,
] extends [never, never]
	? true
	: false = true;

describe('PR review lane-local validation predicates', () => {
	test('keeps every closed predicate covered by a focused regression case', () => {
		const covered = [
			...CASES.map(({ predicate }) => predicate),
			...BATCH_ONLY_PREDICATES,
			'discovery.duplicate_evidence' as const,
		];
		expect(ALL_PREDICATES_ARE_COVERED).toBe(true);
		expect(new Set(covered).size).toBe(covered.length);
	});

	test('accepts an exact prospective completion', () => {
		expect(validatePrReviewDiscoveryLaneCompletion(validInput())).toEqual({
			ok: true,
		});
	});

	test.each(CASES)('reports first failure $predicate', ({
		predicate,
		mutate,
	}) => {
		const input = validInput();
		mutate(input);
		const result = validatePrReviewDiscoveryLaneCompletion(input);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.failure.predicate).toBe(predicate);
	});

	test('preserves first-failure order when later predicates also fail', () => {
		const input = validInput();
		input.record.mode = 'wrong';
		input.artifact = null;
		const result = validatePrReviewDiscoveryLaneCompletion(input);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.failure.predicate).toBe('record.mode');
	});

	test('accepts prose framing and a strict terminal protocol fence', () => {
		const framed = validInput();
		framed.artifact!.text = `Summary before the contract.\n${TEXT}`;
		expect(validatePrReviewDiscoveryLaneCompletion(framed)).toEqual({
			ok: true,
		});

		const fenced = validInput();
		fenced.artifact!.text = `\`\`\`text\n${TEXT}\n\`\`\``;
		const result = validatePrReviewDiscoveryLaneCompletion(fenced);
		expect(result).toEqual({ ok: true, salvaged: [LANE] });
	});

	test('rejects duplicate evidence across a consolidated lane', () => {
		const input = validInput();
		const otherA = 'intent-architecture';
		const otherB = 'tests-falsifiability';
		input.record.ownedWorkflowLanes = [LANE, otherA, otherB];
		input.expected.ownedWorkflowLanes = [LANE, otherA, otherB];
		input.artifact!.text = [
			HEADER,
			`C-1 | ${LANE} | HIGH | correctness | src/a.ts:1 | claim | evidence | impact | HIGH`,
			`[CLEAN] | ${otherA} | exact reviewed diff scope | no finding after focused invariant review`,
			`[CLEAN] | ${otherB} | exact reviewed diff scope | no finding after focused invariant review`,
		].join('\n');
		input.result.chars = input.artifact!.text.length;
		input.artifact!.chars = input.artifact!.text.length;
		const result = validatePrReviewDiscoveryLaneCompletion(input);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.failure.predicate).toBe('discovery.duplicate_evidence');
		}
	});

	test('bounds hostile expected and actual values in formatted diagnostics', () => {
		const input = validInput();
		input.record.mode = 'x'.repeat(20_000);
		const result = validatePrReviewDiscoveryLaneCompletion(input);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		const message = formatPrReviewLaneValidationFailure(result.failure);
		expect(message.length).toBeLessThanOrEqual(1_000);
		expect(message).not.toContain('x'.repeat(1_000));
	});

	test('announces a salvaged artifact instead of accepting it silently', () => {
		// A marker-bearing row with no canonical header — the shape that used to
		// discard an entire lane's findings. It is now accepted, so the repair must
		// be observable rather than indistinguishable from well-formed output.
		const text = `[CANDIDATE] | C-1 | ${LANE} | HIGH | correctness | src/a.ts:1 | claim | evidence | impact | HIGH`;
		const input = validInput();
		input.result!.text = text;
		input.result!.chars = text.length;
		input.artifact!.text = text;
		input.artifact!.chars = text.length;
		input.artifact!.bytes = text.length;

		// Asserted on the returned value rather than a console spy: the logger is
		// mock.module'd by several sibling suites and OPENCODE_SWARM_DEBUG (which
		// gates warn()) is mutated by many more, so a spy-based assertion passes in
		// isolation and fails in a shared runner. A structural signal is both
		// testable and consumable by callers.
		const result = validatePrReviewDiscoveryLaneCompletion(input);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.salvaged).toEqual([LANE]);
	});

	test('does not mark a well-formed artifact as salvaged', () => {
		const result = validatePrReviewDiscoveryLaneCompletion(validInput());
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.salvaged).toBeUndefined();
	});
});
