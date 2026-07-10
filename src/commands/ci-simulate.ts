/**
 * Handle /swarm ci-simulate command.
 *
 * Simulates CI by merging a PR branch into a temporary worktree created from
 * the detected default remote branch (origin/main, origin/master, etc.), then
 * running the full validation suite:
 *   bun run typecheck
 *   bun run lint
 *   bun run build
 *   bun test
 *
 * This reproduces the merge-group CI environment locally, catching integration
 * failures (pass on PR branch, fail on merged result) before they cause
 * merge-queue kick-outs.
 *
 * Input contract:
 *   /swarm ci-simulate              → uses current HEAD branch
 *   /swarm ci-simulate <pr-ref>     → uses the specified branch/ref
 */

import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { getDefaultBaseBranch } from '../git/branch.js';
import {
	type ExternalToolRunResult,
	runExternalTool,
} from '../utils/external-tool-runner.js';

/** Default timeout for git operations (30 seconds). */
const GIT_TIMEOUT_MS = 30_000;

/** Default timeout for validation commands (5 minutes). */
const VALIDATION_TIMEOUT_MS = 5 * 60 * 1000;
const OUTPUT_LIMIT_BYTES = 12_000;

export const _internals: {
	runExternalTool: typeof runExternalTool;
	getDefaultBaseBranch: typeof getDefaultBaseBranch;
	platform: string;
	osTmpdir: () => string;
	fs: {
		existsSync: typeof fs.existsSync;
		rmSync: typeof fs.rmSync;
	};
} = {
	runExternalTool,
	getDefaultBaseBranch,
	platform: process.platform,
	osTmpdir: () => os.tmpdir(),
	fs: {
		existsSync: fs.existsSync,
		rmSync: fs.rmSync,
	},
};

interface GitResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	outputTruncated: boolean;
}

interface StepResult {
	step: string;
	command: string;
	exitCode: number;
	stdout: string;
	stderr: string;
	durationMs: number;
	outputTruncated: boolean;
}

interface CiSimulateResult {
	success: boolean;
	worktreePath: string;
	steps: StepResult[];
	error?: string;
}

/**
 * Runs a bounded git command and returns its captured result.
 */
async function runGit(
	args: string[],
	cwd: string,
	timeoutMs = GIT_TIMEOUT_MS,
): Promise<GitResult> {
	const result: ExternalToolRunResult = await _internals.runExternalTool({
		executable: 'git',
		args,
		cwd,
		timeoutMs,
		maxStdoutBytes: OUTPUT_LIMIT_BYTES,
		maxStderrBytes: OUTPUT_LIMIT_BYTES,
	});
	return {
		exitCode: result.exitCode ?? 1,
		stdout: result.message
			? [result.message, result.stdout].filter(Boolean).join('\n')
			: result.stdout,
		stderr: result.stderr,
		outputTruncated: result.stdoutTruncated || result.stderrTruncated,
	};
}

/**
 * Runs a bounded validation command and returns the result.
 */
async function runValidationCommand(
	cmd: string[],
	cwd: string,
	timeoutMs = VALIDATION_TIMEOUT_MS,
): Promise<GitResult> {
	const [executable, ...args] = cmd;
	const result: ExternalToolRunResult = await _internals.runExternalTool({
		executable,
		args,
		cwd,
		timeoutMs,
		maxStdoutBytes: OUTPUT_LIMIT_BYTES,
		maxStderrBytes: OUTPUT_LIMIT_BYTES,
	});
	return {
		exitCode: result.exitCode ?? 1,
		stdout: result.message
			? [result.message, result.stdout].filter(Boolean).join('\n')
			: result.stdout,
		stderr: result.stderr,
		outputTruncated: result.stdoutTruncated || result.stderrTruncated,
	};
}

function isSafeGitRef(ref: string): boolean {
	return (
		ref.length > 0 &&
		ref.length <= 255 &&
		/^[A-Za-z0-9][A-Za-z0-9._/@-]*$/.test(ref) &&
		!ref.includes('..') &&
		!ref.includes('//') &&
		!ref.includes('@{') &&
		!ref.endsWith('.')
	);
}

/**
 * Gets the current branch name (or HEAD if detached).
 */
async function getCurrentBranchOrRef(directory: string): Promise<string> {
	const result = await runGit(['branch', '--show-current'], directory);
	if (result.exitCode === 0 && result.stdout.trim()) {
		return result.stdout.trim();
	}
	// Detached HEAD — use the commit hash
	const hashResult = await runGit(['rev-parse', 'HEAD'], directory);
	return hashResult.stdout.trim();
}

/**
 * Creates a temporary worktree from the detected default remote branch (detached) and merges the PR ref into it.
 *
 * Returns the worktree path on success, or throws on failure.
 */
