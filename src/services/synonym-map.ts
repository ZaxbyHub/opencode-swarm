/**
 * Tag co-occurrence synonym map (Change 5 / Task 6.2).
 *
 * Retrieval is brittle when a query phrases a concept differently from the
 * stored directive ("module mocks" vs "dependency seams"). Rather than ship a
 * hand-curated thesaurus or a new NLP dependency, we learn synonyms from the
 * corpus itself: tokens that repeatedly co-occur across an entry's
 * triggers / tags / applies_to_tools / applies_to_agents are treated as
 * related. A pair seen at or above `synonym_min_cooccurrence` distinct entries
 * becomes a synonym edge that retrieval can expand a query along.
 *
 * State file: `.swarm/synonym-map.json` (validated through validateSwarmPath).
 *
 * SECURITY: the map is derived from on-disk knowledge entries, which can be
 * attacker-influenced (auto-enrichment, hive imports). Every token is
 * sanitised against control characters and length-bounded BEFORE it ever
 * reaches the map, and the map is hard-capped (`synonym_map_max_pairs`,
 * LRU-evicted by recency) so a flood of junk pairs cannot grow it without
 * bound. Expansion is therefore bounded and cannot inject paths, regex
 * metacharacters with effect, or arbitrarily long strings into the scorer.
 */

import {
	mkdir,
	readFile,
	rename,
	stat,
	unlink,
	writeFile,
} from 'node:fs/promises';
import * as path from 'node:path';
import lockfile from 'proper-lockfile';
import { validateSwarmPath } from '../hooks/utils.js';

export const SYNONYM_MAP_FILENAME = 'synonym-map.json';

/** Hard upper bound on a single sanitised token's length. */
const MAX_TOKEN_LENGTH = 64;
/** Default cap on retained pairs when no config is supplied. */
const DEFAULT_MAX_PAIRS = 500;
/** Default co-occurrence threshold for treating a pair as synonyms. */
const DEFAULT_MIN_COOCCURRENCE = 3;
/** Cap on synonyms expanded per query token (keeps the candidate pool bounded). */
const DEFAULT_MAX_EXPANSIONS_PER_TOKEN = 4;

/** A single learned co-occurrence edge between two distinct tokens. */
export interface SynonymPair {
	/** Lexicographically-first member (sanitised). */
	a: string;
	/** Lexicographically-second member (sanitised). */
	b: string;
	/** Number of distinct entries in which both tokens co-occurred. */
	count: number;
	/** Monotonic recency marker (for LRU eviction). Higher = more recent. */
	seq: number;
}

/** On-disk shape of `.swarm/synonym-map.json`. */
export interface SynonymMap {
	version: 1;
	/** Monotonic counter; the next recorded/touched pair takes `seq = ++cursor`. */
	cursor: number;
	/** Keyed by `pairKey(a, b)`. */
	pairs: Record<string, SynonymPair>;
}

export function emptySynonymMap(): SynonymMap {
	return { version: 1, cursor: 0, pairs: {} };
}

export function resolveSynonymMapPath(directory: string): string {
	return validateSwarmPath(directory, SYNONYM_MAP_FILENAME);
}

/**
 * Normalise a candidate token to its canonical synonym-map form, or return
 * `null` if it is unusable. Strips control characters (poisoning defence),
 * lowercases, collapses internal whitespace to single spaces, trims, and
 * enforces a length bound. Non-string input yields `null`.
 */
export function sanitizeToken(raw: unknown): string | null {
	if (typeof raw !== 'string') return null;
	// Strip C0/C1 control chars and the DEL range; these have no place in a
	// token and are a classic vector for log/render poisoning.
	// biome-ignore lint/suspicious/noControlCharactersInRegex: deliberate control-char stripping
	const stripped = raw.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
	const token = stripped.toLowerCase().replace(/\s+/g, ' ').trim();
	if (token.length === 0) return null;
	if (token.length > MAX_TOKEN_LENGTH) return null;
	return token;
}

/**
 * Stable key for an unordered pair of distinct tokens. The two members are
 * sorted so `pairKey(a, b) === pairKey(b, a)`. A NUL separator cannot appear in
 * a sanitised token, so the key is unambiguous.
 */
