export const CANDIDATE_SEVERITIES = [
	'INFO',
	'LOW',
	'MEDIUM',
	'HIGH',
	'CRITICAL',
] as const;

export type CandidateSeverity = (typeof CANDIDATE_SEVERITIES)[number];

/**
 * Severity vocabulary of the PR-review FINDINGS artifact.
 *
 * A findings record is a projection of an authenticated `[REVIEWED]`/`[CRITIC]`
 * verdict row, never of a `[CANDIDATE]` row — so it must speak the VERDICT
 * dialect. That dialect is `REVIEW_SEVERITIES` in `src/hooks/pr-workflow-gate.ts`,
 * which is exactly `CANDIDATE_SEVERITIES` plus `NONE` (a DISPROVED critic verdict
 * is *required* to carry `NONE`, and a CONFIRMED-but-cosmetic reviewer verdict
 * legitimately does). Reusing `CANDIDATE_SEVERITIES` for findings made `NONE`
 * unrepresentable and forced field omission as its only encoding — which in turn
 * disabled the gate's severity comparison (issue #2279).
 *
 * Deliberately a SEPARATE constant rather than a widened `CANDIDATE_SEVERITIES`:
 * that one still governs explorer/micro-lane `[CANDIDATE]` rows
 * (`isCandidateSeverity` → `analyzeCandidateFields`) and the required sidecar
 * field (`candidate-sidecar-store.ts`), where `NONE` is never legitimate — a
 * candidate row asserting "no severity" is a contradiction, not a finding.
 */
export const FINDINGS_SEVERITIES = [...CANDIDATE_SEVERITIES, 'NONE'] as const;

export type FindingsSeverity = (typeof FINDINGS_SEVERITIES)[number];

export const CANDIDATE_CONFIDENCES = ['HIGH', 'MEDIUM', 'LOW'] as const;

export type CandidateConfidence = (typeof CANDIDATE_CONFIDENCES)[number];

export type RowFormatFamily = 'base_explorer' | 'micro_lane';

export const CANDIDATE_FIELD_COUNT = 9;
export const CLEAN_FIELD_COUNT = 4;
export const CLEAN_COVERAGE_SCOPE_MIN_CHARS = 12;
export const CLEAN_EVIDENCE_MIN_CHARS = 20;
export const CANDIDATE_DIAGNOSTIC_PREVIEW_CHARS = 160;

export const CANDIDATE_FIELDS = {
	base_explorer: [
		'candidate_id',
		'lane',
		'severity',
		'category',
		'file_line',
		'claim',
		'evidence_summary',
		'impact_context',
		'confidence',
	],
	micro_lane: [
		'candidate_id',
		'micro_lane',
		'severity',
		'category',
		'file_line',
		'claim',
		'invariant_violated',
		'evidence_summary',
		'confidence',
	],
} as const;

export const CANDIDATE_MARKER = '[CANDIDATE]' as const;
export const CLEAN_MARKER = '[CLEAN]' as const;

/** Canonical marker-bearing header derived from the parser's field authority. */
export function formatCandidateHeader(family: RowFormatFamily): string {
	return [
		CANDIDATE_MARKER,
		...CANDIDATE_FIELDS[family].map((name) =>
			name === 'file_line' ? 'file:line' : name,
		),
	].join(' | ');
}

/** Canonical zero-finding attestation template for one row family. */
export function formatCleanTemplate(family: RowFormatFamily): string {
	const laneField = family === 'base_explorer' ? 'lane' : 'micro_lane';
	return [CLEAN_MARKER, laneField, 'coverage_scope', 'evidence'].join(' | ');
}

export const CANDIDATE_HEADERS = {
	base_explorer: formatCandidateHeader('base_explorer'),
	micro_lane: formatCandidateHeader('micro_lane'),
} as const;

export const CLEAN_TEMPLATES = {
	base_explorer: formatCleanTemplate('base_explorer'),
	micro_lane: formatCleanTemplate('micro_lane'),
} as const;

/** Identify only an exact, marker-bearing canonical candidate header. */
export function candidateHeaderFamily(
	fields: readonly string[],
): RowFormatFamily | null {
	if (fields[0]?.trim() !== CANDIDATE_MARKER) return null;
	const normalized = fields.slice(1).map((field) => field.trim());
	for (const family of ['base_explorer', 'micro_lane'] as const) {
		const canonicalHeaderFields = CANDIDATE_FIELDS[family].map((name) =>
			name === 'file_line' ? 'file:line' : name,
		);
		if (
			normalized.length === canonicalHeaderFields.length &&
			canonicalHeaderFields.every((name, index) => normalized[index] === name)
		) {
			return family;
		}
	}
	return null;
}

export interface CandidateHeaderSelection {
	lineIndex: number;
	fields: string[];
	family: RowFormatFamily | null;
	markerBearing: boolean;
}

/**
 * Locate the candidate protocol frame in a stored assistant transcript.
 * Unmarked tabular text remains a compatibility fallback only when the
 * transcript contains no marker-bearing candidate line. The first marker is
 * authoritative even when malformed so a later valid header cannot rescue it.
 */
