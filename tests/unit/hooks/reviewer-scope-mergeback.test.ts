import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	captureReviewerScopeFileFingerprint,
	reviewerScopeCaptureToFingerprint,
} from '../../../src/hooks/reviewer-scope-file-fingerprint';
import { verifyReviewerScopeGenerationMergeBack } from '../../../src/hooks/reviewer-scope-mergeback';
import { canonicalWorkspaceIdentity } from '../../../src/scope/scope-binding';
import {
	getReviewerScopeGenerationForCoderCall,
	markReviewerScopeGenerationMergebackPending,
	recordReviewerScopeGenerationFile,
	recordReviewerScopeGenerationFileFingerprint,
	resetSwarmState,
	settleReviewerScopeMergeback,
	startAgentSession,
	startReviewerScopeGeneration,
} from '../../../src/state';

let primary = '';
let lane = '';

function recordLaneFingerprint(
	taskId: string,
	coderCallID: string,
	file: string,
) {
	const captured = captureReviewerScopeFileFingerprint(lane, file);
	expect(captured.kind).toBe('captured_file');
	expect(
		recordReviewerScopeGenerationFileFingerprint({
			parentSessionID: 'parent',
			taskId,
			coderCallID,
			fingerprint: reviewerScopeCaptureToFingerprint(captured)!,
		}),
	).toBe(true);
}

beforeEach(() => {
	resetSwarmState();
	primary = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'reviewer-scope-mergeback-')),
	);
	lane = path.join(primary, '.swarm-worktrees', 'sess', 'lane-1');
	fs.mkdirSync(path.join(primary, 'src'), { recursive: true });
	fs.mkdirSync(path.join(lane, 'src'), { recursive: true });
	startAgentSession('parent', 'architect', primary);
});

afterEach(() => {
	resetSwarmState();
	fs.rmSync(primary, { recursive: true, force: true });
});

function startLaneGeneration(
	taskId: string,
	coderCallID: string,
	files: string[],
) {
	expect(
		startReviewerScopeGeneration({
			parentSessionID: 'parent',
			taskId,
			coderCallID,
			declaredFiles: files,
			captureDirectory: lane,
			workspaceIdentity: canonicalWorkspaceIdentity(lane)!,
		}),
	).not.toBeNull();
	for (const file of files) {
		expect(
			recordReviewerScopeGenerationFile({
				parentSessionID: 'parent',
				taskId,
				coderCallID,
				file,
			}),
		).toBe(true);
		recordLaneFingerprint(taskId, coderCallID, file);
	}
}

function markPending(taskId: string, coderCallID: string): void {
	expect(
		markReviewerScopeGenerationMergebackPending({
			parentSessionID: 'parent',
			taskId,
			coderCallID,
		}),
	).toBe(true);
}

