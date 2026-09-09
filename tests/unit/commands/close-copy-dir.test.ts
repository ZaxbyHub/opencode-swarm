/** Focused coverage for the close command's recursive directory copier. */
import { describe, expect, test } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { copyDirRecursive } from '../../../src/commands/close/fs-helpers.js';

describe('copyDirRecursive (FR-015b)', () => {
	test('copies a nested directory tree and returns the file count', async () => {
		const tmp = mkdtempSync(path.join(os.tmpdir(), 'copydir-recursive-test-'));
		try {
			const src = path.join(tmp, 'src');
			const dest = path.join(tmp, 'dest');
			mkdirSync(path.join(src, 'a', 'b'), { recursive: true });
			writeFileSync(path.join(src, 'file1.txt'), 'hello');
			writeFileSync(path.join(src, 'a', 'file2.txt'), 'world');
			writeFileSync(path.join(src, 'a', 'b', 'file3.txt'), 'deep');

			expect(await copyDirRecursive(src, dest)).toBe(3);
			expect(readFileSync(path.join(dest, 'file1.txt'), 'utf8')).toBe('hello');
			expect(readFileSync(path.join(dest, 'a', 'file2.txt'), 'utf8')).toBe(
				'world',
			);
			expect(readFileSync(path.join(dest, 'a', 'b', 'file3.txt'), 'utf8')).toBe(
				'deep',
			);
			expect(existsSync(path.join(dest, 'a', 'b'))).toBe(true);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});
