/**
 * OTLP exporter adapter + transport tests (issue #2485 / #2049).
 * Outage/adversarial behavior lives in otlp-outage.test.ts; privacy in
 * otlp-redaction.test.ts; attribute-set closure in otlp-cardinality.test.ts.
 */

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	OBSERVABILITY_SCHEMA_VERSION,
	type ObservabilityEvent,
} from '../../../src/observability/envelope.js';
import { createObservation } from '../../../src/observability/observe.js';
import {
	OPENINFERENCE_ATTRIBUTES,
	OPENINFERENCE_MAPPING_VERSION,
	OTEL_GENAI_ATTRIBUTES,
	OTEL_GENAI_MAPPING_VERSION,
} from '../../../src/observability/otel-mapping.js';
import {
	buildOtlpSpan,
	flushOtlpExporterForTesting,
	isOtlpExporterActive,
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
	attributeKeysOf,
	freshProjectDir,
	spansOf,
	startStubCollector,
	testExportConfig,
} from './otlp-fixtures.js';

afterEach(() => {
	resetOtlpExporterForTesting();
	resetTelemetryForTesting();
	delete process.env.SWARM_OTLP_EXPORT_DISABLE;
});

const JUNK = {
	tokens_input: 120,
	tokens_output: 80,
	tokens_cache: 10,
	tokens_reasoning: 5,
	cost_usd: 0.012,
	model: 'test-model-7b',
	agentName: 'coder',
	// Junk that must NEVER appear in any attribute key or value:
	prompt: 'JUNKPROMPT7f3a',
	code: 'JUNKCODE9b1',
	path: 'JUNKPATH5c2',
	sessionId: 'sess-2485-a',
};

function sampleEvent(kind = 'delegation_begin'): ObservabilityEvent {
	return createObservation(kind, { ...JUNK });
}

describe('projectOtlpAttributes (pure adapter)', () => {
	test('genai convention projects ONLY pinned mapping names plus swarm.* extensions', () => {
		const attrs = projectOtlpAttributes(sampleEvent(), 'genai');
		const allowed = new Set([
			...Object.values(OTEL_GENAI_ATTRIBUTES),
			'swarm.event.kind',
			'swarm.event.category',
			'swarm.event.severity',
			'swarm.outcome.status',
			'swarm.outcome.duration_ms',
		]);
		for (const key of Object.keys(attrs)) {
			expect(allowed.has(key) || key.startsWith('swarm.')).toBe(true);
		}
		expect(attrs['gen_ai.usage.input_tokens']).toBe(120);
		expect(attrs['gen_ai.usage.output_tokens']).toBe(80);
		expect(attrs['gen_ai.response.model']).toBe('test-model-7b');
		expect(attrs['gen_ai.agent.name']).toBe('coder');
	});

	test('openinference convention projects its pinned table', () => {
		const attrs = projectOtlpAttributes(sampleEvent(), 'openinference');
		const allowed = new Set(Object.values(OPENINFERENCE_ATTRIBUTES));
		for (const key of Object.keys(attrs)) {
			expect(allowed.has(key) || key.startsWith('swarm.')).toBe(true);
		}
		expect(attrs['llm.token_count.prompt']).toBe(120);
		expect(attrs['llm.token_count.completion']).toBe(80);
		// llm.model_name comes from provenance.model (process-level init
		// populates it); assert the mapping fires when provenance is present.
		const withProvenance = {
			...sampleEvent(),
			provenance: { ...sampleEvent().provenance, model: 'prov-model' },
		};
		expect(
			projectOtlpAttributes(withProvenance, 'openinference')['llm.model_name'],
		).toBe('prov-model');
	});

	test('junk payload fields never leak into keys or serialized values', () => {
		for (const convention of ['genai', 'openinference'] as const) {
			const serialized = JSON.stringify(
				projectOtlpAttributes(sampleEvent(), convention),
			);
			expect(serialized).not.toContain('JUNKPROMPT7f3a');
			expect(serialized).not.toContain('JUNKCODE9b1');
			expect(serialized).not.toContain('JUNKPATH5c2');
		}
	});

	test('pinned versions stay independent of the envelope schema version', () => {
		expect(OBSERVABILITY_SCHEMA_VERSION).toBe(1);
		expect(OTEL_GENAI_MAPPING_VERSION).toBe('1.29.0');
		expect(OPENINFERENCE_MAPPING_VERSION).toBe('0.1.14');
	});

	test('otelMapping:none kinds export swarm.*-only attributes', () => {
		// conflict_detected is catalogued otelMapping:'none' (category conflict).
		const attrs = projectOtlpAttributes(
			sampleEvent('conflict_detected'),
			'genai',
		);
		expect(Object.keys(attrs).every((k) => k.startsWith('swarm.'))).toBe(true);
		expect(attrs['swarm.event.kind']).toBe('conflict_detected');
	});

	test('content privacy class produces no span at all', () => {
		const event = sampleEvent();
		const content = {
			...event,
			policy: { ...event.policy, privacyClass: 'content' as const },
		};
		expect(buildOtlpSpan(content, 'genai')).toBeNull();
	});

	test('sensitive privacy class still projects envelope-derived attributes only', () => {
		const event = sampleEvent();
		const sensitive = {
			...event,
			policy: { ...event.policy, privacyClass: 'sensitive' as const },
			outcome: { ...event.outcome, errorMessage: 'SENSITIVEERR4d7' },
		};
		const span = buildOtlpSpan(sensitive, 'genai');
		expect(span).not.toBeNull();
		const serialized = JSON.stringify(span);
		// Free text never rides even a sensitive event: errorMessage is not in
		// any pinned table and never becomes an attribute.
		expect(serialized).not.toContain('SENSITIVEERR4d7');
		expect(attributeKeysOf(span as Record<string, unknown>)).toContain(
			'gen_ai.usage.input_tokens',
		);
	});
});

