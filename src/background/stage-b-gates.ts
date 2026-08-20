import {
	getTaskWorkflowSnapshot,
	readTaskEvidence,
	recordGateEvidence,
	transitionTaskWorkflowEvidence,
} from '../gate-evidence.js';
import { isMarkdownOnlyTaskChange } from '../gate-evidence-classification.js';
import {
	collectReviewerReceiptFromTranscript,
	type ReviewerReceiptValidationOptions,
} from '../hooks/review-receipt-collector.js';
import {
	captureReviewerScopeFileFingerprint,
	type ReviewerScopeFileFingerprint,
	reviewerScopeCaptureToFingerprint,
	reviewerScopeFileFingerprintsEqual,
} from '../hooks/reviewer-scope-file-fingerprint.js';
import {
	type AgentSessionState,
	advanceTaskState,
	getReviewerScopeGenerationForCoderCall,
	getReviewerScopeOwnershipHistory,
	getTaskState,
	hasActiveTurboMode,
	hasBothStageBCompletions,
	markReviewerScopeGenerationNoChange,
	markReviewerScopeGenerationReady,
	type ReviewerScopeGeneration,
	recordModifiedFilesForTask,
	recordReviewerScopeGenerationFileFingerprint,
	recordStageBCompletion,
	reviewerScopeGenerationHasDeclaredOverlap,
	swarmState,
	updateTaskWorkflowCache,
} from '../state.js';
import * as logger from '../utils/logger.js';
import type {
	BackgroundDelegationRecord,
	BackgroundDelegationResult,
	BackgroundWorkspaceSnapshot,
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

function structuredStageBVerdict(
	role: StageBStateRole,
	text: string,
	taskId: string,
): 'pass' | 'fail' | null {
	const escapedTaskId = taskId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const pattern =
		role === 'reviewer'
			? new RegExp(
					`^\\[REVIEWED\\]\\s*\\|\\s*(?:task-)?${escapedTaskId}\\s*\\|\\s*(APPROVED|REJECTED|CONCERNS)\\s*\\|`,
					'im',
				)
			: new RegExp(
					`^\\[TESTED\\]\\s*\\|\\s*(?:task-)?${escapedTaskId}\\s*\\|\\s*(PASS|FAIL|SKIPPED)\\s*\\|`,
					'im',
				);
	const match = pattern.exec(text);
	if (!match) return null;
	return match[1] === 'APPROVED' || match[1] === 'PASS' ? 'pass' : 'fail';
}

function normalizeAttributionPath(file: string): string | null {
	const normalized = file
		.trim()
		.replaceAll('\\', '/')
		.replace(/^\.\/+/, '');
	const hasControlCharacter = [...normalized].some((character) => {
		const code = character.charCodeAt(0);
		return code <= 31 || code === 127;
	});
	if (
		!normalized ||
		normalized.startsWith('/') ||
		/^[A-Za-z]:\//.test(normalized) ||
		normalized === '..' ||
		normalized.startsWith('../') ||
		normalized.split('/').includes('..') ||
		hasControlCharacter
	) {
		return null;
	}
	return normalized;
}

function normalizedPathSet(
	files: readonly string[] | null,
): Set<string> | null {
	if (!files) return null;
	const normalized = new Set<string>();
	for (const file of files) {
		const candidate = normalizeAttributionPath(file);
		if (!candidate) return null;
		normalized.add(candidate);
	}
	return normalized;
}

function pathSetsEqual(left: Set<string>, right: Set<string>): boolean {
	return left.size === right.size && [...left].every((file) => right.has(file));
}

function hasDistinctBackgroundOwner(input: {
	parentSessionID: string;
	taskId: string;
	coderCallID: string;
	file: string;
	fingerprint: ReviewerScopeFileFingerprint;
	candidateCreatedAt: number;
	candidateCompletedAt: number;
}): boolean {
	if (
		!Number.isFinite(input.candidateCreatedAt) ||
		!Number.isFinite(input.candidateCompletedAt) ||
		input.candidateCreatedAt > input.candidateCompletedAt
	) {
		return false;
	}
	const generations =
		swarmState.agentSessions.get(input.parentSessionID)
			?.reviewerScopeGenerations ?? new Map<string, ReviewerScopeGeneration>();
	const liveOwners = [...generations.values()].filter((generation) => {
		if (
			generation.background !== true ||
			(generation.taskId === input.taskId &&
				generation.coderCallID === input.coderCallID)
		) {
			return false;
		}
		const declared = normalizedPathSet(generation.declaredFiles);
		const routed = normalizedPathSet(generation.modifiedFiles);
		const fingerprints = generation.modifiedFileFingerprints.filter(
			(entry) => normalizeAttributionPath(entry.file) === input.file,
		);
		const ownerCompletedAt = generation.readyAt ?? input.candidateCompletedAt;
		return (
			Number.isFinite(generation.createdAt) &&
			Number.isFinite(ownerCompletedAt) &&
			generation.createdAt <= input.candidateCompletedAt &&
			input.candidateCreatedAt <= ownerCompletedAt &&
			declared?.has(input.file) === true &&
			routed?.has(input.file) === true &&
			fingerprints.length === 1 &&
			reviewerScopeFileFingerprintsEqual(fingerprints[0], input.fingerprint)
		);
	});
	const historicalOwners = getReviewerScopeOwnershipHistory({
		parentSessionID: input.parentSessionID,
	}).filter((owner) => {
		if (
			owner.taskId === input.taskId &&
			owner.coderCallID === input.coderCallID
		) {
			return false;
		}
		const declared = normalizedPathSet(owner.declaredFiles);
		const routed = normalizedPathSet(owner.modifiedFiles);
		const fingerprints = owner.modifiedFileFingerprints.filter(
			(entry) => normalizeAttributionPath(entry.file) === input.file,
		);
		return (
			owner.parentSessionID === input.parentSessionID &&
			owner.background === true &&
			Number.isFinite(owner.createdAt) &&
			Number.isFinite(owner.readyAt) &&
			owner.createdAt <= input.candidateCompletedAt &&
			input.candidateCreatedAt <= owner.readyAt &&
			declared?.has(input.file) === true &&
			routed?.has(input.file) === true &&
			fingerprints.length === 1 &&
			reviewerScopeFileFingerprintsEqual(fingerprints[0], input.fingerprint)
		);
	});
	return liveOwners.length + historicalOwners.length === 1;
}

export interface StageBIngestionResult {
	ok: boolean;
	consumed: boolean;
	stale?: boolean;
	reason?: string;
	/** Typed failure code (issue #2100) — e.g. `capture_failed:<code>`. */
	code?: string;
	/** True when the failure class is transient and bounded retry may recover. */
	retryable?: boolean;
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
	const check = compareStageBWorkspace(record, actualWorkspace);
	return { ...check, ok: !check.stale };
}

export function compareStageBWorkspace(
	record: BackgroundDelegationRecord,
	actualWorkspace: BackgroundWorkspaceSnapshot,
): { stale: boolean; reason?: string } {
	// Reviewer/test roles must observe the exact tree they were dispatched
	// against. A docs agent is different: authoring documentation legitimately
	// changes the dirty-tree digest. Bind it to the same project, Git HEAD, and
	// PR head while allowing those expected uncommitted documentation edits.
	const expectedWorkspace =
		record.normalizedAgent === 'docs' && record.workspace
			? { ...record.workspace, dirtyHash: null }
			: record.workspace;
	return compareWorkspaceSnapshots(expectedWorkspace, actualWorkspace);
}

export async function ingestBackgroundStageBCompletion(args: {
	directory: string;
	record: BackgroundDelegationRecord;
	result: BackgroundDelegationResult;
	reviewerReceiptOptions?: ReviewerReceiptValidationOptions;
}): Promise<StageBIngestionResult> {
	const taskId = args.record.evidenceTaskId ?? args.record.planTaskId;
	if (!taskId) {
		// The trusted terminal completion is still settled in the durable ledger by
		// the caller; it simply has no Stage B evidence/state side effects.
		return { ok: true, consumed: false };
	}

	if (args.record.normalizedAgent === 'coder') {
		const taskChangeContext = args.record.taskChangeContext;
		const settledFiles =
			args.record.coderSettlement?.state === 'settled'
				? args.record.coderSettlement.observedFiles
				: undefined;
		const observedFiles =
			settledFiles !== undefined
				? settledFiles
				: taskChangeContext
					? changedFilesSinceSnapshot(
							taskChangeContext.baseline.directory,
							taskChangeContext.baseline,
						)
					: null;
		if (observedFiles === null) {
			return {
				ok: false,
				consumed: false,
				stale: true,
				reason:
					'background coder files could not be attributed to a clean immutable baseline',
			};
		}
		try {
			const observedSet = normalizedPathSet(observedFiles);
			const declaredSet = normalizedPathSet(
				taskChangeContext?.declaredFiles ?? null,
			);
			const completionTime = args.record.completedAt ?? args.record.updatedAt;
			let attributedFiles = observedFiles ?? [];
			if (args.reviewerReceiptOptions?.config?.enabled !== true) {
				// Without ownership validation, restrict attributed files to the
				// declared scope so concurrent background coders don't cross-attribute.
				if (observedSet && declaredSet) {
					attributedFiles = [...observedSet].filter((file) =>
						declaredSet.has(file),
					);
				}
			}
			if (args.reviewerReceiptOptions?.config?.enabled === true) {
				if (!observedSet || !declaredSet) {
					return {
						ok: false,
						consumed: false,
						reason:
							'background coder changed-file attribution could not be reconstructed exactly',
					};
				}
				attributedFiles = [...observedSet].filter((file) =>
					declaredSet.has(file),
				);
				const generation = getReviewerScopeGenerationForCoderCall({
					parentSessionID: args.record.parentSessionId,
					taskId,
					coderCallID: args.record.callID,
				});
				const generationScope = normalizedPathSet(
					generation?.declaredFiles ?? null,
				);
				const routedFiles = normalizedPathSet(
					generation?.modifiedFiles ?? null,
				);
				const routedFingerprints = generation?.modifiedFileFingerprints ?? null;
				// Issue #2100: a background coder with zero observed files and a
				// zero-route collecting generation is a truthful no-change, not an
				// attribution failure.
				if (
					generation?.status === 'collecting' &&
					generation.background === true &&
					observedSet.size === 0 &&
					routedFiles?.size === 0 &&
					declaredSet
				) {
					if (
						markReviewerScopeGenerationNoChange({
							parentSessionID: args.record.parentSessionId,
							taskId,
							coderCallID: args.record.callID,
						})
					) {
						return { ok: true, consumed: true };
					}
				}
				// Capture from the generation's bound workspace root (the lane
				// for worktree-isolated background coders) with typed results.
				const captureRoot =
					generation?.captureDirectory?.trim() || args.directory;
				const observedFingerprints = new Map<
					string,
					ReviewerScopeFileFingerprint
				>();
				for (const file of observedSet) {
					const captured = captureReviewerScopeFileFingerprint(
						captureRoot,
						file,
					);
					if (captured.kind === 'capture_failed') {
						return {
							ok: false,
							consumed: false,
							code: `capture_failed:${captured.code}`,
							retryable: captured.retryable,
							reason: `background coder post-write fingerprint could not be reconstructed exactly (${captured.code} on ${captured.file})`,
						};
					}
					const fingerprint = reviewerScopeCaptureToFingerprint(captured);
					if (!fingerprint) {
						return {
							ok: false,
							consumed: false,
							code: 'capture_failed:invalid_request',
							retryable: false,
							reason:
								'background coder post-write fingerprint returned an unusable result',
						};
					}
					observedFingerprints.set(file, fingerprint);
				}
				const changedWithinDeclaredScope = new Set(
					[...observedSet].filter(
						(file) => declaredSet.has(file) && generationScope?.has(file),
					),
				);
				const observedOutsideCurrentScope = [...observedSet].filter(
					(file) => !generationScope?.has(file),
				);
				if (
					(generation?.status !== 'collecting' &&
						generation?.status !== 'ready') ||
					generation.background !== true ||
					!generationScope ||
					!routedFiles ||
					!routedFingerprints ||
					routedFiles.size === 0 ||
					!pathSetsEqual(declaredSet, generationScope) ||
					!pathSetsEqual(routedFiles, changedWithinDeclaredScope) ||
					reviewerScopeGenerationHasDeclaredOverlap({
						parentSessionID: args.record.parentSessionId,
						taskId,
						coderCallID: args.record.callID,
						declaredFiles: generation.declaredFiles,
					}) ||
					observedOutsideCurrentScope.some(
						(file) =>
							!hasDistinctBackgroundOwner({
								parentSessionID: args.record.parentSessionId,
								taskId,
								coderCallID: args.record.callID,
								file,
								fingerprint: observedFingerprints.get(file)!,
								candidateCreatedAt: args.record.createdAt,
								candidateCompletedAt: completionTime,
							}),
					) ||
					[...routedFiles].some((file) => {
						const fingerprints = routedFingerprints.filter(
							(entry) => normalizeAttributionPath(entry.file) === file,
						);
						const observedFingerprint = observedFingerprints.get(file);
						return (
							!observedSet.has(file) ||
							!declaredSet.has(file) ||
							!generationScope.has(file) ||
							fingerprints.length !== 1 ||
							!observedFingerprint ||
							!reviewerScopeFileFingerprintsEqual(
								fingerprints[0],
								observedFingerprint,
							)
						);
					})
				) {
					return {
						ok: false,
						consumed: false,
						reason:
							'background coder scope handoff could not be reconstructed exactly',
					};
				}
				attributedFiles = [...routedFiles];
				// Repair path (issue #2100): ingestion re-captured every routed
				// file's exact bytes against the generation's bound root — write
				// them back so the completeness gate at ready-publication sees a
				// fully populated fingerprint set even when a write-time capture
				// transiently failed.
				for (const file of routedFiles) {
					const fingerprint = observedFingerprints.get(file);
					if (fingerprint) {
						recordReviewerScopeGenerationFileFingerprint({
							parentSessionID: args.record.parentSessionId,
							taskId,
							coderCallID: args.record.callID,
							fingerprint,
						});
					}
				}
			}
			const parentSession = swarmState.agentSessions.get(
				args.record.parentSessionId,
			);
			if (parentSession) {
				const state = getTaskState(parentSession, taskId);
				if (
					state !== 'idle' &&
					state !== 'coder_delegated' &&
					state !== 'rework_required'
				) {
					return {
						ok: false,
						consumed: false,
						reason: `background coder completion is late for task ${taskId}: current state is ${state}`,
					};
				}
			}
			const accepted = attributedFiles.length > 0;
			const expectedGeneration =
				args.record.taskChangeContext?.workflowGeneration ?? 0;
			const transitionId = `background-coder:${args.record.correlationId}`;
			const existingEvidence = await readTaskEvidence(args.directory, taskId);
			const existingWorkflow = getTaskWorkflowSnapshot(existingEvidence);
			const alreadyApplied =
				existingWorkflow.authoritative &&
				existingWorkflow.lastTransitionId === transitionId &&
				existingWorkflow.lastOutcome ===
					(accepted ? 'accepted_mutation' : 'dispatch_no_mutation') &&
				existingWorkflow.generation === expectedGeneration + (accepted ? 1 : 0);
			const updated = alreadyApplied
				? existingEvidence!
				: await transitionTaskWorkflowEvidence(
						args.directory,
						taskId,
						accepted
							? {
									type: 'accepted_mutation',
									agentType: 'coder',
									context: {
										testEngineerExempt: isMarkdownOnlyTaskChange(
											taskChangeContext?.declaredFiles,
											attributedFiles,
										),
									},
									expectedGeneration,
									transitionId,
								}
							: {
									type: 'dispatch_no_mutation',
									agentType: 'coder',
									expectedGeneration,
									transitionId,
								},
					);
			if (accepted) {
				const workflow = getTaskWorkflowSnapshot(updated);
				const parentSession = swarmState.agentSessions.get(
					args.record.parentSessionId,
				);
				if (parentSession) {
					if (
						!recordModifiedFilesForTask(parentSession, taskId, attributedFiles)
					) {
						logger.warn(
							`[background] durable coder mutation for ${taskId} exceeded session file-attribution capacity`,
						);
					}
					parentSession.taskWorkflowStates.set(taskId, 'coder_delegated');
					parentSession.stageBCompletion?.delete(taskId);
					parentSession.taskCouncilApproved?.delete(taskId);
					parentSession.taskCouncilWorkflowGeneration?.delete(taskId);
					updateTaskWorkflowCache(parentSession, taskId, workflow);
				}
			}
			if (
				args.reviewerReceiptOptions?.config?.enabled === true &&
				!markReviewerScopeGenerationReady({
					parentSessionID: args.record.parentSessionId,
					taskId,
					coderCallID: args.record.callID,
				})
			) {
				return {
					ok: false,
					consumed: false,
					reason:
						'background coder scope handoff could not be marked ready after evidence persisted',
				};
			}
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
		if (args.record.workflowGeneration === undefined) {
			return {
				ok: false,
				consumed: false,
				reason: `stage-b ingestion failed: TASK_WORKFLOW_GENERATION_REQUIRED for ${taskId}`,
			};
		}
		const existingEvidence = await readTaskEvidence(args.directory, taskId);
		const isStageBRole =
			args.record.normalizedAgent === 'reviewer' ||
			args.record.normalizedAgent === 'test_engineer';
		const stageBRole = isStageBRole
			? (args.record.normalizedAgent as StageBStateRole)
			: null;
		const verdict = stageBRole
			? structuredStageBVerdict(stageBRole, args.result.text ?? '', taskId)
			: null;
		if (stageBRole && verdict !== 'pass') {
			const rejected = await transitionTaskWorkflowEvidence(
				args.directory,
				taskId,
				{
					type: 'stage_b_failed',
					gate: stageBRole,
					expectedGeneration: args.record.workflowGeneration,
					transitionId: `background-gate-failed:${args.record.correlationId}`,
				},
			);
			const parentSession = swarmState.agentSessions.get(
				args.record.parentSessionId,
			);
			if (parentSession) {
				parentSession.taskWorkflowStates.set(taskId, 'rework_required');
				parentSession.stageBCompletion?.delete(taskId);
				updateTaskWorkflowCache(
					parentSession,
					taskId,
					getTaskWorkflowSnapshot(rejected),
				);
			}
			return {
				ok: false,
				consumed: true,
				reason:
					verdict === 'fail'
						? `background ${stageBRole} rejected task ${taskId}`
						: `background ${stageBRole} returned no valid structured verdict for task ${taskId}`,
			};
		}
		await recordGateEvidence(
			args.directory,
			taskId,
			args.record.normalizedAgent,
			args.record.subagentSessionId,
			hasActiveTurboMode(args.record.parentSessionId),
			{
				expectedGeneration: args.record.workflowGeneration,
				transitionId: `background-gate:${args.record.correlationId}`,
				// Missing/non-exempt provenance is conservative: require the full
				// Stage B pair without fabricating a new coder mutation/generation.
				ensureDefaultStageB: existingEvidence?.test_engineer_exempt !== true,
			},
		);

		if (args.record.normalizedAgent === 'reviewer') {
			await collectReviewerReceiptFromTranscript(
				args.directory,
				{
					targetAgent: args.record.swarmPrefixedAgent,
					prompt: args.record.prompt?.text ?? '',
					transcript: args.result.text ?? '',
					// Guardrails records current coder-task scope on the architect
					// parent session, not the returning reviewer child session.
					sessionID: args.record.parentSessionId,
					taskId,
					reviewerCallID: args.record.callID,
					consumeHandoff: true,
				},
				args.reviewerReceiptOptions,
			);
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
