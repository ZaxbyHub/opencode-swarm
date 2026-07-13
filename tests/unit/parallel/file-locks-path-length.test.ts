import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { tryAcquireLock } from '../../../src/parallel/file-locks.js';

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

describe('file lock path portability', () => {
	test('uses a fixed-length lock identity for a long absolute target path', async () => {
		const root = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-lock-path-length-')),
		);
		roots.push(root);
		const relativePath = path.join(
			'evolution',
			'decisions',
			`promotion-${'a'.repeat(64)}.json`,
		);

		const result = await tryAcquireLock(
			root,
			relativePath,
			'evaluation-store',
			'run-1',
		);
		expect(result.acquired).toBe(true);
		const lockEntries = fs.readdirSync(path.join(root, '.swarm', 'locks'));
		expect(lockEntries.length).toBeGreaterThan(0);
		expect(lockEntries.every((entry) => entry.length <= 74)).toBe(true);
		if (result.acquired) await result.lock._release?.();
	});
});
