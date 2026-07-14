import * as fs from 'node:fs';
import * as path from 'node:path';
import pLimit from 'p-limit';
import { z } from 'zod';
import { runExternalTool } from '../utils/external-tool-runner.js';
import type {
	CostRecord,
	EvaluationBudgetsV1Schema,
	EvaluationCandidateV1,
	EvaluationResultV1,
	EvaluationRunV1,
	EvaluationSplit,
	EvaluationTaskV1,
} from './contracts.js';
import {
	CostRecordSchema,
	EvaluationCandidateV1Schema,
	EvaluationRunV1Schema,
	EvaluationTaskV1Schema,
} from './contracts.js';
import {
	captureWorkingTreeFingerprint,
	type DisposableWorktree,
	withDisposableWorktree,
} from './disposable-worktree.js';
import {
	canonicalHash,
	computeCandidateInputContentHash,
	computeRunIntegrityHash,
	computeTaskInputContentHash,
	computeTaskSetContentHash,
	resolveContainedExistingPath,
} from './hashing.js';
import type { EvaluationModelDispatcher } from './model-dispatcher.js';
import {
	admitEvaluationTask,
	claimHeldOutTest,
	readEvaluationRun,
	saveEvaluationRun,
	saveTaskSetSnapshot,
} from './store.js';

const ScorerOutputSchema = z
	.object({
		v: z.literal(1),
		score: z.number().finite(),
		cost: CostRecordSchema,
		metadata: z.record(z.string(), z.unknown()).optional(),
	})
	.strict();

const BuiltinVerdictSchema = z
	.object({
		v: z.literal(1),
		caught: z.boolean(),
		reason: z.string().optional(),
	})
	.strict();

type EvaluationBudgetsV1 = z.infer<typeof EvaluationBudgetsV1Schema>;

class ScorerFailure extends Error {
	constructor(
		readonly outcome: EvaluationResultV1['outcome'],
		readonly failureCode: string,
		readonly retryable: boolean,
	) {
		super(failureCode);
		this.name = 'ScorerFailure';
	}
}

export type EvaluationExecutorResult = {
	status: 'completed' | 'timeout' | 'cancelled' | 'infrastructure_failure';
	text: string;
	durationMs: number;
	cost: CostRecord;
	error?: string;
};

export type EvaluationExecutor = (args: {
	task: EvaluationTaskV1;
	candidate: EvaluationCandidateV1;
	isolatedRoot: string;
	instruction: string;
	payload: string;
	seed: string;
	abortSignal: AbortSignal;
}) => Promise<EvaluationExecutorResult>;

export type RunEvaluationOptions = {
	projectRoot: string;
	inputRoot?: string;
	tasks: EvaluationTaskV1[];
	baseline: EvaluationCandidateV1;
	candidate: EvaluationCandidateV1;
	split: EvaluationSplit;
	seed: string;
	models: string[];
	budgets: EvaluationBudgetsV1;
	executor: EvaluationExecutor;
	abortSignal?: AbortSignal;
};

function aggregateCost(results: EvaluationResultV1[]): CostRecord {
	if (results.some((result) => result.cost.source === 'unavailable')) {
		return { source: 'unavailable' };
	}
	return {
		source: results.some((result) => result.cost.source === 'estimated')
			? 'estimated'
			: 'reported',
		usd: results.reduce((sum, result) => sum + (result.cost.usd ?? 0), 0),
	};
}

function failureResult(args: {
	task: EvaluationTaskV1;
	candidate: EvaluationCandidateV1;
	repetition: number;
	seed: string;
	outcome: EvaluationResultV1['outcome'];
	durationMs: number;
	cost?: CostRecord;
	failureCode: string;
}): EvaluationResultV1 {
	return {
		v: 1,
		taskId: args.task.id,
		category: args.task.category,
		protected: args.task.protected,
		repetition: args.repetition,
		candidateId: args.candidate.id,
		seed: args.seed,
		outcome: args.outcome,
		scoreRange: args.task.scorer.scoreRange,
		cost: args.cost ?? { source: 'unavailable' },
		durationMs: args.durationMs,
		retries: 0,
		failureCode: args.failureCode,
	};
}

