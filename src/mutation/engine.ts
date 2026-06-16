import { spawnSync } from 'node:child_process';

type SpawnSyncFn = typeof spawnSync;

import { unlinkSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

import {
	batchCheckEquivalence,
	type EquivalenceResult,
} from './equivalence.js';

export type MutationOutcome =
	| 'killed'
	| 'survived'
	| 'timeout'
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

export const _internals: {
	executeMutation: typeof executeMutation;
	computeReport: typeof computeReport;
	executeMutationSuite: typeof executeMutationSuite;
	spawnSync: SpawnSyncFn;
} = {
	executeMutation,
	computeReport,
	executeMutationSuite,
	spawnSync,
} as const;

export async function executeMutation(
	patch: MutationPatch,
	testCommand: string[],
	testFiles: string[],
	workingDir: string,
): Promise<MutationResult> {
	const startTime = Date.now();
	let outcome: MutationOutcome = 'survived';
	let testOutput: string | undefined;
	let error: string | undefined;
	let revertError: Error | undefined;
	let patchFile: string | undefined;

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
			const applyResult = _internals.spawnSync(
				'git',
				['apply', '--', patchFile],
				{
					cwd: workingDir,
					timeout: GIT_APPLY_TIMEOUT_MS,
					stdio: 'pipe',
				},
			);
			if (applyResult.error) {
				const code = (applyResult.error as NodeJS.ErrnoException).code;
				if (code === 'ENOENT') {
					throw new Error('git is not installed or not found in PATH');
				}
				throw new Error(`git command failed: ${applyResult.error.message}`);
			}
			if (applyResult.status !== 0) {
				throw new Error(
					`git apply failed with status ${applyResult.status}: ${applyResult.stderr?.toString() || ''}`,
				);
			}
		} catch (applyErr) {
			outcome = 'error';
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
			const spawnResult = _internals.spawnSync(testCommand[0], testArgs, {
				cwd: workingDir,
				timeout: MUTATION_TIMEOUT_MS,
				stdio: 'pipe',
			});
			if (spawnResult.error) {
				if ((spawnResult.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
					outcome = 'timeout';
					error = 'Test command timed out';
				} else {
					outcome = 'error';
					error = `Test command failed: ${spawnResult.error}`;
				}
			} else if (spawnResult.status !== 0) {
				outcome = 'killed';
				testOutput = spawnResult.stdout?.toString() || '';
			} else {
				testOutput = spawnResult.stdout?.toString();
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
				const revertResult = _internals.spawnSync(
					'git',
					['apply', '-R', '--', patchFile],
					{
						cwd: workingDir,
						timeout: GIT_APPLY_TIMEOUT_MS,
						stdio: 'pipe',
					},
				);
				if (revertResult.error) {
					const code = (revertResult.error as NodeJS.ErrnoException).code;
					if (code === 'ENOENT') {
						revertError = new Error(
							'git is not installed or not found in PATH',
						);
					} else {
						revertError = new Error(
							`git command failed: ${revertResult.error.message}`,
						);
					}
				} else if (revertResult.status !== 0) {
					revertError = new Error(
						`Failed to revert mutation ${patch.id}: git apply -R failed with status ${revertResult.status}: ${revertResult.stderr?.toString() || ''}. Working tree may be dirty.`,
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
		);
		results.push(result);

		if (onProgress) {
			onProgress(results.length, patches.length, result);
		}
	}

	return computeReport(results, Date.now() - startTime, effectiveBudget);
}
