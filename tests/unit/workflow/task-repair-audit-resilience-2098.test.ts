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

const TASK_ID = '1.1';

function repairArgs(overrides: Record<string, unknown> = {}) {
	return {
		task_id: TASK_ID,
		status: 'in_progress',
		force: true,
		expected_state: 'tests_run',
		expected_generation: 3,
		target_state: 'idle' as const,
		reason: 'Reviewer found a post-completion defect',
		transition_id: 'repair-1.1-generation-3',
		...overrides,
	};
}

function seedSettledRepairState(directory: string): void {
	const swarmDir = path.join(directory, '.swarm');
	fs.mkdirSync(path.join(swarmDir, 'evidence'), { recursive: true });
	fs.writeFileSync(
		path.join(swarmDir, 'plan.json'),
		JSON.stringify(
			{
				schema_version: '1.0.0',
				title: 'Repair audit resilience',
				swarm: 'test-swarm',
				current_phase: 1,
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						status: 'complete',
						tasks: [
							{
								id: TASK_ID,
								phase: 1,
								status: 'completed',
								size: 'small',
								description: 'Exact repaired task',
								depends: [],
								files_touched: ['src/exact.ts'],
							},
						],
					},
				],
			},
			null,
			2,
		),
	);
	fs.writeFileSync(
		path.join(swarmDir, 'evidence', `${TASK_ID}.json`),
		JSON.stringify(
			{
				taskId: TASK_ID,
				required_gates: ['reviewer', 'test_engineer'],
				gates: {
					pre_check: {
						sessionId: 'system',
						timestamp: '2026-01-01T00:00:00Z',
						agent: 'pre_check',
					},
					reviewer: {
						sessionId: 'review',
						timestamp: '2026-01-01T00:00:01Z',
						agent: 'reviewer',
					},
					test_engineer: {
						sessionId: 'test',
						timestamp: '2026-01-01T00:00:02Z',
						agent: 'test_engineer',
					},
				},
				workflow: {
					schema: 'exact-task-v1',
					state: 'tests_run',
					generation: 3,
					retryCount: 0,
					lastOutcome: 'stage_b_completed',
					updatedAt: '2026-01-01T00:00:02Z',
				},
			},
			null,
			2,
		),
	);
}

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
});

describe('issue #2098 corrupt task-repair WAL error message (FB-002)', () => {
	let directory: string;
	let cleanup: () => void;
	const context = { sessionID: 'repair-corrupt-wal-caller' } as ToolContext;

	beforeEach(() => {
		resetStartupLedgerCheck();
		resetSwarmArtifactCache();
		resetSwarmState();
		({ dir: directory, cleanup } = createSafeTestDir(
			'task-repair-corrupt-wal-2098-',
		));
		seedSettledRepairState(directory);
	});

	afterEach(() => {
		resetSwarmState();
		cleanup();
	});

	test('a garbage WAL file throws an error containing both the WAL path and a remediation hint', async () => {
		const walDir = path.join(directory, '.swarm', 'task-repairs');
		fs.mkdirSync(walDir, { recursive: true });
		const walPath = path.join(walDir, `${TASK_ID}.json`);
		fs.writeFileSync(walPath, 'not valid json at all {{{');

		const result = await executeUpdateTaskStatus(
			repairArgs(),
			directory,
			context,
		);

		expect(result.success).toBe(false);
		const message = [result.message, ...(result.errors ?? [])].join(' ');
		expect(message).toContain(walPath);
		expect(message.toLowerCase()).toContain('delete this file');
	});
});

