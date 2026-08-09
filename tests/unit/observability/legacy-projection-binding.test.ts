/**
 * Direct binding test for `toLegacyTelemetryLine` (issue #2029, reviewer C1).
 *
 * ## Why this file exists
 *
 * `tests/unit/telemetry/emit-line-parity.test.ts` freezes the clock via
 * `freezeClock({ isoNow })`, which spies `Date.prototype.toISOString`
 * GLOBALLY (see `tests/helpers/test-clock.ts`). That means if
 * `toLegacyTelemetryLine` were mutated to compute
 * `timestamp: new Date().toISOString()` instead of reading
 * `timestamp: event.observedAt`, the frozen clock would make BOTH paths
 * produce the identical string — the parity test would keep passing and the
 * mutation would go undetected. That is the single most load-bearing claim of
 * this PR (`src/observability/observe.ts` doc comment: "a real, load-bearing
 * data dependency on the canonical event, which is why this composition is
 * not the identity function on the emit path") and it currently has no test
 * that can distinguish "reads the field" from "recomputes the clock".
 *
 * This file closes that gap by calling `toLegacyTelemetryLine` DIRECTLY with
 * a hand-built envelope whose `observedAt` is a fixed sentinel that a live
 * clock could never produce (a value far in the past). No clock is frozen —
 * this test does not read the clock at all — but per repo convention
 * (`scripts/check-test-clock.sh`), this comment records that fact explicitly
 * rather than silently omitting a `freezeClock` call: a `new Date()` call in
 * this file would be a genuine bug, not something to be masked by freezing.
 */
import { describe, expect, test } from 'bun:test';
import type { ObservabilityEvent } from '../../../src/observability/envelope.js';
import { toLegacyTelemetryLine } from '../../../src/observability/observe.js';

/**
 * A sentinel `observedAt` that is provably NOT what a live clock would
 * return: it predates this repository's `package.json` by decades, and it is
 * not the frozen instant used by ANY other test in the suite (avoiding any
 * accidental collision with `freezeClock`'s default `fixedNow: 0` epoch or
 * `emit-line-parity.test.ts`'s `golden.fixedIso`).
 */
const SENTINEL_OBSERVED_AT = '1999-12-31T23:59:59.999Z';

function buildEvent(
	overrides: Partial<ObservabilityEvent> = {},
): ObservabilityEvent {
	return {
		schemaVersion: 1,
		eventId: 'evt-sentinel-0001',
		kind: 'session_started',
		category: 'lifecycle',
		severity: 'info',
		occurredAt: SENTINEL_OBSERVED_AT,
		observedAt: SENTINEL_OBSERVED_AT,
		writerSequence: 1,
		trace: {
			traceId: '0'.repeat(31) + '1',
			spanId: '0'.repeat(15) + '1',
			links: [],
		},
		workflow: {},
		lineage: {},
		provenance: {},
		outcome: {},
		policy: { sampled: true, sampleRate: 1, privacyClass: 'operational' },
		legacy: {
			sourceStore: '.swarm/telemetry.jsonl',
			sourceSchemaVersion: null,
			timingConfidence: 'writer-clock',
			unknown: [],
			extra: {},
			raw: { sessionId: 'sess-sentinel' },
		},
		relationshipViolations: [],
		...overrides,
	};
}

describe('toLegacyTelemetryLine — direct binding to event.observedAt (reviewer C1)', () => {
	test('timestamp equals event.observedAt EXACTLY, not a freshly computed clock value', () => {
		const event = buildEvent();
		const line = toLegacyTelemetryLine(event);

		expect(line.timestamp).toBe(SENTINEL_OBSERVED_AT);
		// A live `new Date().toISOString()` call can never produce a date in
		// 1999 — this repository did not exist then. This assertion is the
		// one that a `new Date().toISOString()` mutation would falsify while
		// an `isoNow`-frozen parity test would not.
		expect(line.timestamp).not.toBe(new Date().toISOString());
	});

	test('event equals event.kind', () => {
		const event = buildEvent({ kind: 'delegation_begin' });
		const line = toLegacyTelemetryLine(event);

		expect(line.event).toBe('delegation_begin');
		expect(line.event).toBe(event.kind);
	});

	test('a caller-supplied timestamp inside legacy.raw overrides the envelope value (spread-last ordering)', () => {
		const callerTimestamp = '2077-01-01T00:00:00.000Z';
		const event = buildEvent({
			legacy: {
				sourceStore: '.swarm/telemetry.jsonl',
				sourceSchemaVersion: null,
				timingConfidence: 'exact',
				unknown: [],
				extra: {},
				raw: { timestamp: callerTimestamp, sessionId: 'sess-override' },
			},
		});

		const line = toLegacyTelemetryLine(event);

		// The caller's value wins...
		expect(line.timestamp).toBe(callerTimestamp);
		expect(line.timestamp).not.toBe(SENTINEL_OBSERVED_AT);
		// ...but the KEY still occupies the first-declared position (spread is
		// last, so `timestamp`'s position comes from the object literal, not
		// from the spread).
		expect(Object.keys(line)[0]).toBe('timestamp');
		expect(line.sessionId).toBe('sess-override');
	});

	test('a non-object legacy.raw (null) yields exactly { timestamp, event }', () => {
		const event = buildEvent({
			legacy: {
				sourceStore: '.swarm/telemetry.jsonl',
				sourceSchemaVersion: null,
				timingConfidence: 'unknown',
				unknown: [],
				extra: {},
				raw: null,
			},
		});

		const line = toLegacyTelemetryLine(event);
		expect(line).toEqual({
			timestamp: SENTINEL_OBSERVED_AT,
			event: 'session_started',
		});
	});
});
