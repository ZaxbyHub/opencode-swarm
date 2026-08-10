import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_internals,
	runPreCheckBatch,
} from '../../../src/tools/pre-check-batch';
import type {
	SastScanFinding,
	SastScanResult,
} from '../../../src/tools/sast-scan';

const originalRunLintWrapped = _internals.runLintWrapped;
const originalRunSecretscanWrapped = _internals.runSecretscanWrapped;
const originalRunSastScanWrapped = _internals.runSastScanWrapped;
const originalRunQualityBudgetWrapped = _internals.runQualityBudgetWrapped;
const originalGetChangedLineRanges = _internals.getChangedLineRanges;

let tempDir = '';
let sastResult: SastScanResult;
let changedLineRanges: Map<string, Set<number>> | null;

function makeFinding(
	file: string,
	line: number,
	overrides: Partial<SastScanFinding> = {},
): SastScanFinding {
	return {
		rule_id: `test-rule-${line}`,
		severity: 'high',
		message: `Test finding at ${file}:${line}`,
		location: { file, line },
		...overrides,
	};
}

function makeSastResult(findings: SastScanFinding[]): SastScanResult {
	const findingsBySeverity = {
		critical: findings.filter((finding) => finding.severity === 'critical')
			.length,
		high: findings.filter((finding) => finding.severity === 'high').length,
		medium: findings.filter((finding) => finding.severity === 'medium').length,
		low: findings.filter((finding) => finding.severity === 'low').length,
	};
	return {
		verdict: findings.length > 0 ? 'fail' : 'pass',
		findings,
		summary: {
			engine: 'tier_a',
			files_scanned: 1,
			findings_count: findings.length,
			findings_by_severity: findingsBySeverity,
		},
	};
}

beforeEach(() => {
	tempDir = realpathSync(
		mkdtempSync(path.join(os.tmpdir(), 'sast-gate-test-')),
	);
	sastResult = makeSastResult([]);
	changedLineRanges = null;

	_internals.runLintWrapped = async () => ({
		ran: true,
		result: {
			success: true,
			mode: 'check',
			linter: 'biome',
			command: ['biome', 'check', '.'],
			exitCode: 0,
			output: '',
			message: 'No issues found',
		},
		duration_ms: 0,
	});
	_internals.runSecretscanWrapped = async () => ({
		ran: true,
		result: {
			scan_dir: tempDir,
			findings: [],
			count: 0,
			files_scanned: 1,
			skipped_files: 0,
			incomplete_files: 0,
			incomplete_paths: [],
		},
		duration_ms: 0,
	});
	_internals.runSastScanWrapped = async () => ({
		ran: true,
		result: sastResult,
		duration_ms: 0,
	});
	_internals.runQualityBudgetWrapped = async () => ({
		ran: true,
		result: {
			verdict: 'pass',
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
		},
		duration_ms: 0,
	});
	_internals.getChangedLineRanges = async () => changedLineRanges;
});

afterEach(async () => {
	_internals.runLintWrapped = originalRunLintWrapped;
	_internals.runSecretscanWrapped = originalRunSecretscanWrapped;
	_internals.runSastScanWrapped = originalRunSastScanWrapped;
	_internals.runQualityBudgetWrapped = originalRunQualityBudgetWrapped;
	_internals.getChangedLineRanges = originalGetChangedLineRanges;
	await fs.rm(tempDir, { recursive: true, force: true });
});

describe('runPreCheckBatch SAST gate integration', () => {
	test('new HIGH finding on a changed line blocks the gate', async () => {
		sastResult = makeSastResult([
			makeFinding(path.join(tempDir, 'test.ts'), 1, {
				rule_id: 'sql-injection',
			}),
		]);
		const result = await runPreCheckBatch({
			files: ['test.ts'],
			directory: tempDir,
		});
		expect(result.gates_passed).toBe(false);
		expect(result.sast_preexisting_findings).toBeUndefined();
	});

	test('only pre-existing HIGH findings pass through to the reviewer', async () => {
		changedLineRanges = new Map([['test.ts', new Set<number>()]]);
		sastResult = makeSastResult([
			makeFinding(path.join(tempDir, 'test.ts'), 1, {
				rule_id: 'sql-injection',
			}),
		]);
		const result = await runPreCheckBatch({
			files: ['test.ts'],
			directory: tempDir,
		});
		expect(result.gates_passed).toBe(true);
		expect(result.sast_preexisting_findings).toHaveLength(1);
		expect(result.sast_preexisting_findings?.[0].rule_id).toBe('sql-injection');
	});

	test('mixed new and pre-existing findings still block the gate', async () => {
		changedLineRanges = new Map([['test.ts', new Set([1])]]);
		sastResult = makeSastResult([
			makeFinding(path.join(tempDir, 'test.ts'), 1, { rule_id: 'xss-new' }),
			makeFinding(path.join(tempDir, 'test.ts'), 50, { rule_id: 'sql-old' }),
		]);
		const result = await runPreCheckBatch({
			files: ['test.ts'],
			directory: tempDir,
		});
		expect(result.gates_passed).toBe(false);
		expect(result.sast_preexisting_findings).toBeUndefined();
	});

	test('reviewer receives the complete structured pre-existing finding', async () => {
		changedLineRanges = new Map([['test.ts', new Set<number>()]]);
		const findingFile = path.join(tempDir, 'test.ts');
		sastResult = makeSastResult([
			makeFinding(findingFile, 1, {
				rule_id: 'hardcoded-secret',
				severity: 'critical',
				message: 'Hardcoded secret on unchanged line',
				remediation: 'Use environment variables',
			}),
		]);
		const result = await runPreCheckBatch({
			files: ['test.ts'],
			directory: tempDir,
		});
		expect(result.gates_passed).toBe(true);
		expect(result.sast_preexisting_findings?.[0]).toEqual({
			rule_id: 'hardcoded-secret',
			severity: 'critical',
			message: 'Hardcoded secret on unchanged line',
			location: { file: findingFile, line: 1 },
			remediation: 'Use environment variables',
		});
	});

	test('a clean changed file is not blocked by a finding in an unchanged file', async () => {
		changedLineRanges = new Map([['clean.ts', new Set([1])]]);
		sastResult = makeSastResult([
			makeFinding(path.join(tempDir, 'legacy.ts'), 1, {
				rule_id: 'eval-injection',
			}),
		]);
		const result = await runPreCheckBatch({
			files: ['clean.ts'],
			directory: tempDir,
		});
		expect(result.gates_passed).toBe(true);
		expect(result.sast_preexisting_findings).toHaveLength(1);
		expect(result.sast_preexisting_findings?.[0].rule_id).toBe(
			'eval-injection',
		);
	});
});
