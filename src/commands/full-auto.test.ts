/**
 * Tests for handleFullAutoCommand function.
 * Tests the /swarm full-auto command toggle functionality,
 * including the unique counter-reset behavior on disable.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleFullAutoCommand } from '../commands/full-auto';
import { loadFullAutoRunState } from '../full-auto/state';
import { getAgentSession, swarmState } from '../state';

describe('handleFullAutoCommand', () => {
	let testSessionId: string;
	let tmpDir: string;

	beforeEach(() => {
		testSessionId = `full-auto-test-${Date.now()}`;
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'full-auto-cmd-'));
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
		swarmState.agentSessions.delete(testSessionId);
		try {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	});

	function getSession() {
		const session = getAgentSession(testSessionId);
		if (!session) throw new Error('Session not found');
		return session;
	}

	describe('Error Path - No Active Session', () => {
		it('returns error message when no session exists', async () => {
			const result = await handleFullAutoCommand(
				tmpDir,
				[],
				'non-existent-session',
			);
			expect(result).toBe(
				'Error: No active session. Full-Auto Mode requires an active session to operate.',
			);
		});
	});

	describe('Happy Path - Enable Full-Auto Mode', () => {
		it('enables full-auto mode when arg is "on"', async () => {
			const result = await handleFullAutoCommand(tmpDir, ['on'], testSessionId);
			expect(result).toContain('Full-Auto Mode enabled');
			expect(getSession().fullAutoMode).toBe(true);
		});

		it('enables full-auto mode when arg is "ON" (case insensitive)', async () => {
			const result = await handleFullAutoCommand(tmpDir, ['ON'], testSessionId);
			expect(result).toContain('Full-Auto Mode enabled');
			expect(getSession().fullAutoMode).toBe(true);
		});
	});

	describe('Happy Path - Disable Full-Auto Mode', () => {
		it('disables full-auto mode when arg is "off"', async () => {
			getSession().fullAutoMode = true;
			const result = await handleFullAutoCommand(
				tmpDir,
				['off'],
				testSessionId,
			);
			expect(result).toContain('Full-Auto Mode disabled');
			expect(getSession().fullAutoMode).toBe(false);
		});

		it('disables full-auto mode when arg is "OFF" (case insensitive)', async () => {
			getSession().fullAutoMode = true;
			const result = await handleFullAutoCommand(
				tmpDir,
				['OFF'],
				testSessionId,
			);
			expect(result).toContain('Full-Auto Mode disabled');
			expect(getSession().fullAutoMode).toBe(false);
		});
	});

	describe('Happy Path - Toggle Behavior', () => {
		it('toggles full-auto mode from off to on when no argument provided', async () => {
			getSession().fullAutoMode = false;
			const result = await handleFullAutoCommand(tmpDir, [], testSessionId);
			expect(result).toContain('Full-Auto Mode enabled');
			expect(getSession().fullAutoMode).toBe(true);
		});

		it('toggles full-auto mode from on to off when no argument provided', async () => {
			getSession().fullAutoMode = true;
			const result = await handleFullAutoCommand(tmpDir, [], testSessionId);
			expect(result).toContain('Full-Auto Mode disabled');
			expect(getSession().fullAutoMode).toBe(false);
		});

		it('toggles full-auto mode when arg is empty string', async () => {
			getSession().fullAutoMode = false;
			const result = await handleFullAutoCommand(tmpDir, [''], testSessionId);
			expect(result).toContain('Full-Auto Mode enabled');
			expect(getSession().fullAutoMode).toBe(true);
		});
	});

	describe('Edge Cases', () => {
		it('rejects an invalid mode token after "on"', async () => {
			getSession().fullAutoMode = false;
			const result = await handleFullAutoCommand(
				tmpDir,
				['on', 'extra', 'ignored'],
				testSessionId,
			);
			expect(result).toContain('invalid Full-Auto mode');
			expect(result).toContain('assisted, supervised, strict');
			expect(getSession().fullAutoMode).toBe(false);
		});

		it('treats unknown arguments as toggle', async () => {
			getSession().fullAutoMode = false;
			const result = await handleFullAutoCommand(
				tmpDir,
				['invalid'],
				testSessionId,
			);
			expect(result).toContain('Full-Auto Mode enabled');
			expect(getSession().fullAutoMode).toBe(true);
		});

		it('does not modify unrelated session properties', async () => {
			const session = getSession();
			const originalAgentName = session.agentName;
			const originalDelegationActive = session.delegationActive;
			const originalLastToolCallTime = session.lastToolCallTime;
			const originalTurboMode = session.turboMode;

			await handleFullAutoCommand(tmpDir, ['on'], testSessionId);

			expect(session.agentName).toBe(originalAgentName);
			expect(session.delegationActive).toBe(originalDelegationActive);
			expect(session.lastToolCallTime).toBe(originalLastToolCallTime);
			expect(session.turboMode).toBe(originalTurboMode);
		});
	});

	describe('State Mutation Verification', () => {
		it('persists fullAutoMode change across multiple calls', async () => {
			expect(getSession().fullAutoMode).toBe(false);

			await handleFullAutoCommand(tmpDir, [], testSessionId);
			expect(getSession().fullAutoMode).toBe(true);

			await handleFullAutoCommand(tmpDir, [], testSessionId);
			expect(getSession().fullAutoMode).toBe(false);
		});

		it('maintains state after multiple enable/disable calls', async () => {
			await handleFullAutoCommand(tmpDir, ['on'], testSessionId);
			expect(getSession().fullAutoMode).toBe(true);

			await handleFullAutoCommand(tmpDir, ['off'], testSessionId);
			expect(getSession().fullAutoMode).toBe(false);

			await handleFullAutoCommand(tmpDir, ['on'], testSessionId);
			expect(getSession().fullAutoMode).toBe(true);
		});
	});

	describe('First-class mode argument', () => {
		it('activates with an explicit strict mode and persists it to the durable run state', async () => {
			const result = await handleFullAutoCommand(
				tmpDir,
				['on', 'strict'],
				testSessionId,
			);
			expect(result).toContain('Full-Auto Mode enabled');
			expect(result).toContain('mode=strict');
			expect(getSession().fullAutoMode).toBe(true);
			const runState = loadFullAutoRunState(tmpDir, testSessionId);
			expect(runState?.status).toBe('running');
			expect(runState?.mode).toBe('strict');
		});

		it('activates with assisted mode (case insensitive)', async () => {
			const result = await handleFullAutoCommand(
				tmpDir,
				['on', 'ASSISTED'],
				testSessionId,
			);
			expect(result).toContain('mode=assisted');
			expect(loadFullAutoRunState(tmpDir, testSessionId)?.mode).toBe(
				'assisted',
			);
		});

		it('defaults to supervised when no mode is given', async () => {
			const result = await handleFullAutoCommand(tmpDir, ['on'], testSessionId);
			expect(result).toContain('mode=supervised');
			expect(loadFullAutoRunState(tmpDir, testSessionId)?.mode).toBe(
				'supervised',
			);
		});
	});

	describe('Status subcommand', () => {
		it('reports no durable run when full-auto was never activated', async () => {
			const result = await handleFullAutoCommand(
				tmpDir,
				['status'],
				testSessionId,
			);
			expect(result).toContain('Full-Auto session flag: off');
			expect(result).toContain('Durable run-state: none');
		});

		it('reports a running durable run after activation, and idle (disarmed) after off', async () => {
			await handleFullAutoCommand(tmpDir, ['on', 'strict'], testSessionId);
			const running = await handleFullAutoCommand(
				tmpDir,
				['status'],
				testSessionId,
			);
			expect(running).toContain('Full-Auto session flag: on');
			expect(running).toContain('Durable run-state: running (mode=strict)');

			await handleFullAutoCommand(tmpDir, ['off'], testSessionId);
			const disarmed = await handleFullAutoCommand(
				tmpDir,
				['status'],
				testSessionId,
			);
			expect(disarmed).toContain('Full-Auto session flag: off');
			expect(disarmed).toContain('Durable run-state: idle');
		});

		it('status is read-only — it does not flip the session flag', async () => {
			getSession().fullAutoMode = false;
			await handleFullAutoCommand(tmpDir, ['status'], testSessionId);
			expect(getSession().fullAutoMode).toBe(false);
		});

		it('regression F4: status reports an UNREADABLE state file instead of "none"', async () => {
			// Previous behavior: loadFullAutoRunState swallowed corruption and
			// status printed "none" while the permission hook was blocking every
			// non-read-only tool project-wide with FULL_AUTO_STATE_UNREADABLE.
			fs.mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });
			fs.writeFileSync(
				path.join(tmpDir, '.swarm', 'full-auto-state.json'),
				'{ this is not json',
				'utf-8',
			);
			const result = await handleFullAutoCommand(
				tmpDir,
				['status'],
				testSessionId,
			);
			expect(result).toContain('UNREADABLE');
			expect(result).not.toContain('Durable run-state: none');
		});
	});

	describe('Bare mode token (regression F10)', () => {
		it('treats `/swarm full-auto strict` as `on strict`, never as a toggle-off', async () => {
			// Previous behavior: a bare mode token hit the toggle branch, so a
			// user trying to switch modes while ON would silently turn Full-Auto
			// OFF instead.
			getSession().fullAutoMode = true;
			const result = await handleFullAutoCommand(
				tmpDir,
				['strict'],
				testSessionId,
			);
			expect(result).toContain('Full-Auto Mode enabled');
			expect(result).toContain('mode=strict');
			expect(getSession().fullAutoMode).toBe(true);
			expect(loadFullAutoRunState(tmpDir, testSessionId)?.mode).toBe('strict');
		});
	});

	describe('Counter Reset on Disable (full-auto-specific)', () => {
		it('resets all three counters when disabled via "off" arg', async () => {
			const session = getSession();
			session.fullAutoMode = true;
			session.fullAutoInteractionCount = 7;
			session.fullAutoDeadlockCount = 2;
			session.fullAutoLastQuestionHash = 'abc123hash';

			await handleFullAutoCommand(tmpDir, ['off'], testSessionId);

			expect(session.fullAutoInteractionCount).toBe(0);
			expect(session.fullAutoDeadlockCount).toBe(0);
			expect(session.fullAutoLastQuestionHash).toBeNull();
		});

		it('resets all three counters when toggled off (no arg, from true)', async () => {
			const session = getSession();
			session.fullAutoMode = true;
			session.fullAutoInteractionCount = 5;
			session.fullAutoDeadlockCount = 1;
			session.fullAutoLastQuestionHash = 'hashxyz';

			await handleFullAutoCommand(tmpDir, [], testSessionId);

			expect(session.fullAutoMode).toBe(false);
			expect(session.fullAutoInteractionCount).toBe(0);
			expect(session.fullAutoDeadlockCount).toBe(0);
			expect(session.fullAutoLastQuestionHash).toBeNull();
		});

		it('does NOT reset counters when enabled via "on" arg', async () => {
			const session = getSession();
			session.fullAutoMode = false;
			// Manually seed non-zero counters (simulates stale state)
			session.fullAutoInteractionCount = 3;
			session.fullAutoDeadlockCount = 1;
			session.fullAutoLastQuestionHash = 'stale-hash';

			await handleFullAutoCommand(tmpDir, ['on'], testSessionId);

			expect(session.fullAutoMode).toBe(true);
			// Counters are preserved — only reset on disable
			expect(session.fullAutoInteractionCount).toBe(3);
			expect(session.fullAutoDeadlockCount).toBe(1);
			expect(session.fullAutoLastQuestionHash).toBe('stale-hash');
		});

		it('does NOT reset counters when toggled on (no arg, from false)', async () => {
			const session = getSession();
			session.fullAutoMode = false;
			session.fullAutoInteractionCount = 4;
			session.fullAutoDeadlockCount = 0;
			session.fullAutoLastQuestionHash = 'some-hash';

			await handleFullAutoCommand(tmpDir, [], testSessionId);

			expect(session.fullAutoMode).toBe(true);
			expect(session.fullAutoInteractionCount).toBe(4);
			expect(session.fullAutoDeadlockCount).toBe(0);
			expect(session.fullAutoLastQuestionHash).toBe('some-hash');
		});

		it('resets counters even when "off" is called on already-disabled session (idempotent)', async () => {
			const session = getSession();
			// fullAutoMode is already false (default)
			session.fullAutoInteractionCount = 9;
			session.fullAutoDeadlockCount = 3;
			session.fullAutoLastQuestionHash = 'orphan-hash';

			// Calling off on already-disabled session still resets counters
			await handleFullAutoCommand(tmpDir, ['off'], testSessionId);

			expect(session.fullAutoMode).toBe(false);
			expect(session.fullAutoInteractionCount).toBe(0);
			expect(session.fullAutoDeadlockCount).toBe(0);
			expect(session.fullAutoLastQuestionHash).toBeNull();
		});
	});
});
