/**
 * Epic v2 C6 — what an epic learns from its own outcomes (pure).
 *
 * Two signals, both learned from the per-task outcomes `epic_next_wave`
 * records when it closes a wave (`EpicTaskOutcome`, see `wave-close.ts`),
 * and both used ONLY by the component planner (`components.ts`) — they are
 * analysis, never write authorization:
 *
 *  1. Learned scope expansion. A task that declared D and wrote f without
 *     declaring it is evidence that work on D also touches f:
 *     w(d → f) += 1 for every d ∈ D. The planner's conflict graph uses
 *       scope*(t) = scope(t) ∪ { f : Σ_{d ∈ scope(t)} w(d → f) ≥ 1 }.
 *     scope* only ADDS path-conflict edges; the wave still freezes the
 *     DECLARED scopes, which the dispatch gate checks for drift and its
 *     parallel verdict reads. Because the planner is stricter than the
 *     verdict (a superset of its edges), every multi-task wave it picks
 *     stays `all_disjoint` under the verdict (property-tested). Co-change
 *     coupling keeps using the declared scopes: its "exclusively owns one
 *     side" rule is not monotone in the scope, so expanding it could REMOVE
 *     a verdict conflict.
 *
 *  2. Decaying hot set. Per file, incidents α_f and exposures β_f:
 *       incidents — undeclared write 1.0 (the written file); merge-back
 *       failure 0.5, Stage B failure 0.25 per failure, rework
 *       0.25 × min(generation − 1, 4) and reopen 0.5 per reopen, each
 *       charged to every declared FILE entry of the task (the merge-status
 *       registry records no conflict files, so a merge failure is charged
 *       to the declared files);
 *       exposures — β += 1 per declared FILE entry of every resolved task.
 *     A declared entry that is a directory (on disk, or covering another
 *     path of the same outcome) is never charged or exposed: one troubled
 *     `src`-scoped task must not make everything under `src/` hot.
 *     A task run again after a reopen is charged only the DELTA of its
 *     counters over its previous outcome (`previous`), when that previous
 *     outcome was already learned.
 *     Beta prior with mean m0 = 0.1 and strength 2 (a0 = 0.2, b0 = 1.8):
 *       r(f) = (a0 + α_f) / (a0 + b0 + α_f + β_f).
 *     Strongest-co-writer discount: α'_f = α_f − m_f when the strongest
 *     learned co-writer m_f = max_d w(d → f) ≥ 1 (an active expansion edge
 *     already keeps that declarer apart from f's owners), else α'_f = α_f.
 *     f is HOT ⇔ α'_f ≥ 1 ∧ r(α'_f, β_f) − m0 > hot_excess (default 0.25). A task
 *     whose declared scope lists a hot file (exact normalized path) runs
 *     alone (exclusive). Hot
 *     needs EXCESS evidence: an empty or clean history has no hot file and
 *     no expansion, so the cold start is neutral (no R_C product).
 *
 * Decay keeps both bounded and current: × `decay_per_epic` (0.7) of the
 * project prior at every epic close that learned something, and age decay
 * in WHOLE half-lives — × 0.5^floor(Δdays / `half_life_days` (60)) since
 * the state was last written — so an observation keeps its full weight for
 * a whole half-life; entries below 0.05 are dropped and at most
 * {@link MAX_EPIC_LEARNING_FILES} files (lowest α + β evicted) and
 * {@link MAX_EPIC_LEARNING_EDGES} co-write edges (lowest weight evicted) are
 * kept. Persistence (project prior + epic posterior) is `learning-store.ts`.
 */

import { resolveRetentionCap } from '../retention/caps.js';
import { normalizePath, pathsConflict } from '../turbo/lean/conflicts.js';
import { type EpicConfigSource, resolveEpicConfig } from './config.js';
import type { EpicTaskOutcome } from './lifecycle.js';

/** Files with learned statistics kept (lowest α + β evicted first). */
export const MAX_EPIC_LEARNING_FILES = 2000;
/** Learned co-write edges kept (lowest weight evicted first). */
export const MAX_EPIC_LEARNING_EDGES = 2000;
/** Entries whose mass falls below this after decay are dropped. */
export const EPIC_LEARNING_DROP_BELOW = 0.05;
/** Prior mean incident rate m0 and its strength (a0 + b0). */
export const EPIC_LEARNING_PRIOR_MEAN = 0.1;
export const EPIC_LEARNING_PRIOR_STRENGTH = 2;
/** Minimum incident mass before a file can be hot. */
export const EPIC_HOT_MIN_ALPHA = 1;
/** Summed co-write weight at which a learned file joins scope*. */
export const EPIC_EXPANSION_MIN_WEIGHT = 1;

