import { z } from 'zod';
import { appendToSidecar } from './candidate-sidecar-store';

// ---------------------------------------------------------------------------
// Zod input validation schemas (matching lane-output-store.ts style)
// ---------------------------------------------------------------------------

const ArtifactInputSchema = z
	.object({
		output_ref: z.string().min(1, 'output_ref must be a non-empty string'),
		batchId: z.string().min(1, 'batchId must be a non-empty string'),
		laneId: z.string().min(1, 'laneId must be a non-empty string'),
		agent: z.string().min(1, 'agent must be a non-empty string'),
		role: z.string().min(1, 'role must be a non-empty string'),
		sessionId: z.string().min(1).optional(),
		parentSessionId: z.string().min(1).optional(),
		digest: z
			.string()
			.regex(/^[a-f0-9]{64}$/, 'digest must be a SHA-256 hex string'),
		text: z.string(),
		transcriptIncomplete: z.boolean().optional(),
		artifact_status: z.enum(['ok', 'ref-not-found', 'artifact-corrupted']),
		source: z.enum(['dispatch_lanes', 'collect_lane_results']),
		produced_at: z.string().min(1, 'produced_at must be a non-empty string'),
	})
	.strict();

const ParseFlagsSchema = z
	.object({
		accept_partial: z.boolean(),
		accept_degraded: z.boolean(),
		degraded: z.boolean(),
		row_format_version: z.number().int().nonnegative(),
		producer: z.string().optional(),
		expected_family: z.enum(['base_explorer', 'micro_lane']).optional(),
		expected_micro_lane: z.string().trim().min(1).optional(),
		/**
		 * Full owned family set of a consolidated (depth-tiered) lane artifact.
		 * Rows and CLEAN attestations for owned-but-not-expected families are
		 * skipped as out-of-scope for this per-family call instead of counting
		 * as mismatches; families outside this set still fail. Defaults to
		 * [expected_micro_lane].
		 */
		expected_micro_lanes: z.array(z.string().trim().min(1)).min(1).optional(),
	})
	.strict();

export type ArtifactInput = z.infer<typeof ArtifactInputSchema>;
export type ParseFlags = z.infer<typeof ParseFlagsSchema>;

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

/**
 * The two supported pipe-delimited format families produced by lane agents.
 */
export type RowFormatFamily = 'base_explorer' | 'micro_lane';

/**
 * A single parsed candidate record extracted from lane text.
 */
export interface CandidateRecord {
	record_type: 'candidate';
	row_format_family: RowFormatFamily;
	row_format_version: number;
	record_version: { major: number; minor: number };
	// Batch-level provenance (FR-004)
	source_output_ref: string;
	source_batch_id: string;
	source_lane_id: string;
	source_agent: string;
	source_digest: string;
	// Source integrity (FR-012)
	extracted_from_partial_source: boolean;
	// Provenance (FR-004)
	sessionId?: string;
	parentSessionId?: string;
	producer?: string;
	// Format-family fields — family-specific fields are null when the other
	// family is active; no classification fields per FR-010.
	candidate_id: string;
	lane: string | null;
	micro_lane: string | null;
	severity: string | null;
	category: string | null;
	file_line: string | null;
	claim: string | null;
	evidence_summary: string | null;
	impact_context: string | null;
	invariant_violated: string | null;
	confidence: string | null;
}

