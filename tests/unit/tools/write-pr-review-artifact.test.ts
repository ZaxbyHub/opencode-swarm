import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { storeLaneOutput } from '../../../src/background/lane-output-store.js';
import {
	appendDelegationTransition,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations.js';
import {
	_test_exports,
	activatePrWorkflow,
	completePrWorkflow,
	enforcePrReviewBaseDimensions,
	markPrReviewTriggerEvaluationComplete,
	PR_REVIEW_BASE_DIMENSION_IDS,
	PR_REVIEW_REQUIRED_MICRO_LANE_IDS,
	readPrWorkflowGateState,
	recordPrReviewValidationBatch,
} from '../../../src/hooks/pr-workflow-gate.js';
import { executeWritePrReviewArtifact } from '../../../src/tools/write-pr-review-artifact.js';

const SESSION_ID = 'write-pr-review-artifact';
const HEAD_SHA = 'abc123';
const REVISION_DIGEST = 'revision-1';

let directory = '';
const originalResolveCurrentGitHead = _test_exports.resolveCurrentGitHead;
const originalResolveCurrentGitHeadAsync =
	_test_exports.resolveCurrentGitHeadAsync;
const originalResolveRevisionDigest =
	_test_exports.resolvePrWorkflowRevisionDigest;
const originalResolveIsWorkingTreeClean =
	_test_exports.resolveIsWorkingTreeClean;
const originalResolveIsWorkingTreeCleanAsync =
	_test_exports.resolveIsWorkingTreeCleanAsync;

beforeEach(() => {
	directory = realpathSync(
		mkdtempSync(path.join(os.tmpdir(), 'write-pr-review-artifact-')),
	);
	_test_exports.resetTrackedStateCache();
	_test_exports.resolveCurrentGitHead = () => HEAD_SHA;
	_test_exports.resolvePrWorkflowRevisionDigest = () => REVISION_DIGEST;
	_test_exports.resolveIsWorkingTreeClean = () => true;
	_test_exports.resolveCurrentGitHeadAsync = async (dir) =>
		_test_exports.resolveCurrentGitHead(dir);
	_test_exports.resolveIsWorkingTreeCleanAsync = async (dir) =>
		_test_exports.resolveIsWorkingTreeClean(dir);
});

afterEach(async () => {
	_test_exports.resetTrackedStateCache();
	_test_exports.resolveCurrentGitHead = originalResolveCurrentGitHead;
	_test_exports.resolveCurrentGitHeadAsync = originalResolveCurrentGitHeadAsync;
	_test_exports.resolvePrWorkflowRevisionDigest = originalResolveRevisionDigest;
	_test_exports.resolveIsWorkingTreeClean = originalResolveIsWorkingTreeClean;
	_test_exports.resolveIsWorkingTreeCleanAsync =
		originalResolveIsWorkingTreeCleanAsync;
	await fs.rm(directory, { recursive: true, force: true });
});

async function persistPrReviewBatch(
	batchId: string,
	mode: string,
	lanes: ReadonlyArray<{ laneId: string; workflowLane: string }>,
	options: {
		status?: 'completed' | 'error';
		head?: string;
		empty?: boolean;
		textOverride?: string;
		transcriptIncomplete?: boolean;
		artifactRole?: string;
		subagentSessionId?: string;
	} = {},
): Promise<void> {
	for (const [index, lane] of lanes.entries()) {
		const correlationId = `${batchId}-${index}`;
		const subagentSessionId = options.subagentSessionId ?? correlationId;
		await recordPendingDelegation(directory, {
			correlationId,
			jobId: null,
			subagentSessionId,
			parentSessionId: SESSION_ID,
			callID: `call-${correlationId}`,
			normalizedAgent: 'reviewer',
			swarmPrefixedAgent: 'reviewer',
			planTaskId: null,
			evidenceTaskId: null,
			batchId,
			laneId: lane.laneId,
			mode,
			workflowLane: lane.workflowLane,
			workspace: {
				directory,
				gitHead: HEAD_SHA,
				dirtyHash: null,
				prHeadSha: options.head ?? HEAD_SHA,
				scope: null,
			},
		});
		const text =
			options.textOverride ??
			(options.empty
				? ''
				: mode === 'swarm-pr-review:reviewer'
					? '[REVIEWED] | C-001 | CONFIRMED | STRUCTURALLY_PROVEN | HIGH | YES | file.ts:1 | rationale | probe | reviewer'
					: mode === 'swarm-pr-review:critic'
						? '[CRITIC] | C-001 | UPHELD | HIGH | reason | no change'
						: mode === 'swarm-pr-feedback:verification'
							? `[FEEDBACK-VERIFIED] | ${lane.workflowLane} | CONFIRMED | evidence`
							: `[CANDIDATE] | candidate_id | lane | severity | category | file:line | claim | evidence_summary | impact_context | confidence\nC-${index} | ${lane.workflowLane} | HIGH | correctness | file.ts:1 | claim | evidence | impact | HIGH`);
		const stored = storeLaneOutput(directory, {
			batchId,
			laneId: lane.laneId,
			agent: 'reviewer',
			role: options.artifactRole ?? 'reviewer',
			sessionId: subagentSessionId,
			parentSessionId: SESSION_ID,
			mode,
			workflowLane: lane.workflowLane,
			prHeadSha: options.head ?? HEAD_SHA,
			gitHead: HEAD_SHA,
			revisionDigest: REVISION_DIGEST,
			source: 'collect_lane_results',
			text,
			transcriptIncomplete: options.transcriptIncomplete,
		});
		await appendDelegationTransition(directory, correlationId, {
			status: options.status ?? 'completed',
			result: {
				text,
				chars: stored.chars,
				truncated: false,
				digest: stored.digest,
				...(stored.ref ? { outputRef: stored.ref } : {}),
				...(options.transcriptIncomplete ? { transcriptIncomplete: true } : {}),
			},
		});
	}
}

async function establishPrReviewPrerequisites(): Promise<void> {
	await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW', {
		prHeadSha: HEAD_SHA,
	});
	const baseLanes = PR_REVIEW_BASE_DIMENSION_IDS.map((workflowLane) => ({
		laneId: workflowLane,
		workflowLane,
	}));
	await enforcePrReviewBaseDimensions(directory, SESSION_ID, baseLanes, {
		batchId: 'base-all',
		prHeadSha: HEAD_SHA,
	});
	await persistPrReviewBatch('base-all', 'swarm-pr-review:base', baseLanes);
	for (const [
		index,
		workflowLane,
	] of PR_REVIEW_REQUIRED_MICRO_LANE_IDS.entries()) {
		const batchId = `micro-${index}`;
		const laneId = `micro-lane-${index}`;
		await persistPrReviewBatch(
			batchId,
			'swarm-pr-review:micro',
			[{ laneId, workflowLane }],
			{
				textOverride: `[CLEAN] | ${workflowLane} | exact reviewed diff | no finding after focused invariant review`,
			},
		);
	}
	const triggerRows: Array<Record<string, string>> = [];
	for (const [
		index,
		workflowLane,
	] of PR_REVIEW_REQUIRED_MICRO_LANE_IDS.entries()) {
		triggerRows.push({
			trigger_id: workflowLane,
			result: 'MATCHED',
			source_batch_id: `micro-${index}`,
			source_lane_id: `micro-lane-${index}`,
		});
	}
	const triggerRelative = path.join(
		'pr-review',
		'test-run',
		'trigger-eval.json',
	);
	const triggerAbsolute = path.join(directory, '.swarm', triggerRelative);
	await fs.mkdir(path.dirname(triggerAbsolute), { recursive: true });
	await fs.writeFile(
		triggerAbsolute,
		JSON.stringify({ rows: triggerRows }),
		'utf-8',
	);
	await markPrReviewTriggerEvaluationComplete(
		directory,
		SESSION_ID,
		triggerRelative,
	);
}

