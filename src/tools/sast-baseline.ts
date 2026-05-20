/**
 * SAST Baseline — phase-scoped snapshot of pre-existing security findings.
 *
 * Enables baseline diffing so only NEW findings (introduced since baseline capture)
 * drive the fail verdict in subsequent sast_scan calls.
 *
 * Storage: .swarm/evidence/{phase}/sast-baseline.json
 *   Mirrors the phase-scoped convention used by write-drift-evidence.ts and
 *   write-hallucination-evidence.ts (path.join('evidence', String(phase), filename)
 *   passed to validateSwarmPath).
 *
 * Fingerprint format (stable):
 *   `${relFile}|${rule_id}|${sha256(3lineWindow).slice(0,16)}|#${occurrenceIndex}`
 *
 * Fingerprint format (unstable — file unreadable or path escapes workspace):
 *   `${relFile}|${rule_id}|L${line}|UNSTABLE|#${occurrenceIndex}`
 *   Unstable fingerprints are ALWAYS treated as NEW findings (fail-closed).
 *
 * Merge semantics:
 *   On every capture for a set of files, ALL prior fingerprints for those files
 *   are removed (full prune, engine-agnostic) before inserting current findings.
 *   This prevents stale cross-engine fingerprints from causing false-pass verdicts.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { validateSwarmPath } from '../hooks/utils';
import type { SastScanFinding } from './sast-scan';

// ============ Constants ============

export const BASELINE_SCHEMA_VERSION = '1.0.0' as const;

/** Maximum findings to store in baseline (heuristic — open for tuning). */
export const MAX_BASELINE_FINDINGS = 2000;

/** Maximum bytes for the baseline JSON file (heuristic). */
const MAX_BASELINE_BYTES = 2 * 1_048_576; // 2 MB

/** Retry delays for advisory file-lock acquisition (ms). */
const LOCK_RETRY_DELAYS_MS = [50, 100, 200, 400, 800];

// ============ Types ============

export interface SastBaselineFile {
	schema_version: '1.0.0';
	phase: number;
	created_at: string;
	updated_at: string;
	engine: 'tier_a' | 'tier_a+tier_b';
	/** Canonical relative paths of files indexed into this baseline. */
	files_indexed: string[];
	/** Fingerprint strings for all indexed findings. */
	fingerprints: string[];
	/** Full findings snapshot (for auditing / debugging). */
	findings_snapshot: SastScanFinding[];
	/** True if the snapshot was truncated at MAX_BASELINE_FINDINGS. */
	truncated: boolean;
}

export type LoadBaselineResult =
	| { status: 'found'; fingerprints: Set<string>; bundle: SastBaselineFile }
	| { status: 'not_found' }
	| { status: 'invalid_schema'; errors: string[] };

export interface FingerprintResult {
	fingerprint: string;
	/** False when the file was unreadable or the path escapes the workspace. */
	stable: boolean;
}

export interface IndexedFinding {
	finding: SastScanFinding;
	index: number;
	stable: boolean;
	fingerprint: string;
}

export type CaptureResult =
	| { status: 'written'; path: string; fingerprint_count: number }
	| { status: 'merged'; path: string; fingerprint_count: number }
	| { status: 'error'; message: string };

// ============ Path Utilities ============

/**
 * Return the canonical relative path for a finding file.
 * Mirrors the normalization in pre-check-batch.ts classifySastFindings.
 */
export function normalizeFindingPath(directory: string, file: string): string {
	const resolved = path.isAbsolute(file) ? file : path.resolve(directory, file);
	const rel = path.relative(path.resolve(directory), resolved);
	return rel.replace(/\\/g, '/');
}

function baselineRelPath(phase: number): string {
	return path.join('evidence', String(phase), 'sast-baseline.json');
}

function tempRelPath(phase: number): string {
	return path.join(
		'evidence',
		String(phase),
		`sast-baseline.json.tmp.${Date.now()}.${process.pid}`,
	);
}

function lockRelPath(phase: number): string {
	return path.join('evidence', String(phase), 'sast-baseline.json.lock');
}

// ============ Fingerprinting ============

function getLine(lines: string[], idx: number): string {
	if (idx < 0 || idx >= lines.length) return '';
	return (lines[idx] ?? '').trim();
}

