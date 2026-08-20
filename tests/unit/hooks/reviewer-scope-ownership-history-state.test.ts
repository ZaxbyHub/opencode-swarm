import { beforeEach, describe, expect, test } from 'bun:test';
import * as os from 'node:os';
import {
	claimReviewerScopeGeneration,
	getReviewerScopeOwnershipHistory,
	MAX_REVIEWER_SCOPE_OWNERSHIP_HISTORY,
	markReviewerScopeGenerationReady,
	recordReviewerScopeGenerationFile,
	recordReviewerScopeGenerationFileFingerprint,
	resetSwarmState,
	startAgentSession,
	startReviewerScopeGeneration,
	takeReviewerScopeGeneration,
} from '../../../src/state';

function consumeOwner(index: number): void {
	const taskId = `task-${index}`;
	const coderCallID = `coder-${index}`;
	const reviewerCallID = `reviewer-${index}`;
	const file = `src/file-${index}.ts`;
	expect(
		startReviewerScopeGeneration({
			parentSessionID: 'parent',
			taskId,
			coderCallID,
			background: true,
			declaredFiles: [file],
			captureDirectory: os.tmpdir(),
			workspaceIdentity: 'ws:/workspace',
			createdAt: 1_000 + index * 10,
		}),
	).not.toBeNull();
	expect(
		recordReviewerScopeGenerationFile({
			parentSessionID: 'parent',
			taskId,
			coderCallID,
			file,
			now: 1_001 + index * 10,
		}),
	).toBe(true);
	expect(
		recordReviewerScopeGenerationFileFingerprint({
			parentSessionID: 'parent',
			taskId,
			coderCallID,
			fingerprint: { file, kind: 'deleted' },
		}),
	).toBe(true);
	expect(
		markReviewerScopeGenerationReady({
			parentSessionID: 'parent',
			taskId,
			coderCallID,
			readyAt: 1_002 + index * 10,
		}),
	).toBe(true);
	expect(
		claimReviewerScopeGeneration({
			parentSessionID: 'parent',
			taskId,
			reviewerCallID,
			now: 1_003 + index * 10,
		}),
	).not.toBeNull();
	expect(
		takeReviewerScopeGeneration({
			parentSessionID: 'parent',
			taskId,
			reviewerCallID,
			now: 1_004 + index * 10,
		}),
	).not.toBeNull();
}

beforeEach(() => {
	resetSwarmState();
	startAgentSession('parent', 'architect', os.tmpdir());
});

describe('reviewer scope ownership history', () => {
	test('evicts deterministically, returns immutable clones, and resets', () => {
		for (
			let index = 0;
			index < MAX_REVIEWER_SCOPE_OWNERSHIP_HISTORY + 1;
			index++
		) {
			consumeOwner(index);
		}

		const history = getReviewerScopeOwnershipHistory({
			parentSessionID: 'parent',
		});
		expect(history).toHaveLength(MAX_REVIEWER_SCOPE_OWNERSHIP_HISTORY);
		expect(history[0].coderCallID).toBe('coder-1');
		expect(history.at(-1)?.coderCallID).toBe(
			`coder-${MAX_REVIEWER_SCOPE_OWNERSHIP_HISTORY}`,
		);
		history[0].declaredFiles[0] = 'mutated';
		history[0].modifiedFileFingerprints[0].file = 'mutated';
		expect(
			getReviewerScopeOwnershipHistory({ parentSessionID: 'parent' })[0],
		).toMatchObject({
			declaredFiles: ['src/file-1.ts'],
			modifiedFileFingerprints: [{ file: 'src/file-1.ts' }],
		});

		resetSwarmState();
		expect(
			getReviewerScopeOwnershipHistory({ parentSessionID: 'parent' }),
		).toEqual([]);
	});
});
