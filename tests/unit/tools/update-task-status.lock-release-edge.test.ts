import { afterEach, beforeEach, describe, expect, test, vi } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { swarmState } from '../../../src/state';
import {
	_internals,
	executeUpdateTaskStatus,
} from '../../../src/tools/update-task-status';
import { canonicalTmpDir } from '../../helpers/tmpdir.js';
import { readPlanWithTaskStatus } from '../../helpers/update-task-status-fixtures';

describe('executeUpdateTaskStatus guaranteed lock release', () => {
	let tempDir: string;
	let originalAgentSessions: typeof swarmState.agentSessions;
	let originalTryAcquireLock: typeof _internals.tryAcquireLock;
	let originalUpdateTaskStatus: typeof _internals.updateTaskStatus;
	let mockTryAcquireLock: ReturnType<typeof vi.fn>;
	let mockUpdateTaskStatus: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(canonicalTmpDir(), 'update-task-lock-release-')),
		);
		fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
		fs.writeFileSync(
			path.join(tempDir, '.swarm', 'plan.json'),
			JSON.stringify({
				schema_version: '1.0.0',
				title: 'Lock release',
				swarm: 'test-swarm',
				current_phase: 1,
				migration_status: 'migrated',
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
								description: 'Test task 1',
								depends: [],
								files_touched: [],
							},
						],
					},
				],
			}),
		);
		originalAgentSessions = new Map(swarmState.agentSessions);
		swarmState.agentSessions.clear();
		originalTryAcquireLock = _internals.tryAcquireLock;
		originalUpdateTaskStatus = _internals.updateTaskStatus;
		mockTryAcquireLock = vi.fn();
		mockUpdateTaskStatus = vi.fn();
		_internals.tryAcquireLock = mockTryAcquireLock;
		_internals.updateTaskStatus = mockUpdateTaskStatus;
		vi.clearAllMocks();
	});

	afterEach(() => {
		swarmState.agentSessions.clear();
		for (const [key, value] of originalAgentSessions)
			swarmState.agentSessions.set(key, value);
		_internals.tryAcquireLock = originalTryAcquireLock;
		_internals.updateTaskStatus = originalUpdateTaskStatus;
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test('returns success even when _release throws', async () => {
		const mockRelease = vi.fn().mockImplementation(() => {
			throw new Error('Release failed');
		});
		mockTryAcquireLock.mockResolvedValue({
			acquired: true,
			lock: {
				filePath: 'plan.json',
				agent: 'update-task-status',
				taskId: 'lock-1',
				timestamp: '2026-08-14T00:00:00.000Z',
				expiresAt: Number.MAX_SAFE_INTEGER,
				_release: mockRelease,
			},
		});
		mockUpdateTaskStatus.mockResolvedValue(
			readPlanWithTaskStatus(tempDir, 'in_progress'),
		);
		const result = await executeUpdateTaskStatus(
			{ task_id: '1.1', status: 'in_progress' },
			tempDir,
		);
		expect(result.success).toBe(true);
		expect(mockRelease).toHaveBeenCalled();
	});

	test('preserves update error when _release also throws', async () => {
		const mockRelease = vi.fn().mockImplementation(() => {
			throw new Error('Release failed');
		});
		mockTryAcquireLock.mockResolvedValue({
			acquired: true,
			lock: {
				filePath: 'plan.json',
				agent: 'update-task-status',
				taskId: 'lock-1',
				timestamp: '2026-08-14T00:00:00.000Z',
				expiresAt: Number.MAX_SAFE_INTEGER,
				_release: mockRelease,
			},
		});
		mockUpdateTaskStatus.mockRejectedValue(new Error('Update failed'));
		const result = await executeUpdateTaskStatus(
			{ task_id: '1.1', status: 'in_progress' },
			tempDir,
		);
		expect(result.success).toBe(false);
		expect(
			result.errors?.some((error) => error.includes('Update failed')),
		).toBe(true);
		expect(mockRelease).toHaveBeenCalled();
	});

	test('does not release when lock acquisition returns acquired=false', async () => {
		const mockRelease = vi.fn().mockResolvedValue(undefined);
		mockTryAcquireLock.mockResolvedValue({ acquired: false });
		await executeUpdateTaskStatus(
			{ task_id: '1.1', status: 'in_progress' },
			tempDir,
		);
		expect(mockRelease).not.toHaveBeenCalled();
	});

	test('does not release when lock acquisition throws', async () => {
		const mockRelease = vi.fn().mockResolvedValue(undefined);
		mockTryAcquireLock.mockRejectedValue(
			new Error('Cannot create lock directory'),
		);
		await executeUpdateTaskStatus(
			{ task_id: '1.1', status: 'in_progress' },
			tempDir,
		);
		expect(mockRelease).not.toHaveBeenCalled();
	});
});
