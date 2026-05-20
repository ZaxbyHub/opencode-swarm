import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
	LeanTurboLane,
	LeanTurboPersistedState,
} from '../../../../src/turbo/lean/state';
import {
	_internals,
	verifyLeanTurboTaskCompletion,
} from '../../../../src/turbo/lean/task-completion';

// Keep original so we can restore after each test
const _original = _internals.listActiveLocks;

function mkdtemp(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lean-turbo-test-'));
	// Seed .swarm dir so validateDirectory (if any) is happy
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	return dir;
}

function writeTurboState(dir: string, state: LeanTurboPersistedState): void {
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	fs.writeFileSync(
		path.join(dir, '.swarm', 'turbo-state.json'),
		JSON.stringify(state),
		'utf-8',
	);
}

function writePlanJson(
	dir: string,
	phases: Array<{
		tasks: Array<{ id: string; files_touched?: string[] }>;
	}>,
): void {
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	fs.writeFileSync(
		path.join(dir, '.swarm', 'plan.json'),
		JSON.stringify({ phases }),
		'utf-8',
	);
}

function writeLaneEvidence(
	dir: string,
	phase: number,
	laneId: string,
	content: object,
): void {
	const evidenceDir = path.join(
		dir,
		'.swarm',
		'evidence',
		String(phase),
		'lean-turbo',
	);
	fs.mkdirSync(evidenceDir, { recursive: true });
	fs.writeFileSync(
		path.join(evidenceDir, `${laneId}.json`),
		JSON.stringify(content),
		'utf-8',
	);
}

function makeLeanState(
	sessionID: string,
	lanes: LeanTurboLane[],
	degradedTasks: Array<{
		taskId: string;
		reason: string;
		files: string[];
		requiredMode: 'standard' | 'balanced';
	}> = [],
	phase = 1,
): LeanTurboPersistedState {
	return {
		version: 1,
		updatedAt: new Date().toISOString(),
		sessions: {
			[sessionID]: {
				status: 'running',
				sessionID,
				strategy: 'lean',
				phase,
				maxParallelCoders: 2,
				lanes,
				degradedTasks,
				counters: {
					lanesPlanned: 1,
					lanesStarted: 1,
					lanesCompleted: 0,
					lanesFailed: 0,
					tasksSerialized: 0,
					tasksDegraded: degradedTasks.length,
				},
			},
		},
	};
}