const PRIOR_A0 = EPIC_LEARNING_PRIOR_MEAN * EPIC_LEARNING_PRIOR_STRENGTH;
const PRIOR_B0 = (1 - EPIC_LEARNING_PRIOR_MEAN) * EPIC_LEARNING_PRIOR_STRENGTH;
const DAY_MS = 24 * 60 * 60 * 1000;

export const EPIC_LEARNING_INCIDENT_WEIGHTS = Object.freeze({
	undeclared: 1,
	mergeFailurePerDeclared: 0.5,
	stageBFailure: 0.25,
	reworkPerGeneration: 0.25,
	reworkMaxGenerations: 4,
	reopen: 0.5,
});

/** Resolved `epic.learning.*` settings. */
export interface EpicLearningSettings {
	enabled: boolean;
	decayPerEpic: number;
	halfLifeDays: number;
	hotExcess: number;
}

export const DEFAULT_EPIC_LEARNING_SETTINGS: EpicLearningSettings =
	Object.freeze({
		enabled: true,
		decayPerEpic: 0.7,
		halfLifeDays: 60,
		hotExcess: 0.25,
	});

export function resolveEpicLearningSettings(
	config: EpicConfigSource,
): EpicLearningSettings {
	const learning = resolveEpicConfig(config)?.learning;
	const d = DEFAULT_EPIC_LEARNING_SETTINGS;
	return {
		enabled: learning?.enabled ?? d.enabled,
		decayPerEpic: learning?.decay_per_epic ?? d.decayPerEpic,
		halfLifeDays: learning?.half_life_days ?? d.halfLifeDays,
		hotExcess: learning?.hot_excess ?? d.hotExcess,
	};
}

export interface EpicFileStats {
	/** Incident mass α_f. */
	alpha: number;
	/** Exposure mass β_f. */
	beta: number;
}

/** In-memory learning statistics (paths normalized, never `.swarm/`). */
export interface EpicLearningStats {
	files: Map<string, EpicFileStats>;
	/** from (declared) → to (co-written undeclared) → weight. */
	edges: Map<string, Map<string, number>>;
}

/** Learned co-write weights, read-only (the planner's view). */
export type EpicCoWriteIndex = ReadonlyMap<string, ReadonlyMap<string, number>>;

export function emptyEpicLearning(): EpicLearningStats {
	return { files: new Map(), edges: new Map() };
}

export function isEpicLearningEmpty(stats: EpicLearningStats): boolean {
	return stats.files.size === 0 && stats.edges.size === 0;
}

export function cloneEpicLearning(stats: EpicLearningStats): EpicLearningStats {
	const edges = new Map<string, Map<string, number>>();
	for (const [from, targets] of stats.edges) edges.set(from, new Map(targets));
	const files = new Map<string, EpicFileStats>();
	for (const [file, s] of stats.files) files.set(file, { ...s });
	return { files, edges };
}

function isLearnablePath(file: string): boolean {
	return (
		file.length > 0 &&
		file !== '.' &&
		file !== '.swarm' &&
		!file.startsWith('.swarm/') &&
		!file.startsWith('../') &&
		file !== '..' &&
		!file.startsWith('/')
	);
}

/** Normalized, unique paths learning may keep (never `.swarm/` or absolute). */
export function learnablePaths(files: readonly string[]): string[] {
	const out = new Set<string>();
	for (const file of files) {
		const normalized = normalizePath(file);
		if (isLearnablePath(normalized)) out.add(normalized);
	}
	return [...out];
}

function addFile(
	stats: EpicLearningStats,
	file: string,
	alpha: number,
	beta: number,
): void {
	if (alpha === 0 && beta === 0) return;
	const current = stats.files.get(file) ?? { alpha: 0, beta: 0 };
	current.alpha += alpha;
	current.beta += beta;
	stats.files.set(file, current);
}

function addEdge(
	stats: EpicLearningStats,
	from: string,
	to: string,
	weight: number,
): void {
	if (from === to || weight === 0) return;
	const targets = stats.edges.get(from) ?? new Map<string, number>();
	targets.set(to, (targets.get(to) ?? 0) + weight);
	stats.edges.set(from, targets);
}

