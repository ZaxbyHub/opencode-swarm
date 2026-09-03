/**
 * Repo graph context injection for the system-enhancer hook.
 *
 * Produces compact text blocks that surface structural information
 * (importers, dependents, blast radius) for the file the agent is about
 * to edit. Designed to fit within the system-enhancer's per-block budget
 * (~300-500 chars).
 *
 * Failure mode: silent. If no graph exists (`.swarm/repo-graph.json`
 * absent or invalid), this module returns `null` for every helper —
 * the agent simply doesn't get the extra context. The graph is built
 * on-demand by the agent calling `repo_map` with action="build".
 *
 * Caching: the loaded graph is cached in a bounded per-directory LRU and
 * invalidated when the graph artifact changes. Before returning it, the shared
 * bounded workspace probe gates use of the graph. Uncertified graphs and
 * complete drift above the configured refresh cap are suppressed;
 * inconclusive probes remain usable as freshness-unknown, without mutation.
 *
 * Storage modes (issue #1534): when `options.storage === 'indexed'`, the two
 * FILE-SCOPED block builders may, on a full-graph LRU miss, serve a bounded
 * subgraph read from `.swarm/repo-memory.sqlite` instead of parsing the whole
 * JSON document. The kill switch, the stat gate and the freshness probe all
 * run first and are unchanged, and the LRU hit — the common case — never
 * touches SQLite. Whole-graph consumers (`buildLaneOrientationBlock`,
 * `semantic-diff-injection`) always get the full JSON graph.
 */

import * as fs from 'node:fs';
import { loadPluginConfigWithMetaAsync } from '../config/loader';
import { RepoGraphConfigSchema } from '../config/schema';
import {
	askGraph,
	type FreshnessOptions,
	getBlastRadius,
	getGraphNode,
	getGraphPath,
	getKeyFiles,
	getLocalizationContext,
	loadGraphSync,
	probeFreshness,
	type RepoGraph,
} from '../tools/repo-graph';
import { loadSubgraphForFiles } from '../tools/repo-graph/indexed-storage';
import { canonicalRootKeyFresh } from '../utils/canonical-root.js';
import { estimateTokens } from './utils';

interface CachedGraph {
	graph: RepoGraph;
	mtimeMs: number;
	size: number;
	/**
	 * File identity from `st.ino`. The indexed freshness stamp relies on it
	 * because same-size/same-mtime-tick rewrites are common, and these caches
	 * shadow that stamp (a hit short-circuits before the index is consulted).
	 * On filesystems reporting no usable id it is 0 on both sides, so the
	 * comparator degrades to mtime+size exactly as before.
	 */
	ino: number;
}

const cache = new Map<string, CachedGraph>();
const MAX_CACHED_DIRECTORIES = 16;

/**
 * Bounded LRU for indexed-mode subgraphs (issue #1534).
 *
 * Deliberately SEPARATE from `cache`: a subgraph is a partial view built for
 * one specific (files, depth) request and must never be handed to a
 * whole-graph consumer (`askGraph`, `getKeyFiles`, `semantic-diff-injection`).
 * Writing one into `cache` would do exactly that.
 */
const subgraphCache = new Map<string, RepoGraph>();
const MAX_CACHED_SUBGRAPHS = 32;

export interface RepoGraphInjectionOptions extends FreshnessOptions {
	enabled?: boolean;
	refreshCap?: number;
	/**
	 * Resolved `repo_graph.storage` mode (issue #1534). Passed in by the caller
	 * — this module deliberately never reads config synchronously (see the
	 * `loadPluginConfigWithMetaAsync` note on `_internals`), so the mode rides
	 * in beside `enabled` / `refreshCap`. Anything other than `'indexed'`
	 * (including `undefined`) keeps every path on the JSON document.
	 */
	storage?: 'json' | 'indexed';
}

export const _internals = {
	probeFreshness,
	cacheSize: () => cache.size,
	subgraphCacheSize: () => subgraphCache.size,
	renderLaneOrientationBlock,
	orientationFreshnessLine,
	// Routed through the seam so tests can force the config-load failure
	// fallback (the sync-free async variant per issue #704/#1900 discipline).
	loadPluginConfigWithMetaAsync,
	// Seam (invariant 7: DI over mock.module) so tests can count SQLite reads
	// and assert the suppression gates return before the index is consulted.
	loadSubgraphForFiles,
	// Exposed so tests can pin the key's ino sensitivity (PRR-003): dropping
	// it would let same-size/same-mtime rewrites reuse stale subgraphs.
	subgraphCacheKey,
};

