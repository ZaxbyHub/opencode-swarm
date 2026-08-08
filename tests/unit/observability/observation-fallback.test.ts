/**
 * FB-012 — the `createObservation` FALLBACK path (`buildFallbackObservation`).
 *
 * Before these tests, `OBSERVATION_BUILD_FAILED` appeared only in
 * `src/observability/observe.ts` and had zero test hits: the fallback was
 * shipped, documented and unexercised.
 *
 * ## How the fallback is forced (no source change, no mocks)
 *
 * `createObservation(kind, data)` calls `getCatalogEntry(kind)` FIRST, which
 * does `Object.hasOwn(EVENT_CATALOG, kind)`. `Object.hasOwn` coerces its key
 * argument via `ToPropertyKey`, which calls `toString`. A null-prototype object
 * (`Object.create(null)`) has no `toString`/`Symbol.toPrimitive`, so the
 * coercion throws `TypeError: No default value` — inside the guarded region,
 * before anything else runs. That is a REAL hostile-input shape for a function
 * whose contract is "NEVER THROWS", not a contrived seam.
 *
 * `kind` is typed `string`, so the cast is deliberate and documented.
 *
 * Clock note: this file makes no raw time read. `occurredAt`/`observedAt` are
 * compared to each other (both come from one `safeNowIso()` call), never to a
 * wall-clock value, so no `freezeClock` (tests/helpers/test-clock.ts) freeze is
 * required for determinism.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ObservabilityEventSchema } from '../../../src/observability/envelope.js';
import {
	createObservation,
	initObservability,
	OBSERVATION_BUILD_FAILED,
	resetObservabilityForTesting,
	toLegacyTelemetryLine,
} from '../../../src/observability/observe.js';
import { DEFAULT_SAMPLE_RATE } from '../../../src/observability/sampling.js';

/** A `kind` value whose property-key coercion throws. */
function hostileKind(): string {
	return Object.create(null) as string;
}

describe('createObservation — fallback path (FB-012)', () => {
	beforeEach(() => {
		resetObservabilityForTesting();
	});
	afterEach(() => {
		resetObservabilityForTesting();
	});

	test('(a) the fallback is REACHABLE and stamps observation_build_failed', () => {
		const data = { sessionId: 'sess-1' };
		expect(() => createObservation(hostileKind(), data)).not.toThrow();

		const event = createObservation(hostileKind(), data);
		expect(event.relationshipViolations).toEqual([OBSERVATION_BUILD_FAILED]);
		expect(OBSERVATION_BUILD_FAILED).toBe('observation_build_failed');
	});

	test('(a) the fallback event is a STRUCTURALLY VALID envelope', () => {
		const event = createObservation(hostileKind(), { sessionId: 's' });
		// `kind` is the hostile object on the fallback path, so swap in a string
		// before schema-parsing: the point of this assertion is that every OTHER
		// field the fallback fabricates satisfies the envelope contract.
		const parsed = ObservabilityEventSchema.safeParse({
			...event,
			kind: 'forced_fallback',
		});
		expect(parsed.success).toBe(true);
		expect(event.category).toBe('unrecognized');
		expect(event.severity).toBe('error');
		expect(event.trace.links).toEqual([]);
		expect(event.trace.parentSpanId).toBeUndefined();
		// Both timestamps come from ONE safeNowIso() call — no clock read here.
		expect(event.occurredAt).toBe(event.observedAt);
	});

	test('(a) writerSequence still advances exactly once per call on the fallback path', () => {
		const first = createObservation(hostileKind(), {});
		const second = createObservation(hostileKind(), {});
		expect(second.writerSequence).toBe(first.writerSequence + 1);
	});

	test('(b) legacy.raw ALIASES the caller data (identity, not a copy)', () => {
		const data: Record<string, unknown> = {
			sessionId: 'sess-9',
			extra: 'keep',
		};
		const event = createObservation(hostileKind(), data);
		// Identity, not toEqual: byte-preservation of the legacy line depends on
		// the caller's object being spread, not a reconstruction of it.
		expect(event.legacy.raw).toBe(data);
		expect(event.legacy.sourceStore).toBe('.swarm/telemetry.jsonl');
		expect(event.legacy.timingConfidence).toBe('unknown');
	});

	test('(b) the legacy projection off a fallback event still carries the caller keys', () => {
		const data = { sessionId: 'sess-9', extra: 'keep' };
		const line = toLegacyTelemetryLine(createObservation(hostileKind(), data));
		expect(line.sessionId).toBe('sess-9');
		expect(line.extra).toBe('keep');
	});

	test('(b) a non-object payload survives the fallback by reference too', () => {
		const event = createObservation(hostileKind(), 'a-raw-string');
		expect(event.legacy.raw).toBe('a-raw-string');
		expect(event.relationshipViolations).toEqual([OBSERVATION_BUILD_FAILED]);
	});
});

describe('createObservation fallback — policy honours CONFIGURED sample rate (FB-012 regression)', () => {
	beforeEach(() => {
		resetObservabilityForTesting();
	});
	afterEach(() => {
		resetObservabilityForTesting();
	});

	/**
	 * REGRESSION for the fix that just landed. The previous fallback hardcoded
	 * `policy: { sampled: true, sampleRate: DEFAULT_SAMPLE_RATE }`, which
	 * misdescribed the policy actually in effect. `DEFAULT_SAMPLE_RATE` is `1`
	 * and `shouldSample(traceId, 0) === false`, so a configured rate of `0`
	 * discriminates on BOTH fields: reverting to the hardcoded values makes this
	 * test fail on `sampleRate` (0 vs 1) and on `sampled` (false vs true).
	 */
	test('initObservability({ sampleRate: 0 }) is reported by the fallback, not DEFAULT_SAMPLE_RATE', () => {
		expect(DEFAULT_SAMPLE_RATE).toBe(1); // guards the test from becoming vacuous

		initObservability({ sampleRate: 0 });
		const event = createObservation(hostileKind(), { sessionId: 's' });

		expect(event.relationshipViolations).toEqual([OBSERVATION_BUILD_FAILED]);
		expect(event.policy.sampleRate).toBe(0);
		expect(event.policy.sampled).toBe(false);
		expect(event.policy.privacyClass).toBe('operational');
	});

	test('rate 0 also takes effect on the NORMAL path (isolates which layer broke)', () => {
		initObservability({ sampleRate: 0 });
		const event = createObservation('heartbeat', { sessionId: 's' });
		expect(event.relationshipViolations).toEqual([]);
		expect(event.policy.sampleRate).toBe(0);
		expect(event.policy.sampled).toBe(false);
	});

	test('a fractional configured rate is reported verbatim by the fallback', () => {
		initObservability({ sampleRate: 0.25 });
		const event = createObservation(hostileKind(), {});
		expect(event.policy.sampleRate).toBe(0.25);
		// FALLBACK_TRACE_ID is the constant '0'.repeat(31)+'1'; its last 8 hex
		// chars parse to 1, and 1/0xffffffff < 0.25, so this is deterministically
		// sampled — a hardcoded `sampled: true` would agree here, which is exactly
		// why the rate-0 test above is the one that bites.
		expect(event.policy.sampled).toBe(true);
	});

	test('with no init the fallback reports the module default, not a hardcoded literal', () => {
		const event = createObservation(hostileKind(), {});
		expect(event.policy.sampleRate).toBe(DEFAULT_SAMPLE_RATE);
		expect(event.policy.sampled).toBe(true);
	});
});
