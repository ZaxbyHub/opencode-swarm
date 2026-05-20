/**
 * Preflight Automation Service
 *
 * Runs automated preflight checks for release readiness:
 * - lint check
 * - tests check (sane verification scope)
 * - secrets check
 * - evidence completeness check
 * - version consistency check
 *
 * Returns deterministic structured result with per-check status + overall verdict.
 * Callable by background flow (from preflight.requested events).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	checkRequirementCoverage,
	listEvidenceTaskIds,
} from '../evidence/manager';
import { loadPlan } from '../plan/manager';
import { runLint } from '../tools/lint';
import { runSecretscan, type SecretscanResult } from '../tools/secretscan';
import { runTests, type TestResult } from '../tools/test-runner';
import { log } from '../utils';

/** Preflight check types */
export type PreflightCheckType =
	| 'lint'
	| 'tests'
	| 'secrets'
	| 'evidence'
	| 'version'
	| 'req_coverage';

/** Individual check status */
export interface PreflightCheckResult {
	type: PreflightCheckType;
	status: 'pass' | 'fail' | 'skip' | 'error';
	message: string;
	details?: Record<string, unknown>;
	durationMs?: number;
}

/** Preflight report structure */
export interface PreflightReport {
	id: string;
	timestamp: number;
	phase: number;
	overall: 'pass' | 'fail' | 'skipped';
	checks: PreflightCheckResult[];
	totalDurationMs: number;
	message: string;
}

/** Preflight configuration */
export interface PreflightConfig {
	/** Timeout per check in ms (default 60s, min 5s, max 300s) */
	checkTimeoutMs?: number;
	/** Skip tests check (default false) */
	skipTests?: boolean;
	/** Skip secrets check (default false) */
	skipSecrets?: boolean;
	/** Skip evidence check (default false) */
	skipEvidence?: boolean;
	/** Skip version check (default false) */
	skipVersion?: boolean;
	/** Test scope (default 'convention' for faster preflight) */
	testScope?: 'all' | 'convention' | 'graph';
	/** Linter to use (default 'biome') */
	linter?: 'biome' | 'eslint';
}

/** Minimum allowed timeout per check (5 seconds) */
const MIN_CHECK_TIMEOUT_MS = 5000;
/** Maximum allowed timeout per check (5 minutes) */
const MAX_CHECK_TIMEOUT_MS = 300_000;

/** Default configuration */
const DEFAULT_CONFIG: Required<PreflightConfig> = {
	checkTimeoutMs: 60000,
	skipTests: false,
	skipSecrets: false,
	skipEvidence: false,
	skipVersion: false,
	testScope: 'convention',
	linter: 'biome',
};

/**
 * Validate directory path to prevent path traversal attacks.
 * Returns the normalized absolute path if valid, or throws an error.
 */
function validateDirectoryPath(dir: string): string {
	// Check for null/undefined/empty
	if (!dir || typeof dir !== 'string') {
		throw new Error('Directory path is required');
	}

	// Check for path traversal sequences
	if (dir.includes('..')) {
		throw new Error('Directory path must not contain path traversal sequences');
	}

	// Normalize and resolve to absolute path
	const normalized = path.normalize(dir);
	const absolutePath = path.isAbsolute(normalized)
		? normalized
		: path.resolve(normalized);

	return absolutePath;
}

/**
 * Validate and sanitize timeout value.
 * Returns a valid timeout within bounds, or throws an error for invalid values.
 */
function validateTimeout(
	timeoutMs: number | undefined,
	defaultValue: number,
): number {
	if (timeoutMs === undefined) {
		return defaultValue;
	}

	if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs)) {
		throw new Error('Timeout must be a finite number');
	}

	if (timeoutMs <= 0) {
		throw new Error('Timeout must be greater than 0');
	}

	if (timeoutMs < MIN_CHECK_TIMEOUT_MS) {
		throw new Error(
			`Timeout must be at least ${MIN_CHECK_TIMEOUT_MS}ms (5 seconds)`,
		);
	}

	if (timeoutMs > MAX_CHECK_TIMEOUT_MS) {
		throw new Error(
			`Timeout must not exceed ${MAX_CHECK_TIMEOUT_MS}ms (5 minutes)`,
		);
	}

	return timeoutMs;
}

/**
 * Get package.json version from directory
 */
