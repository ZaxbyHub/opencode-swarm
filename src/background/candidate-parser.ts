import { z } from 'zod';
import {
	analyzeCandidateFields,
	analyzeCandidateLaneContext,
	analyzeCleanFields,
	CANDIDATE_FIELD_COUNT,
	CANDIDATE_FIELDS,
	type CandidateArtifactRepairKind,
	type CandidateConfidence,
	type CandidateSeverity,
	candidateDiagnosticPreview,
	isCandidateLookingShortRow,
	normalizeCandidateArtifact,
	type RowFormatFamily,
	removeCandidateCodeFences,
	type CleanAttestationRecord as SharedCleanAttestationRecord,
	selectCandidateHeader,
	splitPipeFields,
} from './candidate-contract';
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
		expected_lane: z.string().trim().min(1).max(120).optional(),
		expected_lanes: z
			.array(z.string().trim().min(1).max(120))
			.min(1)
			.max(11)
			.optional(),
		expected_micro_lane: z.string().trim().min(1).max(120).optional(),
		/**
		 * Full owned family set of a consolidated (depth-tiered) lane artifact.
		 * Rows and CLEAN attestations for owned-but-not-expected families are
		 * skipped as out-of-scope for this per-family call instead of counting
		 * as mismatches; families outside this set still fail. Defaults to
		 * [expected_micro_lane].
		 */
		expected_micro_lanes: z
			.array(z.string().trim().min(1).max(120))
			.min(1)
			.max(11)
			.optional(),
	})
	.strict()
	.superRefine((value, context) => {
		for (const issue of analyzeCandidateLaneContext(value)) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: [issue.field],
				message: issue.message,
			});
		}
	});

export type ArtifactInput = z.infer<typeof ArtifactInputSchema>;
export type ParseFlags = z.infer<typeof ParseFlagsSchema>;

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

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
	severity: CandidateSeverity | null;
	category: string | null;
	file_line: string | null;
	claim: string | null;
	evidence_summary: string | null;
	impact_context: string | null;
	invariant_violated: string | null;
	confidence: CandidateConfidence | null;
}

/** A machine-readable attestation that a complete lane found no candidates. */
export type CleanAttestationRecord = SharedCleanAttestationRecord;

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
	/**
	 * The artifact carried a `[CLEAN]` attestation that had to be discredited,
	 * but the artifact itself is still valid and its candidate rows were retained.
	 * The parse SUCCEEDS: `error`/`error_code` are absent. Mutually exclusive with
	 * `error_code` by construction (issue #2279).
	 *
	 * Callers must not read this as coverage: `clean_attestation` is `undefined`
	 * whenever this is set, so a lane with zero candidate rows still fails
	 * coverage exactly as before.
	 */
	clean_attestation_salvaged?: boolean;
	/** Human-readable reason a salvaged attestation was discredited. */
	clean_attestation_salvage_reason?: string;
	/**
	 * Structural repairs applied by `normalizeCandidateArtifact` before the strict
	 * parse. Present only on the `parseAndPersist` path, which is the one that
	 * normalizes; disclosed so the tool receipt reports a repaired artifact
	 * instead of silently presenting it as pristine.
	 */
	repair_kinds?: CandidateArtifactRepairKind[];
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

