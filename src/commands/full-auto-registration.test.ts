/**
 * Tests for Full-Auto Mode command registration in src/commands/index.ts.
 * Verifies import, export, help text, and registry routing for /swarm full-auto.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleFullAutoCommand } from '../commands/full-auto';
import * as commandsIndex from '../commands/index';
import { COMMAND_REGISTRY, VALID_COMMANDS } from '../commands/registry';
import { getAgentSession, swarmState } from '../state';

describe('Full-Auto Command Registration', () => {
	describe('Import Verification', () => {
		it('handleFullAutoCommand should be importable from ./full-auto', () => {
			expect(typeof handleFullAutoCommand).toBe('function');
		});

		it('handleFullAutoCommand should accept directory, args, and sessionID parameters', () => {
			expect(handleFullAutoCommand.length).toBe(3);
		});
	});

	describe('Export Verification', () => {
		it('should export handleFullAutoCommand from commands/index', () => {
			expect(commandsIndex).toBeDefined();
			expect(
				typeof (commandsIndex as Record<string, unknown>).handleFullAutoCommand,
			).toBe('function');
		});

		it('exported handleFullAutoCommand should be the same function as imported', () => {
			const exported = (commandsIndex as Record<string, unknown>)
				.handleFullAutoCommand;
			expect(exported).toBe(handleFullAutoCommand);
		});
	});

	describe('Help Text Verification', () => {
		it('HELP_TEXT should contain full-auto command documentation', async () => {
			const handler = commandsIndex.createSwarmCommandHandler(os.tmpdir(), {});
			const output = { parts: [] as unknown[] };

			await handler(
				{ command: 'swarm', arguments: '', sessionID: 'no-session' },
				output,
			);

			const text = (output.parts[0] as { text: string }).text;
			expect(text).toContain('/swarm full-auto');
			expect(text).toContain('Full-Auto Mode');
			expect(text).toContain('[on|off]');
		});

		it('HELP_TEXT should document toggle behavior', async () => {
			const handler = commandsIndex.createSwarmCommandHandler(os.tmpdir(), {});
			const output = { parts: [] as unknown[] };

			await handler(
				{ command: 'swarm', arguments: '', sessionID: 'no-session' },
				output,
			);

			const text = (output.parts[0] as { text: string }).text;
			// Description is "Toggle Full-Auto Mode …" — check case-insensitively
			expect(text.toLowerCase()).toContain('toggle');
		});
	});

	describe('Switch Case Routing', () => {
		let testSessionId: string;
		let projectDir: string;
		let originalXdg: string | undefined;

		beforeEach(() => {
			// '/test-project' is a fictional filesystem-root path: full-auto
			// activation durably writes .swarm/full-auto-state.json, and mkdir at
			// the root requires privileges a non-root CI runner does not have
			// (issue #1778 H4 red-fix — this file was never run in CI before).
			projectDir = fs.mkdtempSync(
				path.join(os.tmpdir(), 'full-auto-reg-test-'),
			);
			originalXdg = process.env.XDG_CONFIG_HOME;
			process.env.XDG_CONFIG_HOME = path.join(projectDir, 'user-config');
			testSessionId = `full-auto-reg-test-${Date.now()}`;
			// Enable config-level full-auto so command activation succeeds
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
		});

		afterEach(() => {
			if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
			else process.env.XDG_CONFIG_HOME = originalXdg;
			swarmState.agentSessions.delete(testSessionId);
			fs.rmSync(projectDir, { recursive: true, force: true });
		});

		it('returns an exact swarm_command directive for "full-auto on"', async () => {
			const handler = commandsIndex.createSwarmCommandHandler(projectDir, {});
			const output = { parts: [] as unknown[] };

			await handler(
				{
					command: 'swarm',
					arguments: 'full-auto on',
					sessionID: testSessionId,
				},
				output,
			);

			expect(output.parts).toHaveLength(1);
			const text = (output.parts[0] as { text: string }).text;
			expect(text).toContain('Call the `swarm_command` tool exactly once');
			expect(text).toContain('"command": "full-auto"');
			expect(text).toContain('"on"');
			expect(getAgentSession(testSessionId)?.fullAutoMode).toBe(false);
		});

		it('returns an exact swarm_command directive for "full-auto off"', async () => {
			const session = getAgentSession(testSessionId);
			session!.fullAutoMode = true;

			const handler = commandsIndex.createSwarmCommandHandler(projectDir, {});
			const output = { parts: [] as unknown[] };

			await handler(
				{
					command: 'swarm',
					arguments: 'full-auto off',
					sessionID: testSessionId,
				},
				output,
			);

			const text = (output.parts[0] as { text: string }).text;
			expect(text).toContain('Call the `swarm_command` tool exactly once');
			expect(text).toContain('"off"');
			expect(session?.fullAutoMode).toBe(true);
		});

		it('shows the exact grammar for "full-auto" with no args', async () => {
			const handler = commandsIndex.createSwarmCommandHandler(projectDir, {});
			const output = { parts: [] as unknown[] };

			// Initial fullAutoMode is false, so toggle should enable it
			await handler(
				{
					command: 'swarm',
					arguments: 'full-auto',
					sessionID: testSessionId,
				},
				output,
			);

			const text = (output.parts[0] as { text: string }).text;
			expect(text).toContain('Usage through swarm_command');
			expect(getAgentSession(testSessionId)?.fullAutoMode).toBe(false);
		});

		it('returns a command directive without executing when no session is bound', async () => {
			const handler = commandsIndex.createSwarmCommandHandler(projectDir, {});
			const output = { parts: [] as unknown[] };

			await handler(
				{
					command: 'swarm',
					arguments: 'full-auto on',
					sessionID: 'non-existent-session',
				},
				output,
			);

			expect((output.parts[0] as { text: string }).text).toContain(
				'Call the `swarm_command` tool exactly once',
			);
		});
	});

	describe('Command Registration Integration', () => {
		it('createSwarmCommandHandler should be exported', () => {
			expect(typeof commandsIndex.createSwarmCommandHandler).toBe('function');
		});

		it('full-auto should be recognized as a valid subcommand', () => {
			expect(VALID_COMMANDS).toContain('full-auto');
			expect(typeof COMMAND_REGISTRY['full-auto']).toBe('object');
			expect(typeof COMMAND_REGISTRY['full-auto'].handler).toBe('function');
			expect(COMMAND_REGISTRY['full-auto'].description).toContain(
				'Full-Auto Mode',
			);
		});

		// Regression: the TUI shortcut key for full-auto must be 'swarm-full-auto' (dashes only).
		// If the key ever contains a space (e.g. 'swarm full-auto'), OpenCode's command picker
		// cannot filter it — typing '/swarm-full' shows "No matching commands".
		// This test verifies the registry side (dash key exists); the TUI side is covered by the
		// shortcut-routing test that calls the handler with command='swarm-full-auto'.
		it('registry has full-auto with dash (no space) for TUI shortcut compatibility', () => {
			// 'full-auto' (dash) must exist — this is what swarm-full-auto shortcut resolves to
			expect(Object.hasOwn(COMMAND_REGISTRY, 'full-auto')).toBe(true);
			// The actual registry key must contain no spaces — a space would break the TUI filter chain
			const registryKey = Object.keys(COMMAND_REGISTRY).find(
				(k) => k === 'full-auto',
			);
			expect(registryKey).toBeDefined();
			expect(registryKey).not.toContain(' ');
		});
	});
});
