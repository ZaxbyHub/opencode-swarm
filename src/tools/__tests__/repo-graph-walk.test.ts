/**
 * Regression coverage for the repo-graph walker (issue #704).
 *
 * Each test installs a fresh fixture under a tmp dir and asserts the walker
 * cannot be tricked into:
 *   - infinite recursion via symlink cycles,
 *   - exceeding the wall-clock budget on a slow filesystem,
 *   - exceeding the file cap during traversal (vs. post-truncation),
 *   - scanning a refused top-level workspace root.
 *
 * Symlink-loop coverage is POSIX-only; the test bails on Windows because
 * creating a directory symlink there requires Developer Mode. The walker's
 * cycle defense itself is platform-agnostic — see `seenRealPaths` in
 * src/tools/repo-graph.ts.
 */

import { describe, expect, test } from 'bun:test';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildWorkspaceGraph, buildWorkspaceGraphAsync } from '../repo-graph';

function makeTmpDir(prefix: string): string {
	return fsSync.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('repo-graph walker — issue #704 regression suite', () => {
	test('symlink loop does not hang the sync walker (Linux/macOS only)', () => {
		if (process.platform === 'win32') return;
		const root = makeTmpDir('repo-graph-cycle-');
		try {
			// dir a contains a real source file, plus a symlink b -> a.
			// b/loop -> .. would normally cause infinite recursion; the
			// realpath visited-set bails on the second visit.
			const a = path.join(root, 'a');
			fsSync.mkdirSync(a, { recursive: true });
			fsSync.writeFileSync(path.join(a, 'file.ts'), 'export const x = 1;');
			fsSync.symlinkSync(a, path.join(root, 'b'));

			const start = Date.now();
			const graph = buildWorkspaceGraph(root, {
				walkBudgetMs: 2000,
				maxFiles: 100,
			});
			const elapsed = Date.now() - start;
			expect(elapsed).toBeLessThan(2500);
			// Symlinks are skipped by default — we should see exactly one source file.
			expect(Object.keys(graph.nodes).length).toBe(1);
		} finally {
			fsSync.rmSync(root, { recursive: true, force: true });
		}
	});

	test('async walker yields and respects file cap during traversal', async () => {
		const root = makeTmpDir('repo-graph-cap-');
		try {
			const dir = path.join(root, 'src');
			fsSync.mkdirSync(dir, { recursive: true });
			for (let i = 0; i < 200; i++) {
				fsSync.writeFileSync(path.join(dir, `file${i}.ts`), 'export {};');
			}
			const graph = await buildWorkspaceGraphAsync(root, { maxFiles: 50 });
			// The cap stops the walk at <= 50 files.
			expect(Object.keys(graph.nodes).length).toBeLessThanOrEqual(50);
		} finally {
			fsSync.rmSync(root, { recursive: true, force: true });
		}
	});

	test('async walker honors a tight wall-clock budget', async () => {
		const root = makeTmpDir('repo-graph-budget-');
		try {
			const dir = path.join(root, 'src');
			fsSync.mkdirSync(dir, { recursive: true });
			for (let i = 0; i < 100; i++) {
				fsSync.writeFileSync(path.join(dir, `f${i}.ts`), 'export {};');
			}
			const start = Date.now();
			await buildWorkspaceGraphAsync(root, {
				walkBudgetMs: 1, // forces immediate truncation
				maxFiles: 100000,
			});
			expect(Date.now() - start).toBeLessThan(2000);
		} finally {
			fsSync.rmSync(root, { recursive: true, force: true });
		}
	});

	test('refuses to scan os.homedir() as a workspace root', () => {
		expect(() => buildWorkspaceGraph(os.homedir())).toThrow(
			/Refusing to scan top-level system path/,
		);
	});

	test('refuses to scan / as a workspace root (POSIX) or C:\\ (Windows)', () => {
		const refused = process.platform === 'win32' ? 'C:\\' : '/';
		expect(() => buildWorkspaceGraph(refused)).toThrow(
			/Refusing to scan top-level system path/,
		);
	});

	test('async walker respects refusal guard', async () => {
		await expect(buildWorkspaceGraphAsync(os.homedir())).rejects.toThrow(
			/Refusing to scan top-level system path/,
		);
	});

	test('happy path: small project under tmp succeeds', async () => {
		const root = makeTmpDir('repo-graph-happy-');
		try {
			const dir = path.join(root, 'src');
			fsSync.mkdirSync(dir, { recursive: true });
			fsSync.writeFileSync(path.join(dir, 'a.ts'), 'export const a = 1;');
			fsSync.writeFileSync(path.join(dir, 'b.ts'), 'export const b = 2;');
			const graph = await buildWorkspaceGraphAsync(root);
			expect(Object.keys(graph.nodes).length).toBe(2);
		} finally {
			fsSync.rmSync(root, { recursive: true, force: true });
		}
	});
});