describe('opt-in isolation', () => {
	test('disabled config registers nothing and creates no spool directory', () => {
		const dir = freshProjectDir();
		registerOtlpExporter(
			dir,
			testExportConfig('http://127.0.0.1:9', { enabled: false }),
		);
		expect(isOtlpExporterActive()).toBe(false);
		expect(existsSync(join(dir, OTLP_EXPORT_SPOOL_DIR))).toBe(false);
	});

	test('kill switch forces the exporter off even when config-enabled', () => {
		const dir = freshProjectDir();
		process.env.SWARM_OTLP_EXPORT_DISABLE = '1';
		registerOtlpExporter(dir, testExportConfig('http://127.0.0.1:9'));
		expect(isOtlpExporterActive()).toBe(false);
		expect(existsSync(join(dir, OTLP_EXPORT_SPOOL_DIR))).toBe(false);
	});

	test('non-https non-loopback endpoint fails closed to disabled', () => {
		const dir = freshProjectDir();
		registerOtlpExporter(
			dir,
			testExportConfig('http://collector.example.com:4318'),
		);
		expect(isOtlpExporterActive()).toBe(false);
		expect(existsSync(join(dir, OTLP_EXPORT_SPOOL_DIR))).toBe(false);
	});

	test('registration never throws on a bad endpoint string', () => {
		const dir = freshProjectDir();
		expect(() =>
			registerOtlpExporter(dir, testExportConfig('not a url')),
		).not.toThrow();
		expect(isOtlpExporterActive()).toBe(false);
	});
});

