/**
 * FB-010 — NEGATIVE tests for `ObservabilityEventSchema`.
 *
 * Before this file every `safeParse` assertion in the repo asserted
 * `success: true`; there were ZERO `success: false` assertions, so the schema
 * could have been replaced by `z.any()` without a single test noticing.
 *
 * ## WHICH LAYER ENFORCES WHAT (read this before adding assertions here)
 *
 * Two independent layers, and conflating them is the exact mistake AC1's
 * wording invites ("invalid parent/link combinations FAIL schema validation"):
 *
 * | Concern                                   | Enforced by                     |
 * |-------------------------------------------|---------------------------------|
 * | SHAPE: field presence, JS type, enum member | `ObservabilityEventSchema` (zod) |
 * | FORMAT: 32/16-lowercase-hex trace/span ids  | `validateEventRelationships`     |
 * | RELATIONSHIPS: parent allowed/required, links allowed, required/forbidden workflow ids | `validateEventRelationships` |
 *
 * The schema declares `traceId`/`spanId`/`parentSpanId` as bare `z.string()`
 * with no `.regex()`, and `z.object()` STRIPS unknown keys rather than
 * rejecting them. So a malformed trace id, an unknown extra key, and an invalid
 * parent/link combination ALL parse successfully. `relationships.ts` is the only
 * thing standing between those and a corrupt stream. The
 * "layer boundary" describe block below asserts that split executably, so a
 * future reader cannot conclude the schema catches relationship defects.
 */
import { describe, expect, test } from 'bun:test';
import {
	OBSERVABILITY_SCHEMA_VERSION,
	ObservabilityEventSchema,
} from '../../../src/observability/envelope.js';
import {
	RELATIONSHIP_VIOLATION_CODES,
	validateEventRelationships,
} from '../../../src/observability/relationships.js';

const VALID_TRACE_ID = 'a'.repeat(32);
const VALID_SPAN_ID = 'b'.repeat(16);

/** A minimal envelope that PARSES — every negative case below mutates one field. */
function validEnvelope(): Record<string, unknown> {
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
	};
}

/** Delete a top-level key and return the mutated envelope. */
function without(key: string): Record<string, unknown> {
	const envelope = validEnvelope();
	delete envelope[key];
	return envelope;
}

/** Overwrite a top-level key and return the mutated envelope. */
function withField(key: string, value: unknown): Record<string, unknown> {
	return { ...validEnvelope(), [key]: value };
}

describe('ObservabilityEventSchema — the baseline actually parses', () => {
	test('the unmutated fixture is accepted (otherwise every negative below is vacuous)', () => {
		const result = ObservabilityEventSchema.safeParse(validEnvelope());
		expect(result.success).toBe(true);
	});
});

describe('ObservabilityEventSchema — SHAPE rejections (FB-010)', () => {
	const missingRequired: readonly string[] = [
		'schemaVersion',
		'eventId',
		'kind',
		'category',
		'severity',
		'occurredAt',
		'observedAt',
		'writerSequence',
		'trace',
		'policy',
		'legacy',
		'relationshipViolations',
	];

	for (const key of missingRequired) {
		test(`rejects an envelope missing required field "${key}"`, () => {
			const result = ObservabilityEventSchema.safeParse(without(key));
			expect(result.success).toBe(false);
			if (result.success) throw new Error('unreachable');
			// The issue must name the field, not just "invalid".
			expect(result.error.issues.some((i) => i.path[0] === key)).toBe(true);
		});
	}

	const wrongTypes: ReadonlyArray<readonly [string, unknown]> = [
		['schemaVersion', '1'],
		['eventId', 42],
		['kind', null],
		['writerSequence', 'not-a-number'],
		['occurredAt', 1737000000000],
		['relationshipViolations', 'unknown_kind'],
		['relationshipViolations', [42]],
		['trace', 'not-an-object'],
		['workflow', []],
	];

	for (const [key, value] of wrongTypes) {
		test(`rejects wrong type for "${key}": ${JSON.stringify(value)}`, () => {
			const result = ObservabilityEventSchema.safeParse(withField(key, value));
			expect(result.success).toBe(false);
		});
	}

	test('rejects a category outside the enum', () => {
		const result = ObservabilityEventSchema.safeParse(
			withField('category', 'definitely_not_a_category'),
		);
		expect(result.success).toBe(false);
		if (result.success) throw new Error('unreachable');
		expect(result.error.issues.some((i) => i.path[0] === 'category')).toBe(
			true,
		);
	});

	test('rejects a severity outside the enum', () => {
		expect(
			ObservabilityEventSchema.safeParse(withField('severity', 'catastrophic'))
				.success,
		).toBe(false);
	});

	test('rejects a policy.privacyClass outside the enum', () => {
		const envelope = validEnvelope();
		envelope.policy = { sampled: true, sampleRate: 1, privacyClass: 'secret' };
		expect(ObservabilityEventSchema.safeParse(envelope).success).toBe(false);
	});

	test('rejects a legacy.timingConfidence outside the enum', () => {
		const envelope = validEnvelope();
		envelope.legacy = {
			...(validEnvelope().legacy as Record<string, unknown>),
			timingConfidence: 'vibes',
		};
		expect(ObservabilityEventSchema.safeParse(envelope).success).toBe(false);
	});

	test('rejects a non-numeric, non-null legacy.sourceSchemaVersion', () => {
		const envelope = validEnvelope();
		envelope.legacy = {
			...(validEnvelope().legacy as Record<string, unknown>),
			sourceSchemaVersion: 'v1',
		};
		expect(ObservabilityEventSchema.safeParse(envelope).success).toBe(false);
	});

	test('rejects a span link whose kind is not one of the five typed reasons', () => {
		const envelope = validEnvelope();
		envelope.trace = {
			traceId: VALID_TRACE_ID,
			spanId: VALID_SPAN_ID,
			links: [
				{ traceId: VALID_TRACE_ID, spanId: VALID_SPAN_ID, kind: 'sideways' },
			],
		};
		expect(ObservabilityEventSchema.safeParse(envelope).success).toBe(false);
	});

	test('rejects trace.links that is an object rather than an array', () => {
		const envelope = validEnvelope();
		envelope.trace = {
			traceId: VALID_TRACE_ID,
			spanId: VALID_SPAN_ID,
			links: {},
		};
		expect(ObservabilityEventSchema.safeParse(envelope).success).toBe(false);
	});

	test('rejects non-object envelopes outright', () => {
		for (const value of [null, undefined, 'event', 42, []]) {
			expect(ObservabilityEventSchema.safeParse(value).success).toBe(false);
		}
	});
});

