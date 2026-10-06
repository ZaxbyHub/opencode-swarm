/**
 * Co-change-aware pair conflict predicate for Epic mode.
 *
 * Combines Lean Turbo's existing path-based conflict signal (imported from
 * `../lean/conflicts`) with a git co-change signal (from the
 * `co_change_analyzer` output, sourced via `./cochange-source`).
 *
 * Conservative combination rule (design notes §15.2 step 4):
 *  - The co-change signal may only ESCALATE a verdict, never DOWNGRADE it.
 *  - `conflict = pathConflict || cochangeConflict`.
 *  - This module never modifies Lean Turbo's behavior — when its caller does
 *    not invoke it, nothing changes anywhere.
 *
 * Path / co-change name reconciliation:
 *  - Planner scope paths are repo-relative (`getValidatedFiles` in
 *    `src/turbo/lean/partition-common.ts` normalizes them relative to the
 *    project root), but other callers may still pass normalized absolute
 *    paths (`{projectRoot}/src/x.ts`).
 *  - Co-change paths come from `git log --name-only` and are always
 *    repo-relative (e.g. `src/x.ts`).
 *  - We bridge with a boundary-aware suffix match: a scope path matches a
 *    co-change path if they are equal OR the scope ends with `'/' + cochange`.
 *    This handles both absolute and relative scope paths without needing the
 *    project root.
 */

import type { CoChangeEntry } from '../tools/co-change-analyzer.js';
import { normalizePath, pathsConflict } from '../turbo/lean/conflicts.js';

/**
 * Threshold for treating a co-change pair as a conflict signal.
 *
 * `npmi` and `minCoChanges` directly correspond to fields on
 * `CoChangeEntry`. Both must be satisfied for a pair to contribute a signal.
 * Defaults live in `EpicConfigSchema` (`src/config/schema.ts`) and are
 * deliberately stricter than `co_change_analyzer`'s discovery defaults.
 */
export interface CoChangeThreshold {
	/** Minimum NPMI in [-1, 1]. */
	npmi: number;
	/** Minimum raw co-change count, to suppress small-sample noise. */
	minCoChanges: number;
}

/** Detailed verdict from `epicPairConflict`. */
export interface EpicPairVerdict {
	/** True iff the two scopes conflict under the combined signal. */
	conflict: boolean;
	/** Which signal(s) fired. `'none'` only when `conflict === false`. */
	reason: 'path' | 'cochange' | 'both' | 'none';
	/** Concrete pairs that drove the verdict. Empty arrays when no signal fired. */
	evidence: {
		/** Path-overlapping pairs (each entry: `[scopeApath, scopeBpath]`). */
		pathPairs: Array<[string, string]>;
		/** Co-change pairs (each entry references files as they appear in CoChangeEntry). */
		cochangePairs: Array<{
			a: string;
			b: string;
			npmi: number;
			coChangeCount: number;
		}>;
	};
}

/**
 * True iff `scopePath` refers to the same file as `cochangePath`, allowing
 * for the scope to be project-root-prefixed and the co-change path to be
 * repo-relative.
 */
function pathMatches(scopePath: string, cochangePath: string): boolean {
	if (scopePath === cochangePath) return true;
	return scopePath.endsWith(`/${cochangePath}`);
}

/**
 * Decide whether two task scopes conflict, combining path-based and co-change
 * signals. Pure function — no I/O, no side effects.
 *
 * @param scopeA       Files task 1 declares. Paths may be absolute or relative.
 * @param scopeB       Files task 2 declares.
 * @param cochangePairs Unfiltered co-change entries from `./cochange-source`.
 *                     This function applies the threshold internally so callers
 *                     can pass the analyzer's output verbatim.
 * @param threshold    NPMI floor + min co-change count.
 *
 * Behavioral invariants verified by tests:
 *  - Empty `cochangePairs` (greenfield / signal absent) → verdict is exactly
 *    the path-only result. This is the "feature disabled" guarantee from
 *    design notes §15.6.
 *  - Co-change-only conflict promotes `'none'` to `'cochange'`.
 *  - Path-only conflict is unaffected by co-change input.
 *  - Both signals present → reason `'both'`.
 *  - Empty scopes (either side) → no conflict (no pairs to evaluate).
 */
export function epicPairConflict(
	scopeA: string[],
	scopeB: string[],
	cochangePairs: CoChangeEntry[],
	threshold: CoChangeThreshold,
): EpicPairVerdict {
	const normA = scopeA.map(normalizePath);
	const normB = scopeB.map(normalizePath);

	// Path-based pass. Mirrors what Lean Turbo's planner already does pair-wise.
	const pathPairs: Array<[string, string]> = [];
	for (const a of normA) {
		for (const b of normB) {
			if (pathsConflict(a, b)) {
				pathPairs.push([a, b]);
			}
		}
	}
	const pathConflict = pathPairs.length > 0;

	// Co-change pass. Filter to threshold-passing pairs first so the
	// scope cross-check is cheap even on large analyzer outputs.
	const activePairs = cochangePairs.filter(
		(e) =>
			e.coChangeCount >= threshold.minCoChanges && e.npmi >= threshold.npmi,
	);

	const cochangeMatches: EpicPairVerdict['evidence']['cochangePairs'] = [];
	for (const entry of activePairs) {
		const fa = entry.fileA;
		const fb = entry.fileB;
		const aTouchesFa = normA.some((p) => pathMatches(p, fa));
		const aTouchesFb = normA.some((p) => pathMatches(p, fb));
		const bTouchesFa = normB.some((p) => pathMatches(p, fa));
		const bTouchesFb = normB.some((p) => pathMatches(p, fb));
		// Cross-task coupling via the pair (fa, fb) requires that each scope
		// exclusively owns one side of the pair (strict partition). If a single
		// scope contains BOTH files of the pair, the pair is fully internal to
		// that task — its co-change relationship is exercised inside one task,
		// not across the two — so it adds no cross-task signal beyond whatever
		// path-overlap may also fire. Without this exclusivity requirement,
		// `reason` over-attributes to `'cochange'` / `'both'` on pairs whose
		// coupling does not actually live between the two tasks.
		const aExclusivelyFa = aTouchesFa && !aTouchesFb;
		const aExclusivelyFb = aTouchesFb && !aTouchesFa;
		const bExclusivelyFa = bTouchesFa && !bTouchesFb;
		const bExclusivelyFb = bTouchesFb && !bTouchesFa;
		const crossCouple =
			(aExclusivelyFa && bExclusivelyFb) || (aExclusivelyFb && bExclusivelyFa);
		if (crossCouple) {
			cochangeMatches.push({
				a: fa,
				b: fb,
				npmi: entry.npmi,
				coChangeCount: entry.coChangeCount,
			});
		}
	}
	const cochangeConflict = cochangeMatches.length > 0;

	let reason: EpicPairVerdict['reason'];
	if (pathConflict && cochangeConflict) reason = 'both';
	else if (pathConflict) reason = 'path';
	else if (cochangeConflict) reason = 'cochange';
	else reason = 'none';

	return {
		conflict: pathConflict || cochangeConflict,
		reason,
		evidence: { pathPairs, cochangePairs: cochangeMatches },
	};
}
