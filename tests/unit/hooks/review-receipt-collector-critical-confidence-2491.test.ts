import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveAutoReviewConfig } from '../../../src/config/schema';
import {
	_internals,
	collectReviewerReceiptAfter,
} from '../../../src/hooks/review-receipt-collector';
import {
	createFindingValidationScheduler,
	type FindingValidationScheduler,
} from '../../../src/review/finding-validator';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const LOW_CONFIDENCE_CRITICAL_OUTPUT = [
	'VERDICT: REJECTED',
	'RISK: CRITICAL',
	'ISSUES: none (see structured findings)',
	'FIXES: preserve the critical finding for independent validation',
	'```json',
	'{"findings":[{"title":"Critical invariant is broken","body":"The critical invariant is not enforced.","severity":"critical","confidence":0.2,"file":"src/critical.ts","line_start":10,"line_end":10}],"verdict":"REJECTED","overall_confidence":0.2}',
	'```',
].join('\n');

let tmpDir: string;
let validationScheduler: FindingValidationScheduler;
const originalDelegationBegin = _internals.delegationBegin;
const originalDelegationEnd = _internals.delegationEnd;
const originalResolveReviewerTaskScope = _internals.resolveReviewerTaskScope;

beforeEach(() => {
	tmpDir = canonicalMkdtemp('critical-confidence-2491-');
	validationScheduler = createFindingValidationScheduler();
	_internals.delegationBegin = () => {};
	_internals.delegationEnd = () => {};
	_internals.resolveReviewerTaskScope = async () => ({
		content: 'opencode-swarm-reviewer-task-scope-v1\ncritical-confidence\n',
		description: 'critical-confidence-2491',
		files: ['src/critical.ts'],
	});
});

afterEach(() => {
	validationScheduler.reset();
	_internals.delegationBegin = originalDelegationBegin;
	_internals.delegationEnd = originalDelegationEnd;
	_internals.resolveReviewerTaskScope = originalResolveReviewerTaskScope;
	try {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	} catch {}
});

describe('review receipt critical confidence policy — issue #2491', () => {
	test('low-confidence CRITICAL remains an independent validation candidate', async () => {
		let dispatched = false;

		const receiptPath = await collectReviewerReceiptAfter(
			tmpDir,
			{
				tool: 'Task',
				args: {
					subagent_type: 'reviewer',
					prompt: 'TASK: validate the critical finding',
				},
				sessionID: 'critical-confidence-session',
			},
			{ output: LOW_CONFIDENCE_CRITICAL_OUTPUT },
			{
				config: resolveAutoReviewConfig({
					enabled: true,
					validate_findings: true,
				}),
				dispatcher: {
					async dispatch(request) {
						dispatched = true;
						const findingId = request.prompt.match(
							/"finding_id": "([a-f0-9]{64})"/,
						)?.[1];
						if (!findingId) throw new Error('missing critical finding ID');
						const text = JSON.stringify({
							validations: [
								{
									finding_id: findingId,
									disposition: 'CONFIRMED',
									confidence: 0.99,
									evidence: 'independent critical-finding check',
								},
							],
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
				injectAdvisory: () => {},
				validationScheduler,
			},
		);

		for (let attempt = 0; attempt < 20 && !dispatched; attempt++) {
			await Bun.sleep(5);
		}
		expect(receiptPath).not.toBeNull();
		expect(dispatched).toBe(true);
		// Previous coverage stopped after dispatch and reset the scheduler while
		// async receipt-validation persistence was still in flight (F-007). Wait for
		// the owning scheduler to drain before teardown can reset its bookkeeping.
		for (
			let attempt = 0;
			attempt < 100 && validationScheduler.pendingCount > 0;
			attempt++
		) {
			await Bun.sleep(5);
		}
		expect(validationScheduler.pendingCount).toBe(0);
		const persistedReceipt = JSON.parse(
			await fs.promises.readFile(receiptPath as string, 'utf8'),
		) as { finding_validations?: unknown[] };
		expect(persistedReceipt.finding_validations).toEqual([
			{
				finding_id: expect.any(String),
				disposition: 'CONFIRMED',
				confidence: 0.99,
				evidence: 'independent critical-finding check',
			},
		]);
	});
});
