/**
 * AC1 negative — `validateEventRelationships` correctly rejects malformed
 * events with the right violation codes, and NEVER throws (issue #2029).
 */
import { describe, expect, test } from 'bun:test';
import { getCatalogEntry } from '../../../src/observability/catalog.js';
import type { ObservabilityEvent } from '../../../src/observability/envelope.js';
import { OBSERVABILITY_SCHEMA_VERSION } from '../../../src/observability/envelope.js';
import {
	RELATIONSHIP_VIOLATION_CODES,
	validateEventRelationships,
} from '../../../src/observability/relationships.js';

const VALID_TRACE_ID = 'a'.repeat(32);
const VALID_SPAN_ID = 'b'.repeat(16);

/** Build a structurally-valid baseline event for a known catalogued kind. */
function baseEvent(
	overrides: Partial<ObservabilityEvent> = {},
): ObservabilityEvent {
	return {
		schemaVersion: OBSERVABILITY_SCHEMA_VERSION,
		eventId: 'evt-1',
		kind: 'heartbeat',
		category: 'lifecycle',
		severity: 'debug',
		occurredAt: '2026-01-15T12:00:00.000Z',
		observedAt: '2026-01-15T12:00:00.000Z',
		writerSequence: 1,
		trace: { traceId: VALID_TRACE_ID, spanId: VALID_SPAN_ID, links: [] },
		workflow: { hostSessionId: 'sess-1' },
		lineage: {},
		provenance: {},
		outcome: {},
		policy: { sampled: true, sampleRate: 1, privacyClass: 'pseudonymous' },
		legacy: {
			sourceStore: '.swarm/telemetry.jsonl',
			sourceSchemaVersion: null,
			timingConfidence: 'writer-clock',
			unknown: [],
			extra: {},
			raw: {},
		},
		relationshipViolations: [],
		...overrides,
	};
}

