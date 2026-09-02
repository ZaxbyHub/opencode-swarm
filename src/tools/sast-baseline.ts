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
 * Reflow identity (schema 1.1.0, issue #2302):
 *   The 3-line window hash is sensitive to adjacent-line edits and the
 *   occurrence index shifts when an identical same-rule line is inserted
 *   above a baselined one — both reclassify an unchanged pre-existing
 *   finding as NEW. Every stable entry therefore also records a
 *   position-independent reflow key
 *   `${relFile}|${rule_id}|${sha256(trimmed flagged line).slice(0,16)}`
 *   (aligned 1:1 with fingerprints[] in reflow_keys[]). Diff scans match
 *   current findings against the baseline as a multiset of reflow keys
 *   BEFORE classifying NEW; matches are reported as `moved` (never gating).
 *   A 1.0.0 baseline has no reflow keys (they cannot be reconstructed after
 *   the fact — findings_snapshot stores no line content) and degrades to
 *   exact matching only until its next capture rewrites it as 1.1.0.
 *
 * Absorption triage (schema 1.1.0, issue #2302):
 *   Merging a finding that matches neither the exact fingerprints nor the
 *   reflow multiset of the prior baseline is a NOVEL ABSORPTION. EVERY novel
 *   absorption — in already-indexed OR first-time-indexed files — requires an
 *   explicit refreshRationale; without it the capture is BLOCKED and the
 *   baseline is left untouched (fail-closed: a bare failure-response
 *   recapture can never silently accept a coder-introduced vulnerability).
 *   With a rationale, every absorbed finding records who/when/rationale in
 *   triage_log[]. First writes (`status:'written'`) are snapshots, not
 *   absorptions, and stay free.
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
import { invalidateCachedArtifact } from '../utils/swarm-artifact-cache';
import type { SastScanFinding } from './sast-scan';

// ============ Constants ============

export const BASELINE_SCHEMA_VERSION = '1.1.0' as const;

/** Baselines written before issue #2302 — loaded read-only, exact matching only. */
export const LEGACY_BASELINE_SCHEMA_VERSION = '1.0.0' as const;

/** Maximum findings to store in baseline (heuristic — open for tuning). */
export const MAX_BASELINE_FINDINGS = 2000;

/** Maximum bytes for the baseline JSON file (heuristic). */
const MAX_BASELINE_BYTES = 2 * 1_048_576; // 2 MB

/** Maximum novel findings listed in an absorption_blocked result (heuristic). */
const MAX_BLOCKED_LIST = 20;

/** Retry delays for advisory file-lock acquisition (ms). */
const LOCK_RETRY_DELAYS_MS = [50, 100, 200, 400, 800];

// ============ Types ============

export interface SastBaselineFile {
	schema_version: '1.0.0' | '1.1.0';
	phase: number;
	created_at: string;
	updated_at: string;
	engine: 'tier_a' | 'tier_a+tier_b';
	/** Canonical relative paths of files indexed into this baseline. */
	files_indexed: string[];
	/** Fingerprint strings for all indexed findings. */
	fingerprints: string[];
	/**
	 * Position-independent reflow identities aligned 1:1 with fingerprints[]
	 * (`${relFile}|${rule_id}|${sha256(trimmed flagged line).slice(0,16)}`,
	 * '' for unstable entries). Absent in 1.0.0 files — exact matching only.
	 */
	reflow_keys?: string[];
	/** Full findings snapshot (for auditing / debugging). */
	findings_snapshot: SastScanFinding[];
	/**
	 * Audit trail for every novel absorption into an existing baseline
	 * (issue #2302). First writes record no entries — a snapshot is not an
	 * acceptance. Entries are dropped when their fingerprint no longer
	 * survives in fingerprints[].
	 */
	triage_log?: BaselineTriageEntry[];
	/** True if the snapshot was truncated at MAX_BASELINE_FINDINGS. */
	truncated: boolean;
}

export interface BaselineTriageEntry {
	/** Fingerprint of the absorbed finding (post-capture form). */
	fingerprint: string;
	/** Canonical relative path of the file containing the absorbed finding. */
	rel_file: string;
	rule_id: string;
	/** Caller-supplied refresh rationale, or the first-time-index auto-rationale. */
	rationale: string;
	/** Session id of the capturing caller, or 'unknown-session'. */
	actor: string;
	/** ISO timestamp of the absorption. */
	absorbed_at: string;
}

export type LoadBaselineResult =
	| {
			status: 'found';
			fingerprints: Set<string>;
			/** Reflow keys aligned with the loaded fingerprints (empty for 1.0.0 files). */
			reflowKeys: string[];
			bundle: SastBaselineFile;
	  }
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
	/** Position-independent reflow identity ('' when unstable — never reflow-matched). */
	reflowKey: string;
}

export interface BaselinePartition {
	preExisting: SastScanFinding[];
	moved: SastScanFinding[];
	newFindings: SastScanFinding[];
}

export interface BlockedAbsorptionFinding {
	fingerprint: string;
	rel_file: string;
	rule_id: string;
}

export type CaptureResult =
	| { status: 'written'; path: string; fingerprint_count: number }
	| {
			status: 'merged';
			path: string;
			fingerprint_count: number;
			/** Novel absorptions recorded in triage_log by this capture. */
			absorbed_finding_count: number;
			/** Prior triage entries whose fingerprints no longer survive this merge. */
			dropped_triage_count: number;
	  }
	| {
			status: 'absorption_blocked';
			path: string;
			/** Novel findings in already-indexed files (bounded to MAX_BLOCKED_LIST). */
			blocked: BlockedAbsorptionFinding[];
			message: string;
	  }
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
 * Assign occurrence indices and reflow identities to a batch of findings.
 *
 * Two findings that produce the same (relFile, rule_id, contentHash) tuple
 * — e.g., copy-pasted vulnerable lines — receive different indices so they
 * get distinct fingerprints and can be individually classified.
 *
 * The reflow key hashes only the flagged line's own (trimmed) content, so it
 * survives adjacent-line edits, pure line moves, and occurrence-index shifts
 * — the three fingerprint instabilities fixed by issue #2302. It is '' when
 * the fingerprint is unstable; unstable findings never reflow-match.
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
		let reflowKey = '';
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
			const lineHash = crypto
				.createHash('sha256')
				.update(getLine(lines, idx))
				.digest('hex')
				.slice(0, 16);
			reflowKey = `${relFile}|${finding.rule_id}|${lineHash}`;
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
			reflowKey,
		};
	});
}