function touchCache(key: string, value: CachedGraph): void {
	cache.delete(key);
	cache.set(key, value);
	while (cache.size > MAX_CACHED_DIRECTORIES) {
		const oldest = cache.keys().next().value;
		if (oldest === undefined) break;
		cache.delete(oldest);
	}
}

function touchSubgraphCache(key: string, value: RepoGraph): void {
	subgraphCache.delete(key);
	subgraphCache.set(key, value);
	while (subgraphCache.size > MAX_CACHED_SUBGRAPHS) {
		const oldest = subgraphCache.keys().next().value;
		if (oldest === undefined) break;
		subgraphCache.delete(oldest);
	}
}

/**
 * Cache key for a subgraph request. The graph artifact's `{mtimeMs, size, ino}`
 * is part of the key, so a graph change invalidates every cached subgraph for
 * that directory without an explicit sweep — the identical invalidation
 * contract the full-graph LRU uses. Files are sorted because the closure is a
 * set union and is order-independent; the caller's own array order (which does
 * drive `BlastRadiusResult.target` and the rendered target list) is never read
 * from this key. NUL is the separator because it is the one character that
 * cannot appear in a path component, so no two distinct requests can collide
 * by concatenation.
 */
function subgraphCacheKey(
	directoryKey: string,
	stat: { mtimeMs: number; size: number; ino: number },
	files: readonly string[],
	depth: number,
): string {
	return [
		directoryKey,
		String(stat.mtimeMs),
		String(stat.size),
		String(stat.ino),
		String(depth),
		[...files].sort().join('\u0000'),
	].join('\u0000');
}

/**
 * Outcome of the shared gate sequence that precedes every graph
 * materialization. Extracted so `getCachedGraph` and the indexed-aware block
 * builders run the SAME gates in the SAME order rather than duplicating them.
 */
type GraphGateResult =
	| { kind: 'suppressed' }
	| { kind: 'hit'; graph: RepoGraph }
	| {
			kind: 'miss';
			key: string;
			stat: { mtimeMs: number; size: number; ino: number };
	  };

/**
 * Gates 1-4 of the injection contract, in the order the approved plan for
 * issue #1534 fixes:
 *
 *   1. `enabled === false` — the `repo_graph.enabled` kill switch. Evicts the
 *      cache entry and returns without any I/O beyond the eviction.
 *   2. The graph artifact must stat.
 *   3. Freshness suppression (`no-fingerprint`, or `drifted` beyond the
 *      refresh cap). Evaluated BEFORE any graph or subgraph is materialized:
 *      `probeFreshness` takes only the directory and never reads the graph, so
 *      hoisting it above materialization is behavior-preserving and avoids a
 *      full JSON parse (or a SQLite open) on the suppressed path.
 *   4. Full-graph LRU hit — the common case, which must never touch SQLite.
 *
 * A `miss` result means the caller may materialize: indexed subgraph first
 * where that applies, otherwise the full JSON document.
 */
async function evaluateGraphGates(
	directory: string,
	options?: RepoGraphInjectionOptions,
): Promise<GraphGateResult> {
	const key = canonicalRootKeyFresh(directory);
	if (options?.enabled === false) {
		cache.delete(key);
		return { kind: 'suppressed' };
	}
	const file = getGraphPath(directory);
	let stat: fs.Stats;
	try {
		stat = fs.statSync(file);
	} catch {
		// No graph file. Drop any stale cache entry.
		cache.delete(key);
		return { kind: 'suppressed' };
	}

	const probe = await _internals.probeFreshness(directory, options);
	const observedDrift = probe.changed.length + probe.removed.length;
	const refreshCap = options?.refreshCap ?? 50;
	if (
		probe.state === 'no-fingerprint' ||
		(probe.state === 'drifted' && observedDrift > refreshCap)
	) {
		return { kind: 'suppressed' };
	}

	const cached = cache.get(key);
	if (
		cached &&
		cached.mtimeMs === stat.mtimeMs &&
		cached.size === stat.size &&
		cached.ino === stat.ino
	) {
		touchCache(key, cached);
		return { kind: 'hit', graph: cached.graph };
	}
	return {
		kind: 'miss',
		key,
		stat: { mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino },
	};
}

