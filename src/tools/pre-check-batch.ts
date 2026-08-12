/**
 * Pre-Check Batch Tool
 * Runs 4 verification tools in parallel: lint, secretscan, sast-scan, quality-budget
 * Returns unified result with gates_passed status
 */

import * as path from 'node:path';
import type { tool } from '@opencode-ai/plugin';
import pLimit from 'p-limit';
import { z } from 'zod';
import type { PluginConfig } from '../config';
import type { SecretscanEvidence } from '../config/evidence-schema.js';
import { saveEvidence } from '../evidence/manager.js';
import { warn } from '../utils';
import { runExternalTool } from '../utils/external-tool-runner';
import { createSwarmTool } from './create-tool';
import type {
	LintResult,
	LintSuccessResult,
	ResolvedLinterCommand,
} from './lint';
import { detectResolvedLinter, _internals as lintInternals } from './lint';
import type { QualityBudgetResult } from './quality-budget';
import { qualityBudget } from './quality-budget';
import type { SastScanFinding, SastScanResult } from './sast-scan';
import { sastScan } from './sast-scan';
import type { SecretscanErrorResult, SecretscanResult } from './secretscan';
import { runSecretscan, runSecretscanOnFiles } from './secretscan';

// ============ Constants ============
const TOOL_TIMEOUT_MS = 60_000;
const MAX_COMBINED_BYTES = 500_000; // 500KB
const MAX_COMPACT_ERROR_BYTES = 4_096;
const OUTPUT_OMITTED_MESSAGE =
	'Detailed tool result omitted because the batch output exceeded its byte limit';
const MAX_CONCURRENT = 4;
const MAX_FILES = 100;
const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_OUTPUT_BYTES = 2_000_000;
const ALL_LINES_CHANGED = -1;
const MAX_CHANGED_LINE_ENTRIES = 200_000;

export const _internals: {
	qualityBudget: typeof qualityBudget;
	runLintWrapped: typeof runLintWrapped;
	runSecretscanWrapped: typeof runSecretscanWrapped;
	runSastScanWrapped: typeof runSastScanWrapped;
	runQualityBudgetWrapped: typeof runQualityBudgetWrapped;
	runWithTimeout: typeof runWithTimeout;
	getChangedLineRanges: typeof getChangedLineRanges;
	saveEvidence: typeof saveEvidence;
	runExternalTool: typeof runExternalTool;
	detectResolvedLinter: typeof detectResolvedLinter;
	runLintOnFiles: typeof runLintOnFiles;
	platform: () => NodeJS.Platform;
	serializePreCheckResult: typeof serializePreCheckResult;
	MAX_COMBINED_BYTES: number;
} = {
	qualityBudget,
	runLintWrapped,
	runSecretscanWrapped,
	runSastScanWrapped,
	runQualityBudgetWrapped,
	runWithTimeout,
	getChangedLineRanges,
	saveEvidence,
	runExternalTool,
	detectResolvedLinter,
	runLintOnFiles,
	platform: () => process.platform,
	serializePreCheckResult,
	MAX_COMBINED_BYTES,
};

// ============ Input/Output Types ============
export interface PreCheckBatchInput {
	/** List of specific files to check (optional) */
	files?: string[];
	/** Directory to scan */
	directory: string;
	/** SAST severity threshold (default: medium) */
	sast_threshold?: 'low' | 'medium' | 'high' | 'critical';
	/** Optional plugin config */
	config?: PluginConfig;
	/**
	 * Current phase number (positive integer >= 1).
	 * When provided, enables SAST baseline diffing: only findings absent from the
	 * phase-scoped baseline (.swarm/evidence/{phase}/sast-baseline.json) drive the
	 * fail verdict. Capture the baseline before first coder delegation via sast_scan
	 * with capture_baseline:true.
	 */
	phase?: number;
}

export interface ToolResult<T> {
	/** Whether the tool was executed */
	ran: boolean;
	/** Tool result if successful */
	result?: T;
	/** Error message if failed */
	error?: string;
	/** Duration in milliseconds */
	duration_ms: number;
}

interface SecretscanGateDecision {
	passed: boolean;
	summary: string;
	result?: SecretscanResult;
	findingsCount: number;
}

function formatIncompletePaths(
	incompletePaths: Array<{ path: string; reason: string }>,
	maxEntries = 3,
): string {
	const visible = incompletePaths.slice(0, maxEntries).map((entry) => {
		return `${entry.path} (${entry.reason})`;
	});
	const suffix =
		incompletePaths.length > maxEntries
			? ` (+${incompletePaths.length - maxEntries} more)`
			: '';
	return `${visible.join('; ')}${suffix}`;
}

function evaluateSecretscanGate(
	toolResult: ToolResult<SecretscanResult | SecretscanErrorResult>,
	requestedFiles: number,
): SecretscanGateDecision {
	if (toolResult.error) {
		return {
			passed: false,
			summary: `Secretscan wrapper error: ${toolResult.error}`,
			findingsCount: 0,
		};
	}
	if (!toolResult.ran || !toolResult.result) {
		return {
			passed: false,
			summary: 'Secretscan did not return a result',
			findingsCount: 0,
		};
	}
	if ('error' in toolResult.result) {
		return {
			passed: false,
			summary: `Secretscan error: ${toolResult.result.error}`,
			findingsCount: 0,
		};
	}

	const result = toolResult.result;
	if (
		typeof result.incomplete_files !== 'number' ||
		!Array.isArray(result.incomplete_paths)
	) {
		return {
			passed: false,
			summary:
				'Secretscan failed: scanner returned incomplete coverage metadata',
			result,
			findingsCount: Math.max(result.count, result.findings.length),
		};
	}
	const findingsCount = Math.max(result.count, result.findings.length);
	const failures: string[] = [];
	if (findingsCount > 0) failures.push(`${findingsCount} secret finding(s)`);
	if (result.incomplete_files > 0 || result.incomplete_paths.length > 0) {
		const incompletePaths =
			result.incomplete_paths.length > 0
				? `; incomplete paths: ${formatIncompletePaths(result.incomplete_paths)}`
				: '';
		failures.push(
			`${result.incomplete_files} incomplete file(s)${incompletePaths}`,
		);
	}
	if (result.count !== result.findings.length) {
		failures.push(
			`findings/count mismatch (reported ${result.count}, actual ${result.findings.length})`,
		);
	}
	if (requestedFiles > 0 && result.files_scanned === 0) {
		failures.push('zero requested files scanned');
	}

	const statistics = `Secretscan: ${findingsCount} finding(s), ${result.files_scanned} files scanned, ${result.skipped_files} skipped`;
	return {
		passed: failures.length === 0,
		summary:
			failures.length > 0
				? `${statistics}; failed: ${failures.join('; ')}`
				: statistics,
		result,
		findingsCount,
	};
}

