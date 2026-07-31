import { stripKnownSwarmPrefix } from '../config/schema.js';
import { getScopeBindingForParentDispatch } from '../scope/scope-binding.js';
import {
	attachReviewerScopeGenerationDispatchSnapshot,
	claimReviewerScopeGeneration,
	discardReviewerScopeGenerationClaim,
	discardReviewerScopeGenerationForCoderCall,
	isReviewerScopeGenerationCurrent,
	markReviewerScopeGenerationReady,
	peekReadyReviewerScopeGeneration,
	type ReviewerScopeGeneration,
	startReviewerScopeGeneration,
} from '../state.js';
import { normalizeToolName } from './normalize-tool-name.js';
import { computeScopeFingerprint } from './review-receipt.js';
import {
	buildReviewerTaskScope,
	type ReviewerTaskScope,
	resolveReviewerScopeTaskId,
} from './review-receipt-scope.js';
import {
	captureReviewerScopeFileFingerprint,
	MAX_REVIEWER_SCOPE_FINGERPRINT_AGGREGATE_BYTES,
	reviewerScopeFileFingerprintsEqual,
} from './reviewer-scope-file-fingerprint.js';
import { parseDelegationArgs } from './skill-propagation-gate.js';
import { classifyTaskResult } from './task-result-classifier.js';

export type ReviewerScopeLifecycleTransition =
	| 'coder_started'
	| 'coder_ready'
	| 'reviewer_claimed';

function lifecycleTarget(args: unknown): string {
	const delegation = parseDelegationArgs(args);
	return delegation
		? stripKnownSwarmPrefix(delegation.targetAgent).toLowerCase()
		: '';
}

function isTaskTool(tool: unknown): boolean {
	if (typeof tool !== 'string') return false;
	const normalized = normalizeToolName(tool);
	return normalized === 'Task' || normalized === 'task';
}

function generationFingerprintsAreCurrent(
	directory: string,
	generation: ReviewerScopeGeneration,
): boolean {
	const modifiedFiles = generation.modifiedFiles;
	const fingerprints = generation.modifiedFileFingerprints;
	if (
		modifiedFiles.length === 0 ||
		modifiedFiles.length !== fingerprints.length ||
		new Set(modifiedFiles).size !== modifiedFiles.length ||
		new Set(fingerprints.map((entry) => entry.file)).size !==
			fingerprints.length
	) {
		return false;
	}
	let fingerprintBytes = 0;
	for (const file of modifiedFiles) {
		const stored = fingerprints.filter((entry) => entry.file === file);
		const current = captureReviewerScopeFileFingerprint(
			directory,
			file,
			MAX_REVIEWER_SCOPE_FINGERPRINT_AGGREGATE_BYTES - fingerprintBytes,
		);
		if (
			stored.length !== 1 ||
			!current ||
			!reviewerScopeFileFingerprintsEqual(stored[0], current)
		) {
			return false;
		}
		if (current.kind === 'file') fingerprintBytes += current.size;
	}
	return true;
}

function scopeMatchesGenerationFingerprints(
	scope: ReviewerTaskScope,
	generation: ReviewerScopeGeneration,
): boolean {
	const records = new Map<string, Record<string, unknown>>();
	for (const line of scope.content.split('\n').slice(1)) {
		if (!line) continue;
		try {
			const parsed = JSON.parse(line) as Record<string, unknown>;
			if (typeof parsed.path === 'string') records.set(parsed.path, parsed);
		} catch {
			return false;
		}
	}
	if (
		records.size !== generation.modifiedFileFingerprints.length ||
		scope.files.length !== generation.modifiedFiles.length
	) {
		return false;
	}
	return generation.modifiedFileFingerprints.every((fingerprint) => {
		const record = records.get(fingerprint.file);
		if (!record) return false;
		return fingerprint.kind === 'deleted'
			? record.state === 'deleted'
			: record.state === 'file' &&
					record.bytes === fingerprint.size &&
					record.sha256 === fingerprint.hash;
	});
}

