/**
 * Semgrep Integration for Tier B SAST Enhancement
 * Provides optional Semgrep detection and invocation for advanced static analysis
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	resolveExecutableFromPath,
	runExternalTool,
} from '../utils/external-tool-runner';
import type { SastFinding } from './rules/index.js';

/**
 * Semgrep CLI options
 */
export interface SemgrepOptions {
	/** Files or directories to scan */
	files: string[];
	/** Directory containing Semgrep rules (default: .swarm/semgrep-rules/) */
	rulesDir?: string;
	/** Timeout in milliseconds (default: 30000) */
	timeoutMs?: number;
	/** Working directory for Semgrep execution */
	cwd?: string;
	/** Language identifier for --lang flag (used with useAutoConfig) */
	lang?: string;
	/** When true, use --config auto instead of local rulesDir (for profile-driven languages) */
	useAutoConfig?: boolean;
	/** Host/tool cancellation propagated to the shared subprocess runner. */
	abortSignal?: AbortSignal;
}

/**
 * Result from Semgrep execution
 */
export interface SemgrepResult {
	/** Whether Semgrep is available on the system */
	available: boolean;
	/** Array of security findings from Semgrep */
	findings: SastFinding[];
	/** Error message if Semgrep failed */
	error?: string;
	/** Engine label for the findings */
	engine: 'tier_a' | 'tier_a+tier_b';
}

/**
 * Cached Semgrep availability status.
 * Null means "not probed yet using the bounded async path".
 */
let semgrepAvailableCache: boolean | null = null;

/**
 * Default rules directory
 */
const DEFAULT_RULES_DIR = '.swarm/semgrep-rules';

/**
 * Default timeout for Semgrep execution (30 seconds)
 */
const DEFAULT_TIMEOUT_MS = 30000;
const SEMGREP_AVAILABILITY_TIMEOUT_MS = 5_000;
const SEMGREP_AVAILABILITY_MAX_STDOUT_BYTES = 16 * 1024;
const SEMGREP_AVAILABILITY_MAX_STDERR_BYTES = 16 * 1024;

/**
 * Per-stream cap on accumulated stdout/stderr from the Semgrep subprocess.
 * AGENTS.md invariant 3 requires bounded stdio.
 */
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // 10MB per stream

function resolveSemgrepBinary(): string | null {
	// The Node subprocess API cannot directly launch Windows command shims.
	// Semgrep's supported Windows installs provide a native executable; treat a
	// shim-only PATH as unavailable instead of introducing a shell launcher.
	return _internals.resolveExecutableFromPath(
		process.platform === 'win32' ? ['semgrep.exe'] : ['semgrep'],
	);
}

function getAvailabilityProbeCwd(): string {
	try {
		return fs.realpathSync(process.cwd());
	} catch {
		return path.resolve(process.cwd());
	}
}

export const _internals: {
	isSemgrepAvailable: typeof isSemgrepAvailable;
	checkSemgrepAvailable: typeof checkSemgrepAvailable;
	resetSemgrepCache: typeof resetSemgrepCache;
	runSemgrep: typeof runSemgrep;
	getRulesDirectory: typeof getRulesDirectory;
	hasBundledRules: typeof hasBundledRules;
	resolveExecutableFromPath: typeof resolveExecutableFromPath;
	resolveSemgrepBinary: typeof resolveSemgrepBinary;
	runExternalTool: typeof runExternalTool;
	getAvailabilityProbeCwd: typeof getAvailabilityProbeCwd;
} = {
	isSemgrepAvailable,
	checkSemgrepAvailable,
	resetSemgrepCache,
	runSemgrep,
	getRulesDirectory,
	hasBundledRules,
	resolveExecutableFromPath,
	resolveSemgrepBinary,
	runExternalTool,
	getAvailabilityProbeCwd,
} as const;

/**
 * Synchronous compatibility surface.
 * Returns the last confirmed async availability result when cached; otherwise
 * falls back to a pure PATH-resolution heuristic without spawning.
 */
export function isSemgrepAvailable(): boolean {
	if (semgrepAvailableCache !== null) {
		return semgrepAvailableCache;
	}
	return _internals.resolveSemgrepBinary() !== null;
}

/**
 * Bounded async availability probe used by the live batch path.
 * Caches only the result of the real shared-runner probe.
 */
