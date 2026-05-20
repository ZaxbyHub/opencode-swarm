import { beforeEach, describe, expect, it, vi } from 'bun:test';
import { execFileSync } from 'node:child_process';
import type { ToolContext } from '@opencode-ai/plugin';
import { diff } from '../../../src/tools/diff';

// Mock execFileSync
const mockExecFileSync = vi.fn((cmd: string, args: string[], opts: any) => {
	// Validate cwd - reject null bytes (mimics Node.js behavior)
	if (opts.cwd?.includes('\u0000')) {
		throw new Error(
			"The property 'options.cwd' must be a string or Uint8Array without null bytes.",
		);
	}
	// Return valid git diff output
	return '0\t0\tfile.ts\n';
});

vi.mock('node:child_process', () => ({
	execFileSync: mockExecFileSync,
}));

// Helper to create mock context
function getMockContext(directory: string): ToolContext {
	return {
		sessionID: 'test-session',
		messageID: 'test-message',
		agent: 'test-agent',
		directory,
		worktree: directory,
		abort: new AbortController().signal,
		metadata: () => ({}),
		ask: async () => undefined,
	};
}

describe('diff tool - adversarial security tests', () => {
	const validDirectory = '/valid/project';

	beforeEach(() => {
		mockExecFileSync.mockClear();
	});

	// ============================================
	// BASE REF ATTACK VECTORS
	// ============================================

	describe('base ref malicious inputs', () => {
		it('should reject base ref with shell injection attempt', async () => {
			const result = await diff.execute(
				{ base: 'HEAD; rm -rf /' },
				getMockContext(validDirectory),
			);
			const parsed = JSON.parse(result);
			expect(parsed.error).toContain('invalid base');
		});

		it('should reject base ref with command substitution', async () => {
			const result = await diff.execute(
				{ base: 'HEAD$(whoami)' },
				getMockContext(validDirectory),
			);
			const parsed = JSON.parse(result);
			expect(parsed.error).toContain('invalid base');
		});

		it('should reject base ref with pipe', async () => {
			const result = await diff.execute(
				{ base: 'HEAD | cat /etc/passwd' },
				getMockContext(validDirectory),
			);
			const parsed = JSON.parse(result);
			expect(parsed.error).toContain('invalid base');
		});

		it('should reject base ref with backticks', async () => {
			const result = await diff.execute(
				{ base: 'HEAD`id`' },
				getMockContext(validDirectory),
			);
			const parsed = JSON.parse(result);
			expect(parsed.error).toContain('invalid base');
		});

		it('should reject base ref with semicolon injection', async () => {
			const result = await diff.execute(
				{ base: 'HEAD; cat /etc/passwd' },
				getMockContext(validDirectory),
			);
			const parsed = JSON.parse(result);
			expect(parsed.error).toContain('invalid base');
		});

		it('should reject base ref with newlines', async () => {
			const result = await diff.execute(
				{ base: 'HEAD\nmalicious' },
				getMockContext(validDirectory),
			);
			const parsed = JSON.parse(result);
			expect(parsed.error).toContain('invalid base');
		});

		it('should reject base ref with null byte', async () => {
			const result = await diff.execute(
				{ base: 'HEAD\u0000' },
				getMockContext(validDirectory),
			);
			const parsed = JSON.parse(result);
			expect(parsed.error).toContain('invalid base');
		});
	});

	describe('base ref boundary tests', () => {
		it('should reject base ref exceeding MAX_REF_LENGTH (257 chars)', async () => {
			const longBase = 'a'.repeat(257);
			const result = await diff.execute(
				{ base: longBase },
				getMockContext(validDirectory),
			);
			const parsed = JSON.parse(result);
			expect(parsed.error).toContain('exceeds maximum length');
		});

		it('should accept base ref at MAX_REF_LENGTH (256 chars)', async () => {
			const baseAtMax = 'a'.repeat(256);
			const result = await diff.execute(
				{ base: baseAtMax },
				getMockContext(validDirectory),
			);
			const parsed = JSON.parse(result);
			// Should pass validation - mock returns success
			expect(parsed.error).toBeUndefined();
		});

		it('should reject empty string base ref', async () => {
			const result = await diff.execute(
				{ base: '' },
				getMockContext(validDirectory),
			);
			const parsed = JSON.parse(result);
			// Empty string should fail SAFE_REF_PATTERN
			expect(parsed.error).toContain('invalid base');
		});
	});

	// ============================================
	// PATH ATTACK VECTORS
	// ============================================

	describe('path with shell metacharacters', () => {
		it('should reject path with semicolon', async () => {
			const result = await diff.execute(
				{ paths: ['file; rm -rf /'] },
				getMockContext(validDirectory),
			);
			const parsed = JSON.parse(result);
			expect(parsed.error).toContain('invalid paths');
		});

		it('should reject path with pipe', async () => {
			const result = await diff.execute(
				{ paths: ['file | cat /etc/passwd'] },
				getMockContext(validDirectory),
			);
			const parsed = JSON.parse(result);
			expect(parsed.error).toContain('invalid paths');
		});

		it('should reject path with backticks', async () => {
			const result = await diff.execute(
				{ paths: ['file`id`'] },
				getMockContext(validDirectory),
			);
			const parsed = JSON.parse(result);
			expect(parsed.error).toContain('invalid paths');
		});

		it('should reject path with dollar sign', async () => {
			const result = await diff.execute(
				{ paths: ['file$(whoami)'] },
				getMockContext(validDirectory),
			);
			const parsed = JSON.parse(result);
			expect(parsed.error).toContain('invalid paths');
		});

		it('should reject path with single quotes', async () => {
			const result = await diff.execute(
				{ paths: ["file'; rm -rf /"] },
				getMockContext(validDirectory),
			);
			const parsed = JSON.parse(result);
			expect(parsed.error).toContain('invalid paths');
		});

		it('should reject path with double quotes', async () => {
			const result = await diff.execute(
				{ paths: ['file" && malicious'] },
				getMockContext(validDirectory),
			);
			const parsed = JSON.parse(result);
			expect(parsed.error).toContain('invalid paths');
		});

		it('should reject path with parentheses', async () => {
			const result = await diff.execute(
				{ paths: ['file(malicious)'] },
				getMockContext(validDirectory),
			);
			const parsed = JSON.parse(result);
			expect(parsed.error).toContain('invalid paths');
		});

		it('should reject path with braces', async () => {
			const result = await diff.execute(
				{ paths: ['file{$(cmd)}'] },
				getMockContext(validDirectory),
			);
			const parsed = JSON.parse(result);
			expect(parsed.error).toContain('invalid paths');
		});

		it('should reject path with less than', async () => {
			const result = await diff.execute(
				{ paths: ['file < /etc/passwd'] },
				getMockContext(validDirectory),
			);
			const parsed = JSON.parse(result);
			expect(parsed.error).toContain('invalid paths');
		});

		it('should reject path with greater than', async () => {
			const result = await diff.execute(
				{ paths: ['file > /tmp/output'] },
				getMockContext(validDirectory),
			);
			const parsed = JSON.parse(result);
			expect(parsed.error).toContain('invalid paths');
		});
	});

	describe('path option injection', () => {
		it('should reject path starting with dash', async () => {
			const result = await diff.execute(
				{ paths: ['-rf'] },
				getMockContext(validDirectory),
			);
			const parsed = JSON.parse(result);
			expect(parsed.error).toContain('invalid paths');
			expect(parsed.error).toContain('cannot start with "-"');
		});

		it('should reject path starting with double dash', async () => {
			const result = await diff.execute(
				{ paths: ['--help'] },
				getMockContext(validDirectory),
			);
			const parsed = JSON.parse(result);
			expect(parsed.error).toContain('invalid paths');
		});

		it('should reject path that looks like git option', async () => {
			const result = await diff.execute(
				{ paths: ['--version'] },
				getMockContext(validDirectory),
			);
			const parsed = JSON.parse(result);
			expect(parsed.error).toContain('invalid paths');
		});

		it('should reject path starting with dash and space', async () => {
			const result = await diff.execute(
				{ paths: ['-C /etc'] },
				getMockContext(validDirectory),
			);
			const parsed = JSON.parse(result);
			expect(parsed.error).toContain('invalid paths');
		});
	});

	describe('path control characters', () => {
		it('should reject path with null byte', async () => {
			const result = await diff.execute(
				{ paths: ['file\u0000.txt'] },
				getMockContext(validDirectory),
			);
			const parsed = JSON.parse(result);
			expect(parsed.error).toContain('invalid paths');
			expect(parsed.error).toContain('control characters');
		});

		it('should reject path with newline', async () => {
			const result = await diff.execute(
				{ paths: ['file\nmalicious'] },
				getMockContext(validDirectory),
			);
			const parsed = JSON.parse(result);
			expect(parsed.error).toContain('invalid paths');
			expect(parsed.error).toContain('control characters');
		});

		it('should reject path with carriage return', async () => {
			const result = await diff.execute(
				{ paths: ['file\r.txt'] },
				getMockContext(validDirectory),
			);
			const parsed = JSON.parse(result);
			expect(parsed.error).toContain('invalid paths');
			expect(parsed.error).toContain('control characters');
		});

		it('should reject path with tab', async () => {
			const result = await diff.execute(
				{ paths: ['file\t.txt'] },
				getMockContext(validDirectory),
			);
			const parsed = JSON.parse(result);
			expect(parsed.error).toContain('invalid paths');
			expect(parsed.error).toContain('control characters');
		});

		it('should reject path with bell character', async () => {
			const result = await diff.execute(
				{ paths: ['file\u0007.txt'] },
				getMockContext(validDirectory),
			);
			const parsed = JSON.parse(result);
			expect(parsed.error).toContain('invalid paths');
			expect(parsed.error).toContain('control characters');
		});
	});

	describe('path boundary tests', () => {
		it('should reject path exceeding MAX_PATH_LENGTH (501 chars)', async () => {
			const longPath = 'a'.repeat(501);
			const result = await diff.execute(
				{ paths: [longPath] },
				getMockContext(validDirectory),
			);
			const parsed = JSON.parse(result);
			expect(parsed.error).toContain('exceeds maximum length');
		});

		it('should accept path at MAX_PATH_LENGTH (500 chars)', async () => {
			const pathAtMax = 'a'.repeat(500);
			const result = await diff.execute(
				{ paths: [pathAtMax] },
				getMockContext(validDirectory),
			);
			const parsed = JSON.parse(result);
			// Should pass validation - mock returns success
			expect(parsed.error).toBeUndefined();
		});
	});

	describe('path array attacks', () => {
		it('should handle very large array of paths', async () => {
			// Create 1000 paths
			const manyPaths = Array(1000)
				.fill(null)
				.map((_, i) => `file${i}.ts`);
			const result = await diff.execute(
				{ paths: manyPaths },
				getMockContext(validDirectory),
			);
			const parsed = JSON.parse(result);
			// Should either validate and try to run, or reject
			// Large arrays should be handled without crashing
			expect(parsed).toBeDefined();
		});

		it('should reject array with empty string path', async () => {
			const result = await diff.execute(
				{ paths: ['valid.ts', '', 'another.ts'] },
				getMockContext(validDirectory),
			);
			const parsed = JSON.parse(result);
			expect(parsed.error).toContain('invalid paths');
			expect(parsed.error).toContain('empty path');
		});
	});

	describe('path unicode attacks', () => {
		it('should accept valid unicode in paths', async () => {
			const result = await diff.execute(
				{ paths: ['文件.ts', '路径/测试.ts'] },
				getMockContext(validDirectory),
			);
			const parsed = JSON.parse(result);
			// Unicode should be accepted (no shell metacharacters)
			expect(parsed.error).toBeUndefined();
		});

		it('should accept unicode homoglyphs', async () => {
			// Cyrillic 'e' looks like Latin 'e' but is different char
			const result = await diff.execute(
				{ paths: ['filе.ts'] },
				getMockContext(validDirectory),
			);
			const parsed = JSON.parse(result);
			expect(parsed.error).toBeUndefined();
		});
	});

	// ============================================
	// DIRECTORY ATTACK VECTORS
	// ============================================

	describe('directory path traversal attacks', () => {
		it('should attempt git with directory path traversal', async () => {
			const result = await diff.execute(
				{},
				getMockContext('../../../etc/passwd'),
			);
			const parsed = JSON.parse(result);
			// Path traversal passes validation and goes to git
			// Mock returns success, but in real scenario git would fail
			expect(parsed).toBeDefined();
			// Verify execFileSync was called with the traversal path as cwd
			expect(mockExecFileSync).toHaveBeenCalled();
		});

		it('should attempt git with absolute path traversal', async () => {
			const result = await diff.execute({}, getMockContext('/etc/passwd'));
			const parsed = JSON.parse(result);
			// Should pass to git (which will fail in real scenario)
			expect(parsed).toBeDefined();
		});

		it('should reject directory with null byte (Node.js level)', async () => {
			const result = await diff.execute({}, getMockContext('/valid\u0000dir'));
			const parsed = JSON.parse(result);
			// Node.js rejects null bytes in cwd before git is even called
			// Error comes from execFileSync itself
			expect(parsed.error).toContain('null bytes');
		});

		it('should reject whitespace-only directory', async () => {
			const result = await diff.execute({}, getMockContext('   '));
			const parsed = JSON.parse(result);
			expect(parsed.error).toContain('not provided');
		});

		it('should reject empty string directory', async () => {
			const result = await diff.execute({}, getMockContext(''));
			const parsed = JSON.parse(result);
			expect(parsed.error).toContain('not provided');
		});
	});

	describe('directory deeply nested path', () => {
		it('should handle deeply nested path without crashing', async () => {
			// Create a very deep path (1000 levels)
			const deepPath = '/'.repeat(1000) + 'project';
			const result = await diff.execute({}, getMockContext(deepPath));
			const parsed = JSON.parse(result);
			// Should handle gracefully (mock returns success)
			expect(parsed).toBeDefined();
		});
	});

	// ============================================
	// COMBINED ATTACKS
	// ============================================

	describe('combined attack vectors', () => {
		it('should reject base with path traversal combined', async () => {
			const result = await diff.execute(
				{ base: 'HEAD; cat /etc/passwd', paths: ['../../secret.txt'] },
				getMockContext(validDirectory),
			);
			const parsed = JSON.parse(result);
			// Base has semicolon so it fails validation
			expect(parsed.error).toContain('invalid base');
		});

		it('should reject multiple malicious paths', async () => {
			const result = await diff.execute(
				{
					paths: ['-rf', 'file; rm -rf /', '../secret', 'file.txt\u0000'],
				},
				getMockContext(validDirectory),
			);
			const parsed = JSON.parse(result);
			// First malicious path should be caught
			expect(parsed.error).toContain('invalid paths');
		});
	});
});
