import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { storeLaneOutput } from '../../src/background/lane-output-store.js';
import {
	appendDelegationTransition,
	type BackgroundDelegationResult,
	claimTerminalResult,
	recordPendingDelegation,
} from '../../src/background/pending-delegations.js';
import type { PrReviewResultReceipt } from '../../src/background/pr-review-contract.js';
import {
	activatePrWorkflow,
	enforcePrReviewBaseDimensions,
	markPrReviewTriggerEvaluationComplete,
	PR_REVIEW_BASE_DIMENSION_IDS,
	PR_REVIEW_REQUIRED_MICRO_LANE_IDS,
	recordPrReviewValidationBatch,
} from '../../src/hooks/pr-workflow-gate.js';
import { executeWritePrReviewArtifact } from '../../src/tools/write-pr-review-artifact.js';
import { LEGACY_PR_REVIEW_RESILIENCE_POLICY } from '../unit/pr-review-test-policy.js';

export const PR_ARTIFACT_SESSION_ID = 'write-pr-review-artifact';
export const PR_ARTIFACT_HEAD_SHA = 'abc123';
export const PR_ARTIFACT_REVISION_DIGEST = 'revision-1';

const MICRO_CANDIDATE_HEADER =
	'[CANDIDATE] | candidate_id | micro_lane | severity | category | file:line | claim | invariant_violated | evidence_summary | confidence | risk_impact | risk_tags';
const BASE_CANDIDATE_HEADER =
	'[CANDIDATE] | candidate_id | lane | severity | category | file:line | claim | evidence_summary | impact_context | confidence | risk_impact | risk_tags';

/**
 * Typed risk metadata for reviewer rows and CONFIRMED records (issue #2383).
 * CONFIRMED MEDIUM keeps its historical critic-routing intent by declaring
 * `HIGH_IMPACT` (the old contract routed every CONFIRMED MEDIUM); every other
 * fixture shape uses `ORDINARY` with no tags — CRITICAL/HIGH still route on
 * severity alone and LOW/INFO/NONE were never critic-routed.
 */
function fixtureRiskImpact(
	classification: string,
	severity: string,
): 'ORDINARY' | 'HIGH_IMPACT' {
	return classification === 'CONFIRMED' && severity === 'MEDIUM'
		? 'HIGH_IMPACT'
		: 'ORDINARY';
}

/**
 * Shared lane-persistence fixture for `write_pr_review_artifact` tests. These
 * helpers own no lifecycle: they never touch `_test_exports`, install no
 * beforeEach/afterEach, and create no directory — every importing test file
 * keeps its own `_test_exports` snapshot/restore and its own temp root.
 */