/** A machine-readable attestation that a complete micro-lane found no candidates. */
export interface CleanAttestationRecord {
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

/**
 * One invocation-envelope record per parseCandidates call.
 * Part of the return value but not persisted to a sidecar in this phase.
 */
export interface InvocationEnvelope {
	record_type: 'invocation';
	source_output_ref: string;
	source_batch_id: string;
	source_lane_id: string;
	source_agent: string;
	source_digest: string;
	row_format_version: number;
	producer?: string;
	produced_at: string;
	record_version: { major: number; minor: number };
	sessionId?: string;
	parentSessionId?: string;
	format_families_detected: string[];
	candidate_count: number;
	parse_errors: number;
	malformed_rows: number;
	clean_attestation_count: number;
}

/**
 * Detail record for a required-field violation inside a data row.
 */
export interface ParseErrorDetail {
	row_index: number;
	field: string;
	message: string;
}

/**
 * Warning record for a candidate_id that occurs more than once.
 */
export interface DuplicateIdWarning {
	candidate_id: string;
	occurrences: number;
}

/**
 * Aggregate diagnostics returned alongside every parse result.
 */
export interface DiagnosticsSummary {
	candidate_count: number;
	parse_errors: number;
	parse_error_details: ParseErrorDetail[];
	malformed_rows: number;
	duplicate_id_count: number;
	duplicate_id_warnings: DuplicateIdWarning[];
	degraded_source_count: number;
	incomplete_source_count: number;
	format_families_detected: string[];
	clean_attestation_count: number;
	format_mismatch_hint?: string;
}

/**
 * Top-level return value from parseCandidates.
 */
export interface ParseResult {
	error?: string;
	error_code?: string;
	candidates: CandidateRecord[];
	clean_attestation?: CleanAttestationRecord;
	invocation_envelope: InvocationEnvelope;
	diagnostics: DiagnosticsSummary;
}

/**
 * Options for the parse-and-persist path.
 */
export interface ParsePersistOptions {
	/** Project root directory (OpenCode process working directory). */
	projectRoot: string;
	/** Override the batch digest. When omitted, SHA-256(batchId) is used. */
	batchDigest?: string;
	/**
	 * Passed through to the sidecar store's `useLockfile` option.
	 * When true, a proper-lockfile lock is acquired on the batch directory
	 * before the append; on lock failure `sidecar_write_error` is set.
	 * Default: false (no lock — existing append-only pattern).
	 */
	useLockfile?: boolean;
}

/**
 * ParseResult extended with an optional sidecar write error.
 * When sidecar_write_error is present, the parse succeeded but the
 * sidecar append failed; the caller should treat the parse as valid
 * and log/report the write error separately.
 */
export interface ParseResultWithSidecar extends ParseResult {
	sidecar_write_error?: string;
}

// ---------------------------------------------------------------------------
// Format-family field ordering and discriminators
// ---------------------------------------------------------------------------

const BASE_EXPLORER_FIELDS = [
	'candidate_id',
	'lane',
	'severity',
	'category',
	'file_line',
	'claim',
	'evidence_summary',
	'impact_context',
	'confidence',
] as const;

const MICRO_LANE_FIELDS = [
	'candidate_id',
	'micro_lane',
	'severity',
	'category',
	'file_line',
	'claim',
	'invariant_violated',
	'evidence_summary',
	'confidence',
] as const;

const BASE_EXPLORER_DISCRIMINATOR = 'impact_context';
const MICRO_LANE_DISCRIMINATOR = 'invariant_violated';

const EXPECTED_FIELD_COUNT = 9;
const RECORD_VERSION = { major: 1, minor: 1 };

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Split a single line on unescaped `|` characters.
 * A `\|` sequence is treated as a literal pipe inside a field value (FR-008).
 */
function splitRow(line: string): string[] {
	const fields: string[] = [];
	let current = '';
	let i = 0;

	while (i < line.length) {
		if (line[i] === '\\' && i + 1 < line.length && line[i + 1] === '|') {
			current += '|';
			i += 2;
		} else if (line[i] === '|') {
			fields.push(current);
			current = '';
			i++;
		} else {
			current += line[i];
			i++;
		}
	}

	fields.push(current);
	return fields;
}

/**
 * Remove content that lives inside triple-backtick markdown code fences.
 * The fence markers themselves are also removed (FR-006).
 */
function removeCodeFences(text: string): string {
	const lines: string[] = [];
	let inFence = false;

	for (const rawLine of text.split('\n')) {
		const trimmedStart = rawLine.trimStart();
		if (trimmedStart.startsWith('```')) {
			inFence = !inFence;
			continue;
		}
		if (!inFence) {
			lines.push(rawLine);
		}
	}

	return lines.join('\n');
}

/**
 * Thrown when neither format-family discriminator is present in a header row.
 */
class UnknownFormatFamilyError extends Error {
	constructor() {
		super(
			'Unknown format family: neither impact_context nor invariant_violated present',
		);
		this.name = 'UnknownFormatFamilyError';
	}
}

/**
 * Determine the format family from the header field names (FR-017).
 *
 * - `impact_context` present        → base_explorer
 * - `invariant_violated` present    → micro_lane
 * - both present                    → base_explorer (+ caller emits parse_error)
 * - neither present                 → throws UnknownFormatFamilyError
 */
function detectFormatFamily(headerFields: string[]): RowFormatFamily {
	const trimmed = headerFields.map((f) => f.trim());
	const hasImpactContext = trimmed.includes(BASE_EXPLORER_DISCRIMINATOR);
	const hasInvariantViolated = trimmed.includes(MICRO_LANE_DISCRIMINATOR);

	if (hasImpactContext) {
		return 'base_explorer';
	}
	if (hasInvariantViolated) {
		return 'micro_lane';
	}
	throw new UnknownFormatFamilyError();
}

/**
 * Determine the format family for a single data row by examining
 * discriminator column values (FR-017).
 *
 * Per-row detection: each row is classified independently.
 * - impact_context non-empty (position 7) → base_explorer
 * - invariant_violated non-empty (position 6) → micro_lane
 * - both non-empty → base_explorer (+ caller emits parse_error)
 * - neither → throws UnknownFormatFamilyError
 */
function detectRowFormatFamily(rowFields: string[]): RowFormatFamily {
	const trimmed = rowFields.map((f) => f.trim());
	const hasImpactContext = trimmed.length > 7 && trimmed[7] !== '';
	const hasInvariantViolated = trimmed.length > 6 && trimmed[6] !== '';

	if (hasImpactContext && !hasInvariantViolated) return 'base_explorer';
	if (hasInvariantViolated && !hasImpactContext) return 'micro_lane';
	if (hasImpactContext && hasInvariantViolated) return 'base_explorer';

	throw new UnknownFormatFamilyError();
}

/**
 * Map positional field values to named properties based on the format family.
 * Missing positions (fields beyond the array length) become null.
 * Empty-string values are also normalized to null (FR-002 / SC-009).
 */
function mapFields(
	fields: string[],
	family: RowFormatFamily,
): Record<string, string | null> {
	const trimmed = fields.map((f) => f.trim());
	const names =
		family === 'base_explorer' ? BASE_EXPLORER_FIELDS : MICRO_LANE_FIELDS;
	const result: Record<string, string | null> = {};

	for (let i = 0; i < names.length; i++) {
		result[names[i]] =
			i < trimmed.length && trimmed[i] !== '' ? trimmed[i] : null;
	}

	// Null-out the family-specific fields that do not apply.
	if (family === 'base_explorer') {
		result.micro_lane = null;
		result.invariant_violated = null;
	} else {
		result.lane = null;
		result.impact_context = null;
	}

	return result;
}

function getRequiredFields(family: RowFormatFamily): readonly string[] {
	return family === 'base_explorer' ? BASE_EXPLORER_FIELDS : MICRO_LANE_FIELDS;
}

/** Runtime assertion: candidate_id is guaranteed non-null after the rowMalformed guard. */
function assertNonNullCandidateId(
	value: string | null,
): asserts value is string {
	if (value === null || value === '') {
		throw new Error(
			'Invariant violation: null/empty candidate_id reached candidate builder',
		);
	}
}

// ---------------------------------------------------------------------------
// Result builders
// ---------------------------------------------------------------------------

function buildInvocationEnvelope(
	input: ArtifactInput,
	flags: ParseFlags,
	formatFamiliesDetected: string[],
	candidateCount: number,
	parseErrors: number,
	malformedRows: number,
	cleanAttestationCount = 0,
): InvocationEnvelope {
	return {
		record_type: 'invocation',
		source_output_ref: input.output_ref,
		source_batch_id: input.batchId,
		source_lane_id: input.laneId,
		source_agent: input.agent,
		source_digest: input.digest,
		row_format_version: flags.row_format_version,
		sessionId: input.sessionId,
		parentSessionId: input.parentSessionId,
		...(flags.producer ? { producer: flags.producer } : {}),
		produced_at: input.produced_at,
		record_version: RECORD_VERSION,
		format_families_detected: formatFamiliesDetected,
		candidate_count: candidateCount,
		parse_errors: parseErrors,
		malformed_rows: malformedRows,
		clean_attestation_count: cleanAttestationCount,
	};
}

function buildEmptyDiagnostics(
	input: ArtifactInput,
	flags: ParseFlags,
): DiagnosticsSummary {
	return {
		candidate_count: 0,
		parse_errors: 0,
		parse_error_details: [],
		malformed_rows: 0,
		duplicate_id_count: 0,
		duplicate_id_warnings: [],
		degraded_source_count: flags.degraded ? 1 : 0,
		incomplete_source_count: input.transcriptIncomplete ? 1 : 0,
		format_families_detected: [],
		clean_attestation_count: 0,
	};
}

function refusalResult(
	errorCode: string,
	errorMessage: string,
	input: ArtifactInput,
	flags: ParseFlags,
): ParseResult {
	const envelope = buildInvocationEnvelope(input, flags, [], 0, 0, 0);
	return {
		error: errorMessage,
		error_code: errorCode,
		candidates: [],
		invocation_envelope: envelope,
		diagnostics: buildEmptyDiagnostics(input, flags),
	};
}

function detectFormatMismatchHint(text: string): string | undefined {
	if (text.trim() === '') return undefined;
	const severityPattern = /\b(CRITICAL|HIGH|MEDIUM|LOW|INFO)\b/;
	const fileLinePattern = /\b\S+\.[a-z]{1,4}:\d+\b/;
	const hasSeverity = severityPattern.test(text);
	// Strip scheme-based URLs (http://, https://, ftp://, etc.) before checking for
	// file:line refs to avoid false positives on hostname:port patterns (e.g. api.example.com:8080).
	const textForFileLine = text.replace(/\b\w+:\/\/\S*/g, '');
	const hasFileLine = fileLinePattern.test(textForFileLine);
	if (hasSeverity && hasFileLine) {
		return 'Lane output contains severity keywords and file:line references but no parseable [CANDIDATE] rows. The explorer may have emitted findings in prose format instead of pipe-delimited candidate rows.';
	}
	if (hasSeverity) {
		return 'Lane output contains severity keywords but no parseable [CANDIDATE] rows. The explorer may have emitted findings in an unstructured format.';
	}
	return undefined;
}

function emptyTextResult(input: ArtifactInput, flags: ParseFlags): ParseResult {
	const envelope = buildInvocationEnvelope(input, flags, [], 0, 0, 0);
	const diagnostics = buildEmptyDiagnostics(input, flags);
	const hint = detectFormatMismatchHint(input.text);
	if (hint) {
		diagnostics.format_mismatch_hint = hint;
	}
	return {
		candidates: [],
		invocation_envelope: envelope,
		diagnostics,
	};
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Parse candidate records from structured lane-output text.
 *
 * This is a pure function: no filesystem writes, no store lookups, no I/O.
 * The caller is responsible for store lookup, constructing the ArtifactInput,
 * and setting artifact_status based on lookup outcome.
 *
 * @param input  Structured artifact metadata and raw text.
 * @param flags  Caller-controlled acceptance flags and format version.
 * @returns      Parsed candidates, invocation envelope, and diagnostics.
 */
export function parseCandidates(
	input: ArtifactInput,
	flags: ParseFlags,
): ParseResult {
	const inputParse = ArtifactInputSchema.safeParse(input);
	if (!inputParse.success) {
		throw new Error(
			`Invalid ArtifactInput: ${inputParse.error.issues
				.map((issue) => issue.message)
				.join(', ')}`,
		);
	}

	const flagsParse = ParseFlagsSchema.safeParse(flags);
	if (!flagsParse.success) {
		throw new Error(
			`Invalid ParseFlags: ${flagsParse.error.issues
				.map((issue) => issue.message)
				.join(', ')}`,
		);
	}

	const validatedInput = inputParse.data;
	const validatedFlags = flagsParse.data;

	// -----------------------------------------------------------------------
	// Refusal conditions — fixed priority order (FR-001)
	// -----------------------------------------------------------------------

	if (validatedInput.artifact_status === 'ref-not-found') {
		return refusalResult(
			'ref-not-found',
			'Artifact reference not found in store',
			validatedInput,
			validatedFlags,
		);
	}

	if (validatedInput.artifact_status === 'artifact-corrupted') {
		return refusalResult(
			'artifact-corrupted',
			'Artifact data is corrupted',
			validatedInput,
			validatedFlags,
		);
	}

	if (validatedFlags.degraded && !validatedFlags.accept_degraded) {
		return refusalResult(
			'degraded-source-refused',
			'Degraded source refused by caller',
			validatedInput,
			validatedFlags,
		);
	}

	if (
		validatedInput.transcriptIncomplete === true &&
		!validatedFlags.accept_partial
	) {
		return refusalResult(
			'partial-source-refused',
			'Partial transcript refused by caller',
			validatedInput,
			validatedFlags,
		);
	}

	// Empty text — zero candidates, NOT an error (FR-001 condition 5).
	if (validatedInput.text.trim() === '') {
		return emptyTextResult(validatedInput, validatedFlags);
	}

	// -----------------------------------------------------------------------
	// Parse text into candidates
	// -----------------------------------------------------------------------

	return parseText(validatedInput, validatedFlags);
}

// ---------------------------------------------------------------------------
// Core text parser
// ---------------------------------------------------------------------------

function parseText(input: ArtifactInput, flags: ParseFlags): ParseResult {
	// Strip markdown code fences before row parsing (FR-006).
	const cleanedText = removeCodeFences(input.text);
	const lines = cleanedText.split('\n');

	// Locate the header row: first non-empty line that looks tabular.
	let headerIndex = -1;
	let headerFields: string[] = [];

	for (let i = 0; i < lines.length; i++) {
		const trimmed = lines[i].trim();
		if (trimmed === '') continue;
		const fields = splitRow(trimmed);
		if (fields.length >= 2 && fields.some((f) => f.trim() !== '')) {
			headerIndex = i;
			headerFields = fields.map((f) => f.trim());
			break;
		}
	}

	if (headerIndex === -1) {
		// No header found — nothing to parse.
		return emptyTextResult(input, flags);
	}

	// The asserted batch family is authoritative only when it agrees with a
	// recognizable header. A mismatch is a contract failure, not a remapping hint.
	let headerFamily: RowFormatFamily | undefined;
	try {
		headerFamily = detectFormatFamily(headerFields);
	} catch (e) {
		if (e instanceof UnknownFormatFamilyError) {
			// Header has no recognizable family — continue with per-row detection.
		} else {
			throw e;
		}
	}
	if (
		flags.expected_family !== undefined &&
		headerFamily !== undefined &&
		flags.expected_family !== headerFamily
	) {
		return refusalResult(
			'expected-family-mismatch',
			`Expected ${flags.expected_family} rows but header declares ${headerFamily}`,
			input,
			flags,
		);
	}

	const bothDiscriminators =
		headerFields.includes(BASE_EXPLORER_DISCRIMINATOR) &&
		headerFields.includes(MICRO_LANE_DISCRIMINATOR);

	const parseErrorDetails: ParseErrorDetail[] = [];

	// Emit parse_error when both discriminators are present in the header (FR-017).
	if (bothDiscriminators && headerFamily === 'base_explorer') {
		parseErrorDetails.push({
			row_index: headerIndex,
			field: 'header',
			message:
				'Both format-family discriminators present; defaulting to base_explorer',
		});
	}

	const candidates: CandidateRecord[] = [];
	const idCounts = new Map<string, number>();
	const idFirstRows = new Map<string, number>();
	const formatFamiliesDetected = new Set<RowFormatFamily>();
	let malformedRows = 0;
	let currentCandidate: Partial<CandidateRecord> | null = null;
	let pendingClean:
		| { micro_lane: string; coverage_scope: string; evidence: string }
		| undefined;
	let cleanErrorCode: string | undefined;
	let cleanErrorMessage: string | undefined;

	for (let i = headerIndex + 1; i < lines.length; i++) {
		const rawLine = lines[i];
		const trimmed = rawLine.trim();

		// Skip blank lines — continuation is preserved across blank lines per FR-007.
		if (trimmed === '') continue;

		let fields = splitRow(trimmed);

		// A CLEAN sentinel is a distinct record, not a short continuation row.
		if (fields[0]?.trim() === '[CLEAN]') {
			const cleanFamily = flags.expected_family ?? headerFamily;
			const cleanFields = fields.map((field) => field.trim());
			// Out-of-scope family from a consolidated lane artifact: another
			// per-family call extracts it; this call skips it silently.
			if (
				cleanFamily === 'micro_lane' &&
				cleanFields.length === 4 &&
				flags.expected_micro_lane !== undefined &&
				cleanFields[1] !== flags.expected_micro_lane &&
				(flags.expected_micro_lanes ?? [flags.expected_micro_lane]).includes(
					cleanFields[1],
				)
			) {
				continue;
			}
			if (cleanFamily !== 'micro_lane') {
				cleanErrorCode = 'invalid-clean-attestation';
				cleanErrorMessage =
					'CLEAN attestation is valid only for micro_lane output';
			} else if (
				cleanFields.length !== 4 ||
				cleanFields.slice(1).some((field) => field.length === 0)
			) {
				cleanErrorCode = 'invalid-clean-attestation';
				cleanErrorMessage =
					'CLEAN attestation requires micro_lane, coverage_scope, and evidence';
			} else if (pendingClean !== undefined) {
				cleanErrorCode = 'invalid-clean-attestation';
				cleanErrorMessage =
					'Only one CLEAN attestation is allowed per artifact';
			} else if (flags.degraded || input.transcriptIncomplete === true) {
				cleanErrorCode = 'untrusted-clean-attestation';
				cleanErrorMessage =
					'CLEAN attestation cannot come from a degraded or partial artifact';
			} else if (
				flags.expected_micro_lane !== undefined &&
				cleanFields[1] !== flags.expected_micro_lane
			) {
				cleanErrorCode = 'expected-micro-lane-mismatch';
				cleanErrorMessage = `Expected CLEAN attestation for ${flags.expected_micro_lane}, received ${cleanFields[1]}`;
			} else {
				pendingClean = {
					micro_lane: cleanFields[1],
					coverage_scope: cleanFields[2],
					evidence: cleanFields[3],
				};
			}
			if (cleanErrorCode) {
				parseErrorDetails.push({
					row_index: i,
					field: 'clean_attestation',
					message: cleanErrorMessage ?? 'Invalid CLEAN attestation',
				});
				malformedRows++;
			}
			continue;
		}

		// Compatibility: older prompt text put the marker on every data row.
		if (fields[0]?.trim() === '[CANDIDATE]') {
			fields = fields.slice(1);
		}

		// Continuation line: fewer fields than the format family expects (FR-007).
		if (fields.length < EXPECTED_FIELD_COUNT) {
			if (currentCandidate) {
				const prev = currentCandidate.evidence_summary ?? '';
				currentCandidate.evidence_summary = `${prev}\n${trimmed}`;
			} else {
				// Continuation with no preceding candidate — malformed.
				malformedRows++;
			}
			continue;
		}

		// Complete row — take exactly the expected number of fields.
		const rowFields = fields.slice(0, EXPECTED_FIELD_COUNT);

		// Resolve family from the asserted batch, then the recognized header. Only
		// legacy/unknown-header callers use positional inference.
		let rowFamily: RowFormatFamily;
		if (flags.expected_family ?? headerFamily) {
			rowFamily = (flags.expected_family ?? headerFamily) as RowFormatFamily;
		} else {
			try {
				rowFamily = detectRowFormatFamily(rowFields);
			} catch (e) {
				if (e instanceof UnknownFormatFamilyError) {
					malformedRows++;
					continue;
				}
				throw e;
			}
		}

		// Emit parse_error when both discriminators are present on this row (FR-017).
		const rowHasImpact = rowFields[7].trim() !== '';
		const rowHasInvariant = rowFields[6].trim() !== '';
		if (
			rowHasImpact &&
			rowHasInvariant &&
			rowFamily === 'base_explorer' &&
			flags.expected_family === undefined &&
			headerFamily === undefined
		) {
			parseErrorDetails.push({
				row_index: i,
				field: 'row',
				message:
					'Both format-family discriminators present; defaulting to base_explorer',
			});
		}

		const mapped = mapFields(rowFields, rowFamily);
		if (
			rowFamily === 'micro_lane' &&
			flags.expected_micro_lane !== undefined &&
			mapped.micro_lane !== flags.expected_micro_lane
		) {
			// Owned-but-not-expected families in a consolidated lane artifact are
			// out of scope for this per-family call, not mismatches.
			if (
				mapped.micro_lane !== null &&
				(flags.expected_micro_lanes ?? [flags.expected_micro_lane]).includes(
					mapped.micro_lane,
				)
			) {
				continue;
			}
			parseErrorDetails.push({
				row_index: i,
				field: 'micro_lane',
				message: `Expected micro_lane ${flags.expected_micro_lane}, received ${mapped.micro_lane ?? '<missing>'}`,
			});
			malformedRows++;
			continue;
		}
		const requiredFields =
			rowFamily === 'base_explorer'
				? getRequiredFields('base_explorer')
				: getRequiredFields('micro_lane');

		// Required-field validation (FR-002).
		let rowMalformed = false;
		for (const field of requiredFields) {
			const value = mapped[field];
			if (field === 'candidate_id') {
				// Missing or empty candidate_id → malformed row (FR-005).
				if (value === null || value === '') {
					rowMalformed = true;
					break;
				}
			} else if (value === null) {
				// Missing non-ID required field → null + parse_error (row is valid).
				parseErrorDetails.push({
					row_index: i,
					field,
					message: `Missing required field: ${field}`,
				});
			}
		}

		if (rowMalformed) {
			malformedRows++;
			continue;
		}

		// Build the candidate record.
		// candidate_id is guaranteed non-null after the rowMalformed guard above;
		// assert to satisfy the type system without a type assertion.
		assertNonNullCandidateId(mapped.candidate_id);
		const candidateId: string = mapped.candidate_id;
		const candidate: CandidateRecord = {
			record_type: 'candidate',
			row_format_family: rowFamily,
			row_format_version: flags.row_format_version,
			record_version: RECORD_VERSION,
			source_output_ref: input.output_ref,
			source_batch_id: input.batchId,
			source_lane_id: input.laneId,
			source_agent: input.agent,
			source_digest: input.digest,
			sessionId: input.sessionId,
			parentSessionId: input.parentSessionId,
			producer: flags.producer,
			extracted_from_partial_source: !!(
				input.transcriptIncomplete || flags.degraded
			),
			candidate_id: candidateId,
			lane: mapped.lane,
			micro_lane: mapped.micro_lane,
			severity: mapped.severity,
			category: mapped.category,
			file_line: mapped.file_line,
			claim: mapped.claim,
			evidence_summary: mapped.evidence_summary,
			impact_context: mapped.impact_context,
			invariant_violated: mapped.invariant_violated,
			confidence: mapped.confidence,
		};

		// Track duplicate candidate_ids (FR-005).
		const cid = candidate.candidate_id;
		idCounts.set(cid, (idCounts.get(cid) ?? 0) + 1);
		if (!idFirstRows.has(cid)) {
			idFirstRows.set(cid, i);
		}

		formatFamiliesDetected.add(rowFamily);
		candidates.push(candidate);
		currentCandidate = candidate;
	}

	// Build duplicate-id warnings from counts.
	const duplicateIdWarnings: DuplicateIdWarning[] = [];
	let duplicateIdCount = 0;
	for (const [id, count] of idCounts) {
		if (count > 1) {
			duplicateIdCount++;
			duplicateIdWarnings.push({
				candidate_id: id,
				occurrences: count,
			});
			// Record each duplicate as a parse-error detail (SC-006).
			parseErrorDetails.push({
				row_index: idFirstRows.get(id) ?? -1,
				field: 'candidate_id',
				message: `Duplicate candidate_id: "${id}" appears ${count} times`,
			});
		}
	}

	if (pendingClean && candidates.length > 0) {
		cleanErrorCode = 'conflicting-clean-attestation';
		cleanErrorMessage = 'CLEAN attestation cannot appear with candidate rows';
		parseErrorDetails.push({
			row_index: headerIndex,
			field: 'clean_attestation',
			message: cleanErrorMessage,
		});
	}
	if (
		pendingClean &&
		!cleanErrorCode &&
		(malformedRows > 0 || parseErrorDetails.length > 0)
	) {
		cleanErrorCode = 'untrusted-clean-attestation';
		cleanErrorMessage =
			'CLEAN attestation requires zero malformed rows and zero parse errors';
		parseErrorDetails.push({
			row_index: headerIndex,
			field: 'clean_attestation',
			message: cleanErrorMessage,
		});
	}

	const cleanAttestation: CleanAttestationRecord | undefined =
		pendingClean && !cleanErrorCode && candidates.length === 0
			? {
					record_type: 'clean_attestation',
					row_format_family: 'micro_lane',
					row_format_version: flags.row_format_version,
					record_version: RECORD_VERSION,
					source_output_ref: input.output_ref,
					source_batch_id: input.batchId,
					source_lane_id: input.laneId,
					source_agent: input.agent,
					source_digest: input.digest,
					extracted_from_partial_source: false,
					sessionId: input.sessionId,
					parentSessionId: input.parentSessionId,
					producer: flags.producer,
					micro_lane: pendingClean.micro_lane,
					coverage_scope: pendingClean.coverage_scope,
					evidence: pendingClean.evidence,
				}
			: undefined;
	if (cleanAttestation) formatFamiliesDetected.add('micro_lane');

	const acceptedCandidates = cleanErrorCode ? [] : candidates;
	const parseErrors = parseErrorDetails.length;

	const envelope = buildInvocationEnvelope(
		input,
		flags,
		Array.from(formatFamiliesDetected),
		acceptedCandidates.length,
		parseErrors,
		malformedRows,
		cleanAttestation ? 1 : 0,
	);

	const diagnostics: DiagnosticsSummary = {
		candidate_count: acceptedCandidates.length,
		parse_errors: parseErrors,
		parse_error_details: parseErrorDetails,
		malformed_rows: malformedRows,
		duplicate_id_count: duplicateIdCount,
		duplicate_id_warnings: duplicateIdWarnings,
		degraded_source_count: flags.degraded ? 1 : 0,
		incomplete_source_count: input.transcriptIncomplete ? 1 : 0,
		format_families_detected: Array.from(formatFamiliesDetected),
		clean_attestation_count: cleanAttestation ? 1 : 0,
	};
	if (acceptedCandidates.length === 0 && !cleanAttestation) {
		const hint = detectFormatMismatchHint(input.text);
		if (hint) {
			diagnostics.format_mismatch_hint = hint;
		}
	}
	return {
		...(cleanErrorCode
			? {
					error: cleanErrorMessage ?? 'Invalid CLEAN attestation',
					error_code: cleanErrorCode,
				}
			: {}),
		candidates: acceptedCandidates,
		...(cleanAttestation ? { clean_attestation: cleanAttestation } : {}),
		invocation_envelope: envelope,
		diagnostics,
	};
}

// ---------------------------------------------------------------------------
// Sidecar persistence wrapper
// ---------------------------------------------------------------------------

/**
 * Parse candidates and append the invocation envelope + candidate records
 * to the sidecar JSONL file.
 *
 * parseCandidates remains pure (no I/O). This wrapper adds sidecar
 * persistence: on success the envelope + candidates are appended to
 * `.swarm/lane-results/{batchDigest}/candidates.jsonl`; on append
 * failure the parse still succeeds and sidecar_write_error is populated
 * (SC-023).
 *
 * batchDigest is derived as SHA-256(batchId) when not explicitly provided
 * in options (Option A — consistent with lane-output-store.ts internals).
 *
 * @param input   Structured artifact metadata and raw text.
 * @param flags   Caller-controlled acceptance flags and format version.
 * @param options Persistence options (projectRoot, optional batchDigest).
 * @returns       Parse result with optional sidecar_write_error field.
 */
export function parseAndPersist(
	input: ArtifactInput,
	flags: ParseFlags,
	options: ParsePersistOptions,
): ParseResultWithSidecar {
	const result = parseCandidates(input, flags);

	try {
		appendToSidecar(
			options,
			input.batchId,
			result.invocation_envelope,
			result.candidates,
			result.clean_attestation,
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			...result,
			sidecar_write_error: message,
		};
	}

	return result;
}
