import { afterEach, describe, expect, mock, test } from 'bun:test';
import { createHash } from 'node:crypto';
import fs, * as realFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
	ArtifactInput,
	ParseFlags,
	ParseResult,
	ParseResultWithSidecar,
} from '../../../src/background/candidate-parser';
import {
	parseAndPersist,
	parseCandidates,
} from '../../../src/background/candidate-parser';
import {
	appendToSidecar,
	sanitizeString,
} from '../../../src/background/candidate-sidecar-store';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Tracked temp directories for afterEach cleanup. */
const tmpDirs: string[] = [];

/** Create a resolved temp directory under os.tmpdir() and register for cleanup. */
function makeTempDir(): string {
	const dir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-store-')),
	);
	tmpDirs.push(dir);
	return dir;
}

/** SHA-256 hex of a string (same algorithm as candidate-sidecar-store). */
function sha256(value: string): string {
	return createHash('sha256').update(value).digest('hex');
}

/** Read the entire content of a file, or null if it doesn't exist. */
function readSidecar(projectRoot: string, batchDigest: string): string | null {
	const filePath = path.join(
		projectRoot,
		'.swarm',
		'lane-results',
		batchDigest,
		'candidates.jsonl',
	);
	try {
		return fs.readFileSync(filePath, 'utf-8');
	} catch {
		return null;
	}
}

/** Parse a JSONL string into an array of records. */
function parseJsonl(content: string): unknown[] {
	return content
		.split('\n')
		.filter((line) => line.trim() !== '')
		.map((line) => JSON.parse(line));
}

/** Shortcut to build a minimal base input for parseCandidates. */
const BASE_INPUT: ArtifactInput = {
	output_ref: 'L1:abc123:def456:ghi789',
	batchId: 'batch-1',
	laneId: 'lane-1',
	agent: 'mega_explorer',
	role: 'explorer',
	sessionId: 'session-abc',
	parentSessionId: 'parent-xyz',
	digest: 'a'.repeat(64),
	text: '',
	artifact_status: 'ok',
	source: 'dispatch_lanes',
	produced_at: '2024-01-01T00:00:00.000Z',
};

const BASE_FLAGS: ParseFlags = {
	accept_partial: false,
	accept_degraded: false,
	degraded: false,
	row_format_version: 1,
};

const BASE_EXPLORER_HEADER =
	'[CANDIDATE] | candidate_id | lane | severity | category | file:line | claim | evidence_summary | impact_context | confidence';

function beRow(
	c1: string,
	c2 = 'lane-A',
	c3 = 'HIGH',
	c4 = 'security',
	c5 = 'src/foo.ts:10',
	c6 = 'claim1',
	c7 = 'evidence1',
	c8 = 'impact1',
	c9 = '0.9',
): string {
	return [c1, c2, c3, c4, c5, c6, c7, c8, c9].join(' | ');
}

function buildBeText(rows: string[]): string {
	return [BASE_EXPLORER_HEADER, ...rows].join('\n');
}

// ---------------------------------------------------------------------------
// Temp directory cleanup
// ---------------------------------------------------------------------------

afterEach(() => {
	for (const dir of tmpDirs) {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			// best-effort cleanup; ignore failures on Windows due to file locks
		}
	}
	tmpDirs.length = 0;
});

// ---------------------------------------------------------------------------
// SC-015 — Invocation envelope is FIRST record in append batch
// ---------------------------------------------------------------------------

describe('SC-015 — invocation envelope is first record in sidecar append', () => {
	test('single candidate → sidecar has envelope as first line, candidate as second', () => {
		const dir = makeTempDir();
		const batchId = 'batch-sc015';
		const digest = sha256(batchId);
		const input: ArtifactInput = {
			...BASE_INPUT,
			batchId,
			text: buildBeText([beRow('c1')]),
		};

		const result = parseAndPersist(input, BASE_FLAGS, { projectRoot: dir });
		expect(result.error_code).toBeUndefined();
		expect(result.candidates.length).toBe(1);

		const content = readSidecar(dir, digest);
		expect(content).not.toBeNull();
		const records = parseJsonl(content!);
		expect(records.length).toBe(2);
		expect((records[0] as Record<string, unknown>).record_type).toBe(
			'invocation',
		);
		expect((records[1] as Record<string, unknown>).record_type).toBe(
			'candidate',
		);
	});

	test('zero candidates → sidecar has only the envelope', () => {
		const dir = makeTempDir();
		const batchId = 'batch-sc015-zero';
		const digest = sha256(batchId);
		const input: ArtifactInput = { ...BASE_INPUT, batchId, text: '' };

		const result = parseAndPersist(input, BASE_FLAGS, { projectRoot: dir });
		expect(result.candidates.length).toBe(0);
		expect(result.invocation_envelope.candidate_count).toBe(0);

		const content = readSidecar(dir, digest);
		expect(content).not.toBeNull();
		const records = parseJsonl(content!);
		expect(records.length).toBe(1);
		expect((records[0] as Record<string, unknown>).record_type).toBe(
			'invocation',
		);
	});

	test('batchDigest is SHA-256 of batchId — same batchId gives same digest', () => {
		const dir = makeTempDir();
		const batchId = 'deterministic-batch';
		const digest = sha256(batchId);

		// First append
		parseAndPersist(
			{ ...BASE_INPUT, batchId, text: buildBeText([beRow('x1')]) },
			BASE_FLAGS,
			{ projectRoot: dir },
		);
		// Second append with same batchId (different candidates)
		parseAndPersist(
			{ ...BASE_INPUT, batchId, text: buildBeText([beRow('x2')]) },
			BASE_FLAGS,
			{ projectRoot: dir },
		);

		// Both go to the same sidecar
		const content = readSidecar(dir, digest);
		expect(content).not.toBeNull();
		const records = parseJsonl(content!);
		expect(records.length).toBe(4); // 2 envelopes + 2 candidates
	});

	test('explicit batchDigest overrides SHA-256 derivation', () => {
		const dir = makeTempDir();
		const batchId = 'batch-with-override';
		const customDigest = 'deadbeef'.repeat(8); // 64 hex chars

		parseAndPersist(
			{ ...BASE_INPUT, batchId, text: buildBeText([beRow('c1')]) },
			BASE_FLAGS,
			{ projectRoot: dir, batchDigest: customDigest },
		);

		const content = readSidecar(dir, customDigest);
		expect(content).not.toBeNull();
		const records = parseJsonl(content!);
		expect(records.length).toBe(2);
	});
});

