import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isCanonicalPathWithinRoot } from '../../../src/utils/path-security.js';
import {
	createSafeTestDir,
	safeRmRecursive,
	withSafeTestDir,
} from '../../helpers/safe-test-dir';
import { canonicalTmpDir } from '../../helpers/tmpdir';

describe('createSafeTestDir', () => {
	it('creates a directory that exists', () => {
		const { dir, cleanup } = createSafeTestDir();
		try {
			expect(fs.existsSync(dir)).toBe(true);
			expect(fs.statSync(dir).isDirectory()).toBe(true);
		} finally {
			cleanup();
		}
	});

	it('creates a directory inside os.tmpdir()', () => {
		const { dir, cleanup } = createSafeTestDir();
		try {
			// The helper now returns a realpath-resolved dir (issue #1729: wraps
			// mkdtempSync in realpathSync so the canonical path matches what
			// production code compares against on macOS, where os.tmpdir()
			// returns the /var/... symlink but the real path is /private/var/...).
			// Compare against the realpath-resolved tmpdir base so the assertion
			// holds on macOS too.
			expect(isCanonicalPathWithinRoot(dir, canonicalTmpDir())).toBe(true);
		} finally {
			cleanup();
		}
	});

	it('creates a directory with the given prefix in the name', () => {
		const customPrefix = 'my-prefix-';
		const { dir, cleanup } = createSafeTestDir(customPrefix);
		try {
			const dirName = path.basename(dir);
			expect(dirName.startsWith(customPrefix)).toBe(true);
		} finally {
			cleanup();
		}
	});

	it('removes the directory when cleanup() is called', () => {
		const { dir, cleanup } = createSafeTestDir();
		expect(fs.existsSync(dir)).toBe(true);
		cleanup();
		expect(fs.existsSync(dir)).toBe(false);
	});

	it('cleanup() is idempotent (calling twice does not throw)', () => {
		const { dir, cleanup } = createSafeTestDir();
		expect(() => {
			cleanup();
			cleanup();
		}).not.toThrow();
		expect(fs.existsSync(dir)).toBe(false);
	});

	it('uses default prefix when none is provided', () => {
		const { dir, cleanup } = createSafeTestDir();
		try {
			const dirName = path.basename(dir);
			expect(dirName).toContain('swarm-safe-test-');
		} finally {
			cleanup();
		}
	});

	it('the created directory is writable (can write and read a file)', () => {
		const { dir, cleanup } = createSafeTestDir();
		try {
			const testFile = path.join(dir, 'test.txt');
			const testContent = 'Hello, world!';
			fs.writeFileSync(testFile, testContent);
			expect(fs.existsSync(testFile)).toBe(true);
			const readContent = fs.readFileSync(testFile, 'utf-8');
			expect(readContent).toBe(testContent);
		} finally {
			cleanup();
		}
	});
});

