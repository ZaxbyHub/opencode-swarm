/**
 * Lean Turbo status integration tests for status-service.
 *
 * Tests that status data and markdown output correctly reflect Lean Turbo state.
 * Uses _internals DI seams for mocking to avoid mock.module leakage.
 *
 * Test scenarios:
 * 1. Turbo off — no lean or standard turbo active
 * 2. Turbo standard — standard turbo active, lean not active
 * 3. Turbo lean — lean turbo active with phase, lanes, degraded tasks
 * 4. Full-Auto + Lean Turbo — both active simultaneously
 * 5. Lean Turbo paused — pause reason displayed
 * 6. All tasks degraded — degradation_summary and markdown shown
 * 7. Standard turbo unchanged when lean is not active
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { Plan } from '../../../src/config/plan-schema';
import {
	_internals,
	formatStatusMarkdown,
	getStatusData,
} from '../../../src/services/status-service';
import {
	ensureAgentSession,
	resetSwarmState,
	swarmState,
} from '../../../src/state';
import type {
	LeanTurboLane,
	LeanTurboPersistedState,
} from '../../../src/turbo/lean/state';
import { repairStateUnreadable } from '../../../src/turbo/lean/state';

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

const SESSION_ID = 'test-lean-status-session';
const PLAN_PHASE_1: Plan = {
	schema_version: '1.0.0',
	title: 'Lean Turbo Status Test',
	swarm: 'test-swarm',
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
					description: 'Task 1',
					depends: [],
					files_touched: [],
				},
				{
					id: '1.2',
					phase: 1,
					status: 'pending',
					size: 'small',
					description: 'Task 2',
					depends: [],
					files_touched: [],
				},
			],
		},
	],
};

function writePlanJson(dir: string, plan: Plan): void {
	const swarmDir = path.join(dir, '.swarm');
	fs.mkdirSync(swarmDir, { recursive: true });
	fs.writeFileSync(
		path.join(swarmDir, 'plan.json'),
		JSON.stringify(plan, null, 2),
	);
}

function writeLeanTurboState(
	dir: string,
	sessionId: string,
	phase: number,
	lanes: LeanTurboLane[],
	degradedTasks: {
		taskId: string;
		reason: string;
		files: string[];
		requiredMode: 'standard' | 'balanced';
	}[] = [],
	status: 'idle' | 'running' | 'paused' | 'terminated' = 'running',
	pauseReason?: string,
): void {
	const turboDir = path.join(dir, '.swarm');
	fs.mkdirSync(turboDir, { recursive: true });

	const persisted: LeanTurboPersistedState = {
		version: 1,
		updatedAt: new Date().toISOString(),
		sessions: {
			[sessionId]: {
				status,
				sessionID: sessionId,
				strategy: 'lean',
				phase,
				maxParallelCoders: 2,
				lanes,
				degradedTasks,
				lastReviewerVerdict: 'APPROVED',
				lastCriticVerdict: 'APPROVED',
				counters: {
					lanesPlanned: lanes.length,
					lanesStarted: lanes.length,
					lanesCompleted: lanes.filter((l) => l.status === 'completed').length,
					lanesFailed: lanes.filter((l) => l.status === 'failed').length,
					tasksSerialized: 1,
					tasksDegraded: degradedTasks.length,
				},
				...(pauseReason ? { pauseReason } : {}),
			},
		},
	};

	fs.writeFileSync(
		path.join(turboDir, 'turbo-state.json'),
		JSON.stringify(persisted, null, 2),
	);
}

describe('status-service Lean Turbo integration', () => {
	let tempDir: string;
	let originalLoadLeanTurboRunState: typeof _internals.loadLeanTurboRunState;
	let originalHasActiveLeanTurbo: typeof _internals.hasActiveLeanTurbo;
	let originalHasActiveFullAuto: typeof _internals.hasActiveFullAuto;

	const mockAgents: Record<
		string,
		{ name: string; config: { model: string } }
	> = {
		architect: { name: 'architect', config: { model: 'gpt-4' } },
	};

	beforeEach(async () => {
		// Create a fresh temp directory for each test
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lean-status-test-'));
		writePlanJson(tempDir, PLAN_PHASE_1);

		// Save original _internals
		originalLoadLeanTurboRunState = _internals.loadLeanTurboRunState;
		originalHasActiveLeanTurbo = _internals.hasActiveLeanTurbo;
		originalHasActiveFullAuto = _internals.hasActiveFullAuto;

		// Reset swarm state and set up a clean session
		resetSwarmState();
		ensureAgentSession(SESSION_ID);
	});

	afterEach(() => {
		// Restore all _internals
		_internals.loadLeanTurboRunState = originalLoadLeanTurboRunState;
		_internals.hasActiveLeanTurbo = originalHasActiveLeanTurbo;
		_internals.hasActiveFullAuto = originalHasActiveFullAuto;

		// Clean up temp directory
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// ignore cleanup errors
		}
		resetSwarmState();
		// Reset the module-level stateUnreadable flag between tests so a corrupted
		// state file in one test does not cascade to others.
		repairStateUnreadable(tempDir);
	});

	// -------------------------------------------------------------------------
	// Test 1: Turbo off — no turbo active
	// -------------------------------------------------------------------------

	test('1. status shows Turbo: off when no turbo active', async () => {
		// Ensure no turbo is active — lean turbo returns false, standard turbo returns false
		_internals.hasActiveLeanTurbo = mock(() => false);
		_internals.hasActiveFullAuto = mock(() => false);

		// Also need to ensure standard turbo mode is off
		// hasActiveTurboMode is not in _internals, so we need to ensure the session doesn't have turboStrategy

		const status = await getStatusData(tempDir, mockAgents);

		expect(status.turboStrategy).toBe('off');
		expect(status.turboMode).toBe(false);

		const markdown = formatStatusMarkdown(status);
		expect(markdown).not.toContain('**Turbo**:');
		expect(markdown).not.toContain('TURBO MODE');
	});

	// -------------------------------------------------------------------------
	// Test 2: Turbo standard — standard turbo active, lean not active
	// -------------------------------------------------------------------------

	test('2. status shows Turbo: standard when standard turbo active', async () => {
		// Set up standard turbo mode via turboMode flag (not lean)
		const session = swarmState.agentSessions.get(SESSION_ID)!;
		session.turboMode = true;
		// leanTurboActive should be false for standard turbo
		session.leanTurboActive = false;
		session.turboStrategy = undefined; // not lean

		_internals.hasActiveLeanTurbo = mock(() => false);
		_internals.hasActiveFullAuto = mock(() => false);

		const status = await getStatusData(tempDir, mockAgents);

		expect(status.turboStrategy).toBe('standard');
		expect(status.turboMode).toBe(true);

		const markdown = formatStatusMarkdown(status);
		expect(markdown).toContain('**Turbo**: standard');
	});

	// -------------------------------------------------------------------------
	// Test 3: Turbo lean — lean turbo active with phase, lanes, degraded tasks
	// -------------------------------------------------------------------------

	test('3. status shows Turbo: lean with phase, lanes, degraded when lean active', async () => {
		// Set up lean turbo session
		const session = swarmState.agentSessions.get(SESSION_ID)!;
		session.turboStrategy = 'lean';
		session.leanTurboActive = true;
		session.fullAutoMode = false;

		// Write lean turbo state
		const lanes: LeanTurboLane[] = [
			{
				laneId: 'lane-1',
				taskIds: ['1.1'],
				files: ['src/a.ts'],
				status: 'running',
				agent: 'mega_coder',
				sessionId: SESSION_ID,
			},
			{
				laneId: 'lane-2',
				taskIds: ['1.2'],
				files: ['src/b.ts'],
				status: 'completed',
				agent: 'mega_coder',
				sessionId: SESSION_ID,
			},
		];

		writeLeanTurboState(tempDir, SESSION_ID, 2, lanes, [
			{
				taskId: '1.1',
				reason: 'context_limit',
				files: ['src/a.ts'],
				requiredMode: 'standard',
			},
		]);

		_internals.hasActiveLeanTurbo = mock(() => true);
		_internals.hasActiveFullAuto = mock(() => false);

		const status = await getStatusData(tempDir, mockAgents);

		expect(status.turboStrategy).toBe('lean');
		expect(status.leanTurboPhase).toBe(2);
		expect(status.leanActiveLaneCount).toBe(1); // 1 running lane
		expect(status.leanCompletedLanes).toBe(1); // 1 completed lane
		expect(status.leanDegradedTasks).toBe(1);
		expect(status.leanDegradationSummary).toContain('1.1');
		expect(status.leanDegradationSummary).toContain('context_limit');

		const markdown = formatStatusMarkdown(status);
		expect(markdown).toContain('**Turbo**: lean');
		expect(markdown).toContain('Phase 2');
		expect(markdown).toContain('1/2 lanes active');
		expect(markdown).toContain('1 degraded');
	});

	// -------------------------------------------------------------------------
	// Test 4: Full-Auto + Lean Turbo — both active simultaneously
	// -------------------------------------------------------------------------

	test('4. status shows Full-Auto: active when both lean and full-auto active', async () => {
		// Set up lean turbo session with full-auto
		const session = swarmState.agentSessions.get(SESSION_ID)!;
		session.turboStrategy = 'lean';
		session.leanTurboActive = true;
		session.fullAutoMode = true;

		const lanes: LeanTurboLane[] = [
			{
				laneId: 'lane-1',
				taskIds: ['1.1'],
				files: ['src/a.ts'],
				status: 'running',
				agent: 'mega_coder',
				sessionId: SESSION_ID,
			},
		];

		writeLeanTurboState(tempDir, SESSION_ID, 1, lanes);

		_internals.hasActiveLeanTurbo = mock(() => true);
		_internals.hasActiveFullAuto = mock(() => true);

		const status = await getStatusData(tempDir, mockAgents);

		expect(status.turboStrategy).toBe('lean');
		expect(status.fullAutoActive).toBe(true);

		const markdown = formatStatusMarkdown(status);
		expect(markdown).toContain('**Turbo**: lean');
		expect(markdown).toContain('**Full-Auto**: active');
	});

	// -------------------------------------------------------------------------
	// Test 5: Lean Turbo paused — pause reason displayed
	// -------------------------------------------------------------------------

	test('5. status shows pause reason when lean is paused', async () => {
		// Set up paused lean turbo session
		const session = swarmState.agentSessions.get(SESSION_ID)!;
		session.turboStrategy = 'lean';
		session.leanTurboActive = true;
		session.fullAutoMode = false;

		const lanes: LeanTurboLane[] = [
			{
				laneId: 'lane-1',
				taskIds: ['1.1'],
				files: ['src/a.ts'],
				status: 'running',
				agent: 'mega_coder',
				sessionId: SESSION_ID,
			},
		];

		writeLeanTurboState(
			tempDir,
			SESSION_ID,
			1,
			lanes,
			[],
			'paused',
			'Waiting for resource',
		);

		_internals.hasActiveLeanTurbo = mock(() => true);
		_internals.hasActiveFullAuto = mock(() => false);

		const status = await getStatusData(tempDir, mockAgents);

		expect(status.turboStrategy).toBe('lean');
		expect(status.leanPauseReason).toBe('Waiting for resource');

		const markdown = formatStatusMarkdown(status);
		expect(markdown).toContain('**Turbo**: lean');
		expect(markdown).toContain('**Lean paused**: Waiting for resource');
	});

	// -------------------------------------------------------------------------
	// Test 6: All tasks degraded — degradation summary shown
	// -------------------------------------------------------------------------

	test('6. status shows degradation_summary when all tasks are degraded', async () => {
		// Set up lean turbo session where all tasks are degraded
		const session = swarmState.agentSessions.get(SESSION_ID)!;
		session.turboStrategy = 'lean';
		session.leanTurboActive = true;
		session.fullAutoMode = false;

		// Two lanes, both tasks degraded with distinct reasons
		const lanes: LeanTurboLane[] = [
			{
				laneId: 'lane-1',
				taskIds: ['1.1'],
				files: ['src/a.ts'],
				status: 'running',
				agent: 'mega_coder',
				sessionId: SESSION_ID,
			},
			{
				laneId: 'lane-2',
				taskIds: ['1.2'],
				files: ['src/b.ts'],
				status: 'running',
				agent: 'mega_coder',
				sessionId: SESSION_ID,
			},
		];

		writeLeanTurboState(tempDir, SESSION_ID, 2, lanes, [
			{
				taskId: '1.1',
				reason: 'context_limit',
				files: ['src/a.ts'],
				requiredMode: 'standard',
			},
			{
				taskId: '1.2',
				reason: 'timeout',
				files: ['src/b.ts'],
				requiredMode: 'balanced',
			},
		]);

		_internals.hasActiveLeanTurbo = mock(() => true);
		_internals.hasActiveFullAuto = mock(() => false);

		const status = await getStatusData(tempDir, mockAgents);

		expect(status.turboStrategy).toBe('lean');
		expect(status.leanDegradedTasks).toBe(2);
		expect(status.leanDegradationSummary).toBe(
			'1.1 (context_limit); 1.2 (timeout)',
		);

		const markdown = formatStatusMarkdown(status);
		expect(markdown).toContain('**Turbo**: lean');
		expect(markdown).toContain('2 degraded');
		expect(markdown).toContain('1.1 (context_limit)');
	});

	// -------------------------------------------------------------------------
	// Test 7: Standard turbo status unchanged when lean is not active
	// -------------------------------------------------------------------------

	test('7. standard turbo status is unchanged when lean is not active', async () => {
		// Set up standard turbo mode via turboMode flag (lean not active)
		const session = swarmState.agentSessions.get(SESSION_ID)!;
		session.turboMode = true;
		session.leanTurboActive = false;
		session.turboStrategy = undefined; // not lean

		_internals.hasActiveLeanTurbo = mock(() => false);
		_internals.hasActiveFullAuto = mock(() => false);

		const status = await getStatusData(tempDir, mockAgents);

		expect(status.turboStrategy).toBe('standard');
		expect(status.turboMode).toBe(true);
		expect(status.leanTurboPhase).toBeUndefined();
		expect(status.leanActiveLaneCount).toBeUndefined();
		expect(status.leanDegradedTasks).toBeUndefined();
		expect(status.fullAutoActive).toBeUndefined();

		const markdown = formatStatusMarkdown(status);
		expect(markdown).toContain('**Turbo**: standard');
		expect(markdown).not.toContain('**Full-Auto**:');
		expect(markdown).not.toContain('lanes active');
	});
});