export function selectCandidateHeader(
	lines: readonly string[],
): CandidateHeaderSelection | null {
	let markerlessFallback: CandidateHeaderSelection | null = null;
	for (const [lineIndex, line] of lines.entries()) {
		const fields = splitPipeFields(line.trim()).map((field) => field.trim());
		if (fields.length < 2 || !fields.some(Boolean)) continue;
		const markerBearing = fields[0] === '[CANDIDATE]';
		const selection: CandidateHeaderSelection = {
			lineIndex,
			fields,
			family: candidateHeaderFamily(fields),
			markerBearing,
		};
		if (markerBearing) return selection;
		markerlessFallback ??= selection;
	}
	return markerlessFallback;
}

/** Remove fenced markdown blocks before any candidate-contract inspection. */
export function removeCandidateCodeFences(text: string): string {
	const lines: string[] = [];
	let inFence = false;
	for (const rawLine of text.split('\n')) {
		if (rawLine.trimStart().startsWith('```')) {
			inFence = !inFence;
			continue;
		}
		if (!inFence) lines.push(rawLine);
	}
	return lines.join('\n');
}

export interface NormalizedCandidateArtifact {
	/** Fence-stripped text, with a canonical header synthesized when salvageable. */
	text: string;
	/** True when a canonical header was supplied by this normalizer. */
	synthesizedHeader: boolean;
	/** Narrow, auditable repairs applied before the unchanged strict parser runs. */
	repairKinds: CandidateArtifactRepairKind[];
}

export type CandidateArtifactRepairKind =
	| 'synthesized-header'
	| 'terminal-protocol-fence'
	| 'redundant-clean-confidence'
	| 'clean-evidence-pipe-tail-merge'
	| 'candidate-evidence-pipe-recovery-lossy'
	| 'late-canonical-header-resynchronized'
	| 'summary-row-dropped'
	| 'duplicate-header-row-dropped';

interface MarkdownFenceBlock {
	openingLine: number;
	closingLine: number;
	content: string[];
}