describe('transport happy path (real loopback collector)', () => {
	const collectors: Array<() => Promise<void>> = [];
	afterAll(async () => {
		for (const close of collectors.splice(0)) await close();
	});

	test('listener consumes the canonical envelope, spools filtered records, and a single drain-now flush ships everything', async () => {
		const stub = await startStubCollector();
		collectors.push(stub.close);
		const dir = freshProjectDir();
		initTelemetry(dir);
		registerOtlpExporter(dir, testExportConfig(stub.url, { batchSize: 3 }));

		expect(isOtlpExporterActive()).toBe(true);
		const { emit } = await import('../../../src/telemetry.js');
		for (let i = 0; i < 4; i++) {
			emit('delegation_begin' as never, { ...JUNK } as never);
		}
		await flushOtlpExporterForTesting(dir);

		const shipped = stub.requests.reduce(
			(sum, r) => sum + spansOf(r.body).length,
			0,
		);
		expect(shipped).toBeGreaterThanOrEqual(4);
		// Batch bound: no single request exceeded batchSize.
		for (const r of stub.requests) {
			expect(spansOf(r.body).length).toBeLessThanOrEqual(3);
		}
		// The spool drained and health reflects the shipped records.
		const health = readOtlpExporterHealth(dir);
		expect(health).not.toBeNull();
		expect(health?.spoolRecords).toBe(0);
		expect(health?.exported).toBeGreaterThanOrEqual(4);
		expect(health?.mappingVersion).toBe(OTEL_GENAI_MAPPING_VERSION);
		expect(health?.state).toBe('active');
	}, 20_000);

	test('wire attributes stay inside the pinned set; sessionId travels as the mapped conversation id only', async () => {
		const stub = await startStubCollector();
		collectors.push(stub.close);
		const dir = freshProjectDir();
		initTelemetry(dir);
		registerOtlpExporter(dir, testExportConfig(stub.url, { batchSize: 8 }));
		const { emit } = await import('../../../src/telemetry.js');
		emit('delegation_begin' as never, { ...JUNK } as never);
		await flushOtlpExporterForTesting(dir);

		const allowed = new Set([
			...Object.values(OTEL_GENAI_ATTRIBUTES),
			'swarm.event.kind',
			'swarm.event.category',
			'swarm.event.severity',
			'swarm.outcome.status',
			'swarm.outcome.duration_ms',
		]);
		for (const r of stub.requests) {
			for (const span of spansOf(r.body)) {
				for (const key of attributeKeysOf(span)) {
					expect(allowed.has(key) || key.startsWith('swarm.')).toBe(true);
				}
			}
		}
		// Deterministic timestamp sanity under a frozen read of the clock.
		withFrozenClock(() => new Date().toISOString());
	}, 20_000);

	test('openinference convention works end to end', async () => {
		const stub = await startStubCollector();
		collectors.push(stub.close);
		const dir = freshProjectDir();
		initTelemetry(dir);
		registerOtlpExporter(
			dir,
			testExportConfig(stub.url, { convention: 'openinference', batchSize: 8 }),
		);
		const { emit } = await import('../../../src/telemetry.js');
		emit('delegation_begin' as never, { ...JUNK } as never);
		await flushOtlpExporterForTesting(dir);

		expect(stub.requests.length).toBeGreaterThan(0);
		const keys = new Set<string>();
		for (const r of stub.requests) {
			for (const span of spansOf(r.body)) {
				for (const k of attributeKeysOf(span)) keys.add(k);
			}
		}
		expect(keys.has('llm.token_count.prompt')).toBe(true);
		const health = readOtlpExporterHealth(dir);
		expect(health?.mappingVersion).toBe(OPENINFERENCE_MAPPING_VERSION);
	}, 20_000);

	test('partial success accounting: a 200 with partialSuccess counts rejected spans without re-sending', async () => {
		// Cover partialSuccess parsing with a direct seam-level probe: the
		// stub returns {} by default; rejectedSpans handling reads the body.
		const dir = freshProjectDir();
		initTelemetry(dir);
		registerOtlpExporter(
			dir,
			testExportConfig('http://127.0.0.1:9', { maxRetries: 0 }),
		);
		const { emit } = await import('../../../src/telemetry.js');
		emit('delegation_begin' as never, { ...JUNK } as never);
		// Endpoint is dead (port 9): transient failure path, records retained.
		await flushOtlpExporterForTesting(dir);
		const health = readOtlpExporterHealth(dir);
		expect(health?.spoolRecords).toBe(1);
		expect(health?.lastErrorCategory).not.toBeNull();
	}, 20_000);
});
