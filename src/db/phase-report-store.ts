/**
 * swarm.db store for per-phase reports (issue #2480 D1 migration).
 *
 * Replaces two legacy file families with the entity/KV pattern — one row per
 * (kind, phase), last-write-wins on a same-phase re-run:
 * - `.swarm/drift-report-phase-{N}.json` (curator drift, kind
 *   `curator_drift`) — written by `src/hooks/curator-drift.ts`, read back by
 *   `readPriorDriftReports` and the curator postmortem.
 * - `.swarm/doc-drift-phase-{N}.json` (design-doc drift, kind
 *   `design_doc_drift`) — written by `src/hooks/design-doc-drift.ts` (whose
 *   legacy bare `writeFile` was non-atomic; the store fixes that).
 *
 * Payloads are opaque serialized JSON strings; readers own validation
 * (skip-corrupt on read, mirroring the legacy readers).
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalProjectKey } from './canonical-project.js';
import { DURABILITY_CLASSES } from './durability.js';
import { getGroupCommitWriter } from './group-commit-writer.js';
import { importLegacyJsonFiles } from './legacy-import.js';
import { getProjectDb, projectDbExists } from './project-db.js';

export type PhaseReportKind = 'curator_drift' | 'design_doc_drift';

/** Legacy filename prefixes, one per report kind. */
export const PHASE_REPORT_LEGACY_PREFIXES: Readonly<
	Record<PhaseReportKind, string>
> = {
	curator_drift: 'drift-report-phase-',
	design_doc_drift: 'doc-drift-phase-',
};

const importedRoots = new Set<string>();

/**
 * #2480 never-opens-for-create guard for read-shaped entry points (mirrors
 * hasAnyInsightState): a project with neither a swarm.db NOR a legacy report
 * file has nothing to read, and reading it must not materialize a DB. When a
 * legacy file IS present the read proceeds (the lazy import then creates the
 * DB — the sanctioned migration path).
 */
function hasAnyPhaseReportState(directory: string): boolean {
	if (projectDbExists(directory)) return true;
	const root = canonicalProjectKey(directory);
	let entries: string[];
	try {
		entries = readdirSync(join(root, '.swarm'));
	} catch {
		return false; // no .swarm dir — nothing to read
	}
	for (const prefix of Object.values(PHASE_REPORT_LEGACY_PREFIXES)) {
		if (
			entries.some(
				(name) =>
					name.startsWith(prefix) &&
					name.endsWith('.json') &&
					!name.includes('.imported'),
			)
		) {
			return true;
		}
	}
	return false;
}

interface PhaseReportRow {
	phase: number;
	payload: string;
}

function kindCount(
	db: ReturnType<typeof getProjectDb>,
	kind: PhaseReportKind,
): number {
	return (
		db
			.query<{ count: number }, [string]>(
				'SELECT COUNT(*) as count FROM phase_report WHERE kind = ?',
			)
			.get(kind)?.count ?? 0
	);
}

/**
 * One-time (per process, per canonical root) lazy import of both legacy
 * report families. Never runs at plugin init.
 */
export function ensurePhaseReportsImported(directory: string): void {
	const root = canonicalProjectKey(directory);
	if (importedRoots.has(root)) return;
	for (const kind of Object.keys(
		PHASE_REPORT_LEGACY_PREFIXES,
	) as PhaseReportKind[]) {
		importLegacyJsonFiles(directory, {
			filePrefix: PHASE_REPORT_LEGACY_PREFIXES[kind],
			kind,
			kindCount: (db) => kindCount(db, kind),
			upsertRow: (db, phase, payload) => {
				db.run(
					`INSERT INTO phase_report (kind, phase, payload, updated_at)
					VALUES (?, ?, ?, datetime('now'))
					ON CONFLICT(kind, phase) DO UPDATE SET
						payload = excluded.payload,
						updated_at = datetime('now')`,
					[kind, phase, payload],
				);
			},
		});
	}
	// Mark imported ONLY on success (retry on transient failure) — mirrors
	// ensureInsightLegacyImported.
	importedRoots.add(root);
}

/**
 * Upsert one phase report via the group-commit writer and await the flush.
 * A same-phase re-run overwrites the row (the legacy file rewrite semantic)
 * and `updated_at` moves.
 */
export async function upsertPhaseReportDb(
	directory: string,
	kind: PhaseReportKind,
	phase: number,
	payload: string,
): Promise<void> {
	ensurePhaseReportsImported(directory);
	const writer = getGroupCommitWriter(directory);
	writer.enqueue({
		durability: DURABILITY_CLASSES.phase_report,
		run: (db) => {
			db.run(
				`INSERT INTO phase_report (kind, phase, payload, updated_at)
				VALUES (?, ?, ?, datetime('now'))
				ON CONFLICT(kind, phase) DO UPDATE SET
					payload = excluded.payload,
					updated_at = datetime('now')`,
				[kind, phase, payload],
			);
		},
	});
	await writer.flush();
}

/**
 * Read all reports of one kind, ascending by phase. Returns the raw payload
 * strings; the caller validates (the curator drift reader keeps its
 * skip-corrupt schema check).
 */
export function readPhaseReportsDb(
	directory: string,
	kind: PhaseReportKind,
): Array<{ phase: number; payload: string }> {
	if (!hasAnyPhaseReportState(directory)) return [];
	ensurePhaseReportsImported(directory);
	const db = getProjectDb(directory);
	return db
		.query<PhaseReportRow, [string]>(
			'SELECT phase, payload FROM phase_report WHERE kind = ? ORDER BY phase',
		)
		.all(kind)
		.map((row) => ({ phase: row.phase, payload: row.payload }));
}

/**
 * Stable, human-readable locator for a stored report (event payloads and
 * advisory text reference the DB-backed store instead of a file path).
 */
export function phaseReportLocator(
	kind: PhaseReportKind,
	phase: number,
): string {
	return `swarm.db:phase_report(${kind},${phase})`;
}

/** Test hook: reset the per-process import guards. */
export function _resetPhaseReportImportGuards(): void {
	importedRoots.clear();
}
