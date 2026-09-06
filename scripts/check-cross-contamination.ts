import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRepoRoot, spawnUtf8 } from './gate-utils';

export interface PairSpec {
	fileA: string;
	fileB: string;
	minimumPasses: number;
	allowedOutcome: 'clean' | 'known_shared_process';
}

export interface PairRunResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export type PairEvaluationKind =
	| 'clean'
	| 'known_issue'
	| 'regression_pass_drop'
	| 'regression_unexpected_failure';

export interface PairEvaluation {
	kind: PairEvaluationKind;
	actualPasses: number;
	minimumPasses: number;
	messages: string[];
}

export interface AuditSummary {
	exitCode: number;
	knownIssue: boolean;
	regressionDetected: boolean;
	messages: string[];
	repoRoot: string;
}

export interface AuditOptions {
	runPair?: (
		repoRoot: string,
		pair: PairSpec,
	) => PairRunResult | Promise<PairRunResult>;
	log?: (line: string) => void;
}

export const PAIRS: readonly PairSpec[] = [
	{
		fileA: 'tests/unit/diff/ast-diff.test.ts',
		fileB: 'src/hooks/__tests__/semantic-diff-injection.test.ts',
		minimumPasses: 57,
		allowedOutcome: 'clean',
	},
	{
		fileA: 'tests/unit/hooks/knowledge-reader.test.ts',
		fileB: 'tests/unit/services/skill-generator.test.ts',
		minimumPasses: 71,
		allowedOutcome: 'known_shared_process',
	},
] as const;

export const PAIR_TIMEOUT_MS = 120_000;

export function readPassCount(output: string): number {
	const match = output.match(/^[ \t]*(\d+) pass/m);
	return match ? Number(match[1]) : 0;
}

export function lastLines(text: string, count: number): string {
	const lines = text.trimEnd().split(/\r?\n/);
	return lines.slice(Math.max(0, lines.length - count)).join('\n');
}

export function mergeProcessOutput(result: PairRunResult): string {
	const parts = [result.stdout, result.stderr].filter((chunk) => chunk.length > 0);
	return parts.join('\n');
}

export function buildPairCommand(
	execPath: string,
	pair: PairSpec,
	timeoutMs = PAIR_TIMEOUT_MS,
): string[] {
	return [
		execPath,
		'--smol',
		'test',
		pair.fileA,
		pair.fileB,
		'--timeout',
		String(timeoutMs),
	];
}

export function runPair(
	repoRoot: string,
	pair: PairSpec,
): Promise<PairRunResult> {
	return spawnUtf8(
		buildPairCommand(process.execPath, pair),
		repoRoot,
		PAIR_TIMEOUT_MS + 30_000,
	);
}

export function evaluatePairResult(
	pair: PairSpec,
	result: PairRunResult,
): PairEvaluation {
	const combinedOutput = mergeProcessOutput(result);
	const actualPasses = readPassCount(combinedOutput);
	if (result.exitCode === 0) {
		return {
			kind: 'clean',
			actualPasses,
			minimumPasses: pair.minimumPasses,
			messages: [],
		};
	}

	if (actualPasses < pair.minimumPasses) {
		return {
			kind: 'regression_pass_drop',
			actualPasses,
			minimumPasses: pair.minimumPasses,
			messages: [
				`::error title=Cross-contamination regression::Co-run of ${pair.fileA} + ${pair.fileB}: minimum ${pair.minimumPasses} pass, got ${actualPasses} pass. A new mock.module or vi.mock() leak was introduced.`,
				'',
				`Test pair: ${pair.fileA} + ${pair.fileB}`,
				`Minimum passes: ${pair.minimumPasses}`,
				`Actual passes (co-run): ${actualPasses}`,
				'',
				'Tail of output:',
				lastLines(combinedOutput, 20),
			],
		};
	}

	if (pair.allowedOutcome === 'known_shared_process') {
		return {
			kind: 'known_issue',
			actualPasses,
			minimumPasses: pair.minimumPasses,
			messages: [
				`::warning title=Cross-contamination known issue::Co-run of ${pair.fileA} + ${pair.fileB}: ${actualPasses} pass meets the minimum ${pair.minimumPasses}-pass floor but exits non-zero. Allowed known shared-process outcome: CI runs each discovered unit file in its own process (per-file CI isolation), so this pre-existing mock leak is non-blocking.`,
			],
		};
	}

	return {
		kind: 'regression_unexpected_failure',
		actualPasses,
		minimumPasses: pair.minimumPasses,
		messages: [
			`::error title=Cross-contamination regression::Co-run of ${pair.fileA} + ${pair.fileB} exited with code ${result.exitCode} despite ${actualPasses} >= ${pair.minimumPasses} minimum passes. Unexpected test failure or process error introduced.`,
			'',
			'Tail of output:',
			lastLines(combinedOutput, 20),
		],
	};
}

export async function auditCrossContamination(
	startDir: string = process.cwd(),
	options: AuditOptions = {},
): Promise<AuditSummary> {
	const repoRoot = await resolveRepoRoot(startDir);
	const runPairImpl = options.runPair ?? runPair;
	let regressionDetected = false;
	let knownIssue = false;
	const messages: string[] = [];

	for (const pair of PAIRS) {
		const evaluation = evaluatePairResult(
			pair,
			await runPairImpl(repoRoot, pair),
		);
		if (evaluation.kind === 'clean') {
			continue;
		}
		messages.push(...evaluation.messages);
		if (evaluation.kind === 'known_issue') {
			knownIssue = true;
			continue;
		}
		regressionDetected = true;
	}

	if (regressionDetected) {
		messages.push(
			'',
			'Cross-contamination REGRESSION detected. New mock leaks were introduced.',
			'These test files must be refactored before merging.',
		);
		return {
			exitCode: 1,
			knownIssue,
			regressionDetected,
			messages,
			repoRoot,
		};
	}

	if (knownIssue) {
		messages.push(
			'',
			'Known pre-existing cross-contamination present (non-blocking).',
			'This shared-process-only outcome remains guarded by the minimumPasses floor in this script.',
		);
		return {
			exitCode: 0,
			knownIssue,
			regressionDetected,
			messages,
			repoRoot,
		};
	}

	messages.push('No cross-contamination detected: all test pairs pass when co-run.');
	return {
		exitCode: 0,
		knownIssue,
		regressionDetected,
		messages,
		repoRoot,
	};
}

export async function main(
	startDir: string = process.cwd(),
	options: AuditOptions = {},
): Promise<number> {
	const summary = await auditCrossContamination(startDir, options);
	const log = options.log ?? console.log;
	for (const line of summary.messages) {
		log(line);
	}
	return summary.exitCode;
}

const isDirectRun =
	typeof process.argv[1] === 'string' &&
	path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
	void main(process.argv[2] ?? process.cwd())
		.then((exitCode) => {
			process.exit(exitCode);
		})
		.catch((error) => {
			throw error;
		});
}
