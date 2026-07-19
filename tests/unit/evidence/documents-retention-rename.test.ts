/**
 * Unit tests for `atomicRenameWithRetry` (issue #1184).
 *
 * Split from `documents-retention.test.ts` to keep both files under the
 * 500-line ceiling (AGENTS.md invariant #7 / FR-006). These tests exercise
 * the retry loop directly with an injectable rename function so they are
 * deterministic on non-Windows hosts.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { atomicRenameWithRetry } from '../../../src/evidence/documents-retention';

describe('atomicRenameWithRetry', () => {
	test('succeeds on first try when no contention', async () => {
		const dir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-rename-')),
		);
		try {
			const src = path.join(dir, 'src.txt');
			const dst = path.join(dir, 'dst.txt');
			await fsp.writeFile(src, 'hello', 'utf8');
			await atomicRenameWithRetry(src, dst);
			expect(await fsp.readFile(dst, 'utf8')).toBe('hello');
			await expect(fsp.stat(src)).rejects.toThrow();
		} finally {
			await fsp.rm(dir, { recursive: true, force: true });
		}
	});

	test('non-retryable error throws immediately (no retry)', async () => {
		let calls = 0;
		const failRename = async () => {
			calls++;
			const err = new Error('ENOSPC') as NodeJS.ErrnoException;
			err.code = 'ENOSPC';
			throw err;
		};
		// The mocked rename ignores the path; use os.tmpdir()-anchored
		// placeholders to honor AGENTS.md invariant #7 (no hardcoded /tmp).
		const src = path.join(os.tmpdir(), 'swarm-rename-src');
		const dst = path.join(os.tmpdir(), 'swarm-rename-dst');
		await expect(atomicRenameWithRetry(src, dst, failRename)).rejects.toThrow();
		expect(calls).toBe(1); // no retry on non-Windows-contention codes
	});

	test('EPERM retried up to 5 times then succeeds', async () => {
		let calls = 0;
		const retryThenSucceed = async (src: string, dst: string) => {
			calls++;
			if (calls < 5) {
				const err = new Error('EPERM') as NodeJS.ErrnoException;
				err.code = 'EPERM';
				throw err;
			}
			await fsp.rename(src, dst);
		};
		const dir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-rename-retry-')),
		);
		try {
			const src = path.join(dir, 'src.txt');
			const dst = path.join(dir, 'dst.txt');
			await fsp.writeFile(src, 'data', 'utf8');
			await atomicRenameWithRetry(src, dst, retryThenSucceed);
			expect(calls).toBe(5);
			expect(await fsp.readFile(dst, 'utf8')).toBe('data');
		} finally {
			await fsp.rm(dir, { recursive: true, force: true });
		}
	});

	test('EPERM exhausted after 5 attempts rethrows', async () => {
		let calls = 0;
		const alwaysFail = async () => {
			calls++;
			const err = new Error('EBUSY') as NodeJS.ErrnoException;
			err.code = 'EBUSY';
			throw err;
		};
		const src = path.join(os.tmpdir(), 'swarm-rename-src');
		const dst = path.join(os.tmpdir(), 'swarm-rename-dst');
		await expect(atomicRenameWithRetry(src, dst, alwaysFail)).rejects.toThrow(
			'EBUSY',
		);
		expect(calls).toBe(5); // exactly RENAME_MAX_ATTEMPTS
	});
});
