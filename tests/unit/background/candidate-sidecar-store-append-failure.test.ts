/**
 * SC-023 — sidecar append failure handling (split from
 * candidate-sidecar-store.test.ts, FR-006 file cap).
 *
 * These tests use mock.module('node:fs'). Bun's mock.module patches the
 * ORIGINAL module's export slots retroactively, and mock.restore() does NOT
 * undo the replacement — the describe's afterEach therefore re-installs the
 * ORIGINAL appendFileSync (captured before any mock) via mock.module, so the
 * pollution cannot leak into later-loaded test files in the same process.
 *
 * The file is self-contained: it has NO top-level parseAndPersist import
 * (every test dynamic-imports the parser AFTER installing its mock), so the
 * old "MUST run LAST" ordering constraint from the original file does not
 * apply here. The afterEach repair keeps node:fs pristine for every
 * later-loaded test file in the process.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import fs, * as realFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
	ArtifactInput,
	ParseFlags,
} from '../../../src/background/candidate-parser';

// ---------------------------------------------------------------------------
// Minimal local fixtures (duplicated from candidate-sidecar-store.test.ts)
// ---------------------------------------------------------------------------

/** Tracked temp directories for afterEach cleanup. */
const tmpDirs: string[] = [];

/** Create a canonical resolved temp directory and register for cleanup. */
function makeTempDir(): string {
	const dir = fs.realpathSync(canonicalMkdtemp('sidecar-store-'));
	tmpDirs.push(dir);
	return dir;
}

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
	'[CANDIDATE] | candidate_id | lane | severity | category | file:line | claim | evidence_summary | impact_context | confidence | risk_impact | risk_tags';

function beRow(
	c1: string,
	c2 = 'lane-A',
	c3 = 'HIGH',
	c4 = 'security',
	c5 = 'src/foo.ts:10',
	c6 = 'claim1',
	c7 = 'evidence1',
	c8 = 'impact1',
	c9 = 'HIGH',
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
// SC-023 — Append failure handling (uses mock.module; see file header)
// ---------------------------------------------------------------------------

describe('SC-023 — sidecar append failure does not fail the parse', () => {
	// r15 audit repair (Phase 6 — test isolation): Bun's mock.module
	// retroactively patches the ORIGINAL module's export slots, and
	// mock.restore() does NOT undo a mock.module replacement (verified by a
	// minimal two-file reproducer). Spreading `...realFs` after a previous
	// mock therefore re-installs the MOCKED functions — the previous
	// afterEach left the throwing appendFileSync in place for every
	// later-loaded module in the process, polluting unrelated test files
	// (94 artificial failures in the full background suite). Restoring the
	// ORIGINAL function reference captured BEFORE any mock — re-installed
	// via mock.module in afterEach — puts the real export slots back for
	// all holders (Bun patches the same slots in place again).
	const realAppendFileSync = realFs.appendFileSync;

	afterEach(() => {
		mock.restore();
		mock.module('node:fs', () => ({
			...realFs,
			appendFileSync: realAppendFileSync,
		}));
	});

	// We use mock.module to replace node:fs BEFORE parseAndPersist runs.
	// The mock is installed per-test via dynamic import so the module
	// binding is captured with the mock in place.
	//
	// Bun's mock.module replaces the module in the cache. Subsequent imports
	// of 'node:fs' get the mock. Because we use a dynamic import AFTER
	// installing the mock, the candidate-parser module (and its transitive
	// import of candidate-sidecar-store) gets the mocked fs.

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