describe('SC-015 — sidecar path and directory creation', () => {
	test('sidecar file is created at .swarm/lane-results/{batchDigest}/candidates.jsonl', () => {
		const dir = makeTempDir();
		const batchId = 'path-test-batch';
		const digest = sha256(batchId);

		parseAndPersist(
			{ ...BASE_INPUT, batchId, text: buildBeText([beRow('c1')]) },
			BASE_FLAGS,
			{ projectRoot: dir },
		);

		const expectedPath = path.join(
			dir,
			'.swarm',
			'lane-results',
			digest,
			'candidates.jsonl',
		);
		expect(fs.existsSync(expectedPath)).toBe(true);
	});

	test('parent directory is auto-created on first append', () => {
		const dir = makeTempDir();
		const batchId = 'auto-mkdir-batch';
		const digest = sha256(batchId);

		const parentDir = path.join(dir, '.swarm', 'lane-results', digest);
		expect(fs.existsSync(parentDir)).toBe(false);

		parseAndPersist(
			{ ...BASE_INPUT, batchId, text: buildBeText([beRow('c1')]) },
			BASE_FLAGS,
			{ projectRoot: dir },
		);

		expect(fs.existsSync(parentDir)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// SC-016 — Cross-skill coexistence
// ---------------------------------------------------------------------------

describe('SC-016 — cross-skill records coexist in the same sidecar', () => {
	test('two appends with different producer values both persist', () => {
		const dir = makeTempDir();
		const batchId = 'cross-skill-batch';

		// First skill appends
		parseAndPersist(
			{ ...BASE_INPUT, batchId, text: buildBeText([beRow('c1')]) },
			{ ...BASE_FLAGS, producer: 'swarm-pr-review' },
			{ projectRoot: dir },
		);

		// Second skill appends to same batch
		parseAndPersist(
			{
				...BASE_INPUT,
				batchId,
				text: buildBeText([beRow('c2')]),
			},
			{ ...BASE_FLAGS, producer: 'deep-dive' },
			{ projectRoot: dir },
		);

		const digest = sha256(batchId);
		const content = readSidecar(dir, digest);
		expect(content).not.toBeNull();
		const records = parseJsonl(content!);

		// 2 envelopes + 2 candidates = 4 records
		expect(records.length).toBe(4);
		const envelopes = records.filter(
			(r: unknown) =>
				(r as Record<string, unknown>).record_type === 'invocation',
		);
		const candidates = records.filter(
			(r: unknown) =>
				(r as Record<string, unknown>).record_type === 'candidate',
		);
		expect(envelopes.length).toBe(2);
		expect(candidates.length).toBe(2);

		// Verify producers are present and distinct
		const producers = envelopes.map(
			(r: unknown) => (r as Record<string, unknown>).producer,
		);
		expect(producers).toContain('swarm-pr-review');
		expect(producers).toContain('deep-dive');

		// Verify row_format_family is present in all candidate records (not envelopes)
		for (const r of records) {
			const rec = r as Record<string, unknown>;
			if (rec.record_type === 'candidate') {
				expect(typeof rec.row_format_family).toBe('string');
			}
		}
	});

	test('second append does NOT overwrite the first (append-only)', () => {
		const dir = makeTempDir();
		const batchId = 'append-only-batch';

		parseAndPersist(
			{ ...BASE_INPUT, batchId, text: buildBeText([beRow('first')]) },
			{ ...BASE_FLAGS, producer: 'skill-a' },
			{ projectRoot: dir },
		);

		parseAndPersist(
			{ ...BASE_INPUT, batchId, text: buildBeText([beRow('second')]) },
			{ ...BASE_FLAGS, producer: 'skill-b' },
			{ projectRoot: dir },
		);

		const digest = sha256(batchId);
		const content = readSidecar(dir, digest);
		const records = parseJsonl(content!);

		const candidateIds = records
			.filter(
				(r: unknown) =>
					(r as Record<string, unknown>).record_type === 'candidate',
			)
			.map((r: unknown) => (r as Record<string, unknown>).candidate_id);
		expect(candidateIds).toContain('first');
		expect(candidateIds).toContain('second');
	});
});

// ---------------------------------------------------------------------------
// Record validation (write-time) — throws before append
// ---------------------------------------------------------------------------

describe('Record validation — envelope schema', () => {
	test('envelope missing record_type → throws with validation error', () => {
		const dir = makeTempDir();
		const badEnvelope = {
			// missing record_type
			source_output_ref: 'L1:abc',
			source_batch_id: 'b',
			source_lane_id: 'l',
			source_agent: 'a',
			source_digest: 'b'.repeat(64),
			row_format_version: 1,
			produced_at: '2024-01-01T00:00:00.000Z',
			record_version: { major: 1, minor: 0 },
			format_families_detected: [],
			candidate_count: 0,
			parse_errors: 0,
			malformed_rows: 0,
		};

		expect(() =>
			appendToSidecar({ projectRoot: dir }, 'batch', badEnvelope, []),
		).toThrow(/validation failed/i);
	});

	test('envelope missing source_digest → throws with validation error', () => {
		const dir = makeTempDir();
		const badEnvelope = {
			record_type: 'invocation' as const,
			source_output_ref: 'L1:abc',
			source_batch_id: 'b',
			source_lane_id: 'l',
			source_agent: 'a',
			// missing source_digest
			row_format_version: 1,
			produced_at: '2024-01-01T00:00:00.000Z',
			record_version: { major: 1, minor: 0 },
			format_families_detected: [],
			candidate_count: 0,
			parse_errors: 0,
			malformed_rows: 0,
		};

		expect(() =>
			appendToSidecar({ projectRoot: dir }, 'batch', badEnvelope, []),
		).toThrow(/validation failed/i);
	});

	test('envelope with wrong record_type literal → throws', () => {
		const dir = makeTempDir();
		const badEnvelope = {
			record_type: 'wrong_type' as const,
			source_output_ref: 'L1:abc',
			source_batch_id: 'b',
			source_lane_id: 'l',
			source_agent: 'a',
			source_digest: 'b'.repeat(64),
			row_format_version: 1,
			produced_at: '2024-01-01T00:00:00.000Z',
			record_version: { major: 1, minor: 0 },
			format_families_detected: [],
			candidate_count: 0,
			parse_errors: 0,
			malformed_rows: 0,
		};

		expect(() =>
			appendToSidecar({ projectRoot: dir }, 'batch', badEnvelope, []),
		).toThrow(/validation failed/i);
	});
});

describe('Record validation — candidate schema', () => {
	test('candidate missing record_version → throws with validation error', () => {
		const dir = makeTempDir();
		const envelope = {
			record_type: 'invocation' as const,
			source_output_ref: 'L1:abc',
			source_batch_id: 'b',
			source_lane_id: 'l',
			source_agent: 'a',
			source_digest: 'b'.repeat(64),
			row_format_version: 1,
			produced_at: '2024-01-01T00:00:00.000Z',
			record_version: { major: 1, minor: 0 },
			format_families_detected: [],
			candidate_count: 1,
			parse_errors: 0,
			malformed_rows: 0,
		};
		const badCandidate = {
			record_type: 'candidate' as const,
			row_format_family: 'base_explorer' as const,
			row_format_version: 1,
			// missing record_version
			source_output_ref: 'L1:abc',
			source_batch_id: 'b',
			source_lane_id: 'l',
			source_agent: 'a',
			source_digest: 'b'.repeat(64),
			extracted_from_partial_source: false,
			candidate_id: 'c1',
			lane: 'lane-A',
			micro_lane: null,
			severity: 'HIGH',
			category: 'security',
			file_line: 'src/foo.ts:10',
			claim: 'claim1',
			evidence_summary: 'evidence1',
			impact_context: 'impact1',
			invariant_violated: null,
			confidence: '0.9',
		};

		expect(() =>
			appendToSidecar({ projectRoot: dir }, 'batch', envelope, [badCandidate]),
		).toThrow(/validation failed/i);
	});

	test('candidate with wrong record_type → throws', () => {
		const dir = makeTempDir();
		const envelope = {
			record_type: 'invocation' as const,
			source_output_ref: 'L1:abc',
			source_batch_id: 'b',
			source_lane_id: 'l',
			source_agent: 'a',
			source_digest: 'b'.repeat(64),
			row_format_version: 1,
			produced_at: '2024-01-01T00:00:00.000Z',
			record_version: { major: 1, minor: 0 },
			format_families_detected: [],
			candidate_count: 1,
			parse_errors: 0,
			malformed_rows: 0,
		};
		const badCandidate = {
			record_type: 'envelope' as const, // wrong type
			row_format_family: 'base_explorer' as const,
			row_format_version: 1,
			record_version: { major: 1, minor: 0 },
			source_output_ref: 'L1:abc',
			source_batch_id: 'b',
			source_lane_id: 'l',
			source_agent: 'a',
			source_digest: 'b'.repeat(64),
			extracted_from_partial_source: false,
			candidate_id: 'c1',
			lane: 'lane-A',
			micro_lane: null,
			severity: 'HIGH',
			category: 'security',
			file_line: 'src/foo.ts:10',
			claim: 'claim1',
			evidence_summary: 'evidence1',
			impact_context: 'impact1',
			invariant_violated: null,
			confidence: '0.9',
		};

		expect(() =>
			appendToSidecar({ projectRoot: dir }, 'batch', envelope, [badCandidate]),
		).toThrow(/validation failed/i);
	});

	test('validation error before write → sidecar_write_error not set (error thrown before append)', () => {
		const dir = makeTempDir();
		const batchId = 'validation-fail-batch';

		// Envelope missing required field 'source_output_ref' — this will throw from
		// appendToSidecar before any file operation
		const badEnvelope = {
			record_type: 'invocation' as const,
			// missing source_output_ref
			source_batch_id: 'b',
			source_lane_id: 'l',
			source_agent: 'a',
			source_digest: 'b'.repeat(64),
			row_format_version: 1,
			produced_at: '2024-01-01T00:00:00.000Z',
			record_version: { major: 1, minor: 0 },
			format_families_detected: [] as string[],
			candidate_count: 0,
			parse_errors: 0,
			malformed_rows: 0,
		};

		expect(() =>
			appendToSidecar({ projectRoot: dir }, batchId, badEnvelope, []),
		).toThrow();
	});
});

// ---------------------------------------------------------------------------
// Schema field coverage
// ---------------------------------------------------------------------------

describe('Schema field coverage — envelope includes row_format_version', () => {
	test('parseAndPersist envelope has row_format_version field', () => {
		const dir = makeTempDir();
		const input: ArtifactInput = {
			...BASE_INPUT,
			text: buildBeText([beRow('c1')]),
		};

		const result = parseAndPersist(input, BASE_FLAGS, { projectRoot: dir });
		expect(result.invocation_envelope.row_format_version).toBe(1);
	});

	test('parseAndPersist envelope has all required provenance fields', () => {
		const dir = makeTempDir();
		const input: ArtifactInput = {
			...BASE_INPUT,
			text: buildBeText([beRow('c1')]),
		};

		const result = parseAndPersist(input, BASE_FLAGS, { projectRoot: dir });
		const env = result.invocation_envelope;
		expect(env.record_type).toBe('invocation');
		expect(env.source_output_ref).toBe(BASE_INPUT.output_ref);
		expect(env.source_batch_id).toBe(BASE_INPUT.batchId);
		expect(env.source_lane_id).toBe(BASE_INPUT.laneId);
		expect(env.source_agent).toBe(BASE_INPUT.agent);
		expect(env.source_digest).toBe(BASE_INPUT.digest);
		expect(typeof env.row_format_version).toBe('number');
		expect(typeof env.record_version).toBe('object');
		expect(typeof env.record_version.major).toBe('number');
		expect(typeof env.record_version.minor).toBe('number');
		expect(Array.isArray(env.format_families_detected)).toBe(true);
	});
});

describe('Schema field coverage — candidate includes all provenance fields', () => {
	test('candidate has all provenance fields present', () => {
		const dir = makeTempDir();
		const input: ArtifactInput = {
			...BASE_INPUT,
			text: buildBeText([beRow('c1')]),
		};

		const result = parseAndPersist(input, BASE_FLAGS, { projectRoot: dir });
		const c = result.candidates[0];
		expect(c.source_output_ref).toBe(BASE_INPUT.output_ref);
		expect(c.source_batch_id).toBe(BASE_INPUT.batchId);
		expect(c.source_lane_id).toBe(BASE_INPUT.laneId);
		expect(c.source_agent).toBe(BASE_INPUT.agent);
		expect(c.source_digest).toBe(BASE_INPUT.digest);
		expect(c.sessionId).toBe(BASE_INPUT.sessionId);
		expect(c.parentSessionId).toBe(BASE_INPUT.parentSessionId);
		expect(typeof c.row_format_version).toBe('number');
		expect(typeof c.row_format_family).toBe('string');
		expect(typeof c.record_version).toBe('object');
		expect(typeof c.extracted_from_partial_source).toBe('boolean');
	});
});

describe('FR-019 — producer on candidate records (schema + round-trip)', () => {
	test('SidecarCandidateSchema accepts a candidate record with producer field', () => {
		const dir = makeTempDir();
		const envelope = {
			record_type: 'invocation' as const,
			source_output_ref: 'L1:abc',
			source_batch_id: 'b',
			source_lane_id: 'l',
			source_agent: 'a',
			source_digest: 'b'.repeat(64),
			row_format_version: 1,
			produced_at: '2024-01-01T00:00:00.000Z',
			record_version: { major: 1, minor: 0 },
			format_families_detected: ['base_explorer'],
			candidate_count: 1,
			parse_errors: 0,
			malformed_rows: 0,
		};
		const candidateWithProducer = {
			record_type: 'candidate' as const,
			row_format_family: 'base_explorer' as const,
			row_format_version: 1,
			record_version: { major: 1, minor: 0 },
			source_output_ref: 'L1:abc',
			source_batch_id: 'b',
			source_lane_id: 'l',
			source_agent: 'a',
			source_digest: 'b'.repeat(64),
			sessionId: 's1',
			parentSessionId: 'p1',
			producer: 'skill-x',
			extracted_from_partial_source: false,
			candidate_id: 'c1',
			lane: 'lane-A',
			micro_lane: null,
			severity: 'HIGH',
			category: 'security',
			file_line: 'src/foo.ts:10',
			claim: 'claim1',
			evidence_summary: 'evidence1',
			impact_context: 'impact1',
			invariant_violated: null,
			confidence: '0.9',
		};

		// Should NOT throw — schema accepts producer field
		expect(() =>
			appendToSidecar({ projectRoot: dir }, 'batch', envelope, [
				candidateWithProducer,
			]),
		).not.toThrow();
	});

	test('producer is preserved in sidecar JSONL after parseAndPersist round-trip', () => {
		const dir = makeTempDir();
		const batchId = 'producer-roundtrip-batch';
		const input: ArtifactInput = {
			...BASE_INPUT,
			batchId,
			text: buildBeText([beRow('producer-c1')]),
		};
		const flags: ParseFlags = {
			...BASE_FLAGS,
			producer: 'roundtrip-producer',
		};

		const result = parseAndPersist(input, flags, { projectRoot: dir });
		expect(result.error_code).toBeUndefined();
		expect(result.candidates[0].producer).toBe('roundtrip-producer');

		const digest = sha256(batchId);
		const content = readSidecar(dir, digest);
		expect(content).not.toBeNull();
		const records = parseJsonl(content!);

		// Find the candidate record
		const candidate = records.find(
			(r: unknown) =>
				(r as Record<string, unknown>).record_type === 'candidate',
		) as Record<string, unknown>;
		expect(candidate.producer).toBe('roundtrip-producer');
	});

	test('parseAndPersist without producer flag → candidate.producer is undefined and absent from JSONL', () => {
		const dir = makeTempDir();
		const batchId = 'no-producer-batch';
		const input: ArtifactInput = {
			...BASE_INPUT,
			batchId,
			text: buildBeText([beRow('no-prod-c1')]),
		};

		const result = parseAndPersist(input, BASE_FLAGS, { projectRoot: dir });
		expect(result.candidates[0].producer).toBeUndefined();

		const digest = sha256(batchId);
		const content = readSidecar(dir, digest);
		expect(content).not.toBeNull();
		const records = parseJsonl(content!);

		const candidate = records.find(
			(r: unknown) =>
				(r as Record<string, unknown>).record_type === 'candidate',
		) as Record<string, unknown>;
		expect(candidate.producer).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// SC-026 — Empty text still appends invocation envelope
// ---------------------------------------------------------------------------

describe('SC-026 — empty text produces invocation envelope with zero candidates', () => {
	test('empty text → sidecar receives envelope with candidate_count:0', () => {
		const dir = makeTempDir();
		const batchId = 'empty-text-batch';
		const digest = sha256(batchId);

		parseAndPersist({ ...BASE_INPUT, batchId, text: '' }, BASE_FLAGS, {
			projectRoot: dir,
		});

		const content = readSidecar(dir, digest);
		expect(content).not.toBeNull();
		const records = parseJsonl(content!);
		expect(records.length).toBe(1);
		const env = records[0] as Record<string, unknown>;
		expect(env.record_type).toBe('invocation');
		expect(env.candidate_count).toBe(0);
	});

	test('whitespace-only text → sidecar receives envelope with candidate_count:0', () => {
		const dir = makeTempDir();
		const batchId = 'whitespace-text-batch';
		const digest = sha256(batchId);

		parseAndPersist({ ...BASE_INPUT, batchId, text: '   \n\n  ' }, BASE_FLAGS, {
			projectRoot: dir,
		});

		const content = readSidecar(dir, digest);
		expect(content).not.toBeNull();
		const records = parseJsonl(content!);
		expect(records.length).toBe(1);
		expect((records[0] as Record<string, unknown>).candidate_count).toBe(0);
	});

	test('parse result for empty text has correct shape (no error_code)', () => {
		const dir = makeTempDir();
		const result = parseAndPersist({ ...BASE_INPUT, text: '' }, BASE_FLAGS, {
			projectRoot: dir,
		});

		expect(result.error_code).toBeUndefined();
		expect(result.candidates.length).toBe(0);
		expect(result.diagnostics.candidate_count).toBe(0);
		expect(result.diagnostics.parse_errors).toBe(0);
		expect(result.diagnostics.malformed_rows).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Pure parseCandidates unchanged
// ---------------------------------------------------------------------------

describe('parseCandidates — pure function has no sidecar dependencies', () => {
	test('parseCandidates returns no sidecar_write_error', () => {
		const input: ArtifactInput = {
			...BASE_INPUT,
			text: buildBeText([beRow('c1')]),
		};

		const result = parseCandidates(input, BASE_FLAGS);
		expect(result.error_code).toBeUndefined();
		expect(
			(result as ParseResultWithSidecar).sidecar_write_error,
		).toBeUndefined();
	});

	test('parseCandidates works without projectRoot (no filesystem call)', () => {
		const input: ArtifactInput = {
			...BASE_INPUT,
			text: buildBeText([beRow('c1'), beRow('c2')]),
		};

		const result = parseCandidates(input, BASE_FLAGS);
		expect(result.candidates.length).toBe(2);
		expect(result.invocation_envelope.candidate_count).toBe(2);
	});

	test('parseCandidates with empty text returns empty result without error', () => {
		const result = parseCandidates({ ...BASE_INPUT, text: '' }, BASE_FLAGS);
		expect(result.error_code).toBeUndefined();
		expect(result.candidates.length).toBe(0);
		expect(result.invocation_envelope.candidate_count).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Integration: round-trip parse + sidecar write
// ---------------------------------------------------------------------------

describe('Integration — parseAndPersist produces parseable JSONL', () => {
	test('sidecar JSONL can be parsed back to the original records', () => {
		const dir = makeTempDir();
		const batchId = 'roundtrip-batch';
		const digest = sha256(batchId);
		const input: ArtifactInput = {
			...BASE_INPUT,
			batchId,
			text: buildBeText([beRow('roundtrip-c1'), beRow('roundtrip-c2')]),
		};

		const result = parseAndPersist(input, BASE_FLAGS, { projectRoot: dir });
		expect(result.error_code).toBeUndefined();
		expect(result.candidates.length).toBe(2);

		const content = readSidecar(dir, digest);
		expect(content).not.toBeNull();
		const records = parseJsonl(content!);

		expect(records.length).toBe(3); // 1 envelope + 2 candidates

		const [env, c1, c2] = records as Record<string, unknown>[];
		expect(env.record_type).toBe('invocation');
		expect(c1.record_type).toBe('candidate');
		expect(c2.record_type).toBe('candidate');
		expect(c1.candidate_id).toBe('roundtrip-c1');
		expect(c2.candidate_id).toBe('roundtrip-c2');
	});

	test('parseAndPersist with multiple producer appends produces valid JSONL', () => {
		const dir = makeTempDir();
		const batchId = 'multi-producer-jsonl';

		parseAndPersist(
			{ ...BASE_INPUT, batchId, text: buildBeText([beRow('p1-c1')]) },
			{ ...BASE_FLAGS, producer: 'producer-a' },
			{ projectRoot: dir },
		);
		parseAndPersist(
			{ ...BASE_INPUT, batchId, text: buildBeText([beRow('p2-c1')]) },
			{ ...BASE_FLAGS, producer: 'producer-b' },
			{ projectRoot: dir },
		);

		const content = readSidecar(dir, sha256(batchId));
		expect(content).not.toBeNull();
		// All lines should be valid JSON
		expect(() => parseJsonl(content!)).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// FR-021 — sanitizeString surrogate pair handling
// ---------------------------------------------------------------------------

describe('FR-021 — sanitizeString preserves surrogate pairs', () => {
	test('emoji (U+1F600) survives sanitization unchanged', () => {
		// 😀 is U+1F600, a surrogate pair in UTF-16
		const input = 'hello 😀 world';
		const result = sanitizeString(input);
		expect(result).toBe('hello 😀 world');
		// Length should match original (14 chars including surrogate pairs)
		expect(result.length).toBe(input.length);
	});

	test('multiple emoji are all preserved', () => {
		const input = '🎉🔥✅';
		const result = sanitizeString(input);
		expect(result).toBe('🎉🔥✅');
		expect(result.length).toBe(input.length);
	});

	test('supplementary character in candidate field survives round-trip', () => {
		const dir = makeTempDir();
		const batchId = 'surrogate-batch';
		const input: ArtifactInput = {
			...BASE_INPUT,
			batchId,
			text: buildBeText([
				beRow(
					'c-emoji',
					'lane-A',
					'HIGH',
					'sec',
					'src/foo.ts:10',
					'claim with 😀',
					'evidence',
					'impact',
					'0.9',
				),
			]),
		};

		const result = parseAndPersist(input, BASE_FLAGS, { projectRoot: dir });
		expect(result.error_code).toBeUndefined();
		expect(result.candidates[0].claim).toBe('claim with 😀');

		const content = readSidecar(dir, sha256(batchId));
		expect(content).not.toBeNull();
		const records = parseJsonl(content!);
		const candidate = records.find(
			(r: unknown) =>
				(r as Record<string, unknown>).record_type === 'candidate',
		) as Record<string, unknown>;
		expect(candidate.claim).toBe('claim with 😀');
	});

	test('NUL byte is escaped to \\u0000', () => {
		expect(sanitizeString('foo\x00bar')).toBe('foo\\u0000bar');
	});

	test('ANSI ESC byte is stripped', () => {
		expect(sanitizeString('foo\x1b[31mbar')).toBe('foobar');
	});

	test('CSI sequence \x1B[31m is fully removed', () => {
		expect(sanitizeString('\x1B[31mred')).toBe('red');
	});

	test('multiple CSI sequences are fully removed', () => {
		expect(sanitizeString('\x1B[31mred\x1B[0m')).toBe('red');
	});

	test('CSI with multiple parameters is fully removed', () => {
		expect(sanitizeString('\x1B[1;32mgreen\x1B[0m')).toBe('green');
	});

	test('OSC sequence terminated by BEL is fully removed', () => {
		expect(sanitizeString('\x1B]0;title\x07actual')).toBe('actual');
	});

	test('OSC sequence terminated by ST is fully removed', () => {
		expect(sanitizeString('\x1B]0;title\x1B\\actual')).toBe('actual');
	});

	test('two-character escape sequence is fully removed', () => {
		expect(sanitizeString('\x1B7save')).toBe('save');
	});

	test('mixed text and ANSI — full sequences stripped, plain text preserved', () => {
		expect(sanitizeString('normal\x1B[31mred\x1B[0mnormal')).toBe(
			'normalrednormal',
		);
	});

	test('lone ESC at end of string is removed without crashing', () => {
		expect(sanitizeString('text\x1B')).toBe('text');
	});

	test('ESC followed by unrecognized byte — ESC dropped, function does not throw', () => {
		// \xFF (0xFF) is not an ANSI control byte so it is preserved;
		// only the ESC introducer is consumed.
		expect(sanitizeString('\x1B\xFFfoo')).toBe('\xFFfoo');
	});

	test('bidi override markers are stripped', () => {
		// U+202E is RLO (right-to-left override)
		expect(sanitizeString('hello\u202eworld')).toBe('helloworld');
	});
});

// ---------------------------------------------------------------------------
// SC-025 / FR-021 — caller records are not mutated by appendToSidecar
// ---------------------------------------------------------------------------

describe('SC-025 / FR-021 — appendToSidecar does not mutate caller objects', () => {
	test('envelope object is not mutated after appendToSidecar', () => {
		const dir = makeTempDir();
		const envelope = {
			record_type: 'invocation' as const,
			source_output_ref: 'L1:abc',
			source_batch_id: 'b',
			source_lane_id: 'l',
			source_agent: 'a',
			source_digest: 'b'.repeat(64),
			row_format_version: 1,
			produced_at: '2024-01-01T00:00:00.000Z',
			record_version: { major: 1, minor: 0 },
			format_families_detected: [] as string[],
			candidate_count: 1,
			parse_errors: 0,
			malformed_rows: 0,
		};
		const candidate = {
			record_type: 'candidate' as const,
			row_format_family: 'base_explorer' as const,
			row_format_version: 1,
			record_version: { major: 1, minor: 0 },
			source_output_ref: 'L1:abc',
			source_batch_id: 'b',
			source_lane_id: 'l',
			source_agent: 'a',
			source_digest: 'b'.repeat(64),
			extracted_from_partial_source: false,
			candidate_id: 'c1',
			lane: 'lane-A',
			micro_lane: null,
			severity: 'HIGH',
			category: 'security',
			file_line: 'src/foo.ts:10',
			claim: 'claim1',
			evidence_summary: 'evidence1',
			impact_context: 'impact1',
			invariant_violated: null,
			confidence: '0.9',
		};

		const originalEnvelope = JSON.stringify(envelope);
		const originalCandidate = JSON.stringify(candidate);

		appendToSidecar({ projectRoot: dir }, 'batch', envelope, [candidate]);

		// Caller's objects must be unchanged
		expect(JSON.stringify(envelope)).toBe(originalEnvelope);
		expect(JSON.stringify(candidate)).toBe(originalCandidate);
	});

	test('candidate objects are not mutated after appendToSidecar', () => {
		const dir = makeTempDir();
		const envelope = {
			record_type: 'invocation' as const,
			source_output_ref: 'L1:abc',
			source_batch_id: 'b',
			source_lane_id: 'l',
			source_agent: 'a',
			source_digest: 'b'.repeat(64),
			row_format_version: 1,
			produced_at: '2024-01-01T00:00:00.000Z',
			record_version: { major: 1, minor: 0 },
			format_families_detected: [] as string[],
			candidate_count: 2,
			parse_errors: 0,
			malformed_rows: 0,
		};
		const candidates = [
			{
				record_type: 'candidate' as const,
				row_format_family: 'base_explorer' as const,
				row_format_version: 1,
				record_version: { major: 1, minor: 0 },
				source_output_ref: 'L1:abc',
				source_batch_id: 'b',
				source_lane_id: 'l',
				source_agent: 'a',
				source_digest: 'b'.repeat(64),
				extracted_from_partial_source: false,
				candidate_id: 'c1',
				lane: 'lane-A',
				micro_lane: null,
				severity: 'HIGH',
				category: 'security',
				file_line: 'src/foo.ts:10',
				claim: 'claim with NUL\x00byte',
				evidence_summary: 'evidence1',
				impact_context: 'impact1',
				invariant_violated: null,
				confidence: '0.9',
			},
			{
				record_type: 'candidate' as const,
				row_format_family: 'base_explorer' as const,
				row_format_version: 1,
				record_version: { major: 1, minor: 0 },
				source_output_ref: 'L1:abc',
				source_batch_id: 'b',
				source_lane_id: 'l',
				source_agent: 'a',
				source_digest: 'b'.repeat(64),
				extracted_from_partial_source: false,
				candidate_id: 'c2',
				lane: 'lane-B',
				micro_lane: null,
				severity: 'MEDIUM',
				category: 'style',
				file_line: 'src/bar.ts:20',
				claim: 'claim with ESC\x1b[1m',
				evidence_summary: 'evidence2',
				impact_context: 'impact2',
				invariant_violated: null,
				confidence: '0.8',
			},
		];

		const originals = candidates.map((c) => JSON.stringify(c));

		appendToSidecar({ projectRoot: dir }, 'batch', envelope, candidates);

		for (let i = 0; i < candidates.length; i++) {
			expect(JSON.stringify(candidates[i])).toBe(originals[i]);
		}
	});
});

// ---------------------------------------------------------------------------
// SC-023 — Append failure handling (MUST run LAST — uses mock.module)
// ---------------------------------------------------------------------------
// NOTE: These tests use mock.module('node:fs') which pollutes Bun's module
// cache. Running them LAST ensures they don't corrupt state for earlier tests.
// See: tests/unit/background/candidate-sidecar-store.test.ts (isolated at end)

describe('SC-023 — sidecar append failure does not fail the parse', () => {
	afterEach(() => {
		mock.restore();
	});

	// We use mock.module to replace node:fs BEFORE parseAndPersist runs.
	// The mock is installed per-test via dynamic import so the module
	// binding is captured with the mock in place.
	//
	// Bun's mock.module replaces the module in the cache. Subsequent imports
	// of 'node:fs' get the mock. Because we use a dynamic import AFTER
	// installing the mock, the candidate-parser module (and its transitive
	// import of candidate-sidecar-store) gets the mocked fs.
	//
	// IMPORTANT: These tests must remain in a SEPARATE describe block at the
	// END of the file. Running them before other tests that use the top-level
	// parseAndPersist import causes Bun's module cache to return the mock for
	// subsequent top-level calls. This is a Bun test-runner artifact, not
	// a bug in the application code.

	test('appendFileSync throws → sidecar_write_error is set, parse result still returned', async () => {
		const dir = makeTempDir();
		const batchId = 'append-fail-batch';
		const input: ArtifactInput = {
			...BASE_INPUT,
			batchId,
			text: buildBeText([beRow('c1')]),
		};

		const appendMock = mock(() => {
			throw new Error('ENOSPC: no space left on device');
		});
		mock.module('node:fs', () => ({
			...realFs,
			appendFileSync: appendMock as typeof realFs.appendFileSync,
		}));

		// Dynamic import AFTER mock is installed — ensures the mock is
		// in the module cache before candidate-sidecar-store captures its
		// fs bindings.
		const { parseAndPersist: pp } = await import(
			'../../../src/background/candidate-parser'
		);
		const result = pp(input, BASE_FLAGS, { projectRoot: dir });

		// Parse succeeded despite sidecar failure
		expect(result.error_code).toBeUndefined();
		expect(result.candidates.length).toBe(1);
		expect(result.invocation_envelope.candidate_count).toBe(1);

		// sidecar_write_error is set
		expect(result.sidecar_write_error).toBeDefined();
		expect(result.sidecar_write_error).toContain('ENOSPC');
	});

	test('parse result fields are all present alongside sidecar_write_error', async () => {
		const dir = makeTempDir();
		const batchId = 'sidecar-error-fields-batch';

		const appendMock = mock(() => {
			throw new Error('disk full');
		});
		mock.module('node:fs', () => ({
			...realFs,
			appendFileSync: appendMock as typeof realFs.appendFileSync,
		}));

		const { parseAndPersist: pp } = await import(
			'../../../src/background/candidate-parser'
		);
		const result = pp(
			{ ...BASE_INPUT, batchId, text: buildBeText([beRow('c1')]) },
			BASE_FLAGS,
			{ projectRoot: dir },
		);

		// All standard parse result fields must be present
		expect(Array.isArray(result.candidates)).toBe(true);
		expect(typeof result.invocation_envelope).toBe('object');
		expect(typeof result.diagnostics).toBe('object');
		expect(typeof result.diagnostics.candidate_count).toBe('number');
		expect(typeof result.sidecar_write_error).toBe('string');
		expect(result.sidecar_write_error!.length).toBeGreaterThan(0);
	});
});
