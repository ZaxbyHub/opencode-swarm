import { afterEach, describe, expect, test } from 'bun:test';
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type {
	EvaluationRunV1,
	EvaluationTaskV1,
	PromotionDecisionV1,
	TestConsumptionClaimV1,
} from '../../../src/evaluation/contracts.js';
import {
	computeRunIntegrityHash,
	computeTaskInputContentHash,
} from '../../../src/evaluation/hashing.js';
import {
	admitEvaluationTask,
	claimHeldOutTest,
	EvaluationConflictError,
	getProtectedEvaluationRunIds,
	readEvaluationRun,
	saveEvaluationRun,
	savePromotionDecision,
	TestAlreadyConsumedError,
} from '../../../src/evaluation/store.js';

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function project(): string {
	const root = realpathSync(
		mkdtempSync(path.join(tmpdir(), 'swarm-evaluation-store-')),
	);
	roots.push(root);
	mkdirSync(path.join(root, 'fixtures', 'project'), { recursive: true });
	writeFileSync(
		path.join(root, 'fixtures', 'instruction.md'),
		'Complete the task.',
	);
	return root;
}

function task(
	root: string,
	overrides: Partial<Omit<EvaluationTaskV1, 'contentHash'>> = {},
): EvaluationTaskV1 {
	const withoutHash = {
		v: 1 as const,
		id: 'task-1',
		source: 'curated' as const,
		split: 'validation' as const,
		category: 'correctness',
		protected: false,
		instructionPath: path.join('fixtures', 'instruction.md'),
		environment: {
			kind: 'fixture' as const,
			path: path.join('fixtures', 'project'),
		},
		scorer: {
			kind: 'builtin' as const,
			argv: ['score-v1'],
			timeoutMs: 1_000,
			scoreRange: [0, 1] as [number, number],
		},
		provenance: { origin: 'repository', license: 'MIT' },
		...overrides,
	};
	return {
		...withoutHash,
		contentHash: computeTaskInputContentHash(
			root,
			withoutHash as EvaluationTaskV1,
		),
	} as EvaluationTaskV1;
}