/** Gate 6: parse the whole JSON document and populate the full-graph LRU. */
function loadFullGraph(
	directory: string,
	key: string,
	stat: { mtimeMs: number; size: number; ino: number },
): RepoGraph | null {
	let graph: RepoGraph | null;
	try {
		graph = loadGraphSync(directory);
	} catch {
		cache.delete(key);
		return null;
	}
	if (!graph) {
		cache.delete(key);
		return null;
	}
	touchCache(key, {
		graph,
		mtimeMs: stat.mtimeMs,
		size: stat.size,
		ino: stat.ino,
	});
	return graph;
}

/**
 * Load the repo graph for `directory`, using a bounded per-directory cache that
 * invalidates on file mtime/size change and a shared content-freshness gate.
 * Returns null if no graph exists or its workspace alignment is unsafe.
 *
 * Always returns the WHOLE graph — `semantic-diff-injection` and
 * `buildLaneOrientationBlock` are whole-graph consumers and must never receive
 * a bounded subgraph.
 *
 * Exported only for tests; production callers use the buildXxxBlock helpers below.
 */
export async function getCachedGraph(
	directory: string,
	options?: RepoGraphInjectionOptions,
): Promise<RepoGraph | null> {
	const gate = await evaluateGraphGates(directory, options);
	if (gate.kind === 'suppressed') return null;
	if (gate.kind === 'hit') return gate.graph;
	return loadFullGraph(directory, gate.key, gate.stat);
}

/**
 * Graph resolution for the two file-scoped block builders (issue #1534).
 *
 * Identical to {@link getCachedGraph} except for gate 5: on a full-graph LRU
 * miss in `indexed` mode, a bounded subgraph covering `files` to `depth` is
 * served instead of a whole-document `JSON.parse`. The subgraph is an ordinary
 * `RepoGraph` fed to the existing, unmodified `getGraphNode` /
 * `getLocalizationContext` / `getBlastRadius` — no query logic is duplicated.
 *
 * `loadSubgraphForFiles` verifies index freshness, workspace binding and
 * integrity internally and returns null on any doubt, so a null result simply
 * falls through to the JSON path.
 */
async function resolveGraphForFiles(
	directory: string,
	files: readonly string[],
	depth: number,
	options?: RepoGraphInjectionOptions,
): Promise<RepoGraph | null> {
	const gate = await evaluateGraphGates(directory, options);
	if (gate.kind === 'suppressed') return null;
	if (gate.kind === 'hit') return gate.graph;

	if (options?.storage === 'indexed' && files.length > 0) {
		const subKey = subgraphCacheKey(gate.key, gate.stat, files, depth);
		const cachedSubgraph = subgraphCache.get(subKey);
		if (cachedSubgraph) {
			touchSubgraphCache(subKey, cachedSubgraph);
			return cachedSubgraph;
		}
		let subgraph: RepoGraph | null = null;
		try {
			subgraph = _internals.loadSubgraphForFiles(directory, [...files], depth);
		} catch {
			// Fail-open: the index is an accelerator, never a durability point.
			subgraph = null;
		}
		if (subgraph) {
			// Deliberately NOT written into the full-graph LRU.
			touchSubgraphCache(subKey, subgraph);
			return subgraph;
		}
	}

	return loadFullGraph(directory, gate.key, gate.stat);
}

/** Test-only: clear the per-directory cache. */
export function resetGraphInjectionCache(): void {
	cache.clear();
	subgraphCache.clear();
}

/**
 * Build a localization block for a target file. Used by the coder agent
 * to surface importers/dependencies/blast-radius before editing.
 *
 * Returns null when:
 *   - No graph exists.
 *   - The target isn't tracked in the graph (file too new, language unsupported).
 */
