import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
	appendObservabilityEventDb,
	MAX_EVENT_PAYLOAD_BYTES,
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
	createObservation,
	toLegacyTelemetryLine,
} from '../../../src/observability/index.js';
import {
	emit,
	flushAndDrainTelemetry,
	getTelemetryWriterStatus,
	initTelemetry,
	LEGACY_OBSERVATION_ID_FIELD,
	LEGACY_OBSERVATION_ID_PROVENANCE_PREFIX,
	resetTelemetryForTesting,
} from '../../../src/telemetry.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const directories: string[] = [];

function makeProject(): string {
	const directory = canonicalMkdtemp('obs-slice-b-2487-');
	mkdirSync(join(directory, '.swarm'), { recursive: true });
	directories.push(directory);
	return directory;
}

function canonicalAt(timestamp: string) {
	const event = createObservation('gate_passed', {
		sessionId: 'same-session',
		taskId: 'same-task',
		gate: 'review',
	});
	event.observedAt = timestamp;
	event.occurredAt = timestamp;
	return event;
}

afterEach(() => {
	resetObservabilityEventSinkForTesting();
	resetTelemetryForTesting();
	closeAllProjectDbs();
	while (directories.length > 0) {
		const directory = directories.pop();
		if (directory !== undefined)
			rmSync(directory, { recursive: true, force: true });
	}
});