function parseBuiltinScore(text: string): z.infer<typeof ScorerOutputSchema> {
	let value: unknown;
	try {
		value = JSON.parse(text.trim());
	} catch {
		throw new ScorerFailure('malformed', 'builtin-invalid-json', false);
	}
	const parsed = BuiltinVerdictSchema.safeParse(value);
	if (!parsed.success) {
		throw new ScorerFailure('malformed', 'builtin-schema-invalid', false);
	}
	const verdict = parsed.data;
	return {
		v: 1,
		score: verdict.caught ? 1 : 0,
		cost: { source: 'unavailable' },
		metadata: verdict.reason ? { reason: verdict.reason } : undefined,
	};
}

async function scoreExecution(args: {
	task: EvaluationTaskV1;
	candidate: EvaluationCandidateV1;
	inputRoot: string;
	isolatedRoot: string;
	execution: EvaluationExecutorResult;
	seed: string;
	maxOutputBytes: number;
	timeoutMs: number;
	abortSignal: AbortSignal;
}): Promise<z.infer<typeof ScorerOutputSchema>> {
	if (args.task.scorer.kind === 'builtin')
		return parseBuiltinScore(args.execution.text);
	const sourceEnvironment = resolveContainedExistingPath(
		args.inputRoot,
		args.task.environment.path,
	);
	const sourceExecutable = resolveContainedExistingPath(
		args.inputRoot,
		args.task.scorer.argv[0],
	);
	const scorerRelative = path.relative(sourceEnvironment, sourceExecutable);
	if (
		!scorerRelative ||
		scorerRelative === '..' ||
		scorerRelative.startsWith(`..${path.sep}`) ||
		path.isAbsolute(scorerRelative)
	) {
		throw new ScorerFailure('malformed', 'scorer-outside-task-package', false);
	}
	const isolatedExecutable = resolveContainedExistingPath(
		args.isolatedRoot,
		scorerRelative,
	);
	if (!fs.statSync(isolatedExecutable).isFile()) {
		throw new ScorerFailure('malformed', 'scorer-not-a-file', false);
	}
	const extension = path.extname(isolatedExecutable).toLowerCase();
	const isJavaScript = ['.cjs', '.js', '.mjs'].includes(extension);
	const executable = isJavaScript ? process.execPath : isolatedExecutable;
	const scorerArgs = isJavaScript
		? [isolatedExecutable, ...args.task.scorer.argv.slice(1)]
		: args.task.scorer.argv.slice(1);
	const artifactDirectory = path.join(args.isolatedRoot, '.artifacts');
	fs.mkdirSync(artifactDirectory, { recursive: true });
	fs.writeFileSync(
		path.join(artifactDirectory, 'model-output.json'),
		JSON.stringify({ v: 1, text: args.execution.text }),
	);
	const result = await _internals.runExternalTool({
		executable,
		args: scorerArgs,
		cwd: args.isolatedRoot,
		timeoutMs: Math.min(args.task.scorer.timeoutMs, args.timeoutMs),
		maxStdoutBytes: args.maxOutputBytes,
		maxStderrBytes: args.maxOutputBytes,
		abortSignal: args.abortSignal,
		env: {
			...process.env,
			SWARM_EVAL_TASK_ID: args.task.id,
			SWARM_EVAL_CANDIDATE_ID: args.candidate.id,
			SWARM_EVAL_ARTIFACT_DIR: artifactDirectory,
			SWARM_EVAL_SEED: args.seed,
		},
	});
	if (result.status === 'timeout')
		throw new ScorerFailure('timeout', 'scorer-timeout', false);
	if (result.status === 'cancelled')
		throw new ScorerFailure('cancelled', 'scorer-cancelled', false);
	if (result.status === 'spawn-error')
		throw new ScorerFailure(
			'infrastructure_failure',
			'scorer-spawn-failure',
			true,
		);
	if (result.exitCode !== 0) {
		throw new ScorerFailure(
			'infrastructure_failure',
			`scorer-exit-${result.exitCode ?? 'none'}`,
			true,
		);
	}
	if (result.stdoutTruncated || result.stderrTruncated) {
		throw new ScorerFailure('malformed', 'scorer-output-truncated', false);
	}
	let value: unknown;
	try {
		value = JSON.parse(result.stdout.trim());
	} catch {
		throw new ScorerFailure('malformed', 'scorer-invalid-json', false);
	}
	const parsed = ScorerOutputSchema.safeParse(value);
	if (!parsed.success) {
		throw new ScorerFailure('malformed', 'scorer-schema-invalid', false);
	}
	return parsed.data;
}

