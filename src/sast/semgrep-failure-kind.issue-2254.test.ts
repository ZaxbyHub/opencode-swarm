import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { ExternalToolRunResult } from '../utils/external-tool-runner';
import { _internals, resetSemgrepCache, runSemgrep } from './semgrep';

const originalResolveExecutableFromPath = _internals.resolveExecutableFromPath;
const originalRunExternalTool = _internals.runExternalTool;

function completedRun(
	overrides: Partial<ExternalToolRunResult> = {},
): ExternalToolRunResult {
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
	resetSemgrepCache();
	_internals.resolveExecutableFromPath = originalResolveExecutableFromPath;
	_internals.runExternalTool = originalRunExternalTool;
});

afterEach(() => {
	resetSemgrepCache();
	_internals.resolveExecutableFromPath = originalResolveExecutableFromPath;
	_internals.runExternalTool = originalRunExternalTool;
});

describe('Semgrep early failure kinds — issue #2254', () => {
	test('classifies an unavailable Semgrep probe as a spawn error', async () => {
		_internals.resolveExecutableFromPath = () => null;

		const result = await runSemgrep({ files: ['test.ts'] });

		expect(result.available).toBe(false);
		expect(result.failure_kind).toBe('spawn_error');
	});

	test('classifies an aborted availability check as cancellation', async () => {
		const controller = new AbortController();
		controller.abort();

		const result = await runSemgrep({
			files: ['test.ts'],
			abortSignal: controller.signal,
		});

		expect(result.available).toBe(true);
		expect(result.failure_kind).toBe('cancelled');
	});

	test('classifies a binary disappearing after the availability probe as a spawn error', async () => {
		let resolutions = 0;
		_internals.resolveExecutableFromPath = () => {
			resolutions++;
			return resolutions === 1 ? '/fake/semgrep' : null;
		};
		_internals.runExternalTool = async () => completedRun({ stdout: '1.0.0' });

		const result = await runSemgrep({ files: ['test.ts'] });

		expect(result.available).toBe(false);
		expect(result.failure_kind).toBe('spawn_error');
	});
});
