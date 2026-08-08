/**
 * AC1 negative — `validateEventRelationships` correctly rejects malformed
 * events with the right violation codes, and NEVER throws (issue #2029).
 */
import { describe, expect, test } from 'bun:test';
import {
	CATALOG_KINDS,
	getCatalogEntry,
} from '../../../src/observability/catalog.js';
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

	test('malformed parentSpanId is rejected with malformed_parent_span_id (FB-007)', () => {
		// `gate_passed` allows links and does not require a parent; the ONLY
		// violation the malformed value must produce is the format one — asserted
		// by value from the exported codes table, never as a bare string literal.
		const malformed = [
			'ZZZ', // non-hex
			'b'.repeat(15), // one char short
			'b'.repeat(17), // one char long
			'B'.repeat(16), // uppercase hex — the pattern is lowercase-only
			'', // empty string is NOT "absent"
			'b'.repeat(15) + 'g', // right length, one invalid nibble
		];
		for (const parentSpanId of malformed) {
			const event = baseEvent({
				kind: 'gate_passed',
				workflow: { hostSessionId: 'sess-1', taskId: '1.1' },
				trace: {
					traceId: VALID_TRACE_ID,
					spanId: VALID_SPAN_ID,
					parentSpanId,
					links: [],
				},
			});
			const verdict = validateEventRelationships(event);
			expect(verdict.ok).toBe(false);
			if (verdict.ok) throw new Error('unreachable');
			expect(verdict.violations).toContain(
				RELATIONSHIP_VIOLATION_CODES.malformedParentSpanId,
			);
		}
	});

	test('a well-formed 16-lowercase-hex parentSpanId does NOT yield malformed_parent_span_id (FB-007)', () => {
		// `gate_passed` has requiresParent:false, so a present parent still trips
		// parent_span_not_allowed — that is a DIFFERENT code. This asserts the
		// format branch specifically does not fire, which is what would break if
		// the regex were widened or the branch made unconditional.
		const event = baseEvent({
			kind: 'gate_passed',
			workflow: { hostSessionId: 'sess-1', taskId: '1.1' },
			trace: {
				traceId: VALID_TRACE_ID,
				spanId: VALID_SPAN_ID,
				parentSpanId: '0123456789abcdef',
				links: [],
			},
		});
		const verdict = validateEventRelationships(event);
		expect(verdict.ok).toBe(false);
		if (verdict.ok) throw new Error('unreachable');
		expect(verdict.violations).not.toContain(
			RELATIONSHIP_VIOLATION_CODES.malformedParentSpanId,
		);
		expect(verdict.violations).toEqual([
			RELATIONSHIP_VIOLATION_CODES.parentSpanNotAllowed,
		]);
	});

	test('a parentSpanId whose string conversion THROWS returns relationship_validation_failed and never throws (FB-007/FB-016)', () => {
		// `Object.create(null)` has no prototype, so `String(value)` throws
		// "Cannot convert object to primitive value" inside the format check at
		// relationships.ts. The catch must convert that into a verdict.
		const hostileParent = Object.create(null) as string;
		const event = baseEvent({
			kind: 'heartbeat',
			trace: {
				traceId: VALID_TRACE_ID,
				spanId: VALID_SPAN_ID,
				parentSpanId: hostileParent,
				links: [],
			},
		});

		expect(() => validateEventRelationships(event)).not.toThrow();
		const verdict = validateEventRelationships(event);
		expect(verdict.ok).toBe(false);
		if (verdict.ok) throw new Error('unreachable');
		// EXACT equality, not toContain: `parent_span_not_allowed` was already
		// pushed before the throw, and the catch RETURNS a fresh array rather than
		// appending. This proves the catch replaces the accumulated list.
		expect(verdict.violations).toEqual([
			RELATIONSHIP_VIOLATION_CODES.validationFailed,
		]);
		expect(RELATIONSHIP_VIOLATION_CODES.validationFailed).toBe(
			'relationship_validation_failed',
		);
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

describe('RELATIONSHIP_VIOLATION_CODES — asserted by value (FB-016)', () => {
	test('every exported code has its documented wire value', () => {
		// These strings are the join key a downstream consumer groups on and must
		// not be renamed once emitted (relationships.ts docstring). Pinning them
		// here makes a rename a test failure rather than a silent stream break.
		expect(RELATIONSHIP_VIOLATION_CODES).toEqual({
			unknownKind: 'unknown_kind',
			requiredWorkflowIdMissing: 'required_workflow_id_missing',
			forbiddenWorkflowIdPresent: 'forbidden_workflow_id_present',
			parentSpanNotAllowed: 'parent_span_not_allowed',
			parentSpanMissing: 'parent_span_missing',
			malformedParentSpanId: 'malformed_parent_span_id',
			linksNotAllowed: 'links_not_allowed',
			malformedLinkTraceId: 'malformed_link_trace_id',
			malformedLinkSpanId: 'malformed_link_span_id',
			validationFailed: 'relationship_validation_failed',
		});
	});

	/**
	 * `parent_span_missing` is UNREACHABLE BY CONSTRUCTION today, and this is a
	 * live tripwire for that fact rather than a comment that can rot.
	 *
	 * Reason, verified in source: the branch at relationships.ts requires
	 * `entry.requiresParent === true`, but `defineEntry` (catalog.ts) defaults
	 * `requiresParent` to `false` and NO `CATALOG_SOURCE` entry overrides it.
	 * `EVENT_CATALOG` and each entry are `Object.freeze`d, so a test cannot
	 * synthesize a `requiresParent: true` entry, and `validateEventRelationships`
	 * imports `getCatalogEntry` as a direct binding (no `_internals` seam), so it
	 * cannot be intercepted without a new `mock.module` target.
	 *
	 * The day someone sets `requiresParent: true` on any kind, THIS test fails —
	 * which is the signal to add real coverage for the branch it unlocks.
	 */
	test('no catalogued kind sets requiresParent:true, so parent_span_missing is unreachable', () => {
		const withParent = CATALOG_KINDS.filter(
			(kind) => getCatalogEntry(kind)?.requiresParent === true,
		);
		expect(withParent).toEqual([]);
		expect(RELATIONSHIP_VIOLATION_CODES.parentSpanMissing).toBe(
			'parent_span_missing',
		);
	});

	test('a kind with requiresParent:false and NO parent span yields no parent-related violation', () => {
		// The complement of the unreachable branch: the currently-real world.
		const event = baseEvent({ kind: 'heartbeat' });
		const verdict = validateEventRelationships(event);
		expect(verdict).toEqual({ ok: true });
	});
});