export interface PreCheckBatchResult {
	/** Structured producer status. Optional only for legacy serialized results. */
	batch_status?: 'completed' | 'skipped' | 'invalid';
	/** Overall gate status: true if all security gates pass */
	gates_passed: boolean;
	/** Lint tool result */
	lint: ToolResult<LintResult>;
	/** Secretscan tool result */
	secretscan: ToolResult<SecretscanResult | SecretscanErrorResult>;
	/** SAST scan tool result */
	sast_scan: ToolResult<SastScanResult>;
	/** Quality budget tool result */
	quality_budget: ToolResult<QualityBudgetResult>;
	/** Total duration in milliseconds */
	total_duration_ms: number;
	/** Pre-existing SAST findings on unchanged lines, requiring reviewer triage */
	sast_preexisting_findings?: SastScanFinding[];
}

function truncateUtf8(value: string, maxBytes: number): string {
	if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
	const marker = '... (truncated)';
	const budget = Math.max(0, maxBytes - Buffer.byteLength(marker, 'utf8'));
	let result = '';
	let usedBytes = 0;
	for (const character of value) {
		const characterBytes = Buffer.byteLength(character, 'utf8');
		if (usedBytes + characterBytes > budget) break;
		result += character;
		usedBytes += characterBytes;
	}
	return `${result}${marker}`;
}

function compactToolResult(toolResult: ToolResult<unknown>) {
	const diagnostic =
		toolResult.error ??
		(toolResult.result !== undefined ? OUTPUT_OMITTED_MESSAGE : undefined);
	return {
		ran: toolResult.ran,
		duration_ms: toolResult.duration_ms,
		...(diagnostic !== undefined && {
			error: truncateUtf8(diagnostic, MAX_COMPACT_ERROR_BYTES),
		}),
	};
}

/**
 * Serialize the public result below the decoder's stricter byte ceiling. When
 * detailed diagnostics exceed the aggregate budget, preserve every control
 * field and replace optional payloads with bounded, UTF-8-safe summaries.
 */
function serializePreCheckResult(result: PreCheckBatchResult): string {
	const serialized = JSON.stringify(result, null, 2);
	if (Buffer.byteLength(serialized, 'utf8') <= MAX_COMBINED_BYTES) {
		return serialized;
	}

	const compact = {
		batch_status: result.batch_status,
		gates_passed: result.gates_passed,
		lint: compactToolResult(result.lint),
		secretscan: compactToolResult(result.secretscan),
		sast_scan: compactToolResult(result.sast_scan),
		quality_budget: compactToolResult(result.quality_budget),
		total_duration_ms: result.total_duration_ms,
		output_truncated: true,
	};
	return JSON.stringify(compact, null, 2);
}

// ============ Security Validation ============

/**
 * Check if path is a Windows absolute path with drive letter (e.g., C:\ or C:/)
 * Node's path.isAbsolute() doesn't detect Windows paths correctly on POSIX systems
 */
function isWindowsAbsolutePath(inputPath: string): boolean {
	// Match drive letter paths: A: through Z: (case-insensitive) followed by :\ or :/
	return /^[A-Za-z]:[/\\]/.test(inputPath);
}

/**
 * Validate path to prevent traversal attacks
 * @param inputPath - The path to validate (can be relative or absolute)
 * @param baseDir - The base directory to resolve relative paths against
 * @param workspaceDir - The workspace root directory for absolute path validation
 */
function validatePath(
	inputPath: unknown,
	baseDir: string,
	workspaceDir: string,
): string | null {
	// Strict type guard - reject non-string inputs fail-closed before any path operations
	if (typeof inputPath !== 'string') {
		return 'path must be a string';
	}

	if (!inputPath || inputPath.trim().length === 0) {
		return 'path is required';
	}

	let resolved: string;
	const isWinAbs = isWindowsAbsolutePath(inputPath);

	// Handle absolute paths - use Windows path module for Windows absolute paths,
	// POSIX path module otherwise
	if (isWinAbs) {
		// For Windows absolute paths, resolve using win32 semantics
		resolved = path.win32.resolve(inputPath);
	} else if (path.isAbsolute(inputPath)) {
		resolved = path.resolve(inputPath);
	} else {
		resolved = path.resolve(baseDir, inputPath);
	}

	const workspaceResolved = isWindowsAbsolutePath(workspaceDir)
		? path.win32.resolve(workspaceDir)
		: path.resolve(workspaceDir);

	// CRITICAL: Do NOT allow path == workspace anchor as valid bypass
	// This prevents attackers from using the workspace directory itself as their validation anchor
	// Always enforce traversal check against the TRUE workspace boundary
	// The resolved path must be within workspace, not equal to it (except for the specific base dir case below)

	// Ensure the resolved path is within workspace directory
	// Use win32 relative for Windows paths to handle cross-platform correctly
	let relative: string;
	if (isWinAbs) {
		relative = path.win32.relative(workspaceResolved, resolved);
	} else {
		relative = path.relative(workspaceResolved, resolved);
	}

	// Path traversal: starts with '..' means going up from workspace
	if (relative.startsWith('..')) {
		return 'path traversal detected';
	}

	return null;
}

/**
 * Validate the directory input
 * @param dir - The directory to validate
 * @param workspaceDir - The workspace root directory
 */
function validateDirectory(dir: string, workspaceDir: string): string | null {
	if (!dir || dir.length === 0) {
		return 'directory is required';
	}

	if (dir.length > 500) {
		return 'directory path too long';
	}

	// Validate directory against the TRUE workspace boundary
	// CRITICAL: Use workspaceDir as both base and boundary - NOT the input dir itself
	// This prevents bypassing validation by treating input directory as its own anchor
	const traversalCheck = validatePath(dir, workspaceDir, workspaceDir);
	if (traversalCheck) {
		return traversalCheck;
	}

	const platform = _internals.platform();
	const resolveForComparison =
		platform === 'win32' ? path.win32.resolve : path.resolve;
	const directoryKey = resolveForComparison(dir).replace(/\\/g, '/');
	const workspaceKey = resolveForComparison(workspaceDir).replace(/\\/g, '/');
	if (
		(platform === 'win32' ? directoryKey.toLowerCase() : directoryKey) !==
		(platform === 'win32' ? workspaceKey.toLowerCase() : workspaceKey)
	) {
		return 'directory must resolve to the project root';
	}

	return null;
}

