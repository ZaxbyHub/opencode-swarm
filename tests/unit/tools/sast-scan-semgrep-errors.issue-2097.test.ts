import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { _internals as semgrepInternals } from '../../../src/sast/semgrep';
import {
	_internals as batchInternals,
	runPreCheckBatch,
} from '../../../src/tools/pre-check-batch';
import {
	_internals as sastInternals,
	sastScan,
} from '../../../src/tools/sast-scan';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const originalSastInternals = {
	checkSemgrepAvailable: sastInternals.checkSemgrepAvailable,
	runSemgrep: sastInternals.runSemgrep,
};
const originalBatchInternals = {
	runLintWrapped: batchInternals.runLintWrapped,
	runSecretscanWrapped: batchInternals.runSecretscanWrapped,
	runSastScanWrapped: batchInternals.runSastScanWrapped,
	runQualityBudgetWrapped: batchInternals.runQualityBudgetWrapped,
	saveEvidence: batchInternals.saveEvidence,
	getChangedLineRanges: batchInternals.getChangedLineRanges,
};
const originalSemgrepInternals = {
	checkSemgrepAvailable: semgrepInternals.checkSemgrepAvailable,
	resolveSemgrepBinary: semgrepInternals.resolveSemgrepBinary,
	runExternalTool: semgrepInternals.runExternalTool,
};

let directory: string;

beforeEach(() => {
	directory = canonicalMkdtemp('sast-semgrep-error-');
	fs.writeFileSync(
		path.join(directory, 'safe.js'),
		'export const safe = true;\n',
	);
	sastInternals.checkSemgrepAvailable = async () => true;
});

afterEach(() => {
	sastInternals.checkSemgrepAvailable =
		originalSastInternals.checkSemgrepAvailable;
	sastInternals.runSemgrep = originalSastInternals.runSemgrep;
	batchInternals.runLintWrapped = originalBatchInternals.runLintWrapped;
	batchInternals.runSecretscanWrapped =
		originalBatchInternals.runSecretscanWrapped;
	batchInternals.runSastScanWrapped = originalBatchInternals.runSastScanWrapped;
	batchInternals.runQualityBudgetWrapped =
		originalBatchInternals.runQualityBudgetWrapped;
	batchInternals.saveEvidence = originalBatchInternals.saveEvidence;
	batchInternals.getChangedLineRanges =
		originalBatchInternals.getChangedLineRanges;
	semgrepInternals.checkSemgrepAvailable =
		originalSemgrepInternals.checkSemgrepAvailable;
	semgrepInternals.resolveSemgrepBinary =
		originalSemgrepInternals.resolveSemgrepBinary;
	semgrepInternals.runExternalTool = originalSemgrepInternals.runExternalTool;
	fs.rmSync(directory, { recursive: true, force: true });
});

