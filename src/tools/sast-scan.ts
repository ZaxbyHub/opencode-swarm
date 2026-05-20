/**
 * SAST Scan Tool - Static Application Security Testing
 * Integrates Tier A rules (offline) and optional Semgrep (Tier B)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { extname } from 'node:path';
import type { ToolDefinition } from '@opencode-ai/plugin/tool';
import { z } from 'zod';
import type { PluginConfig } from '../config';
import type { EvidenceVerdict } from '../config/evidence-schema';
import { saveEvidence } from '../evidence/manager';
import { getProfileForFile } from '../lang/detector';
import { getLanguageForExtension } from '../lang/registry';
import { executeRulesSync } from '../sast/rules/index';
import { isSemgrepAvailable, runSemgrep } from '../sast/semgrep';
import { warn } from '../utils';
import { createSwarmTool } from './create-tool';
import {
	assignOccurrenceIndices,
	type CaptureResult,
	captureOrMergeBaseline,
	loadBaseline,
	MAX_BASELINE_FINDINGS,
} from './sast-baseline';

// ============ Types ============

export interface SastScanInput {
	/** List of files to scan */
	changed_files: string[];
	/** Minimum severity that causes failure (default: 'medium') */
	severity_threshold?: 'low' | 'medium' | 'high' | 'critical';
	/**
	 * When true, capture/merge a phase-scoped baseline snapshot and return
	 * status:'baseline_captured'. Subsequent scans with the same phase will
	 * diff against this baseline so only NEW findings drive the fail verdict.
	 *
	 * Capture mode ignores severity_threshold — all severities are recorded.
	 * Requires `phase` to be provided.
	 */
	capture_baseline?: boolean;
	/**
	 * Current phase number (positive integer, >= 1). Required when
	 * capture_baseline is true. When provided without capture_baseline, enables
	 * baseline diff mode: only findings absent from the phase baseline fail.
	 */
	phase?: number;
}

export interface SastScanResult {
	/** Overall verdict: pass if no findings above threshold, fail otherwise */
	verdict: EvidenceVerdict;
	/** Array of security findings */
	findings: SastScanFinding[];
	/** Summary information */
	summary: {
		/** Engine used for scanning */
		engine: 'tier_a' | 'tier_a+tier_b';
		/** Number of files scanned */
		files_scanned: number;
		/** Total number of findings */
		findings_count: number;
		/** Breakdown of findings by severity */
		findings_by_severity: {
			critical: number;
			high: number;
			medium: number;
			low: number;
		};
	};
	// Baseline-diffing fields — present when capture_baseline is true or a baseline was loaded
	/** 'baseline_captured' when capture_baseline:true succeeded */
	status?: 'baseline_captured' | 'baseline_merged';
	/** Number of findings recorded in the baseline (capture mode only) */
	finding_count?: number;
	/** Findings NOT present in the baseline (diff mode only) */
	new_findings?: SastScanFinding[];
	/** Findings that match the baseline (diff mode only) */
	pre_existing_findings?: SastScanFinding[];
	/** True when a baseline was loaded and diff mode was active */
	baseline_used?: boolean;
	/** True when pre_existing_findings were truncated to fit result limits */
	truncated_pre_existing?: boolean;
}

export interface SastScanFinding {
	rule_id: string;
	severity: 'critical' | 'high' | 'medium' | 'low';
	message: string;
	location: {
		file: string;
		line: number;
		column?: number;
	};
	remediation?: string;
}

// ============ Constants ============

const MAX_FILE_SIZE_BYTES = 512 * 1024; // 512KB per file
const MAX_FILES_SCANNED = 1000;
const MAX_FINDINGS = 100;

/** Severity level ordering (higher = more severe) */
const SEVERITY_ORDER: Record<string, number> = {
	low: 0,
	medium: 1,
	high: 2,
	critical: 3,
};

// ============ Helper Functions ============

/**
 * Check if a file should be skipped based on size or binary content
 */
