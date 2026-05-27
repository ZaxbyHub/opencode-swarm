/**
 * Tests for Task 1.2: Concurrency command registration in src/commands/index.ts
 * Verifies import, export, help text, and switch case routing for /swarm concurrency
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { handleConcurrencyCommand } from '../commands/concurrency';
import * as commandsIndex from '../commands/index';
import { COMMAND_REGISTRY, VALID_COMMANDS } from '../commands/registry';
import type { Plan } from '../config/plan-schema';
import { getAgentSession, swarmState } from '../state';

// Mock plan for switch-case routing tests that call handleConcurrencyCommand directly
const mockLoadPlanJsonOnly = mock(async () => null);

mock.module('../plan/manager.js', () => ({
	loadPlanJsonOnly: mockLoadPlanJsonOnly,
	_snapshot_test_exports: {},
}));

function makePlanWithExecutionProfile(
	overrides?: Partial<NonNullable<Plan['execution_profile']>>,
): Plan {
	return {
		schema_version: '1.0.0',
		title: 'test',
		swarm: 'test',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Test Phase',
				status: 'in_progress',
				tasks: [
					{
						id: '1.1',
						phase: 1,
						status: 'pending',
						description: 'test',
						depends: [],
					},
				],
			},
		],
		execution_profile: {
			parallelization_enabled: true,
			max_concurrent_tasks: 4,
			council_parallel: false,
			locked: true,
			...overrides,
		},
	} as Plan;
}

describe('Task 1.2: Concurrency Command Registration', () => {
	describe('Import Verification', () => {
		it('handleConcurrencyCommand should be importable from ./concurrency', () => {
			expect(typeof handleConcurrencyCommand).toBe('function');
		});

		it('handleConcurrencyCommand should accept directory, args, and sessionID parameters', () => {
			// Check the function has the correct arity (3 parameters)
			expect(handleConcurrencyCommand.length).toBe(3);
		});
	});

	describe('Export Verification', () => {
		it('should export handleConcurrencyCommand from commands/index', () => {
			// Verify the export exists in the commands index module
			expect(commandsIndex).toBeDefined();
			expect(
				typeof (commandsIndex as Record<string, unknown>)
					.handleConcurrencyCommand,
			).toBe('function');
		});

		it('exported handleConcurrencyCommand should be the same function as imported', () => {
			const exported = (commandsIndex as Record<string, unknown>)
				.handleConcurrencyCommand;
			expect(exported).toBe(handleConcurrencyCommand);
		});
	});

	describe('Command Registry Verification', () => {
		it('COMMAND_REGISTRY should contain concurrency entry', () => {
			expect(typeof COMMAND_REGISTRY.concurrency).toBe('object');
		});

		it('COMMAND_REGISTRY.concurrency.handler should be a function', () => {
			expect(typeof COMMAND_REGISTRY.concurrency.handler).toBe('function');
		});

		it('COMMAND_REGISTRY.concurrency should have description, args, details, and category', () => {
			const entry = COMMAND_REGISTRY.concurrency;
			expect(typeof entry.description).toBe('string');
			expect(entry.description.length).toBeGreaterThan(0);
			expect(typeof entry.args).toBe('string');
			expect(typeof entry.details).toBe('string');
			expect(typeof entry.category).toBe('string');
		});

		it('VALID_COMMANDS should include concurrency', () => {
			expect(VALID_COMMANDS).toContain('concurrency');
		});
	});

	describe('Help Text Verification', () => {
		it('buildHelpText should contain /swarm concurrency with its description', async () => {
			const handler = commandsIndex.createSwarmCommandHandler('/tmp', {});
			const output = { parts: [] as unknown[] };

			await handler(
				{ command: 'swarm', arguments: '', sessionID: 'no-session' },
				output,
			);

			const text = (output.parts[0] as { text: string }).text;
			expect(text).toContain('/swarm concurrency');
			expect(text).toContain(
				'Manage runtime concurrency override for plan execution',
			);
		});

		it('HELP_TEXT should document subcommands (set, status, reset)', async () => {
			const handler = commandsIndex.createSwarmCommandHandler('/tmp', {});
			const output = { parts: [] as unknown[] };

			await handler(
				{ command: 'swarm', arguments: '', sessionID: 'no-session' },
				output,
			);

			const text = (output.parts[0] as { text: string }).text;
			expect(text.toLowerCase()).toContain('set');
			expect(text.toLowerCase()).toContain('status');
			expect(text.toLowerCase()).toContain('reset');
		});
	});

	describe('Switch Case Routing', () => {
		let testSessionId: string;

		beforeEach(() => {
			// Mock plan for handler calls
			mockLoadPlanJsonOnly.mockImplementation(() =>
				Promise.resolve(makePlanWithExecutionProfile()),
			);
			// Create a test session
			testSessionId = `concurrency-test-${Date.now()}`;
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
				maxConcurrencyOverride: undefined,
			});
		});

		afterEach(() => {
			swarmState.agentSessions.delete(testSessionId);
			mockLoadPlanJsonOnly.mockReset();
			mock.restore();
		});

		it('switch case should route "concurrency" to handler', async () => {
			const handler = commandsIndex.createSwarmCommandHandler(
				'/test-project',
				{},
			);
			const output = { parts: [] as unknown[] };

			await handler(
				{
					command: 'swarm',
					arguments: 'concurrency',
					sessionID: testSessionId,
				},
				output,
			);

			// Should return usage info since no subcommand given
			expect(output.parts).toHaveLength(1);
			expect((output.parts[0] as { text: string }).text).toContain(
				'Concurrency commands',
			);
			expect((output.parts[0] as { text: string }).text).toContain('set');
			expect((output.parts[0] as { text: string }).text).toContain('status');
			expect((output.parts[0] as { text: string }).text).toContain('reset');
		});

		it('switch case should route "concurrency status" correctly', async () => {
			const handler = commandsIndex.createSwarmCommandHandler(
				'/test-project',
				{},
			);
			const output = { parts: [] as unknown[] };

			await handler(
				{
					command: 'swarm',
					arguments: 'concurrency status',
					sessionID: testSessionId,
				},
				output,
			);

			// Should return status message
			expect(output.parts).toHaveLength(1);
			expect((output.parts[0] as { text: string }).text).toContain(
				'Concurrency',
			);
		});

		it('switch case should route "concurrency reset" correctly', async () => {
			// First set an override
			const session = getAgentSession(testSessionId);
			session!.maxConcurrencyOverride = 5;

			const handler = commandsIndex.createSwarmCommandHandler(
				'/test-project',
				{},
			);
			const output = { parts: [] as unknown[] };

			await handler(
				{
					command: 'swarm',
					arguments: 'concurrency reset',
					sessionID: testSessionId,
				},
				output,
			);

			expect((output.parts[0] as { text: string }).text).toContain(
				'Concurrency override cleared',
			);
			// Verify the override was actually cleared
			expect(session?.maxConcurrencyOverride).toBeUndefined();
		});

		it('should return error when no active session', async () => {
			const handler = commandsIndex.createSwarmCommandHandler(
				'/test-project',
				{},
			);
			const output = { parts: [] as unknown[] };

			await handler(
				{
					command: 'swarm',
					arguments: 'concurrency status',
					sessionID: 'non-existent-session',
				},
				output,
			);

			expect((output.parts[0] as { text: string }).text).toContain(
				'Error: No active session',
			);
		});
	});

	describe('Command Registration Integration', () => {
		it('createSwarmCommandHandler should be exported', () => {
			expect(typeof commandsIndex.createSwarmCommandHandler).toBe('function');
		});

		it('concurrency should be recognized as a valid subcommand in registry', () => {
			expect(VALID_COMMANDS).toContain('concurrency');
			expect(typeof COMMAND_REGISTRY.concurrency).toBe('object');
			expect(typeof COMMAND_REGISTRY.concurrency.handler).toBe('function');
			expect(COMMAND_REGISTRY.concurrency.description).toContain('concurrency');
		});
	});
});