const PAIR_SEP = String.fromCharCode(0);

export function pairKey(a: string, b: string): string {
	return a < b ? `${a}${PAIR_SEP}${b}` : `${b}${PAIR_SEP}${a}`;
}

/** A subset of KnowledgeEntry fields relevant to synonym learning. */
export interface SynonymSourceEntry {
	triggers?: string[];
	tags?: string[];
	applies_to_tools?: string[];
	applies_to_agents?: string[];
}

/**
 * Collect the sanitised, de-duplicated token set that represents one entry for
 * co-occurrence learning. Draws from the entry's triggers, tags,
 * applies_to_tools, and applies_to_agents.
 */
export function tokensForEntry(entry: SynonymSourceEntry): string[] {
	const out = new Set<string>();
	const fields: Array<string[] | undefined> = [
		entry.triggers,
		entry.tags,
		entry.applies_to_tools,
		entry.applies_to_agents,
	];
	for (const field of fields) {
		if (!Array.isArray(field)) continue;
		for (const raw of field) {
			const token = sanitizeToken(raw);
			if (token) out.add(token);
		}
	}
	return Array.from(out);
}

/**
 * Evict the least-recently-touched pairs until `map.pairs` is within
 * `maxPairs`. Mutates `map` in place. Eviction order is by ascending `seq`
 * (oldest first); ties broken by key for determinism.
 */
function evictToCap(map: SynonymMap, maxPairs: number): void {
	const keys = Object.keys(map.pairs);
	if (keys.length <= maxPairs) return;
	keys.sort((k1, k2) => {
		const s1 = map.pairs[k1].seq;
		const s2 = map.pairs[k2].seq;
		if (s1 !== s2) return s1 - s2;
		return k1 < k2 ? -1 : 1;
	});
	const removeCount = keys.length - maxPairs;
	for (let i = 0; i < removeCount; i++) {
		delete map.pairs[keys[i]];
	}
}

/**
 * Pure: fold one entry's token set into the map, incrementing the co-occurrence
 * count of every distinct token pair and refreshing its recency. Applies the
 * LRU cap afterward. Returns the same `map` reference (mutated) for chaining.
 *
 * Each entry contributes at most +1 to any given pair (the token set is already
 * de-duplicated), so a single entry repeating a tag cannot inflate a pair.
 */
export function recordEntryCooccurrences(
	map: SynonymMap,
	entry: SynonymSourceEntry,
	maxPairs: number = DEFAULT_MAX_PAIRS,
): SynonymMap {
	const tokens = tokensForEntry(entry);
	if (tokens.length < 2) return map;
	for (let i = 0; i < tokens.length; i++) {
		for (let j = i + 1; j < tokens.length; j++) {
			const a = tokens[i];
			const b = tokens[j];
			if (a === b) continue;
			const key = pairKey(a, b);
			const seq = ++map.cursor;
			const existing = map.pairs[key];
			if (existing) {
				existing.count += 1;
				existing.seq = seq;
			} else {
				const [lo, hi] = a < b ? [a, b] : [b, a];
				map.pairs[key] = { a: lo, b: hi, count: 1, seq };
			}
		}
	}
	evictToCap(map, maxPairs);
	return map;
}

/**
 * Pure: rebuild the synonym map from scratch over a list of entries. Used by the
 * curator after phase_complete so the map reflects the current corpus rather
 * than drifting monotonically. Returns a fresh map.
 */
export function buildSynonymMap(
	entries: SynonymSourceEntry[],
	maxPairs: number = DEFAULT_MAX_PAIRS,
): SynonymMap {
	const map = emptySynonymMap();
	for (const entry of entries) {
		recordEntryCooccurrences(map, entry, maxPairs);
	}
	return map;
}

/**
 * Pure: derive an undirected adjacency index of synonyms from the map, keeping
 * only pairs whose count is at or above `minCooccurrence`. Returns a Map from
 * each token to the set of its synonym tokens.
 */
