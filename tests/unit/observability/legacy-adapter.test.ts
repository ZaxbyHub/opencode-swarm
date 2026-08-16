/**
 * AC2 — the legacy telemetry adapter (issue #2029 item 4).
 *
 * Covers: missing IDs, unknown cost, duplicate timestamps, extra fields,
 * unknown-is-not-zero, `sourceSchemaVersion === null`, `raw` reference
 * identity, never-throw guarantees on hostile payloads, and `__proto__`
 * safety.
 */
import { describe, expect, test } from 'bun:test';
import {
	adaptLegacyTelemetryPayload,
	extractOutcome,
	extractWorkflowIds,
	KNOWN_TELEMETRY_KEYS,
	NON_OBJECT_PAYLOAD_MARKER,
} from '../../../src/observability/legacy.js';

describe('adaptLegacyTelemetryPayload — AC2', () => {
	test('missing IDs: extractWorkflowIds leaves sessionId/taskId absent (undefined), never synthesized', () => {
		const ids = extractWorkflowIds({ someOtherField: 1 });
		expect(ids.hostSessionId).toBeUndefined();
		expect(ids.taskId).toBeUndefined();
		expect(Object.hasOwn(ids, 'hostSessionId')).toBe(false);
	});

	test('extracts canonical knowledge receipt workflow IDs without coercion', () => {
		const ids = extractWorkflowIds({
			knowledgeTraceId: 'trace-uuid',
			knowledgeEntryId: 'entry-uuid',
		});
		expect(ids.knowledgeTraceId).toBe('trace-uuid');
		expect(ids.knowledgeEntryId).toBe('entry-uuid');
		expect(
			extractWorkflowIds({ knowledgeTraceId: '', knowledgeEntryId: 42 }),
		).toEqual({});
	});

	test('unknown cost: a `delegation_end` payload missing cost_usd lists it in unknown, does NOT default to 0', () => {
		const knownKeys = KNOWN_TELEMETRY_KEYS.delegation_end;
		const payload = {
			sessionId: 'sess-1',
			agentName: 'coder',
			taskId: '1.1',
			result: 'failure',
			// cost_usd intentionally absent
		};
		const projection = adaptLegacyTelemetryPayload(
			'delegation_end',
			payload,
			knownKeys,
		);
		expect(projection.unknown).toContain('cost_usd');
		// Unknown is NOT zero: no cost_usd key was fabricated on the projection,
		// and the raw payload itself carries no cost_usd of any value.
		expect(Object.hasOwn(payload, 'cost_usd')).toBe(false);
		expect(
			(projection.raw as Record<string, unknown>).cost_usd,
		).toBeUndefined();
	});

	test('explicit undefined cost_usd is ALSO reported unknown (JSON.stringify cannot distinguish absent from undefined)', () => {
		const knownKeys = KNOWN_TELEMETRY_KEYS.delegation_end;
		const payload = {
			sessionId: 'sess-1',
			agentName: 'coder',
			taskId: '1.1',
			result: 'failure',
			cost_usd: undefined,
		};
		const projection = adaptLegacyTelemetryPayload(
			'delegation_end',
			payload,
			knownKeys,
		);
		expect(projection.unknown).toContain('cost_usd');
	});

	test('a real cost_usd of exactly 0 is NOT reported unknown (0 is a valid reported value, not absence)', () => {
		const knownKeys = KNOWN_TELEMETRY_KEYS.delegation_end;
		const payload = {
			sessionId: 'sess-1',
			agentName: 'coder',
			taskId: '1.1',
			result: 'success',
			cost_usd: 0,
		};
		const projection = adaptLegacyTelemetryPayload(
			'delegation_end',
			payload,
			knownKeys,
		);
		expect(projection.unknown).not.toContain('cost_usd');
	});

	test('duplicate timestamps: two payloads with the SAME timestamp are preserved verbatim, not deduplicated', () => {
		const knownKeys = KNOWN_TELEMETRY_KEYS.agent_conflict_detected;
		const sharedTs = '2020-01-02T03:04:05.678Z';
		const payloadA = {
			type: 'agent_conflict_detected',
			timestamp: sharedTs,
			sessionId: 'a',
		};
		const payloadB = {
			type: 'agent_conflict_detected',
			timestamp: sharedTs,
			sessionId: 'b',
		};

		const projA = adaptLegacyTelemetryPayload(
			'agent_conflict_detected',
			payloadA,
			knownKeys,
		);
		const projB = adaptLegacyTelemetryPayload(
			'agent_conflict_detected',
			payloadB,
			knownKeys,
		);

		expect((projA.raw as Record<string, unknown>).timestamp).toBe(sharedTs);
		expect((projB.raw as Record<string, unknown>).timestamp).toBe(sharedTs);
		// Both preserved independently — adapter does not mutate or collapse.
		expect(projA.raw).not.toBe(projB.raw);
	});

	test('extra unrecognized fields land in legacy.extra by reference, and are NOT dropped', () => {
		const marker = { nested: true };
		const payload = {
			sessionId: 'sess-1',
			agentName: 'architect',
			totallyUnrecognizedField: marker,
		};
		const projection = adaptLegacyTelemetryPayload(
			'session_started',
			payload,
			KNOWN_TELEMETRY_KEYS.session_started,
		);
		expect(projection.extra.totallyUnrecognizedField).toBe(marker);
	});

	test('known-but-absent keys land in legacy.unknown, never in extra', () => {
		const payload = { sessionId: 'sess-1' }; // missing agentName
		const projection = adaptLegacyTelemetryPayload(
			'session_started',
			payload,
			KNOWN_TELEMETRY_KEYS.session_started,
		);
		expect(projection.unknown).toContain('agentName');
		expect(Object.hasOwn(projection.extra, 'agentName')).toBe(false);
	});

	test('sourceSchemaVersion is null, not 0 — telemetry.jsonl has no version field', () => {
		const projection = adaptLegacyTelemetryPayload(
			'heartbeat',
			{ sessionId: 'x' },
			['sessionId'],
		);
		expect(projection.sourceSchemaVersion).toBeNull();
		expect(projection.sourceSchemaVersion).not.toBe(0);
	});

	test('legacy.raw is the SAME OBJECT REFERENCE as the input, not a copy', () => {
		const payload = { sessionId: 'x', nested: { a: 1 } };
		const projection = adaptLegacyTelemetryPayload('heartbeat', payload, [
			'sessionId',
		]);
		expect(projection.raw).toBe(payload);
		// A structural-equality check would also pass for a clone; toBe (identity)
		// is the property under test.
		expect(projection.raw).not.toEqual({ different: true });
	});

	describe('never throws', () => {
		test('circular object', () => {
			const circular: Record<string, unknown> = { a: 1 };
			circular.self = circular;
			expect(() =>
				adaptLegacyTelemetryPayload('heartbeat', circular, []),
			).not.toThrow();
			const projection = adaptLegacyTelemetryPayload('heartbeat', circular, []);
			expect(projection.raw).toBe(circular);
		});

		test('function value inside payload', () => {
			const payload = { fn: () => 'x' };
			expect(() =>
				adaptLegacyTelemetryPayload('heartbeat', payload, []),
			).not.toThrow();
		});

		test('Symbol value inside payload', () => {
			const payload = { sym: Symbol('test') };
			expect(() =>
				adaptLegacyTelemetryPayload('heartbeat', payload, []),
			).not.toThrow();
		});

		test('BigInt value inside payload', () => {
			const payload = { big: BigInt(123) };
			expect(() =>
				adaptLegacyTelemetryPayload('heartbeat', payload, []),
			).not.toThrow();
		});

		test('null payload', () => {
			expect(() =>
				adaptLegacyTelemetryPayload('heartbeat', null, []),
			).not.toThrow();
			const projection = adaptLegacyTelemetryPayload('heartbeat', null, []);
			expect(projection.unknown).toContain(NON_OBJECT_PAYLOAD_MARKER);
		});

		test('undefined payload', () => {
			expect(() =>
				adaptLegacyTelemetryPayload('heartbeat', undefined, []),
			).not.toThrow();
		});

		test('number payload', () => {
			expect(() =>
				adaptLegacyTelemetryPayload('heartbeat', 42, []),
			).not.toThrow();
			const projection = adaptLegacyTelemetryPayload('heartbeat', 42, []);
			expect(projection.raw).toBe(42);
		});

		test('string payload', () => {
			expect(() =>
				adaptLegacyTelemetryPayload('heartbeat', 'hello', []),
			).not.toThrow();
		});

		test('array payload', () => {
			const payload = [1, 2, 3];
			expect(() =>
				adaptLegacyTelemetryPayload('heartbeat', payload, []),
			).not.toThrow();
			const projection = adaptLegacyTelemetryPayload('heartbeat', payload, []);
			expect(projection.raw).toBe(payload);
		});

		test('object with a throwing getter', () => {
			const hostile = {
				get poison(): unknown {
					throw new Error('boom');
				},
			};
			expect(() =>
				adaptLegacyTelemetryPayload('heartbeat', hostile, []),
			).not.toThrow();
		});

		test('extractWorkflowIds never throws on a throwing-getter Proxy', () => {
			const hostile = new Proxy(
				{},
				{
					get() {
						throw new Error('boom');
					},
				},
			);
			expect(() => extractWorkflowIds(hostile)).not.toThrow();
		});

		test('extractOutcome never throws on a throwing-getter Proxy', () => {
			const hostile = new Proxy(
				{},
				{
					get() {
						throw new Error('boom');
					},
				},
			);
			expect(() => extractOutcome(hostile)).not.toThrow();
		});
	});

	test('an own __proto__ key is preserved into legacy.extra and does NOT pollute Object.prototype', () => {
		const payload = JSON.parse(
			'{"__proto__": {"polluted": true}, "sessionId": "x"}',
		);
		const projection = adaptLegacyTelemetryPayload('heartbeat', payload, [
			'sessionId',
		]);

		// The value must be preserved somewhere reachable (never silently dropped).
		expect(Object.hasOwn(projection.extra, '__proto__')).toBe(true);
		expect((projection.extra as Record<string, unknown>).__proto__).toEqual({
			polluted: true,
		});

		// Object.prototype itself must remain unpolluted.
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
		expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);
	});
});