function parseClosedMarkdownFences(text: string): {
	lines: string[];
	blocks: MarkdownFenceBlock[];
	unfencedLines: string[];
} | null {
	const lines = text.split(/\r?\n/);
	const blocks: MarkdownFenceBlock[] = [];
	const fencedLineIndexes = new Set<number>();
	let openingLine = -1;
	let openingWidth = 0;
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (openingLine < 0) {
			const opening = line.match(/^\s{0,3}(`{3,})([^`]*)$/);
			if (!opening) continue;
			openingLine = index;
			openingWidth = opening[1].length;
			continue;
		}
		const closing = line.match(/^\s{0,3}(`{3,})\s*$/);
		if (!closing || closing[1].length < openingWidth) continue;
		const content = lines.slice(openingLine + 1, index);
		blocks.push({ openingLine, closingLine: index, content });
		for (let fenced = openingLine; fenced <= index; fenced += 1) {
			fencedLineIndexes.add(fenced);
		}
		openingLine = -1;
		openingWidth = 0;
	}
	if (openingLine >= 0) return null;
	return {
		lines,
		blocks,
		unfencedLines: lines.filter((_, index) => !fencedLineIndexes.has(index)),
	};
}

function lineCarriesCandidateProtocol(line: string): boolean {
	const fields = splitPipeFields(line.trim()).map((field) => field.trim());
	return (
		fields[0] === CANDIDATE_MARKER ||
		fields[0] === CLEAN_MARKER ||
		candidateHeaderFamily(fields) !== null
	);
}

function lastUnescapedPipeIndex(line: string): number {
	let last = -1;
	for (let index = 0; index < line.length; index += 1) {
		if (line[index] === '\\' && line[index + 1] === '|') {
			index += 1;
			continue;
		}
		if (line[index] === '|') last = index;
	}
	return last;
}

function repairRedundantCleanConfidenceLine(
	line: string,
	family: RowFormatFamily,
): { line: string; repaired: boolean } {
	const fields = splitPipeFields(line).map((field) => field.trim());
	if (
		fields.length !== CLEAN_FIELD_COUNT + 1 ||
		fields[0] !== CLEAN_MARKER ||
		!isCandidateConfidence(fields[CLEAN_FIELD_COUNT]) ||
		!analyzeCleanFields(fields.slice(0, CLEAN_FIELD_COUNT), family).valid
	) {
		return { line, repaired: false };
	}
	const delimiter = lastUnescapedPipeIndex(line);
	if (delimiter < 0) return { line, repaired: false };
	return { line: line.slice(0, delimiter).trimEnd(), repaired: true };
}

function repairRedundantCleanConfidence(
	text: string,
	family: RowFormatFamily,
): { text: string; repaired: boolean } {
	let repaired = false;
	const lines = text.split(/\r?\n/).map((line) => {
		const result = repairRedundantCleanConfidenceLine(line, family);
		repaired ||= result.repaired;
		return result.line;
	});
	return { text: lines.join('\n'), repaired };
}

/**
 * A lane's trailing self-summary or aside rows (``[LANE_SUMMARY]``, ``[NOTE]``,
 * ``[DONE]``, …) carry a bracket marker token in their first pipe field. They
 * are not part of the candidate contract, yet their pipe-delimited shape was
 * previously misclassified as malformed short candidate rows, voiding an
 * otherwise-valid CLEAN attestation via the zero-malformed-rows rule. Only
 * pipe-bearing marker lines are dropped: a pipe-free line (even one starting
 * with a bracket token) is harmless prose today and may be a continuation
 * fragment, so it is preserved. Marker lines for the contract's own rows
 * ([CANDIDATE]/[CLEAN]) are never dropped. The match is deliberately
 * UPPERCASE-ONLY: the machine contract's markers are uppercase by convention
 * ([LANE_SUMMARY], [NOTE], [DONE]), and a lowercase bracket token is likelier
 * prose than a marker row.
 */
const NON_CONTRACT_MARKER_LINE =
	/^\[(?!(?:CANDIDATE|CLEAN)\])[A-Z][A-Z0-9_-]*\]/;

/**
 * True when a line is shaped exactly like a canonical candidate header — either
 * marker-bearing (`[CANDIDATE] | candidate_id | lane | …`) or the bare field-name
 * list re-emitted without its marker.
 */
function canonicalHeaderShape(line: string): { markerBearing: boolean } | null {
	const fields = splitPipeFields(line.trim()).map((field) => field.trim());
	if (fields.length === 0) return null;
	if (candidateHeaderFamily(fields)) return { markerBearing: true };
	for (const family of ['base_explorer', 'micro_lane'] as const) {
		const canonical = CANDIDATE_FIELDS[family].map((name) =>
			name === 'file_line' ? 'file:line' : name,
		);
		if (
			fields.length === canonical.length &&
			canonical.every((name, index) => fields[index] === name)
		) {
			return { markerBearing: false };
		}
	}
	return null;
}

/**
 * A lane that re-emits its header as a data row (a "placeholder" row — literal
 * template text pasted where a finding belonged) previously had that row reach
 * `analyzeCandidateFields`, fail, and increment `malformedRows` — which trips the
 * zero-malformed-rows rule and destroys an otherwise-valid `[CLEAN]` attestation,
 * possibly for a DIFFERENT lane. An echoed header carries no *parsed* information
 * — the strict parser rejects it as a data row either way — so dropping it is
 * parse-equivalent salvage (issue #2279).
 *
 * Known narrow case: a consolidated artifact carrying canonical headers for BOTH
 * row families loses the second family's header, which is a structural marker
 * rather than an echo. No parsed candidate value changes as a result — the rows
 * under that header were already being read against the first header's family
 * before this repair existed — so the only delta is the suppressed
 * `malformed_rows` increment. That suppression is the point: it is what stops a
 * placeholder row from voiding an unrelated lane's valid `[CLEAN]`.
 *
 * The survivor is the MARKER-BEARING canonical header, never merely the first
 * such line: `selectCandidateHeader` treats the first marker-bearing line as
 * authoritative and only falls back to a markerless one, so keeping a markerless
 * field-name list that happened to precede the real header would delete the real
 * header and manufacture a header failure that does not exist today.
 *
 * A legitimate candidate row can never be dropped here: the match demands exact
 * equality against all nine canonical field NAMES, and `analyzeCandidateFields`
 * independently rejects the literal `"severity"` as a severity value — a
 * header-shaped row is definitionally not a valid candidate.
 */
function dropDuplicateHeaderRows(text: string): {
	text: string;
	dropped: boolean;
} {
	const lines = text.split(/\r?\n/);
	const shapes = lines.map((line) =>
		line.includes('|') ? canonicalHeaderShape(line) : null,
	);
	const keepIndex = (() => {
		const markerBearing = shapes.findIndex((shape) => shape?.markerBearing);
		if (markerBearing !== -1) return markerBearing;
		return shapes.findIndex((shape) => shape !== null);
	})();
	if (keepIndex === -1) return { text, dropped: false };
	const kept = lines.filter(
		(_line, index) => shapes[index] === null || index === keepIndex,
	);
	return {
		text: kept.join('\n'),
		dropped: kept.length !== lines.length,
	};
}

function dropNonContractMarkerRows(text: string): {
	text: string;
	dropped: boolean;
} {
	const lines = text.split(/\r?\n/);
	const kept = lines.filter((line) => {
		if (!line.includes('|')) return true;
		const firstField = splitPipeFields(line.trim())[0]?.trim() ?? '';
		return !NON_CONTRACT_MARKER_LINE.test(firstField);
	});
	return {
		text: kept.join('\n'),
		dropped: kept.length !== lines.length,
	};
}

/**
 * Escape unescaped pipe separators beyond the CLEAN field count so free-text
 * evidence containing literal pipes (regex character classes, `,;|`, shell
 * snippets) re-merges into the trailing evidence field instead of splitting
 * the row past `CLEAN_FIELD_COUNT`. Deterministic: evidence is the trailing
 * field, so extra unescaped separators can only belong to it. Runs before the
 * other line repairs so downstream repairs see canonical field counts.
 */
function repairCleanEvidencePipesLine(line: string): {
	line: string;
	repaired: boolean;
} {
	if (splitPipeFields(line)[0]?.trim() !== CLEAN_MARKER) {
		return { line, repaired: false };
	}
	let separatorCount = 0;
	let out = '';
	for (let index = 0; index < line.length; index += 1) {
		const char = line[index];
		if (char === '\\' && line[index + 1] === '|') {
			out += '\\|';
			index += 1;
			continue;
		}
		if (char === '|') {
			separatorCount += 1;
			out += separatorCount <= CLEAN_FIELD_COUNT - 1 ? '|' : '\\|';
			continue;
		}
		out += char;
	}
	return separatorCount > CLEAN_FIELD_COUNT - 1
		? { line: out, repaired: true }
		: { line, repaired: false };
}

function repairCleanEvidencePipes(text: string): {
	text: string;
	repaired: boolean;
} {
	let repaired = false;
	const lines = text.split(/\r?\n/).map((line) => {
		const result = repairCleanEvidencePipesLine(line);
		repaired ||= result.repaired;
		return result.line;
	});
	return { text: lines.join('\n'), repaired };
}

function escapeCandidateField(value: string): string {
	return value.trim().replace(/\|/g, '\\|');
}

function repairCandidateEvidencePipes(
	text: string,
	family: RowFormatFamily,
): { text: string; repaired: boolean } {
	let repaired = false;
	const lines = text.split(/\r?\n/).map((line) => {
		const fields = splitPipeFields(line);
		if (
			fields[0]?.trim() !== CANDIDATE_MARKER ||
			fields.length <= CANDIDATE_FIELD_COUNT + 1 ||
			fields.length > CANDIDATE_FIELD_COUNT + 17 ||
			!isCandidateConfidence(fields.at(-1)?.trim())
		) {
			return line;
		}
		const normalized = fields.map(escapeCandidateField);
		const overflowEvidence =
			family === 'base_explorer'
				? normalized.slice(7, -2)
				: normalized.slice(8, -1);
		// Two overflow fields are indistinguishable from a base/micro hybrid row.
		// Require three substantial prose fragments so recovery remains narrow and
		// explicitly lossy instead of silently retyping a shifted schema column.
		if (
			overflowEvidence.length < 3 ||
			overflowEvidence.some((fragment) => fragment.length < 4)
		) {
			return line;
		}
		const rebuilt =
			family === 'base_explorer'
				? [
						...normalized.slice(0, 7),
						overflowEvidence.join(' \\| '),
						...normalized.slice(-2),
					]
				: [
						...normalized.slice(0, 8),
						overflowEvidence.join(' \\| '),
						normalized.at(-1) ?? '',
					];
		if (rebuilt.length !== CANDIDATE_FIELD_COUNT + 1) return line;
		repaired = true;
		return rebuilt.join(' | ');
	});
	return { text: lines.join('\n'), repaired };
}

function resynchronizeLateCanonicalHeader(
	text: string,
	family: RowFormatFamily,
): { text: string; repaired: boolean } {
	const lines = text.split(/\r?\n/);
	const firstMarker = lines.findIndex((line) => {
		const marker = splitPipeFields(line)[0]?.trim();
		return marker === CANDIDATE_MARKER || marker === CLEAN_MARKER;
	});
	if (
		firstMarker < 0 ||
		!analyzeCandidateLine(lines[firstMarker]!, family)?.valid
	) {
		return { text, repaired: false };
	}
	const headerIndexes = lines.flatMap((line, index) =>
		line.trim() === CANDIDATE_HEADERS[family] ? [index] : [],
	);
	if (!headerIndexes.some((index) => index > firstMarker)) {
		return { text, repaired: false };
	}
	if (declaredCanonicalFamilies(text).some((declared) => declared !== family)) {
		return { text, repaired: false };
	}
	const withoutHeaders = lines.filter(
		(_line, index) => !headerIndexes.includes(index),
	);
	const insertion = withoutHeaders.findIndex((line) => {
		const marker = splitPipeFields(line)[0]?.trim();
		return marker === CANDIDATE_MARKER || marker === CLEAN_MARKER;
	});
	return {
		text: [
			...withoutHeaders.slice(0, insertion),
			CANDIDATE_HEADERS[family],
			...withoutHeaders.slice(insertion),
		].join('\n'),
		repaired: true,
	};
}

function isStrictProtocolDataLine(
	line: string,
	family: RowFormatFamily,
): boolean {
	const clean = repairRedundantCleanConfidenceLine(line, family).line;
	const fields = splitPipeFields(clean).map((field) => field.trim());
	if (fields[0] === CLEAN_MARKER) {
		return analyzeCleanFields(fields, family).valid;
	}
	if (fields[0] === CANDIDATE_MARKER) {
		return analyzeCandidateFields(fields.slice(1), family).valid;
	}
	return analyzeCandidateFields(fields, family).valid;
}

function recoverTerminalProtocolFence(
	rawText: string,
	family: RowFormatFamily,
): string | null {
	const parsed = parseClosedMarkdownFences(rawText);
	if (!parsed || parsed.blocks.length === 0) return null;
	if (parsed.unfencedLines.some(lineCarriesCandidateProtocol)) return null;

	let lastNonblankLine = parsed.lines.length - 1;
	while (
		lastNonblankLine >= 0 &&
		parsed.lines[lastNonblankLine].trim().length === 0
	) {
		lastNonblankLine -= 1;
	}
	const terminal = parsed.blocks.at(-1)!;
	if (terminal.closingLine !== lastNonblankLine) return null;
	// Earlier quoted examples are harmless only when they contain no candidate
	// protocol at all. A second fenced protocol frame is ambiguous and stays out.
	if (
		parsed.blocks
			.slice(0, -1)
			.some((block) => block.content.some(lineCarriesCandidateProtocol))
	) {
		return null;
	}

	const content = terminal.content.slice().map((line) => line.trimEnd());
	while (content[0]?.trim() === '') content.shift();
	while (content.at(-1)?.trim() === '') content.pop();
	if (content[0]?.trim() !== CANDIDATE_HEADERS[family]) return null;
	const rows = content.slice(1).filter((line) => line.trim() !== '');
	if (
		rows.length === 0 ||
		!rows.every((line) => isStrictProtocolDataLine(line, family))
	) {
		return null;
	}

	const outside = parsed.unfencedLines.join('\n').trimEnd();
	const protocol = content.join('\n');
	return outside ? `${outside}\n${protocol}` : protocol;
}

/** Every canonical header family declared on any line of `source`. */
function declaredCanonicalFamilies(source: string): RowFormatFamily[] {
	const families: RowFormatFamily[] = [];
	for (const line of source.split(/\r?\n/)) {
		const family = candidateHeaderFamily(
			splitPipeFields(line).map((field) => field.trim()),
		);
		if (family && !families.includes(family)) families.push(family);
	}
	return families;
}

/**
 * Normalize a lane artifact ONCE so every consumer parses byte-identical text.
 *
 * Coverage validation and candidate-id extraction previously applied the header
 * rule in two separate places, so a repair applied to one could not be seen by
 * the other — a lane could be judged "covered" while contributing zero findings
 * to the inventory. Both callers now route through this function.
 *
 * A missing header is repaired; a *wrong* or *late* header is not, so genuine
 * contract violations still fail closed:
 *  - a leading canonical header (either family) is left alone, preserving
 *    `expected-family-mismatch`;
 *  - a canonical header that exists but does not lead is left alone, preserving
 *    "a later valid header cannot rescue a malformed first marker";
 *  - only a total absence of any canonical header, together with at least one
 *    valid marker-bearing row, is repaired.
 *
 * KNOWN RESIDUAL: the two row families are both nine fields and differ only in
 * the meaning of positions 6 and 7 (`evidence_summary`/`impact_context` versus
 * `invariant_violated`/`evidence_summary`), neither of which is structurally
 * distinguishable. A headerless lane that emits the other family's field order
 * is therefore repaired into the expected family and its two prose fields are
 * transposed. Callers surface `synthesizedHeader` so this is auditable.
 */
export function normalizeCandidateArtifact(
	rawText: string,
	fallbackFamily: RowFormatFamily,
): NormalizedCandidateArtifact {
	const repairKinds: CandidateArtifactRepairKind[] = [];
	// Marker-row drop runs first (it is shape-only), then the pre-existing
	// repairs in their historical order, then the pipe tail-merge LAST: the
	// redundant-confidence repair must see a 5-field row before the tail-merge
	// folds the trailing token into evidence, while the tail-merge is the final
	// fallback for prose pipes that no earlier repair addresses.
	const summaryDrop = dropNonContractMarkerRows(rawText);
	if (summaryDrop.dropped) repairKinds.push('summary-row-dropped');
	const recoveredFence = recoverTerminalProtocolFence(
		summaryDrop.text,
		fallbackFamily,
	);
	if (recoveredFence !== null) repairKinds.push('terminal-protocol-fence');
	const cleanRepair = repairRedundantCleanConfidence(
		recoveredFence ?? removeCandidateCodeFences(summaryDrop.text),
		fallbackFamily,
	);
	if (cleanRepair.repaired) repairKinds.push('redundant-clean-confidence');
	const pipeRepair = repairCleanEvidencePipes(cleanRepair.text);
	if (pipeRepair.repaired) repairKinds.push('clean-evidence-pipe-tail-merge');
	const candidatePipeRepair = repairCandidateEvidencePipes(
		pipeRepair.text,
		fallbackFamily,
	);
	if (candidatePipeRepair.repaired) {
		repairKinds.push('candidate-evidence-pipe-recovery-lossy');
	}
	const lateHeaderRepair = resynchronizeLateCanonicalHeader(
		candidatePipeRepair.text,
		fallbackFamily,
	);
	if (lateHeaderRepair.repaired) {
		repairKinds.push('late-canonical-header-resynchronized');
	}
	// Runs LAST of the line-set repairs, so the duplicate-header scan sees the
	// final line set: both the marker-row drop and the terminal-fence recovery
	// above add or remove lines that header selection would otherwise disagree
	// about.
	const duplicateHeaderDrop = dropDuplicateHeaderRows(lateHeaderRepair.text);
	if (duplicateHeaderDrop.dropped) {
		repairKinds.push('duplicate-header-row-dropped');
	}
	const text = duplicateHeaderDrop.text;
	const header = selectCandidateHeader(text.split(/\r?\n/));
	if (header?.markerBearing && header.family !== null) {
		return { text, synthesizedHeader: false, repairKinds };
	}
	// A canonical header that survives fence-stripping but does not lead is a
	// genuine contract violation: a later valid header still cannot rescue a
	// malformed first marker.
	if (declaredCanonicalFamilies(text).length > 0) {
		return { text, synthesizedHeader: false, repairKinds };
	}
	// A header that existed only inside a code fence was deleted before it could
	// be read. Honour the family it declared: if that disagrees with the expected
	// family the artifact must still fail closed, but if it agrees there is
	// nothing to protect and refusing would discard the lane's findings for no
	// reason. The declaration must be read from the PRE-strip source — the
	// stripped text no longer contains the fenced header that declares it.
	if (
		declaredCanonicalFamilies(summaryDrop.text).some(
			(family) => family !== fallbackFamily,
		)
	) {
		return { text, synthesizedHeader: false, repairKinds };
	}
	// A lane proves it did the work with EITHER a valid candidate row or a valid
	// zero-findings [CLEAN] attestation. Triggering only on candidate rows would
	// leave a lane that correctly found nothing permanently unsalvageable — and a
	// single unresolved micro lane blocks an entire PR-review run.
	const lines = text.split(/\r?\n/);
	// The TRIGGER asks whether the lane produced anything worth keeping.
	const hasSalvageableRow = lines.some((line) => {
		if (analyzeCandidateLine(line, fallbackFamily)?.valid === true) return true;
		const fields = splitPipeFields(line).map((field) => field.trim());
		if (fields[0] !== CLEAN_MARKER) return false;
		return analyzeCleanFields(fields, fallbackFamily).valid;
	});
	if (!hasSalvageableRow)
		return { text, synthesizedHeader: false, repairKinds };
	// The INSERTION POINT is the first marker-bearing line, valid or not —
	// deliberately not the first *valid* row. selectCandidateHeader takes the
	// first marker-bearing line as authoritative, so inserting after a malformed
	// marker would leave that malformed line as the header and fail the artifact
	// anyway. Placing the header above it demotes it to a data row, which is then
	// rejected on its own merits while its valid siblings survive. This matters:
	// headerless (9/16) co-occurring with an unescaped pipe (7/16) is the single
	// most likely recurrence shape.
	// Cannot be -1: hasSalvageableRow above only returns true for a line whose
	// first field is one of these two markers, so at least one such line exists.
	const firstSalvageableIndex = lines.findIndex((line) => {
		const marker = splitPipeFields(line)[0]?.trim();
		return marker === CANDIDATE_MARKER || marker === CLEAN_MARKER;
	});
	// Insert the header immediately before the first salvageable row, not at the
	// top. Prepending would push the explorer's leading prose BELOW the header,
	// where every prose line is counted as a malformed row — which both inflates
	// the diagnostics and trips the CLEAN attestation's zero-malformed-rows rule,
	// defeating the repair it was supposed to enable.
	repairKinds.push('synthesized-header');
	return {
		text: [
			...lines.slice(0, firstSalvageableIndex),
			CANDIDATE_HEADERS[fallbackFamily],
			...lines.slice(firstSalvageableIndex),
		].join('\n'),
		synthesizedHeader: true,
		repairKinds,
	};
}

export type CandidateFieldName =
	(typeof CANDIDATE_FIELDS)[RowFormatFamily][number];

export interface CandidateFieldIssue {
	field: CandidateFieldName | 'row';
	message: string;
}

export interface CandidateFieldAnalysis {
	valid: boolean;
	issues: CandidateFieldIssue[];
	values: Record<CandidateFieldName, string | null>;
	candidateId: string | null;
	workflowLane: string | null;
}

export interface CandidateLaneContext {
	row_format_family?: RowFormatFamily;
	expected_family?: RowFormatFamily;
	expected_lane?: string;
	expected_lanes?: readonly string[];
	expected_micro_lane?: string;
	expected_micro_lanes?: readonly string[];
}

export interface CandidateLaneContextIssue {
	field:
		| 'expected_family'
		| 'expected_lane'
		| 'expected_lanes'
		| 'expected_micro_lane'
		| 'expected_micro_lanes';
	message: string;
}

/**
 * Validate the relationships between the public ownership flags. Keeping this
 * rule here makes the tool boundary and the pure parser refuse the same
 * ambiguous or cross-family ownership declarations.
 */
export function analyzeCandidateLaneContext(
	context: CandidateLaneContext,
): CandidateLaneContextIssue[] {
	const issues: CandidateLaneContextIssue[] = [];
	const baseBound = Boolean(context.expected_lane || context.expected_lanes);
	const microBound = Boolean(
		context.expected_micro_lane || context.expected_micro_lanes,
	);

	if (context.expected_lanes) {
		if (!context.expected_lane) {
			issues.push({
				field: 'expected_lane',
				message: 'expected_lane is required when expected_lanes is supplied',
			});
		}
		if (
			new Set(context.expected_lanes).size !== context.expected_lanes.length
		) {
			issues.push({
				field: 'expected_lanes',
				message: 'expected_lanes must contain unique lane identities',
			});
		}
		if (
			context.expected_lane &&
			!context.expected_lanes.includes(context.expected_lane)
		) {
			issues.push({
				field: 'expected_lanes',
				message: 'expected_lanes must contain expected_lane',
			});
		}
	}

	if (context.expected_micro_lanes) {
		if (!context.expected_micro_lane) {
			issues.push({
				field: 'expected_micro_lane',
				message:
					'expected_micro_lane is required when expected_micro_lanes is supplied',
			});
		}
		if (
			new Set(context.expected_micro_lanes).size !==
			context.expected_micro_lanes.length
		) {
			issues.push({
				field: 'expected_micro_lanes',
				message: 'expected_micro_lanes must contain unique lane identities',
			});
		}
		if (
			context.expected_micro_lane &&
			!context.expected_micro_lanes.includes(context.expected_micro_lane)
		) {
			issues.push({
				field: 'expected_micro_lanes',
				message: 'expected_micro_lanes must contain expected_micro_lane',
			});
		}
	}

	if (!context.expected_family && baseBound && microBound) {
		issues.push({
			field: 'expected_family',
			message:
				'base and micro ownership fields cannot be combined without one expected_family',
		});
	} else if (context.expected_family === 'base_explorer' && microBound) {
		issues.push({
			field: 'expected_family',
			message:
				'base_explorer ownership cannot include expected_micro_lane fields',
		});
	} else if (context.expected_family === 'micro_lane' && baseBound) {
		issues.push({
			field: 'expected_family',
			message: 'micro_lane ownership cannot include expected_lane fields',
		});
	} else if (!context.expected_family && baseBound) {
		issues.push({
			field: 'expected_family',
			message: 'base ownership fields require expected_family base_explorer',
		});
	} else if (!context.expected_family && microBound) {
		issues.push({
			field: 'expected_family',
			message: 'micro ownership fields require expected_family micro_lane',
		});
	}

	return issues;
}

export type CleanFieldName =
	| 'row'
	| 'lane'
	| 'micro_lane'
	| 'coverage_scope'
	| 'evidence';

export interface CleanFieldAnalysis {
	valid: boolean;
	issues: Array<{ field: CleanFieldName; message: string }>;
	lane: string | null;
	coverageScope: string | null;
	evidence: string | null;
}

export interface CleanAttestationBaseRecord {
	record_type: 'clean_attestation';
	row_format_family: 'base_explorer';
	row_format_version: number;
	record_version: { major: number; minor: number };
	source_output_ref: string;
	source_batch_id: string;
	source_lane_id: string;
	source_agent: string;
	source_digest: string;
	extracted_from_partial_source: false;
	sessionId?: string;
	parentSessionId?: string;
	producer?: string;
	lane: string;
	coverage_scope: string;
	evidence: string;
}

export interface CleanAttestationMicroRecord {
	record_type: 'clean_attestation';
	row_format_family: 'micro_lane';
	row_format_version: number;
	record_version: { major: number; minor: number };
	source_output_ref: string;
	source_batch_id: string;
	source_lane_id: string;
	source_agent: string;
	source_digest: string;
	extracted_from_partial_source: false;
	sessionId?: string;
	parentSessionId?: string;
	producer?: string;
	micro_lane: string;
	coverage_scope: string;
	evidence: string;
}

export type CleanAttestationRecord =
	| CleanAttestationBaseRecord
	| CleanAttestationMicroRecord;

export function splitPipeFields(line: string): string[] {
	const fields: string[] = [];
	let current = '';
	for (let index = 0; index < line.length; index++) {
		const char = line[index];
		if (char === '\\' && index + 1 < line.length && line[index + 1] === '|') {
			current += '|';
			index++;
			continue;
		}
		if (char === '|') {
			fields.push(current);
			current = '';
			continue;
		}
		current += char;
	}
	fields.push(current);
	return fields;
}

export function candidateDiagnosticPreview(value: string): string {
	const normalized = value.replace(/[\r\n\t]+/g, ' ').trim();
	if (normalized.length <= CANDIDATE_DIAGNOSTIC_PREVIEW_CHARS)
		return normalized;
	return `${normalized.slice(0, CANDIDATE_DIAGNOSTIC_PREVIEW_CHARS)}...`;
}

export function isCandidateSeverity(
	value: string | null | undefined,
): value is CandidateSeverity {
	return (
		value !== null &&
		value !== undefined &&
		CANDIDATE_SEVERITIES.includes(value as CandidateSeverity)
	);
}

export function isCandidateConfidence(
	value: string | null | undefined,
): value is CandidateConfidence {
	return (
		value !== null &&
		value !== undefined &&
		CANDIDATE_CONFIDENCES.includes(value as CandidateConfidence)
	);
}

export function isCandidateLookingShortRow(
	fields: string[],
	_context: CandidateLaneContext,
	explicitCandidateMarker = false,
): boolean {
	if (explicitCandidateMarker || fields[0]?.trim() === '[CANDIDATE]')
		return true;
	// After a canonical header, any unescaped pipe makes this a tabular row.
	// Default explorer data rows are unprefixed, so limiting recognition to an
	// expected lane lets short foreign rows masquerade as multiline prose and
	// get absorbed into the preceding candidate's evidence.
	return fields.length >= 2;
}

/** Validate one marker-stripped canonical candidate row. */
export function analyzeCandidateFields(
	fields: readonly string[],
	family: RowFormatFamily,
): CandidateFieldAnalysis {
	const names = CANDIDATE_FIELDS[family];
	const trimmed = fields.map((field) => field.trim());
	const values = {} as Record<CandidateFieldName, string | null>;
	const issues: CandidateFieldIssue[] = [];
	if (trimmed.length !== CANDIDATE_FIELD_COUNT) {
		issues.push({
			field: 'row',
			message: `Expected exactly ${CANDIDATE_FIELD_COUNT} candidate fields, received ${trimmed.length}`,
		});
	}
	for (let index = 0; index < names.length; index++) {
		const name = names[index];
		const value = trimmed[index]?.trim() || null;
		values[name] = value;
		if (value === null) {
			issues.push({
				field: name,
				message: `Missing required field: ${name}`,
			});
		}
	}
	const severity = values.severity;
	if (severity !== null && !isCandidateSeverity(severity)) {
		issues.push({
			field: 'severity',
			message: `Invalid severity: ${candidateDiagnosticPreview(severity)}; expected ${CANDIDATE_SEVERITIES.join('|')}`,
		});
	}
	const confidence = values.confidence;
	if (confidence !== null && !isCandidateConfidence(confidence)) {
		issues.push({
			field: 'confidence',
			message: `Invalid confidence: ${candidateDiagnosticPreview(confidence)}; expected ${CANDIDATE_CONFIDENCES.join('|')}`,
		});
	}
	return {
		valid: issues.length === 0,
		issues,
		values,
		candidateId: values.candidate_id,
		workflowLane: family === 'base_explorer' ? values.lane : values.micro_lane,
	};
}

/** Validate one canonical CLEAN row, including its marker and lane identity. */
export function analyzeCleanFields(
	fields: readonly string[],
	family: RowFormatFamily,
	expectedLane?: string,
): CleanFieldAnalysis {
	const trimmed = fields.map((field) => field.trim());
	const issues: CleanFieldAnalysis['issues'] = [];
	const laneField: CleanFieldName =
		family === 'base_explorer' ? 'lane' : 'micro_lane';
	if (trimmed.length !== CLEAN_FIELD_COUNT) {
		issues.push({
			field: 'row',
			message: `Expected exactly ${CLEAN_FIELD_COUNT - 1} CLEAN fields after [CLEAN], received ${Math.max(0, trimmed.length - 1)}`,
		});
	}
	if (trimmed[0] !== '[CLEAN]') {
		issues.push({ field: 'row', message: 'CLEAN row must begin with [CLEAN]' });
	}
	const lane = trimmed[1] || null;
	const coverageScope = trimmed[2] || null;
	const evidence = trimmed[3] || null;
	if (lane === null) {
		issues.push({
			field: laneField,
			message: `Missing required field: ${laneField}`,
		});
	} else if (expectedLane !== undefined && lane !== expectedLane) {
		issues.push({
			field: laneField,
			message: `Expected ${laneField} ${candidateDiagnosticPreview(expectedLane)}, received ${candidateDiagnosticPreview(lane)}`,
		});
	}
	if (coverageScope === null) {
		issues.push({
			field: 'coverage_scope',
			message: 'Missing required field: coverage_scope',
		});
	} else if (coverageScope.length < CLEAN_COVERAGE_SCOPE_MIN_CHARS) {
		issues.push({
			field: 'coverage_scope',
			message: `coverage_scope must contain at least ${CLEAN_COVERAGE_SCOPE_MIN_CHARS} characters`,
		});
	}
	if (evidence === null) {
		issues.push({
			field: 'evidence',
			message: 'Missing required field: evidence',
		});
	} else if (evidence.length < CLEAN_EVIDENCE_MIN_CHARS) {
		issues.push({
			field: 'evidence',
			message: `evidence must contain at least ${CLEAN_EVIDENCE_MIN_CHARS} characters`,
		});
	}
	return {
		valid: issues.length === 0,
		issues,
		lane,
		coverageScope,
		evidence,
	};
}

/** Analyze one raw artifact line when it explicitly carries the marker. */
export function analyzeCandidateLine(
	line: string,
	family: RowFormatFamily,
): CandidateFieldAnalysis | null {
	const fields = splitPipeFields(line).map((field) => field.trim());
	if (fields[0] !== '[CANDIDATE]') return null;
	return analyzeCandidateFields(fields.slice(1), family);
}
