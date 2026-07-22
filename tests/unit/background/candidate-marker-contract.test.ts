import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
	ArtifactInput,
	ParseFlags,
} from '../../../src/background/candidate-parser';
import { parseCandidates } from '../../../src/background/candidate-parser';

const PARSER_PATH = join(
	import.meta.dir,
	'../../../src/background/candidate-parser.ts',
);
const EXPLORER_PATH = join(import.meta.dir, '../../../src/agents/explorer.ts');
const DISPATCH_PATH = join(
	import.meta.dir,
	'../../../src/tools/dispatch-lanes.ts',
);

// ---------------------------------------------------------------------------
// Shared test helpers
// ---------------------------------------------------------------------------

function makeArtifactInput(text: string): ArtifactInput {
	return {
		output_ref: 'test-ref',
		batchId: 'test-batch',
		laneId: 'test-lane',
		agent: 'test-agent',
		role: 'generalist',
		digest: 'a'.repeat(64),
		text,
		artifact_status: 'ok',
		source: 'dispatch_lanes',
		produced_at: '2026-01-01T00:00:00Z',
	};
}

const defaultFlags: ParseFlags = {
	accept_partial: false,
	accept_degraded: false,
	degraded: false,
	row_format_version: 1,
};

describe('CANDIDATE marker contract (FR-007)', () => {
	// Read source files once per describe block
	const parserSrc = readFileSync(PARSER_PATH, 'utf-8');
	const explorerSrc = readFileSync(EXPLORER_PATH, 'utf-8');
	const dispatchSrc = readFileSync(DISPATCH_PATH, 'utf-8');

	// -------------------------------------------------------------------------
	// SC-018: [CANDIDATE] marker appears in parser, explorer prompt, and dispatch tool
	// -------------------------------------------------------------------------

	test('SC-018: CANDIDATE marker appears in parser', () => {
		expect(parserSrc).toContain('[CANDIDATE]');
	});

	test('SC-018: CANDIDATE marker appears in explorer prompt', () => {
		expect(explorerSrc).toContain('[CANDIDATE]');
	});

	test('SC-018: CANDIDATE marker appears in dispatch tool', () => {
		expect(dispatchSrc).toContain('[CANDIDATE]');
	});

	// -------------------------------------------------------------------------
	// SC-018: Marker mode consistency — header row bears marker
	// The convention is: header row has [CANDIDATE] prefix, data rows do NOT
	// (per explorer.ts line 113: "Emit the marker-bearing header, then exactly
	// one unprefixed data row per finding")
	// -------------------------------------------------------------------------

	test('explorer prompt instructs marker on header only, not on every data row', () => {
		// The explorer prompt at lines 110-111 says:
		// "Emit the marker-bearing header, then exactly one unprefixed data
		//  row per finding"
		// This pins the header-only marker convention — data rows are unprefixed.
		expect(explorerSrc).toContain('marker-bearing header');
		expect(explorerSrc).toContain('unprefixed data');
	});

	// -------------------------------------------------------------------------
	// SC-019: Parser and prompt agree on field structure
	// Parser expects exactly 9 fields per row (EXPECTED_FIELD_COUNT = 9)
	// Prompt instructs 9-pipe format for both base_explorer and micro_lane
	// -------------------------------------------------------------------------

	test('SC-019: parser defines EXPECTED_FIELD_COUNT = 9', () => {
		const match = parserSrc.match(/EXPECTED_FIELD_COUNT\s*=\s*(\d+)/);
		expect(match).not.toBeNull();
		expect(Number(match![1])).toBe(9);
	});

	test('SC-019: base_explorer prompt declares 9 pipe-delimited fields', () => {
		// explorer.ts line 113:
		// [CANDIDATE] | candidate_id | lane | severity | category |
		//   file:line | claim | evidence_summary | impact_context | confidence
		// Count the pipes: 9 pipes = 10 fields... but candidate_id is the marker
		// stripped before parsing, so the actual data fields = 9
		const baseExplorerLine = explorerSrc
			.split('\n')
			.find((l) => l.includes('candidate_id') && l.includes('impact_context'));
		expect(baseExplorerLine).toBeDefined();
		const pipeCount = (baseExplorerLine!.match(/\|/g) || []).length;
		// 9 pipes in the data row format (after [CANDIDATE] marker is stripped)
		expect(pipeCount).toBe(9);
	});

	test('SC-019: micro_lane prompt declares 9 pipe-delimited fields', () => {
		// explorer.ts line 136:
		// [CANDIDATE] | candidate_id | micro_lane | severity | category |
		//   file:line | claim | invariant_violated | evidence_summary | confidence
		const microLaneLine = explorerSrc
			.split('\n')
			.find(
				(l) => l.includes('candidate_id') && l.includes('invariant_violated'),
			);
		expect(microLaneLine).toBeDefined();
		const pipeCount = (microLaneLine!.match(/\|/g) || []).length;
		// 9 pipes in the data row format
		expect(pipeCount).toBe(9);
	});

	test('SC-019: dispatch tool declares same 9-pipe formats as explorer prompt', () => {
		// dispatch-lanes.ts lines 51 and 54 declare the same formats
		const dispatchLines = dispatchSrc
			.split('\n')
			.filter((l) => l.includes('[CANDIDATE]') && l.includes('candidate_id'));
		expect(dispatchLines.length).toBeGreaterThanOrEqual(2);

		// Both format lines should have 9 pipes
		for (const line of dispatchLines) {
			const pipeCount = (line.match(/\|/g) || []).length;
			expect(pipeCount).toBe(9);
		}
	});

	// -------------------------------------------------------------------------
	// SC-019: Parser strips [CANDIDATE] from data rows (compatibility mode)
	// Line 727-729: if row starts with [CANDIDATE], slice it off before processing
	// This means BOTH header-only and per-row-marker modes are supported
	// -------------------------------------------------------------------------

	test('parser handles per-row [CANDIDATE] prefix by stripping it', () => {
		// Line 727-729 in candidate-parser.ts shows the compatibility strip
		expect(parserSrc).toContain("fields[0]?.trim() === '[CANDIDATE]'");
		expect(parserSrc).toContain('fields = fields.slice(1)');
	});

	// -------------------------------------------------------------------------
	// SC-019: Field order consistency between format families
	// base_explorer uses impact_context (pos 7), micro_lane uses invariant_violated (pos 6)
	// These discriminators allow the parser to detect format family per-row
	// -------------------------------------------------------------------------

	test('base_explorer uses impact_context as family discriminator', () => {
		expect(parserSrc).toContain('BASE_EXPLORER_DISCRIMINATOR');
		expect(parserSrc).toContain('impact_context');
	});

	test('micro_lane uses invariant_violated as family discriminator', () => {
		expect(parserSrc).toContain('MICRO_LANE_DISCRIMINATOR');
		expect(parserSrc).toContain('invariant_violated');
	});

	test('explorer prompt distinguishes base_explorer and micro_lane by discriminator field', () => {
		// explorer.ts line 113 uses impact_context for standard explorer
		// explorer.ts line 136 uses invariant_violated for micro-lane
		expect(explorerSrc).toContain('impact_context');
		expect(explorerSrc).toContain('invariant_violated');
	});

	// -------------------------------------------------------------------------
	// SC-019: CLEAN marker for empty micro-lane results
	// -------------------------------------------------------------------------

	test('parser recognizes [CLEAN] sentinel for empty micro-lane attestation', () => {
		expect(parserSrc).toContain('[CLEAN]');
	});

	test('explorer prompt documents [CLEAN] sentinel for zero-issue micro-lane', () => {
		expect(explorerSrc).toContain('[CLEAN]');
	});

	test('dispatch tool documents [CLEAN] sentinel for zero-issue micro-lane', () => {
		expect(dispatchSrc).toContain('[CLEAN]');
	});

	// =========================================================================
	// SC-018/SC-019 behavioral: parseCandidates exercises the real parser
	// =========================================================================

	describe('SC-018 behavioral: parseCandidates extracts valid base_explorer row', () => {
		test('returns one candidate with all fields matching input row', () => {
			const text = [
				'[CANDIDATE] | candidate_id | lane | severity | category | file:line | claim | evidence_summary | impact_context | confidence',
				'C-001 | test-lane | LOW | async-ordering | src/utils/test.ts:42 | example claim | observed evidence | affects cache layer | MEDIUM',
			].join('\n');

			const input = makeArtifactInput(text);
			const result = parseCandidates(input, defaultFlags);

			expect(result.candidates).toHaveLength(1);
			const c = result.candidates[0];
			expect(c.candidate_id).toBe('C-001');
			expect(c.lane).toBe('test-lane');
			expect(c.severity).toBe('LOW');
			expect(c.category).toBe('async-ordering');
			expect(c.file_line).toBe('src/utils/test.ts:42');
			expect(c.claim).toBe('example claim');
			expect(c.evidence_summary).toBe('observed evidence');
			expect(c.impact_context).toBe('affects cache layer');
			expect(c.confidence).toBe('MEDIUM');
			expect(c.row_format_family).toBe('base_explorer');
			expect(result.diagnostics.candidate_count).toBe(1);
			expect(result.diagnostics.parse_errors).toBe(0);
			expect(result.diagnostics.malformed_rows).toBe(0);
		});

		test('returns one candidate with all fields matching input row (micro_lane format)', () => {
			const text = [
				'[CANDIDATE] | candidate_id | micro_lane | severity | category | file:line | claim | invariant_violated | evidence_summary | confidence',
				'C-002 | invariant-check | HIGH | null-safety | src/core/parser.ts:88 | possible null | NON_NULL_INVARIANT | observed null access | HIGH',
			].join('\n');

			const input = makeArtifactInput(text);
			const result = parseCandidates(input, defaultFlags);

			expect(result.candidates).toHaveLength(1);
			const c = result.candidates[0];
			expect(c.candidate_id).toBe('C-002');
			expect(c.micro_lane).toBe('invariant-check');
			expect(c.severity).toBe('HIGH');
			expect(c.category).toBe('null-safety');
			expect(c.file_line).toBe('src/core/parser.ts:88');
			expect(c.claim).toBe('possible null');
			expect(c.invariant_violated).toBe('NON_NULL_INVARIANT');
			expect(c.evidence_summary).toBe('observed null access');
			expect(c.confidence).toBe('HIGH');
			expect(c.row_format_family).toBe('micro_lane');
			expect(result.diagnostics.candidate_count).toBe(1);
			expect(result.diagnostics.parse_errors).toBe(0);
			expect(result.diagnostics.malformed_rows).toBe(0);
		});
	});

	describe('SC-019 behavioral: parseCandidates rejects malformed rows', () => {
		test('wrong number of fields yields 0 candidates and malformed_rows > 0', () => {
			// Only 3 fields instead of the expected 9
			const text = [
				'[CANDIDATE] | candidate_id | lane | severity | category | file:line | claim | evidence_summary | impact_context | confidence',
				'C-001 | test-lane | LOW',
			].join('\n');

			const input = makeArtifactInput(text);
			const result = parseCandidates(input, defaultFlags);

			// A row with fewer fields than EXPECTED_FIELD_COUNT that cannot be a
			// continuation (no preceding candidate) increments malformedRows.
			expect(result.diagnostics.malformed_rows).toBe(1);
			expect(result.candidates).toHaveLength(0);
		});

		test('missing candidate_id yields 0 candidates (FR-005)', () => {
			const text = [
				'[CANDIDATE] | candidate_id | lane | severity | category | file:line | claim | evidence_summary | impact_context | confidence',
				' | test-lane | LOW | async-ordering | src/utils/test.ts:42 | example claim | observed evidence | affects cache layer | MEDIUM',
			].join('\n');

			const input = makeArtifactInput(text);
			const result = parseCandidates(input, defaultFlags);

			// Empty candidate_id is treated as malformed row (FR-005)
			expect(result.candidates).toHaveLength(0);
			expect(result.diagnostics.malformed_rows).toBeGreaterThan(0);
		});

		test('empty text yields 0 candidates and no errors', () => {
			const input = makeArtifactInput('');
			const result = parseCandidates(input, defaultFlags);

			expect(result.candidates).toHaveLength(0);
			expect(result.diagnostics.candidate_count).toBe(0);
			expect(result.diagnostics.parse_errors).toBe(0);
			expect(result.diagnostics.malformed_rows).toBe(0);
		});

		test('artifact_status ref-not-found returns refusal result', () => {
			const text = [
				'[CANDIDATE] | candidate_id | lane | severity | category | file:line | claim | evidence_summary | impact_context | confidence',
				'C-001 | test-lane | LOW | async-ordering | src/utils/test.ts:42 | example claim | observed evidence | affects cache layer | MEDIUM',
			].join('\n');

			const input: ArtifactInput = {
				...makeArtifactInput(text),
				artifact_status: 'ref-not-found',
			};
			const result = parseCandidates(input, defaultFlags);

			expect(result.candidates).toHaveLength(0);
			expect(result.error_code).toBe('ref-not-found');
		});

		test('transcriptIncomplete without accept_partial returns refusal result', () => {
			const text = [
				'[CANDIDATE] | candidate_id | lane | severity | category | file:line | claim | evidence_summary | impact_context | confidence',
				'C-001 | test-lane | LOW | async-ordering | src/utils/test.ts:42 | example claim | observed evidence | affects cache layer | MEDIUM',
			].join('\n');

			const input: ArtifactInput = {
				...makeArtifactInput(text),
				transcriptIncomplete: true,
			};
			const result = parseCandidates(input, defaultFlags);

			expect(result.candidates).toHaveLength(0);
			expect(result.error_code).toBe('partial-source-refused');
		});
	});

	describe('SC-019 behavioral: per-row [CANDIDATE] prefix is stripped (backward compat)', () => {
		test('parser strips [CANDIDATE] from data rows and parses correctly', () => {
			// Older prompt variants put [CANDIDATE] on every data row.
			// The parser strips this at line 727-729 for backward compatibility.
			const text = [
				'[CANDIDATE] | candidate_id | lane | severity | category | file:line | claim | evidence_summary | impact_context | confidence',
				'[CANDIDATE] | C-001 | test-lane | LOW | async-ordering | src/utils/test.ts:42 | example claim | observed evidence | affects cache layer | MEDIUM',
			].join('\n');

			const input = makeArtifactInput(text);
			const result = parseCandidates(input, defaultFlags);

			expect(result.candidates).toHaveLength(1);
			expect(result.candidates[0].candidate_id).toBe('C-001');
			expect(result.diagnostics.parse_errors).toBe(0);
		});
	});

	describe('consolidated depth-tier lane artifacts (per-family extraction)', () => {
		const consolidatedFlags: ParseFlags = {
			...defaultFlags,
			expected_family: 'micro_lane',
			expected_micro_lane: 'auth-identity-secrets',
			expected_micro_lanes: ['auth-identity-secrets', 'subprocess-platform'],
		};

		test('extracts only the expected family; owned sibling rows skip without errors', () => {
			const text = [
				'[CANDIDATE] | candidate_id | micro_lane | severity | category | file:line | claim | invariant_violated | evidence_summary | confidence',
				'C-AUTH-1 | auth-identity-secrets | HIGH | secrets | src/auth.ts:10 | leaked token | LEAST_PRIVILEGE | token in log output | HIGH',
				'C-SUB-1 | subprocess-platform | MEDIUM | shell | src/run.ts:20 | unbounded exec | BOUNDED_EXECUTION | no timeout on spawn | MEDIUM',
			].join('\n');

			const result = parseCandidates(
				makeArtifactInput(text),
				consolidatedFlags,
			);
			expect(result.candidates).toHaveLength(1);
			expect(result.candidates[0].candidate_id).toBe('C-AUTH-1');
			expect(result.diagnostics.parse_errors).toBe(0);
			expect(result.diagnostics.malformed_rows).toBe(0);
		});

		test('accepts a CLEAN for the expected family alongside sibling-family candidates', () => {
			const text = [
				'[CANDIDATE] | candidate_id | micro_lane | severity | category | file:line | claim | invariant_violated | evidence_summary | confidence',
				'C-SUB-1 | subprocess-platform | MEDIUM | shell | src/run.ts:20 | unbounded exec | BOUNDED_EXECUTION | no timeout on spawn | MEDIUM',
				'[CLEAN] | auth-identity-secrets | exact reviewed diff | no candidate survived the focused review',
			].join('\n');

			const result = parseCandidates(
				makeArtifactInput(text),
				consolidatedFlags,
			);
			expect(result.candidates).toHaveLength(0);
			expect(result.clean_attestation?.micro_lane).toBe(
				'auth-identity-secrets',
			);
			expect(result.diagnostics.parse_errors).toBe(0);
			expect(result.diagnostics.malformed_rows).toBe(0);
		});

		test('sibling-family CLEAN rows skip so each per-family call sees one attestation', () => {
			const text = [
				'[CANDIDATE] | candidate_id | micro_lane | severity | category | file:line | claim | invariant_violated | evidence_summary | confidence',
				'[CLEAN] | auth-identity-secrets | exact reviewed diff | no candidate survived the focused review',
				'[CLEAN] | subprocess-platform | exact reviewed diff | no candidate survived the focused review',
			].join('\n');

			const result = parseCandidates(
				makeArtifactInput(text),
				consolidatedFlags,
			);
			expect(result.clean_attestation?.micro_lane).toBe(
				'auth-identity-secrets',
			);
			expect(result.diagnostics.parse_errors).toBe(0);
			expect(result.diagnostics.malformed_rows).toBe(0);
		});

		test('families outside the owned set are still refused as mismatches', () => {
			const text = [
				'[CANDIDATE] | candidate_id | micro_lane | severity | category | file:line | claim | invariant_violated | evidence_summary | confidence',
				'C-UI-1 | ui-accessibility-i18n | LOW | focus | src/ui.ts:5 | focus trap | KEYBOARD_ACCESS | tab order breaks | LOW',
			].join('\n');

			const result = parseCandidates(
				makeArtifactInput(text),
				consolidatedFlags,
			);
			expect(result.candidates).toHaveLength(0);
			expect(result.diagnostics.malformed_rows).toBe(1);
			expect(
				result.diagnostics.parse_error_details.some((detail) =>
					detail.message.includes('Expected micro_lane'),
				),
			).toBe(true);
		});
	});
});
