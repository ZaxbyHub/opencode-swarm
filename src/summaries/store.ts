/**
 * Persistence for the architecture-summary tiers (issue #893).
 *
 * Storage strategy (verified against the evidence system):
 *  - Per-agent summaries are stored as `note` evidence entries via saveEvidence(), with
 *    the structured payload under `metadata` (EvidenceBundleSchema parses entries through
 *    a discriminated union and strips unknown top-level keys, so the payload MUST live in
 *    metadata).
 *  - Phase summaries and the supervisor report are written as raw sidecar bundles
 *    (temp-file + rename), mirroring submit-phase-council-verdicts.ts, so the gate can
 *    read top-level fields (verdict, phase_number, timestamp) without zod stripping them.
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs';
import * as path from 'node:path';
import {
	listEvidenceTaskIds,
	loadEvidence,
	saveEvidence,
} from '../evidence/manager';
import { validateSwarmPath } from '../hooks/utils';
import { warn } from '../utils';
import {
	type AgentWorkSummary,
	AgentWorkSummarySchema,
	type ArchitectureSupervisorReport,
	type PhaseArchitectureSummary,
} from './schema';

export const AGENT_SUMMARY_METADATA_KIND = 'agent_summary';
const PHASE_SUMMARY_FILE = 'phase-architecture-summary.json';
const SUPERVISOR_REPORT_FILE = 'architecture-supervisor.json';
const SUPERVISOR_ENTRY_TYPE = 'architecture-supervisor';

/** Atomic raw sidecar write: temp-file + rename (mirrors the council writer). */
function writeRawSidecar(absPath: string, bundle: unknown): void {
	mkdirSync(path.dirname(absPath), { recursive: true });
	const tempFile = `${absPath}.tmp-${Date.now()}-${process.pid}`;
	try {
		writeFileSync(tempFile, JSON.stringify(bundle, null, 2), 'utf-8');
		renameSync(tempFile, absPath);
	} finally {
		if (existsSync(tempFile)) {
			try {
				unlinkSync(tempFile);
			} catch {
				/* best-effort cleanup */
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Tier 1: per-agent summaries (stored as note evidence)
// ---------------------------------------------------------------------------

/**
 * Persist a per-agent work summary as a `note` evidence entry. The structured payload
 * lives entirely under metadata so it survives EvidenceBundleSchema validation.
 * Keyed by the agent's task_id when present, else a synthetic phase-scoped bucket.
 */
export async function writeAgentSummary(
	directory: string,
	summary: AgentWorkSummary,
): Promise<string> {
	const taskId = summary.task_id ?? `phase-${summary.phase}-summaries`;
	await saveEvidence(directory, taskId, {
		task_id: taskId,
		type: 'note',
		timestamp: summary.created_at,
		agent: summary.agent,
		verdict: 'info',
		summary: summary.summary,
		metadata: {
			kind: AGENT_SUMMARY_METADATA_KIND,
			phase: summary.phase,
			session_id: summary.session_id,
			payload: summary,
		},
	});
	return taskId;
}

export interface ListAgentSummariesFilter {
	phase?: number;
	session?: string;
}

/**
 * Scan all evidence bundles and return the agent work summaries matching the filter.
 * Malformed payloads are skipped (logged, never thrown) so aggregation stays fail-open.
 */
export async function listAgentSummaries(
	directory: string,
	filter: ListAgentSummariesFilter = {},
): Promise<AgentWorkSummary[]> {
	const taskIds = await listEvidenceTaskIds(directory);
	const results: AgentWorkSummary[] = [];

	for (const taskId of taskIds) {
		const loaded = await loadEvidence(directory, taskId);
		if (loaded.status !== 'found') continue;

		for (const entry of loaded.bundle.entries) {
			if (entry.type !== 'note') continue;
			const meta = entry.metadata;
			if (!meta || meta.kind !== AGENT_SUMMARY_METADATA_KIND) continue;
			if (filter.phase !== undefined && meta.phase !== filter.phase) continue;
			if (filter.session !== undefined && meta.session_id !== filter.session) {
				continue;
			}

			const parsed = AgentWorkSummarySchema.safeParse(meta.payload);
			if (!parsed.success) {
				warn(
					`Skipping malformed agent summary in task ${taskId}: ${parsed.error.issues.map((i) => i.message).join(', ')}`,
				);
				continue;
			}
			results.push(parsed.data);
		}
	}

	return results;
}

// ---------------------------------------------------------------------------
// Tier 2: phase architecture summary (raw sidecar)
// ---------------------------------------------------------------------------

export function writePhaseArchitectureSummary(
	directory: string,
	summary: PhaseArchitectureSummary,
): string {
	const rel = path.join('evidence', String(summary.phase), PHASE_SUMMARY_FILE);
	const abs = validateSwarmPath(directory, rel);
	writeRawSidecar(abs, summary);
	return abs;
}

export function readPhaseArchitectureSummary(
	directory: string,
	phase: number,
): PhaseArchitectureSummary | null {
	const rel = path.join('evidence', String(phase), PHASE_SUMMARY_FILE);
	let abs: string;
	try {
		abs = validateSwarmPath(directory, rel);
	} catch {
		return null;
	}
	if (!existsSync(abs)) return null;
	try {
		return JSON.parse(readFileSync(abs, 'utf-8')) as PhaseArchitectureSummary;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Tier 3: supervisor report (raw sidecar, gate-readable shape)
// ---------------------------------------------------------------------------

/**
 * Write the supervisor report as a raw sidecar bundle whose single entry carries
 * top-level `verdict`, `phase_number`, and `timestamp` — exactly the shape the
 * phase-complete gate reads via fs.readFileSync + JSON.parse (mirrors phase-council).
 */
export function writeSupervisorReport(
	directory: string,
	report: ArchitectureSupervisorReport,
): string {
	const rel = path.join(
		'evidence',
		String(report.phase),
		SUPERVISOR_REPORT_FILE,
	);
	const abs = validateSwarmPath(directory, rel);
	const bundle = {
		entries: [
			{
				type: SUPERVISOR_ENTRY_TYPE,
				phase_number: report.phase,
				scope: 'phase',
				timestamp: report.created_at,
				verdict: report.verdict,
				findings: report.findings,
				knowledge_recommendations: report.knowledge_recommendations,
				...(report.provenance ? { provenance: report.provenance } : {}),
			},
		],
	};
	writeRawSidecar(abs, bundle);
	return abs;
}

/** A single raw supervisor entry as read back from the sidecar (untyped JSON). */
export interface RawSupervisorEntry {
	type: string;
	phase_number?: number;
	timestamp?: string;
	verdict?: string;
	findings?: unknown[];
	knowledge_recommendations?: unknown[];
	provenance?: {
		agent_name?: string;
		session_id?: string;
		captured_at?: string;
	};
}

/**
 * Read the supervisor report sidecar raw (no zod), returning the supervisor entry or
 * null when the file is missing/malformed. This is the read path the gate uses.
 */
export function readSupervisorReportRaw(
	directory: string,
	phase: number,
): RawSupervisorEntry | null {
	const rel = path.join('evidence', String(phase), SUPERVISOR_REPORT_FILE);
	let abs: string;
	try {
		abs = validateSwarmPath(directory, rel);
	} catch {
		return null;
	}
	if (!existsSync(abs)) return null;
	try {
		const parsed = JSON.parse(readFileSync(abs, 'utf-8')) as {
			entries?: RawSupervisorEntry[];
		};
		const entry = parsed.entries?.find((e) => e.type === SUPERVISOR_ENTRY_TYPE);
		return entry ?? null;
	} catch {
		return null;
	}
}
