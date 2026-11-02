import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	acquireDirectoryWriteLock,
	DIRECTORY_WRITE_LOCK_ANCHOR,
} from '../../../src/parallel/directory-write-lock.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const tempRoots: string[] = [];

afterEach(() => {
	for (const root of tempRoots.splice(0)) {
		try {
			fs.rmSync(root, { recursive: true, force: true });
		} catch {
			// ignore
		}
	}
});

describe('acquireDirectoryWriteLock', () => {
	test('does not create a sibling <dirname>.lock when locking a .swarm directory', async () => {
		const project = canonicalMkdtemp('dir-write-lock-');
		tempRoots.push(project);
		const swarmDir = path.join(project, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });

		const release = await acquireDirectoryWriteLock(swarmDir);
		try {
			expect(fs.existsSync(path.join(project, '.swarm.lock'))).toBe(false);
			expect(
				fs.existsSync(path.join(swarmDir, DIRECTORY_WRITE_LOCK_ANCHOR)),
			).toBe(true);
		} finally {
			await release();
		}
	});
});