export async function persistPrReviewBatch(
	directory: string,
	batchId: string,
	mode: string,
	lanes: ReadonlyArray<{
		laneId: string;
		workflowLane: string;
		ownedWorkflowLanes?: string[];
	}>,
	options: {
		status?: 'pending' | 'running' | 'completed' | 'error';
		head?: string;
		empty?: boolean;
		textOverride?: string;
		transcriptIncomplete?: boolean;
		artifactRole?: string;
		subagentSessionId?: string;
		/** Severity the generated `[CANDIDATE]` rows declare. Default HIGH. */
		candidateSeverity?: 'INFO' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
		/**
		 * Emit a per-lane `[CLEAN]` attestation instead of a `[CANDIDATE]` row, so
		 * the lane settles with zero findings.
		 */
		cleanPerLane?: boolean;
		/**
		 * Override the generated candidate_id of lane 0's row. `candidate_id` is
		 * unconstrained free text, so a lane can name a real finding after the
		 * synthetic `CLEAN-REVIEW` sentinel; this lets a test prove the gate still
		 * compares such a record against ITS OWN row (issue #2320).
		 */
		firstCandidateId?: string;
		workflowLaneFailureClass?: 'contract' | 'resource' | 'deadline';
		prReviewLegacyTranscriptCompatibility?: boolean;
		prReviewResultReceipt?: PrReviewResultReceipt;
	} = {},
): Promise<void> {
	const legacyTranscriptCompatibility =
		options.prReviewLegacyTranscriptCompatibility ??
		(mode === 'swarm-pr-review:base' || mode === 'swarm-pr-review:micro'
			? true
			: undefined);
	for (const [index, lane] of lanes.entries()) {
		const correlationId = `${batchId}-${index}`;
		const subagentSessionId = options.subagentSessionId ?? correlationId;
		await recordPendingDelegation(directory, {
			correlationId,
			jobId: null,
			subagentSessionId,
			parentSessionId: PR_ARTIFACT_SESSION_ID,
			callID: `call-${correlationId}`,
			normalizedAgent: 'reviewer',
			swarmPrefixedAgent: 'reviewer',
			planTaskId: null,
			evidenceTaskId: null,
			batchId,
			laneId: lane.laneId,
			mode,
			workflowLane: lane.workflowLane,
			...(lane.ownedWorkflowLanes?.length
				? { ownedWorkflowLanes: lane.ownedWorkflowLanes }
				: {}),
			workspace: {
				directory,
				gitHead: PR_ARTIFACT_HEAD_SHA,
				dirtyHash: null,
				prHeadSha: options.head ?? PR_ARTIFACT_HEAD_SHA,
				scope: null,
			},
			...(legacyTranscriptCompatibility !== undefined
				? {
						prReviewLegacyTranscriptCompatibility:
							legacyTranscriptCompatibility,
					}
				: {}),
		});
		const text =
			options.textOverride ??
			(options.cleanPerLane
				? `${BASE_CANDIDATE_HEADER}\n[CLEAN] | ${lane.workflowLane} | exact reviewed diff | no actionable finding survived triage`
				: undefined) ??
			(options.empty
				? ''
				: mode === 'swarm-pr-review:reviewer'
					? '[REVIEWED] | C-001 | CONFIRMED | STRUCTURALLY_PROVEN | HIGH | YES | file.ts:1 | rationale | probe | reviewer | ORDINARY | '
					: mode === 'swarm-pr-review:critic'
						? '[CRITIC] | C-001 | UPHELD | HIGH | reason | no change'
						: mode === 'swarm-pr-feedback:verification'
							? `[FEEDBACK-VERIFIED] | ${lane.workflowLane} | CONFIRMED | evidence`
							: `${mode === 'swarm-pr-review:micro' ? MICRO_CANDIDATE_HEADER : BASE_CANDIDATE_HEADER}\n${index === 0 && options.firstCandidateId ? options.firstCandidateId : `C-${index}`} | ${lane.workflowLane} | ${options.candidateSeverity ?? 'HIGH'} | correctness | file.ts:1 | claim | evidence | impact | HIGH | UNKNOWN | `);
		const stored = storeLaneOutput(directory, {
			batchId,
			laneId: lane.laneId,
			agent: 'reviewer',
			role: options.artifactRole ?? 'reviewer',
			sessionId: subagentSessionId,
			parentSessionId: PR_ARTIFACT_SESSION_ID,
			mode,
			workflowLane: lane.workflowLane,
			prHeadSha: options.head ?? PR_ARTIFACT_HEAD_SHA,
			gitHead: PR_ARTIFACT_HEAD_SHA,
			revisionDigest: PR_ARTIFACT_REVISION_DIGEST,
			source: 'collect_lane_results',
			text,
			transcriptIncomplete: options.transcriptIncomplete,
		});
		const result: BackgroundDelegationResult = {
			text,
			chars: stored.chars,
			truncated: false,
			digest: stored.digest,
			...(stored.ref ? { outputRef: stored.ref } : {}),
			...(options.transcriptIncomplete ? { transcriptIncomplete: true } : {}),
			...(options.prReviewResultReceipt
				? { prReviewResultReceipt: options.prReviewResultReceipt }
				: {}),
			...(options.workflowLaneFailureClass
				? {
						workflowLaneFailureClass: options.workflowLaneFailureClass,
					}
				: {}),
		};
		if (options.workflowLaneFailureClass) {
			await claimTerminalResult(directory, correlationId, {
				eventId: `fixture-terminal-${correlationId}`,
				status: options.status ?? 'completed',
				recordedAt: Date.now(),
				result,
			});
		} else {
			await appendDelegationTransition(directory, correlationId, {
				status: options.status ?? 'completed',
				result,
			});
		}
	}
}

