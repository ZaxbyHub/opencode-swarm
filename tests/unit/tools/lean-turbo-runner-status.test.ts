/**
 * Behavioral tests for the lean_turbo_runner_status tool (FR-009).
 *
 * Covers three observable outcomes:
 * 1. Active lanes listing (in-flight lanes reported correctly)
 * 2. Settled lanes listing (completed/failed lanes reported correctly)
 * 3. File-lock state reporting (which files are locked by which lanes)
 *
 * Tests call executeLeanTurboRunnerStatus directly against real state files,
 * exercising the full read path through loadLeanTurboRunState without mocks.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	executeLeanTurboRunnerStatus,
	type LeanTurboRunnerStatusArgs,
} from '../../../src/tools/lean-turbo-runner-status';
import {
	emptyRunState,
	saveLeanTurboRunState,
} from '../../../src/turbo/lean/state';

// ---------------------------------------------------------------------------
// Temp directory setup
// ---------------------------------------------------------------------------

let tmpDir: string;
let originalCwd: string;

function makeArgs(
	overrides: Partial<LeanTurboRunnerStatusArgs> = {},
): LeanTurboRunnerStatusArgs {
	return {
		directory: tmpDir,
		sessionID: 'test-session',
		...overrides,
	};
}

beforeEach(() => {
	tmpDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'lean-turbo-status-test-')),
	);
	originalCwd = process.cwd();
	fs.mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });
});

afterEach(() => {
	try {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		// best-effort
	}
	try {
		process.chdir(originalCwd);
	} catch {
		// ignore if already at original
	}
});

// ---------------------------------------------------------------------------
// Outcome 1: Active lanes listing (in-flight lanes reported correctly)
// ---------------------------------------------------------------------------

describe('1. active lanes listing (in-flight lanes)', () => {
	it('returns running lanes with correct status, laneId, taskIds, and files', async () => {
		const state = emptyRunState('test-session', 4);
		state.status = 'running';
		state.phase = 2;
		state.lanes = [
			{
				laneId: 'lane-1',
				taskIds: ['1.1', '1.2'],
				files: ['src/a.ts', 'src/b.ts'],
				status: 'running',
				startedAt: new Date().toISOString(),
				agent: 'coder',
				sessionId: 'test-session',
			},
			{
				laneId: 'lane-2',
				taskIds: ['1.3'],
				files: ['src/c.ts'],
				status: 'pending',
				agent: undefined,
			},
		];
		saveLeanTurboRunState(tmpDir, state);

		const result = await executeLeanTurboRunnerStatus(makeArgs());

		expect(result.success).toBe(true);
		expect(result.status).toBe('running');
		expect(result.phase).toBe(2);
		expect(result.maxParallelCoders).toBe(4);
		expect(result.sessionID).toBe('test-session');
		expect(result.strategy).toBe('lean');
		expect(result.lanes).toHaveLength(2);

		const [lane1, lane2] = result.lanes!;
		expect(lane1.laneId).toBe('lane-1');
		expect(lane1.status).toBe('running');
		expect(lane1.taskIds).toEqual(['1.1', '1.2']);
		expect(lane1.files).toEqual(['src/a.ts', 'src/b.ts']);
		expect(lane1.agent).toBe('coder');
		expect(lane1.startedAt).toBeDefined();

		expect(lane2.laneId).toBe('lane-2');
		expect(lane2.status).toBe('pending');
		expect(lane2.taskIds).toEqual(['1.3']);
		expect(lane2.files).toEqual(['src/c.ts']);
	});

	it('includes worktreePath and branchName for worktree-isolated lanes', async () => {
		const state = emptyRunState('test-session', 2);
		state.status = 'running';
		state.lanes = [
			{
				laneId: 'lane-wt',
				taskIds: ['3.1'],
				files: ['src/isolated.ts'],
				status: 'running',
				startedAt: new Date().toISOString(),
				agent: 'coder',
				sessionId: 'test-session',
				worktreePath: '/fake/worktree/lane-wt',
				branchName: 'swarm-lane/test-session/lane-wt',
			},
		];
		saveLeanTurboRunState(tmpDir, state);

		const result = await executeLeanTurboRunnerStatus(makeArgs());

		expect(result.success).toBe(true);
		expect(result.lanes![0].worktreePath).toBe('/fake/worktree/lane-wt');
		expect(result.lanes![0].branchName).toBe('swarm-lane/test-session/lane-wt');
	});

	it('returns all pending and running lanes without filtering settled ones', async () => {
		const state = emptyRunState('test-session', 3);
		state.status = 'running';
		state.lanes = [
			{
				laneId: 'lane-pending',
				taskIds: ['2.1'],
				files: ['src/pending.ts'],
				status: 'pending',
			},
			{
				laneId: 'lane-running',
				taskIds: ['2.2'],
				files: ['src/running.ts'],
				status: 'running',
				startedAt: new Date().toISOString(),
			},
		];
		saveLeanTurboRunState(tmpDir, state);

		const result = await executeLeanTurboRunnerStatus(makeArgs());

		expect(result.success).toBe(true);
		expect(result.lanes).toHaveLength(2);
		const statuses = result.lanes!.map((l) => l.status);
		expect(statuses).toContain('pending');
		expect(statuses).toContain('running');
	});

	it('includes degradedTasks in response', async () => {
		const state = emptyRunState('test-session', 4);
		state.status = 'running';
		state.phase = 1;
		state.degradedTasks = [
			{
				taskId: '5.1',
				reason: 'requires standard mode',
				files: ['src/std.ts'],
				requiredMode: 'standard',
			},
		];
		state.lanes = [];
		saveLeanTurboRunState(tmpDir, state);

		const result = await executeLeanTurboRunnerStatus(makeArgs());

		expect(result.success).toBe(true);
		expect(result.degradedTasks).toHaveLength(1);
		expect(result.degradedTasks![0].taskId).toBe('5.1');
		expect(result.degradedTasks![0].reason).toBe('requires standard mode');
		expect(result.degradedTasks![0].requiredMode).toBe('standard');
	});
});

// ---------------------------------------------------------------------------
// Outcome 2: Settled lanes listing (completed/failed lanes reported correctly)
// ---------------------------------------------------------------------------

describe('2. settled lanes listing (completed/failed lanes)', () => {
	it('reports completed lanes with completedAt timestamp', async () => {
		const completedAt = new Date().toISOString();
		const state = emptyRunState('test-session', 4);
		state.status = 'paused';
		state.phase = 3;
		state.lanes = [
			{
				laneId: 'lane-done',
				taskIds: ['1.1', '1.2'],
				files: ['src/done-a.ts', 'src/done-b.ts'],
				status: 'completed',
				startedAt: new Date(Date.now() - 60_000).toISOString(),
				completedAt,
				agent: 'coder',
				sessionId: 'test-session',
			},
		];
		saveLeanTurboRunState(tmpDir, state);

		const result = await executeLeanTurboRunnerStatus(makeArgs());

		expect(result.success).toBe(true);
		expect(result.status).toBe('paused');
		expect(result.lanes!).toHaveLength(1);
		const lane = result.lanes![0];
		expect(lane.laneId).toBe('lane-done');
		expect(lane.status).toBe('completed');
		expect(lane.completedAt).toBe(completedAt);
		expect(lane.taskIds).toEqual(['1.1', '1.2']);
		expect(lane.files).toEqual(['src/done-a.ts', 'src/done-b.ts']);
	});

	it('reports failed lanes with error message', async () => {
		const state = emptyRunState('test-session', 4);
		state.status = 'running';
		state.lanes = [
			{
				laneId: 'lane-fail',
				taskIds: ['4.1'],
				files: ['src/fail.ts'],
				status: 'failed',
				startedAt: new Date(Date.now() - 30_000).toISOString(),
				completedAt: new Date().toISOString(),
				error: 'merge conflict: src/fail.ts',
				agent: 'coder',
				sessionId: 'test-session',
			},
		];
		saveLeanTurboRunState(tmpDir, state);

		const result = await executeLeanTurboRunnerStatus(makeArgs());

		expect(result.success).toBe(true);
		const lane = result.lanes![0];
		expect(lane.laneId).toBe('lane-fail');
		expect(lane.status).toBe('failed');
		expect(lane.error).toBe('merge conflict: src/fail.ts');
	});

	it('reports blocked lanes', async () => {
		const state = emptyRunState('test-session', 4);
		state.status = 'running';
		state.lanes = [
			{
				laneId: 'lane-blocked',
				taskIds: ['6.1'],
				files: ['src/blocked.ts'],
				status: 'blocked',
			},
		];
		saveLeanTurboRunState(tmpDir, state);

		const result = await executeLeanTurboRunnerStatus(makeArgs());

		expect(result.success).toBe(true);
		expect(result.lanes![0].status).toBe('blocked');
	});

	it('mixed lane statuses are all reported', async () => {
		const state = emptyRunState('test-session', 4);
		state.status = 'running';
		state.lanes = [
			{
				laneId: 'l-pending',
				taskIds: ['p1'],
				files: ['p.ts'],
				status: 'pending',
			},
			{
				laneId: 'l-running',
				taskIds: ['r1'],
				files: ['r.ts'],
				status: 'running',
				startedAt: new Date().toISOString(),
			},
			{
				laneId: 'l-completed',
				taskIds: ['c1'],
				files: ['c.ts'],
				status: 'completed',
				completedAt: new Date().toISOString(),
			},
			{
				laneId: 'l-failed',
				taskIds: ['f1'],
				files: ['f.ts'],
				status: 'failed',
				error: 'died',
				completedAt: new Date().toISOString(),
			},
			{
				laneId: 'l-blocked',
				taskIds: ['b1'],
				files: ['b.ts'],
				status: 'blocked',
			},
		];
		saveLeanTurboRunState(tmpDir, state);

		const result = await executeLeanTurboRunnerStatus(makeArgs());

		expect(result.success).toBe(true);
		expect(result.lanes).toHaveLength(5);
		const byId = Object.fromEntries(result.lanes!.map((l) => [l.laneId, l]));
		expect(byId['l-pending'].status).toBe('pending');
		expect(byId['l-running'].status).toBe('running');
		expect(byId['l-completed'].status).toBe('completed');
		expect(byId['l-failed'].status).toBe('failed');
		expect(byId['l-failed'].error).toBe('died');
		expect(byId['l-blocked'].status).toBe('blocked');
	});

	it('idle status with empty lanes returns success with empty lanes array', async () => {
		const state = emptyRunState('test-session', 4);
		state.status = 'idle';
		state.lanes = [];
		saveLeanTurboRunState(tmpDir, state);

		const result = await executeLeanTurboRunnerStatus(makeArgs());

		expect(result.success).toBe(true);
		expect(result.status).toBe('idle');
		expect(result.lanes).toEqual([]);
		expect(result.phase).toBeUndefined();
	});

	it('terminated status does not surface terminateReason in tool result', async () => {
		const state = emptyRunState('test-session', 4);
		state.status = 'terminated';
		state.terminateReason = 'user requested termination';
		state.lanes = [];
		saveLeanTurboRunState(tmpDir, state);

		const result = await executeLeanTurboRunnerStatus(makeArgs());

		expect(result.success).toBe(true);
		expect(result.status).toBe('terminated');
		// terminateReason is in the raw state but not surfaced to the tool result;
		// the tool result shape only includes status, phase, lanes, degradedTasks, maxParallelCoders, sessionID, strategy
		// so we verify terminateReason is NOT in the result (not part of the exposed surface)
		expect(result['terminateReason']).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Outcome 3: File-lock state reporting (which files are locked by which lanes)
// ---------------------------------------------------------------------------

describe('3. file-lock state reporting (files per lane)', () => {
	it('each lane exposes its locked files via the files field', async () => {
		const state = emptyRunState('test-session', 4);
		state.status = 'running';
		state.lanes = [
			{
				laneId: 'lane-files-a',
				taskIds: ['1.1', '1.2'],
				files: ['src/utils.ts', 'src/helpers.ts'],
				status: 'running',
				startedAt: new Date().toISOString(),
				agent: 'coder',
				sessionId: 'test-session',
			},
		];
		saveLeanTurboRunState(tmpDir, state);

		const result = await executeLeanTurboRunnerStatus(makeArgs());

		expect(result.success).toBe(true);
		expect(result.lanes![0].files).toEqual(['src/utils.ts', 'src/helpers.ts']);
	});

	it('multiple lanes each report their own file set', async () => {
		const state = emptyRunState('test-session', 4);
		state.status = 'running';
		state.lanes = [
			{
				laneId: 'lane-multi-a',
				taskIds: ['2.1'],
				files: ['src/feature-a.ts', 'src/feature-a.test.ts'],
				status: 'running',
				startedAt: new Date().toISOString(),
				agent: 'coder',
				sessionId: 'test-session',
			},
			{
				laneId: 'lane-multi-b',
				taskIds: ['2.2'],
				files: ['src/feature-b.ts'],
				status: 'running',
				startedAt: new Date().toISOString(),
				agent: 'coder',
				sessionId: 'test-session',
			},
		];
		saveLeanTurboRunState(tmpDir, state);

		const result = await executeLeanTurboRunnerStatus(makeArgs());

		expect(result.success).toBe(true);
		const byId = Object.fromEntries(result.lanes!.map((l) => [l.laneId, l]));
		expect(byId['lane-multi-a'].files).toEqual([
			'src/feature-a.ts',
			'src/feature-a.test.ts',
		]);
		expect(byId['lane-multi-b'].files).toEqual(['src/feature-b.ts']);
	});

	it('files field is present and is an array for every lane status', async () => {
		const state = emptyRunState('test-session', 4);
		state.status = 'running';
		state.lanes = [
			{
				laneId: 'l-pending',
				taskIds: ['p1'],
				files: ['p.ts'],
				status: 'pending',
			},
			{
				laneId: 'l-running',
				taskIds: ['r1'],
				files: ['r.ts'],
				status: 'running',
				startedAt: new Date().toISOString(),
			},
			{
				laneId: 'l-completed',
				taskIds: ['c1'],
				files: ['c.ts'],
				status: 'completed',
				completedAt: new Date().toISOString(),
			},
			{
				laneId: 'l-failed',
				taskIds: ['f1'],
				files: ['f.ts'],
				status: 'failed',
				completedAt: new Date().toISOString(),
			},
			{
				laneId: 'l-blocked',
				taskIds: ['b1'],
				files: ['b.ts'],
				status: 'blocked',
			},
		];
		saveLeanTurboRunState(tmpDir, state);

		const result = await executeLeanTurboRunnerStatus(makeArgs());

		expect(result.success).toBe(true);
		for (const lane of result.lanes!) {
			expect(Array.isArray(lane.files)).toBe(true);
			expect(lane.files.length).toBeGreaterThan(0);
		}
	});
});

// ---------------------------------------------------------------------------
// Error / edge cases
// ---------------------------------------------------------------------------

describe('error and edge cases', () => {
	it('returns success:false when no state file exists for the session', async () => {
		// tmpDir/.swarm exists but has no turbo-state.json
		const result = await executeLeanTurboRunnerStatus(makeArgs());

		expect(result.success).toBe(false);
		expect(result.errors).toBeDefined();
		expect(result.errors!.length).toBeGreaterThan(0);
		expect(result.errors![0]).toContain('state');
	});

	it('returns success:false when a different sessionID has no state', async () => {
		const state = emptyRunState('other-session', 4);
		state.status = 'running';
		saveLeanTurboRunState(tmpDir, state);

		const result = await executeLeanTurboRunnerStatus(
			makeArgs({ sessionID: 'nonexistent-session' }),
		);

		expect(result.success).toBe(false);
		expect(result.errors).toBeDefined();
		expect(result.errors![0]).toContain('state');
	});

	it('respects the sessionID argument — does not leak between sessions', async () => {
		const stateA = emptyRunState('session-a', 2);
		stateA.status = 'running';
		stateA.lanes = [
			{
				laneId: 'lane-a',
				taskIds: ['a1'],
				files: ['a.ts'],
				status: 'running',
				startedAt: new Date().toISOString(),
			},
		];
		saveLeanTurboRunState(tmpDir, stateA);

		const stateB = emptyRunState('session-b', 4);
		stateB.status = 'running';
		stateB.lanes = [
			{
				laneId: 'lane-b',
				taskIds: ['b1'],
				files: ['b.ts'],
				status: 'running',
				startedAt: new Date().toISOString(),
			},
		];
		saveLeanTurboRunState(tmpDir, stateB);

		const resultA = await executeLeanTurboRunnerStatus(
			makeArgs({ sessionID: 'session-a' }),
		);
		const resultB = await executeLeanTurboRunnerStatus(
			makeArgs({ sessionID: 'session-b' }),
		);

		expect(resultA.success).toBe(true);
		expect(resultA.lanes).toHaveLength(1);
		expect(resultA.lanes![0].laneId).toBe('lane-a');

		expect(resultB.success).toBe(true);
		expect(resultB.lanes).toHaveLength(1);
		expect(resultB.lanes![0].laneId).toBe('lane-b');
	});

	it('surfaces corrupted state file as success:false with error message', async () => {
		const turboStatePath = path.join(tmpDir, '.swarm', 'turbo-state.json');
		fs.writeFileSync(turboStatePath, '{ invalid json }', 'utf-8');

		const result = await executeLeanTurboRunnerStatus(makeArgs());

		expect(result.success).toBe(false);
		expect(result.errors).toBeDefined();
		expect(result.errors!.length).toBeGreaterThan(0);
		expect(result.errors![0]).toContain('state');
	});

	it('surfaces version-mismatched state file as success:false', async () => {
		const turboStatePath = path.join(tmpDir, '.swarm', 'turbo-state.json');
		fs.writeFileSync(
			turboStatePath,
			JSON.stringify({ version: 99, sessions: {} }),
			'utf-8',
		);

		const result = await executeLeanTurboRunnerStatus(makeArgs());

		expect(result.success).toBe(false);
		expect(result.errors).toBeDefined();
	});
});
