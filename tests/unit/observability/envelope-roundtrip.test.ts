/** AC1 positive — every catalogued event kind round-trips create -> validate -> project, and Task/lane/resume/cross-process fixtures parse against `ObservabilityEventSchema`. */
import { describe, expect, test } from 'bun:test';
import { CATALOG_KINDS } from '../../../src/observability/catalog.js';
import { ObservabilityEventSchema } from '../../../src/observability/envelope.js';
import {
	createObservation,
	resetObservabilityForTesting,
	toLegacyTelemetryLine,
} from '../../../src/observability/observe.js';
import { validateEventRelationships } from '../../../src/observability/relationships.js';
import { FIXTURES } from './envelope-roundtrip-fixtures.js';

describe('envelope roundtrip — AC1 positive', () => {
	test('FIXTURES covers every catalogued kind (self-check)', () => {
		expect(Object.keys(FIXTURES).sort()).toEqual([...CATALOG_KINDS].sort());
	});

	describe.each(CATALOG_KINDS)('kind: %s', (kind) => {
		test(`${kind}: createObservation -> ObservabilityEventSchema.safeParse succeeds`, () => {
			resetObservabilityForTesting();
			const data = FIXTURES[kind];
			expect(data).toBeDefined();

			const event = createObservation(kind, data);
			const result = ObservabilityEventSchema.safeParse(event);
			if (!result.success) {
				throw new Error(
					`safeParse failed for ${kind}: ${JSON.stringify(result.error.issues)}`,
				);
			}
			expect(result.success).toBe(true);
		});

		test(`${kind}: validateEventRelationships returns ok:true`, () => {
			resetObservabilityForTesting();
			const data = FIXTURES[kind];
			const event = createObservation(kind, data);
			const verdict = validateEventRelationships(event);
			if (!verdict.ok) {
				throw new Error(
					`validateEventRelationships failed for ${kind}: ${JSON.stringify(verdict.violations)}`,
				);
			}
			expect(verdict.ok).toBe(true);
		});

		test(`${kind}: projects to a legacy line carrying timestamp and event`, () => {
			resetObservabilityForTesting();
			const data = FIXTURES[kind];
			const event = createObservation(kind, data);
			const line = toLegacyTelemetryLine(event);
			expect(line.event).toBe(kind);
			expect(typeof line.timestamp).toBe('string');
		});
	});

	test('Task-workflow fixture (taskId + hostSessionId) round-trips', () => {
		resetObservabilityForTesting();
		const event = createObservation('delegation_begin', {
			sessionId: 'task-sess',
			agentName: 'coder',
			taskId: '2.3',
		});
		expect(event.workflow.taskId).toBe('2.3');
		expect(event.workflow.hostSessionId).toBe('task-sess');
		expect(ObservabilityEventSchema.safeParse(event).success).toBe(true);
		expect(validateEventRelationships(event).ok).toBe(true);
	});

	test('lane fixture (batchId present) round-trips', () => {
		resetObservabilityForTesting();
		const event = createObservation('plan_ledger_cas_retry', {
			attempt: 1,
			expectedHashPrefix: 'deadbeef',
			delayMs: 37,
			batchId: 'lane-batch-9',
		});
		expect(event.workflow.batchId).toBe('lane-batch-9');
		expect(ObservabilityEventSchema.safeParse(event).success).toBe(true);
		expect(validateEventRelationships(event).ok).toBe(true);
	});

	test('resume fixture (session id reused across two createObservation calls) round-trips both', () => {
		resetObservabilityForTesting();
		const first = createObservation('session_started', {
			sessionId: 'resume-sess',
			agentName: 'architect',
		});
		const second = createObservation('session_started', {
			sessionId: 'resume-sess',
			agentName: 'architect',
		});
		expect(ObservabilityEventSchema.safeParse(first).success).toBe(true);
		expect(ObservabilityEventSchema.safeParse(second).success).toBe(true);
		expect(validateEventRelationships(first).ok).toBe(true);
		expect(validateEventRelationships(second).ok).toBe(true);
		// Distinct eventIds/writerSequence even though the payload repeats.
		expect(first.eventId).not.toBe(second.eventId);
		expect(second.writerSequence).toBeGreaterThan(first.writerSequence);
	});
});
