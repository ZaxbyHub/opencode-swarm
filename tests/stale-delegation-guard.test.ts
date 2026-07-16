/**
 * Adversarial tests for stale-delegation takeover guard in src/index.ts
 *
 * Tests attack vectors:
 * 1. Long-running tool timing - stale-delegation shouldn't trigger while tool runs >10s
 * 2. Concurrent calls in same session - other in-flight calls should block stale reset
 * 3. Cross-session interference - different sessions shouldn't interfere
 * 4. Missing cleanup - orphaned entries shouldn't cause incorrect blocking
 * 5. Force architect takeover during active subagent execution - Task tool handoff
 */

import { beforeEach, describe, expect, it } from 'bun:test';
import { ORCHESTRATOR_NAME } from '../src/config/constants';
import { stripKnownSwarmPrefix } from '../src/config/schema';
import { resetSwarmState, swarmState, type ToolCallEntry } from '../src/state';
import { withFrozenClockAsync } from './helpers/test-clock';

// Mock the tool.execute.before logic directly from src/index.ts
// This tests the actual stale-delegation guard logic
async function executeToolBeforeGuard(input: {
	tool: string;
	sessionID: string;
	callID: string;
}): Promise<{ activeAgent: string; blocked: boolean }> {
	// If no active agent is mapped for this session, it's the primary agent (architect)
	if (!swarmState.activeAgent.has(input.sessionID)) {
		swarmState.activeAgent.set(input.sessionID, ORCHESTRATOR_NAME);
	}

	// Register current tool call BEFORE stale-delegation check
	// This is the v6.26 fix: prevents stale-delegation from incorrectly resetting
	// while a tool call is already in progress for this session
	swarmState.activeToolCalls.set(input.callID, {
		tool: input.tool,
		sessionID: input.sessionID,
		callID: input.callID,
		startTime: Date.now(),
	});

	// Revert to primary agent if delegation appears stale
	// Stale if: delegationActive is false OR lastAgentEventTime >10s old
	const session = swarmState.agentSessions.get(input.sessionID);
	const activeAgent = swarmState.activeAgent.get(input.sessionID);

	// Check for OTHER in-flight tool calls (excluding current callID)
	// This prevents stale-delegation from incorrectly resetting while another
	// tool call is in progress for this session
	const hasActiveToolCall = Array.from(
		swarmState.activeToolCalls.values(),
	).some(
		(entry) =>
			entry.sessionID === input.sessionID && entry.callID !== input.callID,
	);

	let blocked = false;
	if (
		session &&
		activeAgent &&
		activeAgent !== ORCHESTRATOR_NAME &&
		!hasActiveToolCall
	) {
		const stripActive = stripKnownSwarmPrefix(activeAgent);
		if (stripActive !== ORCHESTRATOR_NAME) {
			const staleDelegation =
				!session.delegationActive ||
				Date.now() - session.lastAgentEventTime > 10000;
			if (staleDelegation) {
				swarmState.activeAgent.set(input.sessionID, ORCHESTRATOR_NAME);
				blocked = true;
			}
		}
	}

	return { activeAgent: swarmState.activeAgent.get(input.sessionID)!, blocked };
}

// Mock the tool.execute.after logic for Task handoff
async function executeToolAfterHandoff(input: {
	tool: string;
	sessionID: string;
	callID: string;
}): Promise<{ activeAgent: string; delegationActive: boolean }> {
	// Normalize tool name (simulate plugin runtime format)
	const normalizedTool = input.tool.replace(/^[^:]+[:.]/, '');

	// Deterministic handoff: when Task tool completes, force handoff to architect
	if (normalizedTool === 'Task' || normalizedTool === 'task') {
		const sessionId = input.sessionID;

		// Set active agent to architect
		swarmState.activeAgent.set(sessionId, ORCHESTRATOR_NAME);

		// Mark delegation as inactive
		const session = swarmState.agentSessions.get(sessionId);
		if (session) {
			session.delegationActive = false;
			session.lastAgentEventTime = Date.now();
		}
	}

	// Clean up the tool call entry (simulating agent-activity hook)
	swarmState.activeToolCalls.delete(input.callID);

	return {
		activeAgent: swarmState.activeAgent.get(input.sessionID)!,
		delegationActive:
			swarmState.agentSessions.get(input.sessionID)?.delegationActive ?? false,
	};
}

