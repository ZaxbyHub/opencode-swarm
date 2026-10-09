/**
 * Pre-Check Batch Tool
 * Runs 4 verification tools in parallel: lint, secretscan, sast-scan, quality-budget
 * Returns unified result with gates_passed status
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import pLimit from 'p-limit';
import type { PluginConfig } from '../config';
import { warn } from '../utils';
import { bunSpawn } from '../utils/bun-compat';
import type { LintResult, LintSuccessResult, SupportedLinter } from './lint';
import { detectAvailableLinter, runLint } from './lint';
import type { QualityBudgetResult } from './quality-budget';
import { qualityBudget } from './quality-budget';
import type { SastScanResult } from './sast-scan';
import { sastScan } from './sast-scan';
import type {
	SecretFinding,
	SecretscanErrorResult,
	SecretscanResult,
} from './secretscan';
import { runSecretscan } from './secretscan';

// ============ Constants ============
const TOOL_TIMEOUT_MS = 60_000;
const MAX_COMBINED_BYTES = 500_000; // 500KB
const MAX_CONCURRENT = 4;
const MAX_FILES = 100;

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

export interface PreCheckBatchResult {
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

	if (!inputPath || inputPath.length === 0) {
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

	const workspaceResolved = path.resolve(workspaceDir);

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

	return null;
}

// ============ Timeout Helper ============

/**
 * Run a function with timeout
 */
async function runWithTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
): Promise<T> {
	const timeoutPromise = new Promise<never>((_, reject) => {
		setTimeout(
			() => reject(new Error(`Timeout after ${timeoutMs}ms`)),
			timeoutMs,
		);
	});

	return Promise.race([promise, timeoutPromise]);
}

// ============ Wrapper Functions ============

/**
 * Run lint with detection and timeout
 */
