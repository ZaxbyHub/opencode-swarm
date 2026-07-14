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
import {
	_internals,
	type RunEvaluationOptions,
	runEvaluation,
} from '../../../src/evaluation/runner.js';

const originalFingerprint = _internals.captureWorkingTreeFingerprint;
const originalDisposableWorktree = _internals.withDisposableWorktree;
const originalRunExternalTool = _internals.runExternalTool;
let harnessSequence = 0;

afterEach(() => {
	_internals.captureWorkingTreeFingerprint = originalFingerprint;
	_internals.withDisposableWorktree = originalDisposableWorktree;
	_internals.runExternalTool = originalRunExternalTool;
});

async function candidate(
	root: string,
	id: string,
): Promise<EvaluationCandidateV1> {
	const draft = {
		v: 1 as const,
		id,
		kind: id === 'baseline' ? ('baseline' as const) : ('skill' as const),
		payloadPath: `${id}.md`,
		model: 'configured',
	};
	return {
		...draft,
		contentHash: await computeCandidateInputContentHash(root, draft),
	};
}

async function harness(
	kind: 'builtin' | 'project' = 'project',
	scorerInput: Record<string, unknown> = { score: 0.75 },
): Promise<{ root: string; options: RunEvaluationOptions }> {
	const root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'eval-runner-failure-')),
	);
	fs.mkdirSync(path.join(root, 'fixture'));
	fs.writeFileSync(path.join(root, 'fixture', 'subject.ts'), 'export {}\n');
	fs.writeFileSync(path.join(root, 'instruction.md'), 'Return a verdict.\n');
	fs.writeFileSync(path.join(root, 'baseline.md'), 'baseline\n');
	fs.writeFileSync(path.join(root, 'candidate.md'), 'candidate\n');
	fs.writeFileSync(
		path.join(root, 'fixture', 'helper.mjs'),
		'export const normalize = (value) => Number(value);\n',
	);
	fs.writeFileSync(
		path.join(root, 'fixture', 'score.json'),
		`${JSON.stringify(scorerInput)}\n`,
	);
	fs.writeFileSync(
		path.join(root, 'fixture', 'scorer.mjs'),
		"import { readFile } from 'node:fs/promises';\nimport { normalize } from './helper.mjs';\nconst input = JSON.parse(await readFile(process.argv[2], 'utf8'));\nif (input.mode === 'exit') process.exit(7);\nif (input.mode === 'malformed') process.stdout.write('{bad');\nelse process.stdout.write(JSON.stringify({ v: 1, score: normalize(input.score), cost: { source: 'reported', usd: 0 } }));\n",
	);
	const draft = {
		v: 1 as const,
		id: `task-${kind}`,
		source: 'curated' as const,
		split: 'validation' as const,
		category: 'correctness',
		protected: true,
		instructionPath: 'instruction.md',
		environment: { kind: 'fixture' as const, path: 'fixture' },
		scorer: {
			kind,
			argv:
				kind === 'project' ? ['fixture/scorer.mjs', 'score.json'] : ['builtin'],
			timeoutMs: 1_000,
			scoreRange: [0, 1] as [number, number],
		},
		provenance: { origin: 'unit-test', license: 'MIT' },
	};
	const task: EvaluationTaskV1 = {
		...draft,
		contentHash: await computeTaskInputContentHash(root, draft),
	};
	_internals.captureWorkingTreeFingerprint = async () => ({
		head: 'a'.repeat(40),
		porcelainHash: 'b'.repeat(64),
	});
	_internals.withDisposableWorktree = async ({ baseRef, run }) => {
		const worktreeRoot = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'eval-isolated-')),
		);
		try {
			return await run({ path: worktreeRoot, baseSha: baseRef });
		} finally {
			fs.rmSync(worktreeRoot, { recursive: true, force: true });
		}
	};
	const options: RunEvaluationOptions = {
		projectRoot: root,
		tasks: [task],
		baseline: await candidate(root, 'baseline'),
		candidate: await candidate(root, 'candidate'),
		split: 'validation',
		seed: `seed-${++harnessSequence}`,
		models: ['configured'],
		budgets: {
			maxTasks: 1,
			maxRepetitions: 1,
			maxConcurrency: 2,
			maxTaskTimeMs: 250,
			maxRetries: 1,
			maxOutputBytes: 128,
		},
		executor: async () => ({
			status: 'completed',
			text: '{"v":1,"caught":true}',
			durationMs: 1,
			cost: { source: 'reported', usd: 0 },
		}),
	};
	return { root, options };
}

