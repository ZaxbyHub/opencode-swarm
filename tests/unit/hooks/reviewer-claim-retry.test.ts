import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveAutoReviewConfig } from '../../../src/config/schema';
import {
	_internals,
	collectReviewerReceiptFromTranscript,
} from '../../../src/hooks/review-receipt-collector';
import {
	claimReviewerScopeGeneration,
	getReviewerScopeGenerationForCoderCall,
	markReviewerScopeGenerationReady,
	recordReviewerScopeGenerationFile,
	resetSwarmState,
	startAgentSession,
	startReviewerScopeGeneration,
} from '../../../src/state';

const realResolveReviewerTaskScope = _internals.resolveReviewerTaskScope;
const realBuildReviewerTaskScope = _internals.buildReviewerTaskScope;
const realPersistReviewReceipt = _internals.persistReviewReceipt;
let directory = '';

beforeEach(() => {
	resetSwarmState();
	directory = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'reviewer-claim-retry-')),
	);
	startAgentSession('parent', 'architect', directory);
});

afterEach(() => {
	_internals.resolveReviewerTaskScope = realResolveReviewerTaskScope;
	_internals.buildReviewerTaskScope = realBuildReviewerTaskScope;
	_internals.persistReviewReceipt = realPersistReviewReceipt;
	resetSwarmState();
	fs.rmSync(directory, { recursive: true, force: true });
});

describe('reviewer claim retry lifecycle', () => {
	test('retains the exact claim through scope-build and persistence failures', async () => {
		const generation = startReviewerScopeGeneration({
			parentSessionID: 'parent',
			taskId: '1.1',
			coderCallID: 'coder-retry',
			declaredFiles: ['src/a.ts'],
		});
		expect(generation).not.toBeNull();
		expect(
			recordReviewerScopeGenerationFile({
				parentSessionID: 'parent',
				taskId: '1.1',
				coderCallID: 'coder-retry',
				file: 'src/a.ts',
			}),
		).toBe(true);
		expect(
			markReviewerScopeGenerationReady({
				parentSessionID: 'parent',
				taskId: '1.1',
				coderCallID: 'coder-retry',
			}),
		).toBe(true);
		expect(
			claimReviewerScopeGeneration({
				parentSessionID: 'parent',
				taskId: '1.1',
				reviewerCallID: 'reviewer-retry',
			}),
		).not.toBeNull();
		const scope = {
			content: 'immutable scope\n',
			description: 'reviewer-task-files-v1',
			files: ['src/a.ts'],
			headSha: 'a'.repeat(40),
			taskId: '1.1',
			coderCallID: 'coder-retry',
			generation: generation!.generation,
			sessionIncarnation: generation!.sessionIncarnation,
		};
		let resolveAttempts = 0;
		_internals.resolveReviewerTaskScope = async () => {
			resolveAttempts += 1;
			return resolveAttempts === 1 ? null : scope;
		};
		_internals.buildReviewerTaskScope = async () => scope;
		let persistAttempts = 0;
		_internals.persistReviewReceipt = async (...args) => {
			persistAttempts += 1;
			if (persistAttempts === 1)
				throw new Error('simulated persistence failure');
			return realPersistReviewReceipt(...args);
		};
		const input = {
			targetAgent: 'reviewer',
			transcript: 'VERDICT: APPROVED\nRISK: LOW\nISSUES: none\nFIXES: none',
			sessionID: 'parent',
			taskId: '1.1',
			reviewerCallID: 'reviewer-retry',
			consumeHandoff: true,
		};
		const options = {
			config: resolveAutoReviewConfig({ enabled: true }),
		};

		expect(
			await collectReviewerReceiptFromTranscript(directory, input, options),
		).toBeNull();
		expect(
			getReviewerScopeGenerationForCoderCall({
				parentSessionID: 'parent',
				coderCallID: 'coder-retry',
			})?.status,
		).toBe('claimed');
		expect(
			await collectReviewerReceiptFromTranscript(directory, input, options),
		).toBeNull();
		expect(
			getReviewerScopeGenerationForCoderCall({
				parentSessionID: 'parent',
				coderCallID: 'coder-retry',
			})?.status,
		).toBe('claimed');

		expect(
			await collectReviewerReceiptFromTranscript(directory, input, options),
		).not.toBeNull();
		expect(
			getReviewerScopeGenerationForCoderCall({
				parentSessionID: 'parent',
				coderCallID: 'coder-retry',
			}),
		).toBeNull();
	});
});
