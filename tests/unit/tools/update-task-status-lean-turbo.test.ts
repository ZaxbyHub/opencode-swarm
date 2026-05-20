/**
 * Lean Turbo integration tests for update_task_status checkReviewerGate.
 *
 * Covers the Lean Turbo bypass path in checkReviewerGate:
 * - Lean Turbo active + eligible task  → blocked:false with Lean Turbo reason
 * - Lean Turbo active + degraded task  → falls through to normal gates
 * - Lean Turbo active + Tier-3 task   → falls through to normal gates
 * - Standard Turbo active (not lean)  → existing bypass unchanged
 * - Turbo off                        → normal gate behavior
 * - Lean Turbo check throws          → falls through to normal gates
 *
 * Uses _internals seam for mocking verifyLeanTurboTaskCompletion (to trigger
 * the catch-block path in test 6). State functions (hasActiveLeanTurbo,
 * hasActiveTurboMode) are exercised via real session state setup.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'path';
import {
	resetSwarmState,
	_internals as stateInternals,
	swarmState,
} from '../../../src/state';
import { checkReviewerGate } from '../../../src/tools/update-task-status';
import { _internals as leanTurboInternals } from '../../../src/turbo/lean/task-completion';

// ---------------------------------------------------------------------------
// Shared plan.json skeleton
// ---------------------------------------------------------------------------

function makePlanJson(
	tasks: Array<{
		id: string;
		files_touched?: string[];
		status?: string;
	}>,
): string {
	return JSON.stringify({
		schema_version: '1.0.0',
		title: 'Lean Turbo Test Plan',
		swarm: 'lean-turbo-test',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'in_progress',
				tasks: tasks.map((t) => ({
					id: t.id,
					phase: 1,
					status: t.status ?? 'in_progress',
					size: 'small',
					description: `task ${t.id}`,
					depends: [],
					files_touched: t.files_touched ?? [],
				})),
			},
		],
	});
}

// ---------------------------------------------------------------------------
// Session factory helpers
// ---------------------------------------------------------------------------

/** Creates a Lean Turbo session (turboMode=true, turboStrategy='lean', leanTurboActive=true) */
function createLeanTurboSession(sessionId: string): void {
	swarmState.agentSessions.set(sessionId, {
		id: sessionId,
		turboMode: true,
		turboStrategy: 'lean',
		leanTurboActive: true,
		taskWorkflowStates: new Map(),
	});
}

/** Creates a standard Turbo session (turboMode=true, turboStrategy='standard') */
function createStandardTurboSession(sessionId: string): void {
	swarmState.agentSessions.set(sessionId, {
		id: sessionId,
		turboMode: true,
		turboStrategy: 'standard',
		leanTurboActive: false,
		taskWorkflowStates: new Map(),
	});
}

/**
 * Creates a plain session with no turbo flags set.
 * @param taskStates - optional map of taskId → state for gate tests
 */
function createPlainSession(
	sessionId: string,
	taskStates?: Map<string, string>,
): void {
	swarmState.agentSessions.set(sessionId, {
		id: sessionId,
		turboMode: false,
		turboStrategy: 'standard',
		leanTurboActive: false,
		taskWorkflowStates: taskStates ?? new Map(),
	});
}

// ---------------------------------------------------------------------------
// Lean Turbo turbo-state.json helpers
// ---------------------------------------------------------------------------

/**
 * Build a turbo-state.json with a Lean Turbo session where taskId is in a
 * completed lane and lane evidence file exists on disk.
 */