// ============ Timeout Helper ============

/**
 * Run a function with timeout
 */
async function runWithTimeout<T>(
	operation: (abortSignal: AbortSignal) => Promise<T>,
	timeoutMs: number,
	parentSignal?: AbortSignal,
	waitForCancellationSettlement = false,
): Promise<T> {
	const controller = new AbortController();
	let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
	let parentAbortListener: (() => void) | undefined;
	if (parentSignal?.aborted) throw new Error('Tool execution cancelled');
	const parentAbortPromise = new Promise<never>((_, reject) => {
		if (!parentSignal) return;
		parentAbortListener = () => {
			reject(new Error('Tool execution cancelled'));
			controller.abort();
		};
		parentSignal.addEventListener('abort', parentAbortListener, { once: true });
		if (parentSignal.aborted) parentAbortListener();
	});
	if (controller.signal.aborted) return await parentAbortPromise;
	const operationPromise = operation(controller.signal);
	try {
		const timeoutPromise = new Promise<never>((_, reject) => {
			timeoutHandle = setTimeout(() => {
				reject(new Error(`Timeout after ${timeoutMs}ms`));
				controller.abort();
			}, timeoutMs);
		});
		return await Promise.race([
			operationPromise,
			timeoutPromise,
			parentAbortPromise,
		]);
	} catch (error) {
		if (controller.signal.aborted && waitForCancellationSettlement) {
			await operationPromise.then(
				() => undefined,
				() => undefined,
			);
		}
		throw error;
	} finally {
		if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
		if (parentAbortListener && parentSignal) {
			parentSignal.removeEventListener('abort', parentAbortListener);
		}
	}
}

// ============ Wrapper Functions ============

/**
 * Run lint with detection and timeout
 */
async function runLintWrapped(
	files: string[] | undefined,
	directory: string,
	_config?: PluginConfig,
	abortSignal?: AbortSignal,
): Promise<ToolResult<LintResult>> {
	const start = process.hrtime.bigint();

	try {
		const resolvedLinter = await _internals.detectResolvedLinter(
			directory,
			abortSignal,
		);

		if (!resolvedLinter) {
			return {
				ran: false,
				error: 'No linter found (biome or eslint)',
				duration_ms: Number(process.hrtime.bigint() - start) / 1_000_000,
			};
		}

		// If files are provided, run lint on those specific files only
		if (files && files.length > 0) {
			const filteredResult = await _internals.runLintOnFiles(
				resolvedLinter,
				files,
				directory,
				abortSignal,
			);
			return {
				ran: true,
				result: filteredResult,
				duration_ms: Number(process.hrtime.bigint() - start) / 1_000_000,
			};
		}

		// No files provided - run lint on entire directory (current behavior)
		const result = await lintInternals.runResolvedLint(
			resolvedLinter,
			'check',
			directory,
			abortSignal,
		);

		return {
			ran: true,
			result,
			duration_ms: Number(process.hrtime.bigint() - start) / 1_000_000,
		};
	} catch (error) {
		return {
			ran: true,
			error: error instanceof Error ? error.message : 'Unknown error',
			duration_ms: Number(process.hrtime.bigint() - start) / 1_000_000,
		};
	}
}

/**
 * Run lint on specific files only
 */
async function runLintOnFiles(
	resolvedLinter: ResolvedLinterCommand,
	files: string[],
	workspaceDir: string,
	abortSignal?: AbortSignal,
): Promise<LintResult> {
	if (resolvedLinter.source === 'legacy-test-probe') {
		return lintInternals.runResolvedLint(
			resolvedLinter,
			'check',
			workspaceDir,
			abortSignal,
		);
	}
	// Security: Validate all resolved file paths before use
	const validatedFiles: string[] = [];
	for (const file of files) {
		// Hardened: Explicit type guard for non-string entries fail-closed
		if (typeof file !== 'string') {
			continue;
		}
		// Resolve the path first
		const resolvedPath = path.resolve(file);
		// Validate the resolved path against workspace
		const validationError = validatePath(
			resolvedPath,
			workspaceDir,
			workspaceDir,
		);
		if (validationError) {
			// Skip invalid files - fail closed
			continue;
		}
		validatedFiles.push(resolvedPath);
	}

	// Fail closed if no valid files after validation
	if (validatedFiles.length === 0) {
		return {
			success: false,
			mode: 'check',
			linter: resolvedLinter.linter,
			command: [],
			error: 'No valid files after security validation',
		};
	}

	// Resolve binary using the same hierarchy as detectAvailableLinter
	// (local → ancestor → PATH) so detection and execution are consistent.
	let args: string[];
	if (resolvedLinter.linter === 'biome') {
		args = [...resolvedLinter.argsPrefix, 'check', ...validatedFiles];
	} else {
		args = [...resolvedLinter.argsPrefix, ...validatedFiles];
	}
	const command = [...resolvedLinter.displayPrefix, ...args];

	try {
		const execution = await _internals.runExternalTool({
			executable: resolvedLinter.executable,
			args,
			cwd: workspaceDir,
			timeoutMs: TOOL_TIMEOUT_MS,
			maxStdoutBytes: 512_000,
			maxStderrBytes: 512_000,
			abortSignal,
		});
		if (execution.status !== 'completed') {
			return {
				success: false,
				mode: 'check',
				linter: resolvedLinter.linter,
				command,
				error: execution.message ?? `Execution ${execution.status}`,
			};
		}
		const exitCode = execution.exitCode ?? 1;
		let output = execution.stdout;
		if (execution.stderr) {
			output += (output ? '\n' : '') + execution.stderr;
		}
		if (execution.stdoutTruncated || execution.stderrTruncated) {
			output += '\n... (output truncated)';
		}

		const result: LintSuccessResult = {
			success: true,
			mode: 'check',
			linter: resolvedLinter.linter,
			command,
			exitCode,
			output,
		};

		if (exitCode === 0) {
			result.message = `${resolvedLinter.linter} check completed successfully with no issues`;
		} else {
			result.message = `${resolvedLinter.linter} check found issues (exit code ${exitCode}).`;
		}

		return result;
	} catch (error) {
		return {
			success: false,
			mode: 'check',
			linter: resolvedLinter.linter,
			command,
			error:
				error instanceof Error
					? `Execution failed: ${error.message}`
					: 'Execution failed: unknown error',
		};
	}
}

/**
 * Run secretscan with timeout
 */
