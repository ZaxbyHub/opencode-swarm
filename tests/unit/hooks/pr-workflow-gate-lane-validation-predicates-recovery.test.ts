import { describe, expect, test } from 'bun:test';
import type { LaneOutputArtifact } from '../../../src/background/lane-output-store.js';
import type {
	BackgroundDelegationRecord,
	BackgroundDelegationResult,
} from '../../../src/background/pending-delegations.js';
import {
	formatPrReviewLaneValidationFailure,
	type PrReviewDiscoveryLaneValidationInput,
	validatePrReviewDiscoveryLaneCompletion,
} from '../../../src/hooks/pr-workflow-gate.js';

const DIGEST = 'a'.repeat(64);
const REF = `L1:${'b'.repeat(64)}:${'c'.repeat(64)}:${DIGEST}`;
const LANE = 'correctness-state';
const HEADER =
	'[CANDIDATE] | candidate_id | lane | severity | category | file:line | claim | evidence_summary | impact_context | confidence | risk_impact | risk_tags';
const TEXT = `${HEADER}\nC-1 | ${LANE} | HIGH | correctness | src/a.ts:1 | claim | evidence | impact | HIGH | ORDINARY | `;

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

describe('PR review lane validation recovery diagnostics', () => {
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
		const text = `[CANDIDATE] | C-1 | ${LANE} | HIGH | correctness | src/a.ts:1 | claim | evidence | impact | HIGH | ORDINARY | `;
		const input = validInput();
		input.result!.text = text;
		input.result!.chars = text.length;
		input.artifact!.text = text;
		input.artifact!.chars = text.length;
		input.artifact!.bytes = text.length;

		const result = validatePrReviewDiscoveryLaneCompletion(input);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.salvaged).toEqual([LANE]);
		expect(result.recoveries).toEqual([
			{
				workflowLane: LANE,
				kind: 'parser-normalization',
				reason: 'structural repairs applied: synthesized-header',
			},
		]);
	});

	test('does not mark a well-formed artifact as salvaged', () => {
		const result = validatePrReviewDiscoveryLaneCompletion(validInput());
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.salvaged).toBeUndefined();
	});
});
