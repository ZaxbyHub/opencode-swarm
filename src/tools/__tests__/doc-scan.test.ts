/**
 * Tests for scanDocIndex — verifies that:
 * 1. Skip directories (including Bazel dirs) are pruned before descent
 * 2. Only doc-pattern matching files are indexed
 * 3. Cache validation works correctly
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { scanDocIndex } from '../doc-scan.js';

let tmpDir: string;

function mkfile(relPath: string, content: string): void {
	const fullPath = path.join(tmpDir, relPath);
	fs.mkdirSync(path.dirname(fullPath), { recursive: true });
	fs.writeFileSync(fullPath, content, 'utf-8');
}

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-scan-test-'));
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('scanDocIndex — skip directory pruning', () => {
	test('does not descend into bazel-out', async () => {
		// Put a README inside bazel-out — it must NOT be indexed
		mkfile('bazel-out/k8-fastbuild/bin/README.md', '# Should be skipped');
		// Put a real README at root — must be indexed
		mkfile('README.md', '# Root readme');

		const { manifest } = await scanDocIndex(tmpDir);
		const paths = manifest.files.map((f) => f.path);

		expect(paths).not.toContain('bazel-out/k8-fastbuild/bin/README.md');
		expect(
			paths.some((p) => p.endsWith('README.md') && !p.includes('bazel')),
		).toBe(true);
	});

	test('does not descend into bazel-bin', async () => {
		mkfile('bazel-bin/src/lib/ARCHITECTURE.md', '# Should be skipped');
		mkfile('ARCHITECTURE.md', '# Real architecture doc');

		const { manifest } = await scanDocIndex(tmpDir);
		const paths = manifest.files.map((f) => f.path);

		expect(paths).not.toContain('bazel-bin/src/lib/ARCHITECTURE.md');
		expect(paths.some((p) => p === 'ARCHITECTURE.md')).toBe(true);
	});

	test('does not descend into node_modules', async () => {
		mkfile('node_modules/some-pkg/README.md', '# Package readme');
		mkfile('README.md', '# Project readme');

		const { manifest } = await scanDocIndex(tmpDir);
		const paths = manifest.files.map((f) => f.path);

		expect(paths.some((p) => p.startsWith('node_modules'))).toBe(false);
		expect(paths.some((p) => p === 'README.md')).toBe(true);
	});

	test('does not descend into .git', async () => {
		mkfile('.git/COMMIT_EDITMSG', '# git internal');
		mkfile('README.md', '# Project readme');

		const { manifest } = await scanDocIndex(tmpDir);
		const paths = manifest.files.map((f) => f.path);

		expect(paths.some((p) => p.startsWith('.git'))).toBe(false);
	});

	test('does not descend into target (Maven/Cargo)', async () => {
		mkfile('target/classes/README.md', '# build artifact doc');
		mkfile('README.md', '# Project readme');

		const { manifest } = await scanDocIndex(tmpDir);
		const paths = manifest.files.map((f) => f.path);

		expect(paths.some((p) => p.startsWith('target'))).toBe(false);
		expect(paths).toContain('README.md');
	});

	test('does not descend into .gradle', async () => {
		mkfile('.gradle/caches/README.md', '# gradle cache');
		mkfile('README.md', '# Project readme');

		const { manifest } = await scanDocIndex(tmpDir);
		const paths = manifest.files.map((f) => f.path);

		expect(paths.some((p) => p.startsWith('.gradle'))).toBe(false);
		expect(paths).toContain('README.md');
	});
});

describe('scanDocIndex — doc pattern matching', () => {
	test('indexes README.md files', async () => {
		mkfile('README.md', '# Top-level README');
		mkfile('src/README.md', '# Src README');

		const { manifest } = await scanDocIndex(tmpDir);
		const paths = manifest.files.map((f) => f.path);

		expect(paths).toContain('README.md');
		expect(paths).toContain('src/README.md');
	});

	test('indexes CLAUDE.md and AGENTS.md', async () => {
		mkfile('CLAUDE.md', '# Claude instructions');
		mkfile('AGENTS.md', '# Agents doc');

		const { manifest } = await scanDocIndex(tmpDir);
		const paths = manifest.files.map((f) => f.path);

		expect(paths).toContain('CLAUDE.md');
		expect(paths).toContain('AGENTS.md');
	});

	test('skips .test.ts files even if named *.md pattern is not met', async () => {
		mkfile('src/foo.test.ts', 'test file');
		mkfile('README.md', '# readme');

		const { manifest } = await scanDocIndex(tmpDir);
		const paths = manifest.files.map((f) => f.path);

		expect(paths.some((p) => p.endsWith('.test.ts'))).toBe(false);
	});
});

describe('scanDocIndex — symlink handling', () => {
	test('indexes a symlinked doc file', async () => {
		// Create a real file and a symlink to it — the symlink should be indexed
		const realPath = path.join(tmpDir, 'docs', 'real-readme.md');
		fs.mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
		fs.writeFileSync(realPath, '# Real file content', 'utf-8');

		const linkPath = path.join(tmpDir, 'docs', 'linked-readme.md');
		try {
			fs.symlinkSync(realPath, linkPath);
		} catch {
			// Skip on platforms that disallow symlinks in this context
			return;
		}

		const { manifest } = await scanDocIndex(tmpDir);
		const paths = manifest.files.map((f) => f.path);

		// Both real and symlinked files should be indexed
		expect(paths.some((p) => p.includes('real-readme.md'))).toBe(true);
		expect(paths.some((p) => p.includes('linked-readme.md'))).toBe(true);
	});

	test('does not recurse into a symlinked directory (avoids cycles)', async () => {
		mkfile('README.md', '# Project readme');
		// Create a symlink that points to the project root (cycle)
		const linkPath = path.join(tmpDir, 'loop');
		try {
			fs.symlinkSync(tmpDir, linkPath);
		} catch {
			return; // Skip on unsupported platforms
		}

		// Must complete without infinite recursion
		const { manifest } = await scanDocIndex(tmpDir);
		const paths = manifest.files.map((f) => f.path);

		// loop/README.md should NOT be indexed (directory symlink not followed)
		expect(paths.some((p) => p.startsWith('loop/'))).toBe(false);
		expect(paths).toContain('README.md');
	});

	test('does not index a symlink whose target lies outside the project root', async () => {
		// /etc/hosts is a real file on Linux/macOS outside any tmpDir
		const externalTarget = '/etc/hosts';
		if (!fs.existsSync(externalTarget)) return; // skip on platforms without /etc/hosts

		fs.mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
		const linkPath = path.join(tmpDir, 'docs', 'outside.md');
		try {
			fs.symlinkSync(externalTarget, linkPath);
		} catch {
			return; // skip on platforms that disallow symlinks
		}

		mkfile('README.md', '# Real readme');

		const { manifest } = await scanDocIndex(tmpDir);
		const paths = manifest.files.map((f) => f.path);

		// Symlink target is outside the project root — must not be indexed
		expect(paths.some((p) => p.includes('outside.md'))).toBe(false);
		// Real files are still indexed
		expect(paths).toContain('README.md');
	});
});

describe('scanDocIndex — error handling', () => {
	test('returns empty manifest without caching when root directory is unreadable', async () => {
		// Make tmpDir itself unreadable, then call scanDocIndex on a nonexistent path
		const nonExistent = path.join(tmpDir, 'does-not-exist');

		const { manifest, cached } = await scanDocIndex(nonExistent);

		expect(cached).toBe(false);
		expect(manifest.files).toHaveLength(0);
		// Must NOT have written a manifest to disk (the directory doesn't exist)
		const manifestFile = path.join(nonExistent, '.swarm', 'doc-manifest.json');
		expect(fs.existsSync(manifestFile)).toBe(false);
	});
});

describe('scanDocIndex — file cap', () => {
	test('caps indexed files at MAX_INDEXED_FILES (100) and exits walk early', async () => {
		// Create 105 docs matching docs/**/*.md — all would match without the cap
		for (let i = 1; i <= 105; i++) {
			mkfile(`docs/file${String(i).padStart(3, '0')}.md`, `# Doc ${i}`);
		}

		const { manifest } = await scanDocIndex(tmpDir);

		// Must be capped at 100, not 105
		expect(manifest.files.length).toBe(100);
	});
});

describe('scanDocIndex — caching', () => {
	test('returns cached=false on first scan, cached=true on unchanged rescan', async () => {
		mkfile('README.md', '# Project readme');

		const first = await scanDocIndex(tmpDir);
		expect(first.cached).toBe(false);
		expect(first.manifest.files.length).toBeGreaterThan(0);

		const second = await scanDocIndex(tmpDir);
		expect(second.cached).toBe(true);
	});

	test('invalidates cache when a file is modified', async () => {
		const readmePath = path.join(tmpDir, 'README.md');
		mkfile('README.md', '# Original');

		const first = await scanDocIndex(tmpDir);
		expect(first.cached).toBe(false);

		// Touch the file to bump mtime (ensure enough resolution)
		await new Promise((resolve) => setTimeout(resolve, 10));
		fs.writeFileSync(readmePath, '# Modified', 'utf-8');
		const now = Date.now();
		fs.utimesSync(readmePath, now / 1000, now / 1000);

		const second = await scanDocIndex(tmpDir);
		expect(second.cached).toBe(false);
	});
});