async function runSecretscanWrapped(
	files: string[] | undefined,
	directory: string,
	_config?: PluginConfig,
	abortSignal?: AbortSignal,
): Promise<ToolResult<SecretscanResult | SecretscanErrorResult>> {
	const start = process.hrtime.bigint();

	try {
		// If files are provided, run secretscan with explicit file scope
		if (files && files.length > 0) {
			const result = await runWithTimeout(
				() => runSecretscanOnFiles(files, directory),
				TOOL_TIMEOUT_MS,
				abortSignal,
			);
			return {
				ran: true,
				result,
				duration_ms: Number(process.hrtime.bigint() - start) / 1_000_000,
			};
		}

		// No files provided - scan entire directory (current behavior)
		const result = await runWithTimeout(
			() => runSecretscan(directory),
			TOOL_TIMEOUT_MS,
			abortSignal,
		);

		return {
			ran: true,
			result,
			duration_ms: Number(process.hrtime.bigint() - start) / 1_000_000,
		};
	} catch (error) {
		return {
			ran: true,
			error: error instanceof Error ? error.message : 'Unknown error',
			duration_ms: Number(process.hrtime.bigint() - start) / 1_000_000,
		};
	}
}

/**
 * Run SAST scan with timeout
 */
async function runSastScanWrapped(
	changedFiles: string[],
	directory: string,
	severityThreshold: 'low' | 'medium' | 'high' | 'critical',
	config?: PluginConfig,
	phase?: number,
	abortSignal?: AbortSignal,
): Promise<ToolResult<SastScanResult>> {
	const start = process.hrtime.bigint();

	try {
		const result = await runWithTimeout(
			(signal) =>
				sastScan(
					{
						changed_files: changedFiles,
						severity_threshold: severityThreshold,
						phase,
						abort_signal: signal,
					},
					directory,
					config,
				),
			TOOL_TIMEOUT_MS,
			abortSignal,
			true,
		);

		return {
			ran: true,
			result,
			duration_ms: Number(process.hrtime.bigint() - start) / 1_000_000,
		};
	} catch (error) {
		return {
			ran: true,
			error: error instanceof Error ? error.message : 'Unknown error',
			duration_ms: Number(process.hrtime.bigint() - start) / 1_000_000,
		};
	}
}

/**
 * Run quality budget with timeout
 */
async function runQualityBudgetWrapped(
	changedFiles: string[],
	directory: string,
	config?: PluginConfig,
	abortSignal?: AbortSignal,
): Promise<ToolResult<QualityBudgetResult>> {
	const start = process.hrtime.bigint();

	try {
		const result = await runWithTimeout(
			() =>
				_internals.qualityBudget(
					{
						changed_files: changedFiles,
						config: config?.gates?.quality_budget,
					},
					directory,
				),
			TOOL_TIMEOUT_MS,
			abortSignal,
		);

		return {
			ran: true,
			result,
			duration_ms: Number(process.hrtime.bigint() - start) / 1_000_000,
		};
	} catch (error) {
		return {
			ran: true,
			error: error instanceof Error ? error.message : 'Unknown error',
			duration_ms: Number(process.hrtime.bigint() - start) / 1_000_000,
		};
	}
}

// ============ Changed-Line Detection ============

/** Severity levels that trigger the gate (legacy changed-line triage) */
const GATE_SEVERITIES = new Set(['high', 'critical']);

const SEVERITY_ORDER_PCB: Record<string, number> = {
	low: 0,
	medium: 1,
	high: 2,
	critical: 3,
};

/** Whether a finding severity meets or exceeds the given threshold. */
function meetsThresholdForTriage(
	severity: string,
	threshold: 'low' | 'medium' | 'high' | 'critical',
): boolean {
	return (
		(SEVERITY_ORDER_PCB[severity] ?? 0) >= (SEVERITY_ORDER_PCB[threshold] ?? 1)
	);
}

async function runGit(
	args: string[],
	directory: string,
	abortSignal?: AbortSignal,
): Promise<string | null> {
	const result = await _internals.runExternalTool({
		executable: 'git',
		args,
		cwd: directory,
		timeoutMs: GIT_TIMEOUT_MS,
		maxStdoutBytes: GIT_MAX_OUTPUT_BYTES,
		maxStderrBytes: 64_000,
		abortSignal,
	});
	if (
		result.status !== 'completed' ||
		result.exitCode !== 0 ||
		result.stdoutTruncated
	) {
		return null;
	}
	return result.stdout;
}

function decodeGitQuotedPath(value: string): string | null {
	if (!value.startsWith('"')) return value;
	if (!value.endsWith('"')) return null;
	const bytes: number[] = [];
	const appendText = (text: string) => {
		bytes.push(...Buffer.from(text, 'utf8'));
	};
	for (let index = 1; index < value.length - 1; index++) {
		const codePoint = value.codePointAt(index);
		if (codePoint === undefined) return null;
		const char = String.fromCodePoint(codePoint);
		if (char !== '\\') {
			appendText(char);
			if (char.length === 2) index++;
			continue;
		}
		index++;
		if (index >= value.length - 1) return null;
		const escaped = value[index];
		const simple: Record<string, string> = {
			'\\': '\\',
			'"': '"',
			t: '\t',
			n: '\n',
			r: '\r',
			b: '\b',
			f: '\f',
			v: '\v',
		};
		if (simple[escaped] !== undefined) {
			appendText(simple[escaped]);
			continue;
		}
		if (/[0-7]/.test(escaped)) {
			let octal = escaped;
			for (let count = 0; count < 2; count++) {
				const next = value[index + 1];
				if (!next || !/[0-7]/.test(next)) break;
				octal += next;
				index++;
			}
			bytes.push(Number.parseInt(octal, 8));
			continue;
		}
		return null;
	}
	return Buffer.from(bytes).toString('utf8');
}

function normalizeRepoPathKey(repoPath: string): string {
	const normalized = repoPath.replace(/\\/g, '/');
	return _internals.platform() === 'win32' || _internals.platform() === 'darwin'
		? normalized.toLowerCase()
		: normalized;
}

function normalizeDiffPath(rawPath: string): string | null {
	const pathToken = rawPath.startsWith('"')
		? rawPath
		: rawPath.split('\t', 1)[0];
	const decoded = decodeGitQuotedPath(pathToken);
	if (
		decoded === null ||
		decoded === '/dev/null' ||
		decoded.trim().length === 0
	) {
		return null;
	}
	// Every producer diff uses --no-prefix. A literal leading `a/` or `b/` is
	// therefore part of the repository path and must never be stripped: doing so
	// would make a newly changed security finding look pre-existing.
	return normalizeRepoPathKey(decoded);
}

/**
 * Parse unified diff output (with -U0) to extract added/modified line numbers per file.
 * Returns a Map from normalised file path → Set of changed line numbers.
 */