async function setupWorktree(
	projectRoot: string,
	prRef: string,
	baseBranch: string,
	onWorktreeCreated: (worktreePath: string) => void,
): Promise<string> {
	const worktreeBase = path.join(_internals.osTmpdir(), 'swarm-ci-simulate');
	const worktreeName = `pr-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
	const worktreePath = path.join(worktreeBase, worktreeName);

	// Ensure the base directory exists
	await fsPromises.mkdir(worktreeBase, { recursive: true });

	// Create a detached worktree from the detected default branch
	const addResult = await runGit(
		['worktree', 'add', '--detach', worktreePath, baseBranch],
		projectRoot,
	);
	if (addResult.exitCode !== 0) {
		throw new Error(
			`Failed to create worktree: ${addResult.stderr.trim() || addResult.stdout.trim()}`,
		);
	}
	onWorktreeCreated(worktreePath);

	// Merge the PR branch into the worktree
	const mergeResult = await runGit(
		['merge', '--no-ff', '--no-edit', '--', prRef],
		worktreePath,
		GIT_TIMEOUT_MS * 2, // Merge can be slow for large histories
	);

	// Capture merge failure for reporting
	if (mergeResult.exitCode !== 0) {
		// Throw to signal merge failure - the error will be caught and reported
		// but finally{} will still run to clean up the worktree
		throw new Error(
			`Merge failed for '${prRef}': ${mergeResult.stderr.trim() || mergeResult.stdout.trim()}`,
		);
	}

	return worktreePath;
}

/**
 * Removes the temporary worktree and its directory.
 */
async function cleanupWorktree(
	worktreePath: string,
	projectRoot: string,
): Promise<void> {
	// Try git worktree remove first
	const removeResult = await runGit(
		['worktree', 'remove', '--force', worktreePath],
		projectRoot,
	);

	// Always clean up the directory itself
	try {
		if (_internals.fs.existsSync(worktreePath)) {
			_internals.fs.rmSync(worktreePath, { recursive: true, force: true });
		}
	} catch {
		// Best-effort cleanup
	}

	// If git worktree remove failed, log a warning but don't throw
	if (removeResult.exitCode !== 0) {
		console.warn(
			`[ci-simulate] git worktree remove failed: ${removeResult.stderr.trim() || removeResult.stdout.trim()}`,
		);
	}
}

/**
 * Runs the validation suite in the worktree.
 */
async function runValidationSuite(worktreePath: string): Promise<StepResult[]> {
	const steps: StepResult[] = [];
	const commands = [
		{ step: 'typecheck', cmd: ['bun', 'run', 'typecheck'] },
		{ step: 'lint', cmd: ['bun', 'run', 'lint'] },
		{ step: 'build', cmd: ['bun', 'run', 'build'] },
		{ step: 'test', cmd: ['bun', 'test'] },
	];

	for (const { step, cmd } of commands) {
		const start = Date.now();
		const result = await runValidationCommand(cmd, worktreePath);
		const durationMs = Date.now() - start;

		steps.push({
			step,
			command: cmd.join(' '),
			exitCode: result.exitCode,
			stdout: result.stdout,
			stderr: result.stderr,
			durationMs,
			outputTruncated: result.outputTruncated,
		});
	}

	return steps;
}

/**
 * Formats step output for display, truncating if needed.
 */
function formatStepOutput(
	stdout: string,
	stderr: string,
	outputTruncated: boolean,
	maxLength = 2000,
): string {
	let output = stdout;
	if (stderr) {
		output += output ? `\n${stderr}` : stderr;
	}
	if (output.length > maxLength) {
		output = `${output.slice(0, maxLength)}\n... (output truncated)`;
	}
	if (outputTruncated) {
		output = `${output}\n... (child output truncated to bounded limit)`;
	}
	return output;
}

/**
 * Parses common failure patterns to extract file:line references.
 */
function extractFileLineReferences(output: string): string[] {
	const lines: string[] = [];
	const patterns = [
		// TypeScript/ESLint style: file.ts:line:col
		/([A-Za-z]:[\\/])?[^\s:]+\.(ts|tsx|js|jsx):(\d+):(\d+)/g,
		// Error with path:line format
		/(?:error|Error|FAIL|Failed)[:\s]+([^\s]+\.(ts|tsx|js|jsx)?:?:\d+)/gi,
		// Test failures often show: FAIL src/foo.test.ts
		/FAIL\s+([^\s]+\.(test|spec)\.(ts|tsx|js|jsx))/gi,
	];

	for (const pattern of patterns) {
		const matches = Array.from(output.matchAll(pattern));
		for (const match of matches) {
			if (match[0]) {
				lines.push(match[0]);
			}
		}
	}

	// Deduplicate
	return Array.from(new Set(lines));
}

/**
 * Handle /swarm ci-simulate command.
 *
 * @param directory - Project root (absolute path to the git working tree).
 * @param args - Command arguments; first positional is the PR ref (optional).
 * @returns Human-readable report string.
 */
export async function handleCiSimulateCommand(
	directory: string,
	args: string[],
): Promise<string> {
	// Parse PR ref from args (first positional argument)
	const prRef = args[0] ?? (await getCurrentBranchOrRef(directory));
	if (!isSafeGitRef(prRef)) {
		return 'CI simulation failed: PR ref must be a safe git branch or commit reference.';
	}

	const lines: string[] = [];
	lines.push(`# CI Simulation Report`);
	lines.push('');
	lines.push(`PR ref: **${prRef}**`);
	lines.push(`Started: ${new Date().toISOString()}`);
	lines.push('');

	let worktreePath: string | undefined;
	const result: CiSimulateResult = {
		success: false,
		worktreePath: '',
		steps: [],
	};

	try {
		// Detect the default remote branch (handles origin/main, origin/master, etc.)
		const baseBranch = _internals.getDefaultBaseBranch(directory);
		if (!isSafeGitRef(baseBranch)) {
			throw new Error('Detected default branch is not a safe git reference.');
		}

		// Step 1: Create worktree and merge
		lines.push('## Setup');
		lines.push('');
		lines.push(`Creating temporary worktree from ${baseBranch}...`);

		worktreePath = await setupWorktree(
			directory,
			prRef,
			baseBranch,
			(createdPath) => {
				worktreePath = createdPath;
			},
		);
		result.worktreePath = worktreePath;
		lines.push(`Worktree: \`${worktreePath}\``);
		lines.push('');

		// Verify merge succeeded
		const mergeCheckResult = await runGit(
			['log', '--oneline', '-1', '--format=%s'],
			worktreePath,
		);
		const lastCommit = mergeCheckResult.stdout.trim();
		lines.push(`Last commit in worktree: \`${lastCommit}\``);
		lines.push('');

		// Step 2: Run validation suite
		lines.push('## Validation Suite');
		lines.push('');

		result.steps = await runValidationSuite(worktreePath);

		for (const step of result.steps) {
			const status = step.exitCode === 0 ? '✅ PASS' : '❌ FAIL';
			lines.push(`### ${status}: ${step.step}`);
			lines.push('');
			lines.push(`Command: \`${step.command}\``);
			lines.push(`Duration: ${(step.durationMs / 1000).toFixed(1)}s`);
			if (step.exitCode !== 0) {
				lines.push(`Exit code: ${step.exitCode}`);
				const fileRefs = extractFileLineReferences(
					`${step.stdout}\n${step.stderr}`,
				);
				if (fileRefs.length > 0) {
					lines.push('');
					lines.push('**Failure locations:**');
					for (const ref of fileRefs.slice(0, 20)) {
						lines.push(`  - \`${ref}\``);
					}
				}
				lines.push('');
				lines.push('**Output:**');
				lines.push('```');
				lines.push(
					formatStepOutput(step.stdout, step.stderr, step.outputTruncated),
				);
				lines.push('```');
			}
			lines.push('');
		}

		// Determine overall success
		const allPassed = result.steps.every((s) => s.exitCode === 0);
		result.success = allPassed;

		// Summary
		lines.push('## Summary');
		lines.push('');
		const passed = result.steps.filter((s) => s.exitCode === 0).length;
		const failed = result.steps.filter((s) => s.exitCode !== 0).length;
		lines.push(
			`Validation: ${passed}/${result.steps.length} steps passed, ${failed} failed`,
		);
		lines.push('');
		if (allPassed) {
			lines.push('✅ **All checks passed — CI simulation succeeded**');
		} else {
			lines.push(
				`❌ **CI simulation failed — these failures would cause a merge-queue kick-out**`,
			);
			lines.push('');
			lines.push('To reproduce locally, run in the worktree:');
			lines.push(`\`\`\`bash`);
			lines.push(`cd "${worktreePath}"`);
			for (const step of result.steps.filter((s) => s.exitCode !== 0)) {
				lines.push(`# ${step.step}: ${step.command}`);
			}
			lines.push(`\`\`\``);
		}
	} catch (err) {
		const errMsg = err instanceof Error ? err.message : String(err);
		result.error = errMsg;
		lines.push('');
		lines.push('## Error');
		lines.push('');
		lines.push(`\`\`\``);
		lines.push(errMsg);
		lines.push(`\`\`\``);
	} finally {
		// Cleanup
		if (worktreePath) {
			lines.push('');
			lines.push('---');
			lines.push('');
			lines.push('*Cleaning up temporary worktree...*');
			await cleanupWorktree(worktreePath, directory);
			lines.push(`Worktree removed: \`${worktreePath}\``);
		}
	}

	return lines.join('\n');
}