async function runExecutorWithinBudget(args: {
	options: RunEvaluationOptions;
	task: EvaluationTaskV1;
	candidate: EvaluationCandidateV1;
	isolatedRoot: string;
	instruction: string;
	payload: string;
	seed: string;
	parentSignal: AbortSignal;
	maxTimeMs: number;
}): Promise<EvaluationExecutorResult> {
	const startedAt = Date.now();
	const controller = new AbortController();
	let timedOut = false;
	const parentAbort = () => controller.abort();
	args.parentSignal.addEventListener('abort', parentAbort, { once: true });
	if (args.parentSignal.aborted) controller.abort();
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, args.maxTimeMs);
	try {
		const aborted = new Promise<EvaluationExecutorResult>((resolve) => {
			const finish = () =>
				resolve({
					status: timedOut ? 'timeout' : 'cancelled',
					text: '',
					durationMs: Date.now() - startedAt,
					cost: { source: 'unavailable' },
					error: timedOut ? 'executor-task-timeout' : 'executor-cancelled',
				});
			controller.signal.addEventListener('abort', finish, { once: true });
			if (controller.signal.aborted) finish();
		});
		return await Promise.race([
			args.options.executor({
				task: args.task,
				candidate: args.candidate,
				isolatedRoot: args.isolatedRoot,
				instruction: args.instruction,
				payload: args.payload,
				seed: args.seed,
				abortSignal: controller.signal,
			}),
			aborted,
		]);
	} finally {
		clearTimeout(timer);
		args.parentSignal.removeEventListener('abort', parentAbort);
		controller.abort();
	}
}