// ============ Reflow Partition ============

/**
 * Partition current findings against a loaded baseline (issue #2302).
 *
 * 1. Exact: stable fingerprint present in baselineFingerprints → pre-existing.
 *    Each exact match consumes one count of its reflow key — an exact
 *    fingerprint match implies the same flagged-line content, so a baseline
 *    entry can never absorb both an exact and a reflow match.
 * 2. Reflow: stable finding whose reflow key still has unconsumed baseline
 *    counts → moved (same finding, new position/window; never gating).
 * 3. Anything else — including every unstable finding — is NEW (fail-closed).
 *
 * Multiset counting keeps duplicate content honest: a baseline with one
 * `exec(cmd)` line absorbs exactly one current `exec(cmd)` line; a second
 * identical line stays NEW.
 */
export function partitionAgainstBaseline(
	indexed: IndexedFinding[],
	baselineFingerprints: Set<string>,
	baselineReflowKeys: readonly string[],
): BaselinePartition {
	const reflowCounts = new Map<string, number>();
	for (const key of baselineReflowKeys) {
		if (!key) continue;
		reflowCounts.set(key, (reflowCounts.get(key) ?? 0) + 1);
	}

	const preExisting: SastScanFinding[] = [];
	const moved: SastScanFinding[] = [];
	const newFindings: SastScanFinding[] = [];

	for (const { finding, stable, fingerprint, reflowKey } of indexed) {
		if (stable && baselineFingerprints.has(fingerprint)) {
			preExisting.push(finding);
			if (reflowKey) {
				const count = reflowCounts.get(reflowKey) ?? 0;
				if (count > 0) reflowCounts.set(reflowKey, count - 1);
			}
		} else if (stable && reflowKey && (reflowCounts.get(reflowKey) ?? 0) > 0) {
			const matchedCount = reflowCounts.get(reflowKey) ?? 0;
			reflowCounts.set(reflowKey, matchedCount - 1);
			moved.push(finding);
		} else {
			newFindings.push(finding);
		}
	}

	return { preExisting, moved, newFindings };
}

