import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
	initTelemetry,
	LEGACY_OBSERVATION_ID_FIELD,
	LEGACY_OBSERVATION_ID_PROVENANCE_PREFIX,
	resetTelemetryForTesting,
} from '../../../src/telemetry.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const directories: string[] = [];

function makeProject(): string {
	const directory = canonicalMkdtemp('obs-identity-collision-2487-');
	mkdirSync(join(directory, '.swarm'), { recursive: true });
	directories.push(directory);
	return directory;
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

describe('issue #2487 — oversized identity collisions (F1.1)', () => {
	test('live-first oversized rows use the marker when caller event and timestamp collide', async () => {
		// Before this fix, the importer joined the marker by canonical id plus
		// caller-overridden kind/time, so it imported the same emit a second time.
		const directory = makeProject();
		registerObservabilityEventSink(directory);
		initTelemetry(directory);
		emit('gate_passed', {
			sessionId: 'oversized-live-collision',
			taskId: 'oversized-live-collision-task',
			gate: 'review',
			event: 'legacy-collision-kind',
			timestamp: 'legacy-collision-time',
			large: 'x'.repeat(MAX_EVENT_PAYLOAD_BYTES + 1024),
		});
		await flushAndDrainTelemetry();

		expect(syncObservabilityImport(directory).imported).toBe(1);
		const rows = getProjectDb(directory)
			.query<
				{
					kind: string;
					occurred_at: string;
					ingested_via: string;
					quarantined: number;
				},
				[]
			>(
				'SELECT kind, occurred_at, ingested_via, quarantined FROM observability_event ORDER BY rowid',
			)
			.all();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.kind).toBe('gate_passed');
		expect(rows[0]?.occurred_at).not.toBe('legacy-collision-time');
		expect(rows[0]?.ingested_via).toBe('live');
		expect(rows[0]?.quarantined).toBe(1);
	});

	test('import-first oversized rows reconcile after caller event and timestamp collisions', () => {
		// Before this fix, import-first reconciliation filtered by lossy caller
		// kind/time before it inspected the canonical marker, creating a duplicate.
		const directory = makeProject();
		const canonical = createObservation('gate_passed', {
			sessionId: 'oversized-import-collision',
			taskId: 'oversized-import-collision-task',
			gate: 'review',
			event: 'legacy-collision-kind',
			timestamp: 'legacy-collision-time',
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
				{
					event_id: string;
					kind: string;
					occurred_at: string;
					ingested_via: string;
					quarantined: number;
				},
				[]
			>(
				'SELECT event_id, kind, occurred_at, ingested_via, quarantined FROM observability_event ORDER BY rowid',
			)
			.all();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.event_id).toBe(canonical.eventId);
		expect(rows[0]?.kind).toBe('gate_passed');
		expect(rows[0]?.occurred_at).not.toBe('legacy-collision-time');
		expect(rows[0]?.ingested_via).toBe('live');
		expect(rows[0]?.quarantined).toBe(1);
	});
});
