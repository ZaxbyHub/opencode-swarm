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
import type { EvaluationModelDispatchRequest } from '../../../src/evaluation/model-dispatcher.js';
import {
	_internals,
	createModelEvaluationExecutor,
	runEvaluation,
} from '../../../src/evaluation/runner.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

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

describe('createModelEvaluationExecutor — #2009 session directory binding', () => {
	test('binds the session to the project root and conveys the fixture path in the prompt', async () => {
		// OpenCode keys permission state per directory. The executor must create
		// its session in the project root (the invoking instance's directory),
		// NOT the isolated fixture root, so it lands in the same permission
		// partition. The fixture location is conveyed via the prompt.
		const projectRoot = '/project/root';
		const isolatedRoot = canonicalMkdtemp('eval-exec-2009-');
		try {
			const captured: EvaluationModelDispatchRequest[] = [];
			const fakeDispatcher = async (req: EvaluationModelDispatchRequest) => {
				captured.push(req);
				return {
					status: 'completed' as const,
					modelId: 'provider/model',
					agentName: 'reviewer',
					text: '{"v":1,"caught":true}',
					durationMs: 1,
				};
			};
			const executor = createModelEvaluationExecutor(fakeDispatcher);
			await executor({
				task: {
					v: 1,
					id: 't1',
					source: 'curated',
					split: 'validation',
					category: 'cat',
					protected: false,
					instructionPath: 'instruction.md',
					environment: { kind: 'fixture', path: 'fixture' },
					scorer: {
						kind: 'builtin',
						argv: ['scorer'],
						timeoutMs: 1_000,
						scoreRange: [0, 1],
					},
				} as EvaluationTaskV1,
				candidate: {
					v: 1,
					id: 'c1',
					kind: 'skill',
					payloadPath: 'candidate.md',
					model: 'configured',
				} as EvaluationCandidateV1,
				isolatedRoot,
				instruction: 'Find the defect.',
				payload: 'candidate system payload',
				seed: 'seed',
				abortSignal: new AbortController().signal,
				projectRoot,
			});
			expect(captured).toHaveLength(1);
			expect(captured[0]!.sessionDirectory).toBe(projectRoot);
			expect(captured[0]!.sessionDirectory).not.toBe(isolatedRoot);
			// The prompt directs the agent to the isolated fixture directory.
			expect(captured[0]!.prompt).toContain(
				`Work ONLY in this directory: ${isolatedRoot}`,
			);
		} finally {
			fs.rmSync(isolatedRoot, { recursive: true, force: true });
		}
	});

	test('runEvaluation threads projectRoot into the executor args', async () => {
		// The executor contract receives projectRoot from the runner so ANY
		// executor — including createModelEvaluationExecutor — has it without
		// an optional factory parameter. This is the wiring that ensures the
		// runner path is actually fixed (#2009), not silently falling back to
		// the isolated fixture directory.
		const root = canonicalMkdtemp('eval-thread-2009-');
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
				id: 'thread-2009',
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
			_internals.captureWorkingTreeFingerprint = async () => ({
				head: 'a'.repeat(40),
				porcelainHash: 'b'.repeat(64),
			});
			_internals.withDisposableWorktree = async ({ baseRef, run }) => {
				const worktreeRoot = canonicalMkdtemp('eval-worktree-thread-');
				try {
					return await run({ path: worktreeRoot, baseSha: baseRef });
				} finally {
					fs.rmSync(worktreeRoot, { recursive: true, force: true });
				}
			};
			const receivedProjectRoots: string[] = [];
			const options = {
				projectRoot: root,
				tasks: [task],
				baseline: await candidate(root, 'baseline', 'baseline'),
				candidate: await candidate(root, 'candidate', 'skill'),
				split: 'validation' as const,
				seed: 'thread-seed',
				models: ['configured'],
				budgets: {
					maxTasks: 1,
					maxRepetitions: 1,
					maxConcurrency: 1,
					maxTaskTimeMs: 5_000,
					maxRetries: 0,
					maxOutputBytes: 4_096,
				},
				executor: async ({ projectRoot: received }) => {
					receivedProjectRoots.push(received);
					return {
						status: 'completed' as const,
						text: '{"v":1,"caught":true}',
						durationMs: 1,
						cost: { source: 'unavailable' as const },
					};
				},
			};
			await runEvaluation(options);
			// The executor received the project root, not a temp path.
			expect(receivedProjectRoots.length).toBeGreaterThan(0);
			for (const received of receivedProjectRoots) {
				expect(received).toBe(root);
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
