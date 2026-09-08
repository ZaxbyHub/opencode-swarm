/**
 * Issue #2487 parity-harness entry — close/reopen + restart parity for the
 * three SQLite stores that had no Node-side proof, run under REAL Node via
 * `bun run repro:2487` (bun builds this file to `--target node --format esm`;
 * scripts/repro-2487-parity.mjs drives it). No `bun:` imports, no `Bun.*`.
 *
 * (a) Observability event sink: emit -> flush -> close writers + DBs ->
 *     reopen -> query. CANONICAL-CONTENT comparison per event (kind, session,
 *     task, payload round-trip, ingested_via), then the report-path import
 *     must add ZERO rows (issue #2487 live/import overlap suppression).
 * (b) Plan ledger SQLite backend (the exact backend `appendLedgerEvent`
 *     delegates to; the high-level API additionally requires a full Plan
 *     fixture and project-root assertion that add no backend-parity signal):
 *     import -> append -> close -> reopen -> byte-identical canonical events,
 *     equal event hash chain, equal state (lastSeq, authority mode, terminal
 *     projection).
 * (c) Coordination store: one transactional state write -> close -> reopen ->
 *     read returns the written value.
 *
 * Every phase uses the uniform teardown `closeAllGroupCommitWriters()` THEN
 * `closeAllProjectDbs()` before each reopen (the writer owns its own cached
 * DB reference; project-db close does not close writers).
 */

import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeAllGroupCommitWriters } from '../src/db/group-commit-writer.js';
import {
	queryObservabilityEvents,
	readObservabilityCoverage,
	registerObservabilityEventSink,
	resetObservabilityEventSinkForTesting,
	syncObservabilityImport,
} from '../src/db/observability-event-store.js';
import { closeAllProjectDbs } from '../src/db/project-db.js';
import {
	getCoordinationState,
	transitionCoordinationState,
} from '../src/db/coordination-store.js';
import {
	appendSqliteLedger,
	getPlanLedgerStateReadOnly,
	importSqliteLedger,
	readSqliteLedgerEventsReadOnly,
} from '../src/plan/ledger-sqlite.js';
import { emit, initTelemetry, resetTelemetryForTesting } from '../src/telemetry.js';

function makeProject(prefix: string): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), `${prefix}-`)));
	return dir;
}