/**
 * Compute a stable or unstable fingerprint for a single finding.
 *
 * Stable uses a 3-line content window (N-1, N, N+1) so the fingerprint
 * survives line-number shifts caused by insertions above the finding.
 *
 * Unstable is produced when the file cannot be read or the path escapes
 * the workspace — such findings are always classified NEW (fail-closed).
 */
export function fingerprintFinding(
	finding: SastScanFinding,
	directory: string,
	occurrenceIndex: number,
): FingerprintResult {
	const relFile = normalizeFindingPath(directory, finding.location.file);

	if (relFile.startsWith('..')) {
		return {
			fingerprint: `${relFile}|${finding.rule_id}|L${finding.location.line}|UNSTABLE|#${occurrenceIndex}`,
			stable: false,
		};
	}

	const lineNum = finding.location.line; // 1-indexed

	try {
		const content = fs.readFileSync(finding.location.file, 'utf-8');
		const lines = content.split('\n');
		const idx = lineNum - 1; // 0-indexed
		const window = [
			getLine(lines, idx - 1),
			getLine(lines, idx),
			getLine(lines, idx + 1),
		].join('\n');
		const hash = crypto
			.createHash('sha256')
			.update(window)
			.digest('hex')
			.slice(0, 16);
		return {
			fingerprint: `${relFile}|${finding.rule_id}|${hash}|#${occurrenceIndex}`,
			stable: true,
		};
	} catch {
		return {
			fingerprint: `${relFile}|${finding.rule_id}|L${lineNum}|UNSTABLE|#${occurrenceIndex}`,
			stable: false,
		};
	}
}

/**
 * Assign occurrence indices to a batch of findings.
 *
 * Two findings that produce the same (relFile, rule_id, contentHash) tuple
 * — e.g., copy-pasted vulnerable lines — receive different indices so they
 * get distinct fingerprints and can be individually classified.
 */
export function assignOccurrenceIndices(
	findings: SastScanFinding[],
	directory: string,
): IndexedFinding[] {
	const countMap = new Map<string, number>();

	return findings.map((finding) => {
		const relFile = normalizeFindingPath(directory, finding.location.file);
		const lineNum = finding.location.line;

		let baseKey: string;
		try {
			if (relFile.startsWith('..')) throw new Error('escapes workspace');
			const content = fs.readFileSync(finding.location.file, 'utf-8');
			const lines = content.split('\n');
			const idx = lineNum - 1;
			const window = [
				getLine(lines, idx - 1),
				getLine(lines, idx),
				getLine(lines, idx + 1),
			].join('\n');
			const hash = crypto
				.createHash('sha256')
				.update(window)
				.digest('hex')
				.slice(0, 16);
			baseKey = `${relFile}|${finding.rule_id}|${hash}`;
		} catch {
			baseKey = `${relFile}|${finding.rule_id}|L${lineNum}|UNSTABLE`;
		}

		const occIdx = countMap.get(baseKey) ?? 0;
		countMap.set(baseKey, occIdx + 1);

		const fp = _internals.fingerprintFinding(finding, directory, occIdx);
		return {
			finding,
			index: occIdx,
			stable: fp.stable,
			fingerprint: fp.fingerprint,
		};
	});
}

// ============ File Lock ============

async function acquireLock(lockPath: string): Promise<() => void> {
	for (let attempt = 0; attempt <= LOCK_RETRY_DELAYS_MS.length; attempt++) {
		try {
			const fd = fs.openSync(lockPath, 'wx');
			fs.closeSync(fd);
			return () => {
				try {
					fs.unlinkSync(lockPath);
				} catch {
					/* best-effort cleanup */
				}
			};
		} catch {
			if (attempt < LOCK_RETRY_DELAYS_MS.length) {
				await new Promise((resolve) =>
					setTimeout(resolve, LOCK_RETRY_DELAYS_MS[attempt]),
				);
			}
		}
	}
	// Could not acquire lock — proceed without it (concurrent merges are rare in practice)
	return () => {};
}

// ============ Phase Validation ============

function validatePhase(phase: number): string | null {
	if (!Number.isInteger(phase) || phase < 1) {
		return 'Invalid phase: must be a positive integer';
	}
	return null;
}

// ============ Capture / Merge ============

