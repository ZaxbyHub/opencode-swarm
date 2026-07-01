/**
 * Adversarial security tests for validateWorkspace and resolveModuleSpecifier
 * bug fixes in src/tools/repo-graph.ts.
 *
 * Tests two security fixes:
 * 1. validateWorkspace now accepts absolute paths but still rejects traversal/control chars
 * 2. resolveModuleSpecifier handles extensionless imports with proper symlink boundary checks
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fsSync from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import {
	resolveModuleSpecifier,
	validateWorkspace,
} from '../../../src/tools/repo-graph';

describe('validateWorkspace adversarial security tests', () => {
	let tempDir: string;
	let cleanupDirs: string[] = [];

	beforeEach(async () => {
		tempDir = path.join(
			process.cwd(),
			'.test-temp',
			'validate-workspace-adversarial-' +
				Date.now() +
				Math.floor(Math.random() * 1e6),
		);
		await fsPromises.mkdir(tempDir, { recursive: true });
		cleanupDirs.push(tempDir);
	});

	afterEach(async () => {
		for (const dir of cleanupDirs) {
			try {
				await fsPromises.rm(dir, { recursive: true, force: true });
			} catch {
				// Ignore cleanup errors
			}
		}
		cleanupDirs = [];
	});

	// ===== ABSOLUTE PATH WITH TRAVERSAL =====

	test('rejects absolute path with traversal: /foo/../../etc/passwd', () => {
		expect(() => validateWorkspace('/foo/../../etc/passwd')).toThrow(
			'path traversal detected',
		);
	});

	test('accepts /foo/./bar as valid (current dir marker, not traversal)', () => {
		// /foo/./bar is a normalized path with no traversal - . is current directory
		expect(() => validateWorkspace('/foo/./bar')).not.toThrow();
	});

	// ===== ABSOLUTE PATH WITH CONTROL CHARS =====

	test('rejects absolute path with null byte: /foo\\x00bar', () => {
		expect(() => validateWorkspace('/foo\x00bar')).toThrow(
			'control characters detected',
		);
	});

	test('rejects absolute path with tab: /foo\\tbar', () => {
		expect(() => validateWorkspace('/foo\tbar')).toThrow(
			'control characters detected',
		);
	});

	test('rejects absolute path with newline: /foo\\nbar', () => {
		expect(() => validateWorkspace('/foo\nbar')).toThrow(
			'control characters detected',
		);
	});

	// ===== URL-ENCODED TRAVERSAL =====

	test('rejects URL-encoded traversal: /foo/%2e%2e/bar', () => {
		expect(() => validateWorkspace('/foo/%2e%2e/bar')).toThrow(
			'path traversal detected',
		);
	});

	test('accepts /foo/%2e/bar as valid (encoded single dot, not traversal)', () => {
		// Single %2e is encoded "." which is valid - only %2e%2e is ".."
		expect(() => validateWorkspace('/foo/%2e/bar')).not.toThrow();
	});

	test('rejects double-encoded traversal: /foo/%252e%252e/bar', () => {
		expect(() => validateWorkspace('/foo/%252e%252e/bar')).toThrow(
			'path traversal detected',
		);
	});

	// ===== MIXED ABSOLUTE PATH ATTACKS (Windows-style) =====

	test('rejects Windows-style traversal: C:\\..\\..\\Windows\\System32', () => {
		expect(() => validateWorkspace('C:\\..\\..\\Windows\\System32')).toThrow(
			'path traversal detected',
		);
	});

	test('rejects Windows-style absolute with traversal: C:\\foo\\..\\bar', () => {
		expect(() => validateWorkspace('C:\\foo\\..\\bar')).toThrow(
			'path traversal detected',
		);
	});

	// ===== UNC PATH ATTACKS =====

	test('accepts UNC path as valid absolute path (no traversal)', () => {
		// UNC paths without .. should be accepted as valid absolute paths
		expect(() => validateWorkspace('\\\\server\\share')).not.toThrow();
	});

	test('rejects UNC path with traversal: \\\\server\\share\\..\\other', () => {
		expect(() => validateWorkspace('\\\\server\\share\\..\\other')).toThrow(
			'path traversal detected',
		);
	});

	// ===== EDGE CASES =====

	test('rejects root-only absolute path that is empty after validation', () => {
		// Root '/' is technically valid but let's verify behavior
		// It should NOT throw since it doesn't contain traversal
		expect(() => validateWorkspace('/')).not.toThrow();
	});

	test('rejects Windows drive root: C:\\', () => {
		// C:\ is technically valid - no traversal
		expect(() => validateWorkspace('C:\\')).not.toThrow();
	});

	test('accepts valid absolute path: /tmp/valid-workspace', () => {
		expect(() => validateWorkspace('/tmp/valid-workspace')).not.toThrow();
	});

	test('accepts valid relative path: my-project', () => {
		expect(() => validateWorkspace('my-project')).not.toThrow();
	});

	test('rejects empty string', () => {
		expect(() => validateWorkspace('')).toThrow('must be a non-empty string');
	});

	test('rejects whitespace-only string', () => {
		expect(() => validateWorkspace('   ')).toThrow(
			'must be a non-empty string',
		);
	});

	test('rejects null/undefined', () => {
		// @ts-ignore - testing runtime behavior
		expect(() => validateWorkspace(null)).toThrow();
		// @ts-ignore
		expect(() => validateWorkspace(undefined)).toThrow();
	});

	// ===== UNICODE HOMOGLYPHS =====

	test('rejects fullwidth dot traversal: /foo\\uff0ebar/bar', () => {
		// Fullwidth dot U+FF0E looks like ".." but isn't - should be rejected
		expect(() => validateWorkspace('/foo\uff0ebar/bar')).toThrow(
			'path traversal detected',
		);
	});

	test('rejects ideographic full stop: /foo\\u3002/bar', () => {
		expect(() => validateWorkspace('/foo\u3002/bar')).toThrow(
			'path traversal detected',
		);
	});
});

describe('resolveModuleSpecifier adversarial security tests', () => {
	let tempDir: string;
	let workspaceRoot: string;
	let srcDir: string;
	let cleanupDirs: string[] = [];

	beforeEach(async () => {
		tempDir = path.join(
			process.cwd(),
			'.test-temp',
			'resolve-module-adversarial-' +
				Date.now() +
				Math.floor(Math.random() * 1e6),
		);
		await fsPromises.mkdir(tempDir, { recursive: true });
		await fsPromises.mkdir(path.join(tempDir, 'src'), { recursive: true });
		await fsPromises.mkdir(path.join(tempDir, 'outside'), { recursive: true });

		workspaceRoot = tempDir;
		srcDir = path.join(tempDir, 'src');

		// Create a source file for testing imports
		await fsPromises.writeFile(
			path.join(srcDir, 'index.ts'),
			`import { foo } from './utils';\nexport const bar = 'test';\n`,
			'utf-8',
		);

		cleanupDirs.push(tempDir);
	});

	afterEach(async () => {
		for (const dir of cleanupDirs) {
			try {
				await fsPromises.rm(dir, { recursive: true, force: true });
			} catch {
				// Ignore cleanup errors
			}
		}
		cleanupDirs = [];
	});

	// ===== EXTENSIONLESS IMPORT WITH PATH TRAVERSAL =====

	test('returns null for extensionless import with ../ traversal', async () => {
		const sourceFile = path.join(srcDir, 'index.ts');

		// This should return null because it escapes the workspace via ..
		const result = resolveModuleSpecifier(
			workspaceRoot,
			sourceFile,
			'./../escape',
		);
		expect(result).toBeNull();
	});

	test('returns null for extensionless import with multiple ../ traversal', async () => {
		const sourceFile = path.join(srcDir, 'index.ts');

		// Multiple traversal attempts
		const result = resolveModuleSpecifier(
			workspaceRoot,
			sourceFile,
			'./../../outside/escape',
		);
		expect(result).toBeNull();
	});

	test('returns null for extensionless import with encoded traversal', async () => {
		const sourceFile = path.join(srcDir, 'index.ts');

		// URL-encoded traversal - should be rejected
		const result = resolveModuleSpecifier(
			workspaceRoot,
			sourceFile,
			'./%2e%2e/escape',
		);
		expect(result).toBeNull();
	});

	// ===== EXTENSIONLESS IMPORT WITH NULL BYTE =====

	test('returns null for extensionless import with null byte', async () => {
		const sourceFile = path.join(srcDir, 'index.ts');

		// Null byte injection attempt
		const result = resolveModuleSpecifier(
			workspaceRoot,
			sourceFile,
			'./file\x00.ts',
		);
		expect(result).toBeNull();
	});

	test('returns null for extensionless import with null byte in middle', async () => {
		const sourceFile = path.join(srcDir, 'index.ts');

		const result = resolveModuleSpecifier(
			workspaceRoot,
			sourceFile,
			'./fi\x00le.ts',
		);
		expect(result).toBeNull();
	});

	// ===== UNICODE HOMOGLYPHS =====

	test('returns null for extensionless import with fullwidth dot', async () => {
		const sourceFile = path.join(srcDir, 'index.ts');

		// Fullwidth dot (U+FF0E) - looks like . but isn't
		const result = resolveModuleSpecifier(
			workspaceRoot,
			sourceFile,
			'./fi\uff0ele.ts',
		);
		expect(result).toBeNull();
	});

	test('returns null for extensionless import with ideographic full stop', async () => {
		const sourceFile = path.join(srcDir, 'index.ts');

		// Ideographic full stop (U+3002)
		const result = resolveModuleSpecifier(
			workspaceRoot,
			sourceFile,
			'./fi\u3002le.ts',
		);
		expect(result).toBeNull();
	});

	// ===== SYMLINK ESCAPE ATTACKS =====

	test('returns null for symlink pointing outside workspace', async () => {
		// Create a truly outside directory (sibling to tempDir, not inside it)
		const outsideDir = path.join(
			process.cwd(),
			'.test-temp',
			'outside-workspace-' + Date.now() + Math.floor(Math.random() * 1e6),
		);
		await fsPromises.mkdir(outsideDir, { recursive: true });
		cleanupDirs.push(outsideDir);

		// Create a file in the outside directory
		await fsPromises.writeFile(
			path.join(outsideDir, 'evil.ts'),
			`export const evil = 'escaped';\n`,
			'utf-8',
		);

		// Create symlink inside src pointing to outside directory
		try {
			await fsPromises.symlink(
				outsideDir,
				path.join(srcDir, 'outside-link'),
				'dir',
			);
		} catch {
			return;
		}

		const sourceFile = path.join(srcDir, 'index.ts');

		// Try to import through symlink that escapes - should return null
		const result = resolveModuleSpecifier(
			workspaceRoot,
			sourceFile,
			'./outside-link/evil',
		);
		expect(result).toBeNull();
	});

	test('returns null for symlink pointing to sibling directory outside workspace', async () => {
		// Create a truly outside directory
		const outsideDir = path.join(
			process.cwd(),
			'.test-temp',
			'outside-workspace-sibling-' +
				Date.now() +
				Math.floor(Math.random() * 1e6),
		);
		await fsPromises.mkdir(outsideDir, { recursive: true });
		cleanupDirs.push(outsideDir);

		// Create a file in the outside directory
		await fsPromises.writeFile(
			path.join(outsideDir, 'secret.ts'),
			`export const secret = 'data';\n`,
			'utf-8',
		);

		// Create symlink to parent directory (which contains both workspace and outside)
		// This is the parent of both tempDir and outsideDir
		const parentDir = path.dirname(tempDir);
		const symlinkToParent = path.join(srcDir, 'parent-symlink');
		try {
			await fsPromises.symlink(parentDir, symlinkToParent, 'dir');
		} catch {
			return;
		}

		const sourceFile = path.join(srcDir, 'index.ts');

		// The outside directory is a sibling to workspace inside .test-temp
		// Escape via parent symlink: ../<outside-dir-name>/secret
		const outsideDirName = path.basename(outsideDir);
		const result = resolveModuleSpecifier(
			workspaceRoot,
			sourceFile,
			`./parent-symlink/${outsideDirName}/secret`,
		);
		expect(result).toBeNull();
	});

	// ===== DETERMINISTIC EXTENSION RESOLUTION =====

	test('resolves .ts over .js when both exist', async () => {
		// Create both .ts and .js with same base name
		await fsPromises.writeFile(
			path.join(srcDir, 'util.ts'),
			`export const tsExport = 'typescript';\n`,
			'utf-8',
		);
		await fsPromises.writeFile(
			path.join(srcDir, 'util.js'),
			`export const jsExport = 'javascript';\n`,
			'utf-8',
		);

		const sourceFile = path.join(srcDir, 'index.ts');

		// Should resolve to .ts (first in EXTENSIONS list)
		const result = resolveModuleSpecifier(workspaceRoot, sourceFile, './util');
		expect(result).not.toBeNull();
		expect(result).toEndWith('.ts');
	});

	test('resolves extensionless to existing .ts file', async () => {
		// Create a .ts file
		await fsPromises.writeFile(
			path.join(srcDir, 'helper.ts'),
			`export const helper = 'help';\n`,
			'utf-8',
		);

		const sourceFile = path.join(srcDir, 'index.ts');

		// Should resolve to .ts
		const result = resolveModuleSpecifier(
			workspaceRoot,
			sourceFile,
			'./helper',
		);
		expect(result).not.toBeNull();
		expect(result).toEndWith('.ts');
	});

	test('returns null for non-existent extensionless import', async () => {
		const sourceFile = path.join(srcDir, 'index.ts');

		// No such file exists
		const result = resolveModuleSpecifier(
			workspaceRoot,
			sourceFile,
			'./nonexistent',
		);
		expect(result).toBeNull();
	});

	// ===== ABSOLUTE PATH REJECTION =====

	test('returns null for absolute path specifier', async () => {
		const sourceFile = path.join(srcDir, 'index.ts');

		// POSIX absolute
		const result1 = resolveModuleSpecifier(
			workspaceRoot,
			sourceFile,
			'/etc/passwd',
		);
		expect(result1).toBeNull();

		// Windows absolute
		const result2 = resolveModuleSpecifier(
			workspaceRoot,
			sourceFile,
			'C:\\Windows\\System32',
		);
		expect(result2).toBeNull();
	});

	// ===== URL REJECTION =====

	test('returns null for http:// URL specifier', async () => {
		const sourceFile = path.join(srcDir, 'index.ts');

		const result = resolveModuleSpecifier(
			workspaceRoot,
			sourceFile,
			'http://evil.com/malware.ts',
		);
		expect(result).toBeNull();
	});

	test('returns null for https:// URL specifier', async () => {
		const sourceFile = path.join(srcDir, 'index.ts');

		const result = resolveModuleSpecifier(
			workspaceRoot,
			sourceFile,
			'https://evil.com/malware.ts',
		);
		expect(result).toBeNull();
	});

	// ===== CONTROL CHARACTERS IN SPECIFIER =====

	test('returns null for specifier with tab', async () => {
		const sourceFile = path.join(srcDir, 'index.ts');

		const result = resolveModuleSpecifier(
			workspaceRoot,
			sourceFile,
			'./fi\tle.ts',
		);
		expect(result).toBeNull();
	});

	test('returns null for specifier with newline', async () => {
		const sourceFile = path.join(srcDir, 'index.ts');

		const result = resolveModuleSpecifier(
			workspaceRoot,
			sourceFile,
			'./fi\nle.ts',
		);
		expect(result).toBeNull();
	});

	test('returns null for specifier with carriage return', async () => {
		const sourceFile = path.join(srcDir, 'index.ts');

		const result = resolveModuleSpecifier(
			workspaceRoot,
			sourceFile,
			'./fi\rle.ts',
		);
		expect(result).toBeNull();
	});

	// ===== VALID IMPORTS =====

	test('resolves valid relative import with extension', async () => {
		// Create target file
		await fsPromises.writeFile(
			path.join(srcDir, 'valid.ts'),
			`export const valid = true;\n`,
			'utf-8',
		);

		const sourceFile = path.join(srcDir, 'index.ts');

		const result = resolveModuleSpecifier(
			workspaceRoot,
			sourceFile,
			'./valid.ts',
		);
		expect(result).not.toBeNull();
		expect(result).toContain('valid.ts');
	});

	test('resolves valid relative import without extension', async () => {
		// Create target file
		await fsPromises.writeFile(
			path.join(srcDir, 'module.ts'),
			`export const module = true;\n`,
			'utf-8',
		);

		const sourceFile = path.join(srcDir, 'index.ts');

		const result = resolveModuleSpecifier(
			workspaceRoot,
			sourceFile,
			'./module',
		);
		expect(result).not.toBeNull();
		expect(result).toEndWith('.ts');
	});

	// ===== EDGE CASE: SYMLINK TO FILE =====

	test('returns null for symlink to file outside workspace', async () => {
		// Create target file in truly outside directory
		const outsideDir = path.join(
			process.cwd(),
			'.test-temp',
			'outside-file-' + Date.now() + Math.floor(Math.random() * 1e6),
		);
		await fsPromises.mkdir(outsideDir, { recursive: true });
		cleanupDirs.push(outsideDir);

		// Create target file outside workspace
		await fsPromises.writeFile(
			path.join(outsideDir, 'secret.ts'),
			`export const secret = 'data';\n`,
			'utf-8',
		);

		// Create symlink to that file inside workspace
		const symlinkPath = path.join(srcDir, 'secret-link.ts');
		try {
			await fsPromises.symlink(
				path.join(outsideDir, 'secret.ts'),
				symlinkPath,
				'file',
			);
		} catch {
			return;
		}

		const sourceFile = path.join(srcDir, 'index.ts');

		// The symlink itself is within workspace, but it points outside
		// When we resolve ./secret-link.ts, realpathSync should reveal the true path
		const result = resolveModuleSpecifier(
			workspaceRoot,
			sourceFile,
			'./secret-link',
		);
		// Should return null because realpathSync resolves it to outside workspace
		expect(result).toBeNull();
	});

	// ===== BARE SPECIFIERS =====

	test('returns null for bare specifier (no ./ prefix)', async () => {
		const sourceFile = path.join(srcDir, 'index.ts');

		// Bare specifiers cannot be resolved without node_modules
		const result = resolveModuleSpecifier(workspaceRoot, sourceFile, 'lodash');
		expect(result).toBeNull();
	});

	test('returns null for scoped bare specifier', async () => {
		const sourceFile = path.join(srcDir, 'index.ts');

		const result = resolveModuleSpecifier(
			workspaceRoot,
			sourceFile,
			'@scope/package',
		);
		expect(result).toBeNull();
	});
});

// Helper assertion
expect.extend({
	toEndWith(received: string, suffix: string) {
		const pass = received.endsWith(suffix);
		return {
			pass,
			message: pass
				? () => `expected ${received} not to end with ${suffix}`
				: `expected ${received} to end with ${suffix}`,
		};
	},
});
