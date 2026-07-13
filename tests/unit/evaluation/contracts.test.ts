import { describe, expect, test } from 'bun:test';
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
	CostRecordSchema,
	EvaluationResultV1Schema,
	type EvaluationTaskV1,
	EvaluationTaskV1Schema,
} from '../../../src/evaluation/contracts.js';
import {
	canonicalHash,
	canonicalJson,
	computeTaskContentHash,
	resolveContainedExistingPath,
} from '../../../src/evaluation/hashing.js';

function task(overrides: Partial<EvaluationTaskV1> = {}): EvaluationTaskV1 {
	const withoutHash = {
		v: 1 as const,
		id: 'curated-1',
		source: 'curated' as const,
		split: 'validation' as const,
		category: 'correctness',
		protected: false,
		instructionPath: 'fixtures/instruction.md',
		environment: { kind: 'fixture' as const, path: 'fixtures/project' },
		scorer: {
			kind: 'builtin' as const,
			argv: ['score-v1'],
			timeoutMs: 1_000,
			scoreRange: [0, 10] as [number, number],
		},
		provenance: { origin: 'repository', license: 'MIT' },
		...overrides,
	};
	return {
		...withoutHash,
		contentHash: computeTaskContentHash(withoutHash as EvaluationTaskV1),
	} as EvaluationTaskV1;
}

describe('evaluation v1 contracts', () => {
	test('accepts a curated task and rejects unknown versions and traversal', () => {
		expect(EvaluationTaskV1Schema.parse(task()).v).toBe(1);
		expect(() => EvaluationTaskV1Schema.parse({ ...task(), v: 2 })).toThrow();
		expect(() =>
			EvaluationTaskV1Schema.parse({ ...task(), instructionPath: '../secret' }),
		).toThrow('traverse');
	});

	test('requires a complete human review receipt for trace proposals', () => {
		expect(() =>
			EvaluationTaskV1Schema.parse(task({ source: 'trace-proposal' })),
		).toThrow('human review');
		const reviewed = task({
			source: 'trace-proposal',
			provenance: {
				origin: 'trace:42',
				license: 'MIT',
				review: {
					reviewer: 'human@example.test',
					reviewedAt: '2026-07-13T12:00:00.000Z',
					instruction: true,
					fixture: true,
					scorer: true,
					secretsPrivacy: true,
					license: true,
					split: true,
				},
			},
		});
		expect(EvaluationTaskV1Schema.parse(reviewed).source).toBe(
			'trace-proposal',
		);
	});

	test('never converts missing or failed scores into zero', () => {
		const base = {
			v: 1,
			taskId: 'task-1',
			category: 'correctness',
			protected: false,
			repetition: 0,
			candidateId: 'candidate',
			seed: 'seed',
			scoreRange: [0, 1],
			cost: { source: 'unavailable' },
			durationMs: 5,
		};
		expect(() =>
			EvaluationResultV1Schema.parse({
				...base,
				outcome: 'infrastructure_failure',
				score: 0,
			}),
		).toThrow('must not be imputed');
		expect(() =>
			EvaluationResultV1Schema.parse({ ...base, outcome: 'scored' }),
		).toThrow('require an in-range score');
	});

	test('enforces cost availability semantics', () => {
		expect(CostRecordSchema.parse({ source: 'unavailable' })).toEqual({
			source: 'unavailable',
		});
		expect(() =>
			CostRecordSchema.parse({ source: 'unavailable', usd: 0 }),
		).toThrow();
		expect(() => CostRecordSchema.parse({ source: 'reported' })).toThrow();
	});
});

describe('canonical evaluation hashing', () => {
	test('is stable across object key order and normalizes negative zero', () => {
		expect(canonicalJson({ z: -0, a: { y: 2, x: 1 } })).toBe(
			'{"a":{"x":1,"y":2},"z":0}',
		);
		expect(canonicalHash({ b: 2, a: 1 })).toBe(canonicalHash({ a: 1, b: 2 }));
	});

	test('rejects values that cannot be represented deterministically', () => {
		expect(() => canonicalJson({ value: Number.NaN })).toThrow('non-finite');
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expect(() => canonicalJson(cyclic)).toThrow('cyclic');
	});

	test('rejects symlink and junction components before reading task inputs', () => {
		const root = realpathSync(
			mkdtempSync(path.join(tmpdir(), 'swarm-eval-hash-')),
		);
		try {
			const target = path.join(root, 'target');
			mkdirSync(target);
			symlinkSync(
				target,
				path.join(root, 'link'),
				process.platform === 'win32' ? 'junction' : 'dir',
			);
			expect(() => resolveContainedExistingPath(root, 'link')).toThrow(
				'symlink or reparse point',
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
