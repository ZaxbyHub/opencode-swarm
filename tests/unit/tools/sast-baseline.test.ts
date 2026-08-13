/**
 * SAST Baseline Tool Tests
 * Comprehensive tests covering:
 * - normalizeFindingPath
 * - fingerprintFinding (stable/unstable, line-edge, path-escape)
 * - assignOccurrenceIndices (single, copy-paste duplicates)
 * - captureOrMergeBaseline (validation, first write, merge, size cap, prune)
 * - loadBaseline (not_found, found, invalid_schema)
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
	assignOccurrenceIndices,
	BASELINE_SCHEMA_VERSION,
	captureOrMergeBaseline,
	fingerprintFinding,
	loadBaseline,
	MAX_BASELINE_FINDINGS,
	normalizeFindingPath,
} from '../../../src/tools/sast-baseline';
import type { SastScanFinding } from '../../../src/tools/sast-scan';

// ============ Helpers ============

function makeFinding(
	file: string,
	line: number,
	ruleId = 'sast/js-eval',
	severity: SastScanFinding['severity'] = 'high',
): SastScanFinding {
	return {
		rule_id: ruleId,
		severity,
		message: 'Test finding',
		location: { file, line },
	};
}

describe('sast-baseline', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(tmpdir(), 'sast-baseline-test-'));
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	// ============ normalizeFindingPath ============

	describe('normalizeFindingPath', () => {
		it('converts an absolute path inside directory to a relative path', () => {
			const file = path.join(tempDir, 'src', 'foo.js');
			const rel = normalizeFindingPath(tempDir, file);
			expect(rel).toBe('src/foo.js');
		});

		it('converts a relative path by resolving against directory', () => {
			const rel = normalizeFindingPath(tempDir, 'src/bar.ts');
			expect(rel).toBe('src/bar.ts');
		});

		it('replaces backslashes with forward slashes', () => {
			// Construct a path with backslashes manually to test the replacement
			const winStyle = path.join(tempDir, 'src', 'foo.js').replace(/\//g, '\\');
			const rel = normalizeFindingPath(tempDir, winStyle);
			expect(rel).not.toContain('\\');
		});

		it('path outside directory starts with ..', () => {
			const outsideFile = path.join(path.dirname(tempDir), 'other', 'evil.js');
			const rel = normalizeFindingPath(tempDir, outsideFile);
			expect(rel.startsWith('..')).toBe(true);
		});

		it('root-level file in directory returns just the filename', () => {
			const file = path.join(tempDir, 'index.js');
			const rel = normalizeFindingPath(tempDir, file);
			expect(rel).toBe('index.js');
		});
	});

	// ============ fingerprintFinding ============

	describe('fingerprintFinding', () => {
		it('returns stable:true and consistent fingerprint when file is readable', () => {
			const file = path.join(tempDir, 'test.js');
			fs.writeFileSync(file, 'line1\neval(x);\nline3\n');
			const finding = makeFinding(file, 2);

			const r1 = fingerprintFinding(finding, tempDir, 0);
			const r2 = fingerprintFinding(finding, tempDir, 0);

			expect(r1.stable).toBe(true);
			expect(r1.fingerprint).toBe(r2.fingerprint);
			expect(r1.fingerprint).not.toContain('UNSTABLE');
		});

		it('produces different fingerprints for different file content at same line', () => {
			const file = path.join(tempDir, 'test.js');
			fs.writeFileSync(file, 'line1\neval(x);\nline3\n');
			const finding = makeFinding(file, 2);
			const r1 = fingerprintFinding(finding, tempDir, 0);

			fs.writeFileSync(file, 'line1\neval(y);\nline3\n');
			const r2 = fingerprintFinding(finding, tempDir, 0);

			expect(r1.fingerprint).not.toBe(r2.fingerprint);
		});

		it('returns stable:false when file is unreadable (non-root, non-Windows only)', () => {
			if (process.getuid && process.getuid() === 0) {
				// root ignores chmod — skip
				return;
			}
			if (process.platform === 'win32') {
				// Windows permissions don't work the same way — skip
				return;
			}
			const file = path.join(tempDir, 'unreadable.js');
			fs.writeFileSync(file, 'eval(x);');
			fs.chmodSync(file, 0o000);

			const finding = makeFinding(file, 1);
			const result = fingerprintFinding(finding, tempDir, 0);

			// restore for cleanup
			fs.chmodSync(file, 0o644);

			expect(result.stable).toBe(false);
			expect(result.fingerprint).toContain('UNSTABLE');
		});

		it('returns stable:false when path escapes workspace (starts with ..)', () => {
			const outsideFile = path.join(path.dirname(tempDir), 'evil.js');
			// We do NOT create the file — the path-escape check happens before file I/O
			const finding = makeFinding(outsideFile, 1);
			const result = fingerprintFinding(finding, tempDir, 0);

			expect(result.stable).toBe(false);
			expect(result.fingerprint).toContain('UNSTABLE');
		});

		it('includes occurrence index in fingerprint', () => {
			const file = path.join(tempDir, 'test.js');
			fs.writeFileSync(file, 'eval(x);');
			const finding = makeFinding(file, 1);

			const r0 = fingerprintFinding(finding, tempDir, 0);
			const r1 = fingerprintFinding(finding, tempDir, 1);

			expect(r0.fingerprint).toContain('#0');
			expect(r1.fingerprint).toContain('#1');
			expect(r0.fingerprint).not.toBe(r1.fingerprint);
		});

		// Line-edge tests
		it('does not throw and returns stable:true for a finding on line 1', () => {
			const file = path.join(tempDir, 'edge.js');
			fs.writeFileSync(file, 'eval(x);\nline2\nline3\n');
			const finding = makeFinding(file, 1);

			let result: ReturnType<typeof fingerprintFinding> | undefined;
			expect(() => {
				result = fingerprintFinding(finding, tempDir, 0);
			}).not.toThrow();
			expect(result!.stable).toBe(true);
		});

		it('does not throw and returns stable:true for a finding on the last line', () => {
			const content = 'line1\nline2\neval(x);';
			const file = path.join(tempDir, 'edge-last.js');
			fs.writeFileSync(file, content);
			const lines = content.split('\n');
			const lastLine = lines.length;
			const finding = makeFinding(file, lastLine);

			let result: ReturnType<typeof fingerprintFinding> | undefined;
			expect(() => {
				result = fingerprintFinding(finding, tempDir, 0);
			}).not.toThrow();
			expect(result!.stable).toBe(true);
		});

		// Path-escape via finding.location.file
		it('returns stable:false when finding.location.file is outside directory', () => {
			const outsideFile = path.resolve(tempDir, '..', 'outside.js');
			const finding = makeFinding(outsideFile, 1);
			const result = fingerprintFinding(finding, tempDir, 0);

			expect(result.stable).toBe(false);
		});
	});

	// ============ assignOccurrenceIndices ============

	describe('assignOccurrenceIndices', () => {
		it('assigns index 0 to a single finding', () => {
			const file = path.join(tempDir, 'single.js');
			fs.writeFileSync(file, 'eval(x);');
			const findings = [makeFinding(file, 1)];

			const indexed = assignOccurrenceIndices(findings, tempDir);

			expect(indexed).toHaveLength(1);
			expect(indexed[0].index).toBe(0);
			expect(indexed[0].fingerprint).toContain('#0');
		});

		it('assigns different indices to two identical findings on the same line (copy-paste)', () => {
			const file = path.join(tempDir, 'copypaste.js');
			// Both findings point to the same line with the same rule — same content window
			fs.writeFileSync(file, 'eval(x);\n');
			const f1 = makeFinding(file, 1);
			const f2 = makeFinding(file, 1);
			const findings = [f1, f2];

			const indexed = assignOccurrenceIndices(findings, tempDir);

			expect(indexed).toHaveLength(2);
			expect(indexed[0].index).toBe(0);
			expect(indexed[1].index).toBe(1);
			// Fingerprints must differ
			expect(indexed[0].fingerprint).not.toBe(indexed[1].fingerprint);
			expect(indexed[0].fingerprint).toContain('#0');
			expect(indexed[1].fingerprint).toContain('#1');
		});

		it('assigns independent indices to findings on different lines', () => {
			const file = path.join(tempDir, 'multiline.js');
			fs.writeFileSync(file, 'eval(a);\neval(b);\neval(c);\n');
			const findings = [
				makeFinding(file, 1),
				makeFinding(file, 2),
				makeFinding(file, 3),
			];

			const indexed = assignOccurrenceIndices(findings, tempDir);

			// Each different line gives a different base key → each gets index 0
			expect(indexed[0].index).toBe(0);
			expect(indexed[1].index).toBe(0);
			expect(indexed[2].index).toBe(0);
			// All fingerprints are distinct
			const fps = indexed.map((i) => i.fingerprint);
			expect(new Set(fps).size).toBe(3);
		});
	});

	// ============ captureOrMergeBaseline ============

	describe('captureOrMergeBaseline', () => {
		it('rejects phase 0 with status:error', async () => {
			const file = path.join(tempDir, 'test.js');
			fs.writeFileSync(file, 'eval(x);');
			const result = await captureOrMergeBaseline(
				tempDir,
				0,
				[makeFinding(file, 1)],
				'tier_a',
				[file],
			);
			expect(result.status).toBe('error');
		});

		it('rejects phase -1 with status:error', async () => {
			const file = path.join(tempDir, 'test.js');
			fs.writeFileSync(file, 'eval(x);');
			const result = await captureOrMergeBaseline(
				tempDir,
				-1,
				[makeFinding(file, 1)],
				'tier_a',
				[file],
			);
			expect(result.status).toBe('error');
		});

		it('rejects empty scannedFiles with status:error', async () => {
			const result = await captureOrMergeBaseline(tempDir, 1, [], 'tier_a', []);
			expect(result.status).toBe('error');
		});

		it('first write produces status:written', async () => {
			const file = path.join(tempDir, 'app.js');
			fs.writeFileSync(file, 'eval(x);');
			const finding = makeFinding(file, 1);

			const result = await captureOrMergeBaseline(
				tempDir,
				1,
				[finding],
				'tier_a',
				[file],
			);

			expect(result.status).toBe('written');
			if (result.status === 'written') {
				expect(result.fingerprint_count).toBe(1);
				expect(typeof result.path).toBe('string');
			}
		});

		it('second call with same files produces status:merged', async () => {
			const file = path.join(tempDir, 'app.js');
			fs.writeFileSync(file, 'eval(x);');
			const finding = makeFinding(file, 1);

			await captureOrMergeBaseline(tempDir, 1, [finding], 'tier_a', [file]);

			const result2 = await captureOrMergeBaseline(
				tempDir,
				1,
				[finding],
				'tier_a',
				[file],
			);

			expect(result2.status).toBe('merged');
		});

		it('second call updates fingerprints when content changes (stale replaced)', async () => {
			const file = path.join(tempDir, 'changing.js');
			fs.writeFileSync(file, 'eval(old);');
			const findingV1 = makeFinding(file, 1);

			const r1 = await captureOrMergeBaseline(
				tempDir,
				1,
				[findingV1],
				'tier_a',
				[file],
			);
			expect(r1.status).toBe('written');

			// Load baseline v1 — record original fingerprints
			const loadedV1 = loadBaseline(tempDir, 1);
			expect(loadedV1.status).toBe('found');
			const fpsV1 =
				loadedV1.status === 'found' ? Array.from(loadedV1.fingerprints) : [];

			// Change content and re-capture
			fs.writeFileSync(file, 'eval(new_value);');
			const findingV2 = makeFinding(file, 1);

			const r2 = await captureOrMergeBaseline(
				tempDir,
				1,
				[findingV2],
				'tier_a',
				[file],
			);
			expect(r2.status).toBe('merged');

			const loadedV2 = loadBaseline(tempDir, 1);
			expect(loadedV2.status).toBe('found');
			const fpsV2 =
				loadedV2.status === 'found' ? Array.from(loadedV2.fingerprints) : [];

			// Old fingerprint must not appear in new baseline
			for (const oldFp of fpsV1) {
				expect(fpsV2).not.toContain(oldFp);
			}
		});

		it('incremental merge of disjoint file sets — both files indexed after two captures', async () => {
			const fileA = path.join(tempDir, 'a.js');
			const fileB = path.join(tempDir, 'b.js');
			fs.writeFileSync(fileA, 'eval(a);');
			fs.writeFileSync(fileB, 'eval(b);');

			// First capture: file A only
			await captureOrMergeBaseline(
				tempDir,
				1,
				[makeFinding(fileA, 1)],
				'tier_a',
				[fileA],
			);

			// Second capture: file B only
			const r2 = await captureOrMergeBaseline(
				tempDir,
				1,
				[makeFinding(fileB, 1)],
				'tier_a',
				[fileB],
			);
			expect(r2.status).toBe('merged');

			// Both should be indexed
			const loaded = loadBaseline(tempDir, 1);
			expect(loaded.status).toBe('found');
			if (loaded.status === 'found') {
				const relA = path.relative(tempDir, fileA).replace(/\\/g, '/');
				const relB = path.relative(tempDir, fileB).replace(/\\/g, '/');
				expect(loaded.bundle.files_indexed).toContain(relA);
				expect(loaded.bundle.files_indexed).toContain(relB);
				expect(loaded.fingerprints.size).toBe(2);
			}
		});

		it('returns status:error when JSON would exceed MAX_BASELINE_BYTES', async () => {
			// Create a finding with an enormous message to inflate JSON size
			const file = path.join(tempDir, 'big.js');
			fs.writeFileSync(file, 'eval(x);');

			// Build findings list with massive payloads that exceed 2MB
			const bigMessage = 'x'.repeat(100_000);
			const findings: SastScanFinding[] = Array.from(
				{ length: 30 },
				(_, i) => ({
					rule_id: 'sast/js-eval',
					severity: 'high' as const,
					message: bigMessage,
					location: { file, line: i + 1 },
					remediation: bigMessage,
				}),
			);

			const result = await captureOrMergeBaseline(
				tempDir,
				1,
				findings,
				'tier_a',
				[file],
			);

			expect(result.status).toBe('error');
			if (result.status === 'error') {
				expect(result.message).toContain('size cap');
			}
		});
	});

	// ============ Full prune on re-scan ============

	describe('Full prune on re-scan', () => {
		it('old fingerprints for file A are gone after re-capturing file A with new findings', async () => {
			const fileA = path.join(tempDir, 'prune.js');
			fs.writeFileSync(fileA, 'eval(original);');

			// First capture
			const r1 = await captureOrMergeBaseline(
				tempDir,
				1,
				[makeFinding(fileA, 1)],
				'tier_a',
				[fileA],
			);
			expect(r1.status).toBe('written');

			const loadedV1 = loadBaseline(tempDir, 1);
			expect(loadedV1.status).toBe('found');
			const originalFps =
				loadedV1.status === 'found' ? Array.from(loadedV1.fingerprints) : [];
			expect(originalFps.length).toBeGreaterThan(0);

			// Change file content and re-capture with a different finding
			fs.writeFileSync(fileA, 'eval(updated_content);');
			const r2 = await captureOrMergeBaseline(
				tempDir,
				1,
				[makeFinding(fileA, 1, 'sast/js-dangerous-function')],
				'tier_a',
				[fileA],
			);
			expect(r2.status).toBe('merged');

			const loadedV2 = loadBaseline(tempDir, 1);
			expect(loadedV2.status).toBe('found');
			if (loadedV2.status === 'found') {
				for (const oldFp of originalFps) {
					expect(loadedV2.fingerprints.has(oldFp)).toBe(false);
				}
			}
		});
	});

	// ============ loadBaseline ============

	describe('loadBaseline', () => {
		it('returns not_found for a missing baseline file', () => {
			const result = loadBaseline(tempDir, 1);
			expect(result.status).toBe('not_found');
		});

		it('returns found with correct Set of fingerprints after a write', async () => {
			const file = path.join(tempDir, 'load-test.js');
			fs.writeFileSync(file, 'eval(x);');

			const captureResult = await captureOrMergeBaseline(
				tempDir,
				1,
				[makeFinding(file, 1)],
				'tier_a',
				[file],
			);
			expect(captureResult.status).toBe('written');

			const loaded = loadBaseline(tempDir, 1);
			expect(loaded.status).toBe('found');
			if (loaded.status === 'found') {
				expect(loaded.fingerprints instanceof Set).toBe(true);
				expect(loaded.fingerprints.size).toBe(1);
				expect(loaded.bundle.schema_version).toBe(BASELINE_SCHEMA_VERSION);
				expect(loaded.bundle.phase).toBe(1);
			}
		});

		it('returns invalid_schema for phase 0', () => {
			const result = loadBaseline(tempDir, 0);
			expect(result.status).toBe('invalid_schema');
		});

		it('returns invalid_schema for corrupted JSON', () => {
			// Manually write a corrupted baseline file
			const evidenceDir = path.join(tempDir, '.swarm', 'evidence', '1');
			fs.mkdirSync(evidenceDir, { recursive: true });
			fs.writeFileSync(
				path.join(evidenceDir, 'sast-baseline.json'),
				'{ this is not valid JSON !!!',
			);

			const result = loadBaseline(tempDir, 1);
			expect(result.status).toBe('invalid_schema');
		});

		it('returns invalid_schema for a baseline with wrong schema_version', () => {
			const evidenceDir = path.join(tempDir, '.swarm', 'evidence', '2');
			fs.mkdirSync(evidenceDir, { recursive: true });
			const badBundle = {
				schema_version: '0.0.1',
				phase: 2,
				created_at: new Date().toISOString(),
				updated_at: new Date().toISOString(),
				engine: 'tier_a',
				files_indexed: [],
				fingerprints: [],
				findings_snapshot: [],
				truncated: false,
			};
			fs.writeFileSync(
				path.join(evidenceDir, 'sast-baseline.json'),
				JSON.stringify(badBundle, null, 2),
			);

			const result = loadBaseline(tempDir, 2);
			expect(result.status).toBe('invalid_schema');
		});

		it('returns invalid_schema for a baseline with missing fingerprints array', () => {
			const evidenceDir = path.join(tempDir, '.swarm', 'evidence', '3');
			fs.mkdirSync(evidenceDir, { recursive: true });
			const badBundle = {
				schema_version: BASELINE_SCHEMA_VERSION,
				phase: 3,
				created_at: new Date().toISOString(),
				updated_at: new Date().toISOString(),
				engine: 'tier_a',
				files_indexed: [],
				// fingerprints deliberately omitted
				findings_snapshot: [],
				truncated: false,
			};
			fs.writeFileSync(
				path.join(evidenceDir, 'sast-baseline.json'),
				JSON.stringify(badBundle, null, 2),
			);

			const result = loadBaseline(tempDir, 3);
			expect(result.status).toBe('invalid_schema');
		});
	});
});
