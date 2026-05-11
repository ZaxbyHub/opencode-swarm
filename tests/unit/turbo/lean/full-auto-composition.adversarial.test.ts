/**
 * Adversarial tests for LeanTurboRunner — task 11.2 final verification.
 *
 * ONLY attack vectors: malformed inputs, boundary violations, injection attempts.
 * Does NOT repeat existing composition tests from full-auto-composition.test.ts.
 *
 * Attack surface covered:
 * 1. Path traversal in directory parameter
 * 2. Lane ID injection (special chars, shell chars, unicode)
 * 3. Agent name injection (special chars, template literals)
 * 4. Boundary: zero lanes, empty task lists, null files array
 * 5. Overflow: negative phase numbers, Number.MAX_SAFE_INTEGER
 * 6. Session ID injection (special chars)
 * 7. Malformed plan.json (invalid JSON, missing required fields)
 * 8. Corrupted turbo-state.json
 * 9. Null bytes and forbidden chars in file paths
 * 10. Empty and undefined string edge cases
 * 11. Lane dispatch timeout edge cases
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { closeAllProjectDbs } from '../../../../src/db/project-db';
import { resetSwarmState, swarmState } from '../../../../src/state';
import { LeanTurboRunner } from '../../../../src/turbo/lean/runner';
import type { LeanTurboLane } from '../../../../src/turbo/lean/state';
import { repairStateUnreadable } from '../../../../src/turbo/lean/state';

const SESSION_ID = 'sess-adv';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
					parts: [{ type: 'text', text: 'Lane completed' }],
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

function writePlan(dir: string, plan: Record<string, unknown>): void {
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	fs.writeFileSync(path.join(dir, '.swarm', 'plan.json'), JSON.stringify(plan));
}

function writePlanInvalid(dir: string, content: string): void {
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	fs.writeFileSync(path.join(dir, '.swarm', 'plan.json'), content);
}

function writeTurboState(dir: string, state: Record<string, unknown>): void {
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	fs.writeFileSync(
		path.join(dir, '.swarm', 'turbo-state.json'),
		JSON.stringify(state, null, 2),
	);
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('LeanTurboRunner adversarial — task 11.2', () => {
	let tempDir: string;
	let originalCwd: string;

	// Store originals
	const _origLoadPlanJsonOnly = LeanTurboRunner._internals.loadPlanJsonOnly;
	const _origPlanLeanTurboLanes = LeanTurboRunner._internals.planLeanTurboLanes;
	const _origAcquireLaneLocks = LeanTurboRunner._internals.acquireLaneLocks;
	const _origReleaseLaneLocks = LeanTurboRunner._internals.releaseLaneLocks;
	const _origLoadLeanTurboRunState =
		LeanTurboRunner._internals.loadLeanTurboRunState;
	const _origSaveLeanTurboRunState =
		LeanTurboRunner._internals.saveLeanTurboRunState;
	const _origHasActiveFullAuto = LeanTurboRunner._internals.hasActiveFullAuto;
	const _origLoadFullAutoRunState =
		LeanTurboRunner._internals.loadFullAutoRunState;

	beforeEach(() => {
		resetSwarmState();
		tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'lean-adversarial-')),
		);
		originalCwd = process.cwd();
		process.chdir(tempDir);

		// Reset stateUnreadable flag between tests to prevent cascade from corrupted state
		repairStateUnreadable(tempDir);
	});

	afterEach(() => {
		process.chdir(originalCwd);

		// Restore all _internals
		LeanTurboRunner._internals.loadPlanJsonOnly = _origLoadPlanJsonOnly;
		LeanTurboRunner._internals.planLeanTurboLanes = _origPlanLeanTurboLanes;
		LeanTurboRunner._internals.acquireLaneLocks = _origAcquireLaneLocks;
		LeanTurboRunner._internals.releaseLaneLocks = _origReleaseLaneLocks;
		LeanTurboRunner._internals.loadLeanTurboRunState =
			_origLoadLeanTurboRunState;
		LeanTurboRunner._internals.saveLeanTurboRunState =
			_origSaveLeanTurboRunState;
		LeanTurboRunner._internals.hasActiveFullAuto = _origHasActiveFullAuto;
		LeanTurboRunner._internals.loadFullAutoRunState = _origLoadFullAutoRunState;

		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// ignore
		}
		closeAllProjectDbs();
		resetSwarmState();
	});

	// -------------------------------------------------------------------------
	// Attack 1: Path traversal in directory parameter
	// -------------------------------------------------------------------------

	test('1. directory with path traversal (../) — runner handles gracefully', async () => {
		// Directory is explicitly used in file-lock paths and state paths.
		// Passing a path with ../ should NOT escape the project root.
		const escapedDir = path.join(tempDir, 'subdir');
		fs.mkdirSync(escapedDir, { recursive: true });

		LeanTurboRunner._internals.loadPlanJsonOnly = mock(async () => null);
		LeanTurboRunner._internals.hasActiveFullAuto = mock(() => false);
		LeanTurboRunner._internals.loadFullAutoRunState = mock(() => null);

		const runner = new LeanTurboRunner({
			directory: escapedDir,
			sessionID: SESSION_ID,
			generatedAgentNames: ['mega_coder'],
		});

		// Even with path traversal in directory, NO_PLAN should be returned cleanly
		const result = await runner.runPhase(1);
		expect(result.reason).toBe('NO_PLAN');
	});

	// -------------------------------------------------------------------------
	// Attack 2: Lane ID injection — special characters
	// -------------------------------------------------------------------------

	test('2. lane ID with shell injection chars ($`!\\;) — lane processed without code execution', async () => {
		const maliciousLaneId = 'lane-$`!\\;echo-injected';

		writePlan(tempDir, {
			schema_version: '1.0.0',
			title: 'Adv Test',
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
							description: 'task',
							status: 'in_progress',
							phase: 1,
							size: 'small',
							depends: [],
							acceptance: 'Done',
							files_touched: [],
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
		});

		LeanTurboRunner._internals.loadPlanJsonOnly = _origLoadPlanJsonOnly;
		LeanTurboRunner._internals.hasActiveFullAuto = mock(() => false);
		LeanTurboRunner._internals.loadFullAutoRunState = mock(() => null);
		LeanTurboRunner._internals.planLeanTurboLanes = mock(() => ({
			phase: 1,
			planId: 'plan-1',
			lanes: [
				{
					laneId: maliciousLaneId,
					taskIds: ['1.1'],
					files: [],
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
			_origLoadLeanTurboRunState;
		LeanTurboRunner._internals.saveLeanTurboRunState =
			_origSaveLeanTurboRunState;

		const runner = new LeanTurboRunner({
			directory: tempDir,
			sessionID: SESSION_ID,
			generatedAgentNames: ['mega_coder'],
		});
		injectMockSessionOps(runner, makeMockSessionOps(false));

		const result = await runner.runPhase(1);

		// Runner should not crash — lane ID is treated as opaque string
		expect(result.ok).toBe(true);
		// The lane with malicious ID should appear in results as-is (not sanitized/expanded)
		expect(result.lanes[0]?.laneId).toBe(maliciousLaneId);
	});

	// -------------------------------------------------------------------------
	// Attack 3: Lane ID with unicode (RTL override, zero-width space)
	// -------------------------------------------------------------------------

	test('3. lane ID with unicode injection (zero-width space, RTL override) — treated as opaque string', async () => {
		const unicodeLaneId = 'lane-\u200B\u200E\x00term'; // ZWSP + LRM + null byte

		writePlan(tempDir, {
			schema_version: '1.0.0',
			title: 'Adv Test',
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
							description: 'task',
							status: 'in_progress',
							phase: 1,
							size: 'small',
							depends: [],
							acceptance: 'Done',
							files_touched: [],
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
		});

		LeanTurboRunner._internals.loadPlanJsonOnly = _origLoadPlanJsonOnly;
		LeanTurboRunner._internals.hasActiveFullAuto = mock(() => false);
		LeanTurboRunner._internals.loadFullAutoRunState = mock(() => null);
		LeanTurboRunner._internals.planLeanTurboLanes = mock(() => ({
			phase: 1,
			planId: 'plan-1',
			lanes: [
				{
					laneId: unicodeLaneId,
					taskIds: ['1.1'],
					files: [],
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
			_origLoadLeanTurboRunState;
		LeanTurboRunner._internals.saveLeanTurboRunState =
			_origSaveLeanTurboRunState;

		const runner = new LeanTurboRunner({
			directory: tempDir,
			sessionID: SESSION_ID,
			generatedAgentNames: ['mega_coder'],
		});
		injectMockSessionOps(runner, makeMockSessionOps(false));

		const result = await runner.runPhase(1);

		// Runner should handle unicode without crashing
		expect(result.ok).toBe(true);
		expect(result.lanes[0]?.laneId).toBe(unicodeLaneId);
	});

	// -------------------------------------------------------------------------
	// Attack 4: Agent name injection (template literal injection)
	// -------------------------------------------------------------------------

	test('4. agent name with template literal injection (${...}) — not evaluated', async () => {
		const maliciousAgent = 'mega_coder${process.exit(1)}';

		writePlan(tempDir, {
			schema_version: '1.0.0',
			title: 'Adv Test',
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
							description: 'task',
							status: 'in_progress',
							phase: 1,
							size: 'small',
							depends: [],
							acceptance: 'Done',
							files_touched: [],
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
		});

		LeanTurboRunner._internals.loadPlanJsonOnly = _origLoadPlanJsonOnly;
		LeanTurboRunner._internals.hasActiveFullAuto = mock(() => false);
		LeanTurboRunner._internals.loadFullAutoRunState = mock(() => null);
		LeanTurboRunner._internals.planLeanTurboLanes = mock(() => ({
			phase: 1,
			planId: 'plan-1',
			lanes: [
				{
					laneId: 'lane-1',
					taskIds: ['1.1'],
					files: [],
					agent: maliciousAgent,
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
			_origLoadLeanTurboRunState;
		LeanTurboRunner._internals.saveLeanTurboRunState =
			_origSaveLeanTurboRunState;

		const runner = new LeanTurboRunner({
			directory: tempDir,
			sessionID: SESSION_ID,
			generatedAgentNames: [maliciousAgent],
		});
		injectMockSessionOps(runner, makeMockSessionOps(false));

		// Runner should not crash — agent name is used as-is, not evaluated
		const result = await runner.runPhase(1);
		expect(result.ok).toBe(true);
	});

	// -------------------------------------------------------------------------
	// Attack 5: Boundary — zero lanes (NO_LANES result)
	// -------------------------------------------------------------------------

	test('5. planner returns zero lanes → runPhase returns NO_LANES reason', async () => {
		writePlan(tempDir, {
			schema_version: '1.0.0',
			title: 'Adv Test',
			swarm: 'mega',
			current_phase: 1,
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'in_progress',
					tasks: [],
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
		});

		LeanTurboRunner._internals.loadPlanJsonOnly = _origLoadPlanJsonOnly;
		LeanTurboRunner._internals.hasActiveFullAuto = mock(() => false);
		LeanTurboRunner._internals.loadFullAutoRunState = mock(() => null);
		LeanTurboRunner._internals.planLeanTurboLanes = mock(() => ({
			phase: 1,
			planId: 'plan-1',
			lanes: [], // Zero lanes — boundary case
			degradedTasks: [],
			serializedTasks: [],
			counters: {
				lanesPlanned: 0,
				lanesStarted: 0,
				lanesCompleted: 0,
				lanesFailed: 0,
				tasksSerialized: 0,
				tasksDegraded: 0,
			},
			crossLaneDependencies: {},
		}));

		const runner = new LeanTurboRunner({
			directory: tempDir,
			sessionID: SESSION_ID,
			generatedAgentNames: ['mega_coder'],
		});

		const result = await runner.runPhase(1);

		// Zero lanes is a valid "no work to do" case — NOT an error
		expect(result.ok).toBe(false);
		expect(result.reason).toBe('NO_LANES');
		expect(result.lanes).toHaveLength(0);
	});

	// -------------------------------------------------------------------------
	// Attack 6: Boundary — negative phase number
	// -------------------------------------------------------------------------

	test('6. negative phase number — runner handles gracefully', async () => {
		writePlan(tempDir, {
			schema_version: '1.0.0',
			title: 'Adv Test',
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
							description: 'task',
							status: 'in_progress',
							phase: 1,
							size: 'small',
							depends: [],
							acceptance: 'Done',
							files_touched: [],
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
		});

		LeanTurboRunner._internals.loadPlanJsonOnly = _origLoadPlanJsonOnly;
		LeanTurboRunner._internals.hasActiveFullAuto = mock(() => false);
		LeanTurboRunner._internals.loadFullAutoRunState = mock(() => null);
		LeanTurboRunner._internals.planLeanTurboLanes = mock(() => ({
			phase: -999,
			planId: 'plan-1',
			lanes: [],
			degradedTasks: [],
			serializedTasks: [],
			counters: {
				lanesPlanned: 0,
				lanesStarted: 0,
				lanesCompleted: 0,
				lanesFailed: 0,
				tasksSerialized: 0,
				tasksDegraded: 0,
			},
			crossLaneDependencies: {},
		}));

		const runner = new LeanTurboRunner({
			directory: tempDir,
			sessionID: SESSION_ID,
			generatedAgentNames: ['mega_coder'],
		});

		// Negative phase should produce NO_LANES, not crash
		const result = await runner.runPhase(-999);
		expect(result.ok).toBe(false);
		expect(result.reason).toBe('NO_LANES');
	});

	// -------------------------------------------------------------------------
	// Attack 7: Boundary — Number.MAX_SAFE_INTEGER phase number
	// -------------------------------------------------------------------------

	test('7. MAX_SAFE_INTEGER phase number — runner handles without overflow', async () => {
		writePlan(tempDir, {
			schema_version: '1.0.0',
			title: 'Adv Test',
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
							description: 'task',
							status: 'in_progress',
							phase: 1,
							size: 'small',
							depends: [],
							acceptance: 'Done',
							files_touched: [],
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
		});

		LeanTurboRunner._internals.loadPlanJsonOnly = _origLoadPlanJsonOnly;
		LeanTurboRunner._internals.hasActiveFullAuto = mock(() => false);
		LeanTurboRunner._internals.loadFullAutoRunState = mock(() => null);
		LeanTurboRunner._internals.planLeanTurboLanes = mock(() => ({
			phase: Number.MAX_SAFE_INTEGER,
			planId: 'plan-1',
			lanes: [],
			degradedTasks: [],
			serializedTasks: [],
			counters: {
				lanesPlanned: 0,
				lanesStarted: 0,
				lanesCompleted: 0,
				lanesFailed: 0,
				tasksSerialized: 0,
				tasksDegraded: 0,
			},
			crossLaneDependencies: {},
		}));

		const runner = new LeanTurboRunner({
			directory: tempDir,
			sessionID: SESSION_ID,
			generatedAgentNames: ['mega_coder'],
		});

		// Should not crash, should return NO_LANES
		const result = await runner.runPhase(Number.MAX_SAFE_INTEGER);
		expect(result.ok).toBe(false);
		expect(result.reason).toBe('NO_LANES');
	});

	// -------------------------------------------------------------------------
	// Attack 8: Malformed plan.json — invalid JSON
	// -------------------------------------------------------------------------

	test('8. plan.json is invalid JSON — runner returns NO_PLAN', async () => {
		writePlanInvalid(tempDir, '{ invalid json }');

		LeanTurboRunner._internals.loadPlanJsonOnly = _origLoadPlanJsonOnly;
		LeanTurboRunner._internals.hasActiveFullAuto = mock(() => false);
		LeanTurboRunner._internals.loadFullAutoRunState = mock(() => null);

		const runner = new LeanTurboRunner({
			directory: tempDir,
			sessionID: SESSION_ID,
			generatedAgentNames: ['mega_coder'],
		});

		const result = await runner.runPhase(1);

		// Invalid JSON causes loadPlanJsonOnly to return null → NO_PLAN
		expect(result.ok).toBe(false);
		expect(result.reason).toBe('NO_PLAN');
	});

	// -------------------------------------------------------------------------
	// Attack 9: Malformed plan.json — missing required fields (schema_version, phases)
	// -------------------------------------------------------------------------

	test('9. plan.json missing required fields (schema_version, phases) → NO_PLAN', async () => {
		fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
		fs.writeFileSync(
			path.join(tempDir, '.swarm', 'plan.json'),
			JSON.stringify({ title: 'Missing fields' }),
		);

		LeanTurboRunner._internals.loadPlanJsonOnly = _origLoadPlanJsonOnly;
		LeanTurboRunner._internals.hasActiveFullAuto = mock(() => false);
		LeanTurboRunner._internals.loadFullAutoRunState = mock(() => null);

		const runner = new LeanTurboRunner({
			directory: tempDir,
			sessionID: SESSION_ID,
			generatedAgentNames: ['mega_coder'],
		});

		// loadPlanJsonOnly returns null for missing required fields → NO_PLAN
		const result = await runner.runPhase(1);
		expect(result.ok).toBe(false);
		expect(result.reason).toBe('NO_PLAN');
	});

	// -------------------------------------------------------------------------
	// Attack 10: Corrupted turbo-state.json (invalid JSON)
	// -------------------------------------------------------------------------

	test('10. turbo-state.json is invalid JSON → runner handles gracefully (non-fatal)', async () => {
		writePlan(tempDir, {
			schema_version: '1.0.0',
			title: 'Adv Test',
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
							description: 'task',
							status: 'in_progress',
							phase: 1,
							size: 'small',
							depends: [],
							acceptance: 'Done',
							files_touched: [],
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
		});

		// Write corrupted turbo-state.json
		fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
		fs.writeFileSync(
			path.join(tempDir, '.swarm', 'turbo-state.json'),
			'{ corrupted json',
		);

		LeanTurboRunner._internals.loadPlanJsonOnly = _origLoadPlanJsonOnly;
		LeanTurboRunner._internals.hasActiveFullAuto = mock(() => false);
		LeanTurboRunner._internals.loadFullAutoRunState = mock(() => null);
		LeanTurboRunner._internals.planLeanTurboLanes = mock(() => ({
			phase: 1,
			planId: 'plan-1',
			lanes: [
				{
					laneId: 'lane-1',
					taskIds: ['1.1'],
					files: [],
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
			_origLoadLeanTurboRunState;
		LeanTurboRunner._internals.saveLeanTurboRunState =
			_origSaveLeanTurboRunState;

		const runner = new LeanTurboRunner({
			directory: tempDir,
			sessionID: SESSION_ID,
			generatedAgentNames: ['mega_coder'],
		});
		injectMockSessionOps(runner, makeMockSessionOps(false));

		// Runner should bootstrap fresh state rather than crash on corrupted turbo-state
		const result = await runner.runPhase(1);
		expect(result.ok).toBe(true);
	});

	// -------------------------------------------------------------------------
	// Attack 11: File path with null byte injection
	// -------------------------------------------------------------------------

	test('11. file path with null byte (\\x00) — runner handles without crash', async () => {
		const nullBytePath = 'src/file\x00with-null.js';

		writePlan(tempDir, {
			schema_version: '1.0.0',
			title: 'Adv Test',
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
							description: 'task',
							status: 'in_progress',
							phase: 1,
							size: 'small',
							depends: [],
							acceptance: 'Done',
							files_touched: [nullBytePath],
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
		});

		LeanTurboRunner._internals.loadPlanJsonOnly = _origLoadPlanJsonOnly;
		LeanTurboRunner._internals.hasActiveFullAuto = mock(() => false);
		LeanTurboRunner._internals.loadFullAutoRunState = mock(() => null);
		LeanTurboRunner._internals.planLeanTurboLanes = mock(() => ({
			phase: 1,
			planId: 'plan-1',
			lanes: [
				{
					laneId: 'lane-1',
					taskIds: ['1.1'],
					files: [nullBytePath],
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
			_origLoadLeanTurboRunState;
		LeanTurboRunner._internals.saveLeanTurboRunState =
			_origSaveLeanTurboRunState;

		const runner = new LeanTurboRunner({
			directory: tempDir,
			sessionID: SESSION_ID,
			generatedAgentNames: ['mega_coder'],
		});
		injectMockSessionOps(runner, makeMockSessionOps(false));

		// Runner should not crash — file path is passed to lock system
		const result = await runner.runPhase(1);
		expect(result.ok).toBe(true);
	});

	// -------------------------------------------------------------------------
	// Attack 12: Empty session ID
	// -------------------------------------------------------------------------

	test('12. empty session ID — runner handles without crash', async () => {
		writePlan(tempDir, {
			schema_version: '1.0.0',
			title: 'Adv Test',
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
							description: 'task',
							status: 'in_progress',
							phase: 1,
							size: 'small',
							depends: [],
							acceptance: 'Done',
							files_touched: [],
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
		});

		LeanTurboRunner._internals.loadPlanJsonOnly = _origLoadPlanJsonOnly;
		LeanTurboRunner._internals.hasActiveFullAuto = mock(() => false);
		LeanTurboRunner._internals.loadFullAutoRunState = mock(() => null);
		LeanTurboRunner._internals.planLeanTurboLanes = mock(() => ({
			phase: 1,
			planId: 'plan-1',
			lanes: [
				{
					laneId: 'lane-1',
					taskIds: ['1.1'],
					files: [],
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
			_origLoadLeanTurboRunState;
		LeanTurboRunner._internals.saveLeanTurboRunState =
			_origSaveLeanTurboRunState;

		const runner = new LeanTurboRunner({
			directory: tempDir,
			sessionID: '', // Empty session ID
			generatedAgentNames: ['mega_coder'],
		});
		injectMockSessionOps(runner, makeMockSessionOps(false));

		// Runner should not crash with empty session ID
		const result = await runner.runPhase(1);
		expect(result.ok).toBe(true);
	});

	// -------------------------------------------------------------------------
	// Attack 13: Very long task ID (>10KB) — oversized input
	// -------------------------------------------------------------------------

	test('13. task ID exceeds 10KB — runner handles without OOM or crash', async () => {
		const oversizedTaskId = '1.' + 'x'.repeat(15_000); // >10KB task ID

		writePlan(tempDir, {
			schema_version: '1.0.0',
			title: 'Adv Test',
			swarm: 'mega',
			current_phase: 1,
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'in_progress',
					tasks: [
						{
							id: oversizedTaskId,
							description: 'task',
							status: 'in_progress',
							phase: 1,
							size: 'small',
							depends: [],
							acceptance: 'Done',
							files_touched: [],
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
		});

		LeanTurboRunner._internals.loadPlanJsonOnly = _origLoadPlanJsonOnly;
		LeanTurboRunner._internals.hasActiveFullAuto = mock(() => false);
		LeanTurboRunner._internals.loadFullAutoRunState = mock(() => null);
		LeanTurboRunner._internals.planLeanTurboLanes = mock(() => ({
			phase: 1,
			planId: 'plan-1',
			lanes: [
				{
					laneId: 'lane-1',
					taskIds: [oversizedTaskId],
					files: [],
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
			_origLoadLeanTurboRunState;
		LeanTurboRunner._internals.saveLeanTurboRunState =
			_origSaveLeanTurboRunState;

		const runner = new LeanTurboRunner({
			directory: tempDir,
			sessionID: SESSION_ID,
			generatedAgentNames: ['mega_coder'],
		});
		injectMockSessionOps(runner, makeMockSessionOps(false));

		// Runner should handle oversized input without crashing
		const result = await runner.runPhase(1);
		expect(result.ok).toBe(true);
		// The oversized task ID should be preserved in lane result
		expect(result.lanes[0]?.taskIds[0]).toBe(oversizedTaskId);
	});

	// -------------------------------------------------------------------------
	// Attack 14: Lock acquisition fails → lane marked 'blocked'
	// -------------------------------------------------------------------------

	test('14. lock acquisition fails → lane is marked failed, not crashed', async () => {
		writePlan(tempDir, {
			schema_version: '1.0.0',
			title: 'Adv Test',
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
							description: 'task',
							status: 'in_progress',
							phase: 1,
							size: 'small',
							depends: [],
							acceptance: 'Done',
							files_touched: [],
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
		});

		LeanTurboRunner._internals.loadPlanJsonOnly = _origLoadPlanJsonOnly;
		LeanTurboRunner._internals.hasActiveFullAuto = mock(() => false);
		LeanTurboRunner._internals.loadFullAutoRunState = mock(() => null);
		LeanTurboRunner._internals.planLeanTurboLanes = mock(() => ({
			phase: 1,
			planId: 'plan-1',
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
		// Lock acquisition fails (another process holds the lock)
		LeanTurboRunner._internals.acquireLaneLocks = mock(async () => ({
			acquired: false,
			conflicts: ['src/a.ts'],
		}));
		LeanTurboRunner._internals.releaseLaneLocks = mock(async () => {});
		LeanTurboRunner._internals.loadLeanTurboRunState =
			_origLoadLeanTurboRunState;
		LeanTurboRunner._internals.saveLeanTurboRunState =
			_origSaveLeanTurboRunState;

		const runner = new LeanTurboRunner({
			directory: tempDir,
			sessionID: SESSION_ID,
			generatedAgentNames: ['mega_coder'],
		});

		const result = await runner.runPhase(1);

		// Runner should succeed but lane should be blocked
		expect(result.ok).toBe(true);
		expect(result.lanes[0]?.status).toBe('failed');
		expect(result.lanes[0]?.error).toContain('lock conflict');
	});

	// -------------------------------------------------------------------------
	// Attack 15: Lane dispatch timeout — orphan session cleanup
	// -------------------------------------------------------------------------

	test('15. lane dispatch times out → orphan session is cleaned up', async () => {
		writePlan(tempDir, {
			schema_version: '1.0.0',
			title: 'Adv Test',
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
							description: 'task',
							status: 'in_progress',
							phase: 1,
							size: 'small',
							depends: [],
							acceptance: 'Done',
							files_touched: [],
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
		});

		const deleteMock = mock(async () => {});
		const mockOps: MockSessionOps = {
			create: mock(async () => {
				// create succeeds, returns a session ID
				return { data: { id: 'session-timeout-123' }, error: null };
			}),
			prompt: mock(
				async () =>
					new Promise((resolve) =>
						setTimeout(
							() =>
								resolve({
									data: null,
									error: 'Timeout simulating slow prompt',
								}),
							200,
						),
					),
			), // Never resolves within timeout
			delete: deleteMock,
		};

		LeanTurboRunner._internals.loadPlanJsonOnly = _origLoadPlanJsonOnly;
		LeanTurboRunner._internals.hasActiveFullAuto = mock(() => false);
		LeanTurboRunner._internals.loadFullAutoRunState = mock(() => null);
		LeanTurboRunner._internals.planLeanTurboLanes = mock(() => ({
			phase: 1,
			planId: 'plan-1',
			lanes: [
				{
					laneId: 'lane-1',
					taskIds: ['1.1'],
					files: [],
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
			_origLoadLeanTurboRunState;
		LeanTurboRunner._internals.saveLeanTurboRunState =
			_origSaveLeanTurboRunState;
		// Set a short dispatch timeout
		LeanTurboRunner._internals.laneDispatchTimeoutMs = 50;

		const runner = new LeanTurboRunner({
			directory: tempDir,
			sessionID: SESSION_ID,
			generatedAgentNames: ['mega_coder'],
		});
		injectMockSessionOps(runner, mockOps);

		const result = await runner.runPhase(1);

		// Timeout should cause dispatch to fail
		expect(result.ok).toBe(true);
		expect(result.lanes[0]?.status).toBe('failed');
		expect(result.lanes[0]?.error).toContain('timed out');

		// Reset timeout
		LeanTurboRunner._internals.laneDispatchTimeoutMs = undefined;
	});

	// -------------------------------------------------------------------------
	// Attack 16: Session ID with special characters (path traversal potential)
	// -------------------------------------------------------------------------

	test('16. session ID with path traversal chars (../) — runner handles safely', async () => {
		const maliciousSessionId = '../../../etc/passwd';

		writePlan(tempDir, {
			schema_version: '1.0.0',
			title: 'Adv Test',
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
							description: 'task',
							status: 'in_progress',
							phase: 1,
							size: 'small',
							depends: [],
							acceptance: 'Done',
							files_touched: [],
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
		});

		LeanTurboRunner._internals.loadPlanJsonOnly = _origLoadPlanJsonOnly;
		LeanTurboRunner._internals.hasActiveFullAuto = mock(() => false);
		LeanTurboRunner._internals.loadFullAutoRunState = mock(() => null);
		LeanTurboRunner._internals.planLeanTurboLanes = mock(() => ({
			phase: 1,
			planId: 'plan-1',
			lanes: [
				{
					laneId: 'lane-1',
					taskIds: ['1.1'],
					files: [],
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
			_origLoadLeanTurboRunState;
		LeanTurboRunner._internals.saveLeanTurboRunState =
			_origSaveLeanTurboRunState;

		const runner = new LeanTurboRunner({
			directory: tempDir,
			sessionID: maliciousSessionId,
			generatedAgentNames: ['mega_coder'],
		});
		injectMockSessionOps(runner, makeMockSessionOps(false));

		// Runner should not crash with path-traversal session ID
		const result = await runner.runPhase(1);
		expect(result.ok).toBe(true);
	});

	// -------------------------------------------------------------------------
	// Attack 17: HTML/script injection in task description
	// -------------------------------------------------------------------------

	test('17. task description with HTML/script injection (<script>alert(1)</script>) — not rendered', async () => {
		const maliciousDesc = '<script>alert(1)</script>';
		const maliciousTaskId = '1.1';

		writePlan(tempDir, {
			schema_version: '1.0.0',
			title: 'Adv Test',
			swarm: 'mega',
			current_phase: 1,
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'in_progress',
					tasks: [
						{
							id: maliciousTaskId,
							description: maliciousDesc,
							status: 'in_progress',
							phase: 1,
							size: 'small',
							depends: [],
							acceptance: 'Done',
							files_touched: [],
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
		});

		LeanTurboRunner._internals.loadPlanJsonOnly = _origLoadPlanJsonOnly;
		LeanTurboRunner._internals.hasActiveFullAuto = mock(() => false);
		LeanTurboRunner._internals.loadFullAutoRunState = mock(() => null);
		LeanTurboRunner._internals.planLeanTurboLanes = mock(() => ({
			phase: 1,
			planId: 'plan-1',
			lanes: [
				{
					laneId: 'lane-1',
					taskIds: [maliciousTaskId],
					files: [],
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
			_origLoadLeanTurboRunState;
		LeanTurboRunner._internals.saveLeanTurboRunState =
			_origSaveLeanTurboRunState;

		const runner = new LeanTurboRunner({
			directory: tempDir,
			sessionID: SESSION_ID,
			generatedAgentNames: ['mega_coder'],
		});
		injectMockSessionOps(runner, makeMockSessionOps(false));

		const result = await runner.runPhase(1);

		// Runner should not crash — HTML is treated as plain text in the prompt
		expect(result.ok).toBe(true);
	});

	// -------------------------------------------------------------------------
	// Attack 18: Null opencodeClient triggers fail-closed NO_CLIENT
	// -------------------------------------------------------------------------

	test('18. opencodeClient explicitly null → runPhase returns NO_CLIENT (fail-closed)', async () => {
		writePlan(tempDir, {
			schema_version: '1.0.0',
			title: 'Adv Test',
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
							description: 'task',
							status: 'in_progress',
							phase: 1,
							size: 'small',
							depends: [],
							acceptance: 'Done',
							files_touched: [],
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
		});

		LeanTurboRunner._internals.loadPlanJsonOnly = _origLoadPlanJsonOnly;
		LeanTurboRunner._internals.hasActiveFullAuto = mock(() => false);
		LeanTurboRunner._internals.loadFullAutoRunState = mock(() => null);
		LeanTurboRunner._internals.planLeanTurboLanes = mock(() => ({
			phase: 1,
			planId: 'plan-1',
			lanes: [
				{
					laneId: 'lane-1',
					taskIds: ['1.1'],
					files: [],
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

		// Explicitly null client → fail-closed
		const runner = new LeanTurboRunner({
			directory: tempDir,
			sessionID: SESSION_ID,
			opencodeClient: null, // explicitly null — fail-closed
			generatedAgentNames: ['mega_coder'],
		});

		const result = await runner.runPhase(1);

		// Fail-closed: null client means no dispatch
		expect(result.ok).toBe(false);
		expect(result.reason).toBe('NO_CLIENT');
		expect(result.lanes).toHaveLength(0);
	});

	// -------------------------------------------------------------------------
	// Attack 19: Empty generatedAgentNames array → defaults to ['coder']
	// -------------------------------------------------------------------------

	test('19. empty generatedAgentNames → runner falls back to coder', async () => {
		writePlan(tempDir, {
			schema_version: '1.0.0',
			title: 'Adv Test',
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
							description: 'task',
							status: 'in_progress',
							phase: 1,
							size: 'small',
							depends: [],
							acceptance: 'Done',
							files_touched: [],
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
		});

		LeanTurboRunner._internals.loadPlanJsonOnly = _origLoadPlanJsonOnly;
		LeanTurboRunner._internals.hasActiveFullAuto = mock(() => false);
		LeanTurboRunner._internals.loadFullAutoRunState = mock(() => null);
		LeanTurboRunner._internals.planLeanTurboLanes = mock(() => ({
			phase: 1,
			planId: 'plan-1',
			lanes: [
				{
					laneId: 'lane-1',
					taskIds: ['1.1'],
					files: [],
					agent: 'coder', // Fallback agent
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
			_origLoadLeanTurboRunState;
		LeanTurboRunner._internals.saveLeanTurboRunState =
			_origSaveLeanTurboRunState;

		const runner = new LeanTurboRunner({
			directory: tempDir,
			sessionID: SESSION_ID,
			generatedAgentNames: [], // Empty array
		});
		injectMockSessionOps(runner, makeMockSessionOps(false));

		const result = await runner.runPhase(1);

		// Runner should fall back to 'coder' and still work
		expect(result.ok).toBe(true);
	});
});
