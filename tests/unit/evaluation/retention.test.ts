import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type {
	EvaluationRunV1,
	GateAuditResultV1,
} from '../../../src/evaluation/contracts.js';
import { computeRunIntegrityHash } from '../../../src/evaluation/hashing.js';
import {
	_retentionInternals,
	archiveEvaluationArtifacts,
} from '../../../src/evaluation/retention.js';
import {
	claimHeldOutTest,
	saveEvaluationRun,
	saveGateAuditResult,
} from '../../../src/evaluation/store.js';

const roots: string[] = [];
const realProtectedArtifacts = _retentionInternals.protectedArtifacts;
const realRemoveCandidate = _retentionInternals.removeCandidate;

afterEach(() => {
	_retentionInternals.protectedArtifacts = realProtectedArtifacts;
	_retentionInternals.removeCandidate = realRemoveCandidate;
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function project(): string {
	const root = realpathSync(
		mkdtempSync(path.join(tmpdir(), 'swarm-evaluation-retention-')),
	);
	roots.push(root);
	return root;
}

function run(runId: string, createdAt: string): EvaluationRunV1 {
	const withoutIntegrity = {
		v: 1 as const,
		runId,
		createdAt,
		status: 'complete' as const,
		baseline: {
			v: 1 as const,
			id: 'baseline',
			kind: 'baseline' as const,
			payloadPath: 'baseline.md',
			model: 'model-a',
			contentHash: 'a'.repeat(64),
		},
		candidate: {
			v: 1 as const,
			id: 'candidate',
			kind: 'skill' as const,
			payloadPath: 'candidate.md',
			model: 'model-a',
			contentHash: 'b'.repeat(64),
		},
		taskSet: {
			id: 'validation-v1',
			contentHash: 'c'.repeat(64),
			taskIds: ['task-1'],
		},
		split: 'validation' as const,
		seed: 'seed',
		models: ['model-a'],
		environment: {
			platform: 'test',
			arch: 'test',
			runtime: 'bun-test',
			baseSha: 'd'.repeat(40),
			activeTreeHash: 'e'.repeat(64),
			taskSetHash: 'c'.repeat(64),
		},
		budgets: {
			maxTasks: 1,
			maxRepetitions: 1,
			maxConcurrency: 1,
			maxTaskTimeMs: 1_000,
			maxRetries: 0,
			maxOutputBytes: 1_024,
		},
		results: [],
		cost: { source: 'unavailable' as const },
	};
	return {
		...withoutIntegrity,
		integrityHash: computeRunIntegrityHash(withoutIntegrity as EvaluationRunV1),
	} as EvaluationRunV1;
}

function audit(runId: string, createdAt: string): GateAuditResultV1 {
	return {
		v: 1,
		runId,
		manifestHash: 'f'.repeat(64),
		createdAt,
		status: 'complete',
		cells: [],
		cost: { source: 'reported', usd: 0 },
		qualityMetricAvailability: {
			complexity_delta: 'unavailable',
			public_api_delta: 'unavailable',
		},
	};
}

describe('unified evaluation retention', () => {
	test('uses one dry-run/execution inventory for generic runs and gate audits', async () => {
		const root = project();
		await saveEvaluationRun(root, run('generic-old', '2025-01-01T00:00:00Z'));
		await saveGateAuditResult(root, audit('audit-old', '2025-01-02T00:00:00Z'));
		const args = {
			directory: root,
			maxAgeDays: 30,
			now: new Date('2026-07-13T00:00:00Z'),
		};
		const preview = await archiveEvaluationArtifacts({ ...args, dryRun: true });
		expect(preview.selected).toEqual([
			{ namespace: 'evaluation-run', id: 'generic-old' },
			{ namespace: 'gate-audit', id: 'audit-old' },
		]);
		const executed = await archiveEvaluationArtifacts(args);
		expect(executed.selected).toEqual(preview.selected);
		expect(executed.archived).toEqual(preview.selected);
		expect(
			existsSync(
				path.join(root, '.swarm', 'evolution', 'runs', 'generic-old.json'),
			),
		).toBe(false);
		expect(
			existsSync(
				path.join(root, '.swarm', 'evidence', 'gate-audit', 'audit-old'),
			),
		).toBe(false);
	});

	test('enforces count retention across both artifact namespaces', async () => {
		const root = project();
		await saveEvaluationRun(root, run('generic-1', '2026-07-10T00:00:00Z'));
		await saveGateAuditResult(root, audit('audit-2', '2026-07-11T00:00:00Z'));
		await saveEvaluationRun(root, run('generic-3', '2026-07-12T00:00:00Z'));
		const result = await archiveEvaluationArtifacts({
			directory: root,
			maxAgeDays: 30,
			maxBundles: 2,
			now: new Date('2026-07-13T00:00:00Z'),
		});
		expect(result.archived).toEqual([
			{ namespace: 'evaluation-run', id: 'generic-1' },
		]);
	});

	test('keeps promotion/test lineage namespaced from a same-id gate audit', async () => {
		const root = project();
		await saveEvaluationRun(root, run('shared-id', '2025-01-01T00:00:00Z'));
		await saveGateAuditResult(root, audit('shared-id', '2025-01-01T00:00:00Z'));
		await claimHeldOutTest(root, {
			v: 1,
			runId: 'shared-id',
			taskSetHash: '1'.repeat(64),
			baselineHash: '2'.repeat(64),
			candidateHash: '3'.repeat(64),
			claimedAt: '2026-07-13T00:00:00Z',
		});
		const result = await archiveEvaluationArtifacts({
			directory: root,
			maxAgeDays: 30,
			now: new Date('2026-07-13T00:00:00Z'),
		});
		expect(result.protected).toEqual([
			{ namespace: 'evaluation-run', id: 'shared-id' },
		]);
		expect(result.archived).toEqual([
			{ namespace: 'gate-audit', id: 'shared-id' },
		]);
	});

	test('rechecks protection after selection and preserves a newly linked run', async () => {
		const root = project();
		await saveEvaluationRun(root, run('race-run', '2025-01-01T00:00:00Z'));
		let calls = 0;
		_retentionInternals.protectedArtifacts = async () => {
			calls++;
			return calls === 1 ? new Set() : new Set(['evaluation-run/race-run']);
		};
		const result = await archiveEvaluationArtifacts({
			directory: root,
			maxAgeDays: 30,
			now: new Date('2026-07-13T00:00:00Z'),
		});
		expect(result.selected).toEqual([
			{ namespace: 'evaluation-run', id: 'race-run' },
		]);
		expect(result.archived).toEqual([]);
		expect(result.protected).toEqual([
			{ namespace: 'evaluation-run', id: 'race-run' },
		]);
	});

	test('reports deletion failures without claiming archival', async () => {
		const root = project();
		await saveEvaluationRun(root, run('undeletable', '2025-01-01T00:00:00Z'));
		_retentionInternals.removeCandidate = async () => {
			throw new Error('simulated EPERM');
		};
		const result = await archiveEvaluationArtifacts({
			directory: root,
			maxAgeDays: 30,
			now: new Date('2026-07-13T00:00:00Z'),
		});
		expect(result.archived).toEqual([]);
		expect(result.failed).toEqual([
			{
				artifact: { namespace: 'evaluation-run', id: 'undeletable' },
				error: 'simulated EPERM',
			},
		]);
		expect(
			existsSync(
				path.join(root, '.swarm', 'evolution', 'runs', 'undeletable.json'),
			),
		).toBe(true);
	});
});
