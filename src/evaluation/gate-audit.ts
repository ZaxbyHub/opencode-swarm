import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import pLimit from 'p-limit';
import { z } from 'zod';
import {
	executeMutationSuite,
	runMutationCommand,
} from '../mutation/engine.js';
import { classifyFailure } from '../test-impact/failure-classifier.js';
import type { TestRunRecord } from '../test-impact/history-store.js';
import { qualityBudget } from '../tools/quality-budget.js';
import { sastScan } from '../tools/sast-scan.js';
import type {
	CostRecord,
	EvaluationTaskV1,
	GateAuditCellV1,
	GateAuditManifestV1,
	GateAuditResultV1,
	GateName,
} from './contracts.js';
import {
	GateAuditManifestV1Schema,
	GateAuditResultV1Schema,
} from './contracts.js';
import { captureWorkingTreeFingerprint } from './disposable-worktree.js';
import { loadTier1EvaluationTasks } from './fixtures.js';
import {
	type GateGroundTruthV1,
	recordTestImpactGateGroundTruth,
	saveGateGroundTruth,
} from './gate-ground-truth.js';
import {
	canonicalHash,
	computeManifestContentHash,
	computeTaskSetContentHash,
	resolveContainedExistingPath,
} from './hashing.js';
import type { EvaluationModelDispatcher } from './model-dispatcher.js';
import {
	admitEvaluationTask,
	saveGateAuditResult,
	saveTaskSetSnapshot,
} from './store.js';

const ModelVerdictSchema = z
	.object({
		v: z.literal(1),
		caught: z.boolean(),
		reason: z.string().min(1).max(2000),
	})
	.strict();

const LOCAL_COST: CostRecord = { source: 'reported', usd: 0 };
const CANDIDATE_VARIANTS = ['defect', 'clean'] as const;
type CandidateVariant = (typeof CANDIDATE_VARIANTS)[number];
type GroundTruthClassification = GateGroundTruthV1['classification'];
type GroundTruthProbe = {
	integration: Record<CandidateVariant, GroundTruthClassification>;
	testImpact: Record<
		CandidateVariant,
		{ classification: GroundTruthClassification; confidence: number }
	>;
};

export type RunGateAuditOptions = {
	projectRoot: string;
	packageRoot: string;
	manifest: GateAuditManifestV1;
	dispatcher?: EvaluationModelDispatcher;
	parentSessionId?: string;
	abortSignal?: AbortSignal;
};

function errorCell(args: {
	task: EvaluationTaskV1;
	candidateId: string;
	gate: GateName;
	model: string;
	repetition: number;
	startedAt: number;
	outcome?: GateAuditCellV1['outcome'];
	failureCode: string;
	cost?: CostRecord;
	retries?: number;
}): GateAuditCellV1 {
	return {
		v: 1,
		taskId: args.task.id,
		candidateId: args.candidateId,
		defectType: args.task.category,
		gate: args.gate,
		model: args.model,
		repetition: args.repetition,
		outcome: args.outcome ?? 'infrastructure_failure',
		retries: args.retries ?? 0,
		cost: args.cost ?? { source: 'unavailable' },
		durationMs: Date.now() - args.startedAt,
		failureClassification: 'infrastructure_failure',
		failureCode: args.failureCode,
	};
}

function parseModelVerdict(text: string): z.infer<typeof ModelVerdictSchema> {
	return ModelVerdictSchema.parse(JSON.parse(text.trim()));
}

function modelPrompt(
	task: EvaluationTaskV1,
	instruction: string,
	variant: CandidateVariant,
): string {
	return [
		'You are executing a read-only production gate audit against a curated defect fixture.',
		`Defect id: ${task.id}`,
		`Category: ${task.category}`,
		variant === 'defect'
			? instruction
			: 'This is a reviewed clean control. Report caught=false unless you find a concrete defect in the supplied implementation.',
		'Inspect the files in the current isolated directory. Do not modify them.',
		'Return exactly one JSON object and no markdown:',
		'{"v":1,"caught":true|false,"reason":"concise evidence"}',
	].join('\n');
}