function settle(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

const failures: string[] = [];

function check(label: string, cond: boolean, detail = ''): void {
	if (cond) {
		console.log(`[repro-2487] OK ${label}`);
	} else {
		failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
		console.error(`[repro-2487] FAIL ${label}${detail ? ` — ${detail}` : ''}`);
	}
}

/**
 * Scratch cleanup must never mask the phase result (issue #2487 review
 * PRR-004): on Windows a lingering handle (AV scan, deferred WAL reclaim) can
 * make rmSync throw EPERM/EBUSY even after close, and an unguarded finally
 * would replace the intended exit code. The dir is git-ignored scratch, so a
 * failed cleanup is harmless.
 */
function removeScratchDir(dir: string): void {
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {
		/* best-effort */
	}
}

function canonicalEventJson(seq: number, title: string): string {
	return JSON.stringify({
		seq,
		timestamp: `2026-01-01T00:00:0${seq}.000Z`,
		plan_id: 'plan-2487-parity',
		event_type: seq === 1 ? 'plan_created' : 'task_updated',
		source: 'parity-harness',
		plan_hash_before: seq === 1 ? '' : `before-${seq}`,
		plan_hash_after: `after-${seq}`,
		schema_version: '1.1.0',
		payload: { title },
	});
}

async function phaseObservabilitySink(): Promise<void> {
	const dir = makeProject('obs-parity-node');
	try {
		registerObservabilityEventSink(dir);
		initTelemetry(dir);
		const emitted: Array<{ kind: string; session: string; task: string }> = [];
		for (let i = 0; i < 6; i++) {
			const kind = i % 2 === 0 ? 'delegation_begin' : 'delegation_end';
			const payload = {
				sessionId: 'sess-node-parity',
				taskId: `task-${i}`,
				agentName: 'coder',
				result: 'success',
			};
			emit(kind as Parameters<typeof emit>[0], payload);
			emitted.push({
				kind,
				session: payload.sessionId,
				task: payload.taskId,
			});
		}
		await settle(400);

		closeAllGroupCommitWriters();
		closeAllProjectDbs();
		const query = queryObservabilityEvents(dir, {});
		check('sink: 6 emitted -> 6 rows after close/reopen', query.rows.length === 6, `rows=${query.rows.length}`);
		check('sink: totalMatching equals row count', query.totalMatching === 6, `totalMatching=${query.totalMatching}`);
		for (let i = 0; i < emitted.length; i++) {
			const row = query.rows[i];
			const want = emitted[i];
			const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
			check(
				`sink: event ${i} canonical content (kind/session/task/payload/ingested_via)`,
				row.kind === want.kind &&
					row.host_session_id === want.session &&
					row.task_id === want.task &&
					payload.taskId === want.task &&
					row.ingested_via === 'live' &&
					row.quarantined === 0,
				`kind=${row.kind} session=${row.host_session_id} task=${row.task_id} via=${row.ingested_via}`,
			);
		}
		const beforeJson = JSON.stringify(query.rows);

		const importResult = syncObservabilityImport(dir);
		check(
			'sink: report-path import after live capture adds zero rows',
			importResult.imported === 0 && importResult.skippedLive === 6,
			`imported=${importResult.imported} skippedLive=${importResult.skippedLive}`,
		);
		const after = queryObservabilityEvents(dir, {});
		check('sink: query byte-identical across import', JSON.stringify(after.rows) === beforeJson);
		const coverage = readObservabilityCoverage(dir);
		check(
			'sink: coverage honest (live=6, imported=0)',
			coverage !== null && coverage.liveRows === 6 && coverage.importedRows === 0,
			`live=${coverage?.liveRows} imported=${coverage?.importedRows}`,
		);
	} finally {
		resetObservabilityEventSinkForTesting();
		resetTelemetryForTesting();
		closeAllGroupCommitWriters();
		closeAllProjectDbs();
		removeScratchDir(dir);
	}
}

function phasePlanLedger(): void {
	const dir = makeProject('ledger-parity-node');
	try {
		const canonicals = [canonicalEventJson(1, 'created'), canonicalEventJson(2, 'updated')];
		importSqliteLedger(dir, {
			canonicalEvents: canonicals,
			source: 'plan-ledger.jsonl',
			sourceHash: 'parity-source-hash',
			mode: 'file_shadow',
			state: { authorityMode: 'file_shadow', parityStatus: 'pending' },
		});
		const appended = appendSqliteLedger(dir, {
			canonicalEvent: canonicalEventJson(3, 'terminal'),
			state: {
				lastSeq: 3,
				terminalProjection: new TextEncoder().encode('{"title":"terminal"}'),
				terminalPlanHash: 'after-3',
			},
			expectedSeq: 2,
		});
		check('ledger: append seq 3', appended.seq === 3, `seq=${appended.seq}`);

		closeAllGroupCommitWriters();
		closeAllProjectDbs();
		const afterReopen = readSqliteLedgerEventsReadOnly(dir);
		check('ledger: 3 events after close/reopen', afterReopen.events.length === 3, `events=${afterReopen.events.length}`);
		const decoder = new TextDecoder();
		for (let i = 0; i < 3; i++) {
			check(
				`ledger: event ${i + 1} canonical bytes identical across close/reopen`,
				decoder.decode(afterReopen.events[i].canonicalEvent) === canonicalEventJson(i + 1, i === 0 ? 'created' : i === 1 ? 'updated' : 'terminal'),
			);
		}
		const hashes = afterReopen.events.map((e) => e.eventHash).join(',');
		check('ledger: hash chain all 64-hex', afterReopen.events.every((e) => /^[a-f0-9]{64}$/.test(e.eventHash)), hashes.slice(0, 40));
		const state = getPlanLedgerStateReadOnly(dir);
		check(
			'ledger: state survives close/reopen (lastSeq/authority/terminal hash)',
			state !== null &&
				state.lastSeq === 3 &&
				state.authorityMode === 'file_shadow' &&
				state.terminalPlanHash === 'after-3',
			`lastSeq=${state?.lastSeq} mode=${state?.authorityMode} terminal=${state?.terminalPlanHash}`,
		);
	} finally {
		closeAllGroupCommitWriters();
		closeAllProjectDbs();
		removeScratchDir(dir);
	}
}

function phaseCoordinationStore(): void {
	const dir = makeProject('coord-parity-node');
	try {
		// transitionCoordinationState opens its own withImmediateTransaction
		// (single transactional state write, the documented production path).
		const result = transitionCoordinationState(dir, {
			namespace: 'parity',
			entityKey: 'entity-1',
			expectedRevision: null,
			generation: 1,
			status: 'active',
			payload: '{"probe":"node-parity"}',
		});

		closeAllGroupCommitWriters();
		closeAllProjectDbs();
		const state = getCoordinationState(dir, 'parity', 'entity-1');
		check(
			'coordination: state readable after close/reopen',
			state !== null &&
				state.status === 'active' &&
				state.payload === '{"probe":"node-parity"}' &&
				typeof result === 'object',
			`state=${state === null ? 'null' : `${state.status}/${state.payload}/${state.revision}`}`,
		);
	} finally {
		closeAllGroupCommitWriters();
		closeAllProjectDbs();
		removeScratchDir(dir);
	}
}

async function main(): Promise<void> {
	await phaseObservabilitySink();
	phasePlanLedger();
	phaseCoordinationStore();
	if (failures.length > 0) {
		console.error(`[repro-2487] ${failures.length} failure(s)`);
		process.exitCode = 1;
		return;
	}
	console.log('[repro-2487] all parity checks passed under Node');
}

await main();
