/**
 * Fixed-point recovery helper for malformed config values.
 *
 * Given a Zod schema and a raw config object, this module iteratively
 * removes malformed fields/sections until the config validates cleanly.
 * It uses ONLY `safeParse` + `issue.path`/`issue.code`/`issue.keys` as
 * signals — no schema introspection (`_def`, `.shape`, `instanceof` along
 * paths), making it robust across Zod versions (v3 and v4+).
 *
 * Algorithm (SME-designed fixed-point):
 *   1. Fast path: if `safeParse` succeeds, return the original reference
 *      (no clone cost on the happy path).
 *   2. Deep-clone the input exactly once.
 *   3. Loop: parse → build leaf drop-set from issue paths → remove deepest
 *      leaves first → re-parse.  If no new leaves found but fresh issues
 *      remain, escalate to nearest non-removed ancestor.  If still stuck,
 *      drop entire implicated top-level sections.
 *   4. Terminate when parse succeeds or fuel is exhausted.
 *   5. Emit ancestor-suppressed, deterministically-ordered warnings.
 *
 * This is a PURE function — no side effects, no I/O, no logging.
 */

import type { z } from 'zod';

// ─── Public types ───────────────────────────────────────────────────────────

/** Dotted path identifying the dropped unit, e.g. "council.enabled" or "pr_monitor". */
export interface RecoveryWarning {
	section: string;
	/** Currently always 'warn'; reserved for future severity levels. */
	severity: 'warn';
	/** Human-readable description of what was dropped and why. */
	message: string;
	/** Full Zod error path if available (for debugging / downstream use). */
	path?: string;
}

export interface SanitizeResult {
	/** The recovered config object. Keys omitted here will be filled by Zod defaults
	 *  at parse time — callers should re-parse this through the schema. */
	config: Record<string, unknown>;
	/** Warnings for every field or section that was dropped during recovery. */
	recoveryWarnings: RecoveryWarning[];
}

// ─── Internal types ────────────────────────────────────────────────────────

type Path = (string | number)[];

/** Collision-free JSON key for a path array. */
const keyOf = (p: Path): string => JSON.stringify(p);

interface RemovedEntry {
	path: Path;
	code: string;
	message: string;
}

// ─── Internal helpers ───────────────────────────────────────────────────────

/** Join path segments into a dotted string for messages only.
 *  NEVER used as a Map key — `'a.b'` vs `['a','b.c']` collision. */
function dotted(p: Path): string {
	return p.map(String).join('.');
}

/** Deep-clone with structuredClone → JSON fallback for older runtimes. */
function deepClone(obj: Record<string, unknown>): Record<string, unknown> {
	try {
		return structuredClone(obj);
	} catch {
		return JSON.parse(JSON.stringify(obj)) as Record<string, unknown>;
	}
}

/** Recursive key+element count for fuel budget. */
function countNodes(obj: unknown): number {
	if (obj === null || obj === undefined) return 0;
	if (typeof obj !== 'object') return 1;
	if (Array.isArray(obj)) {
		let count = 0;
		for (const el of obj) count += 1 + countNodes(el);
		return count;
	}
	let count = 0;
	for (const _key of Object.keys(obj as Record<string, unknown>)) {
		count += 1;
	}
	for (const val of Object.values(obj as Record<string, unknown>)) {
		count += countNodes(val);
	}
	return count;
}

/**
 * Select the deepest (longest) paths, keeping only maximal-depth entries.
 * Sorts by length descending, then keeps a path only if no already-kept
 * path is its prefix (i.e. it extends a longer path).
 */
function selectDeepest(paths: Path[]): Path[] {
	const sorted = [...paths].sort((a, b) => b.length - a.length);
	const kept: Path[] = [];
	for (const p of sorted) {
		if (!kept.some((q) => q.length > p.length && startsWith(q, p))) {
			kept.push(p);
		}
	}
	return kept;
}

/** Check whether `prefix` is a prefix of `path` (element-wise). */
function startsWith(path: Path, prefix: Path): boolean {
	if (prefix.length > path.length) return false;
	for (let i = 0; i < prefix.length; i++) {
		if (path[i] !== prefix[i]) return false;
	}
	return true;
}

/**
 * Mutate the clone at `obj` by removing the value at `path`.
 * Returns true if removal succeeded, false if the path was unreachable.
 *
 * For numeric segments into arrays, collects per-parent-array and splices
 * in descending index order (never `delete arr[i]` — leaves holes).
 */
function removeAtPath(obj: Record<string, unknown>, path: Path): boolean {
	if (path.length === 0) return false;

	let node: unknown = obj;
	for (let i = 0; i < path.length - 1; i++) {
		if (node === null || node === undefined || typeof node !== 'object') {
			return false;
		}
		const key = path[i];
		if (Array.isArray(node)) {
			const idx = Number(key);
			if (!Number.isInteger(idx) || idx < 0 || idx >= node.length) {
				return false;
			}
			node = node[idx];
		} else {
			node = (node as Record<string, unknown>)[String(key)];
		}
	}

	// Final segment — remove from the parent node.
	if (node === null || node === undefined || typeof node !== 'object') {
		return false;
	}

	const lastSegment = path[path.length - 1];
	if (Array.isArray(node)) {
		const idx = Number(lastSegment);
		if (!Number.isInteger(idx) || idx < 0 || idx >= node.length) {
			return false;
		}
		node.splice(idx, 1);
	} else {
		delete (node as Record<string, unknown>)[String(lastSegment)];
	}
	return true;
}

