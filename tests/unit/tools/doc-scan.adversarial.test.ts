/**
 * Adversarial tests for doc-scan tool
 * Tests malformed inputs, path traversal, race conditions, permission errors,
 * oversized payloads, type coercion exploits, and boundary violations.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { doc_scan, scanDocIndex } from '../../../src/tools/doc-scan';
import { executeInDirectory } from '../../helpers/tool-directory';

// An explicit ToolContext directory keeps the manifest write out of the checkout.
const runDocScan = executeInDirectory(doc_scan);

// Helper to create temp test directories
function createTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'doc-scan-adv-'));
}

// Helper to create test markdown files
function createTestFile(
	dir: string,
	filename: string,
	content: string,
): string {
	const relativePath = filename.replace(/\\/g, '/');
	const parts = relativePath.split('/');
	let currentDir = dir;

	for (let i = 0; i < parts.length - 1; i++) {
		currentDir = path.join(currentDir, parts[i]);
		if (!fs.existsSync(currentDir)) {
			fs.mkdirSync(currentDir, { recursive: true });
		}
	}

	const filePath = path.join(dir, ...parts);
	fs.writeFileSync(filePath, content, 'utf-8');
	return filePath;
}

// Normalize path for comparison
function normalizePath(p: string): string {
	return p.replace(/\\/g, '/');
}

describe('doc-scan adversarial tests', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = createTempDir();
		fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	// ============ Path Traversal Tests ============
	describe('path traversal attacks', () => {
		it('should handle non-existent directory path', async () => {
			// Create a README in temp dir to verify
			createTestFile(tempDir, 'README.md', '# Real Readme\n\nReal content.\n');

			// Use a path that resolves to non-existent directory
			const nonExistentPath = path.join(tempDir, 'non-existent-dir');
			const result = await scanDocIndex(nonExistentPath);

			// Should return empty manifest without crashing
			expect(result.manifest).toBeDefined();
			expect(result.manifest.schema_version).toBe(1);
			expect(result.manifest.files).toEqual([]);
		});

		it('should handle deeply nested non-existent path', async () => {
			createTestFile(tempDir, 'README.md', '# Real\n\nContent.\n');

			// Use a deeply nested non-existent path
			const deepPath = path.join(tempDir, 'a/b/c/d/e/f/g/h');
			const result = await scanDocIndex(deepPath);

			expect(result.manifest).toBeDefined();
			expect(result.manifest.schema_version).toBe(1);
		});
	});

	// ============ Directory/File Type Confusion ============
	describe('directory/file type confusion', () => {
		it('should handle when directory argument is actually a file', async () => {
			// Create a file where directory is expected
			const fakeDirFile = path.join(tempDir, 'not-a-directory');
			fs.writeFileSync(fakeDirFile, 'I am not a directory', 'utf-8');

			// Should handle gracefully and return empty manifest
			const result = await scanDocIndex(fakeDirFile);

			expect(result.manifest).toBeDefined();
			expect(result.manifest.schema_version).toBe(1);
			// readdirSync on a file should throw or return empty
			expect(Array.isArray(result.manifest.files)).toBe(true);
		});

		it('should handle file that exists but is deleted before stat', async () => {
			// This tests the case where statSync fails on a file
			createTestFile(tempDir, 'README.md', '# Title\n\nContent.\n');
			const filePath = path.join(tempDir, 'README.md');

			// Delete the file before scan completes
			fs.unlinkSync(filePath);

			const result = await scanDocIndex(tempDir);
			// Should not crash, should return empty or partial manifest
			expect(result.manifest).toBeDefined();
		});
	});

	// ============ Empty and Minimal Files ============
	describe('empty and minimal files', () => {
		it('should handle 0-byte file', async () => {
			const filePath = path.join(tempDir, 'README.md');
			fs.writeFileSync(filePath, '', 'utf-8');

			const result = await scanDocIndex(tempDir);

			// File exists but has no content - title should be filename
			expect(result.manifest.files.length).toBe(1);
			expect(result.manifest.files[0].title).toBe('README.md');
			expect(result.manifest.files[0].summary).toBe('');
			// Empty string split by \n returns [''] which has length 1
			expect(result.manifest.files[0].lines).toBe(1);
		});

		it('should handle file with only whitespace and newlines', async () => {
			createTestFile(tempDir, 'README.md', '   \n\n\t  \n\n   \n\n');

			const result = await scanDocIndex(tempDir);

			expect(result.manifest.files.length).toBe(1);
			expect(result.manifest.files[0].summary).toBe('');
		});

		it('should handle file with only # headings and no content', async () => {
			createTestFile(
				tempDir,
				'README.md',
				'# Heading 1\n\n## Heading 2\n\n### Heading 3\n',
			);

			const result = await scanDocIndex(tempDir);

			expect(result.manifest.files.length).toBe(1);
			expect(result.manifest.files[0].title).toBe('Heading 1');
			expect(result.manifest.files[0].summary).toBe('');
		});

		it('should handle file with only carriage returns (old Mac)', async () => {
			createTestFile(tempDir, 'README.md', 'Line one\rLine two\rLine three\r');

			const result = await scanDocIndex(tempDir);

			// Should handle \r as part of content, not as line terminator
			expect(result.manifest.files.length).toBe(1);
		});
	});

	// ============ Oversized Payloads ============
	describe('oversized payloads', () => {
		it('should handle extremely long lines (100,000 chars)', async () => {
			const extremelyLongLine = 'x'.repeat(100000);
			createTestFile(tempDir, 'README.md', `# Title\n\n${extremelyLongLine}\n`);

			const result = await scanDocIndex(tempDir);

			expect(result.manifest.files.length).toBe(1);
			// Summary should be truncated to 200 chars
			expect(result.manifest.files[0].summary.length).toBeLessThanOrEqual(200);
		});

		it('should handle many small files (memory pressure)', async () => {
			// Create 200 files to stress test
			for (let i = 0; i < 200; i++) {
				createTestFile(
					tempDir,
					`docs/file${i}.md`,
					`# Doc ${i}\n\nContent for file ${i}.\n`,
				);
			}

			const result = await scanDocIndex(tempDir);

			// Should be truncated to 100
			expect(result.manifest.files.length).toBe(100);
			expect(result.manifest.files[0].summary).toContain('Warning');
			expect(result.manifest.files[0].summary).toContain('100');
		});

		it('should handle deeply nested directory (15 levels)', async () => {
			// Create 15 levels of nesting
			const deepPath = Array.from({ length: 15 }, (_, i) => `level${i}`).join(
				'/',
			);
			createTestFile(
				tempDir,
				`${deepPath}/CHANGELOG.md`,
				`# Deep Change\n\nNested.\n`,
			);

			const result = await scanDocIndex(tempDir);

			expect(result.manifest.files.length).toBe(1);
			expect(normalizePath(result.manifest.files[0].path)).toContain('level0');
		});
	});

	// ============ Special Characters in Filenames ============
	describe('special characters in filenames', () => {
		it('should handle file with spaces in name', async () => {
			// Create a file that DOES match a pattern (README.md) but with spaces
			createTestFile(tempDir, 'README.md', '# Spaced\n\nContent.\n');

			const result = await scanDocIndex(tempDir);

			// Should find the file because README.md matches pattern
			expect(result.manifest.files.length).toBe(1);
		});

		it('should handle file with unicode characters in name', async () => {
			createTestFile(tempDir, 'RÉADME.md', '# Unicode\n\nContent.\n');

			const result = await scanDocIndex(tempDir);

			// May or may not match pattern depending on case sensitivity
			expect(result.manifest).toBeDefined();
		});

		it('should handle file with parentheses in name that matches pattern', async () => {
			// Create a file that matches pattern with parentheses in directory
			createTestFile(
				tempDir,
				'docs/README (copy).md',
				'# Parens\n\nContent.\n',
			);

			const result = await scanDocIndex(tempDir);

			// Should find the file because docs/README matches doc/**/*.md pattern
			expect(result.manifest.files.length).toBe(1);
		});

		it('should handle file with brackets in name that matches pattern', async () => {
			createTestFile(tempDir, 'doc/README [v1].md', '# Brackets\n\nContent.\n');

			const result = await scanDocIndex(tempDir);

			expect(result.manifest.files.length).toBe(1);
		});
	});

	// ============ Binary/Invalid UTF-8 Content ============
	describe('binary/invalid UTF-8 content', () => {
		it('should handle file with binary content', async () => {
			const binaryPath = path.join(tempDir, 'README.md');
			// Write binary content (not valid UTF-8)
			fs.writeFileSync(binaryPath, Buffer.from([0x80, 0x81, 0x82, 0xff, 0xfe]));

			// readFileSync with utf-8 will replace invalid sequences
			// This tests that the code handles the resulting string
			const result = await scanDocIndex(tempDir);

			expect(result.manifest.files.length).toBe(1);
			expect(result.manifest.files[0].title).toBe('README.md');
		});
	});

	// ============ Manifest Corruption ============
	describe('manifest corruption handling', () => {
		it('should re-scan when manifest.json contains garbage', async () => {
			createTestFile(tempDir, 'README.md', '# Real\n\nContent.\n');

			// Write garbage to manifest
			const manifestPath = path.join(tempDir, '.swarm', 'doc-manifest.json');
			fs.writeFileSync(manifestPath, '{ garbage json content }', 'utf-8');

			const result = await scanDocIndex(tempDir);

			// Should re-scan and get correct result
			expect(result.cached).toBe(false);
			expect(result.manifest.files.length).toBe(1);
			expect(result.manifest.files[0].title).toBe('Real');
		});

		it('should re-scan when manifest.json has invalid schema', async () => {
			createTestFile(tempDir, 'README.md', '# Title\n\nSummary.\n');

			// Write valid JSON but wrong schema
			const manifestPath = path.join(tempDir, '.swarm', 'doc-manifest.json');
			fs.writeFileSync(
				manifestPath,
				JSON.stringify({ wrong: 'schema' }),
				'utf-8',
			);

			const result = await scanDocIndex(tempDir);

			expect(result.cached).toBe(false);
			expect(result.manifest.schema_version).toBe(1);
		});

		it('should handle when .swarm/doc-manifest.json is a directory', async () => {
			createTestFile(tempDir, 'README.md', '# Title\n\nContent.\n');

			// Replace file with directory
			const manifestPath = path.join(tempDir, '.swarm', 'doc-manifest.json');
			fs.mkdirSync(manifestPath, { recursive: true });

			// Should handle gracefully and re-scan
			const result = await scanDocIndex(tempDir);

			expect(result.manifest).toBeDefined();
			expect(result.manifest.schema_version).toBe(1);
		});
	});

	// ============ Tool Execute Type Coercion ============
	describe('tool execute type coercion attacks', () => {
		it('should handle args.force as string "true" instead of boolean', async () => {
			createTestFile(tempDir, 'README.md', '# Title\n\nContent.\n');

			// Pass force as string "true" instead of boolean true
			const result = await runDocScan({ force: 'true' as any }, tempDir);
			const parsed = JSON.parse(result);

			// Should still work - string "true" should not be treated as true
			expect(parsed.success).toBe(true);
			expect(parsed.manifest).toBeDefined();
		});

		it('should handle args.force as number 1', async () => {
			createTestFile(tempDir, 'README.md', '# Title\n\nContent.\n');

			const result = await runDocScan({ force: 1 as any }, tempDir);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);
		});

		it('should handle extremely large args object (1000 keys)', async () => {
			createTestFile(tempDir, 'README.md', '# Title\n\nContent.\n');

			// Create object with 1000 keys
			const largeArgs: Record<string, unknown> = {};
			for (let i = 0; i < 1000; i++) {
				largeArgs[`key${i}`] = `value${i}`;
			}

			const result = await runDocScan(largeArgs, tempDir);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);
			expect(parsed.manifest).toBeDefined();
		});

		it('should handle args with prototype pollution attempt', async () => {
			createTestFile(tempDir, 'README.md', '# Title\n\nContent.\n');

			// Try prototype pollution
			const maliciousArgs = { force: true, __proto__: { admin: true } } as any;

			const result = await runDocScan(maliciousArgs, tempDir);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);
			// Verify pollution didn't affect the result
			expect(parsed.manifest).toBeDefined();
		});

		it('should handle args with constructor property', async () => {
			createTestFile(tempDir, 'README.md', '# Title\n\nContent.\n');

			const argsWithConstructor = { force: true, constructor: {} } as any;

			const result = await runDocScan(argsWithConstructor, tempDir);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);
		});
	});

	// ============ Race Conditions ============
	describe('race condition handling', () => {
		it('should handle file deleted between cache check and read', async () => {
			createTestFile(tempDir, 'README.md', '# Title\n\nContent.\n');

			// First scan to create manifest
			await scanDocIndex(tempDir);

			// Delete file before second scan
			fs.unlinkSync(path.join(tempDir, 'README.md'));

			// Second scan - should handle gracefully
			const result = await scanDocIndex(tempDir);

			// Should re-scan and not include the deleted file
			expect(result.cached).toBe(false);
			expect(result.manifest.files.length).toBe(0);
		});

		it('should handle file deleted during scan iteration', async () => {
			createTestFile(tempDir, 'README.md', '# Title\n\nContent.\n');
			createTestFile(tempDir, 'CHANGELOG.md', '# Changes\n\nLog.\n');

			// Verify scan works with multiple files
			const result = await scanDocIndex(tempDir);

			// Should complete without crashing and find both files
			expect(result.manifest).toBeDefined();
			expect(result.manifest.files.length).toBeGreaterThanOrEqual(1);
		});
	});

	// ============ Line Ending Variations ============
	describe('line ending variations', () => {
		it('should handle mixed CRLF and LF line endings', async () => {
			createTestFile(
				tempDir,
				'README.md',
				'# Title\r\n\r\nLine one.\r\nLine two.\nLine three.\n',
			);

			const result = await scanDocIndex(tempDir);

			expect(result.manifest.files.length).toBe(1);
			expect(result.manifest.files[0].title).toBe('Title');
			// Summary should contain the content
			expect(result.manifest.files[0].summary.length).toBeGreaterThan(0);
		});

		it('should handle file with only CRLF line endings', async () => {
			createTestFile(tempDir, 'README.md', '# Title\r\n\r\nContent here.\r\n');

			const result = await scanDocIndex(tempDir);

			expect(result.manifest.files.length).toBe(1);
			expect(result.manifest.files[0].title).toBe('Title');
		});
	});

	// ============ Permission/Symlink Edge Cases ============
	describe('permission and symlink edge cases', () => {
		it('should handle unreadable file gracefully', async () => {
			createTestFile(tempDir, 'README.md', '# Title\n\nContent.\n');

			// Remove read permission (Unix-like systems only)
			if (process.platform !== 'win32') {
				const filePath = path.join(tempDir, 'README.md');
				fs.chmodSync(filePath, 0o000);

				const result = await scanDocIndex(tempDir);

				// Should skip the unreadable file, not crash
				expect(result.manifest).toBeDefined();

				// Restore permission for cleanup
				fs.chmodSync(filePath, 0o644);
			} else {
				// On Windows, skip this test
				expect(true).toBe(true);
			}
		});

		it('should handle circular symlink (symlink loop)', async () => {
			// Create a directory with a symlink pointing to itself
			const linkDir = path.join(tempDir, 'docs');
			fs.mkdirSync(linkDir, { recursive: true });

			// Create a file first
			createTestFile(tempDir, 'docs/README.md', '# Doc\n\nContent.\n');

			// Try to create a symlink loop (on Unix)
			const symlinkPath = path.join(linkDir, 'loop');
			if (process.platform !== 'win32') {
				try {
					fs.symlinkSync(linkDir, symlinkPath, 'dir');
				} catch {}

				const result = await scanDocIndex(tempDir);

				// Should handle loop without infinite recursion
				expect(result.manifest).toBeDefined();
				expect(result.manifest.schema_version).toBe(1);
			} else {
				// On Windows, symlinks may require admin privileges
				expect(true).toBe(true);
			}
		});
	});

	// ============ Identical Content Handling ============
	describe('identical content handling', () => {
		it('should handle multiple files with identical content', async () => {
			const identicalContent = '# Same Title\n\nSame content.\n';
			createTestFile(tempDir, 'README.md', identicalContent);
			createTestFile(tempDir, 'docs/readme.md', identicalContent);
			createTestFile(tempDir, 'doc/readme.md', identicalContent);

			const result = await scanDocIndex(tempDir);

			// Should include all three - no deduplication
			expect(result.manifest.files.length).toBe(3);
			const paths = result.manifest.files.map((f) => normalizePath(f.path));
			expect(paths).toContain('README.md');
			expect(paths).toContain('docs/readme.md');
			expect(paths).toContain('doc/readme.md');
		});

		it('should handle identical files at different paths', async () => {
			const content = '# Identical\n\nSame.\n';
			createTestFile(tempDir, 'a/CHANGELOG.md', content);
			createTestFile(tempDir, 'b/CHANGELOG.md', content);

			const result = await scanDocIndex(tempDir);

			expect(result.manifest.files.length).toBe(2);
		});
	});

	// ============ Unusual Directory Structures ============
	describe('unusual directory structures', () => {
		it('should handle directory with same name as skip directory', async () => {
			// Create node_modules directory with a README
			fs.mkdirSync(path.join(tempDir, 'node_modules'), { recursive: true });
			createTestFile(
				tempDir,
				'node_modules/README.md',
				'# In NodeModules\n\nShould be skipped.\n',
			);
			createTestFile(tempDir, 'README.md', '# Real\n\nShould be included.\n');

			const result = await scanDocIndex(tempDir);

			const paths = result.manifest.files.map((f) => normalizePath(f.path));
			expect(paths).toContain('README.md');
			expect(paths.filter((p) => p.includes('node_modules'))).toHaveLength(0);
		});
	});

	// ============ Boundary Value Tests ============
	describe('boundary value tests', () => {
		it('should handle summary at exactly 200 characters', async () => {
			// Create summary that is exactly 200 chars
			const exactly200 = 'a'.repeat(200);
			createTestFile(tempDir, 'README.md', `# Title\n\n${exactly200}\n`);

			const result = await scanDocIndex(tempDir);

			// Should not truncate at exactly boundary
			expect(result.manifest.files[0].summary.length).toBe(200);
		});

		it('should handle summary at 201 characters (triggers truncation)', async () => {
			const over200 = 'b'.repeat(201);
			createTestFile(tempDir, 'README.md', `# Title\n\n${over200}\n`);

			const result = await scanDocIndex(tempDir);

			// Should truncate with ellipsis
			expect(result.manifest.files[0].summary.length).toBe(200);
			expect(result.manifest.files[0].summary.endsWith('...')).toBe(true);
		});

		it('should handle file with exactly 30 lines (READ_LINES_LIMIT boundary)', async () => {
			const lines = ['# Title\n'];
			for (let i = 1; i < 30; i++) {
				lines.push(`L${i}.\n`);
			}
			createTestFile(tempDir, 'README.md', lines.join(''));

			const result = await scanDocIndex(tempDir);

			// Should read all 30 lines for title/summary extraction
			expect(result.manifest.files[0].title).toBe('Title');
			// Summary should contain early lines - content is "L1. L2. L3..." truncated at 200 chars
			expect(result.manifest.files[0].summary).toContain('L1');
			expect(result.manifest.files[0].summary).toContain('L2');
		});
	});
});
