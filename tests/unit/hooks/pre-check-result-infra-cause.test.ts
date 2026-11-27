/**
 * 2026-11-27 (task 2.18 retry-circuit wedge): the pre_check failure CAUSE
 * classification. `decodePreCheckResult` must distinguish what a failing
 * batch says about the CODE under gate:
 *  - `'infrastructure'` ONLY for positively proven execution/persistence
 *    failures (gate wrapper error, scan-process error with zero findings,
 *    malformed batch input) — the shapes that wedged task 2.18's retry
 *    circuit without a single content rejection;
 *  - `'content'` for everything else, including every unprovable shape
 *    (findings, fail verdicts, baseline mismatch, truncation,
 *    contradictions). Conservative by construction: the retry budget may
 *    only be spared when the failure is PROVEN to say nothing about the code.
 */
import { describe, expect, test } from 'bun:test';
import { decodePreCheckResult } from '../../../src/hooks/guardrails/pre-check-result';

function tool(ran: boolean, extra: Record<string, unknown> = {}) {
	return { ran, duration_ms: 1, ...extra };
}

function result(
	gatesPassed: boolean,
	gateOverrides: Record<string, unknown> = {},
	batchOverrides: Record<string, unknown> = {},
): string {
	return JSON.stringify({
		batch_status: 'completed',
		gates_passed: gatesPassed,
		total_duration_ms: 1,
		lint: tool(true),
		secretscan: tool(true, {
			result: {
				count: 0,
				findings: [],
				files_scanned: 5,
				incomplete_files: 0,
				incomplete_paths: [],
			},
		}),
		sast_scan: tool(true, { result: { verdict: 'pass', findings: [] } }),
		quality_budget: tool(false),
		...gateOverrides,
		...batchOverrides,
	});
}

const PERSIST_ERROR =
	'Failed to persist sast evidence: Evidence bundle size (528522 bytes) exceeds maximum (512000 bytes)';

