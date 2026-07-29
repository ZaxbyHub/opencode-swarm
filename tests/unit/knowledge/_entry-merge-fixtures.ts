/**
 * Shared entry fixtures for the `entry-merge` test trio (issue #1821 Lane A):
 *  - `entry-merge-characterization.test.ts`
 *  - `entry-merge-characterization-confidence.test.ts`
 *  - `entry-merge-fixes.test.ts`
 *
 * Extracted so all three files build IDENTICAL baseline entries. Three private
 * copies of `entry()` would let one file's default drift (a different starting
 * `confidence`, a missing `retrieval_outcomes`) and silently change what a
 * "pinned" assertion means. Not a `.test.ts` file, so the runner never collects
 * it — helpers do not need their own tests.
 *
 * The default lesson is deliberately shared by `entry()` and its overrides, so
 * two default entries are equal-length and the merge's strict `>` lesson swap
 * does NOT fire unless a test asks for it.
 */

import type {
	KnowledgeEntryBase,
	PhaseConfirmationRecord,
	RetrievalOutcome,
} from '../../../src/hooks/knowledge-types.js';

/** Entry view that also allows the optional/loose fields the merge touches. */
export type LooseEntry = KnowledgeEntryBase & Record<string, unknown>;

export function outcomes(over: Record<string, unknown> = {}): RetrievalOutcome {
	return {
		applied_count: 0,
		succeeded_after_count: 0,
		failed_after_count: 0,
		...over,
	} as RetrievalOutcome;
}

export function entry(over: Record<string, unknown> = {}): LooseEntry {
	return {
		id: 'target-1',
		tier: 'swarm',
		lesson: 'run focused tests before claiming done',
		category: 'testing',
		tags: [],
		scope: 'global',
		confidence: 0.5,
		status: 'candidate',
		confirmed_by: [],
		retrieval_outcomes: outcomes(),
		schema_version: 3,
		created_at: '2026-01-01T00:00:00.000Z',
		updated_at: '2026-01-01T00:00:00.000Z',
		...over,
	} as LooseEntry;
}

export function phaseRec(
	over: Partial<PhaseConfirmationRecord> = {},
): PhaseConfirmationRecord {
	return {
		phase_number: 1,
		confirmed_at: '2026-01-01T00:00:00.000Z',
		project_name: 'proj',
		...over,
	};
}

/**
 * Positional variant used by the confidence suite, where a record's
 * `confirmed_at` must vary with its phase so distinct phases never collapse
 * into one under the `phase|project|confirmed_at` dedup key.
 */
export function phaseRecAt(phase: number): PhaseConfirmationRecord {
	return {
		phase_number: phase,
		confirmed_at: `2026-01-0${phase}T00:00:00.000Z`,
		project_name: 'proj',
	};
}

/** Every summed counter on `retrieval_outcomes`, in `sumRetrievalOutcomes` order. */
export const ALL_COUNTERS = [
	'applied_count',
	'succeeded_after_count',
	'failed_after_count',
	'shown_count',
	'acknowledged_count',
	'applied_explicit_count',
	'ignored_count',
	'violated_count',
	'contradicted_count',
	'n_a_count',
	'succeeded_after_shown_count',
	'failed_after_shown_count',
	'partial_after_shown_count',
] as const;