/**
 * Capture or merge SAST findings into the phase-scoped baseline.
 *
 * Merge semantics:
 *   For every file in `scannedFiles`, ALL prior fingerprints for that file are
 *   removed from the baseline before inserting the current scan's fingerprints.
 *   This full-prune (engine-agnostic) prevents stale cross-engine entries from
 *   causing false-pass verdicts on later full-engine diff scans.
 *
 * Severity threshold:
 *   Callers MUST pass ALL findings regardless of severity threshold so the
 *   baseline captures the full pre-existing surface. Threshold filtering is
 *   the diff caller's responsibility.
 *
 * Idempotency:
 *   Calling twice with identical inputs produces an identical baseline file.
 *   Calling with a new file set adds/replaces only those files' fingerprints.
 */
export async function captureOrMergeBaseline(
	directory: string,
	phase: number,
	findings: SastScanFinding[],
	engine: 'tier_a' | 'tier_a+tier_b',
	scannedFiles: string[],
	opts?: { force?: boolean },
): Promise<CaptureResult> {
	const phaseError = validatePhase(phase);
	if (phaseError) return { status: 'error', message: phaseError };

	if (!scannedFiles || scannedFiles.length === 0) {
		return {
			status: 'error',
			message: 'capture_baseline requires non-empty changed_files',
		};
	}

	let baselinePath: string;
	let tempPath: string;
	let lockPath: string;
	try {
		baselinePath = validateSwarmPath(directory, baselineRelPath(phase));
		tempPath = validateSwarmPath(directory, tempRelPath(phase));
		lockPath = validateSwarmPath(directory, lockRelPath(phase));
	} catch (e) {
		return {
			status: 'error',
			message: e instanceof Error ? e.message : 'Path validation failed',
		};
	}

	fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
	fs.mkdirSync(path.dirname(tempPath), { recursive: true });

	const releaseLock = await acquireLock(lockPath);
	try {
		// Load existing baseline
		let existing: SastBaselineFile | null = null;
		try {
			const raw = fs.readFileSync(baselinePath, 'utf-8');
			const parsed = JSON.parse(raw) as SastBaselineFile;
			if (parsed.schema_version === BASELINE_SCHEMA_VERSION) {
				existing = parsed;
			}
		} catch {
			/* no baseline yet */
		}

		// Canonical scanned-file set for prune matching
		const scannedRelFiles = new Set(
			scannedFiles.map((f) => normalizeFindingPath(directory, f)),
		);

		// Compute fingerprints for current scan's findings
		const indexed = _internals.assignOccurrenceIndices(findings, directory);

		if (existing && !opts?.force) {
			// Full prune: drop ALL prior fingerprints for rescanned files (engine-agnostic).
			// Fingerprint format: `${relFile}|...` — relFile is the first `|`-delimited segment.
			const prunedFingerprints = existing.fingerprints.filter((fp) => {
				const relFile = fp.slice(0, fp.indexOf('|'));
				return !scannedRelFiles.has(relFile);
			});
			const prunedSnapshot = existing.findings_snapshot.filter((f) => {
				return !scannedRelFiles.has(
					normalizeFindingPath(directory, f.location.file),
				);
			});
			const prunedFilesIndexed = existing.files_indexed.filter(
				(f) => !scannedRelFiles.has(f),
			);

			const mergedFingerprints = [
				...prunedFingerprints,
				...indexed.map((i) => i.fingerprint),
			];
			const mergedSnapshot = [
				...prunedSnapshot,
				...indexed.map((i) => i.finding),
			];
			const mergedFilesIndexed = [
				...prunedFilesIndexed,
				...Array.from(scannedRelFiles),
			];

			const truncated = mergedSnapshot.length > MAX_BASELINE_FINDINGS;
			const cappedSnapshot = truncated
				? mergedSnapshot.slice(-MAX_BASELINE_FINDINGS)
				: mergedSnapshot;
			const cappedFingerprints = truncated
				? mergedFingerprints.slice(-MAX_BASELINE_FINDINGS)
				: mergedFingerprints;

			// When truncating, rebuild files_indexed to only include files with surviving fingerprints
			let cappedFilesIndexed = mergedFilesIndexed;
			if (truncated) {
				const survivingFiles = new Set<string>();
				for (const finding of cappedSnapshot) {
					const relFile = normalizeFindingPath(
						directory,
						finding.location.file,
					);
					survivingFiles.add(relFile);
				}
				cappedFilesIndexed = Array.from(survivingFiles);
			}

			const now = new Date().toISOString();
			const bundle: SastBaselineFile = {
				schema_version: BASELINE_SCHEMA_VERSION,
				phase,
				created_at: existing.created_at,
				updated_at: now,
				engine,
				files_indexed: cappedFilesIndexed,
				fingerprints: cappedFingerprints,
				findings_snapshot: cappedSnapshot,
				truncated,
			};

			const json = JSON.stringify(bundle, null, 2);
			if (json.length > MAX_BASELINE_BYTES) {
				return {
					status: 'error',
					message: `Baseline would exceed size cap (${json.length} bytes > ${MAX_BASELINE_BYTES})`,
				};
			}
			fs.writeFileSync(tempPath, json, 'utf-8');
			fs.renameSync(tempPath, baselinePath);

			return {
				status: 'merged',
				path: baselinePath,
				fingerprint_count: cappedFingerprints.length,
			};
		}

		// First write (or force)
		const newFingerprints = indexed.map((i) => i.fingerprint);
		const newSnapshot = indexed.map((i) => i.finding);
		const truncated = newSnapshot.length > MAX_BASELINE_FINDINGS;
		const cappedSnapshot = truncated
			? newSnapshot.slice(0, MAX_BASELINE_FINDINGS)
			: newSnapshot;
		const cappedFingerprints = truncated
			? newFingerprints.slice(0, MAX_BASELINE_FINDINGS)
			: newFingerprints;

		const now = new Date().toISOString();
		const bundle: SastBaselineFile = {
			schema_version: BASELINE_SCHEMA_VERSION,
			phase,
			created_at: now,
			updated_at: now,
			engine,
			files_indexed: Array.from(scannedRelFiles),
			fingerprints: cappedFingerprints,
			findings_snapshot: cappedSnapshot,
			truncated,
		};

		const json = JSON.stringify(bundle, null, 2);
		if (json.length > MAX_BASELINE_BYTES) {
			return {
				status: 'error',
				message: `Baseline would exceed size cap (${json.length} bytes > ${MAX_BASELINE_BYTES})`,
			};
		}
		fs.writeFileSync(tempPath, json, 'utf-8');
		fs.renameSync(tempPath, baselinePath);

		return {
			status: 'written',
			path: baselinePath,
			fingerprint_count: cappedFingerprints.length,
		};
	} finally {
		releaseLock();
	}
}

