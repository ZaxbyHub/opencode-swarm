/**
 * Ledger-replay staleness refusal tests for update-task-status.ts (#1269 finding 2).
 *
 * Acceptance (#1269 finding 2): "update_task_status consults the staleness signal
 * (refuse or re-verify) rather than relying on a logged warning."
 *
 * When loadPlan attaches `_ledgerReplayStale === true` (plan.json hash mismatched the
 * ledger, ledger replay threw, AND no critic-approved snapshot was available), the tool
 * must REFUSE the mutation with structured recovery guidance and leave plan.json
 * untouched — never silently overwrite the authoritative ledger view.
 *
 * Uses the `_internals.loadPlan` DI seam instead of module-scope mock.module to avoid
 * cross-file leakage in Bun's shared test-runner process.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RuntimePlan } from '../../../src/config/plan-schema';
import { swarmState } from '../../../src/state';
import {
	_internals,
	executeUpdateTaskStatus,
} from '../../../src/tools/update-task-status';

describe('executeUpdateTaskStatus — ledger-replay staleness refusal (#1269 finding 2)', () => {
	let tempDir: string;
	let originalCwd: string;
	let planPath: string;
	let originalAgentSessions: typeof swarmState.agentSessions;
	let originalLoadPlan: typeof _internals.loadPlan;
	let originalTryAcquireLock: typeof _internals.tryAcquireLock;
	let originalUpdateTaskStatus: typeof _internals.updateTaskStatus;

	const buildPlan = () => ({
		schema_version: '1.0.0',
		title: 'Ledger Stale Test Plan',
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
						description: 'Task 1',
						depends: [] as string[],
						files_touched: [] as string[],
					},
				],
			},
		],
	});

	beforeEach(() => {
		tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'uts-ledger-stale-')),
		);
		originalCwd = process.cwd();
		process.chdir(tempDir);

		fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
		planPath = path.join(tempDir, '.swarm', 'plan.json');
		fs.writeFileSync(planPath, JSON.stringify(buildPlan(), null, 2));

		originalAgentSessions = new Map(swarmState.agentSessions);
		swarmState.agentSessions.clear();

		originalLoadPlan = _internals.loadPlan;
		originalTryAcquireLock = _internals.tryAcquireLock;
		originalUpdateTaskStatus = _internals.updateTaskStatus;
	});

	afterEach(() => {
		_internals.loadPlan = originalLoadPlan;
		_internals.tryAcquireLock = originalTryAcquireLock;
		_internals.updateTaskStatus = originalUpdateTaskStatus;
		swarmState.agentSessions.clear();
		for (const [key, value] of originalAgentSessions) {
			swarmState.agentSessions.set(key, value);
		}
		process.chdir(originalCwd);
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test('refuses to mutate when the loaded plan is ledger-replay stale and leaves plan.json untouched', async () => {
		// Arrange: loadPlan reports the loaded plan.json is stale relative to the ledger.
		const staleReason =
			'Ledger replay failed during hash-mismatch rebuild and no approved snapshot was available: boom';
		const stalePlan: RuntimePlan = {
			...buildPlan(),
			_ledgerReplayStale: true,
			_ledgerReplayStaleReason: staleReason,
		} as unknown as RuntimePlan;
		_internals.loadPlan = async () => stalePlan;

		// Capture plan.json bytes before the call so "not mutated" is proven, not assumed.
		const before = fs.readFileSync(planPath, 'utf-8');

		// Act: use 'pending' to isolate the staleness gate from the in_progress evidence
		// write and the completed reviewer/council gates.
		const result = await executeUpdateTaskStatus(
			{ task_id: '1.1', status: 'pending' },
			tempDir,
		);

		// Assert: structured refusal (mirrors the lock-blocked shape).
		expect(result.success).toBe(false);
		expect(result.message.toLowerCase()).toContain('stale');
		expect(Array.isArray(result.errors)).toBe(true);
		// The staleness reason from loadPlan is surfaced to the caller.
		expect(result.errors).toContain(staleReason);
		expect(typeof result.recovery_guidance).toBe('string');
		expect(result.recovery_guidance!.length).toBeGreaterThan(0);
		// No partial mutation leaked through.
		expect(result.task_id).toBeUndefined();
		expect(result.new_status).toBeUndefined();

		// Assert: plan.json is byte-for-byte unchanged — the mutation was refused.
		const after = fs.readFileSync(planPath, 'utf-8');
		expect(after).toBe(before);
		const parsed = JSON.parse(after);
		expect(parsed.phases[0].tasks[0].status).toBe('pending');
	});

	test('proceeds normally when loadPlan reports a non-stale plan', async () => {
		// Arrange: loadPlan returns a fresh (non-stale) plan — the staleness gate must not fire.
		_internals.loadPlan = async () => buildPlan() as unknown as RuntimePlan;

		// Invariant 7 robustness: this control proves the *staleness gate* (not some
		// unrelated scaffold failure) is what causes the refusal in the test above —
		// i.e. a non-stale plan proceeds past the gate to the real mutation call.
		// The cross-module persistence seams (`tryAcquireLock` from parallel/file-locks,
		// `updateTaskStatus` from plan/manager) are injected through the same `_internals`
		// DI seam this file already uses, so a leaked sibling `vi.mock('plan/manager')`
		// (which omits `updateTaskStatus`) or `vi.mock('parallel/file-locks')` (which
		// stubs `tryAcquireLock`) in Bun's shared test process cannot corrupt this control.
		// We assert the post-gate mutation path is reached with the exact arguments —
		// the discrimination the control exists for — rather than relying on real
		// on-disk persistence, which a leaked mock can silently no-op.
		const releaseSpy = mock(async () => {});
		_internals.tryAcquireLock = mock(async () => ({
			acquired: true as const,
			lock: {
				filePath: 'plan.json',
				agent: 'update-task-status',
				taskId: 'update-task-status-1.1',
				timestamp: new Date().toISOString(),
				expiresAt: Date.now() + 300000,
				_release: releaseSpy,
			},
		})) as unknown as typeof _internals.tryAcquireLock;
		const updateSpy = mock(
			async () => buildPlan() as unknown as RuntimePlan,
		) as unknown as typeof _internals.updateTaskStatus;
		_internals.updateTaskStatus = updateSpy;

		// Act
		const result = await executeUpdateTaskStatus(
			{ task_id: '1.1', status: 'in_progress' },
			tempDir,
		);

		// Assert: the staleness gate did NOT fire — the call succeeded (no false-positive
		// refusal) and proceeded all the way to the real mutation with the exact arguments.
		expect(result.success).toBe(true);
		expect(result.new_status).toBe('in_progress');
		expect(result.message).not.toContain('stale');
		expect(updateSpy).toHaveBeenCalledTimes(1);
		expect(updateSpy).toHaveBeenCalledWith(tempDir, '1.1', 'in_progress');
		// The acquired lock is released even on the success path.
		expect(releaseSpy).toHaveBeenCalledTimes(1);
	});
});
