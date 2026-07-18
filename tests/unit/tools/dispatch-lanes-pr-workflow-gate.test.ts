import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, realpathSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	activatePrWorkflow,
	_test_exports as gateInternals,
	PR_REVIEW_BASE_DIMENSION_IDS,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	dispatch_lanes_async,
	_internals as dispatchInternals,
	executeDispatchLanesAsync,
} from '../../../src/tools/dispatch-lanes.js';

let directory = '';
const originalGetSessionOps = dispatchInternals.getSessionOps;
const originalResolveCurrentGitHead = gateInternals.resolveCurrentGitHead;
const originalResolveIsWorkingTreeClean =
	gateInternals.resolveIsWorkingTreeClean;
const originalResolveRevision =
	dispatchInternals.resolvePrWorkflowRevisionDigest;
const originalResolveMergeBase = dispatchInternals.resolveExactMergeBase;

function lane(id: string, workflowLane?: string, feedbackItemIds?: string[]) {
	return {
		id,
		agent: 'explorer',
		prompt: `Inspect ${id}`,
		...(workflowLane ? { workflow_lane: workflowLane } : {}),
		...(feedbackItemIds ? { feedback_item_ids: feedbackItemIds } : {}),
	};
}

beforeEach(() => {
	directory = realpathSync(
		mkdtempSync(path.join(os.tmpdir(), 'dispatch-pr-gate-')),
	);
	gateInternals.resetTrackedStateCache();
	gateInternals.resolveCurrentGitHead = () => 'abc123';
	gateInternals.resolveIsWorkingTreeClean = () => true;
	dispatchInternals.resolvePrWorkflowRevisionDigest = () => 'revision-1';
	dispatchInternals.resolveExactMergeBase = () => 'def456';
	dispatchInternals.getSessionOps = () => ({
		create: mock(async () => ({ data: { id: 'lane-session' } })),
		promptAsync: mock(async () => ({ data: undefined, error: undefined })),
		delete: mock(async () => undefined),
	});
});

afterEach(async () => {
	gateInternals.resetTrackedStateCache();
	gateInternals.resolveCurrentGitHead = originalResolveCurrentGitHead;
	gateInternals.resolveIsWorkingTreeClean = originalResolveIsWorkingTreeClean;
	dispatchInternals.resolvePrWorkflowRevisionDigest = originalResolveRevision;
	dispatchInternals.resolveExactMergeBase = originalResolveMergeBase;
	dispatchInternals.getSessionOps = originalGetSessionOps;
	await fs.rm(directory, { recursive: true, force: true });
});

describe('dispatch_lanes PR workflow enforcement', () => {
	test('exposes mandatory review and feedback ledgers in the real async tool schema', () => {
		expect(dispatch_lanes_async.args.trigger_evaluation).toBeDefined();
		expect(dispatch_lanes_async.args.feedback_inventory).toBeDefined();
		expect(dispatch_lanes_async.args.base_sha).toBeDefined();
		expect(dispatch_lanes_async.args.base_ref).toBeDefined();
	});

	test('supports a read-only test_engineer validation lane', async () => {
		const result = await executeDispatchLanesAsync(
			{
				lanes: [
					{
						id: 'test-validation',
						agent: 'test_engineer',
						prompt:
							'Run independent falsification probes without editing files',
					},
				],
			},
			directory,
			{ sessionID: 'ordinary-session' },
		);
		expect(result.success).toBe(true);
		expect(result.pending).toBe(1);
	});

	test('blocks a two-of-six PR review base wave and names the six obligations', async () => {
		const result = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:base',
				pr_head_sha: 'abc123',
				base_sha: 'def456',
				base_ref: 'origin/main',
				max_concurrent: 6,
				lanes: [
					lane('lane-a', 'intent-architecture'),
					lane('lane-b', 'correctness-state'),
				],
			},
			directory,
			{ sessionID: 'review-session' },
		);

		expect(result.success).toBe(false);
		expect(result.message).toContain('exactly six lanes');
	});

	test('binds the first exact merge base and rejects later scope drift', async () => {
		let sessionIndex = 0;
		dispatchInternals.getSessionOps = () => ({
			create: mock(async () => ({
				data: { id: `base-lane-session-${sessionIndex++}` },
			})),
			promptAsync: mock(async () => ({ data: undefined, error: undefined })),
			delete: mock(async () => undefined),
		});
		const initial = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:base',
				pr_head_sha: 'abc123',
				base_sha: 'def456',
				base_ref: 'origin/main',
				max_concurrent: 6,
				lanes: PR_REVIEW_BASE_DIMENSION_IDS.map((workflowLane) =>
					lane(`base-${workflowLane}`, workflowLane),
				),
			},
			directory,
			{ sessionID: 'base-binding-session' },
		);
		expect(initial.success).toBe(true);

		dispatchInternals.resolveExactMergeBase = () => 'feed00';
		const drifted = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:base',
				pr_head_sha: 'abc123',
				base_sha: 'feed00',
				base_ref: 'origin/rebased-main',
				max_concurrent: 1,
				lanes: [lane('retry-intent', PR_REVIEW_BASE_DIMENSION_IDS[0])],
			},
			directory,
			{ sessionID: 'base-binding-session' },
		);
		expect(drifted.success).toBe(false);
		expect(drifted.message).toContain('bound to merge-base scope');
	});

	test('blocks review dispatch that omits the explicit workflow mode', async () => {
		await activatePrWorkflow(directory, 'review-session', 'PR_REVIEW');
		const result = await executeDispatchLanesAsync(
			{ lanes: [lane('lane-a')] },
			directory,
			{ sessionID: 'review-session' },
		);

		expect(result.success).toBe(false);
		expect(result.message).toContain(
			'active PR_REVIEW dispatch requires pr_head_sha',
		);
	});

	test('blocks PR feedback verification without exact head provenance', async () => {
		await activatePrWorkflow(directory, 'feedback-session', 'PR_FEEDBACK');
		const result = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-feedback:verification',
				feedback_inventory: ['FB-001', 'FB-002'],
				lanes: [lane('verify-a', undefined, ['FB-001'])],
			},
			directory,
			{ sessionID: 'feedback-session' },
		);

		expect(result.success).toBe(false);
		expect(result.message).toContain('requires pr_head_sha');
	});
});
