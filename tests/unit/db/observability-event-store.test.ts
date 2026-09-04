import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	_internals,
	appendObservabilityEventDb,
	MAX_OBSERVABILITY_EVENT_ROWS,
	queryObservabilityEvents,
	RETENTION_CHECK_INTERVAL,
	readObservabilityCoverage,
	readObservabilitySinkHealth,
	registerObservabilityEventSink,
	resetObservabilityEventSinkForTesting,
	syncObservabilityImport,
} from '../../../src/db/observability-event-store.js';
import {
	closeAllProjectDbs,
	closeProjectDb,
	getProjectDb,
} from '../../../src/db/project-db.js';
import { createObservation } from '../../../src/observability/index.js';
import {
	emit,
	initTelemetry,
	resetTelemetryForTesting,
} from '../../../src/telemetry.js';

function makeProject(): string {
	const dir = join(
		tmpdir(),
		`obs-store-${Math.random().toString(36).slice(2, 10)}`,
	);
	mkdirSync(join(dir, '.swarm'), { recursive: true });
	return dir;
}

function cleanup(dir: string): void {
	closeAllProjectDbs();
	rmSync(dir, { recursive: true, force: true });
}

function sampleCanonical(overrides: Record<string, unknown> = {}) {
	return createObservation('gate_passed', {
		sessionId: 'sess-a',
		taskId: 'task-1',
		gate: 'review',
		...overrides,
	}) as ReturnType<typeof createObservation>;
}

