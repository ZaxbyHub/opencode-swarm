import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type {
	EvaluationCandidateV1,
	EvaluationRunV1,
	EvaluationTaskV1,
} from './contracts.js';
import {
	computeCandidateInputContentHash,
	computeTaskInputContentHash,
	sha256,
} from './hashing.js';
import type { EvaluationModelDispatcher } from './model-dispatcher.js';
import { createModelEvaluationExecutor, runEvaluation } from './runner.js';

export const PR_REVIEW_RECOVERY_BASE_SHA =
	'3811fe5981072c7fa541523e9f08430f18594590' as const;

const FIXTURE_ROOT = 'evaluation-fixtures/pr-review-recovery';
const BASELINE_MANIFEST_PATH = `${FIXTURE_ROOT}/baseline-manifest.json`;
const BASELINE_PAYLOAD_PATH = `${FIXTURE_ROOT}/baseline/SKILL.md`;
const CANDIDATE_PAYLOAD_PATH = '.opencode/skills/swarm-pr-review/SKILL.md';
const INSTRUCTION_PATH = `${FIXTURE_ROOT}/instruction.md`;
const ENVIRONMENT_PATH = `${FIXTURE_ROOT}/environment`;
const SCORER_PATH = `${ENVIRONMENT_PATH}/score-recovery.cjs`;

type RecoveryBudgets = {
	maxTasks: number;
	maxRepetitions: number;
	maxConcurrency: number;
	maxTaskTimeMs: number;
	maxRetries: number;
	maxOutputBytes: number;
	maxSpendUsd?: number;
};

export type EvaluatePrReviewRecoveryV1Options = {
	projectRoot: string;
	packageRoot?: string;
	dispatcher: EvaluationModelDispatcher;
	parentSessionId?: string;
	model?: string;
	seed?: string;
	baselineSourceSha?: string;
	budgets?: Partial<RecoveryBudgets>;
	abortSignal?: AbortSignal;
};

type BaselineManifest = {
	v: 1;
	sourceSha: string;
	payloadPath: string;
	sha256: string;
};

function parseBaselineManifest(value: unknown): BaselineManifest {
	if (
		value === null ||
		typeof value !== 'object' ||
		Array.isArray(value) ||
		Object.keys(value).sort().join('\0') !==
			['v', 'sourceSha', 'payloadPath', 'sha256'].sort().join('\0')
	) {
		throw new Error('PR-review recovery baseline manifest is invalid');
	}
	const manifest = value as Record<string, unknown>;
	if (
		manifest.v !== 1 ||
		typeof manifest.sourceSha !== 'string' ||
		typeof manifest.payloadPath !== 'string' ||
		typeof manifest.sha256 !== 'string'
	) {
		throw new Error('PR-review recovery baseline manifest is invalid');
	}
	return manifest as BaselineManifest;
}

async function candidate(
	packageRoot: string,
	input: Omit<EvaluationCandidateV1, 'contentHash'>,
): Promise<EvaluationCandidateV1> {
	return {
		...input,
		contentHash: await computeCandidateInputContentHash(packageRoot, input),
	};
}

async function task(packageRoot: string): Promise<EvaluationTaskV1> {
	const input: Omit<EvaluationTaskV1, 'contentHash'> = {
		v: 1,
		id: 'pr-review-controller-recovery',
		source: 'curated',
		split: 'train',
		category: 'pr-review-recovery',
		protected: true,
		instructionPath: INSTRUCTION_PATH,
		environment: { kind: 'fixture', path: ENVIRONMENT_PATH },
		scorer: {
			kind: 'project',
			argv: [SCORER_PATH],
			timeoutMs: 30_000,
			scoreRange: [0, 1],
		},
		provenance: {
			origin: 'https://github.com/ZaxbyHub/opencode-swarm/issues/2075',
			license: 'MIT',
		},
	};
	return {
		...input,
		contentHash: await computeTaskInputContentHash(packageRoot, input),
	};
}

async function verifyBaseline(
	packageRoot: string,
	requestedSourceSha: string,
): Promise<void> {
	if (requestedSourceSha !== PR_REVIEW_RECOVERY_BASE_SHA) {
		throw new Error(
			`PR-review recovery baseline source SHA must be ${PR_REVIEW_RECOVERY_BASE_SHA}`,
		);
	}
	const manifest = parseBaselineManifest(
		JSON.parse(
			await fs.readFile(path.join(packageRoot, BASELINE_MANIFEST_PATH), 'utf8'),
		),
	);
	if (
		manifest.sourceSha !== PR_REVIEW_RECOVERY_BASE_SHA ||
		manifest.payloadPath !== BASELINE_PAYLOAD_PATH
	) {
		throw new Error('PR-review recovery baseline source SHA is invalid');
	}
	const payload = await fs.readFile(
		path.join(packageRoot, manifest.payloadPath),
	);
	if (sha256(payload) !== manifest.sha256) {
		throw new Error('PR-review recovery baseline payload hash is invalid');
	}
}

/**
 * Runs the packaged issue-2075 recovery scenario against the exact canonical
 * PR-review skill and its content-addressed pre-hardening baseline.
 */
export async function evaluatePrReviewRecoveryV1(
	options: EvaluatePrReviewRecoveryV1Options,
): Promise<EvaluationRunV1> {
	const packageRoot = path.resolve(options.packageRoot ?? options.projectRoot);
	await verifyBaseline(
		packageRoot,
		options.baselineSourceSha ?? PR_REVIEW_RECOVERY_BASE_SHA,
	);
	const model = options.model ?? 'configured';
	const baseline = await candidate(packageRoot, {
		v: 1,
		id: 'pr-review-recovery-baseline',
		kind: 'baseline',
		payloadPath: BASELINE_PAYLOAD_PATH,
		model,
		agent: 'reviewer',
	});
	const current = await candidate(packageRoot, {
		v: 1,
		id: 'pr-review-recovery-candidate',
		kind: 'skill',
		payloadPath: CANDIDATE_PAYLOAD_PATH,
		model,
		agent: 'reviewer',
	});
	const budgets: RecoveryBudgets = {
		maxTasks: 1,
		maxRepetitions: 1,
		maxConcurrency: 1,
		maxTaskTimeMs: 60_000,
		maxRetries: 0,
		maxOutputBytes: 32 * 1024,
		...options.budgets,
	};
	return runEvaluation({
		projectRoot: options.projectRoot,
		inputRoot: packageRoot,
		tasks: [await task(packageRoot)],
		baseline,
		candidate: current,
		split: 'train',
		seed: options.seed ?? 'pr-review-recovery-v1',
		models: [model],
		budgets,
		executor: createModelEvaluationExecutor(
			options.dispatcher,
			options.parentSessionId,
		),
		abortSignal: options.abortSignal,
	});
}

export const _internals = {
	parseBaselineManifest,
	verifyBaseline,
};
