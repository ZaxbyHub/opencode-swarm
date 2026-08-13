import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	quality_budget,
	qualityBudget,
} from '../../../src/tools/quality-budget';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const originalComputeQualityMetrics = _internals.computeQualityMetrics;
const originalQualityBudget = _internals.qualityBudget;
const tempDirs: string[] = [];

afterEach(() => {
	_internals.computeQualityMetrics = originalComputeQualityMetrics;
	_internals.qualityBudget = originalQualityBudget;
	for (const directory of tempDirs.splice(0)) {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

describe('quality budget cancellation - regression F-004', () => {
	test('public tool forwards the host cancellation signal', async () => {
		const directory = canonicalMkdtemp('quality-budget-tool-cancel-');
		tempDirs.push(directory);
		const controller = new AbortController();
		let observedSignal: AbortSignal | undefined;
		_internals.qualityBudget = async (_input, _directory, signal) => {
			observedSignal = signal;
			return {
				verdict: 'pass',
				metrics: {} as never,
				violations: [],
				summary: {
					files_analyzed: 0,
					violations_count: 0,
					errors_count: 0,
					warnings_count: 0,
				},
			};
		};

		await quality_budget.execute({ changed_files: ['src/example.ts'] }, {
			directory,
			abort: controller.signal,
		} as never);

		expect(observedSignal).toBe(controller.signal);
	});

	test('does not persist evidence after cancellation during metric computation', async () => {
		const directory = canonicalMkdtemp('quality-budget-cancel-');
		tempDirs.push(directory);
		let releaseMetrics!: () => void;
		const metricsReady = new Promise<void>((resolve) => {
			releaseMetrics = resolve;
		});
		_internals.computeQualityMetrics = async (_files, thresholds) => {
			await metricsReady;
			return {
				complexity_delta: 0,
				public_api_delta: 0,
				duplication_ratio: 0,
				test_to_code_ratio: 1,
				files_analyzed: [],
				thresholds,
				violations: [],
			};
		};
		const controller = new AbortController();

		const pending = qualityBudget(
			{ changed_files: ['src/example.ts'] },
			directory,
			controller.signal,
		);
		controller.abort();
		releaseMetrics();

		// Previous code discarded the wrapper signal and wrote evidence later.
		await expect(pending).rejects.toThrow();
		expect(
			fs.existsSync(
				path.join(
					directory,
					'.swarm',
					'evidence',
					'quality_budget',
					'evidence.json',
				),
			),
		).toBe(false);
	});
});
