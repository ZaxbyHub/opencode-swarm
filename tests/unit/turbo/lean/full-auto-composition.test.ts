/**
 * Full-Auto v2 + Lean Turbo composition integration tests.
 *
 * Tests the interaction between Full-Auto v2 autonomy regime and Lean Turbo
 * lane execution when both are active simultaneously in a session.
 *
 * Test scenarios:
 * 1. Both modes active simultaneously — runPhase proceeds when both Full-Auto is
 *    running (not paused/terminated) and Lean Turbo state is valid
 * 2. Full-Auto paused blocks runner — runPhase returns FULL_AUTO_BLOCKED when
 *    Full-Auto is paused (existing runner.test.ts coverage, verified here)
 * 3. Full-Auto terminated blocks runner — runPhase returns FULL_AUTO_BLOCKED
 * 4. Full-Auto not active — Lean Turbo gate runs normally
 * 5. Full-Auto running + lane dispatch failure → lane marked failed when
 *    session.create fails (simulating policy denial)
 *
 * Uses _internals seams for LeanTurboRunner mocking. Does NOT use mock.module.
 * Session state (leanTurboActive, fullAutoMode) is set via real swarmState.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { closeAllProjectDbs } from '../../../../src/db/project-db';
import {
	ensureAgentSession,
	recordPhaseAgentDispatch,
	resetSwarmState,
	swarmState,
} from '../../../../src/state';
import { LeanTurboRunner } from '../../../../src/turbo/lean/runner';
import type {
	LeanTurboLane,
	LeanTurboPersistedState,
} from '../../../../src/turbo/lean/state';

// ---------------------------------------------------------------------------
// Shared setup helpers
// ---------------------------------------------------------------------------

const SESSION_ID = 'sess1';

interface MockSessionOps {
	create: ReturnType<typeof mock>;
	prompt: ReturnType<typeof mock>;
	delete: ReturnType<typeof mock>;
}

function makeMockSessionOps(shouldFail = false): MockSessionOps {
	return {
		create: mock(async () => {
			if (shouldFail) {
				return { data: null, error: 'Session creation failed' };
			}
			return { data: { id: `mock-session-${Date.now()}` }, error: null };
		}),
		prompt: mock(async () => {
			if (shouldFail) {
				return { data: null, error: 'Prompt failed' };
			}
			return {
				data: {
					parts: [{ type: 'text', text: 'Lane completed successfully' }],
				},
				error: null,
			};
		}),
		delete: mock(async () => {}),
	};
}

function injectMockSessionOps(
	runner: LeanTurboRunner,
	ops: MockSessionOps,
): void {
	(runner as unknown as { _sessionOps: MockSessionOps })._sessionOps = ops;
}

function setupMinimalPlan(dir: string, phaseNumber = 1): void {
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	fs.mkdirSync(path.join(dir, '.swarm', 'scopes'), { recursive: true });
	fs.mkdirSync(path.join(dir, 'src'), { recursive: true });

	// Create actual file so completion verification passes
	fs.writeFileSync(
		path.join(dir, 'src', 'a.ts'),
		'export function testFunction(): void {}\n',
	);

	// Create scope file
	fs.writeFileSync(
		path.join(dir, '.swarm', 'scopes', `scope-${phaseNumber}.1.json`),
		JSON.stringify({ files: ['src/a.ts'] }),
	);

	const plan = {
		schema_version: '1.0.0',
		title: 'Full-Auto Lean Turbo Test',
		swarm: 'mega',
		current_phase: phaseNumber,
		phases: [
			{
				id: phaseNumber,
				name: `Phase ${phaseNumber}`,
				status: 'in_progress',
				tasks: [
					{
						id: `${phaseNumber}.1`,
						description: 'testFunction implementation',
						status: 'completed',
						phase: phaseNumber,
						size: 'small',
						depends: [],
						acceptance: 'Done',
						files_touched: ['src/a.ts'],
					},
				],
			},
		],
		lean: {
			max_parallel_coders: 4,
			require_declared_scope: false,
			conflict_policy: 'serialize',
			degrade_on_risk: true,
			phase_reviewer: false,
			phase_critic: false,
			integrated_diff_required: false,
			allow_docs_only_without_reviewer: false,
			worktree_isolation: false,
		},
	};
	fs.writeFileSync(path.join(dir, '.swarm', 'plan.json'), JSON.stringify(plan));
}

function writeLeanTurboState(
	dir: string,
	phase: number,
	lanes: LeanTurboLane[],
): void {
	const turboDir = path.join(dir, '.swarm');
	fs.mkdirSync(turboDir, { recursive: true });

	const persisted: LeanTurboPersistedState = {
		version: 1,
		updatedAt: new Date().toISOString(),
		sessions: {
			sess1: {
				status: 'running',
				sessionID: 'sess1',
				strategy: 'lean',
				phase,
				maxParallelCoders: 2,
				lanes,
				degradedTasks: [],
				lastReviewerVerdict: 'APPROVED',
				lastCriticVerdict: 'APPROVED',
				counters: {
					lanesPlanned: lanes.length,
					lanesStarted: lanes.length,
					lanesCompleted: lanes.filter((l) => l.status === 'completed').length,
					lanesFailed: lanes.filter((l) => l.status === 'failed').length,
					tasksSerialized: 1,
					tasksDegraded: 0,
				},
			},
		},
	};

	fs.writeFileSync(
		path.join(turboDir, 'turbo-state.json'),
		JSON.stringify(persisted, null, 2),
	);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Full-Auto v2 + Lean Turbo composition', () => {
	let tempDir: string;
	let originalCwd: string;

	// Store original _internals for restoration
	const _originalLoadPlanJsonOnly = LeanTurboRunner._internals.loadPlanJsonOnly;
	const _originalPlanLeanTurboLanes =
		LeanTurboRunner._internals.planLeanTurboLanes;
	const _originalAcquireLaneLocks = LeanTurboRunner._internals.acquireLaneLocks;
	const _originalReleaseLaneLocks = LeanTurboRunner._internals.releaseLaneLocks;
	const _originalLoadLeanTurboRunState =
		LeanTurboRunner._internals.loadLeanTurboRunState;
	const _originalSaveLeanTurboRunState =
		LeanTurboRunner._internals.saveLeanTurboRunState;
	const _originalHasActiveFullAuto =
		LeanTurboRunner._internals.hasActiveFullAuto;
	const _originalLoadFullAutoRunState =
		LeanTurboRunner._internals.loadFullAutoRunState;

	beforeEach(() => {
		resetSwarmState();
		tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'full-auto-lean-composition-')),
		);
		originalCwd = process.cwd();
		process.chdir(tempDir);

		ensureAgentSession(SESSION_ID);
		recordPhaseAgentDispatch(SESSION_ID, 'coder');
	});

	afterEach(() => {
		process.chdir(originalCwd);

		// Restore all _internals
		LeanTurboRunner._internals.loadPlanJsonOnly = _originalLoadPlanJsonOnly;
		LeanTurboRunner._internals.planLeanTurboLanes = _originalPlanLeanTurboLanes;
		LeanTurboRunner._internals.acquireLaneLocks = _originalAcquireLaneLocks;
		LeanTurboRunner._internals.releaseLaneLocks = _originalReleaseLaneLocks;
		LeanTurboRunner._internals.loadLeanTurboRunState =
			_originalLoadLeanTurboRunState;
		LeanTurboRunner._internals.saveLeanTurboRunState =
			_originalSaveLeanTurboRunState;
		LeanTurboRunner._internals.hasActiveFullAuto = _originalHasActiveFullAuto;
		LeanTurboRunner._internals.loadFullAutoRunState =
			_originalLoadFullAutoRunState;

		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// ignore
		}
		closeAllProjectDbs();
		resetSwarmState();
	});

	// -------------------------------------------------------------------------
	// Test 1: Both modes active — runPhase proceeds when Full-Auto is running
	// -------------------------------------------------------------------------

	test('1. Lean Turbo active + Full-Auto running → runPhase proceeds', async () => {
		// Set up Lean Turbo session state
		swarmState.agentSessions.get(SESSION_ID)!.turboStrategy = 'lean';
		swarmState.agentSessions.get(SESSION_ID)!.leanTurboActive = true;
		swarmState.agentSessions.get(SESSION_ID)!.fullAutoMode = true;

		setupMinimalPlan(tempDir, 1);

		writeLeanTurboState(tempDir, 1, [
			{
				laneId: 'lane-1',
				taskIds: ['1.1'],
				files: ['src/a.ts'],
				status: 'completed',
				agent: 'mega_coder',
				sessionId: SESSION_ID,
			},
		]);

		// Mock Full-Auto internals - Full-Auto is running
		LeanTurboRunner._internals.hasActiveFullAuto = mock(() => true);
		LeanTurboRunner._internals.loadFullAutoRunState = mock(() => ({
			sessionID: SESSION_ID,
			status: 'running',
			mode: 'supervised',
			planID: 'test-plan',
			currentPhase: 1,
			currentTaskID: '1.1',
			pauseReason: undefined,
			terminateReason: undefined,
			denialCounters: { consecutive: 0, total: 0 },
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		}));

		LeanTurboRunner._internals.loadPlanJsonOnly = mock(async () => ({
			schema_version: '1.0.0',
			title: 'Test Plan',
			swarm: 'mega',
			current_phase: 1,
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'in_progress',
					tasks: [
						{
							id: '1.1',
							description: 'testFunction implementation',
							status: 'completed',
							phase: 1,
							size: 'small',
							depends: [],
							acceptance: 'Done',
						},
					],
				},
			],
			lean: {
				max_parallel_coders: 4,
				require_declared_scope: false,
				conflict_policy: 'serialize',
				degrade_on_risk: true,
				phase_reviewer: false,
				phase_critic: false,
				integrated_diff_required: false,
				allow_docs_only_without_reviewer: false,
				worktree_isolation: false,
			},
		}));

		LeanTurboRunner._internals.planLeanTurboLanes = mock(() => ({
			phase: 1,
			planId: 'test-plan',
			lanes: [
				{
					laneId: 'lane-1',
					taskIds: ['1.1'],
					files: ['src/a.ts'],
					agent: 'mega_coder',
				},
			],
			degradedTasks: [],
			serializedTasks: [],
			counters: {
				lanesPlanned: 1,
				lanesStarted: 0,
				lanesCompleted: 0,
				lanesFailed: 0,
				tasksSerialized: 0,
				tasksDegraded: 0,
			},
			crossLaneDependencies: {},
		}));
		LeanTurboRunner._internals.acquireLaneLocks = mock(async () => ({
			ok: true,
			acquired: [],
		}));
		LeanTurboRunner._internals.releaseLaneLocks = mock(async () => {});
		LeanTurboRunner._internals.loadLeanTurboRunState =
			_originalLoadLeanTurboRunState;
		LeanTurboRunner._internals.saveLeanTurboRunState =
			_originalSaveLeanTurboRunState;

		const runner = new LeanTurboRunner({
			directory: tempDir,
			sessionID: SESSION_ID,
			generatedAgentNames: ['mega_coder'],
		});

		// Inject successful mock session ops
		injectMockSessionOps(runner, makeMockSessionOps(false));

		const result = await runner.runPhase(1);

		// runPhase should succeed because Full-Auto is running (not paused/terminated)
		expect(result.ok).toBe(true);
		// Lanes should have been processed
		expect(result.lanes.length).toBeGreaterThan(0);
	});

	// -------------------------------------------------------------------------
	// Test 2: Full-Auto paused blocks runner
	// -------------------------------------------------------------------------

	test('2. runPhase returns FULL_AUTO_BLOCKED when full-auto is paused', async () => {
		// Set up Lean Turbo session state
		swarmState.agentSessions.get(SESSION_ID)!.turboStrategy = 'lean';
		swarmState.agentSessions.get(SESSION_ID)!.leanTurboActive = true;
		swarmState.agentSessions.get(SESSION_ID)!.fullAutoMode = true;

		setupMinimalPlan(tempDir, 1);

		writeLeanTurboState(tempDir, 1, [
			{
				laneId: 'lane-1',
				taskIds: ['1.1'],
				files: ['src/a.ts'],
				status: 'completed',
				agent: 'mega_coder',
				sessionId: SESSION_ID,
			},
		]);

		// Mock hasActiveFullAuto to return true (Full-Auto paused)
		LeanTurboRunner._internals.hasActiveFullAuto = mock(() => true);
		LeanTurboRunner._internals.loadFullAutoRunState = mock(() => ({
			sessionID: SESSION_ID,
			status: 'paused',
			mode: 'supervised',
			planID: 'test-plan',
			currentPhase: 1,
			currentTaskID: '1.1',
			pauseReason: 'user_paused',
			terminateReason: undefined,
			denialCounters: { consecutive: 0, total: 0 },
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		}));

		LeanTurboRunner._internals.acquireLaneLocks = mock(async () => ({
			ok: true,
			acquired: [],
		}));
		LeanTurboRunner._internals.releaseLaneLocks = mock(async () => {});

		const runner = new LeanTurboRunner({
			directory: tempDir,
			sessionID: SESSION_ID,
			generatedAgentNames: ['mega_coder'],
		});

		const result = await runner.runPhase(1);

		// Full-Auto paused should block the runner
		expect(result.ok).toBe(false);
		expect(result.reason).toBe('FULL_AUTO_BLOCKED');
		expect(result.lanes).toHaveLength(0);
	});

	// -------------------------------------------------------------------------
	// Test 3: Full-Auto terminated blocks runner
	// -------------------------------------------------------------------------

	test('3. runPhase returns FULL_AUTO_BLOCKED when full-auto is terminated', async () => {
		// Set up Lean Turbo session state
		swarmState.agentSessions.get(SESSION_ID)!.turboStrategy = 'lean';
		swarmState.agentSessions.get(SESSION_ID)!.leanTurboActive = true;
		swarmState.agentSessions.get(SESSION_ID)!.fullAutoMode = true;

		setupMinimalPlan(tempDir, 1);

		writeLeanTurboState(tempDir, 1, [
			{
				laneId: 'lane-1',
				taskIds: ['1.1'],
				files: ['src/a.ts'],
				status: 'completed',
				agent: 'mega_coder',
				sessionId: SESSION_ID,
			},
		]);

		// Mock hasActiveFullAuto to return true (Full-Auto terminated)
		LeanTurboRunner._internals.hasActiveFullAuto = mock(() => true);
		LeanTurboRunner._internals.loadFullAutoRunState = mock(() => ({
			sessionID: SESSION_ID,
			status: 'terminated',
			mode: 'supervised',
			planID: 'test-plan',
			currentPhase: 1,
			currentTaskID: '1.1',
			pauseReason: undefined,
			terminateReason: 'user_terminated',
			denialCounters: { consecutive: 0, total: 0 },
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		}));

		LeanTurboRunner._internals.acquireLaneLocks = mock(async () => ({
			ok: true,
			acquired: [],
		}));
		LeanTurboRunner._internals.releaseLaneLocks = mock(async () => {});

		const runner = new LeanTurboRunner({
			directory: tempDir,
			sessionID: SESSION_ID,
			generatedAgentNames: ['mega_coder'],
		});

		const result = await runner.runPhase(1);

		// Full-Auto terminated should block the runner
		expect(result.ok).toBe(false);
		expect(result.reason).toBe('FULL_AUTO_BLOCKED');
		expect(result.lanes).toHaveLength(0);
	});

	// -------------------------------------------------------------------------
	// Test 4: Full-Auto not active — Lean Turbo gate runs normally
	// -------------------------------------------------------------------------

	test('4. Lean Turbo active + Full-Auto not active → runPhase proceeds without Full-Auto check', async () => {
		// Set up Lean Turbo session state (no Full-Auto)
		swarmState.agentSessions.get(SESSION_ID)!.turboStrategy = 'lean';
		swarmState.agentSessions.get(SESSION_ID)!.leanTurboActive = true;
		swarmState.agentSessions.get(SESSION_ID)!.fullAutoMode = false;

		setupMinimalPlan(tempDir, 1);

		writeLeanTurboState(tempDir, 1, [
			{
				laneId: 'lane-1',
				taskIds: ['1.1'],
				files: ['src/a.ts'],
				status: 'completed',
				agent: 'mega_coder',
				sessionId: SESSION_ID,
			},
		]);

		// Full-Auto is NOT active
		LeanTurboRunner._internals.hasActiveFullAuto = mock(() => false);
		LeanTurboRunner._internals.loadFullAutoRunState = mock(() => null);

		LeanTurboRunner._internals.loadPlanJsonOnly = mock(async () => ({
			schema_version: '1.0.0',
			title: 'Test Plan',
			swarm: 'mega',
			current_phase: 1,
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'in_progress',
					tasks: [
						{
							id: '1.1',
							description: 'testFunction implementation',
							status: 'completed',
							phase: 1,
							size: 'small',
							depends: [],
							acceptance: 'Done',
						},
					],
				},
			],
			lean: {
				max_parallel_coders: 4,
				require_declared_scope: false,
				conflict_policy: 'serialize',
				degrade_on_risk: true,
				phase_reviewer: false,
				phase_critic: false,
				integrated_diff_required: false,
				allow_docs_only_without_reviewer: false,
				worktree_isolation: false,
			},
		}));

		LeanTurboRunner._internals.planLeanTurboLanes = mock(() => ({
			phase: 1,
			planId: 'test-plan',
			lanes: [
				{
					laneId: 'lane-1',
					taskIds: ['1.1'],
					files: ['src/a.ts'],
					agent: 'mega_coder',
				},
			],
			degradedTasks: [],
			serializedTasks: [],
			counters: {
				lanesPlanned: 1,
				lanesStarted: 0,
				lanesCompleted: 0,
				lanesFailed: 0,
				tasksSerialized: 0,
				tasksDegraded: 0,
			},
			crossLaneDependencies: {},
		}));
		LeanTurboRunner._internals.acquireLaneLocks = mock(async () => ({
			ok: true,
			acquired: [],
		}));
		LeanTurboRunner._internals.releaseLaneLocks = mock(async () => {});
		LeanTurboRunner._internals.loadLeanTurboRunState =
			_originalLoadLeanTurboRunState;
		LeanTurboRunner._internals.saveLeanTurboRunState =
			_originalSaveLeanTurboRunState;

		const runner = new LeanTurboRunner({
			directory: tempDir,
			sessionID: SESSION_ID,
			generatedAgentNames: ['mega_coder'],
		});

		// Inject successful mock session ops
		injectMockSessionOps(runner, makeMockSessionOps(false));

		const result = await runner.runPhase(1);

		// runPhase should succeed because Full-Auto is not active
		expect(result.ok).toBe(true);
		expect(result.lanes.length).toBeGreaterThan(0);
	});

	// -------------------------------------------------------------------------
	// Test 5: Full-Auto running + lane dispatch failure → lane marked failed
	// -------------------------------------------------------------------------

	test('5. Full-Auto running + lane dispatch fails → lane result indicates failure', async () => {
		// Set up Lean Turbo session state
		swarmState.agentSessions.get(SESSION_ID)!.turboStrategy = 'lean';
		swarmState.agentSessions.get(SESSION_ID)!.leanTurboActive = true;
		swarmState.agentSessions.get(SESSION_ID)!.fullAutoMode = true;

		setupMinimalPlan(tempDir, 1);

		writeLeanTurboState(tempDir, 1, [
			{
				laneId: 'lane-1',
				taskIds: ['1.1'],
				files: ['src/a.ts'],
				status: 'in_progress',
				agent: 'mega_coder',
				sessionId: SESSION_ID,
			},
		]);

		// Mock hasActiveFullAuto to return true (Full-Auto running)
		LeanTurboRunner._internals.hasActiveFullAuto = mock(() => true);
		LeanTurboRunner._internals.loadFullAutoRunState = mock(() => ({
			sessionID: SESSION_ID,
			status: 'running',
			mode: 'supervised',
			planID: 'test-plan',
			currentPhase: 1,
			currentTaskID: '1.1',
			pauseReason: undefined,
			terminateReason: undefined,
			denialCounters: { consecutive: 0, total: 0 },
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		}));

		LeanTurboRunner._internals.loadPlanJsonOnly = mock(async () => ({
			schema_version: '1.0.0',
			title: 'Test Plan',
			swarm: 'mega',
			current_phase: 1,
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'in_progress',
					tasks: [
						{
							id: '1.1',
							description: 'testFunction implementation',
							status: 'in_progress',
							phase: 1,
							size: 'small',
							depends: [],
							acceptance: 'Done',
						},
					],
				},
			],
			lean: {
				max_parallel_coders: 4,
				require_declared_scope: false,
				conflict_policy: 'serialize',
				degrade_on_risk: true,
				phase_reviewer: false,
				phase_critic: false,
				integrated_diff_required: false,
				allow_docs_only_without_reviewer: false,
				worktree_isolation: false,
			},
		}));

		LeanTurboRunner._internals.planLeanTurboLanes = mock(() => ({
			phase: 1,
			planId: 'test-plan',
			lanes: [
				{
					laneId: 'lane-1',
					taskIds: ['1.1'],
					files: ['src/a.ts'],
					agent: 'mega_coder',
				},
			],
			degradedTasks: [],
			serializedTasks: [],
			counters: {
				lanesPlanned: 1,
				lanesStarted: 0,
				lanesCompleted: 0,
				lanesFailed: 0,
				tasksSerialized: 0,
				tasksDegraded: 0,
			},
			crossLaneDependencies: {},
		}));
		LeanTurboRunner._internals.acquireLaneLocks = mock(async () => ({
			ok: true,
			acquired: [],
		}));
		LeanTurboRunner._internals.releaseLaneLocks = mock(async () => {});
		LeanTurboRunner._internals.loadLeanTurboRunState =
			_originalLoadLeanTurboRunState;
		LeanTurboRunner._internals.saveLeanTurboRunState =
			_originalSaveLeanTurboRunState;

		const runner = new LeanTurboRunner({
			directory: tempDir,
			sessionID: SESSION_ID,
			generatedAgentNames: ['mega_coder'],
		});

		// Inject failing mock session ops (simulates policy denial during dispatch)
		injectMockSessionOps(runner, makeMockSessionOps(true));

		const result = await runner.runPhase(1);

		// Full-Auto is running so runner proceeds to dispatch lanes
		expect(result.ok).toBe(true);
		// The lane should be in the results with a failed status due to dispatch failure
		expect(result.lanes.length).toBeGreaterThan(0);
		// The lane status should be 'failed' because session.create failed
		expect(result.lanes[0].status).toBe('failed');
	});
});
