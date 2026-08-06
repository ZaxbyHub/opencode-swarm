/**
 * Activation + rollback (Workstream D, issue #1822).
 *
 * Safety model (per the revised plan + critic C2): slash commands invoked by a
 * human do NOT go through scope-guard.ts (which is coder-only, line 83). The
 * activation safety stack is therefore:
 *   1. `toolPolicy: 'human-only'` on the `approve`/`activate`/`reject`/`rollback`
 *      command entries — prevents agent `swarm_command` invocation;
 *   2. an explicit `expectedContentHash` argument checked against the current
 *      SKILL.md contentHash — refuses a stale base (`STALE_BASE`);
 *   3. atomic write (snapshot-then-rename) after recording a rollback snapshot;
 *   4. append-only history — rollback appends a new event, never deletes.
 *
 * No claim of `SCOPE_NOT_DECLARED` for these commands (that invariant applies
 * to coder tool calls under a Task, not human slash commands).
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs';
import * as path from 'node:path';
import { currentCandidateState, recordTransition } from './lifecycle.js';
import { computeContentHash, readArtifact, writeArtifact } from './store.js';

/** Atomic file write helper (temp + rename). Used for the SKILL.md mutation. */
function writeSkillFileAtomic(targetPath: string, content: string): void {
	const tempPath = `${targetPath}.tmp.${Date.now()}.${Math.floor(Math.random() * 1e9)}`;
	try {
		_internals.writeFileSync(tempPath, content, 'utf8');
		_internals.renameSync(tempPath, targetPath);
	} finally {
		try {
			if (existsSync(tempPath)) _internals.unlinkSync(tempPath);
		} catch {
			// best-effort cleanup
		}
	}
}

export const _internals = {
	writeFileSync,
	renameSync,
	unlinkSync,
};

export interface ActivateInput {
	directory: string;
	skillSlug: string;
	candidateId: string;
	actor: string;
	/** Caller's view of the current SKILL.md contentHash — refuses stale base. */
	expectedContentHash: string;
}

export interface ActivateResult {
	activated: boolean;
	reason: string;
	/** Path to the rollback snapshot recorded before activation. */
	rollbackSnapshotRef: string;
}

/**
 * Activate a candidate: refuse stale base, snapshot the incumbent, atomic-write
 * the candidate content to the skill root, record the `activated` event with
 * user/origin + snapshot ref.
 */
export async function activateCandidate(
	input: ActivateInput,
): Promise<ActivateResult> {
	const skillPath = path.join(
		input.directory,
		'.opencode',
		'skills',
		'generated',
		input.skillSlug,
		'SKILL.md',
	);
	const incumbent = existsSync(skillPath)
		? readFileSync(skillPath, 'utf8')
		: '';
	const currentHash = computeContentHash(incumbent);

	// Stale-base refusal — the caller must have a current view of the content.
	if (currentHash !== input.expectedContentHash) {
		return {
			activated: false,
			reason: `STALE_BASE: expected ${input.expectedContentHash.slice(0, 12)} but current is ${currentHash.slice(0, 12)}`,
			rollbackSnapshotRef: '',
		};
	}

	// Read the candidate content from the candidate dir.
	const candidateContent = readArtifact(
		input.directory,
		input.skillSlug,
		input.candidateId,
		'candidate.md',
	);
	if (candidateContent === null) {
		return {
			activated: false,
			reason: 'candidate content not found (drafted candidate missing)',
			rollbackSnapshotRef: '',
		};
	}

	// State pre-check: activation is only legal from accepted_pending_approval.
	// This MUST happen BEFORE any filesystem mutation so an illegal-transition
	// throw never leaves the SKILL.md mutated with no audit trail (reviewer CR1).
	const state = currentCandidateState(
		input.directory,
		input.skillSlug,
		input.candidateId,
	);
	if (state.state !== 'accepted_pending_approval') {
		return {
			activated: false,
			reason: `INVALID_STATE: candidate is in state ${state.state ?? '<none>'}; activation requires accepted_pending_approval`,
			rollbackSnapshotRef: '',
		};
	}

	// Record a rollback snapshot BEFORE the write (so rollback can restore).
	const rollbackSnapshotRef = writeArtifact(
		input.directory,
		input.skillSlug,
		input.candidateId,
		'rollback.md',
		incumbent,
	);

	// Record the activated event BEFORE the file mutation. If this throws
	// (it should not, given the pre-check above + the hash-chain verify), the
	// SKILL.md is still untouched.
	await recordTransition({
		directory: input.directory,
		skillSlug: input.skillSlug,
		candidateId: input.candidateId,
		toState: 'activated',
		eventType: 'activate',
		actor: input.actor,
		origin: 'command:skill-opt:approve',
		reason: 'human-approved activation',
		contentHashBefore: currentHash,
		contentHashAfter: computeContentHash(candidateContent),
		evidenceRefs: [rollbackSnapshotRef],
		payload: { rollbackSnapshotRef },
	});

	// Atomic write. Ensure the skill root exists.
	const skillRoot = path.dirname(skillPath);
	if (!existsSync(skillRoot)) mkdirSync(skillRoot, { recursive: true });
	writeSkillFileAtomic(skillPath, candidateContent);

	return {
		activated: true,
		reason: 'activated',
		rollbackSnapshotRef,
	};
}

export interface RollbackInput {
	directory: string;
	skillSlug: string;
	candidateId: string;
	actor: string;
}

export interface RollbackResult {
	rolledBack: boolean;
	reason: string;
}

/**
 * Rollback an activation by restoring the snapshot. Appends a `rolled_back`
 * event — history is NEVER deleted. The restored snapshot becomes the live
 * SKILL.md content atomically.
 */
export async function rollbackCandidate(
	input: RollbackInput,
): Promise<RollbackResult> {
	const snapshot = readArtifact(
		input.directory,
		input.skillSlug,
		input.candidateId,
		'rollback.md',
	);
	if (snapshot === null) {
		return {
			rolledBack: false,
			reason: 'no rollback snapshot recorded for this candidate',
		};
	}

	// State pre-check: rollback is only legal from activated (or, defensively,
	// accepted_pending_approval if a snapshot exists). This MUST happen BEFORE
	// the file mutation so an illegal-transition throw never diverges the live
	// file from the audit log (reviewer CR2).
	const state = currentCandidateState(
		input.directory,
		input.skillSlug,
		input.candidateId,
	);
	if (state.state !== 'activated') {
		return {
			rolledBack: false,
			reason: `INVALID_STATE: candidate is in state ${state.state ?? '<none>'}; rollback requires activated`,
		};
	}

	const skillPath = path.join(
		input.directory,
		'.opencode',
		'skills',
		'generated',
		input.skillSlug,
		'SKILL.md',
	);
	const beforeContent = existsSync(skillPath)
		? readFileSync(skillPath, 'utf8')
		: '';

	// Record the rolled_back event BEFORE the file restore. If this throws, the
	// SKILL.md is still untouched.
	await recordTransition({
		directory: input.directory,
		skillSlug: input.skillSlug,
		candidateId: input.candidateId,
		toState: 'rolled_back',
		eventType: 'rollback',
		actor: input.actor,
		origin: 'command:skill-opt:rollback',
		reason: 'human-invoked rollback',
		contentHashBefore: computeContentHash(beforeContent),
		contentHashAfter: computeContentHash(snapshot),
	});

	writeSkillFileAtomic(skillPath, snapshot);

	return { rolledBack: true, reason: 'rolled back from snapshot' };
}
