/**
 * `/swarm report` — bounded, deterministic observability report over the
 * SQLite-native query authority (issue #2482 / D3, absorbing #2048).
 *
 * - Read-only. Queries `.swarm/swarm.db` `observability_event` via the
 *   bounded store queries (`src/db/observability-event-store.ts`); lazily
 *   syncs the rebuildable legacy import (`syncObservabilityImport`) FIRST so
 *   the report covers the bounded `telemetry.jsonl(.1)` window too.
 * - Filters: `--task <id>` (workflow.taskId), `--session <id>`
 *   (hostSessionId), `--trace <id>` (traceId), `--run <id>` (workflow.batchId
 *   — the lane/dispatch batch axis; `prRunId`/`backgroundInvocationId` have
 *   no producers today), `--since <ISO-8601>` (inclusive lower bound).
 *   `--json` emits a versioned JSON block. Each value flag may appear at
 *   most once with a non-empty value; any subset is valid.
 * - Bounded: row cap + truncated flag (`MAX_REPORT_ROWS`), ordering is
 *   `occurred_at, rowid` (code-unit string compare — no locale collation),
 *   so the same query window yields byte-identical output (proven by test).
 * - Honest coverage: live vs imported row counts, quarantined rows (excluded
 *   from the timeline), the sink's own health counters, and the delegation
 *   begin/end pairing delta — unmatched begins are DISCLOSED, never
 *   fabricated into ends.
 * - Fail-open: a missing/unopenable store yields an explicit empty report
 *   with `coverage.unavailable`, never an error.
 */

import {
	MAX_REPORT_ROWS,
	type ObservabilityEventFilter,
	type ObservabilityEventRow,
	queryObservabilityEvents,
	readObservabilityCoverage,
	readObservabilitySinkHealth,
	syncObservabilityImport,
} from '../db/observability-event-store.js';

export const REPORT_JSON_SCHEMA_VERSION = 1;

interface ParsedReportArgs {
	filter: ObservabilityEventFilter;
	json: boolean;
}

const USAGE = [
	'Usage: /swarm report [--task <id>] [--session <id>] [--trace <id>]',
	'                    [--run <batchId>] [--since <ISO-8601>] [--json]',
	'  --run filters the lane/dispatch batch axis (workflow.batchId).',
].join('\n');

function parseValueFlag(
	args: string[],
	flag: string,
): { value?: string; error?: string } {
	let found: string | undefined;
	for (let i = 0; i < args.length; i++) {
		if (args[i] !== flag) continue;
		if (found !== undefined) {
			return { error: `${flag} may be passed at most once` };
		}
		const value = args[i + 1];
		if (value === undefined || value.startsWith('--')) {
			return { error: `${flag} requires a non-empty value` };
		}
		found = value;
		i++;
	}
	if (found !== undefined && found.length === 0) {
		return { error: `${flag} requires a non-empty value` };
	}
	return { value: found };
}

export function parseReportArgs(args: string[]): {
	parsed?: ParsedReportArgs;
	error?: string;
} {
	const known = new Set([
		'--task',
		'--session',
		'--trace',
		'--run',
		'--since',
		'--json',
	]);
	for (const arg of args) {
		if (arg.startsWith('--') && !known.has(arg)) {
			return { error: `Unrecognized argument: ${arg}\n${USAGE}` };
		}
	}
	const task = parseValueFlag(args, '--task');
	if (task.error) return { error: task.error };
	const session = parseValueFlag(args, '--session');
	if (session.error) return { error: session.error };
	const trace = parseValueFlag(args, '--trace');
	if (trace.error) return { error: trace.error };
	const run = parseValueFlag(args, '--run');
	if (run.error) return { error: run.error };
	const since = parseValueFlag(args, '--since');
	if (since.error) return { error: since.error };
	if (since.value !== undefined && Number.isNaN(Date.parse(since.value))) {
		return { error: `--since must be an ISO-8601 timestamp\n${USAGE}` };
	}
	return {
		parsed: {
			filter: {
				...(task.value !== undefined ? { taskId: task.value } : {}),
				...(session.value !== undefined ? { sessionId: session.value } : {}),
				...(trace.value !== undefined ? { traceId: trace.value } : {}),
				...(run.value !== undefined ? { batchId: run.value } : {}),
				...(since.value !== undefined ? { since: since.value } : {}),
			},
			json: args.includes('--json'),
		},
	};
}

