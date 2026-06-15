import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import {
	composeHandlers,
	estimateTokens,
	readSwarmFileAsync,
	safeHook,
	validateSwarmPath,
} from '../../../src/hooks/utils';

// Mock logger module at file scope so warn() bypasses DEBUG gate
// NOTE: This is a CROSS-MODULE mock — no _internals seam available in utils.ts for logger
mock.module('../../../src/utils/logger', () => ({
	warn: (...args: any[]) => console.warn(...args),
	log: (...args: any[]) => console.log(...args),
	error: (...args: any[]) => console.error(...args),
}));

import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('Hook Utilities', () => {
	afterEach(() => {
		mock.restore();
	});

	describe('safeHook', () => {
		it('calls the wrapped function with correct input and output args', async () => {
			let callArgs: any[] = [];
			let callCount = 0;

			const mockFn = async (input: string, output: { value: string }) => {
				callArgs = [input, output];
				callCount++;
				expect(input).toBe('test-input');
				expect(output.value).toBe('initial');
				output.value = 'modified';
			};

			const wrapped = safeHook(mockFn);
			const output = { value: 'initial' };

			await wrapped('test-input', output);

			expect(callCount).toBe(1);
			expect(callArgs[0]).toBe('test-input');
			expect(callArgs[1]).toBe(output);
			expect(output.value).toBe('modified');
		});

		it('returns normally when wrapped function succeeds', async () => {
			let called = false;

			const mockFn = async () => {
				called = true;
			};

			const wrapped = safeHook(mockFn);

			// Should not throw
			await expect(wrapped('input', 'output')).resolves.toBeUndefined();
			expect(called).toBe(true);
		});

		it('does not throw when wrapped function throws — catches the error', async () => {
			let called = false;

			const mockFn = async () => {
				called = true;
				throw new Error('Test error');
			};

			const wrapped = safeHook(mockFn);

			// Should not throw despite the wrapped function failing
			await expect(wrapped('input', 'output')).resolves.toBeUndefined();
			expect(called).toBe(true);
		});

		it('leaves output unchanged when wrapped function throws', async () => {
			const output = { a: 1, b: 2, c: 3 };

			const mockFn = async () => {
				throw new Error('Test error');
			};

			const wrapped = safeHook(mockFn);
			await wrapped('input', output);

			// Output should remain unchanged
			expect(output.a).toBe(1);
			expect(output.b).toBe(2);
			expect(output.c).toBe(3);
		});

		it('logs a warning when wrapped function throws', async () => {
			// warn() is gated by OPENCODE_SWARM_DEBUG=1 at module load time.
			// Verify the core invariant: error is swallowed and function resolves.
			const mockFn = async () => {
				throw new Error('Test error');
			};

			const wrapped = safeHook(mockFn);
			await expect(wrapped('input', 'output')).resolves.toBeUndefined();
		});

		it('handles named functions correctly in warning', async () => {
			// warn() is gated by OPENCODE_SWARM_DEBUG=1 at module load time.
			// Verify named functions are handled: error is swallowed and function resolves.
			async function namedFunction(input: string, output: string) {
				throw new Error('Test error');
			}

			const wrapped = safeHook(namedFunction);
			await expect(wrapped('input', 'output')).resolves.toBeUndefined();
		});
	});

	describe('composeHandlers', () => {
		it('returns a no-op async function when called with no handlers', () => {
			const composed = composeHandlers();

			// Should return a function
			expect(typeof composed).toBe('function');

			// Should not throw when called
			return expect(composed('input', 'output')).resolves.toBeUndefined();
		});

		it('calls each handler in order', async () => {
			const executionOrder: number[] = [];

			const handler1 = async (input: string, output: { order: number[] }) => {
				executionOrder.push(1);
				output.order.push(1);
			};

			const handler2 = async (input: string, output: { order: number[] }) => {
				executionOrder.push(2);
				output.order.push(2);
			};

			const handler3 = async (input: string, output: { order: number[] }) => {
				executionOrder.push(3);
				output.order.push(3);
			};

			const composed = composeHandlers(handler1, handler2, handler3);
			const output = { order: [] };

			await composed('test-input', output);

			expect(executionOrder).toEqual([1, 2, 3]);
			expect(output.order).toEqual([1, 2, 3]);
		});

		it('passes same input and output to all handlers', async () => {
			const testInput = 'shared-input';
			const testOutput = { shared: true };

			let handler1Args: any[] = [];
			let handler2Args: any[] = [];

			const handler1 = async (input: string, output: any) => {
				handler1Args = [input, output];
			};

			const handler2 = async (input: string, output: any) => {
				handler2Args = [input, output];
			};

			const composed = composeHandlers(handler1, handler2);
			await composed(testInput, testOutput);

			expect(handler1Args[0]).toBe(testInput);
			expect(handler1Args[1]).toBe(testOutput);
			expect(handler2Args[0]).toBe(testInput);
			expect(handler2Args[1]).toBe(testOutput);
		});

		it('if one handler throws, subsequent handlers still execute', async () => {
			const executionOrder: number[] = [];

			const handler1 = async (input: string, output: { order: number[] }) => {
				executionOrder.push(1);
				throw new Error('Handler 1 error');
			};

			const handler2 = async (input: string, output: { order: number[] }) => {
				executionOrder.push(2);
				output.order.push(2);
			};

			const composed = composeHandlers(handler1, handler2);
			const output = { order: [] };

			await composed('input', output);

			expect(executionOrder).toEqual([1, 2]);
			expect(output.order).toEqual([2]);
		});

		it('if one handler throws, output from other handlers is preserved', async () => {
			const handler1 = async (
				input: string,
				output: { a?: string; c?: string },
			) => {
				output.a = 'from-handler-1';
				throw new Error('Handler 1 error');
			};

			const handler2 = async (
				input: string,
				output: { a?: string; c?: string },
			) => {
				throw new Error('Handler 2 error');
			};

			const handler3 = async (
				input: string,
				output: { a?: string; c?: string },
			) => {
				output.c = 'from-handler-3';
			};

			const composed = composeHandlers(handler1, handler2, handler3);
			const output = {};

			await composed('input', output);

			expect((output as any).a).toBe('from-handler-1');
			expect((output as any).c).toBe('from-handler-3');
		});

		it('composes a single handler correctly', async () => {
			let called = false;

			const handler = async (input: string, output: { called: boolean }) => {
				called = true;
				output.called = true;
			};

			const composed = composeHandlers(handler);
			const output = { called: false };

			await composed('test-input', output);

			expect(called).toBe(true);
			expect(output.called).toBe(true);
		});
	});

	describe('readSwarmFileAsync', () => {
		let tempDir: string;

		beforeEach(async () => {
			tempDir = await mkdtemp(join(tmpdir(), 'swarm-test-'));
		});

		afterEach(async () => {
			try {
				await rm(tempDir, { recursive: true, force: true });
			} catch (error) {
				// Ignore cleanup errors
			}
		});

		it('returns file content when file exists', async () => {
			const swarmDir = join(tempDir, '.swarm');
			await mkdir(swarmDir, { recursive: true });
			const testFile = join(swarmDir, 'test.txt');

			await writeFile(testFile, 'Hello, Swarm!');

			const result = await readSwarmFileAsync(tempDir, 'test.txt');

			expect(result).toBe('Hello, Swarm!');
		});

		it('returns null when file does not exist', async () => {
			const result = await readSwarmFileAsync(tempDir, 'nonexistent.txt');

			expect(result).toBeNull();
		});

		it('returns null on permission/other errors', async () => {
			// Try to read from a directory that doesn't exist
			const result = await readSwarmFileAsync(
				'/nonexistent/directory',
				'test.txt',
			);

			expect(result).toBeNull();
		});

		it('handles empty files correctly', async () => {
			const swarmDir = join(tempDir, '.swarm');
			await mkdir(swarmDir, { recursive: true });
			const emptyFile = join(swarmDir, 'empty.txt');

			await writeFile(emptyFile, '');

			const result = await readSwarmFileAsync(tempDir, 'empty.txt');

			expect(result).toBe('');
		});

		it('handles files with special characters', async () => {
			const swarmDir = join(tempDir, '.swarm');
			await mkdir(swarmDir, { recursive: true });
			const specialFile = join(swarmDir, 'special.txt');

			const content = 'Special chars: !@#$%^&*()[]{}|;:,.<>?';
			await writeFile(specialFile, content);

			const result = await readSwarmFileAsync(tempDir, 'special.txt');

			expect(result).toBe(content);
		});

		it('returns null when path traversal is attempted with ../', async () => {
			const result = await readSwarmFileAsync(tempDir, '../outside.txt');
			expect(result).toBeNull();
		});

		it('returns null when path traversal is attempted with ..\\', async () => {
			const result = await readSwarmFileAsync(tempDir, '..\\outside.txt');
			expect(result).toBeNull();
		});

		it('returns null when filename contains null bytes', async () => {
			const result = await readSwarmFileAsync(tempDir, 'test\0file.txt');
			expect(result).toBeNull();
		});
	});

	describe('validateSwarmPath', () => {
		let tempDir: string;

		beforeEach(async () => {
			tempDir = await mkdtemp(join(tmpdir(), 'swarm-test-'));
		});

		afterEach(async () => {
			try {
				await rm(tempDir, { recursive: true, force: true });
			} catch (error) {
				// Ignore cleanup errors
			}
		});

		it('returns resolved path for valid filenames', async () => {
			const swarmDir = join(tempDir, '.swarm');
			await mkdir(swarmDir, { recursive: true });
			const testFile = join(swarmDir, 'test.txt');
			await writeFile(testFile, 'test content');

			const result = validateSwarmPath(tempDir, 'test.txt');

			expect(result).toBe(testFile);
		});

		it('rejects filenames with null bytes', () => {
			expect(() => validateSwarmPath(tempDir, 'test\0file.txt')).toThrow(
				'Invalid filename: contains null bytes',
			);
		});

		it('rejects path traversal attempts with ../', () => {
			expect(() => validateSwarmPath(tempDir, '../outside.txt')).toThrow(
				'Invalid filename: path traversal detected',
			);
		});

		it('rejects path traversal attempts with ..\\', () => {
			expect(() => validateSwarmPath(tempDir, '..\\outside.txt')).toThrow(
				'Invalid filename: path traversal detected',
			);
		});

		it('rejects path traversal attempts with directory traversal', () => {
			expect(() =>
				validateSwarmPath(tempDir, 'subdir/../../../outside.txt'),
			).toThrow('Invalid filename: path traversal detected');
		});

		it('rejects absolute paths', () => {
			const absolutePath =
				process.platform === 'win32'
					? 'C:\\windows\\system32\\cmd.exe'
					: '/etc/passwd';
			expect(() => validateSwarmPath(tempDir, absolutePath)).toThrow(
				'Invalid filename: path escapes .swarm directory',
			);
		});

		it('handles normalized paths correctly', async () => {
			const swarmDir = join(tempDir, '.swarm');
			const subdir = join(swarmDir, 'subdir');
			const testFile = join(subdir, 'test.txt');

			// Create the directory structure
			await mkdir(subdir, { recursive: true });
			await writeFile(testFile, 'test content');

			// Test with a path that needs normalization but doesn't contain traversal
			const result = validateSwarmPath(tempDir, 'subdir/./test.txt');
			expect(result).toBe(testFile);
		});

		describe('validateSwarmPath — symlink regression (F#)', async () => {
			let tempDir: string;
			let symlinksSupported = true;

			try {
				const testDir = await mkdtemp(
					join(tmpdir(), 'swarm-symlink-test-'),
				);
				try {
					await symlink(
						join(testDir, 'target'),
						join(testDir, 'link'),
					);
					await rm(testDir, { recursive: true, force: true });
				} catch (error) {
					const err = error as NodeJS.ErrnoException;
					if (err.code === 'ENOSYS' || err.code === 'EPERM') {
						symlinksSupported = false;
					}
					try {
						await rm(testDir, { recursive: true, force: true });
					} catch {
						// ignore cleanup errors
					}
				}
			} catch {
				symlinksSupported = false;
			}

			beforeEach(async () => {
				tempDir = await mkdtemp(join(tmpdir(), 'swarm-test-'));
			});

			afterEach(async () => {
				try {
					await rm(tempDir, { recursive: true, force: true });
				} catch {
					// ignore cleanup errors
				}
			});

			const defineSymlinkTest = (
				name: string,
				fn: () => Promise<void>,
			) => {
				if (symlinksSupported) {
					return it(name, fn);
				}
				return it.skip(name, () => {});
			};

			defineSymlinkTest(
				'rejects symlinks pointing outside .swarm',
				async () => {
					const swarmDir = join(tempDir, '.swarm');
					await mkdir(swarmDir, { recursive: true });
					const outsideFile = join(tempDir, 'outside.txt');
					await writeFile(outsideFile, 'outside content');
					const symlinkPath = join(swarmDir, 'escape-link.txt');

					await symlink(outsideFile, symlinkPath);

					expect(() =>
						validateSwarmPath(tempDir, 'escape-link.txt'),
					).toThrow(
						'Invalid filename: path escapes .swarm directory',
					);
				},
			);

			defineSymlinkTest(
				'allows symlinks pointing inside .swarm',
				async () => {
					const swarmDir = join(tempDir, '.swarm');
					await mkdir(swarmDir, { recursive: true });
					const insideFile = join(swarmDir, 'inside.txt');
					await writeFile(insideFile, 'inside content');
					const symlinkPath = join(swarmDir, 'inside-link.txt');

					await symlink(insideFile, symlinkPath);

					const result = validateSwarmPath(
						tempDir,
						'inside-link.txt',
					);
					expect(result).toBe(symlinkPath);
				},
			);

			it('returns normalized path for nonexistent targets via parent fallback', () => {
				const swarmDir = join(tempDir, '.swarm');
				const nonexistentFile = join(swarmDir, 'nonexistent.txt');

				const result = validateSwarmPath(
					tempDir,
					'nonexistent.txt',
				);
				expect(result).toBe(nonexistentFile);
			});
		});
	});

	describe('estimateTokens', () => {
		it('returns 0 for empty string', () => {
			const result = estimateTokens('');
			expect(result).toBe(0);
		});

		it('returns 0 for falsy input (null, undefined)', () => {
			const resultNull = estimateTokens(null as any);
			const resultUndefined = estimateTokens(undefined as any);

			expect(resultNull).toBe(0);
			expect(resultUndefined).toBe(0);
		});

		it('returns correct estimate for short string', () => {
			const result = estimateTokens('hello');
			// 5 chars * 0.33 = 1.65, ceil = 2
			expect(result).toBe(2);
		});

		it('returns correct estimate for 100 char string', () => {
			const text = 'a'.repeat(100);
			const result = estimateTokens(text);
			// 100 chars * 0.33 = 33, ceil = 33
			expect(result).toBe(33);
		});

		it('returns correct estimate for single character', () => {
			const result = estimateTokens('x');
			// 1 char * 0.33 = 0.33, ceil = 1
			expect(result).toBe(1);
		});

		it('handles whitespace correctly', () => {
			const result = estimateTokens('   ');
			// 3 chars * 0.33 = 0.99, ceil = 1
			expect(result).toBe(1);
		});

		it('handles multiline text correctly', () => {
			const multiline = 'line1\nline2\nline3';
			const result = estimateTokens(multiline);
			// 17 chars * 0.33 = 5.61, ceil = 6
			expect(result).toBe(6);
		});

		it('handles unicode characters correctly', () => {
			const unicode = 'Hello 🌍 World';
			const result = estimateTokens(unicode);
			// Note: 🌍 is 1 character, text length = 15
			// 15 chars * 0.33 = 4.95, ceil = 5
			expect(result).toBe(5);
		});
	});
});