describe('write_pr_review_artifact', () => {
	test('ARTIFACT-ORDER regression: requires explorer, reviewer, then critic checkpoints', async () => {
		await establishPrReviewPrerequisites();
		const candidateIds = PR_REVIEW_BASE_DIMENSION_IDS.map(
			(_dimension, index) => `C-${index}`,
		);
		const explorerRecords = candidateIds.map((id) => ({
			finding_id: id,
			status: 'PENDING' as const,
			file_line: 'src/index.ts:1',
			evidence: 'discovery evidence',
			next_action: 'route_to_reviewer' as const,
		}));
		await expect(
			executeWritePrReviewArtifact(
				{
					kind: 'findings',
					run_id: 'coverage-order',
					pr_head_sha: HEAD_SHA,
					boundary: 'post_explorer',
					records: explorerRecords.slice(0, -1),
				},
				directory,
				{ sessionID: SESSION_ID },
			),
		).rejects.toThrow(/exactly cover/i);
		await expect(
			executeWritePrReviewArtifact(
				{
					kind: 'findings',
					run_id: 'coverage-order',
					pr_head_sha: HEAD_SHA,
					boundary: 'post_reviewer',
					records: explorerRecords,
				},
				directory,
				{ sessionID: SESSION_ID },
			),
		).rejects.toThrow(/prior post_explorer checkpoint/i);
		await expect(
			fs.stat(path.join(directory, '.swarm', 'pr-review', 'coverage-order')),
		).rejects.toThrow();
		await expect(
			executeWritePrReviewArtifact(
				{
					kind: 'findings',
					run_id: 'coverage-order',
					pr_head_sha: HEAD_SHA,
					boundary: 'post_explorer',
					records: explorerRecords,
				},
				directory,
				{ sessionID: SESSION_ID },
			),
		).resolves.toContain('"success": true');
		await expect(
			executeWritePrReviewArtifact(
				{
					kind: 'findings',
					run_id: 'coverage-order',
					pr_head_sha: HEAD_SHA,
					boundary: 'post_reviewer',
					records: explorerRecords,
				},
				directory,
				{ sessionID: SESSION_ID },
			),
		).rejects.toThrow(/reviewer/i);
	});

	test('ARTIFACT-VERDICT regression: persists only reviewer and critic-authoritative dispositions', async () => {
		await establishPrReviewPrerequisites();
		const candidateIds = PR_REVIEW_BASE_DIMENSION_IDS.map(
			(_dimension, index) => `C-${index}`,
		);
		const explorerRecords = candidateIds.map((id) => ({
			finding_id: id,
			status: 'PENDING' as const,
			file_line: 'src/index.ts:1',
			evidence: 'discovery evidence',
			next_action: 'route_to_reviewer' as const,
		}));
		const reviewerRecords = candidateIds.map((id, index) => ({
			finding_id: id,
			status: index === 0 ? ('DISPROVED' as const) : ('CONFIRMED' as const),
			file_line: 'src/index.ts:1',
			evidence: 'reviewer evidence',
			next_action:
				index === 0
					? ('suppress_with_reason' as const)
					: ('route_to_critic' as const),
		}));
		const criticRecords = candidateIds.map((id, index) => ({
			finding_id: id,
			status: index === 0 ? ('DISPROVED' as const) : ('CONFIRMED' as const),
			file_line: 'src/index.ts:1',
			evidence: 'critic evidence',
			next_action:
				index === 0
					? ('suppress_with_reason' as const)
					: index === 1
						? ('handoff_to_feedback' as const)
						: ('report' as const),
		}));
		const reviewerRows = candidateIds
			.map((id, index) =>
				index === 0
					? `[REVIEWED] | ${id} | DISPROVED | STRUCTURALLY_PROVEN | LOW | YES | file.ts:1 | rationale | probe | reviewer`
					: `[REVIEWED] | ${id} | CONFIRMED | STRUCTURALLY_PROVEN | HIGH | YES | file.ts:1 | rationale | probe | reviewer`,
			)
			.join('\n');
		await recordPrReviewValidationBatch(
			directory,
			SESSION_ID,
			'reviewer',
			[
				{
					laneId: 'review-boundaries',
					workflowLane: 'review-boundaries',
					reviewItemIds: candidateIds,
				},
			],
			{ batchId: 'review-boundaries', prHeadSha: HEAD_SHA },
		);
		await persistPrReviewBatch(
			'review-boundaries',
			'swarm-pr-review:reviewer',
			[{ laneId: 'review-boundaries', workflowLane: 'review-boundaries' }],
			{ textOverride: reviewerRows },
		);
		const criticRows = candidateIds
			.map((id) => `[CRITIC] | ${id} | UPHELD | HIGH | reason | no change`)
			.join('\n');
		await recordPrReviewValidationBatch(
			directory,
			SESSION_ID,
			'critic',
			[
				{
					laneId: 'critic-boundaries',
					workflowLane: 'critic-boundaries',
					reviewItemIds: candidateIds.slice(1),
				},
			],
			{ batchId: 'critic-boundaries', prHeadSha: HEAD_SHA },
		);
		await persistPrReviewBatch(
			'critic-boundaries',
			'swarm-pr-review:critic',
			[{ laneId: 'critic-boundaries', workflowLane: 'critic-boundaries' }],
			{ textOverride: criticRows },
		);

		await expect(
			executeWritePrReviewArtifact(
				{
					kind: 'findings',
					run_id: 'review-boundaries',
					pr_head_sha: HEAD_SHA,
					boundary: 'post_explorer',
					records: explorerRecords,
				},
				directory,
				{ sessionID: SESSION_ID },
			),
		).resolves.toContain('"success": true');
		await expect(
			executeWritePrReviewArtifact(
				{
					kind: 'findings',
					run_id: 'review-boundaries',
					pr_head_sha: HEAD_SHA,
					boundary: 'post_reviewer',
					records: reviewerRecords.map((record) => ({
						...record,
						status: 'DISPROVED' as const,
						next_action: 'suppress_with_reason' as const,
					})),
				},
				directory,
				{ sessionID: SESSION_ID },
			),
		).rejects.toThrow(/status differs from its reviewer verdict/i);
		await expect(
			executeWritePrReviewArtifact(
				{
					kind: 'findings',
					run_id: 'review-boundaries',
					pr_head_sha: HEAD_SHA,
					boundary: 'post_reviewer',
					records: reviewerRecords.map((record, index) =>
						index === 0
							? { ...record, next_action: 'report' as const }
							: record,
					),
				},
				directory,
				{ sessionID: SESSION_ID },
			),
		).rejects.toThrow(/action does not match reviewer disposition/i);

		await expect(
			executeWritePrReviewArtifact(
				{
					kind: 'findings',
					run_id: 'review-boundaries',
					pr_head_sha: HEAD_SHA,
					boundary: 'post_reviewer',
					records: reviewerRecords,
				},
				directory,
				{ sessionID: SESSION_ID },
			),
		).resolves.toContain('"success": true');
		await expect(
			executeWritePrReviewArtifact(
				{
					kind: 'findings',
					run_id: 'review-boundaries',
					pr_head_sha: HEAD_SHA,
					boundary: 'post_critic',
					records: criticRecords.map((record) => ({
						...record,
						status: 'DISPROVED' as const,
						next_action: 'suppress_with_reason' as const,
					})),
				},
				directory,
				{ sessionID: SESSION_ID },
			),
		).rejects.toThrow(/action does not match its critic verdict/i);

		await expect(
			executeWritePrReviewArtifact(
				{
					kind: 'findings',
					run_id: 'review-boundaries',
					pr_head_sha: HEAD_SHA,
					boundary: 'post_critic',
					records: criticRecords,
				},
				directory,
				{ sessionID: SESSION_ID },
			),
		).resolves.toContain('"success": true');

		await expect(
			readPrWorkflowGateState(directory, SESSION_ID),
		).resolves.toMatchObject({
			prReviewArtifactRunId: 'review-boundaries',
			prReviewFindingsPath: 'pr-review/review-boundaries/findings.jsonl',
			prReviewArtifactBoundaries: [
				'post_explorer',
				'post_reviewer',
				'post_critic',
			],
		});

		const handoffArgs = {
			kind: 'handoff' as const,
			run_id: 'review-boundaries',
			pr_head_sha: HEAD_SHA,
			handoff: {
				pr_url: 'https://github.com/example/project/pull/123',
				finding_ids: ['C-1'],
				summary: 'validated actionable finding',
				provenance: ['review-boundaries', 'critic-boundaries'],
			},
		};
		const wrongHandoff = await executeWritePrReviewArtifact(
			{
				...handoffArgs,
				handoff: { ...handoffArgs.handoff, finding_ids: ['C-0'] },
			},
			directory,
			{ sessionID: SESSION_ID },
		);
		expect(wrongHandoff).toContain('"success": false');
		await expect(
			executeWritePrReviewArtifact(handoffArgs, directory, {
				sessionID: SESSION_ID,
			}),
		).resolves.toContain('feedback-handoff.json');
		await expect(
			completePrWorkflow(directory, SESSION_ID, 'PR_REVIEW', HEAD_SHA),
		).resolves.toBe('completed');
	});
});