describe('issue #2098 force-repair field length limits (FB-004)', () => {
	let directory: string;
	let cleanup: () => void;
	const context = { sessionID: 'repair-length-caller' } as ToolContext;

	beforeEach(() => {
		resetStartupLedgerCheck();
		resetSwarmArtifactCache();
		resetSwarmState();
		({ dir: directory, cleanup } = createSafeTestDir(
			'task-repair-length-2098-',
		));
		seedSettledRepairState(directory);
	});

	afterEach(() => {
		resetSwarmState();
		cleanup();
	});

	test('rejects a reason longer than 2000 chars with TASK_REPAIR_INVALID and no artifact writes', async () => {
		const before = fs.readFileSync(
			path.join(directory, '.swarm', 'evidence', `${TASK_ID}.json`),
			'utf-8',
		);

		const result = await executeUpdateTaskStatus(
			repairArgs({ reason: 'x'.repeat(2001) }),
			directory,
			context,
		);

		expect(result.success).toBe(false);
		expect([result.message, ...(result.errors ?? [])].join(' ')).toContain(
			'TASK_REPAIR_INVALID',
		);
		const after = fs.readFileSync(
			path.join(directory, '.swarm', 'evidence', `${TASK_ID}.json`),
			'utf-8',
		);
		expect(after).toBe(before);
	});

	test('rejects a transition_id longer than 200 chars with TASK_REPAIR_INVALID and no artifact writes', async () => {
		const before = fs.readFileSync(
			path.join(directory, '.swarm', 'evidence', `${TASK_ID}.json`),
			'utf-8',
		);

		const result = await executeUpdateTaskStatus(
			repairArgs({ transition_id: `repair-${'x'.repeat(200)}` }),
			directory,
			context,
		);

		expect(result.success).toBe(false);
		expect([result.message, ...(result.errors ?? [])].join(' ')).toContain(
			'TASK_REPAIR_INVALID',
		);
		const after = fs.readFileSync(
			path.join(directory, '.swarm', 'evidence', `${TASK_ID}.json`),
			'utf-8',
		);
		expect(after).toBe(before);
	});

	test('accepts a reason and transition_id exactly at the 2000/200 char boundary', async () => {
		const result = await executeUpdateTaskStatus(
			repairArgs({
				reason: `Reviewer defect: ${'x'.repeat(2000 - 'Reviewer defect: '.length)}`,
				transition_id: `r-${'x'.repeat(198)}`,
			}),
			directory,
			context,
		);

		expect(result.success).toBe(true);
	});
});

describe('issue #2098 findRepairEvent JSON-escaping safety (FB-001)', () => {
	let directory: string;
	let cleanup: () => void;
	const context = { sessionID: 'repair-escaping-caller' } as ToolContext;

	beforeEach(() => {
		resetStartupLedgerCheck();
		resetSwarmArtifactCache();
		resetSwarmState();
		({ dir: directory, cleanup } = createSafeTestDir(
			'task-repair-escaping-2098-',
		));
		seedSettledRepairState(directory);
	});

	afterEach(() => {
		resetSwarmState();
		cleanup();
	});

	test('a transition_id containing a quote and a backslash still audits and re-verifies successfully', async () => {
		// findRepairEvent's cheap pre-filter must search for the JSON-escaped
		// form of transitionId, matching how it is serialized in events.jsonl,
		// or a raw substring search silently misses every match for an id
		// containing '"' or '\\' and throws TASK_REPAIR_AUDIT_UNVERIFIED even
		// though the event was written successfully.
		const trickyId = 'repair-"1.1"-gen\\3';

		const result = await executeUpdateTaskStatus(
			repairArgs({ transition_id: trickyId }),
			directory,
			context,
		);
		expect(result.success).toBe(true);

		const eventsPath = path.join(directory, '.swarm', 'events.jsonl');
		const lines = fs
			.readFileSync(eventsPath, 'utf-8')
			.split('\n')
			.filter((line) => line.trim().length > 0);
		const repairedEvents = lines
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
					event.transitionId === trickyId,
			);
		expect(repairedEvents.length).toBe(1);

		// A subsequent, unrelated non-force call must not re-throw and must not
		// append a duplicate audit event for the same transitionId.
		const followUp = await executeUpdateTaskStatus(
			{ task_id: TASK_ID, status: 'in_progress' },
			directory,
			context,
		);
		expect(followUp.success).toBe(true);

		const finalLines = fs
			.readFileSync(eventsPath, 'utf-8')
			.split('\n')
			.filter((line) => line.trim().length > 0);
		const finalRepairedCount = finalLines
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
					event.transitionId === trickyId,
			).length;
		expect(finalRepairedCount).toBe(1);
	});

	test('recoverPreparedTaskRepair lazy recovery finds an already-audited event with a JSON-special transition_id', async () => {
		const trickyId = 'repair-control\nchar-1.1';

		const first = await executeUpdateTaskStatus(
			repairArgs({ transition_id: trickyId }),
			directory,
			context,
		);
		expect(first.success).toBe(true);

		// Calling the lazy-recovery entrypoint directly must be a lock-free no-op
		// once the audit event is present, not a wedge.
		const recovered = await recoverPreparedTaskRepair(
			directory,
			TASK_ID,
			context.sessionID,
		);
		expect(recovered).toBeNull();
	});
});
