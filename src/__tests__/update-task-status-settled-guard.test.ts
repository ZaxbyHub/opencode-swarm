/**
 * Tests for the FR-005 settled-task guard across two compatibility surfaces:
 *  1. advanceTaskStateAndPersist legacy boundary refusal (src/state.ts)
 *  2. executeUpdateTaskStatus tool guard                 (src/tools/update-task-status.ts)
 *
 * Mock strategy:
 *  - advanceTaskStateAndPersist tests use the real legacy wrapper. It has no
 *    plan-manager writer: coder and terminal durability boundaries are refused.
 *  - executeUpdateTaskStatus tests: mock the existing _internals seam
 *    (utsInternals.tryAcquireLock, utsInternals.updateTaskStatus) with per-test
 *    save/restore.
 *
 * Mock coverage gaps (per writing-tests "Mock Coverage Documentation"):
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
	advanceTaskStateAndPersist,
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

// ── Legacy workflow wrapper boundary tests ──────────────────────────────────

describe('advanceTaskStateAndPersist — central transaction boundary', () => {
	let tempDir: string;

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
		resetSwarmState();
		if (existsSync(tempDir))
			await rm(tempDir, { recursive: true, force: true });
	});

	test('refuses coder_delegated with zero session or plan mutation', async () => {
		startAgentSession('test-session', 'test-agent');
		const session = swarmState.agentSessions.get('test-session')!;
		const planPath = join(tempDir, '.swarm', 'plan.json');
		const before = await readFile(planPath, 'utf8');

		await expect(
			advanceTaskStateAndPersist(session, '1.1', 'coder_delegated', tempDir),
		).rejects.toThrow('TASK_WORKFLOW_CENTRAL_TRANSACTION_REQUIRED');

		expect(session.taskWorkflowStates.get('1.1')).toBeUndefined();
		expect(await readFile(planPath, 'utf8')).toBe(before);
	});

	test('refuses complete even from tests_run with zero session or plan mutation', async () => {
		startAgentSession('test-session-2', 'test-agent');
		const session = swarmState.agentSessions.get('test-session-2')!;
		session.taskWorkflowStates.set('1.1', 'tests_run');
		const planPath = join(tempDir, '.swarm', 'plan.json');
		const before = await readFile(planPath, 'utf8');

		await expect(
			advanceTaskStateAndPersist(session, '1.1', 'complete', tempDir),
		).rejects.toThrow('TASK_WORKFLOW_CENTRAL_TRANSACTION_REQUIRED');

		expect(session.taskWorkflowStates.get('1.1')).toBe('tests_run');
		expect(await readFile(planPath, 'utf8')).toBe(before);
	});

	test('applies diagnostic intermediate states in memory without persisting plan', async () => {
		await writePlanJson(
			tempDir,
			makePlan([{ id: '1.1', status: 'in_progress' }]),
		);
		startAgentSession('test-session-3', 'test-agent');
		const session = swarmState.agentSessions.get('test-session-3')!;
		session.taskWorkflowStates.set('1.1', 'coder_delegated');
		const planPath = join(tempDir, '.swarm', 'plan.json');
		const before = await readFile(planPath, 'utf8');

		await advanceTaskStateAndPersist(
			session,
			'1.1',
			'pre_check_passed',
			tempDir,
		);
		await advanceTaskStateAndPersist(session, '1.1', 'reviewer_run', tempDir);
		await advanceTaskStateAndPersist(session, '1.1', 'tests_run', tempDir);

		expect(session.taskWorkflowStates.get('1.1')).toBe('tests_run');
		expect(await readFile(planPath, 'utf8')).toBe(before);
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

	test('in_progress on a COMPLETED task rejects bare force:true without CAS audit fields', async () => {
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

		expect(result.success).toBe(false);
		expect(result.errors?.join(' ')).toContain('expected_state');
		expect(updateCalls.length).toBe(0);
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
