/**
 * Read-only dashboard data layer (issue #2509).
 *
 * Every view composes the repo's existing bounded read APIs — this module
 * performs no durable writes and holds no authoritative state. Design rules
 * (AGENTS invariants 4/5, issue #2509 AC4/AC6/AC7):
 *
 * - DB reads go through the sanctioned read-only surface
 *   (`withProjectDbReadOnly`) or store readers that already fail closed on an
 *   absent DB; anything that would open the shared writer handle is guarded
 *   by `projectDbExists` so a read-only view can never materialize a
 *   `.swarm/` tree that does not exist yet.
 * - Every string rendered into a payload passes through
 *   `sanitizeFailureEvidenceDisplay` (the no-secrets posture AC3 names) —
 *   no field class is exempt; plain identifiers simply survive it.
 * - Row counts and per-field lengths are capped so responses stay bounded
 *   against very large stores (AC7).
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { readDelegations } from '../background/pending-delegations.js';
import {
	getSwarmDbHealthSnapshot,
	type SwarmDbHealthSnapshot,
} from '../db/health.js';
import {
	queryObservabilityEvents,
	readObservabilityCoverage,
} from '../db/observability-event-store.js';
import { projectDbExists, withProjectDbReadOnly } from '../db/project-db.js';
import { sanitizeFailureEvidenceDisplay } from '../failures/invocation-failure.js';
import { loadPlanJsonOnly } from '../plan/manager.js';

/** Bound: delegation rows rendered per response. */
const MAX_DELEGATION_ROWS = 200;
/** Bound: task rows rendered per response. */
const MAX_TASK_ROWS = 200;
/** Bound: timeline events rendered per response (also caps distinct payload markers). */
const MAX_TIMELINE_ROWS = 100;
/** Bound: gate-state files scanned for circuit records. */
const MAX_GATE_STATE_FILES = 50;
/** Lane liveness horizon (mirrors the 30-minute delegation reachability floor). */
const LANE_STALE_HORIZON_MS = 30 * 60_000;

/**
 * Credential-bearing userinfo in ANY scheme's URL (`scheme://user:pass@host`)
 * — e.g. `postgres://u:secret@db/x`. The house sanitizer's URL redaction
 * targets web URLs; this prescrub closes the non-http-scheme gap before the
 * sanitizer runs, so rendered payloads never echo URL-embedded secrets.
 */
const URL_USERINFO_CREDENTIAL =
	/([a-zA-Z][a-zA-Z0-9+.-]*):\/\/[^\s/@:]+:[^\s/@]+@/g;

/** One sanitized string — the single rendering rule for every text field. */
function clean(value: unknown): string {
	const raw =
		typeof value === 'string'
			? value
			: value === null || value === undefined
				? ''
				: String(value);
	return sanitizeFailureEvidenceDisplay(
		raw.replace(URL_USERINFO_CREDENTIAL, '$1://<redacted>@'),
	);
}

interface GateProfileSummaryRow {
	planId: string;
	enabledGates: string[];
}

interface CircuitSummaryRow {
	label: string;
	state: string;
	generation: number | null;
	since: string | null;
}

export interface GatesView {
	available: boolean;
	unavailableReason?: string;
	profileCount: number;
	profiles: GateProfileSummaryRow[];
	enabledCounts: Record<string, number>;
	circuits: CircuitSummaryRow[];
}

export interface DelegationBandRow {
	band: string;
	count: number;
	oldestAgeMs: number | null;
}

export interface DelegationRow {
	correlationId: string;
	agent: string;
	status: string;
	planTaskId: string;
	ageMinutes: number | null;
}

export interface DelegationsView {
	available: boolean;
	unavailableReason?: string;
	total: number;
	bands: DelegationBandRow[];
	recent: DelegationRow[];
}

export interface LaneRow {
	correlationId: string;
	laneId: string;
	batchId: string;
	workflowLane: string;
	status: string;
	pendingMinutes: number | null;
	staleSuspect: boolean;
}

export interface LanesView {
	available: boolean;
	unavailableReason?: string;
	lanes: LaneRow[];
	staleSuspectCount: number;
}

export interface TaskRow {
	id: string;
	phase: number;
	status: string;
	description: string;
}

export interface TasksView {
	available: boolean;
	unavailableReason?: string;
	title: string;
	currentPhase: number | null;
	tasks: TaskRow[];
}

export interface TimelineEventRow {
	occurredAt: string;
	kind: string;
	severity: string;
	taskId: string;
	sessionId: string;
	payload: string;
}

export interface TimelineView {
	available: boolean;
	unavailableReason?: string;
	totalMatching: number;
	truncated: boolean;
	events: TimelineEventRow[];
}

export interface OverviewView {
	dbHealth: SwarmDbHealthSnapshot;
	gates: GatesView;
	delegations: DelegationsView;
	lanes: LanesView;
	tasks: TasksView;
	timeline: TimelineView;
}

function ageBandOf(ageMs: number): string {
	if (ageMs < 5 * 60_000) return 'fresh (<5m)';
	if (ageMs < 30 * 60_000) return 'aging (5-30m)';
	if (ageMs < 2 * 60 * 60_000) return 'stale-risk (30m-2h)';
	return 'ancient (>2h)';
}

