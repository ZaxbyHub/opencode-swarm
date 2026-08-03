/**
 * Plan-time parallel-execution verdict helper (#1656 / #1674 v8 flagship).
 *
 * Pure, synchronous, side-effect-free pairwise conflict analysis for N proposed
 * parallel task groups. Used by BOTH:
 *   - the `plan_conflict_check` tool (architect-facing advisory — see
 *     `src/tools/plan-conflict-check.ts`), and
 *   - the delegation gate (`src/hooks/delegation-gate.ts`) which recomputes the
 *     verdict INLINE at coder-dispatch time to enforce the v8 "serial fallback
 *     when scopes overlap or are unknown" contract (acceptance criterion 4).
 *
 * Single source of truth: one helper, two call sites, so the architect's
 * advisory and the gate's enforcement can never disagree on what "disjoint"
 * means.
 *
 * Design notes:
 *  - Sync by design: it reads only `.swarm/scopes/scope-<taskId>.json` via
 *    the hardened persisted-scope reader (sync + fail-closed). The gate runs in
 *    `toolBefore` on every tool call and must stay bounded; an async/gitten
 *    helper would violate the bounded-gate spirit.
 *  - The helper itself NEVER calls `getCoChangePairs` (async + `git log`).
 *    Co-change signal is opt-in and supplied by the caller (the tool) via
 *    `options.cochangePairs`. The gate never supplies it, keeping the
 *    enforcement path git-free and fast.
 *  - Fail-closed: a missing/malformed scope → `unknown_scope`, which conflicts
 *    with everything, so `verdict` can never be `all_disjoint` while any task
 *    lacks a declared scope. This is the v8 safety guarantee.
 *  - Writes nothing. Honors issue #1656's "read-only (writes nothing)" tool
 *    acceptance criterion.
 */

import { readScopeFromDisk } from '../scope/scope-persistence.js';
import type { CoChangeEntry } from '../tools/co-change-analyzer.js';
import {
	type CoChangeThreshold,
	type EpicPairVerdict,
	epicPairConflict,
} from '../turbo/epic/cochange-conflict.js';
import {
	normalizePath,
	pathsConflict,
	readTaskScopes,
} from '../turbo/lean/conflicts.js';

/**
 * Per-pair conflict classification. Mirrors `EpicPairVerdict`'s signal
 * decomposition but flattens `none` into `disjoint` for the plan-level view.
 */
export interface ParallelVerdictPair {
	/** First task id (input order). */
	a: string;
	/** Second task id (input order). */
	b: string;
	/** `conflict` = path or co-change overlap; `disjoint` = provably no overlap; `unknown` = ≥1 task has no usable scope. */
	verdict: 'conflict' | 'disjoint' | 'unknown';
	/** Human-readable evidence lines (path pairs, co-change pairs). Empty for `disjoint`/`unknown`. */
	evidence: string[];
}

/**
 * Whole-plan verdict. The gate keys off `verdict === 'all_disjoint'` to allow
 * parallel execution; anything else forces serial.
 */
export interface ParallelVerdict {
	/** `all_disjoint` iff every pair is `disjoint` (no conflicts, no unknowns). */
	verdict: 'all_disjoint' | 'conflicts_present' | 'unknown_scopes';
	/** Pairwise results, one per input task pair (i < j). */
	pairs: ParallelVerdictPair[];
	/** Suggested serialization order (topological sort over the conflict graph). Input order preserved when no conflicts. */
	suggestedSerialOrder: string[];
	/** Task ids whose scope could not be resolved (missing/malformed). */
	unknownScopeTasks: string[];
}

/** Default co-change threshold when the caller opts into co-change but omits one. */
export const DEFAULT_PARALLEL_COCHANGE_THRESHOLD: CoChangeThreshold = {
	npmi: 0.2,
	minCoChanges: 3,
};

/** Hard cap for the synchronous O(N²) verdict path (F-005). */
export const MAX_PARALLEL_VERDICT_TASKS = 64;

