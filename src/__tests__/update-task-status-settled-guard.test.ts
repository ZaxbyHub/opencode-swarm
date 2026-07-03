/**
 * Tests for the FR-005 settled-task guard across three entry points:
 *  1. advanceTaskStateAndPersist preflight  (src/state.ts)
 *  2. executeUpdateTaskStatus tool guard     (src/tools/update-task-status.ts)
 *
 * Mock strategy:
 *  - advanceTaskStateAndPersist tests: mock.module('src/plan/manager.js')
 *    to intercept isTaskSettled and updateTaskStatus. Uses startAgentSession()
 *    to create proper AgentSessionState objects. Bun's per-file isolation
 *    (--smol) prevents cross-file mock contamination.
 *  - executeUpdateTaskStatus tests: mock the existing _internals seam
 *    (utsInternals.tryAcquireLock, utsInternals.updateTaskStatus) with per-test
 *    save/restore.
 *
 * Mock coverage gaps (per writing-tests "Mock Coverage Documentation"):
 *  - state.ts imports isTaskSettled, loadPlanJsonOnly, updateTaskStatus directly
 *    from 'src/plan/manager.js' — not behind a _internals seam. We mock the
 *    entire plan/manager module. Bun's per-file isolation (--smol) prevents
 *    cross-file contamination.
 *  - executeUpdateTaskStatus depends on swarmState and session identity.
 *    We mock the _internals seam only and use real function for guard logic.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Plan } from '../../src/config/plan-schema';
import { resetStartupLedgerCheck } from '../../src/plan/manager';
import {
	resetSwarmState,
	startAgentSession,
	swarmState,
} from '../../src/state';
import type { UpdateTaskStatusArgs } from '../../src/tools/update-task-status';
import {
	executeUpdateTaskStatus,
	_internals as utsInternals,
} from '../../src/tools/update-task-status';
import { resetSwarmArtifactCache } from '../../src/utils/swarm-artifact-cache';

// ── Test plan factory ─────────────────────────────────────────────────────────

function makePlan(tasks: Array<{ id: string; status: string }>): Plan {
	return {
		schema_version: '1.0.0',
		title: 'Settled Guard Tool Test Plan',
		swarm: 'test-swarm',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'in_progress',
				tasks: tasks.map((t) => ({
					id: t.id,
					phase: 1,
					status: t.status as Plan['phases'][0]['tasks'][0]['status'],
					size: 'small',
					description: `Task ${t.id}`,
					depends: [],
					files_touched: [],
				})),
			},
		],
	};
}

async function writePlanJson(dir: string, plan: Plan) {
	const swarmDir = join(dir, '.swarm');
	await mkdir(swarmDir, { recursive: true });
	await writeFile(join(swarmDir, 'plan.json'), JSON.stringify(plan, null, 2));
}

// ── Mock helpers ───────────────────────────────────────────────────────────────

function makeUpdateTaskStatusMock() {
	const calls: Array<{
		directory: string;
		taskId: string;
		status: string;
		options?: { force?: boolean };
	}> = [];
	const mockFn = mock(async (...args: unknown[]) => {
		calls.push({
			directory: args[0] as string,
			taskId: args[1] as string,
			status: args[2] as string,
			options: args[3] as { force?: boolean },
		});
		return makePlan([{ id: args[1] as string, status: args[2] as string }]);
	});
	return { mockFn, calls };
}

// ── advanceTaskStateAndPersist preflight tests ──────────────────────────────────

describe('advanceTaskStateAndPersist preflight — FR-005 settled-task guard', () => {
	let tempDir: string;
	let mockRestore: (() => void) | undefined;

	beforeEach(async () => {
		resetStartupLedgerCheck();
		resetSwarmArtifactCache();
		resetSwarmState();
		tempDir = await mkdtemp(join(tmpdir(), 'ata-'));
		await writePlanJson(
			tempDir,
			makePlan([{ id: '1.1', status: 'completed' }]),
		);
	});

	afterEach(async () => {
		mockRestore?.();
		resetSwarmState();
		if (existsSync(tempDir)) {
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	test('newState=coder_delegated on SETTLED task: NEITHER in-memory advance NOR durable persist occurs', async () => {
		const { mockFn: mockUpdateStatus, calls: updateCalls } =
			makeUpdateTaskStatusMock();
		const isSettledCalls: string[] = [];

		const mod = await import('../../src/plan/manager.js');
		const origLoadPlanJsonOnly = mod.loadPlanJsonOnly;

		mock.module('../../src/plan/manager.js', () => ({
			...mod,
			isTaskSettled: mock(async (_dir: string, taskId: string) => {
				isSettledCalls.push(taskId);
				return true; // Always settled
			}),
			loadPlanJsonOnly: origLoadPlanJsonOnly,
			updateTaskStatus: mockUpdateStatus,
		}));

		mockRestore = () => mock.restore();

		// Use startAgentSession to create a proper AgentSessionState
		startAgentSession('test-session', 'test-agent');
		const session = swarmState.agentSessions.get('test-session')!;

		const { advanceTaskStateAndPersist } = await import('../../src/state.js');

		await advanceTaskStateAndPersist(
			session,
			'1.1',
			'coder_delegated',
			tempDir,
		);

		// isTaskSettled was called with correct args
		expect(isSettledCalls).toEqual(['1.1']);

		// ZERO-MUTATION: in-memory state must NOT be advanced
		expect(session.taskWorkflowStates.get('1.1')).toBeUndefined();

		// ZERO-MUTATION: updateTaskStatus must NOT have been called
		expect(updateCalls).toHaveLength(0);
	});

	test('newState=coder_delegated on SETTLED task returns EARLY before advanceTaskState', async () => {
		const mod = await import('../../src/plan/manager.js');
		const origLoadPlanJsonOnly = mod.loadPlanJsonOnly;

		mock.module('../../src/plan/manager.js', () => ({
			...mod,
			isTaskSettled: mock(async () => true),
			loadPlanJsonOnly: origLoadPlanJsonOnly,
			// updateTaskStatus would throw if called — but it must NOT be called
			updateTaskStatus: mock(async () => {
				throw new Error('updateTaskStatus should not have been called');
			}),
		}));

		mockRestore = () => mock.restore();

		startAgentSession('test-session-2', 'test-agent');
		const session = swarmState.agentSessions.get('test-session-2')!;

		const { advanceTaskStateAndPersist } = await import('../../src/state.js');

		// Should return without throwing (early exit path)
		await expect(
			advanceTaskStateAndPersist(session, '1.1', 'coder_delegated', tempDir),
		).resolves.toBeUndefined();

		// Session state is still idle (not advanced)
		expect(session.taskWorkflowStates.get('1.1')).toBeUndefined();
	});

	test('newState=coder_delegated on PENDING task PROCEEDS normally (retry NOT blocked)', async () => {
		await writePlanJson(tempDir, makePlan([{ id: '1.1', status: 'pending' }]));

		const { mockFn: mockUpdateStatus, calls: updateCalls } =
			makeUpdateTaskStatusMock();

		const mod = await import('../../src/plan/manager.js');
		const origLoadPlanJsonOnly = mod.loadPlanJsonOnly;

		mock.module('../../src/plan/manager.js', () => ({
			...mod,
			isTaskSettled: mock(async () => false), // Not settled → proceeds
			loadPlanJsonOnly: origLoadPlanJsonOnly,
			updateTaskStatus: mockUpdateStatus,
		}));

		mockRestore = () => mock.restore();

		startAgentSession('test-session-3', 'test-agent');
		const session = swarmState.agentSessions.get('test-session-3')!;

		const { advanceTaskStateAndPersist } = await import('../../src/state.js');

		// Session starts at 'idle' (default); advanceTaskState moves idle → coder_delegated
		await advanceTaskStateAndPersist(
			session,
			'1.1',
			'coder_delegated',
			tempDir,
		);

		expect(updateCalls.length).toBeGreaterThan(0);
		expect(updateCalls[0].taskId).toBe('1.1');
	});

	test('newState=coder_delegated on IN_PROGRESS task PROCEEDS normally', async () => {
		await writePlanJson(
			tempDir,
			makePlan([{ id: '1.1', status: 'in_progress' }]),
		);

		const { mockFn: mockUpdateStatus, calls: updateCalls } =
			makeUpdateTaskStatusMock();

		const mod = await import('../../src/plan/manager.js');
		const origLoadPlanJsonOnly = mod.loadPlanJsonOnly;

		mock.module('../../src/plan/manager.js', () => ({
			...mod,
			isTaskSettled: mock(async () => false), // Not settled → proceeds
			loadPlanJsonOnly: origLoadPlanJsonOnly,
			updateTaskStatus: mockUpdateStatus,
		}));

		mockRestore = () => mock.restore();

		startAgentSession('test-session-4', 'test-agent');
		const session = swarmState.agentSessions.get('test-session-4')!;

		const { advanceTaskStateAndPersist } = await import('../../src/state.js');

		// Session starts at 'idle'; advanceTaskState moves idle → coder_delegated
		await advanceTaskStateAndPersist(
			session,
			'1.1',
			'coder_delegated',
			tempDir,
		);

		expect(updateCalls.length).toBeGreaterThan(0);
	});
});

// ── Tool guard tests (executeUpdateTaskStatus) ─────────────────────────────────

describe('executeUpdateTaskStatus — FR-005 tool guard', () => {
	let tempDir: string;
	let mockRestore: (() => void) | undefined;

	beforeEach(async () => {
		resetStartupLedgerCheck();
		resetSwarmArtifactCache();
		resetSwarmState();
		tempDir = await mkdtemp(join(tmpdir(), 'uts-tool-'));
	});

	afterEach(async () => {
		mockRestore?.();
		resetSwarmState();
		if (existsSync(tempDir)) {
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	test('in_progress on a COMPLETED task WITHOUT force is REJECTED with error', async () => {
		await writePlanJson(
			tempDir,
			makePlan([{ id: '1.1', status: 'completed' }]),
		);

		const origTryAcquireLock = utsInternals.tryAcquireLock;
		utsInternals.tryAcquireLock = mock(async () => ({
			acquired: true,
			lock: { _release: async () => {} },
		})) as typeof origTryAcquireLock;

		const { mockFn: mockUpdateStatus, calls: updateCalls } =
			makeUpdateTaskStatusMock();
		const origUTSUpdateStatus = utsInternals.updateTaskStatus;
		utsInternals.updateTaskStatus =
			mockUpdateStatus as typeof origUTSUpdateStatus;

		mockRestore = () => {
			utsInternals.tryAcquireLock = origTryAcquireLock;
			utsInternals.updateTaskStatus = origUTSUpdateStatus;
			mock.restore();
		};

		const args: UpdateTaskStatusArgs = {
			task_id: '1.1',
			status: 'in_progress',
			force: false,
		};

		const result = await executeUpdateTaskStatus(args, tempDir);

		expect(result.success).toBe(false);
		expect(result.errors).toBeDefined();
		expect(result.errors!.some((e) => e.includes('settled'))).toBe(true);
		// ZERO-MUTATION: updateTaskStatus must NOT have been called
		expect(updateCalls).toHaveLength(0);
	});

	test('in_progress on a COMPLETED task WITH force:true is PERMITTED', async () => {
		await writePlanJson(
			tempDir,
			makePlan([{ id: '1.1', status: 'completed' }]),
		);

		const { mockFn: mockUpdateStatus, calls: updateCalls } =
			makeUpdateTaskStatusMock();
		const origUTSUpdateStatus = utsInternals.updateTaskStatus;
		utsInternals.updateTaskStatus =
			mockUpdateStatus as typeof origUTSUpdateStatus;

		const origTryAcquireLock = utsInternals.tryAcquireLock;
		utsInternals.tryAcquireLock = mock(async () => ({
			acquired: true,
			lock: { _release: async () => {} },
		})) as typeof origTryAcquireLock;

		mockRestore = () => {
			utsInternals.updateTaskStatus = origUTSUpdateStatus;
			utsInternals.tryAcquireLock = origTryAcquireLock;
			mock.restore();
		};

		const args: UpdateTaskStatusArgs = {
			task_id: '1.1',
			status: 'in_progress',
			force: true,
		};

		const result = await executeUpdateTaskStatus(args, tempDir);

		expect(result.success).toBe(true);
		expect(updateCalls.length).toBe(1);
		expect(updateCalls[0].options?.force).toBe(true);
	});

	test('in_progress on a BLOCKED task WITHOUT force is REJECTED', async () => {
		await writePlanJson(tempDir, makePlan([{ id: '1.1', status: 'blocked' }]));

		const { mockFn: mockUpdateStatus, calls: updateCalls } =
			makeUpdateTaskStatusMock();
		const origUTSUpdateStatus = utsInternals.updateTaskStatus;
		utsInternals.updateTaskStatus =
			mockUpdateStatus as typeof origUTSUpdateStatus;

		const origTryAcquireLock = utsInternals.tryAcquireLock;
		utsInternals.tryAcquireLock = mock(async () => ({
			acquired: true,
			lock: { _release: async () => {} },
		})) as typeof origTryAcquireLock;

		mockRestore = () => {
			utsInternals.updateTaskStatus = origUTSUpdateStatus;
			utsInternals.tryAcquireLock = origTryAcquireLock;
			mock.restore();
		};

		const args: UpdateTaskStatusArgs = {
			task_id: '1.1',
			status: 'in_progress',
			force: false,
		};

		const result = await executeUpdateTaskStatus(args, tempDir);

		expect(result.success).toBe(false);
		expect(result.errors).toBeDefined();
		expect(result.errors!.some((e) => e.includes('settled'))).toBe(true);
		expect(updateCalls).toHaveLength(0);
	});

	test('in_progress on a PENDING task PROCEEDS (not blocked)', async () => {
		await writePlanJson(tempDir, makePlan([{ id: '1.1', status: 'pending' }]));

		const { mockFn: mockUpdateStatus, calls: updateCalls } =
			makeUpdateTaskStatusMock();
		const origUTSUpdateStatus = utsInternals.updateTaskStatus;
		utsInternals.updateTaskStatus =
			mockUpdateStatus as typeof origUTSUpdateStatus;

		const origTryAcquireLock = utsInternals.tryAcquireLock;
		utsInternals.tryAcquireLock = mock(async () => ({
			acquired: true,
			lock: { _release: async () => {} },
		})) as typeof origTryAcquireLock;

		mockRestore = () => {
			utsInternals.updateTaskStatus = origUTSUpdateStatus;
			utsInternals.tryAcquireLock = origTryAcquireLock;
			mock.restore();
		};

		const args: UpdateTaskStatusArgs = {
			task_id: '1.1',
			status: 'in_progress',
			force: false,
		};

		const result = await executeUpdateTaskStatus(args, tempDir);

		expect(result.success).toBe(true);
		expect(updateCalls.length).toBe(1);
	});

	test('ZERO-MUTATION: rejected tool call does not write plan.json', async () => {
		await writePlanJson(
			tempDir,
			makePlan([{ id: '1.1', status: 'completed' }]),
		);
		const beforeContent = await readFile(
			join(tempDir, '.swarm', 'plan.json'),
			'utf-8',
		);

		const origTryAcquireLock = utsInternals.tryAcquireLock;
		utsInternals.tryAcquireLock = mock(async () => ({
			acquired: true,
			lock: { _release: async () => {} },
		})) as typeof origTryAcquireLock;

		const { mockFn: mockUpdateStatus } = makeUpdateTaskStatusMock();
		const origUTSUpdateStatus = utsInternals.updateTaskStatus;
		utsInternals.updateTaskStatus =
			mockUpdateStatus as typeof origUTSUpdateStatus;

		mockRestore = () => {
			utsInternals.tryAcquireLock = origTryAcquireLock;
			utsInternals.updateTaskStatus = origUTSUpdateStatus;
			mock.restore();
		};

		await executeUpdateTaskStatus(
			{ task_id: '1.1', status: 'in_progress', force: false },
			tempDir,
		);

		const afterContent = await readFile(
			join(tempDir, '.swarm', 'plan.json'),
			'utf-8',
		);
		expect(afterContent).toBe(beforeContent);
	});
});
