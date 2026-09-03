import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import {
	findByBatchId,
	findByCorrelationId,
	recordPendingDelegation,
} from '../../src/background/pending-delegations.js';
import {
	activatePrWorkflow,
	bindPrReviewBase,
	_test_exports as gateInternals,
	PR_REVIEW_BASE_DIMENSION_IDS,
	readPrWorkflowGateState,
} from '../../src/hooks/pr-workflow-gate.js';
import {
	withSessionStateMutation,
	writeStateWhileLocked,
} from '../../src/pr-review/persistence.js';
import { _internals as dispatchInternals } from '../../src/tools/dispatch-lanes.js';
import {
	bootKnowledgeHost,
	createKnowledgeProject,
} from '../helpers/knowledge-real-host.js';

const SESSION_ID = 'pr-transport-real-host';
const HEAD_SHA = 'a'.repeat(40);
const BASE_SHA = 'b'.repeat(40);
const REVISION_DIGEST = 'c'.repeat(64);

const originalCurrentGitHeadAsync = gateInternals.resolveCurrentGitHeadAsync;
const originalRevisionDigest = gateInternals.resolvePrWorkflowRevisionDigest;
const originalWorkingTreeCleanAsync =
	gateInternals.resolveIsWorkingTreeCleanAsync;
const originalDiffStatsAsync = gateInternals.resolvePrReviewDiffStatsAsync;
const originalDispatchRevisionDigest =
	dispatchInternals.resolvePrWorkflowRevisionDigestAsync;
const originalDispatchMergeBase = dispatchInternals.resolveExactMergeBaseAsync;

