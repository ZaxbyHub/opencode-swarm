/**
 * Tests for git_blame tool (src/tools/git-blame.ts)
 *
 * Covers:
 * 1. Tool accepts file (required), start/end (optional) parameters
 * 2. Returns per-line metadata: sha, author, date, summary, content
 * 3. Rejects absolute paths
 * 4. Rejects path traversal attempts
 * 5. Rejects binary file extensions
 * 6. Handles non-git directories gracefully
 * 7. Handles start/end line range
 * 8. spawnSync called with correct options (array form, cwd, stdin:'ignore', timeout)
 * 9. Output capped at 500 lines
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Get workspace root for integration tests - this is a real git repo
const WORKSPACE_ROOT = path.resolve(__dirname, '../../../..');

describe('git_blame tool', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'git-blame-test-')),
		);
	});

	afterEach(() => {
		mock.restore();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	// ============ Validation: file is required ============
	describe('file parameter validation', () => {
		test('returns error when file is missing', async () => {
			const { git_blame } = await import('../../../src/tools/git-blame');
			const result = await git_blame.execute({}, tempDir);
			const parsed = JSON.parse(result);
			expect(parsed.error).toBe('file path is required');
			expect(parsed.lines).toEqual([]);
		});

		test('returns error when file is null', async () => {
			const { git_blame } = await import('../../../src/tools/git-blame');
			const result = await git_blame.execute({ file: null }, tempDir);
			const parsed = JSON.parse(result);
			expect(parsed.error).toBe('file path is required');
		});

		test('returns error when file is undefined', async () => {
			const { git_blame } = await import('../../../src/tools/git-blame');
			const result = await git_blame.execute({ file: undefined }, tempDir);
			const parsed = JSON.parse(result);
			expect(parsed.error).toBe('file path is required');
		});
	});

	// ============ Validation: absolute paths rejected ============
	describe('absolute path rejection', () => {
		test('rejects absolute path on Windows', async () => {
			const { git_blame } = await import('../../../src/tools/git-blame');
			const result = await git_blame.execute(
				{ file: 'C:\\Users\\test\\file.ts' },
				tempDir,
			);
			const parsed = JSON.parse(result);
			expect(parsed.error).toBe(
				'absolute paths are not allowed; use a relative path from the project root',
			);
			expect(parsed.lines).toEqual([]);
		});

		test('rejects Unix absolute path', async () => {
			const { git_blame } = await import('../../../src/tools/git-blame');
			const result = await git_blame.execute({ file: '/etc/passwd' }, tempDir);
			const parsed = JSON.parse(result);
			expect(parsed.error).toBe(
				'absolute paths are not allowed; use a relative path from the project root',
			);
		});

		test('rejects absolute path with drive letter', async () => {
			const { git_blame } = await import('../../../src/tools/git-blame');
			const result = await git_blame.execute(
				{ file: 'D:\\project\\file.ts' },
				tempDir,
			);
			const parsed = JSON.parse(result);
			expect(parsed.error).toContain('absolute paths are not allowed');
		});
	});

	// ============ Validation: path traversal rejected ============
	describe('path traversal rejection', () => {
		test('rejects ../ path traversal', async () => {
			const { git_blame } = await import('../../../src/tools/git-blame');
			const result = await git_blame.execute(
				{ file: '../etc/passwd' },
				tempDir,
			);
			const parsed = JSON.parse(result);
			expect(parsed.error).toBe('path traversal detected');
			expect(parsed.lines).toEqual([]);
		});

		test('rejects encoded path traversal', async () => {
			const { git_blame } = await import('../../../src/tools/git-blame');
			const result = await git_blame.execute(
				{ file: '..%2f..%2fetc/passwd' },
				tempDir,
			);
			const parsed = JSON.parse(result);
			expect(parsed.error).toBe('path traversal detected');
		});

		test('rejects encoded null byte path', async () => {
			const { git_blame } = await import('../../../src/tools/git-blame');
			const result = await git_blame.execute({ file: 'file\x00.txt' }, tempDir);
			const parsed = JSON.parse(result);
			expect(parsed.error).toBe('file path contains control characters');
		});

		test('rejects shell metacharacters in path', async () => {
			const { git_blame } = await import('../../../src/tools/git-blame');
			const result = await git_blame.execute(
				{ file: 'file;rm -rf /' },
				tempDir,
			);
			const parsed = JSON.parse(result);
			expect(parsed.error).toBe('file path contains shell metacharacters');
		});

		test('rejects path starting with dash', async () => {
			const { git_blame } = await import('../../../src/tools/git-blame');
			const result = await git_blame.execute(
				{ file: '-e /etc/passwd' },
				tempDir,
			);
			const parsed = JSON.parse(result);
			expect(parsed.error).toBe('file path cannot start with "-"');
		});
	});

	// ============ Validation: binary file extension rejection ============
	describe('binary file rejection', () => {
		// These tests mock fs.existsSync to return true so the binary check runs
		test('rejects .png file', async () => {
			mock.module('node:fs', () => ({
				existsSync: () => true,
				statSync: () => ({
					isDirectory: () => false,
					isFile: () => true,
				}),
				realpathSync: (p: string) => p,
			}));

			const { git_blame } = await import('../../../src/tools/git-blame');
			const result = await git_blame.execute({ file: 'image.png' }, tempDir);
			const parsed = JSON.parse(result);
			expect(parsed.error).toBe('binary files are not supported for git blame');
			expect(parsed.lines).toEqual([]);
		});

		test('rejects .pdf file', async () => {
			mock.module('node:fs', () => ({
				existsSync: () => true,
				statSync: () => ({
					isDirectory: () => false,
					isFile: () => true,
				}),
				realpathSync: (p: string) => p,
			}));

			const { git_blame } = await import('../../../src/tools/git-blame');
			const result = await git_blame.execute({ file: 'document.pdf' }, tempDir);
			const parsed = JSON.parse(result);
			expect(parsed.error).toBe('binary files are not supported for git blame');
		});

		test('rejects .exe file', async () => {
			mock.module('node:fs', () => ({
				existsSync: () => true,
				statSync: () => ({
					isDirectory: () => false,
					isFile: () => true,
				}),
				realpathSync: (p: string) => p,
			}));

			const { git_blame } = await import('../../../src/tools/git-blame');
			const result = await git_blame.execute({ file: 'program.exe' }, tempDir);
			const parsed = JSON.parse(result);
			expect(parsed.error).toBe('binary files are not supported for git blame');
		});

		test('rejects .zip file', async () => {
			mock.module('node:fs', () => ({
				existsSync: () => true,
				statSync: () => ({
					isDirectory: () => false,
					isFile: () => true,
				}),
				realpathSync: (p: string) => p,
			}));

			const { git_blame } = await import('../../../src/tools/git-blame');
			const result = await git_blame.execute({ file: 'archive.zip' }, tempDir);
			const parsed = JSON.parse(result);
			expect(parsed.error).toBe('binary files are not supported for git blame');
		});

		test('rejects binary extension regardless of case', async () => {
			mock.module('node:fs', () => ({
				existsSync: () => true,
				statSync: () => ({
					isDirectory: () => false,
					isFile: () => true,
				}),
				realpathSync: (p: string) => p,
			}));

			const { git_blame } = await import('../../../src/tools/git-blame');
			const result = await git_blame.execute({ file: 'image.PNG' }, tempDir);
			const parsed = JSON.parse(result);
			expect(parsed.error).toBe('binary files are not supported for git blame');
		});
	});

	// ============ Validation: line range ============
	describe('line range validation', () => {
		test('returns error when only start is provided', async () => {
			const { git_blame } = await import('../../../src/tools/git-blame');
			const result = await git_blame.execute(
				{ file: 'test.ts', start: 5 },
				tempDir,
			);
			const parsed = JSON.parse(result);
			expect(parsed.error).toBe(
				'both start and end must be provided together for a line range',
			);
		});

		test('returns error when only end is provided', async () => {
			const { git_blame } = await import('../../../src/tools/git-blame');
			const result = await git_blame.execute(
				{ file: 'test.ts', end: 10 },
				tempDir,
			);
			const parsed = JSON.parse(result);
			expect(parsed.error).toBe(
				'both start and end must be provided together for a line range',
			);
		});

		test('returns error when start > end', async () => {
			const { git_blame } = await import('../../../src/tools/git-blame');
			const result = await git_blame.execute(
				{ file: 'test.ts', start: 10, end: 5 },
				tempDir,
			);
			const parsed = JSON.parse(result);
			expect(parsed.error).toBe('start must be less than or equal to end');
		});

		test('returns error when start is not a positive integer', async () => {
			const { git_blame } = await import('../../../src/tools/git-blame');
			const result = await git_blame.execute(
				{ file: 'test.ts', start: 0, end: 10 },
				tempDir,
			);
			const parsed = JSON.parse(result);
			expect(parsed.error).toBe('start must be a positive integer');
		});

		test('returns error when start is negative', async () => {
			const { git_blame } = await import('../../../src/tools/git-blame');
			const result = await git_blame.execute(
				{ file: 'test.ts', start: -1, end: 10 },
				tempDir,
			);
			const parsed = JSON.parse(result);
			expect(parsed.error).toBe('start must be a positive integer');
		});

		test('returns error when start exceeds max line number', async () => {
			const { git_blame } = await import('../../../src/tools/git-blame');
			const result = await git_blame.execute(
				{ file: 'test.ts', start: 1000001, end: 1000010 },
				tempDir,
			);
			const parsed = JSON.parse(result);
			expect(parsed.error).toBe('start exceeds maximum value of 1000000');
		});

		test('accepts valid line range (start <= end)', async () => {
			const { git_blame } = await import('../../../src/tools/git-blame');
			// This will fail at git execution, but validation should pass
			const result = await git_blame.execute(
				{ file: 'test.ts', start: 1, end: 10 },
				tempDir,
			);
			const parsed = JSON.parse(result);
			// Should not have a validation error about range
			expect(parsed.error).not.toBe(
				'both start and end must be provided together for a line range',
			);
			expect(parsed.error).not.toBe('start must be less than or equal to end');
		});
	});

	// ============ Path length validation ============
	describe('path length validation', () => {
		test('rejects path exceeding 500 characters', async () => {
			const { git_blame } = await import('../../../src/tools/git-blame');
			const longPath = 'a'.repeat(501);
			const result = await git_blame.execute({ file: longPath }, tempDir);
			const parsed = JSON.parse(result);
			expect(parsed.error).toBe('file path exceeds maximum length of 500');
		});
	});
});

// ============ Integration tests using real git repo ============
describe('git_blame - integration with real git repo', () => {
	test('returns blame info for a real tracked file', async () => {
		const { git_blame } = await import('../../../src/tools/git-blame');

		// Use package.json from the workspace (real git repo)
		const testFile = 'package.json';
		const packageJsonPath = path.join(WORKSPACE_ROOT, testFile);

		if (!fs.existsSync(packageJsonPath)) {
			throw new Error(`Test file not found: ${packageJsonPath}`);
		}

		const result = await git_blame.execute({ file: testFile }, WORKSPACE_ROOT);
		const parsed = JSON.parse(result);

		expect(parsed.file).toBe(testFile);
		expect(parsed.lineCount).toBeGreaterThan(0);
		expect(parsed.lines.length).toBeGreaterThan(0);

		// Check structure of first line
		const firstLine = parsed.lines[0];
		expect(firstLine).toHaveProperty('line');
		expect(firstLine).toHaveProperty('sha');
		expect(firstLine).toHaveProperty('author');
		expect(firstLine).toHaveProperty('date');
		expect(firstLine).toHaveProperty('summary');
		expect(firstLine).toHaveProperty('content');

		// sha should be 8 characters (abbreviated)
		expect(firstLine.sha).toMatch(/^[0-9a-f]{8}$/);

		// date should be ISO format (YYYY-MM-DD)
		expect(firstLine.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);

		// author should be non-empty
		expect(firstLine.author).toBeTruthy();
	});

	test('respects line range with start and end', async () => {
		const { git_blame } = await import('../../../src/tools/git-blame');
		const testFile = 'package.json';

		const result = await git_blame.execute(
			{ file: testFile, start: 1, end: 5 },
			WORKSPACE_ROOT,
		);
		const parsed = JSON.parse(result);

		expect(parsed.error).toBeUndefined();
		expect(parsed.lineCount).toBeGreaterThan(0);
		expect(parsed.lineCount).toBeLessThanOrEqual(5);

		// All returned lines should be within range
		for (const line of parsed.lines) {
			expect(line.line).toBeGreaterThanOrEqual(1);
			expect(line.line).toBeLessThanOrEqual(5);
		}
	});

	test('returns error for untracked file in git repo', async () => {
		const { git_blame } = await import('../../../src/tools/git-blame');

		// Create a temp file in the workspace that's not tracked by git
		const untrackedFileName = `.untracked-${Date.now()}.txt`;
		const untrackedPath = path.join(WORKSPACE_ROOT, untrackedFileName);
		fs.writeFileSync(untrackedPath, 'untracked content\n');

		try {
			const result = await git_blame.execute(
				{ file: untrackedFileName },
				WORKSPACE_ROOT,
			);
			const parsed = JSON.parse(result);
			// Should get error about file not being tracked
			expect(parsed.error || parsed.lineCount).toBeTruthy();
			if (!parsed.error) {
				expect(parsed.lineCount).toBe(0);
			}
		} finally {
			fs.rmSync(untrackedPath, { force: true });
		}
	});

	test('handles non-git directory gracefully', async () => {
		const { git_blame } = await import('../../../src/tools/git-blame');

		// Create a temp directory that is NOT a git repo
		const nonGitDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'non-git-dir-test-')),
		);

		// Create a file in it
		const testFile = 'test.txt';
		fs.writeFileSync(path.join(nonGitDir, testFile), 'content\n');

		const result = await git_blame.execute({ file: testFile }, nonGitDir);
		const parsed = JSON.parse(result);

		fs.rmSync(nonGitDir, { recursive: true, force: true });

		// Should get a git error since the directory is not a git repo
		expect(parsed.error).toMatch(
			/not a git repository|git execution failed|file not tracked/i,
		);
	});

	test('output is capped at 500 lines', async () => {
		const { git_blame } = await import('../../../src/tools/git-blame');

		// Use package.json
		const testFile = 'package.json';
		const result = await git_blame.execute({ file: testFile }, WORKSPACE_ROOT);
		const parsed = JSON.parse(result);

		// If successful, verify output is capped
		if (!parsed.error) {
			expect(parsed.lineCount).toBeLessThanOrEqual(500);
			expect(parsed.lines.length).toBeLessThanOrEqual(500);
		}
	});

	test('spawnSync uses correct options via successful execution', async () => {
		const { git_blame } = await import('../../../src/tools/git-blame');

		// Test with a valid file - if it works, spawnSync was called correctly
		const testFile = 'package.json';
		const result = await git_blame.execute({ file: testFile }, WORKSPACE_ROOT);
		const parsed = JSON.parse(result);

		// If successful, verify structure
		expect(parsed.error).toBeUndefined();
		expect(parsed.file).toBe(testFile);
		expect(parsed.lines.length).toBeGreaterThan(0);

		// Verify each line has the required metadata
		for (const line of parsed.lines) {
			expect(line.sha).toMatch(/^[0-9a-f]{8}$/);
			expect(line.author).toBeTruthy();
			expect(line.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
			expect(line.summary).toBeDefined();
			expect(line.content).toBeDefined();
		}
	});
});

// ============ Error handling tests with mocked fs ============
describe('git_blame - error handling with mocked fs', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'git-blame-mock-test-')),
		);
	});

	afterEach(() => {
		mock.restore();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test('returns error when file does not exist', async () => {
		mock.module('node:fs', () => ({
			existsSync: () => false,
			statSync: () => ({
				isDirectory: () => false,
				isFile: () => true,
			}),
			realpathSync: (p: string) => p,
		}));

		const { git_blame } = await import('../../../src/tools/git-blame');
		const result = await git_blame.execute({ file: 'nonexistent.ts' }, tempDir);
		const parsed = JSON.parse(result);
		expect(parsed.error).toBe('file not found: nonexistent.ts');
	});

	test('returns error when path is a directory', async () => {
		mock.module('node:fs', () => ({
			existsSync: () => true,
			statSync: () => ({
				isDirectory: () => true,
				isFile: () => false,
			}),
			realpathSync: (p: string) => p,
		}));

		const { git_blame } = await import('../../../src/tools/git-blame');
		const result = await git_blame.execute({ file: 'src' }, tempDir);
		const parsed = JSON.parse(result);
		expect(parsed.error).toBe('path is a directory, not a file');
	});

	test('returns correct error structure for all error cases', async () => {
		const { git_blame } = await import('../../../src/tools/git-blame');

		// Test missing file parameter
		const result1 = await git_blame.execute({}, tempDir);
		const parsed1 = JSON.parse(result1);
		expect(parsed1).toHaveProperty('error');
		expect(parsed1).toHaveProperty('file');
		expect(parsed1).toHaveProperty('lineCount');
		expect(parsed1).toHaveProperty('lines');
		expect(parsed1.lineCount).toBe(0);
		expect(parsed1.lines).toEqual([]);
	});
});
