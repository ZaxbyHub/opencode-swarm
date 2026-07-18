import { afterEach, beforeEach } from 'bun:test';
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
	enforcePrReviewBaseDimensions,
	markPrReviewTriggerEvaluationComplete,
	PR_REVIEW_BASE_DIMENSION_IDS,
	PR_REVIEW_REQUIRED_MICRO_LANE_IDS,
} from '../../../src/hooks/pr-workflow-gate.js';

export const SESSION_ID = 'session-123';
export const HEAD_SHA = 'abc123';
export const REVISION_DIGEST = 'revision-test';

export let tempDir = '';
const originalResolveCurrentGitHead = _test_exports.resolveCurrentGitHead;
const originalResolveRevisionDigest =
	_test_exports.resolvePrWorkflowRevisionDigest;
const originalResolveIsWorkingTreeClean =
	_test_exports.resolveIsWorkingTreeClean;

beforeEach(() => {
	tempDir = realpathSync(
		mkdtempSync(path.join(os.tmpdir(), 'pr-workflow-gate-')),
	);
	_test_exports.resetTrackedStateCache();
	_test_exports.resolveCurrentGitHead = () => HEAD_SHA;
	_test_exports.resolvePrWorkflowRevisionDigest = () => REVISION_DIGEST;
	_test_exports.resolveIsWorkingTreeClean = () => true;
});

afterEach(async () => {
	_test_exports.resetTrackedStateCache();
	_test_exports.resolveCurrentGitHead = originalResolveCurrentGitHead;
	_test_exports.resolvePrWorkflowRevisionDigest = originalResolveRevisionDigest;
	_test_exports.resolveIsWorkingTreeClean = originalResolveIsWorkingTreeClean;
	await fs.rm(tempDir, { recursive: true, force: true });
});

export async function persistBatch(
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
		await recordPendingDelegation(tempDir, {
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
				directory: tempDir,
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
		const stored = storeLaneOutput(tempDir, {
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
		await appendDelegationTransition(tempDir, correlationId, {
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

export async function establishReviewPrerequisites(): Promise<void> {
	await activatePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW');
	const lanes = PR_REVIEW_BASE_DIMENSION_IDS.map((workflowLane) => ({
		laneId: workflowLane,
		workflowLane,
	}));
	await enforcePrReviewBaseDimensions(tempDir, SESSION_ID, lanes, {
		batchId: 'base-all',
		prHeadSha: HEAD_SHA,
	});
	await persistBatch('base-all', 'swarm-pr-review:base', lanes);
	const triggerRows: Array<Record<string, string>> = [];
	for (const [
		index,
		workflowLane,
	] of PR_REVIEW_REQUIRED_MICRO_LANE_IDS.entries()) {
		const batchId = `micro-${index}`;
		const laneId = `micro-lane-${index}`;
		await persistBatch(
			batchId,
			'swarm-pr-review:micro',
			[{ laneId, workflowLane }],
			{
				textOverride: `[CLEAN] | ${workflowLane} | exact reviewed diff | no finding after focused invariant review`,
			},
		);
		triggerRows.push({
			trigger_id: workflowLane,
			result: 'MATCHED',
			source_batch_id: batchId,
			source_lane_id: laneId,
		});
	}
	const triggerRelative = path.join(
		'pr-review',
		'test-run',
		'trigger-eval.json',
	);
	const triggerAbsolute = path.join(tempDir, '.swarm', triggerRelative);
	await fs.mkdir(path.dirname(triggerAbsolute), { recursive: true });
	await fs.writeFile(
		triggerAbsolute,
		JSON.stringify({ rows: triggerRows }),
		'utf-8',
	);
	await markPrReviewTriggerEvaluationComplete(
		tempDir,
		SESSION_ID,
		triggerRelative,
	);
}