// ============ File Lock ============

async function waitForLockRetry(
	delayMs: number,
	abortSignal?: AbortSignal,
): Promise<boolean> {
	if (abortSignal?.aborted) return false;
	return await new Promise<boolean>((resolve) => {
		let settled = false;
		const finish = (value: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			abortSignal?.removeEventListener('abort', onAbort);
			resolve(value);
		};
		const onAbort = () => finish(false);
		const timeout = setTimeout(() => finish(true), delayMs);
		abortSignal?.addEventListener('abort', onAbort, { once: true });
		if (abortSignal?.aborted) onAbort();
	});
}

async function acquireLock(
	lockPath: string,
	abortSignal?: AbortSignal,
): Promise<(() => void) | null> {
	for (let attempt = 0; attempt <= LOCK_RETRY_DELAYS_MS.length; attempt++) {
		if (abortSignal?.aborted) return null;
		try {
			const fd = fs.openSync(lockPath, 'wx');
			fs.closeSync(fd);
			// The lock lives at .swarm/evidence/<phase>/sast-baseline.json.lock, so
			// it falls inside the cached `evidence/**` class — the knowledge-curator
			// reader's trigger filter is unrestricted below .swarm/evidence/, and
			// the class deliberately OVER-approximates.
			//
			// Stated honestly: this is a satisfy-the-class invalidation, not a fix
			// for a demonstrated stale read. Nothing reads this lock's contents, so
			// no reader can be served a stale version of it. Invalidating one Map
			// key on acquire is cheaper and less fragile than carving a lock-file
			// exception into the directory class, which is why the guard's report
			// (#1619 round 7) is answered this way rather than with an allowlist.
			invalidateCachedArtifact(lockPath);
			return () => {
				try {
					fs.unlinkSync(lockPath);
				} catch {
					/* best-effort cleanup */
				}
			};
		} catch {
			if (attempt < LOCK_RETRY_DELAYS_MS.length) {
				if (
					!(await waitForLockRetry(LOCK_RETRY_DELAYS_MS[attempt], abortSignal))
				) {
					return null;
				}
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
 * Absorption triage (issue #2302):
 *   Current findings that match the prior baseline (exact fingerprint or
 *   reflow key) are re-fingerprinted mechanically. A finding that matches
 *   neither is a NOVEL ABSORPTION: the capture is BLOCKED unless
 *   `refreshRationale` is supplied (the baseline is left untouched —
 *   fail-closed), for already-indexed AND first-time-indexed files alike.
 *   With a rationale, every absorbed finding records who (`actor`)/when/
 *   rationale in `triage_log`.
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
	opts?: {
		force?: boolean;
		abortSignal?: AbortSignal;
		/** Audited rationale required to absorb novel findings in already-indexed files. */
		refreshRationale?: string;
		/** Identity recorded in triage_log entries (session id of the caller). */
		actor?: string;
	},
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

	if (opts?.abortSignal?.aborted) {
		return { status: 'error', message: 'SAST baseline capture cancelled' };
	}
	fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
	fs.mkdirSync(path.dirname(tempPath), { recursive: true });

	const releaseLock = await acquireLock(lockPath, opts?.abortSignal);
	if (!releaseLock) {
		return { status: 'error', message: 'SAST baseline capture cancelled' };
	}
	if (opts?.abortSignal?.aborted) {
		releaseLock();
		return { status: 'error', message: 'SAST baseline capture cancelled' };
	}
	try {
		// Load existing baseline. A legacy 1.0.0 baseline is also accepted so
		// its next capture MERGES (preserving non-scanned entries) and rewrites
		// it as 1.1.0 — rejecting it here would silently downgrade the capture
		// to a full replace. Legacy files carry no reflow keys, so their
		// findings can only exact-match until the rewrite (fail-closed).
		let existing: SastBaselineFile | null = null;
		try {
			const raw = fs.readFileSync(baselinePath, 'utf-8');
			const parsed = JSON.parse(raw) as SastBaselineFile;
			if (
				parsed.schema_version === BASELINE_SCHEMA_VERSION ||
				parsed.schema_version === LEGACY_BASELINE_SCHEMA_VERSION
			) {
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
			// reflow_keys[] is index-aligned with fingerprints[], so both arrays
			// are pruned and truncated by the SAME index discipline.
			const prunedFingerprints: string[] = [];
			const prunedReflowKeys: string[] = [];
			existing.fingerprints.forEach((fp, i) => {
				const relFile = fp.slice(0, fp.indexOf('|'));
				if (scannedRelFiles.has(relFile)) return;
				prunedFingerprints.push(fp);
				prunedReflowKeys.push(existing.reflow_keys?.[i] ?? '');
			});
			const prunedSnapshot = existing.findings_snapshot.filter((f) => {
				return !scannedRelFiles.has(
					normalizeFindingPath(directory, f.location.file),
				);
			});
			const prunedFilesIndexed = existing.files_indexed.filter(
				(f) => !scannedRelFiles.has(f),
			);

			// ── #2302 absorption triage ──────────────────────────────────────
			// Match current findings against the prior entries of the rescanned
			// files (exact fingerprint set + reflow multiset). Matching findings
			// are mechanical re-fingerprints; the rest are novel absorptions.
			const priorFingerprintSet = new Set<string>();
			const priorReflowCounts = new Map<string, number>();
			existing.fingerprints.forEach((fp, i) => {
				const relFile = fp.slice(0, fp.indexOf('|'));
				if (!scannedRelFiles.has(relFile)) return;
				priorFingerprintSet.add(fp);
				const key = existing.reflow_keys?.[i] ?? '';
				if (key) {
					priorReflowCounts.set(key, (priorReflowCounts.get(key) ?? 0) + 1);
				}
			});

			let blockedCount = 0;
			const blockedList: BlockedAbsorptionFinding[] = [];
			const triageEntries: BaselineTriageEntry[] = [];
			const absorbedAt = new Date().toISOString();
			const actor = opts?.actor?.trim() ? opts.actor.trim() : 'unknown-session';

			for (const { finding, stable, fingerprint, reflowKey } of indexed) {
				if (stable && priorFingerprintSet.has(fingerprint)) {
					if (reflowKey) {
						const count = priorReflowCounts.get(reflowKey) ?? 0;
						if (count > 0) priorReflowCounts.set(reflowKey, count - 1);
					}
					continue; // exact match — mechanical re-fingerprint
				}
				if (
					stable &&
					reflowKey &&
					(priorReflowCounts.get(reflowKey) ?? 0) > 0
				) {
					const matchedCount = priorReflowCounts.get(reflowKey) ?? 0;
					priorReflowCounts.set(reflowKey, matchedCount - 1);
					continue; // reflow match — moved / index-shifted, mechanical
				}
				// Novel absorption relative to the prior baseline. EVERY novel
				// finding requires an explicit audited rationale — including
				// files not previously indexed (#2302 final-critic revision:
				// the tool cannot distinguish a pre-delegation capture from a
				// failure-response recapture, so first-time files must not be
				// an implicit free-absorption path).
				const relFile = normalizeFindingPath(directory, finding.location.file);
				if (!opts?.refreshRationale) {
					blockedCount++;
					if (blockedList.length < MAX_BLOCKED_LIST) {
						blockedList.push({
							fingerprint,
							rel_file: relFile,
							rule_id: finding.rule_id,
						});
					}
					continue;
				}
				triageEntries.push({
					fingerprint,
					rel_file: relFile,
					rule_id: finding.rule_id,
					rationale: opts.refreshRationale,
					actor,
					absorbed_at: absorbedAt,
				});
			}

			if (blockedCount > 0) {
				const sample = blockedList.slice(0, 5);
				const sampleText = sample
					.map((b) => `${b.rel_file} (${b.rule_id})`)
					.join(', ');
				// Ellipsis when the sample shows fewer than the total blocked —
				// compare against the sample size, not the (capped) list length,
				// so a count of exactly MAX_BLOCKED_LIST still reads as truncated.
				const ellipsis = blockedCount > sample.length ? ', …' : '';
				return {
					status: 'absorption_blocked',
					path: baselinePath,
					blocked: blockedList,
					message:
						`capture_baseline would absorb ${blockedCount} finding(s) not present in the prior baseline ` +
						`(${sampleText}${ellipsis}). ` +
						`Pass baseline_refresh_rationale to record an audited refresh — the baseline was left unchanged (fail-closed).`,
				};
			}

			const mergedFingerprints = [
				...prunedFingerprints,
				...indexed.map((i) => i.fingerprint),
			];
			const mergedReflowKeys = [
				...prunedReflowKeys,
				...indexed.map((i) => i.reflowKey),
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
			const cappedReflowKeys = truncated
				? mergedReflowKeys.slice(-MAX_BASELINE_FINDINGS)
				: mergedReflowKeys;

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

			// Retain triage entries whose fingerprint still survives the merge
			// (non-scanned files' entries and still-present fingerprints); drop
			// dangling history for re-fingerprinted/moved findings. The drop is
			// disclosed to the caller via dropped_triage_count.
			const priorTriage = existing.triage_log ?? [];
			const cappedFingerprintSet = new Set(cappedFingerprints);
			const retainedTriage = priorTriage.filter((e) =>
				cappedFingerprintSet.has(e.fingerprint),
			);
			const droppedTriageCount = priorTriage.length - retainedTriage.length;
			const mergedTriageLog = [...retainedTriage, ...triageEntries].slice(
				-MAX_BASELINE_FINDINGS,
			);

			const now = new Date().toISOString();
			const bundle: SastBaselineFile = {
				schema_version: BASELINE_SCHEMA_VERSION,
				phase,
				created_at: existing.created_at,
				updated_at: now,
				engine,
				files_indexed: cappedFilesIndexed,
				fingerprints: cappedFingerprints,
				reflow_keys: cappedReflowKeys,
				findings_snapshot: cappedSnapshot,
				triage_log: mergedTriageLog,
				truncated,
			};

			const json = JSON.stringify(bundle, null, 2);
			if (json.length > MAX_BASELINE_BYTES) {
				return {
					status: 'error',
					message: `Baseline would exceed size cap (${json.length} bytes > ${MAX_BASELINE_BYTES} bytes)`,
				};
			}
			if (opts?.abortSignal?.aborted) {
				return { status: 'error', message: 'SAST baseline capture cancelled' };
			}
			fs.writeFileSync(tempPath, json, 'utf-8');
			if (opts?.abortSignal?.aborted) {
				fs.rmSync(tempPath, { force: true });
				return { status: 'error', message: 'SAST baseline capture cancelled' };
			}
			fs.renameSync(tempPath, baselinePath);
			invalidateCachedArtifact(baselinePath);

			return {
				status: 'merged',
				path: baselinePath,
				fingerprint_count: cappedFingerprints.length,
				absorbed_finding_count: triageEntries.length,
				dropped_triage_count: droppedTriageCount,
			};
		}

		// First write (or force). A first write is a snapshot, not an
		// acceptance — no triage entries. force replaces the whole baseline
		// (destructive by design; unreachable from the sast_scan tool).
		const newFingerprints = indexed.map((i) => i.fingerprint);
		const newReflowKeys = indexed.map((i) => i.reflowKey);
		const newSnapshot = indexed.map((i) => i.finding);
		const truncated = newSnapshot.length > MAX_BASELINE_FINDINGS;
		const cappedSnapshot = truncated
			? newSnapshot.slice(0, MAX_BASELINE_FINDINGS)
			: newSnapshot;
		const cappedFingerprints = truncated
			? newFingerprints.slice(0, MAX_BASELINE_FINDINGS)
			: newFingerprints;
		const cappedReflowKeys = truncated
			? newReflowKeys.slice(0, MAX_BASELINE_FINDINGS)
			: newReflowKeys;

		const now = new Date().toISOString();
		const bundle: SastBaselineFile = {
			schema_version: BASELINE_SCHEMA_VERSION,
			phase,
			created_at: now,
			updated_at: now,
			engine,
			files_indexed: Array.from(scannedRelFiles),
			fingerprints: cappedFingerprints,
			reflow_keys: cappedReflowKeys,
			findings_snapshot: cappedSnapshot,
			triage_log: [],
			truncated,
		};

		const json = JSON.stringify(bundle, null, 2);
		if (json.length > MAX_BASELINE_BYTES) {
			return {
				status: 'error',
				message: `Baseline would exceed size cap (${json.length} bytes > ${MAX_BASELINE_BYTES})`,
			};
		}
		if (opts?.abortSignal?.aborted) {
			return { status: 'error', message: 'SAST baseline capture cancelled' };
		}
		fs.writeFileSync(tempPath, json, 'utf-8');
		if (opts?.abortSignal?.aborted) {
			fs.rmSync(tempPath, { force: true });
			return { status: 'error', message: 'SAST baseline capture cancelled' };
		}
		fs.renameSync(tempPath, baselinePath);
		invalidateCachedArtifact(baselinePath);

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
 *
 * Schema versions: 1.1.0 files carry reflow_keys (reflow matching active);
 * legacy 1.0.0 files load read-only with an empty reflowKeys array — exact
 * matching only until the next capture rewrites them as 1.1.0 (reflow keys
 * cannot be reconstructed retroactively; findings_snapshot stores no line
 * content). A present-but-misaligned reflow_keys array is corruption and
 * fails closed to invalid_schema (legacy gating; recoverable by recapture).
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
		if (
			parsed.schema_version !== BASELINE_SCHEMA_VERSION &&
			parsed.schema_version !== LEGACY_BASELINE_SCHEMA_VERSION
		) {
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
		let reflowKeys: string[] = [];
		if (parsed.schema_version === BASELINE_SCHEMA_VERSION) {
			if (parsed.reflow_keys === undefined || parsed.reflow_keys === null) {
				// Absent (or explicit null) reflow_keys on a 1.1.0 file:
				// tolerate as exact-only (fail-closed) rather than rejecting
				// the whole baseline — semantically equivalent inputs must not
				// diverge on the storage encoding alone.
				reflowKeys = [];
			} else if (
				!Array.isArray(parsed.reflow_keys) ||
				parsed.reflow_keys.some((k) => typeof k !== 'string') ||
				parsed.reflow_keys.length !== parsed.fingerprints.length
			) {
				return {
					status: 'invalid_schema',
					errors: [
						'reflow_keys must be a string array aligned 1:1 with fingerprints',
					],
				};
			} else {
				reflowKeys = parsed.reflow_keys;
			}
		}
		return {
			status: 'found',
			fingerprints: new Set(parsed.fingerprints),
			reflowKeys,
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
	partitionAgainstBaseline: typeof partitionAgainstBaseline;
	captureOrMergeBaseline: typeof captureOrMergeBaseline;
	loadBaseline: typeof loadBaseline;
} = {
	fingerprintFinding,
	assignOccurrenceIndices,
	partitionAgainstBaseline,
	captureOrMergeBaseline,
	loadBaseline,
} as const;