describe('decodePreCheckResult — failure cause classification', () => {
	test('the 2.18 shape: a clean scan whose evidence save threw is infrastructure', () => {
		expect(
			decodePreCheckResult(
				result(false, {
					sast_scan: tool(true, {
						result: { verdict: 'pass', findings: [] },
						error: PERSIST_ERROR,
					}),
				}),
			),
		).toEqual({
			kind: 'fail',
			code: 'PRE_CHECK_FAILED',
			cause: 'infrastructure',
		});
	});

	test('a secretscan wrapper error (scan tool failed to run) is infrastructure', () => {
		expect(
			decodePreCheckResult(
				result(false, {
					secretscan: tool(true, {
						error: 'Secretscan wrapper error: spawn ENOENT',
					}),
				}),
			),
		).toEqual({
			kind: 'fail',
			code: 'PRE_CHECK_FAILED',
			cause: 'infrastructure',
		});
	});

	test('a scan-process error with zero findings is infrastructure', () => {
		expect(
			decodePreCheckResult(
				result(false, {
					sast_scan: tool(true, {
						result: {
							verdict: 'fail',
							error: 'Semgrep execution failed: spawn ENOENT',
							failure_kind: 'semgrep_spawn_error',
							findings: [],
						},
					}),
				}),
			),
		).toEqual({
			kind: 'fail',
			code: 'PRE_CHECK_FAILED',
			cause: 'infrastructure',
		});
	});

	test('an error WITH findings is content (the findings are real)', () => {
		expect(
			decodePreCheckResult(
				result(false, {
					sast_scan: tool(true, {
						result: {
							verdict: 'fail',
							error: 'semgrep degraded mid-scan',
							failure_kind: 'semgrep_process_exit',
							findings: [
								{
									rule_id: 'py-assert',
									severity: 'high',
									message: 'assert',
									location: { file: 'src/a.py', line: 1 },
								},
							],
						},
					}),
				}),
			),
		).toEqual({ kind: 'fail', code: 'PRE_CHECK_FAILED', cause: 'content' });
	});

	test('secretscan findings are content', () => {
		expect(
			decodePreCheckResult(
				result(false, {
					secretscan: tool(true, {
						result: {
							count: 1,
							findings: [{ path: 'src/a.ts', line: 1, type: 'aws-key' }],
							files_scanned: 5,
							incomplete_files: 0,
							incomplete_paths: [],
						},
					}),
				}),
			),
		).toEqual({ kind: 'fail', code: 'PRE_CHECK_FAILED', cause: 'content' });
	});

	test('a SAST fail verdict with new findings is content', () => {
		expect(
			decodePreCheckResult(
				result(false, {
					sast_scan: tool(true, {
						result: {
							verdict: 'fail',
							findings: [
								{
									rule_id: 'py-assert',
									severity: 'critical',
									message: 'assert',
									location: { file: 'src/a.py', line: 1 },
								},
							],
						},
					}),
				}),
			),
		).toEqual({ kind: 'fail', code: 'PRE_CHECK_FAILED', cause: 'content' });
	});

	test('a baseline-diff SAST failure is content (baseline failures are definitive)', () => {
		expect(
			decodePreCheckResult(
				result(false, {
					sast_scan: tool(true, {
						result: { verdict: 'fail', findings: [], baseline_used: true },
					}),
				}),
			),
		).toEqual({ kind: 'fail', code: 'PRE_CHECK_FAILED', cause: 'content' });
	});

	test('truncation (the compact-omitted error message) is content, never infrastructure', () => {
		expect(
			decodePreCheckResult(
				result(
					false,
					{
						sast_scan: tool(true, {
							result: { verdict: 'pass', findings: [] },
							error:
								'Detailed tool result omitted because the batch output exceeded its byte limit',
						}),
					},
					{ output_truncated: true },
				),
			),
		).toEqual({ kind: 'fail', code: 'PRE_CHECK_FAILED', cause: 'content' });
	});

	test('an omitted result (result_omitted) is content', () => {
		expect(
			decodePreCheckResult(
				result(
					false,
					{ sast_scan: tool(true, { result_omitted: true }) },
					{ output_truncated: true },
				),
			),
		).toEqual({ kind: 'fail', code: 'PRE_CHECK_FAILED', cause: 'content' });
	});

	test('the degraded semgrep shape WITHOUT the degraded flag is contradictory, therefore content', () => {
		expect(
			decodePreCheckResult(
				result(false, {
					sast_scan: tool(true, {
						result: {
							verdict: 'fail',
							error: 'semgrep exited 1',
							failure_kind: 'semgrep_process_exit',
							findings: [],
						},
					}),
				}),
			),
		).toEqual({ kind: 'fail', code: 'PRE_CHECK_FAILED', cause: 'content' });
	});

	test('a gate that failed with neither an error nor content signals is contradictory, therefore content', () => {
		expect(
			decodePreCheckResult(
				result(false, {
					sast_scan: tool(false),
				}),
			),
		).toEqual({ kind: 'fail', code: 'PRE_CHECK_FAILED', cause: 'content' });
	});

	test('a failing batch where NO gate shows any failure signal is content', () => {
		expect(decodePreCheckResult(result(false))).toEqual({
			kind: 'fail',
			code: 'PRE_CHECK_FAILED',
			cause: 'content',
		});
	});

	test('a clean infra error on one gate with real findings on the other is content', () => {
		expect(
			decodePreCheckResult(
				result(false, {
					sast_scan: tool(true, {
						result: { verdict: 'pass', findings: [] },
						error: PERSIST_ERROR,
					}),
					secretscan: tool(true, {
						result: {
							count: 2,
							findings: [
								{ path: 'src/a.ts', line: 1, type: 'aws-key' },
								{ path: 'src/b.ts', line: 2, type: 'aws-key' },
							],
							files_scanned: 5,
							incomplete_files: 0,
							incomplete_paths: [],
						},
					}),
				}),
			),
		).toEqual({ kind: 'fail', code: 'PRE_CHECK_FAILED', cause: 'content' });
	});

	test('an invalid batch input is infrastructure (the call was rejected, not the content)', () => {
		const allSkipped = tool(false, { error: 'No files provided' });
		expect(
			decodePreCheckResult(
				result(
					false,
					{},
					{
						batch_status: 'invalid',
						lint: allSkipped,
						secretscan: allSkipped,
						sast_scan: allSkipped,
						quality_budget: allSkipped,
					},
				),
			),
		).toEqual({
			kind: 'fail',
			code: 'PRE_CHECK_INPUT_INVALID',
			cause: 'infrastructure',
		});
	});

	test('pass and skip verdicts carry no cause (unchanged shapes)', () => {
		expect(decodePreCheckResult(result(true))).toEqual({ kind: 'pass' });
		const allSkipped = tool(false);
		expect(
			decodePreCheckResult(
				result(
					false,
					{
						lint: allSkipped,
						secretscan: allSkipped,
						sast_scan: allSkipped,
						quality_budget: allSkipped,
					},
					{ batch_status: 'skipped' },
				),
			),
		).toEqual({ kind: 'skip' });
	});
});
