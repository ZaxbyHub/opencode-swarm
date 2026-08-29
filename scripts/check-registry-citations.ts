#!/usr/bin/env bun
/**
 * CI enforcement driven by issue #1534 — the `scripts/retention-registry.data.ts`
 * `file:line` citation drift gate.
 *
 * WHY THIS EXISTS
 * ---------------
 * The registry's citations are load-bearing, not decorative. The `08a` record
 * of the #1534 trace documents that a `src/commands/close.ts` refactor was
 * REJECTED specifically to protect citation stability — the registry's line
 * numbers were treated as an interface worth constraining production code for.
 *
 * Yet nothing validated them. `bun run check:retention` passed regardless of
 * whether a line number pointed anywhere near the symbol it claimed:
 *
 *   - During #1534 review, 16 citations were certified exact by hand.
 *   - Two subsequent commits shifted lines; 7 of those 16 went stale, by up
 *     to 46 lines.
 *   - The recomputation that followed itself introduced two MALFORMED
 *     citations (a `foo.ts775-794` shape with the colon dropped) and left one
 *     citation pointing at a real-but-wrong statement.
 *   - `check:retention` was green throughout all of it.
 *
 * A hand-certified pointer with no mechanical guarantee is a pointer that
 * rots silently. This gate supplies the mechanical guarantee.
 *
 * HONEST COVERAGE (measured at the time of writing; the gate prints these)
 * ----------------------------------------------------------------------
 * Of 1009 citation-shaped strings: 854 are structurally verified, 541 carry no
 * adjacent identifier to anchor against, 155 are bare continuation refs that
 * are not resolvable to a single path, 22 are skipped as prose, and 177 are
 * POSITIVELY anchor-validated. So the structural arm is the substantive
 * protection; the anchor arm covers roughly a sixth of citations. That is a
 * limitation to know, not a defect to hide - the counts are printed on every
 * run precisely so the gap cannot be mistaken for coverage.
 *
 * KNOWN FAIL-OPEN IN THE ANCHOR ARM
 * ---------------------------------
 * The identifier match runs against raw line text with no comment stripping, so
 * a citation pointing at a COMMENT that merely mentions the symbol is accepted
 * as correctly anchored. This codebase's docblocks name symbols constantly, so
 * some of the 177 passes may be passing on prose rather than code. The anchor
 * arm is ratcheted and advisory by construction, so this weakens a soft signal
 * rather than opening the hard gate - but it is stated here rather than left
 * for the next reader to discover.
 *
 * WHAT IT CHECKS
 * --------------
 * Two independent arms with deliberately different enforcement strength:
 *
 * 1. STRUCTURAL (hard failure, every row, no baseline, no escape hatch).
 *    Every `path:N` / `path:N-M` / `path:N,M-K` citation must name a file that
 *    exists, with `1 <= N <= M <= <that file's line count>`, and must be
 *    well-formed. Structural health of the tree was measured before this gate
 *    was written and was PERFECT (0 missing files, 0 out-of-bounds, 0
 *    malformed), so a hard repo-wide gate is safe to enforce today and cannot
 *    be softened later without a visible diff.
 *
 * 2. ANCHOR (ratchet against a frozen baseline, NEVER a hard gate).
 *    A citation is frequently followed by the identifier it points at, e.g.
 *    `src/memory/indexed-storage.ts:524 syncIndexFromGraph`. When that
 *    identifier does not occur inside the cited line range, the citation
 *    points at a real-but-wrong statement — the third #1534 defect shape, and
 *    the one a structural check cannot see.
 *
 *    Anchor failures are compared against `scripts/registry-citation-baseline.json`:
 *      - a failure NOT in the baseline is a hard error (new drift is blocked);
 *      - a baseline entry that now PASSES is reported as removable and fails
 *        the check (may-only-shrink — the baseline cannot rot).
 *    The tree carries pre-existing anchor drift in rows owned by other issues.
 *    Making anchor a hard gate would force this change to remediate rows it
 *    does not own, so the baseline exists precisely so that no existing row's
 *    citations have to be edited here.
 *
 * PRECEDENT
 * ---------
 * The ratchet shape follows `scripts/check-runtime-src-refs.ts` (issue #2063),
 * which is the closest precedent in the repo: a checked-in JSON baseline whose
 * stale entries are a hard error, keyed on identity NEVER on line numbers, with
 * a pure exported comparison function. `scripts/check-test-file-cap.ts` is a
 * diff-scoped growth ratchet with no baseline artifact, and
 * `scripts/check-invariants.sh` Check 4 is a flat allowlist whose stale entries
 * are inert by design — neither has may-only-shrink semantics, so neither is
 * the right model here.
 *
 * Keying the baseline on `(rowId, file, identifier)` and deliberately EXCLUDING
 * the line number is what makes the ratchet work: incidental line churn cannot
 * invalidate a baseline entry, and repairing a stale line number makes the
 * anchor resolve, which turns the entry stale, which forces its removal.
 *
 * COVERAGE IS REPORTED, NEVER ASSUMED
 * -----------------------------------
 * Every scanned token lands in exactly one printed bucket. A citation this
 * gate cannot resolve is a hard error, not a silent `continue` — a gate that
 * skips what it cannot parse reports green on a registry that has rotted.
 *
 * Usage:
 *   bun run check:registry-citations
 *   bun run scripts/check-registry-citations.ts --write   # regenerate baseline
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RETENTION_REGISTRY } from './retention-registry.data';

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'..',
);

export const BASELINE_FILENAME = 'registry-citation-baseline.json';

const BASELINE_PATH = path.join(REPO_ROOT, 'scripts', BASELINE_FILENAME);

// ---------------------------------------------------------------------------
// Grammar
// ---------------------------------------------------------------------------

/**
 * Citations are scoped to `.ts` paths. Measured against the tree this gate was
 * written for: of every `<name>.<ext>:<digits>` token in the registry, ZERO
 * carried a non-`.ts` extension. Restricting the grammar to `.ts` therefore
 * loses no coverage while removing an entire class of false positive (a
 * markdown anchor, a `package.json` key path, a `.jsonl` artifact name).
 */