export function parseDiffLineRanges(
	diffOutput: string,
): Map<string, Set<number>> {
	return parseDiffLineRangesChecked(diffOutput, false) ?? new Map();
}

function parseDiffLineRangesChecked(
	diffOutput: string,
	requireGitFileHeaders: boolean,
): Map<string, Set<number>> | null {
	const result = new Map<string, Set<number>>();
	let currentFile: string | null = null;
	let inGitFile = false;
	let expectingDestination = false;
	let destinationSeen = false;
	let destinationNeedsHunk = false;
	let collectedLines = 0;

	for (const rawLine of diffOutput.split(/\r?\n/)) {
		const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
		if (line.startsWith('diff --git ')) {
			if (expectingDestination || destinationNeedsHunk) return null;
			inGitFile = true;
			currentFile = null;
			expectingDestination = false;
			destinationSeen = false;
			continue;
		}
		if (line.startsWith('--- ') && (inGitFile || !requireGitFileHeaders)) {
			if (expectingDestination || destinationNeedsHunk) return null;
			expectingDestination = true;
			continue;
		}
		if (line.startsWith('+++ ')) {
			if (requireGitFileHeaders && (!inGitFile || !expectingDestination)) {
				return null;
			}
			const rawDestination = line.slice(4);
			currentFile = normalizeDiffPath(rawDestination);
			if (currentFile === null && rawDestination.trim() !== '/dev/null') {
				return null;
			}
			expectingDestination = false;
			destinationSeen = true;
			destinationNeedsHunk = true;
			if (!currentFile) continue;
			if (!result.has(currentFile)) {
				result.set(currentFile, new Set());
			}
			continue;
		}
		// @@ -old,count +new,count @@ — anchor regex to hunk header structure
		if (!line.startsWith('@@')) continue;
		if (
			expectingDestination ||
			(requireGitFileHeaders && (!inGitFile || !destinationSeen))
		) {
			return null;
		}
		const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
		if (!match) return null;
		const start = Number.parseInt(match[1], 10);
		const count = match[2] !== undefined ? Number.parseInt(match[2], 10) : 1;
		if (
			!Number.isSafeInteger(start) ||
			!Number.isSafeInteger(count) ||
			count < 0 ||
			(count > 0 && start < 1) ||
			count > MAX_CHANGED_LINE_ENTRIES ||
			start + count - 1 > Number.MAX_SAFE_INTEGER ||
			collectedLines + count > MAX_CHANGED_LINE_ENTRIES
		) {
			return null;
		}
		destinationNeedsHunk = false;
		if (!currentFile) continue;
		const lines = result.get(currentFile);
		if (!lines) return null;
		for (let index = 0; index < count; index++) {
			lines.add(start + index);
		}
		collectedLines += count;
	}
	if (expectingDestination || destinationNeedsHunk) return null;

	return result;
}

function mergeChangedLines(
	target: Map<string, Set<number>>,
	source: Map<string, Set<number>>,
): void {
	for (const [file, sourceLines] of source) {
		const targetLines = target.get(file) ?? new Set<number>();
		for (const line of sourceLines) targetLines.add(line);
		target.set(file, targetLines);
	}
}

function parseUntrackedStatus(output: string): string[] | null {
	if (output.length > 0 && !output.endsWith('\0')) return null;

	const untracked: string[] = [];
	const records = output.split('\0');
	for (let index = 0; index < records.length - 1; index++) {
		const record = records[index];
		if (!record || record.length < 4 || record[2] !== ' ') return null;

		const status = record.slice(0, 2);
		const filePath = record.slice(3);
		if (!filePath || !isKnownPorcelainStatus(status)) return null;
		if (status === '??') untracked.push(normalizeRepoPathKey(filePath));

		if (/[RC]/.test(status)) {
			const sourcePath = records[++index];
			if (!sourcePath || looksLikePorcelainStatusRecord(sourcePath))
				return null;
		}
	}
	return untracked;
}

function isKnownPorcelainStatus(status: string): boolean {
	if (status === '??' || status === '!!') return true;
	if (/U/.test(status)) {
		return new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']).has(status);
	}
	return status !== '  ' && /^[ MTADRC]{2}$/.test(status);
}

function looksLikePorcelainStatusRecord(value: string): boolean {
	return (
		value.length >= 4 &&
		value[2] === ' ' &&
		isKnownPorcelainStatus(value.slice(0, 2))
	);
}

/**
 * Get the union of committed, staged, unstaged, and untracked changed lines.
 * A known empty union is authoritative; null means a required Git source was
 * unavailable or malformed and callers must classify findings fail-closed.
 */
export async function getChangedLineRanges(
	directory: string,
	abortSignal?: AbortSignal,
): Promise<Map<string, Set<number>> | null> {
	let mergeBase: string | null = null;
	for (const baseBranch of [
		'zaxbyhub/main',
		'upstream/main',
		'origin/main',
		'main',
		'origin/master',
		'master',
	]) {
		const output = await runGit(
			['merge-base', baseBranch, 'HEAD'],
			directory,
			abortSignal,
		);
		const candidate = output?.trim();
		if (candidate && /^[0-9a-f]{40,64}$/i.test(candidate)) {
			mergeBase = candidate;
			break;
		}
	}
	if (!mergeBase) return null;

	const commonDiffArgs = [
		'-c',
		'core.quotePath=false',
		'diff',
		'--no-ext-diff',
		'--no-color',
		'--no-prefix',
		'-U0',
	];
	const [committed, staged, unstaged, status] = await Promise.all([
		runGit(
			[...commonDiffArgs, `${mergeBase}..HEAD`, '--'],
			directory,
			abortSignal,
		),
		runGit(
			[...commonDiffArgs, '--cached', 'HEAD', '--'],
			directory,
			abortSignal,
		),
		runGit([...commonDiffArgs, '--'], directory, abortSignal),
		runGit(
			[
				'-c',
				'core.quotePath=false',
				'status',
				'--porcelain=v1',
				'-z',
				'--untracked-files=all',
			],
			directory,
			abortSignal,
		),
	]);
	if (
		committed === null ||
		staged === null ||
		unstaged === null ||
		status === null
	) {
		return null;
	}

	const committedLines = parseDiffLineRangesChecked(committed, true);
	const stagedLines = parseDiffLineRangesChecked(staged, true);
	const unstagedLines = parseDiffLineRangesChecked(unstaged, true);
	if (!committedLines || !stagedLines || !unstagedLines) return null;

	const result = new Map<string, Set<number>>();
	mergeChangedLines(result, committedLines);
	mergeChangedLines(result, stagedLines);
	mergeChangedLines(result, unstagedLines);
	const untracked = parseUntrackedStatus(status);
	if (untracked === null) return null;
	for (const file of untracked) result.set(file, new Set([ALL_LINES_CHANGED]));
	return result;
}

