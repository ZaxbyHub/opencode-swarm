/**
 * Regression tests for swarm-* shortcut command routing.
 *
 * When a user selects a shortcut command from the OpenCode command picker
 * (e.g. swarm-config, swarm-status, swarm-turbo), OpenCode sets
 * input.command to the registered key name ('swarm-config') rather than
 * the generic 'swarm' key. Previously the handler returned early for any
 * command that wasn't exactly 'swarm', so these shortcuts fell through to
 * the LLM as plain text. This file verifies they are correctly routed.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { swarmState } from '../state';
import { createSwarmCommandHandler } from './index';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'shortcut-routing-test-'));
}

function makeSession(id: string): void {
	swarmState.agentSessions.set(id, {
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
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('swarm-* shortcut command routing', () => {
	let tempDir: string;
	let sessionId: string;

	beforeEach(() => {
		tempDir = makeTempDir();
		sessionId = `shortcut-test-${Date.now()}`;
		// Enable config-level full-auto so full-auto command activation succeeds
		swarmState.fullAutoEnabledInConfig = true;
		makeSession(sessionId);
		// Pre-create the first-run sentinel so the welcome message is not shown during tests
		const swarmDir = path.join(tempDir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });
		fs.writeFileSync(
			path.join(swarmDir, '.first-run-complete'),
			`first-run-complete: ${new Date().toISOString()}\n`,
		);
	});

	afterEach(() => {
		swarmState.agentSessions.delete(sessionId);
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	describe('Non-swarm commands are ignored', () => {
		it('returns without setting output.parts for unrelated commands', async () => {
			const handler = createSwarmCommandHandler(tempDir, {});
			const output = { parts: [] as unknown[] };

			await handler(
				{ command: 'other', arguments: '', sessionID: sessionId },
				output,
			);

			expect(output.parts).toHaveLength(0);
		});

		it('returns without setting output.parts for commands that start with a different prefix', async () => {
			const handler = createSwarmCommandHandler(tempDir, {});
			const output = { parts: [] as unknown[] };

			await handler(
				{ command: 'notswarm-status', arguments: '', sessionID: sessionId },
				output,
			);

			expect(output.parts).toHaveLength(0);
		});
	});

	describe('Generic swarm command (existing behaviour preserved)', () => {
		it('routes via input.arguments when command is "swarm"', async () => {
			const handler = createSwarmCommandHandler(tempDir, {});
			const output = { parts: [] as unknown[] };

			await handler(
				{ command: 'swarm', arguments: 'agents', sessionID: sessionId },
				output,
			);

			expect(output.parts).toHaveLength(1);
			// With an empty agent map the agents command reports no agents
			expect(typeof (output.parts[0] as { text: string }).text).toBe('string');
		});

		it('shows help text when command is "swarm" with empty arguments', async () => {
			const handler = createSwarmCommandHandler(tempDir, {});
			const output = { parts: [] as unknown[] };

			await handler(
				{ command: 'swarm', arguments: '', sessionID: sessionId },
				output,
			);

			expect(output.parts).toHaveLength(1);
			expect((output.parts[0] as { text: string }).text).toContain(
				'## Swarm Commands',
			);
		});
	});

	describe('swarm-* shortcut commands are routed correctly', () => {
		it('routes swarm-agents shortcut (no extra arguments)', async () => {
			const handler = createSwarmCommandHandler(tempDir, {});
			const output = { parts: [] as unknown[] };

			await handler(
				{ command: 'swarm-agents', arguments: '', sessionID: sessionId },
				output,
			);

			expect(output.parts).toHaveLength(1);
			// With an empty agent map the agents command reports no agents
			expect(typeof (output.parts[0] as { text: string }).text).toBe('string');
		});

		it('routes swarm-config shortcut (no extra arguments)', async () => {
			const handler = createSwarmCommandHandler(tempDir, {});
			const output = { parts: [] as unknown[] };

			await handler(
				{ command: 'swarm-config', arguments: '', sessionID: sessionId },
				output,
			);

			expect(output.parts).toHaveLength(1);
			// Config command returns a markdown section
			const text = (output.parts[0] as { text: string }).text;
			expect(text).toBeTruthy();
			expect(typeof text).toBe('string');
		});

		it('routes swarm-turbo shortcut and forwards extra arguments', async () => {
			const handler = createSwarmCommandHandler(tempDir, {});
			const output = { parts: [] as unknown[] };

			// Simulate user selecting the swarm-turbo shortcut and typing 'on'
			await handler(
				{ command: 'swarm-turbo', arguments: 'on', sessionID: sessionId },
				output,
			);

			expect(output.parts).toHaveLength(1);
			expect((output.parts[0] as { text: string }).text).toBe(
				'Turbo Mode enabled',
			);
			expect(swarmState.agentSessions.get(sessionId)?.turboMode).toBe(true);
		});

		it('routes swarm-turbo shortcut with no extra arguments (toggle)', async () => {
			const handler = createSwarmCommandHandler(tempDir, {});
			const output = { parts: [] as unknown[] };

			// turboMode starts false — toggle should enable it
			await handler(
				{ command: 'swarm-turbo', arguments: '', sessionID: sessionId },
				output,
			);

			expect(output.parts).toHaveLength(1);
			expect((output.parts[0] as { text: string }).text).toBe(
				'Turbo Mode enabled',
			);
		});

		it('routes swarm-full-auto shortcut and forwards extra arguments', async () => {
			const handler = createSwarmCommandHandler(tempDir, {});
			const output = { parts: [] as unknown[] };

			// Simulate user selecting the swarm-full-auto shortcut and typing 'on'
			await handler(
				{ command: 'swarm-full-auto', arguments: 'on', sessionID: sessionId },
				output,
			);

			expect(output.parts).toHaveLength(1);
			expect((output.parts[0] as { text: string }).text).toBe(
				'Full-Auto Mode enabled',
			);
			expect(swarmState.agentSessions.get(sessionId)?.fullAutoMode).toBe(true);
		});

		it('routes swarm-full-auto shortcut with no extra arguments (toggle)', async () => {
			const handler = createSwarmCommandHandler(tempDir, {});
			const output = { parts: [] as unknown[] };

			// fullAutoMode starts false — toggle should enable it
			await handler(
				{ command: 'swarm-full-auto', arguments: '', sessionID: sessionId },
				output,
			);

			expect(output.parts).toHaveLength(1);
			expect((output.parts[0] as { text: string }).text).toBe(
				'Full-Auto Mode enabled',
			);
		});

		it('routes swarm-reset shortcut (no --confirm → shows safety prompt)', async () => {
			const handler = createSwarmCommandHandler(tempDir, {});
			const output = { parts: [] as unknown[] };

			await handler(
				{ command: 'swarm-reset', arguments: '', sessionID: sessionId },
				output,
			);

			expect(output.parts).toHaveLength(1);
			const text = (output.parts[0] as { text: string }).text;
			// Without --confirm the reset command shows a safety prompt
			expect(text).toContain('--confirm');
		});

		it('routes a compound shortcut like swarm-sync-plan correctly', async () => {
			const handler = createSwarmCommandHandler(tempDir, {});
			const output = { parts: [] as unknown[] };

			await handler(
				{ command: 'swarm-sync-plan', arguments: '', sessionID: sessionId },
				output,
			);

			expect(output.parts).toHaveLength(1);
			// sync-plan returns some output (may warn about missing files)
			expect(typeof (output.parts[0] as { text: string }).text).toBe('string');
		});

		// Regression: swarm-config-doctor and swarm-evidence-summary extract a dash-joined
		// subcommand ('config-doctor', 'evidence-summary') but the registry historically only had
		// space-joined keys ('config doctor', 'evidence summary').  The fix adds dash-joined aliases
		// so these shortcuts no longer silently fall through to the help text.
		it('routes swarm-config-doctor shortcut (not help text)', async () => {
			const handler = createSwarmCommandHandler(tempDir, {});
			const output = { parts: [] as unknown[] };

			await handler(
				{ command: 'swarm-config-doctor', arguments: '', sessionID: sessionId },
				output,
			);

			expect(output.parts).toHaveLength(1);
			const text = (output.parts[0] as { text: string }).text;
			// Must NOT fall through to generic help text
			expect(text).not.toContain('## Swarm Commands');
			// Should return a config doctor report
			expect(text).toContain('Config Doctor');
		});

		it('routes swarm-evidence-summary shortcut (not help text)', async () => {
			const handler = createSwarmCommandHandler(tempDir, {});
			const output = { parts: [] as unknown[] };

			await handler(
				{
					command: 'swarm-evidence-summary',
					arguments: '',
					sessionID: sessionId,
				},
				output,
			);

			expect(output.parts).toHaveLength(1);
			const text = (output.parts[0] as { text: string }).text;
			// Must NOT fall through to generic help text
			expect(text).not.toContain('## Swarm Commands');
		});

		it('routes swarm-deep-dive shortcut (not help text)', async () => {
			const handler = createSwarmCommandHandler(tempDir, {});
			const output = { parts: [] as unknown[] };

			await handler(
				{
					command: 'swarm-deep-dive',
					arguments: '',
					sessionID: sessionId,
				},
				output,
			);

			expect(output.parts).toHaveLength(1);
			const text = (output.parts[0] as { text: string }).text;
			// Must NOT fall through to generic help text
			expect(text).not.toContain('## Swarm Commands');
		});
	});

	describe('swarm-* shortcut with unknown subcommand shows help', () => {
		it('returns help text when the extracted subcommand is not registered', async () => {
			const handler = createSwarmCommandHandler(tempDir, {});
			const output = { parts: [] as unknown[] };

			await handler(
				{ command: 'swarm-unknowncmd', arguments: '', sessionID: sessionId },
				output,
			);

			expect(output.parts).toHaveLength(1);
			expect((output.parts[0] as { text: string }).text).toContain(
				'## Swarm Commands',
			);
		});
	});

	// Regression: 'diagnosis' alias — users commonly type this instead of 'diagnose'.
	// Both the generic swarm handler and the swarm-diagnosis shortcut must resolve correctly.
	describe("'diagnosis' alias routes to health check (issue #588)", () => {
		it('/swarm diagnosis (generic handler) returns health check output', async () => {
			const handler = createSwarmCommandHandler(tempDir, {});
			const output = { parts: [] as unknown[] };

			await handler(
				{ command: 'swarm', arguments: 'diagnosis', sessionID: sessionId },
				output,
			);

			expect(output.parts).toHaveLength(1);
			const text = (output.parts[0] as { text: string }).text;
			expect(text).not.toContain('## Swarm Commands');
			expect(text).toContain('## Swarm Health Check');
		});

		it('swarm-diagnosis shortcut routes to health check output', async () => {
			const handler = createSwarmCommandHandler(tempDir, {});
			const output = { parts: [] as unknown[] };

			await handler(
				{ command: 'swarm-diagnosis', arguments: '', sessionID: sessionId },
				output,
			);

			expect(output.parts).toHaveLength(1);
			const text = (output.parts[0] as { text: string }).text;
			expect(text).not.toContain('## Swarm Commands');
			expect(text).toContain('## Swarm Health Check');
		});

		it('/swarm diagnose and /swarm diagnosis return the same kind of output', async () => {
			const handler = createSwarmCommandHandler(tempDir, {});
			const out1 = { parts: [] as unknown[] };
			const out2 = { parts: [] as unknown[] };

			await handler(
				{ command: 'swarm', arguments: 'diagnose', sessionID: sessionId },
				out1,
			);
			await handler(
				{ command: 'swarm', arguments: 'diagnosis', sessionID: sessionId },
				out2,
			);

			expect(out1.parts).toHaveLength(1);
			expect(out2.parts).toHaveLength(1);
			// Both must contain the health-check heading
			expect((out1.parts[0] as { text: string }).text).toContain(
				'## Swarm Health Check',
			);
			expect((out2.parts[0] as { text: string }).text).toContain(
				'## Swarm Health Check',
			);
		});
	});

	// Regression: adding 'config-doctor' (dash) alias must not break the original
	// space-based path '/swarm config doctor' which uses the generic swarm handler.
	describe('Backward compatibility: space-based compound commands still work', () => {
		it('/swarm config doctor (space path) still returns Config Doctor output', async () => {
			const handler = createSwarmCommandHandler(tempDir, {});
			const output = { parts: [] as unknown[] };

			await handler(
				{ command: 'swarm', arguments: 'config doctor', sessionID: sessionId },
				output,
			);

			expect(output.parts).toHaveLength(1);
			const text = (output.parts[0] as { text: string }).text;
			expect(text).not.toContain('## Swarm Commands');
			expect(text).toContain('Config Doctor');
		});

		it('/swarm evidence summary (space path) still returns evidence summary output', async () => {
			const handler = createSwarmCommandHandler(tempDir, {});
			const output = { parts: [] as unknown[] };

			await handler(
				{
					command: 'swarm',
					arguments: 'evidence summary',
					sessionID: sessionId,
				},
				output,
			);

			expect(output.parts).toHaveLength(1);
			const text = (output.parts[0] as { text: string }).text;
			expect(text).not.toContain('## Swarm Commands');
		});
	});
});
