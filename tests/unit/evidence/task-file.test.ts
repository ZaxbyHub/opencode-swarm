/**
 * Tests for the shared flat-task-file evidence write primitives (#978).
 * Covers the lock that serializes concurrent read-modify-writes to the same
 * .swarm/evidence/{taskId}.json and the atomic temp+rename write.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	atomicWriteFile,
	taskEvidencePath,
	taskEvidenceRelPath,
	withTaskEvidenceLock,
} from '../../../src/evidence/task-file';

let tempDir: string;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), 'task-file-'));
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

describe('taskEvidenceRelPath / taskEvidencePath', () => {
	test('rel path is evidence/{taskId}.json and is the lock key', () => {
		expect(taskEvidenceRelPath('1.1')).toBe(join('evidence', '1.1.json'));
	});

	test('absolute path is under <directory>/.swarm/evidence', () => {
		expect(taskEvidencePath(tempDir, '2.3.1')).toBe(
			join(tempDir, '.swarm', 'evidence', '2.3.1.json'),
		);
	});
});

describe('withTaskEvidenceLock — mutual exclusion', () => {
	test('concurrent callbacks on the SAME taskId do not interleave', async () => {
		const order: string[] = [];

		await Promise.all([
			withTaskEvidenceLock(tempDir, '1.1', 'agentA', async () => {
				order.push('A-start');
				await Bun.sleep(20);
				order.push('A-end');
			}),
			withTaskEvidenceLock(tempDir, '1.1', 'agentB', async () => {
				order.push('B-start');
				await Bun.sleep(20);
				order.push('B-end');
			}),
		]);

		// Whichever ran first, its start/end must be adjacent — no interleave.
		// A broken lock would produce [A-start, B-start, A-end, B-end].
		expect(order).toHaveLength(4);
		expect(order.indexOf('A-end')).toBe(order.indexOf('A-start') + 1);
		expect(order.indexOf('B-end')).toBe(order.indexOf('B-start') + 1);
	});

	test('callbacks on DISJOINT taskIds both complete (no deadlock)', async () => {
		const results = await Promise.all([
			withTaskEvidenceLock(tempDir, '1.1', 'agentA', async () => 'a'),
			withTaskEvidenceLock(tempDir, '2.2', 'agentB', async () => 'b'),
		]);
		expect(results).toEqual(['a', 'b']);
	});

	test('lock is released even when the callback throws', async () => {
		await expect(
			withTaskEvidenceLock(tempDir, '1.1', 'agentA', async () => {
				throw new Error('boom');
			}),
		).rejects.toThrow('boom');

		// A subsequent acquisition on the same taskId must succeed (lock freed).
		const result = await withTaskEvidenceLock(
			tempDir,
			'1.1',
			'agentB',
			async () => 'ok',
		);
		expect(result).toBe('ok');
	});
});

describe('atomicWriteFile', () => {
	test('writes the content and leaves no leftover .tmp file', async () => {
		const target = join(tempDir, 'out.json');
		await atomicWriteFile(target, '{"a":1}');

		expect(readFileSync(target, 'utf-8')).toBe('{"a":1}');
		const leftovers = readdirSync(tempDir).filter((f) => f.includes('.tmp'));
		expect(leftovers).toHaveLength(0);
		expect(readdirSync(tempDir)).toEqual(['out.json']);
	});

	test('overwrites an existing target atomically', async () => {
		const target = join(tempDir, 'out.json');
		await atomicWriteFile(target, 'first');
		await atomicWriteFile(target, 'second');
		expect(readFileSync(target, 'utf-8')).toBe('second');
		expect(readdirSync(tempDir).filter((f) => f.includes('.tmp'))).toHaveLength(
			0,
		);
	});
});
