import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleBenchmarkCommand } from '../../../src/commands/benchmark.js';
import {
	type GateGroundTruthV1,
	saveGateGroundTruth,
} from '../../../src/evaluation/gate-ground-truth.js';
import { saveGateAuditResult } from '../../../src/evaluation/store.js';

function project(): string {
	return fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'gate-benchmark-truth-')),
	);
}

function audit(runId: string, repetitions = 6) {
	return {
		v: 1 as const,
		runId,
		manifestHash: 'a'.repeat(64),
		createdAt: '2026-07-13T12:00:00.000Z',
		status: 'complete' as const,
		cells: Array.from({ length: repetitions }, (_, repetition) => [
			{
				v: 1 as const,
				taskId: 'task-a',
				candidateId: 'defect-task-a',
				defectType: 'correctness',
				gate: 'mutation' as const,
				model: 'configured',
				repetition,
				outcome: 'caught' as const,
				retries: 0,
				cost: { source: 'reported' as const, usd: 0 },
				durationMs: 1,
				failureClassification: 'new_regression' as const,
			},
			{
				v: 1 as const,
				taskId: 'task-a',
				candidateId: 'clean-task-a',
				defectType: 'correctness',
				gate: 'mutation' as const,
				model: 'configured',
				repetition,
				outcome: 'missed' as const,
				retries: 0,
				cost: { source: 'reported' as const, usd: 0 },
				durationMs: 1,
				failureClassification: 'clean' as const,
			},
		]).flat(),
		cost: { source: 'reported' as const, usd: 0 },
		qualityMetricAvailability: {
			complexity_delta: 'unavailable' as const,
			public_api_delta: 'unavailable' as const,
		},
	};
}

function truth(runId: string, repetitions = 6): GateGroundTruthV1[] {
	return Array.from({ length: repetitions }, (_, repetition) => [
		{
			v: 1 as const,
			runId,
			taskId: 'task-a',
			candidateId: 'defect-task-a',
			model: 'configured',
			gate: 'mutation' as const,
			repetition,
			source: 'test-impact' as const,
			classification: 'new_regression' as const,
			observedAt: '2026-07-13T12:00:00.000Z',
		},
		{
			v: 1 as const,
			runId,
			taskId: 'task-a',
			candidateId: 'clean-task-a',
			model: 'configured',
			gate: 'mutation' as const,
			repetition,
			source: 'test-impact' as const,
			classification: 'clean' as const,
			observedAt: '2026-07-13T12:00:00.000Z',
		},
	]).flat();
}

async function benchmark(root: string, runId: string): Promise<string> {
	return handleBenchmarkCommand(root, ['--ci-gate', '--gate-audit-run', runId]);
}

function groundTruthCheck(output: string): { passed: boolean; value: number } {
	const payload = output
		.split('[BENCHMARK_JSON]\n')[1]
		?.split('\n[/BENCHMARK_JSON]')[0];
	const parsed = JSON.parse(payload ?? '{}') as {
		ci_gate?: {
			checks?: Array<{ name: string; passed: boolean; value: number }>;
		};
	};
	const check = parsed.ci_gate?.checks?.find(
		(candidate) => candidate.name === 'Gate audit ground truth',
	);
	if (!check) throw new Error('gate-audit ground-truth CI check is missing');
	return check;
}

describe('benchmark authoritative gate ground truth', () => {
	test('fails closed when ground truth is missing despite positive cell labels', async () => {
		const root = project();
		try {
			await saveGateAuditResult(root, audit('missing'));
			const output = await benchmark(root, 'missing');
			expect(output).toContain('Ground truth: unavailable');
			expect(output).toContain('unjoined 12');
			expect(output).toContain('"caught": 0');
			expect(output).toContain('"ground_truth_available": false');
			expect(groundTruthCheck(output)).toMatchObject({
				passed: false,
				value: 0,
			});
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('fails closed when exact-key classifications conflict and become ambiguous', async () => {
		const root = project();
		try {
			await saveGateAuditResult(root, audit('conflict'));
			await saveGateGroundTruth(root, 'conflict', truth('conflict'));
			await saveGateGroundTruth(root, 'conflict', [
				{
					...truth('conflict', 1)[0],
					source: 'integration',
					classification: 'clean',
				},
			]);
			const output = await benchmark(root, 'conflict');
			expect(output).toContain('Ground truth: unavailable');
			expect(output).toContain('ambiguous 1');
			expect(output).toContain('"ground_truth_available": false');
			expect(groundTruthCheck(output)).toMatchObject({
				passed: false,
				value: 0,
			});
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('fails closed when ground-truth evidence is malformed', async () => {
		const root = project();
		try {
			await saveGateAuditResult(root, audit('malformed'));
			await saveGateGroundTruth(root, 'malformed', truth('malformed'));
			fs.appendFileSync(
				path.join(
					root,
					'.swarm',
					'evidence',
					'gate-audit',
					'malformed',
					'ground-truth.jsonl',
				),
				'not-json\n',
			);
			const output = await benchmark(root, 'malformed');
			expect(output).toContain('malformed 1');
			expect(output).toContain('"ground_truth_available": false');
			expect(groundTruthCheck(output)).toMatchObject({
				passed: false,
				value: 0,
			});
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('fails closed when exact joins do not meet the minimum sample floor', async () => {
		const root = project();
		try {
			await saveGateAuditResult(root, audit('insufficient', 1));
			await saveGateGroundTruth(root, 'insufficient', truth('insufficient', 1));
			const output = await benchmark(root, 'insufficient');
			expect(output).toContain('insufficient true');
			expect(output).toContain('"insufficient_data": true');
			expect(groundTruthCheck(output)).toMatchObject({
				passed: false,
				value: 0,
			});
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