describe('issue #2487 Slice B observability identity', () => {
	test('two identical live occurrences stay distinct during import reconciliation', () => {
		const directory = makeProject();
		const first = canonicalAt('2026-01-01T00:00:00.000Z');
		const second = canonicalAt('2026-01-01T00:00:00.000Z');
		appendObservabilityEventDb(directory, first);
		appendObservabilityEventDb(directory, second);
		writeFileSync(
			join(directory, '.swarm', 'telemetry.jsonl'),
			`${JSON.stringify(toLegacyTelemetryLine(first))}\n${JSON.stringify(toLegacyTelemetryLine(second))}\n`,
		);

		syncObservabilityImport(directory);
		const rows = queryObservabilityEvents(directory, {}).rows;
		expect(rows).toHaveLength(2);
		expect(rows.every((row) => row.ingested_via === 'live')).toBe(true);
		expect(new Set(rows.map((row) => row.event_id)).size).toBe(2);
	});

	test('a pre-existing random-id live row is reconciled without an import duplicate', () => {
		const directory = makeProject();
		const canonical = canonicalAt('2026-01-01T00:01:00.000Z');
		appendObservabilityEventDb(directory, canonical);
		writeFileSync(
			join(directory, '.swarm', 'telemetry.jsonl'),
			`${JSON.stringify(toLegacyTelemetryLine(canonical))}\n`,
		);

		const result = syncObservabilityImport(directory);
		const rows = queryObservabilityEvents(directory, {}).rows;
		expect(result.imported).toBe(1);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.event_id).toBe(canonical.eventId);
		expect(rows[0]?.ingested_via).toBe('live');
	});

	test('an import that wins the race is upgraded when the live event arrives', () => {
		const directory = makeProject();
		const canonical = canonicalAt('2026-01-02T00:00:00.000Z');
		writeFileSync(
			join(directory, '.swarm', 'telemetry.jsonl'),
			`${JSON.stringify(toLegacyTelemetryLine(canonical))}\n`,
		);
		expect(syncObservabilityImport(directory).imported).toBe(1);

		appendObservabilityEventDb(directory, canonical);
		const rows = queryObservabilityEvents(directory, {}).rows;
		expect(rows).toHaveLength(1);
		expect(rows[0]?.event_id).toBe(canonical.eventId);
		expect(rows[0]?.ingested_via).toBe('live');
	});

	test('a rotation rescan reuses moved import rows but keeps new identical occurrences distinct', () => {
		const directory = makeProject();
		const line = JSON.stringify({
			timestamp: '2026-01-03T00:00:00.000Z',
			event: 'gate_passed',
			sessionId: 'rotation-only',
		});
		const current = join(directory, '.swarm', 'telemetry.jsonl');
		writeFileSync(current, `${line}\n${line}\n`);
		syncObservabilityImport(directory);
		const before = queryObservabilityEvents(directory, {}).rows;
		expect(before).toHaveLength(2);
		expect(new Set(before.map((row) => row.event_id)).size).toBe(2);

		renameSync(current, join(directory, '.swarm', 'telemetry.jsonl.1'));
		writeFileSync(current, `${line}\n`);
		const rotated = syncObservabilityImport(directory);
		expect(rotated.skippedUnchanged).toBe(false);
		const after = queryObservabilityEvents(directory, {}).rows;
		expect(after).toHaveLength(3);
		expect(
			before.every((row) =>
				after.some((candidate) => candidate.event_id === row.event_id),
			),
		).toBe(true);
		expect(new Set(after.map((row) => row.event_id)).size).toBe(3);
		expect(syncObservabilityImport(directory).imported).toBe(0);
		expect(queryObservabilityEvents(directory, {}).rows).toHaveLength(3);
	});

	test('a new current occurrence is not reused from an unchanged rotated generation', () => {
		const directory = makeProject();
		const line = JSON.stringify({
			timestamp: '2026-01-03T12:00:00.000Z',
			event: 'gate_passed',
			sessionId: 'unchanged-rotation-source',
		});
		const rotated = join(directory, '.swarm', 'telemetry.jsonl.1');
		const current = join(directory, '.swarm', 'telemetry.jsonl');
		writeFileSync(rotated, `${line}\n`);
		expect(syncObservabilityImport(directory).imported).toBe(1);
		expect(queryObservabilityEvents(directory, {}).rows).toHaveLength(1);

		writeFileSync(current, `${line}\n`);
		expect(syncObservabilityImport(directory).skippedUnchanged).toBe(false);
		const rows = queryObservabilityEvents(directory, {}).rows;
		expect(rows).toHaveLength(2);
		expect(new Set(rows.map((row) => row.event_id)).size).toBe(2);
		expect(syncObservabilityImport(directory).imported).toBe(0);
	});

	test('one live candidate is consumed across rotated and current files', () => {
		const directory = makeProject();
		const first = canonicalAt('2026-01-04T00:00:00.000Z');
		const second = canonicalAt('2026-01-04T00:00:00.000Z');
		appendObservabilityEventDb(directory, first);
		appendObservabilityEventDb(directory, second);
		const line = JSON.stringify(toLegacyTelemetryLine(first));
		writeFileSync(join(directory, '.swarm', 'telemetry.jsonl.1'), `${line}\n`);
		writeFileSync(join(directory, '.swarm', 'telemetry.jsonl'), `${line}\n`);

		syncObservabilityImport(directory);
		const rows = queryObservabilityEvents(directory, {}).rows;
		expect(rows).toHaveLength(2);
		expect(rows.every((row) => row.ingested_via === 'live')).toBe(true);
		expect(new Set(rows.map((row) => row.event_id)).size).toBe(2);
	});

	test('fallback observations use distinct ids while keeping the failure marker', () => {
		const hostileKind = () => Object.create(null) as string;
		const first = createObservation(hostileKind(), {});
		const second = createObservation(hostileKind(), {});
		expect(first.eventId).not.toBe(second.eventId);
		expect(first.eventId).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/i,
		);
		expect(first.relationshipViolations).toContain('observation_build_failed');
		expect(second.relationshipViolations).toContain('observation_build_failed');
	});

	test('the canonical sink receives an event before legacy telemetry is initialized', () => {
		const directory = makeProject();
		registerObservabilityEventSink(directory);
		emit('gate_passed', {
			sessionId: 'before-telemetry-init',
			taskId: 'before-telemetry-init-task',
			gate: 'before-init',
		});

		const rows = queryObservabilityEvents(directory, {}).rows;
		expect(rows).toHaveLength(1);
		expect(rows[0]?.ingested_via).toBe('live');
		expect(getTelemetryWriterStatus(directory).state).toBe('uninitialized');
	});
});