function fullFileMutationPatch(baseline: string, defect: string): string {
	const before = baseline.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
	const after = defect.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
	return [
		'diff --git a/defect.ts b/defect.ts',
		'--- a/defect.ts',
		'+++ b/defect.ts',
		`@@ -1,${before.length} +1,${after.length} @@`,
		...before.map((line) => `-${line}`),
		...after.map((line) => `+${line}`),
		'',
	].join('\n');
}

type MutationGateResult = {
	outcome: 'caught' | 'missed' | 'infrastructure_failure';
	failureCode?: string;
};

/** Run a green baseline first, then apply and test the reviewed real defect patch. */
export async function runMutationGateAdapter(args: {
	directory: string;
	mutationType: string;
	timeoutMs: number;
	variant: CandidateVariant;
	abortSignal?: AbortSignal;
}): Promise<MutationGateResult> {
	const baseline = fs.readFileSync(
		path.join(args.directory, 'baseline.ts'),
		'utf8',
	);
	const defect = fs.readFileSync(
		path.join(args.directory, 'defect.ts'),
		'utf8',
	);
	fs.writeFileSync(path.join(args.directory, 'defect.ts'), baseline);
	const baselineResult = await runMutationCommand({
		executable: 'bun',
		args: ['test', 'defect.test.ts'],
		cwd: args.directory,
		timeoutMs: Math.min(args.timeoutMs, 30_000),
		abortSignal: args.abortSignal,
	});
	if (baselineResult.status !== 'completed') {
		return {
			outcome: 'infrastructure_failure',
			failureCode: `mutation-baseline-${baselineResult.status}`,
		};
	}
	if (baselineResult.exitCode !== 0) {
		return {
			outcome: 'infrastructure_failure',
			failureCode: 'mutation-red-baseline',
		};
	}
	if (args.variant === 'clean') return { outcome: 'missed' };

	const report = await executeMutationSuite(
		[
			{
				id: `gate-audit-${args.mutationType}`,
				filePath: 'defect.ts',
				functionName: 'fixture',
				mutationType: args.mutationType,
				patch: fullFileMutationPatch(baseline, defect),
			},
		],
		['bun', 'test'],
		['defect.test.ts'],
		args.directory,
		Math.min(args.timeoutMs, 30_000),
		undefined,
		undefined,
		{ abortSignal: args.abortSignal },
	);
	if (report.cancelled > 0 || report.timeout > 0 || report.errors > 0) {
		return {
			outcome: 'infrastructure_failure',
			failureCode:
				report.cancelled > 0
					? 'mutation-cancelled'
					: report.timeout > 0
						? 'mutation-timeout'
						: 'mutation-error',
		};
	}
	return { outcome: report.killed > 0 ? 'caught' : 'missed' };
}

function candidateId(
	task: EvaluationTaskV1,
	variant: CandidateVariant,
): string {
	return `${variant}-${task.id}`;
}

