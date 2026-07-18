/**
 * #1850: memory link pointer read/write/remove + cache invalidation.
 * Acceptance #1 (independent opt-in), #2 (distinguishable from knowledge link).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
	invalidateMemoryStoreDirCache,
	isMemoryLinked,
	readMemoryLinkPointer,
	removeMemoryLinkPointer,
	resolveMemoryStoreDir,
	writeMemoryLinkPointer,
} from '../../../src/memory/memory-link';

function makeTmp(prefix: string): string {
	return realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
}

describe('#1850 memory link pointer', () => {
	let dir: string;
	const dirs: string[] = [];

	beforeEach(() => {
		dir = makeTmp('memlink-');
		dirs.push(dir);
	});

	afterEach(() => {
		invalidateMemoryStoreDirCache();
		for (const d of dirs.splice(0)) {
			try {
				rmSync(d, { recursive: true, force: true });
			} catch {
				/* best-effort */
			}
		}
	});

	test('read returns null when no pointer exists (default local)', () => {
		expect(readMemoryLinkPointer(dir)).toBeNull();
		expect(isMemoryLinked(dir)).toBe(false);
	});

	test('write + read round-trip preserves all fields', async () => {
		const pointer = {
			version: 2 as const,
			linkId: 'my-cohort',
			createdAt: '2026-07-17T00:00:00.000Z',
			cohortId: 'cohort-abc',
			identitySource: 'remote' as const,
			degraded: false,
			generation: 3,
		};
		await writeMemoryLinkPointer(dir, pointer);
		const read = readMemoryLinkPointer(dir);
		expect(read).not.toBeNull();
		expect(read?.linkId).toBe('my-cohort');
		expect(read?.cohortId).toBe('cohort-abc');
		expect(read?.generation).toBe(3);
		expect(read?.version).toBe(2);
		expect(isMemoryLinked(dir)).toBe(true);
	});

	test('pointer file is separate from knowledge link.json', async () => {
		await writeMemoryLinkPointer(dir, {
			version: 2,
			linkId: 'mem-only',
			createdAt: new Date().toISOString(),
		});
		// The memory pointer is at .swarm/memory-link.json, NOT .swarm/link.json.
		expect(existsSync(path.join(dir, '.swarm', 'memory-link.json'))).toBe(true);
		expect(existsSync(path.join(dir, '.swarm', 'link.json'))).toBe(false);
	});

	test('remove is idempotent', async () => {
		await writeMemoryLinkPointer(dir, {
			version: 2,
			linkId: 'temp',
			createdAt: new Date().toISOString(),
		});
		await removeMemoryLinkPointer(dir);
		expect(readMemoryLinkPointer(dir)).toBeNull();
		// Removing again does not throw.
		await removeMemoryLinkPointer(dir);
	});

	test('malformed pointer fails open to null', async () => {
		const fs = await import('node:fs/promises');
		const pointerPath = path.join(dir, '.swarm', 'memory-link.json');
		await fs.mkdir(path.dirname(pointerPath), { recursive: true });
		await fs.writeFile(pointerPath, '{ not valid json', 'utf-8');
		expect(readMemoryLinkPointer(dir)).toBeNull();
	});

	test('resolveMemoryStoreDir returns local .swarm when not linked', () => {
		invalidateMemoryStoreDirCache(dir);
		const resolved = resolveMemoryStoreDir(dir);
		expect(resolved).toBe(path.join(dir, '.swarm'));
	});

	test('resolveMemoryStoreDir returns cohort dir when linked', async () => {
		const dataDir = makeTmp('memlink-data-');
		dirs.push(dataDir);
		process.env.XDG_DATA_HOME = dataDir;
		process.env.HOME = dataDir;
		await writeMemoryLinkPointer(dir, {
			version: 2,
			linkId: 'resolve-cohort',
			createdAt: new Date().toISOString(),
		});
		invalidateMemoryStoreDirCache(dir);
		const resolved = resolveMemoryStoreDir(dir);
		expect(resolved).not.toBe(path.join(dir, '.swarm'));
		expect(resolved).toContain('resolve-cohort');
	});
});
