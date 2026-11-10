/**
 * Adversarial tests for Lean Turbo runtime conformance.
 *
 * ONLY attack vectors — malformed inputs, boundary violations, injection attempts.
 * Does NOT repeat existing conformance tests from runtime-conformance.test.ts.
 *
 * Attack surface covered:
 *  1. Invalid phase numbers in verifyLeanTurboPhaseReady (NaN, Infinity, negative, zero, MAX_SAFE_INTEGER)
 *  2. Session ID injection in handleTurboCommand (empty, whitespace, template literals, newlines)
 *  3. Corrupt/missing plan.json for verifyLeanTurboPhaseReady
 *  4. executePhaseComplete with invalid phase inputs (NaN, negative, zero, 1.5)
 *  5. checkReviewerGate with adversarial task IDs (path traversal, null byte)
 *  6. verifyLeanTurboPhaseReady with corrupted persisted state (wrong types, mismatches)
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleTurboCommand } from '../../../../src/commands/turbo';
import {
	resetSwarmState,
	startAgentSession,
	swarmState,
} from '../../../../src/state';
import { executePhaseComplete } from '../../../../src/tools/phase-complete';
import { checkReviewerGate } from '../../../../src/tools/update-task-status';
import { _internals as phaseReadyInternals } from '../../../../src/turbo/lean/phase-ready';
import { repairStateUnreadable } from '../../../../src/turbo/lean/state';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SESSION_ID = 'conformance-adversarial';

function mkdtemp(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lean-conformance-adv-'));
	fs.mkdirSync(path.join(dir, '.swarm', 'evidence', '1', 'lean-turbo'), {
		recursive: true,
	});
	fs.mkdirSync(path.join(dir, '.opencode'), { recursive: true });
	return dir;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Lean Turbo runtime conformance — adversarial', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	afterEach(() => {
		mock.restore();
		resetSwarmState();
		// Reset the module-level stateUnreadable flag between tests.
		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), 'lean-conformance-adv-cleanup-'),
		);
		repairStateUnreadable(tmpDir);
		try {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// Best-effort cleanup
		}
	});

	// -------------------------------------------------------------------------
	// Attack 1: Invalid phase numbers in verifyLeanTurboPhaseReady
	// -------------------------------------------------------------------------

	describe('invalid phase numbers — verifyLeanTurboPhaseReady', () => {
		test('NaN phase number is handled', () => {
			const dir = mkdtemp();
			try {
				startAgentSession(SESSION_ID, 'architect');
				const session = swarmState.agentSessions.get(SESSION_ID);
				session!.turboMode = false;
				session!.turboStrategy = 'lean';
				session!.leanTurboActive = true;

				const turboState = {
					version: 1,
					updatedAt: new Date().toISOString(),
					sessions: {
						[SESSION_ID]: {
							status: 'running',
							sessionID: SESSION_ID,
							strategy: 'lean',
							phase: 1,
							maxParallelCoders: 2,
							lanes: [],
							degradedTasks: [],
							counters: {
								lanesPlanned: 0,
								lanesStarted: 0,
								lanesCompleted: 0,
								lanesFailed: 0,
								tasksSerialized: 0,
								tasksDegraded: 0,
							},
						},
					},
				};
				fs.writeFileSync(
					path.join(dir, '.swarm', 'turbo-state.json'),
					JSON.stringify(turboState),
				);

				// NaN never equals a persisted phase, so no running session matches.
				const result = phaseReadyInternals.verifyLeanTurboPhaseReady(
					dir,
					Number.NaN,
					SESSION_ID,
				);
				expect(result.ok).toBe(false);
				expect(result.reason).toContain(
					'No active Lean Turbo session for phase NaN',
				);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});

		test('Infinity phase number is handled', () => {
			const dir = mkdtemp();
			try {
				startAgentSession(SESSION_ID, 'architect');
				const session = swarmState.agentSessions.get(SESSION_ID);
				session!.turboMode = false;
				session!.turboStrategy = 'lean';
				session!.leanTurboActive = true;

				const turboState = {
					version: 1,
					updatedAt: new Date().toISOString(),
					sessions: {
						[SESSION_ID]: {
							status: 'running',
							sessionID: SESSION_ID,
							strategy: 'lean',
							phase: 1,
							maxParallelCoders: 2,
							lanes: [],
							degradedTasks: [],
							counters: {
								lanesPlanned: 0,
								lanesStarted: 0,
								lanesCompleted: 0,
								lanesFailed: 0,
								tasksSerialized: 0,
								tasksDegraded: 0,
							},
						},
					},
				};
				fs.writeFileSync(
					path.join(dir, '.swarm', 'turbo-state.json'),
					JSON.stringify(turboState),
				);

				const result = phaseReadyInternals.verifyLeanTurboPhaseReady(
					dir,
					Infinity,
					SESSION_ID,
				);
				// No session has phase: Infinity, so no match
				expect(result.ok).toBe(false);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});

		test('negative phase number is handled', () => {
			const dir = mkdtemp();
			try {
				startAgentSession(SESSION_ID, 'architect');
				const session = swarmState.agentSessions.get(SESSION_ID);
				session!.turboMode = false;
				session!.turboStrategy = 'lean';
				session!.leanTurboActive = true;

				const turboState = {
					version: 1,
					updatedAt: new Date().toISOString(),
					sessions: {
						[SESSION_ID]: {
							status: 'running',
							sessionID: SESSION_ID,
							strategy: 'lean',
							phase: 1,
							maxParallelCoders: 2,
							lanes: [],
							degradedTasks: [],
							counters: {
								lanesPlanned: 0,
								lanesStarted: 0,
								lanesCompleted: 0,
								lanesFailed: 0,
								tasksSerialized: 0,
								tasksDegraded: 0,
							},
						},
					},
				};
				fs.writeFileSync(
					path.join(dir, '.swarm', 'turbo-state.json'),
					JSON.stringify(turboState),
				);

				const result = phaseReadyInternals.verifyLeanTurboPhaseReady(
					dir,
					-1,
					SESSION_ID,
				);
				expect(result.ok).toBe(false);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});

		test('zero phase number is handled', () => {
			const dir = mkdtemp();
			try {
				startAgentSession(SESSION_ID, 'architect');
				const session = swarmState.agentSessions.get(SESSION_ID);
				session!.turboMode = false;
				session!.turboStrategy = 'lean';
				session!.leanTurboActive = true;

				const turboState = {
					version: 1,
					updatedAt: new Date().toISOString(),
					sessions: {
						[SESSION_ID]: {
							status: 'running',
							sessionID: SESSION_ID,
							strategy: 'lean',
							phase: 1,
							maxParallelCoders: 2,
							lanes: [],
							degradedTasks: [],
							counters: {
								lanesPlanned: 0,
								lanesStarted: 0,
								lanesCompleted: 0,
								lanesFailed: 0,
								tasksSerialized: 0,
								tasksDegraded: 0,
							},
						},
					},
				};
				fs.writeFileSync(
					path.join(dir, '.swarm', 'turbo-state.json'),
					JSON.stringify(turboState),
				);

				const result = phaseReadyInternals.verifyLeanTurboPhaseReady(
					dir,
					0,
					SESSION_ID,
				);
				expect(result.ok).toBe(false);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});

		test('Number.MAX_SAFE_INTEGER phase number is handled', () => {
			const dir = mkdtemp();
			try {
				startAgentSession(SESSION_ID, 'architect');
				const session = swarmState.agentSessions.get(SESSION_ID);
				session!.turboMode = false;
				session!.turboStrategy = 'lean';
				session!.leanTurboActive = true;

				const turboState = {
					version: 1,
					updatedAt: new Date().toISOString(),
					sessions: {
						[SESSION_ID]: {
							status: 'running',
							sessionID: SESSION_ID,
							strategy: 'lean',
							phase: 1,
							maxParallelCoders: 2,
							lanes: [],
							degradedTasks: [],
							counters: {
								lanesPlanned: 0,
								lanesStarted: 0,
								lanesCompleted: 0,
								lanesFailed: 0,
								tasksSerialized: 0,
								tasksDegraded: 0,
							},
						},
					},
				};
				fs.writeFileSync(
					path.join(dir, '.swarm', 'turbo-state.json'),
					JSON.stringify(turboState),
				);

				const result = phaseReadyInternals.verifyLeanTurboPhaseReady(
					dir,
					Number.MAX_SAFE_INTEGER,
					SESSION_ID,
				);
				// No session will match this phase
				expect(result.ok).toBe(false);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});
	});

	// -------------------------------------------------------------------------
	// Attack 2: Session ID injection in handleTurboCommand
	// -------------------------------------------------------------------------

	describe('session ID injection — handleTurboCommand', () => {
		test('empty session ID returns error message', async () => {
			const dir = mkdtemp();
			try {
				const result = await handleTurboCommand(dir, ['lean', 'on'], '');
				expect(result).toContain('Error');
				expect(result).toContain('session');
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});

		test('whitespace-only session ID returns error message', async () => {
			const dir = mkdtemp();
			try {
				const result = await handleTurboCommand(dir, ['lean', 'on'], '   ');
				expect(result).toContain('Error');
				expect(result).toContain('session');
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});

		test('template literal in session ID is handled safely', async () => {
			const dir = mkdtemp();
			try {
				// Session ID with template literal chars — should not execute any code
				const result = await handleTurboCommand(
					dir,
					['lean', 'on'],
					'${process.env.SECRET}',
				);
				// Should return error (session not found) not execute the template
				expect(result).toContain('Error');
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});

		test('session ID with newline is handled safely', async () => {
			const dir = mkdtemp();
			try {
				const result = await handleTurboCommand(
					dir,
					['lean', 'on'],
					'session\n<script>alert(1)</script>',
				);
				// Should return error, not reflect the injected content
				expect(result).toContain('Error');
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});
	});

	// -------------------------------------------------------------------------
	// Attack 3: Corrupt/missing plan.json for verifyLeanTurboPhaseReady
	// -------------------------------------------------------------------------

	describe('corrupt plan.json — verifyLeanTurboPhaseReady', () => {
		test('missing plan.json with degraded tasks causes fail-closed', () => {
			const dir = mkdtemp();
			try {
				startAgentSession(SESSION_ID, 'architect');
				const session = swarmState.agentSessions.get(SESSION_ID);
				session!.turboMode = false;
				session!.turboStrategy = 'lean';
				session!.leanTurboActive = true;

				// turbo-state with degraded task not in any lane
				const turboState = {
					version: 1,
					updatedAt: new Date().toISOString(),
					sessions: {
						[SESSION_ID]: {
							status: 'running',
							sessionID: SESSION_ID,
							strategy: 'lean',
							phase: 1,
							maxParallelCoders: 2,
							lanes: [
								{
									laneId: 'lane-1',
									taskIds: ['1.1'], // only 1.1 in lane
									files: [],
									status: 'completed',
									startedAt: new Date().toISOString(),
									completedAt: new Date().toISOString(),
								},
							],
							degradedTasks: [
								{ taskId: '1.2', reason: 'conflict resolved' }, // NOT in lane
							],
							counters: {
								lanesPlanned: 1,
								lanesStarted: 1,
								lanesCompleted: 1,
								lanesFailed: 0,
								tasksSerialized: 0,
								tasksDegraded: 1,
							},
						},
					},
				};
				fs.writeFileSync(
					path.join(dir, '.swarm', 'turbo-state.json'),
					JSON.stringify(turboState),
				);

				// Mock lane evidence so test reaches plan.json check
				const originalListLaneEvidence =
					phaseReadyInternals.listLaneEvidenceSync;
				phaseReadyInternals.listLaneEvidenceSync = mock(() => {
					return ['lane-1'];
				});

				// NO plan.json — degraded task verification should fail closed
				const result = phaseReadyInternals.verifyLeanTurboPhaseReady(
					dir,
					1,
					SESSION_ID,
				);

				phaseReadyInternals.listLaneEvidenceSync = originalListLaneEvidence;
				expect(result.ok).toBe(false);
				expect(result.reason).toMatch(/plan\.json|unreadable/i);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});

		test('malformed plan.json (invalid JSON) causes fail-closed', () => {
			const dir = mkdtemp();
			try {
				startAgentSession(SESSION_ID, 'architect');
				const session = swarmState.agentSessions.get(SESSION_ID);
				session!.turboMode = false;
				session!.turboStrategy = 'lean';
				session!.leanTurboActive = true;

				const turboState = {
					version: 1,
					updatedAt: new Date().toISOString(),
					sessions: {
						[SESSION_ID]: {
							status: 'running',
							sessionID: SESSION_ID,
							strategy: 'lean',
							phase: 1,
							maxParallelCoders: 2,
							lanes: [
								{
									laneId: 'lane-1',
									taskIds: ['1.1'],
									files: [],
									status: 'completed',
									startedAt: new Date().toISOString(),
									completedAt: new Date().toISOString(),
								},
							],
							degradedTasks: [{ taskId: '1.2', reason: 'conflict' }],
							counters: {
								lanesPlanned: 1,
								lanesStarted: 1,
								lanesCompleted: 1,
								lanesFailed: 0,
								tasksSerialized: 0,
								tasksDegraded: 1,
							},
						},
					},
				};
				fs.writeFileSync(
					path.join(dir, '.swarm', 'turbo-state.json'),
					JSON.stringify(turboState),
				);

				// Invalid JSON
				fs.writeFileSync(
					path.join(dir, '.swarm', 'plan.json'),
					'not valid json {',
				);

				const result = phaseReadyInternals.verifyLeanTurboPhaseReady(
					dir,
					1,
					SESSION_ID,
				);
				expect(result.ok).toBe(false);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});

		test('plan.json with wrong phases type causes fail-closed', () => {
			const dir = mkdtemp();
			try {
				startAgentSession(SESSION_ID, 'architect');
				const session = swarmState.agentSessions.get(SESSION_ID);
				session!.turboMode = false;
				session!.turboStrategy = 'lean';
				session!.leanTurboActive = true;

				const turboState = {
					version: 1,
					updatedAt: new Date().toISOString(),
					sessions: {
						[SESSION_ID]: {
							status: 'running',
							sessionID: SESSION_ID,
							strategy: 'lean',
							phase: 1,
							maxParallelCoders: 2,
							lanes: [
								{
									laneId: 'lane-1',
									taskIds: ['1.1'],
									files: [],
									status: 'completed',
									startedAt: new Date().toISOString(),
									completedAt: new Date().toISOString(),
								},
							],
							degradedTasks: [{ taskId: '1.2', reason: 'conflict' }],
							counters: {
								lanesPlanned: 1,
								lanesStarted: 1,
								lanesCompleted: 1,
								lanesFailed: 0,
								tasksSerialized: 0,
								tasksDegraded: 1,
							},
						},
					},
				};
				fs.writeFileSync(
					path.join(dir, '.swarm', 'turbo-state.json'),
					JSON.stringify(turboState),
				);

				// phases is a string, not an array
				fs.writeFileSync(
					path.join(dir, '.swarm', 'plan.json'),
					JSON.stringify({ phases: 'not an array' }),
				);

				const result = phaseReadyInternals.verifyLeanTurboPhaseReady(
					dir,
					1,
					SESSION_ID,
				);
				expect(result.ok).toBe(false);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});
	});

	// -------------------------------------------------------------------------
	// Attack 4: executePhaseComplete with invalid phase
	// -------------------------------------------------------------------------

	describe('executePhaseComplete — invalid phase inputs', () => {
		test('phase as NaN returns blocked with Invalid phase number', async () => {
			const dir = mkdtemp();
			try {
				startAgentSession(SESSION_ID, 'architect');
				const session = swarmState.agentSessions.get(SESSION_ID);
				session!.turboMode = false;
				session!.turboStrategy = 'lean';
				session!.leanTurboActive = true;

				// Create required retro evidence
				const retroDir = path.join(dir, '.swarm', 'evidence', 'retro-NaN');
				fs.mkdirSync(retroDir, { recursive: true });
				fs.writeFileSync(
					path.join(retroDir, 'evidence.json'),
					JSON.stringify({
						schema_version: '1.0.0',
						task_id: 'retro-NaN',
						created_at: new Date().toISOString(),
						updated_at: new Date().toISOString(),
						entries: [
							{
								task_id: 'retro-NaN',
								type: 'retrospective',
								timestamp: new Date().toISOString(),
								agent: 'architect',
								verdict: 'pass',
								summary: 'NaN phase retro.',
								phase_number: NaN,
								total_tool_calls: 0,
								coder_revisions: 0,
								reviewer_rejections: 0,
								test_failures: 0,
								security_findings: 0,
								integration_issues: 0,
								task_count: 1,
								task_complexity: 'simple',
								top_rejection_reasons: [],
								lessons_learned: [],
							},
						],
					}),
				);

				// This tests the phase validation in executePhaseComplete
				// Number(NaN) is NaN, which fails phase < 1 check
				const result = await executePhaseComplete(
					{ phase: NaN, sessionID: SESSION_ID },
					dir,
					dir,
				);
				const parsed = JSON.parse(result);
				expect(parsed.status).toBe('blocked');
				expect(parsed.message).toContain('Invalid phase number');
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});

		test('negative phase returns blocked with Invalid phase number', async () => {
			const dir = mkdtemp();
			try {
				startAgentSession(SESSION_ID, 'architect');
				const session = swarmState.agentSessions.get(SESSION_ID);
				session!.turboMode = false;
				session!.turboStrategy = 'lean';
				session!.leanTurboActive = true;

				const result = await executePhaseComplete(
					{ phase: -5, sessionID: SESSION_ID },
					dir,
					dir,
				);
				const parsed = JSON.parse(result);
				expect(parsed.status).toBe('blocked');
				expect(parsed.message).toContain('Invalid phase number');
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});

		test('phase 0 returns blocked with Invalid phase number', async () => {
			const dir = mkdtemp();
			try {
				startAgentSession(SESSION_ID, 'architect');
				const session = swarmState.agentSessions.get(SESSION_ID);
				session!.turboMode = false;
				session!.turboStrategy = 'lean';
				session!.leanTurboActive = true;

				const result = await executePhaseComplete(
					{ phase: 0, sessionID: SESSION_ID },
					dir,
					dir,
				);
				const parsed = JSON.parse(result);
				expect(parsed.status).toBe('blocked');
				expect(parsed.message).toContain('Invalid phase number');
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});

		test('fractional phase (1.5) returns blocked with Invalid phase number', async () => {
			const dir = mkdtemp();
			try {
				startAgentSession(SESSION_ID, 'architect');
				const session = swarmState.agentSessions.get(SESSION_ID);
				session!.turboMode = false;
				session!.turboStrategy = 'lean';
				session!.leanTurboActive = true;

				const result = await executePhaseComplete(
					{ phase: 1.5, sessionID: SESSION_ID },
					dir,
					dir,
				);
				const parsed = JSON.parse(result);
				expect(parsed.status).toBe('blocked');
				expect(parsed.message).toContain('Invalid phase number');
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});

		test('missing sessionID returns error', async () => {
			const dir = mkdtemp();
			try {
				const result = await executePhaseComplete({ phase: 1 }, dir, dir);
				const parsed = JSON.parse(result);
				expect(parsed.success).toBe(false);
				expect(parsed.message).toContain('Session ID');
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});
	});

	// -------------------------------------------------------------------------
	// Attack 5: checkReviewerGate with adversarial taskId
	// -------------------------------------------------------------------------

	describe('checkReviewerGate — adversarial task IDs', () => {
		test('task ID with path traversal chars is blocked', () => {
			const dir = mkdtemp();
			try {
				startAgentSession(SESSION_ID, 'architect');
				const session = swarmState.agentSessions.get(SESSION_ID);
				session!.turboMode = false;
				session!.turboStrategy = 'lean';
				session!.leanTurboActive = true;

				const turboState = {
					version: 1,
					updatedAt: new Date().toISOString(),
					sessions: {
						[SESSION_ID]: {
							status: 'running',
							sessionID: SESSION_ID,
							strategy: 'lean',
							phase: 1,
							maxParallelCoders: 2,
							lanes: [
								{
									laneId: 'lane-1',
									taskIds: ['1.1'],
									files: [],
									status: 'completed',
									startedAt: new Date().toISOString(),
									completedAt: new Date().toISOString(),
								},
							],
							degradedTasks: [],
							counters: {
								lanesPlanned: 1,
								lanesStarted: 1,
								lanesCompleted: 1,
								lanesFailed: 0,
								tasksSerialized: 0,
								tasksDegraded: 0,
							},
						},
					},
				};
				fs.writeFileSync(
					path.join(dir, '.swarm', 'turbo-state.json'),
					JSON.stringify(turboState),
				);

				const planJson = {
					schema_version: '1.0.0',
					title: 'Adv Test',
					swarm: 'test',
					current_phase: 1,
					phases: [
						{
							id: 1,
							name: 'Phase 1',
							status: 'in_progress',
							tasks: [
								{
									id: '1.1',
									phase: 1,
									status: 'pending',
									size: 'small',
									description: 'test task',
									depends: [],
									files_touched: [],
								},
							],
						},
					],
				};
				fs.writeFileSync(
					path.join(dir, '.swarm', 'plan.json'),
					JSON.stringify(planJson),
				);

				// The task ID validation in checkReviewerGate uses validateTaskId
				// which calls _validateTaskIdFormat
				const result = checkReviewerGate('1/../1.1', dir);
				// Task ID format is invalid — should be blocked by format validation
				// OR, if it somehow passes format, by the Stage B gate
				expect(result.blocked).toBe(true);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});

		test('task ID with null byte is handled safely', () => {
			const dir = mkdtemp();
			try {
				startAgentSession(SESSION_ID, 'architect');
				const session = swarmState.agentSessions.get(SESSION_ID);
				session!.turboMode = false;
				session!.turboStrategy = 'lean';
				session!.leanTurboActive = true;

				// Attempt with taskId containing null byte
				const badTaskId = '1.1\x00';
				// The JSON serialization will strip the null byte, producing "1.1"
				// which may or may not match plan.json
				// Either way, checkReviewerGate should not throw
				const turboState = {
					version: 1,
					updatedAt: new Date().toISOString(),
					sessions: {
						[SESSION_ID]: {
							status: 'running',
							sessionID: SESSION_ID,
							strategy: 'lean',
							phase: 1,
							maxParallelCoders: 2,
							lanes: [
								{
									laneId: 'lane-1',
									taskIds: ['1.1'],
									files: [],
									status: 'completed',
									startedAt: new Date().toISOString(),
									completedAt: new Date().toISOString(),
								},
							],
							degradedTasks: [],
							counters: {
								lanesPlanned: 1,
								lanesStarted: 1,
								lanesCompleted: 1,
								lanesFailed: 0,
								tasksSerialized: 0,
								tasksDegraded: 0,
							},
						},
					},
				};
				fs.writeFileSync(
					path.join(dir, '.swarm', 'turbo-state.json'),
					JSON.stringify(turboState),
				);

				const planJson = {
					schema_version: '1.0.0',
					title: 'Adv Test',
					swarm: 'test',
					current_phase: 1,
					phases: [
						{
							id: 1,
							name: 'Phase 1',
							status: 'in_progress',
							tasks: [
								{
									id: '1.1',
									phase: 1,
									status: 'pending',
									size: 'small',
									description: 'test task',
									depends: [],
									files_touched: [],
								},
							],
						},
					],
				};
				fs.writeFileSync(
					path.join(dir, '.swarm', 'plan.json'),
					JSON.stringify(planJson),
				);

				// Should not throw — blocked by format validation or the Stage B gate
				expect(() => checkReviewerGate(badTaskId, dir)).not.toThrow();
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});
	});

	// -------------------------------------------------------------------------
	// Attack 6: verifyLeanTurboPhaseReady with corrupted persisted state
	// -------------------------------------------------------------------------

	describe('verifyLeanTurboPhaseReady — corrupted persisted state', () => {
		test('persisted state with null sessions fails closed', () => {
			const dir = mkdtemp();
			try {
				startAgentSession(SESSION_ID, 'architect');
				const session = swarmState.agentSessions.get(SESSION_ID);
				session!.turboMode = false;
				session!.turboStrategy = 'lean';
				session!.leanTurboActive = true;

				fs.writeFileSync(
					path.join(dir, '.swarm', 'turbo-state.json'),
					JSON.stringify({ version: 1, sessions: null }),
				);

				const result = phaseReadyInternals.verifyLeanTurboPhaseReady(
					dir,
					1,
					SESSION_ID,
				);
				expect(result.ok).toBe(false);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});

		test('persisted state with array sessions fails closed', () => {
			const dir = mkdtemp();
			try {
				startAgentSession(SESSION_ID, 'architect');
				const session = swarmState.agentSessions.get(SESSION_ID);
				session!.turboMode = false;
				session!.turboStrategy = 'lean';
				session!.leanTurboActive = true;

				fs.writeFileSync(
					path.join(dir, '.swarm', 'turbo-state.json'),
					JSON.stringify({ version: 1, sessions: [] }),
				);

				const result = phaseReadyInternals.verifyLeanTurboPhaseReady(
					dir,
					1,
					SESSION_ID,
				);
				expect(result.ok).toBe(false);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});

		test('phase with non-matching session strategy fails closed', () => {
			const dir = mkdtemp();
			try {
				startAgentSession(SESSION_ID, 'architect');
				const session = swarmState.agentSessions.get(SESSION_ID);
				session!.turboMode = false;
				session!.turboStrategy = 'lean';
				session!.leanTurboActive = true;

				// Session is standard, not lean
				const turboState = {
					version: 1,
					updatedAt: new Date().toISOString(),
					sessions: {
						[SESSION_ID]: {
							status: 'running',
							sessionID: SESSION_ID,
							strategy: 'standard', // NOT lean
							phase: 1,
							maxParallelCoders: 2,
							lanes: [],
							degradedTasks: [],
							counters: {
								lanesPlanned: 0,
								lanesStarted: 0,
								lanesCompleted: 0,
								lanesFailed: 0,
								tasksSerialized: 0,
								tasksDegraded: 0,
							},
						},
					},
				};
				fs.writeFileSync(
					path.join(dir, '.swarm', 'turbo-state.json'),
					JSON.stringify(turboState),
				);

				const result = phaseReadyInternals.verifyLeanTurboPhaseReady(
					dir,
					1,
					SESSION_ID,
				);
				expect(result.ok).toBe(false);
				expect(result.reason).toContain('No active Lean Turbo');
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});

		test('phase with non-running session status fails closed', () => {
			const dir = mkdtemp();
			try {
				startAgentSession(SESSION_ID, 'architect');
				const session = swarmState.agentSessions.get(SESSION_ID);
				session!.turboMode = false;
				session!.turboStrategy = 'lean';
				session!.leanTurboActive = true;

				const turboState = {
					version: 1,
					updatedAt: new Date().toISOString(),
					sessions: {
						[SESSION_ID]: {
							status: 'paused', // NOT running
							sessionID: SESSION_ID,
							strategy: 'lean',
							phase: 1,
							maxParallelCoders: 2,
							lanes: [],
							degradedTasks: [],
							counters: {
								lanesPlanned: 0,
								lanesStarted: 0,
								lanesCompleted: 0,
								lanesFailed: 0,
								tasksSerialized: 0,
								tasksDegraded: 0,
							},
						},
					},
				};
				fs.writeFileSync(
					path.join(dir, '.swarm', 'turbo-state.json'),
					JSON.stringify(turboState),
				);

				const result = phaseReadyInternals.verifyLeanTurboPhaseReady(
					dir,
					1,
					SESSION_ID,
				);
				expect(result.ok).toBe(false);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});

		test('phase mismatch (session phase != requested phase) fails closed', () => {
			const dir = mkdtemp();
			try {
				startAgentSession(SESSION_ID, 'architect');
				const session = swarmState.agentSessions.get(SESSION_ID);
				session!.turboMode = false;
				session!.turboStrategy = 'lean';
				session!.leanTurboActive = true;

				const turboState = {
					version: 1,
					updatedAt: new Date().toISOString(),
					sessions: {
						[SESSION_ID]: {
							status: 'running',
							sessionID: SESSION_ID,
							strategy: 'lean',
							phase: 2, // Session is in phase 2
							maxParallelCoders: 2,
							lanes: [],
							degradedTasks: [],
							counters: {
								lanesPlanned: 0,
								lanesStarted: 0,
								lanesCompleted: 0,
								lanesFailed: 0,
								tasksSerialized: 0,
								tasksDegraded: 0,
							},
						},
					},
				};
				fs.writeFileSync(
					path.join(dir, '.swarm', 'turbo-state.json'),
					JSON.stringify(turboState),
				);

				// Request phase 1 readiness, but session is in phase 2
				const result = phaseReadyInternals.verifyLeanTurboPhaseReady(
					dir,
					1,
					SESSION_ID,
				);
				expect(result.ok).toBe(false);
				expect(result.reason).toMatch(/phase 1/);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});
	});
});