async function establishGateGroundTruth(args: {
	packageRoot: string;
	task: EvaluationTaskV1;
	timeoutMs: number;
	abortSignal: AbortSignal;
}): Promise<GroundTruthProbe> {
	if (args.task.environment.kind === 'container') {
		return {
			integration: {
				defect: 'infrastructure_failure',
				clean: 'infrastructure_failure',
			},
			testImpact: {
				defect: { classification: 'infrastructure_failure', confidence: 1 },
				clean: { classification: 'infrastructure_failure', confidence: 1 },
			},
		};
	}
	const tempRoot = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-gate-truth-')),
	);
	try {
		const sourceEnvironment = resolveContainedExistingPath(
			args.packageRoot,
			args.task.environment.path,
		);
		fs.cpSync(sourceEnvironment, tempRoot, {
			recursive: true,
			errorOnExist: false,
		});
		const baseline = fs.readFileSync(
			path.join(tempRoot, 'baseline.ts'),
			'utf8',
		);
		const defect = fs.readFileSync(path.join(tempRoot, 'defect.ts'), 'utf8');
		fs.writeFileSync(path.join(tempRoot, 'defect.ts'), baseline);
		const history: TestRunRecord[] = [];
		for (let baselineRun = 0; baselineRun < 3; baselineRun++) {
			const startedAt = Date.now();
			const clean = await runMutationCommand({
				executable: 'bun',
				args: ['test', 'defect.test.ts'],
				cwd: tempRoot,
				timeoutMs: Math.min(args.timeoutMs, 30_000),
				abortSignal: args.abortSignal,
			});
			if (clean.status !== 'completed') {
				return {
					integration: {
						defect: 'infrastructure_failure',
						clean: 'infrastructure_failure',
					},
					testImpact: {
						defect: {
							classification: 'infrastructure_failure',
							confidence: 1,
						},
						clean: {
							classification: 'infrastructure_failure',
							confidence: 1,
						},
					},
				};
			}
			const cleanRecord = testImpactRecord({
				taskId: args.task.id,
				result: clean.exitCode === 0 ? 'pass' : 'fail',
				startedAt,
				stdout: clean.stdout,
				stderr: clean.stderr,
			});
			if (clean.exitCode !== 0) {
				const classified = classifyFailure(cleanRecord, history);
				return {
					integration: { defect: 'unknown', clean: 'pre_existing' },
					testImpact: {
						defect: { classification: 'unknown', confidence: 0 },
						clean: {
							classification: classified.classification,
							confidence: classified.confidence,
						},
					},
				};
			}
			history.push(cleanRecord);
		}
		fs.writeFileSync(path.join(tempRoot, 'defect.ts'), defect);
		const defectStartedAt = Date.now();
		const defective = await runMutationCommand({
			executable: 'bun',
			args: ['test', 'defect.test.ts'],
			cwd: tempRoot,
			timeoutMs: Math.min(args.timeoutMs, 30_000),
			abortSignal: args.abortSignal,
		});
		if (defective.status !== 'completed') {
			return {
				integration: { defect: 'infrastructure_failure', clean: 'clean' },
				testImpact: {
					defect: {
						classification: 'infrastructure_failure',
						confidence: 1,
					},
					clean: { classification: 'clean', confidence: 1 },
				},
			};
		}
		if (defective.exitCode === 0) {
			return {
				integration: { defect: 'unknown', clean: 'clean' },
				testImpact: {
					defect: { classification: 'unknown', confidence: 0.5 },
					clean: { classification: 'clean', confidence: 1 },
				},
			};
		}
		const classified = classifyFailure(
			testImpactRecord({
				taskId: args.task.id,
				result: 'fail',
				startedAt: defectStartedAt,
				stdout: defective.stdout,
				stderr: defective.stderr,
			}),
			history,
		);
		return {
			integration: { defect: 'new_regression', clean: 'clean' },
			testImpact: {
				defect: {
					classification: classified.classification,
					confidence: classified.confidence,
				},
				clean: { classification: 'clean', confidence: 1 },
			},
		};
	} catch {
		return {
			integration: {
				defect: 'infrastructure_failure',
				clean: 'infrastructure_failure',
			},
			testImpact: {
				defect: { classification: 'infrastructure_failure', confidence: 1 },
				clean: { classification: 'infrastructure_failure', confidence: 1 },
			},
		};
	} finally {
		fs.rmSync(tempRoot, { recursive: true, force: true });
	}
}

function testImpactRecord(args: {
	taskId: string;
	result: TestRunRecord['result'];
	startedAt: number;
	stdout: string;
	stderr: string;
}): TestRunRecord {
	const output = `${args.stderr}\n${args.stdout}`.trim();
	return {
		timestamp: new Date(args.startedAt).toISOString(),
		taskId: args.taskId,
		testFile: 'defect.test.ts',
		testName: args.taskId,
		result: args.result,
		durationMs: Math.max(0, Date.now() - args.startedAt),
		errorMessage: output ? output.slice(0, 500) : undefined,
		stackPrefix: output ? output.split(/\r?\n/, 1)[0].slice(0, 200) : undefined,
		changedFiles: ['defect.test.ts'],
	};
}