function getPackageVersion(dir: string): string | null {
	try {
		const packagePath = path.join(dir, 'package.json');
		if (fs.existsSync(packagePath)) {
			const content = fs.readFileSync(packagePath, 'utf-8');
			const pkg = JSON.parse(content);
			return pkg.version ?? null;
		}
	} catch {
		// Ignore errors
	}
	return null;
}

/**
 * Get version from CHANGELOG.md (latest version header)
 */
function getChangelogVersion(dir: string): string | null {
	try {
		const changelogPath = path.join(dir, 'CHANGELOG.md');
		if (fs.existsSync(changelogPath)) {
			const content = fs.readFileSync(changelogPath, 'utf-8');
			// Match first version header like "## [1.2.3]" or "## 1.2.3"
			const match = content.match(/^##\s*\[?(\d+\.\d+\.\d+)\]?/m);
			if (match) {
				return match[1];
			}
		}
	} catch {
		// Ignore errors
	}
	return null;
}

/**
 * Get version from version file (e.g., VERSION.txt, version.txt)
 */
function getVersionFileVersion(dir: string): string | null {
	const possibleFiles = ['VERSION.txt', 'version.txt', 'VERSION', 'version'];
	for (const file of possibleFiles) {
		const filePath = path.join(dir, file);
		if (fs.existsSync(filePath)) {
			try {
				const content = fs.readFileSync(filePath, 'utf-8').trim();
				// Match semver pattern
				const match = content.match(/(\d+\.\d+\.\d+)/);
				if (match) {
					return match[1];
				}
			} catch {
				// Continue to next file
			}
		}
	}
	return null;
}

/**
 * Run version consistency check
 */
async function runVersionCheck(
	dir: string,
	_timeoutMs: number,
): Promise<PreflightCheckResult> {
	const startTime = Date.now();

	try {
		const packageVersion = _internals.getPackageVersion(dir);
		const changelogVersion = _internals.getChangelogVersion(dir);
		const versionFileVersion = _internals.getVersionFileVersion(dir);

		const versions: string[] = [];
		if (packageVersion) versions.push(`package.json: ${packageVersion}`);
		if (changelogVersion) versions.push(`CHANGELOG.md: ${changelogVersion}`);
		if (versionFileVersion)
			versions.push(`version file: ${versionFileVersion}`);

		// Check consistency
		const uniqueVersions = new Set(
			[packageVersion, changelogVersion, versionFileVersion].filter(Boolean),
		);

		if (uniqueVersions.size <= 1) {
			// All consistent or no versions found
			if (versions.length === 0) {
				return {
					type: 'version',
					status: 'skip',
					message: 'No version information found to check',
					details: {},
					durationMs: Date.now() - startTime,
				};
			}
			return {
				type: 'version',
				status: 'pass',
				message: `Version consistent: ${versions.join(', ')}`,
				details: {
					packageVersion,
					changelogVersion,
					versionFileVersion,
				},
				durationMs: Date.now() - startTime,
			};
		}

		// Versions don't match
		return {
			type: 'version',
			status: 'fail',
			message: `Version mismatch: ${versions.join('; ')}`,
			details: {
				packageVersion,
				changelogVersion,
				versionFileVersion,
			},
			durationMs: Date.now() - startTime,
		};
	} catch (error) {
		return {
			type: 'version',
			status: 'error',
			message: `Version check failed: ${error instanceof Error ? error.message : String(error)}`,
			durationMs: Date.now() - startTime,
		};
	}
}

/**
 * Run lint check
 */
async function runLintCheck(
	dir: string,
	linter: 'biome' | 'eslint',
	timeoutMs: number,
): Promise<PreflightCheckResult> {
	const startTime = Date.now();

	try {
		// Race the lint execution with a timeout
		const lintPromise = runLint(linter, 'check', dir);
		let timeoutId: ReturnType<typeof setTimeout>;
		const timeoutPromise = new Promise<never>((_, reject) => {
			timeoutId = setTimeout(() => {
				reject(new Error(`Lint check timed out after ${timeoutMs}ms`));
			}, timeoutMs);
		});

		const result = await Promise.race([lintPromise, timeoutPromise]).finally(
			() => clearTimeout(timeoutId),
		);

		// Determine status based on result
		if (!result.success) {
			return {
				type: 'lint',
				status: 'error',
				message: result.error ?? 'Lint check failed',
				details: {
					linter,
					success: result.success,
				},
				durationMs: Date.now() - startTime,
			};
		}

		// Check for lint issues (non-zero exit code indicates issues found)
		if (result.exitCode !== 0) {
			// Extract issue count from output if possible
			const issueMatch = result.output.match(/(\d+)\s+(issues?|errors?)/i);
			const issueCount = issueMatch ? parseInt(issueMatch[1], 10) : undefined;

			return {
				type: 'lint',
				status: 'fail',
				message: issueCount
					? `Lint found ${issueCount} issue(s)`
					: 'Lint found issues',
				details: {
					linter,
					exitCode: result.exitCode,
					issueCount,
					hasOutput: result.output.length > 0,
				},
				durationMs: Date.now() - startTime,
			};
		}

		return {
			type: 'lint',
			status: 'pass',
			message: 'Lint check passed',
			details: {
				linter,
				exitCode: result.exitCode,
			},
			durationMs: Date.now() - startTime,
		};
	} catch (error) {
		// Check for timeout
		if (error instanceof Error && error.message.includes('timed out')) {
			return {
				type: 'lint',
				status: 'error',
				message: error.message,
				details: { linter },
				durationMs: Date.now() - startTime,
			};
		}

		return {
			type: 'lint',
			status: 'error',
			message: `Lint check failed: ${error instanceof Error ? error.message : String(error)}`,
			details: { linter },
			durationMs: Date.now() - startTime,
		};
	}
}

/**
 * Run tests check
 */
async function runTestsCheck(
	_dir: string,
	scope: 'all' | 'convention' | 'graph',
	timeoutMs: number,
): Promise<PreflightCheckResult> {
	const startTime = Date.now();

	try {
		const result: TestResult = await runTests(
			'none', // Auto-detect
			scope,
			[],
			false, // No coverage for preflight
			timeoutMs,
			_dir,
		);

		if (!result.success) {
			return {
				type: 'tests',
				status: 'error',
				message: result.error ?? 'Tests check failed',
				details: {
					framework: result.framework,
					scope,
					success: result.success,
				},
				durationMs: Date.now() - startTime,
			};
		}

		// Check if tests passed
		if (result.totals.failed > 0) {
			return {
				type: 'tests',
				status: 'fail',
				message: `Tests failed: ${result.totals.failed}/${result.totals.total} failed`,
				details: {
					framework: result.framework,
					scope,
					totals: result.totals,
				},
				durationMs: Date.now() - startTime,
			};
		}

		if (result.totals.total === 0) {
			return {
				type: 'tests',
				status: 'skip',
				message: 'No tests found to run',
				details: { framework: result.framework, scope },
				durationMs: Date.now() - startTime,
			};
		}

		return {
			type: 'tests',
			status: 'pass',
			message: `Tests passed: ${result.totals.passed} passed`,
			details: {
				framework: result.framework,
				scope,
				totals: result.totals,
			},
			durationMs: Date.now() - startTime,
		};
	} catch (error) {
		// Check for timeout indicators in error
		if (
			error instanceof Error &&
			(error.message.includes('timeout') || error.message.includes('ETIMEDOUT'))
		) {
			return {
				type: 'tests',
				status: 'error',
				message: `Tests check timed out after ${timeoutMs}ms`,
				durationMs: Date.now() - startTime,
			};
		}

		return {
			type: 'tests',
			status: 'error',
			message: `Tests check failed: ${error instanceof Error ? error.message : String(error)}`,
			durationMs: Date.now() - startTime,
		};
	}
}

/**
 * Run secrets check
 */
async function runSecretsCheck(
	dir: string,
	timeoutMs: number,
): Promise<PreflightCheckResult> {
	const startTime = Date.now();

	try {
		// Race the secretscan execution with a timeout
		const secretsPromise = runSecretscan(dir);
		const timeoutPromise = new Promise<never>((_, reject) => {
			setTimeout(() => {
				reject(new Error(`Secrets check timed out after ${timeoutMs}ms`));
			}, timeoutMs);
		});

		const result: SecretscanResult = await Promise.race([
			secretsPromise,
			timeoutPromise,
		]);

		if (result.findings && result.findings.length > 0) {
			// Group by severity
			const critical = result.findings.filter(
				(f) => f.severity === 'critical',
			).length;
			const high = result.findings.filter((f) => f.severity === 'high').length;

			return {
				type: 'secrets',
				status: 'fail',
				message: `Found ${result.findings.length} secret(s): ${critical} critical, ${high} high`,
				details: {
					count: result.count,
					critical,
					high,
					filesScanned: result.files_scanned,
				},
				durationMs: Date.now() - startTime,
			};
		}

		return {
			type: 'secrets',
			status: 'pass',
			message: 'No secrets detected',
			details: {
				filesScanned: result.files_scanned,
			},
			durationMs: Date.now() - startTime,
		};
	} catch (error) {
		if (error instanceof Error && error.name === 'AbortError') {
			return {
				type: 'secrets',
				status: 'error',
				message: `Secrets check timed out after ${timeoutMs}ms`,
				durationMs: Date.now() - startTime,
			};
		}

		return {
			type: 'secrets',
			status: 'error',
			message: `Secrets check failed: ${error instanceof Error ? error.message : String(error)}`,
			durationMs: Date.now() - startTime,
		};
	}
}

/**
 * Run evidence completeness check
 */
async function runEvidenceCheck(dir: string): Promise<PreflightCheckResult> {
	const startTime = Date.now();

	try {
		// Load plan to get completed tasks
		const plan = await loadPlan(dir);

		if (!plan) {
			return {
				type: 'evidence',
				status: 'skip',
				message: 'No plan found to check evidence against',
				details: {},
				durationMs: Date.now() - startTime,
			};
		}

		// Get completed task IDs
		const completedTaskIds: string[] = [];
		for (const phase of plan.phases) {
			for (const task of phase.tasks) {
				if (task.status === 'completed') {
					completedTaskIds.push(task.id);
				}
			}
		}

		if (completedTaskIds.length === 0) {
			return {
				type: 'evidence',
				status: 'skip',
				message: 'No completed tasks yet',
				details: { completedTasks: 0 },
				durationMs: Date.now() - startTime,
			};
		}

		// Get evidence task IDs
		const evidenceTaskIds = new Set(await listEvidenceTaskIds(dir));

		// Find missing evidence
		const missingEvidence = completedTaskIds.filter(
			(id) => !evidenceTaskIds.has(id),
		);

		if (missingEvidence.length > 0) {
			return {
				type: 'evidence',
				status: 'fail',
				message: `${missingEvidence.length} completed task(s) missing evidence`,
				details: {
					totalCompleted: completedTaskIds.length,
					totalWithEvidence: evidenceTaskIds.size,
					missingTasks: missingEvidence.slice(0, 10), // Limit detail
					missingCount: missingEvidence.length,
				},
				durationMs: Date.now() - startTime,
			};
		}

		return {
			type: 'evidence',
			status: 'pass',
			message: `All ${completedTaskIds.length} completed tasks have evidence`,
			details: {
				totalCompleted: completedTaskIds.length,
				totalWithEvidence: evidenceTaskIds.size,
			},
			durationMs: Date.now() - startTime,
		};
	} catch (error) {
		return {
			type: 'evidence',
			status: 'error',
			message: `Evidence check failed: ${error instanceof Error ? error.message : String(error)}`,
			durationMs: Date.now() - startTime,
		};
	}
}

/**
 * Run requirement coverage check
 */
async function runRequirementCoverageCheck(
	dir: string,
	currentPhase: number,
): Promise<PreflightCheckResult> {
	const startTime = Date.now();

	try {
		const specPath = path.join(dir, '.swarm', 'spec.md');

		// Check if spec.md exists
		if (!fs.existsSync(specPath)) {
			return {
				type: 'req_coverage',
				status: 'skip',
				message: 'No spec found, requirement coverage not required',
				details: {},
				durationMs: Date.now() - startTime,
			};
		}

		// Check if coverage file exists for current phase
		const coverage = await checkRequirementCoverage(currentPhase, dir);

		if (coverage.exists) {
			return {
				type: 'req_coverage',
				status: 'pass',
				message: 'Requirement coverage report found',
				details: { path: coverage.path },
				durationMs: Date.now() - startTime,
			};
		}

		return {
			type: 'req_coverage',
			status: 'fail',
			message: 'Requirement coverage report missing but spec exists',
			details: { expectedPath: coverage.path },
			durationMs: Date.now() - startTime,
		};
	} catch (error) {
		return {
			type: 'req_coverage',
			status: 'error',
			message: `Requirement coverage check failed: ${error instanceof Error ? error.message : String(error)}`,
			durationMs: Date.now() - startTime,
		};
	}
}

/**
 * Run all preflight checks
 */
export async function runPreflight(
	dir: string,
	phase: number,
	config?: PreflightConfig,
): Promise<PreflightReport> {
	const startTime = Date.now();
	const reportId = `preflight-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

	// Validate directory path to prevent path traversal
	let validatedDir: string;
	try {
		validatedDir = _internals.validateDirectoryPath(dir);
	} catch (error) {
		return {
			id: reportId,
			timestamp: startTime,
			phase,
			overall: 'fail',
			checks: [
				{
					type: 'lint',
					status: 'error',
					message: `Invalid directory: ${error instanceof Error ? error.message : String(error)}`,
				},
			],
			totalDurationMs: Date.now() - startTime,
			message: 'Preflight aborted: invalid directory',
		};
	}

	// Validate timeout configuration
	let validatedTimeout: number;
	try {
		validatedTimeout = _internals.validateTimeout(
			config?.checkTimeoutMs,
			DEFAULT_CONFIG.checkTimeoutMs,
		);
	} catch (error) {
		return {
			id: reportId,
			timestamp: startTime,
			phase,
			overall: 'fail',
			checks: [
				{
					type: 'lint',
					status: 'error',
					message: `Invalid config: ${error instanceof Error ? error.message : String(error)}`,
				},
			],
			totalDurationMs: Date.now() - startTime,
			message: 'Preflight aborted: invalid configuration',
		};
	}

	// Merge with defaults
	const cfg: Required<PreflightConfig> = {
		checkTimeoutMs: validatedTimeout,
		skipTests: config?.skipTests ?? DEFAULT_CONFIG.skipTests,
		skipSecrets: config?.skipSecrets ?? DEFAULT_CONFIG.skipSecrets,
		skipEvidence: config?.skipEvidence ?? DEFAULT_CONFIG.skipEvidence,
		skipVersion: config?.skipVersion ?? DEFAULT_CONFIG.skipVersion,
		testScope: config?.testScope ?? DEFAULT_CONFIG.testScope,
		linter: config?.linter ?? DEFAULT_CONFIG.linter,
	};

	// Reduced logging - no sensitive path info, just phase and config flags
	log('[Preflight] Starting preflight checks', {
		reportId,
		phase,
		config: {
			skipTests: cfg.skipTests,
			skipSecrets: cfg.skipSecrets,
			skipEvidence: cfg.skipEvidence,
			skipVersion: cfg.skipVersion,
			testScope: cfg.testScope,
			linter: cfg.linter,
			// Note: timeout value not logged to avoid sensitive timing info
		},
	});

	const checks: PreflightCheckResult[] = [];

	// Run lint check
	log('[Preflight] Running lint check...');
	const lintResult = await _internals.runLintCheck(
		validatedDir,
		cfg.linter,
		cfg.checkTimeoutMs,
	);
	checks.push(lintResult);
	log(`[Preflight] Lint check: ${lintResult.status} ${lintResult.message}`);

	// Run tests check (unless skipped)
	if (!cfg.skipTests) {
		log('[Preflight] Running tests check...');
		const testsResult = await _internals.runTestsCheck(
			validatedDir,
			cfg.testScope,
			cfg.checkTimeoutMs,
		);
		checks.push(testsResult);
		log(
			`[Preflight] Tests check: ${testsResult.status} ${testsResult.message}`,
		);
	} else {
		checks.push({
			type: 'tests',
			status: 'skip',
			message: 'Tests check skipped by configuration',
		});
	}

	// Run secrets check (unless skipped)
	if (!cfg.skipSecrets) {
		log('[Preflight] Running secrets check...');
		const secretsResult = await _internals.runSecretsCheck(
			validatedDir,
			cfg.checkTimeoutMs,
		);
		checks.push(secretsResult);
		log(
			`[Preflight] Secrets check: ${secretsResult.status} ${secretsResult.message}`,
		);
	} else {
		checks.push({
			type: 'secrets',
			status: 'skip',
			message: 'Secrets check skipped by configuration',
		});
	}

	// Run evidence check (unless skipped)
	if (!cfg.skipEvidence) {
		log('[Preflight] Running evidence check...');
		const evidenceResult = await _internals.runEvidenceCheck(validatedDir);
		checks.push(evidenceResult);
		log(
			`[Preflight] Evidence check: ${evidenceResult.status} ${evidenceResult.message}`,
		);
	} else {
		checks.push({
			type: 'evidence',
			status: 'skip',
			message: 'Evidence check skipped by configuration',
		});
	}

	// Run requirement coverage check
	log('[Preflight] Running requirement coverage check...');
	const reqCoverageResult = await _internals.runRequirementCoverageCheck(
		validatedDir,
		phase,
	);
	checks.push(reqCoverageResult);
	log(
		`[Preflight] Requirement coverage check: ${reqCoverageResult.status} ${reqCoverageResult.message}`,
	);

	// Run version check (unless skipped)
	if (!cfg.skipVersion) {
		log('[Preflight] Running version check...');
		const versionResult = await _internals.runVersionCheck(
			validatedDir,
			cfg.checkTimeoutMs,
		);
		checks.push(versionResult);
		log(
			`[Preflight] Version check: ${versionResult.status} ${versionResult.message}`,
		);
	} else {
		checks.push({
			type: 'version',
			status: 'skip',
			message: 'Version check skipped by configuration',
		});
	}

	// Calculate overall result
	const totalDurationMs = Date.now() - startTime;
	const failedChecks = checks.filter((c) => c.status === 'fail').length;
	const errorChecks = checks.filter((c) => c.status === 'error').length;
	const skippedChecks = checks.filter((c) => c.status === 'skip').length;

	let overall: PreflightReport['overall'];
	let message: string;

	if (errorChecks > 0) {
		overall = 'fail';
		message = `Preflight failed with ${errorChecks} error(s)`;
	} else if (failedChecks > 0) {
		overall = 'fail';
		message = `Preflight failed: ${failedChecks} check(s) failed`;
	} else if (skippedChecks === checks.length) {
		overall = 'skipped';
		message = 'All checks were skipped';
	} else {
		overall = 'pass';
		message = 'Preflight passed all checks';
	}

	log(`[Preflight] Complete: ${overall} ${message}`);

	return {
		id: reportId,
		timestamp: startTime,
		phase,
		overall,
		checks,
		totalDurationMs,
		message,
	};
}

/**
 * Format preflight report as markdown
 */
export function formatPreflightMarkdown(report: PreflightReport): string {
	const lines = [
		'## Preflight Report',
		'',
		`**Phase**: ${report.phase}`,
		`**Overall**: ${report.overall === 'pass' ? '✅ PASS' : report.overall === 'fail' ? '❌ FAIL' : '⏭️ SKIPPED'}`,
		`**Duration**: ${(report.totalDurationMs / 1000).toFixed(2)}s`,
		'',
		'### Checks',
		'',
	];

	for (const check of report.checks) {
		const icon =
			check.status === 'pass'
				? '✅'
				: check.status === 'fail'
					? '❌'
					: check.status === 'error'
						? '⚠️'
						: '⏭️';
		lines.push(`- ${icon} **${check.type}**: ${check.message}`);
	}

	lines.push('');
	lines.push(report.message);

	return lines.join('\n');
}

/**
 * Handle preflight command - thin adapter for CLI
 */
export async function handlePreflightCommand(
	directory: string,
	_args: string[],
): Promise<string> {
	const plan = await loadPlan(directory);
	const phase = plan?.current_phase ?? 1;
	const report = await _internals.runPreflight(directory, phase);
	return _internals.formatPreflightMarkdown(report);
}

/**
 * DI seam for testability. Contains all test-mocked exports.
 * Internal calls should use _internals.fn() instead of fn() directly.
 */
export const _internals: {
	runPreflight: typeof runPreflight;
	formatPreflightMarkdown: typeof formatPreflightMarkdown;
	handlePreflightCommand: typeof handlePreflightCommand;
	validateDirectoryPath: typeof validateDirectoryPath;
	validateTimeout: typeof validateTimeout;
	getPackageVersion: typeof getPackageVersion;
	getChangelogVersion: typeof getChangelogVersion;
	getVersionFileVersion: typeof getVersionFileVersion;
	runVersionCheck: typeof runVersionCheck;
	runLintCheck: typeof runLintCheck;
	runTestsCheck: typeof runTestsCheck;
	runSecretsCheck: typeof runSecretsCheck;
	runEvidenceCheck: typeof runEvidenceCheck;
	runRequirementCoverageCheck: typeof runRequirementCoverageCheck;
} = {
	runPreflight,
	formatPreflightMarkdown,
	handlePreflightCommand,
	validateDirectoryPath,
	validateTimeout,
	getPackageVersion,
	getChangelogVersion,
	getVersionFileVersion,
	runVersionCheck,
	runLintCheck,
	runTestsCheck,
	runSecretsCheck,
	runEvidenceCheck,
	runRequirementCoverageCheck,
} as const;
