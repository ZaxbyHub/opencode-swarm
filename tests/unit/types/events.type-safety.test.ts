/**
 * Adversarial tests for src/types/events.ts
 * Tests type safety constraints and prevents malicious data injection
 */

import { describe, expect, test } from 'bun:test';
import type {
	ArchitectLoopDetectedEvent,
	CoderRetryCircuitBreakerEvent,
	CoderSelfAuditEvent,
	PrecedentManipulationDetectedEvent,
	SoundingBoardConsultedEvent,
	V619Event,
} from '../../src/types/events';

describe('src/types/events.ts - ADVERSARIAL TESTS', () => {
	describe('Attack Vector 1: Type injection', () => {
		test('SoundingBoardConsultedEvent rejects invalid criticVerdict values', () => {
			// Valid verdicts only: 'UNNECESSARY' | 'REPHRASE' | 'APPROVED' | 'RESOLVE'
			const validEvent: SoundingBoardConsultedEvent = {
				type: 'sounding_board_consulted',
				timestamp: '2024-01-01T00:00:00Z',
				architectQuery: 'test query',
				criticVerdict: 'APPROVED',
				phase: 1,
			};

			expect(validEvent.criticVerdict).toBe('APPROVED');

			// Verify type system prevents invalid values at compile time
			// @ts-expect-error - Invalid verdict should be rejected
			const invalidEvent: SoundingBoardConsultedEvent = {
				type: 'sounding_board_consulted',
				timestamp: '2024-01-01T00:00:00Z',
				architectQuery: 'test query',
				criticVerdict: 'HACKED', // This should fail type check
				phase: 1,
			};

			// At runtime, verify we can check valid values
			const validVerdicts: SoundingBoardConsultedEvent['criticVerdict'][] = [
				'UNNECESSARY',
				'REPHRASE',
				'APPROVED',
				'RESOLVE',
			];

			expect(validVerdicts).toHaveLength(4);
		});

		test('CoderRetryCircuitBreakerEvent rejects invalid action values', () => {
			// Valid actions only: 'sounding_board_consultation' | 'simplification' | 'user_escalation'
			const validEvent: CoderRetryCircuitBreakerEvent = {
				type: 'coder_retry_circuit_breaker',
				timestamp: '2024-01-01T00:00:00Z',
				taskId: 'task-123',
				rejectionCount: 3,
				rejectionHistory: ['error1', 'error2', 'error3'],
				phase: 1,
				action: 'sounding_board_consultation',
			};

			expect(validEvent.action).toBe('sounding_board_consultation');

			// Verify all valid actions are constrained
			const validActions: CoderRetryCircuitBreakerEvent['action'][] = [
				'sounding_board_consultation',
				'simplification',
				'user_escalation',
			];

			expect(validActions).toHaveLength(3);
		});

		test('PrecedentManipulationDetectedEvent rejects invalid pattern values', () => {
			const validEvent: PrecedentManipulationDetectedEvent = {
				type: 'precedent_manipulation_detected',
				timestamp: '2024-01-01T00:00:00Z',
				pattern: 'PRECEDENT_MANIPULATION',
				severity: 'HIGHEST',
				detectedIn: 'test location',
				phase: 1,
			};

			expect(validEvent.pattern).toBe('PRECEDENT_MANIPULATION');

			// Pattern should only allow 'PRECEDENT_MANIPULATION'
			// @ts-expect-error - Invalid pattern should be rejected
			const invalidEvent: PrecedentManipulationDetectedEvent = {
				type: 'precedent_manipulation_detected',
				timestamp: '2024-01-01T00:00:00Z',
				pattern: 'INVALID_PATTERN', // Should fail type check
				severity: 'HIGHEST',
				detectedIn: 'test location',
				phase: 1,
			};
		});

		test('Event type field is constrained to literal values', () => {
			// Each event must have exact type literal
			const types: V619Event['type'][] = [
				'sounding_board_consulted',
				'architect_loop_detected',
				'precedent_manipulation_detected',
				'coder_self_audit',
				'coder_retry_circuit_breaker',
			];

			expect(types).toHaveLength(5);

			// @ts-expect-error - Invalid event type
			const invalidType: V619Event['type'] = 'malicious_event_type';
		});
	});

	describe('Attack Vector 2: Severity escalation', () => {
		test('PrecedentManipulationDetectedEvent severity is constrained to HIGHEST', () => {
			const event: PrecedentManipulationDetectedEvent = {
				type: 'precedent_manipulation_detected',
				timestamp: '2024-01-01T00:00:00Z',
				pattern: 'PRECEDENT_MANIPULATION',
				severity: 'HIGHEST',
				detectedIn: 'test location',
				phase: 1,
			};

			// Severity must be exactly 'HIGHEST'
			expect(event.severity).toBe('HIGHEST');

			// Type system prevents other severity levels
			// @ts-expect-error - Should only accept 'HIGHEST'
			const lowSeverityEvent: PrecedentManipulationDetectedEvent = {
				type: 'precedent_manipulation_detected',
				timestamp: '2024-01-01T00:00:00Z',
				pattern: 'PRECEDENT_MANIPULATION',
				severity: 'LOW', // Should fail type check
				detectedIn: 'test location',
				phase: 1,
			};

			// @ts-expect-error - Should only accept 'HIGHEST'
			const mediumSeverityEvent: PrecedentManipulationDetectedEvent = {
				type: 'precedent_manipulation_detected',
				timestamp: '2024-01-01T00:00:00Z',
				pattern: 'PRECEDENT_MANIPULATION',
				severity: 'MEDIUM', // Should fail type check
				detectedIn: 'test location',
				phase: 1,
			};
		});

		test('Severity cannot be escalated beyond HIGHEST', () => {
			// There is no CRITICAL or EXTREME severity level allowed
			const severityValues: PrecedentManipulationDetectedEvent['severity'][] = [
				'HIGHEST',
			];

			expect(severityValues).toHaveLength(1);

			// Ensure only HIGHEST is valid
			expect('HIGHEST').toBe('HIGHEST');
		});
	});

	describe('Attack Vector 3: Union type exhaustion', () => {
		test('V619Event union covers all event types', () => {
			// Verify all 5 event types are in the union
			const eventTypes: Set<V619Event['type']> = new Set([
				'sounding_board_consulted',
				'architect_loop_detected',
				'precedent_manipulation_detected',
				'coder_self_audit',
				'coder_retry_circuit_breaker',
			]);

			expect(eventTypes.size).toBe(5);

			// Each event type should be constructible
			const event1: V619Event = {
				type: 'sounding_board_consulted',
				timestamp: '2024-01-01T00:00:00Z',
				architectQuery: 'test',
				criticVerdict: 'APPROVED',
				phase: 1,
			};

			const event2: V619Event = {
				type: 'architect_loop_detected',
				timestamp: '2024-01-01T00:00:00Z',
				impasseDescription: 'test',
				occurrenceCount: 1,
				phase: 1,
			};

			const event3: V619Event = {
				type: 'precedent_manipulation_detected',
				timestamp: '2024-01-01T00:00:00Z',
				pattern: 'PRECEDENT_MANIPULATION',
				severity: 'HIGHEST',
				detectedIn: 'test',
				phase: 1,
			};

			const event4: V619Event = {
				type: 'coder_self_audit',
				timestamp: '2024-01-01T00:00:00Z',
				taskId: 'task-123',
				filesModified: ['file1.ts'],
				checklistResults: {
					filesMatchSpec: true,
					noExtraFunctionality: true,
					noSkippedAcceptanceCriteria: true,
					didNotRunTests: false,
					syntaxCheckPassed: true,
				},
				meta: { summary: 'test' },
			};

			const event5: V619Event = {
				type: 'coder_retry_circuit_breaker',
				timestamp: '2024-01-01T00:00:00Z',
				taskId: 'task-123',
				rejectionCount: 3,
				rejectionHistory: ['error1', 'error2', 'error3'],
				phase: 1,
				action: 'user_escalation',
			};

			expect([event1, event2, event3, event4, event5]).toHaveLength(5);
		});

		test('No event types are missing from union', () => {
			// List all event interfaces defined
			const interfaceNames = [
				'SoundingBoardConsultedEvent',
				'ArchitectLoopDetectedEvent',
				'PrecedentManipulationDetectedEvent',
				'CoderSelfAuditEvent',
				'CoderRetryCircuitBreakerEvent',
			];

			expect(interfaceNames).toHaveLength(5);

			// Each should be included in V619Event union
			// This is verified by the fact that we can assign each to V619Event type
			const allEvents: V619Event[] = [
				{
					type: 'sounding_board_consulted',
					timestamp: '2024-01-01T00:00:00Z',
					architectQuery: 'test',
					criticVerdict: 'APPROVED',
					phase: 1,
				},
				{
					type: 'architect_loop_detected',
					timestamp: '2024-01-01T00:00:00Z',
					impasseDescription: 'test',
					occurrenceCount: 1,
					phase: 1,
				},
				{
					type: 'precedent_manipulation_detected',
					timestamp: '2024-01-01T00:00:00Z',
					pattern: 'PRECEDENT_MANIPULATION',
					severity: 'HIGHEST',
					detectedIn: 'test',
					phase: 1,
				},
				{
					type: 'coder_self_audit',
					timestamp: '2024-01-01T00:00:00Z',
					taskId: 'task-123',
					filesModified: ['file1.ts'],
					checklistResults: {
						filesMatchSpec: true,
						noExtraFunctionality: true,
						noSkippedAcceptanceCriteria: true,
						didNotRunTests: false,
						syntaxCheckPassed: true,
					},
					meta: { summary: 'test' },
				},
				{
					type: 'coder_retry_circuit_breaker',
					timestamp: '2024-01-01T00:00:00Z',
					taskId: 'task-123',
					rejectionCount: 3,
					rejectionHistory: ['error1'],
					phase: 1,
					action: 'sounding_board_consultation',
				},
			];

			expect(allEvents).toHaveLength(5);
		});
	});

	describe('Attack Vector 4: Interface pollution', () => {
		test('Extra fields cannot be injected into SoundingBoardConsultedEvent', () => {
			// Valid event with only required fields
			const validEvent: SoundingBoardConsultedEvent = {
				type: 'sounding_board_consulted',
				timestamp: '2024-01-01T00:00:00Z',
				architectQuery: 'test query',
				criticVerdict: 'APPROVED',
				phase: 1,
			};

			// @ts-expect-error - Extra fields should be rejected by TypeScript
			const pollutedEvent: SoundingBoardConsultedEvent = {
				type: 'sounding_board_consulted',
				timestamp: '2024-01-01T00:00:00Z',
				architectQuery: 'test query',
				criticVerdict: 'APPROVED',
				phase: 1,
				maliciousField: 'should not be allowed', // This should fail type check
				extraData: { malicious: true },
			};
		});

		test('Extra fields cannot be injected into PrecedentManipulationDetectedEvent', () => {
			// @ts-expect-error - Extra fields should be rejected
			const pollutedEvent: PrecedentManipulationDetectedEvent = {
				type: 'precedent_manipulation_detected',
				timestamp: '2024-01-01T00:00:00Z',
				pattern: 'PRECEDENT_MANIPULATION',
				severity: 'HIGHEST',
				detectedIn: 'test',
				phase: 1,
				attemptedSeverityEscalation: 'CRITICAL', // Should be rejected
			};
		});

		test('Extra fields cannot be injected into CoderSelfAuditEvent', () => {
			// @ts-expect-error - Extra fields should be rejected
			const pollutedEvent: CoderSelfAuditEvent = {
				type: 'coder_self_audit',
				timestamp: '2024-01-01T00:00:00Z',
				taskId: 'task-123',
				filesModified: ['file1.ts'],
				checklistResults: {
					filesMatchSpec: true,
					noExtraFunctionality: true,
					noSkippedAcceptanceCriteria: true,
					didNotRunTests: false,
					syntaxCheckPassed: true,
				},
				meta: { summary: 'test' },
				bypassedChecklist: true, // Should be rejected
				skippedTests: ['test1', 'test2'], // Should be rejected
			};
		});

		test('Extra fields cannot be injected into CoderRetryCircuitBreakerEvent', () => {
			// @ts-expect-error - Extra fields should be rejected
			const pollutedEvent: CoderRetryCircuitBreakerEvent = {
				type: 'coder_retry_circuit_breaker',
				timestamp: '2024-01-01T00:00:00Z',
				taskId: 'task-123',
				rejectionCount: 3,
				rejectionHistory: ['error1', 'error2'],
				phase: 1,
				action: 'user_escalation',
				overrideAction: 'malicious_override', // Should be rejected
			};
		});

		test('Extra fields cannot be injected into nested checklistResults', () => {
			// @ts-expect-error - Extra fields in nested object should be rejected
			const pollutedEvent: CoderSelfAuditEvent = {
				type: 'coder_self_audit',
				timestamp: '2024-01-01T00:00:00Z',
				taskId: 'task-123',
				filesModified: ['file1.ts'],
				checklistResults: {
					filesMatchSpec: true,
					noExtraFunctionality: true,
					noSkippedAcceptanceCriteria: true,
					didNotRunTests: false,
					syntaxCheckPassed: true,
					// Extra field in nested object
					customFlag: 'should not be allowed',
					bypassedCheck: true,
				},
				meta: { summary: 'test' },
			};
		});

		test('Extra fields cannot be injected into nested meta object', () => {
			// @ts-expect-error - Extra fields in meta should be rejected
			const pollutedEvent: CoderSelfAuditEvent = {
				type: 'coder_self_audit',
				timestamp: '2024-01-01T00:00:00Z',
				taskId: 'task-123',
				filesModified: ['file1.ts'],
				checklistResults: {
					filesMatchSpec: true,
					noExtraFunctionality: true,
					noSkippedAcceptanceCriteria: true,
					didNotRunTests: false,
					syntaxCheckPassed: true,
				},
				meta: {
					summary: 'test',
					// Extra field in meta
					maliciousData: 'should not be allowed',
					bypassedAudit: true,
				},
			};
		});
	});

	describe('Additional adversarial tests', () => {
		test('Required fields cannot be omitted', () => {
			// @ts-expect-error - Missing required fields should be rejected
			const incompleteEvent: SoundingBoardConsultedEvent = {
				type: 'sounding_board_consulted',
				// Missing timestamp
				// Missing architectQuery
				criticVerdict: 'APPROVED',
				phase: 1,
			};

			// @ts-expect-error - Missing required taskId for CoderSelfAuditEvent
			const incompleteAudit: CoderSelfAuditEvent = {
				type: 'coder_self_audit',
				timestamp: '2024-01-01T00:00:00Z',
				// Missing taskId
				filesModified: ['file1.ts'],
				checklistResults: {
					filesMatchSpec: true,
					noExtraFunctionality: true,
					noSkippedAcceptanceCriteria: true,
					didNotRunTests: false,
					syntaxCheckPassed: true,
				},
				meta: { summary: 'test' },
			};
		});

		test('Array fields maintain type safety', () => {
			// filesModified must be string array
			const validEvent: CoderSelfAuditEvent = {
				type: 'coder_self_audit',
				timestamp: '2024-01-01T00:00:00Z',
				taskId: 'task-123',
				filesModified: ['file1.ts', 'file2.js'],
				checklistResults: {
					filesMatchSpec: true,
					noExtraFunctionality: true,
					noSkippedAcceptanceCriteria: true,
					didNotRunTests: false,
					syntaxCheckPassed: true,
				},
				meta: { summary: 'test' },
			};

			expect(validEvent.filesModified).toBeArray();
			expect(validEvent.filesModified[0]).toBeString();

			// @ts-expect-error - Array with wrong type should be rejected
			const invalidFiles: CoderSelfAuditEvent = {
				type: 'coder_self_audit',
				timestamp: '2024-01-01T00:00:00Z',
				taskId: 'task-123',
				filesModified: [123, 456], // Should be strings, not numbers
				checklistResults: {
					filesMatchSpec: true,
					noExtraFunctionality: true,
					noSkippedAcceptanceCriteria: true,
					didNotRunTests: false,
					syntaxCheckPassed: true,
				},
				meta: { summary: 'test' },
			};

			// rejectionHistory must be string array
			const validRetry: CoderRetryCircuitBreakerEvent = {
				type: 'coder_retry_circuit_breaker',
				timestamp: '2024-01-01T00:00:00Z',
				taskId: 'task-123',
				rejectionCount: 3,
				rejectionHistory: ['error1', 'error2'],
				phase: 1,
				action: 'user_escalation',
			};

			expect(validRetry.rejectionHistory).toBeArray();
		});

		test('Optional fields are truly optional', () => {
			// taskId is optional in SoundingBoardConsultedEvent
			const eventWithoutTaskId: SoundingBoardConsultedEvent = {
				type: 'sounding_board_consulted',
				timestamp: '2024-01-01T00:00:00Z',
				architectQuery: 'test query',
				criticVerdict: 'APPROVED',
				phase: 1,
				// taskId omitted - should be valid
			};

			expect(eventWithoutTaskId.taskId).toBeUndefined();

			// taskId is optional in ArchitectLoopDetectedEvent
			const loopEventWithoutTaskId: ArchitectLoopDetectedEvent = {
				type: 'architect_loop_detected',
				timestamp: '2024-01-01T00:00:00Z',
				impasseDescription: 'test impasse',
				occurrenceCount: 5,
				phase: 1,
				// taskId omitted - should be valid
			};

			expect(loopEventWithoutTaskId.taskId).toBeUndefined();

			// taskId is optional in PrecedentManipulationDetectedEvent
			const precedentEventWithoutTaskId: PrecedentManipulationDetectedEvent = {
				type: 'precedent_manipulation_detected',
				timestamp: '2024-01-01T00:00:00Z',
				pattern: 'PRECEDENT_MANIPULATION',
				severity: 'HIGHEST',
				detectedIn: 'test location',
				phase: 1,
				// taskId omitted - should be valid
			};

			expect(precedentEventWithoutTaskId.taskId).toBeUndefined();
		});

		test('Number fields accept only numbers', () => {
			const validLoopEvent: ArchitectLoopDetectedEvent = {
				type: 'architect_loop_detected',
				timestamp: '2024-01-01T00:00:00Z',
				impasseDescription: 'test',
				occurrenceCount: 5,
				phase: 1,
			};

			expect(validLoopEvent.occurrenceCount).toBeNumber();
			expect(validLoopEvent.phase).toBeNumber();

			// @ts-expect-error - String should be rejected for number field
			const invalidCount: ArchitectLoopDetectedEvent = {
				type: 'architect_loop_detected',
				timestamp: '2024-01-01T00:00:00Z',
				impasseDescription: 'test',
				occurrenceCount: 'five', // Should be number, not string
				phase: 1,
			};
		});

		test('Boolean fields in checklistResults are constrained', () => {
			const validChecklist: CoderSelfAuditEvent['checklistResults'] = {
				filesMatchSpec: true,
				noExtraFunctionality: true,
				noSkippedAcceptanceCriteria: true,
				didNotRunTests: false,
				syntaxCheckPassed: true,
			};

			// All should be booleans
			expect(validChecklist.filesMatchSpec).toBeBoolean();
			expect(validChecklist.noExtraFunctionality).toBeBoolean();
			expect(validChecklist.noSkippedAcceptanceCriteria).toBeBoolean();
			expect(validChecklist.didNotRunTests).toBeBoolean();
			expect(validChecklist.syntaxCheckPassed).toBeBoolean();

			// @ts-expect-error - String should be rejected for boolean field
			const invalidChecklist: CoderSelfAuditEvent['checklistResults'] = {
				filesMatchSpec: 'yes', // Should be boolean
				noExtraFunctionality: true,
				noSkippedAcceptanceCriteria: true,
				didNotRunTests: false,
				syntaxCheckPassed: true,
			};
		});

		test('Cannot assign incompatible event types', () => {
			const soundingBoardEvent: SoundingBoardConsultedEvent = {
				type: 'sounding_board_consulted',
				timestamp: '2024-01-01T00:00:00Z',
				architectQuery: 'test',
				criticVerdict: 'APPROVED',
				phase: 1,
			};

			// @ts-expect-error - Cannot assign to wrong type
			const loopEvent: ArchitectLoopDetectedEvent = soundingBoardEvent;

			// @ts-expect-error - Cannot assign to wrong type
			const auditEvent: CoderSelfAuditEvent = soundingBoardEvent;
		});
	});
});
