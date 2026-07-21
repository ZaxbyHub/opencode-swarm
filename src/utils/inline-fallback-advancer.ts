/**
 * Issue #1905: shared "inline fallback advancer" for bespoke dispatch loops that
 * cannot use {@link dispatchWithModelFallback} because their retry semantics
 * differ (e.g. retry-on-permanent, per-attempt session lifecycle, consecutive-
 * failure counters).
 *
 * Before this helper, the advance block (resolve next → advance index → parse
 * → skip-on-malformed → tag quota/transient reason → notify) was inlined in
 * `src/full-auto/oversight.ts:543–579`. Issue #1905 adds a second copy at
 * `src/hooks/full-auto-intercept.ts` (`dispatchCriticAndWriteEvent`). Extracting
 * the block prevents the two copies from drifting — a future fix to the
 * increment-before-parse ordering or the malformed-skip semantics applies to both.
 *
 * The helper is PURE: it resolves, parses, and classifies, then returns the
 * result + invokes an `onAdopt` side-effect callback. It does NOT touch caller
 * state (the loop's `modelOverride` / `modelUsedLabel` / `modelFallbackIndex`
 * stay in the caller).
 */

import {
	type ModelOverride,
	parseModelString,
} from './model-dispatch-fallback';
import { isQuotaError } from './provider-error-classification';

export interface AdvanceInlineFallbackOptions {
	/**
	 * Resolve the 1-based fallback model as a `provider/model` string, or null
	 * when the fallback chain is exhausted. Typically wraps
	 * `resolveFallbackModel(baseRole, index, getSwarmAgents(swarmId))`.
	 */
	resolveFallback: (fallbackIndex: number) => string | null;
	/** Current fallback index (0 = primary / registered model). */
	index: number;
	/** The error from the just-failed attempt — used to tag the reason. */
	lastError: unknown;
	/**
	 * Notified when a fallback model is cleanly adopted (for advisory logging
	 * and telemetry). NOT called when the chain is exhausted or the entry is
	 * malformed. The adopted override is returned in the result's `adopted`
	 * field — callers read it there, not from this callback, so the info
	 * payload intentionally omits the parsed `ModelOverride` (it would be
	 * redundant with `result.adopted.override`).
	 */
	onAdopt: (info: {
		toModel: string;
		fallbackIndex: number;
		reason: 'quota' | 'transient_model_error';
	}) => void;
}

export interface AdvanceInlineFallbackResult {
	/** The new fallback index (always >= the input `index`). */
	nextIndex: number;
	/**
	 * The adopted fallback's raw string + parsed override, or `null` when no
	 * new model was adopted (chain exhausted OR malformed entry skipped).
	 *
	 * When `null`, the caller must NOT change its current `modelOverride` — the
	 * next retry continues on the same model. The index may still have advanced
	 * (malformed-entry skip case) so the entry is not re-resolved.
	 */
	adopted: { modelString: string; override: ModelOverride } | null;
}

/**
 * Advance the inline fallback chain by one step. Encapsulates the
 * increment-before-parse + malformed-skip + reason-tagging logic shared by
 * the bespoke dispatch loops in `oversight.ts` and `full-auto-intercept.ts`.
 *
 * Behavior:
 *  - Chain exhausted (`resolveFallback(index + 1)` returns null):
 *    `{ nextIndex: index, adopted: null }` — keep retrying the current model.
 *  - Malformed entry (`parseModelString` throws or returns undefined):
 *    `{ nextIndex: index + 1, adopted: null }` — index advances (so the entry
 *    is not re-resolved next retry) but the override is NOT changed.
 *  - Clean entry: `{ nextIndex: index + 1, adopted: { modelString, override } }`
 *    — `onAdopt` is called with the quota/transient reason for side effects.
 */
export function advanceInlineFallback(
	opts: AdvanceInlineFallbackOptions,
): AdvanceInlineFallbackResult {
	const nextModel = opts.resolveFallback(opts.index + 1);
	if (!nextModel) {
		// Chain exhausted — keep retrying the current model.
		return { nextIndex: opts.index, adopted: null };
	}

	// Advance the index FIRST so a malformed entry is skipped rather than
	// re-resolved every retry (which would strand any valid fallback listed
	// after it); only adopt the model on a clean parse.
	const advancedIndex = opts.index + 1;

	let parsed: ModelOverride | undefined;
	try {
		parsed = parseModelString(nextModel);
	} catch {
		parsed = undefined; // malformed provider/model entry — skip it
	}

	if (!parsed) {
		// Malformed entry — index advanced, override unchanged.
		return { nextIndex: advancedIndex, adopted: null };
	}

	const reason = isQuotaError(
		opts.lastError instanceof Error
			? opts.lastError.message
			: String(opts.lastError),
	)
		? 'quota'
		: 'transient_model_error';

	opts.onAdopt({
		toModel: nextModel,
		fallbackIndex: advancedIndex,
		reason,
	});

	return {
		nextIndex: advancedIndex,
		adopted: { modelString: nextModel, override: parsed },
	};
}