function run(
	runId = 'run-1',
	createdAt = '2026-07-13T12:00:00.000Z',
): EvaluationRunV1 {
	const withoutIntegrity = {
		v: 1 as const,
		runId,
		createdAt,
		status: 'complete' as const,
		baseline: {
			v: 1 as const,
			id: 'baseline',
			kind: 'baseline' as const,
			payloadPath: 'candidates/baseline.md',
			model: 'model-a',
			contentHash: 'a'.repeat(64),
		},
		candidate: {
			v: 1 as const,
			id: 'candidate',
			kind: 'skill' as const,
			payloadPath: 'candidates/candidate.md',
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

function claim(
	overrides: Partial<TestConsumptionClaimV1> = {},
): TestConsumptionClaimV1 {
	return {
		v: 1,
		runId: 'test-run',
		taskSetHash: '1'.repeat(64),
		baselineHash: '2'.repeat(64),
		candidateHash: '3'.repeat(64),
		claimedAt: '2026-07-13T12:00:00.000Z',
		...overrides,
	};
}

describe('evaluation task admission', () => {
	test('is idempotent and keeps validation tasks immutable', async () => {
		const root = project();
		const admitted = await admitEvaluationTask(root, task(root));
		expect(await admitEvaluationTask(root, task(root))).toEqual(admitted);
		await expect(
			admitEvaluationTask(root, task(root, { category: 'changed' })),
		).rejects.toBeInstanceOf(EvaluationConflictError);
	});

	test('detects instruction or fixture drift after a task was hashed', async () => {
		const root = project();
		const admitted = task(root);
		writeFileSync(
			path.join(root, 'fixtures', 'instruction.md'),
			'Changed instruction.',
		);
		await expect(admitEvaluationTask(root, admitted)).rejects.toThrow(
			'content hash does not match',
		);
	});

	test('requires project scorers to be inside the admitted task environment', async () => {
		const root = project();
		writeFileSync(
			path.join(root, 'scorer.mjs'),
			'process.stdout.write("{}");\n',
		);
		await expect(
			admitEvaluationTask(
				root,
				task(root, {
					scorer: {
						kind: 'project',
						argv: ['scorer.mjs'],
						timeoutMs: 1_000,
						scoreRange: [0, 1],
					},
				}),
			),
		).rejects.toThrow('must be inside the admitted task environment');
	});

	test('rejects split leakage for an already admitted task id', async () => {
		const root = project();
		await admitEvaluationTask(root, task(root));
		await expect(
			admitEvaluationTask(root, task(root, { split: 'test' })),
		).rejects.toThrow('different split');
	});

	test('rejects split leakage through a different task id with identical inputs', async () => {
		const root = project();
		await admitEvaluationTask(root, task(root, { id: 'variant-a' }));
		await expect(
			admitEvaluationTask(root, task(root, { id: 'variant-b', split: 'test' })),
		).rejects.toThrow('lineage is already admitted to validation');
	});

	test('recognizes copied input bytes as the same split lineage', async () => {
		const root = project();
		mkdirSync(path.join(root, 'fixtures', 'project-copy'), { recursive: true });
		writeFileSync(
			path.join(root, 'fixtures', 'instruction-copy.md'),
			'Complete the task.',
		);
		await admitEvaluationTask(root, task(root, { id: 'original-paths' }));
		await expect(
			admitEvaluationTask(
				root,
				task(root, {
					id: 'copied-paths',
					split: 'test',
					instructionPath: path.join('fixtures', 'instruction-copy.md'),
					environment: {
						kind: 'fixture',
						path: path.join('fixtures', 'project-copy'),
					},
				}),
			),
		).rejects.toThrow('lineage is already admitted to validation');
	});

	test('requires derived variants to inherit their admitted parent split', async () => {
		const root = project();
		await admitEvaluationTask(root, task(root, { id: 'parent' }));
		writeFileSync(
			path.join(root, 'fixtures', 'instruction.md'),
			'Derived instruction.',
		);
		await expect(
			admitEvaluationTask(
				root,
				task(root, {
					id: 'derived-wrong-split',
					derivedFromTaskId: 'parent',
					split: 'test',
				}),
			),
		).rejects.toThrow('must inherit that split');
		const derived = task(root, {
			id: 'derived-valid',
			derivedFromTaskId: 'parent',
		});
		expect(await admitEvaluationTask(root, derived)).toEqual(derived);
	});

	test('rejects a derived variant whose parent is not admitted', async () => {
		const root = project();
		await expect(
			admitEvaluationTask(
				root,
				task(root, { id: 'orphan', derivedFromTaskId: 'missing-parent' }),
			),
		).rejects.toThrow('references an unadmitted parent');
	});

	test('serializes concurrent aliases so identical inputs cannot cross splits', async () => {
		const root = project();
		const outcomes = await Promise.allSettled([
			admitEvaluationTask(root, task(root, { id: 'alias-validation' })),
			admitEvaluationTask(
				root,
				task(root, { id: 'alias-test', split: 'test' }),
			),
		]);
		expect(
			outcomes.filter((outcome) => outcome.status === 'fulfilled'),
		).toHaveLength(1);
		expect(
			outcomes.filter((outcome) => outcome.status === 'rejected'),
		).toHaveLength(1);
	});

	test('serializes concurrent admissions of the same id to different splits', async () => {
		const root = project();
		const outcomes = await Promise.allSettled([
			admitEvaluationTask(root, task(root, { split: 'validation' })),
			admitEvaluationTask(root, task(root, { split: 'test' })),
		]);
		expect(
			outcomes.filter((outcome) => outcome.status === 'fulfilled'),
		).toHaveLength(1);
		expect(
			outcomes.filter((outcome) => outcome.status === 'rejected'),
		).toHaveLength(1);
	});
});

describe('immutable runs and permanent test consumption', () => {
	test('returns an identical run and rejects a same-id conflict', async () => {
		const root = project();
		const first = run();
		expect(await saveEvaluationRun(root, first)).toEqual(first);
		expect(await saveEvaluationRun(root, first)).toEqual(first);
		expect(await readEvaluationRun(root, first.runId)).toEqual(first);
		await expect(
			saveEvaluationRun(root, run('run-1', '2026-07-13T12:01:00.000Z')),
		).rejects.toBeInstanceOf(EvaluationConflictError);
	});

	test('resumes by immutable identity and preserves the original claim timestamp', async () => {
		const root = project();
		const first = claim();
		expect(await claimHeldOutTest(root, first)).toEqual(first);
		expect(
			await claimHeldOutTest(
				root,
				claim({ claimedAt: '2026-07-13T12:05:00.000Z' }),
			),
		).toEqual(first);
		await expect(
			claimHeldOutTest(root, claim({ candidateHash: '4'.repeat(64) })),
		).rejects.toBeInstanceOf(EvaluationConflictError);
		await expect(
			claimHeldOutTest(
				root,
				claim({ runId: 'other-run', candidateHash: '5'.repeat(64) }),
			),
		).rejects.toBeInstanceOf(TestAlreadyConsumedError);
	});

	test('serializes concurrent one-shot claims so only one wins', async () => {
		const root = project();
		const outcomes = await Promise.allSettled([
			claimHeldOutTest(root, claim({ runId: 'race-a' })),
			claimHeldOutTest(
				root,
				claim({ runId: 'race-b', candidateHash: '5'.repeat(64) }),
			),
		]);
		expect(
			outcomes.filter((outcome) => outcome.status === 'fulfilled'),
		).toHaveLength(1);
		expect(
			outcomes.filter((outcome) => outcome.status === 'rejected'),
		).toHaveLength(1);
	});
});

describe('retention lineage', () => {
	test('protects test claims and all promotion lineage run ids', async () => {
		const root = project();
		await claimHeldOutTest(root, claim());
		const decision: PromotionDecisionV1 = {
			v: 1,
			decisionId: 'promotion-1',
			runId: 'candidate-run',
			decidedAt: '2026-07-13T12:00:00.000Z',
			status: 'inconclusive',
			reasons: ['confidence_interval_overlaps_deadband'],
			baseline: {
				baselineRunId: 'baseline-run',
				baselineCandidateId: 'baseline',
				baselineMean: 0.5,
				candidateMean: 0.5,
				pairedDelta: 0,
				confidenceInterval: [-0.1, 0.1],
				validPairs: 6,
				missingPairs: 0,
				coverage: 1,
			},
			historicalBest: {
				baselineRunId: 'history-run',
				baselineCandidateId: 'history',
				baselineMean: 0.5,
				candidateMean: 0.5,
				pairedDelta: 0,
				confidenceInterval: [-0.1, 0.1],
				validPairs: 6,
				missingPairs: 0,
				coverage: 1,
			},
			deadband: 0.01,
			bootstrap: {
				resamples: 10_000,
				confidence: 0.95,
				seedHash: '4'.repeat(64),
			},
			categories: [],
			lineage: {
				baselineRunId: 'baseline-run',
				historicalBestRunId: 'history-run',
				taskSetHash: '1'.repeat(64),
				baselineHash: '2'.repeat(64),
				candidateHash: '3'.repeat(64),
				historicalBestHash: '4'.repeat(64),
			},
			policyHash: '5'.repeat(64),
			unavailableQualityMetrics: ['complexity_delta', 'public_api_delta'],
		};
		const storedDecision = await savePromotionDecision(root, decision);
		expect(
			await savePromotionDecision(root, {
				...decision,
				decidedAt: '2026-07-13T12:05:00.000Z',
			}),
		).toEqual(storedDecision);
		const protectedIds = await getProtectedEvaluationRunIds(root);
		expect([...protectedIds].sort()).toEqual([
			'baseline-run',
			'candidate-run',
			'history-run',
			'test-run',
		]);
	});
});