describe('safeRmRecursive', () => {
	it('removes nested paths under os.tmpdir()', () => {
		const { dir, cleanup } = createSafeTestDir('safe-rm-');
		const nested = path.join(dir, 'nested');
		fs.mkdirSync(nested, { recursive: true });
		fs.writeFileSync(path.join(nested, 'file.txt'), 'data');

		safeRmRecursive(nested);
		expect(fs.existsSync(nested)).toBe(false);
		cleanup();
	});

	it('rejects empty paths before recursive removal', () => {
		expect(() => safeRmRecursive('')).toThrow('non-empty string');
	});

	it('rejects dirname of empty path before recursive removal', () => {
		// path.dirname('') === '.' — the working directory. It must be refused
		// wherever the checkout lives (not only when cwd is outside tmpdir).
		expect(path.dirname('')).toBe('.');
		expect(() => safeRmRecursive(path.dirname(''))).toThrow(
			/current working directory|not under os\.tmpdir/,
		);
	});

	it('never removes the working directory or its ancestors, even inside os.tmpdir()', () => {
		// Regression: with the checkout under $TMPDIR the old guard accepted
		// safeRmRecursive('.') and deleted the whole checkout.
		const { dir, cleanup } = createSafeTestDir('safe-rm-cwd-');
		const work = path.join(dir, 'checkout');
		fs.mkdirSync(path.join(work, 'src'), { recursive: true });
		fs.writeFileSync(path.join(work, 'src', 'keep.ts'), 'export {};');
		const original = process.cwd();
		try {
			process.chdir(work);
			expect(() => safeRmRecursive('.')).toThrow('current working directory');
			expect(() => safeRmRecursive(work)).toThrow(
				'current working directory',
			);
			expect(() => safeRmRecursive(dir)).toThrow('current working directory');
			expect(fs.existsSync(path.join(work, 'src', 'keep.ts'))).toBe(true);
			// A sibling of the working directory is still removable.
			const sibling = path.join(dir, 'scratch');
			fs.mkdirSync(sibling);
			safeRmRecursive(sibling);
			expect(fs.existsSync(sibling)).toBe(false);
		} finally {
			process.chdir(original);
			cleanup();
		}
	});

	it('rejects paths outside os.tmpdir()', () => {
		const outside = path.parse(canonicalTmpDir()).root;
		expect(() => safeRmRecursive(outside)).toThrow('not under os.tmpdir');
	});

	it('rejects symlinks or junctions inside the system temp directory that resolve outside it', () => {
		const { dir, cleanup } = createSafeTestDir('safe-rm-symlink-');
		const linkPath = path.join(dir, 'outside-link');
		// The filesystem root is outside os.tmpdir() on every host; cwd is not
		// (a checkout may itself live under $TMPDIR).
		const outsideTarget = path.parse(canonicalTmpDir()).root;
		fs.symlinkSync(
			outsideTarget,
			linkPath,
			process.platform === 'win32' ? 'junction' : 'dir',
		);

		try {
			expect(() => safeRmRecursive(linkPath)).toThrow('not under os.tmpdir');
			expect(fs.existsSync(outsideTarget)).toBe(true);
			expect(fs.existsSync(linkPath)).toBe(true);
		} finally {
			cleanup();
		}
	});
});

describe('withSafeTestDir', () => {
	it('calls the function with a valid directory', async () => {
		let capturedDir: string | null = null;
		await withSafeTestDir(async (dir) => {
			capturedDir = dir;
			expect(fs.existsSync(dir)).toBe(true);
			expect(fs.statSync(dir).isDirectory()).toBe(true);
		});
		expect(capturedDir).not.toBeNull();
	});

	it('cleans up the directory after the function completes', async () => {
		let capturedDir: string | null = null;
		await withSafeTestDir(async (dir) => {
			capturedDir = dir;
		});
		expect(capturedDir).not.toBeNull();
		expect(fs.existsSync(capturedDir!)).toBe(false);
	});

	it('cleans up even when the function throws', async () => {
		let capturedDir: string | null = null;
		const testError = new Error('Test error');
		await expect(
			withSafeTestDir(async (dir) => {
				capturedDir = dir;
				throw testError;
			}),
		).rejects.toThrow('Test error');
		expect(capturedDir).not.toBeNull();
		expect(fs.existsSync(capturedDir!)).toBe(false);
	});

	it('returns the value from the function', async () => {
		const result = await withSafeTestDir(async () => {
			return 'test-result';
		});
		expect(result).toBe('test-result');
	});

	it('uses custom prefix when provided', async () => {
		await withSafeTestDir(async (dir) => {
			const dirName = path.basename(dir);
			expect(dirName).toContain('my-custom-prefix-');
		}, 'my-custom-prefix-');
	});

	it('works with writable directory operations', async () => {
		await withSafeTestDir(async (dir) => {
			const testFile = path.join(dir, 'test.txt');
			const testContent = 'Writable content';
			fs.writeFileSync(testFile, testContent);
			expect(fs.existsSync(testFile)).toBe(true);
			const readContent = fs.readFileSync(testFile, 'utf-8');
			expect(readContent).toBe(testContent);
		});
	});
});
