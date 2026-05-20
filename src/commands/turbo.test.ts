/**
 * Tests for Task 3.11: handleTurboCommand function
 * Tests the /swarm turbo command toggle functionality
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { _internals, handleTurboCommand } from '../commands/turbo';
import { getAgentSession, swarmState } from '../state';

describe('handleTurboCommand', () => {
	let testSessionId: string;
	let originalLoadPluginConfigWithMeta: typeof _internals.loadPluginConfigWithMeta;

	beforeEach(() => {
		// Stub _internals DI seam so tests get standard turbo config
		// instead of whatever the real project's .swarm/ settings contain.
		originalLoadPluginConfigWithMeta = _internals.loadPluginConfigWithMeta;
		_internals.loadPluginConfigWithMeta = () => ({
			config: { turbo: { strategy: 'standard' } },
			loadedFromFile: false,
		});
		// Create a test session
		testSessionId = `turbo-test-${Date.now()}`;
		swarmState.agentSessions.set(testSessionId, {
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
		});
	});

	afterEach(() => {
		// Restore the original _internals seam
		_internals.loadPluginConfigWithMeta = originalLoadPluginConfigWithMeta;
		// Clean up test session
		swarmState.agentSessions.delete(testSessionId);
	});

	function getSession() {
		const session = getAgentSession(testSessionId);
		if (!session) {
			throw new Error('Session not found');
		}
		return session;
	}

	describe('Error Path - No Active Session', () => {
		it('returns error message when no session exists', async () => {
			const result = await handleTurboCommand(
				'/project',
				[],
				'non-existent-session',
			);

			expect(result).toBe(
				'Error: No active session. Turbo Mode requires an active session to operate.',
			);
		});
	});

	describe('Happy Path - Enable Turbo Mode', () => {
		it('enables turbo mode when arg is "on"', async () => {
			const result = await handleTurboCommand(
				'/project',
				['on'],
				testSessionId,
			);

			expect(result).toBe('Turbo Mode enabled');
			expect(getSession().turboMode).toBe(true);
		});

		it('enables turbo mode when arg is "ON" (case insensitive)', async () => {
			const result = await handleTurboCommand(
				'/project',
				['ON'],
				testSessionId,
			);

			expect(result).toBe('Turbo Mode enabled');
			expect(getSession().turboMode).toBe(true);
		});
	});

	describe('Happy Path - Disable Turbo Mode', () => {
		it('disables turbo mode when arg is "off"', async () => {
			getSession().turboMode = true;

			const result = await handleTurboCommand(
				'/project',
				['off'],
				testSessionId,
			);

			expect(result).toBe('Turbo Mode disabled');
			expect(getSession().turboMode).toBe(false);
		});

		it('disables turbo mode when arg is "OFF" (case insensitive)', async () => {
			getSession().turboMode = true;

			const result = await handleTurboCommand(
				'/project',
				['OFF'],
				testSessionId,
			);

			expect(result).toBe('Turbo Mode disabled');
			expect(getSession().turboMode).toBe(false);
		});
	});

	describe('Happy Path - Toggle Behavior', () => {
		it('toggles turbo mode from off to on when no argument provided', async () => {
			getSession().turboMode = false;

			const result = await handleTurboCommand('/project', [], testSessionId);

			expect(result).toBe('Turbo Mode enabled');
			expect(getSession().turboMode).toBe(true);
		});

		it('toggles turbo mode from on to off when no argument provided', async () => {
			getSession().turboMode = true;

			const result = await handleTurboCommand('/project', [], testSessionId);

			expect(result).toBe('Turbo Mode disabled');
			expect(getSession().turboMode).toBe(false);
		});

		it('toggles turbo mode when arg is empty string', async () => {
			getSession().turboMode = false;

			const result = await handleTurboCommand('/project', [''], testSessionId);

			expect(result).toBe('Turbo Mode enabled');
			expect(getSession().turboMode).toBe(true);
		});
	});

	describe('Edge Cases', () => {
		it('ignores extra arguments and uses only the first one', async () => {
			getSession().turboMode = false;

			const result = await handleTurboCommand(
				'/project',
				['on', 'extra', 'ignored'],
				testSessionId,
			);

			expect(result).toBe('Turbo Mode enabled');
			expect(getSession().turboMode).toBe(true);
		});

		it('treats unknown arguments as toggle', async () => {
			getSession().turboMode = false;

			const result = await handleTurboCommand(
				'/project',
				['invalid'],
				testSessionId,
			);

			expect(result).toBe('Turbo Mode enabled');
			expect(getSession().turboMode).toBe(true);
		});

		it('does not modify other session properties', async () => {
			const session = getSession();
			const originalAgentName = session.agentName;
			const originalDelegationActive = session.delegationActive;
			const originalLastToolCallTime = session.lastToolCallTime;

			await handleTurboCommand('/project', ['on'], testSessionId);

			expect(session.agentName).toBe(originalAgentName);
			expect(session.delegationActive).toBe(originalDelegationActive);
			expect(session.lastToolCallTime).toBe(originalLastToolCallTime);
		});
	});

	describe('State Mutation Verification', () => {
		it('persists turboMode change across multiple calls', async () => {
			// Initial: turboMode = false
			expect(getSession().turboMode).toBe(false);

			// Toggle on
			await handleTurboCommand('/project', [], testSessionId);
			expect(getSession().turboMode).toBe(true);

			// Toggle off
			await handleTurboCommand('/project', [], testSessionId);
			expect(getSession().turboMode).toBe(false);
		});

		it('maintains state after multiple enable/disable calls', async () => {
			await handleTurboCommand('/project', ['on'], testSessionId);
			expect(getSession().turboMode).toBe(true);

			await handleTurboCommand('/project', ['off'], testSessionId);
			expect(getSession().turboMode).toBe(false);

			await handleTurboCommand('/project', ['on'], testSessionId);
			expect(getSession().turboMode).toBe(true);
		});
	});
});
