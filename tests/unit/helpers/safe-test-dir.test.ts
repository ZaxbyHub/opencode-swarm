import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ACTIVE_STATE_UNLINK_RETRY_DELAYS_MS } from '../../../src/commands/close/unlink-schedule.js';
import { isCanonicalPathWithinRoot } from '../../../src/utils/path-security.js';
import {
	_internals,
	createSafeTestDir,
	safeRmRecursive,
	withSafeTestDir,
} from '../../helpers/safe-test-dir';
import { canonicalTmpDir } from '../../helpers/tmpdir';

const realRmSync = _internals.rmSync;
const realCollectGarbageBestEffort = _internals.collectGarbageBestEffort;
const realWait = _internals.wait;

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

	it('never removes the working directory or its ancestors, even inside the temp root', () => {
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
			expect(() => safeRmRecursive(work)).toThrow('current working directory');
			expect(() => safeRmRecursive(dir)).toThrow('current working directory');
			// …also when the target reaches it through a symlinked parent.
			if (process.platform !== 'win32') {
				fs.symlinkSync(dir, path.join(dir, 'alias'), 'dir');
				const viaLink = path.join(dir, 'alias', 'checkout');
				expect(() => safeRmRecursive(viaLink)).toThrow(
					'current working directory',
				);
			}
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
		// The filesystem root is outside the temp root on every host; cwd is not
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

describe('safeRmRecursive retry shape (issue #3248 class 2)', () => {
	afterEach(() => {
		// Restore the real implementations (AGENTS.md invariant 7: restore the
		// _internals seam after each test).
		_internals.rmSync = realRmSync;
		_internals.collectGarbageBestEffort = realCollectGarbageBestEffort;
		_internals.wait = realWait;
	});

	const restoreInternals = (): void => {
		_internals.rmSync = realRmSync;
		_internals.collectGarbageBestEffort = realCollectGarbageBestEffort;
		_internals.wait = realWait;
	};

	it('retries transient EBUSY until the handle frees, GC-ing and waiting per attempt', () => {
		const { dir, cleanup } = createSafeTestDir('safe-rm-retry-');
		let rmCalls = 0;
		let gcCalls = 0;
		const waitArgs: number[] = [];
		_internals.rmSync = ((target: fs.PathLike, options?: fs.RmOptions) => {
			rmCalls += 1;
			if (rmCalls <= 3) {
				const error = new Error(
					`EBUSY: resource busy or locked, rm '${target}'`,
				) as NodeJS.ErrnoException;
				error.code = 'EBUSY';
				throw error;
			}
			return realRmSync(target, options);
		}) as typeof fs.rmSync;
		_internals.collectGarbageBestEffort = () => {
			gcCalls += 1;
		};
		_internals.wait = (ms: number) => {
			waitArgs.push(ms);
		};

		try {
			safeRmRecursive(dir);
			expect(fs.existsSync(dir)).toBe(false);
			expect(rmCalls).toBe(4);
			// The hedge runs on EVERY failed attempt (not just the first).
			expect(gcCalls).toBe(3);
			// PRR-025: pin the CADENCE, not just the count — a wait(100) →
			// wait(1) mutation would collapse the budget while a count-only
			// assertion stays green. #3260-A: the cadence is the production
			// schedule's head ([25,50,100,...]) since the helper now consumes
			// ACTIVE_STATE_UNLINK_RETRY_DELAYS_MS.
			expect(waitArgs).toEqual([25, 50, 100]);
		} finally {
			restoreInternals();
			cleanup();
		}
	});

	it('exhausts the production-schedule budget and rethrows the original error', () => {
		const { dir, cleanup } = createSafeTestDir('safe-rm-exhaust-');
		let rmCalls = 0;
		const waitArgs: number[] = [];
		_internals.rmSync = ((target: fs.PathLike) => {
			rmCalls += 1;
			const error = new Error(
				`EBUSY: resource busy or locked, rm '${target}'`,
			) as NodeJS.ErrnoException;
			error.code = 'EBUSY';
			throw error;
		}) as typeof fs.rmSync;
		_internals.collectGarbageBestEffort = () => {};
		_internals.wait = (ms: number) => {
			waitArgs.push(ms);
		};

		try {
			expect(() => safeRmRecursive(dir)).toThrow(/EBUSY/);
			// 21 rmSync attempts: one per schedule delay (20) plus ONE final
			// attempt after the schedule is exhausted (window history: ~2.1 s
			// until #3248 raised it to ~10 s; #3260-A re-tied it to the
			// production schedule, ~15.2 s, one source in
			// src/commands/close/unlink-schedule.ts).
			expect(rmCalls).toBe(21);
			// 20 waits — exactly the production schedule array (the final
			// attempt never sleeps; PRR-025 cadence pin generalizes to the
			// full array).
			expect(waitArgs).toEqual([...ACTIVE_STATE_UNLINK_RETRY_DELAYS_MS]);
			// No wait after the final failure: the schedule IS the waits.
			expect(waitArgs.length).toBe(20);
		} finally {
			restoreInternals();
			cleanup();
		}
	});

	it('does not retry non-transient error codes', () => {
		const { dir, cleanup } = createSafeTestDir('safe-rm-eacces-');
		let rmCalls = 0;
		let waitCalls = 0;
		_internals.rmSync = (() => {
			rmCalls += 1;
			const error = new Error(
				'EACCES: permission denied',
			) as NodeJS.ErrnoException;
			error.code = 'EACCES';
			throw error;
		}) as typeof fs.rmSync;
		_internals.collectGarbageBestEffort = () => {};
		_internals.wait = () => {
			waitCalls += 1;
		};

		try {
			expect(() => safeRmRecursive(dir)).toThrow(/EACCES/);
			expect(rmCalls).toBe(1);
			expect(waitCalls).toBe(0);
		} finally {
			restoreInternals();
			cleanup();
		}
	});

	const transientCase = (
		code: string,
		prefix: string,
	): {
		dir: string;
		cleanup: () => void;
		rmCalls: () => number;
	} => {
		const { dir, cleanup } = createSafeTestDir(prefix);
		let calls = 0;
		_internals.rmSync = ((target: fs.PathLike, options?: fs.RmOptions) => {
			calls += 1;
			if (calls <= 2) {
				const error = new Error(
					`${code}: transient hold, rm '${target}'`,
				) as NodeJS.ErrnoException;
				error.code = code;
				throw error;
			}
			return realRmSync(target, options);
		}) as typeof fs.rmSync;
		_internals.collectGarbageBestEffort = () => {};
		_internals.wait = () => {};
		return { dir, cleanup, rmCalls: () => calls };
	};

	// PRR-026: EPERM is the code Windows actually reports for AV/handle
	// holds, and ENOTEMPTY completes the transient predicate at
	// tests/helpers/safe-test-dir.ts — both branches must be exercised, or
	// deleting either code from the predicate leaves the suite green.
	it('retries transient EPERM holds (PRR-026)', () => {
		const { dir, cleanup, rmCalls } = transientCase('EPERM', 'safe-rm-eperm-');
		try {
			safeRmRecursive(dir);
			expect(fs.existsSync(dir)).toBe(false);
			expect(rmCalls()).toBe(3);
		} finally {
			restoreInternals();
			cleanup();
		}
	});

	it('retries transient ENOTEMPTY holds (PRR-026)', () => {
		const { dir, cleanup, rmCalls } = transientCase(
			'ENOTEMPTY',
			'safe-rm-enotempty-',
		);
		try {
			safeRmRecursive(dir);
			expect(fs.existsSync(dir)).toBe(false);
			expect(rmCalls()).toBe(3);
		} finally {
			restoreInternals();
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
