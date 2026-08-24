import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
	_internals as dispatchInternals,
	executeDispatchLanesAsync,
	type SessionOps,
} from '../../../src/tools/dispatch-lanes.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';
import { initializeGitRepository } from '../helpers/git-repository.js';

const originalGetSessionOps = dispatchInternals.getSessionOps;
const originalResolveRevision =
	dispatchInternals.resolvePrWorkflowRevisionDigest;
const originalResolveRevisionAsync =
	dispatchInternals.resolvePrWorkflowRevisionDigestAsync;
const originalResolveMergeBase = dispatchInternals.resolveExactMergeBase;
const originalResolveMergeBaseAsync =
	dispatchInternals.resolveExactMergeBaseAsync;

let directory = '';
let ops: SessionOps;

beforeEach(async () => {
	directory = canonicalMkdtemp('dispatch-wave-contract-');
	await initializeGitRepository(directory);
	ops = {
		create: mock(async () => ({ data: { id: 'lane-session' } })),
		prompt: mock(async () => ({ data: undefined, error: undefined })),
		promptAsync: mock(async () => ({ data: undefined, error: undefined })),
		delete: mock(async () => undefined),
	};
	dispatchInternals.getSessionOps = () => ops;
	dispatchInternals.resolvePrWorkflowRevisionDigest = () => 'revision-1';
	dispatchInternals.resolvePrWorkflowRevisionDigestAsync = async (...args) =>
		dispatchInternals.resolvePrWorkflowRevisionDigest(...args);
	dispatchInternals.resolveExactMergeBase = () => 'def456';
	dispatchInternals.resolveExactMergeBaseAsync = async (...args) =>
		dispatchInternals.resolveExactMergeBase(...args);
});

afterEach(async () => {
	dispatchInternals.getSessionOps = originalGetSessionOps;
	dispatchInternals.resolvePrWorkflowRevisionDigest = originalResolveRevision;
	dispatchInternals.resolvePrWorkflowRevisionDigestAsync =
		originalResolveRevisionAsync;
	dispatchInternals.resolveExactMergeBase = originalResolveMergeBase;
	dispatchInternals.resolveExactMergeBaseAsync = originalResolveMergeBaseAsync;
	await fs.rm(directory, { recursive: true, force: true });
});

describe('dispatch_lanes_async PR workflow wave contract', () => {
	test('rejects staged base wave fields for every non-base workflow mode before launch', async () => {
		const modes = [
			'swarm-pr-review:micro',
			'swarm-pr-review:council',
			'swarm-pr-review:reviewer',
			'swarm-pr-review:critic',
			'swarm-pr-feedback:verification',
		] as const;

		for (const [index, mode] of modes.entries()) {
			const result = await executeDispatchLanesAsync(
				{
					mode,
					pr_head_sha: 'abc123',
					base_sha: 'def456',
					base_ref: 'origin/main',
					pr_review_wave_stage: 'canary',
					pr_review_wave_attempt: 0,
					feedback_inventory:
						mode === 'swarm-pr-feedback:verification' ? ['F-1'] : undefined,
					lanes: [
						{
							id: `lane-${index}`,
							agent: 'explorer',
							prompt: `Inspect ${mode}`,
							workflow_lane: 'intent-architecture',
						},
					],
				},
				directory,
			);

			expect(result.success).toBe(false);
			expect(result.failure_class).toBe('invalid_args');
			expect(result.message).toContain(
				'pr_review_wave_stage and pr_review_wave_attempt are valid only when mode is exactly "swarm-pr-review:base"',
			);
		}

		expect(ops.create).not.toHaveBeenCalled();
		expect(ops.promptAsync).not.toHaveBeenCalled();
		expect(ops.delete).not.toHaveBeenCalled();
	});
});
