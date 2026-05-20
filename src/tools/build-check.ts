/**
 * Build Check Tool
 *
 * Discovers and runs build commands for various ecosystems in a project directory.
 */

import type { tool } from '@opencode-ai/plugin';
import { z } from 'zod';
import { type BuildCommand, discoverBuildCommands } from '../build/discovery';
import type { BuildEvidence, EvidenceVerdict } from '../config/evidence-schema';
import { saveEvidence } from '../evidence/manager';
import { bunSpawn } from '../utils/bun-compat';
import { createSwarmTool } from './create-tool';

// ============ Constants ============

export const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes
export const MAX_OUTPUT_BYTES = 10 * 1024; // 10KB
export const MAX_OUTPUT_LINES = 100;

// ============ Types ============

export interface BuildCheckInput {
	/** Scope: 'changed' or 'all' */
	scope: 'changed' | 'all';
	/** List of changed files when scope is 'changed' */
	changed_files?: string[];
	/** Mode: 'build', 'typecheck', or 'both' (default: 'both') */
	mode?: 'build' | 'typecheck' | 'both';
}

export interface BuildRun {
	kind: 'build' | 'typecheck' | 'test';
	command: string;
	cwd: string;
	exit_code: number;
	duration_ms: number;
	stdout_tail: string;
	stderr_tail: string;
}

export interface BuildCheckResult {
	verdict: EvidenceVerdict;
	runs: BuildRun[];
	summary: {
		files_scanned: number;
		runs_count: number;
		failed_count: number;
		skipped_reason?: string;
	};
}

// ============ Helper Functions ============

/**
 * Truncate output to last maxLines lines, but not more than maxBytes
 */
export function truncateOutput(
	output: string,
	maxLines = MAX_OUTPUT_LINES,
	maxBytes = MAX_OUTPUT_BYTES,
): string {
	if (!output) {
		return '';
	}

	// First, truncate by bytes
	let truncated = output;
	if (truncated.length > maxBytes) {
		truncated = truncated.slice(-maxBytes);
	}

	// Then truncate by lines
	const lines = truncated.split('\n');
	if (lines.length > maxLines) {
		return lines.slice(-maxLines).join('\n');
	}

	return truncated;
}

/**
 * Parse command to determine its kind
 */
export function getCommandKind(
	command: string,
): 'build' | 'typecheck' | 'test' {
	const lower = command.toLowerCase();

	// Typecheck commands
	if (
		lower.includes('typecheck') ||
		lower.includes('check') ||
		lower.includes('analyze') ||
		lower.includes('lint')
	) {
		return 'typecheck';
	}

	// Test commands
	if (
		lower.includes('test') ||
		lower.includes('spec') ||
		lower.includes('jest') ||
		lower.includes('vitest') ||
		lower.includes('mocha') ||
		lower.includes('pytest')
	) {
		return 'test';
	}

	// Default to build
	return 'build';
}

/**
 * Filter commands by mode
 */
function filterByMode(
	commands: BuildCommand[],
	mode: 'build' | 'typecheck' | 'both',
): BuildCommand[] {
	if (mode === 'both') {
		return commands;
	}

	return commands.filter((cmd) => getCommandKind(cmd.command) === mode);
}

/**
 * Execute a single build command
 */
async function executeCommand(command: BuildCommand): Promise<BuildRun> {
	const startTime = Date.now();
	const kind = getCommandKind(command.command);

	const isWindows = process.platform === 'win32';

	// Parse command for spawn
	let cmd: string[];
	let args: string[];

	if (isWindows && !command.command.includes(' ')) {
		// Single word command like 'make'
		cmd = [command.command];
		args = [];
	} else if (isWindows) {
		// Use cmd.exe on Windows
		cmd = ['cmd', '/c', command.command];
		args = [];
	} else {
		// Use shell -c on Unix
		cmd = ['/bin/sh'];
		args = ['-c', command.command];
	}

	const result = bunSpawn([...cmd, ...args], {
		cwd: command.cwd,
		stdout: 'pipe',
		stderr: 'pipe',
		timeout: DEFAULT_TIMEOUT_MS,
	});

	// Read streams concurrently with process exit to avoid pipe deadlock.
	// Previous code awaited exit implicitly then read streams — if output
	// exceeded the OS pipe buffer (~64KB), the child blocked on write and
	// the process never exited.
	const [exitCode, stdout, stderr] = await Promise.all([
		result.exited,
		result.stdout.text(),
		result.stderr.text(),
	]);

	const duration_ms = Date.now() - startTime;

	return {
		kind,
		command: command.command,
		cwd: command.cwd,
		exit_code: exitCode ?? -1,
		duration_ms,
		stdout_tail: truncateOutput(stdout),
		stderr_tail: truncateOutput(stderr),
	};
}