export interface ComputeParallelVerdictOptions {
	/** When true AND `cochangePairs` is supplied, fold co-change signal into each pair. Off by default. */
	useCochange?: boolean;
	/** Caller-supplied co-change data (e.g. from `getCoChangePairs`). The helper never fetches it. */
	cochangePairs?: CoChangeEntry[];
	/** Override the co-change threshold. Defaults to `DEFAULT_PARALLEL_COCHANGE_THRESHOLD`. */
	cochangeThreshold?: CoChangeThreshold;
}

/**
 * Resolve a task's declared scope, fail-closed.
 *
 * Returns `{ files, ok }` where `ok === false` means the scope is unusable
 * (missing/malformed/empty) and must force every pair involving this task to
 * `unknown`.
 */
function resolveScope(
	directory: string,
	taskId: string,
): { files: string[]; ok: boolean } {
	// F-004/F-007: do not authorize parallelism from the legacy raw reader,
	// which does not validate containment, schema version, TTL, or task identity.
	const raw = readScopeFromDisk(directory, taskId);
	if (raw === null) return { files: [], ok: false };
	// Treat empty declared scope as unknown (mirrors `runPartitionPreflight`'s
	// empty-declared → undeclared rule in src/turbo/lean/partition-common.ts).
	if (raw.length === 0) return { files: [], ok: false };
	return { files: raw, ok: true };
}

/**
 * Compute a pairwise conflict verdict for the given task ids.
 *
 * Pure + synchronous. Reads only `.swarm/scopes/`. Writes nothing. Fail-closed
 * on any read/parse error (treats the task as `unknown`).
 *
 * @param directory  Project root (for `.swarm/scopes/` reads).
 * @param taskIds    Task ids to analyze. Caller is responsible for min-length
 *                   validation (the tool requires ≥2; the gate only calls this
 *                   with ≥2 pending tasks).
 * @param options    Optional co-change signal + threshold.
 */
export function computeParallelVerdict(
	directory: string,
	taskIds: string[],
	options?: ComputeParallelVerdictOptions,
): ParallelVerdict {
	// F-005: reject before any filesystem reads or pair construction. The
	// delegation gate catches this and fails safely to serial execution.
	if (taskIds.length > MAX_PARALLEL_VERDICT_TASKS) {
		throw new RangeError(
			`Parallel verdict supports at most ${MAX_PARALLEL_VERDICT_TASKS} tasks`,
		);
	}
	const useCochange =
		options?.useCochange === true && Array.isArray(options?.cochangePairs);
	const threshold =
		options?.cochangeThreshold ?? DEFAULT_PARALLEL_COCHANGE_THRESHOLD;
	const cochangePairs = useCochange ? options!.cochangePairs! : [];

	// Resolve every task's scope up front. `unknown` tasks short-circuit their
	// pairs to `unknown` below.
	const resolved = new Map<string, { files: string[]; ok: boolean }>();
	const unknownScopeTasks: string[] = [];
	for (const id of taskIds) {
		const r = resolveScope(directory, id);
		resolved.set(id, r);
		if (!r.ok) unknownScopeTasks.push(id);
	}

	const pairs: ParallelVerdictPair[] = [];
	// Adjacency for the suggested-order topo sort: edge A → B means "B depends
	// on / conflicts with A" — i.e. A should serialize before B. We use input
	// order as the tie-break so the suggested order is stable and predictable.
	const inDegree = new Map<string, number>();
	const adj = new Map<string, string[]>();
	for (const id of taskIds) {
		inDegree.set(id, 0);
		adj.set(id, []);
	}

	for (let i = 0; i < taskIds.length; i++) {
		for (let j = i + 1; j < taskIds.length; j++) {
			const a = taskIds[i];
			const b = taskIds[j];
			const ra = resolved.get(a)!;
			const rb = resolved.get(b)!;

			let pairVerdict: ParallelVerdictPair['verdict'];
			let evidence: string[];

			if (!ra.ok || !rb.ok) {
				pairVerdict = 'unknown';
				evidence = [];
			} else {
				// Both scopes usable. Run the combined path (+ optional co-change)
				// verdict via the existing pure `epicPairConflict`. It is NOT
				// Epic-Mode-gated (verified: pure function, no activation check).
				const ev: EpicPairVerdict = epicPairConflict(
					ra.files,
					rb.files,
					cochangePairs,
					threshold,
				);
				if (ev.conflict) {
					pairVerdict = 'conflict';
					evidence = formatEvidence(ev);
					// Add an edge for topo order: earlier task first.
					if (!adj.get(a)!.includes(b)) {
						adj.get(a)!.push(b);
						inDegree.set(b, (inDegree.get(b) ?? 0) + 1);
					}
				} else {
					pairVerdict = 'disjoint';
					evidence = [];
				}
			}

			pairs.push({ a, b, verdict: pairVerdict, evidence });
		}
	}

	// Topological sort (Kahn's) over conflict edges, input-order tie-break.
	const suggestedSerialOrder = topoSort(taskIds, adj, inDegree);

	let verdict: ParallelVerdict['verdict'];
	if (unknownScopeTasks.length > 0) {
		verdict = 'unknown_scopes';
	} else if (pairs.some((p) => p.verdict === 'conflict')) {
		verdict = 'conflicts_present';
	} else {
		verdict = 'all_disjoint';
	}

	return {
		verdict,
		pairs,
		suggestedSerialOrder,
		unknownScopeTasks,
	};
}