describe('validateEventRelationships — AC1 negative', () => {
	test('unknown kind is rejected with unknown_kind:<kind>', () => {
		const event = baseEvent({ kind: 'totally_made_up_kind' });
		const verdict = validateEventRelationships(event);
		expect(verdict.ok).toBe(false);
		if (verdict.ok) throw new Error('unreachable');
		expect(verdict.violations).toContain(
			`${RELATIONSHIP_VIOLATION_CODES.unknownKind}:totally_made_up_kind`,
		);
	});

	test('missing required workflow id is rejected with required_workflow_id_missing:<id>', () => {
		// heartbeat requires hostSessionId (catalog.ts REQUIRE_SESSION).
		const entry = getCatalogEntry('heartbeat');
		expect(entry?.requiredWorkflowIds).toContain('hostSessionId');

		const event = baseEvent({ kind: 'heartbeat', workflow: {} });
		const verdict = validateEventRelationships(event);
		expect(verdict.ok).toBe(false);
		if (verdict.ok) throw new Error('unreachable');
		expect(verdict.violations).toContain(
			`${RELATIONSHIP_VIOLATION_CODES.requiredWorkflowIdMissing}:hostSessionId`,
		);
	});

	test('present forbidden workflow id is rejected with forbidden_workflow_id_present:<id>', () => {
		// gate_parse_error forbids hostSessionId (catalog.ts FORBID_SESSION).
		const entry = getCatalogEntry('gate_parse_error');
		expect(entry?.forbiddenWorkflowIds).toContain('hostSessionId');

		const event = baseEvent({
			kind: 'gate_parse_error',
			workflow: { taskId: '1.1', hostSessionId: 'manufactured-sess' },
		});
		const verdict = validateEventRelationships(event);
		expect(verdict.ok).toBe(false);
		if (verdict.ok) throw new Error('unreachable');
		expect(verdict.violations).toContain(
			`${RELATIONSHIP_VIOLATION_CODES.forbiddenWorkflowIdPresent}:hostSessionId`,
		);
	});

	test('parentSpanId present on an entry with requiresParent:false is rejected', () => {
		const entry = getCatalogEntry('heartbeat');
		expect(entry?.requiresParent).toBe(false);

		const event = baseEvent({
			kind: 'heartbeat',
			trace: {
				traceId: VALID_TRACE_ID,
				spanId: VALID_SPAN_ID,
				parentSpanId: 'c'.repeat(16),
				links: [],
			},
		});
		const verdict = validateEventRelationships(event);
		expect(verdict.ok).toBe(false);
		if (verdict.ok) throw new Error('unreachable');
		expect(verdict.violations).toContain(
			RELATIONSHIP_VIOLATION_CODES.parentSpanNotAllowed,
		);
	});

	test('links present on an entry with allowsLinks:false is rejected', () => {
		// heartbeat has allowsLinks:false (catalog.ts).
		const entry = getCatalogEntry('heartbeat');
		expect(entry?.allowsLinks).toBe(false);

		const event = baseEvent({
			kind: 'heartbeat',
			trace: {
				traceId: VALID_TRACE_ID,
				spanId: VALID_SPAN_ID,
				links: [
					{
						traceId: VALID_TRACE_ID,
						spanId: VALID_SPAN_ID,
						kind: 'resume',
					},
				],
			},
		});
		const verdict = validateEventRelationships(event);
		expect(verdict.ok).toBe(false);
		if (verdict.ok) throw new Error('unreachable');
		expect(verdict.violations).toContain(
			RELATIONSHIP_VIOLATION_CODES.linksNotAllowed,
		);
	});

	test('malformed link traceId is rejected with malformed_link_trace_id:<index>', () => {
		const event = baseEvent({
			kind: 'gate_passed',
			workflow: { hostSessionId: 'sess-1', taskId: '1.1' },
			trace: {
				traceId: VALID_TRACE_ID,
				spanId: VALID_SPAN_ID,
				links: [{ traceId: 'not-hex!', spanId: VALID_SPAN_ID, kind: 'resume' }],
			},
		});
		const verdict = validateEventRelationships(event);
		expect(verdict.ok).toBe(false);
		if (verdict.ok) throw new Error('unreachable');
		expect(verdict.violations).toContain(
			`${RELATIONSHIP_VIOLATION_CODES.malformedLinkTraceId}:0`,
		);
	});

	test('malformed link spanId is rejected with malformed_link_span_id:<index>', () => {
		const event = baseEvent({
			kind: 'gate_passed',
			workflow: { hostSessionId: 'sess-1', taskId: '1.1' },
			trace: {
				traceId: VALID_TRACE_ID,
				spanId: VALID_SPAN_ID,
				links: [{ traceId: VALID_TRACE_ID, spanId: 'zz', kind: 'resume' }],
			},
		});
		const verdict = validateEventRelationships(event);
		expect(verdict.ok).toBe(false);
		if (verdict.ok) throw new Error('unreachable');
		expect(verdict.violations).toContain(
			`${RELATIONSHIP_VIOLATION_CODES.malformedLinkSpanId}:0`,
		);
	});

	test('wrong-case (uppercase hex) link ids are also malformed (pattern is lowercase-only)', () => {
		const event = baseEvent({
			kind: 'gate_passed',
			workflow: { hostSessionId: 'sess-1', taskId: '1.1' },
			trace: {
				traceId: VALID_TRACE_ID,
				spanId: VALID_SPAN_ID,
				links: [
					{
						traceId: VALID_TRACE_ID.toUpperCase(),
						spanId: VALID_SPAN_ID,
						kind: 'resume',
					},
				],
			},
		});
		const verdict = validateEventRelationships(event);
		expect(verdict.ok).toBe(false);
		if (verdict.ok) throw new Error('unreachable');
		expect(verdict.violations).toContain(
			`${RELATIONSHIP_VIOLATION_CODES.malformedLinkTraceId}:0`,
		);
	});

	test('never throws — even for a maximally hostile event object', () => {
		const hostile = {
			kind: 'heartbeat',
			workflow: null,
			trace: { links: 'not-an-array' },
		} as unknown as ObservabilityEvent;

		expect(() => validateEventRelationships(hostile)).not.toThrow();
		const verdict = validateEventRelationships(hostile);
		// Malformed input still yields SOME verdict, never a throw.
		expect(typeof verdict.ok).toBe('boolean');
	});

	test('never throws — event.trace itself is undefined', () => {
		const hostile = {
			kind: 'heartbeat',
			workflow: {},
		} as unknown as ObservabilityEvent;

		expect(() => validateEventRelationships(hostile)).not.toThrow();
	});

	test('never throws — a link entry that is a throwing getter Proxy', () => {
		const throwingLink = new Proxy(
			{},
			{
				get() {
					throw new Error('boom');
				},
			},
		);
		const event = baseEvent({
			kind: 'gate_passed',
			workflow: { hostSessionId: 'sess-1', taskId: '1.1' },
			trace: {
				traceId: VALID_TRACE_ID,
				spanId: VALID_SPAN_ID,
				links: [throwingLink as never],
			},
		});
		expect(() => validateEventRelationships(event)).not.toThrow();
		const verdict = validateEventRelationships(event);
		expect(verdict.ok).toBe(false);
	});
});