export async function checkSemgrepAvailable(
	cwd?: string,
	abortSignal?: AbortSignal,
): Promise<boolean> {
	if (semgrepAvailableCache !== null) {
		return semgrepAvailableCache;
	}

	const executable = _internals.resolveSemgrepBinary();
	if (!executable) {
		semgrepAvailableCache = false;
		return false;
	}

	const run = await _internals.runExternalTool({
		executable,
		args: ['--version'],
		cwd: cwd ?? _internals.getAvailabilityProbeCwd(),
		timeoutMs: SEMGREP_AVAILABILITY_TIMEOUT_MS,
		maxStdoutBytes: SEMGREP_AVAILABILITY_MAX_STDOUT_BYTES,
		maxStderrBytes: SEMGREP_AVAILABILITY_MAX_STDERR_BYTES,
		abortSignal,
	});

	// Cancellation, timeout, spawn failure, and truncated output describe this
	// probe attempt, not Semgrep's durable availability. Caching them would let
	// one cancelled request disable Tier B for every later scan in the process.
	if (
		run.status === 'completed' &&
		run.exitCode === 0 &&
		!run.stdoutTruncated &&
		!run.stderrTruncated
	) {
		semgrepAvailableCache = true;
		return true;
	}
	return false;
}

/**
 * Reset the Semgrep availability cache (useful for testing)
 */
export function resetSemgrepCache(): void {
	semgrepAvailableCache = null;
}

/**
 * Parse Semgrep JSON output and convert to SastFinding format
 * @param semgrepOutput - Raw JSON output from Semgrep
 * @returns Array of SastFinding objects
 */
function parseSemgrepResults(semgrepOutput: string): SastFinding[] {
	const findings: SastFinding[] = [];

	try {
		const parsed = JSON.parse(semgrepOutput);

		// Handle the legacy bare-results array as well as Semgrep's structured
		// object. A completed process can still report scan/parser failures in the
		// top-level errors array, so those must invalidate the entire result.
		let results: unknown;
		if (Array.isArray(parsed)) {
			results = parsed;
		} else if (parsed && typeof parsed === 'object') {
			const output = parsed as Record<string, unknown>;
			if (output.errors !== undefined && !Array.isArray(output.errors)) {
				throw new Error('invalid Semgrep errors shape');
			}
			if (Array.isArray(output.errors) && output.errors.length > 0) {
				throw new SemgrepScanError(
					`Semgrep reported ${output.errors.length} scan error${output.errors.length === 1 ? '' : 's'}`,
				);
			}
			results = output.results;
		}

		if (!Array.isArray(results))
			throw new Error('invalid Semgrep result shape');

		for (const result of results) {
			if (!result || typeof result !== 'object' || Array.isArray(result)) {
				throw new Error('invalid Semgrep result entry');
			}
			const entry = result as Record<string, unknown>;
			const extra =
				entry.extra &&
				typeof entry.extra === 'object' &&
				!Array.isArray(entry.extra)
					? (entry.extra as Record<string, unknown>)
					: null;
			const start =
				entry.start &&
				typeof entry.start === 'object' &&
				!Array.isArray(entry.start)
					? (entry.start as Record<string, unknown>)
					: null;
			const ruleId = entry.check_id ?? entry.rule_id;
			const file = entry.path ?? start?.filename ?? entry.file;
			const line = start?.line ?? entry.line;
			const column = start?.col ?? entry.column;
			const severityValue = extra?.severity ?? entry.severity;
			const message = extra?.message ?? entry.message;
			const knownSeverities = new Set([
				'error',
				'critical',
				'warning',
				'high',
				'medium',
				'info',
				'low',
			]);
			if (
				typeof ruleId !== 'string' ||
				ruleId.length === 0 ||
				typeof file !== 'string' ||
				file.length === 0 ||
				file.includes('\0') ||
				typeof line !== 'number' ||
				!Number.isInteger(line) ||
				line < 1 ||
				(column !== undefined &&
					(typeof column !== 'number' ||
						!Number.isInteger(column) ||
						column < 1)) ||
				typeof severityValue !== 'string' ||
				!knownSeverities.has(severityValue.toLowerCase()) ||
				(message !== undefined && typeof message !== 'string') ||
				(extra?.fix !== undefined && typeof extra.fix !== 'string') ||
				(extra?.lines !== undefined && typeof extra.lines !== 'string') ||
				(entry.lines !== undefined && typeof entry.lines !== 'string')
			) {
				throw new Error('invalid Semgrep result entry');
			}
			const severity = mapSemgrepSeverity(severityValue);

			findings.push({
				rule_id: ruleId,
				severity,
				message: message ?? 'Security issue detected',
				location: {
					file,
					line,
					column: column as number | undefined,
				},
				remediation: extra?.fix as string | undefined,
				excerpt: (extra?.lines ?? entry.lines ?? '') as string,
			});
		}
	} catch (error) {
		if (error instanceof SemgrepScanError) throw error;
		throw new Error('Semgrep returned invalid JSON output', { cause: error });
	}

	return findings;
}