function makeLeanTurboStateCompleted(
	taskId: string,
	laneId = 'lane-1',
): Record<string, unknown> {
	return {
		version: 1,
		updatedAt: new Date().toISOString(),
		sessions: {
			'session-lean': {
				status: 'running',
				sessionID: 'session-lean',
				strategy: 'lean',
				phase: 1,
				maxParallelCoders: 2,
				lanes: [
					{
						laneId,
						taskIds: [taskId],
						files: [`src/${taskId}.ts`],
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
					tasksSerialized: 1,
					tasksDegraded: 0,
				},
			},
		},
	};
}

/**
 * Build a turbo-state.json where taskId is in a completed lane but is marked
 * as degraded (will fail Lean Turbo verification).
 */
function makeLeanTurboStateDegraded(
	taskId: string,
	laneId = 'lane-degraded',
	degradedReason = 'incomplete verification',
): Record<string, unknown> {
	return {
		version: 1,
		updatedAt: new Date().toISOString(),
		sessions: {
			'session-lean': {
				status: 'running',
				sessionID: 'session-lean',
				strategy: 'lean',
				phase: 1,
				maxParallelCoders: 2,
				lanes: [
					{
						laneId,
						taskIds: [taskId],
						files: [`src/${taskId}.ts`],
						status: 'completed',
					},
				],
				degradedTasks: [
					{
						taskId,
						reason: degradedReason,
						files: [`src/${taskId}.ts`],
						requiredMode: 'standard',
					},
				],
				counters: {
					lanesPlanned: 1,
					lanesStarted: 1,
					lanesCompleted: 1,
					lanesFailed: 0,
					tasksSerialized: 1,
					tasksDegraded: 1,
				},
			},
		},
	};
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Lean Turbo integration — checkReviewerGate', () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(path.join(os.tmpdir(), 'lean-turbo-gate-test-'));
		mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });
		mkdirSync(path.join(tmpDir, '.swarm', 'evidence', '1', 'lean-turbo'), {
			recursive: true,
		});
		resetSwarmState();
	});

	afterEach(() => {
		mock.restore();
		resetSwarmState();
		try {
			rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			/* best-effort */
		}
	});

	// -------------------------------------------------------------------------
	// TEST 1: Lean Turbo active + eligible task → bypass Stage B
	// -------------------------------------------------------------------------
	describe('1. Lean Turbo active + eligible task', () => {
		it('returns blocked:false with Lean Turbo bypass reason', () => {
			const taskId = '1.1';

			// Write plan.json with non-Tier-3 files
			writeFileSync(
				path.join(tmpDir, '.swarm', 'plan.json'),
				makePlanJson([{ id: taskId, files_touched: ['src/utils.ts'] }]),
			);

			// Write lane evidence file so verifyLeanTurboTaskCompletion passes step 6
			writeFileSync(
				path.join(
					tmpDir,
					'.swarm',
					'evidence',
					'1',
					'lean-turbo',
					'lane-1.json',
				),
				JSON.stringify({ laneId: 'lane-1', status: 'completed' }),
			);

			// Write turbo-state.json with Lean Turbo session + completed lane
			writeFileSync(
				path.join(tmpDir, '.swarm', 'turbo-state.json'),
				JSON.stringify(makeLeanTurboStateCompleted(taskId, 'lane-1')),
			);

			// Create Lean Turbo session so hasActiveLeanTurbo() returns true
			createLeanTurboSession('session-lean');

			const result = checkReviewerGate(taskId, tmpDir);
			expect(result.blocked).toBe(false);
			expect(result.reason).toContain('Lean Turbo bypass');
		});
	});

	// -------------------------------------------------------------------------
	// TEST 2: Lean Turbo active + degraded task → falls through to normal gates
	// -------------------------------------------------------------------------
	describe('2. Lean Turbo active + degraded task', () => {
		it('falls through to normal gate check (blocked: true — no delegation recorded)', () => {
			const taskId = '2.1';

			writeFileSync(
				path.join(tmpDir, '.swarm', 'plan.json'),
				makePlanJson([{ id: taskId, files_touched: ['src/feature.ts'] }]),
			);

			// turbo-state.json marks the task as degraded
			writeFileSync(
				path.join(tmpDir, '.swarm', 'turbo-state.json'),
				JSON.stringify(
					makeLeanTurboStateDegraded(
						taskId,
						'lane-degraded',
						'incomplete verification',
					),
				),
			);

			// Create Lean Turbo session
			createLeanTurboSession('session-lean');

			// verifyLeanTurboTaskCompletion returns ok:false for degraded tasks,
			// causing Lean Turbo bypass to NOT apply. Falls through to normal
			// gate check. No reviewer/test_engineer delegation recorded → blocked.
			const result = checkReviewerGate(taskId, tmpDir);
			expect(result.blocked).toBe(true);
		});
	});

	// -------------------------------------------------------------------------
	// TEST 3: Lean Turbo active + Tier-3 task → falls through to normal gates
	// -------------------------------------------------------------------------
	describe('3. Lean Turbo active + Tier-3 task', () => {
		it('falls through to normal gate check (blocked: true — no delegation recorded)', () => {
			const taskId = '3.1';

			// plan.json records Tier-3 files (architect.ts, auth.ts)
			writeFileSync(
				path.join(tmpDir, '.swarm', 'plan.json'),
				makePlanJson([
					{ id: taskId, files_touched: ['src/architect.ts', 'src/auth.ts'] },
				]),
			);

			// turbo-state.json has task in completed lane (would normally bypass)
			writeFileSync(
				path.join(tmpDir, '.swarm', 'turbo-state.json'),
				JSON.stringify(makeLeanTurboStateCompleted(taskId, 'lane-tier3')),
			);

			// Write lane evidence
			writeFileSync(
				path.join(
					tmpDir,
					'.swarm',
					'evidence',
					'1',
					'lean-turbo',
					'lane-tier3.json',
				),
				JSON.stringify({ laneId: 'lane-tier3', status: 'completed' }),
			);

			// Create Lean Turbo session
			createLeanTurboSession('session-lean');

			// Tier-3 files cause verifyLeanTurboTaskCompletion to return ok:false
			// (step 8: Tier-3 pattern match). Lean Turbo bypass does NOT apply.
			// Falls through to normal gate check. No delegation recorded → blocked.
			const result = checkReviewerGate(taskId, tmpDir);
			expect(result.blocked).toBe(true);
		});
	});

	// -------------------------------------------------------------------------
	// TEST 4: Standard Turbo active (not lean) → existing bypass unchanged
	// -------------------------------------------------------------------------
	describe('4. Standard Turbo active (not lean)', () => {
		it('applies standard Turbo bypass (blocked:false, reason: "Turbo Mode bypass")', () => {
			const taskId = '4.1';

			writeFileSync(
				path.join(tmpDir, '.swarm', 'plan.json'),
				makePlanJson([{ id: taskId, files_touched: ['src/utils.ts'] }]),
			);

			// Set up standard Turbo session (not Lean)
			createStandardTurboSession('session-std');

			const result = checkReviewerGate(taskId, tmpDir);
			// Standard Turbo bypass — Lean Turbo check is skipped because
			// hasActiveLeanTurbo() returns false (strategy is 'standard', not 'lean').
			expect(result.blocked).toBe(false);
			expect(result.reason).toBe('Turbo Mode bypass');
		});
	});

	// -------------------------------------------------------------------------
	// TEST 5: Turbo off → normal gate behavior
	// -------------------------------------------------------------------------
	describe('5. Turbo off', () => {
		it('falls through to normal gate check (blocked: true — no delegation)', () => {
			const taskId = '5.1';

			writeFileSync(
				path.join(tmpDir, '.swarm', 'plan.json'),
				makePlanJson([{ id: taskId, files_touched: ['src/feature.ts'] }]),
			);

			// Set up a plain session WITHOUT turboMode or leanTurboActive.
			// This makes hasActiveLeanTurbo() and hasActiveTurboMode() both return false.
			// Session has task in 'idle' state → blocked (not tests_run/complete).
			createPlainSession('session-no-turbo', new Map([[taskId, 'idle']]));

			const result = checkReviewerGate(taskId, tmpDir);
			// No turbo bypass. Falls through to normal gate check.
			// Session exists with task state 'idle' (not tests_run/complete) → blocked.
			expect(result.blocked).toBe(true);
		});
	});

	// -------------------------------------------------------------------------
	// TEST 6: Lean Turbo check throws → falls through to normal gates
	// -------------------------------------------------------------------------
	describe('6. Lean Turbo check throws', () => {
		it('catches exception and falls through to normal gate check', () => {
			const taskId = '6.1';

			writeFileSync(
				path.join(tmpDir, '.swarm', 'plan.json'),
				makePlanJson([{ id: taskId, files_touched: ['src/feature.ts'] }]),
			);

			// Set up Lean Turbo session (so hasActiveLeanTurbo() returns true)
			createLeanTurboSession('session-lean-throw');

			// Mock verifyLeanTurboTaskCompletion to throw — triggers catch block
			// in the Lean Turbo bypass section of checkReviewerGate.
			const originalVerify = leanTurboInternals.verifyLeanTurboTaskCompletion;
			leanTurboInternals.verifyLeanTurboTaskCompletion = (() => {
				throw new Error('simulated turbo-state.json read failure');
			}) as typeof originalVerify;

			// Catch block should trigger → falls through to normal gate check.
			// Session has no task state for taskId → falls through to evidence/session checks.
			// No evidence file, task state undefined → blocked.
			const result = checkReviewerGate(taskId, tmpDir);
			expect(result.blocked).toBe(true);

			leanTurboInternals.verifyLeanTurboTaskCompletion = originalVerify;
		});
	});
});