/**
 * Classify SAST findings as "new" (on changed lines) or "pre-existing" (unchanged lines).
 * A finding is "new" if its file+line intersects the changed line ranges from git diff.
 * If line ranges cannot be determined (git unavailable), all findings are treated as new (fail-closed).
 */
export function classifySastFindings(
	findings: SastScanFinding[],
	changedLineRanges: Map<string, Set<number>> | null,
	directory: string,
): { newFindings: SastScanFinding[]; preexistingFindings: SastScanFinding[] } {
	// Fail-closed: if we can't determine changed lines, treat all as new
	if (!changedLineRanges) {
		return { newFindings: findings, preexistingFindings: [] };
	}

	const newFindings: SastScanFinding[] = [];
	const preexistingFindings: SastScanFinding[] = [];
	const platform = _internals.platform();
	const pathApi = platform === 'win32' ? path.win32 : path.posix;
	const resolvedDirectory = pathApi.resolve(directory);

	for (const finding of findings) {
		const filePath = finding.location.file;
		let normalised: string;
		try {
			if (
				typeof filePath !== 'string' ||
				filePath.length === 0 ||
				filePath.includes('\0')
			) {
				newFindings.push(finding);
				continue;
			}
			const resolvedFinding = pathApi.isAbsolute(filePath)
				? pathApi.resolve(filePath)
				: pathApi.resolve(resolvedDirectory, filePath);
			const relative = pathApi.relative(resolvedDirectory, resolvedFinding);
			if (
				pathApi.isAbsolute(relative) ||
				relative === '..' ||
				relative.startsWith(`..${pathApi.sep}`)
			) {
				newFindings.push(finding);
				continue;
			}
			normalised = normalizeRepoPathKey(relative);
		} catch {
			newFindings.push(finding);
			continue;
		}

		const changedLines = changedLineRanges.get(normalised);
		if (
			changedLines?.has(ALL_LINES_CHANGED) ||
			changedLines?.has(finding.location.line)
		) {
			newFindings.push(finding);
		} else {
			preexistingFindings.push(finding);
		}
	}

	return { newFindings, preexistingFindings };
}

// ============ Main Function ============

/**
 * Run all 4 pre-check tools in parallel with concurrency limit
 * @param input - The pre-check batch input
 * @param workspaceDir - Optional workspace directory for traversal validation (injected project root from createSwarmTool, or input.directory)
 */