describe('issue #2487 Slice B identity — regression: oversized quarantined rows reconcile one-to-one (F1)', () => {
	test('a live oversized canonical row is not duplicated by its marked legacy line', async () => {
		// Before this fix, loadLiveProjectionCandidates excluded quarantined rows,
		// so the same oversized emit produced one live row and one import row.
		const directory = makeProject();
		registerObservabilityEventSink(directory);
		initTelemetry(directory);
		emit('gate_passed', {
			sessionId: 'oversized-live',
			taskId: 'oversized-live-task',
			gate: 'review',
			large: 'x'.repeat(MAX_EVENT_PAYLOAD_BYTES + 1024),
		});
		await flushAndDrainTelemetry();

		const result = syncObservabilityImport(directory);
		const rows = getProjectDb(directory)
			.query<
				{ event_id: string; ingested_via: string; quarantined: number },
				[]
			>(
				'SELECT event_id, ingested_via, quarantined FROM observability_event ORDER BY rowid',
			)
			.all();
		expect(result.imported).toBe(1);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.ingested_via).toBe('live');
		expect(rows[0]?.quarantined).toBe(1);
	});

	test('an oversized import row is upgraded when its canonical event arrives later', () => {
		// Before this fix, import-first reconciliation rejected quarantined import
		// rows, so a later canonical append created a second row for the same emit.
		const directory = makeProject();
		const canonical = createObservation('gate_passed', {
			sessionId: 'oversized-import-first',
			taskId: 'oversized-import-first-task',
			gate: 'review',
			large: 'x'.repeat(MAX_EVENT_PAYLOAD_BYTES + 1024),
		});
		const legacy = toLegacyTelemetryLine(canonical);
		legacy[LEGACY_OBSERVATION_ID_FIELD] =
			`${LEGACY_OBSERVATION_ID_PROVENANCE_PREFIX}${canonical.eventId}`;
		writeFileSync(
			join(directory, '.swarm', 'telemetry.jsonl'),
			`${JSON.stringify(legacy)}\n`,
		);

		expect(syncObservabilityImport(directory).imported).toBe(1);
		appendObservabilityEventDb(directory, canonical);
		queryObservabilityEvents(directory, {});
		const rows = getProjectDb(directory)
			.query<
				{ event_id: string; ingested_via: string; quarantined: number },
				[]
			>(
				'SELECT event_id, ingested_via, quarantined FROM observability_event ORDER BY rowid',
			)
			.all();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.event_id).toBe(canonical.eventId);
		expect(rows[0]?.ingested_via).toBe('live');
		expect(rows[0]?.quarantined).toBe(1);
	});
});

describe('issue #2487 Slice B identity — regression: fallback ids survive same-clock processes (F2)', () => {
	test('independent processes do not collide when Date.now is identical', () => {
		// Before this fix, fallback ids encoded only Date.now plus the local
		// sequence, so independent processes sharing a clock tick collided.
		const observeUrl = new URL(
			'../../../src/observability/observe.ts',
			import.meta.url,
		).href;
		const childSource = `
			Date.now = () => 1700000000000;
			const { createObservation } = await import(${JSON.stringify(observeUrl)});
			const hostileKind = () => Object.create(null);
			console.log(createObservation(hostileKind(), {}).eventId);
		`;
		const run = () =>
			spawnSync(process.execPath, ['-e', childSource], {
				encoding: 'utf8',
				timeout: 30_000,
				windowsHide: true,
			});
		const first = run();
		const second = run();
		expect(first.status).toBe(0);
		expect(second.status).toBe(0);
		const firstId = first.stdout.trim();
		const secondId = second.stdout.trim();
		expect(firstId).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/i,
		);
		expect(secondId).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/i,
		);
		expect(firstId).not.toBe(secondId);
	});
});

