/**
 * Regression Tests for Task 4: Turbo Mode Integration
 *
 * These tests verify that Turbo Mode is correctly integrated across all surfaces:
 * 1. /swarm turbo command toggles turboMode correctly
 * 2. checkReviewerGate bypasses Stage B when turboMode is active AND task is not Tier 3
 * 3. Evidence records include turbo flag when recorded under turboMode
 * 4. Architect prompt includes TURBO MODE ACTIVE banner when active
 * 5. Status output shows TURBO MODE indicator when active
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
import type { PluginConfig } from '../config';
import { isGuidanceCarrier } from '../hooks/system-guidance-carrier';
import {
	formatStatusMarkdown,
	getStatusData,
	type StatusData,
} from '../services/status-service';
import { getAgentSession, hasActiveTurboMode, swarmState } from '../state';
import { checkReviewerGate } from '../tools/update-task-status';
import { _internals, handleTurboCommand } from './turbo';
import { TURBO_BYPASS_DISCLOSURE } from './turbo-constants';

describe('Task 4: Turbo Mode Regression Tests', () => {
	let testSessionId: string;
	let tmpDir: string;
	let originalLoadPluginConfigWithMeta: typeof _internals.loadPluginConfigWithMeta;
	let registeredHostDirectory: string;
	let registeredHost: Awaited<ReturnType<typeof bootSwarmPluginHost>>;

	beforeAll(async () => {
		registeredHostDirectory = createPluginHostProject('turbo-regression-host');
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
		// Create a test session
		testSessionId = `turbo-regression-${Date.now()}`;
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

		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'turbo-regression-'));

		originalLoadPluginConfigWithMeta = _internals.loadPluginConfigWithMeta;
		_internals.loadPluginConfigWithMeta = () => ({
			config: { turbo: { strategy: 'standard' } },
			loadedFromFile: false,
		});
	});

	afterEach(() => {
		swarmState.agentSessions.delete(testSessionId);

		try {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		} catch {}

		_internals.loadPluginConfigWithMeta = originalLoadPluginConfigWithMeta;
	});

	async function registeredGuidanceMessages(
		sessionID: string | undefined = testSessionId,
	): Promise<HostPartsMessage[]> {
		const messages: HostPartsMessage[] = [
			{
				info: {
					id: `turbo-request-${sessionID ?? 'anonymous'}`,
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
	// TEST 1: /swarm turbo command toggles turboMode correctly
	// ============================================
	describe('1. /swarm turbo command toggles turboMode correctly', () => {
		it('1.1 turbo command with no args toggles turboMode from false to true', async () => {
			const session = getAgentSession(testSessionId);
			expect(session?.turboMode).toBe(false);

			const result = await handleTurboCommand('/test', [], testSessionId);

			expect(result).toBe(`Turbo Mode enabled. ${TURBO_BYPASS_DISCLOSURE}`);
			expect(session?.turboMode).toBe(true);
		});

		it('1.2 turbo command with no args toggles turboMode from true to false', async () => {
			const session = getAgentSession(testSessionId);
			session!.turboMode = true;

			const result = await handleTurboCommand('/test', [], testSessionId);

			expect(result).toBe('Turbo Mode disabled');
			expect(session?.turboMode).toBe(false);
		});

		it('1.3 turbo command with "on" arg enables turboMode', async () => {
			const session = getAgentSession(testSessionId);
			expect(session?.turboMode).toBe(false);

			const result = await handleTurboCommand('/test', ['on'], testSessionId);

			expect(result).toBe(`Turbo Mode enabled. ${TURBO_BYPASS_DISCLOSURE}`);
			expect(session?.turboMode).toBe(true);
		});

		it('1.4 turbo command with "off" arg disables turboMode', async () => {
			const session = getAgentSession(testSessionId);
			session!.turboMode = true;

			const result = await handleTurboCommand('/test', ['off'], testSessionId);

			expect(result).toBe('Turbo Mode disabled');
			expect(session?.turboMode).toBe(false);
		});

		it('1.5 turbo command without session returns error message', async () => {
			const result = await handleTurboCommand(
				'/test',
				[],
				'nonexistent-session',
			);

			expect(result).toContain('Error');
			expect(result).toContain('No active session');
		});
	});

	// ============================================
	// TEST 2: checkReviewerGate bypasses Stage B when turboMode is active AND task is not Tier 3
	// ============================================
	describe('2. checkReviewerGate bypasses Stage B when turboMode is active', () => {
		it('2.1 turboMode active + non-Tier3 task = bypass Stage B', async () => {
			// Set turboMode to true
			const session = getAgentSession(testSessionId);
			session!.turboMode = true;

			// Create plan.json with non-Tier3 task
			const plan = {
				phases: [
					{
						tasks: [
							{ id: '1.1', files_touched: ['src/utils.ts', 'src/helpers.ts'] },
						],
					},
				],
			};
			fs.mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });
			fs.writeFileSync(
				path.join(tmpDir, '.swarm', 'plan.json'),
				JSON.stringify(plan, null, 2),
			);

			const result = checkReviewerGate('1.1', tmpDir);

			expect(result.blocked).toBe(false);
			expect(result.reason).toBe('Turbo Mode bypass');
		});

		it('2.2 turboMode inactive = normal gate check (blocked without evidence)', async () => {
			// turboMode is false by default
			const session = getAgentSession(testSessionId);
			session!.turboMode = false;

			const result = checkReviewerGate('1.1', tmpDir);

			// Without evidence, should be blocked (or unblocked if no sessions)
			// This tests that turboMode: false does NOT bypass
			expect(result.blocked).toBe(true);
		});

		it('2.3 turboMode active + Tier3 task = NOT bypassed (full review required)', async () => {
			// Set turboMode to true
			const session = getAgentSession(testSessionId);
			session!.turboMode = true;

			// Create plan.json with Tier3 task (security-sensitive file)
			const plan = {
				phases: [
					{
						tasks: [
							{
								id: '1.2',
								files_touched: ['src/agents/architect.ts', 'src/guards.ts'],
							},
						],
					},
				],
			};
			fs.mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });
			fs.writeFileSync(
				path.join(tmpDir, '.swarm', 'plan.json'),
				JSON.stringify(plan, null, 2),
			);

			const result = checkReviewerGate('1.2', tmpDir);

			// Tier3 task should NOT be bypassed - should be blocked without evidence
			expect(result.blocked).toBe(true);
		});

		it('2.4 turboMode active + no plan.json = normal gate check', async () => {
			// Set turboMode to true
			const session = getAgentSession(testSessionId);
			session!.turboMode = true;

			// Don't create plan.json - this tests the fallback path
			const result = checkReviewerGate('1.3', tmpDir);

			// Without plan.json, should fall through to normal gate check
			// Should be blocked without evidence
			expect(result.blocked).toBe(true);
		});
	});

	// ============================================
	// TEST 3: Evidence records include turbo flag when recorded under turboMode
	// ============================================
	describe('3. Evidence records include turbo flag when recorded under turboMode', () => {
		it('3.1 reviewer evidence includes turbo: true when session has turboMode: true', async () => {
			const session = getAgentSession(testSessionId);
			session!.turboMode = true;

			// Simulate evidence recording with turboMode active
			const evidence = {
				required_gates: ['reviewer'],
				gates: { reviewer: { status: 'pass' } },
				turbo: hasActiveTurboMode(),
			};

			expect(evidence.turbo).toBe(true);
		});

		it('3.2 reviewer evidence does NOT have turbo: true when session has turboMode: false', async () => {
			const session = getAgentSession(testSessionId);
			session!.turboMode = false;

			// Simulate evidence recording with turboMode inactive
			const evidence = {
				required_gates: ['reviewer'],
				gates: { reviewer: { status: 'pass' } },
				turbo: hasActiveTurboMode(),
			};

			expect(evidence.turbo).toBe(false);
		});

		it('3.3 hasActiveTurboMode returns true when session has turboMode: true', () => {
			const session = getAgentSession(testSessionId);
			session!.turboMode = true;

			expect(hasActiveTurboMode()).toBe(true);
		});

		it('3.4 hasActiveTurboMode returns false when session has turboMode: false', () => {
			const session = getAgentSession(testSessionId);
			session!.turboMode = false;

			expect(hasActiveTurboMode()).toBe(false);
		});
	});

	// ============================================
	// TEST 4: System-enhancer hook injects TURBO MODE ACTIVE banner when active
	// ============================================
	describe('4. System-enhancer hook injects TURBO MODE ACTIVE banner when active', () => {
		it('4.1 system-enhancer hook injects TURBO MODE ACTIVE banner when turboMode is true', async () => {
			const session = getAgentSession(testSessionId);
			session!.turboMode = true;

			const systemPrompt = guidanceText(
				await registeredGuidanceMessages(testSessionId),
			);

			expect(systemPrompt).toContain('## 🚀 TURBO MODE ACTIVE');
			expect(systemPrompt).toContain('Speed optimization enabled');
		});

		it('4.2 system-enhancer hook does NOT inject TURBO MODE ACTIVE banner when turboMode is false', async () => {
			const session = getAgentSession(testSessionId);
			session!.turboMode = false;

			const systemPrompt = guidanceText(
				await registeredGuidanceMessages(testSessionId),
			);

			expect(systemPrompt).not.toContain('## 🚀 TURBO MODE ACTIVE');
			expect(systemPrompt).not.toContain('Speed optimization enabled');
		});

		it('4.3 delivers the banner for an explicitly identified turbo session', async () => {
			// Create a second session with turboMode: true
			const secondSessionId = `turbo-regression-second-${Date.now()}`;
			swarmState.agentSessions.set(secondSessionId, {
				...getAgentSession(testSessionId)!,
				turboMode: true,
			});

			const systemPrompt = guidanceText(
				await registeredGuidanceMessages(secondSessionId),
			);

			// Banner should appear because SOME session has turboMode: true
			expect(systemPrompt).toContain('## 🚀 TURBO MODE ACTIVE');

			// Cleanup second session
			swarmState.agentSessions.delete(secondSessionId);
		});

		it('4.4 system-enhancer hook does NOT show banner when no sessions exist', async () => {
			// Remove all sessions
			const testSession = getAgentSession(testSessionId)!;
			swarmState.agentSessions.clear();

			const systemPrompt = guidanceText(
				await registeredGuidanceMessages(undefined),
			);

			// No sessions, so no turbo mode
			expect(systemPrompt).not.toContain('## 🚀 TURBO MODE ACTIVE');

			// Restore the test session
			swarmState.agentSessions.set(testSessionId, testSession);
		});

		it('4.5 system-enhancer hook banner contains correct Tier/Stage instructions', async () => {
			const session = getAgentSession(testSessionId);
			session!.turboMode = true;

			const systemPrompt = guidanceText(
				await registeredGuidanceMessages(testSessionId),
			);

			expect(systemPrompt).toContain('Stage A gates');
			expect(systemPrompt).toContain('Stage B');
			expect(systemPrompt).toContain('TIER 3');
			expect(systemPrompt).toContain('Tier 0-2');
			expect(systemPrompt).toContain('Speed optimization enabled');
		});
	});

	// ============================================
	// TEST 5: Status output shows TURBO MODE indicator when active
	// ============================================
	describe('5. Status output shows TURBO MODE indicator when active', () => {
		it('5.1 status shows TURBO MODE indicator when turboMode is true', async () => {
			const session = getAgentSession(testSessionId);
			session!.turboMode = true;

			const statusData: StatusData = {
				currentPhase: 'Phase 1',
				completedTasks: 5,
				totalTasks: 10,
				agentCount: 3,
				hasPlan: true,
				isLegacy: false,
				turboMode: true,
				contextBudgetPct: null,
				compactionCount: 0,
				lastSnapshotAt: null,
			};

			const output = formatStatusMarkdown(statusData);

			expect(output).toContain('**TURBO MODE**: active');
		});

		it('5.2 status does NOT show TURBO MODE indicator when turboMode is false', async () => {
			const session = getAgentSession(testSessionId);
			session!.turboMode = false;

			const statusData: StatusData = {
				currentPhase: 'Phase 1',
				completedTasks: 5,
				totalTasks: 10,
				agentCount: 3,
				hasPlan: true,
				isLegacy: false,
				turboMode: false,
				contextBudgetPct: null,
				compactionCount: 0,
				lastSnapshotAt: null,
			};

			const output = formatStatusMarkdown(statusData);

			expect(output).not.toContain('TURBO MODE');
		});

		it('5.3 getStatusData returns turboMode: true when session has turboMode: true', async () => {
			const session = getAgentSession(testSessionId);
			session!.turboMode = true;

			const statusData = await getStatusData(tmpDir, {});

			expect(statusData.turboMode).toBe(true);
		});

		it('5.4 getStatusData returns turboMode: false when session has turboMode: false', async () => {
			const session = getAgentSession(testSessionId);
			session!.turboMode = false;

			const statusData = await getStatusData(tmpDir, {});

			expect(statusData.turboMode).toBe(false);
		});
	});
});
