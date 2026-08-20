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
import { z } from 'zod';
import { getDurableGateEvidenceStatusForTask } from '../evidence/gate-bridge.js';
import {
	checkRequirementCoverage,
	listEvidenceTaskIds,
} from '../evidence/manager';
import { loadPlan } from '../plan/manager';
import { readEffectiveSpecSync } from '../sdd/effective-spec';
import { runLint } from '../tools/lint';
import {
	runSecretscan,
	type SecretscanErrorResult,
	type SecretscanResult,
} from '../tools/secretscan';
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

function formatSecretscanIncompletePaths(
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
			false, // No bail for preflight
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
		const secretsPromise = _internals.runSecretscan(dir);
		const timeoutPromise = new Promise<never>((_, reject) => {
			setTimeout(() => {
				reject(new Error(`Secrets check timed out after ${timeoutMs}ms`));
			}, timeoutMs);
		});

		const result: SecretscanResult | SecretscanErrorResult = await Promise.race(
			[secretsPromise, timeoutPromise],
		);

		if ('error' in result) {
			return {
				type: 'secrets',
				status: 'fail',
				message: `Secrets check failed: ${result.error}`,
				details: {
					error: result.error,
					filesScanned: result.files_scanned,
					incompleteFiles: 0,
					incompletePaths: [],
				},
				durationMs: Date.now() - startTime,
			};
		}

		const findingsCount = Math.max(result.count, result.findings.length);
		if (
			typeof result.incomplete_files !== 'number' ||
			!Array.isArray(result.incomplete_paths)
		) {
			return {
				type: 'secrets',
				status: 'fail',
				message:
					'Secrets check failed: scanner returned incomplete coverage metadata',
				details: { filesScanned: result.files_scanned },
				durationMs: Date.now() - startTime,
			};
		}
		const incompleteFiles = result.incomplete_files;
		const incompletePaths = result.incomplete_paths;
		const hasCountMismatch = result.count !== result.findings.length;
		const hasIncompleteCoverage =
			incompleteFiles > 0 || incompletePaths.length > 0;
		const hasZeroCoverage = result.files_scanned === 0;

		const failures: string[] = [];
		if (findingsCount > 0) {
			const critical = result.findings.filter(
				(f) => f.severity === 'critical',
			).length;
			const high = result.findings.filter((f) => f.severity === 'high').length;
			failures.push(
				`Found ${findingsCount} secret(s): ${critical} critical, ${high} high`,
			);
		}
		if (hasIncompleteCoverage) {
			const incompleteSummary =
				incompletePaths.length > 0
					? `; incomplete paths: ${formatSecretscanIncompletePaths(incompletePaths)}`
					: '';
			failures.push(
				`${incompleteFiles} incomplete file(s)${incompleteSummary}`,
			);
		}
		if (hasCountMismatch) {
			failures.push(
				`findings/count mismatch (reported ${result.count}, actual ${result.findings.length})`,
			);
		}
		if (hasZeroCoverage) {
			failures.push('zero requested files scanned');
		}

		if (failures.length > 0) {
			return {
				type: 'secrets',
				status: 'fail',
				message: `Secrets check failed: ${failures.join('; ')}`,
				details: {
					count: findingsCount,
					reportedCount: result.count,
					critical: result.findings.filter((f) => f.severity === 'critical')
						.length,
					high: result.findings.filter((f) => f.severity === 'high').length,
					filesScanned: result.files_scanned,
					skippedFiles: result.skipped_files,
					incompleteFiles,
					incompletePaths,
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
				skippedFiles: result.skipped_files,
				incompleteFiles,
				incompletePaths,
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
		const missingEvidence: string[] = [];
		for (const id of completedTaskIds) {
			const gateStatus = await getDurableGateEvidenceStatusForTask(dir, id);
			if (gateStatus.isComplete) {
				continue;
			}
			if (gateStatus.evidenceExists && gateStatus.missingGates.length > 0) {
				missingEvidence.push(id);
				continue;
			}
			if (evidenceTaskIds.has(id)) {
				continue;
			}
			missingEvidence.push(id);
		}

		const completedWithEvidence =
			completedTaskIds.length - missingEvidence.length;

		if (missingEvidence.length > 0) {
			return {
				type: 'evidence',
				status: 'fail',
				message: `${missingEvidence.length} completed task(s) missing evidence`,
				details: {
					totalCompleted: completedTaskIds.length,
					totalWithEvidence: completedWithEvidence,
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
				totalWithEvidence: completedWithEvidence,
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
 * Schema for the req-coverage report written by the req_coverage tool
 * (`src/tools/req-coverage.ts`) to `.swarm/evidence/req-coverage-phase-{N}.json`.
 * Structural-only: it pins the writer's already-computed count fields so the
 * gate fails on an unusable/incomplete report without re-deriving
 * requirements from the effective spec (issue #1662: the gate previously
 * passed on file existence alone and asserted nothing about content).
 * Numeric fields are constrained to nonnegative integers — the real writer
 * only ever emits derived integer counts and integer phases (issue #2242
 * hardening: shape validation alone does not reject negative/float values
 * unless the schema says so).
 */
const ReqCoverageReportSchema = z.object({
	success: z.boolean(),
	phase: z.number().int().nonnegative(),
	totalRequirements: z.number().int().nonnegative(),
	coveredCount: z.number().int().nonnegative(),
	missingCount: z.number().int().nonnegative(),
	requirements: z.array(z.unknown()),
});

/** Read cap for the report file — the writer's output is a small bounded
 * JSON document; anything larger is treated as invalid rather than read. */
const REQ_COVERAGE_MAX_JSON_BYTES = 500 * 1024; // 500KB, matches EVIDENCE_MAX_JSON_BYTES

/**
 * Run requirement coverage check
 */
async function runRequirementCoverageCheck(
	dir: string,
	currentPhase: number,
): Promise<PreflightCheckResult> {
	const startTime = Date.now();

	try {
		// Check if an effective spec exists
		if (readEffectiveSpecSync(dir) === null) {
			return {
				type: 'req_coverage',
				status: 'skip',
				message: 'No effective spec found, requirement coverage not required',
				details: {},
				durationMs: Date.now() - startTime,
			};
		}

		// Check if coverage file exists for current phase
		const coverage = await checkRequirementCoverage(currentPhase, dir);

		if (!coverage.exists) {
			return {
				type: 'req_coverage',
				status: 'fail',
				message:
					'Requirement coverage report missing but effective spec exists',
				details: { expectedPath: coverage.path },
				durationMs: Date.now() - startTime,
			};
		}

		// The report exists — validate its content. Existence alone proves
		// nothing: an empty file, unparseable JSON, a wrong-shape document, or
		// a report with inconsistent/incomplete counts must all fail the gate
		// (#1662, hardened per #2242). The count fields are the writer's own
		// output; they are read back here rather than re-derived from the
		// effective spec.
		//
		// Deliberate fresh fs read (no swarm-artifact-cache): this is a
		// validation gate that must see the current on-disk bytes, not a
		// possibly-stale cached copy — the whole point is to distrust the
		// artifact until its content is checked (#2242 F-6 disposition).
		let raw: string;
		try {
			const stat = await fs.promises.stat(coverage.path);
			if (stat.size > REQ_COVERAGE_MAX_JSON_BYTES) {
				return {
					type: 'req_coverage',
					status: 'fail',
					message: `Requirement coverage report exceeds ${REQ_COVERAGE_MAX_JSON_BYTES} byte cap and cannot be validated`,
					details: { path: coverage.path, sizeBytes: stat.size },
					durationMs: Date.now() - startTime,
				};
			}
			raw = await fs.promises.readFile(coverage.path, 'utf-8');
		} catch (readError) {
			return {
				type: 'req_coverage',
				status: 'fail',
				message: `Requirement coverage report unreadable: ${
					readError instanceof Error ? readError.message : String(readError)
				}`,
				details: { path: coverage.path },
				durationMs: Date.now() - startTime,
			};
		}

		const trimmed = raw.trim();
		if (trimmed.length === 0) {
			return {
				type: 'req_coverage',
				status: 'fail',
				message: 'Requirement coverage report is empty',
				details: { path: coverage.path },
				durationMs: Date.now() - startTime,
			};
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch (parseError) {
			const parseErrorMessage =
				parseError instanceof Error ? parseError.message : String(parseError);
			return {
				type: 'req_coverage',
				status: 'fail',
				message: `Requirement coverage report is not valid JSON: ${parseErrorMessage}`,
				details: { path: coverage.path },
				durationMs: Date.now() - startTime,
			};
		}

		const report = ReqCoverageReportSchema.safeParse(parsed);
		if (!report.success) {
			return {
				type: 'req_coverage',
				status: 'fail',
				message:
					'Requirement coverage report does not match the expected report shape',
				details: { path: coverage.path },
				durationMs: Date.now() - startTime,
			};
		}

		const {
			success,
			phase,
			totalRequirements,
			coveredCount,
			missingCount,
			requirements,
		} = report.data;

		// Fail-branch precedence (documented, pinned by the multi-defect
		// precedence regression test): success===false (F-1) → phase
		// mismatch (F-15) → totalRequirements===0 → count-inconsistent (F-2)
		// → requirements.length inconsistent (F-5) → missingCount>0 → pass.
		if (!success) {
			return {
				type: 'req_coverage',
				status: 'fail',
				message:
					'Requirement coverage report indicates the coverage run itself failed (success: false)',
				details: { path: coverage.path },
				durationMs: Date.now() - startTime,
			};
		}

		if (phase !== currentPhase) {
			return {
				type: 'req_coverage',
				status: 'fail',
				message: `Requirement coverage report phase (${phase}) does not match the current phase (${currentPhase})`,
				details: { path: coverage.path, reportPhase: phase, currentPhase },
				durationMs: Date.now() - startTime,
			};
		}

		if (totalRequirements === 0) {
			return {
				type: 'req_coverage',
				status: 'fail',
				message:
					'Requirement coverage report contains no requirements (totalRequirements is 0) but effective spec exists',
				details: { path: coverage.path, totalRequirements },
				durationMs: Date.now() - startTime,
			};
		}

		if (coveredCount + missingCount !== totalRequirements) {
			return {
				type: 'req_coverage',
				status: 'fail',
				message: `Requirement coverage report counts are inconsistent: coveredCount (${coveredCount}) + missingCount (${missingCount}) !== totalRequirements (${totalRequirements})`,
				details: {
					path: coverage.path,
					totalRequirements,
					coveredCount,
					missingCount,
				},
				durationMs: Date.now() - startTime,
			};
		}

		if (requirements.length !== totalRequirements) {
			return {
				type: 'req_coverage',
				status: 'fail',
				message: `Requirement coverage report requirements array length (${requirements.length}) does not match totalRequirements (${totalRequirements})`,
				details: {
					path: coverage.path,
					totalRequirements,
					requirementsLength: requirements.length,
				},
				durationMs: Date.now() - startTime,
			};
		}

		if (missingCount > 0) {
			return {
				type: 'req_coverage',
				status: 'fail',
				message: `Requirement coverage report has ${missingCount} uncovered requirement(s)`,
				details: {
					path: coverage.path,
					totalRequirements,
					coveredCount,
					missingCount,
				},
				durationMs: Date.now() - startTime,
			};
		}

		return {
			type: 'req_coverage',
			status: 'pass',
			message: `Requirement coverage report found: ${coveredCount}/${totalRequirements} requirement(s) covered`,
			details: {
				path: coverage.path,
				totalRequirements,
				coveredCount,
				missingCount,
			},
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
	runSecretscan: typeof runSecretscan;
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
	runSecretscan,
	runSecretsCheck,
	runEvidenceCheck,
	runRequirementCoverageCheck,
} as const;