interface PairingStats {
	begins: number;
	ends: number;
	recoveredEnds: number;
	unmatchedBegins: number;
}

function computePairing(rows: ObservabilityEventRow[]): PairingStats {
	let begins = 0;
	let ends = 0;
	let recoveredEnds = 0;
	// Pair by (sessionId, agentName, taskId) triple in the filtered window —
	// honest COUNTS with a disclosed delta; per-call joins are not fabricated
	// (the Task transport emits no shared callID on both halves).
	const openBegins = new Map<string, number>();
	for (const row of rows) {
		if (row.kind === 'delegation_begin') {
			begins += 1;
			const key = `${row.host_session_id ?? ''}\0${
				JSON.parse(row.payload_json).agentName ?? ''
			}\0${row.task_id ?? ''}`;
			openBegins.set(key, (openBegins.get(key) ?? 0) + 1);
		} else if (row.kind === 'delegation_end') {
			ends += 1;
			const payload = JSON.parse(row.payload_json) as {
				sessionId?: string;
				agentName?: string;
				taskId?: string;
				recovered?: boolean;
			};
			// PRR-009: surface recovered ends instead of silently folding
			// them into the raw end count.
			if (payload.recovered === true) recoveredEnds += 1;
			const key = `${payload.sessionId ?? ''}\0${payload.agentName ?? ''}\0${
				payload.taskId ?? ''
			}`;
			const open = openBegins.get(key);
			if (open !== undefined && open > 0) {
				openBegins.set(key, open - 1);
			}
		}
	}
	let unmatched = 0;
	for (const count of openBegins.values()) unmatched += count;
	return { begins, ends, recoveredEnds, unmatchedBegins: unmatched };
}

interface SavingsRow {
	source: string;
	calls: number;
	tokensReturned: number;
	tokensSavedEstimate: number;
}

function computeSavings(rows: ObservabilityEventRow[]): SavingsRow[] {
	const bySource = new Map<string, SavingsRow>();
	for (const row of rows) {
		if (row.kind !== 'context_source_attribution') continue;
		const payload = JSON.parse(row.payload_json) as {
			source?: string;
			tokensReturned?: number;
			tokensSavedEstimate?: number;
		};
		const source =
			typeof payload.source === 'string' ? payload.source : 'unknown';
		const entry =
			bySource.get(source) ??
			({
				source,
				calls: 0,
				tokensReturned: 0,
				tokensSavedEstimate: 0,
			} as SavingsRow);
		entry.calls += 1;
		entry.tokensReturned += payload.tokensReturned ?? 0;
		entry.tokensSavedEstimate += payload.tokensSavedEstimate ?? 0;
		bySource.set(source, entry);
	}
	// Deterministic: code-unit sort by source name.
	return [...bySource.values()].sort((a, b) =>
		a.source < b.source ? -1 : a.source > b.source ? 1 : 0,
	);
}

interface TimelineEntry {
	occurredAt: string;
	kind: string;
	sessionId: string | null;
	taskId: string | null;
	traceId: string | null;
	outcome: string | null;
}

