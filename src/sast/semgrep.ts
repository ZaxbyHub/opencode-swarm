/**
 * Semgrep Integration for Tier B SAST Enhancement
 * Provides optional Semgrep detection and invocation for advanced static analysis
 */

import * as child_process from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
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
 * Cached Semgrep availability status
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

/**
 * Per-stream cap on accumulated stdout/stderr from the Semgrep subprocess.
 * AGENTS.md invariant 3 requires bounded stdio: a misbehaving binary must
 * not be able to exhaust memory by streaming unbounded output. Once a
 * stream exceeds this cap we stop accumulating and terminate the child.
 */
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // 10MB per stream

/**
 * Grace window between SIGTERM and SIGKILL when force-terminating the child.
 * On Windows SIGTERM is best-effort; the SIGKILL escalation guarantees the
 * orphaned process is reaped (AGENTS.md invariant 3 — killable subprocesses).
 */
const KILL_GRACE_MS = 2000;

export const _internals: {
	isSemgrepAvailable: typeof isSemgrepAvailable;
	checkSemgrepAvailable: typeof checkSemgrepAvailable;
	resetSemgrepCache: typeof resetSemgrepCache;
	runSemgrep: typeof runSemgrep;
	getRulesDirectory: typeof getRulesDirectory;
	hasBundledRules: typeof hasBundledRules;
	executeWithTimeout: typeof executeWithTimeout;
} = {
	isSemgrepAvailable,
	checkSemgrepAvailable,
	resetSemgrepCache,
	runSemgrep,
	getRulesDirectory,
	hasBundledRules,
	executeWithTimeout,
} as const;

/**
 * Check if Semgrep CLI is available on the system
 * Uses caching to avoid shelling out on every check
 * @returns true if Semgrep is available, false otherwise
 */
export function isSemgrepAvailable(): boolean {
	// Return cached result if available
	if (semgrepAvailableCache !== null) {
		return semgrepAvailableCache;
	}

	try {
		// Try to run semgrep --version using execFileSync (safer than exec)
		child_process.execFileSync('semgrep', ['--version'], {
			encoding: 'utf-8',
			stdio: 'pipe',
		});
		semgrepAvailableCache = true;
		return true;
	} catch {
		semgrepAvailableCache = false;
		return false;
	}
}

/**
 * Check if Semgrep is available (async version for consistency)
 * @returns Promise resolving to availability status
 */
export async function checkSemgrepAvailable(): Promise<boolean> {
	return _internals.isSemgrepAvailable();
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

		// Handle different Semgrep output formats
		const results = parsed.results || parsed;

		if (!Array.isArray(results)) {
			return [];
		}

		for (const result of results) {
			if (!result || typeof result !== 'object') continue;
			const severity = mapSemgrepSeverity(
				result.extra?.severity || result.severity,
			);

			findings.push({
				rule_id: result.check_id || result.rule_id || 'unknown',
				severity,
				message:
					result.extra?.message || result.message || 'Security issue detected',
				location: {
					file:
						result.path || result.start?.filename || result.file || 'unknown',
					line: result.start?.line || result.line || 1,
					column: result.start?.col || result.column,
				},
				remediation: result.extra?.fix,
				excerpt: result.extra?.lines || result.lines || '',
			});
		}
	} catch {
		// If JSON parsing fails, return empty findings
		// This handles cases where Semgrep returns non-JSON output
		return [];
	}

	return findings;
}

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
 * Execute a command with timeout
 * @param command - Command to execute
 * @param args - Command arguments (safe array, no shell injection)
 * @param options - Execution options including timeout
 * @returns Promise resolving to command output
 */
