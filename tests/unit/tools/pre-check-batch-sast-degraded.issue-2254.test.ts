import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { decodePreCheckResult } from '../../../src/hooks/guardrails/pre-check-result';
import {
	_internals as batchInternals,
	runPreCheckBatch,
} from '../../../src/tools/pre-check-batch';
import {
	type SastScanResult,
	_internals as sastInternals,
	sastScan,
} from '../../../src/tools/sast-scan';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const originals = {
	runLintWrapped: batchInternals.runLintWrapped,
	runSecretscanWrapped: batchInternals.runSecretscanWrapped,
	runSastScanWrapped: batchInternals.runSastScanWrapped,
	runQualityBudgetWrapped: batchInternals.runQualityBudgetWrapped,
	saveEvidence: batchInternals.saveEvidence,
	checkSemgrepAvailable: sastInternals.checkSemgrepAvailable,
	runSemgrep: sastInternals.runSemgrep,
};

let directory = '';
let sastResult: SastScanResult;

function cleanSastResult(): SastScanResult {
	return {
		verdict: 'pass',
		findings: [],
		summary: {
			engine: 'tier_a',
			files_scanned: 1,
			findings_count: 0,
			findings_by_severity: { critical: 0, high: 0, medium: 0, low: 0 },
		},
	};
}

beforeEach(() => {
	directory = canonicalMkdtemp('pre-check-sast-degraded-');
	fs.writeFileSync(
		path.join(directory, 'safe.ts'),
		'export const safe = true;\n',
	);
	sastResult = cleanSastResult();

	batchInternals.runLintWrapped = async () => ({
		ran: false,
		error: 'lint unavailable',
		duration_ms: 0,
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
		duration_ms: 0,
	});
	batchInternals.runSastScanWrapped = async () => ({
		ran: true,
		result: sastResult,
		duration_ms: 0,
	});
	batchInternals.runQualityBudgetWrapped = async () => ({
		ran: false,
		error: 'quality budget unavailable',
		duration_ms: 0,
	});
	batchInternals.saveEvidence = async () => undefined;
});

afterEach(() => {
	batchInternals.runLintWrapped = originals.runLintWrapped;
	batchInternals.runSecretscanWrapped = originals.runSecretscanWrapped;
	batchInternals.runSastScanWrapped = originals.runSastScanWrapped;
	batchInternals.runQualityBudgetWrapped = originals.runQualityBudgetWrapped;
	batchInternals.saveEvidence = originals.saveEvidence;
	sastInternals.checkSemgrepAvailable = originals.checkSemgrepAvailable;
	sastInternals.runSemgrep = originals.runSemgrep;
	fs.rmSync(directory, { recursive: true, force: true });
});

describe('pre_check_batch degraded SAST contract — issue #2254', () => {
	test('derived sast_enabled false never schedules the SAST wrapper', async () => {
		let calls = 0;
		batchInternals.runSastScanWrapped = async () => {
			calls++;
			throw new Error('SAST must not run');
		};

		const result = await runPreCheckBatch({
			files: ['safe.ts'],
			directory,
			sast_enabled: false,
		});

		expect(calls).toBe(0);
		expect(result.gates_passed).toBe(true);
		expect(result.sast_scan).toEqual({ ran: false, duration_ms: 0 });
		expect(result.sast_skipped).toBe(true);
		expect(
			decodePreCheckResult(batchInternals.serializePreCheckResult(result)),
		).toEqual({ kind: 'pass' });
	});

	test('a Semgrep process exit with zero findings is an explicit nonblocking degradation', async () => {
		sastResult = {
			...cleanSastResult(),
			verdict: 'fail',
			error:
				'Semgrep execution failed: Semgrep exited with code 7; run Semgrep directly in the project to diagnose',
			failure_kind: 'semgrep_process_exit',
		};

		const result = await runPreCheckBatch({
			files: ['safe.ts'],
			directory,
		});

		expect(result.gates_passed).toBe(true);
		expect(result.sast_degraded).toBe(true);
		expect(result.sast_scan.result?.error).toContain('code 7');
		expect(
			decodePreCheckResult(batchInternals.serializePreCheckResult(result)),
		).toEqual({ kind: 'pass' });
	});

	test('a Semgrep process exit with any finding remains blocking', async () => {
		sastResult = {
			...cleanSastResult(),
			verdict: 'fail',
			error: 'Semgrep execution failed: Semgrep exited with code 7',
			failure_kind: 'semgrep_process_exit',
			findings: [
				{
					rule_id: 'unsafe-eval',
					severity: 'high',
					message: 'Unsafe eval',
					location: { file: 'safe.ts', line: 1 },
				},
			],
		};

		const result = await runPreCheckBatch({
			files: ['safe.ts'],
			directory,
		});

		expect(result.gates_passed).toBe(false);
		expect(result.sast_degraded).not.toBe(true);
	});

	test.each([
		'coverage',
		'cancelled',
		'invalid_input',
		'semgrep_timeout',
		'semgrep_cancelled',
		'semgrep_output_limit',
		'semgrep_spawn_error',
		'semgrep_invalid_output',
		'semgrep_scan_error',
		'semgrep_unexpected',
		'semgrep_unclassified',
	] as const)('%s remains fail-closed', async (failureKind) => {
		sastResult = {
			...cleanSastResult(),
			verdict: 'fail',
			error: 'SAST could not complete safely',
			failure_kind: failureKind,
		};

		const result = await runPreCheckBatch({
			files: ['safe.ts'],
			directory,
		});

		expect(result.gates_passed).toBe(false);
		expect(result.sast_degraded).not.toBe(true);
	});

	test('a no-native-rules Kotlin scan can degrade, but never silently passes', async () => {
		fs.writeFileSync(path.join(directory, 'safe.kt'), 'fun main() {}\n');
		sastInternals.checkSemgrepAvailable = async () => true;
		sastInternals.runSemgrep = async () => ({
			available: true,
			findings: [],
			error:
				'Semgrep exited with code 7; run Semgrep directly in the project to diagnose',
			failure_kind: 'process_exit',
			engine: 'tier_a',
		});
		batchInternals.runSastScanWrapped = async (files, root) => ({
			ran: true,
			result: await sastScan({ changed_files: files }, root),
			duration_ms: 0,
		});

		const result = await runPreCheckBatch({
			files: ['safe.kt'],
			directory,
		});

		expect(result.gates_passed).toBe(true);
		expect(result.sast_degraded).toBe(true);
		expect(result.sast_scan.result).toMatchObject({
			failure_kind: 'semgrep_process_exit',
			summary: { files_scanned: 1 },
		});
	});
});
