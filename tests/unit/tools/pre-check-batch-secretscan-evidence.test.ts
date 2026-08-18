import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SecretscanEvidence } from '../../../src/config/evidence-schema';
import {
	_internals,
	type PreCheckBatchInput,
	runPreCheckBatch,
} from '../../../src/tools/pre-check-batch';

// Mock the tool modules
const mockDetectAvailableLinter = mock(async () => 'biome');
const mockRunLint = mock(async () => ({
	success: true,
	mode: 'check',
	linter: 'biome' as const,
	command: ['biome', 'check', '.'],
	exitCode: 0,
	output: '',
	message: 'No issues found',
}));
const mockSastScan = mock(async () => ({
	verdict: 'pass' as const,
	findings: [],
	summary: {
		engine: 'tier_a' as const,
		files_scanned: 0,
		findings_count: 0,
		findings_by_severity: {
			critical: 0,
			high: 0,
			medium: 0,
			low: 0,
		},
	},
}));
const mockQualityBudget = mock(async () => ({
	verdict: 'pass' as const,
	metrics: {
		complexity_delta: 0,
		public_api_delta: 0,
		duplication_ratio: 0,
		test_to_code_ratio: 0,
		thresholds: {
			max_complexity_delta: 5,
			max_public_api_delta: 10,
			max_duplication_ratio: 0.05,
			min_test_to_code_ratio: 0.3,
		},
	},
	violations: [],
	summary: {
		files_analyzed: 0,
		violations_count: 0,
		errors_count: 0,
		warnings_count: 0,
	},
}));

mock.module('../../../src/tools/lint', () => ({
	detectAvailableLinter: mockDetectAvailableLinter,
	runLint: mockRunLint,
}));

mock.module('../../../src/tools/secretscan', () => ({
	runSecretscan: mock(async () => ({
		scan_dir: '.',
		findings: [],
		count: 0,
		files_scanned: 0,
		skipped_files: 0,
	})),
}));

mock.module('../../../src/tools/sast-scan', () => ({
	sastScan: mockSastScan,
}));

mock.module('../../../src/tools/quality-budget', () => ({
	qualityBudget: mockQualityBudget,
}));

mock.module('../../../src/utils', () => ({
	warn: mock(() => {}),
}));

// Track saveEvidence calls for verification
const savedEvidence: Array<{
	directory: string;
	taskId: string;
	evidence: SecretscanEvidence;
}> = [];

const mockSaveEvidence = mock(
	async (
		directory: string,
		taskId: string,
		evidence: SecretscanEvidence,
	): Promise<unknown> => {
		savedEvidence.push({ directory, taskId, evidence });
		return {};
	},
);

mock.module('../../../src/evidence/manager', () => ({
	saveEvidence: mockSaveEvidence,
}));
const originalSaveEvidence = _internals.saveEvidence;

// Helper to create temp test directories
function createTempDir(): string {
	return fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'secretscan-evidence-test-')),
	);
}

