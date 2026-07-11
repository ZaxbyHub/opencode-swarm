/**
 * ADVERSARIAL TESTS: SAST Scan - Zero Coverage Fail-Closed
 *
 * These tests validate that SAST scan cannot be bypassed by providing:
 * - empty files list
 * - invalid non-existent paths
 * - unsupported file types
 * - Verify enabled-mode zero coverage returns FAIL (not PASS)
 */

import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from 'bun:test';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { sastScan } from '../../../src/tools/sast-scan';

const BASELINE_COVERAGE_ERROR =
	'capture_baseline requires changed_files to produce a non-empty baseline';

describe('SAST Scan - Adversarial Tests (R2)', () => {
	const MOCK_DIR = process.cwd();

	beforeEach(() => {
		// Mock fs.existsSync to return false for non-existent paths
		spyOn(fs, 'existsSync').mockImplementation((path: any) => {
			const pathStr = String(path);
			return (
				pathStr === MOCK_DIR ||
				pathStr.includes('valid') ||
				pathStr.includes('exists')
			);
		});

		// Mock fs.statSync
		spyOn(fs, 'statSync').mockReturnValue({ size: 100 } as any);

		// Mock fs.readFileSync
		spyOn(fs, 'readFileSync').mockReturnValue('code content');

		// Mock fs.openSync, readSync, closeSync for binary detection
		spyOn(fs, 'openSync').mockReturnValue(0);
		spyOn(fs, 'readSync').mockReturnValue(12);
		spyOn(fs, 'closeSync').mockReturnValue(undefined);
	});

	afterEach(() => {
		mock.restore();
	});

	/**
	 * ATTACK VECTOR 1: Empty files list
	 * Attempt to bypass by providing empty array
	 */
	it('empty files list → FAIL (zero coverage)', async () => {
		const result = await sastScan({ changed_files: [] }, MOCK_DIR);
		expect(result.verdict).toBe('fail');
		expect(result.summary.files_scanned).toBe(0);
	});

	it('empty baseline capture fails with an actionable error', async () => {
		const result = await sastScan(
			{ changed_files: [], capture_baseline: true, phase: 1 },
			MOCK_DIR,
		);

		expect(result.verdict).toBe('fail');
		expect(result.error).toBe(BASELINE_COVERAGE_ERROR);
		expect(result.summary.files_scanned).toBe(0);
	});

	/**
	 * ATTACK VECTOR 2: Invalid non-existent paths
	 * Attempt to bypass by providing paths that don't exist
	 */
	it('invalid non-existent paths → FAIL (zero coverage)', async () => {
		const existsSyncMock = spyOn(fs, 'existsSync').mockReturnValue(false);

		const result = await sastScan(
			{ changed_files: ['/nonexistent/file.ts', '../outside/file.js'] },
			MOCK_DIR,
		);

		expect(result.verdict).toBe('fail');
		expect(result.summary.files_scanned).toBe(0);

		existsSyncMock.mockRestore();
	});

	/**
	 * ATTACK VECTOR 3: Unsupported file types
	 * Attempt to bypass by using file types with no language support
	 */
	it('unsupported file types → FAIL (zero coverage)', async () => {
		const existsSyncMock = spyOn(fs, 'existsSync').mockReturnValue(true);

		const result = await sastScan(
			{ changed_files: ['test.xyz', 'data.unknown', 'file.badext'] },
			MOCK_DIR,
		);

		expect(result.verdict).toBe('fail');
		expect(result.summary.files_scanned).toBe(0);

		existsSyncMock.mockRestore();
	});

	it('baseline capture fails when every requested file is unscannable', async () => {
		const result = await sastScan(
			{
				changed_files: ['missing.ts', 'README.md'],
				capture_baseline: true,
				phase: 1,
			},
			MOCK_DIR,
		);

		expect(result.verdict).toBe('fail');
		expect(result.error).toBe(BASELINE_COVERAGE_ERROR);
		expect(result.summary.files_scanned).toBe(0);
	});

	it('baseline capture allows a supported file with zero findings', async () => {
		mock.restore();
		const tempDir = fs.mkdtempSync(
			path.join(tmpdir(), 'sast-valid-baseline-test-'),
		);
		const testFile = path.join(tempDir, 'valid.ts');
		fs.writeFileSync(testFile, 'const answer = 42;');

		try {
			const result = await sastScan(
				{ changed_files: [testFile], capture_baseline: true, phase: 1 },
				tempDir,
			);

			expect(result.verdict).toBe('pass');
			expect(result.error).toBeUndefined();
			expect(result.status).toBe('baseline_captured');
			expect(result.finding_count).toBe(0);
			expect(result.summary.files_scanned).toBe(1);
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	/**
	 * ATTACK VECTOR 4: Enabled mode with zero coverage must FAIL (not PASS)
	 * This is the critical security invariant - zero coverage cannot be treated as success
	 */
	it('enabled mode with zero coverage → FAIL (not pass)', async () => {
		const result = await sastScan({ changed_files: [] }, MOCK_DIR, {
			gates: {
				syntax_check: { enabled: true },
				placeholder_scan: {
					enabled: true,
					deny_patterns: [],
					allow_globs: [],
					max_allowed_findings: 0,
				},
				sast_scan: { enabled: true },
				sbom_generate: { enabled: true },
				build_check: { enabled: true },
				quality_budget: { enabled: true },
			},
		} as any);
		expect(result.verdict).toBe('fail');
	});

	/**
	 * ATTACK VECTOR 5: Disabled mode bypasses zero coverage (control test)
	 * When feature is disabled, zero coverage should return PASS
	 */
	it('disabled mode bypasses zero coverage → PASS (control test)', async () => {
		const result = await sastScan(
			{ changed_files: [], capture_baseline: true, phase: 1 },
			MOCK_DIR,
			{
				gates: {
					syntax_check: { enabled: true },
					placeholder_scan: {
						enabled: true,
						deny_patterns: [],
						allow_globs: [],
						max_allowed_findings: 0,
					},
					sast_scan: { enabled: false },
					sbom_generate: { enabled: true },
					build_check: { enabled: true },
					quality_budget: { enabled: true },
				},
			} as any,
		);
		expect(result.verdict).toBe('pass');
		expect(result.error).toBeUndefined();
	});
});