function externalResult(overrides: Record<string, unknown> = {}) {
	return {
		status: 'completed' as const,
		exitCode: 0,
		stdout: '{"v":1,"score":1,"cost":{"source":"reported","usd":0}}',
		stderr: '',
		stdoutTruncated: false,
		stderrTruncated: false,
		...overrides,
	};
}

describe('evaluation runner failure classification', () => {
	test.each([
		[
			'timeout',
			externalResult({ status: 'timeout', exitCode: null }),
			'timeout',
			'scorer-timeout',
		],
		[
			'spawn',
			externalResult({
				status: 'spawn-error',
				exitCode: null,
				message: 'EACCES',
			}),
			'infrastructure_failure',
			'scorer-spawn-failure',
		],
		[
			'truncated',
			externalResult({ stdoutTruncated: true }),
			'malformed',
			'scorer-output-truncated',
		],
		[
			'json',
			externalResult({ stdout: '{bad' }),
			'malformed',
			'scorer-invalid-json',
		],
		[
			'schema',
			externalResult({
				stdout: '{"v":1,"score":"bad","cost":{"source":"unavailable"}}',
			}),
			'malformed',
			'scorer-schema-invalid',
		],
		[
			'reported cost without USD',
			externalResult({
				stdout: '{"v":1,"score":1,"cost":{"source":"reported"}}',
			}),
			'malformed',
			'scorer-schema-invalid',
		],
		[
			'unavailable cost with USD',
			externalResult({
				stdout: '{"v":1,"score":1,"cost":{"source":"unavailable","usd":1}}',
			}),
			'malformed',
			'scorer-schema-invalid',
		],
		[
			'range',
			externalResult({
				stdout: '{"v":1,"score":2,"cost":{"source":"reported","usd":0}}',
			}),
			'malformed',
			'score-out-of-range',
		],
	] as const)('classifies project scorer %s distinctly', async (_name, result, outcome, failureCode) => {
		const { root, options } = await harness();
		let calls = 0;
		try {
			_internals.runExternalTool = async () => {
				calls++;
				return result;
			};
			const run = await runEvaluation(options);
			expect(run.results.every((entry) => entry.outcome === outcome)).toBe(
				true,
			);
			expect(
				run.results.every((entry) => entry.failureCode === failureCode),
			).toBe(true);
			expect(calls).toBe(outcome === 'infrastructure_failure' ? 4 : 2);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('returns on the per-task deadline when executor ignores AbortSignal', async () => {
		const { root, options } = await harness('builtin');
		try {
			options.budgets.maxTaskTimeMs = 20;
			options.executor = async () => new Promise(() => {});
			const startedAt = performance.now();
			const run = await runEvaluation(options);
			expect(performance.now() - startedAt).toBeLessThan(500);
			expect(run.results.every((entry) => entry.outcome === 'timeout')).toBe(
				true,
			);
			expect(
				run.results.every(
					(entry) => entry.failureCode === 'executor-task-timeout',
				),
			).toBe(true);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('executes a real portable scorer with sibling imports and relative data', async () => {
		const { root, options } = await harness();
		try {
			options.budgets.maxTaskTimeMs = 3_000;
			_internals.runExternalTool = originalRunExternalTool;
			const run = await runEvaluation(options);
			expect(run.status).toBe('complete');
			expect(run.results).toHaveLength(2);
			expect(run.results.every((entry) => entry.outcome === 'scored')).toBe(
				true,
			);
			expect(run.results.every((entry) => entry.score === 0.75)).toBe(true);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test.each([
		[
			'non-zero exit',
			{ mode: 'exit' },
			'infrastructure_failure',
			'scorer-exit-7',
		],
		[
			'malformed JSON',
			{ mode: 'malformed' },
			'malformed',
			'scorer-invalid-json',
		],
	] as const)('classifies a real portable scorer %s', async (_name, scorerInput, outcome, failureCode) => {
		const { root, options } = await harness('project', scorerInput);
		try {
			options.budgets.maxTaskTimeMs = 3_000;
			_internals.runExternalTool = originalRunExternalTool;
			const run = await runEvaluation(options);
			expect(run.status).toBe('inconclusive');
			expect(run.results.every((entry) => entry.outcome === outcome)).toBe(
				true,
			);
			expect(
				run.results.every((entry) => entry.failureCode === failureCode),
			).toBe(true);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('bounds builtin output before parsing', async () => {
		const { root, options } = await harness('builtin');
		try {
			options.budgets.maxOutputBytes = 8;
			options.executor = async () => ({
				status: 'completed',
				text: '{"v":1,"caught":true}',
				durationMs: 1,
				cost: { source: 'unavailable' },
			});
			const run = await runEvaluation(options);
			expect(
				run.results.every(
					(entry) => entry.failureCode === 'executor-output-truncated',
				),
			).toBe(true);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