describe('issue #2487 Slice B legacy writer state', () => {
	test('serialization failure is bounded and a successful init recovers only the legacy latch', () => {
		const directory = makeProject();
		initTelemetry(directory);
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		emit('session_started', circular);
		const failed = getTelemetryWriterStatus();
		expect(failed.state).toBe('disabled');
		expect(failed.failureCount).toBe(1);
		expect(failed.lastFailureReason).toBe('serialize_failed');

		initTelemetry(directory);
		const recovered = getTelemetryWriterStatus();
		expect(recovered.state).toBe('active');
		expect(recovered.disabled).toBe(false);
		expect(recovered.failureCount).toBe(1);
	});

	test('writer health is root-scoped while last-init-wins remains explicit', () => {
		const first = makeProject();
		const second = makeProject();
		initTelemetry(first);
		expect(getTelemetryWriterStatus(first).state).toBe('active');

		const circular: Record<string, unknown> = {};
		circular.self = circular;
		emit('session_started', circular);
		expect(getTelemetryWriterStatus(first).state).toBe('disabled');
		expect(getTelemetryWriterStatus(second).state).toBe('uninitialized');

		initTelemetry(second);
		expect(getTelemetryWriterStatus(second).state).toBe('active');
		expect(getTelemetryWriterStatus(second).failureCount).toBe(0);
		expect(getTelemetryWriterStatus(first).state).toBe('uninitialized');
	});

	test('canonical identity wins over a reserved legacy-field collision', async () => {
		const directory = makeProject();
		registerObservabilityEventSink(directory);
		initTelemetry(directory);
		emit('gate_passed', {
			sessionId: 'reserved-collision',
			taskId: 'task-reserved',
			gate: 'review',
			[LEGACY_OBSERVATION_ID_FIELD]: 'spoofed-user-id',
		});
		await flushAndDrainTelemetry();
		const row = queryObservabilityEvents(directory, {}).rows[0];
		expect(row).toBeDefined();
		const legacy = JSON.parse(
			readFileSync(join(directory, '.swarm', 'telemetry.jsonl'), 'utf8'),
		) as Record<string, unknown>;
		expect(legacy[LEGACY_OBSERVATION_ID_FIELD]).toBe(
			`${LEGACY_OBSERVATION_ID_PROVENANCE_PREFIX}${row?.event_id}`,
		);
		expect(legacy[LEGACY_OBSERVATION_ID_FIELD]).not.toBe('spoofed-user-id');
		syncObservabilityImport(directory);
		expect(queryObservabilityEvents(directory, {}).rows).toHaveLength(1);
	});

	test('legacy-only UUID and digest caller collisions are imported with synthetic identities', async () => {
		const directory = makeProject();
		const collisions = ['11111111-1111-4111-8111-111111111111', '2'.repeat(64)];
		initTelemetry(directory);
		for (const [index, collision] of collisions.entries()) {
			emit('gate_passed', {
				sessionId: `legacy-only-${index}`,
				taskId: `legacy-only-task-${index}`,
				gate: 'legacy-only',
				[LEGACY_OBSERVATION_ID_FIELD]: collision,
			});
			const live = canonicalAt(`2026-01-05T00:00:0${index}.000Z`);
			live.eventId = collision;
			appendObservabilityEventDb(directory, live);
		}
		await flushAndDrainTelemetry();

		const result = syncObservabilityImport(directory);
		const rows = queryObservabilityEvents(directory, {}).rows;
		expect(result.imported).toBe(2);
		expect(rows).toHaveLength(4);
		expect(
			rows
				.filter((row) => row.ingested_via === 'import')
				.map((row) => row.event_id),
		).not.toContain(collisions[0]);
		expect(
			rows
				.filter((row) => row.ingested_via === 'import')
				.map((row) => row.event_id),
		).not.toContain(collisions[1]);
	});

	test('a forged versioned marker cannot claim an unmatched live event id', async () => {
		const directory = makeProject();
		const collision = '33333333-3333-4333-8333-333333333333';
		initTelemetry(directory);
		emit('gate_passed', {
			sessionId: 'forged-marker',
			taskId: 'forged-marker-task',
			gate: 'forged-marker',
			[LEGACY_OBSERVATION_ID_FIELD]: `${LEGACY_OBSERVATION_ID_PROVENANCE_PREFIX}${collision}`,
		});
		const unrelatedLive = canonicalAt('2026-01-06T00:00:00.000Z');
		unrelatedLive.eventId = collision;
		appendObservabilityEventDb(directory, unrelatedLive);
		await flushAndDrainTelemetry();

		expect(syncObservabilityImport(directory).imported).toBe(1);
		const rows = queryObservabilityEvents(directory, {}).rows;
		expect(rows).toHaveLength(2);
		expect(
			rows.find((row) => row.ingested_via === 'import')?.event_id,
		).not.toBe(collision);
	});
});