describe('PR workflow dispatch and receipt transport at the plugin host boundary', () => {
	let directory = '';
	let plugin: Awaited<ReturnType<typeof bootKnowledgeHost>>;
	let childSessions: string[] = [];
	let deliveredPrompts: string[] = [];

	beforeEach(async () => {
		directory = createKnowledgeProject();
		childSessions = [];
		deliveredPrompts = [];
		gateInternals.resetTrackedStateCache();
		gateInternals.resolveCurrentGitHeadAsync = async () => HEAD_SHA;
		gateInternals.resolvePrWorkflowRevisionDigest = () => REVISION_DIGEST;
		gateInternals.resolveIsWorkingTreeCleanAsync = async () => true;
		gateInternals.resolvePrReviewDiffStatsAsync = async () => ({
			changedLines: 400,
			changedFiles: 12,
			hasSubmoduleChange: false,
		});
		dispatchInternals.resolvePrWorkflowRevisionDigestAsync = async () =>
			REVISION_DIGEST;
		dispatchInternals.resolveExactMergeBaseAsync = async () => BASE_SHA;
		const hostClient = {
			session: {
				create: async () => {
					const id = `host-child-${childSessions.length}`;
					childSessions.push(id);
					return { data: { id }, error: undefined };
				},
				promptAsync: async (args: {
					path: { id: string };
					body: { parts: Array<{ text?: string }> };
				}) => {
					deliveredPrompts.push(
						`${args.path.id}\n${args.body.parts[0]?.text ?? ''}`,
					);
					return { data: undefined, error: undefined };
				},
			},
		};
		plugin = await bootKnowledgeHost(directory, {}, hostClient);
	});

	afterEach(() => {
		gateInternals.resetTrackedStateCache();
		gateInternals.resolveCurrentGitHeadAsync = originalCurrentGitHeadAsync;
		gateInternals.resolvePrWorkflowRevisionDigest = originalRevisionDigest;
		gateInternals.resolveIsWorkingTreeCleanAsync =
			originalWorkingTreeCleanAsync;
		gateInternals.resolvePrReviewDiffStatsAsync = originalDiffStatsAsync;
		dispatchInternals.resolvePrWorkflowRevisionDigestAsync =
			originalDispatchRevisionDigest;
		dispatchInternals.resolveExactMergeBaseAsync = originalDispatchMergeBase;
		try {
			rmSync(directory, { recursive: true, force: true });
		} catch {
			// Best-effort cleanup; Windows may briefly retain a host-created file.
		}
	});

	test('registered dispatch reaches the host client and receipt reaches durable progress state', async () => {
		await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW', {
			prHeadSha: HEAD_SHA,
		});
		const batchId = 'real-host-transport-batch';
		const dispatchResult = JSON.parse(
			String(
				await plugin.tool.dispatch_lanes_async.execute(
					{
						batch_id: batchId,
						mode: 'swarm-pr-review:base',
						pr_head_sha: HEAD_SHA,
						base_sha: BASE_SHA,
						base_ref: 'origin/main',
						max_concurrent: 6,
						lanes: PR_REVIEW_BASE_DIMENSION_IDS.map((workflowLane) => ({
							id: `host-${workflowLane}`,
							agent: 'explorer',
							prompt: `Review ${workflowLane} at the host boundary.`,
							workflow_lane: workflowLane,
						})),
					},
					{ directory, sessionID: SESSION_ID },
				),
			),
		) as { success: boolean };
		expect(dispatchResult.success).toBe(true);
		expect(childSessions).toHaveLength(6);
		expect(deliveredPrompts).toHaveLength(6);
		const records = findByBatchId(directory, batchId);
		expect(records).toHaveLength(6);
		const first = records[0];
		if (!first?.workflowLane || !first.subagentSessionId) {
			throw new Error('real-host dispatch did not persist child provenance');
		}
		const firstPrompt = deliveredPrompts.find((prompt) =>
			prompt.startsWith(`${first.subagentSessionId}\n`),
		);
		expect(firstPrompt).toContain(`batch_id: ${batchId}`);
		expect(firstPrompt).toContain(`lane_id: ${first.laneId}`);
		expect(first.subagentSessionId).toBe(childSessions[0]);
		const envelope = {
			schemaVersion: 1 as const,
			outcome: 'CLEAN' as const,
			creditedLanes: [first.workflowLane],
			findings: [],
			cleanAttestations: [
				{
					workflowLane: first.workflowLane,
					coverageScope: 'The registered host transport was exercised.',
					evidence: 'The child receipt was persisted through the plugin tool.',
				},
			],
			unresolved: [],
		};

		const controllerResult = JSON.parse(
			String(
				await plugin.tool.submit_pr_review_result.execute(
					{
						schemaVersion: 1,
						revisionDigest: REVISION_DIGEST,
						result: envelope,
					},
					{ directory, sessionID: SESSION_ID },
				),
			),
		) as { success: boolean; reason?: string };
		expect(controllerResult.success).toBe(false);
		expect(controllerResult.reason).toContain('exact child delegation');

		const receiptResult = JSON.parse(
			String(
				await plugin.tool.submit_pr_review_result.execute(
					{
						schemaVersion: 1,
						revisionDigest: REVISION_DIGEST,
						result: envelope,
					},
					{
						directory,
						sessionID: first.subagentSessionId,
					},
				),
			),
		) as { success: boolean; status?: string };
		expect(receiptResult).toMatchObject({ success: true, status: 'recorded' });
		const settled = findByCorrelationId(directory, first.subagentSessionId);
		expect(settled?.result?.prReviewResultReceipt?.batchId).toBe(batchId);
		expect(settled?.result?.prReviewResultReceipt?.laneId).toBe(first.laneId);

		const mismatched = JSON.parse(
			String(
				await plugin.tool.submit_pr_review_result.execute(
					{
						schemaVersion: 1,
						batchId: 'invented-batch',
						laneId: first.laneId,
						revisionDigest: REVISION_DIGEST,
						result: envelope,
					},
					{ directory, sessionID: first.subagentSessionId },
				),
			),
		) as { success: boolean; reason?: string };
		expect(mismatched.success).toBe(false);
		expect(mismatched.reason).toBe('delegation batch/lane identity mismatch');

		const exactReplay = JSON.parse(
			String(
				await plugin.tool.submit_pr_review_result.execute(
					{
						schemaVersion: 1,
						batchId,
						laneId: first.laneId,
						revisionDigest: REVISION_DIGEST,
						result: envelope,
					},
					{ directory, sessionID: first.subagentSessionId },
				),
			),
		) as { success: boolean; status?: string };
		expect(exactReplay).toMatchObject({ success: true, status: 'duplicate' });
	});

	test('matched child delegation without workflow binding provenance fails closed', async () => {
		await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW', {
			prHeadSha: HEAD_SHA,
		});
		await bindPrReviewBase(directory, SESSION_ID, {
			prHeadSha: HEAD_SHA,
			baseRef: 'origin/main',
			baseSha: BASE_SHA,
		});
		await recordPendingDelegation(directory, {
			correlationId: 'host-child-missing-provenance',
			jobId: null,
			subagentSessionId: 'host-child-missing-provenance',
			parentSessionId: SESSION_ID,
			callID: 'blocking-dispatch-call',
			normalizedAgent: 'explorer',
			swarmPrefixedAgent: 'explorer',
			planTaskId: null,
			evidenceTaskId: null,
			batchId: 'missing-binding-batch',
			laneId: 'missing-binding-lane',
			mode: 'swarm-pr-review:base',
			workflowLane: 'intent-architecture',
			workspace: {
				directory,
				gitHead: HEAD_SHA,
				dirtyHash: REVISION_DIGEST,
				prHeadSha: HEAD_SHA,
				scope: `complete PR diff ${BASE_SHA}...${HEAD_SHA}`,
			},
		});

		const result = JSON.parse(
			String(
				await plugin.tool.submit_pr_review_result.execute(
					{
						schemaVersion: 1,
						revisionDigest: REVISION_DIGEST,
						result: {
							schemaVersion: 1,
							outcome: 'CLEAN',
							creditedLanes: ['intent-architecture'],
							findings: [],
							cleanAttestations: [
								{
									workflowLane: 'intent-architecture',
									coverageScope: 'The missing-provenance boundary.',
									evidence: 'No batch or lane identity exists to credit.',
								},
							],
							unresolved: [],
						},
					},
					{ directory, sessionID: 'host-child-missing-provenance' },
				),
			),
		) as { success: boolean; reason?: string };
		expect(result.success).toBe(false);
		expect(result.reason).toBe(
			'delegation workflow binding provenance is missing',
		);
	});

	test('matched child delegation bound to a replaced workflow instance fails closed', async () => {
		await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW', {
			prHeadSha: HEAD_SHA,
		});
		const batchId = 'stale-workflow-instance-batch';
		const dispatchResult = JSON.parse(
			String(
				await plugin.tool.dispatch_lanes_async.execute(
					{
						batch_id: batchId,
						mode: 'swarm-pr-review:base',
						pr_head_sha: HEAD_SHA,
						base_sha: BASE_SHA,
						base_ref: 'origin/main',
						max_concurrent: 6,
						lanes: PR_REVIEW_BASE_DIMENSION_IDS.map((workflowLane) => ({
							id: `stale-${workflowLane}`,
							agent: 'explorer',
							prompt: `Review ${workflowLane} before workflow replacement.`,
							workflow_lane: workflowLane,
						})),
					},
					{ directory, sessionID: SESSION_ID },
				),
			),
		) as { success: boolean };
		expect(dispatchResult.success).toBe(true);
		const first = findByBatchId(directory, batchId)[0];
		if (!first?.workflowLane || !first.subagentSessionId) {
			throw new Error('real-host dispatch did not persist child provenance');
		}

		await withSessionStateMutation(directory, SESSION_ID, async () => {
			const current = await readPrWorkflowGateState(directory, SESSION_ID);
			if (!current?.workflowInstanceId) {
				throw new Error('active PR_REVIEW state has no workflow instance');
			}
			await writeStateWhileLocked(
				directory,
				{
					...current,
					workflowInstanceId: 'replacement-workflow-instance',
					updatedAt: '2026-01-01T00:00:00.000Z',
				},
				{ replaceWorkflowInstanceId: current.workflowInstanceId },
			);
		});

		const result = JSON.parse(
			String(
				await plugin.tool.submit_pr_review_result.execute(
					{
						schemaVersion: 1,
						revisionDigest: REVISION_DIGEST,
						result: {
							schemaVersion: 1,
							outcome: 'CLEAN',
							creditedLanes: [first.workflowLane],
							findings: [],
							cleanAttestations: [
								{
									workflowLane: first.workflowLane,
									coverageScope: 'The superseded workflow instance.',
									evidence: 'The child still carries the original binding.',
								},
							],
							unresolved: [],
						},
					},
					{ directory, sessionID: first.subagentSessionId },
				),
			),
		) as { success: boolean; reason?: string };
		expect(result.success).toBe(false);
		expect(result.reason).toBe('stale workflow instance binding');
	});
});