/**
 * Format an `EpicPairVerdict`'s evidence into human-readable lines.
 */
function formatEvidence(ev: EpicPairVerdict): string[] {
	const lines: string[] = [];
	for (const [pa, pb] of ev.evidence.pathPairs) {
		lines.push(`path overlap: ${pa} ↔ ${pb}`);
	}
	for (const cc of ev.evidence.cochangePairs) {
		lines.push(
			`co-change: ${cc.a} ↔ ${cc.b} (npmi=${cc.npmi.toFixed(3)}, coChanges=${cc.coChangeCount})`,
		);
	}
	return lines;
}

/**
 * Stable topological sort. Input order is the tie-break so the result is
 * deterministic and predictable for the architect.
 */
function topoSort(
	taskIds: string[],
	adj: Map<string, string[]>,
	inDegree: Map<string, number>,
): string[] {
	// Clone inDegree so the helper stays pure across repeated calls.
	const deg = new Map(inDegree);
	const order: string[] = [];
	// Use input-order scan for the ready queue (small N; no heap needed).
	const ready = taskIds.filter((id) => (deg.get(id) ?? 0) === 0);
	// Preserve a stable cursor so we drain in input order.
	const queue: string[] = [...ready];

	while (queue.length > 0) {
		const cur = queue.shift()!;
		order.push(cur);
		// Release neighbors in input order (adj lists were built in pair order).
		for (const next of adj.get(cur) ?? []) {
			deg.set(next, (deg.get(next) ?? 0) - 1);
			if ((deg.get(next) ?? 0) === 0) {
				// Insert maintaining input order relative to existing queue.
				queue.push(next);
			}
		}
		// Re-sort the queue by input order to keep determinism stable.
		queue.sort((x, y) => taskIds.indexOf(x) - taskIds.indexOf(y));
	}

	// If there's a cycle (shouldn't happen — conflict graph is undirected but
	// we only added one directed edge per conflicting pair in input order),
	// fall back to input order for any un-emitted tasks.
	if (order.length < taskIds.length) {
		for (const id of taskIds) {
			if (!order.includes(id)) order.push(id);
		}
	}

	return order;
}

/**
 * Quick pairwise check used by the gate: are these task ids provably disjoint?
 *
 * Equivalent to `computeParallelVerdict(...).verdict === 'all_disjoint'` but
 * exposed as a named predicate so the gate reads as intent.
 */
export function isProvablyDisjoint(
	directory: string,
	taskIds: string[],
): boolean {
	return (
		taskIds.length >= 2 &&
		computeParallelVerdict(directory, taskIds).verdict === 'all_disjoint'
	);
}

// Re-export the underlying predicates so the gate/tool can import everything
// from one place without coupling to the turbo/lean or turbo/epic modules
// directly. (The helper already imports them; this is a convenience surface.)
export { normalizePath, pathsConflict, readTaskScopes };