export async function runPreCheckBatch(
	input: PreCheckBatchInput,
	workspaceDir?: string,
	contextDir?: string,
	abortSignal?: AbortSignal,
): Promise<PreCheckBatchResult> {
	// Use provided workspaceDir or fall back to input directory, then plugin context directory
	const effectiveWorkspaceDir = (workspaceDir ||
		input.directory ||
		contextDir) as string;
	const { files, directory, sast_threshold = 'medium', config, phase } = input;

	// Validate directory
	const dirError = validateDirectory(directory, effectiveWorkspaceDir);
	if (dirError) {
		warn(`pre_check_batch: Invalid directory: ${dirError}`);
		return {
			batch_status: 'invalid',
			gates_passed: false,
			lint: { ran: false, error: dirError, duration_ms: 0 },
			secretscan: { ran: false, error: dirError, duration_ms: 0 },
			sast_scan: { ran: false, error: dirError, duration_ms: 0 },
			quality_budget: { ran: false, error: dirError, duration_ms: 0 },
			total_duration_ms: 0,
		};
	}

	// Early fail-closed check: if no files provided at all, fail immediately
	if (!files || files.length === 0) {
		warn(
			'pre_check_batch: No files provided, skipping all tools (fail-closed)',
		);
		return {
			batch_status: 'invalid',
			gates_passed: false,
			lint: { ran: false, error: 'No files provided', duration_ms: 0 },
			secretscan: { ran: false, error: 'No files provided', duration_ms: 0 },
			sast_scan: { ran: false, error: 'No files provided', duration_ms: 0 },
			quality_budget: {
				ran: false,
				error: 'No files provided',
				duration_ms: 0,
			},
			total_duration_ms: 0,
		};
	}

	// Determine files to check
	// If files are provided, use them; otherwise scan directory for changed files
	// For simplicity in batch mode, we'll scan the entire directory
	const changedFiles: string[] = [];

	// Validate each file path
	for (const file of files) {
		// Hardened: Explicit type guard for non-string entries fail-closed
		if (typeof file !== 'string') {
			warn(`pre_check_batch: Non-string file entry rejected: ${String(file)}`);
			continue;
		}
		const fileError = validatePath(file, directory, effectiveWorkspaceDir);
		if (fileError) {
			warn(`pre_check_batch: Invalid file path: ${file}`);
			continue;
		}
		changedFiles.push(path.resolve(directory, file));
	}

	// Early return if no valid files after validation
	if (changedFiles.length === 0) {
		warn(
			'pre_check_batch: No valid files after validation, skipping all tools (fail-closed)',
		);
		return {
			batch_status: 'invalid',
			gates_passed: false,
			lint: { ran: false, error: 'No files provided', duration_ms: 0 },
			secretscan: { ran: false, error: 'No files provided', duration_ms: 0 },
			sast_scan: { ran: false, error: 'No files provided', duration_ms: 0 },
			quality_budget: {
				ran: false,
				error: 'No files provided',
				duration_ms: 0,
			},
			total_duration_ms: 0,
		};
	}

	// Limit files to prevent abuse
	if (changedFiles.length > MAX_FILES) {
		throw new Error(
			`Input exceeds maximum file count: ${changedFiles.length} > ${MAX_FILES}`,
		);
	}

	// Run all tools in parallel with concurrency limit
	const limit = pLimit(MAX_CONCURRENT);

	const [lintResult, secretscanResult, sastScanResult, qualityBudgetResult] =
		await Promise.all([
			limit(() =>
				_internals.runLintWrapped(changedFiles, directory, config, abortSignal),
			),
			limit(() =>
				_internals.runSecretscanWrapped(
					changedFiles,
					directory,
					config,
					abortSignal,
				),
			),
			limit(() =>
				_internals.runSastScanWrapped(
					changedFiles,
					directory,
					sast_threshold,
					config,
					phase,
					abortSignal,
				),
			),
			limit(() =>
				_internals.runQualityBudgetWrapped(
					changedFiles,
					directory,
					config,
					abortSignal,
				),
			),
		]);

	// Calculate total duration
	const totalDuration =
		lintResult.duration_ms +
		secretscanResult.duration_ms +
		sastScanResult.duration_ms +
		qualityBudgetResult.duration_ms;

	// Determine gates_passed:
	// - Security tools (secretscan, sast_scan) are HARD GATES - failures block merging
	// - Quality tools (lint, quality_budget) are informational only - do NOT block gates_passed
	let gatesPassed = true;

	// Check lint (informational only - does NOT block gates_passed)
	if (lintResult.ran && lintResult.result) {
		const lintRes = lintResult.result;
		if ('success' in lintRes && lintRes.success === false) {
			warn('pre_check_batch: Lint found issues (informational only)');
		}
	} else if (lintResult.error) {
		warn(
			`pre_check_batch: Lint error (informational only): ${lintResult.error}`,
		);
	}

	// Check secretscan (hard gate - MUST pass)
	const secretscanDecision = evaluateSecretscanGate(
		secretscanResult,
		changedFiles.length,
	);
	if (!secretscanDecision.passed) {
		gatesPassed = false;
		warn(`pre_check_batch: ${secretscanDecision.summary} - GATE FAILED`);
	}

	// v6.33: Persist secretscan results to evidence bundle
	if (secretscanResult.ran || secretscanResult.error) {
		try {
			const scanResult = secretscanDecision.result;
			const secretscanEvidence: SecretscanEvidence = {
				task_id: 'secretscan',
				type: 'secretscan',
				timestamp: new Date().toISOString(),
				agent: 'pre_check_batch',
				verdict: secretscanDecision.passed ? 'pass' : 'fail',
				summary: secretscanDecision.summary,
				findings_count: secretscanDecision.findingsCount,
				scan_directory: scanResult?.scan_dir ?? directory,
				files_scanned: scanResult?.files_scanned ?? 0,
				skipped_files: scanResult?.skipped_files ?? 0,
				incomplete_files: scanResult?.incomplete_files ?? changedFiles.length,
				incomplete_paths: scanResult?.incomplete_paths ?? [
					{ path: '.', reason: 'missing_coverage_metadata' },
				],
			};
			await _internals.saveEvidence(
				directory,
				'secretscan',
				secretscanEvidence,
			);
		} catch (e) {
			warn(
				`Failed to persist secretscan evidence: ${e instanceof Error ? e.message : String(e)}`,
			);
		}
	}

	// Check SAST scan (hard gate with pre-existing finding classification)
	let sastPreexistingFindings: SastScanFinding[] | undefined;
	if (sastScanResult.ran && sastScanResult.result) {
		const sastResult = sastScanResult.result;

		if (sastResult.error) {
			gatesPassed = false;
			warn(
				`pre_check_batch: SAST scan error (${sastResult.error}) - GATE FAILED`,
			);
		} else if (sastResult.baseline_used) {
			// Baseline diff mode: verdict is driven ONLY by new_findings in sastScan.
			// Populate reviewer triage with pre_existing_findings (if any), regardless of verdict.
			// Use sast_threshold as triage filter so mediums are not silently dropped when
			// threshold is 'medium' or lower.
			if (
				sastResult.pre_existing_findings &&
				sastResult.pre_existing_findings.length > 0
			) {
				sastPreexistingFindings = sastResult.pre_existing_findings.filter((f) =>
					meetsThresholdForTriage(f.severity, sast_threshold),
				);
				if (sastPreexistingFindings.length > 0) {
					warn(
						`pre_check_batch: SAST baseline diff found ${sastPreexistingFindings.length} pre-existing finding(s) - passing to reviewer for triage`,
					);
				}
			}
			// Verdict is already correctly set by sastScan — do not override.
			if (sastResult.verdict === 'fail') {
				gatesPassed = false;
				warn(
					`pre_check_batch: SAST scan found new findings above threshold - GATE FAILED`,
				);
			}
		} else if (sastResult.verdict === 'fail') {
			// Legacy mode (no baseline): classify HIGH/CRITICAL findings by changed lines
			const gateFindings = sastResult.findings.filter((f) =>
				GATE_SEVERITIES.has(f.severity),
			);

			if (gateFindings.length > 0) {
				const changedLineRanges = await _internals.getChangedLineRanges(
					directory,
					abortSignal,
				);
				const { newFindings, preexistingFindings } = classifySastFindings(
					gateFindings,
					changedLineRanges,
					directory,
				);

				if (newFindings.length > 0) {
					// New findings on changed lines → hard block
					gatesPassed = false;
					warn(
						`pre_check_batch: SAST scan found ${newFindings.length} new HIGH/CRITICAL finding(s) on changed lines - GATE FAILED`,
					);
				} else if (preexistingFindings.length > 0) {
					// All HIGH/CRITICAL findings are pre-existing on unchanged lines
					// Do NOT block coder — carry findings forward for reviewer triage
					sastPreexistingFindings = preexistingFindings;
					warn(
						`pre_check_batch: SAST scan found ${preexistingFindings.length} pre-existing HIGH/CRITICAL finding(s) on unchanged lines - passing to reviewer for triage`,
					);
				}
			} else {
				// SAST failed but no HIGH/CRITICAL findings (lower severity only)
				// Original behavior: fail the gate
				gatesPassed = false;
				warn('pre_check_batch: SAST scan found vulnerabilities - GATE FAILED');
			}
		}
	} else if (sastScanResult.error) {
		// Error in SAST - fail closed
		gatesPassed = false;
		warn(
			`pre_check_batch: SAST scan error - GATE FAILED: ${sastScanResult.error}`,
		);
	}

	// Check quality budget (informational only - does NOT block gates_passed)
	if (qualityBudgetResult.ran && qualityBudgetResult.result) {
		if (qualityBudgetResult.result.verdict === 'fail') {
			warn('pre_check_batch: Quality budget exceeded (informational only)');
		}
	} else if (qualityBudgetResult.error) {
		warn(
			`pre_check_batch: Quality budget error (informational only): ${qualityBudgetResult.error}`,
		);
	}

	// Build result
	const result: PreCheckBatchResult = {
		batch_status: [
			lintResult,
			secretscanResult,
			sastScanResult,
			qualityBudgetResult,
		].every((toolResult) => toolResult.ran === false)
			? 'skipped'
			: 'completed',
		gates_passed: gatesPassed,
		lint: lintResult,
		secretscan: secretscanResult,
		sast_scan: sastScanResult,
		quality_budget: qualityBudgetResult,
		total_duration_ms: Math.round(totalDuration),
		...(sastPreexistingFindings &&
			sastPreexistingFindings.length > 0 && {
				sast_preexisting_findings: sastPreexistingFindings,
			}),
	};

	return result;
}

