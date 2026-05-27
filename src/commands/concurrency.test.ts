/**
 * Tests for handleConcurrencyCommand function
 * Tests the /swarm concurrency command set/reset/status functionality
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { Plan } from '../../src/plan/manager';
import { getAgentSession, swarmState } from '../../src/state';

// Create mock functions BEFORE module mock
const mockLoadPlanJsonOnly = mock(async () => null);

// Mock the plan/manager module
mock.module('../../src/plan/manager.js', () => ({
	loadPlanJsonOnly: mockLoadPlanJsonOnly,
	_snapshot_test_exports: {},
}));

// Import after mocking - use dynamic import to ensure mock is in place
const { handleConcurrencyCommand } = await import(
	'../../src/commands/concurrency'
);

// Helper to create a test session in swarmState.agentSessions
function createTestSession(sessionId: string): void {
	swarmState.agentSessions.set(sessionId, {
		agentName: 'architect',
		lastToolCallTime: Date.now(),
		lastAgentEventTime: Date.now(),
		delegationActive: false,
		activeInvocationId: 0,
		lastInvocationIdByAgent: {},
		windows: {},
		lastCompactionHint: 0,
		architectWriteCount: 0,
		lastCoderDelegationTaskId: null,
		currentTaskId: null,
		gateLog: new Map(),
		reviewerCallCount: new Map(),
		lastGateFailure: null,
		partialGateWarningsIssuedForTask: new Set(),
		selfFixAttempted: false,
		selfCodingWarnedAtCount: 0,
		catastrophicPhaseWarnings: new Set(),
		qaSkipCount: 0,
		qaSkipTaskIds: [],
		taskWorkflowStates: new Map(),
		lastGateOutcome: null,
		declaredCoderScope: null,
		lastScopeViolation: null,
		modifiedFilesThisCoderTask: [],
		lastPhaseCompleteTimestamp: 0,
		lastPhaseCompletePhase: 0,
		phaseAgentsDispatched: new Set(),
		lastCompletedPhaseAgentsDispatched: new Set(),
		turboMode: false,
		fullAutoMode: false,
		fullAutoInteractionCount: 0,
		fullAutoDeadlockCount: 0,
		fullAutoLastQuestionHash: null,
		coderRevisions: 0,
		revisionLimitHit: false,
		model_fallback_index: 0,
		modelFallbackExhausted: false,
		sessionRehydratedAt: 0,
		prmPatternCounts: new Map(),
		prmEscalationLevel: 0,
		prmLastPatternDetected: null,
		prmTrajectoryStep: 0,
		prmHardStopPending: false,
		maxConcurrencyOverride: undefined,
	});
}

// Helper to create a plan with execution_profile
function makePlanWithExecutionProfile(
	overrides?: Partial<Plan['execution_profile']>,
): Plan {
	return {
		schema_version: '1.0.0',
		title: 'Test Project',
		swarm: 'mega',
		current_phase: 1,
		phases: [],
		execution_profile: {
			max_concurrent_tasks: 4,
			parallelization_enabled: true,
			...overrides,
		},
	} as Plan;
}

describe('handleConcurrencyCommand', () => {
	let testSessionId: string;
	const testDirectory = '/test/project';

	beforeEach(() => {
		testSessionId = `concurrency-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		createTestSession(testSessionId);
		mockLoadPlanJsonOnly.mockClear();
		mockLoadPlanJsonOnly.mockImplementation(() =>
			Promise.resolve(makePlanWithExecutionProfile()),
		);
	});

	afterEach(() => {
		swarmState.agentSessions.delete(testSessionId);
		mockLoadPlanJsonOnly.mockReset();
		mock.restore();
	});

	function getSession() {
		const session = getAgentSession(testSessionId);
		if (!session) {
			throw new Error('Session not found');
		}
		return session;
	}

	// ── Error Path: Session Validation ─────────────────────────────────────────

	describe('Error Path - Session Validation', () => {
		it('returns error for empty/blank sessionID', async () => {
			const result = await handleConcurrencyCommand(testDirectory, [], '   ');

			expect(result).toBe(
				'Error: No active session context. Concurrency requires an active session. Use /swarm concurrency from within an OpenCode session, or start a session first.',
			);
		});

		it('returns error for non-existent session', async () => {
			const result = await handleConcurrencyCommand(
				testDirectory,
				[],
				'non-existent-session',
			);

			expect(result).toBe(
				'Error: No active session. Concurrency requires an active session to operate.',
			);
		});
	});

	// ── Error Path: Usage Errors ───────────────────────────────────────────────

	describe('Error Path - Usage Errors', () => {
		it('shows usage when no args provided', async () => {
			const result = await handleConcurrencyCommand(
				testDirectory,
				[],
				testSessionId,
			);

			expect(result).toContain('Concurrency commands:');
			expect(result).toContain('/swarm concurrency set');
			expect(result).toContain('/swarm concurrency status');
			expect(result).toContain('/swarm concurrency reset');
		});

		it('returns error for unknown subcommand', async () => {
			const result = await handleConcurrencyCommand(
				testDirectory,
				['invalid'],
				testSessionId,
			);

			expect(result).toContain('Unknown concurrency subcommand: invalid');
			expect(result).toContain('Usage: /swarm concurrency <set|status|reset>');
		});

		it('returns error when set has no value', async () => {
			const result = await handleConcurrencyCommand(
				testDirectory,
				['set'],
				testSessionId,
			);

			expect(result).toBe(
				'Error: /swarm concurrency set requires a value. Usage: /swarm concurrency set <N|preset>',
			);
		});
	});

	// ── Happy Path: set with valid integers ───────────────────────────────────

	describe('Happy Path - set with valid integers', () => {
		it('sets maxConcurrencyOverride to 1', async () => {
			const result = await handleConcurrencyCommand(
				testDirectory,
				['set', '1'],
				testSessionId,
			);

			expect(result).toBe('Concurrency override set to 1');
			expect(getSession().maxConcurrencyOverride).toBe(1);
		});

		it('sets maxConcurrencyOverride to 5', async () => {
			const result = await handleConcurrencyCommand(
				testDirectory,
				['set', '5'],
				testSessionId,
			);

			expect(result).toBe('Concurrency override set to 5');
			expect(getSession().maxConcurrencyOverride).toBe(5);
		});

		it('sets maxConcurrencyOverride to 64', async () => {
			const result = await handleConcurrencyCommand(
				testDirectory,
				['set', '64'],
				testSessionId,
			);

			expect(result).toBe('Concurrency override set to 64');
			expect(getSession().maxConcurrencyOverride).toBe(64);
		});
	});

	// ── Error Path: set with invalid values ───────────────────────────────────

	describe('Error Path - set with invalid values', () => {
		it('returns error for value < 1', async () => {
			const result = await handleConcurrencyCommand(
				testDirectory,
				['set', '0'],
				testSessionId,
			);

			expect(result).toBe(
				'Concurrency value 0 is out of range. Must be between 1 and 64.',
			);
		});

		it('returns error for value > 64', async () => {
			const result = await handleConcurrencyCommand(
				testDirectory,
				['set', '65'],
				testSessionId,
			);

			expect(result).toBe(
				'Concurrency value 65 is out of range. Must be between 1 and 64.',
			);
		});

		it('returns error for negative value', async () => {
			const result = await handleConcurrencyCommand(
				testDirectory,
				['set', '-5'],
				testSessionId,
			);

			expect(result).toBe(
				'Concurrency value -5 is out of range. Must be between 1 and 64.',
			);
		});

		it('returns error for float value', async () => {
			const result = await handleConcurrencyCommand(
				testDirectory,
				['set', '3.5'],
				testSessionId,
			);

			expect(result).toBe(
				'Invalid concurrency value: 3.5. Must be a number (1-64) or a preset (min, medium, max).',
			);
		});

		it('returns error for non-numeric string', async () => {
			const result = await handleConcurrencyCommand(
				testDirectory,
				['set', 'abc'],
				testSessionId,
			);

			expect(result).toBe(
				'Invalid concurrency value: abc. Must be a number (1-64) or a preset (min, medium, max).',
			);
		});

		it('returns error for unknown preset', async () => {
			const result = await handleConcurrencyCommand(
				testDirectory,
				['set', 'huge'],
				testSessionId,
			);

			expect(result).toBe(
				'Invalid concurrency value: huge. Must be a number (1-64) or a preset (min, medium, max).',
			);
		});
	});

	// ── Happy Path: set with presets ─────────────────────────────────────────

	describe('Happy Path - set with presets', () => {
		it('set min sets to 1', async () => {
			const result = await handleConcurrencyCommand(
				testDirectory,
				['set', 'min'],
				testSessionId,
			);

			expect(result).toBe('Concurrency override set to 1 (min)');
			expect(getSession().maxConcurrencyOverride).toBe(1);
		});

		it('set medium sets to 3', async () => {
			const result = await handleConcurrencyCommand(
				testDirectory,
				['set', 'medium'],
				testSessionId,
			);

			expect(result).toBe('Concurrency override set to 3 (medium)');
			expect(getSession().maxConcurrencyOverride).toBe(3);
		});

		it('set max sets to 8', async () => {
			const result = await handleConcurrencyCommand(
				testDirectory,
				['set', 'max'],
				testSessionId,
			);

			expect(result).toBe('Concurrency override set to 8 (max)');
			expect(getSession().maxConcurrencyOverride).toBe(8);
		});

		it('presets are case-insensitive', async () => {
			const result = await handleConcurrencyCommand(
				testDirectory,
				['set', 'MEDIUM'],
				testSessionId,
			);

			expect(result).toBe('Concurrency override set to 3 (medium)');
			expect(getSession().maxConcurrencyOverride).toBe(3);
		});
	});

	// ── Happy Path: reset ─────────────────────────────────────────────────────

	describe('Happy Path - reset', () => {
		it('reset clears maxConcurrencyOverride', async () => {
			// First set a value
			await handleConcurrencyCommand(
				testDirectory,
				['set', '5'],
				testSessionId,
			);
			expect(getSession().maxConcurrencyOverride).toBe(5);

			// Then reset
			const result = await handleConcurrencyCommand(
				testDirectory,
				['reset'],
				testSessionId,
			);

			expect(result).toBe('Concurrency override cleared');
			expect(getSession().maxConcurrencyOverride).toBeUndefined();
		});

		it('reset works when no override is set', async () => {
			expect(getSession().maxConcurrencyOverride).toBeUndefined();

			const result = await handleConcurrencyCommand(
				testDirectory,
				['reset'],
				testSessionId,
			);

			expect(result).toBe('Concurrency override cleared');
			expect(getSession().maxConcurrencyOverride).toBeUndefined();
		});
	});

	// ── Happy Path: status ────────────────────────────────────────────────────

	describe('Happy Path - status', () => {
		it('status without plan shows "No active plan"', async () => {
			mockLoadPlanJsonOnly.mockImplementation(() => Promise.resolve(null));

			const result = await handleConcurrencyCommand(
				testDirectory,
				['status'],
				testSessionId,
			);

			expect(result).toContain('No active plan');
		});

		it('status with plan and override set shows override_active: true', async () => {
			mockLoadPlanJsonOnly.mockImplementation(() =>
				Promise.resolve(makePlanWithExecutionProfile()),
			);

			// Set an override
			await handleConcurrencyCommand(
				testDirectory,
				['set', '5'],
				testSessionId,
			);

			const result = await handleConcurrencyCommand(
				testDirectory,
				['status'],
				testSessionId,
			);

			expect(result).toContain('override_active: true');
			expect(result).toContain('configured_override: 5');
		});

		it('status with plan and no override shows override_active: false', async () => {
			mockLoadPlanJsonOnly.mockImplementation(() =>
				Promise.resolve(makePlanWithExecutionProfile()),
			);

			const result = await handleConcurrencyCommand(
				testDirectory,
				['status'],
				testSessionId,
			);

			expect(result).toContain('override_active: false');
			expect(result).toContain('configured_override: absent');
		});

		it('status with plan that has parallelization disabled shows parallelization disabled', async () => {
			mockLoadPlanJsonOnly.mockImplementation(() =>
				Promise.resolve(
					makePlanWithExecutionProfile({ parallelization_enabled: false }),
				),
			);

			const result = await handleConcurrencyCommand(
				testDirectory,
				['status'],
				testSessionId,
			);

			expect(result).toContain('Parallelization disabled (always 1)');
			expect(result).toContain('parallelization_enabled: false');
		});
	});

	// ── SC-006: Session reset clears override ─────────────────────────────────

	describe('SC-006: Session reset clears override', () => {
		it('session reset clears maxConcurrencyOverride', async () => {
			// Set an override
			await handleConcurrencyCommand(
				testDirectory,
				['set', '7'],
				testSessionId,
			);
			expect(getSession().maxConcurrencyOverride).toBe(7);

			// Simulate session reset by deleting and recreating the session
			swarmState.agentSessions.delete(testSessionId);
			createTestSession(testSessionId);

			// Verify override is cleared
			expect(getSession().maxConcurrencyOverride).toBeUndefined();
		});
	});

	// ── SC-005: Plan.json NOT mutated ─────────────────────────────────────────

	describe('SC-005: Plan.json NOT mutated', () => {
		it('plan.json execution_profile is not mutated by set command', async () => {
			const originalPlan = makePlanWithExecutionProfile({
				max_concurrent_tasks: 4,
			});
			mockLoadPlanJsonOnly.mockImplementation(() =>
				Promise.resolve(originalPlan),
			);

			// Set an override
			await handleConcurrencyCommand(
				testDirectory,
				['set', '10'],
				testSessionId,
			);

			// Verify the original plan object was not modified
			expect(originalPlan.execution_profile?.max_concurrent_tasks).toBe(4);
			expect(originalPlan.execution_profile?.parallelization_enabled).toBe(
				true,
			);
		});

		it('plan.json execution_profile is not mutated by status command', async () => {
			const originalPlan = makePlanWithExecutionProfile({
				max_concurrent_tasks: 4,
			});
			mockLoadPlanJsonOnly.mockImplementation(() =>
				Promise.resolve(originalPlan),
			);

			// Check status multiple times
			await handleConcurrencyCommand(testDirectory, ['status'], testSessionId);
			await handleConcurrencyCommand(testDirectory, ['status'], testSessionId);

			// Verify the original plan object was not modified
			expect(originalPlan.execution_profile?.max_concurrent_tasks).toBe(4);
			expect(originalPlan.execution_profile?.parallelization_enabled).toBe(
				true,
			);
		});

		it('plan.json execution_profile is not mutated by reset command', async () => {
			const originalPlan = makePlanWithExecutionProfile({
				max_concurrent_tasks: 4,
			});
			mockLoadPlanJsonOnly.mockImplementation(() =>
				Promise.resolve(originalPlan),
			);

			// Set then reset
			await handleConcurrencyCommand(
				testDirectory,
				['set', '10'],
				testSessionId,
			);
			await handleConcurrencyCommand(testDirectory, ['reset'], testSessionId);

			// Verify the original plan object was not modified
			expect(originalPlan.execution_profile?.max_concurrent_tasks).toBe(4);
		});
	});

	// ── State Mutation Verification ────────────────────────────────────────────

	describe('State Mutation Verification', () => {
		it('persists maxConcurrencyOverride change across multiple calls', async () => {
			// Initial: maxConcurrencyOverride = undefined
			expect(getSession().maxConcurrencyOverride).toBeUndefined();

			// Set to 3
			await handleConcurrencyCommand(
				testDirectory,
				['set', '3'],
				testSessionId,
			);
			expect(getSession().maxConcurrencyOverride).toBe(3);

			// Set to 8
			await handleConcurrencyCommand(
				testDirectory,
				['set', '8'],
				testSessionId,
			);
			expect(getSession().maxConcurrencyOverride).toBe(8);

			// Reset
			await handleConcurrencyCommand(testDirectory, ['reset'], testSessionId);
			expect(getSession().maxConcurrencyOverride).toBeUndefined();
		});

		it('does not modify other session properties when setting override', async () => {
			const session = getSession();
			const originalAgentName = session.agentName;
			const originalDelegationActive = session.delegationActive;
			const originalLastToolCallTime = session.lastToolCallTime;

			await handleConcurrencyCommand(
				testDirectory,
				['set', '5'],
				testSessionId,
			);

			expect(session.agentName).toBe(originalAgentName);
			expect(session.delegationActive).toBe(originalDelegationActive);
			expect(session.lastToolCallTime).toBe(originalLastToolCallTime);
		});

		it('does not modify other session properties when resetting override', async () => {
			const session = getSession();
			session.maxConcurrencyOverride = 5;

			const originalAgentName = session.agentName;
			const originalDelegationActive = session.delegationActive;

			await handleConcurrencyCommand(testDirectory, ['reset'], testSessionId);

			expect(session.agentName).toBe(originalAgentName);
			expect(session.delegationActive).toBe(originalDelegationActive);
			expect(session.maxConcurrencyOverride).toBeUndefined();
		});
	});
});
