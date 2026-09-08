import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	queryObservabilityEvents,
	registerObservabilityEventSink,
	resetObservabilityEventSinkForTesting,
	syncObservabilityImport,
} from '../../../src/db/observability-event-store.js';
import {
	closeAllProjectDbs,
	getProjectDb,
} from '../../../src/db/project-db.js';
import {
	emit,
	initTelemetry,
	resetTelemetryForTesting,
} from '../../../src/telemetry.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

/**
 * Issue #2487 schema rollout: migration v38 adds observability_event.line_hash
 * and v39 its index; the lazy backfill runs once, inside the import
 * transaction, for live rows only.
 */

function makeProject(): string {
	const dir = canonicalMkdtemp('obs-migration-2487-');
	mkdirSync(join(dir, '.swarm'), { recursive: true });
	return dir;
}

function cleanup(dir: string): void {
	closeAllProjectDbs();
	rmSync(dir, { recursive: true, force: true });
}

function tableColumns(db: ReturnType<typeof getProjectDb>): string[] {
	return db
		.query<{ name: string }, []>('PRAGMA table_info(observability_event)')
		.all()
		.map((c) => c.name);
}

function indexNames(db: ReturnType<typeof getProjectDb>): string[] {
	return db
		.query<{ name: string }, []>(
			"SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'observability_event'",
		)
		.all()
		.map((r) => r.name);
}

function maxSchemaVersion(db: ReturnType<typeof getProjectDb>): number {
	return (
		db
			.query<{ version: number }, []>(
				'SELECT MAX(version) as version FROM schema_migrations',
			)
			.get()?.version ?? 0
	);
}

