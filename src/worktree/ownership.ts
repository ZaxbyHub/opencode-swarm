/**
 * Issue #2527: the single ownership-gated worktree-directory reclamation
 * path.
 *
 * Every deletion of a worktree-base directory reachable from plugin init
 * (init orphan recovery) or `/swarm reset-session` routes through
 * `removeOwnedWorktreeDir`. The contract, frozen by the #2527 acceptance
 * checks (C1/C2/C5/C7/C10) and pinned by the C7 leg-B source-scan ratchet:
 *
 *  1. A `.git`-bearing candidate is deletable ONLY when the existing
 *     commondir-based primitive (`resolveWorktreeRepoOwnership` on
 *     `readLinkedWorktreeGitDir` + `resolveMainWorktree`) proves this
 *     repository owns it.
 *  2. A `git worktree remove` refusal is a STOP — never an escalation to
 *     `rmSync`. The refusal text ("is not a working tree", "contains
 *     modified or untracked files") is itself the safety signal: the first
 *     is git saying this repo does not own the path; the second is git
 *     refusing to destroy uncommitted work. Both must preserve the
 *     candidate.
 *  3. A `.git`-less directory is deletable ONLY when it sits inside this
 *     project's own default worktree base (ours by construction, per F1).
 *     Anywhere else — the legacy parent-level shared base, or a configured
 *     `worktree_dir` override that may point anywhere — the ownership of a
 *     bare directory cannot be proven and it is skipped and reported.
 *     Review-round hardening: the marker probe is errno-discriminating —
 *     an unreadable-but-present `.git` classifies as `uncertain`, never as
 *     "gitless".
 *
 * The entry files (`src/hooks/init-orphan-recovery.ts`,
 * `src/commands/reset-session.ts`) must not call `rmSync` on base-derived
 * paths themselves — the C7 ratchet enforces it.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveWorktreeRepoOwnership } from '../config/lane-context';
import { isPathUnderSwarmWorktreeBase, removeWorktree } from './core';

export type OwnedRemovalOutcome =
	| { status: 'removed' }
	| { status: 'skipped'; reason: string }
	| { status: 'refused'; reason: string };

export type GitMarkerProbe = 'gitless' | 'present' | 'uncertain';

export const _internals = {
	resolveWorktreeRepoOwnership,
	isPathUnderSwarmWorktreeBase,
	removeWorktree,
	rmSync: fs.rmSync.bind(fs),
	statSync: fs.statSync.bind(fs),
};

/**
 * Errno-discriminating `.git` marker probe. A bare `existsSync` collapses
 * every I/O error (EPERM/EBUSY/EMFILE on a transiently-unreadable marker)
 * into "gitless", which would route an ownership-unprovable path into
 * removal. Only a proven-absent marker is "gitless"; any other error is
 * "uncertain" and the caller must retain the candidate.
 */
export function probeGitMarker(dotGitPath: string): GitMarkerProbe {
	try {
		_internals.statSync(dotGitPath);
		return 'present';
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === 'ENOENT' || code === 'ENOTDIR') return 'gitless';
		return 'uncertain';
	}
}

/**
 * Attempt to reclaim one worktree-base directory, gated by repo ownership.
 * NEVER throws: every failure is a returned outcome so callers can report
 * and continue with the next candidate.
 */
export async function removeOwnedWorktreeDir(
	worktreePath: string,
	projectRoot: string,
): Promise<OwnedRemovalOutcome> {
	const marker = probeGitMarker(path.join(worktreePath, '.git'));
	if (marker === 'uncertain') {
		return {
			status: 'skipped',
			reason: 'ownership uncertain (unreadable .git marker)',
		};
	}
	if (marker === 'gitless') {
		// `.git`-less remnant: deletable only inside this project's own
		// default base (ours by construction). Anywhere else — the legacy
		// parent-level shared base, or a configured `worktree_dir` override
		// that may point anywhere — the ownership of a bare directory cannot
		// be proven: skip, never delete.
		const internal = _internals.isPathUnderSwarmWorktreeBase(
			worktreePath,
			projectRoot,
		);
		if (!internal) {
			return {
				status: 'skipped',
				reason:
					'gitless directory outside the project worktree base (ownership unprovable)',
			};
		}
		try {
			_internals.rmSync(worktreePath, { recursive: true, force: true });
			return { status: 'removed' };
		} catch (error) {
			return {
				status: 'skipped',
				reason: `gitless internal remnant removal failed: ${
					error instanceof Error ? error.message : String(error)
				}`,
			};
		}
	}

	const ownership = _internals.resolveWorktreeRepoOwnership(
		worktreePath,
		projectRoot,
	);
	if (!ownership.owned || ownership.uncertain) {
		return {
			status: 'skipped',
			reason: ownership.uncertain
				? 'ownership uncertain (unreadable .git pointer)'
				: 'owned by a different repository',
		};
	}

	// Ours: remove through git. NO rmSync escalation on refusal — the refusal
	// is evidence (foreign metadata drift, dirty content, held handles) and
	// the candidate must survive it (issue #2527 obligation: refusal is a
	// stop). Callers surface the reason; the next start retries.
	const result = await _internals.removeWorktree(worktreePath, projectRoot);
	if ('error' in result) {
		return { status: 'refused', reason: result.error };
	}
	return { status: 'removed' };
}