describe('reviewer scope merge-back verification (issue #2100 contract D)', () => {
	test('exact primary match (including deletions) publishes ready with verified provenance', () => {
		fs.writeFileSync(path.join(lane, 'src/a.ts'), 'lane bytes\n');
		fs.writeFileSync(path.join(lane, 'src/old.ts'), 'stale\n');
		startLaneGeneration('1.1', 'coder-clean', ['src/a.ts']);
		// The coder deleted old.ts after touching it: capture records deleted.
		fs.rmSync(path.join(lane, 'src/old.ts'));
		expect(
			recordReviewerScopeGenerationFile({
				parentSessionID: 'parent',
				taskId: '1.1',
				coderCallID: 'coder-clean',
				file: 'src/old.ts',
			}),
		).toBe(true);
		const deletedCapture = captureReviewerScopeFileFingerprint(
			lane,
			'src/old.ts',
		);
		expect(deletedCapture.kind).toBe('captured_deleted');
		expect(
			recordReviewerScopeGenerationFileFingerprint({
				parentSessionID: 'parent',
				taskId: '1.1',
				coderCallID: 'coder-clean',
				fingerprint: reviewerScopeCaptureToFingerprint(deletedCapture)!,
			}),
		).toBe(true);
		markPending('1.1', 'coder-clean');
		// Primary mirrors the lane after merge-back: a.ts updated, old.ts absent.
		fs.writeFileSync(path.join(primary, 'src/a.ts'), 'lane bytes\n');
		const generation = getReviewerScopeGenerationForCoderCall({
			parentSessionID: 'parent',
			coderCallID: 'coder-clean',
		});
		expect(generation?.modifiedFileFingerprints).toHaveLength(2);

		verifyReviewerScopeGenerationMergeBack({
			parentSessionID: 'parent',
			taskId: '1.1',
			coderCallID: 'coder-clean',
			primaryDirectory: primary,
		});
		const settled = getReviewerScopeGenerationForCoderCall({
			parentSessionID: 'parent',
			coderCallID: 'coder-clean',
		});
		expect(settled?.status).toBe('ready');
		expect(settled?.mergeback).toMatchObject({
			verifiedAt: expect.any(Number),
			primaryWorkspaceIdentity: canonicalWorkspaceIdentity(primary),
		});
	});

	test('a primary byte mismatch retains the generation as mergeback_mismatch', () => {
		fs.writeFileSync(path.join(lane, 'src/a.ts'), 'lane bytes\n');
		startLaneGeneration('1.2', 'coder-conflict', ['src/a.ts']);
		fs.writeFileSync(path.join(primary, 'src/a.ts'), 'conflicting bytes\n');

		verifyReviewerScopeGenerationMergeBack({
			parentSessionID: 'parent',
			taskId: '1.2',
			coderCallID: 'coder-conflict',
			primaryDirectory: primary,
		});
		const mismatched = getReviewerScopeGenerationForCoderCall({
			parentSessionID: 'parent',
			coderCallID: 'coder-conflict',
		});
		expect(mismatched?.status).toBe('mergeback_mismatch');
		expect(mismatched?.mergeback).toMatchObject({
			failedAt: expect.any(Number),
			reason: expect.stringContaining('differ'),
		});
	});

	test('verification of a collecting generation moves it through pending first', () => {
		fs.writeFileSync(path.join(lane, 'src/a.ts'), 'lane bytes\n');
		expect(
			startReviewerScopeGeneration({
				parentSessionID: 'parent',
				taskId: '1.3',
				coderCallID: 'coder-race',
				declaredFiles: ['src/a.ts'],
				captureDirectory: lane,
				workspaceIdentity: canonicalWorkspaceIdentity(lane)!,
			}),
		).not.toBeNull();
		expect(
			recordReviewerScopeGenerationFile({
				parentSessionID: 'parent',
				taskId: '1.3',
				coderCallID: 'coder-race',
				file: 'src/a.ts',
			}),
		).toBe(true);
		recordLaneFingerprint('1.3', 'coder-race', 'src/a.ts');
		fs.writeFileSync(path.join(primary, 'src/a.ts'), 'lane bytes\n');

		verifyReviewerScopeGenerationMergeBack({
			parentSessionID: 'parent',
			taskId: '1.3',
			coderCallID: 'coder-race',
			primaryDirectory: primary,
		});
		expect(
			getReviewerScopeGenerationForCoderCall({
				parentSessionID: 'parent',
				coderCallID: 'coder-race',
			})?.status,
		).toBe('ready');
	});

	test('missing stored fingerprints settle as typed mismatch, never a discard', () => {
		fs.writeFileSync(path.join(lane, 'src/a.ts'), 'lane bytes\n');
		expect(
			startReviewerScopeGeneration({
				parentSessionID: 'parent',
				taskId: '1.4',
				coderCallID: 'coder-incomplete',
				declaredFiles: ['src/a.ts'],
				captureDirectory: lane,
				workspaceIdentity: canonicalWorkspaceIdentity(lane)!,
			}),
		).not.toBeNull();
		expect(
			recordReviewerScopeGenerationFile({
				parentSessionID: 'parent',
				taskId: '1.4',
				coderCallID: 'coder-incomplete',
				file: 'src/a.ts',
			}),
		).toBe(true);
		// No fingerprint recorded.
		markReviewerScopeGenerationMergebackPending({
			parentSessionID: 'parent',
			taskId: '1.4',
			coderCallID: 'coder-incomplete',
		});

		verifyReviewerScopeGenerationMergeBack({
			parentSessionID: 'parent',
			taskId: '1.4',
			coderCallID: 'coder-incomplete',
			primaryDirectory: primary,
		});
		const retained = getReviewerScopeGenerationForCoderCall({
			parentSessionID: 'parent',
			coderCallID: 'coder-incomplete',
		});
		expect(retained).not.toBeNull();
		expect(retained?.status).toBe('mergeback_mismatch');
		expect(retained?.mergeback).toMatchObject({
			reason: expect.stringContaining('incomplete fingerprints'),
		});
	});

	test('settleReviewerScopeMergeback is a pure transition guard', () => {
		expect(
			settleReviewerScopeMergeback({
				parentSessionID: 'parent',
				taskId: '9.9',
				coderCallID: 'missing',
				outcome: { verified: true, primaryWorkspaceIdentity: 'ws:x' },
			}),
		).toBe(false);
	});
});
