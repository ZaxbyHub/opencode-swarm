import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleBenchmarkCommand } from '../../../src/commands/benchmark.js';
import { isCommandFailure } from '../../../src/commands/registry.js';

const text = (r: Awaited<ReturnType<typeof handleBenchmarkCommand>>): string =>
	isCommandFailure(r) ? r.text : r;

import { createGateAuditManifest } from '../../../src/evaluation/gate-audit.js';
import { saveGateGroundTruth } from '../../../src/evaluation/gate-ground-truth.js';
import { computeGateStatistics } from '../../../src/evaluation/gate-stats.js';
import { archiveGateAuditResults } from '../../../src/evaluation/retention.js';
import {
	EvaluationConflictError,
	readGateAuditManifest,
	saveGateAuditManifest,
	saveGateAuditResult,
} from '../../../src/evaluation/store.js';

function tempRoot(): string {
	return fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'gate-audit-store-')),
	);
}

function manifest(id: string) {
	return createGateAuditManifest({
		v: 1,
		id,
		createdAt: '2026-07-13T12:00:00.000Z',
		taskIds: ['mutation-off-by-one'],
		gates: ['mutation'],
		models: ['configured'],
		repetitions: 6,
		seed: 'stable',
		maxConcurrency: 1,
		maxRetries: 0,
		maxTimeMs: 30_000,
	});
}

function result(
	id: string,
	createdAt = '2026-07-13T12:00:00.000Z',
	cleanRejected = false,
) {
	const storedManifest = manifest(id);
	return {
		v: 1 as const,
		runId: id,
		manifestHash: storedManifest.contentHash,
		createdAt,
		status: 'complete' as const,
		cells: Array.from({ length: 6 }, (_, repetition) => [
			{
				v: 1 as const,
				taskId: 'mutation-off-by-one',
				candidateId: 'defect-mutation-off-by-one',
				defectType: 'correctness',
				gate: 'mutation' as const,
				model: 'configured',
				repetition,
				outcome: 'caught' as const,
				retries: 0,
				cost: { source: 'reported' as const, usd: 0 },
				durationMs: 10,
				failureClassification: 'new_regression' as const,
			},
			{
				v: 1 as const,
				taskId: 'mutation-off-by-one',
				candidateId: 'clean-mutation-off-by-one',
				defectType: 'correctness',
				gate: 'mutation' as const,
				model: 'configured',
				repetition,
				outcome: cleanRejected ? ('caught' as const) : ('missed' as const),
				retries: 0,
				cost: { source: 'reported' as const, usd: 0 },
				durationMs: 10,
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

async function saveTruth(root: string, id: string): Promise<void> {
	await saveGateGroundTruth(
		root,
		id,
		Array.from({ length: 6 }, (_, repetition) => [
			{
				v: 1,
				runId: id,
				taskId: 'mutation-off-by-one',
				candidateId: 'defect-mutation-off-by-one',
				model: 'configured',
				gate: 'mutation',
				repetition,
				source: 'test-impact',
				classification: 'new_regression',
				observedAt: '2026-07-13T12:00:00.000Z',
			},
			{
				v: 1,
				runId: id,
				taskId: 'mutation-off-by-one',
				candidateId: 'clean-mutation-off-by-one',
				model: 'configured',
				gate: 'mutation',
				repetition,
				source: 'test-impact',
				classification: 'clean',
				observedAt: '2026-07-13T12:00:00.000Z',
			},
		]).flat(),
	);
}

describe('gate-audit storage and reporting', () => {
	test('persists immutable manifests idempotently', async () => {
		const root = tempRoot();
		try {
			const first = manifest('audit-stable');
			await saveGateAuditManifest(root, first);
			expect(await saveGateAuditManifest(root, first)).toEqual(first);
			expect(await readGateAuditManifest(root, first.id)).toEqual(first);
			await expect(
				saveGateAuditManifest(root, { ...first, seed: 'changed' }),
			).rejects.toBeInstanceOf(EvaluationConflictError);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('feeds gate statistics and the optional benchmark CI bridge', async () => {
		const root = tempRoot();
		try {
			await saveGateAuditResult(root, result('audit-ci'));
			await saveTruth(root, 'audit-ci');
			const stats = await computeGateStatistics(root, 1);
			expect(stats.models[0]?.catchRate).toBe(1);
			expect(stats.models[0]?.falseRejectionRate).toBe(0);
			const output = await handleBenchmarkCommand(root, [
				'--ci-gate',
				'--gate-audit-run',
				'audit-ci',
			]);
			expect(text(output)).toContain('Gate audit complete');
			expect(text(output)).toContain('Gate audit catch rate');
			expect(text(output)).toContain('"ground_truth_available": true');
			expect(text(output)).toContain('"gate_audit"');
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('benchmark excludes clean controls from catch rate and rejects false positives', async () => {
		const root = tempRoot();
		try {
			await saveGateAuditResult(
				root,
				result('audit-clean-reject', undefined, true),
			);
			await saveTruth(root, 'audit-clean-reject');
			const output = await handleBenchmarkCommand(root, [
				'--ci-gate',
				'--gate-audit-run',
				'audit-clean-reject',
			]);
			expect(text(output)).toContain('Gate audit catch rate: 100%');
			expect(text(output)).toContain('Clean-control rejections: 6/6');
			expect(text(output)).toContain('❌ FAILED');
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('archives old audit bundles and supports dry runs', async () => {
		const root = tempRoot();
		try {
			await saveGateAuditResult(
				root,
				result('audit-old', '2025-01-01T00:00:00.000Z'),
			);
			const dryRun = await archiveGateAuditResults({
				directory: root,
				maxAgeDays: 30,
				dryRun: true,
				now: new Date('2026-07-13T00:00:00Z'),
			});
			expect(dryRun.selected).toEqual(['audit-old']);
			expect(dryRun.archived).toEqual([]);
			const archived = await archiveGateAuditResults({
				directory: root,
				maxAgeDays: 30,
				now: new Date('2026-07-13T00:00:00Z'),
			});
			expect(archived.archived).toEqual(['audit-old']);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
