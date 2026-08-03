import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { resolveAutoReviewConfig } from '../../../src/config/schema';
import {
	buildReceiptContextForDrift,
	type RejectedReviewReceipt,
} from '../../../src/hooks/review-receipt';
import {
	_internals,
	collectReviewerReceiptFromTranscript,
} from '../../../src/hooks/review-receipt-collector';
import { createFindingValidationScheduler } from '../../../src/review/finding-validator';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

let tmpDir: string;
let cleanupTmpDir: () => void;
const originalResolveReviewerTaskScope = _internals.resolveReviewerTaskScope;
const validationScheduler = createFindingValidationScheduler();

beforeEach(() => {
	const fixture = createSafeTestDir('receipt-confidence-');
	tmpDir = fixture.dir;
	cleanupTmpDir = fixture.cleanup;
	_internals.resolveReviewerTaskScope = async () => ({
		content: 'opencode-swarm-reviewer-task-scope-v1\nconfidence-fixture\n',
		description: 'reviewer-task-files-v1',
		files: ['src/confidence.ts'],
	});
});

afterEach(() => {
	_internals.resolveReviewerTaskScope = originalResolveReviewerTaskScope;
	validationScheduler.reset();
	cleanupTmpDir();
});

const STRUCTURED_REJECTION = [
	'VERDICT: REJECTED',
	'RISK: CRITICAL',
	'ISSUES: none (see structured findings)',
	'FIXES: repair confirmed high-risk findings',
	'```json',
	JSON.stringify({
		findings: [
			{
				title: 'Below threshold critical',
				body: 'A low-confidence candidate that must remain durable as info.',
				severity: 'critical',
				confidence: 0.69,
				file: 'src/confidence.ts',
				line_start: 1,
				line_end: 1,
			},
			{
				title: 'At threshold high',
				body: 'Equality with min_confidence retains the declared severity.',
				severity: 'high',
				confidence: 0.7,
				file: 'src/confidence.ts',
				line_start: 2,
				line_end: 2,
			},
			{
				title: 'Above threshold critical',
				body: 'A candidate above min_confidence retains critical severity.',
				severity: 'critical',
				confidence: 0.71,
				file: 'src/confidence.ts',
				line_start: 3,
				line_end: 3,
			},
		],
		verdict: 'REJECTED',
		overall_confidence: 0.8,
	}),
	'```',
].join('\n');

describe('Stage-B confidence policy — regression: low-confidence findings stayed blocking (F3)', () => {
	test('persists effective severity and validates/counts only threshold-eligible findings', async () => {
		let dispatchedPrompt = '';
		const receiptPath = await collectReviewerReceiptFromTranscript(
			tmpDir,
			{
				targetAgent: 'reviewer',
				transcript: STRUCTURED_REJECTION,
				sessionID: 'confidence-session',
			},
			{
				config: resolveAutoReviewConfig({
					enabled: true,
					min_confidence: 0.7,
					validate_findings: true,
				}),
				validationScheduler,
				dispatcher: {
					async dispatch(request) {
						dispatchedPrompt = request.prompt;
						const findingIds = [
							...request.prompt.matchAll(/"finding_id":\s*"([a-f0-9]{64})"/g),
						].map((match) => match[1]);
						const text = JSON.stringify({
							validations: findingIds.map((findingId) => ({
								finding_id: findingId,
								disposition: 'CONFIRMED',
								confidence: 0.95,
								evidence: 'Direct evidence confirms this eligible finding.',
							})),
						});
						return {
							status: 'completed',
							text,
							agentName: request.agentName,
							durationMs: 1,
							promptBytes: request.prompt.length,
							responseBytes: text.length,
						};
					},
				},
			},
		);

		expect(receiptPath).not.toBeNull();
		for (let attempt = 0; attempt < 40; attempt++) {
			const current = JSON.parse(
				fs.readFileSync(receiptPath as string, 'utf-8'),
			) as RejectedReviewReceipt;
			if (current.finding_validations?.length === 2) break;
			await Bun.sleep(5);
		}
		const receipt = JSON.parse(
			fs.readFileSync(receiptPath as string, 'utf-8'),
		) as RejectedReviewReceipt;
		const byTitle = new Map(
			receipt.blocking_findings.map((finding) => [finding.title, finding]),
		);

		// Previous code persisted no effective_severity at all, so the 0.69
		// CRITICAL finding remained blocking even though the engine uses `<`.
		expect(byTitle.get('Below threshold critical')?.effective_severity).toBe(
			'info',
		);
		expect(byTitle.get('At threshold high')?.effective_severity).toBe('high');
		expect(byTitle.get('Above threshold critical')?.effective_severity).toBe(
			'critical',
		);

		const belowId = byTitle.get('Below threshold critical')?.finding_id;
		const equalId = byTitle.get('At threshold high')?.finding_id;
		const aboveId = byTitle.get('Above threshold critical')?.finding_id;
		expect(dispatchedPrompt).not.toContain(belowId as string);
		expect(dispatchedPrompt).toContain(equalId as string);
		expect(dispatchedPrompt).toContain(aboveId as string);
		expect(
			receipt.finding_validations?.map((item) => item.finding_id).sort(),
		).toEqual([equalId, aboveId].sort());

		const context = buildReceiptContextForDrift([receipt]);
		expect(context).toContain('2 blocking finding(s)');
		expect(context).toContain('1 non-blocking finding(s) retained');
		expect(context).not.toContain('3 blocking finding(s)');
	});
});