/** Check whether any strict prefix of `p` is present in the `removed` map. */
function hasRemovedAncestor(
	p: Path,
	removed: Map<string, RemovedEntry>,
): boolean {
	for (let len = 1; len < p.length; len++) {
		if (removed.has(keyOf(p.slice(0, len)))) {
			return true;
		}
	}
	return false;
}

/** Deduplicate paths by their JSON key. */
function dedupeByKey(paths: Path[]): Path[] {
	const seen = new Set<string>();
	const result: Path[] = [];
	for (const p of paths) {
		const k = keyOf(p);
		if (!seen.has(k)) {
			seen.add(k);
			result.push(p);
		}
	}
	return result;
}

/** Find the first issue matching `path` and extract a removal record. */
function recordFor(path: Path, issues: z.ZodIssue[]): RemovedEntry {
	const key = keyOf(path);
	for (const issue of issues) {
		if (keyOf(issue.path as Path) === key) {
			return { path, code: issue.code, message: issue.message };
		}
	}
	return { path, code: 'unknown', message: 'no matching issue found' };
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Attempt to recover a malformed config by iteratively dropping invalid
 * values until the config validates.  This is a generic helper that works
 * with any Zod schema and avoids all schema introspection.
 *
 * The returned `config` is the cleaned raw config — callers should pass it
 * through `schema.parse()` to get fully typed output with defaults applied.
 *
 * @param schema - The Zod schema to validate against.
 * @param rawConfig - The raw parsed-config object (not yet Zod-validated).
 * @returns The cleaned config plus any warnings emitted during recovery.
 */
export function sanitizeMalformedValues(
	schema: z.ZodTypeAny,
	rawConfig: Record<string, unknown>,
): SanitizeResult {
	// (a) Defensive: non-plain-object input → empty config with warning
	if (
		rawConfig === null ||
		rawConfig === undefined ||
		typeof rawConfig !== 'object' ||
		Array.isArray(rawConfig)
	) {
		return {
			config: {},
			recoveryWarnings: [
				{
					section: '<root>',
					severity: 'warn',
					message:
						'Config input is not a plain object (received ' +
						String(rawConfig === null ? 'null' : typeof rawConfig) +
						'); schema defaults will apply.',
				},
			],
		};
	}

	// (b) Fast path: already valid — return the ORIGINAL reference (no clone).
	const fastResult = schema.safeParse(rawConfig);
	if (fastResult.success) {
		return { config: rawConfig, recoveryWarnings: [] };
	}

	const current = deepClone(rawConfig);
	const removed = new Map<string, RemovedEntry>();
	const fuel = 2 * countNodes(rawConfig) + 8;
	let recovered = false;

	for (let iter = 0; iter < fuel; iter++) {
		const res = schema.safeParse(current);
		if (res.success) {
			recovered = true;
			break;
		}
		const issues = res.error.issues;

		// Build leaf drop-set from issue paths ONLY
		const leafCandidates: Path[] = [];
		let anyPathIssue = false;
		for (const issue of issues) {
			const p = issue.path as Path;
			if (p.length === 0) continue; // root refinement — not droppable
			anyPathIssue = true;
			if (
				issue.code === 'unrecognized_keys' &&
				Array.isArray((issue as { keys?: unknown }).keys)
			) {
				for (const k of (issue as { keys: string[] }).keys) {
					leafCandidates.push([...p, k]);
				}
			} else {
				leafCandidates.push(p);
			}
		}
		let batch = selectDeepest(leafCandidates).filter(
			(p) => !removed.has(keyOf(p)),
		);

		// ESCALATE only when a FRESH parse shows nothing new at leaf level
		if (batch.length === 0 && anyPathIssue) {
			for (const issue of issues) {
				let q: Path | null = issue.path as Path;
				while (q !== null && removed.has(keyOf(q))) {
					q = q.length > 1 ? q.slice(0, -1) : null;
				}
				if (q !== null && !removed.has(keyOf(q))) {
					batch.push(q);
				}
			}
			batch = dedupeByKey(batch);
		}

		// TERMINAL: drop every implicated top-level section
		if (batch.length === 0) {
			const sections = dedupeByKey(
				issues
					.filter((i) => i.path.length > 0)
					.map((i) => [i.path[0] as string | number]),
			).filter((p) => !removed.has(keyOf(p)));
			if (sections.length === 0) break;
			batch = sections;
		}

		for (const p of batch) {
			if (removeAtPath(current, p)) {
				removed.set(keyOf(p), recordFor(p, issues));
			}
		}
	}

	// Last resort: if still not recovered, drop all implicated top-level
	// sections; if STILL failing → current = {}
	if (!recovered) {
		const finalRes = schema.safeParse(current);
		if (!finalRes.success) {
			const topLevelKeys = [...Object.keys(current)];
			for (const key of topLevelKeys) {
				if (key in current) {
					delete current[key];
				}
			}
			const emptyRes = schema.safeParse(current);
			if (!emptyRes.success) {
				// Schema itself rejects empty object — return empty as best effort
			}
		}
	}

	// Warnings: post-loop, from FINAL removed set, ancestor-suppressed,
	// deterministic order
	const surviving = [...removed.values()]
		.filter((r) => !hasRemovedAncestor(r.path, removed))
		.sort(
			(a, b) =>
				a.path.length - b.path.length ||
				keyOf(a.path).localeCompare(keyOf(b.path)),
		)
		.map((r) => ({
			section: dotted(r.path),
			severity: 'warn' as const,
			message: `Config ${r.path.length === 1 ? 'section' : 'field'} "${dotted(r.path)}" was invalid (${r.code}) and was dropped; schema defaults will apply.`,
			path: dotted(r.path),
		}));

	return { config: current, recoveryWarnings: surviving };
}