/**
 * Files written that the declared scope does not cover (a declared
 * directory covers every file beneath it, segment-aware). Sorted, unique,
 * normalized.
 */
export function undeclaredFiles(
	declaredScope: readonly string[],
	actualFiles: readonly string[],
): string[] {
	const declared = [...new Set(declaredScope.map(normalizePath))];
	const actual = [...new Set(actualFiles.map(normalizePath))].sort();
	const covers = (d: string, f: string): boolean =>
		d.length <= f.length && pathsConflict(d, f);
	return actual.filter((f) => !declared.some((d) => covers(d, f)));
}

export interface EpicLearningOptions {
	/**
	 * Whether a declared entry is a directory on disk (never charged or
	 * exposed). Absent ⇒ only entries covering another path of the same
	 * outcome count as directories.
	 */
	isDirectory?: (path: string) => boolean;
	/**
	 * Waves up to this seq were already learned: a re-run task whose
	 * `previous` outcome is among them is charged only the delta of its
	 * counters. Absent ⇒ every outcome is charged in full (the record
	 * fallback, where the earlier outcome was never learned separately).
	 */
	learnedThroughWaveSeq?: number;
}

function reworkCharge(generation: number): number {
	const w = EPIC_LEARNING_INCIDENT_WEIGHTS;
	const g = Number.isFinite(generation) ? generation : 0;
	return (
		w.reworkPerGeneration * Math.min(Math.max(g - 1, 0), w.reworkMaxGenerations)
	);
}

function count(value: number | undefined): number {
	return Number.isFinite(value) ? Math.max(0, value as number) : 0;
}

/**
 * The learning increments of resolved task outcomes (removed tasks never
 * ran and teach nothing). Pure (the directory probe is injected); the
 * caller merges the result.
 */
export function epicLearningFromOutcomes(
	outcomes: readonly EpicTaskOutcome[],
	options: EpicLearningOptions = {},
): EpicLearningStats {
	const w = EPIC_LEARNING_INCIDENT_WEIGHTS;
	const stats = emptyEpicLearning();
	for (const outcome of outcomes) {
		if (outcome.resolution === 'removed') continue;
		const declared = learnablePaths(outcome.declared);
		const undeclared = learnablePaths(outcome.undeclared).filter(
			(file) => !declared.includes(file),
		);
		const all = [...declared, ...undeclared];
		const fileEntries = declared.filter(
			(entry) =>
				!all.some(
					(other) =>
						other !== entry &&
						other.length > entry.length &&
						pathsConflict(entry, other),
				) && !(options.isDirectory?.(entry) ?? false),
		);
		for (const file of fileEntries) addFile(stats, file, 0, 1);
		for (const file of undeclared) {
			addFile(stats, file, w.undeclared, 0);
			for (const from of declared) addEdge(stats, from, file, 1);
		}
		const previous =
			outcome.previous &&
			options.learnedThroughWaveSeq !== undefined &&
			outcome.previous.waveSeq <= options.learnedThroughWaveSeq
				? outcome.previous
				: null;
		let perDeclared = outcome.mergeFailure ? w.mergeFailurePerDeclared : 0;
		perDeclared +=
			w.stageBFailure *
			Math.max(
				0,
				count(outcome.stageBFailures) - count(previous?.stageBFailures),
			);
		perDeclared += Math.max(
			0,
			reworkCharge(outcome.generation) -
				(previous ? reworkCharge(previous.generation) : 0),
		);
		perDeclared +=
			w.reopen *
			Math.max(0, count(outcome.reopened) - count(previous?.reopened));
		if (perDeclared > 0) {
			for (const file of fileEntries) addFile(stats, file, perDeclared, 0);
		}
	}
	return stats;
}

/** a ⊕ b (new object; inputs untouched). */
export function mergeEpicLearning(
	a: EpicLearningStats,
	b: EpicLearningStats,
): EpicLearningStats {
	const out = cloneEpicLearning(a);
	for (const [file, s] of b.files) addFile(out, file, s.alpha, s.beta);
	for (const [from, targets] of b.edges) {
		for (const [to, weight] of targets) addEdge(out, from, to, weight);
	}
	return out;
}