function cellFailureClassification(
	classification: GroundTruthClassification,
): GateAuditCellV1['failureClassification'] {
	if (classification === 'pre_existing') return 'pre_existing_failure';
	if (classification === 'flaky') return 'flaky_failure';
	if (classification === 'clean') return 'clean';
	if (classification === 'unknown') return 'unknown_failure';
	return classification;
}

async function runCell(args: {
	options: RunGateAuditOptions;
	task: EvaluationTaskV1;
	candidateId: string;
	variant: CandidateVariant;
	groundTruth: GroundTruthClassification;
	gate: GateName;
	model: string;
	repetition: number;
	signal: AbortSignal;
}): Promise<GateAuditCellV1> {
	const startedAt = Date.now();
	if (args.signal.aborted) {
		return errorCell({
			...args,
			startedAt,
			failureCode: 'cancelled',
		});
	}
	if (args.task.environment.kind === 'container') {
		return errorCell({
			...args,
			startedAt,
			outcome: 'unsupported',
			failureCode: 'container-runner-unavailable',
		});
	}
	if (args.groundTruth !== 'clean' && args.groundTruth !== 'new_regression') {
		return errorCell({
			...args,
			startedAt,
			failureCode: `ground-truth-${args.groundTruth}`,
		});
	}

	const tempRoot = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-gate-audit-')),
	);
	try {
		const sourceEnvironment = resolveContainedExistingPath(
			args.options.packageRoot,
			args.task.environment.path,
		);
		fs.cpSync(sourceEnvironment, tempRoot, {
			recursive: true,
			errorOnExist: false,
		});
		if (args.variant === 'clean') {
			fs.copyFileSync(
				path.join(tempRoot, 'baseline.ts'),
				path.join(tempRoot, 'defect.ts'),
			);
		}
		const instruction = fs.readFileSync(
			resolveContainedExistingPath(
				args.options.packageRoot,
				args.task.instructionPath,
			),
			'utf8',
		);
		let caught = false;
		let cost: CostRecord = LOCAL_COST;
		let actualModel = args.model;

		if (args.gate === 'reviewer' || args.gate === 'test-engineer') {
			if (!args.options.dispatcher) {
				return errorCell({
					...args,
					startedAt,
					outcome: 'unsupported',
					failureCode: 'model-dispatcher-unavailable',
				});
			}
			const dispatch = await args.options.dispatcher({
				directory: tempRoot,
				agentName: args.gate === 'reviewer' ? 'reviewer' : 'test_engineer',
				modelId: args.model,
				preferredSwarm: args.options.manifest.preferredSwarm,
				prompt: modelPrompt(args.task, instruction, args.variant),
				timeoutMs: Math.min(args.options.manifest.maxTimeMs, 120_000),
				parentSessionId: args.options.parentSessionId,
				abortSignal: args.signal,
			});
			cost = { source: 'unavailable' };
			if (dispatch.status !== 'completed') {
				return errorCell({
					...args,
					startedAt,
					failureCode: `model-${dispatch.status}`,
					cost,
				});
			}
			actualModel = dispatch.modelId;
			try {
				caught = parseModelVerdict(dispatch.text).caught;
			} catch {
				return errorCell({
					...args,
					startedAt,
					failureCode: 'malformed-model-verdict',
					cost,
				});
			}
		} else if (args.gate === 'sast') {
			const result = await sastScan(
				{
					changed_files: ['defect.ts'],
					severity_threshold: 'low',
					offline_only: true,
				},
				tempRoot,
			);
			caught = result.verdict === 'fail' || result.findings.length > 0;
		} else if (args.gate === 'mutation') {
			const mutation = await runMutationGateAdapter({
				directory: tempRoot,
				mutationType: args.task.category,
				timeoutMs: args.options.manifest.maxTimeMs,
				variant: args.variant,
				abortSignal: args.signal,
			});
			if (mutation.outcome === 'infrastructure_failure') {
				return errorCell({
					...args,
					startedAt,
					failureCode: mutation.failureCode ?? 'mutation-error',
					cost,
				});
			}
			caught = mutation.outcome === 'caught';
		} else {
			const result = await qualityBudget(
				{
					changed_files: ['defect.ts'],
					config: {
						enforce_on_globs: ['**/*.ts'],
						exclude_globs: ['**/*.test.ts'],
					},
				},
				tempRoot,
			);
			caught = result.verdict === 'fail';
		}

		return {
			v: 1,
			taskId: args.task.id,
			candidateId: args.candidateId,
			defectType: args.task.category,
			gate: args.gate,
			model: actualModel,
			repetition: args.repetition,
			outcome:
				args.groundTruth === 'clean' && caught
					? 'false_rejection'
					: caught
						? 'caught'
						: 'missed',
			retries: 0,
			cost,
			durationMs: Date.now() - startedAt,
			failureClassification: cellFailureClassification(args.groundTruth),
		};
	} catch (error) {
		return errorCell({
			...args,
			startedAt,
			failureCode: `gate-error-${canonicalHash(String(error)).slice(0, 12)}`,
		});
	} finally {
		fs.rmSync(tempRoot, { recursive: true, force: true });
	}
}