export const CITATION_PATTERN =
	/((?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.ts):(\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*)/g;

/**
 * A CONTINUATION citation: a bare `:N` / `:N-M` that inherits its path from the
 * enclosing string, e.g.
 *   'src/hooks/skill-usage-log.ts:535 appendSkillUsageEntry — appendFileSync :624-628'
 * The `:624-628` is a citation into `skill-usage-log.ts`, and the registry uses
 * this form heavily.
 *
 * INHERITANCE IS ONLY SOUND FOR SINGLE-PATH STRINGS, and that restriction was
 * derived empirically, not assumed. A nearest-preceding-path rule was tried
 * first and produced a false positive on `skill-usage.disposition.citation`,
 * which reads (abridged):
 *
 *   "... a shared stale-breakable lock (..., skill-usage-pending.ts:109),
 *    atomic temp+rename writes on both the JSONL compaction path (:1697-1703)
 *    and the new authoritative sidecar (skill-usage-pending.ts:803-853) ..."
 *
 * `(:1697-1703)` belongs to `skill-usage-log.ts` — the reader recovers that
 * from the phrase "the JSONL compaction path", not from text order. Nearest
 * preceding path resolves it to `skill-usage-pending.ts` (1402 lines) and
 * reports a bogus out-of-bounds. A hard gate that fires on correct data is
 * worse than no gate.
 *
 * Restricting inheritance to single-path strings is ALSO insufficient, which
 * `skill-usage.crashBehavior` proves — it names one explicit path
 * (`skill-usage-pending.ts`) yet opens with continuations belonging to
 * `skill-usage-log.ts`:
 *
 *   "... (pruneSkillUsageLog :1556, rewrite :1697-1703); sidecar save is
 *    atomic temp+rename (savePendingDocument :795 -> savePendingDocumentAt,
 *    skill-usage-pending.ts:803-853, writeFileSync :820 ...)"
 *
 * Both conditions are therefore required: a continuation is checked only when
 * its string names exactly ONE distinct path AND that path appears BEFORE the
 * continuation. `:1697-1703` fails the second test; `:820` passes both. The
 * remainder is COUNTED and PRINTED as `continuations-unresolvable`, never
 * silently skipped — an unreported skip is how a gate reports green on a
 * rotted tree.
 *
 * The leading `[\s(;]` lookbehind is what separates a continuation from prose
 * punctuation: a continuation's colon is preceded by whitespace, `(`, or `;`,
 * whereas a prose key-like `maxEntries: 5000` attaches its colon directly to a
 * word character.
 *
 * The trailing `(?![\d\-.])` guard rejects a partially-consumed number such as
 * `:1.5`. It deliberately PERMITS a following `,`: the line spec is greedy, so
 * a comma it did not consume is list punctuation (`:1556, rewrite :1697`), and
 * excluding `,` here made the gate drop `:1556` silently instead of counting
 * it — the fail-open shape this gate exists to prevent.
 */
export const CONTINUATION_PATTERN =
	/(?<=[\s(;])(:)(\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*)(?![\d\-.])/g;

/**
 * Malformed shape A — the exact #1534 defect: a `.ts` filename immediately
 * followed by digits with the colon dropped (`close.ts775-794`).
 */
export const MALFORMED_NO_COLON_PATTERN =
	/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.ts\d+(?:-\d+)?/g;

/**
 * Malformed shape B — the colon replaced by a space, which is how a dropped
 * `:` presents when the citation sits inside parentheses
 * (`(close.ts 775-794)`). Requires a full `N-M` range rather than a lone
 * number, because `close.ts 3 arrays` is legitimate prose.
 */
export const MALFORMED_SPACE_RANGE_PATTERN =
	/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.ts \d+-\d+/g;

/** The adjacent-identifier token that an anchor check validates. */
export const ADJACENT_IDENTIFIER_PATTERN = /^[ \t]([A-Za-z_$][A-Za-z0-9_$]*)/;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LineRange {
	start: number;
	end: number;
}

export interface Citation {
	rowId: string;
	/** Dotted/indexed path to the registry field, e.g. `writerCitations[0]`. */
	field: string;
	/** The citation text exactly as it appears, e.g. `src/a/b.ts:12-30`. */
	raw: string;
	/** Path text as written (may be bare, `src/`-relative, or repo-relative). */
	pathText: string | null;
	ranges: LineRange[];
	/** Adjacent identifier token, or `null` when none follows the citation. */
	identifier: string | null;
	/** True when the citation is a bare `:N` inheriting a preceding path. */
	continuation: boolean;
}

export type StructuralFindingKind =
	| 'malformed'
	| 'unresolvable-path'
	| 'ambiguous-path'
	| 'out-of-bounds';

export interface StructuralFinding {
	kind: StructuralFindingKind;
	rowId: string;
	field: string;
	raw: string;
	detail: string;
}

export type AnchorFailureKind = 'out-of-range' | 'absent-from-file';

export interface AnchorFailure {
	rowId: string;
	/** Resolved repo-relative POSIX path of the cited file. */
	file: string;
	identifier: string;
	kind: AnchorFailureKind;
	/** Context only — deliberately NOT part of the baseline key. */
	citation: string;
	field: string;
}

export interface BaselineEntry {
	rowId: string;
	file: string;
	identifier: string;
	kind: AnchorFailureKind;
	note: string;
}

export interface Coverage {
	citationsScanned: number;
	structurallyChecked: number;
	/**
	 * Bare `:N` continuations whose enclosing string names zero or several
	 * distinct paths, so inheritance cannot identify the cited file. Reported,
	 * never silently dropped — see CONTINUATION_PATTERN's docblock.
	 */
	continuationsUnresolvable: number;
	anchorCandidates: number;
	anchorPassed: number;
	anchorOutOfRange: number;
	anchorSkippedLowercase: number;
	anchorAbsent: number;
	noIdentifier: number;
}

export interface CollectResult {
	citations: Citation[];
	structural: StructuralFinding[];
	anchorFailures: AnchorFailure[];
	coverage: Coverage;
}

// ---------------------------------------------------------------------------
// Registry traversal
// ---------------------------------------------------------------------------

export interface RegistryString {
	rowId: string;
	field: string;
	value: string;
}

/**
 * Recursively collect every string value in every registry row, tagged with
 * the row id and a field path. Reading the imported data (rather than text
 * scanning the source file) means escape sequences are already resolved and
 * every finding carries a precise, actionable `row.field` address.
 */
export function collectRegistryStrings(
	rows: readonly unknown[],
): RegistryString[] {
	const out: RegistryString[] = [];

	const visit = (node: unknown, rowId: string, field: string): void => {
		if (typeof node === 'string') {
			out.push({ rowId, field, value: node });
			return;
		}
		if (Array.isArray(node)) {
			node.forEach((child, i) => visit(child, rowId, `${field}[${i}]`));
			return;
		}
		if (node !== null && typeof node === 'object') {
			for (const [key, child] of Object.entries(node)) {
				visit(child, rowId, field ? `${field}.${key}` : key);
			}
		}
	};

	for (const row of rows) {
		const rowId =
			row !== null &&
			typeof row === 'object' &&
			typeof (row as { id?: unknown }).id === 'string'
				? (row as { id: string }).id
				: '<unknown-row>';
		visit(row, rowId, '');
	}
	return out;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Expand a `12` / `12-30` / `12,30-40` line spec into concrete ranges. */
export function parseLineSpec(spec: string): LineRange[] {
	const ranges: LineRange[] = [];
	for (const part of spec.split(',')) {
		const dash = part.indexOf('-');
		if (dash === -1) {
			const n = Number(part);
			ranges.push({ start: n, end: n });
		} else {
			ranges.push({
				start: Number(part.slice(0, dash)),
				end: Number(part.slice(dash + 1)),
			});
		}
	}
	return ranges;
}

/**
 * Decide whether an adjacent token is a code identifier worth anchor-checking.
 *
 * An all-lowercase token (`bounded`, `appended`, `sync`) is indistinguishable
 * from English prose by shape alone, so those are excluded here and counted in
 * `coverage.anchorSkippedLowercase` rather than silently dropped. Everything
 * carrying a case transition, `_`, or `$` is treated as code.
 */
export function looksLikeIdentifier(token: string): boolean {
	if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(token)) {
		return false;
	}
	if (token.includes('_') || token.includes('$')) {
		return true;
	}
	return /[A-Z]/.test(token);
}

/**
 * Parse one registry string into citations, in source order. A `continuation`
 * citation inherits `pathText` from the enclosing string only when that string
 * names exactly ONE distinct path; otherwise it is emitted with
 * `pathText === null` for the caller to count as unresolvable coverage.
 */
export function parseCitations(
	text: string,
	rowId: string,
	field: string,
): Citation[] {
	interface Hit {
		index: number;
		length: number;
		pathText: string | null;
		spec: string;
		continuation: boolean;
	}
	const hits: Hit[] = [];

	const full = new RegExp(CITATION_PATTERN.source, 'g');
	let m: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
	while ((m = full.exec(text)) !== null) {
		hits.push({
			index: m.index,
			length: m[0].length,
			pathText: m[1] as string,
			spec: m[2] as string,
			continuation: false,
		});
	}

	const cont = new RegExp(CONTINUATION_PATTERN.source, 'g');
	// biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
	while ((m = cont.exec(text)) !== null) {
		// Skip a `:N` that is the tail of a full citation already captured.
		const overlaps = hits.some(
			(h) => m !== null && m.index >= h.index && m.index < h.index + h.length,
		);
		if (overlaps) {
			continue;
		}
		hits.push({
			index: m.index,
			length: m[0].length,
			pathText: null,
			spec: m[2] as string,
			continuation: true,
		});
	}

	hits.sort((a, b) => a.index - b.index);

	const distinctPaths = new Set(
		hits.flatMap((h) => (h.pathText === null ? [] : [h.pathText])),
	);
	const singlePath =
		distinctPaths.size === 1 ? ([...distinctPaths][0] as string) : null;

	const citations: Citation[] = [];
	let sawExplicitPath = false;
	for (const hit of hits) {
		if (hit.pathText !== null) {
			sawExplicitPath = true;
		}
		const inheritedPath = sawExplicitPath ? singlePath : null;
		const after = text.slice(hit.index + hit.length);
		const idMatch = ADJACENT_IDENTIFIER_PATTERN.exec(after);
		citations.push({
			rowId,
			field,
			raw: text.slice(hit.index, hit.index + hit.length),
			pathText: hit.pathText ?? inheritedPath,
			ranges: parseLineSpec(hit.spec),
			identifier: idMatch ? (idMatch[1] as string) : null,
			continuation: hit.continuation,
		});
	}
	return citations;
}

/** Detect the two malformed shapes in one string. */
export function findMalformed(text: string): string[] {
	const found: string[] = [];
	for (const pattern of [
		MALFORMED_NO_COLON_PATTERN,
		MALFORMED_SPACE_RANGE_PATTERN,
	]) {
		const re = new RegExp(pattern.source, 'g');
		let m: RegExpExecArray | null;
		// biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
		while ((m = re.exec(text)) !== null) {
			found.push(m[0]);
		}
	}
	return found;
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

export interface SourceTree {
	/** Repo-relative POSIX paths of every non-test `.ts` file under `src/`. */
	srcFiles: string[];
	/** Returns file contents, or `null` when the repo-relative path is absent. */
	readFile: (relPath: string) => string | null;
}

export function toPosix(p: string): string {
	return p.split(path.sep).join('/');
}

/**
 * The resolution ladder, in order:
 *   1. literal repo-relative path (`src/hooks/x.ts`);
 *   2. `src/`-prefixed shorthand (`plan/checkpoint.ts` -> `src/plan/checkpoint.ts`),
 *      a form the registry uses in ~6 places;
 *   3. bare basename (`indexed-storage.ts`), resolved against a unique-basename
 *      index over `src/` — 56 of the registry's 59 bare basenames are unique;
 *   4. for the 4 ambiguous basenames (`manager.ts`, `store.ts`, `cache.ts`,
 *      `memory-link.ts`), `rowPaths` breaks the tie: the set of repo-relative
 *      paths the SAME registry row cites explicitly WITH a line reference.
 *      Row membership alone (`writerModules`) is not enough — `link-pointers`
 *      lists both `src/memory/memory-link.ts` and `src/commands/memory-link.ts`
 *      as writer modules, but only the former is ever cited with a line, and
 *      that is the one its bare `memory-link.ts:138` means.
 *   5. failing that, a candidate SHARING A DIRECTORY with one of `rowPaths`.
 *      The `repo-graph` row cites `src/tools/repo-graph/storage.ts` with lines
 *      and then a bare `cache.ts:13`; `src/tools/repo-graph/cache.ts` is the
 *      only candidate in a directory the row already cites, so the tie breaks
 *      against `src/memory/embeddings/cache.ts`.
 *
 * Returns `{ kind: 'ok' | 'ambiguous' | 'missing' }`. A `missing` or
 * `ambiguous` result is a hard structural failure, never a skip.
 */
export function resolveCitedPath(
	pathText: string,
	tree: SourceTree,
	rowPaths: ReadonlySet<string>,
): { kind: 'ok'; file: string } | { kind: 'ambiguous'; candidates: string[] } | {
	kind: 'missing';
} {
	if (tree.readFile(pathText) !== null) {
		return { kind: 'ok', file: pathText };
	}
	if (!pathText.startsWith('src/')) {
		const prefixed = `src/${pathText}`;
		if (tree.readFile(prefixed) !== null) {
			return { kind: 'ok', file: prefixed };
		}
	}
	if (pathText.includes('/')) {
		return { kind: 'missing' };
	}

	const candidates = tree.srcFiles.filter(
		(f) => f.slice(f.lastIndexOf('/') + 1) === pathText,
	);
	if (candidates.length === 1) {
		return { kind: 'ok', file: candidates[0] as string };
	}
	if (candidates.length === 0) {
		return { kind: 'missing' };
	}
	const inRow = candidates.filter((f) => rowPaths.has(f));
	if (inRow.length === 1) {
		return { kind: 'ok', file: inRow[0] as string };
	}
	const dirOf = (f: string): string => f.slice(0, f.lastIndexOf('/'));
	const rowDirs = new Set([...rowPaths].map(dirOf));
	const inRowDir = candidates.filter((f) => rowDirs.has(dirOf(f)));
	if (inRowDir.length === 1) {
		return { kind: 'ok', file: inRowDir[0] as string };
	}
	return { kind: 'ambiguous', candidates };
}

/**
 * Addressable lines of a file: what an editor (and therefore a citation) can
 * point at. CR is stripped first so a CRLF checkout counts the same as LF.
 *
 * The single trailing empty element produced by a file ending in `\n` is
 * dropped. Without that, `lines.length` is one MORE than `wc -l` and the
 * bounds check accepts a citation to a phantom line one past the end — a
 * permissive-direction hole that no fixture built with `[...].join('\n')` can
 * expose, because such a fixture never has a trailing newline.
 */
export function splitLines(content: string): string[] {
	const lines = content.replace(/\r/g, '').split('\n');
	if (lines.length > 0 && lines[lines.length - 1] === '') {
		lines.pop();
	}
	return lines;
}

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

export function collectFindings(
	rows: readonly unknown[],
	tree: SourceTree,
): CollectResult {
	const citations: Citation[] = [];
	const structural: StructuralFinding[] = [];
	const anchorFailures: AnchorFailure[] = [];
	const coverage: Coverage = {
		citationsScanned: 0,
		structurallyChecked: 0,
		continuationsUnresolvable: 0,
		anchorCandidates: 0,
		anchorPassed: 0,
		anchorOutOfRange: 0,
		anchorSkippedLowercase: 0,
		anchorAbsent: 0,
		noIdentifier: 0,
	};

	const lineCache = new Map<string, string[]>();
	const linesOf = (file: string): string[] => {
		const cached = lineCache.get(file);
		if (cached) {
			return cached;
		}
		const lines = splitLines(tree.readFile(file) ?? '');
		lineCache.set(file, lines);
		return lines;
	};

	const strings = collectRegistryStrings(rows);

	/**
	 * Pass 1 — per-row disambiguation context: every repo-relative path the row
	 * cites explicitly WITH a line reference, resolved. Used only to break ties
	 * between same-basename files in step 4 of the resolution ladder.
	 */
	const rowPathContext = new Map<string, Set<string>>();
	for (const { rowId, field, value } of strings) {
		let set = rowPathContext.get(rowId);
		if (!set) {
			set = new Set<string>();
			rowPathContext.set(rowId, set);
		}
		for (const citation of parseCitations(value, rowId, field)) {
			const explicit = citation.pathText;
			if (explicit === null || citation.continuation || !explicit.includes('/')) {
				continue;
			}
			const resolved = resolveCitedPath(explicit, tree, new Set<string>());
			if (resolved.kind === 'ok') {
				set.add(resolved.file);
			}
		}
	}
	const noContext = new Set<string>();

	// Pass 2 — structural + anchor checks.
	for (const { rowId, field, value } of strings) {
		for (const raw of findMalformed(value)) {
			structural.push({
				kind: 'malformed',
				rowId,
				field,
				raw,
				detail:
					'citation is missing its `:` separator between the path and the line spec',
			});
		}

		const rowPaths = rowPathContext.get(rowId) ?? noContext;
		for (const citation of parseCitations(value, rowId, field)) {
			citations.push(citation);
			coverage.citationsScanned++;

			if (citation.pathText === null) {
				// Continuation in a zero- or multi-path string: inheritance cannot
				// name the cited file. Counted and printed, not silently dropped.
				coverage.continuationsUnresolvable++;
				continue;
			}

			const resolved = resolveCitedPath(citation.pathText, tree, rowPaths);
			if (resolved.kind === 'missing') {
				structural.push({
					kind: 'unresolvable-path',
					rowId,
					field,
					raw: citation.raw,
					detail: `no file matches "${citation.pathText}" (tried it verbatim${citation.pathText.startsWith('src/') ? '' : `, as src/${citation.pathText}`}${citation.pathText.includes('/') ? '' : ', and as a unique basename under src/'})`,
				});
				continue;
			}
			if (resolved.kind === 'ambiguous') {
				structural.push({
					kind: 'ambiguous-path',
					rowId,
					field,
					raw: citation.raw,
					detail: `basename "${citation.pathText}" matches ${resolved.candidates.length} files (${resolved.candidates.join(', ')}); write a repo-relative path`,
				});
				continue;
			}

			const file = resolved.file;
			const lines = linesOf(file);
			const lineCount = lines.length;

			let inBounds = true;
			for (const range of citation.ranges) {
				if (
					range.start < 1 ||
					range.end < range.start ||
					range.end > lineCount
				) {
					inBounds = false;
					structural.push({
						kind: 'out-of-bounds',
						rowId,
						field,
						raw: citation.raw,
						detail: `range ${range.start}-${range.end} is not within 1..${lineCount} of ${file}`,
					});
				}
			}
			if (!inBounds) {
				continue;
			}
			coverage.structurallyChecked++;

			// --- anchor arm -------------------------------------------------
			const identifier = citation.identifier;
			if (identifier === null) {
				coverage.noIdentifier++;
				continue;
			}
			coverage.anchorCandidates++;
			if (!looksLikeIdentifier(identifier)) {
				coverage.anchorSkippedLowercase++;
				continue;
			}

			const wordRe = new RegExp(`(?<![A-Za-z0-9_$])${identifier}(?![A-Za-z0-9_$])`);
			const inRange = citation.ranges.some((range) => {
				for (let n = range.start; n <= range.end; n++) {
					if (wordRe.test(lines[n - 1] ?? '')) {
						return true;
					}
				}
				return false;
			});
			if (inRange) {
				coverage.anchorPassed++;
				continue;
			}

			const anywhere = lines.some((line) => wordRe.test(line));
			if (!anywhere) {
				coverage.anchorAbsent++;
				anchorFailures.push({
					rowId,
					file,
					identifier,
					kind: 'absent-from-file',
					citation: citation.raw,
					field,
				});
				continue;
			}
			coverage.anchorOutOfRange++;
			anchorFailures.push({
				rowId,
				file,
				identifier,
				kind: 'out-of-range',
				citation: citation.raw,
				field,
			});
		}
	}

	return { citations, structural, anchorFailures, coverage };
}

// ---------------------------------------------------------------------------
// Baseline comparison
// ---------------------------------------------------------------------------

/**
 * Baseline identity. Deliberately EXCLUDES the line number so incidental line
 * churn cannot invalidate an entry, and excludes `kind` so that a failure
 * flipping between `out-of-range` and `absent-from-file` stays the same known
 * debt rather than presenting as brand-new drift.
 */
export function baselineKey(entry: {
	rowId: string;
	file: string;
	identifier: string;
}): string {
	return `${entry.rowId}\x00${entry.file}\x00${entry.identifier}`;
}

export interface RatchetResult {
	/** Anchor failures absent from the baseline — hard errors (new drift). */
	newFailures: AnchorFailure[];
	/** Baseline entries that now pass — must be removed (may-only-shrink). */
	removableEntries: BaselineEntry[];
}

export function checkAnchorRatchet(
	failures: AnchorFailure[],
	baseline: readonly BaselineEntry[],
): RatchetResult {
	const baselineKeys = new Set(baseline.map(baselineKey));
	const failureKeys = new Set(failures.map(baselineKey));
	return {
		newFailures: failures.filter((f) => !baselineKeys.has(baselineKey(f))),
		removableEntries: baseline.filter((e) => !failureKeys.has(baselineKey(e))),
	};
}

export function loadBaseline(baselinePath: string): BaselineEntry[] {
	if (!fs.existsSync(baselinePath)) {
		return [];
	}
	const parsed = JSON.parse(fs.readFileSync(baselinePath, 'utf-8'));
	if (!Array.isArray(parsed?.entries)) {
		throw new Error(
			`${baselinePath} must be a JSON object with an "entries" array.`,
		);
	}
	return parsed.entries as BaselineEntry[];
}

export const BASELINE_COMMENT =
	'Issue #1534 anchor ratchet. Every entry is PRE-EXISTING citation debt in a row ' +
	'owned by another issue, captured so the #1534 gate could be landed without editing ' +
	'rows it does not own. An entry is NOT approved drift: it records a citation whose ' +
	'adjacent identifier does not occur in the cited line range. This baseline may only ' +
	'SHRINK — scripts/check-registry-citations.ts fails when an entry starts passing, ' +
	'which forces its removal. Keyed on (rowId, file, identifier); line numbers are ' +
	'deliberately excluded so line churn cannot invalidate an entry. Regenerate with ' +
	'`bun run scripts/check-registry-citations.ts --write` (review the diff — --write ' +
	'will also happily record NEW drift).';

export function serializeBaseline(entries: BaselineEntry[]): string {
	const sorted = [...entries].sort((a, b) =>
		baselineKey(a) < baselineKey(b) ? -1 : baselineKey(a) > baselineKey(b) ? 1 : 0,
	);
	return `${JSON.stringify({ $comment: BASELINE_COMMENT, entries: sorted }, null, '\t')}\n`;
}

export function toBaselineEntry(failure: AnchorFailure): BaselineEntry {
	return {
		rowId: failure.rowId,
		file: failure.file,
		identifier: failure.identifier,
		kind: failure.kind,
		note:
			failure.kind === 'absent-from-file'
				? `Pre-existing debt, not approved drift: "${failure.identifier}" does not occur anywhere in ${failure.file} (cited as ${failure.citation} in ${failure.rowId}.${failure.field}).`
				: `Pre-existing debt, not approved drift: "${failure.identifier}" exists in ${failure.file} but not inside ${failure.citation} (${failure.rowId}.${failure.field}).`,
	};
}

// ---------------------------------------------------------------------------
// Filesystem tree
// ---------------------------------------------------------------------------

export function buildSourceTree(repoRoot: string): SourceTree {
	const srcFiles: string[] = [];
	const walk = (dir: string): void => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.name === 'node_modules' || entry.name === 'dist') {
				continue;
			}
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(full);
			} else if (
				entry.isFile() &&
				entry.name.endsWith('.ts') &&
				!entry.name.endsWith('.test.ts')
			) {
				srcFiles.push(toPosix(path.relative(repoRoot, full)));
			}
		}
	};
	walk(path.join(repoRoot, 'src'));

	return {
		srcFiles,
		readFile: (relPath) => {
			const abs = path.resolve(repoRoot, relPath);
			// Refuse to escape the repo root (a citation is never `../`).
			if (!abs.startsWith(path.resolve(repoRoot) + path.sep)) {
				return null;
			}
			try {
				if (!fs.statSync(abs).isFile()) {
					return null;
				}
			} catch {
				return null;
			}
			return fs.readFileSync(abs, 'utf-8');
		},
	};
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

