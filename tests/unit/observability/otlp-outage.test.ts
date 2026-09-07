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
import { withFrozenClock } from '../../helpers/test-clock.js';
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
		// Clock read for the cooldown assertion stays deterministic.
		withFrozenClock(() => Date.now());

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
		// Diagnostics stay secret-safe: category only, never header values or
		// endpoint strings. The whole persisted state is checked.
		const stateText = readFileSync(
			join(dir, OTLP_EXPORT_SPOOL_DIR, 'state.json'),
			'utf-8',
		);
		expect(stateText).not.toContain('SECRETTOKEN99');
		await stub.close();
	}, 20_000);
});
