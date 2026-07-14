import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	recordTestImpactGateGroundTruth,
	saveGateGroundTruth,
} from '../../../src/evaluation/gate-ground-truth.js';
import { computeGateStatistics } from '../../../src/evaluation/gate-stats.js';
import { saveGateAuditResult } from '../../../src/evaluation/store.js';

function tempRoot(): string {
	return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gate-stats-')));
}

function audit(runId: string) {
	const base = {
		v: 1 as const,
		taskId: 'task-a',
		defectType: 'correctness',
		gate: 'reviewer' as const,
		model: 'provider/model',
		repetition: 0,
		retries: 0,
		cost: { source: 'reported' as const, usd: 0.01 },
		durationMs: 1,
	};
	return {
		v: 1 as const,
		runId,
		manifestHash: 'a'.repeat(64),
		createdAt: '2026-07-13T12:00:00.000Z',
		status: 'complete' as const,
		cells: [
			{
				...base,
				candidateId: 'defect-task-a',
				outcome: 'caught' as const,
				failureClassification: 'new_regression' as const,
			},
			{
				...base,
				candidateId: 'clean-task-a',
				outcome: 'caught' as const,
				failureClassification: 'clean' as const,
			},
		],
		cost: { source: 'reported' as const, usd: 0.02 },
		qualityMetricAvailability: {
			complexity_delta: 'unavailable' as const,
			public_api_delta: 'unavailable' as const,
		},
	};
}

function truth(
	runId: string,
	candidateId: string,
	classification: 'clean' | 'new_regression',
) {
	return {
		v: 1 as const,
		runId,
		taskId: 'task-a',
		candidateId,
		model: 'provider/model',
		gate: 'reviewer' as const,
		repetition: 0,
		classification,
		observedAt: '2026-07-13T12:00:00.000Z',
	};
}

describe('gate statistics regression: exact historical ground-truth joins (P0)', () => {
	test('computes catch and measurable false-reject rates only from exact joins', async () => {
		const root = tempRoot();
		try {
			await saveGateAuditResult(root, audit('joined'));
			await saveGateGroundTruth(
				root,
				'joined',
				[
					truth('joined', 'defect-task-a', 'new_regression'),
					truth('joined', 'clean-task-a', 'clean'),
				].map((event) => ({
					...event,
					v: 1 as const,
					source: 'integration' as const,
				})),
			);
			await recordTestImpactGateGroundTruth(root, 'joined', [
				truth('joined', 'defect-task-a', 'new_regression'),
				truth('joined', 'clean-task-a', 'clean'),
			]);
			const report = await computeGateStatistics(root, 1);
			expect(report.groundTruth).toEqual({
				parsed: 4,
				malformed: 0,
				ambiguous: 0,
				unjoined: 0,
			});
			expect(report.models[0]?.catchRate).toBe(1);
			expect(report.models[0]?.falseRejectionRate).toBe(1);
			expect(report.models[0]?.insufficientData).toBe(false);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('legacy evidence without stable candidate keys remains insufficient', async () => {
		const root = tempRoot();
		try {
			const legacy = audit('legacy');
			legacy.cells = legacy.cells.map(
				({ candidateId: _candidateId, ...cell }) => cell,
			) as typeof legacy.cells;
			await saveGateAuditResult(root, legacy);
			const report = await computeGateStatistics(root, 1);
			expect(report.groundTruth.unjoined).toBe(2);
			expect(report.models[0]?.catchRate).toBeNull();
			expect(report.models[0]?.falseRejectionRate).toBeNull();
			expect(report.models[0]?.insufficientData).toBe(true);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('malformed and ambiguous historical lines are counted and never fuzzily joined', async () => {
		const root = tempRoot();
		try {
			await saveGateAuditResult(root, audit('ambiguous'));
			const event = {
				...truth('ambiguous', 'defect-task-a', 'new_regression'),
				v: 1,
				source: 'test-impact',
			};
			const conflict = { ...event, classification: 'clean' };
			fs.writeFileSync(
				path.join(
					root,
					'.swarm',
					'evidence',
					'gate-audit',
					'ambiguous',
					'ground-truth.jsonl',
				),
				`${JSON.stringify(event)}\n${JSON.stringify(conflict)}\nnot-json\n`,
			);
			const report = await computeGateStatistics(root, 1);
			expect(report.groundTruth.parsed).toBe(2);
			expect(report.groundTruth.malformed).toBe(1);
			expect(report.groundTruth.ambiguous).toBe(1);
			expect(report.groundTruth.unjoined).toBe(1);
			expect(report.models[0]?.catchRate).toBeNull();
			expect(report.models[0]?.insufficientData).toBe(true);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
