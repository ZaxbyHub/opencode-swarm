import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { closeAllGroupCommitWriters } from '../../../src/db/group-commit-writer.js';
import {
	_internals,
	appendObservabilityEventDb,
	queryObservabilityEvents,
	readObservabilityCoverage,
	registerObservabilityEventSink,
	resetObservabilityEventSinkForTesting,
	syncObservabilityImport,
} from '../../../src/db/observability-event-store.js';
import {
	closeAllProjectDbs,
	getProjectDb,
} from '../../../src/db/project-db.js';
import { createObservation } from '../../../src/observability/index.js';
import {
	emit,
	initTelemetry,
	resetTelemetryForTesting,
} from '../../../src/telemetry.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

/**
 * Issue #2487: the live sink and the report-path legacy import must store
 * every emitted event EXACTLY ONCE. Regression class: dual-ingestion surfaces
 * where two writers allocate disjoint identities for the same logical record.
 */

function makeProject(): string {
	const dir = canonicalMkdtemp('obs-dedupe-2487-');
	mkdirSync(join(dir, '.swarm'), { recursive: true });
	return dir;
}

function cleanup(dir: string): void {
	closeAllProjectDbs();
	rmSync(dir, { recursive: true, force: true });
}

function sampleCanonical(overrides: Record<string, unknown> = {}) {
	return createObservation('gate_passed', {
		sessionId: 'sess-2487',
		taskId: 'task-1',
		gate: 'review',
		...overrides,
	}) as ReturnType<typeof createObservation>;
}

async function settleStream(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 300));
}

function telemetryLines(dir: string): string[] {
	const p = join(dir, '.swarm', 'telemetry.jsonl');
	return (
		readFileSync(p, 'utf-8')
			.split('\n')
			.filter((l) => l.length > 0)
			// CRLF files leave one trailing CR on each segment; the canonical
			// line content never includes it.
			.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l))
	);
}