/** Run only after the complete blocking before-chain approved this Task call. */
export async function beginApprovedReviewerScopeLifecycle(input: {
	directory: string;
	tool: unknown;
	args: unknown;
	parentSessionID: string;
	callID: string;
	maxBytes?: number;
}): Promise<ReviewerScopeLifecycleTransition | null> {
	if (!isTaskTool(input.tool)) return null;
	const taskId = await resolveReviewerScopeTaskId(input.directory, input.args);
	if (!taskId) return null;
	const target = lifecycleTarget(input.args);
	if (target === 'coder') {
		const binding = getScopeBindingForParentDispatch({
			parentSessionId: input.parentSessionID,
			dispatchCallId: input.callID,
		});
		if (binding?.taskId !== taskId) return null;
		const rawArgs =
			input.args && typeof input.args === 'object'
				? (input.args as Record<string, unknown>)
				: null;
		return startReviewerScopeGeneration({
			parentSessionID: input.parentSessionID,
			taskId,
			coderCallID: input.callID,
			background:
				rawArgs?.background === true || rawArgs?.background === 'true',
			declaredFiles: binding.files,
		})
			? 'coder_started'
			: null;
	}
	if (target === 'reviewer') {
		const ready = peekReadyReviewerScopeGeneration({
			parentSessionID: input.parentSessionID,
			taskId,
		});
		if (!ready || !generationFingerprintsAreCurrent(input.directory, ready)) {
			if (ready) {
				discardReviewerScopeGenerationForCoderCall({
					parentSessionID: input.parentSessionID,
					taskId,
					coderCallID: ready.coderCallID,
				});
			}
			throw new Error(
				'REVIEWER_SCOPE_STALE: coder post-write fingerprints are incomplete or changed before reviewer dispatch',
			);
		}
		const snapshot = await buildReviewerTaskScope(
			input.directory,
			ready.modifiedFiles,
			input.maxBytes,
			{
				taskId: ready.taskId,
				coderCallID: ready.coderCallID,
				generation: ready.generation,
				sessionIncarnation: ready.sessionIncarnation,
			},
		);
		const current = peekReadyReviewerScopeGeneration({
			parentSessionID: input.parentSessionID,
			taskId,
		});
		const exactGenerationStillCurrent =
			current !== null &&
			current.coderCallID === ready.coderCallID &&
			current.generation === ready.generation &&
			current.sessionIncarnation === ready.sessionIncarnation &&
			isReviewerScopeGenerationCurrent({
				parentSessionID: input.parentSessionID,
				taskId,
				coderCallID: ready.coderCallID,
				generation: ready.generation,
				sessionIncarnation: ready.sessionIncarnation,
			});
		if (
			!snapshot ||
			!current ||
			!exactGenerationStillCurrent ||
			!generationFingerprintsAreCurrent(input.directory, current) ||
			!scopeMatchesGenerationFingerprints(snapshot, current)
		) {
			discardReviewerScopeGenerationForCoderCall({
				parentSessionID: input.parentSessionID,
				taskId,
				coderCallID: ready.coderCallID,
			});
			throw new Error(
				'REVIEWER_SCOPE_STALE: exact reviewer dispatch scope changed during capture',
			);
		}
		// No await is permitted between the final byte/generation recheck above
		// and the exact claim plus immutable dispatch binding below.
		const claimed = claimReviewerScopeGeneration({
			parentSessionID: input.parentSessionID,
			taskId,
			reviewerCallID: input.callID,
		});
		if (
			!claimed ||
			claimed.coderCallID !== ready.coderCallID ||
			claimed.generation !== ready.generation ||
			claimed.sessionIncarnation !== ready.sessionIncarnation ||
			!attachReviewerScopeGenerationDispatchSnapshot({
				parentSessionID: input.parentSessionID,
				taskId,
				reviewerCallID: input.callID,
				snapshot: {
					hash: computeScopeFingerprint(snapshot.content, snapshot.description)
						.hash,
					description: snapshot.description,
					files: [...snapshot.files],
					headSha: snapshot.headSha,
					taskId: claimed.taskId,
					coderCallID: claimed.coderCallID,
					generation: claimed.generation,
					sessionIncarnation: claimed.sessionIncarnation,
				},
			})
		) {
			discardReviewerScopeGenerationClaim({
				parentSessionID: input.parentSessionID,
				taskId,
				reviewerCallID: input.callID,
			});
			throw new Error(
				'REVIEWER_SCOPE_STALE: exact reviewer dispatch scope could not be captured',
			);
		}
		return 'reviewer_claimed';
	}
	return null;
}

/** Mark a synchronous coder terminal; background running placeholders are inert. */
export async function completeReviewerScopeLifecycle(input: {
	directory: string;
	tool: unknown;
	args: unknown;
	output: unknown;
	parentSessionID: string;
	callID: string;
}): Promise<ReviewerScopeLifecycleTransition | null> {
	if (!isTaskTool(input.tool)) return null;
	if (lifecycleTarget(input.args) !== 'coder') return null;
	const result = classifyTaskResult(input.output);
	if (result === 'running') return null;
	const taskId = await resolveReviewerScopeTaskId(input.directory, input.args);
	if (!taskId) {
		discardReviewerScopeGenerationForCoderCall({
			parentSessionID: input.parentSessionID,
			coderCallID: input.callID,
		});
		return null;
	}
	if (result === 'non_success') {
		discardReviewerScopeGenerationForCoderCall({
			parentSessionID: input.parentSessionID,
			taskId,
			coderCallID: input.callID,
		});
		return null;
	}
	return markReviewerScopeGenerationReady({
		parentSessionID: input.parentSessionID,
		taskId,
		coderCallID: input.callID,
	})
		? 'coder_ready'
		: null;
}