async function executePairMember(args: {
	options: RunEvaluationOptions;
	inputRoot: string;
	task: EvaluationTaskV1;
	candidate: EvaluationCandidateV1;
	repetition: number;
	signal: AbortSignal;
	baseSha: string;
}): Promise<EvaluationResultV1> {
	const startedAt = Date.now();
	const seed = canonicalHash(
		`${args.options.seed}:${args.task.id}:${args.candidate.id}:${args.repetition}`,
	);
	if (args.signal.aborted) {
		return failureResult({
			...args,
			seed,
			outcome: 'cancelled',
			durationMs: 0,
			failureCode: 'cancelled-before-execution',
		});
	}
	if (args.task.environment.kind === 'container') {
		return failureResult({
			...args,
			seed,
			outcome: 'unsupported',
			durationMs: 0,
			failureCode: 'container-runner-unavailable',
		});
	}
	try {
		return await _internals.withDisposableWorktree({
			projectRoot: args.options.projectRoot,
			baseRef: args.baseSha,
			abortSignal: args.signal,
			run: async (worktree) => {
				const isolatedRoot = path.join(worktree.path, '.swarm-evaluation-task');
				fs.mkdirSync(isolatedRoot, { recursive: true });
				try {
					fs.cpSync(
						resolveContainedExistingPath(
							args.inputRoot,
							args.task.environment.path,
						),
						isolatedRoot,
						{ recursive: true, errorOnExist: false },
					);
					const instruction = fs.readFileSync(
						resolveContainedExistingPath(
							args.inputRoot,
							args.task.instructionPath,
						),
						'utf8',
					);
					const payload = fs.readFileSync(
						resolveContainedExistingPath(
							args.inputRoot,
							args.candidate.payloadPath,
						),
						'utf8',
					);
					const remainingBeforeExecution =
						args.options.budgets.maxTaskTimeMs - (Date.now() - startedAt);
					if (remainingBeforeExecution <= 0) {
						return failureResult({
							...args,
							seed,
							outcome: 'timeout',
							durationMs: Date.now() - startedAt,
							failureCode: 'task-budget-exhausted-before-executor',
						});
					}
					const execution = await runExecutorWithinBudget({
						options: args.options,
						task: args.task,
						candidate: args.candidate,
						isolatedRoot,
						instruction,
						payload,
						seed,
						parentSignal: args.signal,
						maxTimeMs: remainingBeforeExecution,
					});
					if (execution.status !== 'completed') {
						return failureResult({
							...args,
							seed,
							outcome:
								execution.status === 'infrastructure_failure'
									? 'infrastructure_failure'
									: execution.status,
							durationMs: execution.durationMs,
							cost: execution.cost,
							failureCode: execution.error ?? `executor-${execution.status}`,
						});
					}
					if (
						Buffer.byteLength(execution.text, 'utf8') >
						args.options.budgets.maxOutputBytes
					) {
						return failureResult({
							...args,
							seed,
							outcome: 'malformed',
							durationMs: Date.now() - startedAt,
							cost: execution.cost,
							failureCode: 'executor-output-truncated',
						});
					}
					let scored: z.infer<typeof ScorerOutputSchema>;
					try {
						const remainingBeforeScorer =
							args.options.budgets.maxTaskTimeMs - (Date.now() - startedAt);
						if (remainingBeforeScorer <= 0) {
							throw new ScorerFailure(
								'timeout',
								'task-budget-exhausted-before-scorer',
								false,
							);
						}
						scored = await scoreExecution({
							task: args.task,
							candidate: args.candidate,
							inputRoot: args.inputRoot,
							isolatedRoot,
							execution,
							seed,
							maxOutputBytes: args.options.budgets.maxOutputBytes,
							timeoutMs: remainingBeforeScorer,
							abortSignal: args.signal,
						});
					} catch (error) {
						const scorerFailure =
							error instanceof ScorerFailure ? error : undefined;
						return failureResult({
							...args,
							seed,
							outcome: args.signal.aborted
								? 'cancelled'
								: (scorerFailure?.outcome ?? 'malformed'),
							durationMs: Date.now() - startedAt,
							cost: execution.cost,
							failureCode:
								scorerFailure?.failureCode ??
								(error instanceof Error
									? error.message.slice(0, 160)
									: 'scorer-error'),
						});
					}
					const [minimum, maximum] = args.task.scorer.scoreRange;
					if (scored.score < minimum || scored.score > maximum) {
						return failureResult({
							...args,
							seed,
							outcome: 'malformed',
							durationMs: Date.now() - startedAt,
							cost: scored.cost,
							failureCode: 'score-out-of-range',
						});
					}
					return {
						v: 1,
						taskId: args.task.id,
						category: args.task.category,
						protected: args.task.protected,
						repetition: args.repetition,
						candidateId: args.candidate.id,
						seed,
						outcome: 'scored',
						score: scored.score,
						scoreRange: args.task.scorer.scoreRange,
						cost: scored.cost,
						durationMs: Date.now() - startedAt,
						retries: 0,
						metadata: scored.metadata,
					};
				} finally {
					fs.rmSync(isolatedRoot, { recursive: true, force: true });
				}
			},
		});
	} catch (error) {
		return failureResult({
			...args,
			seed,
			outcome: 'infrastructure_failure',
			durationMs: Date.now() - startedAt,
			failureCode: canonicalHash(String(error)).slice(0, 32),
		});
	}
}

async function executePairMemberWithRetries(
	args: Parameters<typeof executePairMember>[0],
): Promise<EvaluationResultV1> {
	let result: EvaluationResultV1 | undefined;
	for (let attempt = 0; attempt <= args.options.budgets.maxRetries; attempt++) {
		result = await executePairMember(args);
		result.retries = attempt;
		if (result.outcome !== 'infrastructure_failure' || args.signal.aborted) {
			return result;
		}
	}
	return result!;
}