async function runLintWrapped(
	files: string[] | undefined,
	directory: string,
	_config?: PluginConfig,
): Promise<ToolResult<LintResult>> {
	const start = process.hrtime.bigint();

	try {
		const linter = await detectAvailableLinter();

		if (!linter) {
			return {
				ran: false,
				error: 'No linter found (biome or eslint)',
				duration_ms: Number(process.hrtime.bigint() - start) / 1_000_000,
			};
		}

		// If files are provided, run lint on those specific files only
		if (files && files.length > 0) {
			const filteredResult = await runLintOnFiles(linter, files, directory);
			return {
				ran: true,
				result: filteredResult,
				duration_ms: Number(process.hrtime.bigint() - start) / 1_000_000,
			};
		}

		// No files provided - run lint on entire directory (current behavior)
		const result = await runWithTimeout(
			runLint(linter, 'check', directory),
			TOOL_TIMEOUT_MS,
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
	linter: SupportedLinter,
	files: string[],
	workspaceDir: string,
): Promise<LintResult> {
	const isWindows = process.platform === 'win32';
	const binDir = path.join(workspaceDir, 'node_modules', '.bin');

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
			linter,
			command: [],
			error: 'No valid files after security validation',
		};
	}

	let command: string[];
	if (linter === 'biome') {
		const biomeBin = isWindows
			? path.join(binDir, 'biome.EXE')
			: path.join(binDir, 'biome');
		command = [biomeBin, 'check', ...validatedFiles];
	} else {
		const eslintBin = isWindows
			? path.join(binDir, 'eslint.cmd')
			: path.join(binDir, 'eslint');
		command = [eslintBin, ...validatedFiles];
	}

	try {
		const proc = bunSpawn(command, {
			stdout: 'pipe',
			stderr: 'pipe',
			cwd: workspaceDir,
		});

		const [stdout, stderr] = await Promise.all([
			proc.stdout.text(),
			proc.stderr.text(),
		]);

		const exitCode = await proc.exited;

		let output = stdout;
		if (stderr) {
			output += (output ? '\n' : '') + stderr;
		}

		if (output.length > 512_000) {
			output = `${output.slice(0, 512_000)}\n... (output truncated)`;
		}

		const result: LintSuccessResult = {
			success: true,
			mode: 'check',
			linter,
			command,
			exitCode,
			output,
		};

		if (exitCode === 0) {
			result.message = `${linter} check completed successfully with no issues`;
		} else {
			result.message = `${linter} check found issues (exit code ${exitCode}).`;
		}

		return result;
	} catch (error) {
		return {
			success: false,
			mode: 'check',
			linter,
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
): Promise<ToolResult<SecretscanResult | SecretscanErrorResult>> {
	const start = process.hrtime.bigint();

	try {
		// If files are provided, run secretscan with explicit file scope
		if (files && files.length > 0) {
			const result = await runWithTimeout(
				runSecretscanWithFiles(files, directory),
				TOOL_TIMEOUT_MS,
			);
			return {
				ran: true,
				result,
				duration_ms: Number(process.hrtime.bigint() - start) / 1_000_000,
			};
		}

		// No files provided - scan entire directory (current behavior)
		const result = await runWithTimeout(
			runSecretscan(directory),
			TOOL_TIMEOUT_MS,
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

// ============ Secretscan File Scanning (for targeted scanning) ============

/**
 * Run secretscan with explicit file scope - only scans specified files
 */
async function runSecretscanWithFiles(
	files: string[],
	directory: string,
): Promise<SecretscanResult | SecretscanErrorResult> {
	const MAX_FILE_SIZE_BYTES = 512 * 1024; // 512KB per file
	const MAX_FINDINGS = 100;

	// Default exclusions for file extensions
	const DEFAULT_EXCLUDE_EXTENSIONS = new Set([
		'.png',
		'.jpg',
		'.jpeg',
		'.gif',
		'.ico',
		'.svg',
		'.pdf',
		'.zip',
		'.tar',
		'.gz',
		'.rar',
		'.7z',
		'.exe',
		'.dll',
		'.so',
		'.dylib',
		'.bin',
		'.dat',
		'.db',
		'.sqlite',
		'.lock',
		'.log',
		'.md',
	]);

	// Secret patterns for scanning (simplified version)
	// Note: Patterns use non-global regex to avoid shared state mutation
	// Each scan creates a fresh matcher to prevent lastIndex contamination
	const SECRET_PATTERNS: Array<{
		type: string;
		pattern: string;
		redactTemplate: (match?: string) => string;
	}> = [
		{
			type: 'api_key',
			pattern:
				'(?:api[_-]?key|apikey|API[_-]?KEY)\\s*[=:]\\s*[\'"]?([a-zA-Z0-9_-]{16,64})[\'"]?',
			redactTemplate: () => 'api_key=[REDACTED]',
		},
		{
			type: 'password',
			pattern:
				'(?:password|passwd|pwd|PASSWORD|PASSWD)\\s*[=:]\\s*[\'"]?([^s\'"]{4,100})[\'"]?',
			redactTemplate: () => 'password=[REDACTED]',
		},
		{
			type: 'private_key',
			pattern: '-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----',
			redactTemplate: () => '-----BEGIN PRIVATE KEY-----',
		},
		{
			type: 'github_token',
			pattern: '(?:ghp|gho|ghu|ghs|ghr)_[a-zA-Z0-9]{36,}',
			redactTemplate: () => 'ghp_[REDACTED]',
		},
		{
			type: 'jwt',
			pattern: 'eyJ[a-zA-Z0-9_-]*\\.eyJ[a-zA-Z0-9_-]*\\.[a-zA-Z0-9_-]*',
			redactTemplate: (m) => `eyJ...${(m || '').slice(-10)}`,
		},
	];

	try {
		const findings: SecretFinding[] = [];
		let filesScanned = 0;
		let skippedFiles = 0;

		// Security: Validate all resolved file paths before processing
		const validatedFiles: string[] = [];
		for (const file of files) {
			// Hardened: Explicit type guard for non-string entries fail-closed
			if (typeof file !== 'string') {
				skippedFiles++;
				continue;
			}
			// Resolve the path first
			const resolvedPath = path.resolve(file);
			// Validate the resolved path against workspace boundary
			const validationError = validatePath(resolvedPath, directory, directory);
			if (validationError) {
				// Skip invalid files - fail closed
				skippedFiles++;
				continue;
			}
			validatedFiles.push(resolvedPath);
		}

		// Fail closed if no valid files after validation
		if (validatedFiles.length === 0) {
			return {
				scan_dir: directory,
				findings: [],
				count: 0,
				files_scanned: 0,
				skipped_files: skippedFiles,
			};
		}

		// Filter and scan only the validated files
		for (const file of validatedFiles) {
			const ext = path.extname(file).toLowerCase();

			// Skip excluded file types
			if (DEFAULT_EXCLUDE_EXTENSIONS.has(ext)) {
				skippedFiles++;
				continue;
			}

			// Check file size
			let stat: fs.Stats;
			try {
				stat = fs.statSync(file);
			} catch {
				skippedFiles++;
				continue;
			}

			if (stat.size > MAX_FILE_SIZE_BYTES) {
				skippedFiles++;
				continue;
			}

			// Read and scan file
			let content: string;
			try {
				const buffer = fs.readFileSync(file);
				// Skip binary files (check for null bytes)
				if (buffer.includes(0)) {
					skippedFiles++;
					continue;
				}
				// Handle UTF-8 BOM
				if (
					buffer.length >= 3 &&
					buffer[0] === 0xef &&
					buffer[1] === 0xbb &&
					buffer[2] === 0xbf
				) {
					content = buffer.slice(3).toString('utf-8');
				} else {
					content = buffer.toString('utf-8');
				}
			} catch {
				skippedFiles++;
				continue;
			}

			filesScanned++;

			// Scan each line - create fresh regex per pattern to avoid shared state
			const lines = content.split('\n');
			for (let i = 0; i < lines.length && findings.length < MAX_FINDINGS; i++) {
				const line = lines[i];
				for (const pattern of SECRET_PATTERNS) {
					// Create fresh regex instance for each line to avoid lastIndex mutation
					const regex = new RegExp(pattern.pattern, 'gi');
					let match: RegExpExecArray | null = regex.exec(line);
					while (match !== null) {
						findings.push({
							path: file,
							line: i + 1,
							type: pattern.type as SecretFinding['type'],
							confidence: 'medium',
							severity: 'high',
							redacted: pattern.redactTemplate(match[0]),
							context: line,
						});

						// Prevent infinite loop on zero-length matches
						if (match.index === regex.lastIndex) {
							regex.lastIndex++;
						}

						match = regex.exec(line);
					}
				}
			}
		}

		// Sort findings deterministically
		findings.sort((a, b) => {
			if (a.path < b.path) return -1;
			if (a.path > b.path) return 1;
			return a.line - b.line;
		});

		return {
			scan_dir: directory,
			findings,
			count: findings.length,
			files_scanned: filesScanned,
			skipped_files: skippedFiles,
		};
	} catch (e) {
		const errorResult: SecretscanErrorResult = {
			error:
				e instanceof Error
					? `scan failed: ${e.message}`
					: 'scan failed: unknown error',
			scan_dir: directory,
			findings: [],
			count: 0,
			files_scanned: 0,
			skipped_files: 0,
		};
		return errorResult;
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
): Promise<ToolResult<SastScanResult>> {
	const start = process.hrtime.bigint();

	try {
		const result = await runWithTimeout(
			sastScan(
				{ changed_files: changedFiles, severity_threshold: severityThreshold },
				directory,
				config,
			),
			TOOL_TIMEOUT_MS,
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
	_config?: PluginConfig,
): Promise<ToolResult<QualityBudgetResult>> {
	const start = process.hrtime.bigint();

	try {
		const result = await runWithTimeout(
			qualityBudget({ changed_files: changedFiles }, directory),
			TOOL_TIMEOUT_MS,
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

// ============ Main Function ============

/**
 * Run all 4 pre-check tools in parallel with concurrency limit
 * @param input - The pre-check batch input
 * @param workspaceDir - Optional workspace directory for traversal validation (defaults to directory param or process.cwd())
 */
export async function runPreCheckBatch(
	input: PreCheckBatchInput,
	workspaceDir?: string,
): Promise<PreCheckBatchResult> {
	// Use provided workspaceDir or fall back to directory, then process.cwd()
	const effectiveWorkspaceDir =
		workspaceDir || input.directory || process.cwd();
	const { files, directory, sast_threshold = 'medium', config } = input;

	// Validate directory
	const dirError = validateDirectory(directory, effectiveWorkspaceDir);
	if (dirError) {
		warn(`pre_check_batch: Invalid directory: ${dirError}`);
		return {
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
			limit(() => runLintWrapped(changedFiles, directory, config)),
			limit(() => runSecretscanWrapped(changedFiles, directory, config)),
			limit(() =>
				runSastScanWrapped(changedFiles, directory, sast_threshold, config),
			),
			limit(() => runQualityBudgetWrapped(changedFiles, directory, config)),
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
	if (secretscanResult.ran && secretscanResult.result) {
		const scanResult = secretscanResult.result as SecretscanResult;
		if ('findings' in scanResult && scanResult.findings.length > 0) {
			gatesPassed = false;
			warn('pre_check_batch: Secretscan found secrets - GATE FAILED');
		}
	} else if (secretscanResult.error) {
		// Error in secretscan - fail closed
		gatesPassed = false;
		warn(
			`pre_check_batch: Secretscan error - GATE FAILED: ${secretscanResult.error}`,
		);
	}

	// Check SAST scan (hard gate)
	if (sastScanResult.ran && sastScanResult.result) {
		if (sastScanResult.result.verdict === 'fail') {
			gatesPassed = false;
			warn('pre_check_batch: SAST scan found vulnerabilities - GATE FAILED');
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
		gates_passed: gatesPassed,
		lint: lintResult,
		secretscan: secretscanResult,
		sast_scan: sastScanResult,
		quality_budget: qualityBudgetResult,
		total_duration_ms: Math.round(totalDuration),
	};

	// Log warning if output is large
	const outputSize = JSON.stringify(result).length;
	if (outputSize > MAX_COMBINED_BYTES) {
		warn(`pre_check_batch: Large output (${outputSize} bytes)`);
	}

	return result;
}