async function runCellWithRetries(
	args: Parameters<typeof runCell>[0],
): Promise<GateAuditCellV1> {
	let cell: GateAuditCellV1 | undefined;
	for (
		let attempt = 0;
		attempt <= args.options.manifest.maxRetries;
		attempt++
	) {
		cell = await runCell(args);
		cell.retries = attempt;
		if (cell.outcome !== 'infrastructure_failure' || args.signal.aborted) {
			return cell;
		}
	}
	return cell!;
}

export async function runGateAudit(
	options: RunGateAuditOptions,
): Promise<GateAuditResultV1> {
	const manifest = GateAuditManifestV1Schema.parse(options.manifest);
	if (computeManifestContentHash(manifest) !== manifest.contentHash) {
		throw new Error('gate-audit manifest content hash is invalid');
	}
	const tasks = loadTier1EvaluationTasks(options.packageRoot).filter((task) =>
		manifest.taskIds.includes(task.id),
	);
	if (tasks.length !== manifest.taskIds.length) {
		throw new Error(
			'gate-audit manifest references unknown or duplicate tasks',
		);
	}
	for (const task of tasks) {
		await admitEvaluationTask(options.projectRoot, task, options.packageRoot);
	}
	const snapshotDraft = {
		v: 1 as const,
		id: `gate-audit-${manifest.id}`,
		split: 'train' as const,
		tasks,
		createdAt: new Date().toISOString(),
	};
	await saveTaskSetSnapshot(
		options.projectRoot,
		{
			...snapshotDraft,
			contentHash: computeTaskSetContentHash(snapshotDraft),
		},
		options.packageRoot,
	);

	const before = await _gateAuditInternals.captureWorkingTreeFingerprint(
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
	const timeout = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, manifest.maxTimeMs);
	try {
		const limit = pLimit(manifest.maxConcurrency);
		const groundTruthByTask = new Map(
			await Promise.all(
				tasks.map((task) =>
					limit(
						async () =>
							[
								task.id,
								await establishGateGroundTruth({
									packageRoot: options.packageRoot,
									task,
									timeoutMs: manifest.maxTimeMs,
									abortSignal: controller.signal,
								}),
							] as const,
					),
				),
			),
		);
		const work: Array<Promise<GateAuditCellV1>> = [];
		for (const task of tasks) {
			const taskTruth = groundTruthByTask.get(task.id)!.testImpact;
			for (const variant of CANDIDATE_VARIANTS) {
				for (const gate of manifest.gates) {
					for (const model of manifest.models) {
						for (
							let repetition = 0;
							repetition < manifest.repetitions;
							repetition++
						) {
							work.push(
								limit(() =>
									runCellWithRetries({
										options,
										task,
										candidateId: candidateId(task, variant),
										variant,
										groundTruth: taskTruth[variant].classification,
										gate,
										model,
										repetition,
										signal: controller.signal,
									}).then((cell) => {
										if (manifest.maxCostUsd !== undefined) {
											if (cell.cost.source === 'unavailable') {
												budgetInconclusive = true;
												controller.abort();
											} else {
												scheduledSpendUsd += cell.cost.usd ?? 0;
												if (scheduledSpendUsd > manifest.maxCostUsd) {
													budgetInconclusive = true;
													controller.abort();
												}
											}
										}
										return cell;
									}),
								),
							);
						}
					}
				}
			}
		}
		const cells = await Promise.all(work);
		const knownCosts = cells.filter(
			(cell) => cell.cost.source !== 'unavailable',
		);
		const hasUnavailableCost = knownCosts.length !== cells.length;
		const totalUsd = knownCosts.reduce(
			(sum, cell) => sum + (cell.cost.usd ?? 0),
			0,
		);
		const cost: CostRecord = hasUnavailableCost
			? { source: 'unavailable' }
			: { source: 'reported', usd: totalUsd };
		const incomplete = cells.some(
			(cell) =>
				cell.outcome === 'unsupported' ||
				cell.outcome === 'infrastructure_failure',
		);
		const overSpend =
			manifest.maxCostUsd !== undefined &&
			(hasUnavailableCost || totalUsd > manifest.maxCostUsd);
		const integrationGroundTruth: GateGroundTruthV1[] = cells.map((cell) => ({
			v: 1,
			runId: manifest.id,
			taskId: cell.taskId,
			candidateId: cell.candidateId!,
			model: cell.model,
			gate: cell.gate,
			repetition: cell.repetition,
			source: 'integration',
			classification: groundTruthByTask.get(cell.taskId)!.integration[
				cell.candidateId!.startsWith('clean-') ? 'clean' : 'defect'
			],
			observedAt: manifest.createdAt,
			confidence: 1,
		}));
		await saveGateGroundTruth(
			options.projectRoot,
			manifest.id,
			integrationGroundTruth,
		);
		await recordTestImpactGateGroundTruth(
			options.projectRoot,
			manifest.id,
			cells.map((cell) => {
				const truth = groundTruthByTask.get(cell.taskId)!.testImpact[
					cell.candidateId!.startsWith('clean-') ? 'clean' : 'defect'
				];
				return {
					runId: manifest.id,
					taskId: cell.taskId,
					candidateId: cell.candidateId!,
					model: cell.model,
					gate: cell.gate,
					repetition: cell.repetition,
					classification: truth.classification,
					observedAt: manifest.createdAt,
					confidence: truth.confidence,
				};
			}),
		);
		const result = GateAuditResultV1Schema.parse({
			v: 1,
			runId: manifest.id,
			manifestHash: manifest.contentHash,
			createdAt: new Date().toISOString(),
			status:
				externallyCancelled || timedOut
					? 'cancelled'
					: incomplete || overSpend || budgetInconclusive
						? 'inconclusive'
						: 'complete',
			cells,
			cost,
			qualityMetricAvailability: {
				complexity_delta: 'unavailable',
				public_api_delta: 'unavailable',
			},
		});
		await saveGateAuditResult(options.projectRoot, result);
		return result;
	} finally {
		clearTimeout(timeout);
		options.abortSignal?.removeEventListener('abort', externalAbort);
		const after = await _gateAuditInternals.captureWorkingTreeFingerprint(
			options.projectRoot,
		);
		if (
			before.head !== after.head ||
			before.porcelainHash !== after.porcelainHash
		) {
			// biome-ignore lint/correctness/noUnsafeFinally: active-tree integrity must override a seemingly successful audit.
			throw new Error('gate audit changed the active working tree');
		}
	}
}

export function createGateAuditManifest(
	input: Omit<GateAuditManifestV1, 'contentHash'>,
): GateAuditManifestV1 {
	const draft = { ...input, contentHash: '0'.repeat(64) };
	return GateAuditManifestV1Schema.parse({
		...draft,
		contentHash: computeManifestContentHash(draft),
	});
}

export function defaultGateAuditId(seed: string): string {
	return `audit-${crypto.createHash('sha256').update(seed).digest('hex').slice(0, 20)}`;
}

export const _gateAuditInternals = {
	captureWorkingTreeFingerprint,
};
