import type { CloseStageContext, GitAlignResult } from './context.js';
import { _internals } from './internals.js';

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

	const gitStatus = _internals.getGitRepositoryStatus(ctx.directory);
	if (gitStatus.isRepo) {
		// Try aggressive reset first (handles post-merge scenario with uncommitted changes)
		const aggressiveResult = await _internals.resetToMainAfterMerge(
			ctx.directory,
			{
				pruneBranches,
			},
		);
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