// ============ Load ============

/**
 * Load the SAST baseline for a given phase.
 *
 * Returns 'not_found' when no baseline file exists (first run for phase).
 * Returns 'invalid_schema' when the file is present but unparseable.
 */
export function loadBaseline(
	directory: string,
	phase: number,
): LoadBaselineResult {
	const phaseError = validatePhase(phase);
	if (phaseError) {
		return { status: 'invalid_schema', errors: [phaseError] };
	}

	let baselinePath: string;
	try {
		baselinePath = validateSwarmPath(directory, baselineRelPath(phase));
	} catch (e) {
		return {
			status: 'invalid_schema',
			errors: [e instanceof Error ? e.message : 'Path validation failed'],
		};
	}

	try {
		const raw = fs.readFileSync(baselinePath, 'utf-8');
		const parsed = JSON.parse(raw) as SastBaselineFile;
		if (parsed.schema_version !== BASELINE_SCHEMA_VERSION) {
			return {
				status: 'invalid_schema',
				errors: [`Unknown schema version: ${String(parsed.schema_version)}`],
			};
		}
		if (!Array.isArray(parsed.fingerprints)) {
			return {
				status: 'invalid_schema',
				errors: ['Missing or invalid fingerprints array'],
			};
		}
		return {
			status: 'found',
			fingerprints: new Set(parsed.fingerprints),
			bundle: parsed,
		};
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
			return { status: 'not_found' };
		}
		return {
			status: 'invalid_schema',
			errors: [e instanceof Error ? e.message : 'Failed to read baseline'],
		};
	}
}

/**
 * DI seam for testability. Contains all test-mocked exports.
 * Internal calls should use _internals.fn() instead of fn() directly.
 */
export const _internals: {
	fingerprintFinding: typeof fingerprintFinding;
	assignOccurrenceIndices: typeof assignOccurrenceIndices;
	captureOrMergeBaseline: typeof captureOrMergeBaseline;
	loadBaseline: typeof loadBaseline;
} = {
	fingerprintFinding,
	assignOccurrenceIndices,
	captureOrMergeBaseline,
	loadBaseline,
} as const;
