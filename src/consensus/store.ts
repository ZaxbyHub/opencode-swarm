/**
 * Immutable persistence for consensus reports (issue #1821, Workstream C).
 *
 * Reports live under `.swarm/evolution/consensus/<reportId>.json`, alongside the
 * evaluation substrate's runs and decisions. The write goes through the shared
 * `writeImmutableArtifact` pipeline in `src/evidence/immutable-store.ts` — the
 * same one the evaluation store binds — so the lock/read/compare/atomic-rename
 * sequence exists exactly once in the codebase. This module supplies only the
 * three parameters that pipeline deliberately leaves to its callers: the lock
 * actor, the canonical serializer, and the conflict-error factory.
 *
 * Idempotence has one wrinkle a report has and a run does not: `generatedAt` is
 * a wall clock. Two mining runs over an identical corpus produce byte-identical
 * reports except for that timestamp, so an `isEquivalent` escape hatch treats
 * them as the same artifact — exactly how `savePromotionDecision` handles
 * `decidedAt`. A report that differs in any *content* field still conflicts.
 */

import { readdir, unlink } from 'node:fs/promises';
import * as path from 'node:path';
import { canonicalJson } from '../evaluation/hashing.js';
import {
	type ImmutableArtifactConflict,
	readOptionalFile,
	writeImmutableArtifact,
} from '../evidence/immutable-store.js';
import type { ConsensusReportV1 } from './contracts.js';
import { ConsensusReportV1Schema } from './contracts.js';
import { computeConsensusIntegrityHash } from './miner.js';

/** Lock actor. Distinct from `evaluation-store` so lock telemetry stays honest. */
const AGENT = 'consensus-store';

/** Relative location under `.swarm/`. */
const CONSENSUS_RELATIVE_DIR = path.join('evolution', 'consensus');

const REPORT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;

/** Bounds a listing so a pathological directory cannot stall the caller. */
const MAX_LISTED_REPORTS = 1000;

export class ConsensusConflictError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ConsensusConflictError';
	}
}

export class ConsensusIntegrityError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ConsensusIntegrityError';
	}
}

function swarmPath(directory: string, ...segments: string[]): string {
	return path.join(directory, '.swarm', ...segments);
}

function serialized(value: unknown): string {
	return `${canonicalJson(value)}\n`;
}

function relativeReportPath(reportId: string): string {
	return path.join(CONSENSUS_RELATIVE_DIR, `${reportId}.json`);
}

/** Consensus-store wording for the shared writer's conflict outcomes. */
function consensusConflictError(conflict: ImmutableArtifactConflict): Error {
	return conflict.kind === 'corrupt'
		? new ConsensusConflictError(
				`existing consensus report is corrupt: ${conflict.filePath}: ${String(conflict.cause)}`,
			)
		: new ConsensusConflictError(
				`immutable consensus report conflicts with existing content: ${conflict.filePath}`,
			);
}

/**
 * Reject a report id that would escape `.swarm/evolution/consensus/`.
 *
 * The id becomes a filename, so a `../` or an absolute path in it is a
 * containment break (AGENTS.md invariant 4). Validated here rather than relying
 * on the schema's looser `ReferenceSchema`, which intentionally permits `/` for
 * model ids and evidence refs.
 */
function assertSafeReportId(reportId: string): void {
	if (!REPORT_ID_RE.test(reportId)) {
		throw new ConsensusIntegrityError(
			`invalid consensus report id: ${JSON.stringify(reportId)}`,
		);
	}
}

/**
 * Persist a report exactly once.
 *
 * The integrity hash is **verified before persist**, not merely recorded: a
 * report whose declared hash does not match its own content is rejected rather
 * than written, so a corrupted or hand-edited report can never enter the store
 * and later be trusted on read.
 */
export async function writeConsensusReport(
	directory: string,
	input: ConsensusReportV1,
): Promise<ConsensusReportV1> {
	const report = ConsensusReportV1Schema.parse(input) as ConsensusReportV1;
	assertSafeReportId(report.reportId);
	const expected = computeConsensusIntegrityHash(report);
	if (expected !== report.integrityHash) {
		throw new ConsensusIntegrityError(
			`consensus report ${report.reportId} integrity hash does not match its content`,
		);
	}
	const relative = relativeReportPath(report.reportId);
	return writeImmutableArtifact<ConsensusReportV1>({
		directory,
		relativeLockPath: relative,
		filePath: swarmPath(directory, relative),
		agent: AGENT,
		taskId: report.reportId,
		value: report,
		serialize: serialized,
		parse: (value) => ConsensusReportV1Schema.parse(value) as ConsensusReportV1,
		// Same content, different wall clock ⇒ the same artifact. Both hashes are
		// RECOMPUTED from content rather than read off the artifacts, so a
		// forged `integrityHash` cannot talk its way past this check. Any real
		// content difference falls through to the pipeline's divergence
		// rejection.
		isEquivalent: (existing, desired) =>
			computeConsensusIntegrityHash(existing) ===
			computeConsensusIntegrityHash(desired),
		conflictError: consensusConflictError,
	});
}

