export const CANDIDATE_SEVERITIES = [
	'INFO',
	'LOW',
	'MEDIUM',
	'HIGH',
	'CRITICAL',
] as const;

export type CandidateSeverity = (typeof CANDIDATE_SEVERITIES)[number];

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
	const text = removeCandidateCodeFences(rawText);
	const header = selectCandidateHeader(text.split(/\r?\n/));
	if (header?.markerBearing && header.family !== null) {
		return { text, synthesizedHeader: false };
	}
	// A canonical header that survives fence-stripping but does not lead is a
	// genuine contract violation: a later valid header still cannot rescue a
	// malformed first marker.
	if (declaredCanonicalFamilies(text).length > 0) {
		return { text, synthesizedHeader: false };
	}
	// A header that existed only inside a code fence was deleted before it could
	// be read. Honour the family it declared: if that disagrees with the expected
	// family the artifact must still fail closed, but if it agrees there is
	// nothing to protect and refusing would discard the lane's findings for no
	// reason.
	if (
		declaredCanonicalFamilies(rawText).some(
			(family) => family !== fallbackFamily,
		)
	) {
		return { text, synthesizedHeader: false };
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
	if (!hasSalvageableRow) return { text, synthesizedHeader: false };
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
	return {
		text: [
			...lines.slice(0, firstSalvageableIndex),
			CANDIDATE_HEADERS[fallbackFamily],
			...lines.slice(firstSalvageableIndex),
		].join('\n'),
		synthesizedHeader: true,
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
