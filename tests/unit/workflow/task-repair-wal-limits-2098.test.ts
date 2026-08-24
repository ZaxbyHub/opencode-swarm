import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolContext } from '@opencode-ai/plugin/tool';
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
		expect(message).toContain(
			'Preserve this file, reconcile the repair transition, and only then move it aside.',
		);
	});
});

test('lazy repair recovery does not require a plan when no repair WAL exists', async () => {
	const { dir, cleanup } = createSafeTestDir('task-repair-no-wal-2098-');
	try {
		expect(
			await recoverPreparedTaskRepair(dir, TASK_ID, 'repair-no-wal-caller'),
		).toBeNull();
	} finally {
		cleanup();
	}
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
