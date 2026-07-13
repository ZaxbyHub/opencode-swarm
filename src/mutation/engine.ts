import { spawnSync } from 'node:child_process';
import { unlinkSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

import {
	resolveExecutableFromPath,
	runExternalTool,
} from '../utils/external-tool-runner.js';

import {
	batchCheckEquivalence,
	type EquivalenceResult,
} from './equivalence.js';

export type MutationOutcome =
	| 'killed'
	| 'survived'
	| 'timeout'
	| 'cancelled'
	| 'error'
	| 'equivalent'
	| 'skipped';

/**
 * Known test runner executables permitted as the first element of testCommand.
 * Validated as the basename (without extension) to support platform-specific
 * variants like `bun.exe` on Windows or full paths like `/usr/local/bin/jest`.
 */
export const ALLOWED_TEST_RUNNERS = new Set([
	'bun',
	'bunx',
	'node',
	'npx',
	'npm',
	'yarn',
	'pnpm',
	'vitest',
	'jest',
	'mocha',
	'jasmine',
	'ava',
	'tap',
	'pytest',
	'python',
	'python3',
	'cargo',
	'go',
	'deno',
	'ruby',
	'rspec',
	'php',
	'phpunit',
	'gradle',
	'gradlew',
	'mvn',
	'dotnet',
	'swift',
]);

/**
 * Validate that testCommand[0] is a known test runner.
 * Returns an error string if invalid, or null if valid.
 */
export function validateTestCommand(testCommand: string[]): string | null {
	if (!testCommand || testCommand.length === 0) {
		return 'testCommand must not be empty';
	}
	const exe = testCommand[0];
	// Extract basename and strip any platform-specific extension (.exe, .cmd)
	const base = path.basename(exe).replace(/\.(exe|cmd|bat)$/i, '');
	if (!ALLOWED_TEST_RUNNERS.has(base)) {
		return `testCommand executable '${exe}' is not in the allowed test runner list. Permitted runners: ${[...ALLOWED_TEST_RUNNERS].join(', ')}`;
	}
	return null;
}

export interface MutationPatch {
	id: string;
	filePath: string;
	functionName: string;
	mutationType: string;
	patch: string;
	lineNumber?: number;
}

export interface MutationResult {
	patchId: string;
	filePath: string;
	functionName: string;
	mutationType: string;
	outcome: MutationOutcome;
	testOutput?: string;
	durationMs: number;
	error?: string;
}

export interface MutationReport {
	totalMutants: number;
	killed: number;
	survived: number;
	timeout: number;
	cancelled: number;
	equivalent: number;
	skipped: number;
	errors: number;
	killRate: number;
	adjustedKillRate: number;
	perFunction: Map<
		string,
		{
			killed: number;
			survived: number;
			total: number;
			equivalent: number;
			skipped: number;
			killRate: number;
		}
	>;
	results: MutationResult[];
	durationMs: number;
	budgetMs: number;
	budgetExceeded: boolean;
	timestamp: string;
}

export const MAX_MUTATIONS_PER_FUNCTION = 10;
const MUTATION_TIMEOUT_MS = 30_000;
const TOTAL_BUDGET_MS = 300_000;
const GIT_APPLY_TIMEOUT_MS = 5_000;
const MAX_MUTATION_OUTPUT_BYTES = 1024 * 1024;

type LegacySpawnSyncFn = typeof spawnSync;

export type MutationCommandResult = {
	status: 'completed' | 'timeout' | 'cancelled' | 'spawn-error';
	exitCode: number | null;
	stdout: string;
	stderr: string;
	message?: string;
};

export type MutationCommandRunner = (args: {
	executable: string;
	args: string[];
	cwd: string;
	timeoutMs: number;
	abortSignal?: AbortSignal;
}) => Promise<MutationCommandResult>;

export type MutationExecutionOptions = {
	abortSignal?: AbortSignal;
	runner?: MutationCommandRunner;
};

const defaultLegacySpawnSync = spawnSync;

function formatSpawnError(
	executable: string,
	error: NodeJS.ErrnoException,
): string {
	if (error.code === 'ENOENT') {
		return `${executable} is not installed or not found in PATH`;
	}
	return `${executable} command failed: ${error.message}`;
}

function isMissingExecutableFailure(message: string | undefined): boolean {
	if (!message) return false;
	return (
		/\bENOENT\b/i.test(message) ||
		/\bexecutable\b[^\r\n]*\bnot found\b/i.test(message) ||
		/\bnot found in (?:the )?\$?PATH\b/i.test(message)
	);
}

export const runMutationCommand: MutationCommandRunner = async (args) => {
	const resolvedExecutable = _internals.resolveExecutableFromPath([
		args.executable,
	]);
	const result = await _internals.runExternalTool({
		executable: resolvedExecutable ?? args.executable,
		args: args.args,
		cwd: args.cwd,
		timeoutMs: args.timeoutMs,
		maxStdoutBytes: MAX_MUTATION_OUTPUT_BYTES,
		maxStderrBytes: MAX_MUTATION_OUTPUT_BYTES,
		abortSignal: args.abortSignal,
	});
	if (
		resolvedExecutable === null &&
		args.executable === 'git' &&
		result.status === 'spawn-error' &&
		isMissingExecutableFailure(result.message)
	) {
		return {
			...result,
			message: 'git is not installed or not found in PATH',
		};
	}
	return result;
};

const runLegacyTestSeam: MutationCommandRunner = async (args) => {
	try {
		const result = _internals.spawnSync(args.executable, args.args, {
			cwd: args.cwd,
			timeout: args.timeoutMs,
			stdio: 'pipe',
		});
		if (result.error) {
			const code = (result.error as NodeJS.ErrnoException).code;
			return {
				status: code === 'ETIMEDOUT' ? 'timeout' : 'spawn-error',
				exitCode: result.status,
				stdout: result.stdout?.toString() ?? '',
				stderr: result.stderr?.toString() ?? '',
				message: formatSpawnError(
					args.executable,
					result.error as NodeJS.ErrnoException,
				),
			};
		}
		return {
			status: 'completed',
			exitCode: result.status,
			stdout: result.stdout?.toString() ?? '',
			stderr: result.stderr?.toString() ?? '',
		};
	} catch (error) {
		return {
			status: 'spawn-error',
			exitCode: null,
			stdout: '',
			stderr: '',
			message: error instanceof Error ? error.message : String(error),
		};
	}
};

function selectRunner(
	options: MutationExecutionOptions,
): MutationCommandRunner {
	if (options.runner) return options.runner;
	// Compatibility for existing DI-based unit tests only. The production seam
	// is never replaced and therefore always selects the bounded async runner.
	if (_internals.spawnSync !== defaultLegacySpawnSync) return runLegacyTestSeam;
	return _internals.runCommand;
}

export const _internals: {
	executeMutation: typeof executeMutation;
	computeReport: typeof computeReport;
	executeMutationSuite: typeof executeMutationSuite;
	spawnSync: LegacySpawnSyncFn;
	runCommand: MutationCommandRunner;
	runExternalTool: typeof runExternalTool;
	resolveExecutableFromPath: typeof resolveExecutableFromPath;
} = {
	executeMutation,
	computeReport,
	executeMutationSuite,
	spawnSync: defaultLegacySpawnSync,
	runCommand: runMutationCommand,
	runExternalTool,
	resolveExecutableFromPath,
} as const;

export async function executeMutation(
	patch: MutationPatch,
	testCommand: string[],
	testFiles: string[],
	workingDir: string,
	options: MutationExecutionOptions = {},
): Promise<MutationResult> {
	const startTime = Date.now();
	let outcome: MutationOutcome = 'survived';
	let testOutput: string | undefined;
	let error: string | undefined;
	let revertError: Error | undefined;
	let patchFile: string | undefined;
	const runner = selectRunner(options);

	try {
		const safeId = patch.id.replace(/[^a-zA-Z0-9_-]/g, '_');
		patchFile = path.join(workingDir, `.mutation_patch_${safeId}.diff`);
		try {
			writeFileSync(patchFile, patch.patch);
		} catch (writeErr) {
			error = `Failed to write patch file: ${writeErr}`;
			outcome = 'error';
			return {
				patchId: patch.id,
				filePath: patch.filePath,
				functionName: patch.functionName,
				mutationType: patch.mutationType,
				outcome,
				durationMs: Date.now() - startTime,
				error,
			};
		}

		try {
			const applyResult = await runner({
				executable: 'git',
				args: ['apply', '--', patchFile],
				cwd: workingDir,
				timeoutMs: GIT_APPLY_TIMEOUT_MS,
				abortSignal: options.abortSignal,
			});
			if (applyResult.status === 'cancelled') {
				outcome = 'cancelled';
				throw new Error('Mutation cancelled while applying patch');
			}
			if (applyResult.status !== 'completed') {
				throw new Error(
					applyResult.message ?? `git apply ${applyResult.status}`,
				);
			}
			if (applyResult.exitCode !== 0) {
				throw new Error(
					`git apply failed with status ${applyResult.exitCode}: ${applyResult.stderr}`,
				);
			}
		} catch (applyErr) {
			if (outcome !== 'cancelled') outcome = 'error';
			return {
				patchId: patch.id,
				filePath: patch.filePath,
				functionName: patch.functionName,
				mutationType: patch.mutationType,
				outcome,
				durationMs: Date.now() - startTime,
				error: `Git apply failed: ${applyErr}`,
			};
		}

		let testPassed = false;
		try {
			// Append specific test files when provided for scoped test execution.
			// Filter out any entries that look like flags (start with '-') to prevent
			// test file paths from being misinterpreted as command-line options.
			const safeTestFiles = testFiles.filter((f) => !f.startsWith('-'));
			const testArgs =
				safeTestFiles.length > 0
					? [...testCommand.slice(1), ...safeTestFiles]
					: testCommand.slice(1);
			const spawnResult = await runner({
				executable: testCommand[0],
				args: testArgs,
				cwd: workingDir,
				timeoutMs: MUTATION_TIMEOUT_MS,
				abortSignal: options.abortSignal,
			});
			if (spawnResult.status !== 'completed') {
				if (spawnResult.status === 'timeout') {
					outcome = 'timeout';
					error = 'Test command timed out';
				} else if (spawnResult.status === 'cancelled') {
					outcome = 'cancelled';
					error = 'Test command cancelled';
				} else {
					outcome = 'error';
					error = `Test command failed: ${spawnResult.message ?? spawnResult.status}`;
				}
			} else if (spawnResult.exitCode !== 0) {
				outcome = 'killed';
				testOutput = spawnResult.stdout;
			} else {
				testOutput = spawnResult.stdout;
				testPassed = true;
			}
		} catch (execErr: unknown) {
			error = `Unexpected error: ${execErr}`;
			outcome = 'error';
		}

		if (testPassed) {
			outcome = 'survived';
		}
	} catch (testError: unknown) {
		error = `Unexpected error: ${testError}`;
		outcome = 'error';
	} finally {
		if (patchFile) {
			try {
				const revertResult = await runner({
					executable: 'git',
					args: ['apply', '-R', '--', patchFile],
					cwd: workingDir,
					timeoutMs: GIT_APPLY_TIMEOUT_MS,
				});
				if (revertResult.status !== 'completed') {
					revertError = new Error(
						`git revert failed: ${revertResult.message ?? revertResult.status}`,
					);
				} else if (revertResult.exitCode !== 0) {
					revertError = new Error(
						`Failed to revert mutation ${patch.id}: git apply -R failed with status ${revertResult.exitCode}: ${revertResult.stderr}. Working tree may be dirty.`,
					);
				}
			} catch (revertErr) {
				revertError = new Error(
					`Failed to revert mutation ${patch.id}: ${revertErr}. Working tree may be dirty.`,
				);
			}
			try {
				unlinkSync(patchFile);
			} catch (_unlinkErr) {
				// best effort cleanup
			}
		}
	}
	return {
		patchId: patch.id,
		filePath: patch.filePath,
		functionName: patch.functionName,
		mutationType: patch.mutationType,
		outcome: revertError && outcome !== 'error' ? 'error' : outcome,
		testOutput,
		durationMs: Date.now() - startTime,
		error: revertError
			? error
				? `${error}; ${revertError.message}`
				: revertError.message
			: error,
	};
}

export function computeReport(
	results: MutationResult[],
	durationMs: number,
	budgetMs?: number,
): MutationReport {
	const total = results.length;
	let killed = 0;
	let survived = 0;
	let timeout = 0;
	let cancelled = 0;
	let equivalent = 0;
	let skipped = 0;
	let errors = 0;

	for (const result of results) {
		switch (result.outcome) {
			case 'killed':
				killed++;
				break;
			case 'survived':
				survived++;
				break;
			case 'timeout':
				timeout++;
				break;
			case 'cancelled':
				cancelled++;
				break;
			case 'equivalent':
				equivalent++;
				break;
			case 'skipped':
				skipped++;
				break;
			case 'error':
				errors++;
				break;
		}
	}

	const denominator = total - equivalent - skipped;
	const killRate = denominator > 0 ? killed / denominator : 0;
	const adjustedDenominator = total - equivalent - skipped;
	const adjustedKillRate =
		adjustedDenominator > 0 ? killed / adjustedDenominator : 0;

	const perFunction = new Map<
		string,
		{
			killed: number;
			survived: number;
			total: number;
			equivalent: number;
			skipped: number;
			killRate: number;
		}
	>();
	for (const result of results) {
		const key = `${result.filePath}:${result.functionName}`;
		if (!perFunction.has(key)) {
			perFunction.set(key, {
				killed: 0,
				survived: 0,
				total: 0,
				equivalent: 0,
				skipped: 0,
				killRate: 0,
			});
		}
		const entry = perFunction.get(key)!;
		entry.total++;
		if (result.outcome === 'killed') {
			entry.killed++;
		} else if (result.outcome === 'survived') {
			entry.survived++;
		} else if (result.outcome === 'equivalent') {
			entry.equivalent++;
		} else if (result.outcome === 'skipped') {
			entry.skipped++;
		}
	}

	for (const [_key, entry] of perFunction) {
		const fnDenom = entry.total - entry.equivalent - entry.skipped;
		entry.killRate = fnDenom > 0 ? entry.killed / fnDenom : 0;
	}

	const effectiveBudget = budgetMs ?? TOTAL_BUDGET_MS;

	return {
		totalMutants: total,
		killed,
		survived,
		timeout,
		cancelled,
		equivalent,
		skipped,
		errors,
		killRate,
		adjustedKillRate,
		perFunction,
		results,
		durationMs,
		budgetMs: effectiveBudget,
		budgetExceeded: durationMs > effectiveBudget,
		timestamp: new Date().toISOString(),
	};
}

export async function executeMutationSuite(
	patches: MutationPatch[],
	testCommand: string[],
	testFiles: string[],
	workingDir: string,
	budgetMs?: number,
	onProgress?: (
		completed: number,
		total: number,
		result: MutationResult,
	) => void,
	sourceFiles?: Map<string, string>,
	options: MutationExecutionOptions = {},
): Promise<MutationReport> {
	const startTime = Date.now();
	const effectiveBudget = budgetMs ?? TOTAL_BUDGET_MS;

	// Validate testCommand[0] against the known-runner allowlist before executing
	// any mutations. This prevents arbitrary binaries from being invoked even when
	// args are sanitised (array-form spawn does not expand shell metacharacters but
	// an attacker controlling tool arguments could still run unexpected programs).
	const cmdError = validateTestCommand(testCommand);
	if (cmdError) {
		return computeReport([], 0, effectiveBudget);
	}

	const results: MutationResult[] = [];
	let _skippedCount = 0;

	// Phase 1: Check equivalence before execution loop
	const equivalenceMap = new Map<string, EquivalenceResult>();

	if (sourceFiles && sourceFiles.size > 0) {
		const eqInput: Array<{
			patch: MutationPatch;
			originalCode: string;
			mutatedCode: string;
		}> = [];
		for (const patch of patches) {
			const originalCode = sourceFiles.get(patch.filePath);
			if (originalCode) {
				// Extract mutated code from unified diff: take + lines, excluding +++ header
				const mutatedLines: string[] = [];
				for (const line of patch.patch.split('\n')) {
					if (line.startsWith('+++')) continue;
					if (line.startsWith('+')) {
						mutatedLines.push(line.substring(1));
					} else if (
						!line.startsWith('-') &&
						!line.startsWith('@') &&
						!line.startsWith('diff ') &&
						!line.startsWith('index ') &&
						!line.startsWith('---')
					) {
						mutatedLines.push(line);
					}
				}
				const mutatedCode = mutatedLines.join('\n');
				eqInput.push({ patch, originalCode, mutatedCode });
			}
		}
		if (eqInput.length > 0) {
			const eqResults = await batchCheckEquivalence(eqInput);
			for (const eqResult of eqResults) {
				equivalenceMap.set(eqResult.patchId, eqResult);
			}
		}
	}

	// Phase 2: Execution loop
	for (let i = 0; i < patches.length; i++) {
		if (options.abortSignal?.aborted) {
			for (const patch of patches.slice(i)) {
				results.push({
					patchId: patch.id,
					filePath: patch.filePath,
					functionName: patch.functionName,
					mutationType: patch.mutationType,
					outcome: 'cancelled',
					durationMs: 0,
					error: 'Mutation suite cancelled before scheduling',
				});
			}
			break;
		}
		const elapsed = Date.now() - startTime;
		if (elapsed > effectiveBudget) {
			const remaining = patches.slice(i);
			for (const patch of remaining) {
				results.push({
					patchId: patch.id,
					filePath: patch.filePath,
					functionName: patch.functionName,
					mutationType: patch.mutationType,
					outcome: 'skipped',
					durationMs: 0,
				});
				_skippedCount++;
			}
			break;
		}

		// Check if this mutant was identified as equivalent
		const eqResult = equivalenceMap.get(patches[i].id);
		if (eqResult?.isEquivalent) {
			const eqMutantResult: MutationResult = {
				patchId: patches[i].id,
				filePath: patches[i].filePath,
				functionName: patches[i].functionName,
				mutationType: patches[i].mutationType,
				outcome: 'equivalent',
				durationMs: 0,
			};
			results.push(eqMutantResult);
			if (onProgress) {
				onProgress(results.length, patches.length, eqMutantResult);
			}
			continue;
		}

		const result = await executeMutation(
			patches[i],
			testCommand,
			testFiles,
			workingDir,
			options,
		);
		results.push(result);

		if (onProgress) {
			onProgress(results.length, patches.length, result);
		}
	}

	return computeReport(results, Date.now() - startTime, effectiveBudget);
}