/**
 * Read one report. Returns `undefined` when absent.
 *
 * Re-verifies the integrity hash on the way out: a report that was tampered with
 * on disk after being written must not be handed to a caller as authoritative.
 */
export async function readConsensusReport(
	directory: string,
	reportId: string,
): Promise<ConsensusReportV1 | undefined> {
	assertSafeReportId(reportId);
	const content = await readOptionalFile(
		swarmPath(directory, relativeReportPath(reportId)),
	);
	if (content === undefined) return undefined;
	const report = ConsensusReportV1Schema.parse(
		JSON.parse(content),
	) as ConsensusReportV1;
	if (computeConsensusIntegrityHash(report) !== report.integrityHash) {
		throw new ConsensusIntegrityError(
			`consensus report ${reportId} failed integrity verification on read`,
		);
	}
	return report;
}

export type ConsensusListSummary = {
	reports: ConsensusReportV1[];
	/** Report ids present on disk that failed to parse or verify. */
	corruptReportIds: string[];
};

/**
 * Enumerate every stored report, newest first.
 *
 * Corrupt entries are reported rather than thrown so one bad file cannot make
 * the whole history unreadable — the same posture `listGateAuditResults` takes.
 * Sorted by `generatedAt` descending, ties broken by id, so the ordering is
 * total and reproducible.
 */
export async function listConsensusReports(
	directory: string,
): Promise<ConsensusListSummary> {
	const root = swarmPath(directory, CONSENSUS_RELATIVE_DIR);
	let entries: import('node:fs').Dirent[];
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return { reports: [], corruptReportIds: [] };
		}
		throw error;
	}
	const reports: ConsensusReportV1[] = [];
	const corruptReportIds: string[] = [];
	const ids = entries
		.filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
		.map((entry) => entry.name.slice(0, -'.json'.length))
		.filter((id) => REPORT_ID_RE.test(id))
		.sort()
		.slice(0, MAX_LISTED_REPORTS);
	for (const id of ids) {
		try {
			const report = await readConsensusReport(directory, id);
			if (!report) continue;
			if (report.reportId !== id) throw new Error('report id/path mismatch');
			reports.push(report);
		} catch {
			corruptReportIds.push(id);
		}
	}
	reports.sort(
		(left, right) =>
			right.generatedAt.localeCompare(left.generatedAt) ||
			left.reportId.localeCompare(right.reportId),
	);
	return { reports, corruptReportIds };
}

export type ConsensusPruneResult = {
	/** Report ids deleted, oldest-first. */
	deleted: string[];
	/** Report ids retained. */
	retained: string[];
	/** Ids that failed to delete, with the reason. Never fatal. */
	failed: Array<{ reportId: string; error: string }>;
};

/**
 * Enforce `consensus.report_retention`.
 *
 * Deliberate posture, mirroring the evaluation substrate's retention rules:
 * - `retain === 0` **disables** pruning rather than deleting everything. The
 *   schema's `min(0)` bound reads as "the constraint is off", the same way
 *   `default_min_successful_runs: 0` turns that gate off. Interpreting it as
 *   "keep zero reports" would delete the report the caller just wrote.
 * - Corrupt reports are **never** deleted. An unparseable artifact is data-
 *   quality evidence; silently discarding it destroys the only trace of the bug
 *   that produced it.
 * - Newest-first by `generatedAt`, ties broken by id, so pruning is a total
 *   order and two runs over the same store delete the same files.
 * - Only files directly under `.swarm/evolution/consensus/` with a validated
 *   `<id>.json` name are candidates; nothing recurses (AGENTS.md invariant 4).
 */
export async function pruneConsensusReports(
	directory: string,
	retain: number,
): Promise<ConsensusPruneResult> {
	if (!Number.isInteger(retain) || retain <= 0) {
		return { deleted: [], retained: [], failed: [] };
	}
	const { reports } = await listConsensusReports(directory);
	// `listConsensusReports` already returns newest-first.
	const keep = reports.slice(0, retain);
	const drop = reports.slice(retain);
	const deleted: string[] = [];
	const failed: ConsensusPruneResult['failed'] = [];
	for (const report of drop) {
		try {
			await unlink(swarmPath(directory, relativeReportPath(report.reportId)));
			deleted.push(report.reportId);
		} catch (error) {
			failed.push({
				reportId: report.reportId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return {
		deleted,
		retained: keep.map((report) => report.reportId),
		failed,
	};
}

/**
 * Every proposal fingerprint already present in the store.
 *
 * This is what the miner dedupes against so a standing recommendation is not
 * re-proposed on every run. Corrupt reports are skipped: an unreadable prior
 * report is a reason to re-propose, not to crash.
 */
export async function listConsensusProposalFingerprints(
	directory: string,
): Promise<Set<string>> {
	const { reports } = await listConsensusReports(directory);
	const fingerprints = new Set<string>();
	for (const report of reports) {
		for (const proposal of report.proposals) {
			fingerprints.add(proposal.fingerprint);
		}
	}
	return fingerprints;
}