export function buildSynonymIndex(
	map: SynonymMap,
	minCooccurrence: number = DEFAULT_MIN_COOCCURRENCE,
): Map<string, Set<string>> {
	const index = new Map<string, Set<string>>();
	const threshold = Math.max(1, minCooccurrence);
	for (const pair of Object.values(map.pairs)) {
		if (pair.count < threshold) continue;
		add(index, pair.a, pair.b);
		add(index, pair.b, pair.a);
	}
	return index;
}

function add(index: Map<string, Set<string>>, from: string, to: string): void {
	let set = index.get(from);
	if (!set) {
		set = new Set<string>();
		index.set(from, set);
	}
	set.add(to);
}

/**
 * Pure: expand a list of query tokens with their learned synonyms. Input tokens
 * are sanitised first so the caller can pass raw query terms. Returns only the
 * NEW synonym tokens (never the originals), de-duplicated, with a per-token cap
 * so one over-connected token cannot dominate the candidate pool. Synonyms are
 * emitted in sorted order and sliced — recency is deliberately ignored so the
 * result is deterministic regardless of insertion order.
 */
export function expandTokens(
	index: Map<string, Set<string>>,
	queryTokens: string[],
	maxPerToken: number = DEFAULT_MAX_EXPANSIONS_PER_TOKEN,
): string[] {
	const originals = new Set<string>();
	for (const raw of queryTokens) {
		const token = sanitizeToken(raw);
		if (token) originals.add(token);
	}
	const expanded = new Set<string>();
	for (const token of originals) {
		const synonyms = index.get(token);
		if (!synonyms) continue;
		const sorted = Array.from(synonyms).sort();
		let added = 0;
		for (const syn of sorted) {
			if (added >= maxPerToken) break;
			if (originals.has(syn)) continue;
			if (expanded.has(syn)) continue;
			expanded.add(syn);
			added += 1;
		}
	}
	return Array.from(expanded);
}

// ============================================================================
// I/O (atomic, lock-guarded — mirrors skill-improver-quota.ts conventions)
// ============================================================================

function isSynonymPair(value: unknown): value is SynonymPair {
	if (typeof value !== 'object' || value === null) return false;
	const p = value as Record<string, unknown>;
	return (
		typeof p.a === 'string' &&
		typeof p.b === 'string' &&
		typeof p.count === 'number' &&
		Number.isFinite(p.count) &&
		typeof p.seq === 'number' &&
		Number.isFinite(p.seq)
	);
}

/** Per-pair byte budget used to derive the read-side file-size ceiling. */
const APPROX_BYTES_PER_PAIR = 512;
/** Floor for the read-side file-size ceiling regardless of a tiny maxPairs. */
const MIN_READ_CEILING_BYTES = 64 * 1024;

/**
 * Coerce arbitrary parsed JSON into a valid SynonymMap, dropping any malformed
 * or unsafe pairs. Re-sanitises every token and re-derives the canonical key so
 * a tampered file (control chars, mismatched key) cannot smuggle a poisoned
 * token into retrieval. Enforces the same `maxPairs` LRU cap on READ that the
 * write path enforces, so a tampered file with a huge pair count cannot make
 * every retrieval pay an unbounded coerce/index cost. Returns a fresh empty map
 * on any structural failure.
 */
export function coerceSynonymMap(
	parsed: unknown,
	maxPairs: number = DEFAULT_MAX_PAIRS,
): SynonymMap {
	if (typeof parsed !== 'object' || parsed === null) return emptySynonymMap();
	const obj = parsed as Record<string, unknown>;
	if (
		obj.version !== 1 ||
		typeof obj.pairs !== 'object' ||
		obj.pairs === null
	) {
		return emptySynonymMap();
	}
	const out = emptySynonymMap();
	let cursor =
		typeof obj.cursor === 'number' && Number.isFinite(obj.cursor)
			? obj.cursor
			: 0;
	for (const value of Object.values(obj.pairs as Record<string, unknown>)) {
		if (!isSynonymPair(value)) continue;
		const a = sanitizeToken(value.a);
		const b = sanitizeToken(value.b);
		if (!a || !b || a === b) continue;
		const count = Math.max(0, Math.floor(value.count));
		if (count <= 0) continue;
		const key = pairKey(a, b);
		const seq = Number.isFinite(value.seq) ? value.seq : ++cursor;
		if (seq > cursor) cursor = seq;
		const existing = out.pairs[key];
		// On a duplicate (e.g. a tampered file with both orderings), keep the
		// larger count and the more-recent seq.
		if (existing) {
			existing.count = Math.max(existing.count, count);
			existing.seq = Math.max(existing.seq, seq);
		} else {
			const [lo, hi] = a < b ? [a, b] : [b, a];
			out.pairs[key] = { a: lo, b: hi, count, seq };
		}
	}
	out.cursor = cursor;
	// Read-side hard cap (defense-in-depth against a tampered/oversized file that
	// slipped under the byte ceiling): keep only the most-recent `maxPairs`.
	evictToCap(out, Math.max(1, Math.floor(maxPairs)));
	return out;
}

