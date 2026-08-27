import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRepoRoot, spawnUtf8, walkFiles } from './gate-utils';

export interface PairSpec {
	fileA: string;
	fileB: string;
	expectedA: number;
	expectedB: number;
	knownExpected: number;
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
	expectedPasses: number;
	knownExpectedPasses: number;
	messages: string[];
}

export interface AuditSummary {
	exitCode: number;
	knownIssue: boolean;
	regressionDetected: boolean;
	coverageWarning: boolean;
	messages: string[];
	repoRoot: string;
}

export interface AuditOptions {
	runPair?: (
		repoRoot: string,
		pair: PairSpec,
	) => PairRunResult | Promise<PairRunResult>;
	collectWarnings?: (repoRoot: string) => string[];
	log?: (line: string) => void;
}

export const PAIRS: readonly PairSpec[] = [
	{
		fileA: 'tests/unit/diff/ast-diff.test.ts',
		fileB: 'src/hooks/__tests__/semantic-diff-injection.test.ts',
		expectedA: 41,
		expectedB: 16,
		knownExpected: 57,
	},
	{
		fileA: 'tests/unit/hooks/knowledge-reader.test.ts',
		fileB: 'tests/unit/services/skill-generator.test.ts',
		expectedA: 22,
		expectedB: 77,
		knownExpected: 71,
	},
] as const;

export const PAIR_TIMEOUT_MS = 120_000;
export const HOOKS_ROOT_REL = path.join('tests', 'unit', 'hooks');
export const HOOK_ISOLATION_BASENAMES = [
	'knowledge-injector.adversarial.test.ts',
	'knowledge-curator.test.ts',
	'knowledge-curator-evidence-curation.test.ts',
	'knowledge-curator-ttl.test.ts',
	'knowledge-curator.adversarial.test.ts',
	'knowledge-curator-output.test.ts',
	'full-auto-intercept.test.ts',
	'full-auto-intercept.adversarial.test.ts',
	'full-auto-intercept.dispatch.test.ts',
	'utils.test.ts',
	'knowledge-reader.test.ts',
	'system-enhancer-coder-context.test.ts',
	'model-limits-log-reclassification.test.ts',
	'model-limits-adversarial.test.ts',
	'log-level-reclassification.test.ts',
	'context-budget-log-reclassification.test.ts',
] as const;

export const HOOK_STEP_GLOBS = [
	'adversarial-detect*',
	'advisory*',
	'agent-activity*',
	'co-change*',
	'compaction*',
	'context-budget*',
	'context-scoring*',
	'curator*',
	'curator-*',
	'dark-matter*',
	'delegation*',
	'delegation-*',
	'destructive-command*',
	'extractors*',
	'full-auto-*',
	'gate-tracking*',
	'guardrails*',
	'hive*',
	'hook-composition*',
	'interpreter-gating*',
	'knowledge-application*',
	'knowledge-contextual-retrieval*',
	'knowledge-curator*',
	'knowledge-curator-*',
	'knowledge-events*',
	'knowledge-injector*',
	'knowledge-migrator*',
	'knowledge-quarantine*',
	'knowledge-reader*',
	'knowledge-registration*',
	'knowledge-schema-v2*',
	'knowledge-store*',
	'knowledge-types*',
	'knowledge-validator*',
	'message*',
	'mode-detection*',
	'model-limits*',
	'phase-complete*',
	'phase-monitor*',
	'pipeline*',
	'plan-cursor*',
	'repo-graph*',
	'review-receipt*',
	'search-knowledge*',
	'self-coding*',
	'skill-*',
	'spec-drift*',
	'steering*',
	'system-enhancer*',
	'system-enhancer-budget*',
	'system-enhancer-lean*',
	'system-enhancer-load-evidence*',
	'system-enhancer-v*',
	'system-message*',
	'telemetry*',
	'tool-summarizer*',
	'trajectory*',
	'utils*',
	'write-lstat*',
] as const;

function stripGlobSuffix(glob: string): string {
	return glob.endsWith('*') ? glob.slice(0, -1) : glob;
}

export function matchesHookStepGlob(basename: string): boolean {
	return HOOK_STEP_GLOBS.some((glob) => basename.startsWith(stripGlobSuffix(glob)));
}

