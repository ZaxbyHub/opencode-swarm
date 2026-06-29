/**
 * Unit tests for src/hooks/conflict-resolution.ts
 *
 * Behavioral tests covering:
 * 1. Detects conflicting evidence records for the same task (advisory injection)
 * 2. Applies resolution policy (self_resolve vs soundingboard) per rejectionCount
 * 3. Emits a conflict event for downstream consumers via telemetry
 *
 * Uses addTelemetryListener for telemetry capture (no mock.module),
 * _internals reset for swarmState isolation, and per-test temp dirs.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	type ResolveAgentConflictInput,
	resolveAgentConflict,
} from '../../../src/hooks/conflict-resolution';
import {
	ensureAgentSession,
	resetSwarmState,
	swarmState,
} from '../../../src/state';
import {
	addTelemetryListener,
	initTelemetry,
	resetTelemetryForTesting,
	_internals as telemetryInternals,
} from '../../../src/telemetry';

// =============================================================================
// Helpers
// =============================================================================

const SESSION_ID = 'test-conflict-session';

function makeTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'conflict-resolution-test-'));
}

// =============================================================================
// Test suite
// =============================================================================

describe('conflict-resolution', () => {
	let tempDir: string;

	beforeEach(() => {
		resetTelemetryForTesting();
		resetSwarmState();
		tempDir = makeTempDir();
		initTelemetry(tempDir);
	});

	afterEach(() => {
		resetTelemetryForTesting();
		resetSwarmState();
		// Restore _internals telemetry emit in case any test replaced it
		telemetryInternals.emit = (event, data) => {
			const { emit } = require('../../../src/telemetry');
			return emit(event as Parameters<typeof emit>[0], data);
		};
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	// ---------------------------------------------------------------------------
	// Outcome 1: Detects conflicting evidence — advisory messages are pushed
	// for the same session/task across multiple conflict calls
	// ---------------------------------------------------------------------------

	describe('detects conflicting evidence records for the same task', () => {
		test('pushes advisory message to session on first conflict', () => {
			ensureAgentSession(SESSION_ID, 'architect');

			resolveAgentConflict({
				sessionID: SESSION_ID,
				phase: 1,
				taskId: 'task-1',
				sourceAgent: 'reviewer',
				targetAgent: 'coder',
				conflictType: 'feedback_rejection',
				rejectionCount: 1,
				summary: 'First rejection',
			});

			const session = ensureAgentSession(SESSION_ID);
			expect(session.pendingAdvisoryMessages).toBeDefined();
			expect(session.pendingAdvisoryMessages).toHaveLength(1);
			expect(session.pendingAdvisoryMessages![0]).toContain(
				'CONFLICT DETECTED',
			);
			expect(session.pendingAdvisoryMessages![0]).toContain('reviewer');
			expect(session.pendingAdvisoryMessages![0]).toContain('coder');
			expect(session.pendingAdvisoryMessages![0]).toContain('task-1');
		});

		test('accumulates multiple advisory messages for repeated conflicts', () => {
			ensureAgentSession(SESSION_ID, 'architect');

			resolveAgentConflict({
				sessionID: SESSION_ID,
				phase: 1,
				taskId: 'task-1',
				sourceAgent: 'reviewer',
				targetAgent: 'coder',
				conflictType: 'feedback_rejection',
				rejectionCount: 1,
				summary: 'Rejection 1',
			});

			resolveAgentConflict({
				sessionID: SESSION_ID,
				phase: 1,
				taskId: 'task-1',
				sourceAgent: 'reviewer',
				targetAgent: 'coder',
				conflictType: 'feedback_rejection',
				rejectionCount: 2,
				summary: 'Rejection 2',
			});

			const session = ensureAgentSession(SESSION_ID);
			expect(session.pendingAdvisoryMessages).toHaveLength(2);
			expect(session.pendingAdvisoryMessages![0]).toContain(
				'CONFLICT DETECTED',
			);
			expect(session.pendingAdvisoryMessages![1]).toContain(
				'CONFLICT DETECTED',
			);
		});

		test('no-ops when session does not exist (does not throw)', () => {
			expect(() => {
				resolveAgentConflict({
					sessionID: 'nonexistent-session',
					phase: 1,
					sourceAgent: 'coder',
					targetAgent: 'reviewer',
					conflictType: 'feedback_rejection',
					rejectionCount: 0,
					summary: 'No such session',
				});
			}).not.toThrow();
		});
	});

	// ---------------------------------------------------------------------------
	// Outcome 2: Applies resolution policy based on rejectionCount
	// ---------------------------------------------------------------------------

	describe('applies resolution policy per configuration', () => {
		test('uses self_resolve policy when rejectionCount < 3', () => {
			ensureAgentSession(SESSION_ID, 'architect');

			const received: Array<{
				event: string;
				data: Record<string, unknown>;
			}> = [];
			addTelemetryListener((event, data) => received.push({ event, data }));

			resolveAgentConflict({
				sessionID: SESSION_ID,
				phase: 1,
				taskId: 'task-2',
				sourceAgent: 'reviewer',
				targetAgent: 'coder',
				conflictType: 'feedback_rejection',
				rejectionCount: 2,
				summary: 'Below threshold',
			});

			const session = ensureAgentSession(SESSION_ID);
			expect(session.pendingAdvisoryMessages![0]).toContain(
				'CONFLICT DETECTED',
			);
			expect(session.pendingAdvisoryMessages![0]).not.toContain(
				'CONFLICT ESCALATION',
			);

			const found = received.find((r) => r.event === 'agent_conflict_detected');
			expect(found).toBeDefined();
			expect(found!.data).toMatchObject({
				resolutionPath: 'self_resolve',
				sourceAgent: 'reviewer',
				targetAgent: 'coder',
			});
		});

		test('uses soundingboard policy when rejectionCount >= 3', () => {
			ensureAgentSession(SESSION_ID, 'architect');

			const received: Array<{
				event: string;
				data: Record<string, unknown>;
			}> = [];
			addTelemetryListener((event, data) => received.push({ event, data }));

			resolveAgentConflict({
				sessionID: SESSION_ID,
				phase: 2,
				taskId: 'task-3',
				sourceAgent: 'coder',
				targetAgent: 'reviewer',
				conflictType: 'retry_spiral',
				rejectionCount: 3,
				summary: 'Three failed cycles',
			});

			const session = ensureAgentSession(SESSION_ID);
			expect(session.pendingAdvisoryMessages![0]).toContain(
				'CONFLICT ESCALATION',
			);
			expect(session.pendingAdvisoryMessages![0]).toContain('SOUNDING_BOARD');

			const found = received.find((r) => r.event === 'agent_conflict_detected');
			expect(found).toBeDefined();
			expect(found!.data).toMatchObject({
				resolutionPath: 'soundingboard',
				sourceAgent: 'coder',
				targetAgent: 'reviewer',
			});
		});

		test('defaults rejectionCount to 0 when not provided (self_resolve path)', () => {
			ensureAgentSession(SESSION_ID, 'architect');

			const received: Array<{
				event: string;
				data: Record<string, unknown>;
			}> = [];
			addTelemetryListener((event, data) => received.push({ event, data }));

			resolveAgentConflict({
				sessionID: SESSION_ID,
				phase: 1,
				sourceAgent: 'test_engineer',
				targetAgent: 'coder',
				conflictType: 'scope_disagreement',
				summary: 'No rejectionCount provided',
			});

			const session = ensureAgentSession(SESSION_ID);
			expect(session.pendingAdvisoryMessages).toHaveLength(1);
			expect(session.pendingAdvisoryMessages![0]).toContain(
				'CONFLICT DETECTED',
			);

			const found = received.find((r) => r.event === 'agent_conflict_detected');
			expect(found!.data).toMatchObject({ resolutionPath: 'self_resolve' });
		});

		test('escalation fires at exactly 3 rejections', () => {
			ensureAgentSession(SESSION_ID, 'architect');

			resolveAgentConflict({
				sessionID: SESSION_ID,
				phase: 1,
				sourceAgent: 'architect',
				targetAgent: 'critic',
				conflictType: 'quality_gate_dispute',
				rejectionCount: 3,
				summary: 'Exactly three',
			});

			const session = ensureAgentSession(SESSION_ID);
			expect(session.pendingAdvisoryMessages![0]).toContain(
				'CONFLICT ESCALATION',
			);
		});

		test('escalation fires for rejectionCount > 3', () => {
			ensureAgentSession(SESSION_ID, 'architect');

			resolveAgentConflict({
				sessionID: SESSION_ID,
				phase: 1,
				sourceAgent: 'architect',
				targetAgent: 'critic',
				conflictType: 'quality_gate_dispute',
				rejectionCount: 7,
				summary: 'Seven cycles',
			});

			const session = ensureAgentSession(SESSION_ID);
			expect(session.pendingAdvisoryMessages![0]).toContain(
				'CONFLICT ESCALATION',
			);
		});

		test('self_resolve fires for rejectionCount = 0', () => {
			ensureAgentSession(SESSION_ID, 'architect');

			resolveAgentConflict({
				sessionID: SESSION_ID,
				phase: 1,
				sourceAgent: 'architect',
				targetAgent: 'critic',
				conflictType: 'authority_collision',
				rejectionCount: 0,
				summary: 'Zero rejections',
			});

			const session = ensureAgentSession(SESSION_ID);
			expect(session.pendingAdvisoryMessages![0]).toContain(
				'CONFLICT DETECTED',
			);
			expect(session.pendingAdvisoryMessages![0]).not.toContain(
				'CONFLICT ESCALATION',
			);
		});
	});

	// ---------------------------------------------------------------------------
	// Outcome 3: Emits a conflict event for downstream consumers
	// ---------------------------------------------------------------------------

	describe('emits a conflict event for downstream consumers', () => {
		test('emits agent_conflict_detected event with correct shape', () => {
			ensureAgentSession(SESSION_ID, 'architect');

			const received: Array<{
				event: string;
				data: Record<string, unknown>;
			}> = [];
			addTelemetryListener((event, data) => received.push({ event, data }));

			resolveAgentConflict({
				sessionID: SESSION_ID,
				phase: 2,
				taskId: 'task-4',
				sourceAgent: 'reviewer',
				targetAgent: 'test_engineer',
				conflictType: 'quality_gate_dispute',
				rejectionCount: 2,
				summary: 'Quality dispute',
			});

			const found = received.find((r) => r.event === 'agent_conflict_detected');
			expect(found).toBeDefined();
			expect(found!.data).toMatchObject({
				type: 'agent_conflict_detected',
				sessionId: SESSION_ID,
				phase: 2,
				taskId: 'task-4',
				sourceAgent: 'reviewer',
				targetAgent: 'test_engineer',
				conflictType: 'quality_gate_dispute',
				resolutionPath: 'self_resolve',
				summary: 'Quality dispute',
			});
			// timestamp is auto-generated; verify it is an ISO string
			expect(typeof (found!.data as { timestamp: string }).timestamp).toBe(
				'string',
			);
			expect((found!.data as { timestamp: string }).timestamp).toMatch(
				/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
			);
		});

		test('emits soundingboard event shape when rejectionCount >= 3', () => {
			ensureAgentSession(SESSION_ID, 'architect');

			const received: Array<{
				event: string;
				data: Record<string, unknown>;
			}> = [];
			addTelemetryListener((event, data) => received.push({ event, data }));

			resolveAgentConflict({
				sessionID: SESSION_ID,
				phase: 3,
				taskId: 'task-5',
				sourceAgent: 'coder',
				targetAgent: 'architect',
				conflictType: 'retry_spiral',
				rejectionCount: 4,
				summary: 'Spiralling',
			});

			const found = received.find((r) => r.event === 'agent_conflict_detected');
			expect(found).toBeDefined();
			expect(found!.data).toMatchObject({
				resolutionPath: 'soundingboard',
				conflictType: 'retry_spiral',
				taskId: 'task-5',
			});
		});

		test('emits event only when session exists (no session = no event emitted)', () => {
			const received: Array<{
				event: string;
				data: Record<string, unknown>;
			}> = [];
			addTelemetryListener((event, data) => received.push({ event, data }));

			// resolveAgentConflict no-ops when session missing and also does not emit
			resolveAgentConflict({
				sessionID: 'missing-session',
				phase: 1,
				sourceAgent: 'reviewer',
				targetAgent: 'coder',
				conflictType: 'feedback_rejection',
				rejectionCount: 1,
				summary: 'Missing session',
			});

			const found = received.find((r) => r.event === 'agent_conflict_detected');
			// Session does not exist → early return before event emission
			expect(found).toBeUndefined();
		});

		test('emits event with all conflictType variants', () => {
			ensureAgentSession(SESSION_ID, 'architect');

			const conflictTypes = [
				'feedback_rejection',
				'authority_collision',
				'retry_spiral',
				'scope_disagreement',
				'quality_gate_dispute',
			] as const;

			for (const conflictType of conflictTypes) {
				const received: Array<{
					event: string;
					data: Record<string, unknown>;
				}> = [];
				addTelemetryListener((event, data) => received.push({ event, data }));

				resolveAgentConflict({
					sessionID: SESSION_ID,
					phase: 1,
					taskId: `task-${conflictType}`,
					sourceAgent: 'architect',
					targetAgent: 'coder',
					conflictType,
					rejectionCount: 0,
					summary: `Testing ${conflictType}`,
				});

				const found = received.find(
					(r) => r.event === 'agent_conflict_detected',
				);
				expect(found!.data).toMatchObject({ conflictType });
			}
		});

		test('multiple sequential calls emit one event each', () => {
			ensureAgentSession(SESSION_ID, 'architect');

			const received: Array<{
				event: string;
				data: Record<string, unknown>;
			}> = [];
			addTelemetryListener((event, data) => received.push({ event, data }));

			resolveAgentConflict({
				sessionID: SESSION_ID,
				phase: 1,
				sourceAgent: 'reviewer',
				targetAgent: 'coder',
				conflictType: 'feedback_rejection',
				rejectionCount: 1,
				summary: 'First',
			});

			resolveAgentConflict({
				sessionID: SESSION_ID,
				phase: 1,
				sourceAgent: 'reviewer',
				targetAgent: 'coder',
				conflictType: 'feedback_rejection',
				rejectionCount: 2,
				summary: 'Second',
			});

			const events = received.filter(
				(r) => r.event === 'agent_conflict_detected',
			);
			expect(events).toHaveLength(2);
			expect(events[0].data).toMatchObject({ summary: 'First' });
			expect(events[1].data).toMatchObject({ summary: 'Second' });
		});
	});
});