export async function buildCoderLocalizationBlock(
	directory: string,
	targetFile: string,
	options?: RepoGraphInjectionOptions,
): Promise<string | null> {
	if (!targetFile) return null;
	const normalized = targetFile.replace(/\\/g, '/').replace(/^\.\/+/, '');
	// Depth 2 matches the `maxDepth` handed to getLocalizationContext below;
	// the closure must cover exactly what that call can reach.
	const graph = await resolveGraphForFiles(directory, [normalized], 2, options);
	if (!graph) return null;
	const targetNode = getGraphNode(graph, normalized);
	if (!targetNode) return null;
	const ctx = getLocalizationContext(graph, normalized, {
		maxImporters: 5,
		maxDeps: 5,
		maxDepth: 2,
	});
	return [
		'## REPO GRAPH — LOCALIZATION',
		ctx.summary,
		'_(Run `repo_map action="blast_radius"` for full transitive dependents.)_',
	].join('\n');
}

/**
 * Build a blast-radius block for a list of changed files. Used by the
 * reviewer agent to spot-check whether unseen consumers might break.
 *
 * Returns null when no graph exists or when none of the files are in the
 * graph. The result is bounded to the top 8 dependents to stay within
 * the per-block context budget.
 */
export async function buildReviewerBlastRadiusBlock(
	directory: string,
	changedFiles: string[],
	options?: RepoGraphInjectionOptions,
): Promise<string | null> {
	if (changedFiles.length === 0) return null;
	const requested = changedFiles.map((f) =>
		f.replace(/\\/g, '/').replace(/^\.\/+/, ''),
	);
	// The closure is the union over ALL requested files computed in ONE call:
	// getBlastRadius seeds `visited` with every target simultaneously, so a
	// file that is both a target and another target's dependent must be
	// pre-visited. Per-file subgraphs merged afterwards would produce a
	// different totalDependents and therefore a different riskLevel.
	// Depth 3 matches the getBlastRadius maxDepth below.
	const graph = await resolveGraphForFiles(directory, requested, 3, options);
	if (!graph) return null;
	// Requested files absent from the graph are dropped here, against whatever
	// graph was handed back — the subgraph must resolve every requested file
	// exactly as the full graph would.
	const normalized = requested.filter(
		(f) => getGraphNode(graph, f) !== undefined,
	);
	if (normalized.length === 0) return null;

	const blast = getBlastRadius(graph, normalized, 3);
	const directList =
		blast.directDependents.length === 0
			? '(none)'
			: blast.directDependents.slice(0, 8).join(', ') +
				(blast.directDependents.length > 8
					? `, +${blast.directDependents.length - 8} more`
					: '');
	const transitiveSummary =
		blast.transitiveDependents.length === 0
			? '(none)'
			: `${blast.transitiveDependents.length} files (depth ${blast.depthReached})`;

	const targetList =
		normalized.length <= 3
			? normalized.join(', ')
			: `${normalized.slice(0, 3).join(', ')}, +${normalized.length - 3} more`;

	return [
		'## REPO GRAPH — BLAST RADIUS',
		`  Changed: ${targetList}`,
		`  Direct dependents: ${directList}`,
		`  Transitive dependents: ${transitiveSummary}`,
		`  Risk: ${blast.riskLevel} (${blast.totalDependents} total)`,
		'_Verify these dependents still build/typecheck._',
	].join('\n');
}

/**
 * Options for {@link buildLaneOrientationBlock}.
 *
 * `sessionID` scopes the novelty dedupe so two controller sessions never
 * suppress each other's orientation blocks (invariant 8).
 */
export interface LaneOrientationOptions extends RepoGraphInjectionOptions {
	sessionID?: string;
}

/**
 * Relevance floor for the top `ask` hit (plan §7.2 starting constant; PR6
 * re-tunes). Applied to the normalized top-hit share — top score divided by
 * the sum of the top-3 hit scores (the top hit's absolute score when fewer
 * than 3 hits exist). Raw askGraph scores are personalized-PageRank
 * probabilities that sum to 1 across ALL graph nodes, so their absolute
 * magnitude scales with 1/graph-size: on this repository (3.4k nodes) a
 * perfectly-targeted mission yields top scores of ~0.01, while a uniform
 * noise ranking yields ~1/N per file. The share normalization makes the
 * 0.35 constant mean the same thing on every scale: the top file must own
 * more than a third of the top-3 ranking mass (a diffuse ranking scores
 * ~0.33 and is suppressed; a concentrated one clears the floor). Verified
 * against this repo: real missions measure 0.35-0.37 share and emit.
 */