export function isHookIsolationBasename(basename: string): boolean {
	return HOOK_ISOLATION_BASENAMES.includes(
		basename as (typeof HOOK_ISOLATION_BASENAMES)[number],
	);
}

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
	const expectedPasses = pair.expectedA + pair.expectedB;
	if (result.exitCode === 0) {
		return {
			kind: 'clean',
			actualPasses: expectedPasses,
			expectedPasses,
			knownExpectedPasses: pair.knownExpected,
			messages: [],
		};
	}

	const combinedOutput = mergeProcessOutput(result);
	const actualPasses = readPassCount(combinedOutput);
	if (actualPasses < pair.knownExpected) {
		return {
			kind: 'regression_pass_drop',
			actualPasses,
			expectedPasses,
			knownExpectedPasses: pair.knownExpected,
			messages: [
				`::error title=Cross-contamination regression::Co-run of ${pair.fileA} + ${pair.fileB}: expected ${expectedPasses} pass (${pair.expectedA}+${pair.expectedB}), got ${actualPasses} pass. Previously known baseline was ${pair.knownExpected}. A new mock.module or vi.mock() leak was introduced.`,
				'',
				`Test pair: ${pair.fileA} + ${pair.fileB}`,
				`Expected passes (individual): ${expectedPasses}`,
				`Known baseline (previous co-run): ${pair.knownExpected}`,
				`Actual passes (co-run): ${actualPasses}`,
				'',
				'Tail of output:',
				lastLines(combinedOutput, 20),
			],
		};
	}

	if (actualPasses < expectedPasses) {
		return {
			kind: 'known_issue',
			actualPasses,
			expectedPasses,
			knownExpectedPasses: pair.knownExpected,
			messages: [
				// Compatibility text is frozen to the pre-port Bash owner by issue #2094.
				`::warning title=Cross-contamination known issue::Co-run of ${pair.fileA} + ${pair.fileB}: expected ${expectedPasses} pass, got ${actualPasses} pass (known baseline: ${pair.knownExpected}). Pre-existing vi.mock() leak — tracked in scripts/check-cross-contamination.sh.`,
			],
		};
	}

	return {
		kind: 'regression_unexpected_failure',
		actualPasses,
		expectedPasses,
		knownExpectedPasses: pair.knownExpected,
		messages: [
			`::error title=Cross-contamination regression::Co-run of ${pair.fileA} + ${pair.fileB} exited with code ${result.exitCode} despite ${actualPasses} >= ${expectedPasses} expected passes. Unexpected test failure or process error introduced.`,
			'',
			'Tail of output:',
			lastLines(combinedOutput, 20),
		],
	};
}

export function toRepoRelativePath(repoRoot: string, absPath: string): string {
	const pathApi = /^[A-Za-z]:[\\/]/.test(repoRoot) ? path.win32 : path;
	return pathApi.relative(repoRoot, absPath).replaceAll('\\', '/');
}

export function walkHookTestFiles(
	hooksRoot: string,
	recursive: boolean,
): string[] {
	const files: string[] = [];
	walkFiles(
		hooksRoot,
		(absPath) => {
			if (absPath.endsWith('.test.ts')) {
				files.push(absPath);
			}
		},
		{ maxDepth: recursive ? Number.POSITIVE_INFINITY : 0 },
	);
	return files;
}

export function collectHookWarnings(repoRoot: string): string[] {
	const warnings: string[] = [];
	const hooksRoot = path.join(repoRoot, HOOKS_ROOT_REL);
	if (!fs.existsSync(hooksRoot)) {
		return warnings;
	}

	const mockModuleFiles: string[] = [];
	walkFiles(hooksRoot, (absPath) => {
		if (fs.readFileSync(absPath, 'utf-8').includes('mock.module(')) {
			mockModuleFiles.push(absPath);
		}
	});
	for (const absPath of mockModuleFiles) {
		const basename = path.basename(absPath);
		if (isHookIsolationBasename(basename)) {
			continue;
		}
		warnings.push(
			`::warning title=Mock module not in isolation list::${toRepoRelativePath(repoRoot, absPath)} uses mock.module() but is not in the CI isolation step file list. Add it to ci.yml isolation step or refactor to use _internals DI seam.`,
		);
	}

	for (const absPath of walkHookTestFiles(hooksRoot, false)) {
		const basename = path.basename(absPath);
		if (isHookIsolationBasename(basename) || matchesHookStepGlob(basename)) {
			continue;
		}
		warnings.push(
			`::notice title=Hook test file not in CI coverage::${toRepoRelativePath(repoRoot, absPath)} is not covered by any named CI step glob or the isolation list. Consider adding it to an appropriate CI step or the isolation list.`,
		);
	}

	return warnings;
}

export async function auditCrossContamination(
	startDir: string = process.cwd(),
	options: AuditOptions = {},
): Promise<AuditSummary> {
	const repoRoot = await resolveRepoRoot(startDir);
	const runPairImpl = options.runPair ?? runPair;
	const collectWarningsImpl = options.collectWarnings ?? collectHookWarnings;
	let regressionDetected = false;
	let knownIssue = false;
	let coverageWarning = false;
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

	const coverageWarnings = collectWarningsImpl(repoRoot);
	if (coverageWarnings.length > 0) {
		coverageWarning = true;
		messages.push(
			...coverageWarnings,
			'',
			'Audit checks completed with warnings (non-blocking).',
		);
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
			coverageWarning,
			messages,
			repoRoot,
		};
	}

	if (knownIssue) {
		messages.push(
			'',
			'Known pre-existing cross-contamination present (non-blocking).',
			'Expected passes when fixed: update known_expected in this script.',
		);
		return {
			exitCode: 0,
			knownIssue,
			regressionDetected,
			coverageWarning,
			messages,
			repoRoot,
		};
	}

	messages.push('No cross-contamination detected: all test pairs pass when co-run.');
	return {
		exitCode: 0,
		knownIssue,
		regressionDetected,
		coverageWarning,
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
