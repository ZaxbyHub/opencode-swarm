/**
 * Coupling report computation for Epic mode (Capability B).
 *
 * Given a plan, computes:
 *  - `p` — the coupling coefficient (fraction of task pairs that conflict
 *          under the combined path + co-change signal from Capability A).
 *  - `perModule` — for each file/module that caused at least one conflict,
 *          the count of conflicting pairs it appeared in.
 *  - `roadmap` — the modules ranked by conflict-contribution, with each
 *          one's share of total detected conflicts. The team can use this
 *          as a decoupling priority order.
 *
 * Read-only — this module changes no execution behavior. It composes
 * Capability A's `epicPairConflict` (the same predicate the future epic
 * mode will use when scheduling), so the report answers exactly the
 * question "what would Capability A say about this plan if I asked it
 * about every task pair?".
 */

import type { CoChangeEntry } from '../tools/co-change-analyzer.js';
import {
	type CoChangeThreshold,
	type EpicPairVerdict,
	epicPairConflict,
} from './cochange-conflict.js';

/** A task as `epic` mode sees it: identifier + declared file scope. */
export interface CouplingTask {
	id: string;
	scope: string[];
}

/** One conflicting pair in the report. */
export interface ConflictingPair {
	a: string;
	b: string;
	reason: EpicPairVerdict['reason'];
	cochangeMatches: number;
	pathMatches: number;
}

/** Per-module conflict contribution. */
export interface ModuleContention {
	module: string;
	conflicts: number;
	share: number; // 0..1, count / total conflicting pairs
}

/** Output of `computeCouplingReport`. */
export interface CouplingReport {
	/** Number of tasks considered. */
	taskCount: number;
	/** Number of unordered task pairs evaluated (`n*(n-1)/2`). */
	totalPairs: number;
	/** Pairs the combined signal flagged as conflicting. */
	conflictingPairCount: number;
	/** Coupling coefficient `p` = conflictingPairCount / totalPairs (0 when totalPairs == 0). */
	p: number;
	/** Each conflicting pair, with the per-pair verdict reason and evidence counts. */
	conflictingPairs: ConflictingPair[];
	/** Per-module contention table, sorted by `conflicts` descending. */
	perModule: ModuleContention[];
	/** Top-N modules with a human-readable rank line for each. */
	roadmap: string[];
}

/** Whether the co-change conflict signal contributed to `p` (`/swarm coupling`). */
export type EpicCochangeSignalState = 'enabled' | 'disabled-by-config';

export interface ComputeCouplingReportOptions {
	/** Cap on roadmap rank entries. Default 5. */
	roadmapTop?: number;
}

/**
 * Compute the coupling report over a set of tasks.
 *
 * Inputs:
 *  - `tasks`: the tasks to consider. The caller decides scoping (whole
 *    plan vs a single phase) and any filtering (pending vs all). Empty
 *    array is valid and produces `p = 0`.
 *  - `cochangePairs`: typically the output of
 *    `getCoChangePairs(directory)` — passed in so this function stays
 *    pure (no I/O) and trivially testable. Empty array is valid (the
 *    Capability A predicate falls back to path-only verdicts).
 *  - `threshold`: NPMI + min-co-changes floor, same shape Capability A
 *    consumes.
 *  - `options.roadmapTop`: how many modules to list in the roadmap
 *    (default 5).
 *
 * Pure function — no file I/O, no side effects.
 */
