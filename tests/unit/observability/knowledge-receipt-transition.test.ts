import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	_internals,
	emitKnowledgeReceiptTransition,
} from '../../../src/hooks/knowledge-receipt-observability.js';
import { EVENT_CATALOG } from '../../../src/observability/catalog.js';
import {
	adaptLegacyTelemetryPayload,
	extractOutcome,
	KNOWN_TELEMETRY_KEYS,
} from '../../../src/observability/legacy.js';
import type { TelemetryEvent } from '../../../src/telemetry.js';

const originalEmit = _internals.emit;
let emitted: Array<{
	event: TelemetryEvent;
	payload: Record<string, unknown>;
}>;

beforeEach(() => {
	emitted = [];
	_internals.emit = (event, payload) => {
		emitted.push({ event, payload });
	};
});

afterEach(() => {
	_internals.emit = originalEmit;
});

describe('knowledge receipt transition observation', () => {
	test('emits the bounded event with only truthfully-held IDs and domain codes', () => {
		emitKnowledgeReceiptTransition({
			transition: 'terminal_committed',
			reasonCode: 'committed',
			schemaVersion: 2,
			knowledgeTraceId: 'trace-1',
			knowledgeEntryId: 'entry-1',
			sessionId: 'session-1',
			taskId: 'task-1',
			phase: 'phase_review',
			receiptOutcome: 'applied',
			receiptSource: 'delegate_ack',
		});

		expect(emitted).toEqual([
			{
				event: 'knowledge_receipt_transition',
				payload: {
					transition: 'terminal_committed',
					reasonCode: 'committed',
					schemaVersion: 2,
					// #2032: the outcome/source meaning-contract version is a
					// canonical fact on every transition, defaulted at the emitter.
					receiptSemantics: 2,
					knowledgeTraceId: 'trace-1',
					knowledgeEntryId: 'entry-1',
					sessionId: 'session-1',
					taskId: 'task-1',
					phase: 'phase_review',
					receiptOutcome: 'applied',
					receiptSource: 'delegate_ack',
				},
			},
		]);
	});

	test('does not synthesize absent IDs or copy circuit state/free text', () => {
		emitKnowledgeReceiptTransition({
			transition: 'legacy_unverifiable',
			reasonCode: 'legacy_unverifiable',
			schemaVersion: 2,
			knowledgeTraceId: '',
			sessionId: '',
			receiptSource: 'free text / user path',
			nonTransientCircuit: { state: 'open' },
			reason: 'unbounded details',
		} as never);

		expect(emitted).toHaveLength(1);
		expect(emitted[0]?.payload).toEqual({
			transition: 'legacy_unverifiable',
			reasonCode: 'legacy_unverifiable',
			schemaVersion: 2,
			receiptSemantics: 2,
		});
	});

	test('drops prose phases while preserving bounded phase codes (PRIV-01)', () => {
		// Previously, any non-empty phase was copied into this pseudonymous event,
		// allowing raw user prose and path-like values to escape the receipt ledger.
		emitKnowledgeReceiptTransition({
			transition: 'membership_committed',
			reasonCode: 'committed',
			schemaVersion: 2,
			phase: 'Review the user notes at C:\\Users\\example\\private-plan.md',
		});
		emitKnowledgeReceiptTransition({
			transition: 'membership_committed',
			reasonCode: 'committed',
			schemaVersion: 2,
			phase: 'phase_2-review',
		});
		emitKnowledgeReceiptTransition({
			transition: 'membership_committed',
			reasonCode: 'committed',
			schemaVersion: 2,
			phase: 'fix_bug',
		});

		expect(emitted).toHaveLength(3);
		expect(emitted[0]?.payload).not.toHaveProperty('phase');
		expect(emitted[1]?.payload.phase).toBe('phase_2-review');
		expect(emitted[2]?.payload).not.toHaveProperty('phase');
	});

	test('rejects unbounded transition/reason codes and invalid schema versions', () => {
		for (const observation of [
			{
				transition: 'arbitrary transition',
				reasonCode: 'committed',
				schemaVersion: 2,
			},
			{
				transition: 'terminal_committed',
				reasonCode: 'arbitrary reason',
				schemaVersion: 2,
			},
			{
				transition: 'terminal_committed',
				reasonCode: 'committed',
				schemaVersion: 0,
			},
		]) {
			emitKnowledgeReceiptTransition(observation as never);
		}
		expect(emitted).toEqual([]);
	});

	test('is fail-open when the telemetry sink throws', () => {
		_internals.emit = () => {
			throw new Error('sink unavailable');
		};
		expect(() =>
			emitKnowledgeReceiptTransition({
				transition: 'checkpoint',
				reasonCode: 'committed',
				schemaVersion: 2,
			}),
		).not.toThrow();
	});

	test('accepts the distinct authoritative application-marker transition', () => {
		emitKnowledgeReceiptTransition({
			transition: 'application_marker_committed',
			reasonCode: 'committed',
			schemaVersion: 2,
			knowledgeTraceId: 'trace-marker',
			knowledgeEntryId: 'entry-marker',
		});
		expect(emitted[0]?.payload.transition).toBe('application_marker_committed');
	});

	test('catalog declares truthful optional lineage and future ownership', () => {
		const entry = EVENT_CATALOG.knowledge_receipt_transition;
		expect(entry?.category).toBe('knowledge');
		expect(entry?.privacyClass).toBe('pseudonymous');
		expect(entry?.requiredWorkflowIds).toEqual([]);
		expect(entry?.allowsLinks).toBe(false);
		expect(entry?.consumers).toEqual([]);
		expect(entry?.futureOwnerIssue).toBe(2047);
	});

	test('receipt outcome/source stay payload values, not generic outcome fields', () => {
		const payload = {
			transition: 'terminal_committed',
			reasonCode: 'committed',
			schemaVersion: 2,
			receiptOutcome: 'contradicted',
			receiptSource: 'reviewer',
		};
		const legacy = adaptLegacyTelemetryPayload(
			'knowledge_receipt_transition',
			payload,
			KNOWN_TELEMETRY_KEYS.knowledge_receipt_transition,
		);
		expect(legacy.raw).toBe(payload);
		expect(extractOutcome(legacy.raw)).toEqual({});
	});
});
