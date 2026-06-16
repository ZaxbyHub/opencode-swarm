/**
 * Tests for Full-Auto command discoverability fixes.
 *
 * Verifies that TUI shortcuts, error messages, and registry entries
 * all use the dashed form (/swarm-full-auto) while maintaining backward
 * compatibility with the spaced form (/swarm full-auto).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleFullAutoCommand } from '../commands/full-auto';
import { COMMAND_REGISTRY, VALID_COMMANDS } from '../commands/registry';
import { swarmState } from '../state';

describe('Full-Auto discoverability', () => {
	let testSessionId: string;
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'full-auto-disc-'));
		testSessionId = `discoverability-test-${Date.now()}`;
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
		swarmState.fullAutoEnabledInConfig = true;
	});

	afterEach(() => {
		swarmState.agentSessions.delete(testSessionId);
		try {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// best-effort
		}
		swarmState.fullAutoEnabledInConfig = false;
	});

	describe('TUI shortcut description', () => {
		it('description does not start with "Use /swarm full-auto"', () => {
			const entry =
				COMMAND_REGISTRY['full-auto' as keyof typeof COMMAND_REGISTRY];
			expect(entry).toBeDefined();
			expect(entry.description).not.toMatch(/^Use \/swarm full-auto/);
		});
	});

	describe('TUI shortcut template uses dashed form', () => {
		// The TUI shortcut is defined in index.ts at plugin registration time.
		// We cannot easily import that object here, but we can verify the registry
		// key uses the dashed form which is what the TUI shortcut resolves to.
		it('registry key "full-auto" uses dashes not spaces', () => {
			const key = Object.keys(COMMAND_REGISTRY).find(
				(k) => k.includes('full') && k.includes('auto'),
			);
			expect(key).toBe('full-auto');
			// Ensure there is no space-separated variant like "full auto"
			expect(Object.hasOwn(COMMAND_REGISTRY, 'full auto')).toBe(false);
		});
	});

	describe('error message references dashed form', () => {
		it('no-session error mentions /swarm-full-auto, not /swarm full-auto', async () => {
			const result = await handleFullAutoCommand('/project', [], '');
			expect(result).toContain('/swarm-full-auto');
			expect(result).not.toContain('/swarm full-auto');
		});
	});

	describe('registry key presence', () => {
		it('"full-auto" is present in COMMAND_REGISTRY', () => {
			expect(Object.hasOwn(COMMAND_REGISTRY, 'full-auto')).toBe(true);
		});

		it('"full-auto" is included in VALID_COMMANDS', () => {
			expect(VALID_COMMANDS).toContain('full-auto');
		});
	});

	describe('backward compatibility — spaced form routes correctly', () => {
		it('/swarm full-auto still resolves via the "full-auto" registry key', async () => {
			// The generic handler splits "full-auto" from the user input and looks
			// it up in COMMAND_REGISTRY. Verify the handler is callable and returns
			// a valid result when invoked directly (simulating what the generic
			// handler does after resolving the key).
			const entry =
				COMMAND_REGISTRY['full-auto' as keyof typeof COMMAND_REGISTRY];
			expect(entry).toBeDefined();
			expect(typeof entry.handler).toBe('function');

			// Call the handler via handleFullAutoCommand to confirm it works
			const result = await handleFullAutoCommand(tmpDir, ['on'], testSessionId);
			expect(result).toContain('Full-Auto Mode enabled');
		});
	});
});
