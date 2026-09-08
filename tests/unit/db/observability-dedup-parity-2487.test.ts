/**
 * Issue #2487 acceptance checks AC3 and AC5.
 *
 * This check deliberately crosses the real telemetry listener, legacy JSONL,
 * and SQLite import paths. It does not replace the lower-level store tests.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
	queryObservabilityEvents,
	registerObservabilityEventSink,
	resetObservabilityEventSinkForTesting,
	syncObservabilityImport,
} from '../../../src/db/observability-event-store.js';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import {
	emit,
	initTelemetry,
	resetTelemetryForTesting,
} from '../../../src/telemetry.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

describe('issue #2487 — observability dedup parity', () => {
	let directory: string;

	beforeEach(() => {
		directory = canonicalMkdtemp('issue-2487-observability-dedup-');
		resetTelemetryForTesting();
		resetObservabilityEventSinkForTesting();
	});

	afterEach(() => {
		resetTelemetryForTesting();
		resetObservabilityEventSinkForTesting();
		closeAllProjectDbs();
		rmSync(directory, { recursive: true, force: true });
	});

	test('AC3/AC5: one live emit plus legacy import yields one canonical row', async () => {
		registerObservabilityEventSink(directory);
		initTelemetry(directory);
		emit('gate_passed', {
			sessionId: 'issue-2487-session',
			taskId: 'issue-2487-task',
			gate: 'review',
		});
		resetTelemetryForTesting();

		const telemetryPath = join(directory, '.swarm', 'telemetry.jsonl');
		for (let attempt = 0; attempt < 200; attempt += 1) {
			if (
				existsSync(telemetryPath) &&
				readFileSync(telemetryPath, 'utf8').trim()
			)
				break;
			await Bun.sleep(10);
		}
		expect(readFileSync(telemetryPath, 'utf8').trim()).not.toBe('');

		syncObservabilityImport(directory);
		const rows = queryObservabilityEvents(directory, {}).rows;
		// Before the fix, the live row used a random envelope id while the
		// importer used a content-derived id, so one event became two rows.
		expect(rows).toHaveLength(1);
		expect(rows[0]?.ingested_via).toBe('live');
		expect(rows[0]?.host_session_id).toBe('issue-2487-session');
		expect(rows[0]?.task_id).toBe('issue-2487-task');
	});

	test('legacy reader tolerates additive reserved observation metadata', () => {
		mkdirSync(join(directory, '.swarm'), { recursive: true });
		const telemetryPath = join(directory, '.swarm', 'telemetry.jsonl');
		writeFileSync(
			telemetryPath,
			`${JSON.stringify({
				timestamp: '2026-01-01T00:00:00.000Z',
				event: 'gate_passed',
				sessionId: 'issue-2487-additive-session',
				taskId: 'issue-2487-additive-task',
				gate: 'review',
				__swarm_observation_id: 'opencode-swarm-observation/v1:future-id',
				future_additive_field: 'preserve-reader-compatibility',
			})}\n`,
		);

		const imported = syncObservabilityImport(directory);
		const rows = queryObservabilityEvents(directory, {
			taskId: 'issue-2487-additive-task',
		}).rows;
		expect(imported.imported).toBe(1);
		expect(rows).toHaveLength(1);
		expect(
			JSON.parse(rows[0]?.payload_json ?? '{}').future_additive_field,
		).toBe('preserve-reader-compatibility');
	});
});
