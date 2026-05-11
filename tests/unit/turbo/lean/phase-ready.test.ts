import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_internals,
	verifyLeanTurboPhaseReady,
} from '../../../../src/turbo/lean/phase-ready';
import type {
	LeanTurboLane,
	LeanTurboPersistedState,
} from '../../../../src/turbo/lean/state';

// Keep originals so we can restore after each test
const _originalListActiveLocks = _internals.listActiveLocks;
const _originalReadPersisted = _internals.readPersisted;
const _originalReadPlanJson = _internals.readPlanJson;
const _originalListLaneEvidenceSync = _internals.listLaneEvidenceSync;

function mkdtemp(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lean-phase-ready-test-'));
	// Seed .swarm dir
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
	status: 'running' | 'paused' | 'idle' | 'terminated' = 'running',
	lastReviewerVerdict?: 'APPROVED' | 'NEEDS_REVISION' | 'REJECTED',
	lastCriticVerdict?: string,
): LeanTurboPersistedState {
	return {
		version: 1,
		updatedAt: new Date().toISOString(),
		sessions: {
			[sessionID]: {
				status,
				sessionID,
				strategy: 'lean',
				phase,
				maxParallelCoders: 2,
				lanes,
				degradedTasks,
				lastReviewerVerdict,
				lastCriticVerdict,
				counters: {
					lanesPlanned: lanes.length,
					lanesStarted: lanes.length,
					lanesCompleted: lanes.filter((l) => l.status === 'completed').length,
					lanesFailed: lanes.filter((l) => l.status === 'failed').length,
					tasksSerialized: 0,
					tasksDegraded: degradedTasks.length,
				},
			},
		},
	};
}