function shouldSkipFile(filePath: string): { skip: boolean; reason?: string } {
	try {
		const stats = fs.statSync(filePath);

		// Check file size
		if (stats.size > MAX_FILE_SIZE_BYTES) {
			return { skip: true, reason: 'file too large' };
		}

		// Check for empty files
		if (stats.size === 0) {
			return { skip: true, reason: 'empty file' };
		}

		// Check for binary content (simple heuristic)
		const fd = fs.openSync(filePath, 'r');
		const buffer = Buffer.alloc(8192);
		const bytesRead = fs.readSync(fd, buffer, 0, 8192, 0);
		fs.closeSync(fd);

		if (bytesRead > 0) {
			// Check for null bytes (common in binary files)
			let nullCount = 0;
			for (let i = 0; i < bytesRead; i++) {
				if (buffer[i] === 0) {
					nullCount++;
				}
			}
			// If more than 10% null bytes, likely binary
			if (nullCount / bytesRead > 0.1) {
				return { skip: true, reason: 'binary file' };
			}
		}

		return { skip: false };
	} catch {
		return { skip: true, reason: 'cannot read file' };
	}
}

/**
 * Determine if a finding meets the severity threshold
 */
function meetsThreshold(
	severity: string,
	threshold: 'low' | 'medium' | 'high' | 'critical',
): boolean {
	const severityLevel = SEVERITY_ORDER[severity] ?? 0;
	const thresholdLevel = SEVERITY_ORDER[threshold] ?? 1;
	return severityLevel >= thresholdLevel;
}

/**
 * Count findings by severity
 */
function countBySeverity(findings: SastScanFinding[]): {
	critical: number;
	high: number;
	medium: number;
	low: number;
} {
	const counts = {
		critical: 0,
		high: 0,
		medium: 0,
		low: 0,
	};

	for (const finding of findings) {
		const severity = finding.severity.toLowerCase();
		if (severity in counts) {
			counts[severity as keyof typeof counts]++;
		}
	}

	return counts;
}

/**
 * Scan a single file using Tier A rules
 */
function scanFileWithTierA(
	filePath: string,
	language: string,
): SastScanFinding[] {
	try {
		const content = fs.readFileSync(filePath, 'utf-8');
		const findings = executeRulesSync(filePath, content, language);

		return findings.map((f) => ({
			rule_id: f.rule_id,
			severity: f.severity,
			message: f.message,
			location: {
				file: f.location.file,
				line: f.location.line,
				column: f.location.column,
			},
			remediation: f.remediation,
		}));
	} catch {
		return [];
	}
}

// ============ Main Tool Implementation ============

/**
 * SAST Scan tool - Static Application Security Testing
 * Scans changed files for security vulnerabilities using:
 * - Tier A: Built-in pattern-based rules (always runs)
 * - Tier B: Semgrep (optional, if available on PATH)
 */
