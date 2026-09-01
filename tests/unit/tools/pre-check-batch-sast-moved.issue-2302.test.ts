/**
 * Issue #2302 — pre_check_batch wiring for SAST moved findings.
 *
 * Moved findings (reflow-matched: same finding, new position/window) join the
 * pre-existing reviewer triage bucket under the same severity filter and
 * never gate.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
	_internals,
	runPreCheckBatch,
} from '../../../src/tools/pre-check-batch';
import type {
	SastScanFinding,
	SastScanResult,
} from '../../../src/tools/sast-scan';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const originalRunLintWrapped = _internals.runLintWrapped;
const originalRunSecretscanWrapped = _internals.runSecretscanWrapped;
const originalRunSastScanWrapped = _internals.runSastScanWrapped;
const originalRunQualityBudgetWrapped = _internals.runQualityBudgetWrapped;
const originalGetChangedLineRanges = _internals.getChangedLineRanges;

let tempDir = '';
let sastResult: SastScanResult;

function makeFinding(
	file: string,
	line: number,
	overrides: Partial<SastScanFinding> = {},
): SastScanFinding {
	return {
		rule_id: `moved-rule-${line}`,
		severity: 'high',
		message: `Moved finding at ${file}:${line}`,
		location: { file, line },
		...overrides,
	};
}

function makeBaselineResult(parts: {
	new?: SastScanFinding[];
	preExisting?: SastScanFinding[];
	moved?: SastScanFinding[];
}): SastScanResult {
	const all = [
		...(parts.new ?? []),
		...(parts.preExisting ?? []),
		...(parts.moved ?? []),
	];
	const count = (sev: SastScanFinding['severity']) =>
		all.filter((f) => f.severity === sev).length;
	return {
		verdict: (parts.new ?? []).length > 0 ? 'fail' : 'pass',
		findings: all,
		summary: {
			engine: 'tier_a',
			files_scanned: 1,
			findings_count: all.length,
			findings_by_severity: {
				critical: count('critical'),
				high: count('high'),
				medium: count('medium'),
				low: count('low'),
			},
		},
		new_findings: parts.new ?? [],
		pre_existing_findings: parts.preExisting ?? [],
		moved_findings: parts.moved ?? [],
		baseline_used: true,
	};
}

beforeEach(() => {
	tempDir = canonicalMkdtemp('sast-moved-gate-');
	sastResult = makeBaselineResult({});

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
	_internals.getChangedLineRanges = async () => null;
});

afterEach(async () => {
	_internals.runLintWrapped = originalRunLintWrapped;
	_internals.runSecretscanWrapped = originalRunSecretscanWrapped;
	_internals.runSastScanWrapped = originalRunSastScanWrapped;
	_internals.runQualityBudgetWrapped = originalRunQualityBudgetWrapped;
	_internals.getChangedLineRanges = originalGetChangedLineRanges;
	await fs.rm(tempDir, { recursive: true, force: true });
});

test('moved HIGH findings pass the gate and reach reviewer triage', async () => {
	sastResult = makeBaselineResult({
		moved: [makeFinding(path.join(tempDir, 'test.ts'), 42)],
	});
	const result = await runPreCheckBatch({
		files: ['test.ts'],
		directory: tempDir,
	});
	expect(result.gates_passed).toBe(true);
	expect(result.sast_preexisting_findings).toHaveLength(1);
	expect(result.sast_preexisting_findings?.[0].location.line).toBe(42);
});

test('moved and pre-existing findings both reach reviewer triage', async () => {
	sastResult = makeBaselineResult({
		preExisting: [makeFinding(path.join(tempDir, 'test.ts'), 1)],
		moved: [makeFinding(path.join(tempDir, 'test.ts'), 99)],
	});
	const result = await runPreCheckBatch({
		files: ['test.ts'],
		directory: tempDir,
	});
	expect(result.gates_passed).toBe(true);
	expect(result.sast_preexisting_findings).toHaveLength(2);
});

test('moved findings never gate even at critical severity', async () => {
	sastResult = makeBaselineResult({
		moved: [
			makeFinding(path.join(tempDir, 'test.ts'), 7, { severity: 'critical' }),
		],
	});
	const result = await runPreCheckBatch({
		files: ['test.ts'],
		directory: tempDir,
	});
	expect(result.gates_passed).toBe(true);
	expect(result.sast_preexisting_findings).toHaveLength(1);
});

test('a new finding still blocks the gate when moved findings are present', async () => {
	sastResult = makeBaselineResult({
		new: [makeFinding(path.join(tempDir, 'test.ts'), 5)],
		moved: [makeFinding(path.join(tempDir, 'test.ts'), 50)],
	});
	const result = await runPreCheckBatch({
		files: ['test.ts'],
		directory: tempDir,
	});
	expect(result.gates_passed).toBe(false);
	// Triage is populated regardless of verdict.
	expect(result.sast_preexisting_findings).toHaveLength(1);
	expect(result.sast_preexisting_findings?.[0].location.line).toBe(50);
});

test('low-severity moved findings are filtered by the default triage threshold', async () => {
	sastResult = makeBaselineResult({
		moved: [makeFinding(path.join(tempDir, 'test.ts'), 3, { severity: 'low' })],
	});
	const result = await runPreCheckBatch({
		files: ['test.ts'],
		directory: tempDir,
	});
	expect(result.gates_passed).toBe(true);
	expect(result.sast_preexisting_findings).toBeUndefined();
});