/** Every mass × factor (new object). */
export function scaleEpicLearning(
	stats: EpicLearningStats,
	factor: number,
): EpicLearningStats {
	const f = Number.isFinite(factor) ? Math.min(Math.max(factor, 0), 1) : 1;
	const out = emptyEpicLearning();
	for (const [file, s] of stats.files) {
		out.files.set(file, { alpha: s.alpha * f, beta: s.beta * f });
	}
	for (const [from, targets] of stats.edges) {
		const scaled = new Map<string, number>();
		for (const [to, weight] of targets) scaled.set(to, weight * f);
		out.edges.set(from, scaled);
	}
	return out;
}

/**
 * Age decay in WHOLE half-lives: 0.5^floor(Δdays / halfLifeDays) — an
 * observation keeps its full weight for a whole half-life (a single
 * co-write keeps expanding scopes until then). 1 for a future or unknown
 * timestamp.
 */
export function epicTimeDecayFactor(
	updatedAtIso: string | null | undefined,
	nowMs: number,
	halfLifeDays: number,
): number {
	const updated = updatedAtIso ? Date.parse(updatedAtIso) : Number.NaN;
	if (!Number.isFinite(updated) || !Number.isFinite(nowMs)) return 1;
	if (!(halfLifeDays > 0)) return 1;
	const days = Math.max(0, nowMs - updated) / DAY_MS;
	return 0.5 ** Math.floor(days / halfLifeDays);
}

/**
 * Drop entries below {@link EPIC_LEARNING_DROP_BELOW} and keep at most the
 * file / edge caps (lowest mass evicted; ties by path). New object.
 */
export function boundEpicLearning(stats: EpicLearningStats): EpicLearningStats {
	const maxFiles = resolveRetentionCap(
		'MAX_EPIC_LEARNING_FILES',
		MAX_EPIC_LEARNING_FILES,
	);
	const maxEdges = resolveRetentionCap(
		'MAX_EPIC_LEARNING_EDGES',
		MAX_EPIC_LEARNING_EDGES,
	);
	const files = [...stats.files]
		.filter(
			([file, s]) =>
				isLearnablePath(file) &&
				Number.isFinite(s.alpha) &&
				Number.isFinite(s.beta) &&
				s.alpha >= 0 &&
				s.beta >= 0 &&
				s.alpha + s.beta >= EPIC_LEARNING_DROP_BELOW,
		)
		.sort(
			([fa, a], [fb, b]) =>
				b.alpha + b.beta - (a.alpha + a.beta) || fa.localeCompare(fb),
		)
		.slice(0, maxFiles);
	const edges: Array<[string, string, number]> = [];
	for (const [from, targets] of stats.edges) {
		for (const [to, weight] of targets) {
			if (
				isLearnablePath(from) &&
				isLearnablePath(to) &&
				from !== to &&
				Number.isFinite(weight) &&
				weight >= EPIC_LEARNING_DROP_BELOW
			) {
				edges.push([from, to, weight]);
			}
		}
	}
	edges.sort(
		(a, b) =>
			b[2] - a[2] || a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]),
	);
	const out = emptyEpicLearning();
	for (const [file, s] of files) out.files.set(file, { ...s });
	for (const [from, to, weight] of edges.slice(0, maxEdges)) {
		addEdge(out, from, to, weight);
	}
	return out;
}

/** r(f) = (a0 + α) / (a0 + b0 + α + β). */
export function epicIncidentRate(stats: EpicFileStats): number {
	return (
		(PRIOR_A0 + stats.alpha) / (PRIOR_A0 + PRIOR_B0 + stats.alpha + stats.beta)
	);
}

export function isEpicHotFile(
	stats: EpicFileStats,
	hotExcess: number,
): boolean {
	return (
		stats.alpha >= EPIC_HOT_MIN_ALPHA &&
		epicIncidentRate(stats) - EPIC_LEARNING_PRIOR_MEAN > hotExcess
	);
}

/** Per file, its strongest learned co-writer: max_d w(d → f). */
function strongestCoWriteInto(stats: EpicLearningStats): Map<string, number> {
	const strongest = new Map<string, number>();
	for (const targets of stats.edges.values()) {
		for (const [to, weight] of targets) {
			if (weight > (strongest.get(to) ?? 0)) strongest.set(to, weight);
		}
	}
	return strongest;
}

