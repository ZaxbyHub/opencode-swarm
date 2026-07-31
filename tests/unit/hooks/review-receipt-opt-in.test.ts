import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveAutoReviewConfig } from '../../../src/config/schema';
import {
	_internals,
	collectReviewerReceiptAfter,
} from '../../../src/hooks/review-receipt-collector';

let directory: string;
const originalResolveReviewerTaskScope = _internals.resolveReviewerTaskScope;

beforeEach(() => {
	directory = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'review-receipt-opt-in-')),
	);
});

afterEach(() => {
	_internals.resolveReviewerTaskScope = originalResolveReviewerTaskScope;
	fs.rmSync(directory, { recursive: true, force: true });
});

describe('review receipt v7 opt-in', () => {
	test('disabled mode does not resolve scope, persist, or launch validation', async () => {
		let scopeCalls = 0;
		let dispatchCalls = 0;
		_internals.resolveReviewerTaskScope = async () => {
			scopeCalls += 1;
			throw new Error('disabled mode must not resolve structured scope');
		};

		const receiptPath = await collectReviewerReceiptAfter(
			directory,
			{
				tool: 'Task',
				args: {
					subagent_type: 'reviewer',
					prompt: 'TASK: Review README.md only',
				},
				sessionID: 'v7-disabled',
			},
			{
				output: [
					'VERDICT: REJECTED',
					'RISK: HIGH',
					'ISSUES: none (see structured findings)',
					'FIXES: fix it',
					'```json',
					'{"findings":[],"verdict":"REJECTED","overall_confidence":0.9}',
					'```',
				].join('\n'),
			},
			{
				config: resolveAutoReviewConfig(
					{ validate_findings: true },
					{ packageVersion: '7.99.0' },
				),
				dispatcher: {
					async dispatch() {
						dispatchCalls += 1;
						throw new Error('disabled mode must not dispatch');
					},
				},
			},
		);

		expect(receiptPath).toBeNull();
		expect(scopeCalls).toBe(0);
		expect(dispatchCalls).toBe(0);
		expect(fs.existsSync(path.join(directory, '.swarm'))).toBe(false);
	});
});
