import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DbWriteError } from '../../../src/db/db-errors.js';
import {
	_internals,
	isObservabilitySinkDisabled,
	queryObservabilityEvents,
	readObservabilitySinkHealth,
	registerObservabilityEventSink,
	resetObservabilityEventSinkForTesting,
	syncObservabilityImport,
} from '../../../src/db/observability-event-store.js';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import {
	canonicalLineContent,
	createObservation,
	toLegacyTelemetryLine,
} from '../../../src/observability/index.js';
import {
	emit,
	initTelemetry,
	resetTelemetryForTesting,
} from '../../../src/telemetry.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

/**
 * Issue #2487 sink controls: the SWARM_OBSERVABILITY_SINK_DISABLE kill switch
 * (strict '1', live-path only, import never gated) and the classified sink
 * failure health category.
 */

function makeProject(): string {
	const dir = canonicalMkdtemp('obs-controls-2487-');
	mkdirSync(join(dir, '.swarm'), { recursive: true });
	return dir;
}

function cleanup(dir: string): void {
	closeAllProjectDbs();
	rmSync(dir, { recursive: true, force: true });
}

function setEnv(value: string | undefined): void {
	if (value === undefined) {
		delete process.env.SWARM_OBSERVABILITY_SINK_DISABLE;
	} else {
		process.env.SWARM_OBSERVABILITY_SINK_DISABLE = value;
	}
}

async function settleStream(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 250));
}

describe('observability sink kill switch + failure classification (issue #2487)', () => {
	let dir: string;
	beforeEach(() => {
		dir = makeProject();
	});
	afterEach(() => {
		setEnv(undefined);
		resetObservabilityEventSinkForTesting();
		resetTelemetryForTesting();
		cleanup(dir);
	});

	test('strictness matrix: only the exact string 1 disables', () => {
		for (const value of ['0', 'true', 'yes', '']) {
			setEnv(value);
			expect(isObservabilitySinkDisabled()).toBe(false);
		}
		setEnv(undefined);
		expect(isObservabilitySinkDisabled()).toBe(false);
		setEnv('1');
		expect(isObservabilitySinkDisabled()).toBe(true);
	});

	test('disabled sink: no live rows, no materialized swarm.db, JSONL still written, import still rebuilds', async () => {
		setEnv('1');
		registerObservabilityEventSink(dir);
		initTelemetry(dir);
		emit('gate_passed', {
			sessionId: 's-off',
			taskId: 't-off',
			gate: 'review',
		});
		await settleStream();
		expect(existsSync(join(dir, '.swarm', 'swarm.db'))).toBe(false);

		// The report-path import is NOT gated by the kill switch — it rebuilds
		// exactly once from the operational JSONL record.
		const result = syncObservabilityImport(dir);
		expect(result.imported).toBe(1);
		expect(result.skippedLive).toBe(0);
		const query = queryObservabilityEvents(dir, {});
		expect(query.rows.length).toBe(1);
		expect(query.rows[0]!.ingested_via).toBe('import');
	});

	test('register-after-env-set: no sink rows while disabled (differential positive control in the enabled suite)', async () => {
		setEnv('1');
		registerObservabilityEventSink(dir);
		initTelemetry(dir);
		emit('gate_passed', {
			sessionId: 's-off',
			taskId: 't-off',
			gate: 'review',
		});
		await settleStream();
		expect(existsSync(join(dir, '.swarm', 'swarm.db'))).toBe(false);
		setEnv(undefined);
		// Differential control: the SAME emission path with the switch cleared
		// and the sink re-registered stores exactly one live row — proving the
		// disabled branch above was reached and suppressed, not that the path
		// never ran.
		registerObservabilityEventSink(dir);
		emit('gate_passed', { sessionId: 's-on', taskId: 't-on', gate: 'review' });
		await settleStream();
		const rows = queryObservabilityEvents(dir, {}).rows;
		expect(rows.length).toBe(1);
		expect(rows[0]!.ingested_via).toBe('live');
		expect(rows[0]!.host_session_id).toBe('s-on');
	});

	test('sink failure surfaces the classified DbWriteError category', () => {
		const real = _internals.getGroupCommitWriter;
		try {
			delete process.env.SWARM_OBSERVABILITY_SINK_DISABLE;
			resetObservabilityEventSinkForTesting();
			registerObservabilityEventSink(dir);
			initTelemetry(dir);
			_internals.getGroupCommitWriter = () => {
				throw new DbWriteError('disk_full', 'simulated disk full');
			};
			expect(() => {
				emit('gate_passed', {
					sessionId: 's-err',
					taskId: 't-err',
					gate: 'review',
				});
			}).not.toThrow();
			const health = readObservabilitySinkHealth(dir);
			expect(health?.last_error_category).toBe('disk_full');
			expect(health?.dropped).toBeGreaterThanOrEqual(1);
		} finally {
			_internals.getGroupCommitWriter = real;
			resetTelemetryForTesting();
		}
	});

	test('untyped sink failure keeps the constructor-name diagnostic', () => {
		const real = _internals.getGroupCommitWriter;
		try {
			delete process.env.SWARM_OBSERVABILITY_SINK_DISABLE;
			resetObservabilityEventSinkForTesting();
			registerObservabilityEventSink(dir);
			initTelemetry(dir);
			_internals.getGroupCommitWriter = () => {
				throw new Error('plain failure');
			};
			emit('gate_passed', {
				sessionId: 's-plain',
				taskId: 't-plain',
				gate: 'review',
			});
			const health = readObservabilitySinkHealth(dir);
			expect(health?.last_error_category).toBe('Error');
		} finally {
			_internals.getGroupCommitWriter = real;
			resetTelemetryForTesting();
		}
	});

	test('canonicalLineContent is byte-identical to the legacy projection and never throws on odd payloads', () => {
		const cases: Array<
			Record<string, unknown> | null | undefined | string | number[]
		> = [
			{ sessionId: 's', taskId: 't', gate: 'review' },
			{},
			null,
			undefined,
			'primitive',
			[1, 2, 3],
		];
		for (const payload of cases) {
			const canonical = createObservation(
				'gate_passed',
				payload as Record<string, unknown>,
			) as ReturnType<typeof createObservation>;
			expect(canonicalLineContent(canonical)).toBe(
				JSON.stringify(toLegacyTelemetryLine(canonical)),
			);
		}
	});

	// PRR-007 (issue #2487 review): pin the unserializable-payload contract.
	// JSON.stringify throws on circular structures and BigInt values, so
	// canonicalLineContent itself throws; containment lives one layer out —
	// emit() catches before the listener fan-out (src/telemetry.ts, ordering
	// pinned by src/telemetry.test.ts:137-162) and the sink's hash path
	// catches to null (buildLiveRow).
	test('canonicalLineContent throws on circular and BigInt payloads (callers own containment)', () => {
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		const payloads: Record<string, unknown>[] = [circular, { big: 1n }];
		for (const payload of payloads) {
			const canonical = createObservation('gate_passed', payload) as ReturnType<
				typeof createObservation
			>;
			expect(() => canonicalLineContent(canonical)).toThrow();
		}
	});
});
