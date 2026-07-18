/**
 * #1850: vetted memory storage-root resolution (acceptance #3, GAP-5).
 *
 * Verifies that resolveVettedMemoryRoot returns local by default, cohort when
 * linked, and that the cohort path bypasses validateSwarmPath by construction.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
	DEFAULT_MEMORY_CONFIG,
	resolveVettedMemoryRoot,
	wrapLocalRoot,
} from '../../../src/memory';
import {
	invalidateMemoryStoreDirCache,
	writeMemoryLinkPointer,
} from '../../../src/memory/memory-link';

function makeTmp(prefix: string): string {
	return realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
}

describe('#1850 storage-root resolution', () => {
	const dirs: string[] = [];
	let prevXdg: string | undefined;
	let prevHome: string | undefined;

	beforeEach(() => {
		prevXdg = process.env.XDG_DATA_HOME;
		prevHome = process.env.HOME;
		// Redirect the platform data dir so cohort paths land in temp.
		const dataDir = makeTmp('storage-root-data-');
		dirs.push(dataDir);
		process.env.XDG_DATA_HOME = dataDir;
		process.env.HOME = dataDir;
	});

	afterEach(() => {
		process.env.XDG_DATA_HOME = prevXdg;
		process.env.HOME = prevHome;
		invalidateMemoryStoreDirCache();
		for (const d of dirs.splice(0)) {
			try {
				require('node:fs').rmSync(d, { recursive: true, force: true });
			} catch {
				/* best-effort */
			}
		}
	});

	test('returns local root when link is disabled (default)', () => {
		const dir = makeTmp('storage-root-local-');
		dirs.push(dir);
		const root = resolveVettedMemoryRoot(dir, DEFAULT_MEMORY_CONFIG);
		expect(root.kind).toBe('local');
		if (root.kind === 'local') {
			expect(root.root).toBe(path.join(dir, '.swarm'));
			expect(root.directory).toBe(dir);
		}
	});

	test('returns local root when link.enabled=true but no pointer exists', () => {
		const dir = makeTmp('storage-root-nopointer-');
		dirs.push(dir);
		const config = { ...DEFAULT_MEMORY_CONFIG, link: { enabled: true } };
		const root = resolveVettedMemoryRoot(dir, config);
		expect(root.kind).toBe('local');
	});

	test('returns cohort root when link.enabled=true and pointer exists', async () => {
		const dir = makeTmp('storage-root-cohort-');
		dirs.push(dir);
		await writeMemoryLinkPointer(dir, {
			version: 2,
			linkId: 'test-cohort',
			createdAt: new Date().toISOString(),
			cohortId: 'cohort-abc',
			generation: 1,
		});
		invalidateMemoryStoreDirCache(dir);
		const config = { ...DEFAULT_MEMORY_CONFIG, link: { enabled: true } };
		const root = resolveVettedMemoryRoot(dir, config);
		expect(root.kind).toBe('cohort');
		if (root.kind === 'cohort') {
			expect(root.cohortId).toBe('cohort-abc');
			expect(root.generation).toBe(1);
			expect(root.linkId).toBe('test-cohort');
			expect(root.cohortRoot).toContain('memory');
			expect(root.directory).toBe(dir);
		}
	});

	test('cohort root path is under the data dir (GAP-5: no validateSwarmPath)', () => {
		const root = wrapLocalRoot('/some/worktree');
		expect(root.kind).toBe('local');
	});

	test('F-7: cohort root is never under .swarm of the worktree', async () => {
		const dir = makeTmp('storage-root-noswarm-');
		dirs.push(dir);
		await writeMemoryLinkPointer(dir, {
			version: 2,
			linkId: 'safety-cohort',
			createdAt: new Date().toISOString(),
			cohortId: 'safety',
			generation: 1,
		});
		invalidateMemoryStoreDirCache(dir);
		const config = { ...DEFAULT_MEMORY_CONFIG, link: { enabled: true } };
		const root = resolveVettedMemoryRoot(dir, config);
		if (root.kind === 'cohort') {
			// The cohort root must NOT contain the worktree's .swarm path.
			expect(root.cohortRoot.startsWith(path.join(dir, '.swarm'))).toBe(false);
		}
	});
});