async function executeWithTimeout(
	command: string,
	args: string[],
	options: { cwd?: string; timeoutMs: number; maxOutputBytes?: number },
): Promise<{
	stdout: string;
	stderr: string;
	exitCode: number;
	truncated: boolean;
}> {
	const maxOutputBytes = options.maxOutputBytes ?? MAX_OUTPUT_BYTES;
	return new Promise((resolve) => {
		// Use spawn with args array and NO shell to prevent command injection.
		// stdin: 'ignore' (AGENTS.md invariant 3) — a never-closed stdin pipe
		// under Bun on Windows can block the child from exiting.
		const child = child_process.spawn(command, args, {
			shell: false, // SECURITY FIX: prevent shell injection
			cwd: options.cwd,
			stdio: ['ignore', 'pipe', 'pipe'],
		});

		let stdout = '';
		let stderr = '';
		let stdoutTruncated = false;
		let stderrTruncated = false;
		let settled = false;
		let timeout: ReturnType<typeof setTimeout> | undefined;

		/**
		 * Resolve exactly once, always clearing the timeout and guaranteeing a
		 * best-effort terminate of the child regardless of which event settled
		 * the promise (AGENTS.md invariant 3: an outer timeout alone lets the
		 * awaiter proceed but does not abort the child). If the child already
		 * exited (close event) the kill calls are harmless no-ops.
		 */
		const settle = (result: {
			stdout: string;
			stderr: string;
			exitCode: number;
		}): void => {
			if (settled) return;
			settled = true;
			if (timeout) clearTimeout(timeout);
			const truncated = stdoutTruncated || stderrTruncated;
			if (child.exitCode === null && child.signalCode === null) {
				try {
					child.kill('SIGTERM');
				} catch {
					// process may already be gone
				}
				const escalation = setTimeout(() => {
					try {
						child.kill('SIGKILL');
					} catch {
						// process may already be gone
					}
				}, KILL_GRACE_MS);
				if (
					typeof (escalation as { unref?: () => void }).unref === 'function'
				) {
					(escalation as { unref: () => void }).unref();
				}
			}
			resolve({ ...result, truncated });
		};

		timeout = setTimeout(() => {
			settle({
				stdout,
				stderr: 'Process timed out',
				exitCode: 124, // Common timeout exit code
			});
		}, options.timeoutMs);
		if (typeof (timeout as { unref?: () => void }).unref === 'function') {
			(timeout as { unref: () => void }).unref();
		}

		child.stdout?.on('data', (data) => {
			if (stdoutTruncated) return;
			const chunk = data.toString();
			if (stdout.length + chunk.length > maxOutputBytes) {
				stdout += chunk.slice(0, Math.max(0, maxOutputBytes - stdout.length));
				stdoutTruncated = true;
				// Runaway output — terminate so we stop accumulating. The close
				// event then settles with the truncated buffer.
				try {
					child.kill('SIGTERM');
				} catch {
					// already gone
				}
			} else {
				stdout += chunk;
			}
		});

		child.stderr?.on('data', (data) => {
			if (stderrTruncated) return;
			const chunk = data.toString();
			if (stderr.length + chunk.length > maxOutputBytes) {
				stderr += chunk.slice(0, Math.max(0, maxOutputBytes - stderr.length));
				stderrTruncated = true;
			} else {
				stderr += chunk;
			}
		});

		child.on('close', (code) => {
			settle({
				stdout,
				stderr,
				exitCode: code ?? 0,
			});
		});

		child.on('error', (err) => {
			settle({
				stdout,
				stderr: err.message,
				exitCode: 1,
			});
		});
	});
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

	// Check Semgrep availability
	if (!_internals.isSemgrepAvailable()) {
		return {
			available: false,
			findings: [],
			error: 'Semgrep is not installed or not available on PATH',
			engine: 'tier_a',
		};
	}

	// Build the Semgrep command arguments (safe array, no shell injection)
	const args: string[] = [
		options.useAutoConfig ? '--config=auto' : `--config=./${rulesDir}`,
		'--json',
		'--quiet', // Only output findings
	];
	if (options.lang) {
		args.push(`--lang=${options.lang}`);
	}
	args.push(...files);

	try {
		const result = await executeWithTimeout('semgrep', args, {
			timeoutMs,
			cwd: options.cwd,
		});

		// Output was capped mid-stream: the JSON is incomplete and would parse to
		// zero findings. Surface that as an error (engine: tier_a) rather than
		// silently reporting a clean scan — a SAST gate must never fail open
		// because the scanner produced too much output.
		if (result.truncated) {
			return {
				available: true,
				findings: [],
				error: `Semgrep output exceeded ${MAX_OUTPUT_BYTES} bytes and was truncated; results incomplete`,
				engine: 'tier_a',
			};
		}

		if (result.exitCode !== 0) {
			// Semgrep returned non-zero exit code
			// This can happen when findings are detected (exit code 1)
			// or when there's an actual error (exit code > 1)
			if (result.exitCode === 1 && result.stdout) {
				// Exit code 1 means findings were found - this is actually OK
				const findings = parseSemgrepResults(result.stdout);
				return {
					available: true,
					findings,
					engine: 'tier_a+tier_b',
				};
			}

			// Other exit codes indicate errors
			return {
				available: true,
				findings: [],
				error: result.stderr || `Semgrep exited with code ${result.exitCode}`,
				engine: 'tier_a',
			};
		}

		// Parse results from stdout
		const findings = parseSemgrepResults(result.stdout);

		return {
			available: true,
			findings,
			engine: 'tier_a+tier_b',
		};
	} catch (error) {
		// Handle any unexpected errors gracefully
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
