/**
 * Tests for command-not-found UX improvement in createSwarmCommandHandler.
 *
 * Covers:
 * - Unknown single-word command shows "Command not found" + suggestions + footer
 * - Unknown compound command shows header with command name
 * - Empty tokens (empty array) → returns buildHelpText() output
 * - Command with no similar matches → shows header + footer only (no "Did you mean" section)
 * - Multiple similar commands returned → all shown with bullet format
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { swarmState } from '../state';
import { createSwarmCommandHandler } from './index';
import { _internals } from './registry';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-not-found-test-'));
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
// Test suite
// ---------------------------------------------------------------------------

describe('Command-not-found UX', () => {
	let tempDir: string;
	let sessionId: string;

	beforeEach(() => {
		tempDir = makeTempDir();
		sessionId = `cmd-not-found-test-${Date.now()}`;
		makeSession(sessionId);

		// Pre-create a marker file to ensure .swarm directory is non-empty
		const swarmDir = path.join(tempDir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });
		fs.writeFileSync(
			path.join(swarmDir, '.test-marker'),
			`test-marker: ${new Date().toISOString()}\n`,
		);
	});

	afterEach(() => {
		swarmState.agentSessions.delete(sessionId);
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	describe('Unknown single-word command', () => {
		it('shows "Command not found" + suggestions + footer', async () => {
			// Mock findSimilarCommands to return ['config', 'diagnose', 'check']
			const mockFindSimilar = mock(() => ['config', 'diagnose', 'check']);
			const originalFn = _internals.findSimilarCommands;
			_internals.findSimilarCommands = mockFindSimilar;

			try {
				const handler = createSwarmCommandHandler(tempDir, {});
				const output = { parts: [] as unknown[] };

				await handler(
					{ command: 'swarm', arguments: 'confg', sessionID: sessionId },
					output,
				);

				expect(output.parts).toHaveLength(1);
				const text = (output.parts[0] as { text: string }).text;

				// Header with the attempted command
				expect(text).toContain('Command `/swarm confg` not found.');
				// Suggestions section with bullet format
				expect(text).toContain('Did you mean:');
				expect(text).toContain('  - /swarm config');
				expect(text).toContain('  - /swarm diagnose');
				expect(text).toContain('  - /swarm check');
				// Footer
				expect(text).toContain('Run `/swarm help` for all commands.');
			} finally {
				_internals.findSimilarCommands = originalFn;
			}
		});
	});

	describe('Unknown compound command', () => {
		it('shows header with compound command name', async () => {
			// Mock findSimilarCommands to return empty (no similar matches)
			const mockFindSimilar = mock(() => []);
			const originalFn = _internals.findSimilarCommands;
			_internals.findSimilarCommands = mockFindSimilar;

			try {
				const handler = createSwarmCommandHandler(tempDir, {});
				const output = { parts: [] as unknown[] };

				await handler(
					{
						command: 'swarm',
						arguments: 'nonexistent-subcommand',
						sessionID: sessionId,
					},
					output,
				);

				expect(output.parts).toHaveLength(1);
				const text = (output.parts[0] as { text: string }).text;

				// Header should contain the compound command name
				expect(text).toContain(
					'Command `/swarm nonexistent-subcommand` not found.',
				);
			} finally {
				_internals.findSimilarCommands = originalFn;
			}
		});
	});

	describe('Empty tokens (empty array)', () => {
		it('returns buildHelpText() output', async () => {
			const handler = createSwarmCommandHandler(tempDir, {});
			const output = { parts: [] as unknown[] };

			// Empty arguments means empty tokens array after split
			await handler(
				{ command: 'swarm', arguments: '', sessionID: sessionId },
				output,
			);

			expect(output.parts).toHaveLength(1);
			const text = (output.parts[0] as { text: string }).text;

			// Should show full help text when tokens are empty
			expect(text).toContain('## Swarm Commands');
			expect(text).toContain('/swarm status');
			expect(text).toContain('/swarm agents');
		});
	});

	describe('Command with no similar matches', () => {
		it('shows header + footer only (no "Did you mean" section)', async () => {
			// Mock findSimilarCommands to return empty array
			const mockFindSimilar = mock(() => [] as string[]);
			const originalFn = _internals.findSimilarCommands;
			_internals.findSimilarCommands = mockFindSimilar;

			try {
				const handler = createSwarmCommandHandler(tempDir, {});
				const output = { parts: [] as unknown[] };

				await handler(
					{ command: 'swarm', arguments: 'xyzabc123', sessionID: sessionId },
					output,
				);

				expect(output.parts).toHaveLength(1);
				const text = (output.parts[0] as { text: string }).text;

				// Header present
				expect(text).toContain('Command `/swarm xyzabc123` not found.');
				// Footer present
				expect(text).toContain('Run `/swarm help` for all commands.');
				// No "Did you mean" section when no similar matches
				expect(text).not.toContain('Did you mean:');
			} finally {
				_internals.findSimilarCommands = originalFn;
			}
		});
	});

	describe('Multiple similar commands returned', () => {
		it('all shown with bullet format', async () => {
			// Mock findSimilarCommands to return multiple commands
			const mockFindSimilar = mock(() => [
				'diagnose',
				'diagnostics',
				'dark-matter',
			]);
			const originalFn = _internals.findSimilarCommands;
			_internals.findSimilarCommands = mockFindSimilar;

			try {
				const handler = createSwarmCommandHandler(tempDir, {});
				const output = { parts: [] as unknown[] };

				// Use "diagnos" (typo of diagnose) as the attempted command
				await handler(
					{ command: 'swarm', arguments: 'diagnos', sessionID: sessionId },
					output,
				);

				expect(output.parts).toHaveLength(1);
				const text = (output.parts[0] as { text: string }).text;

				// All similar commands should appear with bullet format
				expect(text).toContain('  - /swarm diagnose');
				expect(text).toContain('  - /swarm diagnostics');
				expect(text).toContain('  - /swarm dark-matter');
			} finally {
				_internals.findSimilarCommands = originalFn;
			}
		});
	});

	describe('Shortcut command not found', () => {
		it('shows command-not-found UX for swarm-* shortcuts', async () => {
			// Mock findSimilarCommands to return suggestions
			const mockFindSimilar = mock(() => ['status', 'agents']);
			const originalFn = _internals.findSimilarCommands;
			_internals.findSimilarCommands = mockFindSimilar;

			try {
				const handler = createSwarmCommandHandler(tempDir, {});
				const output = { parts: [] as unknown[] };

				// Use a shortcut command that doesn't exist
				await handler(
					{ command: 'swarm-nonexistent', arguments: '', sessionID: sessionId },
					output,
				);

				expect(output.parts).toHaveLength(1);
				const text = (output.parts[0] as { text: string }).text;

				// Should show command-not-found UX for the extracted subcommand
				expect(text).toContain('Command `/swarm nonexistent` not found.');
				expect(text).toContain('Did you mean:');
				expect(text).toContain('  - /swarm status');
				expect(text).toContain('  - /swarm agents');
				expect(text).toContain('Run `/swarm help` for all commands.');
			} finally {
				_internals.findSimilarCommands = originalFn;
			}
		});
	});
});
