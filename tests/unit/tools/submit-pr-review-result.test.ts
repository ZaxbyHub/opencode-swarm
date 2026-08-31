import { describe, expect, test } from 'bun:test';
import * as os from 'node:os';
import { executeSubmitPrReviewResult } from '../../../src/tools/submit-pr-review-result.js';

function validArgs(): Record<string, unknown> {
	return {
		schemaVersion: 1,
		batchId: 'batch-2384',
		laneId: 'lane-2384',
		revisionDigest: 'd'.repeat(64),
		result: {
			schemaVersion: 1,
			outcome: 'CLEAN',
			creditedLanes: ['intent-architecture'],
			findings: [],
			cleanAttestations: [
				{
					workflowLane: 'intent-architecture',
					coverageScope: 'Reviewed the complete changed architecture surface.',
					evidence:
						'No reachable architecture defect remains in the bound diff.',
				},
			],
			unresolved: [],
		},
	};
}

function parseResult(value: string): { success: boolean; message?: string } {
	return JSON.parse(value) as { success: boolean; message?: string };
}

describe('submit_pr_review_result public validation boundary (#2384 FB-004)', () => {
	test('rejects a missing authenticated child session', async () => {
		const result = parseResult(
			await executeSubmitPrReviewResult(validArgs(), os.tmpdir()),
		);
		expect(result.success).toBeFalse();
		expect(result.message).toContain('authenticated child session');
	});

	test('rejects malformed top-level arguments before durable submission', async () => {
		const args = { ...validArgs(), unexpected: true };
		const result = parseResult(
			await executeSubmitPrReviewResult(args, os.tmpdir(), {
				sessionID: 'child-2384',
			}),
		);
		expect(result.success).toBeFalse();
		expect(result.message).toContain('Invalid PR-review result');
	});

	test('rejects invalid lane dimensions before durable submission', async () => {
		const args = validArgs();
		args.result = {
			...(args.result as Record<string, unknown>),
			creditedLanes: ['security-trust'],
		};
		const result = parseResult(
			await executeSubmitPrReviewResult(args, os.tmpdir(), {
				sessionID: 'child-2384',
			}),
		);
		expect(result.success).toBeFalse();
		expect(result.message).toContain('Invalid PR-review result');
	});

	test('rejects findings with missing or unknown risk metadata', async () => {
		for (const finding of [
			{
				id: 'finding-missing-risk',
				workflowLane: 'intent-architecture',
				severity: 'HIGH',
				riskTags: ['SECURITY'],
				title: 'Missing risk impact',
				body: 'The finding omits required risk impact metadata.',
				evidence: 'The public handler must reject this malformed finding.',
				location: { kind: 'local', file: 'src/review.ts', line: 1 },
			},
			{
				id: 'finding-unknown-risk',
				workflowLane: 'intent-architecture',
				severity: 'HIGH',
				riskImpact: 'UNKNOWN_IMPACT',
				riskTags: ['NOT_A_RISK_TAG'],
				title: 'Unknown risk metadata',
				body: 'The finding uses risk values outside the closed vocabulary.',
				evidence: 'The public handler must reject this malformed finding.',
				location: { kind: 'local', file: 'src/review.ts', line: 1 },
			},
		]) {
			const args = validArgs();
			args.result = {
				schemaVersion: 1,
				outcome: 'FINDINGS',
				creditedLanes: ['intent-architecture'],
				findings: [finding],
				cleanAttestations: [],
				unresolved: [],
			};
			const result = parseResult(
				await executeSubmitPrReviewResult(args, os.tmpdir(), {
					sessionID: 'child-2384',
				}),
			);
			expect(result.success).toBeFalse();
			expect(result.message).toContain('Invalid PR-review result');
		}
	});
});
