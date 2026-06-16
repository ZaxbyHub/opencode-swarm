/**
 * Regression tests for swarm-pr-review and swarm-issue shortcut command routing.
 *
 * Verifies that the shortcut entries added to opencodeConfig.command in src/index.ts:
 *   'swarm-pr-review': { template: '/swarm pr-review $ARGUMENTS' }
 *   'swarm-issue':     { template: '/swarm issue $ARGUMENTS' }
 *
 * route correctly through createSwarmCommandHandler to the 'pr-review' and 'issue'
 * handlers in COMMAND_REGISTRY.
 *
 * Routing flow:
 *   input.command = 'swarm-pr-review'  →  strip 'swarm-' prefix → 'pr-review'
 *   input.command = 'swarm-issue'      →  strip 'swarm-' prefix → 'issue'
 *   resolveCommand(['pr-review']) / resolveCommand(['issue']) → COMMAND_REGISTRY entry
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createSwarmCommandHandler } from '../../../src/commands';
import { swarmState } from '../../../src/state';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
	return fs.mkdtempSync(
		path.join(os.tmpdir(), 'pr-review-issue-shortcut-test-'),
	);
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

describe('swarm-pr-review and swarm-issue shortcut routing', () => {
	let tempDir: string;
	let sessionId: string;

	beforeEach(() => {
		tempDir = makeTempDir();
		sessionId = `pr-review-issue-test-${Date.now()}`;
		swarmState.fullAutoEnabledInConfig = true;
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

	// -------------------------------------------------------------------------
	// swarm-pr-review shortcut
	// -------------------------------------------------------------------------

	describe('swarm-pr-review shortcut routes to pr-review handler', () => {
		it('returns usage text when no arguments are provided', async () => {
			const handler = createSwarmCommandHandler(tempDir, {});
			const output = { parts: [] as unknown[] };

			await handler(
				{ command: 'swarm-pr-review', arguments: '', sessionID: sessionId },
				output,
			);

			expect(output.parts).toHaveLength(1);
			const text = (output.parts[0] as { text: string }).text;
			// Handler returns USAGE string when no args given
			expect(text).toContain('Usage: /swarm pr-review');
			expect(text).toContain('--council');
			// Must NOT fall through to generic help text
			expect(text).not.toContain('## Swarm Commands');
		});

		it('returns MODE signal when given a valid GitHub PR URL', async () => {
			const handler = createSwarmCommandHandler(tempDir, {});
			const output = { parts: [] as unknown[] };

			await handler(
				{
					command: 'swarm-pr-review',
					arguments: 'https://github.com/owner/repo/pull/42',
					sessionID: sessionId,
				},
				output,
			);

			expect(output.parts).toHaveLength(1);
			const text = (output.parts[0] as { text: string }).text;
			// Handler returns [MODE: PR_REVIEW pr="..." council=false]
			expect(text).toContain('[MODE: PR_REVIEW');
			expect(text).toContain('council=false');
			expect(text).not.toContain('## Swarm Commands');
		});

		it('returns usage text when given an invalid PR URL', async () => {
			const handler = createSwarmCommandHandler(tempDir, {});
			const output = { parts: [] as unknown[] };

			await handler(
				{
					command: 'swarm-pr-review',
					arguments: 'not-a-valid-url',
					sessionID: sessionId,
				},
				output,
			);

			expect(output.parts).toHaveLength(1);
			const text = (output.parts[0] as { text: string }).text;
			// Handler returns error + usage for unparseable input
			expect(text).toContain('Error:');
			expect(text).toContain('Usage: /swarm pr-review');
		});

		it('forwards --council flag to the handler', async () => {
			const handler = createSwarmCommandHandler(tempDir, {});
			const output = { parts: [] as unknown[] };

			await handler(
				{
					command: 'swarm-pr-review',
					arguments: 'https://github.com/owner/repo/pull/42 --council',
					sessionID: sessionId,
				},
				output,
			);

			expect(output.parts).toHaveLength(1);
			const text = (output.parts[0] as { text: string }).text;
			expect(text).toContain('[MODE: PR_REVIEW');
			expect(text).toContain('council=true');
		});

		it('accepts owner/repo#N shorthand format', async () => {
			const handler = createSwarmCommandHandler(tempDir, {});
			const output = { parts: [] as unknown[] };

			await handler(
				{
					command: 'swarm-pr-review',
					arguments: 'owner/repo#42',
					sessionID: sessionId,
				},
				output,
			);

			expect(output.parts).toHaveLength(1);
			const text = (output.parts[0] as { text: string }).text;
			expect(text).toContain('[MODE: PR_REVIEW');
			expect(text).toContain('github.com/owner/repo/pull/42');
		});
	});

	// -------------------------------------------------------------------------
	// swarm-issue shortcut
	// -------------------------------------------------------------------------

	describe('swarm-issue shortcut routes to issue handler', () => {
		it('returns usage text when no arguments are provided', async () => {
			const handler = createSwarmCommandHandler(tempDir, {});
			const output = { parts: [] as unknown[] };

			await handler(
				{ command: 'swarm-issue', arguments: '', sessionID: sessionId },
				output,
			);

			expect(output.parts).toHaveLength(1);
			const text = (output.parts[0] as { text: string }).text;
			// Handler returns USAGE string when no args given
			expect(text).toContain('Usage: /swarm issue');
			expect(text).toContain('--plan');
			expect(text).toContain('--trace');
			expect(text).toContain('--no-repro');
			// Must NOT fall through to generic help text
			expect(text).not.toContain('## Swarm Commands');
		});

		it('returns MODE signal when given a valid GitHub issue URL', async () => {
			const handler = createSwarmCommandHandler(tempDir, {});
			const output = { parts: [] as unknown[] };

			await handler(
				{
					command: 'swarm-issue',
					arguments: 'https://github.com/owner/repo/issues/42',
					sessionID: sessionId,
				},
				output,
			);

			expect(output.parts).toHaveLength(1);
			const text = (output.parts[0] as { text: string }).text;
			// Handler returns [MODE: ISSUE_INGEST issue="..."]
			expect(text).toContain('[MODE: ISSUE_INGEST');
			expect(text).toContain('github.com/owner/repo/issues/42');
			expect(text).not.toContain('## Swarm Commands');
		});

		it('returns usage text when given an invalid issue URL', async () => {
			const handler = createSwarmCommandHandler(tempDir, {});
			const output = { parts: [] as unknown[] };

			await handler(
				{
					command: 'swarm-issue',
					arguments: 'not-a-valid-issue',
					sessionID: sessionId,
				},
				output,
			);

			expect(output.parts).toHaveLength(1);
			const text = (output.parts[0] as { text: string }).text;
			// Handler returns error + usage for unparseable input
			expect(text).toContain('Error:');
			expect(text).toContain('Usage: /swarm issue');
		});

		it('forwards --plan flag to the handler', async () => {
			const handler = createSwarmCommandHandler(tempDir, {});
			const output = { parts: [] as unknown[] };

			await handler(
				{
					command: 'swarm-issue',
					arguments: 'https://github.com/owner/repo/issues/42 --plan',
					sessionID: sessionId,
				},
				output,
			);

			expect(output.parts).toHaveLength(1);
			const text = (output.parts[0] as { text: string }).text;
			expect(text).toContain('[MODE: ISSUE_INGEST');
			expect(text).toContain('plan=true');
		});

		it('forwards --trace flag to the handler', async () => {
			const handler = createSwarmCommandHandler(tempDir, {});
			const output = { parts: [] as unknown[] };

			await handler(
				{
					command: 'swarm-issue',
					arguments: 'https://github.com/owner/repo/issues/42 --trace',
					sessionID: sessionId,
				},
				output,
			);

			expect(output.parts).toHaveLength(1);
			const text = (output.parts[0] as { text: string }).text;
			expect(text).toContain('[MODE: ISSUE_INGEST');
			expect(text).toContain('trace=true');
		});

		it('accepts owner/repo#N shorthand format', async () => {
			const handler = createSwarmCommandHandler(tempDir, {});
			const output = { parts: [] as unknown[] };

			await handler(
				{
					command: 'swarm-issue',
					arguments: 'owner/repo#42',
					sessionID: sessionId,
				},
				output,
			);

			expect(output.parts).toHaveLength(1);
			const text = (output.parts[0] as { text: string }).text;
			expect(text).toContain('[MODE: ISSUE_INGEST');
			expect(text).toContain('github.com/owner/repo/issues/42');
		});
	});

	// -------------------------------------------------------------------------
	// Equivalence with generic /swarm pr-review and /swarm issue paths
	// -------------------------------------------------------------------------

	describe('shortcut and generic paths produce equivalent output', () => {
		it('swarm-pr-review shortcut and /swarm pr-review with URL produce same MODE signal', async () => {
			const handler = createSwarmCommandHandler(tempDir, {});
			const out1 = { parts: [] as unknown[] };
			const out2 = { parts: [] as unknown[] };

			await handler(
				{
					command: 'swarm-pr-review',
					arguments: 'https://github.com/owner/repo/pull/42',
					sessionID: sessionId,
				},
				out1,
			);
			await handler(
				{
					command: 'swarm',
					arguments: 'pr-review https://github.com/owner/repo/pull/42',
					sessionID: sessionId,
				},
				out2,
			);

			expect(out1.parts).toHaveLength(1);
			expect(out2.parts).toHaveLength(1);
			// Both should produce the same MODE signal
			expect((out1.parts[0] as { text: string }).text).toContain(
				'[MODE: PR_REVIEW',
			);
			expect((out2.parts[0] as { text: string }).text).toContain(
				'[MODE: PR_REVIEW',
			);
		});

		it('swarm-issue shortcut and /swarm issue with URL produce same MODE signal', async () => {
			const handler = createSwarmCommandHandler(tempDir, {});
			const out1 = { parts: [] as unknown[] };
			const out2 = { parts: [] as unknown[] };

			await handler(
				{
					command: 'swarm-issue',
					arguments: 'https://github.com/owner/repo/issues/42',
					sessionID: sessionId,
				},
				out1,
			);
			await handler(
				{
					command: 'swarm',
					arguments: 'issue https://github.com/owner/repo/issues/42',
					sessionID: sessionId,
				},
				out2,
			);

			expect(out1.parts).toHaveLength(1);
			expect(out2.parts).toHaveLength(1);
			// Both should produce the same MODE signal
			expect((out1.parts[0] as { text: string }).text).toContain(
				'[MODE: ISSUE_INGEST',
			);
			expect((out2.parts[0] as { text: string }).text).toContain(
				'[MODE: ISSUE_INGEST',
			);
		});
	});

	// -------------------------------------------------------------------------
	// Unknown subcommand via shortcut prefix falls through to help
	// -------------------------------------------------------------------------

	describe('unknown subcommand via shortcut prefix shows help', () => {
		it('swarm-pr-review-unknown shows help text (not crash)', async () => {
			const handler = createSwarmCommandHandler(tempDir, {});
			const output = { parts: [] as unknown[] };

			await handler(
				{
					command: 'swarm-pr-review-unknown',
					arguments: '',
					sessionID: sessionId,
				},
				output,
			);

			expect(output.parts).toHaveLength(1);
			const text = (output.parts[0] as { text: string }).text;
			// Falls through to help text
			expect(text).toContain('not found');
		});
	});
});
