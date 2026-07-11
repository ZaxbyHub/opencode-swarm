import {
	readTaskEvidence,
	recordAgentDispatch,
	recordGateEvidence,
} from '../gate-evidence.js';
import { isMarkdownOnlyTaskChange } from '../gate-evidence-classification.js';
import { collectReviewerReceiptFromTranscript } from '../hooks/review-receipt-collector.js';
import {
	type AgentSessionState,
	advanceTaskState,
	getTaskState,
	hasActiveTurboMode,
	hasBothStageBCompletions,
	recordStageBCompletion,
	swarmState,
} from '../state.js';
import * as logger from '../utils/logger.js';
import type {
	BackgroundDelegationRecord,
	BackgroundDelegationResult,
} from './pending-delegations.js';
import {
	captureWorkspaceSnapshot,
	changedFilesSinceSnapshot,
	compareWorkspaceSnapshots,
} from './workspace-snapshot.js';

const GATE_EVIDENCE_ROLES = new Set([
	'reviewer',
	'test_engineer',
	'docs',
	'designer',
	'critic',
	'critic_sounding_board',
	'critic_drift_verifier',
	'critic_hallucination_verifier',
	'critic_architecture_supervisor',
	'explorer',
	'sme',
]);
// Only reviewer/test_engineer advance the live task state machine. The broader
// set above records gate evidence for other gate-bearing background roles.

type StageBStateRole = 'reviewer' | 'test_engineer';

export interface StageBIngestionResult {
	ok: boolean;
	consumed: boolean;
	stale?: boolean;
	reason?: string;
}

export function isBackgroundGateBearingRecord(
	record: BackgroundDelegationRecord,
): boolean {
	return (
		record.batchId === undefined &&
		record.evidenceTaskId !== null &&
		GATE_EVIDENCE_ROLES.has(record.normalizedAgent)
	);
}

export function validateStageBWorkspace(
	directory: string,
	record: BackgroundDelegationRecord,
): { ok: boolean; stale: boolean; reason?: string } {
	const actualWorkspace = captureWorkspaceSnapshot(directory, {
		scope: record.workspace?.scope ?? null,
		prHeadSha: record.workspace?.prHeadSha ?? null,
		resolveCurrentPrHeadSha: record.workspace?.prHeadSha !== null,
	});
	const check = compareWorkspaceSnapshots(record.workspace, actualWorkspace);
	return { ...check, ok: !check.stale };
}

export async function ingestBackgroundStageBCompletion(args: {
	directory: string;
	record: BackgroundDelegationRecord;
	result: BackgroundDelegationResult;
}): Promise<StageBIngestionResult> {
	const taskId = args.record.evidenceTaskId ?? args.record.planTaskId;
	if (!taskId) {
		// The trusted terminal completion is still settled in the durable ledger by
		// the caller; it simply has no Stage B evidence/state side effects.
		return { ok: true, consumed: false };
	}

	if (args.record.normalizedAgent === 'coder') {
		const taskChangeContext = args.record.taskChangeContext;
		const observedFiles = taskChangeContext
			? changedFilesSinceSnapshot(
					taskChangeContext.baseline.directory,
					taskChangeContext.baseline,
				)
			: null;
		try {
			await recordAgentDispatch(args.directory, taskId, 'coder', undefined, {
				testEngineerExempt: isMarkdownOnlyTaskChange(
					taskChangeContext?.declaredFiles,
					observedFiles,
				),
			});
			return { ok: true, consumed: true };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return {
				ok: false,
				consumed: false,
				reason: `background coder evidence ingestion failed: ${message}`,
			};
		}
	}

	if (!isBackgroundGateBearingRecord(args.record)) {
		return { ok: true, consumed: false };
	}

	const workspaceCheck = validateStageBWorkspace(args.directory, args.record);
	if (workspaceCheck.stale) {
		return {
			ok: false,
			consumed: false,
			stale: true,
			reason:
				workspaceCheck.reason ?? 'workspace changed while gate was running',
		};
	}

	try {
		const existingEvidence = await readTaskEvidence(args.directory, taskId);
		if (existingEvidence?.test_engineer_exempt !== true) {
			// Legacy/missing coder provenance fails closed to the full Stage B pair.
			await recordAgentDispatch(
				args.directory,
				taskId,
				stageBRequiredGateAgent(args.record.normalizedAgent),
				hasActiveTurboMode(args.record.parentSessionId),
			);
		}
		await recordGateEvidence(
			args.directory,
			taskId,
			args.record.normalizedAgent,
			args.record.subagentSessionId,
			hasActiveTurboMode(args.record.parentSessionId),
		);

		if (args.record.normalizedAgent === 'reviewer') {
			await collectReviewerReceiptFromTranscript(args.directory, {
				targetAgent: args.record.swarmPrefixedAgent,
				prompt: args.record.prompt?.text ?? '',
				transcript: args.result.text ?? '',
				sessionID: args.record.subagentSessionId,
			});
		}

		if (
			args.record.normalizedAgent === 'reviewer' ||
			args.record.normalizedAgent === 'test_engineer'
		) {
			applyStageBStateCompletion(
				taskId,
				args.record.normalizedAgent,
				args.record.parentSessionId,
				existingEvidence?.test_engineer_exempt === true,
			);
		}

		return { ok: true, consumed: true };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		logger.warn(`[background-stage-b] ingestion failed: ${message}`);
		return {
			ok: false,
			consumed: false,
			reason: `stage-b ingestion failed: ${message}`,
		};
	}
}

function stageBRequiredGateAgent(agent: string): string {
	return agent === 'reviewer' || agent === 'test_engineer' ? 'coder' : agent;
}

function candidateSessions(parentSessionId: string): AgentSessionState[] {
	const parent = swarmState.agentSessions.get(parentSessionId);
	return parent ? [parent] : [];
}

function applyStageBStateCompletion(
	taskId: string,
	agent: StageBStateRole,
	parentSessionId: string,
	testEngineerExempt: boolean,
): void {
	for (const session of candidateSessions(parentSessionId)) {
		recordStageBCompletion(session, taskId, agent);
		const state = getTaskState(session, taskId);
		if (state === 'tests_run' || state === 'complete') continue;

		if (
			hasBothStageBCompletions(session, taskId) ||
			(testEngineerExempt && agent === 'reviewer')
		) {
			try {
				if (state === 'coder_delegated' || state === 'pre_check_passed') {
					advanceTaskState(session, taskId, 'reviewer_run', {
						telemetrySessionId: parentSessionId,
					});
				}
				if (getTaskState(session, taskId) === 'reviewer_run') {
					advanceTaskState(session, taskId, 'tests_run', {
						telemetrySessionId: parentSessionId,
					});
				}
			} catch (err) {
				logger.warn(
					`[background-stage-b] could not advance ${taskId} after ${agent}: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
			continue;
		}

		if (
			agent === 'reviewer' &&
			(state === 'coder_delegated' || state === 'pre_check_passed')
		) {
			try {
				advanceTaskState(session, taskId, 'reviewer_run', {
					telemetrySessionId: parentSessionId,
				});
			} catch (err) {
				logger.warn(
					`[background-stage-b] could not advance ${taskId} to reviewer_run: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		} else if (agent === 'test_engineer' && state === 'reviewer_run') {
			try {
				advanceTaskState(session, taskId, 'tests_run', {
					telemetrySessionId: parentSessionId,
				});
			} catch (err) {
				logger.warn(
					`[background-stage-b] could not advance ${taskId} to tests_run: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}
	}
}