/**
 * Read and validate the synonym map. Returns an empty map if absent/invalid.
 * Bounded: a file larger than the `maxPairs`-derived byte ceiling is ignored
 * WITHOUT being parsed, so a tampered/oversized map cannot blow up memory or CPU
 * on the retrieval hot path. `maxPairs` is also enforced as an LRU cap on the
 * coerced result.
 */
export async function readSynonymMap(
	directory: string,
	maxPairs: number = DEFAULT_MAX_PAIRS,
): Promise<SynonymMap> {
	let filePath: string;
	try {
		filePath = resolveSynonymMapPath(directory);
	} catch {
		return emptySynonymMap();
	}
	try {
		const ceiling = Math.max(
			MIN_READ_CEILING_BYTES,
			Math.floor(maxPairs) * APPROX_BYTES_PER_PAIR,
		);
		// Check size before reading so an oversized file is never loaded into
		// memory. A legitimately written map is ~maxPairs small pairs, well under
		// the ceiling; anything larger is treated as tampered → no expansion.
		const st = await stat(filePath);
		if (st.size > ceiling) return emptySynonymMap();
		const raw = await readFile(filePath, 'utf-8');
		return coerceSynonymMap(JSON.parse(raw), maxPairs);
	} catch {
		return emptySynonymMap();
	}
}

async function writeSynonymMapAtomic(
	filePath: string,
	map: SynonymMap,
): Promise<void> {
	await mkdir(path.dirname(filePath), { recursive: true });
	// Unique temp suffix (not pid-stable) + finally cleanup, matching the repo's
	// blessed atomicWriteFile pattern, so a failed write/rename (e.g. Windows
	// EPERM when a reader holds the target open) never orphans a .tmp in .swarm/.
	const tmp = `${filePath}.tmp.${Date.now()}.${Math.floor(Math.random() * 1e9)}`;
	try {
		await writeFile(tmp, JSON.stringify(map, null, 2), 'utf-8');
		await rename(tmp, filePath);
	} finally {
		try {
			await unlink(tmp);
		} catch {
			/* already renamed away, or never created */
		}
	}
}

/**
 * Atomically rebuild the synonym map from the supplied entries under a
 * directory lock and persist it. Returns the written map. Intended to be called
 * by the curator after phase_complete. Bounded by `maxPairs`.
 */
export async function rebuildSynonymMap(
	directory: string,
	entries: SynonymSourceEntry[],
	maxPairs: number = DEFAULT_MAX_PAIRS,
): Promise<SynonymMap> {
	const filePath = resolveSynonymMapPath(directory);
	const dir = path.dirname(filePath);
	await mkdir(dir, { recursive: true });
	let release: (() => Promise<void>) | null = null;
	try {
		release = await lockfile.lock(dir, {
			retries: { retries: 5, minTimeout: 100, maxTimeout: 500 },
			stale: 5000,
		});
		const map = buildSynonymMap(entries, maxPairs);
		await writeSynonymMapAtomic(filePath, map);
		return map;
	} finally {
		if (release) {
			try {
				await release();
			} catch {
				/* lock release failures are non-blocking */
			}
		}
	}
}

export const _internals = {
	MAX_TOKEN_LENGTH,
	DEFAULT_MAX_PAIRS,
	DEFAULT_MIN_COOCCURRENCE,
	DEFAULT_MAX_EXPANSIONS_PER_TOKEN,
	evictToCap,
	isSynonymPair,
	writeSynonymMapAtomic,
};