export async function runEvaluation(
	options: RunEvaluationOptions,
): Promise<EvaluationRunV1> {
	const inputRoot = options.inputRoot ?? options.projectRoot;
	const tasks = options.tasks.map((task) => EvaluationTaskV1Schema.parse(task));
	if (tasks.length === 0 || tasks.length > options.budgets.maxTasks) {
		throw new Error('evaluation task count exceeds its declared budget');
	}
	if (tasks.some((task) => task.split !== options.split)) {
		throw new Error('evaluation task split does not match the run split');
	}
	const baseline = EvaluationCandidateV1Schema.parse(options.baseline);
	const candidate = EvaluationCandidateV1Schema.parse(options.candidate);
	for (const item of [baseline, candidate]) {
		if (
			(await computeCandidateInputContentHash(inputRoot, item)) !==
			item.contentHash
		) {
			throw new Error(`candidate ${item.id} content hash is invalid`);
		}
	}
	const snapshotDraft = {
		v: 1 as const,
		id: `taskset-${canonicalHash(tasks.map((task) => task.id)).slice(0, 20)}`,
		split: options.split,
		tasks,
		createdAt: new Date().toISOString(),
	};
	for (const task of tasks) {
		await admitEvaluationTask(options.projectRoot, task, inputRoot);
	}
	const taskSet = {
		...snapshotDraft,
		contentHash: computeTaskSetContentHash(snapshotDraft),
	};
	const storedTaskSet = await saveTaskSetSnapshot(
		options.projectRoot,
		taskSet,
		inputRoot,
	);
	const runId = `eval-${canonicalHash({
		baseline: baseline.contentHash,
		candidate: candidate.contentHash,
		taskSet: storedTaskSet.contentHash,
		split: options.split,
		seed: options.seed,
		models: options.models,
		budgets: options.budgets,
	}).slice(0, 32)}`;
	const existingRun = await readEvaluationRun(options.projectRoot, runId);
	if (existingRun) return existingRun;
	if (options.split === 'test') {
		await claimHeldOutTest(options.projectRoot, {
			v: 1,
			runId,
			taskSetHash: storedTaskSet.contentHash,
			baselineHash: baseline.contentHash,
			candidateHash: candidate.contentHash,
			claimedAt: new Date().toISOString(),
		});
	}

	const before = await _internals.captureWorkingTreeFingerprint(
		options.projectRoot,
	);
	const controller = new AbortController();
	let externallyCancelled = options.abortSignal?.aborted ?? false;
	let timedOut = false;
	let budgetInconclusive = false;
	let scheduledSpendUsd = 0;
	const externalAbort = () => {
		externallyCancelled = true;
		controller.abort();
	};
	options.abortSignal?.addEventListener('abort', externalAbort, { once: true });
	if (externallyCancelled) controller.abort();
	const totalExecutions = tasks.length * 2 * options.budgets.maxRepetitions;
	const executionWaves = Math.ceil(
		totalExecutions / options.budgets.maxConcurrency,
	);
	const totalTimeoutMs = Math.min(
		2_147_483_647,
		options.budgets.maxTaskTimeMs *
			executionWaves *
			(options.budgets.maxRetries + 1) +
			1_000,
	);
	const timeout = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, totalTimeoutMs);
	try {
		const limit = pLimit(options.budgets.maxConcurrency);
		const jobs: Array<Promise<EvaluationResultV1>> = [];
		for (const task of tasks) {
			for (const item of [baseline, candidate]) {
				for (
					let repetition = 0;
					repetition < options.budgets.maxRepetitions;
					repetition++
				) {
					jobs.push(
						limit(() =>
							executePairMemberWithRetries({
								options,
								inputRoot,
								task,
								candidate: item,
								repetition,
								signal: controller.signal,
								baseSha: before.head,
							}).then((result) => {
								if (options.budgets.maxSpendUsd !== undefined) {
									if (result.cost.source === 'unavailable') {
										budgetInconclusive = true;
										controller.abort();
									} else {
										scheduledSpendUsd += result.cost.usd ?? 0;
										if (scheduledSpendUsd > options.budgets.maxSpendUsd) {
											budgetInconclusive = true;
											controller.abort();
										}
									}
								}
								return result;
							}),
						),
					);
				}
			}
		}
		const results = await Promise.all(jobs);
		for (const task of tasks) {
			if (
				(await computeTaskInputContentHash(inputRoot, task)) !==
				task.contentHash
			) {
				throw new Error(`task ${task.id} changed during evaluation`);
			}
		}
		for (const item of [baseline, candidate]) {
			if (
				(await computeCandidateInputContentHash(inputRoot, item)) !==
				item.contentHash
			) {
				throw new Error(`candidate ${item.id} changed during evaluation`);
			}
		}
		const cost = aggregateCost(results);
		const spendUnknown =
			options.budgets.maxSpendUsd !== undefined &&
			cost.source === 'unavailable';
		const overSpend =
			options.budgets.maxSpendUsd !== undefined &&
			cost.source !== 'unavailable' &&
			(cost.usd ?? 0) > options.budgets.maxSpendUsd;
		const incomplete = results.some((result) => result.outcome !== 'scored');
		const runDraft = {
			v: 1 as const,
			runId,
			createdAt: new Date().toISOString(),
			status:
				externallyCancelled || timedOut
					? ('cancelled' as const)
					: incomplete || spendUnknown || overSpend || budgetInconclusive
						? ('inconclusive' as const)
						: ('complete' as const),
			baseline,
			candidate,
			taskSet: {
				id: storedTaskSet.id,
				contentHash: storedTaskSet.contentHash,
				taskIds: tasks.map((task) => task.id),
			},
			split: options.split,
			seed: options.seed,
			models: options.models,
			environment: {
				platform: process.platform,
				arch: process.arch,
				runtime: `node-${process.versions.node};bun-${process.versions.bun ?? 'compat'}`,
				baseSha: before.head,
				activeTreeHash: canonicalHash(before),
				taskSetHash: storedTaskSet.contentHash,
			},
			budgets: options.budgets,
			results,
			cost,
		};
		const run = EvaluationRunV1Schema.parse({
			...runDraft,
			integrityHash: computeRunIntegrityHash(runDraft),
		});
		await saveEvaluationRun(options.projectRoot, run);
		return run;
	} finally {
		clearTimeout(timeout);
		options.abortSignal?.removeEventListener('abort', externalAbort);
		const after = await _internals.captureWorkingTreeFingerprint(
			options.projectRoot,
		);
		if (
			before.head !== after.head ||
			before.porcelainHash !== after.porcelainHash
		) {
			// biome-ignore lint/correctness/noUnsafeFinally: active-tree integrity failure must override a seemingly successful evaluation.
			throw new Error('evaluation changed the active working tree');
		}
	}
}

export const _internals = {
	captureWorkingTreeFingerprint,
	runExternalTool,
	withDisposableWorktree: withDisposableWorktree as <T>(args: {
		projectRoot: string;
		baseRef: string;
		abortSignal?: AbortSignal;
		run: (worktree: DisposableWorktree) => Promise<T>;
	}) => Promise<T>,
};

export function createModelEvaluationExecutor(
	dispatcher: EvaluationModelDispatcher,
	parentSessionId?: string,
): EvaluationExecutor {
	return async (args) => {
		const result = await dispatcher({
			directory: args.isolatedRoot,
			agentName: args.candidate.agent ?? 'reviewer',
			modelId: args.candidate.model,
			system: args.payload,
			prompt: [
				'EVALUATION TASK:',
				args.instruction,
				'',
				'Return the task-required scorer payload exactly.',
			].join('\n'),
			timeoutMs: args.task.scorer.timeoutMs,
			parentSessionId,
			abortSignal: args.abortSignal,
		});
		return {
			status:
				result.status === 'error' ? 'infrastructure_failure' : result.status,
			text: result.text,
			durationMs: result.durationMs,
			cost: { source: 'unavailable' },
			error: result.error,
		};
	};
}
