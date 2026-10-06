/**
 * One-time retirement of Epic v1 session state (Epic v2 C1a).
 *
 * Epic v1 kept a per-session "Epic on" flag in the coordination namespace
 * `turbo.epic.session` with `.swarm/epic-state.json` as its projection. v2
 * epics are plan-scoped and opened only by `/swarm epic start`, so v1 state
 * is never imported as an open epic: it is retired here — rows deleted, the
 * projection renamed to `.imported` — and any session that was still "on"
 * yields an advisory to run `/swarm epic start`.
 *
 * Runs only inside `/swarm epic status` (never on a probe/hot path). Opens
 * swarm.db only when it already exists. Idempotent: once retired there is
 * nothing left to find.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	deleteCoordinationState,
	listCoordinationStates,
} from '../db/coordination-store.js';
import { projectDbExists } from '../db/project-db.js';

/** The retired v1 coordination namespace. */
export const LEGACY_EPIC_SESSION_NAMESPACE = 'turbo.epic.session';
const LEGACY_STATE_FILE = 'epic-state.json';
const MAX_LEGACY_FILE_BYTES = 4 * 1024 * 1024;
const MAX_ARCHIVE_SUFFIX = 1_000;

export interface LegacyEpicMigrationResult {
	rowsRemoved: number;
	/** Sessions that still had Epic v1 switched on. */
	activeSessions: number;
	fileArchivedTo: string | null;
	errors: string[];
}

function archiveWithoutOverwrite(filePath: string): string {
	const canonical = `${filePath}.imported`;
	if (!fs.existsSync(canonical)) {
		fs.renameSync(filePath, canonical);
		return canonical;
	}
	for (let suffix = 1; suffix <= MAX_ARCHIVE_SUFFIX; suffix += 1) {
		const candidate = `${canonical}.${suffix}`;
		if (fs.existsSync(candidate)) continue;
		fs.renameSync(filePath, candidate);
		return candidate;
	}
	throw new Error('legacy Epic state archive collision limit exceeded');
}

function countActiveInLegacyFile(filePath: string): number {
	const stat = fs.statSync(filePath);
	if (!stat.isFile() || stat.size > MAX_LEGACY_FILE_BYTES) return 0;
	const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as {
		sessions?: Record<string, { active?: unknown }>;
	};
	return Object.values(parsed.sessions ?? {}).filter(
		(session) => session?.active === true,
	).length;
}

export function retireLegacyEpicSessionState(
	directory: string,
): LegacyEpicMigrationResult {
	const result: LegacyEpicMigrationResult = {
		rowsRemoved: 0,
		activeSessions: 0,
		fileArchivedTo: null,
		errors: [],
	};
	const activeIds = new Set<string>();
	if (projectDbExists(directory)) {
		try {
			const rows = listCoordinationStates(
				directory,
				LEGACY_EPIC_SESSION_NAMESPACE,
			);
			for (const row of rows) {
				if (row.status === 'active') activeIds.add(row.entityKey);
				if (
					deleteCoordinationState(
						directory,
						LEGACY_EPIC_SESSION_NAMESPACE,
						row.entityKey,
						row.revision,
					)
				) {
					result.rowsRemoved += 1;
				}
			}
		} catch (error) {
			result.errors.push(
				`legacy Epic session rows: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	const filePath = path.join(directory, '.swarm', LEGACY_STATE_FILE);
	if (fs.existsSync(filePath)) {
		let fileActive = 0;
		try {
			fileActive = countActiveInLegacyFile(filePath);
		} catch {
			fileActive = 0; // unreadable projection: archive it anyway
		}
		try {
			result.fileArchivedTo = path.relative(
				directory,
				archiveWithoutOverwrite(filePath),
			);
		} catch (error) {
			result.errors.push(
				`.swarm/${LEGACY_STATE_FILE}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		result.activeSessions = Math.max(activeIds.size, fileActive);
	} else {
		result.activeSessions = activeIds.size;
	}
	return result;
}

/** Status lines for a non-empty migration result (empty otherwise). */
export function describeLegacyEpicMigration(
	result: LegacyEpicMigrationResult,
): string[] {
	if (
		result.rowsRemoved === 0 &&
		result.fileArchivedTo === null &&
		result.errors.length === 0
	) {
		return [];
	}
	const lines = ['', '### Legacy Epic v1 state'];
	if (result.rowsRemoved > 0 || result.fileArchivedTo !== null) {
		lines.push(
			`Retired Epic v1 per-session state (${result.rowsRemoved} row(s)${result.fileArchivedTo ? `; projection archived to \`${result.fileArchivedTo}\`` : ''}). Epic v1 \`/swarm epic on|off\` no longer exists — epics are plan-scoped.`,
		);
	}
	if (result.activeSessions > 0) {
		lines.push(
			`${result.activeSessions} session(s) had Epic v1 switched on. Nothing was opened automatically: run \`/swarm epic start\` to open an epic for the current plan.`,
		);
	}
	for (const error of result.errors) {
		lines.push(`⚠️ Could not retire ${error}`);
	}
	return lines;
}
