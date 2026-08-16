import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	readWorkflowWalFile,
	readWorkflowWalFileSync,
	writeWorkflowWalFile,
} from '../../../src/workflow/workflow-wal-file';
import type { TaskTerminalWal } from '../../../src/workflow/workflow-wal-schema';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

function terminalWal(taskId = '1.1'): TaskTerminalWal {
	return {
		version: 2,
		state: 'PREPARED',
		taskId,
		transitionId: 'close-terminal:1.1',
		actor: 'architect',
		oldPlanStatus: 'in_progress',
		newPlanStatus: 'closed',
		oldWorkflowState: 'tests_run',
		newWorkflowState: 'closed',
		generation: 3,
		qaExempt: false,
		recordedAt: '2026-08-15T00:00:00.000Z',
		planIdentityHash: 'a'.repeat(64),
		planEpoch: '11111111-1111-4111-8111-111111111111',
	};
}

function repairWal() {
	return {
		version: 1,
		state: 'PREPARED',
		taskId: '1.1',
		transitionId: 'repair:1.1:3',
		reason: 'Resume exact task',
		actor: 'architect',
		oldPlanStatus: 'completed',
		newPlanStatus: 'in_progress',
		oldWorkflowState: 'complete',
		newWorkflowState: 'idle',
		oldGeneration: 3,
		generation: 4,
		recordedAt: '2026-08-15T00:00:00.000Z',
	} as const;
}