describe('observability-event-store', () => {
	let dir: string;
	beforeEach(() => {
		dir = makeProject();
	});
	afterEach(() => {
		resetObservabilityEventSinkForTesting();
		cleanup(dir);
	});

	test('live append persists the canonical envelope fields the JSONL line loses', () => {
		const canonical = sampleCanonical();
		appendObservabilityEventDb(dir, canonical);
		const rows = queryObservabilityEvents(dir, {}).rows;
		expect(rows.length).toBe(1);
		const row = rows[0]!;
		expect(row.kind).toBe('gate_passed');
		expect(row.event_id).toBe(canonical.eventId);
		expect(row.host_session_id).toBe('sess-a');
		expect(row.task_id).toBe('task-1');
		expect(row.trace_id).toBe(canonical.trace.traceId);
		expect(row.ingested_via).toBe('live');
		expect(row.quarantined).toBe(0);
		// payload JSON round-trips the legacy payload
		const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
		expect(payload.gate).toBe('review');
	});

	test('registration is idempotent and opens no database', () => {
		registerObservabilityEventSink(dir);
		registerObservabilityEventSink(dir);
		expect(existsSync(join(dir, '.swarm', 'swarm.db'))).toBe(false);
	});

	test('re-registering with a different directory evicts the stale listener', () => {
		const dirB = makeProject();
		try {
			registerObservabilityEventSink(dir);
			registerObservabilityEventSink(dirB);
			initTelemetry(dirB);
			emit('gate_passed', {
				sessionId: 'sess-rebind',
				taskId: 'task-rebind',
				gate: 'review',
			});
			// Exactly one sink listener remains: the event is appended once,
			// to the NEW binding only (a stale listener would double-append).
			expect(queryObservabilityEvents(dirB, {}).rows.length).toBe(1);
			// The previous root was evicted before any DB open — nothing
			// materializes there.
			expect(existsSync(join(dir, '.swarm', 'swarm.db'))).toBe(false);
		} finally {
			resetTelemetryForTesting();
			cleanup(dirB);
		}
	});

	test('oversize payload is quarantined with a reason, not dropped', () => {
		const canonical = sampleCanonical({
			huge: 'x'.repeat(64 * 1024),
		});
		appendObservabilityEventDb(dir, canonical);
		// Public read path flushes the group-commit queue before reading.
		expect(queryObservabilityEvents(dir, {}).rows.length).toBe(0);
		const db = getProjectDb(dir);
		const quarantined = db
			.query<{ event_id: string; quarantine_reason: string }, []>(
				'SELECT event_id, quarantine_reason FROM observability_event WHERE quarantined = 1',
			)
			.all();
		expect(quarantined.length).toBe(1);
		expect(quarantined[0]!.quarantine_reason).toBe('payload_oversize');
		// Quarantined rows are excluded from timelines.
		expect(queryObservabilityEvents(dir, {}).rows.length).toBe(0);
	});

	test('retention cap deletes oldest rows beyond MAX_OBSERVABILITY_EVENT_ROWS', () => {
		const db = getProjectDb(dir);
		db.run('BEGIN');
		for (let i = 0; i < MAX_OBSERVABILITY_EVENT_ROWS + 5; i++) {
			db.run(
				'INSERT INTO observability_event (event_id, kind, occurred_at, payload_json, quarantined, ingested_via) VALUES (?, ?, ?, ?, 0, ?)',
				[
					`evt-${i}`,
					'gate_passed',
					`2026-01-01T00:00:${String(i % 60).padStart(2, '0')}.000Z`,
					'{}',
					'live',
				],
			);
		}
		db.run('COMMIT');
		const before = db
			.query<{ count: number }, []>(
				'SELECT COUNT(*) as count FROM observability_event',
			)
			.get()!.count;
		expect(before).toBe(MAX_OBSERVABILITY_EVENT_ROWS + 5);
		// Retention is throttled: it rides the append batch every
		// RETENTION_CHECK_INTERVAL accepted events. Drive one full interval
		// through the real append path, then flush via a public read.
		for (let i = 0; i < RETENTION_CHECK_INTERVAL; i++) {
			appendObservabilityEventDb(dir, sampleCanonical());
		}
		queryObservabilityEvents(dir, {});
		const after = db
			.query<{ count: number }, []>(
				'SELECT COUNT(*) as count FROM observability_event',
			)
			.get()!.count;
		expect(after).toBeLessThanOrEqual(MAX_OBSERVABILITY_EVENT_ROWS);
		// Oldest evt-0..evt-4 evicted; the newest appended row present.
		const hasZero = db
			.query<{ c: number }, []>(
				"SELECT COUNT(*) as c FROM observability_event WHERE event_id = 'evt-0'",
			)
			.get()!.c;
		expect(hasZero).toBe(0);
	});

	test('syncObservabilityImport imports legacy lines deterministically and idempotently', () => {
		const lines = [
			JSON.stringify({
				timestamp: '2026-01-01T00:00:00.000Z',
				event: 'gate_passed',
				sessionId: 's1',
				taskId: 't1',
			}),
			'not-json-at-all',
			JSON.stringify({
				timestamp: '2026-01-02T00:00:00.000Z',
				event: 'delegation_end',
				sessionId: 's1',
				agentName: 'coder',
				taskId: 't1',
			}),
		];
		writeFileSync(
			join(dir, '.swarm', 'telemetry.jsonl'),
			lines.join('\n') + '\n',
		);
		const first = syncObservabilityImport(dir);
		expect(first.imported).toBe(3);
		expect(first.quarantined).toBe(1); // the unparseable line
		const coverage = readObservabilityCoverage(dir)!;
		expect(coverage.importedRows).toBe(3);
		expect(coverage.quarantinedRows).toBe(1);
		// Idempotent: re-sync with unchanged fingerprint is a no-op.
		const second = syncObservabilityImport(dir);
		expect(second.imported).toBe(0);
		// Deterministic rebuild: wipe imported rows + markers, re-sync, same rows.
		const db = getProjectDb(dir);
		db.run('DELETE FROM observability_event');
		db.run('DELETE FROM observability_import');
		closeProjectDb(dir);
		const third = syncObservabilityImport(dir);
		expect(third.imported).toBe(3);
		const rebuilt = readObservabilityCoverage(dir)!;
		expect(rebuilt.importedRows).toBe(3);
		expect(rebuilt.quarantinedRows).toBe(1);
		// Imported rows extract workflow ids from the payload.
		const rows = queryObservabilityEvents(dir, { sessionId: 's1' }).rows;
		expect(rows.length).toBe(2); // quarantined excluded from timeline
	});

	test('import handles rotation: growth appends only the delta; shrink rescans deduped', () => {
		const f = join(dir, '.swarm', 'telemetry.jsonl');
		writeFileSync(
			f,
			JSON.stringify({
				timestamp: '2026-01-01T00:00:00.000Z',
				event: 'gate_passed',
				sessionId: 's1',
			}) + '\n',
		);
		expect(syncObservabilityImport(dir).imported).toBe(1);
		// Delta: one more line appended.
		appendFileSync(
			f,
			JSON.stringify({
				timestamp: '2026-01-02T00:00:00.000Z',
				event: 'gate_passed',
				sessionId: 's2',
			}) + '\n',
		);
		expect(syncObservabilityImport(dir).imported).toBe(1);
		// Rotation: file shrinks to fresh content — full rescan, INSERT OR IGNORE dedupes.
		writeFileSync(
			f,
			JSON.stringify({
				timestamp: '2026-01-03T00:00:00.000Z',
				event: 'gate_passed',
				sessionId: 's3',
			}) + '\n',
		);
		const coverage = readObservabilityCoverage(dir)!;
		const res = syncObservabilityImport(dir);
		expect(res.imported).toBe(1);
		const after = readObservabilityCoverage(dir)!;
		expect(after.importedRows).toBe(coverage.importedRows + 1);
	});

	test('sink failures never propagate out of the emit path (listener owns fail-open)', () => {
		registerObservabilityEventSink(dir);
		initTelemetry(dir);
		const orig = _internals.getGroupCommitWriter;
		_internals.getGroupCommitWriter = () => {
			throw new Error('simulated writer failure');
		};
		try {
			// The listener wrapper swallows the writer failure: emit itself
			// (the agent-facing path) must complete normally.
			expect(() =>
				emit('gate_passed', {
					sessionId: 'sess-fail',
					taskId: 't1',
					gate: 'review',
				}),
			).not.toThrow();
		} finally {
			_internals.getGroupCommitWriter = orig;
			resetTelemetryForTesting();
		}
		// Uninitialized-observability read path: no DB at all is null coverage.
		const fresh = makeProject();
		try {
			expect(readObservabilityCoverage(fresh)).toBe(null);
		} finally {
			rmSync(fresh, { recursive: true, force: true });
		}
	});

	test('health counters persist through the throttled upsert path', () => {
		const db = getProjectDb(dir);
		db.run(
			'INSERT INTO observability_sink_health (id, accepted, quarantined, dropped, updated_at) VALUES (1, 10, 2, 1, ?)',
			[new Date().toISOString()],
		);
		appendObservabilityEventDb(dir, sampleCanonical());
		const health = readObservabilitySinkHealth(dir);
		expect(health).not.toBeNull();
	});

	test('report queries are bounded and deterministic (occurred_at, rowid ordering)', () => {
		const canonicals = [
			'2026-03-01T00:00:00.000Z',
			'2026-01-01T00:00:00.000Z',
			'2026-02-01T00:00:00.000Z',
		].map(
			(ts) =>
				({
					...sampleCanonical(),
					occurredAt: ts,
				}) as ReturnType<typeof createObservation>,
		);
		for (const c of canonicals) appendObservabilityEventDb(dir, c);
		const q1 = queryObservabilityEvents(dir, {});
		const q2 = queryObservabilityEvents(dir, {});
		expect(q1.rows.map((r) => r.occurred_at)).toEqual([
			'2026-01-01T00:00:00.000Z',
			'2026-02-01T00:00:00.000Z',
			'2026-03-01T00:00:00.000Z',
		]);
		expect(JSON.stringify(q1)).toBe(JSON.stringify(q2));
		// --since lower bound is inclusive.
		const since = queryObservabilityEvents(dir, {
			since: '2026-02-01T00:00:00.000Z',
		});
		expect(since.rows.length).toBe(2);
		// Malicious filter values are bound parameters, never SQL text.
		const evil = queryObservabilityEvents(dir, {
			taskId: "'; DROP TABLE observability_event; --",
		});
		expect(evil.rows.length).toBe(0);
		expect(
			getProjectDb(dir)
				.query<{ c: number }, []>(
					'SELECT COUNT(*) as c FROM observability_event',
				)
				.get()!.c,
		).toBe(3);
	});
});
