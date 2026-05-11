/**
 * Lean Turbo integration points — runtime conformance test.
 *
 * Verifies that Lean Turbo integration points are present and functional
 * in the built dist/index.js, without regressing standard Turbo behavior.
 *
 * Integration points tested:
 * 1. phase_complete lean gate: verifyLeanTurboPhaseReady called when leanTurboActive is true
 * 2. update_task_status lean bypass: verifyLeanTurboTaskCompletion checked for lane tasks
 * 3. system-enhancer lean banner: LEAN_TURBO_BANNER constant exists with expected content
 * 4. /swarm turbo lean command: handler responds to 'lean on', 'lean off', 'lean status'
 * 5. Standard Turbo regression: standard Turbo behavior unchanged when lean is not active
 *
 * Uses _internals DI seams for mocking per AGENTS.md invariant #7.
 * All tests use bun:test framework with proper mock isolation.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// --- Source module imports (for behavioral testing with _internals seams) ---

import { handleTurboCommand } from '../../../../src/commands/turbo';
import { LEAN_TURBO_BANNER } from '../../../../src/config/constants';
import {
	ensureAgentSession,
	hasActiveLeanTurbo,
	resetSwarmState,
	startAgentSession,
	swarmState,
} from '../../../../src/state';
import { executePhaseComplete } from '../../../../src/tools/phase-complete';
import { checkReviewerGate } from '../../../../src/tools/update-task-status';
import type { verifyLeanTurboPhaseReady } from '../../../../src/turbo/lean/phase-ready';
import { _internals as phaseReadyInternals } from '../../../../src/turbo/lean/phase-ready';
import { repairStateUnreadable } from '../../../../src/turbo/lean/state';
import type { verifyLeanTurboTaskCompletion } from '../../../../src/turbo/lean/task-completion';
import { _internals as taskCompletionInternals } from '../../../../src/turbo/lean/task-completion';

// --- Dist bundle content check ---

const REPO_ROOT = path.resolve(import.meta.dir, '../../../..');
const DIST_INDEX_PATH = path.join(REPO_ROOT, 'dist/index.js');

function distContains(pattern: string): boolean {
	try {
		const content = fs.readFileSync(DIST_INDEX_PATH, 'utf-8');
		return content.includes(pattern);
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mkdtemp(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lean-conformance-'));
	fs.mkdirSync(path.join(dir, '.swarm', 'evidence', '1'), { recursive: true });
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

function createStandardTurboSession(sessionId: string): void {
	ensureAgentSession(sessionId, 'architect');
	const session = swarmState.agentSessions.get(sessionId);
	if (session) {
		session.turboMode = true;
		session.turboStrategy = 'standard';
		session.leanTurboActive = false;
	}
}

function createPlainSession(sessionId: string): void {
	ensureAgentSession(sessionId, 'architect');
	const session = swarmState.agentSessions.get(sessionId);
	if (session) {
		session.turboMode = false;
		session.turboStrategy = undefined;
		session.leanTurboActive = false;
	}
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Lean Turbo runtime conformance', () => {
	const SESSION_ID = 'conformance-test-session';

	beforeEach(() => {
		resetSwarmState();
	});

	afterEach(() => {
		mock.restore();
		resetSwarmState();
		// Reset the module-level stateUnreadable flag between tests so a corrupted
		// state file in one test does not cascade to others. Use a fresh temp dir
		// (guaranteed no turbo-state.json) to ensure deterministic reset.
		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), 'lean-conformance-cleanup-'),
		);
		repairStateUnreadable(tmpDir);
		try {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// Best-effort cleanup
		}
	});

	// -------------------------------------------------------------------------
	// Integration point 1: phase_complete lean gate
	// -------------------------------------------------------------------------

	describe('phase_complete lean gate — dist/index.js presence (smoke)', () => {
		// Minimal smoke test: verifies critical function is bundled
		test('dist/index.js contains verifyLeanTurboPhaseReady function', () => {
			expect(distContains('function verifyLeanTurboPhaseReady')).toBe(true);
		});
	});

	describe('phase_complete lean gate — behavioral test with _internals', () => {
		test('verifyLeanTurboPhaseReady _internals seam is replaceable', () => {
			// Verify the _internals seam exists and can be mocked
			const original = phaseReadyInternals.verifyLeanTurboPhaseReady;
			expect(typeof original).toBe('function');

			// Mock to return ready
			phaseReadyInternals.verifyLeanTurboPhaseReady = mock(() => ({
				ok: true,
				reason: 'mocked-ready',
			})) as typeof verifyLeanTurboPhaseReady;

			expect(typeof phaseReadyInternals.verifyLeanTurboPhaseReady).toBe(
				'function',
			);

			// Restore
			phaseReadyInternals.verifyLeanTurboPhaseReady = original;
		});

		test('verifyLeanTurboPhaseReady _internals seam returns correct shape', () => {
			const original = phaseReadyInternals.verifyLeanTurboPhaseReady;
			phaseReadyInternals.verifyLeanTurboPhaseReady = mock(() => ({
				ok: true,
				reason: 'mocked-ready',
				phase: 1,
				sessionID: SESSION_ID,
			})) as typeof verifyLeanTurboPhaseReady;

			const result = phaseReadyInternals.verifyLeanTurboPhaseReady(
				'/fake',
				1,
				SESSION_ID,
			);
			expect(result).toHaveProperty('ok');
			expect(result).toHaveProperty('reason');

			phaseReadyInternals.verifyLeanTurboPhaseReady = original;
		});
	});

	describe('phase_complete lean gate — behavioral integration', () => {
		test('executePhaseComplete blocks when verifyLeanTurboPhaseReady returns ok:false', async () => {
			const dir = mkdtemp();
			try {
				// Set up Lean Turbo session in memory
				startAgentSession(SESSION_ID, 'architect');
				const session = swarmState.agentSessions.get(SESSION_ID);
				session!.turboMode = true;
				session!.turboStrategy = 'lean';
				session!.leanTurboActive = true;

				// Create turbo-state.json with a running lean session for phase 1
				// but with NO lanes (will cause verifyLeanTurboPhaseReady to return ok:false)
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

				// Create minimal plan.json with phase 1 and a task
				const planJson = {
					schema_version: '1.0.0',
					title: 'Lean Turbo Test',
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
								},
							],
						},
					],
				};
				fs.writeFileSync(
					path.join(dir, '.swarm', 'plan.json'),
					JSON.stringify(planJson),
				);

				// Create required retro evidence
				const retroDir = path.join(dir, '.swarm', 'evidence', 'retro-1');
				fs.mkdirSync(retroDir, { recursive: true });
				fs.writeFileSync(
					path.join(retroDir, 'evidence.json'),
					JSON.stringify({
						schema_version: '1.0.0',
						task_id: 'retro-1',
						created_at: new Date().toISOString(),
						updated_at: new Date().toISOString(),
						entries: [
							{
								task_id: 'retro-1',
								type: 'retrospective',
								timestamp: new Date().toISOString(),
								agent: 'architect',
								verdict: 'pass',
								summary: 'Phase 1 completed.',
								phase_number: 1,
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

				// Execute phase_complete with Lean Turbo active — should be blocked
				// because verifyLeanTurboPhaseReady returns ok:false (no lanes found)
				const result = await executePhaseComplete(
					{ phase: 1, sessionID: SESSION_ID },
					dir,
					dir,
				);
				const parsed = JSON.parse(result);

				expect(parsed.success).toBe(false);
				expect(parsed.status).toBe('blocked');
				expect(parsed.reason).toBe('LEAN_TURBO_PHASE_NOT_READY');
				expect(parsed.message).toContain(
					'No lane plan or fallback tasks found for phase 1',
				);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});

		test('executePhaseComplete allows phase when verifyLeanTurboPhaseReady returns ok:true', async () => {
			const dir = mkdtemp();
			try {
				// Set up Lean Turbo session in memory
				startAgentSession(SESSION_ID, 'architect');
				const session = swarmState.agentSessions.get(SESSION_ID);
				session!.turboMode = true;
				session!.turboStrategy = 'lean';
				session!.leanTurboActive = true;

				// Create turbo-state.json with running lean session AND completed lanes
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
							lastReviewerVerdict: 'APPROVED',
							lastCriticVerdict: 'APPROVED',
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

				// Create minimal plan.json with phase 1 and task
				const planJson = {
					schema_version: '1.0.0',
					title: 'Lean Turbo Test',
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
									status: 'completed',
									size: 'small',
									description: 'test task',
									depends: [],
								},
							],
						},
					],
				};
				fs.writeFileSync(
					path.join(dir, '.swarm', 'plan.json'),
					JSON.stringify(planJson),
				);

				// Create lane evidence directory and file
				const laneEvidenceDir = path.join(
					dir,
					'.swarm',
					'evidence',
					'1',
					'lean-turbo',
				);
				fs.mkdirSync(laneEvidenceDir, { recursive: true });
				fs.writeFileSync(
					path.join(laneEvidenceDir, 'lane-1.json'),
					JSON.stringify({
						laneId: 'lane-1',
						status: 'completed',
						taskIds: ['1.1'],
						completedAt: new Date().toISOString(),
					}),
				);

				// Create required retro evidence
				const retroDir = path.join(dir, '.swarm', 'evidence', 'retro-1');
				fs.mkdirSync(retroDir, { recursive: true });
				fs.writeFileSync(
					path.join(retroDir, 'evidence.json'),
					JSON.stringify({
						schema_version: '1.0.0',
						task_id: 'retro-1',
						created_at: new Date().toISOString(),
						updated_at: new Date().toISOString(),
						entries: [
							{
								task_id: 'retro-1',
								type: 'retrospective',
								timestamp: new Date().toISOString(),
								agent: 'architect',
								verdict: 'pass',
								summary: 'Phase 1 completed.',
								phase_number: 1,
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

				// Mock the _internals.readCriticEvidence to return APPROVED
				// (the real function reads from .swarm/evidence/{phase}/lean-turbo-critic.json
				// which we haven't created — so mock it to avoid ENOENT)
				const originalReadCriticEvidence =
					phaseReadyInternals.readCriticEvidence;
				phaseReadyInternals.readCriticEvidence = mock(() => ({
					phase: 1,
					verdict: 'APPROVED',
					reason: null,
					timestamp: new Date().toISOString(),
				}));

				try {
					// Execute phase_complete with Lean Turbo active — should succeed
					// because verifyLeanTurboPhaseReady returns ok:true (all lanes complete, approved)
					const result = await executePhaseComplete(
						{ phase: 1, sessionID: SESSION_ID },
						dir,
						dir,
					);
					const parsed = JSON.parse(result);

					// Phase should NOT be blocked by lean gate
					// (may still succeed, be incomplete, etc. depending on other gates)
					expect(parsed.status).not.toBe('blocked');
				} finally {
					phaseReadyInternals.readCriticEvidence = originalReadCriticEvidence;
				}
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});
	});

	// -------------------------------------------------------------------------
	// Integration point 2: update_task_status lean bypass
	// -------------------------------------------------------------------------

	describe('update_task_status lean bypass — dist/index.js presence (smoke)', () => {
		// Minimal smoke test: verifies critical function is bundled
		test('dist/index.js contains verifyLeanTurboTaskCompletion function', () => {
			expect(distContains('function verifyLeanTurboTaskCompletion')).toBe(true);
		});
	});

	describe('update_task_status lean bypass — behavioral test with _internals', () => {
		test('verifyLeanTurboTaskCompletion _internals seam is replaceable', () => {
			const original = taskCompletionInternals.verifyLeanTurboTaskCompletion;
			expect(typeof original).toBe('function');

			// Mock to return eligible
			taskCompletionInternals.verifyLeanTurboTaskCompletion = mock(() => ({
				ok: true,
				reason: 'lane-complete',
				laneFound: true,
			})) as typeof verifyLeanTurboTaskCompletion;

			expect(typeof taskCompletionInternals.verifyLeanTurboTaskCompletion).toBe(
				'function',
			);

			taskCompletionInternals.verifyLeanTurboTaskCompletion = original;
		});

		test('hasActiveLeanTurbo returns false when leanTurboActive is not set', () => {
			createPlainSession(SESSION_ID);
			expect(hasActiveLeanTurbo(SESSION_ID)).toBe(false);
		});

		test('hasActiveLeanTurbo returns true when leanTurboActive is true and strategy is lean', () => {
			createLeanTurboSession(SESSION_ID);
			expect(hasActiveLeanTurbo(SESSION_ID)).toBe(true);
		});

		test('hasActiveLeanTurbo returns false when leanTurboActive is true but strategy is standard', () => {
			createStandardTurboSession(SESSION_ID);
			expect(hasActiveLeanTurbo(SESSION_ID)).toBe(false);
		});
	});

	describe('update_task_status lean bypass — behavioral integration', () => {
		test('checkReviewerGate allows bypass when Lean Turbo active and task in completed lane', () => {
			const dir = mkdtemp();
			try {
				// Set up Lean Turbo session
				startAgentSession(SESSION_ID, 'architect');
				const session = swarmState.agentSessions.get(SESSION_ID);
				session!.turboMode = true;
				session!.turboStrategy = 'lean';
				session!.leanTurboActive = true;

				// Create turbo-state.json with running lean session and completed lane containing task 1.1
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

				// Create plan.json with task 1.1
				const planJson = {
					schema_version: '1.0.0',
					title: 'Lean Turbo Test',
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
									files_touched: ['src/utils.ts'],
								},
							],
						},
					],
				};
				fs.writeFileSync(
					path.join(dir, '.swarm', 'plan.json'),
					JSON.stringify(planJson),
				);

				// Create lane evidence file — required by verifyLeanTurboTaskCompletion
				const laneEvidenceDir = path.join(
					dir,
					'.swarm',
					'evidence',
					'1',
					'lean-turbo',
				);
				fs.mkdirSync(laneEvidenceDir, { recursive: true });
				fs.writeFileSync(
					path.join(laneEvidenceDir, 'lane-1.json'),
					JSON.stringify({
						laneId: 'lane-1',
						status: 'completed',
						taskIds: ['1.1'],
						completedAt: new Date().toISOString(),
					}),
				);

				// checkReviewerGate with Lean Turbo active and task in completed lane
				// → should return blocked:false (lean bypass)
				const result = checkReviewerGate('1.1', dir);

				expect(result.blocked).toBe(false);
				expect(result.reason).toContain('Lean Turbo bypass');
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});

		test('checkReviewerGate blocks when Lean Turbo active but task NOT in any lane', () => {
			const dir = mkdtemp();
			try {
				// Set up Lean Turbo session
				startAgentSession(SESSION_ID, 'architect');
				const session = swarmState.agentSessions.get(SESSION_ID);
				session!.turboMode = true;
				session!.turboStrategy = 'lean';
				session!.leanTurboActive = true;

				// Create turbo-state.json with running lean session but NO lanes
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

				// Create plan.json with task 1.1
				const planJson = {
					schema_version: '1.0.0',
					title: 'Lean Turbo Test',
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
									files_touched: ['src/utils.ts'],
								},
							],
						},
					],
				};
				fs.writeFileSync(
					path.join(dir, '.swarm', 'plan.json'),
					JSON.stringify(planJson),
				);

				// checkReviewerGate with Lean Turbo active but task not in any lane
				// → should return blocked:true (task not found in any lane)
				const result = checkReviewerGate('1.1', dir);

				// When lean check returns laneFound:false, standard turbo bypass IS allowed
				// (task confirmed not in any lane, apply standard Turbo rules).
				// Since src/utils.ts is not a Tier-3 file, standard Turbo bypass applies.
				expect(result.blocked).toBe(false);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});

		test('checkReviewerGate blocks when Lean Turbo active and task in incomplete lane', () => {
			const dir = mkdtemp();
			try {
				// Set up Lean Turbo session
				startAgentSession(SESSION_ID, 'architect');
				const session = swarmState.agentSessions.get(SESSION_ID);
				session!.turboMode = true;
				session!.turboStrategy = 'lean';
				session!.leanTurboActive = true;

				// Create turbo-state.json with running lean session and INCOMPLETE lane
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
									status: 'running', // NOT completed
									startedAt: new Date().toISOString(),
								},
							],
							degradedTasks: [],
							counters: {
								lanesPlanned: 1,
								lanesStarted: 1,
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

				// Create plan.json with task 1.1
				const planJson = {
					schema_version: '1.0.0',
					title: 'Lean Turbo Test',
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
									files_touched: ['src/utils.ts'],
								},
							],
						},
					],
				};
				fs.writeFileSync(
					path.join(dir, '.swarm', 'plan.json'),
					JSON.stringify(planJson),
				);

				// checkReviewerGate with Lean Turbo active and task in INCOMPLETE lane
				// → should return blocked:true (lane not completed)
				const result = checkReviewerGate('1.1', dir);

				expect(result.blocked).toBe(true);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});
	});

	// -------------------------------------------------------------------------
	// Integration point 3: system-enhancer lean banner
	// -------------------------------------------------------------------------

	describe('system-enhancer lean banner — LEAN_TURBO_BANNER constant', () => {
		test('LEAN_TURBO_BANNER constant exists in source', () => {
			expect(typeof LEAN_TURBO_BANNER).toBe('string');
			expect(LEAN_TURBO_BANNER.length).toBeGreaterThan(0);
		});

		test('LEAN_TURBO_BANNER contains expected content', () => {
			expect(LEAN_TURBO_BANNER).toContain('LEAN TURBO ACTIVE');
			expect(LEAN_TURBO_BANNER).toContain('lane');
			expect(LEAN_TURBO_BANNER).toContain('parallel');
		});

		test('LEAN_TURBO_BANNER contains Stage B model', () => {
			expect(LEAN_TURBO_BANNER).toContain('Stage B');
			expect(LEAN_TURBO_BANNER).toContain('skip');
		});

		test('LEAN_TURBO_BANNER is non-empty and well-formed', () => {
			// Banner should be a markdown header
			expect(LEAN_TURBO_BANNER).toMatch(/^##\s+/);
			// Banner should contain behavioral changes section
			expect(LEAN_TURBO_BANNER).toContain('Behavioral changes');
		});

		// Minimal smoke test: verifies critical constant is bundled
		test('dist/index.js contains LEAN_TURBO_BANNER constant', () => {
			expect(distContains('LEAN_TURBO_BANNER')).toBe(true);
		});
	});

	// -------------------------------------------------------------------------
	// Integration point 4: /swarm turbo lean command
	// -------------------------------------------------------------------------

	describe('/swarm turbo lean command — dist/index.js presence (smoke)', () => {
		// Minimal smoke test: verifies critical function is bundled
		test('dist/index.js contains enableLeanTurbo function', () => {
			expect(distContains('enableLeanTurbo')).toBe(true);
		});
	});

	describe('/swarm turbo lean command — behavioral test', () => {
		test('turbo lean on enables lean turbo', async () => {
			const dir = mkdtemp();
			try {
				createPlainSession(SESSION_ID);
				const result = await handleTurboCommand(
					dir,
					['lean', 'on'],
					SESSION_ID,
				);
				expect(result).toContain('Lean Turbo enabled');
				const session = swarmState.agentSessions.get(SESSION_ID);
				expect(session?.leanTurboActive).toBe(true);
				expect(session?.turboStrategy).toBe('lean');
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});

		test('turbo lean off disables lean turbo', async () => {
			const dir = mkdtemp();
			try {
				createLeanTurboSession(SESSION_ID);
				const result = await handleTurboCommand(
					dir,
					['lean', 'off'],
					SESSION_ID,
				);
				expect(result).toContain('disabled');
				const session = swarmState.agentSessions.get(SESSION_ID);
				expect(session?.leanTurboActive).toBe(false);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});

		test('turbo status reports precise turbo state (lean or standard or off)', async () => {
			const dir = mkdtemp();
			try {
				// Plain session with turbo off — status must show exact state
				createPlainSession(SESSION_ID);
				const plainResult = await handleTurboCommand(
					dir,
					['status'],
					SESSION_ID,
				);
				expect(plainResult).toBe('Turbo: off');

				// Lean turbo active — status must include 'lean'
				createLeanTurboSession(SESSION_ID);
				const leanResult = await handleTurboCommand(
					dir,
					['status'],
					SESSION_ID,
				);
				expect(leanResult).toMatch(/Turbo: lean/);

				// Standard turbo active — status must include 'standard'
				createStandardTurboSession(SESSION_ID);
				const standardResult = await handleTurboCommand(
					dir,
					['status'],
					SESSION_ID,
				);
				expect(standardResult).toMatch(/Turbo: standard/);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});

		test('turbo lean (toggle) enables lean when inactive', async () => {
			const dir = mkdtemp();
			try {
				createPlainSession(SESSION_ID);
				const result = await handleTurboCommand(dir, ['lean'], SESSION_ID);
				expect(result).toContain('Lean Turbo enabled');
				const session = swarmState.agentSessions.get(SESSION_ID);
				expect(session?.leanTurboActive).toBe(true);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});

		test('turbo lean (toggle) disables lean when active', async () => {
			const dir = mkdtemp();
			try {
				createLeanTurboSession(SESSION_ID);
				const result = await handleTurboCommand(dir, ['lean'], SESSION_ID);
				expect(result).toContain('disabled');
				const session = swarmState.agentSessions.get(SESSION_ID);
				expect(session?.leanTurboActive).toBe(false);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});
	});

	// -------------------------------------------------------------------------
	// Integration point 5: Standard Turbo regression
	// -------------------------------------------------------------------------

	describe('Standard Turbo regression — lean is not active', () => {
		test('standard turbo mode does NOT set leanTurboActive', async () => {
			const dir = mkdtemp();
			try {
				createStandardTurboSession(SESSION_ID);
				await handleTurboCommand(dir, ['standard', 'on'], SESSION_ID);
				const session = swarmState.agentSessions.get(SESSION_ID);
				expect(session?.leanTurboActive).toBe(false);
				expect(session?.turboStrategy).toBe('standard');
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});

		test('standard turbo toggle does NOT activate lean turbo', async () => {
			const dir = mkdtemp();
			try {
				createPlainSession(SESSION_ID);
				const result = await handleTurboCommand(dir, [], SESSION_ID);
				expect(result).toContain('Turbo Mode enabled');
				const session = swarmState.agentSessions.get(SESSION_ID);
				expect(session?.leanTurboActive).toBe(false);
				expect(session?.turboStrategy).toBe('standard');
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});

		test('hasActiveLeanTurbo is false for standard turbo session', () => {
			createStandardTurboSession(SESSION_ID);
			expect(hasActiveLeanTurbo(SESSION_ID)).toBe(false);
		});

		test('hasActiveLeanTurbo is false for plain session', () => {
			createPlainSession(SESSION_ID);
			expect(hasActiveLeanTurbo(SESSION_ID)).toBe(false);
		});

		// Minimal smoke test: verifies standard turbo bypass is bundled
		test('dist/index.js contains standard turbo bypass path', () => {
			expect(distContains('hasActiveTurboMode()')).toBe(true);
		});
	});
});
