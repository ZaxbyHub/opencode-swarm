import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
	EvaluationCandidateV1,
	EvaluationTaskV1,
} from '../../../src/evaluation/contracts.js';
import {
	computeCandidateInputContentHash,
	computeTaskInputContentHash,
} from '../../../src/evaluation/hashing.js';
import { _internals, runEvaluation } from '../../../src/evaluation/runner.js';

const originalFingerprint = _internals.captureWorkingTreeFingerprint;
const originalDisposableWorktree = _internals.withDisposableWorktree;

afterEach(() => {
	_internals.captureWorkingTreeFingerprint = originalFingerprint;
	_internals.withDisposableWorktree = originalDisposableWorktree;
});

async function candidate(
	root: string,
	id: string,
	kind: 'baseline' | 'skill',
): Promise<EvaluationCandidateV1> {
	const draft = {
		v: 1 as const,
		id,
		kind,
		payloadPath: `${id}.md`,
		model: 'configured',
	};
	return {
		...draft,
		contentHash: await computeCandidateInputContentHash(root, draft),
	};
}

describe('bounded evaluation runner', () => {
	test('isolates pairs, retries infrastructure failures, and resumes immutably', async () => {
		const root = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'eval-runner-')),
		);
		try {
			fs.mkdirSync(path.join(root, 'fixture'));
			fs.writeFileSync(
				path.join(root, 'fixture', 'subject.ts'),
				'export const value = 1;\n',
			);
			fs.writeFileSync(
				path.join(root, 'instruction.md'),
				'Return a verdict.\n',
			);
			fs.writeFileSync(path.join(root, 'baseline.md'), 'baseline payload\n');
			fs.writeFileSync(path.join(root, 'candidate.md'), 'candidate payload\n');
			const taskDraft = {
				v: 1 as const,
				id: 'validation-task',
				source: 'curated' as const,
				split: 'validation' as const,
				category: 'correctness',
				protected: true,
				instructionPath: 'instruction.md',
				environment: { kind: 'fixture' as const, path: 'fixture' },
				scorer: {
					kind: 'builtin' as const,
					argv: ['tier1-defect'],
					timeoutMs: 1_000,
					scoreRange: [0, 1] as [number, number],
				},
				provenance: { origin: 'unit-test', license: 'MIT' },
			};
			const task: EvaluationTaskV1 = {
				...taskDraft,
				contentHash: await computeTaskInputContentHash(root, taskDraft),
			};
			const attempts = new Map<string, number>();
			_internals.captureWorkingTreeFingerprint = async () => ({
				head: 'a'.repeat(40),
				porcelainHash: 'b'.repeat(64),
			});
			_internals.withDisposableWorktree = async ({ baseRef, run }) => {
				const worktreeRoot = fs.realpathSync(
					fs.mkdtempSync(path.join(os.tmpdir(), 'eval-worktree-')),
				);
				try {
					return await run({ path: worktreeRoot, baseSha: baseRef });
				} finally {
					fs.rmSync(worktreeRoot, { recursive: true, force: true });
				}
			};
			const options = {
				projectRoot: root,
				tasks: [task],
				baseline: await candidate(root, 'baseline', 'baseline'),
				candidate: await candidate(root, 'candidate', 'skill'),
				split: 'validation' as const,
				seed: 'stable-seed',
				models: ['configured'],
				budgets: {
					maxTasks: 1,
					maxRepetitions: 1,
					maxConcurrency: 2,
					maxTaskTimeMs: 5_000,
					maxRetries: 1,
					maxOutputBytes: 4_096,
				},
				executor: async ({
					candidate: item,
					isolatedRoot,
				}: {
					candidate: EvaluationCandidateV1;
					isolatedRoot: string;
				}) => {
					expect(fs.existsSync(path.join(isolatedRoot, 'subject.ts'))).toBe(
						true,
					);
					const attempt = attempts.get(item.id) ?? 0;
					attempts.set(item.id, attempt + 1);
					return attempt === 0
						? {
								status: 'infrastructure_failure' as const,
								text: '',
								durationMs: 1,
								cost: { source: 'unavailable' as const },
								error: 'retryable',
							}
						: {
								status: 'completed' as const,
								text: '{"v":1,"caught":true}',
								durationMs: 1,
								cost: { source: 'unavailable' as const },
							};
				},
			};
			const first = await runEvaluation(options);
			expect(first.status).toBe('complete');
			expect(first.results).toHaveLength(2);
			expect(first.results.every((result) => result.retries === 1)).toBe(true);
			const resumed = await runEvaluation(options);
			expect(resumed).toEqual(first);
			expect([...attempts.values()]).toEqual([2, 2]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