/** Never throws: a busy/locked store degrades to an unavailable view. */
function guard<T>(view: () => T, label: string): T {
	try {
		return view();
	} catch (err) {
		return {
			available: false,
			unavailableReason: `${label}: ${
				err instanceof Error ? err.message : String(err)
			}`.slice(0, 200),
		} as T;
	}
}

export function renderGatesView(directory: string): GatesView {
	return guard((): GatesView => {
		const circuits = readCircuitSummaries(directory);
		if (!projectDbExists(directory)) {
			return {
				available: false,
				unavailableReason: 'swarm.db absent',
				profileCount: 0,
				profiles: [],
				enabledCounts: {},
				circuits,
			};
		}
		const rows =
			withProjectDbReadOnly(directory, (db) =>
				db
					.query<{ plan_id: string; gates: string }, []>(
						'SELECT plan_id, gates FROM qa_gate_profile',
					)
					.all(),
			) ?? [];
		const profiles: GateProfileSummaryRow[] = [];
		const enabledCounts: Record<string, number> = {};
		for (const row of rows) {
			let enabled: string[] = [];
			try {
				const parsed = JSON.parse(row.gates) as Record<string, unknown>;
				enabled = Object.keys(parsed).filter((k) => parsed[k] === true);
			} catch {
				enabled = [];
			}
			const planId = clean(row.plan_id);
			profiles.push({ planId, enabledGates: enabled.map(clean) });
			for (const gate of enabled) {
				const key = clean(gate);
				enabledCounts[key] = (enabledCounts[key] ?? 0) + 1;
			}
		}
		profiles.sort((a, b) => a.planId.localeCompare(b.planId));
		return {
			available: true,
			profileCount: profiles.length,
			profiles: profiles.slice(0, MAX_TASK_ROWS),
			enabledCounts,
			circuits,
		};
	}, 'gates');
}

/** Circuit state lives inside PR-workflow gate-state files; render latest K. */
function readCircuitSummaries(directory: string): CircuitSummaryRow[] {
	const gatesDir = path.join(directory, '.swarm', 'pr-workflow-gates');
	let entries: { name: string; mtimeMs: number }[] = [];
	try {
		entries = readdirSync(gatesDir)
			.filter((name) => name.endsWith('.json'))
			.map((name) => {
				const full = path.join(gatesDir, name);
				return { name, mtimeMs: statSync(full).mtimeMs };
			});
	} catch {
		return [];
	}
	entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
	const circuits: CircuitSummaryRow[] = [];
	for (const entry of entries.slice(0, MAX_GATE_STATE_FILES)) {
		try {
			const raw = JSON.parse(
				readFileSync(path.join(gatesDir, entry.name), 'utf8'),
			) as {
				prReviewResilience?: {
					circuit?: {
						state?: string;
						generation?: number;
						openedAt?: number | string | null;
					};
				};
			};
			const circuit = raw.prReviewResilience?.circuit;
			if (!circuit) continue;
			const openedAt = circuit.openedAt;
			const since =
				typeof openedAt === 'number'
					? new Date(openedAt).toISOString()
					: typeof openedAt === 'string'
						? openedAt
						: null;
			circuits.push({
				label: clean(entry.name),
				state: clean(circuit.state ?? 'unknown'),
				generation:
					typeof circuit.generation === 'number' ? circuit.generation : null,
				since: since === null ? null : clean(since),
			});
		} catch {
			// unreadable/degraded state file — skip, the dashboard is read-only
		}
	}
	return circuits;
}

export function renderDelegationsView(directory: string): DelegationsView {
	return guard((): DelegationsView => {
		const now = Date.now();
		const records = readDelegations(directory);
		const active = records.filter(
			(r) => r.status === 'pending' || r.status === 'running',
		);
		const byBand = new Map<string, { count: number; oldest: number | null }>();
		for (const rec of active) {
			const ageMs = Math.max(0, now - rec.updatedAt);
			const band = ageBandOf(ageMs);
			const slot = byBand.get(band) ?? { count: 0, oldest: null };
			slot.count += 1;
			slot.oldest = slot.oldest === null ? ageMs : Math.max(slot.oldest, ageMs);
			byBand.set(band, slot);
		}
		const bands: DelegationBandRow[] = [
			'fresh (<5m)',
			'aging (5-30m)',
			'stale-risk (30m-2h)',
			'ancient (>2h)',
		].map((band) => {
			const slot = byBand.get(band);
			return {
				band,
				count: slot?.count ?? 0,
				oldestAgeMs: slot?.oldest ?? null,
			};
		});
		const recent = [...records]
			.sort((a, b) => b.updatedAt - a.updatedAt)
			.slice(0, MAX_DELEGATION_ROWS)
			.map((rec) => ({
				correlationId: clean(rec.correlationId),
				agent: clean(rec.normalizedAgent),
				status: clean(rec.status),
				planTaskId: clean(rec.planTaskId ?? ''),
				ageMinutes:
					typeof rec.updatedAt === 'number'
						? Math.round(Math.max(0, now - rec.updatedAt) / 60_000)
						: null,
			}));
		return {
			available: true,
			total: records.length,
			bands,
			recent,
		};
	}, 'delegations');
}