class SemgrepScanError extends Error {}

/**
 * Map Semgrep severity to our severity format
 * @param severity - Semgrep severity string
 * @returns Mapped severity level
 */
function mapSemgrepSeverity(
	severity: string,
): 'critical' | 'high' | 'medium' | 'low' {
	const severityLower = (severity || '').toLowerCase();

	switch (severityLower) {
		case 'error':
		case 'critical':
			return 'critical';
		case 'warning':
		case 'high':
			return 'high';
		case 'info':
		case 'low':
			return 'low';
		default:
			return 'medium';
	}
}

/**
 * Run Semgrep on specified files
 * @param options - Semgrep options
 * @returns Promise resolving to SemgrepResult
 */
export async function runSemgrep(
	options: SemgrepOptions,
): Promise<SemgrepResult> {
	const files = options.files || [];
	const rulesDir = options.rulesDir || DEFAULT_RULES_DIR;
	const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;

	// If no files to scan, return empty results
	if (files.length === 0) {
		return {
			available: _internals.isSemgrepAvailable(),
			findings: [],
			engine: 'tier_a',
		};
	}

	if (
		!(await _internals.checkSemgrepAvailable(options.cwd, options.abortSignal))
	) {
		if (options.abortSignal?.aborted) {
			return {
				available: true,
				findings: [],
				error: 'Semgrep execution cancelled',
				engine: 'tier_a',
			};
		}
		return {
			available: false,
			findings: [],
			error: 'Semgrep is not installed or not available on PATH',
			engine: 'tier_a',
		};
	}

	const executable = _internals.resolveSemgrepBinary();
	if (!executable) {
		return {
			available: false,
			findings: [],
			error: 'Semgrep is not installed or not available on PATH',
			engine: 'tier_a',
		};
	}

	const args: string[] = [
		options.useAutoConfig ? '--config=auto' : `--config=./${rulesDir}`,
		'--json',
		'--quiet',
	];
	if (options.lang) {
		args.push(`--lang=${options.lang}`);
	}
	args.push(...files);

	try {
		const result = await _internals.runExternalTool({
			executable,
			args,
			cwd: options.cwd ?? _internals.getAvailabilityProbeCwd(),
			timeoutMs,
			maxStdoutBytes: MAX_OUTPUT_BYTES,
			maxStderrBytes: MAX_OUTPUT_BYTES,
			abortSignal: options.abortSignal,
		});

		if (result.stdoutTruncated || result.stderrTruncated) {
			return {
				available: true,
				findings: [],
				error: `Semgrep output exceeded ${MAX_OUTPUT_BYTES} bytes and was truncated; results incomplete`,
				engine: 'tier_a',
			};
		}
		if (result.status !== 'completed') {
			return {
				available: true,
				findings: [],
				error:
					result.message ??
					(result.status === 'timeout'
						? 'Semgrep process timed out'
						: `Semgrep process ${result.status}`),
				engine: 'tier_a',
			};
		}

		if (result.exitCode !== 0) {
			if (result.exitCode === 1 && result.stdout) {
				const findings = parseSemgrepResults(result.stdout);
				return {
					available: true,
					findings,
					engine: 'tier_a+tier_b',
				};
			}

			return {
				available: true,
				findings: [],
				error: result.stderr || `Semgrep exited with code ${result.exitCode}`,
				engine: 'tier_a',
			};
		}

		const findings = parseSemgrepResults(result.stdout);

		return {
			available: true,
			findings,
			engine: 'tier_a+tier_b',
		};
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : 'Unknown error running Semgrep';

		return {
			available: true,
			findings: [],
			error: errorMessage,
			engine: 'tier_a',
		};
	}
}

/**
 * Get the default rules directory path
 * @param projectRoot - Optional project root directory
 * @returns Absolute path to rules directory
 */
export function getRulesDirectory(projectRoot?: string): string {
	if (projectRoot) {
		return path.resolve(projectRoot, DEFAULT_RULES_DIR);
	}
	return DEFAULT_RULES_DIR;
}

/**
 * Check if bundled rules directory exists
 * @param projectRoot - Optional project root directory
 * @returns true if rules directory exists
 */
export function hasBundledRules(projectRoot?: string): boolean {
	const rulesDir = getRulesDirectory(projectRoot);
	try {
		return fs.existsSync(rulesDir);
	} catch {
		return false;
	}
}