/**
 * The incident mass the hot predicate judges (the strongest-co-writer
 * discount): α' = max(0, α − m) when the file's strongest learned co-writer
 * m = max_d w(d → f) is an ACTIVE scope-expansion edge (m ≥
 * {@link EPIC_EXPANSION_MIN_WEIGHT}), else α. Undeclared writes that one
 * declared file keeps explaining are already handled by scope expansion
 * (the declarer now conflicts with the file's owners), so they must not
 * ALSO make the file hot and serialize everyone declaring it; writes from
 * several different declarers (a file that attracts undeclared writes
 * from all over) and the other incidents still count.
 */
export function epicHotIncidentMass(
	stats: EpicFileStats,
	strongestCoWriter: number,
): number {
	return strongestCoWriter >= EPIC_EXPANSION_MIN_WEIGHT
		? Math.max(0, stats.alpha - strongestCoWriter)
		: stats.alpha;
}

/** The hot predicate's evidence for one file (`/swarm epic learning`). */
export interface EpicHotEvidence {
	/** Raw incident mass α. */
	alpha: number;
	/** α' after the strongest-co-writer discount. */
	countedAlpha: number;
	beta: number;
	/** r(α', β). */
	rate: number;
}

export function epicHotEvidence(
	stats: EpicLearningStats,
	file: string,
): EpicHotEvidence {
	const s = stats.files.get(file) ?? { alpha: 0, beta: 0 };
	const countedAlpha = epicHotIncidentMass(
		s,
		strongestCoWriteInto(stats).get(file) ?? 0,
	);
	return {
		alpha: s.alpha,
		countedAlpha,
		beta: s.beta,
		rate: epicIncidentRate({ alpha: countedAlpha, beta: s.beta }),
	};
}

/**
 * Hot files, hottest first (ties by path) — THE hot predicate (planner,
 * sizing, shaping, report and commands all use it): {@link isEpicHotFile}
 * over the discounted incident mass ({@link epicHotIncidentMass}).
 */
export function epicHotFiles(
	stats: EpicLearningStats,
	hotExcess: number,
): string[] {
	const strongest = strongestCoWriteInto(stats);
	return [...stats.files]
		.map(([file, s]): [string, EpicFileStats] => [
			file,
			{
				alpha: epicHotIncidentMass(s, strongest.get(file) ?? 0),
				beta: s.beta,
			},
		])
		.filter(([, s]) => isEpicHotFile(s, hotExcess))
		.sort(
			([fa, a], [fb, b]) =>
				epicIncidentRate(b) - epicIncidentRate(a) || fa.localeCompare(fb),
		)
		.map(([file]) => file);
}

/**
 * scope*(t) = scope(t) ∪ { f : Σ_{d ∈ scope(t)} w(d → f) ≥ 1 } (normalized;
 * declared entries first, learned files appended sorted). Analysis only.
 */
export function expandEpicScope(
	scope: readonly string[],
	coWrites: EpicCoWriteIndex | null,
): string[] {
	const declared = [...new Set(scope.map(normalizePath))];
	if (!coWrites || coWrites.size === 0) return declared;
	const sums = new Map<string, number>();
	for (const from of declared) {
		for (const [to, weight] of coWrites.get(from) ?? []) {
			sums.set(to, (sums.get(to) ?? 0) + weight);
		}
	}
	const learned = [...sums]
		.filter(
			([file, weight]) =>
				weight >= EPIC_EXPANSION_MIN_WEIGHT && !declared.includes(file),
		)
		.map(([file]) => file)
		.sort((a, b) => a.localeCompare(b));
	return [...declared, ...learned];
}

export interface EpicLearningSummary {
	files: number;
	edges: number;
	hotFiles: string[];
	topCoWrites: Array<{ from: string; to: string; weight: number }>;
}

/** A bounded human summary (status / commands). */
export function summarizeEpicLearning(
	stats: EpicLearningStats,
	hotExcess: number,
	limit = 10,
): EpicLearningSummary {
	const edges: Array<{ from: string; to: string; weight: number }> = [];
	for (const [from, targets] of stats.edges) {
		for (const [to, weight] of targets) edges.push({ from, to, weight });
	}
	edges.sort(
		(a, b) =>
			b.weight - a.weight ||
			a.from.localeCompare(b.from) ||
			a.to.localeCompare(b.to),
	);
	return {
		files: stats.files.size,
		edges: edges.length,
		hotFiles: epicHotFiles(stats, hotExcess),
		topCoWrites: edges.slice(0, limit),
	};
}
