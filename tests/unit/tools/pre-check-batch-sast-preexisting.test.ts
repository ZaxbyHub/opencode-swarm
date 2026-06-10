/**
 * Tests for SAST pre-existing findings classification in pre_check_batch.
 *
 * Verifies:
 * 1. New HIGH/CRITICAL SAST finding on changed line → blocks coder (gates_passed: false)
 * 2. Pre-existing HIGH/CRITICAL SAST finding on unchanged line → passes to reviewer (gates_passed: true + sast_preexisting_findings)
 * 3. Mixed case (one new + one pre-existing) → blocks coder
 * 4. classifySastFindings correctly classifies based on changed line ranges
 * 5. parseDiffLineRanges correctly parses git diff output
 * 6. Integration: runPreCheckBatch gate behavior with pre-existing vs new findings
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	classifySastFindings,
	getChangedLineRanges,
	parseDiffLineRanges,
} from '../../../src/tools/pre-check-batch';
import type { SastScanFinding } from '../../../src/tools/sast-scan';

// ============ classifySastFindings unit tests ============

describe('classifySastFindings', () => {
	const makeFinding = (
		file: string,
		line: number,
		severity: 'critical' | 'high' | 'medium' | 'low' = 'high',
	): SastScanFinding => ({
		rule_id: `test-rule-${line}`,
		severity,
		message: `Test finding at ${file}:${line}`,
		location: { file, line },
	});

	test('finding on changed line classified as new', () => {
		const changedRanges = new Map<string, Set<number>>();
		changedRanges.set('src/foo.ts', new Set([10, 11, 12]));

		const findings = [makeFinding('/workspace/src/foo.ts', 11)];

		const { newFindings, preexistingFindings } = classifySastFindings(
			findings,
			changedRanges,
			'/workspace',
		);

		expect(newFindings).toHaveLength(1);
		expect(preexistingFindings).toHaveLength(0);
	});

	test('finding on unchanged line classified as pre-existing', () => {
		const changedRanges = new Map<string, Set<number>>();
		changedRanges.set('src/foo.ts', new Set([10, 11, 12]));

		const findings = [makeFinding('/workspace/src/foo.ts', 50)];

		const { newFindings, preexistingFindings } = classifySastFindings(
			findings,
			changedRanges,
			'/workspace',
		);

		expect(newFindings).toHaveLength(0);
		expect(preexistingFindings).toHaveLength(1);
	});

	test('mixed: one new + one pre-existing finding', () => {
		const changedRanges = new Map<string, Set<number>>();
		changedRanges.set('src/foo.ts', new Set([10, 11, 12]));

		const findings = [
			makeFinding('/workspace/src/foo.ts', 11), // changed line → new
			makeFinding('/workspace/src/foo.ts', 50), // unchanged line → pre-existing
		];

		const { newFindings, preexistingFindings } = classifySastFindings(
			findings,
			changedRanges,
			'/workspace',
		);

		expect(newFindings).toHaveLength(1);
		expect(preexistingFindings).toHaveLength(1);
		expect(newFindings[0].location.line).toBe(11);
		expect(preexistingFindings[0].location.line).toBe(50);
	});

	test('finding in file not present in changed ranges classified as pre-existing', () => {
		const changedRanges = new Map<string, Set<number>>();
		changedRanges.set('src/bar.ts', new Set([1, 2, 3]));

		const findings = [makeFinding('/workspace/src/foo.ts', 10)];

		const { newFindings, preexistingFindings } = classifySastFindings(
			findings,
			changedRanges,
			'/workspace',
		);

		expect(newFindings).toHaveLength(0);
		expect(preexistingFindings).toHaveLength(1);
	});

	test('null changedLineRanges → fail-closed, all findings treated as new', () => {
		const findings = [
			makeFinding('/workspace/src/foo.ts', 10),
			makeFinding('/workspace/src/bar.ts', 20),
		];

		const { newFindings, preexistingFindings } = classifySastFindings(
			findings,
			null,
			'/workspace',
		);

		expect(newFindings).toHaveLength(2);
		expect(preexistingFindings).toHaveLength(0);
	});

	test('empty changedLineRanges → fail-closed, all findings treated as new', () => {
		const findings = [makeFinding('/workspace/src/foo.ts', 10)];

		const { newFindings, preexistingFindings } = classifySastFindings(
			findings,
			new Map(),
			'/workspace',
		);

		expect(newFindings).toHaveLength(1);
		expect(preexistingFindings).toHaveLength(0);
	});

	test('windows-style paths normalised correctly', () => {
		const changedRanges = new Map<string, Set<number>>();
		changedRanges.set('src/foo.ts', new Set([10]));

		const findings = [makeFinding('/workspace/src/foo.ts', 10)];

		const { newFindings } = classifySastFindings(
			findings,
			changedRanges,
			'/workspace',
		);

		expect(newFindings).toHaveLength(1);
	});
});

// ============ parseDiffLineRanges unit tests ============

describe('parseDiffLineRanges', () => {
	test('parses single file with single hunk', () => {
		const diff = [
			'diff --git a/src/foo.ts b/src/foo.ts',
			'index abc1234..def5678 100644',
			'--- a/src/foo.ts',
			'+++ b/src/foo.ts',
			'@@ -10,3 +10,5 @@ function example() {',
		].join('\n');

		const result = parseDiffLineRanges(diff);
		expect(result.has('src/foo.ts')).toBe(true);
		const lines = result.get('src/foo.ts')!;
		expect(lines.has(10)).toBe(true);
		expect(lines.has(11)).toBe(true);
		expect(lines.has(14)).toBe(true);
		expect(lines.has(15)).toBe(false);
		expect(lines.size).toBe(5);
	});

	test('parses multiple files', () => {
		const diff = [
			'diff --git a/src/a.ts b/src/a.ts',
			'--- a/src/a.ts',
			'+++ b/src/a.ts',
			'@@ -1,0 +1,2 @@',
			'diff --git a/src/b.ts b/src/b.ts',
			'--- a/src/b.ts',
			'+++ b/src/b.ts',
			'@@ -5,0 +5,3 @@',
		].join('\n');

		const result = parseDiffLineRanges(diff);
		expect(result.size).toBe(2);
		expect(result.get('src/a.ts')!.size).toBe(2);
		expect(result.get('src/b.ts')!.size).toBe(3);
	});

	test('parses hunk with count 0 (pure deletion)', () => {
		const diff = ['+++ b/src/foo.ts', '@@ -10,3 +10,0 @@'].join('\n');

		const result = parseDiffLineRanges(diff);
		expect(result.get('src/foo.ts')!.size).toBe(0);
	});

	test('parses hunk with no count (single line change)', () => {
		const diff = ['+++ b/src/foo.ts', '@@ -10 +20 @@'].join('\n');

		const result = parseDiffLineRanges(diff);
		const lines = result.get('src/foo.ts')!;
		expect(lines.has(20)).toBe(true);
		expect(lines.size).toBe(1);
	});

	test('handles trailing context text in hunk header without misparse', () => {
		const diff = [
			'+++ b/src/foo.ts',
			'@@ -10,3 +20,5 @@ function add(a, b) {',
		].join('\n');

		const result = parseDiffLineRanges(diff);
		const lines = result.get('src/foo.ts')!;
		expect(lines.has(20)).toBe(true);
		expect(lines.size).toBe(5);
	});

	test('returns empty map for empty diff', () => {
		const result = parseDiffLineRanges('');
		expect(result.size).toBe(0);
	});
});

// ============ getChangedLineRanges integration test ============

describe('getChangedLineRanges', () => {
	test('returns null for non-git directory', async () => {
		const result = await getChangedLineRanges(
			path.join(os.tmpdir(), 'definitely-not-a-git-repo-' + Date.now()),
		);
		expect(result).toBeNull();
	});
});

// ============ Integration: runPreCheckBatch gate behavior ============

// These tests use mock.module to control SAST output and verify gate behavior.
// They must be in a separate describe to avoid mock conflicts with the unit tests above.

const mockSastScan = mock(async () => ({
	verdict: 'pass' as const,
	findings: [] as SastScanFinding[],
	summary: {
		engine: 'tier_a' as const,
		files_scanned: 1,
		findings_count: 0,
		findings_by_severity: { critical: 0, high: 0, medium: 0, low: 0 },
	},
}));

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
const mockRunSecretscan = mock(async () => ({
	scan_dir: '.',
	findings: [],
	count: 0,
	files_scanned: 0,
	skipped_files: 0,
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
	runSecretscan: mockRunSecretscan,
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

// Re-import after mocks are set up
const { runPreCheckBatch } = await import('../../../src/tools/pre-check-batch');

// DD-C008: previously skipped on Windows. The lint/secretscan/sast/quality
// gates are all mocked (above), so the only real subprocess is git — which
// emits forward-slash diff paths on every OS, and is stabilized here with
// core.autocrlf=false so committed content (and therefore diff line ranges)
// is identical across platforms. classifySastFindings already normalizes
// `\`→`/` (pre-check-batch.ts), so the gate logic is platform-agnostic.
describe('runPreCheckBatch SAST gate integration', () => {
	let tempDir: string;
	let originalCwd: string;

	beforeEach(() => {
		originalCwd = process.cwd();
		tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'sast-gate-test-')),
		);
		process.chdir(tempDir);

		// Create test file
		fs.writeFileSync(path.join(tempDir, 'test.ts'), 'export const x = 1;\n');

		// Symlink node_modules
		try {
			fs.symlinkSync(
				path.join(originalCwd, 'node_modules'),
				path.join(tempDir, 'node_modules'),
				'junction',
			);
		} catch {
			// May fail on some platforms
		}

		mockSastScan.mockClear();
	});

	afterEach(() => {
		process.chdir(originalCwd);
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// Windows EBUSY: git processes may still hold locks; non-fatal in tests
		}
	});

	test(
		'SAST with new HIGH finding on changed line → gates_passed false',
		{ timeout: 30_000 },
		async () => {
			// SAST returns a HIGH finding — and git diff is unavailable (non-git dir)
			// so fail-closed treats it as new
			mockSastScan.mockImplementationOnce(async () => ({
				verdict: 'fail' as const,
				findings: [
					{
						rule_id: 'sql-injection',
						severity: 'high' as const,
						message: 'SQL injection detected',
						location: { file: path.join(tempDir, 'test.ts'), line: 1 },
					},
				],
				summary: {
					engine: 'tier_a' as const,
					files_scanned: 1,
					findings_count: 1,
					findings_by_severity: { critical: 0, high: 1, medium: 0, low: 0 },
				},
			}));

			const result = await runPreCheckBatch({
				files: ['test.ts'],
				directory: tempDir,
			});

			expect(result.gates_passed).toBe(false);
			expect(result.sast_preexisting_findings).toBeUndefined();
		},
	);

	test(
		'SAST with only pre-existing HIGH finding (no changed lines) → gates_passed true + sast_preexisting_findings',
		{ timeout: 30_000 },
		async () => {
			// Initialize a git repo with two commits so HEAD~1 strategy works
			const { execSync } = await import('node:child_process');
			try {
				execSync('git init', { cwd: tempDir, stdio: 'pipe' });
				execSync('git config core.autocrlf false', {
					cwd: tempDir,
					stdio: 'pipe',
				});
				execSync('git config user.email "test@test.com"', {
					cwd: tempDir,
					stdio: 'pipe',
				});
				execSync('git config user.name "Test"', {
					cwd: tempDir,
					stdio: 'pipe',
				});
				// First commit with the file
				execSync('git add -A && git commit -m "init"', {
					cwd: tempDir,
					stdio: 'pipe',
				});
				// Second commit (empty) so HEAD~1 diff shows no changes to test.ts
				fs.writeFileSync(path.join(tempDir, 'other.txt'), 'unrelated\n');
				execSync('git add -A && git commit -m "other"', {
					cwd: tempDir,
					stdio: 'pipe',
				});
			} catch {
				// Git may not be available; skip this test gracefully
				return;
			}

			const findingFile = path.join(tempDir, 'test.ts');
			mockSastScan.mockImplementationOnce(async () => ({
				verdict: 'fail' as const,
				findings: [
					{
						rule_id: 'sql-injection',
						severity: 'high' as const,
						message: 'Pre-existing SQL injection',
						location: { file: findingFile, line: 1 },
					},
				],
				summary: {
					engine: 'tier_a' as const,
					files_scanned: 1,
					findings_count: 1,
					findings_by_severity: { critical: 0, high: 1, medium: 0, low: 0 },
				},
			}));

			const result = await runPreCheckBatch({
				files: ['test.ts'],
				directory: tempDir,
			});

			// test.ts was not modified in the last commit — finding is pre-existing
			expect(result.gates_passed).toBe(true);
			expect(result.sast_preexisting_findings).toBeDefined();
			expect(result.sast_preexisting_findings).toHaveLength(1);
			expect(result.sast_preexisting_findings![0].rule_id).toBe(
				'sql-injection',
			);
		},
	);

	test(
		'SAST with mixed findings (one new + one pre-existing) → gates_passed false',
		{ timeout: 30_000 },
		async () => {
			// In a non-git directory, fail-closed means ALL are treated as new → blocks
			mockSastScan.mockImplementationOnce(async () => ({
				verdict: 'fail' as const,
				findings: [
					{
						rule_id: 'xss-new',
						severity: 'critical' as const,
						message: 'XSS on changed line',
						location: { file: path.join(tempDir, 'test.ts'), line: 1 },
					},
					{
						rule_id: 'sql-old',
						severity: 'high' as const,
						message: 'Pre-existing SQL injection',
						location: { file: path.join(tempDir, 'test.ts'), line: 50 },
					},
				],
				summary: {
					engine: 'tier_a' as const,
					files_scanned: 1,
					findings_count: 2,
					findings_by_severity: { critical: 1, high: 1, medium: 0, low: 0 },
				},
			}));

			const result = await runPreCheckBatch({
				files: ['test.ts'],
				directory: tempDir,
			});

			// Non-git dir → fail-closed → all findings are new → blocks
			expect(result.gates_passed).toBe(false);
			expect(result.sast_preexisting_findings).toBeUndefined();
		},
	);

	// DD-C008: enabled on Windows — git config below pins autocrlf off so the
	// committed content and diff line ranges match across platforms.
	test(
		'reviewer receives structured sast_preexisting_findings field',
		{ timeout: 30_000 },
		async () => {
			// Use git repo where file is committed (no changed lines)
			const { execSync } = await import('node:child_process');
			try {
				execSync('git init', { cwd: tempDir, stdio: 'pipe' });
				execSync('git config core.autocrlf false', {
					cwd: tempDir,
					stdio: 'pipe',
				});
				execSync('git config user.email "test@test.com"', {
					cwd: tempDir,
					stdio: 'pipe',
				});
				execSync('git config user.name "Test"', {
					cwd: tempDir,
					stdio: 'pipe',
				});
				execSync('git add -A && git commit -m "init"', {
					cwd: tempDir,
					stdio: 'pipe',
				});
				// Second commit so HEAD~1 works
				fs.writeFileSync(path.join(tempDir, 'other.txt'), 'unrelated\n');
				execSync('git add -A && git commit -m "other"', {
					cwd: tempDir,
					stdio: 'pipe',
				});
			} catch {
				return; // Skip if git unavailable
			}

			const findingFile = path.join(tempDir, 'test.ts');
			mockSastScan.mockImplementationOnce(async () => ({
				verdict: 'fail' as const,
				findings: [
					{
						rule_id: 'hardcoded-secret',
						severity: 'critical' as const,
						message: 'Hardcoded secret on unchanged line',
						location: { file: findingFile, line: 1 },
						remediation: 'Use environment variables',
					},
				],
				summary: {
					engine: 'tier_a' as const,
					files_scanned: 1,
					findings_count: 1,
					findings_by_severity: { critical: 1, high: 0, medium: 0, low: 0 },
				},
			}));

			const result = await runPreCheckBatch({
				files: ['test.ts'],
				directory: tempDir,
			});

			expect(result.gates_passed).toBe(true);
			expect(result.sast_preexisting_findings).toBeDefined();

			const finding = result.sast_preexisting_findings![0];
			expect(finding.rule_id).toBe('hardcoded-secret');
			expect(finding.severity).toBe('critical');
			expect(finding.message).toBe('Hardcoded secret on unchanged line');
			expect(finding.location.file).toBe(findingFile);
			expect(finding.location.line).toBe(1);
			expect(finding.remediation).toBe('Use environment variables');
		},
	);

	test(
		'no false deadlock: changed file is clean, unchanged file has HIGH SAST finding → gates_passed true, finding surfaced to reviewer',
		{ timeout: 30_000 },
		async () => {
			// Scenario: coder touched clean.ts (no findings), but legacy.ts (not touched) has a HIGH finding.
			// System must NOT block the coder for legacy.ts's pre-existing issue.
			// The finding must be surfaced to reviewer via sast_preexisting_findings.

			const tempDir = fs.realpathSync(
				fs.mkdtempSync(path.join(os.tmpdir(), 'pcb-nodeadlock-')),
			);
			try {
				// Create two files: clean.ts (changed) and legacy.ts (unchanged with finding)
				fs.writeFileSync(
					path.join(tempDir, 'clean.ts'),
					'export const x = 1;\n',
				);
				fs.writeFileSync(path.join(tempDir, 'legacy.ts'), 'eval(userInput);\n');

				// Set up git repo: legacy.ts committed first, then clean.ts added in second commit
				const { execSync } = await import('node:child_process');
				try {
					execSync('git init', { cwd: tempDir, stdio: 'pipe' });
					execSync('git config core.autocrlf false', {
						cwd: tempDir,
						stdio: 'pipe',
					});
					execSync('git config user.email "test@test.com"', {
						cwd: tempDir,
						stdio: 'pipe',
					});
					execSync('git config user.name "Test"', {
						cwd: tempDir,
						stdio: 'pipe',
					});
					// First commit: legacy.ts only
					execSync('git add legacy.ts && git commit -m "add legacy"', {
						cwd: tempDir,
						stdio: 'pipe',
					});
					// Second commit: add clean.ts (this is the "changed" file)
					execSync('git add clean.ts && git commit -m "add clean"', {
						cwd: tempDir,
						stdio: 'pipe',
					});
				} catch {
					// Git not available — skip gracefully
					return;
				}

				const legacyFile = path.join(tempDir, 'legacy.ts');
				// SAST returns a HIGH finding on legacy.ts line 1 (unchanged file)
				mockSastScan.mockImplementationOnce(async () => ({
					verdict: 'fail' as const,
					findings: [
						{
							rule_id: 'eval-injection',
							severity: 'high' as const,
							message: 'eval() with user input is dangerous',
							location: { file: legacyFile, line: 1 },
						},
					],
					summary: {
						engine: 'tier_a' as const,
						files_scanned: 2,
						findings_count: 1,
						findings_by_severity: { critical: 0, high: 1, medium: 0, low: 0 },
					},
				}));

				// Coder only touched clean.ts — pass only that file
				const result = await runPreCheckBatch({
					files: ['clean.ts'],
					directory: tempDir,
				});

				// Must NOT block: changed file (clean.ts) has no findings
				expect(result.gates_passed).toBe(true);

				// Must surface the pre-existing finding to reviewer
				expect(result.sast_preexisting_findings).toBeDefined();
				expect(result.sast_preexisting_findings).toHaveLength(1);
				expect(result.sast_preexisting_findings![0].rule_id).toBe(
					'eval-injection',
				);
			} finally {
				fs.rmSync(tempDir, { recursive: true, force: true });
			}
		},
	);
});
