import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	createSafeTestDir,
	safeRmRecursive,
	withSafeTestDir,
} from '../../helpers/safe-test-dir';

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
			const tmpdir = os.tmpdir();
			const resolvedDir = path.resolve(dir);
			const resolvedTmpdir = path.resolve(tmpdir);
			expect(
				resolvedDir.startsWith(resolvedTmpdir + path.sep) ||
					resolvedDir === resolvedTmpdir,
			).toBe(true);
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

	it('rejects paths outside os.tmpdir()', () => {
		const outside = path.parse(os.tmpdir()).root;
		expect(() => safeRmRecursive(outside)).toThrow('not under os.tmpdir');
	});

	it.skipIf(process.platform === 'win32')(
		'rejects symlinks inside os.tmpdir() that resolve outside os.tmpdir()',
		() => {
			// Windows directory symlinks are junction-like and require different
			// privileges/semantics; non-Windows CI exercises the symlink escape path,
			// while the helper still uses realpath containment on every platform.
			const { dir, cleanup } = createSafeTestDir('safe-rm-symlink-');
			const linkPath = path.join(dir, 'outside-link');
			fs.symlinkSync(process.cwd(), linkPath, 'dir');

			try {
				expect(() => safeRmRecursive(linkPath)).toThrow('escapes os.tmpdir');
				expect(fs.existsSync(process.cwd())).toBe(true);
				expect(fs.existsSync(linkPath)).toBe(true);
			} finally {
				cleanup();
			}
		},
	);
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