export async function handleReportCommand(
	directory: string,
	args: string[],
): Promise<string> {
	const { parsed, error } = parseReportArgs(args);
	if (parsed === undefined || error !== undefined) {
		return error ?? USAGE;
	}
	// Fail-open first: a project with neither swarm.db nor a legacy stream
	// gets an explicit empty report — and must not materialize a DB here.
	const coverage = readObservabilityCoverage(directory);
	if (coverage === null) {
		// Fail-open: no store at all — an honest empty report, not an error.
		return parsed.json
			? `[REPORT_JSON]${JSON.stringify({
					schemaVersion: REPORT_JSON_SCHEMA_VERSION,
					filters: parsed.filter,
					coverage: { unavailable: true },
					timeline: [],
				})}[/REPORT_JSON]`
			: 'No observability store found for this project yet — events land here once the swarm runs.';
	}
	// Rebuildable legacy import (report path only — never per emit, never at
	// plugin init) runs BEFORE the queries so the timeline and its coverage
	// reflect the post-import state.
	const importResult = syncObservabilityImport(directory);
	const query = queryObservabilityEvents(directory, parsed.filter);
	const pairing = computePairing(query.rows);
	const savings = computeSavings(query.rows);
	const timeline: TimelineEntry[] = query.rows.map((row) => ({
		occurredAt: row.occurred_at,
		kind: row.kind,
		sessionId: row.host_session_id,
		taskId: row.task_id,
		traceId: row.trace_id,
		outcome: row.outcome_status,
	}));
	const health = readObservabilitySinkHealth(directory);
	const postImportCoverage: typeof coverage =
		readObservabilityCoverage(directory) ?? coverage;
	const report = {
		schemaVersion: REPORT_JSON_SCHEMA_VERSION,
		filters: parsed.filter,
		coverage: {
			...postImportCoverage,
			importedThisSync: importResult.imported,
			quarantinedThisSync: importResult.quarantined,
			rowCap: MAX_REPORT_ROWS,
			truncated: query.truncated,
			totalMatching: query.totalMatching,
			// Honest window statement: the import covers only the CURRENT
			// bounded legacy generations; older rotated-away events are gone.
			legacyWindow: 'current telemetry.jsonl generations only',
		},
		pairing: {
			...pairing,
			note: 'unmatched begins are disclosed, never fabricated into ends',
		},
		savings: savings.map((s) => ({ ...s, estimate: true })),
		health,
		timeline,
	};
	if (parsed.json) {
		return `[REPORT_JSON]${JSON.stringify(report)}[/REPORT_JSON]`;
	}
	const lines: string[] = [];
	lines.push('## Swarm Observability Report');
	lines.push('');
	lines.push(
		`**Coverage** — ${postImportCoverage.totalRows} events (live ${postImportCoverage.liveRows}, imported ${postImportCoverage.importedRows}; quarantined ${postImportCoverage.quarantinedRows})`,
	);
	if (postImportCoverage.earliestOccurredAt !== null) {
		lines.push(
			`Window: ${postImportCoverage.earliestOccurredAt} → ${postImportCoverage.latestOccurredAt} (import covers current telemetry.jsonl generations only)`,
		);
	}
	if (query.truncated) {
		lines.push(
			`⚠ Timeline truncated to ${MAX_REPORT_ROWS} rows (${query.totalMatching} matched the filters).`,
		);
	}
	lines.push('');
	lines.push(
		`**Delegation pairing** — ${pairing.begins} begins / ${pairing.ends} ends${
			pairing.recoveredEnds > 0 ? ` (${pairing.recoveredEnds} recovered)` : ''
		}; ${pairing.unmatchedBegins} unmatched begin(s) disclosed`,
	);
	lines.push('');
	if (savings.length > 0) {
		lines.push('**Context-source savings (estimates)**');
		lines.push('');
		lines.push('| Source | Calls | Tokens returned | Est. saved |');
		lines.push('| --- | --- | --- | --- |');
		for (const s of savings) {
			// PRR-011: source arrives from event payloads — escape markdown
			// structure characters so a crafted value cannot break the table.
			const safeSource = s.source.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
			lines.push(
				`| ${safeSource} | ${s.calls} | ${s.tokensReturned} | ${s.tokensSavedEstimate} |`,
			);
		}
		lines.push('');
	}
	lines.push(
		`**Sink health** — accepted ${health?.accepted ?? 0}, quarantined ${health?.quarantined ?? 0}, dropped ${health?.dropped ?? 0}`,
	);
	lines.push('');
	lines.push(`**Timeline** — ${timeline.length} event(s)`);
	for (const entry of timeline.slice(0, 50)) {
		lines.push(
			`- ${entry.occurredAt} ${entry.kind}${
				entry.taskId !== null ? ` task=${entry.taskId}` : ''
			}${entry.sessionId !== null ? ` session=${entry.sessionId}` : ''}${
				entry.outcome !== null ? ` outcome=${entry.outcome}` : ''
			}`,
		);
	}
	if (timeline.length > 50) {
		lines.push(
			`- … ${timeline.length - 50} more (use --json or narrower filters)`,
		);
	}
	return lines.join('\n');
}
