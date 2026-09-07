/**
 * OTLP exporter outage/adversarial behavior (issue #2485 / #2049): collector
 * unavailable, 429 + Retry-After, circuit open/cooldown/probe, restart
 * replay from the persistent spool, and spool byte-cap drop-oldest.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
	flushOtlpExporterForTesting,
	OTLP_EXPORT_SPOOL_DIR,
	readOtlpExporterHealth,
	registerOtlpExporter,
	resetOtlpExporterForTesting,
} from '../../../src/observability/otlp-exporter.js';
import {
	initTelemetry,
	resetTelemetryForTesting,
} from '../../../src/telemetry.js';
import {
	deadEndpointUrl,
	freshProjectDir,
	spansOf,
	startStubCollector,
	testExportConfig,
} from './otlp-fixtures.js';

const PAYLOAD = {
	tokens_input: 42,
	model: 'outage-model',
	sessionId: 'replay-probe',
	prompt: 'NEVERSEENPROMPT',
};

afterEach(() => {
	resetOtlpExporterForTesting();
	resetTelemetryForTesting();
});

function spoolSize(dir: string): number {
	try {
		return statSync(join(dir, OTLP_EXPORT_SPOOL_DIR, 'spool.jsonl')).size;
	} catch {
		return 0;
	}
}

describe('collector unavailable (transient)', () => {
	test('flush fails transiently: records retained, retried counted, error categorized', async () => {
		const dead = await deadEndpointUrl();
		const dir = freshProjectDir();
		initTelemetry(dir);
		registerOtlpExporter(
			dir,
			testExportConfig(dead, { maxRetries: 1, backoffBaseMs: 5 }),
		);
		const { emit } = await import('../../../src/telemetry.js');
		emit('delegation_begin' as never, { ...PAYLOAD } as never);
		await flushOtlpExporterForTesting(dir);
		await flushOtlpExporterForTesting(dir);

		const health = readOtlpExporterHealth(dir);
		expect(health).not.toBeNull();
		expect(health?.spoolRecords).toBe(1);
		expect(health?.retried).toBeGreaterThanOrEqual(1);
		expect(health?.lastErrorCategory).not.toBeNull();
		// Local behavior stays independent: the spool holds the record for
		// later replay, nothing was dropped.
		expect(health?.exported).toBe(0);
	}, 20_000);
});

describe('429 with Retry-After', () => {
	test('a rate-limited batch retries within the honored window and then ships', async () => {
		const stub = await startStubCollector();
		const dir = freshProjectDir();
		initTelemetry(dir);
		registerOtlpExporter(
			dir,
			testExportConfig(stub.url, { maxRetries: 2, backoffBaseMs: 5 }),
		);
		const { emit } = await import('../../../src/telemetry.js');
		emit('delegation_begin' as never, { ...PAYLOAD } as never);
		stub.respond(429, { 'retry-after': '0' });
		await flushOtlpExporterForTesting(dir);
		// The exhausted cycle set a backoff window; let it elapse, then flip
		// the collector healthy and flush again.
		await new Promise((r) => setTimeout(r, 60));
		stub.respond(200);
		await flushOtlpExporterForTesting(dir);

		const statuses = stub.requests.map((r) => r.status);
		expect(statuses[0]).toBe(429);
		expect(statuses).toContain(200);
		const health = readOtlpExporterHealth(dir);
		expect(health?.exported).toBeGreaterThanOrEqual(1);
		expect(health?.spoolRecords).toBe(0);
		await stub.close();
	}, 20_000);
});

describe('restart replay', () => {
	test('spooled-but-unshipped records survive re-registration and ship later', async () => {
		const dead = await deadEndpointUrl();
		const stub = await startStubCollector();
		const dir = freshProjectDir();
		initTelemetry(dir);
		registerOtlpExporter(
			dir,
			testExportConfig(dead, { maxRetries: 0, backoffBaseMs: 5 }),
		);
		const { emit } = await import('../../../src/telemetry.js');
		emit(
			'delegation_begin' as never,
			{
				...PAYLOAD,
				sessionId: 'replay-alpha-4d2f',
			} as never,
		);
		emit(
			'delegation_begin' as never,
			{
				...PAYLOAD,
				sessionId: 'replay-beta-8c71',
			} as never,
		);
		await flushOtlpExporterForTesting(dir);
		expect(readOtlpExporterHealth(dir)?.spoolRecords).toBe(2);

		// "Restart": drop in-memory state, re-register the SAME directory
		// against a healthy collector, flush — both records ship.
		resetOtlpExporterForTesting();
		initTelemetry(dir);
		registerOtlpExporter(
			dir,
			testExportConfig(stub.url, { maxRetries: 1, backoffBaseMs: 5 }),
		);
		// A single flush can race the persisted backoff window on a loaded
		// host; poll with bounded retries until both markers have shipped.
		let allSerialized = '';
		for (let attempt = 0; attempt < 20; attempt++) {
			await flushOtlpExporterForTesting(dir);
			allSerialized = stub.requests
				.map((r) => JSON.stringify(r.body))
				.join(' ');
			if (
				allSerialized.includes('replay-alpha-4d2f') &&
				allSerialized.includes('replay-beta-8c71')
			) {
				break;
			}
			await new Promise((r) => setTimeout(r, 50));
		}
		expect(allSerialized).toContain('replay-alpha-4d2f');
		expect(allSerialized).toContain('replay-beta-8c71');
		expect(readOtlpExporterHealth(dir)?.spoolRecords).toBe(0);
		await stub.close();
	}, 20_000);
});

describe('spool byte cap', () => {
	test('drop-oldest keeps the spool within budget and counts spool_cap drops', async () => {
		const dead = await deadEndpointUrl();
		const dir = freshProjectDir();
		initTelemetry(dir);
		registerOtlpExporter(
			dir,
			testExportConfig(dead, {
				spoolMaxBytes: 4 * 1024,
				maxRetries: 0,
				backoffBaseMs: 5,
			}),
		);
		const { emit } = await import('../../../src/telemetry.js');
		for (let i = 0; i < 40; i++) {
			emit(
				'delegation_begin' as never,
				{
					...PAYLOAD,
					sessionId: `cap-${i}`,
				} as never,
			);
		}
		// Drop-oldest happens at append time; budget + slack asserted.
		expect(spoolSize(dir)).toBeLessThanOrEqual(5 * 1024);
		const health = readOtlpExporterHealth(dir);
		expect(health?.dropped['spool_cap'] ?? 0).toBeGreaterThanOrEqual(1);
	}, 20_000);
});

describe('circuit', () => {
	test('consecutive failed cycles open the circuit; a later successful probe closes it', async () => {
		const dead = await deadEndpointUrl();
		const stub = await startStubCollector();
		const dir = freshProjectDir();
		initTelemetry(dir);
		registerOtlpExporter(
			dir,
			testExportConfig(dead, {
				maxRetries: 0,
				backoffBaseMs: 5,
				backoffMaxMs: 10,
				circuitThreshold: 3,
				circuitCooldownMs: 30_000,
			}),
		);
		const { emit } = await import('../../../src/telemetry.js');
		emit('delegation_begin' as never, { ...PAYLOAD } as never);

		// Three failed cycles trip the threshold.
		await flushOtlpExporterForTesting(dir);
		await new Promise((r) => setTimeout(r, 30));
		await flushOtlpExporterForTesting(dir);
		await new Promise((r) => setTimeout(r, 30));
		await flushOtlpExporterForTesting(dir);
		const open = readOtlpExporterHealth(dir);
		expect(open?.circuitOpen).toBe(true);
		expect(open?.state).toBe('cooldown');

		// Rebind to a healthy collector with a SHORT cooldown; after it
		// elapses, the recovery probe ships and closes the circuit.
		resetOtlpExporterForTesting();
		initTelemetry(dir);
		registerOtlpExporter(
			dir,
			testExportConfig(stub.url, {
				backoffBaseMs: 5,
				maxRetries: 1,
				circuitCooldownMs: 60,
			}),
		);
		await new Promise((r) => setTimeout(r, 90));
		await flushOtlpExporterForTesting(dir);
		const closed = readOtlpExporterHealth(dir);
		expect(closed?.circuitOpen).toBe(false);
		expect(closed?.exported).toBeGreaterThanOrEqual(1);
		await stub.close();
	}, 30_000);

	test('post-restart health display uses the persisted circuitCooldownMs, not a fixed default', async () => {
		const dead = await deadEndpointUrl();
		const dir = freshProjectDir();
		initTelemetry(dir);
		registerOtlpExporter(
			dir,
			testExportConfig(dead, {
				maxRetries: 0,
				backoffBaseMs: 5,
				backoffMaxMs: 10,
				circuitThreshold: 1,
				circuitCooldownMs: 200,
			}),
		);
		const { emit } = await import('../../../src/telemetry.js');
		emit('delegation_begin' as never, { ...PAYLOAD } as never);
		await flushOtlpExporterForTesting(dir);
		expect(readOtlpExporterHealth(dir)?.circuitOpen).toBe(true);

		// Restart: the in-memory config is gone; only persisted state remains.
		resetOtlpExporterForTesting();
		// Past the CONFIGURED 200 ms cooldown but far inside a fixed 60 s
		// fallback — the persisted cooldown must report the circuit closed.
		await new Promise((r) => setTimeout(r, 260));
		const afterRestart = readOtlpExporterHealth(dir);
		expect(afterRestart?.circuitOpen).toBe(false);
		expect(afterRestart?.state).toBe('disabled');
	}, 20_000);
});

describe('TLS/auth failure classification (secret-safe diagnostics)', () => {
	test('a permanent 4xx drops the batch with a terminal reason and no secret text', async () => {
		const stub = await startStubCollector();
		const dir = freshProjectDir();
		initTelemetry(dir);
		registerOtlpExporter(
			dir,
			testExportConfig(stub.url, {
				headers: { Authorization: 'Bearer SECRETTOKEN99' },
				maxRetries: 2,
				backoffBaseMs: 5,
			}),
		);
		const { emit } = await import('../../../src/telemetry.js');
		emit('delegation_begin' as never, { ...PAYLOAD } as never);
		stub.respond(403);
		await flushOtlpExporterForTesting(dir);

		const health = readOtlpExporterHealth(dir);
		expect(health?.dropped['rejected_permanent'] ?? 0).toBeGreaterThanOrEqual(
			1,
		);
		expect(health?.spoolRecords).toBe(0);
		// PR review PRR-002 pin: a terminally rejected batch is a DROP, not
		// an export — no exported credit, no success timestamp, and the
		// circuit-failure accounting is left untouched (neither reset nor
		// incremented by a 4xx).
		expect(health?.exported).toBe(0);
		expect(health?.lastSuccessAt).toBeNull();
		// Config headers reach the wire (PRR-019) — and the secret must not
		// leak into diagnostics either way.
		const sawAuth = stub.requests.some(
			(r) => r.headers['authorization'] === 'Bearer SECRETTOKEN99',
		);
		expect(sawAuth).toBe(true);
		// Diagnostics stay secret-safe: category only, never header values or
		// endpoint strings. The whole persisted state is checked.
		const stateText = readFileSync(
			join(dir, OTLP_EXPORT_SPOOL_DIR, 'state.json'),
			'utf-8',
		);
		expect(stateText).not.toContain('SECRETTOKEN99');
		await stub.close();
	}, 20_000);

	test('a TLS-level connect failure (https to a plain-http port) is classified transient, never a success', async () => {
		// The issue's "TLS/auth failure" obligation: point the exporter at
		// https:// on the stub's plain-http port — the TLS handshake fails
		// before any HTTP exchange. Records stay spooled for replay, the
		// error category is set, and no header material leaks.
		const stub = await startStubCollector();
		const dir = freshProjectDir();
		initTelemetry(dir);
		const tlsUrl = stub.url.replace('http://', 'https://');
		registerOtlpExporter(
			dir,
			testExportConfig(tlsUrl, {
				headers: { Authorization: 'Bearer SECRETTOKEN99' },
				maxRetries: 0,
				backoffBaseMs: 5,
			}),
		);
		const { emit } = await import('../../../src/telemetry.js');
		emit('delegation_begin' as never, { ...PAYLOAD } as never);
		await flushOtlpExporterForTesting(dir);
		const health = readOtlpExporterHealth(dir);
		// Handshake failure is transient network: batch retained for replay.
		expect(health?.spoolRecords).toBe(1);
		expect(health?.exported).toBe(0);
		expect(health?.lastErrorCategory ?? null).not.toBeNull();
		expect(health?.lastErrorCategory).not.toBe('rejected_permanent');
		const stateText = readFileSync(
			join(dir, OTLP_EXPORT_SPOOL_DIR, 'state.json'),
			'utf-8',
		);
		expect(stateText).not.toContain('SECRETTOKEN99');
		await stub.close();
	}, 20_000);

	test('a negative Retry-After hint is ignored (backoff still applies)', async () => {
		const stub = await startStubCollector();
		const dir = freshProjectDir();
		initTelemetry(dir);
		registerOtlpExporter(
			dir,
			testExportConfig(stub.url, {
				maxRetries: 1,
				backoffBaseMs: 5,
				backoffMaxMs: 20,
			}),
		);
		const { emit } = await import('../../../src/telemetry.js');
		emit('delegation_begin' as never, { ...PAYLOAD } as never);
		stub.respond(429, { 'retry-after': '-1' });
		await flushOtlpExporterForTesting(dir);
		// The negative hint must not produce an immediate tight retry: with
		// the hint ignored, attempts stay bounded and the records remain
		// spooled (retry budget exhausted within this cycle).
		const health = readOtlpExporterHealth(dir);
		expect(health?.spoolRecords).toBe(1);
		expect(health?.exported).toBe(0);
		await stub.close();
	}, 20_000);

	test('flush-path age sweep drops records that aged while idle (spool_age)', async () => {
		const stub = await startStubCollector();
		const dir = freshProjectDir();
		initTelemetry(dir);
		registerOtlpExporter(
			dir,
			testExportConfig(stub.url, {
				batchSize: 8,
				maxRetries: 0,
				spoolMaxAgeMs: 50,
			}),
		);
		const { emit } = await import('../../../src/telemetry.js');
		emit('delegation_begin' as never, { ...PAYLOAD } as never);
		// Let the record age past the 50ms budget BEFORE the first flush:
		// the flush read path (not just the append path) must sweep it.
		await new Promise((r) => setTimeout(r, 90));
		await flushOtlpExporterForTesting(dir);
		const health = readOtlpExporterHealth(dir);
		expect(health?.dropped['spool_age'] ?? 0).toBeGreaterThanOrEqual(1);
		expect(health?.exported).toBe(0);
		expect(health?.spoolRecords).toBe(0);
		expect(stub.requests.length).toBe(0);
		await stub.close();
	}, 20_000);

	test('records appended during a flush await survive the shipped-removal (id-matched)', async () => {
		// PRR-009 regression: with a tiny spool budget, the record appended
		// by the listener DURING the flush's network await forces a cap-drop
		// from the front. The post-await removal must be id-matched — the
		// still-unshipped appended record must survive (a blind front slice
		// would silently erase it).
		const stub = await startStubCollector({ delayMs: 150 });
		const dir = freshProjectDir();
		initTelemetry(dir);
		registerOtlpExporter(
			dir,
			testExportConfig(stub.url, {
				batchSize: 1,
				maxRetries: 0,
				backoffBaseMs: 5,
				spoolMaxBytes: 700, // ~2 records; forces drop-oldest on append
			}),
		);
		const { emit } = await import('../../../src/telemetry.js');
		emit(
			'delegation_begin' as never,
			{ ...PAYLOAD, sessionId: 'race-alpha' } as never,
		);
		const flushPromise = flushOtlpExporterForTesting(dir);
		// Land inside the flush's network await: append a second record that
		// trips the byte-cap drop-oldest of the first (front mutation).
		await new Promise((r) => setTimeout(r, 40));
		emit(
			'delegation_begin' as never,
			{ ...PAYLOAD, sessionId: 'race-beta' } as never,
		);
		await flushPromise;
		// Second flush ships whatever survived; BOTH session ids must
		// eventually reach the collector or be terminal-dropped with a
		// reason — neither may vanish silently.
		await flushOtlpExporterForTesting(dir);
		const allSerialized = stub.requests
			.map((r) => JSON.stringify(r.body))
			.join(' ');
		const sawAlpha = allSerialized.includes('race-alpha');
		const sawBeta = allSerialized.includes('race-beta');
		const health = readOtlpExporterHealth(dir);
		const accounted =
			(health?.dropped['spool_cap'] ?? 0) + (health?.dropped['spool_age'] ?? 0);
		expect(sawAlpha || accounted >= 1).toBe(true);
		expect(sawBeta).toBe(true);
		await stub.close();
	}, 30_000);
});
