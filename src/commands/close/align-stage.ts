import { log } from '../../utils/logger';
import { recheckBeforeDestructive } from '../destructive-purge.js';
import type { CloseStageContext, GitAlignResult } from './context.js';
import { _internals } from './internals.js';

/** Options for the guarded `resetToMainAfterMerge` seam (issue #2953). */
export type GuardedResetToMainOptions = {
	pruneBranches?: boolean;
	/**
	 * The tracked-dirty set the close gate measured (and the operator
	 * confirmed, or the empty clean-tree set). REQUIRED — the guard
	 * re-verifies exactly this scope before the destructive reset.
	 */
	expectedDirtyPaths: readonly string[];
};

export type GuardedResetToMainResult =
	import('../../git/branch.js').ResetToMainAfterMergeResult & {
		/** True when the #2953 re-check refused and NO reset ran. */
		recheckRefused?: true;
	};

function renderRecheckRefusal(
	reason: string,
	newDirtyPaths: readonly string[],
): string {
	const listed = newDirtyPaths.slice(0, 10);
	const overflow = newDirtyPaths.length - listed.length;
	// The plugin keeps .swarm/ git-excluded (ensureSwarmGitExcluded); a change
	// under it at recheck time almost always means someone git-added runtime
	// state — name the remediation instead of implying an external writer.
	const swarmHint = newDirtyPaths.some((p) => p.startsWith('.swarm/'))
		? 'One or more changed paths are under .swarm/ — this project tracks swarm runtime state in git. Consider `git rm -r --cached .swarm/` and re-adding `.swarm/` to .git/info/exclude; close never confirms runtime state as destructive scope.'
		: undefined;
	return [
		`🛑 Git alignment aborted (fail-closed): ${reason} — this destructive scope was never confirmed${listed[0] ? ` (first: ${listed[0]})` : ''}.`,
		...listed.map((p) => `  - ${p}`),
		...(overflow > 0 ? [`  … and ${overflow} more`] : []),
		...(swarmHint ? [swarmHint] : []),
		'Nothing was reset or checked out; the session is finalized (finalize/archive/clean completed). Complete git alignment manually if still wanted.',
	].join('\n');
}

/**
 * Issue #2953 guard: re-verify the tracked-dirty tree with the SAME argv and
 * parser the close gate used, immediately before delegating to the real
 * aggressive reset. Installed as the `_internals.resetToMainAfterMerge` seam
 * value at facade wiring time (see wiring.ts) so the re-measurement happens
 * at the tightest point reachable without editing src/git/branch.ts; a
 * residual fetch/checkout window INSIDE the real reset remains and is
 * disclosed in the release notes. On refusal the real reset is never called
 * and the result carries the full bounded refusal text in `message` — the
 * caller must treat `recheckRefused` as terminal (no cautious fallback).
 */
export async function guardResetWithRecheck(
	real: typeof import('../../git/branch.js').resetToMainAfterMerge,
	cwd: string,
	options?: GuardedResetToMainOptions,
): Promise<GuardedResetToMainResult> {
	const recheck = await recheckBeforeDestructive(
		cwd,
		options?.expectedDirtyPaths ?? [],
	);
	if (recheck.ok) {
		return real(cwd, { pruneBranches: options?.pruneBranches });
	}
	log(
		`[close-align] re-check refused destructive reset: ${recheck.reason} (${recheck.newDirtyPaths.length} newly-dirty path(s))`,
	);
	return {
		success: false,
		targetBranch: '',
		previousBranch: '',
		message: renderRecheckRefusal(recheck.reason, recheck.newDirtyPaths),
		branchDeleted: false,
		changesDiscarded: false,
		warnings: [],
		recheckRefused: true,
	};
}

/**
 * STAGE 4: ALIGN
 *
 * Performs safe git alignment to main (resetToMainAfterMerge / resetToRemoteBranch
 * via _internals), handling post-merge scenarios and non-git directories.
 * Returns { gitAlignResult, prunedBranches } so the orchestrator can build
 * the close summary. All warnings are pushed into ctx.warnings.
 */
export async function runAlignStage(
	ctx: CloseStageContext,
): Promise<GitAlignResult> {
	const pruneBranches = ctx.args.includes('--prune-branches');
	let gitAlignResult = '';
	const prunedBranches: string[] = [];

	// #3427: the repository probe is awaited through the async seam (the
	// reader-backed detailed twin wired by wireCloseInternals) — the finalize
	// pipeline no longer crosses the blocking sync gitExec chain here.
	const gitStatus = await _internals.getGitRepositoryStatus(ctx.directory);
	if (gitStatus.isRepo) {
		// Try aggressive reset first (handles post-merge scenario with uncommitted changes).
		// #2953: the seam value is guardResetWithRecheck (installed at wiring
		// time) — it re-verifies the confirmed tracked-dirty scope immediately
		// before the destructive reset and refuses fail-closed on drift.
		const aggressiveResult = await _internals.resetToMainAfterMerge(
			ctx.directory,
			{
				pruneBranches,
				expectedDirtyPaths: ctx.purgeGateDirtyPaths ?? [],
			},
		);
		if (aggressiveResult.recheckRefused) {
			// Least-destructive outcome on drift: NO alignment at all —
			// neither the aggressive reset nor the cautious fallback. The
			// refusal text lands on both the Git summary line and warnings.
			gitAlignResult = aggressiveResult.message;
			ctx.warnings.push(aggressiveResult.message);
			return { gitAlignResult, prunedBranches };
		}
		if (aggressiveResult.success) {
			gitAlignResult = aggressiveResult.message;
			for (const w of aggressiveResult.warnings) {
				ctx.warnings.push(w);
			}
			if (aggressiveResult.changesDiscarded) {
				ctx.warnings.push(
					'Uncommitted changes were discarded during git alignment',
				);
			}
		} else {
			// Fallback to cautious reset (preserves uncommitted changes)
			const alignResult = await _internals.resetToRemoteBranch(ctx.directory, {
				pruneBranches,
			});
			gitAlignResult = alignResult.message;
			prunedBranches.push(...alignResult.prunedBranches);

			if (!alignResult.success) {
				ctx.warnings.push(`Git alignment: ${alignResult.message}`);
			}
			if (alignResult.alreadyAligned) {
				gitAlignResult = `Already aligned with ${alignResult.targetBranch}`;
			}
			for (const w of alignResult.warnings) {
				ctx.warnings.push(w);
			}
		}
	} else if (gitStatus.reason === 'git_unavailable') {
		gitAlignResult = `Git executable unavailable — skipped git alignment: ${gitStatus.message}`;
		ctx.warnings.push(gitAlignResult);
	} else if (gitStatus.reason === 'git_error') {
		gitAlignResult = `Git repository check failed — skipped git alignment: ${gitStatus.message}`;
		ctx.warnings.push(gitAlignResult);
	} else {
		// gitStatus.reason === 'not_git_repo'
		gitAlignResult = 'Not a git repository — skipped git alignment';
	}

	return { gitAlignResult, prunedBranches };
}