describe('observability live/import dedupe (issue #2487)', () => {
	let dir: string;
	beforeEach(() => {
		dir = makeProject();
	});
	afterEach(() => {
		resetObservabilityEventSinkForTesting();
		resetTelemetryForTesting();
		cleanup(dir);
	});

	test('live emit + report import yields exactly-once rows (the AC1 regression)', async () => {
		registerObservabilityEventSink(dir);
		initTelemetry(dir);
		for (let i = 0; i < 6; i++) {
			emit(i % 2 === 0 ? 'delegation_begin' : 'delegation_end', {
				sessionId: 'sess-2487',
				taskId: `task-${i}`,
				agentName: 'coder',
				result: 'success',
			});
		}
		await settleStream();
		// Simulate the production restart boundary: the report path runs in a
		// separate process after the sink's writer and DB handle are gone, so
		// close everything before importing (issue #2487 review PRR-006).
		closeAllGroupCommitWriters();
		closeAllProjectDbs();

		const result = syncObservabilityImport(dir);
		const query = queryObservabilityEvents(dir, {});
		expect(query.rows.length).toBe(6);
		expect(query.totalMatching).toBe(6);
		expect(result.imported).toBe(0);
		expect(result.skippedLive).toBe(6);
		expect(result.skippedUnchanged).toBe(false);
		for (const row of query.rows) {
			expect(row.ingested_via).toBe('live');
			expect(row.quarantined).toBe(0);
		}
		// Each (kind, task_id) pair appears exactly once.
		const seen = new Set<string>();
		for (const row of query.rows) {
			const key = `${row.kind}\0${row.task_id}`;
			expect(seen.has(key)).toBe(false);
			seen.add(key);
		}
		expect(seen.size).toBe(6);
	});

	test('unchanged re-import is still a no-op and rescan adds no rows', () => {
		// Legacy-only project: no live sink.
		writeFileSync(
			join(dir, '.swarm', 'telemetry.jsonl'),
			[
				JSON.stringify({
					timestamp: '2026-01-01T00:00:00.000Z',
					event: 'gate_passed',
					sessionId: 's',
					taskId: 't1',
					gate: 'review',
				}),
				JSON.stringify({
					timestamp: '2026-01-01T00:00:01.000Z',
					event: 'gate_passed',
					sessionId: 's',
					taskId: 't2',
					gate: 'review',
				}),
				JSON.stringify({
					timestamp: '2026-01-01T00:00:02.000Z',
					event: 'delegation_end',
					sessionId: 's',
					taskId: 't1',
					agentName: 'coder',
					result: 'success',
				}),
			].join('\n') + '\n',
		);
		const first = syncObservabilityImport(dir);
		expect(first.imported).toBe(3);
		expect(first.skippedLive).toBe(0);
		const unchanged = syncObservabilityImport(dir);
		expect(unchanged.imported).toBe(0);
		expect(unchanged.skippedUnchanged).toBe(true);
		expect(queryObservabilityEvents(dir, {}).rows.length).toBe(3);
	});

	test('CRLF stream: live hash skips CR-bearing segment AND CR-hashed import ids stay idempotent', async () => {
		registerObservabilityEventSink(dir);
		initTelemetry(dir);
		emit('gate_passed', {
			sessionId: 'sess-crlf',
			taskId: 't-crlf',
			gate: 'review',
		});
		await settleStream();
		const line = telemetryLines(dir)[0]!;
		// Rewrite the file with CRLF line endings (simulating a cross-OS write).
		writeFileSync(join(dir, '.swarm', 'telemetry.jsonl'), `${line}\r\n`);
		const result = syncObservabilityImport(dir);
		expect(result.imported).toBe(0);
		expect(result.skippedLive).toBe(1);
		expect(queryObservabilityEvents(dir, {}).rows.length).toBe(1);
	});

	test('pre-v38-shaped live rows get the one-time backfill; guard-failing rows stay NULL', async () => {
		registerObservabilityEventSink(dir);
		initTelemetry(dir);
		emit('gate_passed', { sessionId: 's-bf', taskId: 't-bf', gate: 'review' });
		await settleStream();
		// Flush the group-commit writer so the live row is on disk before the
		// direct SQL reads below (queries flush; raw handles do not).
		queryObservabilityEvents(dir, {});
		// Simulate a pre-v38 row: clear its hash and insert a
		// timestamp-collision live row that cannot be byte-reconstructed.
		const db = _internals.getProjectDb(dir);
		db.run('UPDATE observability_event SET line_hash = NULL');
		db.run(
			`INSERT INTO observability_event (event_id, kind, occurred_at, payload_json, quarantined, ingested_via, line_hash) VALUES ('legacy-collision', 'gate_passed', '2026-01-01T00:00:00.000Z', ?, 0, 'live', NULL)`,
			[
				JSON.stringify({
					timestamp: '2020-01-01T00:00:00.000Z',
					event: 'other',
					sessionId: 'x',
				}),
			],
		);
		closeAllProjectDbs();

		const result = syncObservabilityImport(dir);
		// The reconstructible row's line was skipped (backfill populated it);
		// the collision row's line was never in the stream, so nothing imports.
		expect(result.skippedLive).toBe(1);
		expect(result.imported).toBe(0);

		const db2 = getProjectDb(dir);
		const rows = db2
			.query<{ event_id: string; line_hash: string | null }, []>(
				"SELECT event_id, line_hash FROM observability_event WHERE ingested_via = 'live'",
			)
			.all();
		const backfilled = rows.find((r) => r.event_id !== 'legacy-collision');
		expect(backfilled?.line_hash).toMatch(/^[a-f0-9]{64}$/);
		const collision = rows.find((r) => r.event_id === 'legacy-collision');
		expect(collision?.line_hash).toBeNull();
		// The backfill marker exists and a second sync re-runs nothing.
		const marker = db2
			.query<{ found: number }, []>(
				"SELECT 1 as found FROM observability_import WHERE source = '__live_line_hash_backfill__'",
			)
			.get();
		expect(marker).toBeDefined();
	});

	test('imported rows never carry line_hash (no false live-capture claims)', () => {
		writeFileSync(
			join(dir, '.swarm', 'telemetry.jsonl'),
			`${JSON.stringify({ timestamp: '2026-01-01T00:00:00.000Z', event: 'gate_passed', sessionId: 's', taskId: 't', gate: 'review' })}\n`,
		);
		syncObservabilityImport(dir);
		const db = getProjectDb(dir);
		const rows = db
			.query<{ ingested_via: string; line_hash: string | null }, []>(
				'SELECT ingested_via, line_hash FROM observability_event',
			)
			.all();
		expect(rows).toHaveLength(1);
		expect(rows[0]!.ingested_via).toBe('import');
		expect(rows[0]!.line_hash).toBeNull();
	});

	test('two same-payload emissions in different milliseconds yield TWO rows (no false collapse)', async () => {
		registerObservabilityEventSink(dir);
		initTelemetry(dir);
		emit('gate_passed', {
			sessionId: 's-dup',
			taskId: 't-dup',
			gate: 'review',
		});
		await new Promise((resolve) => setTimeout(resolve, 25));
		emit('gate_passed', {
			sessionId: 's-dup',
			taskId: 't-dup',
			gate: 'review',
		});
		await settleStream();
		syncObservabilityImport(dir);
		expect(queryObservabilityEvents(dir, {}).rows.length).toBe(2);
	});

	test('quarantined live row keeps its line hash computed from canonical content', () => {
		const canonical = sampleCanonical({
			huge: 'x'.repeat(64 * 1024),
		});
		appendObservabilityEventDb(dir, canonical);
		queryObservabilityEvents(dir, {});
		const db = getProjectDb(dir);
		const row = db
			.query<{ quarantined: number; line_hash: string | null }, []>(
				'SELECT quarantined, line_hash FROM observability_event',
			)
			.get();
		expect(row?.quarantined).toBe(1);
		expect(row?.line_hash).toMatch(/^[a-f0-9]{64}$/);
	});

	test('skippedLive counts only pre-existing live matches, not in-batch INSERT OR IGNORE collapse', () => {
		// Identical legacy lines collapse via INSERT OR IGNORE on synthetic ids;
		// neither is a live match, so skippedLive stays 0 and imported counts both.
		const line = JSON.stringify({
			timestamp: '2026-01-01T00:00:00.000Z',
			event: 'gate_passed',
			sessionId: 's',
			taskId: 't',
			gate: 'review',
		});
		writeFileSync(join(dir, '.swarm', 'telemetry.jsonl'), `${line}\n${line}\n`);
		const result = syncObservabilityImport(dir);
		expect(result.imported).toBe(2);
		expect(result.skippedLive).toBe(0);
		expect(queryObservabilityEvents(dir, {}).rows.length).toBe(1);
	});

	test('coverage stays honest after overlap suppression', async () => {
		registerObservabilityEventSink(dir);
		initTelemetry(dir);
		emit('gate_passed', {
			sessionId: 's-cov',
			taskId: 't-cov',
			gate: 'review',
		});
		await settleStream();
		syncObservabilityImport(dir);
		const coverage = readObservabilityCoverage(dir);
		expect(coverage?.liveRows).toBe(1);
		expect(coverage?.importedRows).toBe(0);
		expect(coverage?.totalRows).toBe(1);
	});

	test('no swarm.db materializes for a stream-only project that never syncs', () => {
		writeFileSync(
			join(dir, '.swarm', 'telemetry.jsonl'),
			`${JSON.stringify({ timestamp: '2026-01-01T00:00:00.000Z', event: 'gate_passed' })}\n`,
		);
		expect(existsSync(join(dir, '.swarm', 'swarm.db'))).toBe(false);
	});
});