export async function sastScan(
	input: SastScanInput,
	directory: string,
	config?: PluginConfig,
): Promise<SastScanResult> {
	const {
		changed_files,
		severity_threshold = 'medium',
		capture_baseline = false,
		phase,
	} = input;

	// Check feature flag
	if (config?.gates?.sast_scan?.enabled === false) {
		return {
			verdict: 'pass',
			findings: [],
			summary: {
				engine: 'tier_a',
				files_scanned: 0,
				findings_count: 0,
				findings_by_severity: {
					critical: 0,
					high: 0,
					medium: 0,
					low: 0,
				},
			},
		};
	}

	// Track results
	const allFindings: SastScanFinding[] = [];
	let filesScanned = 0;
	let _filesSkipped = 0;
	/** Paths of files that were successfully scanned (for baseline capture). */
	const scannedFilePaths: string[] = [];

	// Check Semgrep availability once
	const semgrepAvailable = isSemgrepAvailable();
	const engine: 'tier_a' | 'tier_a+tier_b' = semgrepAvailable
		? 'tier_a+tier_b'
		: 'tier_a';

	// Group files by language for Semgrep batch scanning
	const filesByLanguage = new Map<string, string[]>();

	// Process each file
	for (const filePath of changed_files) {
		// Skip non-string or empty entries
		if (typeof filePath !== 'string' || !filePath) {
			_filesSkipped++;
			continue;
		}

		// Resolve relative paths
		const resolvedPath = path.isAbsolute(filePath)
			? filePath
			: path.resolve(directory, filePath);

		// Security: reject paths that escape the working directory via traversal
		const resolvedDirectory = path.resolve(directory);
		if (
			!resolvedPath.startsWith(resolvedDirectory + path.sep) &&
			resolvedPath !== resolvedDirectory
		) {
			_filesSkipped++;
			continue;
		}

		// Skip non-existent files
		if (!fs.existsSync(resolvedPath)) {
			_filesSkipped++;
			continue;
		}

		// Check if file should be skipped (size/binary)
		const skipResult = shouldSkipFile(resolvedPath);
		if (skipResult.skip) {
			_filesSkipped++;
			continue;
		}

		// Get language from extension — try profile first, fall back to old registry
		const ext = extname(resolvedPath).toLowerCase();
		const profile = getProfileForFile(resolvedPath);
		const langDef = getLanguageForExtension(ext);

		// Skip if neither registry knows about this file type
		if (!profile && !langDef) {
			_filesSkipped++;
			continue;
		}

		const language = profile?.id ?? langDef!.id;

		// Run Tier A rules (always, when nativeRuleSet is defined OR old registry knows the language)
		const hasNativeRules = profile
			? profile.sast.nativeRuleSet !== null
			: !!langDef;
		if (hasNativeRules) {
			const tierAFindings = scanFileWithTierA(resolvedPath, language);
			allFindings.push(...tierAFindings);
		}

		// Add to Semgrep language bucket
		// - If profile has nativeRuleSet: use existing local-rules-only Semgrep (bucket key = language)
		// - If profile has nativeRuleSet === null and semgrepSupport !== 'none': use auto mode (bucket key = 'auto:<lang>')
		// - If profile has nativeRuleSet === null and semgrepSupport === 'none': skip Semgrep for this file
		// - If no profile: fall back to old behavior (add to language bucket)
		if (semgrepAvailable) {
			if (
				profile &&
				profile.sast.nativeRuleSet === null &&
				profile.sast.semgrepSupport !== 'none'
			) {
				// Language has no native rules but Semgrep supports it — use auto mode
				const bucketKey = `auto:${profile.id}`;
				const existing = filesByLanguage.get(bucketKey) || [];
				existing.push(resolvedPath);
				filesByLanguage.set(bucketKey, existing);
			} else if (
				!(
					profile &&
					profile.sast.nativeRuleSet === null &&
					profile.sast.semgrepSupport === 'none'
				)
			) {
				// Language has native rules or no profile — use local rules (existing behavior)
				// Skip if profile explicitly has no Semgrep support
				const existing = filesByLanguage.get(language) || [];
				existing.push(resolvedPath);
				filesByLanguage.set(language, existing);
			}
		}

		filesScanned++;
		scannedFilePaths.push(resolvedPath);

		// Limit files scanned
		if (filesScanned >= MAX_FILES_SCANNED) {
			warn(
				`SAST Scan: Reached maximum files limit (${MAX_FILES_SCANNED}), stopping`,
			);
			break;
		}
	}

	// Run Semgrep if available and we have files
	if (semgrepAvailable && filesByLanguage.size > 0) {
		try {
			for (const [bucketKey, bucketFiles] of filesByLanguage.entries()) {
				if (bucketFiles.length === 0) continue;

				let semgrepResult: Awaited<ReturnType<typeof runSemgrep>>;

				if (bucketKey.startsWith('auto:')) {
					// Profile-driven auto mode: --config auto --lang <lang>
					const lang = bucketKey.slice('auto:'.length);
					semgrepResult = await runSemgrep({
						files: bucketFiles,
						lang,
						useAutoConfig: true,
					});
				} else {
					// Existing local-rules mode
					semgrepResult = await runSemgrep({
						files: bucketFiles,
					});
				}

				if (semgrepResult.findings.length > 0) {
					// Add Semgrep findings
					const semgrepFindings: SastScanFinding[] = semgrepResult.findings.map(
						(f) => ({
							rule_id: f.rule_id,
							severity: f.severity,
							message: f.message,
							location: {
								file: f.location.file,
								line: f.location.line,
								column: f.location.column,
							},
							remediation: f.remediation,
						}),
					);

					// Deduplicate findings (same rule_id + location)
					const existingKeys = new Set(
						allFindings.map(
							(f) => `${f.rule_id}:${f.location.file}:${f.location.line}`,
						),
					);
					for (const finding of semgrepFindings) {
						const key = `${finding.rule_id}:${finding.location.file}:${finding.location.line}`;
						if (!existingKeys.has(key)) {
							allFindings.push(finding);
							existingKeys.add(key);
						}
					}
				}
			}
		} catch (error) {
			// Graceful fallback to Tier A only
			warn(`SAST Scan: Semgrep failed, falling back to Tier A: ${error}`);
		}
	}

	// ── Capture mode ─────────────────────────────────────────────────────────
	// Records a baseline snapshot WITHOUT applying severity_threshold and WITHOUT
	// the zero-coverage-fail invariant (capturing nothing is legitimate).
	if (capture_baseline) {
		if (phase === undefined || !Number.isInteger(phase) || phase < 1) {
			// Capture without a valid phase is a hard error
			const errorResult: SastScanResult = {
				verdict: 'fail',
				findings: allFindings.slice(0, MAX_FINDINGS),
				summary: {
					engine,
					files_scanned: filesScanned,
					findings_count: Math.min(allFindings.length, MAX_FINDINGS),
					findings_by_severity: countBySeverity(
						allFindings.slice(0, MAX_FINDINGS),
					),
				},
			};
			return errorResult;
		}

		// Use raised cap for baseline capture so mediums/lows aren't silently lost.
		const captureFindings = allFindings.slice(0, MAX_BASELINE_FINDINGS);

		const captureResult: CaptureResult = await captureOrMergeBaseline(
			directory,
			phase,
			captureFindings,
			engine,
			scannedFilePaths,
		);

		// Even on capture error, return a pass so the architect flow continues —
		// baseline failure is surfaced in status field and should be logged.
		const captureStatus =
			captureResult.status === 'written'
				? 'baseline_captured'
				: captureResult.status === 'merged'
					? 'baseline_merged'
					: undefined;

		if (captureResult.status === 'error') {
			warn(`SAST Baseline: capture failed — ${captureResult.message}`);
		}

		const finalFindings = allFindings.slice(0, MAX_FINDINGS);
		const summary = {
			engine,
			files_scanned: filesScanned,
			findings_count: finalFindings.length,
			findings_by_severity: countBySeverity(finalFindings),
		};

		await saveEvidence(directory, 'sast_scan', {
			task_id: 'sast_scan',
			type: 'sast',
			timestamp: new Date().toISOString(),
			agent: 'sast_scan',
			verdict: 'pass',
			summary: `Baseline capture: scanned ${filesScanned} files, recorded ${captureFindings.length} finding(s)`,
			...summary,
			findings: finalFindings,
			baseline_used: false,
		});

		return {
			verdict: 'pass',
			findings: finalFindings,
			summary,
			status: captureStatus,
			finding_count:
				captureResult.status !== 'error'
					? captureResult.fingerprint_count
					: undefined,
			baseline_used: false,
		};
	}

	// ── Diff mode (baseline-aware) ────────────────────────────────────────────
	// When a phase is provided and a baseline exists, partition findings into
	// new (not in baseline) vs pre_existing (in baseline). Only new findings
	// drive the fail verdict. Severity threshold applied post-partition.
	let newFindings: SastScanFinding[] | undefined;
	let preExistingFindings: SastScanFinding[] | undefined;
	let baselineUsed = false;
	let truncatedPreExisting = false;

	if (phase !== undefined && Number.isInteger(phase) && phase >= 1) {
		const baselineResult = loadBaseline(directory, phase);

		if (baselineResult.status === 'found') {
			baselineUsed = true;
			const baselineSet = baselineResult.fingerprints;

			// Partition ALL raw findings (pre-truncation) — avoids false passes
			// from new findings that would have been truncated before partitioning.
			const indexed = assignOccurrenceIndices(allFindings, directory);

			const rawNew: SastScanFinding[] = [];
			const rawPreExisting: SastScanFinding[] = [];

			for (const { finding, stable, fingerprint } of indexed) {
				if (!stable || !baselineSet.has(fingerprint)) {
					// Unstable fingerprint or not in baseline → treat as NEW (fail-closed)
					rawNew.push(finding);
				} else {
					rawPreExisting.push(finding);
				}
			}

			// Truncate per-bucket (new_findings take priority)
			newFindings = rawNew.slice(0, MAX_FINDINGS);
			const preExistingBudget = Math.max(0, MAX_FINDINGS - newFindings.length);
			preExistingFindings = rawPreExisting.slice(0, preExistingBudget);
			truncatedPreExisting = rawPreExisting.length > preExistingBudget;
		} else if (baselineResult.status === 'invalid_schema') {
			warn(
				`SAST Baseline: could not load baseline for phase ${phase} — ${baselineResult.errors.join(', ')}. Falling back to legacy behavior.`,
			);
		}
		// 'not_found' → silent legacy fallback (no baseline yet for this phase)
	}

	// ── Legacy verdict (no baseline) ─────────────────────────────────────────
	let finalFindings: SastScanFinding[];
	if (!baselineUsed) {
		finalFindings = allFindings;
		if (allFindings.length > MAX_FINDINGS) {
			finalFindings = allFindings.slice(0, MAX_FINDINGS);
			warn(
				`SAST Scan: Found ${allFindings.length} findings, limiting to ${MAX_FINDINGS}`,
			);
		}
	} else {
		// findings[] = all findings (new + pre_existing) for backward compat with callers
		finalFindings = [
			...(newFindings ?? []),
			...(preExistingFindings ?? []),
		].slice(0, MAX_FINDINGS);
	}

	// Count by severity
	const findingsBySeverity = countBySeverity(finalFindings);

	// Determine verdict:
	// - Baseline mode: only new_findings (above threshold) drive fail
	// - Legacy mode: all finalFindings (above threshold) drive fail
	const verdictSource = baselineUsed ? (newFindings ?? []) : finalFindings;
	let verdict: EvidenceVerdict = 'pass';
	for (const finding of verdictSource) {
		if (meetsThreshold(finding.severity, severity_threshold)) {
			verdict = 'fail';
			break;
		}
	}

	// Zero-coverage fail: preserved in both modes (only skip for capture mode, handled above)
	if (filesScanned === 0) {
		verdict = 'fail';
	}

	// Build summary
	const summary = {
		engine,
		files_scanned: filesScanned,
		findings_count: finalFindings.length,
		findings_by_severity: findingsBySeverity,
	};

	// Save evidence
	await saveEvidence(directory, 'sast_scan', {
		task_id: 'sast_scan',
		type: 'sast',
		timestamp: new Date().toISOString(),
		agent: 'sast_scan',
		verdict,
		summary: `Scanned ${filesScanned} files, found ${finalFindings.length} finding(s) using ${engine}`,
		...summary,
		findings: finalFindings,
		...(baselineUsed && {
			new_findings: newFindings,
			pre_existing_findings: preExistingFindings,
			baseline_used: true,
		}),
	});

	const result: SastScanResult = {
		verdict,
		findings: finalFindings,
		summary,
	};

	if (baselineUsed) {
		result.new_findings = newFindings;
		result.pre_existing_findings = preExistingFindings;
		result.baseline_used = true;
		if (truncatedPreExisting) result.truncated_pre_existing = true;
	}

	return result;
}

