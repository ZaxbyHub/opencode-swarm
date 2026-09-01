/** AC1 positive — independent createObservation calls retain valid relationships and distinct traces. */
import { describe, expect, test } from 'bun:test';
import { ObservabilityEventSchema } from '../../../src/observability/envelope.js';
import {
	createObservation,
	resetObservabilityForTesting,
} from '../../../src/observability/observe.js';
import { validateEventRelationships } from '../../../src/observability/relationships.js';

describe('envelope roundtrip — independent process fixture', () => {
	test('cross-process fixture round-trips without shared in-memory state', () => {
		resetObservabilityForTesting();
		const procA = createObservation('heartbeat', { sessionId: 'proc-a' });
		resetObservabilityForTesting();
		const procB = createObservation('heartbeat', { sessionId: 'proc-b' });
		expect(ObservabilityEventSchema.safeParse(procA).success).toBe(true);
		expect(ObservabilityEventSchema.safeParse(procB).success).toBe(true);
		expect(validateEventRelationships(procA).ok).toBe(true);
		expect(validateEventRelationships(procB).ok).toBe(true);
		expect(procA.trace.traceId).not.toBe(procB.trace.traceId);
	});
});
