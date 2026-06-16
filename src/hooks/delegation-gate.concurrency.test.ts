/**
 * delegation-gate.concurrency.test.ts
 *
 * Tests for buildParallelExecutionGuidance function which provides parallel execution
 * guidance based on plan execution_profile and session maxConcurrencyOverride.
 *
 * Tests the precedence matrix:
 * 1. Override takes precedence over plan baseline
 * 2. Plan fallback when no override
 * 3. Lean Turbo bypass
 * 4. parallelization_disabled returns null
 * 5. No plan returns null
 * 6. Override with plan baseline verifies correct max_concurrent_tasks in message
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { Plan } from '../plan/manager';
import type { AgentSessionState } from '../state';
import { resetSwarmState, swarmState } from '../state';
import { _internals } from './delegation-gate';

// Create mock functions BEFORE module mock
const mockLoadPlanJsonOnly = mock(async () => null);

// Mock the plan/manager module
mock.module('../plan/manager.js', () => ({
	loadPlanJsonOnly: mockLoadPlanJsonOnly,
	_snapshot_test_exports: {},
}));

// Restore mocks after each test to prevent cross-test pollution when this
// file is batched with other delegation*.test.ts files in the same process.
afterEach(() => {
	mock.restore();
});

// We need to import the module after mocking
const { _internals: delegationGateInternals } = await import(
	'./delegation-gate'
);
const { buildParallelExecutionGuidance } = delegationGateInternals;

// Helper to create a minimal plan with execution_profile
function makePlan(
	overrides?: Partial<Plan['execution_profile']> & { current_phase?: number },
): Plan {
	return {
		schema_version: '1.0.0',
		title: 'Test Project',
		swarm: 'mega',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'in_progress',
				tasks: [
					{
						id: '1.1',
						description: 'Task 1.1',
						status: 'pending',
						depends: [],
					},
					{
						id: '1.2',
						description: 'Task 1.2',
						status: 'pending',
						depends: ['1.1'],
					},
					{
						id: '1.3',
						description: 'Task 1.3',
						status: 'pending',
						depends: ['1.1'],
					},
					{
						id: '1.4',
						description: 'Task 1.4',
						status: 'pending',
						depends: ['1.2', '1.3'],
					},
				],
			},
		],
		execution_profile: {
			max_concurrent_tasks: 2,
			parallelization_enabled: true,
			...overrides,
		},
	} as Plan;
}

// Helper to create a test session with all required fields
function createTestSession(
	sessionId: string,
	overrides?: Partial<AgentSessionState>,
): AgentSessionState {
	const session: AgentSessionState = {
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
		lastPhaseCompleteTimestamp: 0,
		lastPhaseCompletePhase: 0,
		phaseAgentsDispatched: new Set(),
		lastCompletedPhaseAgentsDispatched: new Set(),
		qaSkipCount: 0,
		qaSkipTaskIds: [],
		taskWorkflowStates: new Map(),
		lastGateOutcome: null,
		declaredCoderScope: null,
		lastScopeViolation: null,
		scopeViolationDetected: undefined,
		modifiedFilesThisCoderTask: [],
		sessionRehydratedAt: 0,
		prmPatternCounts: new Map(),
		prmEscalationLevel: 0,
		prmLastPatternDetected: null,
		prmTrajectoryStep: 0,
		prmHardStopPending: false,
		turboMode: false,
		turboStrategy: undefined,
		leanTurboActive: false,
		fullAutoMode: false,
		fullAutoInteractionCount: 0,
		fullAutoDeadlockCount: 0,
		fullAutoLastQuestionHash: null,
		coderRevisions: 0,
		revisionLimitHit: false,
		model_fallback_index: 0,
		modelFallbackExhausted: false,
		maxConcurrencyOverride: undefined,
		...overrides,
	};
	swarmState.agentSessions.set(sessionId, session);
	return session;
}

describe('buildParallelExecutionGuidance', () => {
	const testDirectory = '/test/project';

	beforeEach(() => {
		resetSwarmState();
		mockLoadPlanJsonOnly.mockClear();
		mockLoadPlanJsonOnly.mockImplementation(() => Promise.resolve(null));
	});

	afterEach(() => {
		resetSwarmState();
		mockLoadPlanJsonOnly.mockReset();
		mock.restore();
	});

	// ── Test 1: Override takes precedence ──────────────────────────────────────
	it('Override takes precedence over plan baseline max_concurrent_tasks', async () => {
		const plan = makePlan({ max_concurrent_tasks: 2 });
		mockLoadPlanJsonOnly.mockImplementation(() => Promise.resolve(plan));

		const sessionId = 'test-override-precedence';
		createTestSession(sessionId, { maxConcurrencyOverride: 5 });

		const result = await buildParallelExecutionGuidance(
			testDirectory,
			sessionId,
			swarmState.agentSessions.get(sessionId)!,
		);

		expect(result).not.toBeNull();
		// The override value (5) should appear in the output, not the plan value (2)
		expect(result).toContain('max_concurrent_tasks=5');
		expect(result).not.toContain('max_concurrent_tasks=2');
	});

	// ── Test 2: Plan fallback when no override ──────────────────────────────────
	it('Plan baseline is used when no session override is set', async () => {
		const plan = makePlan({ max_concurrent_tasks: 2 });
		mockLoadPlanJsonOnly.mockImplementation(() => Promise.resolve(plan));

		const sessionId = 'test-plan-fallback';
		// maxConcurrencyOverride is undefined by default
		createTestSession(sessionId);

		const result = await buildParallelExecutionGuidance(
			testDirectory,
			sessionId,
			swarmState.agentSessions.get(sessionId)!,
		);

		expect(result).not.toBeNull();
		// Should use plan's max_concurrent_tasks=2
		expect(result).toContain('max_concurrent_tasks=2');
	});

	// ── Test 3: Lean Turbo bypass ───────────────────────────────────────────────
	it('Lean Turbo bypass returns Lean Turbo message instead of override guidance', async () => {
		const plan = makePlan({ max_concurrent_tasks: 2 });
		mockLoadPlanJsonOnly.mockImplementation(() => Promise.resolve(plan));

		const sessionId = 'test-lean-turbo-bypass';
		// Set up Lean Turbo session state for hasActiveLeanTurbo to return true
		// (turboMode: true, turboStrategy: 'lean', leanTurboActive: true)
		createTestSession(sessionId, {
			maxConcurrencyOverride: 5,
			turboMode: true,
			turboStrategy: 'lean',
			leanTurboActive: true,
		});

		const result = await buildParallelExecutionGuidance(
			testDirectory,
			sessionId,
			swarmState.agentSessions.get(sessionId)!,
		);

		expect(result).not.toBeNull();
		expect(result).toContain('Lean Turbo');
		// Should NOT contain override value when Lean Turbo is active
		expect(result).not.toContain('max_concurrent_tasks=5');
	});

	// ── Test 4: parallelization_disabled returns null ───────────────────────────
	it('Returns null when parallelization_enabled=false regardless of override', async () => {
		const plan = makePlan({
			max_concurrent_tasks: 2,
			parallelization_enabled: false,
		});
		mockLoadPlanJsonOnly.mockImplementation(() => Promise.resolve(plan));

		const sessionId = 'test-parallelization-disabled';
		createTestSession(sessionId, { maxConcurrencyOverride: 5 });

		const result = await buildParallelExecutionGuidance(
			testDirectory,
			sessionId,
			swarmState.agentSessions.get(sessionId)!,
		);

		expect(result).toBeNull();
	});

	// ── Test 5: No plan returns null ────────────────────────────────────────────
	it('Returns null when loadPlanJsonOnly returns null', async () => {
		mockLoadPlanJsonOnly.mockImplementation(() => Promise.resolve(null));

		const sessionId = 'test-no-plan';
		createTestSession(sessionId, { maxConcurrencyOverride: 5 });

		const result = await buildParallelExecutionGuidance(
			testDirectory,
			sessionId,
			swarmState.agentSessions.get(sessionId)!,
		);

		expect(result).toBeNull();
	});

	// ── Test 6: Override with plan baseline - verify correct max_concurrent_tasks ─
	it('Override changes slot count, verifying PARALLEL EXECUTION PROFILE contains correct value', async () => {
		const plan = makePlan({ max_concurrent_tasks: 3 });
		mockLoadPlanJsonOnly.mockImplementation(() => Promise.resolve(plan));

		const sessionId = 'test-override-value';
		// Set override to 4 (higher than plan's 3)
		createTestSession(sessionId, { maxConcurrencyOverride: 4 });

		const result = await buildParallelExecutionGuidance(
			testDirectory,
			sessionId,
			swarmState.agentSessions.get(sessionId)!,
		);

		expect(result).not.toBeNull();
		expect(result).toContain('PARALLEL EXECUTION PROFILE');
		expect(result).toContain('max_concurrent_tasks=4');
		expect(result).not.toContain('max_concurrent_tasks=3');
	});

	// ── Additional edge case: undefined directory ─────────────────────────────────
	it('Returns null when directory is undefined', async () => {
		const sessionId = 'test-undefined-dir';
		createTestSession(sessionId);

		const result = await buildParallelExecutionGuidance(
			undefined,
			sessionId,
			swarmState.agentSessions.get(sessionId)!,
		);

		expect(result).toBeNull();
	});

	// ── Additional edge case: empty directory string ─────────────────────────────
	it('Returns null when directory is empty string', async () => {
		const sessionId = 'test-empty-dir';
		createTestSession(sessionId);

		const result = await buildParallelExecutionGuidance(
			'',
			sessionId,
			swarmState.agentSessions.get(sessionId)!,
		);

		expect(result).toBeNull();
	});

	// ── Additional edge case: override of 1 (should return null) ─────────────────
	it('Returns null when effective max_concurrent_tasks is 1', async () => {
		const plan = makePlan({ max_concurrent_tasks: 1 });
		mockLoadPlanJsonOnly.mockImplementation(() => Promise.resolve(plan));

		const sessionId = 'test-override-one';
		createTestSession(sessionId);

		const result = await buildParallelExecutionGuidance(
			testDirectory,
			sessionId,
			swarmState.agentSessions.get(sessionId)!,
		);

		expect(result).toBeNull();
	});

	// ── Additional edge case: override of 0 (should return null) ────────────────
	it('Returns null when effective max_concurrent_tasks is 0', async () => {
		const plan = makePlan({ max_concurrent_tasks: 2 });
		mockLoadPlanJsonOnly.mockImplementation(() => Promise.resolve(plan));

		const sessionId = 'test-override-zero';
		createTestSession(sessionId, { maxConcurrencyOverride: 0 });

		const result = await buildParallelExecutionGuidance(
			testDirectory,
			sessionId,
			swarmState.agentSessions.get(sessionId)!,
		);

		expect(result).toBeNull();
	});

	// ── Additional: Override lower than plan baseline ────────────────────────────
	it('Override value lower than plan is used when set', async () => {
		const plan = makePlan({ max_concurrent_tasks: 8 });
		mockLoadPlanJsonOnly.mockImplementation(() => Promise.resolve(plan));

		const sessionId = 'test-override-lower';
		// Override with a lower value than plan
		createTestSession(sessionId, { maxConcurrencyOverride: 2 });

		const result = await buildParallelExecutionGuidance(
			testDirectory,
			sessionId,
			swarmState.agentSessions.get(sessionId)!,
		);

		expect(result).not.toBeNull();
		expect(result).toContain('max_concurrent_tasks=2');
		expect(result).not.toContain('max_concurrent_tasks=8');
	});

	// ── Additional: Override value of 1 via setConcurrencyOverride ───────────────
	it('Override of 1 disables parallel execution guidance', async () => {
		const plan = makePlan({ max_concurrent_tasks: 4 });
		mockLoadPlanJsonOnly.mockImplementation(() => Promise.resolve(plan));

		const sessionId = 'test-override-one-disable';
		createTestSession(sessionId, { maxConcurrencyOverride: 1 });

		const result = await buildParallelExecutionGuidance(
			testDirectory,
			sessionId,
			swarmState.agentSessions.get(sessionId)!,
		);

		expect(result).toBeNull();
	});

	// ── Additional: Plan with no execution_profile ───────────────────────────────
	it('Plan without execution_profile returns null when parallelization is disabled', async () => {
		const planWithoutProfile: Plan = {
			schema_version: '1.0.0',
			title: 'Test Project',
			swarm: 'mega',
			current_phase: 1,
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'in_progress',
					tasks: [
						{
							id: '1.1',
							description: 'Task 1.1',
							status: 'pending',
							depends: [],
						},
					],
				},
			],
			// No execution_profile
		} as Plan;
		mockLoadPlanJsonOnly.mockImplementation(() =>
			Promise.resolve(planWithoutProfile),
		);

		const sessionId = 'test-no-execution-profile';
		createTestSession(sessionId);

		const result = await buildParallelExecutionGuidance(
			testDirectory,
			sessionId,
			swarmState.agentSessions.get(sessionId)!,
		);

		// parallelization_enabled defaults to false when no execution_profile is present,
		// so result should be null because !enabled returns null (not because of max_concurrent_tasks)
		expect(result).toBeNull();
	});

	// ── Adaptive backoff on task failures ─────────────────────────────────────
	it('Adaptive backoff: reduces concurrency when >20% of tasks are blocked', async () => {
		const planWithBlockedTasks: Plan = {
			schema_version: '1.0.0',
			title: 'Test Project',
			swarm: 'mega',
			current_phase: 1,
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'in_progress',
					tasks: [
						{
							id: '1.1',
							description: 'Task 1.1',
							status: 'pending',
							depends: [],
						},
						{
							id: '1.2',
							description: 'Task 1.2',
							status: 'blocked',
							blocked_reason: 'Failed during execution',
							depends: [],
						},
						{
							id: '1.3',
							description: 'Task 1.3',
							status: 'blocked',
							blocked_reason: 'Failed during execution',
							depends: [],
						},
						{
							id: '1.4',
							description: 'Task 1.4',
							status: 'pending',
							depends: [],
						},
						{
							id: '1.5',
							description: 'Task 1.5',
							status: 'pending',
							depends: [],
						},
					],
				},
			],
			execution_profile: {
				max_concurrent_tasks: 10,
				parallelization_enabled: true,
				locked: false,
			},
		} as Plan;

		mockLoadPlanJsonOnly.mockImplementation(() =>
			Promise.resolve(planWithBlockedTasks),
		);

		const sessionId = 'test-adaptive-backoff';
		createTestSession(sessionId);
		const session = swarmState.agentSessions.get(sessionId)!;

		// Initial state: no override
		expect(session.maxConcurrencyOverride).toBeUndefined();

		const result = await buildParallelExecutionGuidance(
			testDirectory,
			sessionId,
			session,
		);

		// After backoff: concurrency should be reduced to 5 (50% of 10)
		// 2 blocked out of 5 tasks = 40% failure rate > 20% threshold
		expect(session.maxConcurrencyOverride).toBe(5);
		expect(result).toContain('blocked task(s) detected');
		expect(result).toContain('max_concurrent_tasks=5');
	});

	it('Adaptive backoff: does not reduce when failure rate is below threshold', async () => {
		const planWithMinorFailures: Plan = {
			schema_version: '1.0.0',
			title: 'Test Project',
			swarm: 'mega',
			current_phase: 1,
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'in_progress',
					tasks: [
						{
							id: '1.1',
							description: 'Task 1.1',
							status: 'pending',
							depends: [],
						},
						{
							id: '1.2',
							description: 'Task 1.2',
							status: 'completed',
							depends: [],
						},
						{
							id: '1.3',
							description: 'Task 1.3',
							status: 'completed',
							depends: [],
						},
						{
							id: '1.4',
							description: 'Task 1.4',
							status: 'blocked',
							blocked_reason: 'Failed',
							depends: [],
						},
						{
							id: '1.5',
							description: 'Task 1.5',
							status: 'pending',
							depends: [],
						},
					],
				},
			],
			execution_profile: {
				max_concurrent_tasks: 10,
				parallelization_enabled: true,
				locked: false,
			},
		} as Plan;

		mockLoadPlanJsonOnly.mockImplementation(() =>
			Promise.resolve(planWithMinorFailures),
		);

		const sessionId = 'test-no-backoff';
		createTestSession(sessionId);
		const session = swarmState.agentSessions.get(sessionId)!;

		const result = await buildParallelExecutionGuidance(
			testDirectory,
			sessionId,
			session,
		);

		// 1 blocked out of 5 = 20% exactly, which is not > 20%, so no reduction
		// The override should remain undefined (no automatic reduction)
		expect(session.maxConcurrencyOverride).toBeUndefined();
		// Result should not mention backoff when threshold is not exceeded
		if (result) {
			expect(result).not.toContain(
				'blocked task(s) detected — concurrency auto-reduced',
			);
		}
	});

	it('Adaptive backoff: does not reduce concurrency when effective max is already 1', async () => {
		const planWithMinConcurrency: Plan = {
			schema_version: '1.0.0',
			title: 'Test Project',
			swarm: 'mega',
			current_phase: 1,
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'in_progress',
					tasks: [
						{
							id: '1.1',
							description: 'Task 1.1',
							status: 'pending',
							depends: [],
						},
						{
							id: '1.2',
							description: 'Task 1.2',
							status: 'blocked',
							blocked_reason: 'Failed during execution',
							depends: [],
						},
						{
							id: '1.3',
							description: 'Task 1.3',
							status: 'blocked',
							blocked_reason: 'Failed during execution',
							depends: [],
						},
						{
							id: '1.4',
							description: 'Task 1.4',
							status: 'pending',
							depends: [],
						},
						{
							id: '1.5',
							description: 'Task 1.5',
							status: 'pending',
							depends: [],
						},
					],
				},
			],
			execution_profile: {
				max_concurrent_tasks: 1,
				parallelization_enabled: true,
				locked: false,
			},
		} as Plan;

		mockLoadPlanJsonOnly.mockImplementation(() =>
			Promise.resolve(planWithMinConcurrency),
		);

		const sessionId = 'test-no-backoff-min-concurrency';
		createTestSession(sessionId);
		const session = swarmState.agentSessions.get(sessionId)!;

		// Initial state: no override
		expect(session.maxConcurrencyOverride).toBeUndefined();

		const result = await buildParallelExecutionGuidance(
			testDirectory,
			sessionId,
			session,
		);

		// Even though 2 blocked out of 5 = 40% > 20% threshold,
		// Math.max(1, Math.floor(1 * 0.5)) = Math.max(1, 0) = 1
		// Since effective max is already 1, no backoff should trigger (1 < 1 is false)
		expect(session.maxConcurrencyOverride).toBeUndefined();
		// Result should not contain backoff message since no reduction occurred
		if (result) {
			expect(result).not.toContain('concurrency auto-reduced');
		}
	});
});