export function renderLanesView(directory: string): LanesView {
	return guard((): LanesView => {
		const now = Date.now();
		const records = readDelegations(directory).filter(
			(r) =>
				(r.laneId !== undefined ||
					r.batchId !== undefined ||
					r.workflowLane !== undefined) &&
				(r.status === 'pending' || r.status === 'running'),
		);
		const lanes: LaneRow[] = records
			.sort((a, b) => b.updatedAt - a.updatedAt)
			.slice(0, MAX_DELEGATION_ROWS)
			.map((rec) => {
				const pendingMs = Math.max(0, now - rec.updatedAt);
				return {
					correlationId: clean(rec.correlationId),
					laneId: clean(rec.laneId ?? ''),
					batchId: clean(rec.batchId ?? ''),
					workflowLane: clean(rec.workflowLane ?? ''),
					status: clean(rec.status),
					pendingMinutes: Math.round(pendingMs / 60_000),
					staleSuspect: pendingMs > LANE_STALE_HORIZON_MS,
				};
			});
		return {
			available: true,
			lanes,
			staleSuspectCount: lanes.filter((l) => l.staleSuspect).length,
		};
	}, 'lanes');
}

export async function renderTasksView(directory: string): Promise<TasksView> {
	const plan = await loadPlanJsonOnly(directory);
	if (!plan) {
		return {
			available: false,
			unavailableReason: 'no plan on disk',
			title: '',
			currentPhase: null,
			tasks: [],
		};
	}
	const tasks: TaskRow[] = [];
	for (const phase of plan.phases) {
		for (const task of phase.tasks) {
			tasks.push({
				id: clean(task.id),
				phase: phase.id,
				status: clean(task.status),
				description: clean(task.description),
			});
			if (tasks.length >= MAX_TASK_ROWS) break;
		}
		if (tasks.length >= MAX_TASK_ROWS) break;
	}
	return {
		available: true,
		title: clean(plan.title),
		currentPhase: plan.current_phase ?? null,
		tasks,
	};
}

export function renderTimelineView(directory: string): TimelineView {
	return guard((): TimelineView => {
		if (!projectDbExists(directory)) {
			return {
				available: false,
				unavailableReason: 'swarm.db absent',
				totalMatching: 0,
				truncated: false,
				events: [],
			};
		}
		const result = queryObservabilityEvents(directory, {});
		const window = result.rows.slice(-MAX_TIMELINE_ROWS).reverse();
		const events = window.map((row) => ({
			occurredAt: clean(row.occurred_at),
			kind: clean(row.kind),
			severity: clean(row.severity ?? ''),
			taskId: clean(row.task_id ?? ''),
			sessionId: clean(row.host_session_id ?? ''),
			payload: clean(compactPayload(row.payload_json)),
		}));
		return {
			available: true,
			totalMatching: result.totalMatching,
			truncated: result.truncated || result.rows.length > MAX_TIMELINE_ROWS,
			events,
		};
	}, 'timeline');
}

function compactPayload(payloadJson: string | null): string {
	if (!payloadJson) return '';
	try {
		const parsed = JSON.parse(payloadJson) as Record<string, unknown>;
		// Render only scalar fields; nested objects collapse to their keys —
		// bounded by the sanitizer regardless.
		const parts: string[] = [];
		for (const key of Object.keys(parsed).slice(0, 8)) {
			const value = parsed[key];
			if (value === null || value === undefined) continue;
			if (
				typeof value === 'string' ||
				typeof value === 'number' ||
				typeof value === 'boolean'
			) {
				parts.push(`${key}=${String(value)}`);
			} else {
				parts.push(`${key}=…`);
			}
		}
		return parts.join(' ');
	} catch {
		return payloadJson;
	}
}

export interface DashboardStatusView {
	dbHealth: SwarmDbHealthSnapshot;
	observabilityCoverage: {
		available: boolean;
		totalRows?: number;
		earliestOccurredAt?: string | null;
		latestOccurredAt?: string | null;
	};
}

export function renderStatusView(directory: string): DashboardStatusView {
	const coverage = readObservabilityCoverage(directory);
	return {
		dbHealth: getSwarmDbHealthSnapshot(directory),
		observabilityCoverage: coverage
			? {
					available: true,
					totalRows: coverage.totalRows,
					earliestOccurredAt: clean(coverage.earliestOccurredAt ?? ''),
					latestOccurredAt: clean(coverage.latestOccurredAt ?? ''),
				}
			: { available: false },
	};
}

export async function renderOverviewView(
	directory: string,
): Promise<OverviewView> {
	return {
		dbHealth: getSwarmDbHealthSnapshot(directory),
		gates: renderGatesView(directory),
		delegations: renderDelegationsView(directory),
		lanes: renderLanesView(directory),
		tasks: await renderTasksView(directory),
		timeline: renderTimelineView(directory),
	};
}