// ============ Tool Definition ============

/**
 * SAST Scan tool - Static Application Security Testing
 * Scans changed files for security vulnerabilities using:
 * - Tier A: Built-in pattern-based rules (always runs)
 * - Tier B: Semgrep (optional, if available on PATH)
 */
export const sast_scan: ToolDefinition = createSwarmTool({
	description:
		'Static Application Security Testing (SAST) scan. Scans files for security vulnerabilities using built-in rules (Tier A) and optional Semgrep (Tier B). Supports phase-scoped baseline diffing: set capture_baseline:true before first coder delegation to snapshot pre-existing findings; subsequent scans with the same phase only fail on NEW findings.',
	args: {
		directory: z
			.string()
			.describe('Directory to scan for security vulnerabilities'),
		changed_files: z
			.array(z.string())
			.optional()
			.describe('List of files to scan (leave empty to scan none)'),
		severity_threshold: z
			.enum(['low', 'medium', 'high', 'critical'])
			.optional()
			.default('medium')
			.describe('Minimum severity that causes failure'),
		capture_baseline: z
			.boolean()
			.optional()
			.describe(
				'When true, capture/merge a phase-scoped baseline of pre-existing findings. Requires phase. Subsequent scans with phase only fail on NEW findings.',
			),
		phase: z
			.number()
			.int()
			.min(1)
			.optional()
			.describe(
				'Current phase number (positive integer >= 1). Required with capture_baseline. Enables baseline diff when provided on non-capture scans.',
			),
	},
	execute: async (args, directory) => {
		// Safe args extraction - guard against malformed args and malicious getters
		let safeArgs: {
			directory: string | undefined;
			changed_files: string[] | undefined;
			severity_threshold: 'low' | 'medium' | 'high' | 'critical' | undefined;
			capture_baseline: boolean | undefined;
			phase: number | undefined;
		};

		try {
			if (args && typeof args === 'object') {
				const rawPhase = (args as Record<string, unknown>).phase;
				const rawCapture = (args as Record<string, unknown>).capture_baseline;
				safeArgs = {
					directory: args.directory as unknown as string | undefined,
					changed_files: args.changed_files as unknown as string[] | undefined,
					severity_threshold: args.severity_threshold as unknown as
						| 'low'
						| 'medium'
						| 'high'
						| 'critical'
						| undefined,
					// Strict type guards: reject coerced/string values
					phase:
						typeof rawPhase === 'number' &&
						Number.isInteger(rawPhase) &&
						rawPhase >= 1
							? rawPhase
							: undefined,
					capture_baseline:
						typeof rawCapture === 'boolean' ? rawCapture : undefined,
				};
			} else {
				safeArgs = {
					directory: undefined,
					changed_files: undefined,
					severity_threshold: undefined,
					capture_baseline: undefined,
					phase: undefined,
				};
			}
		} catch {
			// Malicious getter threw - treat as malformed args
			safeArgs = {
				directory: undefined,
				changed_files: undefined,
				severity_threshold: undefined,
				capture_baseline: undefined,
				phase: undefined,
			};
		}

		// Handle malformed args: return structured error
		if (safeArgs.directory === undefined) {
			const errorResult: SastScanResult = {
				verdict: 'fail',
				findings: [],
				summary: {
					engine: 'tier_a',
					files_scanned: 0,
					findings_count: 0,
					findings_by_severity: {
						critical: 0,
						high: 0,
						medium: 0,
						low: 0,
					},
				},
			};
			return JSON.stringify(errorResult, null, 2);
		}

		const input: SastScanInput = {
			changed_files: safeArgs.changed_files ?? [],
			severity_threshold: safeArgs.severity_threshold ?? 'medium',
			capture_baseline: safeArgs.capture_baseline,
			phase: safeArgs.phase,
		};

		const result = await _internals.sastScan(input, directory);
		return JSON.stringify(result, null, 2);
	},
});

/**
 * DI seam for testability. Contains all test-mocked exports.
 * Internal calls should use _internals.fn() instead of fn() directly.
 */
export const _internals: {
	sastScan: typeof sastScan;
	sast_scan: typeof sast_scan;
} = {
	sastScan,
	sast_scan,
} as const;
