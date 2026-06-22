import { afterEach, describe, expect, mock, test } from 'bun:test';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { LaneOutputArtifact } from '../../../src/background/lane-output-store';
import { parse_lane_candidates } from '../../../src/tools/parse-lane-candidates';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Tracked temp directories for afterEach cleanup. */
const tmpDirs: string[] = [];

/** Create a resolved temp directory under os.tmpdir() and register for cleanup. */
function makeTempDir(): string {
	const dir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'parse-lane-candidates-')),
	);
	tmpDirs.push(dir);
	return dir;
}

/** SHA-256 hex of a string. */
function sha256(value: string): string {
	return createHash('sha256').update(value).digest('hex');
}

/**
 * Write a valid LaneOutputArtifact JSON file to the lane-output-store path
 * derived from the given ref, and return the artifact object.
 */
function writeLaneArtifact(
	directory: string,
	artifact: LaneOutputArtifact,
): LaneOutputArtifact {
	const absPath = validateSwarmPath(
		directory,
		path.join(
			'lane-results',
			sha256(artifact.batchId),
			sha256(artifact.laneId),
			`${artifact.digest}.json`,
		),
	);
	fs.mkdirSync(path.dirname(absPath), { recursive: true });
	fs.writeFileSync(absPath, JSON.stringify(artifact, null, 2), 'utf-8');
	return artifact;
}

/** Write a raw (possibly corrupt) file at the lane-output path for the given ref. */
function writeRawLaneFile(
	directory: string,
	ref: string,
	content: string,
): void {
	const parts = ref.split(':');
	if (parts.length !== 4) throw new Error(`Invalid ref: ${ref}`);
	const [, batchDigest, laneDigest, outputDigest] = parts;
	const absPath = validateSwarmPath(
		directory,
		path.join('lane-results', batchDigest, laneDigest, `${outputDigest}.json`),
	);
	fs.mkdirSync(path.dirname(absPath), { recursive: true });
	fs.writeFileSync(absPath, content, 'utf-8');
}

/**
 * Build a valid LaneOutputArtifact with optional overrides.
 * The digest is always derived from the full text (sha256(text)), ensuring
 * consistency between the artifact's ref and its stored digest.
 */
function buildArtifact(
	overrides: Partial<LaneOutputArtifact> = {},
): LaneOutputArtifact {
	const batchId = overrides.batchId ?? 'test-batch';
	const laneId = overrides.laneId ?? 'test-lane';
	const text = overrides.text ?? '';
	// Digest is always derived from the full text — consistent with what
	// storeLaneOutput does internally.
	const digest = sha256(text);
	const createdAt = overrides.createdAt ?? '2024-01-01T00:00:00.000Z';
	const updatedAt = overrides.updatedAt ?? createdAt;

	// Build overrides without any keys whose value is undefined
	// (prevents polluting the strict schema with undefined-valued properties).
	const cleanOverrides: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(overrides)) {
		if (value !== undefined) {
			cleanOverrides[key] = value;
		}
	}

	const result = {
		schemaVersion: 1,
		ref: `L1:${sha256(batchId)}:${sha256(laneId)}:${digest}`,
		batchId,
		laneId,
		agent: 'mega_explorer',
		role: 'explorer',
		...cleanOverrides,
		source: 'dispatch_lanes' as const,
		text,
		chars: text.length,
		bytes: Buffer.byteLength(text, 'utf-8'),
		digest,
		createdAt,
		updatedAt,
	};

	return result as LaneOutputArtifact;
}

/** Build a minimal [CANDIDATE] pipe-delimited text with one row. */
function buildCandidateText(row: string): string {
	const header =
		'[CANDIDATE] | candidate_id | lane | severity | category | file:line | claim | evidence_summary | impact_context | confidence';
	return `${header}\n${row}`;
}

/** A well-formed base_explorer row. */
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

/**
 * Call parse_lane_candidates with the given args and a mock ToolContext
 * whose directory is set to the provided path.
 */
async function callTool(
	directory: string,
	args: Record<string, unknown>,
): Promise<string> {
	// Cast to ToolContext — we only need to provide `directory`.
	return (
		parse_lane_candidates as unknown as {
			execute: (args: unknown, ctx: { directory: string }) => Promise<string>;
		}
	).execute(args, { directory });
}