/**
 * Drives the gate through base settlement, all eleven micro lanes, and trigger
 * evaluation so a findings boundary write is admissible. Candidate inventory is
 * the six base candidates C-0..C-5 (base lanes each contribute one candidate).
 */
export async function establishPrReviewPrerequisites(
	directory: string,
	runId: string = 'test-run',
	sessionID: string = PR_ARTIFACT_SESSION_ID,
	headSha: string = PR_ARTIFACT_HEAD_SHA,
	options: {
		skipTriggerEvaluation?: boolean;
		/** Severity the base lanes' `[CANDIDATE]` rows declare. Default HIGH. */
		candidateSeverity?: 'INFO' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
		/** Override lane 0's generated candidate_id (sentinel-spoofing tests). */
		firstCandidateId?: string;
		/**
		 * Base lanes emit a per-lane `[CLEAN]` attestation instead of a candidate
		 * row, so discovery finds NOTHING and the inventory collapses to the
		 * mechanically derived `CLEAN-REVIEW` sentinel.
		 */
		zeroCandidates?: boolean;
	} = {},
): Promise<void> {
	await activatePrWorkflow(directory, sessionID, 'PR_REVIEW', {
		prHeadSha: headSha,
	});
	const baseLanes = PR_REVIEW_BASE_DIMENSION_IDS.map((workflowLane) => ({
		laneId: workflowLane,
		workflowLane,
	}));
	await enforcePrReviewBaseDimensions(directory, sessionID, baseLanes, {
		batchId: 'base-all',
		prHeadSha: headSha,
		prReviewResiliencePolicy: LEGACY_PR_REVIEW_RESILIENCE_POLICY,
	});
	await persistPrReviewBatch(
		directory,
		'base-all',
		'swarm-pr-review:base',
		baseLanes,
		{
			candidateSeverity: options.candidateSeverity,
			cleanPerLane: options.zeroCandidates,
			firstCandidateId: options.firstCandidateId,
		},
	);
	for (const [
		index,
		workflowLane,
	] of PR_REVIEW_REQUIRED_MICRO_LANE_IDS.entries()) {
		const batchId = `micro-${index}`;
		const laneId = `micro-lane-${index}`;
		await persistPrReviewBatch(
			directory,
			batchId,
			'swarm-pr-review:micro',
			[{ laneId, workflowLane }],
			{
				textOverride: `${MICRO_CANDIDATE_HEADER}\n[CLEAN] | ${workflowLane} | exact reviewed diff | no finding after focused invariant review`,
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
			evidence: `Test fixture evidence for ${workflowLane}`,
			source_batch_id: `micro-${index}`,
			source_lane_id: `micro-lane-${index}`,
		});
	}
	const triggerRelative = path.join('pr-review', runId, 'trigger-eval.json');
	const triggerAbsolute = path.join(directory, '.swarm', triggerRelative);
	await fs.mkdir(path.dirname(triggerAbsolute), { recursive: true });
	await fs.writeFile(
		triggerAbsolute,
		JSON.stringify({ rows: triggerRows }),
		'utf-8',
	);
	if (options.skipTriggerEvaluation) return;
	await markPrReviewTriggerEvaluationComplete(
		directory,
		sessionID,
		runId,
		triggerRelative,
	);
}

export function reviewedRow(
	id: string,
	classification: string,
	severity: string,
): string {
	return `[REVIEWED] | ${id} | ${classification} | STRUCTURALLY_PROVEN | ${severity} | YES | file.ts:1 | rationale text | probe output | reviewer | ${fixtureRiskImpact(classification, severity)} | `;
}

export async function settleReviewerPhase(
	directory: string,
	runId: string,
	rows: readonly string[],
	itemIds: readonly string[],
): Promise<void> {
	await recordPrReviewValidationBatch(
		directory,
		PR_ARTIFACT_SESSION_ID,
		'reviewer',
		[
			{
				laneId: `${runId}-rv`,
				workflowLane: `${runId}-rv`,
				reviewItemIds: [...itemIds],
			},
		],
		{ batchId: `${runId}-rv`, prHeadSha: PR_ARTIFACT_HEAD_SHA },
	);
	await persistPrReviewBatch(
		directory,
		`${runId}-rv`,
		'swarm-pr-review:reviewer',
		[{ laneId: `${runId}-rv`, workflowLane: `${runId}-rv` }],
		{ textOverride: rows.join('\n') },
	);
}