export function formatReport(
	result: CollectResult,
	ratchet: RatchetResult,
	baselineSize: number,
): { lines: string[]; failed: boolean } {
	const lines: string[] = [];
	const { coverage } = result;

	if (result.structural.length > 0) {
		lines.push(
			`STRUCTURAL FAILURES (${result.structural.length}) — hard gate, no baseline:`,
		);
		for (const f of result.structural) {
			lines.push(`  [${f.kind}] ${f.rowId}.${f.field}`);
			lines.push(`      citation: ${f.raw}`);
			lines.push(`      expected: ${f.detail}`);
		}
		lines.push(
			'  Fix the citation in scripts/retention-registry.data.ts. Structural failures are',
		);
		lines.push(
			'  never baselined: the tree was measured at zero when this gate landed.',
		);
		lines.push('');
	}

	if (ratchet.newFailures.length > 0) {
		lines.push(
			`NEW ANCHOR DRIFT (${ratchet.newFailures.length}) — not in scripts/${BASELINE_FILENAME}:`,
		);
		for (const f of ratchet.newFailures) {
			lines.push(`  ${f.rowId}.${f.field}`);
			lines.push(`      citation: ${f.citation} ${f.identifier}`);
			lines.push(
				f.kind === 'absent-from-file'
					? `      expected: "${f.identifier}" to occur in ${f.file}; it occurs nowhere in that file`
					: `      expected: "${f.identifier}" to occur inside ${f.citation}; it occurs in ${f.file} but outside the cited range`,
			);
		}
		lines.push(
			'  Correct the line number (preferred), or — only for debt this change does not own —',
		);
		lines.push(
			`  run \`bun run scripts/check-registry-citations.ts --write\` and justify each new entry.`,
		);
		lines.push('');
	}

	if (ratchet.removableEntries.length > 0) {
		lines.push(
			`STALE BASELINE ENTRIES (${ratchet.removableEntries.length}) — these now PASS and must be removed:`,
		);
		for (const e of ratchet.removableEntries) {
			lines.push(`  ${e.rowId} / ${e.file} / ${e.identifier}`);
		}
		lines.push(
			`  The baseline may only shrink. Run \`bun run scripts/check-registry-citations.ts --write\`.`,
		);
		lines.push('');
	}

	lines.push('=== Registry citation check (issue #1534) ===');
	lines.push(`Citations scanned:            ${coverage.citationsScanned}`);
	lines.push(`Structurally verified:        ${coverage.structurallyChecked}`);
	lines.push(`Structural failures:          ${result.structural.length}`);
	lines.push(
		`Continuations unresolvable:   ${coverage.continuationsUnresolvable}  (bare :N in a zero-/multi-path string; not checkable, see CONTINUATION_PATTERN)`,
	);
	lines.push(`Anchor candidates:            ${coverage.anchorCandidates}`);
	// N1: passes and failures were previously summed into one `anchor-checked`
	// bucket, which made the docblock's "every scanned token lands in exactly
	// one printed bucket" untrue and overstated how much is positively
	// validated. They are separate counters now.
	lines.push(`  anchor PASSED:              ${coverage.anchorPassed}`);
	lines.push(`  anchor out-of-range:        ${coverage.anchorOutOfRange}`);
	lines.push(
		`  skipped (lowercase/prose):  ${coverage.anchorSkippedLowercase}`,
	);
	lines.push(`  identifier absent from file:${coverage.anchorAbsent}`);
	lines.push(`Citations with no identifier: ${coverage.noIdentifier}`);
	lines.push(`Anchor failures:              ${result.anchorFailures.length}`);
	lines.push(`Baseline entries:             ${baselineSize}`);

	const failed =
		result.structural.length > 0 ||
		ratchet.newFailures.length > 0 ||
		ratchet.removableEntries.length > 0;
	lines.push(
		failed
			? 'FAILED — see the sections above.'
			: 'All registry citation checks passed.',
	);
	return { lines, failed };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function main(
	argv: readonly string[] = process.argv.slice(2),
	repoRoot: string = REPO_ROOT,
	baselinePath: string = BASELINE_PATH,
	rows: readonly unknown[] = RETENTION_REGISTRY,
): number {
	const write = argv.includes('--write') || argv.includes('--update');
	const tree = buildSourceTree(repoRoot);
	const result = collectFindings(rows, tree);

	if (write) {
		if (result.structural.length > 0) {
			console.error(
				'Refusing to write the baseline while structural failures exist — ' +
					'structural failures are never baselined. Fix them first:',
			);
			for (const f of result.structural) {
				console.error(`  [${f.kind}] ${f.rowId}.${f.field}: ${f.raw} — ${f.detail}`);
			}
			return 1;
		}
		const entries = result.anchorFailures.map(toBaselineEntry);
		fs.writeFileSync(baselinePath, serializeBaseline(entries), 'utf-8');
		console.log(
			`Wrote ${entries.length} entrie(s) to ${toPosix(path.relative(repoRoot, baselinePath))}. Review the diff — --write records NEW drift too.`,
		);
		return 0;
	}

	const baseline = loadBaseline(baselinePath);
	const ratchet = checkAnchorRatchet(result.anchorFailures, baseline);
	const { lines, failed } = formatReport(result, ratchet, baseline.length);
	for (const line of lines) {
		if (failed) {
			console.error(line);
		} else {
			console.log(line);
		}
	}
	return failed ? 1 : 0;
}

if (import.meta.main) {
	process.exit(main());
}