// ============ Main Implementation ============

/**
 * Run build check: discover and execute build commands
 */
export async function runBuildCheck(
	workingDir: string,
	input: BuildCheckInput,
): Promise<BuildCheckResult> {
	const scope = input.scope ?? 'all';
	const mode = input.mode ?? 'both';
	const changedFiles = input.changed_files ?? [];

	// Discover build commands
	const discoveryResult = await discoverBuildCommands(workingDir, {
		scope,
		changedFiles,
	});

	// Filter by mode
	const commands = filterByMode(discoveryResult.commands, mode);

	// Execute commands
	const runs: BuildRun[] = [];
	let failedCount = 0;

	for (const cmd of commands) {
		try {
			const run = await executeCommand(cmd);
			runs.push(run);
			if (run.exit_code !== 0) {
				failedCount++;
			}
		} catch (error) {
			// Handle timeout or execution errors
			runs.push({
				kind: getCommandKind(cmd.command),
				command: cmd.command,
				cwd: cmd.cwd,
				exit_code: -1,
				duration_ms: 0,
				stdout_tail: '',
				stderr_tail: error instanceof Error ? error.message : 'Unknown error',
			});
			failedCount++;
		}
	}

	// Determine verdict
	let verdict: EvidenceVerdict;
	let skipped_reason: string | undefined;

	if (runs.length === 0) {
		verdict = 'info';
		// Generate skipped reason
		if (discoveryResult.skipped.length > 0) {
			skipped_reason = discoveryResult.skipped
				.map((s) => `${s.ecosystem}: ${s.reason}`)
				.join('; ');
		} else {
			skipped_reason = 'No build commands discovered (no toolchains found)';
		}
	} else if (failedCount > 0) {
		verdict = 'fail';
	} else {
		verdict = 'pass';
	}

	return {
		verdict,
		runs,
		summary: {
			files_scanned: changedFiles.length,
			runs_count: runs.length,
			failed_count: failedCount,
			skipped_reason,
		},
	};
}

// ============ Tool Definition ============

export const build_check: ReturnType<typeof tool> = createSwarmTool({
	description:
		'Discover and run build commands for various ecosystems in a project directory. Supports build, typecheck, and test commands.',
	args: {
		scope: z
			.enum(['changed', 'all'])
			.describe(
				'Scope of detection: "all" for all build files, "changed" for only changed files',
			),
		changed_files: z
			.array(z.string())
			.optional()
			.describe('List of changed files when scope is "changed"'),
		mode: z
			.enum(['build', 'typecheck', 'both'])
			.optional()
			.describe(
				'Mode: "build" for build commands, "typecheck" for type checking, "both" for all (default: both)',
			),
	},
	async execute(args: unknown, directory: string): Promise<string> {
		// Cast args
		const obj = args as BuildCheckInput;
		const scope = obj.scope ?? 'all';
		const changedFiles = obj.changed_files ?? [];
		const mode = obj.mode ?? 'both';

		// Get directory from createSwarmTool
		const workingDir = directory;

		// Run build check
		const result = await runBuildCheck(workingDir, {
			scope,
			changed_files: changedFiles,
			mode,
		});

		// Build evidence
		const evidence: BuildEvidence = {
			task_id: 'build',
			type: 'build',
			timestamp: new Date().toISOString(),
			agent: 'build_check',
			verdict: result.verdict,
			summary: `${result.runs.length} build command(s) executed, ${result.summary.failed_count} failed`,
			runs: result.runs,
			files_scanned: result.summary.files_scanned,
			runs_count: result.summary.runs_count,
			failed_count: result.summary.failed_count,
			skipped_reason: result.summary.skipped_reason,
		};

		// Save evidence
		try {
			await saveEvidence(workingDir, 'build', evidence);
		} catch (error) {
			console.error(
				'Failed to save build evidence:',
				error instanceof Error ? error.message : String(error),
			);
		}

		// Return as JSON
		return JSON.stringify(result, null, 2);
	},
});