describe('secretscan evidence persistence', () => {
	let tempDir: string;
	let originalCwd: string;

	beforeEach(() => {
		originalCwd = process.cwd();
		tempDir = createTempDir();
		process.chdir(tempDir);

		// Create symlink to node_modules so biome is available
		try {
			fs.symlinkSync(
				path.join(originalCwd, 'node_modules'),
				path.join(tempDir, 'node_modules'),
				'junction',
			);
		} catch {
			// Symlink might already exist or fail on some platforms
		}

		// Clear saved evidence tracking
		savedEvidence.length = 0;

		// Reset mock call counts
		mockDetectAvailableLinter.mockClear();
		mockRunLint.mockClear();
		mockSastScan.mockClear();
		mockQualityBudget.mockClear();
		mockSaveEvidence.mockClear();
		_internals.saveEvidence = mockSaveEvidence;
	});

	afterEach(() => {
		_internals.saveEvidence = originalSaveEvidence;
		process.chdir(originalCwd);
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	// ============ Happy Path: No secrets found → verdict='pass' ============

	test('secretscan with no findings saves evidence with verdict=pass', async () => {
		// Create a clean file with no secrets
		fs.writeFileSync(
			path.join(tempDir, 'clean.ts'),
			'export const x = 1;\nexport const y = 2;\n',
		);

		const input: PreCheckBatchInput = {
			files: ['clean.ts'],
			directory: tempDir,
		};

		const result = await runPreCheckBatch(input);

		// Verify the pipeline ran
		expect(result.gates_passed).toBe(true);
		expect(result.secretscan.ran).toBe(true);

		// Verify saveEvidence was called with secretscan task
		expect(mockSaveEvidence).toHaveBeenCalled();
		const lastCall =
			mockSaveEvidence.mock.calls[mockSaveEvidence.mock.calls.length - 1];
		expect(lastCall[0]).toBe(tempDir); // directory
		expect(lastCall[1]).toBe('secretscan'); // taskId

		const evidence = lastCall[2] as SecretscanEvidence;
		expect(evidence.task_id).toBe('secretscan');
		expect(evidence.type).toBe('secretscan');
		expect(evidence.agent).toBe('pre_check_batch');
		expect(evidence.verdict).toBe('pass');
		expect(evidence.findings_count).toBe(0);
		expect(evidence.scan_directory).toBeDefined();
		expect(typeof evidence.scan_directory).toBe('string');
		expect(evidence.files_scanned).toBeGreaterThanOrEqual(0);
		expect(evidence.skipped_files).toBeGreaterThanOrEqual(0);
		expect(evidence.summary).toContain('Secretscan');
		expect(evidence.summary).toContain('0 finding(s)');
		expect(evidence.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
	});

	// ============ Error Path: Secrets found → verdict='fail' ============

	test('secretscan with findings saves evidence with verdict=fail', async () => {
		// Create a file with a fake API key that the inline scanner will detect
		fs.writeFileSync(
			path.join(tempDir, 'secret.ts'),
			'export const apiKey = "sk-abc1234567890abcdefghijklmnop";\n',
		);

		const input: PreCheckBatchInput = {
			files: ['secret.ts'],
			directory: tempDir,
		};

		const result = await runPreCheckBatch(input);

		// Verify gates failed
		expect(result.gates_passed).toBe(false);

		// Verify saveEvidence was called with secretscan task
		expect(mockSaveEvidence).toHaveBeenCalled();
		const lastCall =
			mockSaveEvidence.mock.calls[mockSaveEvidence.mock.calls.length - 1];
		const evidence = lastCall[2] as SecretscanEvidence;

		expect(evidence.verdict).toBe('fail');
		expect(evidence.findings_count).toBeGreaterThan(0);
		expect(evidence.summary).toContain('Secretscan');
		expect(evidence.summary).toContain('finding(s)');
	});

	// ============ Evidence Schema Validation ============

	test('evidence object matches SecretscanEvidenceSchema structure', async () => {
		fs.writeFileSync(path.join(tempDir, 'clean.ts'), 'export const x = 1;\n');

		const input: PreCheckBatchInput = {
			files: ['clean.ts'],
			directory: tempDir,
		};

		await runPreCheckBatch(input);

		expect(mockSaveEvidence).toHaveBeenCalled();
		const lastCall =
			mockSaveEvidence.mock.calls[mockSaveEvidence.mock.calls.length - 1];
		const evidence = lastCall[2] as SecretscanEvidence;

		// Verify all required fields are present and correctly typed
		expect(typeof evidence.task_id).toBe('string');
		expect(evidence.task_id).toBe('secretscan');

		expect(typeof evidence.type).toBe('string');
		expect(evidence.type).toBe('secretscan');

		expect(typeof evidence.timestamp).toBe('string');
		// ISO 8601 datetime format
		expect(evidence.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

		expect(typeof evidence.agent).toBe('string');
		expect(evidence.agent).toBe('pre_check_batch');

		expect(typeof evidence.verdict).toBe('string');
		expect(['pass', 'fail']).toContain(evidence.verdict);

		expect(typeof evidence.summary).toBe('string');
		expect(evidence.summary.length).toBeGreaterThan(0);

		expect(typeof evidence.findings_count).toBe('number');
		expect(evidence.findings_count).toBeGreaterThanOrEqual(0);

		expect(typeof evidence.scan_directory).toBe('string');

		expect(typeof evidence.files_scanned).toBe('number');
		expect(evidence.files_scanned).toBeGreaterThanOrEqual(0);

		expect(typeof evidence.skipped_files).toBe('number');
		expect(evidence.skipped_files).toBeGreaterThanOrEqual(0);
	});

	// ============ Evidence persistence failure: gate fails, no crash (#2209) ============

	test('secretscan evidence persistence failure fails the gate and surfaces on the payload (#2209)', async () => {
		// Create a clean file
		fs.writeFileSync(path.join(tempDir, 'clean.ts'), 'export const x = 1;\n');

		// Make ONLY the secretscan evidence write reject. A bare
		// mockRejectedValueOnce historically missed this path entirely: the
		// quality_budget evidence write runs first and consumed the single
		// rejection, so this test never actually exercised the secretscan
		// catch (surfaced by the #2209 final critic).
		const defaultImpl = async (
			directory: string,
			taskId: string,
			evidence: SecretscanEvidence,
		): Promise<unknown> => {
			savedEvidence.push({ directory, taskId, evidence });
			return {};
		};
		mockSaveEvidence.mockImplementation(
			async (
				directory: string,
				taskId: string,
				evidence: SecretscanEvidence,
			): Promise<unknown> => {
				if (taskId === 'secretscan') {
					throw new Error('Filesystem error');
				}
				return defaultImpl(directory, taskId, evidence);
			},
		);
		try {
			const input: PreCheckBatchInput = {
				files: ['clean.ts'],
				directory: tempDir,
			};

			// Should not throw — but per #2209 the persistence failure now
			// fails the gate identically to sast_scan instead of being
			// swallowed as a warn().
			const result = await runPreCheckBatch(input);

			expect(result.secretscan.ran).toBe(true);
			expect(result.secretscan.error).toContain(
				'Failed to persist secretscan evidence',
			);
			expect(result.secretscan.error).toContain('Filesystem error');
			expect(result.gates_passed).toBe(false);
		} finally {
			mockSaveEvidence.mockImplementation(defaultImpl);
		}
	});

	// ============ Verdict Logic: findings_count > 0 → 'fail' ============

	test('verdict is fail when findings_count > 0', async () => {
		// File with multiple secrets
		fs.writeFileSync(
			path.join(tempDir, 'multi-secret.ts'),
			`export const password = "super_secret_123";
export const apiKey = "ghp_abcdefghijklmnopqrstuvwxyz1234567890abcdefghijk";
export const token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";\n`,
		);

		const input: PreCheckBatchInput = {
			files: ['multi-secret.ts'],
			directory: tempDir,
		};

		const result = await runPreCheckBatch(input);

		expect(result.gates_passed).toBe(false);

		const lastCall =
			mockSaveEvidence.mock.calls[mockSaveEvidence.mock.calls.length - 1];
		const evidence = lastCall[2] as SecretscanEvidence;

		expect(evidence.verdict).toBe('fail');
		expect(evidence.findings_count).toBeGreaterThan(0);
	});

	test('verdict is pass when findings_count is 0', async () => {
		fs.writeFileSync(
			path.join(tempDir, 'clean.ts'),
			'export const x = 1;\nexport const message = "hello world";\n',
		);

		const input: PreCheckBatchInput = {
			files: ['clean.ts'],
			directory: tempDir,
		};

		const result = await runPreCheckBatch(input);

		expect(result.gates_passed).toBe(true);

		const lastCall =
			mockSaveEvidence.mock.calls[mockSaveEvidence.mock.calls.length - 1];
		const evidence = lastCall[2] as SecretscanEvidence;

		expect(evidence.verdict).toBe('pass');
		expect(evidence.findings_count).toBe(0);
	});

	// ============ Evidence Summary Format ============

	test('evidence summary contains scan statistics', async () => {
		fs.writeFileSync(path.join(tempDir, 'clean.ts'), 'export const x = 1;\n');

		const input: PreCheckBatchInput = {
			files: ['clean.ts'],
			directory: tempDir,
		};

		await runPreCheckBatch(input);

		const lastCall =
			mockSaveEvidence.mock.calls[mockSaveEvidence.mock.calls.length - 1];
		const evidence = lastCall[2] as SecretscanEvidence;

		// Summary format: "Secretscan: X finding(s), Y files scanned, Z skipped"
		expect(evidence.summary).toMatch(
			/^Secretscan: \d+ finding\(s\), \d+ files scanned, \d+ skipped$/,
		);
	});

	// ============ Multiple Files Scanned ============

	test('evidence reflects multiple files scanned', async () => {
		fs.writeFileSync(path.join(tempDir, 'clean1.ts'), 'export const a = 1;\n');
		fs.writeFileSync(path.join(tempDir, 'clean2.ts'), 'export const b = 2;\n');
		fs.writeFileSync(path.join(tempDir, 'clean3.ts'), 'export const c = 3;\n');

		const input: PreCheckBatchInput = {
			files: ['clean1.ts', 'clean2.ts', 'clean3.ts'],
			directory: tempDir,
		};

		await runPreCheckBatch(input);

		const lastCall =
			mockSaveEvidence.mock.calls[mockSaveEvidence.mock.calls.length - 1];
		const evidence = lastCall[2] as SecretscanEvidence;

		// All 3 files should be scanned
		expect(evidence.files_scanned).toBe(3);
		expect(evidence.findings_count).toBe(0);
		expect(evidence.verdict).toBe('pass');
	});

	// ============ Secretscan Not Ran: No Evidence Saved ============

	test('no evidence saved when secretscan did not run', async () => {
		// No files provided - secretscan won't run
		const input: PreCheckBatchInput = {
			directory: tempDir,
			// files not provided
		};

		const result = await runPreCheckBatch(input);

		expect(result.secretscan.ran).toBe(false);
		expect(mockSaveEvidence).not.toHaveBeenCalled();
	});

	// ============ Skipped Files Tracking ============

	test('skipped files are tracked in evidence', async () => {
		// Create a file that will be skipped (binary file simulation via .md extension)
		// The secretscan excludes .md files
		fs.writeFileSync(path.join(tempDir, 'clean.ts'), 'export const x = 1;\n');
		fs.writeFileSync(path.join(tempDir, 'readme.md'), '# Readme\n');

		const input: PreCheckBatchInput = {
			files: ['clean.ts', 'readme.md'],
			directory: tempDir,
		};

		await runPreCheckBatch(input);

		const lastCall =
			mockSaveEvidence.mock.calls[mockSaveEvidence.mock.calls.length - 1];
		const evidence = lastCall[2] as SecretscanEvidence;

		// .md file should be skipped
		expect(evidence.skipped_files).toBeGreaterThan(0);
	});

	// ============ Evidence Saved to Correct Directory ============

	test('evidence is saved to the provided directory, not cwd', async () => {
		fs.writeFileSync(path.join(tempDir, 'clean.ts'), 'export const x = 1;\n');

		const input: PreCheckBatchInput = {
			files: ['clean.ts'],
			directory: tempDir,
		};

		await runPreCheckBatch(input);

		expect(mockSaveEvidence).toHaveBeenCalled();
		const lastCall = mockSaveEvidence.mock.calls[0];
		expect(lastCall[0]).toBe(tempDir); // First arg is directory
	});
});
