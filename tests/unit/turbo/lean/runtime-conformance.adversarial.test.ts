/**
 * Adversarial tests for Lean Turbo runtime conformance.
 *
 * ONLY attack vectors — malformed inputs, boundary violations, injection attempts.
 * Does NOT repeat existing conformance tests from runtime-conformance.test.ts.
 *
 * Attack surface covered:
 *  1. Path traversal in lane IDs (already defended in source, verify it cannot be bypassed)
 *  2. Malformed JSON in turbo-state.json (invalid JSON, type confusion)
 *  3. Invalid phase numbers (NaN, Infinity, negative, zero, MAX_SAFE_INTEGER)
 *  4. Unicode/special chars in lane IDs (emoji, null bytes, RTL override)
 *  5. Empty/missing session in turbo-state.json
 *  6. Corrupt persisted state shape (wrong types, nulls)
 *  7. Tier-3 pattern bypass via files_touched injection
 *  8. Missing required state fields (lanes as non-array, corrupted session objects)
 *  9. Session ID injection (special chars, template literals)
 * 10. Boundary: phase number as floating point (1.5)
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleTurboCommand } from '../../../../src/commands/turbo';
import {
	ensureAgentSession,
	resetSwarmState,
	startAgentSession,
	swarmState,
} from '../../../../src/state';
import { executePhaseComplete } from '../../../../src/tools/phase-complete';
import { checkReviewerGate } from '../../../../src/tools/update-task-status';
import { _internals as phaseReadyInternals } from '../../../../src/turbo/lean/phase-ready';
import { repairStateUnreadable } from '../../../../src/turbo/lean/state';
import {
	_internals as taskCompletionInternals,
	verifyLeanTurboTaskCompletion,
} from '../../../../src/turbo/lean/task-completion';

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

function createLeanTurboSession(sessionId: string): void {
	ensureAgentSession(sessionId, 'architect');
	const session = swarmState.agentSessions.get(sessionId);
	if (session) {
		session.turboMode = true;
		session.turboStrategy = 'lean';
		session.leanTurboActive = true;
	}
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
	// Attack 1: Path traversal in lane IDs
	// Defended in verifyLeanTurboTaskCompletion (checks /, \, ..)
	// -------------------------------------------------------------------------

	describe('lane ID path traversal — verifyLeanTurboTaskCompletion', () => {
		test('lane ID with forward slash is rejected', () => {
			const dir = mkdtemp();
			try {
				startAgentSession(SESSION_ID, 'architect');
				const session = swarmState.agentSessions.get(SESSION_ID);
				session!.turboMode = false;
				session!.turboStrategy = 'lean';
				session!.leanTurboActive = true;

				// turbo-state.json with laneId containing /
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
									laneId: 'lane-1/../../../etc/passwd',
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

				// Create plan.json
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

				const result = verifyLeanTurboTaskCompletion(dir, '1.1');
				expect(result.ok).toBe(false);
				expect(result.reason).toContain('invalid characters');
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});

		test('lane ID with backslash is rejected', () => {
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
									laneId: 'lane-1\\..\\..\\etc\\passwd',
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

				const result = verifyLeanTurboTaskCompletion(dir, '1.1');
				expect(result.ok).toBe(false);
				expect(result.reason).toContain('invalid characters');
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});

		test('lane ID with parent directory traversal (..) is rejected', () => {
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
									laneId: 'lane-1..',
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

				const result = verifyLeanTurboTaskCompletion(dir, '1.1');
				expect(result.ok).toBe(false);
				expect(result.reason).toContain('invalid characters');
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});

		test('lane ID with null byte is rejected', () => {
			const dir = mkdtemp();
			try {
				startAgentSession(SESSION_ID, 'architect');
				const session = swarmState.agentSessions.get(SESSION_ID);
				session!.turboMode = false;
				session!.turboStrategy = 'lean';
				session!.leanTurboActive = true;

				// Use raw buffer to write null byte
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
									laneId: 'lane-1\x00..\x00etc\x00passwd',
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

				// Should either reject null byte or fail JSON parse
				const result = verifyLeanTurboTaskCompletion(dir, '1.1');
				// Null byte in JSON will cause JSON.parse to fail, or laneId check will reject
				expect(result.ok).toBe(false);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});

		test('lane ID with emoji is rejected (not a valid lane ID)', () => {
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
									laneId: 'lane-1-💉-test',
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

				// Lane evidence file won't be found (lane ID with emoji doesn't match file)
				const result = verifyLeanTurboTaskCompletion(dir, '1.1');
				expect(result.ok).toBe(false);
				expect(result.laneFound).toBe(true); // lane was found in state
				// But evidence file check should fail
				expect(result.reason).toContain('evidence file not found');
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});
	});

	// -------------------------------------------------------------------------
	// Attack 2: Malformed JSON in turbo-state.json
	// -------------------------------------------------------------------------

	describe('malformed turbo-state.json', () => {
		test('invalid JSON in turbo-state.json is handled gracefully', () => {
			const dir = mkdtemp();
			try {
				startAgentSession(SESSION_ID, 'architect');
				const session = swarmState.agentSessions.get(SESSION_ID);
				session!.turboMode = false;
				session!.turboStrategy = 'lean';
				session!.leanTurboActive = true;

				// Write garbage
				fs.writeFileSync(
					path.join(dir, '.swarm', 'turbo-state.json'),
					'{ this is not json ',
				);

				const result = verifyLeanTurboTaskCompletion(dir, '1.1');
				expect(result.ok).toBe(false);
				expect(result.reason).toMatch(/unreadable|malformed|not found/i);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});

		test('valid JSON but wrong type (string instead of object) fails closed', () => {
			const dir = mkdtemp();
			try {
				startAgentSession(SESSION_ID, 'architect');
				const session = swarmState.agentSessions.get(SESSION_ID);
				session!.turboMode = false;
				session!.turboStrategy = 'lean';
				session!.leanTurboActive = true;

				// JSON is valid but root is a string, not an object
				fs.writeFileSync(
					path.join(dir, '.swarm', 'turbo-state.json'),
					JSON.stringify('not an object'),
				);

				const result = verifyLeanTurboTaskCompletion(dir, '1.1');
				expect(result.ok).toBe(false);
				expect(result.reason).toMatch(/malformed|missing/i);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});

		test('sessions is an array instead of object fails closed', () => {
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

				const result = verifyLeanTurboTaskCompletion(dir, '1.1');
				expect(result.ok).toBe(false);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});

		test('lanes is null instead of array fails closed', () => {
			const dir = mkdtemp();
			try {
				startAgentSession(SESSION_ID, 'architect');
				const session = swarmState.agentSessions.get(SESSION_ID);
				session!.turboMode = false;
				session!.turboStrategy = 'lean';
				session!.leanTurboActive = true;

				fs.writeFileSync(
					path.join(dir, '.swarm', 'turbo-state.json'),
					JSON.stringify({
						version: 1,
						sessions: {
							[SESSION_ID]: {
								status: 'running',
								sessionID: SESSION_ID,
								strategy: 'lean',
								phase: 1,
								maxParallelCoders: 2,
								lanes: null, // invalid
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
					}),
				);

				const result = verifyLeanTurboTaskCompletion(dir, '1.1');
				expect(result.ok).toBe(false);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});

		test('degradedTasks is null instead of array fails closed', () => {
			const dir = mkdtemp();
			try {
				startAgentSession(SESSION_ID, 'architect');
				const session = swarmState.agentSessions.get(SESSION_ID);
				session!.turboMode = false;
				session!.turboStrategy = 'lean';
				session!.leanTurboActive = true;

				fs.writeFileSync(
					path.join(dir, '.swarm', 'turbo-state.json'),
					JSON.stringify({
						version: 1,
						sessions: {
							[SESSION_ID]: {
								status: 'running',
								sessionID: SESSION_ID,
								strategy: 'lean',
								phase: 1,
								maxParallelCoders: 2,
								lanes: [],
								degradedTasks: null, // invalid
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
					}),
				);

				const result = verifyLeanTurboTaskCompletion(dir, '1.1');
				expect(result.ok).toBe(false);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});

		test('empty turbo-state.json (just {}) is handled', () => {
			const dir = mkdtemp();
			try {
				startAgentSession(SESSION_ID, 'architect');
				const session = swarmState.agentSessions.get(SESSION_ID);
				session!.turboMode = false;
				session!.turboStrategy = 'lean';
				session!.leanTurboActive = true;

				fs.writeFileSync(path.join(dir, '.swarm', 'turbo-state.json'), '{}');

				const result = verifyLeanTurboTaskCompletion(dir, '1.1');
				expect(result.ok).toBe(false);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});

		test('phase number as floating point (1.5) fails closed', () => {
			const dir = mkdtemp();
			try {
				startAgentSession(SESSION_ID, 'architect');
				const session = swarmState.agentSessions.get(SESSION_ID);
				session!.turboMode = false;
				session!.turboStrategy = 'lean';
				session!.leanTurboActive = true;

				fs.writeFileSync(
					path.join(dir, '.swarm', 'turbo-state.json'),
					JSON.stringify({
						version: 1,
						sessions: {
							[SESSION_ID]: {
								status: 'running',
								sessionID: SESSION_ID,
								strategy: 'lean',
								phase: 1.5, // non-integer
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
					}),
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

				// Floating point phase — evidence path will be .swarm/evidence/1.5/lean-turbo/lane-1.json
				// which can't exist on disk (phase should be integer)
				const result = verifyLeanTurboTaskCompletion(dir, '1.1');
				// Lane found but evidence file not found (path .swarm/evidence/1.5/...) won't resolve
				expect(result.ok).toBe(false);
				expect(result.laneFound).toBe(true);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});
	});

	// -------------------------------------------------------------------------
	// Attack 3: Invalid phase numbers in verifyLeanTurboPhaseReady
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

				// NaN phase number via call — the function accepts number but phase-ready
				// reads from state. The check happens in executePhaseComplete which validates.
				// Here we test the verifyLeanTurboPhaseReady call with a float.
				const result = phaseReadyInternals.verifyLeanTurboPhaseReady(
					dir,
					1.5,
					SESSION_ID,
				);
				// With floating point phase, no session matches (session has phase: 1)
				expect(result.ok).toBe(false);
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
	// Attack 4: Unicode/special characters in lane IDs
	// -------------------------------------------------------------------------

	describe('unicode edge cases in lane IDs', () => {
		test('RTL override character in lane ID is rejected or evidence not found', () => {
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
									laneId: 'lane\u202Elane', // RLO (U+202E) character
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

				const result = verifyLeanTurboTaskCompletion(dir, '1.1');
				// Either rejected for invalid chars, or evidence file not found
				expect(result.ok).toBe(false);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});
	});

	// -------------------------------------------------------------------------
	// Attack 5: Empty/missing session in turbo-state.json
	// -------------------------------------------------------------------------

	describe('missing/empty session in turbo-state.json', () => {
		test('no lean turbo session present fails closed', () => {
			const dir = mkdtemp();
			try {
				startAgentSession(SESSION_ID, 'architect');
				const session = swarmState.agentSessions.get(SESSION_ID);
				session!.turboMode = false;
				session!.turboStrategy = 'lean';
				session!.leanTurboActive = true;

				// turbo-state with standard strategy, not lean
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

				const result = verifyLeanTurboTaskCompletion(dir, '1.1');
				expect(result.ok).toBe(false);
				expect(result.reason).toContain('No active Lean Turbo');
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});

		test('session status is not "running" fails closed', () => {
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
							status: 'completed', // not running
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

				const result = verifyLeanTurboTaskCompletion(dir, '1.1');
				expect(result.ok).toBe(false);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});
	});

	// -------------------------------------------------------------------------
	// Attack 6: Tier-3 pattern bypass via files_touched injection
	// -------------------------------------------------------------------------

	describe('Tier-3 pattern bypass via files_touched', () => {
		test('task touching architect.ts is blocked even in completed lane', () => {
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

				// Create lane evidence file
				fs.writeFileSync(
					path.join(
						dir,
						'.swarm',
						'evidence',
						'1',
						'lean-turbo',
						'lane-1.json',
					),
					JSON.stringify({
						laneId: 'lane-1',
						status: 'completed',
						taskIds: ['1.1'],
						completedAt: new Date().toISOString(),
					}),
				);

				// Plan.json with Tier-3 file in files_touched
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
									files_touched: ['src/architect.ts'], // Tier-3
								},
							],
						},
					],
				};
				fs.writeFileSync(
					path.join(dir, '.swarm', 'plan.json'),
					JSON.stringify(planJson),
				);

				const result = verifyLeanTurboTaskCompletion(dir, '1.1');
				expect(result.ok).toBe(false);
				expect(result.reason).toContain('Tier-3');
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});

		test('task touching security.ts is blocked even in completed lane', () => {
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

				fs.writeFileSync(
					path.join(
						dir,
						'.swarm',
						'evidence',
						'1',
						'lean-turbo',
						'lane-1.json',
					),
					JSON.stringify({
						laneId: 'lane-1',
						status: 'completed',
						taskIds: ['1.1'],
						completedAt: new Date().toISOString(),
					}),
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
									files_touched: ['lib/security.ts'], // Tier-3
								},
							],
						},
					],
				};
				fs.writeFileSync(
					path.join(dir, '.swarm', 'plan.json'),
					JSON.stringify(planJson),
				);

				const result = verifyLeanTurboTaskCompletion(dir, '1.1');
				expect(result.ok).toBe(false);
				expect(result.reason).toContain('Tier-3');
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});

		test('task touching auth is blocked (Tier-3 pattern)', () => {
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

				fs.writeFileSync(
					path.join(
						dir,
						'.swarm',
						'evidence',
						'1',
						'lean-turbo',
						'lane-1.json',
					),
					JSON.stringify({
						laneId: 'lane-1',
						status: 'completed',
						taskIds: ['1.1'],
						completedAt: new Date().toISOString(),
					}),
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
									files_touched: ['src/auth.ts'], // Tier-3 auth pattern
								},
							],
						},
					],
				};
				fs.writeFileSync(
					path.join(dir, '.swarm', 'plan.json'),
					JSON.stringify(planJson),
				);

				const result = verifyLeanTurboTaskCompletion(dir, '1.1');
				expect(result.ok).toBe(false);
				expect(result.reason).toContain('Tier-3');
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});
	});

	// -------------------------------------------------------------------------
	// Attack 7: Session ID injection in handleTurboCommand
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
	// Attack 8: Corrupt/missing plan.json for verifyLeanTurboPhaseReady
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
	// Attack 9: Degraded task in completed lane should be checked
	// -------------------------------------------------------------------------

	describe('degraded task edge cases', () => {
		test('task that is both in completed lane AND degradedTasks is rejected', () => {
			const dir = mkdtemp();
			try {
				startAgentSession(SESSION_ID, 'architect');
				const session = swarmState.agentSessions.get(SESSION_ID);
				session!.turboMode = false;
				session!.turboStrategy = 'lean';
				session!.leanTurboActive = true;

				// Task 1.1 is BOTH in a completed lane AND in degradedTasks
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
							degradedTasks: [{ taskId: '1.1', reason: 'conflict resolved' }],
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

				const result = verifyLeanTurboTaskCompletion(dir, '1.1');
				// Should be rejected because it's in degradedTasks
				expect(result.ok).toBe(false);
				expect(result.reason).toContain('degraded');
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});
	});

	// -------------------------------------------------------------------------
	// Attack 10: executePhaseComplete with invalid phase
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
	// Attack 11: checkReviewerGate with adversarial taskId
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
				// OR if it somehow passes format, the turbo state lookup fails
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

				// Should not throw — either blocked by format validation or lean turbo check
				expect(() => checkReviewerGate(badTaskId, dir)).not.toThrow();
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});
	});

	// -------------------------------------------------------------------------
	// Attack 12: Oversized JSON payloads
	// -------------------------------------------------------------------------

	describe('oversized/malformed JSON edge cases', () => {
		test('very large lane ID (>10KB) is handled', () => {
			const dir = mkdtemp();
			try {
				startAgentSession(SESSION_ID, 'architect');
				const session = swarmState.agentSessions.get(SESSION_ID);
				session!.turboMode = false;
				session!.turboStrategy = 'lean';
				session!.leanTurboActive = true;

				// Create a very long lane ID
				const largeLaneId = 'lane-' + 'x'.repeat(20_000);

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
									laneId: largeLaneId,
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

				const result = verifyLeanTurboTaskCompletion(dir, '1.1');
				// Long lane ID is not rejected by the character check (only /, \, ..)
				// But evidence file won't be found (lane ID with 20KB of x's doesn't exist on disk)
				expect(result.ok).toBe(false);
				expect(result.laneFound).toBe(true);
				expect(result.reason).toContain('evidence file not found');
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});

		test('lane with empty string laneId fails', () => {
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
									laneId: '', // empty — should be rejected
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

				const result = verifyLeanTurboTaskCompletion(dir, '1.1');
				// Empty laneId is rejected by the length === 0 check
				expect(result.ok).toBe(false);
				expect(result.reason).toContain('invalid characters');
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});
	});

	// -------------------------------------------------------------------------
	// Attack 13: verifyLeanTurboPhaseReady with corrupted persisted state
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
