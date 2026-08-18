import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolContext } from '@opencode-ai/plugin/tool';
import { tryAcquireLock } from '../../../src/parallel/file-locks';
import { resetStartupLedgerCheck } from '../../../src/plan/manager';
import { resetSwarmState } from '../../../src/state';
import { executeUpdateTaskStatus } from '../../../src/tools/update-task-status';
import { resetSwarmArtifactCache } from '../../../src/utils/swarm-artifact-cache';
import { recoverPreparedTaskRepair } from '../../../src/workflow/task-repair';
import { createSafeTestDir } from '../../helpers/safe-test-dir';
import {
	repairArgs,
	seedSettledRepairState,
	TASK_ID,
} from '../../helpers/task-repair-2098-fixtures';

describe('issue #2098 task-repair audit-event resilience (FB-001)', () => {
	let directory: string;
	let cleanup: () => void;
	const context = { sessionID: 'repair-audit-caller' } as ToolContext;

	beforeEach(() => {
		resetStartupLedgerCheck();
		resetSwarmArtifactCache();
		resetSwarmState();
		({ dir: directory, cleanup } = createSafeTestDir(
			'task-repair-audit-2098-',
		));
		seedSettledRepairState(directory);
	});

	afterEach(() => {
		resetSwarmState();
		cleanup();
	});

	test('a malformed line elsewhere in events.jsonl does not block finding or appending the repair audit event', async () => {
		const swarmDir = path.join(directory, '.swarm');
		const eventsPath = path.join(swarmDir, 'events.jsonl');
		// Pre-seed events.jsonl with a valid unrelated event, a truncated/garbage
		// line, and another valid unrelated event, BEFORE the repair runs. If
		// ensureAuditEvent's line-by-line scan throws on the malformed line
		// (pre-fix behaviour via JSON.parse without try/catch), the whole repair
		// call throws and this test fails.
		const lines = [
			JSON.stringify({
				type: 'some_other_event',
				timestamp: '2026-01-01T00:00:00Z',
				taskId: TASK_ID,
			}),
			'{"type": "task_workflow_repaired", "transitionId": "trunc', // truncated JSON fragment
			'not even json at all {{{',
			JSON.stringify({
				type: 'another_event',
				timestamp: '2026-01-01T00:00:01Z',
				taskId: TASK_ID,
			}),
		];
		fs.writeFileSync(eventsPath, `${lines.join('\n')}\n`);

		const result = await executeUpdateTaskStatus(
			repairArgs(),
			directory,
			context,
		);

		expect(result.success).toBe(true);

		const finalContent = fs.readFileSync(eventsPath, 'utf-8');
		const finalLines = finalContent
			.split('\n')
			.filter((line) => line.trim().length > 0);
		// The malformed lines must still be present (skipped, not dropped/mangled).
		expect(finalLines).toContain('not even json at all {{{');
		const repairedEvents = finalLines
			.map((line) => {
				try {
					return JSON.parse(line) as Record<string, unknown>;
				} catch {
					return null;
				}
			})
			.filter(
				(event) =>
					event?.type === 'task_workflow_repaired' &&
					event.transitionId === 'repair-1.1-generation-3',
			);
		expect(repairedEvents.length).toBe(1);
	});

	test('retrying after an audit-event lock failure lands on the idempotent alreadyApplied path, not a permanently PREPARED WAL', async () => {
		const swarmDir = path.join(directory, '.swarm');
		const eventsPath = path.join(swarmDir, 'events.jsonl');
		fs.mkdirSync(swarmDir, { recursive: true });
		if (!fs.existsSync(eventsPath)) fs.writeFileSync(eventsPath, '');

		// Externally hold the events.jsonl lock so ensureAuditEvent's internal
		// tryAcquireLock call fails during the repair's audit-event step. Because
		// the fix commits the WAL to COMMITTED *before* calling ensureAuditEvent,
		// the WAL should already be COMMITTED on disk when this throws.
		const externalLock = await tryAcquireLock(
			directory,
			'events.jsonl',
			'external-holder',
			'blocking-audit',
		);
		expect(externalLock.acquired).toBe(true);

		const failed = await executeUpdateTaskStatus(
			repairArgs(),
			directory,
			context,
		);
		expect(failed.success).toBe(false);

		const walPath = path.join(swarmDir, 'task-repairs', `${TASK_ID}.json`);
		const walDuringLock = JSON.parse(fs.readFileSync(walPath, 'utf-8')) as {
			state: string;
		};
		// This is the crux of the FB-001 lock-ordering fix: the WAL must already
		// be COMMITTED, not PREPARED, even though the audit event failed.
		expect(walDuringLock.state).toBe('COMMITTED');

		// Release the external lock and retry. The retry must succeed via the
		// alreadyApplied idempotent path (workflowMatchesCommittedRepair), not be
		// fenced by a stale PREPARED WAL requiring manual recovery.
		if (externalLock.acquired) {
			await externalLock.lock._release?.();
		}

		const retry = await executeUpdateTaskStatus(
			repairArgs(),
			directory,
			context,
		);
		expect(retry.success).toBe(true);

		const finalContent = fs.readFileSync(eventsPath, 'utf-8');
		const repairedCount = finalContent
			.split('\n')
			.filter((line) => line.trim().length > 0)
			.map((line) => {
				try {
					return JSON.parse(line) as Record<string, unknown>;
				} catch {
					return null;
				}
			})
			.filter(
				(event) =>
					event?.type === 'task_workflow_repaired' &&
					event.transitionId === 'repair-1.1-generation-3',
			).length;
		expect(repairedCount).toBe(1);
	});

	test('lazy recovery via recoverPreparedTaskRepair retries a lost audit event on a COMMITTED WAL instead of returning null forever', async () => {
		const swarmDir = path.join(directory, '.swarm');
		const eventsPath = path.join(swarmDir, 'events.jsonl');
		fs.mkdirSync(swarmDir, { recursive: true });
		if (!fs.existsSync(eventsPath)) fs.writeFileSync(eventsPath, '');

		// Externally hold the events.jsonl lock so the initial repair call
		// commits the WAL but fails to write the audit event (same setup as the
		// lock-ordering test above).
		const externalLock = await tryAcquireLock(
			directory,
			'events.jsonl',
			'external-holder',
			'blocking-audit-lazy',
		);
		expect(externalLock.acquired).toBe(true);

		const failed = await executeUpdateTaskStatus(
			repairArgs(),
			directory,
			context,
		);
		expect(failed.success).toBe(false);

		const walPath = path.join(swarmDir, 'task-repairs', `${TASK_ID}.json`);
		const walDuringLock = JSON.parse(fs.readFileSync(walPath, 'utf-8')) as {
			state: string;
		};
		expect(walDuringLock.state).toBe('COMMITTED');

		// Confirm the audit event genuinely did not make it to disk yet.
		const contentBeforeRecovery = fs.readFileSync(eventsPath, 'utf-8');
		expect(contentBeforeRecovery).not.toContain('task_workflow_repaired');

		await externalLock.lock._release?.();

		// Do NOT go through executeUpdateTaskStatus's own repair/force path here.
		// Call the lazy-recovery entrypoint directly, exactly as
		// delegation-gate.ts and update-task-status.ts's normal (non-force) flow
		// do on every subsequent call once a WAL is left on disk.
		const recovered = await recoverPreparedTaskRepair(
			directory,
			TASK_ID,
			'lazy-recovery-caller',
		);

		// The pre-fix behaviour returned null immediately on an observed
		// COMMITTED WAL without ever retrying ensureAuditEvent, permanently
		// losing the audit event. The fixed behaviour also returns null here
		// (there's nothing further to apply), but it must have retried the
		// audit write as a side effect first.
		expect(recovered).toBeNull();

		const finalContent = fs.readFileSync(eventsPath, 'utf-8');
		const repairedEvents = finalContent
			.split('\n')
			.filter((line) => line.trim().length > 0)
			.map((line) => {
				try {
					return JSON.parse(line) as Record<string, unknown>;
				} catch {
					return null;
				}
			})
			.filter(
				(event) =>
					event?.type === 'task_workflow_repaired' &&
					event.transitionId === 'repair-1.1-generation-3',
			);
		expect(repairedEvents.length).toBe(1);
	});

	test('steady-state lazy recovery on a fully-settled repair does not throw TASK_REPAIR_AUDIT_LOCKED even while events.jsonl is externally locked', async () => {
		const swarmDir = path.join(directory, '.swarm');
		const eventsPath = path.join(swarmDir, 'events.jsonl');
		fs.mkdirSync(swarmDir, { recursive: true });
		if (!fs.existsSync(eventsPath)) fs.writeFileSync(eventsPath, '');

		// First, let the repair run to full completion with no contention: the
		// WAL commits to COMMITTED and the audit event lands in events.jsonl.
		const settled = await executeUpdateTaskStatus(
			repairArgs(),
			directory,
			context,
		);
		expect(settled.success).toBe(true);

		const walPath = path.join(swarmDir, 'task-repairs', `${TASK_ID}.json`);
		const walAfterSettle = JSON.parse(fs.readFileSync(walPath, 'utf-8')) as {
			state: string;
		};
		expect(walAfterSettle.state).toBe('COMMITTED');

		const contentAfterSettle = fs.readFileSync(eventsPath, 'utf-8');
		expect(contentAfterSettle).toContain('task_workflow_repaired');

		// Now simulate the steady state: some unrelated tool call touches this
		// task and triggers lazy recovery (recoverPreparedTaskRepair) while
		// another process happens to be holding the events.jsonl lock for an
		// unrelated write. Because the audit event is already durably present,
		// the fixed ensureAuditEvent must find it via the pre-lock read and
		// return WITHOUT ever calling tryAcquireLock. The pre-fix
		// (unconditional-lock-then-check) version would call tryAcquireLock
		// here, fail because the lock is externally held, and throw
		// TASK_REPAIR_AUDIT_LOCKED.
		const externalLock = await tryAcquireLock(
			directory,
			'events.jsonl',
			'external-holder',
			'steady-state-unrelated-write',
		);
		expect(externalLock.acquired).toBe(true);

		try {
			const recovered = await recoverPreparedTaskRepair(
				directory,
				TASK_ID,
				'steady-state-lazy-recovery-caller',
			);
			// Nothing left to apply: the WAL is COMMITTED and already reflected
			// in plan state, so recovery reports null (not an error).
			expect(recovered).toBeNull();
		} finally {
			if (externalLock.acquired) await externalLock.lock._release?.();
		}
	});

	test('same transition id on different tasks records two audit events while same-task retry stays idempotent', async () => {
		const swarmDir = path.join(directory, '.swarm');
		const evidenceDir = path.join(swarmDir, 'evidence');
		fs.writeFileSync(
			path.join(swarmDir, 'plan.json'),
			JSON.stringify(
				{
					schema_version: '1.0.0',
					title: 'Repair audit identity scope',
					swarm: 'test-swarm',
					current_phase: 1,
					phases: [
						{
							id: 1,
							name: 'Phase 1',
							status: 'complete',
							tasks: [
								{
									id: '1.1',
									phase: 1,
									status: 'completed',
									size: 'small',
									description: 'First repaired task',
									depends: [],
									files_touched: ['src/first.ts'],
								},
								{
									id: '1.2',
									phase: 1,
									status: 'completed',
									size: 'small',
									description: 'Second repaired task',
									depends: [],
									files_touched: ['src/second.ts'],
								},
							],
						},
					],
				},
				null,
				2,
			),
		);
		const evidencePayload = JSON.parse(
			fs.readFileSync(path.join(evidenceDir, `${TASK_ID}.json`), 'utf-8'),
		) as Record<string, unknown>;
		fs.writeFileSync(
			path.join(evidenceDir, '1.2.json'),
			JSON.stringify({ ...evidencePayload, taskId: '1.2' }, null, 2),
		);

		const transitionId = 'shared-repair-transition';
		expect(
			(
				await executeUpdateTaskStatus(
					repairArgs({ transition_id: transitionId }),
					directory,
					context,
				)
			).success,
		).toBe(true);
		expect(
			(
				await executeUpdateTaskStatus(
					repairArgs({ task_id: '1.2', transition_id: transitionId }),
					directory,
					context,
				)
			).success,
		).toBe(true);

		const repairedEvents = fs
			.readFileSync(path.join(swarmDir, 'events.jsonl'), 'utf-8')
			.split('\n')
			.filter((line) => line.trim().length > 0)
			.map((line) => JSON.parse(line) as Record<string, unknown>)
			.filter(
				(event) =>
					event.type === 'task_workflow_repaired' &&
					event.transitionId === transitionId,
			);
		expect(repairedEvents).toHaveLength(2);
		expect(repairedEvents.map((event) => event.taskId).sort()).toEqual([
			'1.1',
			'1.2',
		]);

		expect(
			(
				await executeUpdateTaskStatus(
					{ task_id: '1.1', status: 'in_progress' },
					directory,
					context,
				)
			).success,
		).toBe(true);
		const retryEvents = fs
			.readFileSync(path.join(swarmDir, 'events.jsonl'), 'utf-8')
			.split('\n')
			.filter((line) => line.trim().length > 0)
			.map((line) => JSON.parse(line) as Record<string, unknown>)
			.filter(
				(event) =>
					event.type === 'task_workflow_repaired' &&
					event.transitionId === transitionId,
			);
		expect(retryEvents).toHaveLength(2);
	});
});