export function computeCouplingReport(
	tasks: CouplingTask[],
	cochangePairs: CoChangeEntry[],
	threshold: CoChangeThreshold,
	options?: ComputeCouplingReportOptions,
): CouplingReport {
	const roadmapTop = options?.roadmapTop ?? 5;
	const conflictingPairs: ConflictingPair[] = [];
	const moduleConflictCount = new Map<string, number>();

	for (let i = 0; i < tasks.length; i++) {
		for (let j = i + 1; j < tasks.length; j++) {
			const a = tasks[i];
			const b = tasks[j];
			const v = epicPairConflict(a.scope, b.scope, cochangePairs, threshold);
			if (!v.conflict) continue;

			conflictingPairs.push({
				a: a.id,
				b: b.id,
				reason: v.reason,
				cochangeMatches: v.evidence.cochangePairs.length,
				pathMatches: v.evidence.pathPairs.length,
			});

			// Attribute the conflict to every module that drove it. A pair may
			// contribute multiple modules; each module's count goes up by one
			// per pair it appears in (not per occurrence within the pair) so
			// the `share` denominator stays meaningful.
			const driving = new Set<string>();
			for (const [p1, p2] of v.evidence.pathPairs) {
				driving.add(p1);
				driving.add(p2);
			}
			for (const cp of v.evidence.cochangePairs) {
				driving.add(cp.a);
				driving.add(cp.b);
			}
			for (const m of driving) {
				moduleConflictCount.set(m, (moduleConflictCount.get(m) ?? 0) + 1);
			}
		}
	}

	// Guard against JS's `-0` when `tasks.length <= 1` so callers/tests can
	// rely on `Object.is(totalPairs, 0)` semantics.
	const totalPairs =
		tasks.length <= 1 ? 0 : (tasks.length * (tasks.length - 1)) / 2;
	const conflictingPairCount = conflictingPairs.length;
	const p = totalPairs === 0 ? 0 : conflictingPairCount / totalPairs;

	const perModule: ModuleContention[] = Array.from(
		moduleConflictCount.entries(),
	)
		.map(([module, conflicts]) => ({
			module,
			conflicts,
			share: conflictingPairCount === 0 ? 0 : conflicts / conflictingPairCount,
		}))
		.sort((x, y) => {
			if (y.conflicts !== x.conflicts) return y.conflicts - x.conflicts;
			// Stable tie-break: lexicographic by module path.
			return x.module.localeCompare(y.module);
		});

	const roadmap: string[] = [];
	for (const m of perModule.slice(0, roadmapTop)) {
		const pct = (m.share * 100).toFixed(0);
		// "appears in X% of conflicting pairs" is what `share` literally
		// measures (count / conflictingPairCount). Avoids the misleading
		// "drives X% of detected coupling" phrasing — when a cochange pair
		// attributes both endpoints, each one's share is 100%, and a
		// natural reading of "drives X%" makes the values look like they
		// should sum to 100% when they don't.
		roadmap.push(
			`\`${m.module}\` appears in ${pct}% of conflicting pairs (${m.conflicts} pair${m.conflicts === 1 ? '' : 's'}) — isolating it behind an interface is a high-leverage refactor.`,
		);
	}

	return {
		taskCount: tasks.length,
		totalPairs,
		conflictingPairCount,
		p,
		conflictingPairs,
		perModule,
		roadmap,
	};
}

/**
 * Render a `CouplingReport` as a markdown document. Output shape is
 * stable so downstream tools can parse it; the JSON form (via
 * `JSON.stringify(report)`) is the better target for programmatic use.
 */
export function formatCouplingReportMarkdown(report: CouplingReport): string {
	const lines: string[] = [];
	lines.push('## Coupling Report');
	lines.push('');
	if (report.taskCount === 0) {
		lines.push(
			'No tasks to analyze (the plan is empty or all tasks were filtered out).',
		);
		return lines.join('\n');
	}
	if (report.totalPairs === 0) {
		lines.push(
			`Only ${report.taskCount} task in scope — at least two tasks are needed to measure coupling.`,
		);
		return lines.join('\n');
	}

	// Use .toFixed(2) so very small / very large p values do not collapse
	// to '0.0' or '100.0' in the percentage rendering. The exact p value is
	// always available in `report.p` for programmatic consumers.
	const pPct = (report.p * 100).toFixed(2);
	lines.push(
		`**p = ${report.p.toFixed(3)}** (${report.conflictingPairCount} conflicting pair${report.conflictingPairCount === 1 ? '' : 's'} out of ${report.totalPairs} total — ${pPct}% of task pairs conflict)`,
	);
	lines.push('');
	lines.push(
		'`p` is a measured coupling coefficient — *not* a target. Lower means the plan is naturally more parallelizable. Estimates above flow from the combined path + co-change signal Capability A computes; treat them as inputs to your refactor decisions, not as established facts.',
	);
	lines.push('');

	if (report.perModule.length > 0) {
		lines.push('### Per-module contention');
		lines.push('');
		lines.push('| Module | Conflicts | Pair coverage |');
		lines.push('|---|---:|---:|');
		for (const m of report.perModule) {
			const pct = (m.share * 100).toFixed(0);
			lines.push(`| \`${m.module}\` | ${m.conflicts} | ${pct}% |`);
		}
		lines.push('');
		lines.push(
			'_Pair coverage = the fraction of conflicting pairs this module appears in. A single co-change pair attributes both endpoints, so coverage values can sum past 100%._',
		);
		lines.push('');
	}

	if (report.roadmap.length > 0) {
		lines.push('### Decoupling roadmap');
		lines.push('');
		report.roadmap.forEach((line, i) => {
			lines.push(`${i + 1}. ${line}`);
		});
		lines.push('');
	}

	if (report.conflictingPairs.length > 0) {
		lines.push('### Conflicting task pairs');
		lines.push('');
		lines.push(
			'| Task A | Task B | Reason | Path overlaps | Co-change matches |',
		);
		lines.push('|---|---|---|---:|---:|');
		for (const pair of report.conflictingPairs) {
			lines.push(
				`| ${pair.a} | ${pair.b} | ${pair.reason} | ${pair.pathMatches} | ${pair.cochangeMatches} |`,
			);
		}
		lines.push('');
	}

	return lines.join('\n');
}