describe('issue #2098 shared workflow WAL trust boundary', () => {
	let directory: string;
	const originalInternals = { ..._internals };

	beforeEach(() => {
		directory = canonicalMkdtemp('workflow-wal-file-2098-');
	});

	afterEach(() => {
		Object.assign(_internals, originalInternals);
		fs.rmSync(directory, { recursive: true, force: true });
	});

	test('async and sync readers use the same exact-task validation', async () => {
		const filePath = path.join(directory, 'terminal.json');
		await writeWorkflowWalFile('task-terminal', filePath, terminalWal('2.1'));

		await expect(
			readWorkflowWalFile('task-terminal', filePath, '1.1'),
		).rejects.toThrow('TASK_TERMINAL_WAL_TASK_MISMATCH');
		expect(() =>
			readWorkflowWalFileSync('task-terminal', filePath, '1.1'),
		).toThrow('TASK_TERMINAL_WAL_TASK_MISMATCH');
	});

	test('malformed UTF-8 fails closed with the exact path and safe remediation', async () => {
		const filePath = path.join(directory, 'repair.json');
		fs.writeFileSync(filePath, Buffer.from([0xc3, 0x28]));

		await expect(
			readWorkflowWalFile('task-repair', filePath, '1.1'),
		).rejects.toThrow(
			`TASK_REPAIR_WAL_UNREADABLE: ${filePath} is not valid UTF-8`,
		);
		await expect(
			readWorkflowWalFile('task-repair', filePath, '1.1'),
		).rejects.toThrow('Preserve this file, reconcile the repair transition');
	});

	test('permission failures retain the WAL kind, exact path, cause, and remediation', async () => {
		const filePath = path.join(directory, 'repair.json');
		const denied = Object.assign(new Error('access denied'), {
			code: 'EACCES',
		});
		_internals.openFile = (async () => {
			throw denied;
		}) as typeof _internals.openFile;

		await expect(
			readWorkflowWalFile('task-repair', filePath, '1.1'),
		).rejects.toThrow(
			`TASK_REPAIR_WAL_UNREADABLE: could not open ${filePath} (access denied)`,
		);
		await expect(
			readWorkflowWalFile('task-repair', filePath, '1.1'),
		).rejects.toThrow('Preserve this file, reconcile the repair transition');
		const wrapped = await readWorkflowWalFile(
			'task-repair',
			filePath,
			'1.1',
		).catch((error: unknown) => error);
		expect((wrapped as Error).cause).toBe(denied);

		_internals.openFile = originalInternals.openFile;
		_internals.openFileSync = (() => {
			throw denied;
		}) as typeof _internals.openFileSync;
		expect(() =>
			readWorkflowWalFileSync('task-repair', filePath, '1.1'),
		).toThrow(`TASK_REPAIR_WAL_UNREADABLE: could not open ${filePath}`);
	});

	test('a path replacement during a multi-chunk read cannot replace the opened WAL', async () => {
		const filePath = path.join(directory, 'repair.json');
		const original = Buffer.from(
			JSON.stringify({ ...repairWal(), padding: 'x'.repeat(96 * 1024) }),
		);
		fs.writeFileSync(filePath, original);
		let cursor = 0;
		let openCalls = 0;
		_internals.openFile = (async () => {
			openCalls++;
			return {
				read: async (buffer: Buffer, offset: number, length: number) => {
					const bytesRead = Math.min(length, original.length - cursor);
					if (bytesRead > 0) {
						original.copy(buffer, offset, cursor, cursor + bytesRead);
						cursor += bytesRead;
						if (cursor === bytesRead)
							fs.writeFileSync(filePath, '{replacement');
					}
					return { bytesRead, buffer };
				},
				close: async () => {},
			} as never;
		}) as typeof _internals.openFile;

		const recovered = await readWorkflowWalFile('task-repair', filePath, '1.1');
		expect(recovered?.transitionId).toBe('repair:1.1:3');
		expect(openCalls).toBe(1);
		expect(fs.readFileSync(filePath, 'utf8')).toBe('{replacement');
	});

	test('invalid v2 plan identity is rejected before terminal recovery', async () => {
		const filePath = path.join(directory, 'terminal.json');
		fs.writeFileSync(
			filePath,
			JSON.stringify({ ...terminalWal(), planIdentityHash: 'not-a-hash' }),
		);

		await expect(
			readWorkflowWalFile('task-terminal', filePath, '1.1'),
		).rejects.toThrow('TASK_TERMINAL_WAL_UNREADABLE');
	});

	test('empty, wrong-version, and mismatched terminal records fail closed', async () => {
		const filePath = path.join(directory, 'terminal.json');
		for (const invalid of [
			'',
			JSON.stringify({ ...terminalWal(), version: 99 }),
			JSON.stringify({ ...terminalWal(), newWorkflowState: 'complete' }),
		]) {
			fs.writeFileSync(filePath, invalid);
			await expect(
				readWorkflowWalFile('task-terminal', filePath, '1.1'),
			).rejects.toThrow(/TASK_TERMINAL_WAL_(?:UNREADABLE|STATE_MISMATCH)/);
			expect(fs.readFileSync(filePath, 'utf8')).toBe(invalid);
		}
	});

	test('the one-MiB boundary is accepted exactly and rejected at cap plus one', async () => {
		const filePath = path.join(directory, 'repair.json');
		const base = JSON.stringify({ ...repairWal(), padding: '' });
		const exact = JSON.stringify({
			...repairWal(),
			padding: 'x'.repeat(1024 * 1024 - Buffer.byteLength(base)),
		});
		expect(Buffer.byteLength(exact)).toBe(1024 * 1024);
		fs.writeFileSync(filePath, exact);
		expect(
			(await readWorkflowWalFile('task-repair', filePath, '1.1'))?.taskId,
		).toBe('1.1');

		fs.appendFileSync(filePath, 'x');
		await expect(
			readWorkflowWalFile('task-repair', filePath, '1.1'),
		).rejects.toThrow('TASK_REPAIR_WAL_OVERSIZE');
	});

	test('small WAL readers reject oversized input without truncating it', async () => {
		const filePath = path.join(directory, 'repair.json');
		const original = Buffer.alloc(1024 * 1024 + 1, 0x61);
		fs.writeFileSync(filePath, original);

		await expect(
			readWorkflowWalFile('task-repair', filePath, '1.1'),
		).rejects.toThrow('TASK_REPAIR_WAL_OVERSIZE');
		expect(fs.readFileSync(filePath)).toEqual(original);
	});

	test('oversized legacy coder WAL is preserved with lane-reconciliation guidance', async () => {
		const filePath = path.join(directory, 'coder.json');
		const handle = fs.openSync(filePath, 'w');
		try {
			fs.ftruncateSync(handle, 64 * 1024 * 1024 + 1);
		} finally {
			fs.closeSync(handle);
		}

		await expect(
			readWorkflowWalFile('coder-settlement', filePath, '1.1'),
		).rejects.toThrow('CODER_SETTLEMENT_WAL_OVERSIZE');
		await expect(
			readWorkflowWalFile('coder-settlement', filePath, '1.1'),
		).rejects.toThrow('reconcile the lane');
		expect(fs.statSync(filePath).size).toBe(64 * 1024 * 1024 + 1);
	}, 20_000);
});
