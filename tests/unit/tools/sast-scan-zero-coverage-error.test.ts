/**
 * sast_scan zero-coverage payload — issues #2210 + #2271 bug 3.
 *
 * Split into its own file (FR-006 ratchet: tests/unit/tools/sast-scan.test.ts
 * is over the 500-line cap and must not grow).
 *
 * #2210: a zero-file scan with NOTHING legitimate to scan (empty input, or
 * scannable files that could not be scanned) must return verdict 'fail' WITH
 * an explicit `error` reason so pre_check_batch and other consumers never
 * mistake the failure for findings above threshold.
 *
 * #2271 bug 3: a diff consisting ONLY of files with no SAST language profile
 * (markdown, JSON, unknown-but-non-code extensions) is a legitimate
 * nothing-to-scan PASS — hard-failing it wedged every markdown-only task in
 * rework_required and blocked reviewer dispatch with
 * TASK_WORKFLOW_STAGE_A_REQUIRED. Such a scan passes with
 * `summary.files_skipped_non_code` explaining why zero files were scanned.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { type SastScanInput, sastScan } from '../../../src/tools/sast-scan';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

// No evidence-manager mock needed: the tempdir is a standalone project root,
// so the real saveEvidence writes land harmlessly inside it.

describe('sast_scan zero-coverage payload (#2210 + #2271 bug 3)', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = canonicalMkdtemp('sast-zero-2210-');
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test('empty changed_files returns verdict fail with an explicit error reason', async () => {
		const input: SastScanInput = {
			changed_files: [],
			severity_threshold: 'medium',
		};
		const result = await sastScan(input, tempDir);
		expect(result.verdict).toBe('fail');
		expect(result.findings).toEqual([]);
		expect(result.summary.files_scanned).toBe(0);
		expect(result.error).toBe(
			'SAST requires at least one file to scan; zero files were scanned',
		);
	});

	test('non-code-only input (markdown/JSON/unknown) passes with files_skipped_non_code (#2271 bug 3)', async () => {
		const doc = path.join(tempDir, 'README.md');
		fs.writeFileSync(doc, '# Docs-only change\n');
		const config = path.join(tempDir, 'config.json');
		fs.writeFileSync(config, '{"a":1}');
		const unknown = path.join(tempDir, 'notes.xyz');
		fs.writeFileSync(unknown, 'content');

		const result = await sastScan(
			{ changed_files: [doc, config, unknown], severity_threshold: 'medium' },
			tempDir,
		);
		expect(result.verdict).toBe('pass');
		expect(result.error).toBeUndefined();
		expect(result.findings).toEqual([]);
		expect(result.summary.files_scanned).toBe(0);
		expect(result.summary.files_skipped_non_code).toBe(3);
	});

	test('scannable-but-unscannable input (oversized code file) still fails closed', async () => {
		// A real code file that cannot be scanned (size cap) is a coverage
		// failure, not a non-code pass.
		const bigTs = path.join(tempDir, 'big.ts');
		fs.writeFileSync(bigTs, 'export const x = 1;\n'.repeat(500_000));
		const result = await sastScan({ changed_files: [bigTs] }, tempDir);
		expect(result.verdict).toBe('fail');
		expect(result.error).toBe(
			'SAST requires at least one file to scan; zero files were scanned',
		);
	});

	test('mixed input (markdown + missing code file) is not a clean non-code pass', async () => {
		const doc = path.join(tempDir, 'README.md');
		fs.writeFileSync(doc, '# Docs\n');
		const result = await sastScan(
			{ changed_files: [doc, 'src/missing.ts'] },
			tempDir,
		);
		// The missing .ts should have been scanned — zero coverage is a real
		// failure here, so the hard fail stays.
		expect(result.verdict).toBe('fail');
		expect(result.error).toBe(
			'SAST requires at least one file to scan; zero files were scanned',
		);
	});
});