export async function settleCriticPhase(
	directory: string,
	runId: string,
	rows: readonly string[],
	itemIds: readonly string[],
): Promise<void> {
	await recordPrReviewValidationBatch(
		directory,
		PR_ARTIFACT_SESSION_ID,
		'critic',
		[
			{
				laneId: `${runId}-cr`,
				workflowLane: `${runId}-cr`,
				reviewItemIds: [...itemIds],
			},
		],
		{ batchId: `${runId}-cr`, prHeadSha: PR_ARTIFACT_HEAD_SHA },
	);
	await persistPrReviewBatch(
		directory,
		`${runId}-cr`,
		'swarm-pr-review:critic',
		[{ laneId: `${runId}-cr`, workflowLane: `${runId}-cr` }],
		{ textOverride: rows.join('\n') },
	);
}

export type ArtifactRecord = {
	finding_id: string;
	status: 'PENDING' | 'CONFIRMED' | 'DISPROVED' | 'PRE_EXISTING';
	file_line: string;
	evidence: string;
	next_action:
		| 'route_to_reviewer'
		| 'route_to_critic'
		| 'report'
		| 'suppress_with_reason'
		| 'handoff_to_feedback';
	severity?: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO' | 'NONE';
	risk_impact?: 'ORDINARY' | 'HIGH_IMPACT' | 'UNKNOWN';
	risk_tags?: string[];
};

export function artifactRecord(
	id: string,
	status: ArtifactRecord['status'],
	nextAction: ArtifactRecord['next_action'],
	severity: NonNullable<ArtifactRecord['severity']>,
): ArtifactRecord {
	return {
		finding_id: id,
		status,
		file_line: 'src/index.ts:1',
		evidence: 'validator-errors fixture evidence',
		next_action: nextAction,
		severity,
		// A CONFIRMED record must carry the typed risk metadata of the reviewer
		// row it projects (issue #2383 write boundary); the values mirror
		// `reviewedRow` so records and rows stay coherent.
		...(status === 'CONFIRMED'
			? {
					risk_impact: fixtureRiskImpact('CONFIRMED', severity),
					risk_tags: [] as string[],
				}
			: {}),
	};
}

export function artifactRecordWithoutSeverity(
	id: string,
	status: ArtifactRecord['status'],
	nextAction: ArtifactRecord['next_action'],
	/**
	 * Severity of the authoritative reviewer row, used ONLY to derive the typed
	 * risk metadata a CONFIRMED record must carry (issue #2383). The record
	 * itself still omits `severity` — that is the condition under test.
	 */
	severityHint?: NonNullable<ArtifactRecord['severity']>,
): ArtifactRecord {
	return {
		finding_id: id,
		status,
		file_line: 'src/index.ts:1',
		evidence: 'validator-errors fixture evidence',
		next_action: nextAction,
		...(status === 'CONFIRMED'
			? {
					risk_impact: fixtureRiskImpact('CONFIRMED', severityHint ?? 'LOW'),
					risk_tags: [] as string[],
				}
			: {}),
	};
}

export function writePrReviewFindings(
	directory: string,
	runId: string,
	boundary: 'post_explorer' | 'post_reviewer' | 'post_critic',
	records: readonly ArtifactRecord[],
): Promise<string> {
	return executeWritePrReviewArtifact(
		{
			kind: 'findings',
			run_id: runId,
			pr_head_sha: PR_ARTIFACT_HEAD_SHA,
			boundary,
			records,
		},
		directory,
		{ sessionID: PR_ARTIFACT_SESSION_ID },
	);
}

export async function rejectionMessage(
	promise: Promise<string>,
): Promise<string> {
	try {
		const result = JSON.parse(await promise) as {
			success?: boolean;
			message?: string;
		};
		if (result.success === false && result.message) return result.message;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	throw new Error('expected the artifact write to be rejected');
}
