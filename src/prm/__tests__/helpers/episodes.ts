import type { PatternMatch } from '../../types';

/**
 * Issue #2134 — shared fixture helpers for the PRM episode gate.
 *
 * The episode gate requires a match's `stepRange[0]` to advance past the
 * PRIOR struck episode's `stepRange[1]` before the same pattern is allowed
 * to strike again. A test that feeds the SAME fixed `stepRange` on every
 * `detectPatterns()` call is modeling one ongoing episode being re-reported
 * every tick — the gate now (correctly) recognizes that as a re-report and
 * suppresses it after the first strike (no count increment, no advisory,
 * no escalation). Any test that expects N strikes across N `toolAfter`
 * calls must instead feed N genuinely distinct, non-overlapping episodes.
 *
 * `episodeAt` derives that fresh, non-overlapping `[start, end]` step range
 * for a given 1-indexed tick: tick 1 => [1, 3], tick 2 => [4, 6], tick 3 =>
 * [7, 9], etc. `createTickingDetectPatterns` wraps it into a drop-in
 * `_internals.detectPatterns` replacement so call sites don't hand-roll the
 * tick counter.
 */
export function episodeAt(tick: number): [number, number] {
	return [tick * 3 - 2, tick * 3];
}

interface DetectPatternsResult {
	matches: PatternMatch[];
	detectionTimeMs: number;
	patternsChecked: number;
}

/**
 * Returns a `_internals.detectPatterns`-compatible function that, on each
 * call, increments an internal tick counter and produces a single match
 * (via `matchFactory`) whose `stepRange` is `episodeAt(tick)` — a fresh
 * episode every call, per the module doc above.
 */
export function createTickingDetectPatterns(
	matchFactory: (overrides: Partial<PatternMatch>) => PatternMatch,
): () => DetectPatternsResult {
	let tick = 0;
	return () => {
		tick += 1;
		return {
			matches: [matchFactory({ stepRange: episodeAt(tick) })],
			detectionTimeMs: 5,
			patternsChecked: 5,
		};
	};
}