describe('verifyLeanTurboTaskCompletion', () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtemp();
		// Default: no active locks
		_internals.listActiveLocks = mock(() => []);
	});

	afterEach(() => {
		_internals.listActiveLocks = _original;
		// Clean up temp dir
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			// ignore
		}
	});

	// ── 1. turbo-state.json missing ─────────────────────────────────────────────
	test('no turbo-state.json → ok: false', () => {
		const result = verifyLeanTurboTaskCompletion(dir, 'task-1');
		expect(result.ok).toBe(false);
		expect(result.reason).toBe('Lean Turbo state file not found');
	});

	// ── 2. turbo-state.json unreadable / malformed ──────────────────────────────
	test('unreadable turbo-state.json → ok: false', () => {
		fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
		fs.writeFileSync(
			path.join(dir, '.swarm', 'turbo-state.json'),
			'{ broken json',
			'utf-8',
		);

		const result = verifyLeanTurboTaskCompletion(dir, 'task-1');
		expect(result.ok).toBe(false);
		expect(result.reason).toBe('Lean Turbo state file unreadable or malformed');
	});

	// ── 3. No lean strategy in state ───────────────────────────────────────────
	test('no lean strategy in state → ok: false', () => {
		writeTurboState(dir, {
			version: 1,
			updatedAt: new Date().toISOString(),
			sessions: {
				'session-1': {
					status: 'running',
					sessionID: 'session-1',
					strategy: 'full-auto', // not 'lean'
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
		});

		const result = verifyLeanTurboTaskCompletion(dir, 'task-1');
		expect(result.ok).toBe(false);
		expect(result.reason).toBe('No active Lean Turbo run state found');
	});

	// ── 4. Task not in any lane ───────────────────────────────────────────────
	test('task not in any lane → ok: false', () => {
		const state = makeLeanState('session-1', [
			{
				laneId: 'lane-1',
				taskIds: ['task-2', 'task-3'],
				files: [],
				status: 'completed',
			},
		]);
		writeTurboState(dir, state);

		const result = verifyLeanTurboTaskCompletion(dir, 'task-1');
		expect(result.ok).toBe(false);
		expect(result.reason).toBe('Task task-1 not found in any Lean Turbo lane');
	});

	// ── 5. Task is degraded ────────────────────────────────────────────────────
	test('task is degraded → ok: false', () => {
		const state = makeLeanState(
			'session-1',
			[
				{
					laneId: 'lane-1',
					taskIds: ['task-1', 'task-2'],
					files: [],
					status: 'completed',
				},
			],
			[
				{
					taskId: 'task-1',
					reason: 'Tier-3 file touched',
					files: [],
					requiredMode: 'standard',
				},
			],
		);
		writeTurboState(dir, state);

		const result = verifyLeanTurboTaskCompletion(dir, 'task-1');
		expect(result.ok).toBe(false);
		expect(result.reason).toContain('is degraded');
		expect(result.reason).toContain('Tier-3 file touched');
	});

	// ── 6. Lane not completed ─────────────────────────────────────────────────
	test('lane pending → ok: false', () => {
		const state = makeLeanState('session-1', [
			{
				laneId: 'lane-1',
				taskIds: ['task-1'],
				files: [],
				status: 'pending',
			},
		]);
		writeTurboState(dir, state);

		const result = verifyLeanTurboTaskCompletion(dir, 'task-1');
		expect(result.ok).toBe(false);
		expect(result.reason).toBe(
			'Lane lane-1 is not completed (status: pending)',
		);
		expect(result.evidence?.laneStatus).toBe('pending');
	});

	test('lane running → ok: false', () => {
		const state = makeLeanState('session-1', [
			{
				laneId: 'lane-1',
				taskIds: ['task-1'],
				files: [],
				status: 'running',
			},
		]);
		writeTurboState(dir, state);

		const result = verifyLeanTurboTaskCompletion(dir, 'task-1');
		expect(result.ok).toBe(false);
		expect(result.reason).toBe(
			'Lane lane-1 is not completed (status: running)',
		);
	});

	test('lane failed → ok: false', () => {
		const state = makeLeanState('session-1', [
			{
				laneId: 'lane-1',
				taskIds: ['task-1'],
				files: [],
				status: 'failed',
			},
		]);
		writeTurboState(dir, state);

		const result = verifyLeanTurboTaskCompletion(dir, 'task-1');
		expect(result.ok).toBe(false);
		expect(result.reason).toBe('Lane lane-1 is not completed (status: failed)');
	});

	test('lane blocked → ok: false', () => {
		const state = makeLeanState('session-1', [
			{
				laneId: 'lane-1',
				taskIds: ['task-1'],
				files: [],
				status: 'blocked',
			},
		]);
		writeTurboState(dir, state);

		const result = verifyLeanTurboTaskCompletion(dir, 'task-1');
		expect(result.ok).toBe(false);
		expect(result.reason).toBe(
			'Lane lane-1 is not completed (status: blocked)',
		);
	});

	// ── 7. Lane evidence missing ───────────────────────────────────────────────
	test('lane evidence missing → ok: false', () => {
		const state = makeLeanState('session-1', [
			{
				laneId: 'lane-1',
				taskIds: ['task-1'],
				files: [],
				status: 'completed',
			},
		]);
		writeTurboState(dir, state);
		// Intentionally do NOT write the evidence file

		const result = verifyLeanTurboTaskCompletion(dir, 'task-1');
		expect(result.ok).toBe(false);
		expect(result.reason).toContain('evidence file not found');
		expect(result.evidence?.laneId).toBe('lane-1');
	});

	// ── 8. Active locks for lane ───────────────────────────────────────────────
	test('active locks for lane → ok: false', () => {
		const state = makeLeanState('session-1', [
			{
				laneId: 'lane-1',
				taskIds: ['task-1'],
				files: [],
				status: 'completed',
			},
		]);
		writeTurboState(dir, state);
		writeLaneEvidence(dir, 1, 'lane-1', { laneId: 'lane-1' });

		// Inject mock: one active lock for this lane
		_internals.listActiveLocks = mock(() => [
			{
				filePath: 'src/foo.ts',
				agent: 'coder',
				taskId: 'task-1',
				timestamp: new Date().toISOString(),
				expiresAt: Date.now() + 300_000,
				laneId: 'lane-1',
			},
		]);

		const result = verifyLeanTurboTaskCompletion(dir, 'task-1');
		expect(result.ok).toBe(false);
		expect(result.reason).toContain('Active file locks exist for lane lane-1');
		expect(result.reason).toContain('src/foo.ts');
	});

	// ── 9. Tier-3 files touched ────────────────────────────────────────────────
	test('tier-3 files touched → ok: false', () => {
		const state = makeLeanState('session-1', [
			{
				laneId: 'lane-1',
				taskIds: ['task-1'],
				files: [],
				status: 'completed',
			},
		]);
		writeTurboState(dir, state);
		writeLaneEvidence(dir, 1, 'lane-1', { laneId: 'lane-1' });
		writePlanJson(dir, [
			{
				tasks: [{ id: 'task-1', files_touched: ['src/security/auth.ts'] }],
			},
		]);

		const result = verifyLeanTurboTaskCompletion(dir, 'task-1');
		expect(result.ok).toBe(false);
		expect(result.reason).toContain('Tier-3');
		expect(result.reason).toContain('cannot bypass Stage B');
	});

	// ── 10. All checks pass ───────────────────────────────────────────────────
	test('all checks pass → ok: true', () => {
		const state = makeLeanState('session-1', [
			{
				laneId: 'lane-1',
				taskIds: ['task-1'],
				files: [],
				status: 'completed',
			},
		]);
		writeTurboState(dir, state);
		writeLaneEvidence(dir, 1, 'lane-1', { laneId: 'lane-1' });
		writePlanJson(dir, [
			{
				tasks: [{ id: 'task-1', files_touched: ['src/utils/helper.ts'] }],
			},
		]);

		const result = verifyLeanTurboTaskCompletion(dir, 'task-1');
		expect(result.ok).toBe(true);
		expect(result.reason).toContain('task-1');
		expect(result.reason).toContain('lane-1');
		expect(result.evidence?.laneId).toBe('lane-1');
		expect(result.evidence?.laneStatus).toBe('completed');
	});

	// ── 11. plan.json unreadable → fail closed ────────────────────────────────
	test('plan.json unreadable → ok: false (fail-closed)', () => {
		const state = makeLeanState('session-1', [
			{
				laneId: 'lane-1',
				taskIds: ['task-1'],
				files: [],
				status: 'completed',
			},
		]);
		writeTurboState(dir, state);
		writeLaneEvidence(dir, 1, 'lane-1', { laneId: 'lane-1' });
		// Write a malformed plan.json
		fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
		fs.writeFileSync(path.join(dir, '.swarm', 'plan.json'), '{ bad', 'utf-8');

		const result = verifyLeanTurboTaskCompletion(dir, 'task-1');
		expect(result.ok).toBe(false);
		expect(result.reason).toContain('plan.json unreadable');
		expect(result.reason).toContain('Cannot verify Tier-3 patterns');
	});

	// ── 12. Session status !== 'running' is skipped ───────────────────────────
	test('session with status paused is skipped → ok: false', () => {
		writeTurboState(dir, {
			version: 1,
			updatedAt: new Date().toISOString(),
			sessions: {
				'session-1': {
					status: 'paused',
					sessionID: 'session-1',
					strategy: 'lean',
					phase: 1,
					maxParallelCoders: 2,
					lanes: [
						{
							laneId: 'lane-1',
							taskIds: ['task-1'],
							files: [],
							status: 'completed',
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
		});
		writeLaneEvidence(dir, 1, 'lane-1', { laneId: 'lane-1' });
		writePlanJson(dir, [
			{
				tasks: [{ id: 'task-1', files_touched: ['src/utils/helper.ts'] }],
			},
		]);

		const result = verifyLeanTurboTaskCompletion(dir, 'task-1');
		expect(result.ok).toBe(false);
		expect(result.reason).toBe('No active Lean Turbo run state found');
	});

	test('session with status terminated is skipped → ok: false', () => {
		writeTurboState(dir, {
			version: 1,
			updatedAt: new Date().toISOString(),
			sessions: {
				'session-1': {
					status: 'terminated',
					sessionID: 'session-1',
					strategy: 'lean',
					phase: 1,
					maxParallelCoders: 2,
					lanes: [
						{
							laneId: 'lane-1',
							taskIds: ['task-1'],
							files: [],
							status: 'completed',
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
		});
		writeLaneEvidence(dir, 1, 'lane-1', { laneId: 'lane-1' });
		writePlanJson(dir, [
			{
				tasks: [{ id: 'task-1', files_touched: ['src/utils/helper.ts'] }],
			},
		]);

		const result = verifyLeanTurboTaskCompletion(dir, 'task-1');
		expect(result.ok).toBe(false);
		expect(result.reason).toBe('No active Lean Turbo run state found');
	});

	test('session with status idle is skipped → ok: false', () => {
		writeTurboState(dir, {
			version: 1,
			updatedAt: new Date().toISOString(),
			sessions: {
				'session-1': {
					status: 'idle',
					sessionID: 'session-1',
					strategy: 'lean',
					phase: 1,
					maxParallelCoders: 2,
					lanes: [
						{
							laneId: 'lane-1',
							taskIds: ['task-1'],
							files: [],
							status: 'completed',
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
		});
		writeLaneEvidence(dir, 1, 'lane-1', { laneId: 'lane-1' });
		writePlanJson(dir, [
			{
				tasks: [{ id: 'task-1', files_touched: ['src/utils/helper.ts'] }],
			},
		]);

		const result = verifyLeanTurboTaskCompletion(dir, 'task-1');
		expect(result.ok).toBe(false);
		expect(result.reason).toBe('No active Lean Turbo run state found');
	});

	// ── 13. sessionID parameter prevents cross-session bypass ─────────────────
	test('when sessionID is provided, non-matching session is skipped → ok: false', () => {
		// Two sessions: session-1 (running) and session-2 (running)
		// When we look for session-X specifically, session-1 should be skipped
		writeTurboState(dir, {
			version: 1,
			updatedAt: new Date().toISOString(),
			sessions: {
				'session-1': {
					status: 'running',
					sessionID: 'session-1',
					strategy: 'lean',
					phase: 1,
					maxParallelCoders: 2,
					lanes: [
						{
							laneId: 'lane-1',
							taskIds: ['task-1'],
							files: [],
							status: 'completed',
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
				'session-2': {
					status: 'running',
					sessionID: 'session-2',
					strategy: 'lean',
					phase: 1,
					maxParallelCoders: 2,
					lanes: [
						{
							laneId: 'lane-2',
							taskIds: ['task-1'],
							files: [],
							status: 'completed',
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
		});
		writeLaneEvidence(dir, 1, 'lane-1', { laneId: 'lane-1' });
		writeLaneEvidence(dir, 1, 'lane-2', { laneId: 'lane-2' });
		writePlanJson(dir, [
			{
				tasks: [{ id: 'task-1', files_touched: ['src/utils/helper.ts'] }],
			},
		]);

		// Looking for session-X specifically — neither session-1 nor session-2 matches
		const result = verifyLeanTurboTaskCompletion(dir, 'task-1', 'session-X');
		expect(result.ok).toBe(false);
		expect(result.reason).toBe('No active Lean Turbo run state found');
	});

	test('when sessionID is provided, matching running session is used → ok: true', () => {
		// Two sessions: session-1 (running) and session-2 (running)
		// When we look for session-2 specifically, it should find session-2's lane
		writeTurboState(dir, {
			version: 1,
			updatedAt: new Date().toISOString(),
			sessions: {
				'session-1': {
					status: 'running',
					sessionID: 'session-1',
					strategy: 'lean',
					phase: 1,
					maxParallelCoders: 2,
					lanes: [
						{
							laneId: 'lane-1',
							taskIds: ['task-1'],
							files: [],
							status: 'completed',
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
				'session-2': {
					status: 'running',
					sessionID: 'session-2',
					strategy: 'lean',
					phase: 1,
					maxParallelCoders: 2,
					lanes: [
						{
							laneId: 'lane-2',
							taskIds: ['task-1'],
							files: [],
							status: 'completed',
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
		});
		writeLaneEvidence(dir, 1, 'lane-1', { laneId: 'lane-1' });
		writeLaneEvidence(dir, 1, 'lane-2', { laneId: 'lane-2' });
		writePlanJson(dir, [
			{
				tasks: [{ id: 'task-1', files_touched: ['src/utils/helper.ts'] }],
			},
		]);

		// Looking for session-2 specifically — should find session-2's lane
		const result = verifyLeanTurboTaskCompletion(dir, 'task-1', 'session-2');
		expect(result.ok).toBe(true);
		expect(result.evidence?.laneId).toBe('lane-2');
	});

	test('without sessionID, first running lean session is used (no session mismatch bypass)', () => {
		// Two sessions: session-1 (running) and session-2 (running)
		// Without sessionID filter, first running lean session is used
		writeTurboState(dir, {
			version: 1,
			updatedAt: new Date().toISOString(),
			sessions: {
				'session-1': {
					status: 'running',
					sessionID: 'session-1',
					strategy: 'lean',
					phase: 1,
					maxParallelCoders: 2,
					lanes: [
						{
							laneId: 'lane-1',
							taskIds: ['task-1'],
							files: [],
							status: 'completed',
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
				'session-2': {
					status: 'running',
					sessionID: 'session-2',
					strategy: 'lean',
					phase: 1,
					maxParallelCoders: 2,
					lanes: [
						{
							laneId: 'lane-2',
							taskIds: ['task-1'],
							files: [],
							status: 'completed',
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
		});
		writeLaneEvidence(dir, 1, 'lane-1', { laneId: 'lane-1' });
		writeLaneEvidence(dir, 1, 'lane-2', { laneId: 'lane-2' });
		writePlanJson(dir, [
			{
				tasks: [{ id: 'task-1', files_touched: ['src/utils/helper.ts'] }],
			},
		]);

		// Without sessionID, first running lean session (session-1) is used
		const result = verifyLeanTurboTaskCompletion(dir, 'task-1');
		expect(result.ok).toBe(true);
		expect(result.evidence?.laneId).toBe('lane-1');
	});

	test('sessionID filter combined with status === running check', () => {
		// session-1 is 'paused' (should be skipped), session-2 is 'running'
		// When looking for session-2 with session-2, it should find it
		writeTurboState(dir, {
			version: 1,
			updatedAt: new Date().toISOString(),
			sessions: {
				'session-1': {
					status: 'paused',
					sessionID: 'session-1',
					strategy: 'lean',
					phase: 1,
					maxParallelCoders: 2,
					lanes: [
						{
							laneId: 'lane-1',
							taskIds: ['task-1'],
							files: [],
							status: 'completed',
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
				'session-2': {
					status: 'running',
					sessionID: 'session-2',
					strategy: 'lean',
					phase: 1,
					maxParallelCoders: 2,
					lanes: [
						{
							laneId: 'lane-2',
							taskIds: ['task-1'],
							files: [],
							status: 'completed',
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
		});
		writeLaneEvidence(dir, 1, 'lane-2', { laneId: 'lane-2' });
		writePlanJson(dir, [
			{
				tasks: [{ id: 'task-1', files_touched: ['src/utils/helper.ts'] }],
			},
		]);

		// Looking for session-2 specifically — should skip paused session-1 and find running session-2
		const result = verifyLeanTurboTaskCompletion(dir, 'task-1', 'session-2');
		expect(result.ok).toBe(true);
		expect(result.evidence?.laneId).toBe('lane-2');
	});
});