// Mirror of validateSwarmPath from src/hooks/utils.ts for test path construction.
// Resolves `relPath` under `{root}/.swarm/` and returns the absolute path.
function validateSwarmPath(root: string, relPath: string): string {
	const baseDir = path.normalize(path.resolve(root, '.swarm'));
	const resolved = path.normalize(path.resolve(baseDir, relPath));
	if (process.platform === 'win32') {
		if (
			!resolved.toLowerCase().startsWith((baseDir + path.sep).toLowerCase())
		) {
			throw new Error('Invalid path: escapes .swarm directory');
		}
	} else {
		if (!resolved.startsWith(baseDir + path.sep)) {
			throw new Error('Invalid path: escapes .swarm directory');
		}
	}
	return resolved;
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
// Tests
// ---------------------------------------------------------------------------

describe('parse_lane_candidates', () => {
	// -----------------------------------------------------------------------
	// Argument validation
	// -----------------------------------------------------------------------
	describe('argument validation', () => {
		test('missing output_ref → invalid_args', async () => {
			const dir = makeTempDir();
			const result = await callTool(dir, {});
			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(false);
			expect(parsed.failure_class).toBe('invalid_args');
			expect(parsed.message).toContain('Invalid parse_lane_candidates');
		});

		test('output_ref: empty string → invalid_args', async () => {
			const dir = makeTempDir();
			const result = await callTool(dir, { output_ref: '' });
			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(false);
			expect(parsed.failure_class).toBe('invalid_args');
		});

		test('row_format_version: negative → invalid_args', async () => {
			const dir = makeTempDir();
			const result = await callTool(dir, {
				output_ref: 'L1:abc:def:ghi',
				row_format_version: -1,
			});
			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(false);
			expect(parsed.failure_class).toBe('invalid_args');
		});

		test('accept_partial: non-boolean → invalid_args', async () => {
			const dir = makeTempDir();
			const result = await callTool(dir, {
				output_ref: 'L1:abc:def:ghi',
				accept_partial: 'yes',
			});
			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(false);
			expect(parsed.failure_class).toBe('invalid_args');
		});
	});

	// -----------------------------------------------------------------------
	// ref-not-found: no file on disk
	// -----------------------------------------------------------------------
	describe('ref-not-found', () => {
		test('nonexistent ref with no on-disk file → ref-not-found refusal', async () => {
			const dir = makeTempDir();
			const fakeRef = `L1:${sha256('no-such-batch')}:${sha256('no-such-lane')}:${sha256('no-such-digest')}`;
			const result = await callTool(dir, { output_ref: fakeRef });
			const parsed = JSON.parse(result);
			expect(parsed.error_code).toBe('ref-not-found');
			expect(parsed.error).toBe('Artifact reference not found in store');
			expect(parsed.candidates).toEqual([]);
			expect(parsed.invocation_envelope).toBeDefined();
			expect(parsed.invocation_envelope.candidate_count).toBe(0);
			expect(parsed.invocation_envelope.parse_errors).toBe(0);
			expect(parsed.invocation_envelope.malformed_rows).toBe(0);
			expect(parsed.diagnostics.candidate_count).toBe(0);
			expect(parsed.diagnostics.parse_errors).toBe(0);
			expect(parsed.diagnostics.malformed_rows).toBe(0);
		});
	});

	// -----------------------------------------------------------------------
	// artifact-corrupted: file exists but is invalid JSON
	// -----------------------------------------------------------------------
	describe('artifact-corrupted', () => {
		test('file exists but contains invalid JSON → artifact-corrupted refusal', async () => {
			const dir = makeTempDir();
			const batchId = 'corrupt-batch';
			const laneId = 'corrupt-lane';
			const digest = sha256('corrupt-text');
			const ref = `L1:${sha256(batchId)}:${sha256(laneId)}:${digest}`;
			writeRawLaneFile(dir, ref, 'NOT VALID JSON {{{');
			const result = await callTool(dir, { output_ref: ref });
			const parsed = JSON.parse(result);
			expect(parsed.error_code).toBe('artifact-corrupted');
			expect(parsed.error).toBe('Artifact data is corrupted');
			expect(parsed.candidates).toEqual([]);
			expect(parsed.invocation_envelope).toBeDefined();
			expect(parsed.invocation_envelope.candidate_count).toBe(0);
			expect(parsed.invocation_envelope.parse_errors).toBe(0);
			expect(parsed.invocation_envelope.malformed_rows).toBe(0);
		});

		test('file exists but fails schema validation → artifact-corrupted refusal', async () => {
			const dir = makeTempDir();
			const batchId = 'schema-fail-batch';
			const laneId = 'schema-fail-lane';
			const digest = sha256('text');
			const ref = `L1:${sha256(batchId)}:${sha256(laneId)}:${digest}`;
			// Write a JSON object that is valid JSON but fails LaneOutputArtifactSchema.
			writeRawLaneFile(
				dir,
				ref,
				JSON.stringify({ schemaVersion: 1, ref, badField: true }),
			);
			const result = await callTool(dir, { output_ref: ref });
			const parsed = JSON.parse(result);
			expect(parsed.error_code).toBe('artifact-corrupted');
			expect(parsed.error).toBe('Artifact data is corrupted');
			expect(parsed.candidates).toEqual([]);
			expect(parsed.invocation_envelope).toBeDefined();
			expect(parsed.invocation_envelope.candidate_count).toBe(0);
		});

		test('ref-not-found sidecar still receives invocation envelope with zero candidates', async () => {
			const dir = makeTempDir();
			const batchId = 'sidecar-ref-not-found-batch';
			const laneId = 'sidecar-ref-not-found-lane';
			const fakeRef = `L1:${sha256(batchId)}:${sha256(laneId)}:${'0'.repeat(64)}`;
			const result = await callTool(dir, { output_ref: fakeRef });
			const parsed = JSON.parse(result);
			expect(parsed.candidates).toEqual([]);
			expect(parsed.invocation_envelope).toBeDefined();
			// synthetic input uses the digest portions of the ref as batchId/laneId
			expect(parsed.invocation_envelope.source_batch_id).toBe(sha256(batchId));
			expect(parsed.invocation_envelope.source_lane_id).toBe(sha256(laneId));

			// Verify sidecar was written with envelope + zero candidates.
			const sidecarPath = path.join(
				dir,
				'.swarm',
				'lane-results',
				sha256(batchId),
				'candidates.jsonl',
			);
			expect(fs.existsSync(sidecarPath)).toBe(true);
			const lines = fs.readFileSync(sidecarPath, 'utf-8').trim().split('\n');
			expect(lines.length).toBeGreaterThanOrEqual(1);
			const envelope = JSON.parse(lines[0]);
			expect(envelope.record_type).toBe('invocation');
			expect(envelope.source_batch_id).toBe(sha256(batchId));
			expect(envelope.candidate_count).toBe(0);
		});
	});

	// -----------------------------------------------------------------------
	// Happy path: well-formed artifact
	// -----------------------------------------------------------------------
	describe('happy path', () => {
		test('well-formed artifact → parsed candidates with envelope and diagnostics', async () => {
			const dir = makeTempDir();
			const batchId = 'happy-batch';
			const laneId = 'happy-lane';
			const text = buildCandidateText(
				beRow(
					'c1',
					'lane-A',
					'HIGH',
					'sec',
					'src/a.ts:1',
					'cl',
					'ev',
					'imp',
					'0.9',
				),
			);
			const digest = sha256(text);
			const artifact = buildArtifact({
				batchId,
				laneId,
				text,
				digest,
				sessionId: 'sess-1',
				parentSessionId: 'parent-1',
			});
			writeLaneArtifact(dir, artifact);

			const result = await callTool(dir, {
				output_ref: artifact.ref,
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBeUndefined(); // ParseResultWithSidecar, not error envelope
			expect(parsed.candidates).toBeDefined();
			expect(Array.isArray(parsed.candidates)).toBe(true);
			expect(parsed.candidates.length).toBe(1);
			expect(parsed.candidates[0].candidate_id).toBe('c1');
			expect(parsed.invocation_envelope).toBeDefined();
			expect(parsed.invocation_envelope.source_output_ref).toBe(artifact.ref);
			expect(parsed.invocation_envelope.source_batch_id).toBe(batchId);
			expect(parsed.invocation_envelope.source_lane_id).toBe(laneId);
			expect(parsed.diagnostics).toBeDefined();
			expect(parsed.diagnostics.candidate_count).toBe(1);
		});

		test('response includes all ParseResultWithSidecar fields', async () => {
			const dir = makeTempDir();
			const batchId = 'fields-batch';
			const laneId = 'fields-lane';
			const text = buildCandidateText(beRow('c1'));
			const digest = sha256(text);
			const artifact = buildArtifact({ batchId, laneId, text, digest });
			writeLaneArtifact(dir, artifact);

			const result = await callTool(dir, {
				output_ref: artifact.ref,
			});
			const parsed = JSON.parse(result);

			// Top-level ParseResultWithSidecar fields
			expect('candidates' in parsed).toBe(true);
			expect('invocation_envelope' in parsed).toBe(true);
			expect('diagnostics' in parsed).toBe(true);
			// sidecar_write_error is absent in the happy path
			expect(parsed.sidecar_write_error).toBeUndefined();
		});
	});

	// -----------------------------------------------------------------------
	// Sidecar persistence
	// -----------------------------------------------------------------------
	describe('sidecar persistence', () => {
		test('default options — sidecar JSONL written to .swarm/lane-results/{batchDigest}/candidates.jsonl', async () => {
			const dir = makeTempDir();
			const batchId = 'sidecar-batch';
			const laneId = 'sidecar-lane';
			const text = buildCandidateText(
				beRow(
					'sc1',
					'lane-X',
					'MEDIUM',
					'style',
					'src/b.ts:2',
					'cl',
					'ev',
					'imp',
					'0.8',
				),
			);
			const digest = sha256(text);
			const artifact = buildArtifact({ batchId, laneId, text, digest });
			writeLaneArtifact(dir, artifact);

			const result = await callTool(dir, {
				output_ref: artifact.ref,
			});
			const parsed = JSON.parse(result);
			expect(parsed.candidates.length).toBe(1);

			// Verify the sidecar file was created.
			const batchDigest = sha256(batchId);
			const sidecarPath = path.join(
				dir,
				'.swarm',
				'lane-results',
				batchDigest,
				'candidates.jsonl',
			);
			expect(fs.existsSync(sidecarPath)).toBe(true);
			const lines = fs.readFileSync(sidecarPath, 'utf-8').trim().split('\n');
			// At least 2 lines: envelope + 1 candidate
			expect(lines.length).toBeGreaterThanOrEqual(2);
			const envelope = JSON.parse(lines[0]);
			expect(envelope.record_type).toBe('invocation');
			expect(envelope.source_batch_id).toBe(batchId);
		});

		test('use_lockfile:true — sidecar written with proper-lockfile lock', async () => {
			const dir = makeTempDir();
			const batchId = 'lockfile-batch';
			const laneId = 'lockfile-lane';
			const text = buildCandidateText(beRow('lf1'));
			const digest = sha256(text);
			const artifact = buildArtifact({ batchId, laneId, text, digest });
			writeLaneArtifact(dir, artifact);

			const result = await callTool(dir, {
				output_ref: artifact.ref,
				use_lockfile: true,
			});
			const parsed = JSON.parse(result);
			expect(parsed.candidates.length).toBe(1);
			expect(parsed.sidecar_write_error).toBeUndefined();

			// Sidecar file should be written successfully.
			const batchDigest = sha256(batchId);
			const sidecarPath = path.join(
				dir,
				'.swarm',
				'lane-results',
				batchDigest,
				'candidates.jsonl',
			);
			expect(fs.existsSync(sidecarPath)).toBe(true);
		});

		test('producer field appears in invocation envelope', async () => {
			const dir = makeTempDir();
			const batchId = 'producer-batch';
			const laneId = 'producer-lane';
			const text = buildCandidateText(beRow('p1'));
			const digest = sha256(text);
			const artifact = buildArtifact({ batchId, laneId, text, digest });
			writeLaneArtifact(dir, artifact);

			const result = await callTool(dir, {
				output_ref: artifact.ref,
				producer: 'custom-producer',
			});
			const parsed = JSON.parse(result);
			expect(parsed.invocation_envelope.producer).toBe('custom-producer');
		});
	});

	// -----------------------------------------------------------------------
	// Degraded source
	// -----------------------------------------------------------------------
	describe('degraded source', () => {
		test('degraded:true + accept_degraded:true → candidates parsed, extracted_from_partial_source:true', async () => {
			const dir = makeTempDir();
			const batchId = 'degraded-batch';
			const laneId = 'degraded-lane';
			const text = buildCandidateText(
				beRow(
					'd1',
					'lane-D',
					'HIGH',
					'sec',
					'src/d.ts:1',
					'cl',
					'ev',
					'imp',
					'0.9',
				),
			);
			const digest = sha256(text);
			const artifact = buildArtifact({
				batchId,
				laneId,
				text,
				digest,
				transcriptIncomplete: true,
			});
			writeLaneArtifact(dir, artifact);

			const result = await callTool(dir, {
				output_ref: artifact.ref,
				accept_partial: true,
				accept_degraded: true,
				degraded: true,
			});
			const parsed = JSON.parse(result);
			expect(parsed.candidates.length).toBe(1);
			expect(parsed.candidates[0].extracted_from_partial_source).toBe(true);
			expect(parsed.invocation_envelope.record_type).toBe('invocation');
		});
	});

	// -----------------------------------------------------------------------
	// Optional session fields
	// -----------------------------------------------------------------------
	describe('optional session fields', () => {
		test('artifact without sessionId/parentSessionId → parses correctly', async () => {
			const dir = makeTempDir();
			const batchId = 'no-session-batch';
			const laneId = 'no-session-lane';
			const text = buildCandidateText(beRow('ns1'));
			const digest = sha256(text);
			// Explicitly omit sessionId and parentSessionId
			const artifact = buildArtifact({
				batchId,
				laneId,
				text,
				digest,
				sessionId: undefined,
				parentSessionId: undefined,
			} as Partial<LaneOutputArtifact> as LaneOutputArtifact);
			writeLaneArtifact(dir, artifact);

			const result = await callTool(dir, {
				output_ref: artifact.ref,
			});
			const parsed = JSON.parse(result);
			expect(parsed.candidates.length).toBe(1);
			expect(parsed.candidates[0].sessionId).toBeUndefined();
			expect(parsed.candidates[0].parentSessionId).toBeUndefined();
		});
	});

	// -----------------------------------------------------------------------
	// Artifact → ArtifactInput mapping
	// -----------------------------------------------------------------------
	describe('artifact-to-input mapping', () => {
		test('output_ref maps to artifact.ref', async () => {
			const dir = makeTempDir();
			const batchId = 'map-batch';
			const laneId = 'map-lane';
			const text = buildCandidateText(
				beRow(
					'm1',
					'lane-M',
					'HIGH',
					'sec',
					'src/m.ts:1',
					'cl',
					'ev',
					'imp',
					'0.9',
				),
			);
			const artifact = buildArtifact({
				batchId,
				laneId,
				text,
				agent: 'reviewer',
				role: 'reviewer',
				sessionId: 's-42',
				parentSessionId: 'p-42',
				transcriptIncomplete: true,
			});
			writeLaneArtifact(dir, artifact);

			const result = await callTool(dir, {
				output_ref: artifact.ref,
				accept_partial: true,
			});
			const parsed = JSON.parse(result);
			const expectedDigest = sha256(text);
			expect(parsed.invocation_envelope.source_output_ref).toBe(artifact.ref);
			expect(parsed.invocation_envelope.source_batch_id).toBe(batchId);
			expect(parsed.invocation_envelope.source_lane_id).toBe(laneId);
			expect(parsed.invocation_envelope.source_agent).toBe('reviewer');
			expect(parsed.invocation_envelope.source_digest).toBe(expectedDigest);
			expect(parsed.invocation_envelope.sessionId).toBe('s-42');
			expect(parsed.invocation_envelope.parentSessionId).toBe('p-42');
			expect(parsed.diagnostics.incomplete_source_count).toBe(1);
		});
	});

	// -----------------------------------------------------------------------
	// project_root override
	// -----------------------------------------------------------------------
	describe('project_root override', () => {
		test('project_root overrides sidecar write location', async () => {
			const dir = makeTempDir();
			const customRoot = path.join(dir, '.swarm-test');
			fs.mkdirSync(customRoot, { recursive: true });
			const batchId = 'custom-root-batch';
			const laneId = 'custom-root-lane';
			const text = buildCandidateText(beRow('cr1'));
			const digest = sha256(text);
			const artifact = buildArtifact({ batchId, laneId, text, digest });
			// Write the artifact to dir (where the tool reads from).
			writeLaneArtifact(dir, artifact);

			// Pass customRoot as project_root: the sidecar should be written there,
			// not under dir.
			const result = await callTool(dir, {
				output_ref: artifact.ref,
				project_root: customRoot,
			});
			const parsed = JSON.parse(result);
			expect(parsed.candidates.length).toBe(1);
			expect(parsed.candidates[0].candidate_id).toBe('cr1');

			// Sidecar should be written to customRoot, not dir.
			const batchDigest = sha256(batchId);
			const customSidecarPath = path.join(
				customRoot,
				'.swarm',
				'lane-results',
				batchDigest,
				'candidates.jsonl',
			);
			expect(fs.existsSync(customSidecarPath)).toBe(true);
			const dirSidecarPath = path.join(
				dir,
				'.swarm',
				'lane-results',
				batchDigest,
				'candidates.jsonl',
			);
			expect(fs.existsSync(dirSidecarPath)).toBe(false);
		});

		test('project_root outside the injected directory is rejected — absolute filesystem root', async () => {
			const dir = makeTempDir();
			const batchId = 'outside-root-batch';
			const laneId = 'outside-root-lane';
			const text = buildCandidateText(beRow('out1'));
			const digest = sha256(text);
			const artifact = buildArtifact({ batchId, laneId, text, digest });
			writeLaneArtifact(dir, artifact);

			const outsideRoot = path.sep; // filesystem root, always outside dir
			const result = await callTool(dir, {
				output_ref: artifact.ref,
				project_root: outsideRoot,
			});
			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(false);
			expect(parsed.failure_class).toBe('invalid_args');
			expect(parsed.message).toContain('project_root must resolve');

			// No sidecar should be written at the adversarial location.
			const batchDigest = sha256(batchId);
			const sidecarPath = path.join(
				outsideRoot,
				'.swarm',
				'lane-results',
				batchDigest,
				'candidates.jsonl',
			);
			expect(fs.existsSync(sidecarPath)).toBe(false);
		});

		test('project_root outside the injected directory is rejected — path traversal ..', async () => {
			const dir = makeTempDir();
			const batchId = 'outside-escape-batch';
			const laneId = 'outside-escape-lane';
			const text = buildCandidateText(beRow('esc1'));
			const digest = sha256(text);
			const artifact = buildArtifact({ batchId, laneId, text, digest });
			writeLaneArtifact(dir, artifact);

			const outsideRoot = path.join(dir, '..', 'escape');
			const result = await callTool(dir, {
				output_ref: artifact.ref,
				project_root: outsideRoot,
			});
			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(false);
			expect(parsed.failure_class).toBe('invalid_args');
			expect(parsed.message).toContain('project_root must resolve');

			// No sidecar should be written at the adversarial location.
			const batchDigest = sha256(batchId);
			const sidecarPath = path.join(
				outsideRoot,
				'.swarm',
				'lane-results',
				batchDigest,
				'candidates.jsonl',
			);
			expect(fs.existsSync(sidecarPath)).toBe(false);
		});

		test('project_root outside the injected directory is rejected — resolved via relative traversal', async () => {
			const dir = makeTempDir();
			const batchId = 'outside-dir-batch';
			const laneId = 'outside-dir-lane';
			const text = buildCandidateText(beRow('outdir1'));
			const digest = sha256(text);
			const artifact = buildArtifact({ batchId, laneId, text, digest });
			writeLaneArtifact(dir, artifact);

			const outsideRoot = path.join(dir, '..', 'outside');
			const result = await callTool(dir, {
				output_ref: artifact.ref,
				project_root: outsideRoot,
			});
			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(false);
			expect(parsed.failure_class).toBe('invalid_args');
			expect(parsed.message).toContain('project_root must resolve');

			// No sidecar should be written at the adversarial location.
			const batchDigest = sha256(batchId);
			const sidecarPath = path.join(
				outsideRoot,
				'.swarm',
				'lane-results',
				batchDigest,
				'candidates.jsonl',
			);
			expect(fs.existsSync(sidecarPath)).toBe(false);
		});
	});

	// -----------------------------------------------------------------------
	// Schema validation in response — confirm parsed records have correct shape
	// -----------------------------------------------------------------------
	describe('schema validation in response', () => {
		test('candidate records have expected ParseResultWithSidecar structure', async () => {
			const dir = makeTempDir();
			const batchId = 'struct-batch';
			const laneId = 'struct-lane';
			const text = buildCandidateText(
				beRow(
					's1',
					'lane-S',
					'CRITICAL',
					'security',
					'src/s.ts:1',
					'claim',
					'ev',
					'imp',
					'1.0',
				),
			);
			const digest = sha256(text);
			const artifact = buildArtifact({ batchId, laneId, text, digest });
			writeLaneArtifact(dir, artifact);

			const result = await callTool(dir, { output_ref: artifact.ref });
			const parsed = JSON.parse(result);

			// Top-level structure
			expect(parsed).toHaveProperty('candidates');
			expect(parsed).toHaveProperty('invocation_envelope');
			expect(parsed).toHaveProperty('diagnostics');

			// Invocation envelope fields
			const env = parsed.invocation_envelope;
			expect(env).toHaveProperty('record_type', 'invocation');
			expect(env).toHaveProperty('source_output_ref');
			expect(env).toHaveProperty('source_batch_id');
			expect(env).toHaveProperty('source_lane_id');
			expect(env).toHaveProperty('source_agent');
			expect(env).toHaveProperty('source_digest');
			expect(env).toHaveProperty('row_format_version', 1);
			expect(env).toHaveProperty('produced_at');
			expect(env).toHaveProperty('record_version');
			expect(env.record_version).toEqual({ major: 1, minor: 0 });
			expect(env).toHaveProperty('format_families_detected');
			expect(env).toHaveProperty('candidate_count');
			expect(env).toHaveProperty('parse_errors');
			expect(env).toHaveProperty('malformed_rows');

			// Candidate record fields
			const c = parsed.candidates[0];
			expect(c).toHaveProperty('record_type', 'candidate');
			expect(c).toHaveProperty('row_format_family');
			expect(c).toHaveProperty('row_format_version', 1);
			expect(c).toHaveProperty('record_version', { major: 1, minor: 0 });
			expect(c).toHaveProperty('source_output_ref');
			expect(c).toHaveProperty('source_batch_id');
			expect(c).toHaveProperty('source_lane_id');
			expect(c).toHaveProperty('source_agent');
			expect(c).toHaveProperty('source_digest');
			expect(c).toHaveProperty('extracted_from_partial_source');
			expect(c).toHaveProperty('candidate_id');
			expect(c).toHaveProperty('lane');
			expect(c).toHaveProperty('micro_lane');
			expect(c).toHaveProperty('severity');
			expect(c).toHaveProperty('category');
			expect(c).toHaveProperty('file_line');
			expect(c).toHaveProperty('claim');
			expect(c).toHaveProperty('evidence_summary');
			expect(c).toHaveProperty('impact_context');
			expect(c).toHaveProperty('invariant_violated');
			expect(c).toHaveProperty('confidence');

			// Diagnostics fields
			const diag = parsed.diagnostics;
			expect(diag).toHaveProperty('candidate_count');
			expect(diag).toHaveProperty('parse_errors');
			expect(diag).toHaveProperty('parse_error_details');
			expect(diag).toHaveProperty('malformed_rows');
			expect(diag).toHaveProperty('duplicate_id_count');
			expect(diag).toHaveProperty('duplicate_id_warnings');
			expect(diag).toHaveProperty('degraded_source_count');
			expect(diag).toHaveProperty('incomplete_source_count');
			expect(diag).toHaveProperty('format_families_detected');
		});
	});
});