// ============ Tool Definition ============

/**
 * Pre-check batch tool - runs 4 verification tools in parallel
 * Returns unified result with gates_passed status
 */
export const pre_check_batch: ReturnType<typeof tool> = createSwarmTool({
	description:
		'Run multiple verification tools in parallel: lint, secretscan, SAST scan, and quality budget. Returns unified result with gates_passed status. Security tools (secretscan, sast_scan) are HARD GATES - failures block merging.',
	args: {
		files: z
			.array(z.string())
			.optional()
			.describe(
				'Specific files to check (optional, scans directory if not provided)',
			),
		directory: z
			.string()
			.describe(
				'Project root directory — must be the workspace root, subdirectories are rejected',
			),
		sast_threshold: z
			.enum(['low', 'medium', 'high', 'critical'])
			.optional()
			.describe(
				'Minimum severity for SAST findings to cause failure (default: medium)',
			),
		phase: z
			.number()
			.int()
			.min(1)
			.optional()
			.describe(
				'Current phase number (positive integer >= 1). When provided, enables SAST baseline diffing: only findings absent from the phase-scoped baseline fail the gate.',
			),
	},
	async execute(args: unknown, directory: string, ctx): Promise<string> {
		// Validate arguments
		if (!args || typeof args !== 'object') {
			const errorResult: PreCheckBatchResult = {
				batch_status: 'invalid',
				gates_passed: false,
				lint: { ran: false, error: 'Invalid arguments', duration_ms: 0 },
				secretscan: { ran: false, error: 'Invalid arguments', duration_ms: 0 },
				sast_scan: { ran: false, error: 'Invalid arguments', duration_ms: 0 },
				quality_budget: {
					ran: false,
					error: 'Invalid arguments',
					duration_ms: 0,
				},
				total_duration_ms: 0,
			};
			return serializePreCheckResult(errorResult);
		}

		if (
			!directory ||
			typeof directory !== 'string' ||
			directory.trim() === ''
		) {
			const errorResult: PreCheckBatchResult = {
				batch_status: 'invalid',
				gates_passed: false,
				lint: {
					ran: false,
					error: 'project directory is required but was not provided',
					duration_ms: 0,
				},
				secretscan: {
					ran: false,
					error: 'project directory is required but was not provided',
					duration_ms: 0,
				},
				sast_scan: {
					ran: false,
					error: 'project directory is required but was not provided',
					duration_ms: 0,
				},
				quality_budget: {
					ran: false,
					error: 'project directory is required but was not provided',
					duration_ms: 0,
				},
				total_duration_ms: 0,
			};
			return serializePreCheckResult(errorResult);
		}

		const typedArgs = args as PreCheckBatchInput;

		if (!typedArgs.directory) {
			const errorResult: PreCheckBatchResult = {
				batch_status: 'invalid',
				gates_passed: false,
				lint: { ran: false, error: 'directory is required', duration_ms: 0 },
				secretscan: {
					ran: false,
					error: 'directory is required',
					duration_ms: 0,
				},
				sast_scan: {
					ran: false,
					error: 'directory is required',
					duration_ms: 0,
				},
				quality_budget: {
					ran: false,
					error: 'directory is required',
					duration_ms: 0,
				},
				total_duration_ms: 0,
			};
			return serializePreCheckResult(errorResult);
		}

		// Resolve directory to absolute path first to ensure consistent behavior
		// This handles cases where path.isAbsolute may not detect Windows paths correctly
		const resolvedDirectory = path.resolve(typedArgs.directory);

		// Determine workspace anchor: use the injected project root (directory parameter)
		// rather than the user-supplied arg value, to prevent self-validation bypass
		const workspaceAnchor = path.resolve(directory);

		// Reject subdirectory: if arg resolves inside project root, hard-reject
		if (
			resolvedDirectory !== workspaceAnchor &&
			resolvedDirectory.startsWith(workspaceAnchor + path.sep)
		) {
			const subDirError = `directory "${typedArgs.directory}" is a subdirectory of the project root — pre_check_batch requires the project root directory "${workspaceAnchor}"`;
			const subDirResult: PreCheckBatchResult = {
				batch_status: 'invalid',
				gates_passed: false,
				lint: { ran: false, error: subDirError, duration_ms: 0 },
				secretscan: { ran: false, error: subDirError, duration_ms: 0 },
				sast_scan: { ran: false, error: subDirError, duration_ms: 0 },
				quality_budget: { ran: false, error: subDirError, duration_ms: 0 },
				total_duration_ms: 0,
			};
			return serializePreCheckResult(subDirResult);
		}

		// Validate directory using the resolved path against the true workspace anchor
		const dirError = validateDirectory(resolvedDirectory, workspaceAnchor);
		if (dirError) {
			const errorResult: PreCheckBatchResult = {
				batch_status: 'invalid',
				gates_passed: false,
				lint: { ran: false, error: dirError, duration_ms: 0 },
				secretscan: { ran: false, error: dirError, duration_ms: 0 },
				sast_scan: { ran: false, error: dirError, duration_ms: 0 },
				quality_budget: { ran: false, error: dirError, duration_ms: 0 },
				total_duration_ms: 0,
			};
			return serializePreCheckResult(errorResult);
		}

		// Run pre-check batch
		try {
			const rawPhase = (typedArgs as unknown as Record<string, unknown>).phase;
			const safePhase =
				typeof rawPhase === 'number' &&
				Number.isInteger(rawPhase) &&
				rawPhase >= 1
					? rawPhase
					: undefined;

			const result = await runPreCheckBatch(
				{
					files: typedArgs.files,
					directory: resolvedDirectory,
					sast_threshold: typedArgs.sast_threshold,
					config: typedArgs.config,
					phase: safePhase,
				},
				workspaceAnchor,
				directory,
				ctx?.abort,
			);

			return serializePreCheckResult(result);
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : 'Unknown error';
			const errorResult: PreCheckBatchResult = {
				batch_status: 'invalid',
				gates_passed: false,
				lint: { ran: false, error: errorMessage, duration_ms: 0 },
				secretscan: { ran: false, error: errorMessage, duration_ms: 0 },
				sast_scan: { ran: false, error: errorMessage, duration_ms: 0 },
				quality_budget: { ran: false, error: errorMessage, duration_ms: 0 },
				total_duration_ms: 0,
			};
			return serializePreCheckResult(errorResult);
		}
	},
});
