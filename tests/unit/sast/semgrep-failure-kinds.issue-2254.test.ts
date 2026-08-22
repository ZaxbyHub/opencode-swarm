import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	_internals,
	runSemgrep,
	type SemgrepFailureKind,
} from '../../../src/sast/semgrep';

const originals = {
	resolveExecutableFromPath: _internals.resolveExecutableFromPath,
	runExternalTool: _internals.runExternalTool,
};

type RunResult = Awaited<ReturnType<typeof _internals.runExternalTool>>;

function completedRun(overrides: Partial<RunResult> = {}): RunResult {
	return {
		status: 'completed',
		exitCode: 0,
		stdout: '',
		stderr: '',
		stdoutTruncated: false,
		stderrTruncated: false,
		...overrides,
	};
}

beforeEach(() => {
	_internals.resetSemgrepCache();
	_internals.resolveExecutableFromPath = () => '/fake/semgrep';
});

afterEach(() => {
	_internals.resolveExecutableFromPath = originals.resolveExecutableFromPath;
	_internals.runExternalTool = originals.runExternalTool;
	_internals.resetSemgrepCache();
});

async function runWithScanResult(scanResult: RunResult) {
	_internals.runExternalTool = async (options) =>
		options.args[0] === '--version'
			? completedRun({ stdout: '1.173.0' })
			: scanResult;
	return runSemgrep({ files: ['safe.ts'], useAutoConfig: true });
}

describe('Semgrep typed failures — issue #2254', () => {
	test.each([
		['timeout', 'timeout', 'Semgrep process timed out'],
		['cancelled', 'cancelled', 'Semgrep execution cancelled'],
		[
			'spawn-error',
			'spawn_error',
			'Semgrep process failed to start or terminate safely',
		],
	] as const)('classifies external-runner %s separately', async (status, failureKind, message) => {
		const result = await runWithScanResult(
			completedRun({ status, exitCode: null }),
		);

		expect(result).toMatchObject({
			findings: [],
			error: message,
			failure_kind: failureKind,
		});
	});

	test('classifies bounded-output overflow without exposing output', async () => {
		const secret = 'Authorization: Bearer hidden-marker';
		const result = await runWithScanResult(
			completedRun({
				stdout: secret,
				stderr: 'C:\\private\\source.ts',
				stdoutTruncated: true,
			}),
		);

		expect(result.failure_kind).toBe('output_limit');
		expect(result.error).toContain('truncated');
		expect(result.error).not.toContain('hidden-marker');
		expect(result.error).not.toContain('private');
	});

	test('classifies invalid JSON separately', async () => {
		const result = await runWithScanResult(
			completedRun({ stdout: '{not-json' }),
		);

		expect(result).toMatchObject({
			failure_kind: 'invalid_output',
			error: 'Semgrep returned invalid JSON output',
		});
	});

	test('classifies structured partial-scan errors separately', async () => {
		const result = await runWithScanResult(
			completedRun({
				stdout: JSON.stringify({
					results: [],
					errors: [{ type: 'ParseError', message: 'incomplete' }],
				}),
			}),
		);

		expect(result).toMatchObject({
			failure_kind: 'scan_error',
			error: 'Semgrep reported 1 scan error',
		});
	});

	test('classifies unexpected wrapper exceptions separately', async () => {
		_internals.runExternalTool = async (options) => {
			if (options.args[0] === '--version') {
				return completedRun({ stdout: '1.173.0' });
			}
			throw new Error('C:\\secret\\source.ts bearer hidden-marker');
		};

		const result = await runSemgrep({ files: ['safe.ts'] });

		expect(result).toMatchObject({
			failure_kind: 'unexpected',
			error: 'Semgrep execution failed unexpectedly',
		});
		expect(result.error).not.toContain('hidden-marker');
	});

	test('only a completed nonzero exit receives process_exit guidance', async () => {
		const secret = 'Bearer hidden-marker C:\\private\\source.ts';
		const result = await runWithScanResult(
			completedRun({ exitCode: 7, stderr: secret }),
		);

		expect(result.failure_kind satisfies SemgrepFailureKind).toBe(
			'process_exit',
		);
		expect(result.error).toBe(
			'Semgrep exited with code 7; run Semgrep directly in the project to diagnose',
		);
		expect(result.error).not.toContain('hidden-marker');
		expect(result.error).not.toContain('private');
	});

	test('maps the reporter-confirmed stderr to a fixed safe explanation', async () => {
		const result = await runWithScanResult(
			completedRun({
				exitCode: 7,
				stderr:
					'[00.13][ERROR]: -e/--pattern and -l/--lang must both be specified',
			}),
		);

		expect(result).toMatchObject({
			failure_kind: 'process_exit',
			error:
				'Semgrep exited with code 7: incompatible --lang option in config mode',
		});
	});
});
