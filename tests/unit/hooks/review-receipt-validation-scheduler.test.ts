import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveAutoReviewConfig } from '../../../src/config/schema';
import type { RejectedReviewReceipt } from '../../../src/hooks/review-receipt';
import {
	_internals,
	collectReviewerReceiptAfter,
} from '../../../src/hooks/review-receipt-collector';

const REJECTED_OUTPUT = [
	'VERDICT: REJECTED',
	'RISK: HIGH',
	'ISSUES: none (see structured findings)',
	'FIXES: correct the loop bound',
	'```json',
	'{"findings":[{"title":"Final record is dropped","body":"The loop exits before processing the final record.","severity":"high","confidence":0.93,"file":"src/utils/parse.ts","line_start":42,"line_end":43}],"verdict":"REJECTED","overall_confidence":0.91}',
	'```',
].join('\n');

const originalResolveReviewerTaskScope = _internals.resolveReviewerTaskScope;
let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-scheduler-')),
	);
	_internals.resolveReviewerTaskScope = async () => ({
		content: 'opencode-swarm-reviewer-task-scope-v1\nscheduler-fixture\n',
		description: 'reviewer-task-files-v1',
		files: ['src/fixture.ts'],
	});
});

afterEach(() => {
	_internals.resolveReviewerTaskScope = originalResolveReviewerTaskScope;
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('review receipt validation scheduler ownership', () => {
	test('fails closed as UNVERIFIED instead of creating an unbounded per-call scheduler', async () => {
		let dispatchCount = 0;
		const advisories: string[] = [];
		const receiptPath = await collectReviewerReceiptAfter(
			tmpDir,
			{
				tool: 'Task',
				args: {
					subagent_type: 'reviewer',
					prompt: 'TASK: Review structured output',
				},
				sessionID: 'scheduler-required',
			},
			{ output: REJECTED_OUTPUT },
			{
				config: resolveAutoReviewConfig({
					enabled: true,
					validate_findings: true,
				}),
				dispatcher: {
					async dispatch() {
						dispatchCount += 1;
						throw new Error('must not dispatch without an instance scheduler');
					},
				},
				injectAdvisory: (_sessionID, message) => advisories.push(message),
			},
		);

		expect(receiptPath).not.toBeNull();
		expect(dispatchCount).toBe(0);
		const receipt = JSON.parse(
			fs.readFileSync(receiptPath as string, 'utf8'),
		) as RejectedReviewReceipt;
		expect(receipt.finding_validations).toHaveLength(1);
		expect(receipt.finding_validations?.[0]).toMatchObject({
			disposition: 'UNVERIFIED',
			confidence: 0,
		});
		expect(receipt.finding_validations?.[0].evidence).toContain(
			'owning plugin instance did not provide its bounded validation scheduler',
		);
		expect(advisories).toHaveLength(1);
		expect(advisories[0]).toContain('recorded as UNVERIFIED');
	});
});