describe('Semgrep error propagation — issue #2097', () => {
	test.each([
		['Semgrep process timed out', 'Semgrep process timed out'],
		[
			'Semgrep output exceeded the maximum size and was truncated',
			'Semgrep output exceeded its bounded limit; results incomplete',
		],
		[
			'external tool process termination could not be confirmed',
			'Semgrep execution failed',
		],
		[
			'Semgrep returned invalid JSON output',
			'Semgrep returned invalid JSON output',
		],
	])('sastScan fails closed for %s', async (error, safeError) => {
		sastInternals.runSemgrep = async () => ({
			available: true,
			findings: [],
			error,
			engine: 'tier_a',
		});

		const result = await sastScan(
			{ changed_files: [path.join(directory, 'safe.js')] },
			directory,
		);

		expect(result.verdict).toBe('fail');
		expect(result.error).toBe(`Semgrep execution failed: ${safeError}`);
		expect(result.summary.engine).toBe('tier_a');
	});

	test('redacts untrusted Semgrep diagnostics from results and evidence (F-009)', async () => {
		const sensitiveDiagnostic =
			'Authorization: Bearer secret-review-marker from scanner stderr';
		// This seam covers an untrusted Semgrep error only. Finding conversion and
		// successful Tier B results are covered by the profile and Semgrep suites.
		sastInternals.runSemgrep = async () => ({
			available: true,
			findings: [],
			error: sensitiveDiagnostic,
			engine: 'tier_a',
		});

		// Previous code copied arbitrary scanner diagnostics into both the public
		// result and `.swarm/evidence/sast_scan/evidence.json`.
		const result = await sastScan(
			{ changed_files: [path.join(directory, 'safe.js')] },
			directory,
		);
		const evidence = fs.readFileSync(
			path.join(directory, '.swarm', 'evidence', 'sast_scan', 'evidence.json'),
			'utf8',
		);

		expect(result.error).toBe(
			'Semgrep execution failed: Semgrep execution failed',
		);
		expect(result.error).not.toContain('secret-review-marker');
		expect(evidence).not.toContain('secret-review-marker');
		expect(evidence).toContain('Semgrep execution failed');
	});

	test('does not persist evidence after cancellation wins the Semgrep race (F-003)', async () => {
		const controller = new AbortController();
		// This seam covers cancellation immediately after the external scan settles.
		// Pre-aborted and successful evidence paths are covered by adjacent suites.
		sastInternals.runSemgrep = async () => {
			controller.abort();
			return {
				available: true,
				findings: [],
				error: 'scanner diagnostic that must not persist',
				engine: 'tier_a',
			};
		};

		const result = await sastScan(
			{
				changed_files: [path.join(directory, 'safe.js')],
				abort_signal: controller.signal,
			},
			directory,
		);

		expect(result).toMatchObject({
			verdict: 'fail',
			error: 'SAST scan cancelled',
		});
		expect(
			fs.existsSync(
				path.join(
					directory,
					'.swarm',
					'evidence',
					'sast_scan',
					'evidence.json',
				),
			),
		).toBe(false);
	});

	test('pre_check_batch blocks a completed Semgrep payload with structured scan errors', async () => {
		const semgrepError = 'Semgrep reported 1 scan error';
		fs.writeFileSync(
			path.join(directory, 'safe.js'),
			'eval(untrustedInput);\n',
		);
		semgrepInternals.checkSemgrepAvailable = async () => true;
		semgrepInternals.resolveSemgrepBinary = () => '/fake/semgrep';
		semgrepInternals.runExternalTool = async () => ({
			status: 'completed',
			exitCode: 0,
			stdout: JSON.stringify({
				results: [],
				errors: [{ type: 'ParseError', message: 'scan incomplete' }],
			}),
			stderr: '',
			stdoutTruncated: false,
			stderrTruncated: false,
		});
		sastInternals.runSemgrep = semgrepInternals.runSemgrep;
		batchInternals.runLintWrapped = async () => ({
			ran: false,
			error: 'No linter found (biome or eslint)',
			duration_ms: 1,
		});
		batchInternals.runSecretscanWrapped = async () => ({
			ran: true,
			result: {
				scan_dir: directory,
				findings: [],
				count: 0,
				files_scanned: 1,
				skipped_files: 0,
				incomplete_files: 0,
				incomplete_paths: [],
			},
			duration_ms: 1,
		});
		batchInternals.runSastScanWrapped = async (files, root) => ({
			ran: true,
			result: await sastScan({ changed_files: files }, root),
			duration_ms: 1,
		});
		batchInternals.runQualityBudgetWrapped = async () => ({
			ran: true,
			result: {
				verdict: 'pass',
				metrics: {
					complexity_delta: 0,
					public_api_delta: 0,
					duplication_ratio: 0,
					test_to_code_ratio: 1,
					thresholds: {
						max_complexity_delta: 5,
						max_public_api_delta: 10,
						max_duplication_ratio: 0.05,
						min_test_to_code_ratio: 0.3,
					},
				},
				violations: [],
				summary: {
					files_analyzed: 1,
					violations_count: 0,
					errors_count: 0,
					warnings_count: 0,
				},
			},
			duration_ms: 1,
		});
		batchInternals.saveEvidence = async () => undefined;
		batchInternals.getChangedLineRanges = async () => new Map();

		const result = await runPreCheckBatch({
			files: ['safe.js'],
			directory,
		});

		expect(result.gates_passed).toBe(false);
		expect(result.sast_scan.result).toMatchObject({
			verdict: 'fail',
			error: expect.stringContaining(semgrepError),
		});
		expect(result.sast_scan.result?.findings.length).toBeGreaterThan(0);
	});
});
