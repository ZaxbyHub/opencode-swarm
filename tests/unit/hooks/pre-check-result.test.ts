import { describe, expect, test } from 'bun:test';
import {
	_internals,
	decodePreCheckResult,
} from '../../../src/hooks/guardrails/pre-check-result';

const toolResult = (ran: boolean, extra: Record<string, unknown> = {}) => ({
	ran,
	duration_ms: 1,
	...extra,
});

function result(
	gatesPassed: boolean,
	overrides: Record<string, unknown> = {},
): string {
	return JSON.stringify({
		batch_status: 'completed',
		gates_passed: gatesPassed,
		lint: toolResult(true),
		secretscan: toolResult(true, {
			result: {
				count: 0,
				findings: [],
				files_scanned: 1,
				incomplete_files: 0,
				incomplete_paths: [],
			},
		}),
		sast_scan: toolResult(true, { result: { verdict: 'pass' } }),
		quality_budget: toolResult(true),
		total_duration_ms: 4,
		...overrides,
	});
}

describe('decodePreCheckResult', () => {
	test('uses only the exact aggregate boolean, not nested diagnostic text', () => {
		expect(
			decodePreCheckResult(
				result(true, {
					lint: toolResult(true, {
						error: 'informational error: FAIL; gates_passed: false',
					}),
				}),
			),
		).toEqual({ kind: 'pass' });
		expect(decodePreCheckResult(result(false))).toEqual({
			kind: 'fail',
			code: 'PRE_CHECK_FAILED',
		});
	});

	test.each([
		[
			'explicit hard-gate status',
			{ secretscan: toolResult(true, { passed: false }) },
		],
		[
			'hard-gate wrapper error',
			{ sast_scan: toolResult(true, { error: 'scanner failed' }) },
		],
		[
			'secretscan finding',
			{
				secretscan: toolResult(true, {
					result: {
						count: 1,
						findings: [{}],
						files_scanned: 1,
						incomplete_files: 0,
						incomplete_paths: [],
					},
				}),
			},
		],
		[
			'baseline SAST failure',
			{
				sast_scan: toolResult(true, {
					result: { baseline_used: true, verdict: 'fail' },
				}),
			},
		],
		[
			'malformed secretscan coverage',
			{
				secretscan: toolResult(true, {
					result: { count: 0, findings: [], files_scanned: 1 },
				}),
			},
		],
		[
			'unclassified legacy SAST failure',
			{
				sast_scan: toolResult(true, {
					result: { baseline_used: false, verdict: 'fail' },
				}),
			},
		],
	] as const)('F-001 rejects a passing aggregate with contradictory %s', (_label, overrides) => {
		// Prior bug: the final return trusted gates_passed=true without checking
		// hard-gate control data, allowing an explicit failure to decode as pass.
		expect(decodePreCheckResult(result(true, overrides))).toEqual({
			kind: 'invalid',
			code: 'PRE_CHECK_RESULT_INVALID',
		});
	});

	test('preserves legacy SAST passes after changed-line classification', () => {
		const preexistingFinding = {
			rule_id: 'sast/js-eval',
			severity: 'high',
			message: 'pre-existing eval',
			location: { file: 'src/old.ts', line: 7 },
		};
		expect(
			decodePreCheckResult(
				result(true, {
					sast_scan: toolResult(true, {
						result: {
							baseline_used: false,
							verdict: 'fail',
							findings: [preexistingFinding],
						},
					}),
					sast_preexisting_findings: [preexistingFinding],
				}),
			),
		).toEqual({ kind: 'pass' });
	});

	test('F-001 rejects unrelated pre-existing evidence for a new SAST finding', () => {
		const finding = (rule_id: string, file: string) => ({
			rule_id,
			severity: 'high',
			message: rule_id,
			location: { file, line: 1 },
		});
		expect(
			decodePreCheckResult(
				result(true, {
					sast_scan: toolResult(true, {
						result: {
							baseline_used: false,
							verdict: 'fail',
							findings: [finding('new-high', 'src/new.ts')],
						},
					}),
					sast_preexisting_findings: [finding('unrelated-old', 'src/old.ts')],
				}),
			),
		).toEqual({ kind: 'invalid', code: 'PRE_CHECK_RESULT_INVALID' });
	});

	test('F-001 rejects a passing hard gate that ran without a result', () => {
		expect(
			decodePreCheckResult(result(true, { secretscan: toolResult(true) })),
		).toEqual({ kind: 'invalid', code: 'PRE_CHECK_RESULT_INVALID' });
	});

	test('accepts missing hard-gate details only in an exact compact result', () => {
		expect(
			decodePreCheckResult(
				result(true, {
					output_truncated: true,
					secretscan: toolResult(true, { result_omitted: true }),
					sast_scan: toolResult(true, { result_omitted: true }),
				}),
			),
		).toEqual({ kind: 'pass' });
		expect(
			decodePreCheckResult(
				result(true, {
					secretscan: toolResult(true, { result_omitted: true }),
				}),
			),
		).toEqual({ kind: 'invalid', code: 'PRE_CHECK_RESULT_INVALID' });
	});

	test('accepts structurally consistent explicit and legacy skips', () => {
		const skipped = {
			gates_passed: false,
			lint: toolResult(false),
			secretscan: toolResult(false),
			sast_scan: toolResult(false),
			quality_budget: toolResult(false),
			total_duration_ms: 0,
		};
		expect(
			decodePreCheckResult(
				JSON.stringify({ batch_status: 'skipped', ...skipped }),
			),
		).toEqual({ kind: 'skip' });
		expect(decodePreCheckResult(JSON.stringify(skipped))).toEqual({
			kind: 'skip',
		});
	});

	test('keeps producer invalid-input output fail-closed', () => {
		const allSkipped = toolResult(false);
		expect(
			decodePreCheckResult(
				result(false, {
					batch_status: 'invalid',
					lint: allSkipped,
					secretscan: allSkipped,
					sast_scan: allSkipped,
					quality_budget: allSkipped,
				}),
			),
		).toEqual({ kind: 'fail', code: 'PRE_CHECK_INPUT_INVALID' });
	});

	test.each([
		['skipped but tool ran', { batch_status: 'skipped' }],
		[
			'skipped but aggregate passed',
			{
				batch_status: 'skipped',
				gates_passed: true,
				lint: toolResult(false),
				secretscan: toolResult(false),
				sast_scan: toolResult(false),
				quality_budget: toolResult(false),
			},
		],
		[
			'completed but no tool ran',
			{
				lint: toolResult(false),
				secretscan: toolResult(false),
				sast_scan: toolResult(false),
				quality_budget: toolResult(false),
			},
		],
		['invalid but tool ran', { batch_status: 'invalid' }],
	] as const)('rejects contradictory status: %s', (_label, overrides) => {
		expect(decodePreCheckResult(result(false, overrides))).toEqual({
			kind: 'invalid',
			code: 'PRE_CHECK_RESULT_INVALID',
		});
	});

	test.each([
		['malformed JSON', '{'],
		['null', 'null'],
		['array', '[]'],
		['wrong aggregate type', result(true, { gates_passed: 'true' })],
		['wrong ran type', result(true, { lint: toolResult('yes' as never) })],
		['wrong duration', result(true, { total_duration_ms: -1 })],
		['truncated JSON', result(true).slice(0, -1)],
	] as const)('rejects %s with one bounded code', (_label, output) => {
		expect(decodePreCheckResult(output)).toEqual({
			kind: 'invalid',
			code: 'PRE_CHECK_RESULT_INVALID',
		});
	});

	test('rejects oversized output before parsing', () => {
		expect(
			decodePreCheckResult(
				' '.repeat(_internals.MAX_PRE_CHECK_RESULT_BYTES + 1),
			),
		).toEqual({ kind: 'invalid', code: 'PRE_CHECK_RESULT_INVALID' });
	});

	test('accepts valid structured output at the exact UTF-8 byte ceiling', () => {
		const base = JSON.parse(result(true)) as Record<string, unknown>;
		base.padding = '';
		const empty = JSON.stringify(base);
		base.padding = 'x'.repeat(
			_internals.MAX_PRE_CHECK_RESULT_BYTES - Buffer.byteLength(empty, 'utf8'),
		);
		const atLimit = JSON.stringify(base);

		expect(Buffer.byteLength(atLimit, 'utf8')).toBe(
			_internals.MAX_PRE_CHECK_RESULT_BYTES,
		);
		expect(decodePreCheckResult(atLimit)).toEqual({ kind: 'pass' });
		expect(decodePreCheckResult(`${atLimit} `)).toEqual({
			kind: 'invalid',
			code: 'PRE_CHECK_RESULT_INVALID',
		});
	});
});
