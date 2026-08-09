import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, realpathSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { findByBatchId } from '../../../src/background/pending-delegations.js';
import {
	activatePrWorkflow,
	bindPrReviewBase,
	_test_exports as gateInternals,
	PR_REVIEW_BASE_DIMENSION_IDS,
	readPrWorkflowGateState,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	_internals as dispatchInternals,
	_test_exports as dispatchTestExports,
	executeDispatchLanesAsync,
	MAX_PROMPT_CHARS,
} from '../../../src/tools/dispatch-lanes.js';

const SESSION_ID = 'review-prompt-overflow';
const HEAD_SHA = 'abc123';
const REVISION_DIGEST = 'review-revision';
const REVIEW_SCOPE = `complete PR diff def456...${HEAD_SHA}`;
let directory = '';
let createdSessions = 0;
const originalGetSessionOps = dispatchInternals.getSessionOps;
const originalGetGeneratedAgentNames = dispatchInternals.getGeneratedAgentNames;
const originalResolveCurrentGitHead = gateInternals.resolveCurrentGitHead;
const originalResolveCurrentGitHeadAsync =
	gateInternals.resolveCurrentGitHeadAsync;
const originalResolveIsWorkingTreeClean =
	gateInternals.resolveIsWorkingTreeClean;
const originalResolveIsWorkingTreeCleanAsync =
	gateInternals.resolveIsWorkingTreeCleanAsync;
const originalGateRevisionDigest =
	gateInternals.resolvePrWorkflowRevisionDigest;
const originalDispatchRevisionDigestAsync =
	dispatchInternals.resolvePrWorkflowRevisionDigestAsync;
const originalDispatchMergeBaseAsync =
	dispatchInternals.resolveExactMergeBaseAsync;

beforeEach(() => {
	directory = realpathSync(
		mkdtempSync(path.join(os.tmpdir(), 'dispatch-review-overflow-')),
	);
	createdSessions = 0;
	gateInternals.resetTrackedStateCache();
	gateInternals.resolveCurrentGitHead = () => HEAD_SHA;
	gateInternals.resolveIsWorkingTreeClean = () => true;
	gateInternals.resolvePrWorkflowRevisionDigest = () => REVISION_DIGEST;
	gateInternals.resolveCurrentGitHeadAsync = async (dir) =>
		gateInternals.resolveCurrentGitHead(dir);
	gateInternals.resolveIsWorkingTreeCleanAsync = async (dir) =>
		gateInternals.resolveIsWorkingTreeClean(dir);
	dispatchInternals.resolvePrWorkflowRevisionDigestAsync = async () =>
		REVISION_DIGEST;
	dispatchInternals.resolveExactMergeBaseAsync = async () => 'def456';
	dispatchInternals.getGeneratedAgentNames = () => ['explorer'];
	dispatchInternals.getSessionOps = () => ({
		create: mock(async () => ({
			data: { id: `child-${++createdSessions}` },
			error: undefined,
		})),
		prompt: mock(async () => ({ data: undefined, error: undefined })),
		promptAsync: mock(async () => ({ data: undefined, error: undefined })),
		delete: mock(async () => undefined),
	});
});

afterEach(async () => {
	gateInternals.resetTrackedStateCache();
	gateInternals.resolveCurrentGitHead = originalResolveCurrentGitHead;
	gateInternals.resolveCurrentGitHeadAsync = originalResolveCurrentGitHeadAsync;
	gateInternals.resolveIsWorkingTreeClean = originalResolveIsWorkingTreeClean;
	gateInternals.resolveIsWorkingTreeCleanAsync =
		originalResolveIsWorkingTreeCleanAsync;
	gateInternals.resolvePrWorkflowRevisionDigest = originalGateRevisionDigest;
	dispatchInternals.resolvePrWorkflowRevisionDigestAsync =
		originalDispatchRevisionDigestAsync;
	dispatchInternals.resolveExactMergeBaseAsync = originalDispatchMergeBaseAsync;
	dispatchInternals.getSessionOps = originalGetSessionOps;
	dispatchInternals.getGeneratedAgentNames = originalGetGeneratedAgentNames;
	await fs.rm(directory, { recursive: true, force: true });
});

describe('PR-review mandatory explorer prompt contract', () => {
	test('refuses overflow before launching any session', async () => {
		await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW');
		await bindPrReviewBase(directory, SESSION_ID, {
			prHeadSha: HEAD_SHA,
			baseRef: 'origin/main',
			baseSha: 'def456',
		});
		const stateBefore = await readPrWorkflowGateState(directory, SESSION_ID);
		const firstLane = PR_REVIEW_BASE_DIMENSION_IDS[0];
		const probe = [
			{
				id: firstLane,
				agent: 'explorer',
				prompt: '',
				workflow_lane: firstLane,
			},
		];
		const contracted = dispatchTestExports.applyPrWorkflowPromptContract(
			probe,
			{
				mode: 'swarm-pr-review:base',
				prHeadSha: HEAD_SHA,
				revisionDigest: REVISION_DIGEST,
				scope: REVIEW_SCOPE,
			},
		);
		expect(contracted.ok).toBe(true);
		if (!contracted.ok) throw new Error(contracted.errors.join('; '));
		const formatted = dispatchTestExports.applyExplorerFormatSuffix(
			contracted.lanes,
			{ failClosed: true, mode: 'swarm-pr-review:base' },
		);
		expect(formatted.ok).toBe(true);
		if (!formatted.ok) throw new Error(formatted.errors.join('; '));
		const contractOverhead = contracted.lanes[0].prompt.length;
		const suffixOverhead =
			formatted.lanes[0].prompt.length - contracted.lanes[0].prompt.length;
		const overflowPromptLength =
			MAX_PROMPT_CHARS - contractOverhead - suffixOverhead + 1;
		expect(overflowPromptLength).toBeGreaterThan(0);

		const result = await executeDispatchLanesAsync(
			{
				batch_id: 'overflow-base',
				mode: 'swarm-pr-review:base',
				pr_head_sha: HEAD_SHA,
				base_sha: 'def456',
				base_ref: 'origin/main',
				max_concurrent: 6,
				lanes: PR_REVIEW_BASE_DIMENSION_IDS.map((workflowLane, index) => ({
					id: workflowLane,
					agent: 'explorer',
					prompt:
						index === 0
							? 'x'.repeat(overflowPromptLength)
							: `Review ${workflowLane}`,
					workflow_lane: workflowLane,
				})),
			},
			directory,
			{ sessionID: SESSION_ID },
		);
		expect(result.success).toBe(false);
		expect(result.failure_class).toBe('invalid_args');
		expect(result.message).toContain(
			'mandatory PR workflow explorer output contract',
		);
		expect(result.errors?.join('; ')).toContain(
			'mandatory explorer output contract',
		);
		expect(createdSessions).toBe(0);
		expect(findByBatchId(directory, 'overflow-base')).toEqual([]);
		expect(await readPrWorkflowGateState(directory, SESSION_ID)).toEqual(
			stateBefore,
		);
	});
});