describe('verifyLeanTurboPhaseReady', () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtemp();
		// Use a direct file read for readPersisted mock to avoid the module-level
		// stateUnreadable flag pollution between tests. This reads the file directly
		// without going through the state module's flag.
		_internals.readPersisted = mock((d: string) => {
			const filePath = path.join(d, '.swarm', 'turbo-state.json');
			if (!fs.existsSync(filePath)) {
				return null;
			}
			try {
				const raw = fs.readFileSync(filePath, 'utf-8');
				return JSON.parse(raw) as LeanTurboPersistedState;
			} catch {
				return null;
			}
		});
		// Default: no active locks
		_internals.listActiveLocks = mock(() => []);
		// Default: real synchronous read of plan.json
		_internals.readPlanJson = mock((d: string) => {
			const planPath = path.join(d, '.swarm', 'plan.json');
			if (!fs.existsSync(planPath)) return null;
			try {
				const raw = fs.readFileSync(planPath, 'utf-8');
				return JSON.parse(raw);
			} catch {
				return null;
			}
		});
		// Default: return evidence for all lanes found in turbo-state.json
		_internals.listLaneEvidenceSync = mock((_d: string, _phase: number) => {
			const statePath = path.join(dir, '.swarm', 'turbo-state.json');
			if (!fs.existsSync(statePath)) return [];
			try {
				const raw = fs.readFileSync(statePath, 'utf-8');
				const state = JSON.parse(raw) as LeanTurboPersistedState;
				const session = Object.values(state.sessions)[0];
				if (!session?.lanes) return [];
				return session.lanes
					.filter(
						(l: { status: string }) =>
							l.status === 'completed' || l.status === 'failed',
					)
					.map((l: { laneId: string }) => l.laneId);
			} catch {
				return [];
			}
		});
	});

	afterEach(() => {
		_internals.listActiveLocks = _originalListActiveLocks;
		_internals.readPersisted = _originalReadPersisted;
		_internals.readPlanJson = _originalReadPlanJson;
		_internals.listLaneEvidenceSync = _originalListLaneEvidenceSync;
		// Clean up temp dir
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			// ignore
		}
	});

	// ── 1. All lanes completed, no locks, no degraded tasks → passes ───────
	test('all lanes completed, no locks, no degraded tasks → ok: true', () => {
		const state = makeLeanState(
			'test-session',
			[
				{
					laneId: 'lane-1',
					taskIds: ['task-1', 'task-2'],
					files: [],
					status: 'completed',
				},
				{
					laneId: 'lane-2',
					taskIds: ['task-3'],
					files: [],
					status: 'completed',
				},
			],
			[],
			1,
			'running',
			'APPROVED',
			'APPROVED',
		);
		writeTurboState(dir, state);

		const result = verifyLeanTurboPhaseReady(dir, 1, 'test-session');
		expect(result.ok).toBe(true);
		expect(result.reason).toBe('Phase 1 is ready to advance');
		expect(result.evidence?.lanes).toEqual(['lane-1', 'lane-2']);
		expect(result.evidence?.degradedTasks).toEqual([]);
	});

	// ── 2. State unreadable → blocks ─────────────────────────────────────────
	test('no turbo-state.json → ok: false', () => {
		// Intentionally do NOT write turbo-state.json

		const result = verifyLeanTurboPhaseReady(dir, 1, 'test-session');
		expect(result.ok).toBe(false);
		expect(result.reason).toBe('Lean Turbo state unreadable or missing');
	});

	test('malformed turbo-state.json → ok: false', () => {
		fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
		fs.writeFileSync(
			path.join(dir, '.swarm', 'turbo-state.json'),
			'{ broken json',
			'utf-8',
		);

		const result = verifyLeanTurboPhaseReady(dir, 1, 'test-session');
		expect(result.ok).toBe(false);
		expect(result.reason).toBe('Lean Turbo state unreadable or missing');
	});

	// ── 3. No active session for phase → blocks ──────────────────────────────
	test('no running session for phase → ok: false', () => {
		const state = makeLeanState('test-session', [], [], 1, 'paused');
		writeTurboState(dir, state);

		const result = verifyLeanTurboPhaseReady(dir, 1, 'test-session');
		expect(result.ok).toBe(false);
		expect(result.reason).toBe(
			'No active Lean Turbo session for phase 1 and session test-session',
		);
	});

	test('running session for different phase → ok: false', () => {
		const state = makeLeanState('test-session', [], [], 2, 'running');
		writeTurboState(dir, state);

		const result = verifyLeanTurboPhaseReady(dir, 1, 'test-session');
		expect(result.ok).toBe(false);
		expect(result.reason).toBe(
			'No active Lean Turbo session for phase 1 and session test-session',
		);
	});

	test('running session for phase but wrong strategy → ok: false', () => {
		const state: LeanTurboPersistedState = {
			version: 1,
			updatedAt: new Date().toISOString(),
			sessions: {
				'test-session': {
					status: 'running',
					sessionID: 'test-session',
					strategy: 'full-auto', // not 'lean'
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
		writeTurboState(dir, state);

		const result = verifyLeanTurboPhaseReady(dir, 1, 'test-session');
		expect(result.ok).toBe(false);
		expect(result.reason).toBe(
			'No active Lean Turbo session for phase 1 and session test-session',
		);
	});

	// ── 4. Empty lane plan → blocks ──────────────────────────────────────────
	test('empty lane plan → ok: false', () => {
		const state = makeLeanState('test-session', [], [], 1, 'running');
		writeTurboState(dir, state);

		const result = verifyLeanTurboPhaseReady(dir, 1, 'test-session');
		expect(result.ok).toBe(false);
		expect(result.reason).toBe(
			'No lane plan or fallback tasks found for phase 1',
		);
	});

	// ── 5. Lane not completed (status: running) → blocks ────────────────────
	test('lane running → ok: false', () => {
		const state = makeLeanState(
			'test-session',
			[
				{
					laneId: 'lane-1',
					taskIds: ['task-1'],
					files: [],
					status: 'running',
				},
			],
			[],
			1,
			'running',
		);
		writeTurboState(dir, state);

		const result = verifyLeanTurboPhaseReady(dir, 1, 'test-session');
		expect(result.ok).toBe(false);
		expect(result.reason).toBe(
			'Lane lane-1 is not completed (status: running)',
		);
	});

	test('lane pending → ok: false', () => {
		const state = makeLeanState(
			'test-session',
			[
				{
					laneId: 'lane-1',
					taskIds: ['task-1'],
					files: [],
					status: 'pending',
				},
			],
			[],
			1,
			'running',
		);
		writeTurboState(dir, state);

		const result = verifyLeanTurboPhaseReady(dir, 1, 'test-session');
		expect(result.ok).toBe(false);
		expect(result.reason).toBe(
			'Lane lane-1 is not completed (status: pending)',
		);
	});

	// ── 5b. Failed lane status is treated as completed ───────────────────────
	test('lane failed → treated as completed (ok: true when all lanes failed/completed)', () => {
		const state = makeLeanState(
			'test-session',
			[
				{
					laneId: 'lane-1',
					taskIds: ['task-1'],
					files: [],
					status: 'failed',
				},
			],
			[],
			1,
			'running',
			'APPROVED',
			'APPROVED',
		);
		writeTurboState(dir, state);

		const result = verifyLeanTurboPhaseReady(dir, 1, 'test-session');
		expect(result.ok).toBe(true);
		expect(result.evidence?.lanes).toEqual(['lane-1']);
	});

	// ── 6. Active locks remain → blocks ─────────────────────────────────────
	test('active locks for phase lane → ok: false', () => {
		const state = makeLeanState(
			'test-session',
			[
				{
					laneId: 'lane-1',
					taskIds: ['task-1'],
					files: [],
					status: 'completed',
				},
			],
			[],
			1,
			'running',
		);
		writeTurboState(dir, state);

		// Inject mock: one active lock for lane-1
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

		const result = verifyLeanTurboPhaseReady(dir, 1, 'test-session');
		expect(result.ok).toBe(false);
		expect(result.reason).toBe('Active locks remain for lane lane-1');
	});

	test('active lock for different phase lane → ok: true (not blocking)', () => {
		const state = makeLeanState(
			'test-session',
			[
				{
					laneId: 'lane-1',
					taskIds: ['task-1'],
					files: [],
					status: 'completed',
				},
			],
			[],
			1,
			'running',
			'APPROVED',
			'APPROVED',
		);
		writeTurboState(dir, state);

		// Inject mock: active lock for lane-2 (not in phase 1)
		_internals.listActiveLocks = mock(() => [
			{
				filePath: 'src/bar.ts',
				agent: 'coder',
				taskId: 'task-2',
				timestamp: new Date().toISOString(),
				expiresAt: Date.now() + 300_000,
				laneId: 'lane-2',
			},
		]);

		const result = verifyLeanTurboPhaseReady(dir, 1, 'test-session');
		expect(result.ok).toBe(true);
	});

	// ── 7. Degraded task in lane plan → handled by lane completion check ─────
	test('degraded task in lane plan but lane completed → ok: true (covered by lane check)', () => {
		const state = makeLeanState(
			'test-session',
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
					taskId: 'task-2',
					reason: 'global file conflict',
					files: ['package.json'],
					requiredMode: 'standard',
				},
			],
			1,
			'running',
			'APPROVED',
			'APPROVED',
		);
		writeTurboState(dir, state);

		const result = verifyLeanTurboPhaseReady(dir, 1, 'test-session');
		// Degraded task was in lane plan and lane is completed → considered handled
		expect(result.ok).toBe(true);
	});

	// ── 7b. Degraded task NOT in lane plan: must be completed via standard flow ─
	test('degraded task not in lane plan but completed in plan.json → ok: true', () => {
		const state = makeLeanState(
			'test-session',
			[
				{
					laneId: 'lane-1',
					taskIds: ['task-1'],
					files: [],
					status: 'completed',
				},
			],
			[
				{
					taskId: 'task-9', // NOT in lane plan
					reason: 'global file conflict',
					files: ['package.json'],
					requiredMode: 'standard',
				},
			],
			1,
			'running',
			'APPROVED',
			'APPROVED',
		);
		writeTurboState(dir, state);
		// Mock plan.json: task-9 is completed in phase 1
		_internals.readPlanJson = mock(() => ({
			phases: [{ id: 1, tasks: [{ id: 'task-9', status: 'completed' }] }],
		}));

		const result = verifyLeanTurboPhaseReady(dir, 1, 'test-session');
		expect(result.ok).toBe(true);
	});

	test('degraded task not in lane plan and not completed in plan.json → ok: false', () => {
		const state = makeLeanState(
			'test-session',
			[
				{
					laneId: 'lane-1',
					taskIds: ['task-1'],
					files: [],
					status: 'completed',
				},
			],
			[
				{
					taskId: 'task-9', // NOT in lane plan
					reason: 'global file conflict',
					files: ['package.json'],
					requiredMode: 'standard',
				},
			],
			1,
			'running',
			'APPROVED',
			'APPROVED',
		);
		writeTurboState(dir, state);
		// Mock plan.json: task-9 is still pending
		_internals.readPlanJson = mock(() => ({
			phases: [{ id: 1, tasks: [{ id: 'task-9', status: 'in_progress' }] }],
		}));

		const result = verifyLeanTurboPhaseReady(dir, 1, 'test-session');
		expect(result.ok).toBe(false);
		expect(result.reason).toBe(
			'Degraded task task-9 not yet completed via standard flow',
		);
	});

	test('degraded task not in lane plan and plan.json unreadable → ok: false (fail-closed)', () => {
		const state = makeLeanState(
			'test-session',
			[
				{
					laneId: 'lane-1',
					taskIds: ['task-1'],
					files: [],
					status: 'completed',
				},
			],
			[
				{
					taskId: 'task-9', // NOT in lane plan
					reason: 'global file conflict',
					files: ['package.json'],
					requiredMode: 'standard',
				},
			],
			1,
			'running',
			'APPROVED',
			'APPROVED',
		);
		writeTurboState(dir, state);
		// Mock plan.json as unreadable
		_internals.readPlanJson = mock(() => null);

		const result = verifyLeanTurboPhaseReady(dir, 1, 'test-session');
		expect(result.ok).toBe(false);
		expect(result.reason).toBe(
			'Cannot verify degraded task status: plan.json unreadable or malformed',
		);
	});

	// ── 7c. plan.json shape validation — malformed JSON that parses but has wrong shape ─
	test('readPlanJson returns {} (empty object) → blocks with malformed reason', () => {
		const state = makeLeanState(
			'test-session',
			[
				{
					laneId: 'lane-1',
					taskIds: ['task-1'],
					files: [],
					status: 'completed',
				},
			],
			[
				{
					taskId: 'task-9',
					reason: 'global file conflict',
					files: ['package.json'],
					requiredMode: 'standard',
				},
			],
			1,
			'running',
			'APPROVED',
			'APPROVED',
		);
		writeTurboState(dir, state);
		// Mock plan.json as parseable but malformed (no phases array)
		_internals.readPlanJson = mock(() => ({}));

		const result = verifyLeanTurboPhaseReady(dir, 1, 'test-session');
		expect(result.ok).toBe(false);
		expect(result.reason).toBe(
			'Cannot verify degraded task task-9: plan.json malformed (phases is not an array)',
		);
	});

	test('readPlanJson returns {phases: null} → blocks with malformed reason', () => {
		const state = makeLeanState(
			'test-session',
			[
				{
					laneId: 'lane-1',
					taskIds: ['task-1'],
					files: [],
					status: 'completed',
				},
			],
			[
				{
					taskId: 'task-9',
					reason: 'global file conflict',
					files: ['package.json'],
					requiredMode: 'standard',
				},
			],
			1,
			'running',
			'APPROVED',
			'APPROVED',
		);
		writeTurboState(dir, state);
		// Mock plan.json as parseable but phases is null
		_internals.readPlanJson = mock(() => ({ phases: null }));

		const result = verifyLeanTurboPhaseReady(dir, 1, 'test-session');
		expect(result.ok).toBe(false);
		expect(result.reason).toBe(
			'Cannot verify degraded task task-9: plan.json malformed (phases is not an array)',
		);
	});

	test('readPlanJson returns {phases: [{id: 1, tasks: null}]} → blocks with malformed reason', () => {
		const state = makeLeanState(
			'test-session',
			[
				{
					laneId: 'lane-1',
					taskIds: ['task-1'],
					files: [],
					status: 'completed',
				},
			],
			[
				{
					taskId: 'task-9',
					reason: 'global file conflict',
					files: ['package.json'],
					requiredMode: 'standard',
				},
			],
			1,
			'running',
			'APPROVED',
			'APPROVED',
		);
		writeTurboState(dir, state);
		// Mock plan.json with phase found but phase.tasks is null
		_internals.readPlanJson = mock(() => ({
			phases: [{ id: 1, tasks: null }],
		}));

		const result = verifyLeanTurboPhaseReady(dir, 1, 'test-session');
		expect(result.ok).toBe(false);
		expect(result.reason).toBe(
			'Cannot verify degraded task task-9: plan.json malformed (phase 1 tasks is not an array)',
		);
	});

	test('readPlanJson returns {phases: [{id: 1, tasks: [{id: "1.1"}]}]} (task missing status field) → blocks with not completed reason', () => {
		const state = makeLeanState(
			'test-session',
			[
				{
					laneId: 'lane-1',
					taskIds: ['task-1'],
					files: [],
					status: 'completed',
				},
			],
			[
				{
					taskId: 'task-9',
					reason: 'global file conflict',
					files: ['package.json'],
					requiredMode: 'standard',
				},
			],
			1,
			'running',
			'APPROVED',
			'APPROVED',
		);
		writeTurboState(dir, state);
		// Mock plan.json: task exists but has no status field
		_internals.readPlanJson = mock(() => ({
			phases: [{ id: 1, tasks: [{ id: 'task-9' }] }],
		}));

		const result = verifyLeanTurboPhaseReady(dir, 1, 'test-session');
		expect(result.ok).toBe(false);
		expect(result.reason).toBe(
			'Degraded task task-9 not yet completed via standard flow',
		);
	});

	// ── 8. Missing reviewer approval (when required) → blocks ─────────────────
	test('missing reviewer approval when required → ok: false', () => {
		const state = makeLeanState(
			'test-session',
			[
				{
					laneId: 'lane-1',
					taskIds: ['task-1'],
					files: [],
					status: 'completed',
				},
			],
			[],
			1,
			'running',
			undefined, // no reviewer verdict
			'APPROVED',
		);
		writeTurboState(dir, state);

		const result = verifyLeanTurboPhaseReady(dir, 1, 'test-session');
		expect(result.ok).toBe(false);
		expect(result.reason).toBe(
			'Integrated reviewer approval missing or rejected',
		);
	});

	test('reviewer verdict NEEDS_REVISION when required → ok: false', () => {
		const state = makeLeanState(
			'test-session',
			[
				{
					laneId: 'lane-1',
					taskIds: ['task-1'],
					files: [],
					status: 'completed',
				},
			],
			[],
			1,
			'running',
			'NEEDS_REVISION',
			'APPROVED',
		);
		writeTurboState(dir, state);

		const result = verifyLeanTurboPhaseReady(dir, 1, 'test-session');
		expect(result.ok).toBe(false);
		expect(result.reason).toBe(
			'Integrated reviewer approval missing or rejected',
		);
	});

	// ── 9. Missing critic approval (when required) → blocks ──────────────────
	test('missing critic approval when required → ok: false', () => {
		const state = makeLeanState(
			'test-session',
			[
				{
					laneId: 'lane-1',
					taskIds: ['task-1'],
					files: [],
					status: 'completed',
				},
			],
			[],
			1,
			'running',
			'APPROVED',
			undefined, // no critic verdict
		);
		writeTurboState(dir, state);

		const result = verifyLeanTurboPhaseReady(dir, 1, 'test-session');
		expect(result.ok).toBe(false);
		expect(result.reason).toBe(
			'Integrated critic approval missing or rejected',
		);
	});

	test('critic verdict not APPROVED when required → ok: false', () => {
		const state = makeLeanState(
			'test-session',
			[
				{
					laneId: 'lane-1',
					taskIds: ['task-1'],
					files: [],
					status: 'completed',
				},
			],
			[],
			1,
			'running',
			'APPROVED',
			'NEEDS_REVISION',
		);
		writeTurboState(dir, state);

		const result = verifyLeanTurboPhaseReady(dir, 1, 'test-session');
		expect(result.ok).toBe(false);
		expect(result.reason).toBe(
			'Integrated critic approval missing or rejected',
		);
	});

	// ── 10. Reviewer/critic not required when config disables them → passes ──
	test('reviewer not required when config disables it → ok: true without reviewer verdict', () => {
		const state = makeLeanState(
			'test-session',
			[
				{
					laneId: 'lane-1',
					taskIds: ['task-1'],
					files: [],
					status: 'completed',
				},
			],
			[],
			1,
			'running',
			undefined,
			'APPROVED',
		);
		writeTurboState(dir, state);

		const result = verifyLeanTurboPhaseReady(dir, 1, 'test-session', {
			phase_reviewer: false,
			phase_critic: true,
		});
		expect(result.ok).toBe(true);
		expect(result.evidence?.reviewerVerdict).toBeUndefined();
	});

	test('critic not required when config disables it → ok: true without critic verdict', () => {
		const state = makeLeanState(
			'test-session',
			[
				{
					laneId: 'lane-1',
					taskIds: ['task-1'],
					files: [],
					status: 'completed',
				},
			],
			[],
			1,
			'running',
			'APPROVED',
			undefined,
		);
		writeTurboState(dir, state);

		const result = verifyLeanTurboPhaseReady(dir, 1, 'test-session', {
			phase_reviewer: true,
			phase_critic: false,
		});
		expect(result.ok).toBe(true);
		expect(result.evidence?.criticVerdict).toBeUndefined();
	});

	test('both reviewer and critic disabled → ok: true without any verdicts', () => {
		const state = makeLeanState(
			'test-session',
			[
				{
					laneId: 'lane-1',
					taskIds: ['task-1'],
					files: [],
					status: 'completed',
				},
			],
			[],
			1,
			'running',
			undefined,
			undefined,
		);
		writeTurboState(dir, state);

		const result = verifyLeanTurboPhaseReady(dir, 1, 'test-session', {
			phase_reviewer: false,
			phase_critic: false,
		});
		expect(result.ok).toBe(true);
	});

	// ── 11. Failed lane treated as completed (not blocking) ───────────────────
	test('mixed completed and failed lanes → ok: true', () => {
		const state = makeLeanState(
			'test-session',
			[
				{
					laneId: 'lane-1',
					taskIds: ['task-1'],
					files: [],
					status: 'completed',
				},
				{
					laneId: 'lane-2',
					taskIds: ['task-2'],
					files: [],
					status: 'failed',
				},
			],
			[],
			1,
			'running',
			'APPROVED',
			'APPROVED',
		);
		writeTurboState(dir, state);

		const result = verifyLeanTurboPhaseReady(dir, 1, 'test-session');
		expect(result.ok).toBe(true);
		expect(result.evidence?.lanes).toEqual(['lane-1', 'lane-2']);
	});

	// ── 12. Shape validation: missing lanes array → blocks gracefully ─────────
	test('sessions.sessions is not an object → ok: false', () => {
		writeTurboState(dir, {
			version: 1,
			updatedAt: new Date().toISOString(),
			// @ts-expect-error — intentionally invalid shape for test
			sessions: 'not-an-object',
		});

		const result = verifyLeanTurboPhaseReady(dir, 1, 'test-session');
		expect(result.ok).toBe(false);
		expect(result.reason).toBe('Lean Turbo state unreadable or missing');
	});

	test('sessions.sessions is an array → ok: false', () => {
		writeTurboState(dir, {
			version: 1,
			updatedAt: new Date().toISOString(),
			// @ts-expect-error — intentionally invalid shape for test
			sessions: [],
		});

		const result = verifyLeanTurboPhaseReady(dir, 1, 'test-session');
		expect(result.ok).toBe(false);
		expect(result.reason).toBe('Lean Turbo state unreadable or missing');
	});

	test('lane.laneId is not a string → ok: false', () => {
		const state: LeanTurboPersistedState = {
			version: 1,
			updatedAt: new Date().toISOString(),
			sessions: {
				'test-session': {
					status: 'running',
					sessionID: 'test-session',
					strategy: 'lean',
					phase: 1,
					maxParallelCoders: 2,
					lanes: [
						// @ts-expect-error — intentionally invalid shape for test
						{ laneId: 123, status: 'completed' },
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
		writeTurboState(dir, state);

		const result = verifyLeanTurboPhaseReady(dir, 1, 'test-session');
		expect(result.ok).toBe(false);
	});

	test('degradedTask.taskId is not a string → ok: false', () => {
		const state: LeanTurboPersistedState = {
			version: 1,
			updatedAt: new Date().toISOString(),
			sessions: {
				'test-session': {
					status: 'running',
					sessionID: 'test-session',
					strategy: 'lean',
					phase: 1,
					maxParallelCoders: 2,
					lanes: [],
					// @ts-expect-error — intentionally invalid shape for test
					degradedTasks: [
						{
							taskId: 123,
							reason: 'test',
							files: [],
							requiredMode: 'standard',
						},
					],
					counters: {
						lanesPlanned: 0,
						lanesStarted: 0,
						lanesCompleted: 0,
						lanesFailed: 0,
						tasksSerialized: 0,
						tasksDegraded: 1,
					},
				},
			},
		};
		writeTurboState(dir, state);

		const result = verifyLeanTurboPhaseReady(dir, 1, 'test-session');
		expect(result.ok).toBe(false);
	});

	// ── 6b. Defensive branches: planPhase / task not found ──────────────────
	test('degraded task not in lane plan and phase not found in plan.json → ok: false', () => {
		const state = makeLeanState(
			'test-session',
			[
				{
					laneId: 'lane-1',
					taskIds: ['task-1'],
					files: [],
					status: 'completed',
				},
			],
			[
				{
					taskId: 'task-9', // NOT in lane plan
					reason: 'global file conflict',
					files: ['package.json'],
					requiredMode: 'standard',
				},
			],
			1,
			'running',
			'APPROVED',
			'APPROVED',
		);
		writeTurboState(dir, state);
		// Mock plan.json: phase 1 does not exist
		_internals.readPlanJson = mock(() => ({
			phases: [{ id: 99, tasks: [{ id: 'task-9', status: 'completed' }] }],
		}));

		const result = verifyLeanTurboPhaseReady(dir, 1, 'test-session');
		expect(result.ok).toBe(false);
		expect(result.reason).toBe(
			'Cannot verify degraded task task-9: phase 1 not found in plan.json',
		);
	});

	test('degraded task not in lane plan and task not found in plan phase → ok: false', () => {
		const state = makeLeanState(
			'test-session',
			[
				{
					laneId: 'lane-1',
					taskIds: ['task-1'],
					files: [],
					status: 'completed',
				},
			],
			[
				{
					taskId: 'task-9', // NOT in lane plan
					reason: 'global file conflict',
					files: ['package.json'],
					requiredMode: 'standard',
				},
			],
			1,
			'running',
			'APPROVED',
			'APPROVED',
		);
		writeTurboState(dir, state);
		// Mock plan.json: phase 1 exists but task-9 is not in its task list
		_internals.readPlanJson = mock(() => ({
			phases: [{ id: 1, tasks: [{ id: 'task-X', status: 'completed' }] }],
		}));

		const result = verifyLeanTurboPhaseReady(dir, 1, 'test-session');
		expect(result.ok).toBe(false);
		expect(result.reason).toBe('Degraded task task-9 not found in plan');
	});

	// ── 13. Backward compatibility: legacy calling convention (config as 3rd arg) ──
	test('legacy calling convention: config as 3rd arg (no sessionID) → works correctly', () => {
		const state = makeLeanState(
			'test-session',
			[
				{
					laneId: 'lane-1',
					taskIds: ['task-1', 'task-2'],
					files: [],
					status: 'completed',
				},
				{
					laneId: 'lane-2',
					taskIds: ['task-3'],
					files: [],
					status: 'completed',
				},
			],
			[],
			1,
			'running',
			'APPROVED',
			'APPROVED',
		);
		writeTurboState(dir, state);

		// Legacy calling convention: config as 3rd arg (no sessionID)
		// This should find the first matching session (since no sessionID provided)
		const result = verifyLeanTurboPhaseReady(dir, 1, {
			phase_reviewer: true,
			phase_critic: true,
		});
		expect(result.ok).toBe(true);
		expect(result.reason).toBe('Phase 1 is ready to advance');
		expect(result.evidence?.lanes).toEqual(['lane-1', 'lane-2']);
	});

	test('legacy calling convention: phase_reviewer disabled via config → reviewer check skipped', () => {
		const state = makeLeanState(
			'test-session',
			[
				{
					laneId: 'lane-1',
					taskIds: ['task-1'],
					files: [],
					status: 'completed',
				},
			],
			[],
			1,
			'running',
			undefined, // no reviewer verdict
			'APPROVED',
		);
		writeTurboState(dir, state);

		// Legacy calling convention: config as 3rd arg disables reviewer check
		const result = verifyLeanTurboPhaseReady(dir, 1, {
			phase_reviewer: false,
			phase_critic: true,
		});
		expect(result.ok).toBe(true);
		expect(result.evidence?.reviewerVerdict).toBeUndefined();
	});

	test('new calling convention: sessionID as 3rd arg + config as 4th → both applied correctly', () => {
		const state = makeLeanState(
			'test-session',
			[
				{
					laneId: 'lane-1',
					taskIds: ['task-1'],
					files: [],
					status: 'completed',
				},
			],
			[],
			1,
			'running',
			'APPROVED',
			'APPROVED',
		);
		writeTurboState(dir, state);

		// New calling convention: sessionID as 3rd arg, config as 4th
		// Config disables reviewer/critic checks - function should still succeed even without verdicts
		const state2: LeanTurboPersistedState = {
			...state,
			sessions: {
				'test-session': {
					...state.sessions['test-session'],
					lastReviewerVerdict: undefined,
					lastCriticVerdict: undefined,
				},
			},
		};
		writeTurboState(dir, state2);

		const result = verifyLeanTurboPhaseReady(dir, 1, 'test-session', {
			phase_reviewer: false,
			phase_critic: false,
		});
		expect(result.ok).toBe(true);
		expect(result.evidence?.reviewerVerdict).toBeUndefined();
		expect(result.evidence?.criticVerdict).toBeUndefined();
	});
});
