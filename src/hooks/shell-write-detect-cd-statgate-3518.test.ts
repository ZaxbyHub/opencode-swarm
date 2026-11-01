/**
 * #3518 re-pinned cd-resolution and per-occurrence dedupe contracts, re-homed
 * from the grandfathered shell-write-detect.test.ts (FR-006: that over-cap
 * file may not grow; these tests' fixtures now need REAL directories because
 * the cd tracker stat-gates its cwd mutation — a cd into a missing target or
 * a plain file must not move later siblings' tracked cwd).
 */

import { describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import * as path from 'node:path';
import {
	canonicalMkdtemp,
	removeTreeWithRetry,
} from '../../tests/helpers/tmpdir';
import { detectPosixWrites, resolveWriteTargets } from './shell-write-detect';

describe('resolveWriteTargets — relative cd path resolution (stat-gated)', () => {
	test('cd src && echo hello > output.txt resolves to <cwd>/src/output.txt', () => {
		const root = canonicalMkdtemp('swd3518-cd-src-');
		try {
			mkdirSync(path.join(root, 'src'), { recursive: true });
			const analysis = detectPosixWrites('cd src && echo hello > output.txt');
			const result = resolveWriteTargets(
				'cd src && echo hello > output.txt',
				analysis.writes,
				root,
			);
			const outWrite = result.find((r) => r.original.path === 'output.txt');
			expect(outWrite?.resolvedPath).toBe(path.join(root, 'src', 'output.txt'));
		} finally {
			removeTreeWithRetry(root);
		}
	});

	test('cd subdir in CompoundList resolves relative target', () => {
		// cd subdir && (cd nested && echo > file.txt) — first cd resolves, then nested cd resolves
		const root = canonicalMkdtemp('swd3518-cd-nested-');
		try {
			mkdirSync(path.join(root, 'subdir', 'nested'), { recursive: true });
			const analysis = detectPosixWrites(
				'cd subdir && (cd nested && echo > file.txt)',
			);
			const result = resolveWriteTargets(
				'cd subdir && (cd nested && echo > file.txt)',
				analysis.writes,
				root,
			);
			const fileWrite = result.find((r) => r.original.path === 'file.txt');
			expect(fileWrite?.resolvedPath).toBe(
				path.join(root, 'subdir', 'nested', 'file.txt'),
			);
		} finally {
			removeTreeWithRetry(root);
		}
	});

	test('cd ../../parent resolves multi-level relative path', () => {
		const root = canonicalMkdtemp('swd3518-cd-parent-');
		try {
			// cwd is <root>/project/src; ../../parent is <root>/parent
			mkdirSync(path.join(root, 'project', 'src'), { recursive: true });
			mkdirSync(path.join(root, 'parent'), { recursive: true });
			const writes = [{ category: 'redirect', operator: '>', path: 'out.txt' }];
			const result = resolveWriteTargets(
				'cd ../../parent && echo > out.txt',
				writes,
				path.join(root, 'project', 'src'),
			);
			expect(result[0].resolvedPath).toBe(path.join(root, 'parent', 'out.txt'));
		} finally {
			removeTreeWithRetry(root);
		}
	});

	test('relative path after cd in subshell resolves correctly', () => {
		// (cd varlog && tail -f syslog) — no write but tests context tracking
		const root = canonicalMkdtemp('swd3518-cd-subshell-');
		try {
			mkdirSync(path.join(root, 'varlog'), { recursive: true });
			const writes = [
				{ category: 'redirect', operator: '>>', path: 'app.log' },
			];
			const result = resolveWriteTargets(
				'(cd varlog && echo more >> app.log)',
				writes,
				root,
			);
			expect(result[0].resolvedPath).toBe(path.join(root, 'varlog', 'app.log'));
			expect(result[0].resolved).toBe(true);
		} finally {
			removeTreeWithRetry(root);
		}
	});

	test('a cd into a MISSING target keeps the tracked cwd (#3518 P-2)', () => {
		const root = canonicalMkdtemp('swd3518-cd-missing-');
		try {
			mkdirSync(path.join(root, 'src'), { recursive: true });
			const writes = [{ category: 'redirect', operator: '>', path: 'f' }];
			const result = resolveWriteTargets(
				'cd no-such-dir && echo x > f',
				writes,
				root,
			);
			// The failed cd never moves the cwd: the write resolves at <root>/f
			// (OUTSIDE scope src/), not at a phantom <root>/no-such-dir/f.
			expect(result[0].resolvedPath).toBe(path.join(root, 'f'));
		} finally {
			removeTreeWithRetry(root);
		}
	});
});

describe('dedup key behavior — per-occurrence survival (#3518 P-4)', () => {
	test('multiple same redirects keep one entry per occurrence', () => {
		const result = detectPosixWrites('echo a > f; echo b > f');
		const fWrites = result.writes.filter((w) => w.path === 'f');
		expect(fWrites.length).toBe(2);
		expect(new Set(fWrites.map((w) => w.operator)).size).toBe(2);
	});

	test('identical (category, operator, path) triples stay unique via suffixes', () => {
		const result = detectPosixWrites('cat a > /tmp/out && cat b > /tmp/out');
		const triples = result.writes.map(
			(w) => `${w.category}|${w.operator}|${w.path}`,
		);
		const unique = [...new Set(triples)];
		expect(unique.length).toBe(triples.length);
		expect(result.writes.filter((w) => w.path === '/tmp/out')).toHaveLength(2);
	});
});

describe('resolveWriteTargets — subshell cd tracking (real fixtures)', () => {
	// Moved from the grandfathered base suite (#3518 P-2 CI round): the
	// historical shapes cd'd into synthetic /tmp|/home paths, which only
	// track on hosts where <current-drive>:	mp exists — green locally,
	// red on the CI runner (unit windows-6). Real fixtures below.

	test('subshell cd changes effective cwd for writes inside', () => {
		const root = canonicalMkdtemp('swd3518-sub-1-');
		try {
			mkdirSync(path.join(root, 'tmpdir'), { recursive: true });
			const writes = [{ category: 'redirect', operator: '>', path: 'file' }];
			const result = resolveWriteTargets(
				'(cd tmpdir && echo x > file)',
				writes,
				root,
			);
			expect(result[0].resolvedPath).toBe(path.join(root, 'tmpdir', 'file'));
			expect(result[0].resolved).toBe(true);
		} finally {
			removeTreeWithRetry(root);
		}
	});

	test('cd in parent shell propagates to subshell entry cwd', () => {
		const root = canonicalMkdtemp('swd3518-sub-2-');
		try {
			mkdirSync(path.join(root, 'tmpdir'), { recursive: true });
			const writes = [{ category: 'redirect', operator: '>', path: 'file' }];
			const result = resolveWriteTargets(
				'cd tmpdir && (echo x > file)',
				writes,
				root,
			);
			// The subshell inherits the parent cwd at entry: cd ran BEFORE it.
			expect(result[0].resolvedPath).toBe(path.join(root, 'tmpdir', 'file'));
			expect(result[0].resolved).toBe(true);
		} finally {
			removeTreeWithRetry(root);
		}
	});

	test('nested subshells track cwd independently', () => {
		const root = canonicalMkdtemp('swd3518-sub-3-');
		try {
			mkdirSync(path.join(root, 'home'), { recursive: true });
			const writes = [{ category: 'redirect', operator: '>', path: 'file' }];
			const result = resolveWriteTargets(
				'( (cd home && echo x > file) )',
				writes,
				root,
			);
			expect(result[0].resolvedPath).toBe(path.join(root, 'home', 'file'));
			expect(result[0].resolved).toBe(true);
		} finally {
			removeTreeWithRetry(root);
		}
	});

	test('multiple writes in subshell all use same effective cwd', () => {
		const root = canonicalMkdtemp('swd3518-sub-4-');
		try {
			mkdirSync(path.join(root, 'tmpdir'), { recursive: true });
			const command = '(cd tmpdir && echo a > a.txt && echo b > b.txt)';
			const analysis = detectPosixWrites(command);
			const result = resolveWriteTargets(command, analysis.writes, root);
			const aWrite = result.find((r) => r.original.path === 'a.txt');
			const bWrite = result.find((r) => r.original.path === 'b.txt');
			expect(aWrite?.resolvedPath).toBe(path.join(root, 'tmpdir', 'a.txt'));
			expect(bWrite?.resolvedPath).toBe(path.join(root, 'tmpdir', 'b.txt'));
		} finally {
			removeTreeWithRetry(root);
		}
	});
});