describe('observability line-hash migration + backfill (issue #2487)', () => {
	let dir: string;
	beforeEach(() => {
		dir = makeProject();
	});
	afterEach(() => {
		resetObservabilityEventSinkForTesting();
		resetTelemetryForTesting();
		cleanup(dir);
	});

	test('a fresh DB carries the v38 column, the v39 index, and schema version 39', () => {
		registerObservabilityEventSink(dir);
		initTelemetry(dir);
		emit('gate_passed', {
			sessionId: 's-mig',
			taskId: 't-mig',
			gate: 'review',
		});
		const db = getProjectDb(dir);
		expect(maxSchemaVersion(db)).toBeGreaterThanOrEqual(39);
		expect(tableColumns(db)).toContain('line_hash');
		expect(indexNames(db)).toContain('idx_obs_event_line_hash');
	});

	test('live row appended at the new schema stores a 64-hex line hash', () => {
		registerObservabilityEventSink(dir);
		initTelemetry(dir);
		emit('gate_passed', {
			sessionId: 's-new',
			taskId: 't-new',
			gate: 'review',
		});
		queryObservabilityEvents(dir, {});
		const db = getProjectDb(dir);
		const row = db
			.query<{ line_hash: string | null }, []>(
				'SELECT line_hash FROM observability_event',
			)
			.get();
		expect(row?.line_hash).toMatch(/^[a-f0-9]{64}$/);
	});

	test('pre-v38-shaped live row is backfilled on the next sync, atomically with the marker', async () => {
		registerObservabilityEventSink(dir);
		initTelemetry(dir);
		emit('gate_passed', {
			sessionId: 's-pre',
			taskId: 't-pre',
			gate: 'review',
		});
		await new Promise((resolve) => setTimeout(resolve, 250));
		// Flush the writer so the UPDATE below hits the persisted row.
		queryObservabilityEvents(dir, {});
		// Simulate the v37-era row shape.
		const db = getProjectDb(dir);
		db.run('UPDATE observability_event SET line_hash = NULL');
		const before = db
			.query<{ found: number }, []>(
				"SELECT 1 as found FROM observability_import WHERE source = '__live_line_hash_backfill__'",
			)
			.get();
		// bun's node:sqlite-shaped .get() returns null (not undefined) for
		// no rows on this driver surface.
		expect(before ?? null).toBeNull();
		closeAllProjectDbs();

		syncObservabilityImport(dir);
		const db2 = getProjectDb(dir);
		const row = db2
			.query<{ line_hash: string | null }, []>(
				"SELECT line_hash FROM observability_event WHERE ingested_via = 'live'",
			)
			.get();
		expect(row?.line_hash).toMatch(/^[a-f0-9]{64}$/);
		const marker = db2
			.query<{ found: number }, []>(
				"SELECT 1 as found FROM observability_import WHERE source = '__live_line_hash_backfill__'",
			)
			.get();
		expect(marker).toBeDefined();
	});

	test('backfill is one-shot: the marker suppresses a second backfill pass', () => {
		const line1 = JSON.stringify({
			timestamp: '2026-01-01T00:00:00.000Z',
			event: 'gate_passed',
			sessionId: 's-2nd',
			taskId: 't-a',
			gate: 'review',
		});
		const line2 = JSON.stringify({
			timestamp: '2026-01-01T00:00:01.000Z',
			event: 'gate_passed',
			sessionId: 's-2nd',
			taskId: 't-b',
			gate: 'review',
		});
		writeFileSync(
			join(dir, '.swarm', 'telemetry.jsonl'),
			`${line1}
${line2}
`,
		);
		const first = syncObservabilityImport(dir);
		expect(first.imported).toBe(2);
		// Insert a pre-v38-shaped live row AFTER the first sync already wrote
		// the completion marker.
		getProjectDb(dir).run(
			`INSERT INTO observability_event (event_id, kind, occurred_at, payload_json, quarantined, ingested_via, line_hash) VALUES ('late-live', 'gate_passed', '2026-01-01T00:00:05.000Z', ?, 0, 'live', NULL)`,
			[
				JSON.stringify({
					sessionId: 's-2nd',
					taskId: 't-late',
					gate: 'review',
				}),
			],
		);
		closeAllProjectDbs();
		// Append a third line: it must import normally...
		appendFileSync(
			join(dir, '.swarm', 'telemetry.jsonl'),
			`${JSON.stringify({ timestamp: '2026-01-01T00:00:09.000Z', event: 'gate_passed', sessionId: 's-2nd', taskId: 't-c', gate: 'review' })}
`,
		);
		const second = syncObservabilityImport(dir);
		expect(second.imported).toBe(1);
		expect(second.skippedLive).toBe(0);
		// ...while the late NULL-hash live row is NOT backfilled (marker wins).
		const db = getProjectDb(dir);
		const late = db
			.query<{ line_hash: string | null }, []>(
				"SELECT line_hash FROM observability_event WHERE event_id = 'late-live'",
			)
			.get();
		expect(late?.line_hash ?? null).toBeNull();
	});

	test('quarantined and imported rows are never backfilled', () => {
		writeFileSync(
			join(dir, '.swarm', 'telemetry.jsonl'),
			`${JSON.stringify({ timestamp: '2026-01-01T00:00:00.000Z', event: 'gate_passed', sessionId: 's-i', taskId: 't-i', gate: 'review' })}\n`,
		);
		syncObservabilityImport(dir);
		const db = getProjectDb(dir);
		db.run(
			`INSERT INTO observability_event (event_id, kind, occurred_at, payload_json, quarantined, quarantine_reason, ingested_via, line_hash) VALUES ('q-1', 'gate_passed', '2026-01-01T00:00:00.000Z', '{}', 1, 'payload_oversize', 'live', NULL)`,
		);
		closeAllProjectDbs();
		// A changed file triggers another import transaction (and thus the
		// backfill pass); both guard-failing rows must stay NULL.
		writeFileSync(
			join(dir, '.swarm', 'telemetry.jsonl'),
			`${JSON.stringify({ timestamp: '2026-01-01T00:00:01.000Z', event: 'gate_passed', sessionId: 's-i', taskId: 't-i2', gate: 'review' })}\n`,
		);
		syncObservabilityImport(dir);
		const rows = getProjectDb(dir)
			.query<{ event_id: string; line_hash: string | null }, []>(
				'SELECT event_id, line_hash FROM observability_event WHERE line_hash IS NULL',
			)
			.all();
		const ids = rows.map((r) => r.event_id).sort();
		expect(ids).toContain('q-1');
		expect(
			rows.some((r) => r.event_id !== 'q-1' && r.ingested_via === undefined),
		).toBe(true);
		// The imported rows (synthetic ids) also remain NULL.
		for (const row of rows) {
			if (row.event_id !== 'q-1') {
				expect(row.line_hash).toBeNull();
			}
		}
	});
});