const RECORD_VERSION = { major: 1, minor: 1 };

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

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
	const names = CANDIDATE_FIELDS[family];
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
	return CANDIDATE_FIELDS[family];
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
	const cleanedText = removeCandidateCodeFences(input.text);
	const lines = cleanedText.split('\n');

	// Locate the explicit candidate frame, with markerless positional fallback.
	const header = selectCandidateHeader(lines);
	if (header === null) {
		// No header found — nothing to parse.
		return emptyTextResult(input, flags);
	}
	const headerIndex = header.lineIndex;

	// Marker-bearing candidate output has one exact shared header contract. A
	// markerless unknown header keeps the historical positional fallback, but a
	// malformed marker header (including a lone marker-prefixed data row) fails
	// closed instead of being skipped as if it were trustworthy metadata.
	const headerFamily = header.family ?? undefined;
	if (header.markerBearing && headerFamily === undefined) {
		return refusalResult(
			'invalid-candidate-header',
			'Candidate output must begin with one exact canonical base or micro [CANDIDATE] header',
			input,
			flags,
		);
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

	const parseErrorDetails: ParseErrorDetail[] = [];

	const candidates: CandidateRecord[] = [];
	const idCounts = new Map<string, number>();
	const idFirstRows = new Map<string, number>();
	const formatFamiliesDetected = new Set<RowFormatFamily>();
	let malformedRows = 0;
	let currentCandidate: Partial<CandidateRecord> | null = null;
	let pendingClean: SharedCleanAttestationRecord | undefined;
	let cleanErrorCode: string | undefined;
	let cleanErrorMessage: string | undefined;
	/**
	 * Set when the CLEAN attestation is discredited but the artifact as a whole
	 * is still valid — the attestation is dropped, the independently-validated
	 * candidate rows are kept, and NO top-level error is emitted (issue #2279).
	 * Distinct from `cleanErrorCode`, which additionally fails the parse.
	 */
	let cleanSalvageReason: string | undefined;

	for (let i = headerIndex + 1; i < lines.length; i++) {
		const rawLine = lines[i];
		const trimmed = rawLine.trim();

		// Skip blank lines — continuation is preserved across blank lines per FR-007.
		if (trimmed === '') continue;

		let fields = splitPipeFields(trimmed);

		// A CLEAN sentinel is a distinct record, not a short continuation row.
		if (fields[0]?.trim() === '[CLEAN]') {
			const cleanFamily = flags.expected_family ?? headerFamily;
			const cleanFields = fields.map((field) => field.trim());
			const cleanLane =
				cleanFamily === 'micro_lane'
					? flags.expected_micro_lane
					: flags.expected_lane;
			const cleanLanes =
				cleanFamily === 'micro_lane'
					? (flags.expected_micro_lanes ??
						(flags.expected_micro_lane
							? [flags.expected_micro_lane]
							: undefined))
					: (flags.expected_lanes ??
						(flags.expected_lane ? [flags.expected_lane] : undefined));
			// Out-of-scope family from a consolidated lane artifact: another
			// per-family call extracts it; this call skips it silently.
			if (
				cleanFamily !== undefined &&
				cleanFields.length === 4 &&
				cleanLane !== undefined &&
				cleanFields[1] !== cleanLane &&
				(cleanLanes ?? [cleanLane]).includes(cleanFields[1])
			) {
				continue;
			}
			const cleanAnalysis = cleanFamily
				? analyzeCleanFields(cleanFields, cleanFamily, cleanLane)
				: undefined;
			// A consolidated lane may emit one [CLEAN] attestation per owned lane.
			// Scoped (expected-lane) callers never reach this branch for a sibling
			// lane's row — the out-of-scope skip above already handled it — because
			// analyzeCleanFields marks any non-expected lane invalid. This branch
			// covers UNSCOPED parses (no expected_lane flags), where every lane's
			// row validates: the artifact's singular attestation slot is already
			// filled by a DIFFERENT lane's valid attestation, so the later row is
			// skipped instead of failing the whole artifact. A duplicate
			// attestation for the SAME lane still falls through and errors below.
			if (
				pendingClean !== undefined &&
				cleanAnalysis?.valid === true &&
				// analyzeCleanFields marks a null lane invalid, so a valid
				// analysis always carries one.
				cleanAnalysis.lane !==
					(pendingClean.row_format_family === 'base_explorer'
						? pendingClean.lane
						: pendingClean.micro_lane)
			) {
				continue;
			}
			if (pendingClean !== undefined) {
				cleanErrorCode = 'invalid-clean-attestation';
				cleanErrorMessage =
					'Only one CLEAN attestation is allowed per artifact';
			} else if (!cleanFamily || !cleanAnalysis) {
				cleanErrorCode = 'invalid-clean-attestation';
				cleanErrorMessage =
					'CLEAN attestation is valid only for base_explorer or micro_lane output';
			} else if (!cleanAnalysis.valid) {
				cleanErrorCode = cleanAnalysis.issues.some((issue) =>
					['lane', 'micro_lane'].includes(issue.field),
				)
					? cleanFamily === 'base_explorer'
						? 'expected-lane-mismatch'
						: 'expected-micro-lane-mismatch'
					: 'invalid-clean-attestation';
				cleanErrorMessage = cleanAnalysis.issues
					.map((issue) => `${issue.field}: ${issue.message}`)
					.join('; ');
			} else if (cleanFamily === 'base_explorer') {
				pendingClean = {
					record_type: 'clean_attestation',
					row_format_family: 'base_explorer',
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
					lane: cleanAnalysis.lane!,
					coverage_scope: cleanAnalysis.coverageScope!,
					evidence: cleanAnalysis.evidence!,
				};
			} else {
				pendingClean = {
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
					micro_lane: cleanAnalysis.lane!,
					coverage_scope: cleanAnalysis.coverageScope!,
					evidence: cleanAnalysis.evidence!,
				};
			}
			if (cleanErrorCode) {
				parseErrorDetails.push({
					row_index: i,
					field: 'clean_attestation',
					message: cleanErrorMessage ?? 'Invalid CLEAN attestation',
				});
				malformedRows++;
				continue;
			}
			if (flags.degraded || input.transcriptIncomplete === true) {
				cleanErrorCode = 'untrusted-clean-attestation';
				cleanErrorMessage =
					'CLEAN attestation cannot come from a degraded or partial artifact';
				parseErrorDetails.push({
					row_index: i,
					field: 'clean_attestation',
					message: cleanErrorMessage,
				});
				malformedRows++;
				continue;
			}
			continue;
		}

		// Compatibility: older prompt text put the marker on every data row.
		const hadCandidateMarker = fields[0]?.trim() === '[CANDIDATE]';
		if (hadCandidateMarker) {
			fields = fields.slice(1);
		}

		// Continuation line: fewer fields than the format family expects (FR-007).
		if (fields.length < CANDIDATE_FIELD_COUNT) {
			if (isCandidateLookingShortRow(fields, flags, hadCandidateMarker)) {
				parseErrorDetails.push({
					row_index: i,
					field: 'row',
					message:
						'Structurally short [CANDIDATE] row must be a full candidate or CLEAN attestation, not continuation text',
				});
				malformedRows++;
				continue;
			}
			if (currentCandidate) {
				const prev = currentCandidate.evidence_summary ?? '';
				currentCandidate.evidence_summary = `${prev}\n${trimmed}`;
			} else {
				// Continuation with no preceding candidate — malformed.
				malformedRows++;
			}
			continue;
		}

		// Map the canonical positions; semantic validation below still receives the
		// complete field list so trailing fields fail the exact-nine-field contract.
		const rowFields = fields.slice(0, CANDIDATE_FIELD_COUNT);

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
			rowFamily === 'base_explorer' &&
			flags.expected_lane !== undefined &&
			mapped.lane !== flags.expected_lane
		) {
			if (
				mapped.lane !== null &&
				(flags.expected_lanes ?? [flags.expected_lane]).includes(mapped.lane)
			) {
				continue;
			}
			parseErrorDetails.push({
				row_index: i,
				field: 'lane',
				message: `Expected lane ${candidateDiagnosticPreview(flags.expected_lane)}, received ${candidateDiagnosticPreview(mapped.lane ?? '<missing>')}`,
			});
			malformedRows++;
			continue;
		}
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
				message: `Expected micro_lane ${candidateDiagnosticPreview(flags.expected_micro_lane)}, received ${candidateDiagnosticPreview(mapped.micro_lane ?? '<missing>')}`,
			});
			malformedRows++;
			continue;
		}
		const semanticAnalysis = analyzeCandidateFields(fields, rowFamily);
		if (!semanticAnalysis.valid) {
			for (const issue of semanticAnalysis.issues) {
				parseErrorDetails.push({
					row_index: i,
					field: issue.field,
					message: issue.message,
				});
			}
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
			severity: mapped.severity as CandidateSeverity,
			category: mapped.category,
			file_line: mapped.file_line,
			claim: mapped.claim,
			evidence_summary: mapped.evidence_summary,
			impact_context: mapped.impact_context,
			invariant_violated: mapped.invariant_violated,
			confidence: mapped.confidence as CandidateConfidence,
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
				candidate_id: candidateDiagnosticPreview(id),
				occurrences: count,
			});
			// Record each duplicate as a parse-error detail (SC-006).
			parseErrorDetails.push({
				row_index: idFirstRows.get(id) ?? -1,
				field: 'candidate_id',
				message: `Duplicate candidate_id: "${candidateDiagnosticPreview(id)}" appears ${count} times`,
			});
		}
	}

	// Per-obligation conflict (the #2131 prompt contract): a [CLEAN] attestation
	// contradicts [CANDIDATE] rows only for the SAME lane. Candidates for other
	// lanes of a consolidated artifact are legitimate siblings and must not void
	// this lane's zero-findings attestation.
	const pendingCleanLane = pendingClean
		? pendingClean.row_format_family === 'base_explorer'
			? pendingClean.lane
			: pendingClean.micro_lane
		: null;
	// Guarded on `!cleanErrorCode`: a CLEAN that already hard-failed (degraded or
	// partial source, duplicate attestation, lane mismatch) must NOT be
	// re-labelled as a benign salvage. Without this guard a degraded artifact
	// carrying a same-lane candidate would report a hard error and a salvage
	// disclosure at once, and the gate would write a durable salvage record for a
	// parse that failed (issue #2279 plan-critic BL1).
	if (pendingClean && pendingCleanLane !== null && !cleanErrorCode) {
		const conflictingCandidate = candidates.find(
			(candidate) =>
				(candidate.lane ?? candidate.micro_lane) === pendingCleanLane,
		);
		if (conflictingCandidate) {
			// Salvage, not error: the candidate rows beside this attestation were
			// each independently validated, so the artifact still carries real
			// findings. Only the attestation is discredited. Deliberately NOT
			// pushed to `parseErrorDetails` — doing so would re-trip the
			// zero-parse-errors rule immediately below and restore the hard error
			// through the back door.
			cleanSalvageReason = `CLEAN attestation discredited: it cannot appear with candidate rows for the same lane (${pendingCleanLane}); the candidate rows were retained`;
		}
	}
	if (
		pendingClean &&
		!cleanErrorCode &&
		!cleanSalvageReason &&
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

	// `!cleanErrorCode` already encodes "no same-lane candidate conflict" (set
	// above), so candidates for OTHER lanes of a consolidated artifact no longer
	// suppress this lane's zero-findings attestation.
	// COVERAGE SAFETY: a salvaged attestation is discredited exactly as hard as an
	// errored one. Downgrading the top-level error must never let a discredited
	// CLEAN count as a lane's zero-findings coverage, so both flags gate this.
	const cleanAttestation: CleanAttestationRecord | undefined =
		pendingClean && !cleanErrorCode && !cleanSalvageReason
			? pendingClean
			: undefined;
	if (cleanAttestation) {
		formatFamiliesDetected.add(cleanAttestation.row_format_family);
	}

	// A defective CLEAN attestation discredits the attestation, never the
	// candidate rows: every candidate here was independently validated by
	// analyzeCandidateFields. Discarding them made one malformed trailing row
	// destroy an entire lane's findings. The attestation itself stays gated
	// above on `!cleanErrorCode`; the only candidate-related rejection is the
	// per-obligation same-lane conflict, scoped per the #2131 prompt contract.
	const acceptedCandidates = candidates;
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
		// Only ever set when the parse did NOT hard-fail: `cleanSalvageReason` is
		// assigned under a `!cleanErrorCode` guard, so the two are mutually
		// exclusive and a receipt can never advertise both.
		...(cleanSalvageReason
			? {
					clean_attestation_salvaged: true,
					clean_attestation_salvage_reason: cleanSalvageReason,
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
	// Normalize at this tool boundary for the same reason the PR-review gate does:
	// otherwise an artifact the gate accepts as covered could still be refused
	// here, leaving the caller unable to retrieve findings from a lane that had
	// already been credited. Scope note: it is specifically HEADER REPAIR that stays
	// boundary-only — parseCandidates itself never synthesizes a header, so the two
	// boundaries that consume artifacts on a caller's behalf agree while the pure
	// parser does not silently rewrite input. Candidate acceptance is a separate
	// question and DID change for every consumer: a defective [CLEAN] no longer
	// discards independently validated candidate rows (see acceptedCandidates).
	const normalized = flags.expected_family
		? normalizeCandidateArtifact(input.text, flags.expected_family)
		: undefined;
	const normalizedInput = normalized
		? { ...input, text: normalized.text }
		: input;
	// Disclose the repairs rather than discarding them. This receipt is the only
	// anomaly signal the `parse_lane_candidates` caller sees, so an artifact that
	// had to be structurally repaired must not read as pristine (issue #2279).
	const repairKinds: CandidateArtifactRepairKind[] = normalized
		? normalized.repairKinds
		: [];
	const parsed = parseCandidates(normalizedInput, flags);
	const result: ParseResult =
		repairKinds.length > 0 ? { ...parsed, repair_kinds: repairKinds } : parsed;

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