describe('Stale-Delegation Guard - Adversarial Tests', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	describe('1. Long-running tool timing attack', () => {
		it('should NOT trigger stale-delegation while tool is running >10s', async () => {
			const sessionId = 'session-long-running';
			const subagentName = 'swarm:coder';

			// Setup: Create session with subagent delegation
			swarmState.activeAgent.set(sessionId, subagentName);
			swarmState.agentSessions.set(sessionId, {
				agentName: 'coder',
				lastToolCallTime: Date.now(),
				lastAgentEventTime: Date.now() - 15000, // >10s since chat.message
				delegationActive: true,
				activeInvocationId: 1,
				lastInvocationIdByAgent: { coder: 1 },
				windows: {
					'coder:1': {
						id: 1,
						agentName: 'coder',
						startedAtMs: Date.now() - 15000,
						toolCalls: 5,
						consecutiveErrors: 0,
						hardLimitHit: false,
						lastSuccessTimeMs: Date.now(),
						recentToolCalls: [],
						warningIssued: false,
						warningReason: '',
					},
				},
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
				scopeViolationDetected: false,
				modifiedFilesThisCoderTask: [],
			});

			// Simulate long-running tool call started 15s ago
			const longRunningCallId = 'call-long-running';
			swarmState.activeToolCalls.set(longRunningCallId, {
				tool: 'read',
				sessionID: sessionId,
				callID: longRunningCallId,
				startTime: Date.now() - 15000, // Started 15s ago, still running
			});

			// Execute tool.before with a NEW call in same session
			const result = await executeToolBeforeGuard({
				tool: 'write',
				sessionID: sessionId,
				callID: 'call-new',
			});

			// EXPECTED: Stale-delegation should be BLOCKED because long-running tool exists
			// The hasActiveToolCall check should detect the long-running call and block reset
			expect(result.blocked).toBe(false);
			expect(result.activeAgent).toBe('swarm:coder');
		});

		it('should trigger stale-delegation when no other tool calls are in progress', async () => {
			const sessionId = 'session-stale';
			const subagentName = 'swarm:coder';

			// Setup: Create session with stale delegation (>10s since agent event)
			swarmState.activeAgent.set(sessionId, subagentName);
			swarmState.agentSessions.set(sessionId, {
				agentName: 'coder',
				lastToolCallTime: Date.now(),
				lastAgentEventTime: Date.now() - 15000, // >10s stale
				delegationActive: true,
				activeInvocationId: 1,
				lastInvocationIdByAgent: { coder: 1 },
				windows: {
					'coder:1': {
						id: 1,
						agentName: 'coder',
						startedAtMs: Date.now(),
						toolCalls: 5,
						consecutiveErrors: 0,
						hardLimitHit: false,
						lastSuccessTimeMs: Date.now(),
						recentToolCalls: [],
						warningIssued: false,
						warningReason: '',
					},
				},
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
				scopeViolationDetected: false,
				modifiedFilesThisCoderTask: [],
			});

			// NO other tool calls in progress - clean slate

			// Execute tool.before - should trigger stale-delegation reset
			const result = await executeToolBeforeGuard({
				tool: 'write',
				sessionID: sessionId,
				callID: 'call-first',
			});

			// EXPECTED: Stale-delegation SHOULD trigger because no other calls in progress
			expect(result.blocked).toBe(true);
			expect(result.activeAgent).toBe(ORCHESTRATOR_NAME);
		});
	});

	describe('2. Concurrent calls in same session attack', () => {
		it('should block stale-delegation when OTHER calls are in progress', async () => {
			const sessionId = 'session-concurrent';
			const subagentName = 'swarm:reviewer';

			// Setup: Create session with stale delegation but concurrent tool activity
			swarmState.activeAgent.set(sessionId, subagentName);
			swarmState.agentSessions.set(sessionId, {
				agentName: 'reviewer',
				lastToolCallTime: Date.now(),
				lastAgentEventTime: Date.now() - 15000, // Stale
				delegationActive: true,
				activeInvocationId: 1,
				lastInvocationIdByAgent: { reviewer: 1 },
				windows: {
					'reviewer:1': {
						id: 1,
						agentName: 'reviewer',
						startedAtMs: Date.now(),
						toolCalls: 3,
						consecutiveErrors: 0,
						hardLimitHit: false,
						lastSuccessTimeMs: Date.now(),
						recentToolCalls: [],
						warningIssued: false,
						warningReason: '',
					},
				},
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
				scopeViolationDetected: false,
				modifiedFilesThisCoderTask: [],
			});

			// Simulate other tool calls already in progress for this session
			swarmState.activeToolCalls.set('call-1', {
				tool: 'read',
				sessionID: sessionId,
				callID: 'call-1',
				startTime: Date.now() - 5000,
			});
			swarmState.activeToolCalls.set('call-2', {
				tool: 'grep',
				sessionID: sessionId,
				callID: 'call-2',
				startTime: Date.now() - 3000,
			});

			// New call comes in - should NOT trigger stale-delegation because other calls exist
			const result = await executeToolBeforeGuard({
				tool: 'write',
				sessionID: sessionId,
				callID: 'call-3', // NEW call
			});

			// EXPECTED: Should NOT block, should NOT reset agent
			expect(result.blocked).toBe(false);
			expect(result.activeAgent).toBe('swarm:reviewer');
		});

		it('should allow concurrent calls from DIFFERENT sessions to not interfere', async () => {
			const sessionA = 'session-a';
			const sessionB = 'session-b';
			const subagentA = 'swarm:coder';
			const subagentB = 'swarm:reviewer';

			// Setup two sessions
			swarmState.activeAgent.set(sessionA, subagentA);
			swarmState.activeAgent.set(sessionB, subagentB);

			swarmState.agentSessions.set(sessionA, {
				agentName: 'coder',
				lastToolCallTime: Date.now(),
				lastAgentEventTime: Date.now() - 15000, // Stale
				delegationActive: true,
				activeInvocationId: 1,
				lastInvocationIdByAgent: { coder: 1 },
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
				scopeViolationDetected: false,
				modifiedFilesThisCoderTask: [],
			});

			swarmState.agentSessions.set(sessionB, {
				agentName: 'reviewer',
				lastToolCallTime: Date.now(),
				lastAgentEventTime: Date.now() - 15000, // Stale
				delegationActive: true,
				activeInvocationId: 1,
				lastInvocationIdByAgent: { reviewer: 1 },
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
				scopeViolationDetected: false,
				modifiedFilesThisCoderTask: [],
			});

			// Session B has an active tool call
			swarmState.activeToolCalls.set('call-b-active', {
				tool: 'read',
				sessionID: sessionB,
				callID: 'call-b-active',
				startTime: Date.now() - 5000,
			});

			// New call in session A - should trigger stale-delegation because
			// session A has no active calls (session B's call should NOT block session A)
			const resultA = await executeToolBeforeGuard({
				tool: 'write',
				sessionID: sessionA,
				callID: 'call-a-new',
			});

			// EXPECTED: Session A should reset to architect (no other calls in session A)
			expect(resultA.blocked).toBe(true);
			expect(resultA.activeAgent).toBe(ORCHESTRATOR_NAME);

			// Session B should still be reviewer (not affected by session A)
			expect(swarmState.activeAgent.get(sessionB)).toBe('swarm:reviewer');
		});
	});

	describe('3. Cross-session interference attack', () => {
		it('should NOT allow one session to block stale-delegation in another', async () => {
			const sessionA = 'session-alpha';
			const sessionB = 'session-beta';

			// Setup: Both sessions have subagent delegations
			swarmState.activeAgent.set(sessionA, 'swarm:coder');
			swarmState.activeAgent.set(sessionB, 'swarm:reviewer');

			// Session A: stale, but has active tool call
			swarmState.agentSessions.set(sessionA, {
				agentName: 'coder',
				lastToolCallTime: Date.now(),
				lastAgentEventTime: Date.now() - 15000,
				delegationActive: true,
				activeInvocationId: 1,
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
				scopeViolationDetected: false,
				modifiedFilesThisCoderTask: [],
			});

			// Session B: also stale, but NO active tool calls
			swarmState.agentSessions.set(sessionB, {
				agentName: 'reviewer',
				lastToolCallTime: Date.now(),
				lastAgentEventTime: Date.now() - 15000,
				delegationActive: true,
				activeInvocationId: 1,
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
				scopeViolationDetected: false,
				modifiedFilesThisCoderTask: [],
			});

			// Only session A has an active tool call
			swarmState.activeToolCalls.set('call-a-running', {
				tool: 'read',
				sessionID: sessionA,
				callID: 'call-a-running',
				startTime: Date.now() - 5000,
			});

			// New call in session B - should trigger stale-delegation
			// because session B has no active calls (session A's call shouldn't block)
			const resultB = await executeToolBeforeGuard({
				tool: 'write',
				sessionID: sessionB,
				callID: 'call-b-new',
			});

			// EXPECTED: Session B should reset to architect
			expect(resultB.blocked).toBe(true);
			expect(resultB.activeAgent).toBe(ORCHESTRATOR_NAME);

			// Session A should still be coder (not affected)
			expect(swarmState.activeAgent.get(sessionA)).toBe('swarm:coder');
		});
	});

	describe('4. Missing cleanup attack (orphaned tool calls)', () => {
		it('should handle orphaned tool calls that never complete', async () => {
			const sessionId = 'session-orphaned';
			const subagentName = 'swarm:test_engineer';

			// Setup: Session with subagent but no active session (edge case)
			swarmState.activeAgent.set(sessionId, subagentName);

			// Simulate orphaned tool calls from a previous session/crash
			// These should ideally be cleaned up but may persist
			swarmState.activeToolCalls.set('orphaned-call-1', {
				tool: 'read',
				sessionID: 'old-session', // Different session
				callID: 'orphaned-call-1',
				startTime: Date.now() - 3600000, // 1 hour old!
			});
			swarmState.activeToolCalls.set('orphaned-call-2', {
				tool: 'write',
				sessionID: 'another-old-session',
				callID: 'orphaned-call-2',
				startTime: Date.now() - 3600000,
			});

			// New session with stale delegation - no session object
			// Since no session exists, stale-delegation logic won't trigger
			// The activeAgent stays as set (subagent)
			const result = await executeToolBeforeGuard({
				tool: 'write',
				sessionID: sessionId,
				callID: 'call-new-session',
			});

			// EXPECTED: Should not crash, should not incorrectly block due to orphaned calls
			// Since no session exists, it won't trigger stale-delegation logic
			// ActiveAgent remains as set (test_engineer)
			expect(result.activeAgent).toBe('swarm:test_engineer');
		});

		it('should not block forever if tool calls are never cleaned up', async () => {
			const sessionId = 'session-never-cleaned';
			const subagentName = 'swarm:coder';

			// Setup: Active session with subagent
			swarmState.activeAgent.set(sessionId, subagentName);
			swarmState.agentSessions.set(sessionId, {
				agentName: 'coder',
				lastToolCallTime: Date.now(),
				lastAgentEventTime: Date.now() - 5000, // Recent, not stale
				delegationActive: true,
				activeInvocationId: 1,
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
				scopeViolationDetected: false,
				modifiedFilesThisCoderTask: [],
			});

			// Old "stuck" tool call that was never cleaned up
			swarmState.activeToolCalls.set('stuck-call', {
				tool: 'bash',
				sessionID: sessionId,
				callID: 'stuck-call',
				startTime: Date.now() - 60000, // 60 seconds old
			});

			// Even with a stuck call, the CURRENT call should register itself
			// and subsequent calls should work correctly
			const result = await executeToolBeforeGuard({
				tool: 'write',
				sessionID: sessionId,
				callID: 'call-after-stuck',
			});

			// The new call should register itself
			expect(swarmState.activeToolCalls.has('call-after-stuck')).toBe(true);

			// Should NOT trigger stale-delegation since agentEventTime is recent (<10s)
			expect(result.blocked).toBe(false);
			expect(result.activeAgent).toBe('swarm:coder');
		});
	});

	describe('5. Force architect takeover during active subagent execution', () => {
		it('should force handoff to architect when Task tool completes', async () => {
			const sessionId = 'session-task-handoff';
			const subagentName = 'swarm:coder';

			// Setup: Active subagent session
			swarmState.activeAgent.set(sessionId, subagentName);
			swarmState.agentSessions.set(sessionId, {
				agentName: 'coder',
				lastToolCallTime: Date.now(),
				lastAgentEventTime: Date.now(),
				delegationActive: true,
				activeInvocationId: 1,
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
				scopeViolationDetected: false,
				modifiedFilesThisCoderTask: [],
			});

			// Register a tool call before
			await executeToolBeforeGuard({
				tool: 'Task',
				sessionID: sessionId,
				callID: 'call-task',
			});

			// Execute Task tool after - should force handoff to architect
			const afterResult = await executeToolAfterHandoff({
				tool: 'Task',
				sessionID: sessionId,
				callID: 'call-task',
			});

			// EXPECTED: Should force handoff to architect
			expect(afterResult.activeAgent).toBe(ORCHESTRATOR_NAME);
			expect(afterResult.delegationActive).toBe(false);
		});

		it('should force handoff even with various Task tool name formats', async () => {
			const sessionId = 'session-task-formats';

			// Test different tool name formats that might be used
			const toolFormats = ['Task', 'task', 'tool.execute.Task', 'plugin:Task'];

			for (const toolName of toolFormats) {
				// Reset state for each iteration
				resetSwarmState();

				swarmState.activeAgent.set(sessionId, 'swarm:coder');
				swarmState.agentSessions.set(sessionId, {
					agentName: 'coder',
					lastToolCallTime: Date.now(),
					lastAgentEventTime: Date.now(),
					delegationActive: true,
					activeInvocationId: 1,
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
					scopeViolationDetected: false,
					modifiedFilesThisCoderTask: [],
				});

				await executeToolBeforeGuard({
					tool: toolName,
					sessionID: sessionId,
					callID: `call-${toolName}`,
				});

				const result = await executeToolAfterHandoff({
					tool: toolName,
					sessionID: sessionId,
					callID: `call-${toolName}`,
				});

				// EXPECTED: All Task tool formats should trigger handoff
				expect(result.activeAgent).toBe(ORCHESTRATOR_NAME);
				expect(result.delegationActive).toBe(false);
			}
		});

		it('should NOT force handoff for non-Task tools', async () => {
			const sessionId = 'session-non-task';
			const subagentName = 'swarm:reviewer';

			swarmState.activeAgent.set(sessionId, subagentName);
			swarmState.agentSessions.set(sessionId, {
				agentName: 'reviewer',
				lastToolCallTime: Date.now(),
				lastAgentEventTime: Date.now(),
				delegationActive: true,
				activeInvocationId: 1,
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
				scopeViolationDetected: false,
				modifiedFilesThisCoderTask: [],
			});

			await executeToolBeforeGuard({
				tool: 'read',
				sessionID: sessionId,
				callID: 'call-read',
			});

			const result = await executeToolAfterHandoff({
				tool: 'read',
				sessionID: sessionId,
				callID: 'call-read',
			});

			// EXPECTED: Non-Task tools should NOT trigger handoff
			expect(result.activeAgent).toBe('swarm:reviewer');
			// delegationActive might be undefined or existing value
		});
	});

	describe('Edge cases and boundary conditions', () => {
		it('should handle delegationActive explicitly set to false', async () => {
			const sessionId = 'session-delegation-inactive';
			const subagentName = 'swarm:coder';

			swarmState.activeAgent.set(sessionId, subagentName);
			swarmState.agentSessions.set(sessionId, {
				agentName: 'coder',
				lastToolCallTime: Date.now(),
				lastAgentEventTime: Date.now(), // Recent
				delegationActive: false, // Explicitly inactive
				activeInvocationId: 1,
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
				scopeViolationDetected: false,
				modifiedFilesThisCoderTask: [],
			});

			const result = await executeToolBeforeGuard({
				tool: 'write',
				sessionID: sessionId,
				callID: 'call-test',
			});

			// EXPECTED: Should trigger stale-delegation because delegationActive is false
			expect(result.blocked).toBe(true);
			expect(result.activeAgent).toBe(ORCHESTRATOR_NAME);
		});

		it('should NOT trigger for architect-to-architect transitions', async () => {
			const sessionId = 'session-architect';

			// Already architect - no stale-delegation needed
			swarmState.activeAgent.set(sessionId, ORCHESTRATOR_NAME);
			swarmState.agentSessions.set(sessionId, {
				agentName: 'architect',
				lastToolCallTime: Date.now(),
				lastAgentEventTime: Date.now() - 15000,
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
				scopeViolationDetected: false,
				modifiedFilesThisCoderTask: [],
			});

			const result = await executeToolBeforeGuard({
				tool: 'write',
				sessionID: sessionId,
				callID: 'call-architect',
			});

			// EXPECTED: Should remain architect
			expect(result.activeAgent).toBe(ORCHESTRATOR_NAME);
			expect(result.blocked).toBe(false);
		});

		it('should handle exactly 10s boundary correctly', async () => {
			// Freeze the clock so the setup timestamp and the guard's own
			// `Date.now()` (executeToolBeforeGuard, above) read the SAME instant.
			// The delta is then exactly 10000ms — the boundary this test targets.
			// Without freezing, the real clock advances a few ms between
			// `Date.now() - 10000` and the guard's read, pushing the delta past
			// 10000 (`> 10000` → stale → blocked) and flaking under coverage
			// instrumentation (issue #1782 root-cause class 1). A positive
			// fixedNow avoids a negative-epoch `tenSecondsAgo`.
			await withFrozenClockAsync(
				async () => {
					const sessionId = 'session-10s-boundary';
					const subagentName = 'swarm:coder';

					swarmState.activeAgent.set(sessionId, subagentName);

					// Exactly 10s ago - should be considered stale
					const tenSecondsAgo = Date.now() - 10000;

					swarmState.agentSessions.set(sessionId, {
						agentName: 'coder',
						lastToolCallTime: Date.now(),
						lastAgentEventTime: tenSecondsAgo,
						delegationActive: true,
						activeInvocationId: 1,
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
						scopeViolationDetected: false,
						modifiedFilesThisCoderTask: [],
					});

					// No other tool calls in progress
					const result = await executeToolBeforeGuard({
						tool: 'write',
						sessionID: sessionId,
						callID: 'call-boundary',
					});

					// At exactly 10s, the condition
					// Date.now() - session.lastAgentEventTime > 10000 will be false
					// (it's exactly 10000, not greater than), so it should NOT
					// trigger stale-delegation at exactly 10s.
					expect(result.blocked).toBe(false);
					expect(result.activeAgent).toBe('swarm:coder');
				},
				{ fixedNow: 1_000_000_000_000 },
			);
		});

		it('should handle just over 10s correctly', async () => {
			const sessionId = 'session-over-10s';
			const subagentName = 'swarm:coder';

			swarmState.activeAgent.set(sessionId, subagentName);

			// Just over 10s ago (>10000ms)
			const justOverTenSecondsAgo = Date.now() - 10001;

			swarmState.agentSessions.set(sessionId, {
				agentName: 'coder',
				lastToolCallTime: Date.now(),
				lastAgentEventTime: justOverTenSecondsAgo,
				delegationActive: true,
				activeInvocationId: 1,
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
				scopeViolationDetected: false,
				modifiedFilesThisCoderTask: [],
			});

			// No other tool calls in progress
			const result = await executeToolBeforeGuard({
				tool: 'write',
				sessionID: sessionId,
				callID: 'call-over-10s',
			});

			// Just over 10s - should trigger stale-delegation
			expect(result.blocked).toBe(true);
			expect(result.activeAgent).toBe(ORCHESTRATOR_NAME);
		});
	});
});
