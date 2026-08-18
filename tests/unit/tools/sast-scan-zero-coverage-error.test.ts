/**
 * sast_scan zero-coverage error payload — issue #2210.
 *
 * Split into its own file (FR-006 ratchet: tests/unit/tools/sast-scan.test.ts
 * is over the 500-line cap and must not grow). A zero-file scan must return
 * verdict 'fail' WITH an explicit `error` reason (mirroring capture_baseline's
 * contract) so pre_check_batch and other consumers never mistake the failure
 * for findings above threshold.
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { type SastScanInput, sastScan } from '../../../src/tools/sast-scan';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

// No evidence-manager mock needed: the tempdir is a standalone project root,
// so the real saveEvidence writes land harmlessly inside it.

describe('sast_scan zero-coverage error payload (#2210)', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = canonicalMkdtemp('sast-zero-2210-');
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

	test('all files skipped (unsupported language) also carries the error reason', async () => {
		const skipped = path.join(tempDir, 'unsupported.xyz');
		fs.writeFileSync(skipped, 'content');
		const result = await sastScan({ changed_files: [skipped] }, tempDir);
		expect(result.summary.files_scanned).toBe(0);
		expect(result.verdict).toBe('fail');
		expect(result.error).toBe(
			'SAST requires at least one file to scan; zero files were scanned',
		);
	});
});
