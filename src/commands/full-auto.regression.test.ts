/**
 * Regression Tests for Full-Auto Mode Integration.
 *
 * Covers the integration surfaces unique to full-auto mode:
 * 1. /swarm full-auto command toggle, on, off
 * 2. hasActiveFullAuto() - session-scoped and global-fallback behavior
 * 3. System-enhancer hook injects FULL-AUTO MODE ACTIVE banner (Path A and global)
 * 4. Counter reset side-effects are visible after disable
 */

import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { HostPartsMessage } from '../../tests/helpers/host-contract-v1_18_3';
import {
	bootSwarmPluginHost,
	createPluginHostProject,
} from '../../tests/helpers/plugin-host';
import { isGuidanceCarrier } from '../hooks/system-guidance-carrier';
import { getAgentSession, hasActiveFullAuto, swarmState } from '../state';
import { handleFullAutoCommand } from './full-auto';

describe('Full-Auto Mode Regression Tests', () => {
	let testSessionId: string;
	let tmpDir: string;
	let originalXdg: string | undefined;
	let registeredHostDirectory: string;
	let registeredHost: Awaited<ReturnType<typeof bootSwarmPluginHost>>;

	beforeAll(async () => {
		registeredHostDirectory = createPluginHostProject(
			'full-auto-regression-host',
		);
		registeredHost = await bootSwarmPluginHost(registeredHostDirectory, {
			knowledge: { enabled: false, hive_enabled: false },
			memory: { enabled: false },
			hooks: { delegation_gate: false },
		});
	});

	afterAll(() => {
		try {
			fs.rmSync(registeredHostDirectory, { recursive: true, force: true });
		} catch {
			// SQLite handles may remain open briefly on Windows; best effort only.
		}
	});

	beforeEach(() => {
		testSessionId = `full-auto-regression-${Date.now()}`;
		// Legacy informational flag — no longer gates activation (first-class toggle).
		swarmState.fullAutoEnabledInConfig = true;
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

		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'full-auto-regression-'));
		originalXdg = process.env.XDG_CONFIG_HOME;
		process.env.XDG_CONFIG_HOME = path.join(tmpDir, 'user-config');
	});

	afterEach(() => {
		if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = originalXdg;
		swarmState.agentSessions.delete(testSessionId);
		try {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	async function registeredGuidanceMessages(
		sessionID: string | undefined = testSessionId,
	): Promise<HostPartsMessage[]> {
		const messages: HostPartsMessage[] = [
			{
				info: {
					id: `full-auto-request-${sessionID ?? 'anonymous'}`,
					role: 'user',
					agent: 'architect',
					...(sessionID ? { sessionID } : {}),
				},
				parts: [{ type: 'text', text: 'continue' }],
			},
		];
		if (sessionID) {
			await registeredHost.hooks['chat.message'](
				{ sessionID, agent: 'architect' },
				{},
			);
		}
		await registeredHost.hooks['experimental.chat.messages.transform'](
			{},
			{ messages },
		);
		return messages;
	}

	function guidanceText(messages: HostPartsMessage[]): string {
		return messages
			.filter((message) => isGuidanceCarrier(message))
			.flatMap((message) =>
				message.parts
					.filter((part) => part.type === 'text')
					.map((part) => part.text ?? ''),
			)
			.join('\n');
	}

	// ============================================
	// 1. /swarm full-auto command toggle behavior
	// ============================================
	describe('1. /swarm full-auto command toggles fullAutoMode correctly', () => {
		it('1.1 toggle from false to true with no args', async () => {
			const session = getAgentSession(testSessionId);
			expect(session?.fullAutoMode).toBe(false);

			const result = await handleFullAutoCommand(tmpDir, [], testSessionId);

			expect(result).toContain('Full-Auto Mode enabled');
			expect(session?.fullAutoMode).toBe(true);
		});

		it('1.2 toggle from true to false with no args', async () => {
			const session = getAgentSession(testSessionId);
			session!.fullAutoMode = true;

			const result = await handleFullAutoCommand(tmpDir, [], testSessionId);

			expect(result).toContain('Full-Auto Mode disabled');
			expect(session?.fullAutoMode).toBe(false);
		});

		it('1.3 "on" arg enables', async () => {
			const result = await handleFullAutoCommand(tmpDir, ['on'], testSessionId);
			expect(result).toContain('Full-Auto Mode enabled');
			expect(getAgentSession(testSessionId)?.fullAutoMode).toBe(true);
		});

		it('1.4 "off" arg disables and resets counters', async () => {
			const session = getAgentSession(testSessionId);
			session!.fullAutoMode = true;
			session!.fullAutoInteractionCount = 5;
			session!.fullAutoDeadlockCount = 1;
			session!.fullAutoLastQuestionHash = 'hash';

			const result = await handleFullAutoCommand(
				tmpDir,
				['off'],
				testSessionId,
			);

			expect(result).toContain('Full-Auto Mode disabled');
			expect(session?.fullAutoMode).toBe(false);
			expect(session?.fullAutoInteractionCount).toBe(0);
			expect(session?.fullAutoDeadlockCount).toBe(0);
			expect(session?.fullAutoLastQuestionHash).toBeNull();
		});
	});

	// ============================================
	// 2. hasActiveFullAuto() behavior
	// ============================================
	describe('2. hasActiveFullAuto() session-scoped and global-fallback', () => {
		it('2.1 returns true when session has fullAutoMode: true', () => {
			const session = getAgentSession(testSessionId);
			session!.fullAutoMode = true;

			expect(hasActiveFullAuto(testSessionId)).toBe(true);
		});

		it('2.2 returns false when session has fullAutoMode: false', () => {
			const session = getAgentSession(testSessionId);
			session!.fullAutoMode = false;

			expect(hasActiveFullAuto(testSessionId)).toBe(false);
		});

		it('2.3 global fallback returns true if any session has fullAutoMode: true', () => {
			// testSessionId has fullAutoMode: false (default)
			const secondId = `full-auto-regression-second-${Date.now()}`;
			swarmState.agentSessions.set(secondId, {
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
				fullAutoMode: true, // this session has full-auto on
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

			// Global fallback (no sessionID)
			expect(hasActiveFullAuto()).toBe(true);

			swarmState.agentSessions.delete(secondId);
		});

		it('2.4 global fallback returns false when no session has fullAutoMode: true', () => {
			// All sessions have fullAutoMode: false by default
			expect(hasActiveFullAuto()).toBe(false);
		});

		it('2.5 returns false after disable via command (counter-reset visible)', async () => {
			const session = getAgentSession(testSessionId);
			session!.fullAutoMode = true;
			session!.fullAutoInteractionCount = 3;

			await handleFullAutoCommand(tmpDir, ['off'], testSessionId);

			expect(hasActiveFullAuto(testSessionId)).toBe(false);
			expect(session?.fullAutoInteractionCount).toBe(0);
		});
	});

	// ============================================
	// 3. System-enhancer injects FULL-AUTO MODE ACTIVE banner
	// ============================================
	describe('3. System-enhancer hook injects FULL-AUTO MODE ACTIVE banner', () => {
		it('3.1 injects banner when fullAutoMode is true', async () => {
			const session = getAgentSession(testSessionId);
			session!.fullAutoMode = true;

			const systemPrompt = guidanceText(
				await registeredGuidanceMessages(testSessionId),
			);

			expect(systemPrompt).toContain('## ⚡ FULL-AUTO MODE ACTIVE');
			expect(systemPrompt).toContain('without a human in the loop');
		});

		it('3.2 does NOT inject banner when fullAutoMode is false', async () => {
			const session = getAgentSession(testSessionId);
			session!.fullAutoMode = false;

			const systemPrompt = guidanceText(
				await registeredGuidanceMessages(testSessionId),
			);

			expect(systemPrompt).not.toContain('## ⚡ FULL-AUTO MODE ACTIVE');
			expect(systemPrompt).not.toContain('without a human in the loop');
		});

		it('3.3 banner contains correct autonomous-mode behavioral text', async () => {
			const session = getAgentSession(testSessionId);
			session!.fullAutoMode = true;

			const systemPrompt = guidanceText(
				await registeredGuidanceMessages(testSessionId),
			);

			expect(systemPrompt).toContain('Autonomous Oversight Critic');
			expect(systemPrompt).toContain('ESCALATE_TO_HUMAN');
		});

		it('3.4 delivers the banner for an explicitly identified full-auto session', async () => {
			const secondId = `full-auto-regression-global-${Date.now()}`;
			swarmState.agentSessions.set(secondId, {
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
				fullAutoMode: true,
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

			const systemPrompt = guidanceText(
				await registeredGuidanceMessages(secondId),
			);

			expect(systemPrompt).toContain('## ⚡ FULL-AUTO MODE ACTIVE');

			swarmState.agentSessions.delete(secondId);
		});

		it('3.5 does NOT inject banner when no sessions exist', async () => {
			swarmState.agentSessions.clear();

			const systemPrompt = guidanceText(
				await registeredGuidanceMessages(undefined),
			);

			expect(systemPrompt).not.toContain('## ⚡ FULL-AUTO MODE ACTIVE');

			// Restore test session
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

		it('3.6 full-auto banner is injected independently of turbo banner', async () => {
			const session = getAgentSession(testSessionId);
			session!.fullAutoMode = true;
			session!.turboMode = false; // only full-auto active

			const systemPrompt = guidanceText(
				await registeredGuidanceMessages(testSessionId),
			);

			expect(systemPrompt).toContain('## ⚡ FULL-AUTO MODE ACTIVE');
			expect(systemPrompt).not.toContain('## 🚀 TURBO MODE ACTIVE');
		});
	});
});