const LANE_ORIENTATION_SCORE_FLOOR = 0.35;
/** Rendered-block budget, in estimateTokens tokens. */
const LANE_ORIENTATION_MAX_TOKENS = 600;
/** How many mission-ranked files and repo hubs the block may list. */
const LANE_ORIENTATION_TOP_ASK_FILES = 6;
const LANE_ORIENTATION_TOP_KEY_FILES = 4;
/**
 * Deterministic bound on the concatenated lane mission text fed to `ask`.
 * Keeps the question bounded no matter how many lanes or how long their
 * prompts are (lane prompts alone may be up to MAX_PROMPT_CHARS each).
 */
const ORIENTATION_MISSION_CHAR_BUDGET = 4_000;
/** Per-session already-delivered file pointers, FIFO-evicted at this bound. */
const LANE_ORIENTATION_DEDUPE_BOUND = 128;
/** Bound on tracked dedupe sessions (invariant 8: explicit eviction). */
const LANE_ORIENTATION_MAX_SESSIONS = 16;

const laneOrientationDelivered = new Map<string, Set<string>>();

/** Test-only: clear the per-session orientation dedupe state. */
export function resetLaneOrientationDedupe(): void {
	laneOrientationDelivered.clear();
}

function sessionDeliveredSet(sessionKey: string): Set<string> {
	const existing = laneOrientationDelivered.get(sessionKey);
	if (existing) return existing;
	while (laneOrientationDelivered.size >= LANE_ORIENTATION_MAX_SESSIONS) {
		const oldestSession = laneOrientationDelivered.keys().next().value;
		if (oldestSession === undefined) break;
		laneOrientationDelivered.delete(oldestSession);
	}
	const created = new Set<string>();
	laneOrientationDelivered.set(sessionKey, created);
	return created;
}

function recordDeliveredPointers(
	sessionKey: string,
	pointers: readonly string[],
): void {
	const delivered = sessionDeliveredSet(sessionKey);
	for (const pointer of pointers) {
		delivered.add(pointer);
		while (delivered.size > LANE_ORIENTATION_DEDUPE_BOUND) {
			const oldest = delivered.values().next().value;
			if (oldest === undefined) break;
			delivered.delete(oldest);
		}
	}
}

interface OrientationAskFile {
	file: string;
	score: number;
	exports: string[];
}

/**
 * Pure render for the lane orientation block. Deterministic: a pure function
 * of its arguments — no timestamps, no randomness, no probe timing fields.
 * Exported only through {@link _internals} for tests.
 */
function renderLaneOrientationBlock(
	askFiles: OrientationAskFile[],
	hubFiles: string[],
	freshnessLine: string,
): string {
	const lines: string[] = ['## REPO GRAPH — LANE ORIENTATION'];
	if (askFiles.length > 0) {
		lines.push(
			'Mission-relevant files (graph-ranked; orientation only — read before relying):',
		);
		for (const hit of askFiles) {
			const exports = hit.exports.slice(0, 3).join(', ');
			lines.push(
				`- ${hit.file} (score ${hit.score.toFixed(2)}${exports ? `; exports: ${exports}` : ''})`,
			);
		}
	}
	if (hubFiles.length > 0) {
		lines.push(`Repo hubs (most imported): ${hubFiles.join(', ')}`);
	}
	lines.push(`Freshness: ${freshnessLine}`);
	return lines.join('\n');
}

/**
 * Deterministic freshness statement for the orientation block. Only probe
 * state and drift counts feed the text — never elapsedMs, probedFiles, or
 * truncated, which would break the block's determinism contract.
 */
function orientationFreshnessLine(
	state: string,
	changedCount: number,
	removedCount: number,
): string {
	if (state === 'clean') return 'fresh (probe clean)';
	if (state === 'drifted') {
		return `drifted within refresh cap (${changedCount} changed, ${removedCount} removed)`;
	}
	return 'freshness unknown (probe inconclusive)';
}

