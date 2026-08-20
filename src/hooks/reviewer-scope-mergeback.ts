/**
 * Merge-back verification for lane-captured reviewer generations (issue #2100
 * contract D).
 *
 * A lane generation is only reviewable from the primary checkout after every
 * manifest file (including deletions) matches the lane manifest in the primary
 * root. Verification re-captures each file from the PRIMARY directory with the
 * shared exact-byte capture and compares against the generation's stored
 * fingerprints. A conflict, deferred merge, or changed byte produces a typed
 * retained state (`mergeback_mismatch`) — never a generic reviewer-stale
 * relabel and never a discard.
 */

import { canonicalWorkspaceIdentity } from '../scope/scope-binding.js';
import {
	ensureAgentSession,
	getReviewerScopeGenerationForCoderCall,
	markReviewerScopeGenerationMergebackPending,
	settleReviewerScopeMergeback,
} from '../state.js';
import { pushAdvisory } from '../utils/advisory-queue.js';
import {
	captureReviewerScopeFileFingerprint,
	REVIEWER_SCOPE_CAPTURE_BATCH_DEADLINE_MS,
	reviewerScopeCaptureToFingerprint,
	reviewerScopeFileFingerprintsEqual,
} from './reviewer-scope-file-fingerprint.js';

/**
 * Best-effort synchronous verification. Never throws: an unexpected error is
 * recorded as a typed mismatch so the generation stays actionable.
 */
export function verifyReviewerScopeGenerationMergeBack(input: {
	parentSessionID: string;
	taskId: string;
	coderCallID: string;
	primaryDirectory: string;
	now?: number;
}): void {
	try {
		const generation = getReviewerScopeGenerationForCoderCall({
			parentSessionID: input.parentSessionID,
			taskId: input.taskId,
			coderCallID: input.coderCallID,
			now: input.now,
		});
		if (!generation || generation.modifiedFiles.length === 0) return;
		if (
			generation.status !== 'collecting' &&
			generation.status !== 'mergeback_pending'
		) {
			return;
		}
		if (generation.status === 'collecting') {
			// Merge-back settled before the completion lifecycle ran; move the
			// generation to the pending state this verifier owns.
			if (
				!markReviewerScopeGenerationMergebackPending({
					parentSessionID: input.parentSessionID,
					taskId: input.taskId,
					coderCallID: input.coderCallID,
					at: input.now,
				})
			) {
				return;
			}
		}
		const session = ensureAgentSession(input.parentSessionID);
		const deadlineAt =
			(input.now ?? Date.now()) + REVIEWER_SCOPE_CAPTURE_BATCH_DEADLINE_MS;
		for (const file of generation.modifiedFiles) {
			const stored = generation.modifiedFileFingerprints.find(
				(entry) => entry.file === file,
			);
			if (!stored) {
				settleReviewerScopeMergeback({
					parentSessionID: input.parentSessionID,
					taskId: input.taskId,
					coderCallID: input.coderCallID,
					outcome: {
						verified: false,
						reason: `incomplete fingerprints: ${file} has no stored capture`,
						at: input.now,
					},
				});
				pushAdvisory(
					session,
					`REVIEWER_SCOPE_MERGEBACK_MISMATCH: task ${input.taskId}: merge-back verification found no stored fingerprint for ${file}. ACTION[architect]: re-dispatch the coder for this task`,
				);
				return;
			}
			const captured = captureReviewerScopeFileFingerprint(
				input.primaryDirectory,
				file,
				{ deadlineAt },
			);
			if (captured.kind === 'capture_failed') {
				settleReviewerScopeMergeback({
					parentSessionID: input.parentSessionID,
					taskId: input.taskId,
					coderCallID: input.coderCallID,
					outcome: {
						verified: false,
						reason: `capture ${captured.code} on ${captured.file}`,
						at: input.now,
					},
				});
				pushAdvisory(
					session,
					`REVIEWER_SCOPE_MERGEBACK_MISMATCH: task ${input.taskId}: primary-checkout capture failed for ${captured.file} (${captured.code}). ACTION[architect]: verify the primary checkout, then re-dispatch the reviewer`,
				);
				return;
			}
			const capturedFingerprint = reviewerScopeCaptureToFingerprint(captured);
			if (
				!capturedFingerprint ||
				!reviewerScopeFileFingerprintsEqual(stored, capturedFingerprint)
			) {
				settleReviewerScopeMergeback({
					parentSessionID: input.parentSessionID,
					taskId: input.taskId,
					coderCallID: input.coderCallID,
					outcome: {
						verified: false,
						reason: `primary bytes differ from lane manifest on ${file}`,
						at: input.now,
					},
				});
				pushAdvisory(
					session,
					`REVIEWER_SCOPE_MERGEBACK_MISMATCH: task ${input.taskId}: primary-checkout bytes differ from the lane manifest on ${file}; lane evidence retained. ACTION[architect]: resolve the merge conflict or re-dispatch the coder`,
				);
				return;
			}
		}
		const primaryIdentity = canonicalWorkspaceIdentity(input.primaryDirectory);
		settleReviewerScopeMergeback({
			parentSessionID: input.parentSessionID,
			taskId: input.taskId,
			coderCallID: input.coderCallID,
			outcome: {
				verified: true,
				primaryWorkspaceIdentity: primaryIdentity ?? input.primaryDirectory,
				primaryDirectory: input.primaryDirectory,
				at: input.now,
			},
		});
		pushAdvisory(
			session,
			`REVIEWER_SCOPE_MERGEBACK_VERIFIED: task ${input.taskId}: primary checkout matches the lane manifest exactly; reviewer dispatch is enabled`,
		);
	} catch (error) {
		try {
			const session = ensureAgentSession(input.parentSessionID);
			pushAdvisory(
				session,
				`REVIEWER_SCOPE_MERGEBACK_MISMATCH: task ${input.taskId}: merge-back verification errored (${String(error).slice(0, 200)}). ACTION[architect]: re-dispatch the reviewer to retry verification`,
			);
			settleReviewerScopeMergeback({
				parentSessionID: input.parentSessionID,
				taskId: input.taskId,
				coderCallID: input.coderCallID,
				outcome: {
					verified: false,
					reason: 'verification error',
					at: input.now,
				},
			});
		} catch {
			// Truly nothing left to do; the generation stays mergeback_pending.
		}
	}
}