describe('layer boundary — zod validates SHAPE, validateEventRelationships validates RELATIONSHIPS (FB-010)', () => {
	test('a MALFORMED trace/link id PASSES zod and is caught only by validateEventRelationships', () => {
		const envelope = validEnvelope();
		envelope.kind = 'gate_passed';
		envelope.workflow = { hostSessionId: 'sess-1', taskId: '1.1' };
		envelope.trace = {
			traceId: 'not-hex-at-all',
			spanId: 'nope',
			links: [{ traceId: 'zzz', spanId: 'zzz', kind: 'resume' }],
		};

		// Layer 1 (zod): traceId/spanId are bare z.string(), so this is well-SHAPED.
		expect(ObservabilityEventSchema.safeParse(envelope).success).toBe(true);

		// Layer 2 (relationships): the format defect is caught here, and only here.
		const verdict = validateEventRelationships(
			envelope as unknown as Parameters<typeof validateEventRelationships>[0],
		);
		expect(verdict.ok).toBe(false);
		if (verdict.ok) throw new Error('unreachable');
		expect(verdict.violations).toContain(
			`${RELATIONSHIP_VIOLATION_CODES.malformedLinkTraceId}:0`,
		);
		expect(verdict.violations).toContain(
			`${RELATIONSHIP_VIOLATION_CODES.malformedLinkSpanId}:0`,
		);
	});

	test('an INVALID parent/link combination PASSES zod — AC1 is enforced by relationships.ts, not the schema', () => {
		const envelope = validEnvelope();
		// heartbeat: requiresParent:false, allowsLinks:false.
		envelope.trace = {
			traceId: VALID_TRACE_ID,
			spanId: VALID_SPAN_ID,
			parentSpanId: 'c'.repeat(16),
			links: [{ traceId: VALID_TRACE_ID, spanId: VALID_SPAN_ID, kind: 'lane' }],
		};

		expect(ObservabilityEventSchema.safeParse(envelope).success).toBe(true);

		const verdict = validateEventRelationships(
			envelope as unknown as Parameters<typeof validateEventRelationships>[0],
		);
		expect(verdict.ok).toBe(false);
		if (verdict.ok) throw new Error('unreachable');
		expect(verdict.violations).toContain(
			RELATIONSHIP_VIOLATION_CODES.parentSpanNotAllowed,
		);
		expect(verdict.violations).toContain(
			RELATIONSHIP_VIOLATION_CODES.linksNotAllowed,
		);
	});

	test('an UNKNOWN event kind PASSES zod (kind is z.string()) and is classified by relationships.ts', () => {
		const envelope = withField('kind', 'not_in_the_catalog');
		expect(ObservabilityEventSchema.safeParse(envelope).success).toBe(true);

		const verdict = validateEventRelationships(
			envelope as unknown as Parameters<typeof validateEventRelationships>[0],
		);
		expect(verdict.ok).toBe(false);
		if (verdict.ok) throw new Error('unreachable');
		expect(verdict.violations).toContain(
			`${RELATIONSHIP_VIOLATION_CODES.unknownKind}:not_in_the_catalog`,
		);
	});

	test('unknown extra keys are STRIPPED by zod, not rejected (documented, non-obvious)', () => {
		const envelope = { ...validEnvelope(), totallyUnexpected: 'value' };
		const result = ObservabilityEventSchema.safeParse(envelope);
		expect(result.success).toBe(true);
		if (!result.success) throw new Error('unreachable');
		expect('totallyUnexpected' in result.data).toBe(false);
	});
});