/**
 * Build a bounded, relevance-gated repo-graph orientation block for a lane
 * dispatch batch (issue #1988 C2/C6). The block is appended to the shared
 * `common_prompt` prefix by the dispatch caller.
 *
 * Gating policy — the block is emitted only when ALL hold:
 *   - a usable graph exists (fresh, or drifted within the refresh cap);
 *   - the top `ask` hit for the concatenated mission texts clears
 *     LANE_ORIENTATION_SCORE_FLOOR;
 *   - at least one file pointer is novel for this session (per-session
 *     novelty dedupe, bounded FIFO — suppressed repeats emit NOTHING);
 *   - the rendered block fits LANE_ORIENTATION_MAX_TOKENS.
 *
 * Determinism contract: a pure function of (graph state, mission texts,
 * empty dedupe state) — the same dispatch replayed from a reset dedupe
 * state produces a byte-identical block. Returns null on every gate
 * failure or error; never throws into the dispatch path.
 */
export async function buildLaneOrientationBlock(
	directory: string,
	lanePrompts: string[],
	options?: LaneOrientationOptions,
): Promise<string | null> {
	try {
		let resolved: RepoGraphInjectionOptions = options ?? {};
		try {
			const { config } =
				await _internals.loadPluginConfigWithMetaAsync(directory);
			const repoGraphConfig = RepoGraphConfigSchema.parse(
				config.repo_graph ?? {},
			);
			resolved = {
				...resolved,
				enabled: options?.enabled ?? repoGraphConfig.enabled,
				refreshCap: options?.refreshCap ?? repoGraphConfig.refresh_cap,
				maxFiles: options?.maxFiles ?? repoGraphConfig.max_files,
				walkBudgetMs: options?.walkBudgetMs ?? repoGraphConfig.walk_budget_ms,
				excludeDirs: options?.excludeDirs ?? repoGraphConfig.exclude_dirs,
			};
		} catch {
			// No readable plugin config — fall back to option defaults.
		}

		// DELIBERATE (issue #1534): this block stays on the JSON path and calls
		// getCachedGraph, never resolveGraphForFiles. `askGraph` runs a
		// personalized PageRank over EVERY node and `getKeyFiles` ranks
		// in-degree over `Object.values(graph.nodes)` — both are whole-graph
		// computations whose results would silently change (different scores,
		// different hubs, a different relevance floor outcome) if handed a
		// bounded subgraph. `getCachedGraph` never consults `options.storage`
		// for exactly that reason, so this block is unaffected by the mode.
		// Do not "finish the job" by routing this through the indexed path.
		const graph = await getCachedGraph(directory, resolved);
		if (!graph) return null;

		const missionText = lanePrompts
			.join('\n')
			.slice(0, ORIENTATION_MISSION_CHAR_BUDGET);
		if (!missionText.trim()) return null;
		const ask = askGraph(graph, missionText, {
			topN: LANE_ORIENTATION_TOP_ASK_FILES,
		});
		if (ask.hits.length === 0) return null;
		const topScore = ask.hits[0].score;
		const floorValue =
			ask.hits.length >= 3
				? topScore / (topScore + ask.hits[1].score + ask.hits[2].score)
				: topScore;
		if (floorValue < LANE_ORIENTATION_SCORE_FLOOR) return null;

		const probe = await _internals.probeFreshness(directory, resolved);
		const freshnessLine = orientationFreshnessLine(
			probe.state,
			probe.changed.length,
			probe.removed.length,
		);

		const sessionKey = options?.sessionID ?? '';
		const delivered = sessionDeliveredSet(sessionKey);
		const novelAskFiles: OrientationAskFile[] = ask.hits
			.filter((hit) => !delivered.has(hit.file))
			.map((hit) => ({
				file: hit.file,
				score: hit.score,
				exports: hit.topExports,
			}));
		const novelHubFiles = getKeyFiles(graph, LANE_ORIENTATION_TOP_KEY_FILES)
			.map((node) => node.moduleName)
			.filter((file) => !delivered.has(file));
		if (novelAskFiles.length === 0 && novelHubFiles.length === 0) {
			// Suppressed repeat: emit nothing (no nudge text in lane prompts).
			return null;
		}

		const block = renderLaneOrientationBlock(
			novelAskFiles,
			novelHubFiles,
			freshnessLine,
		);
		if (estimateTokens(block) > LANE_ORIENTATION_MAX_TOKENS) return null;

		recordDeliveredPointers(sessionKey, [
			...novelAskFiles.map((hit) => hit.file),
			...novelHubFiles,
		]);
		return block;
	} catch {
		// Silent fallback contract: orientation is advisory and must never
		// break dispatch.
		return null;
	}
}
