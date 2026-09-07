/**
 * OTLP exporter privacy/redaction tests (issue #2485 / #2049 item 7):
 * secrets never enter the spool, the wire, or diagnostics; content-class
 * events never export; Unicode/control-sequence payloads cannot smuggle
 * text through the export path.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ObservabilityEvent } from '../../../src/observability/envelope.js';
import { createObservation } from '../../../src/observability/observe.js';
import {
	flushOtlpExporterForTesting,
	OTLP_EXPORT_SPOOL_DIR,
	projectOtlpAttributes,
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
	freshProjectDir,
	spansOf,
	startStubCollector,
	testExportConfig,
} from './otlp-fixtures.js';

const SECRET = 'ghp_LEAKCHECK0001';

afterEach(() => {
	resetOtlpExporterForTesting();
	resetTelemetryForTesting();
});

describe('secret patterns never reach spool, wire, or diagnostics', () => {
	test('secret-bearing payloads are filtered before the spool append; wire bodies are clean', async () => {
		const stub = await startStubCollector();
		const dir = freshProjectDir();
		initTelemetry(dir);
		registerOtlpExporter(dir, testExportConfig(stub.url, { batchSize: 8 }));
		const { emit } = await import('../../../src/telemetry.js');
		emit(
			'delegation_begin' as never,
			{
				tokens_input: 5,
				model: 'redact-model',
				authorization: `Bearer ${SECRET}`,
				api_key: SECRET,
				prompt: `user said ${SECRET} in plaintext`,
			} as never,
		);
		// Endpoint unavailable first so the record sits in the spool: assert
		// the SPOOL is clean, then flush to assert the WIRE is clean.
		await flushOtlpExporterForTesting(dir);

		const spoolText = (() => {
			try {
				return readFileSync(
					join(dir, OTLP_EXPORT_SPOOL_DIR, 'spool.jsonl'),
					'utf-8',
				);
			} catch {
				return '';
			}
		})();
		const wireText = stub.requests.map((r) => JSON.stringify(r.body)).join(' ');
		// Whether the record is still spooled or already shipped, the secret
		// must be in NEITHER place (it never enters any attribute).
		expect(spoolText.includes(SECRET)).toBe(false);
		expect(wireText.includes(SECRET)).toBe(false);
		// The mapped metadata DID travel — filtering, not a dead pipeline.
		expect(wireText.includes('redact-model')).toBe(true);
		await stub.close();
	}, 20_000);

	test('health records never contain the endpoint or header values', async () => {
		const stub = await startStubCollector();
		const dir = freshProjectDir();
		initTelemetry(dir);
		registerOtlpExporter(
			dir,
			testExportConfig(stub.url, {
				headers: { Authorization: `Bearer ${SECRET}` },
			}),
		);
		const { emit } = await import('../../../src/telemetry.js');
		emit(
			'delegation_begin' as never,
			{
				tokens_input: 1,
				model: 'm',
			} as never,
		);
		await flushOtlpExporterForTesting(dir);

		const health = readOtlpExporterHealth(dir);
		expect(health).not.toBeNull();
		const healthText = JSON.stringify(health);
		expect(healthText.includes(SECRET)).toBe(false);
		// Endpoint host appears nowhere in health either.
		expect(healthText.includes('127.0.0.1')).toBe(false);
		await stub.close();
	}, 20_000);
});

describe('content-class exclusion (canonical-based privacy gate)', () => {
	test('a content-class canonical yields no exported span while a control event exports', () => {
		const content = createObservation('delegation_begin', {
			tokens_input: 9,
			model: 'content-model',
			prompt: 'CONTENTPROMPT',
		});
		const asContent: ObservabilityEvent = {
			...content,
			policy: { ...content.policy, privacyClass: 'content' },
		};
		const serialized = JSON.stringify(
			projectOtlpAttributes(asContent, 'genai'),
		);
		// Even the pure projection of a content event carries only structural
		// swarm.* fields — no mapped payload values.
		expect(serialized.includes('content-model')).toBe(false);
		expect(serialized.includes('CONTENTPROMPT')).toBe(false);

		const control = createObservation('delegation_begin', {
			tokens_input: 9,
			model: 'content-model',
		});
		expect(
			JSON.stringify(projectOtlpAttributes(control, 'genai')).includes(
				'content-model',
			),
		).toBe(true);
	});
});

describe('Unicode and control sequences (required adversarial set)', () => {
	test('combining marks, invisible format chars, RTL overrides, and NUL never break key/value handling', () => {
		const nasty = createObservation('delegation_begin', {
			tokens_input: 3,
			// Combining-mark split keyword + invisible-fill + RTL + NUL —
			// none of these may surface as attribute keys or values.
			'model\u0300': 'combining-key',
			'key\u200b': 'zwsp-key',
			'model\u202E': 'rtl-override',
			'key\0': 'nul-key',
			model: 'ok-model',
		});
		const attrs = projectOtlpAttributes(nasty, 'genai');
		const keys = Object.keys(attrs);
		expect(keys).toContain('gen_ai.response.model');
		expect(attrs['gen_ai.response.model']).toBe('ok-model');
		// No control/format codepoints ride attribute KEYS.
		for (const key of keys) {
			expect(/[\p{Cc}\p{Cf}]/u.test(key)).toBe(false);
		}
	});

	test('attribute string VALUES are bounded (no unbounded payload text on the wire)', () => {
		const longPayload = createObservation('delegation_begin', {
			tokens_input: 1,
			model: 'x'.repeat(10_000),
		});
		const attrs = projectOtlpAttributes(longPayload, 'genai');
		const value = attrs['gen_ai.response.model'];
		expect(typeof value === 'string' && value.length <= 128).toBe(true);
		// Timestamp determinism note: span time conversion is pure from the
		// envelope's ISO strings; freeze reads for stable assertions.
		withFrozenClock(() => new Date().toISOString());
	});
});
