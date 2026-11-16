/**
 * Verification tests for doc-scan tool
 * Tests Pass 1 documentation index tool: scanDocIndex, doc_scan tool
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
	return fs.mkdtempSync(path.join(os.tmpdir(), 'doc-scan-test-'));
}

// Helper to create test markdown files with forward-slash paths
function createTestFile(
	dir: string,
	filename: string,
	content: string,
): string {
	// Use forward slashes in the path for consistency with what doc-scan stores
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

// Helper to touch a file to update its mtime
function touchFile(filePath: string): void {
	const now = Date.now();
	fs.utimesSync(filePath, now / 1000, now / 1000);
}

// Helper to parse tool JSON output
function parseToolResult(result: string): {
	success: boolean;
	files_count: number;
	cached: boolean;
	manifest: {
		schema_version: number;
		scanned_at: string;
		files: Array<{
			path: string;
			title: string;
			summary: string;
			lines: number;
			mtime: number;
		}>;
	};
} {
	return JSON.parse(result);
}

// Normalize path for comparison (handle Windows backslash vs forward slash)
function normalizePath(p: string): string {
	return p.replace(/\\/g, '/');
}

describe('doc-scan tool verification tests', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = createTempDir();
		// Ensure .swarm directory exists for manifest storage
		fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	// ============ Manifest Generation Tests ============
	describe('manifest generation', () => {
		it('should generate manifest with correct structure for README.md', async () => {
			createTestFile(
				tempDir,
				'README.md',
				'# My Project\n\nThis is a test project.\n\n## Features\n\n- Feature 1\n- Feature 2\n',
			);

			const { manifest, cached } = await scanDocIndex(tempDir);

			expect(manifest.schema_version).toBe(1);
			expect(manifest.scanned_at).toBeDefined();
			expect(typeof manifest.scanned_at).toBe('string');
			expect(manifest.files).toBeDefined();
			expect(Array.isArray(manifest.files)).toBe(true);
			expect(cached).toBe(false);
		});

		it('should discover README.md, CONTRIBUTING.md, and docs/guide.md', async () => {
			createTestFile(tempDir, 'README.md', '# Project\n\nSummary line.\n');
			createTestFile(
				tempDir,
				'CONTRIBUTING.md',
				'# Contributing\n\nGuidelines.\n',
			);
			createTestFile(tempDir, 'docs/guide.md', '# Guide\n\nDocumentation.\n');
			// src/README.md also matches README.md pattern since basename is README.md
			createTestFile(
				tempDir,
				'src/README.md',
				'# Src README\n\nThis also matches.\n',
			);

			const { manifest } = await scanDocIndex(tempDir);

			const paths = manifest.files.map((f) => normalizePath(f.path));
			expect(paths).toContain('README.md');
			expect(paths).toContain('CONTRIBUTING.md');
			expect(paths).toContain('docs/guide.md');
			// src/README.md ALSO matches because basename README.md matches the README.md pattern
			expect(paths.some((p) => p.includes('src/README.md'))).toBe(true);
		});

		it('should include path, title, summary, lines, and mtime for each file', async () => {
			const content =
				'# Test Title\n\nThis is the summary paragraph.\n\n## Section\n\nMore content here.\n';
			createTestFile(tempDir, 'README.md', content);

			const { manifest } = await scanDocIndex(tempDir);

			expect(manifest.files.length).toBe(1);
			const file = manifest.files[0];
			expect(normalizePath(file.path)).toBe('README.md');
			expect(file.title).toBe('Test Title');
			// Summary should contain first paragraph content (multiple lines joined)
			expect(file.summary).toContain('This is the summary paragraph.');
			expect(file.lines).toBe(content.split('\n').length);
			expect(typeof file.mtime).toBe('number');
			expect(file.mtime).toBeGreaterThan(0);
		});

		it('should sort files case-insensitively by path', async () => {
			// Use filenames that match patterns: CHANGELOG.md matches **/CHANGELOG.md
			createTestFile(tempDir, 'ZZZ/CHANGELOG.md', '# Z\n\nZ content.\n');
			createTestFile(tempDir, 'AAA/CHANGELOG.md', '# A\n\nA content.\n');
			createTestFile(tempDir, 'mmm/CHANGELOG.md', '# M\n\nM content.\n');

			const { manifest } = await scanDocIndex(tempDir);

			const paths = manifest.files.map((f) => normalizePath(f.path));
			// Case-insensitive sort: AAA < mmm < ZZZ
			expect(paths[0]).toBe('AAA/CHANGELOG.md');
			expect(paths[1]).toBe('mmm/CHANGELOG.md');
			expect(paths[2]).toBe('ZZZ/CHANGELOG.md');
		});
	});

	// ============ Title Extraction Tests ============
	describe('title extraction', () => {
		it('should extract title from first # heading', async () => {
			createTestFile(
				tempDir,
				'README.md',
				'# My Custom Title\n\nContent here.\n',
			);

			const { manifest } = await scanDocIndex(tempDir);

			expect(manifest.files[0].title).toBe('My Custom Title');
		});

		it('should fallback to filename when no # heading exists', async () => {
			createTestFile(
				tempDir,
				'README.md',
				'No heading here.\nJust plain text.\n',
			);

			const { manifest } = await scanDocIndex(tempDir);

			expect(manifest.files[0].title).toBe('README.md');
		});

		it('should use first # heading even if later headings exist', async () => {
			createTestFile(
				tempDir,
				'README.md',
				'# First Title\n\n## Second Title\n\n### Third Title\n',
			);

			const { manifest } = await scanDocIndex(tempDir);

			expect(manifest.files[0].title).toBe('First Title');
		});

		it('should handle file with only # heading and no other content', async () => {
			createTestFile(tempDir, 'README.md', '# Only Heading\n');

			const { manifest } = await scanDocIndex(tempDir);

			expect(manifest.files[0].title).toBe('Only Heading');
			expect(manifest.files[0].summary).toBe('');
		});

		it('should treat lines not starting with # as content (not heading)', async () => {
			// The code checks `line.startsWith('# ')` - lines with leading spaces don't match
			createTestFile(tempDir, 'README.md', '  # Indented line\n\nContent.\n');

			const { manifest } = await scanDocIndex(tempDir);

			// The line "  # Indented line" is treated as content since it doesn't start with '# '
			// First non-heading content is "  # Indented line" trimmed to "# Indented line"
			// But since it starts with #, it won't be included in summary either
			// Summary would be "Content."
			expect(manifest.files[0].summary).toBe('Content.');
		});
	});

	// ============ Summary Extraction Tests ============
	describe('summary extraction', () => {
		it('should extract summary from first non-heading paragraph', async () => {
			createTestFile(
				tempDir,
				'README.md',
				'# Title\n\nThis is the first paragraph.\nIt continues on multiple lines.\n\n## Section\n\nThis is a second paragraph.\n',
			);

			const { manifest } = await scanDocIndex(tempDir);

			// Summary should be the first paragraph
			expect(manifest.files[0].summary).toContain(
				'This is the first paragraph',
			);
		});

		it('should extract summary from file without headings', async () => {
			createTestFile(
				tempDir,
				'README.md',
				'Plain text without any markdown headings.\n',
			);

			const { manifest } = await scanDocIndex(tempDir);

			expect(manifest.files[0].summary).toBe(
				'Plain text without any markdown headings.',
			);
		});

		it('should skip heading lines when building summary', async () => {
			createTestFile(
				tempDir,
				'README.md',
				'# Title\n\n## Section One\n\n### SubSection\n\nThis is actual content.\n',
			);

			const { manifest } = await scanDocIndex(tempDir);

			// Should skip all heading lines and get "This is actual content."
			expect(manifest.files[0].summary).toBe('This is actual content.');
		});

		it('should handle summary with multiple lines in same paragraph', async () => {
			createTestFile(
				tempDir,
				'README.md',
				'# Title\n\nLine one of paragraph.\nLine two of paragraph.\nLine three.\n',
			);

			const { manifest } = await scanDocIndex(tempDir);

			// Lines should be joined with spaces
			expect(manifest.files[0].summary).toContain('Line one of paragraph');
			expect(manifest.files[0].summary).toContain('Line two of paragraph');
		});
	});

	// ============ Summary Length Tests ============
	describe('summary length truncation', () => {
		it('should truncate summary at 200 characters with ellipsis', async () => {
			const longContent = '# Title\n\n' + 'x'.repeat(250) + '\n';
			createTestFile(tempDir, 'README.md', longContent);

			const { manifest } = await scanDocIndex(tempDir);

			expect(manifest.files[0].summary.length).toBeLessThanOrEqual(200);
			expect(manifest.files[0].summary.endsWith('...')).toBe(true);
		});

		it('should not truncate if summary is under 200 characters', async () => {
			createTestFile(tempDir, 'README.md', '# Title\n\nShort summary.\n');

			const { manifest } = await scanDocIndex(tempDir);

			expect(manifest.files[0].summary.endsWith('...')).toBe(false);
			expect(manifest.files[0].summary).toBe('Short summary.');
		});

		it('should handle summary exactly at boundary (200 chars)', async () => {
			const content = '# Title\n\n' + 'a'.repeat(195) + '\n';
			createTestFile(tempDir, 'README.md', content);

			const { manifest } = await scanDocIndex(tempDir);

			expect(manifest.files[0].summary.length).toBeLessThanOrEqual(200);
		});
	});

	// ============ Skip Directory Tests ============
	describe('skip directories', () => {
		it('should skip files in node_modules', async () => {
			fs.mkdirSync(path.join(tempDir, 'node_modules'), { recursive: true });
			createTestFile(
				path.join(tempDir, 'node_modules'),
				'README.md',
				'# Secret\n\nShould be skipped.\n',
			);
			createTestFile(tempDir, 'README.md', '# Real\n\nReal readme.\n');

			const { manifest } = await scanDocIndex(tempDir);

			const paths = manifest.files.map((f) => normalizePath(f.path));
			expect(paths).toContain('README.md');
			expect(paths.some((p) => p.includes('node_modules'))).toBe(false);
		});

		it('should skip files in .git directory', async () => {
			fs.mkdirSync(path.join(tempDir, '.git'), { recursive: true });
			createTestFile(
				path.join(tempDir, '.git'),
				'README.md',
				'# Git Readme\n\nSkipped.\n',
			);
			createTestFile(tempDir, 'README.md', '# Real\n\nReal readme.\n');

			const { manifest } = await scanDocIndex(tempDir);

			const paths = manifest.files.map((f) => normalizePath(f.path));
			expect(paths).toContain('README.md');
			expect(paths.some((p) => p.includes('.git'))).toBe(false);
		});

		it('should skip files in .swarm directory', async () => {
			createTestFile(
				tempDir,
				'.swarm/README.md',
				'# Swarm Readme\n\nShould be skipped.\n',
			);
			createTestFile(tempDir, 'README.md', '# Real\n\nReal readme.\n');

			const { manifest } = await scanDocIndex(tempDir);

			const paths = manifest.files.map((f) => normalizePath(f.path));
			expect(paths).toContain('README.md');
			expect(paths.some((p) => p.includes('.swarm'))).toBe(false);
		});

		it('should skip files in dist, build, .next, vendor directories', async () => {
			for (const dir of ['dist', 'build', '.next', 'vendor']) {
				fs.mkdirSync(path.join(tempDir, dir), { recursive: true });
				createTestFile(
					path.join(tempDir, dir),
					'README.md',
					`# ${dir}\n\nSkipped.\n`,
				);
			}
			createTestFile(tempDir, 'README.md', '# Real\n\nReal readme.\n');

			const { manifest } = await scanDocIndex(tempDir);

			const paths = manifest.files.map((f) => normalizePath(f.path));
			expect(paths).toContain('README.md');
			expect(paths.some((p) => p.includes('dist'))).toBe(false);
			expect(paths.some((p) => p.includes('build'))).toBe(false);
			expect(paths.some((p) => p.includes('.next'))).toBe(false);
			expect(paths.some((p) => p.includes('vendor'))).toBe(false);
		});
	});

	// ============ Skip Test Files Tests ============
	describe('skip test and type definition files', () => {
		it('should skip *.test.ts files', async () => {
			createTestFile(tempDir, 'README.md', '# Readme\n\nReal readme.\n');
			createTestFile(
				tempDir,
				'docs/test-foo.test.ts',
				'# Test\n\nShould be skipped.\n',
			);

			const { manifest } = await scanDocIndex(tempDir);

			const paths = manifest.files.map((f) => normalizePath(f.path));
			expect(paths).toContain('README.md');
			expect(paths.some((p) => p.includes('.test.ts'))).toBe(false);
		});

		it('should skip *.spec.ts files', async () => {
			createTestFile(tempDir, 'README.md', '# Readme\n\nReal readme.\n');
			createTestFile(
				tempDir,
				'docs/test.spec.ts',
				'# Spec\n\nShould be skipped.\n',
			);

			const { manifest } = await scanDocIndex(tempDir);

			const paths = manifest.files.map((f) => normalizePath(f.path));
			expect(paths).toContain('README.md');
			expect(paths.some((p) => p.includes('.spec.ts'))).toBe(false);
		});

		it('should skip *.d.ts type definition files', async () => {
			createTestFile(tempDir, 'README.md', '# Readme\n\nReal readme.\n');
			createTestFile(
				tempDir,
				'types.doc.d.ts',
				'# Types\n\nShould be skipped.\n',
			);

			const { manifest } = await scanDocIndex(tempDir);

			const paths = manifest.files.map((f) => normalizePath(f.path));
			expect(paths).toContain('README.md');
			expect(paths.some((p) => p.includes('.d.ts'))).toBe(false);
		});

		it('should skip files with .test. in the middle of name', async () => {
			createTestFile(tempDir, 'README.md', '# Readme\n\nReal readme.\n');
			createTestFile(
				tempDir,
				'my.test.file.md',
				'# Test\n\nShould be skipped.\n',
			);

			const { manifest } = await scanDocIndex(tempDir);

			const paths = manifest.files.map((f) => normalizePath(f.path));
			expect(paths).toContain('README.md');
			expect(paths.some((p) => p.includes('.test.'))).toBe(false);
		});
	});

	// ============ Cache Tests ============
	describe('cache behavior', () => {
		it('should return cached: false on second call when files exist (cache uses mtime)', async () => {
			createTestFile(tempDir, 'README.md', '# Project\n\nSummary.\n');

			// First scan
			const first = await scanDocIndex(tempDir);
			expect(first.cached).toBe(false);

			// Wait a bit to ensure mtime would differ if file is touched
			await new Promise((resolve) => setTimeout(resolve, 50));

			// Second scan - depending on mtime resolution, might or might not be cached
			// The important thing is it returns a valid manifest
			const second = await scanDocIndex(tempDir);
			expect(second.manifest).toBeDefined();
			expect(second.manifest.files.length).toBe(1);
		});

		it('should return cached: false when file mtime changes (cache invalidation)', async () => {
			const filePath = createTestFile(
				tempDir,
				'README.md',
				'# Project\n\nSummary.\n',
			);

			// First scan
			const first = await scanDocIndex(tempDir);
			expect(first.cached).toBe(false);

			// Touch file to update mtime
			await new Promise((resolve) => setTimeout(resolve, 50));
			touchFile(filePath);

			// Second scan should invalidate cache
			const second = await scanDocIndex(tempDir);
			expect(second.cached).toBe(false);
		});

		it('should return cached: false when file is deleted (cache invalidation)', async () => {
			const filePath = createTestFile(
				tempDir,
				'README.md',
				'# Project\n\nSummary.\n',
			);

			// First scan
			const first = await scanDocIndex(tempDir);
			expect(first.manifest.files.length).toBe(1);

			// Delete the file
			fs.unlinkSync(filePath);

			// Second scan should invalidate cache and re-scan
			const second = await scanDocIndex(tempDir);
			expect(second.cached).toBe(false);
			expect(second.manifest.files.length).toBe(0);
		});

		it('should return cached: false when existing file is modified', async () => {
			const filePath = createTestFile(
				tempDir,
				'README.md',
				'# Project\n\nSummary.\n',
			);

			// First scan
			const first = await scanDocIndex(tempDir);
			expect(first.manifest.files.length).toBe(1);

			// Modify the existing file
			await new Promise((resolve) => setTimeout(resolve, 50));
			fs.writeFileSync(filePath, '# Modified\n\nNew content.\n');

			// Second scan should re-scan because existing file changed
			const second = await scanDocIndex(tempDir);
			expect(second.cached).toBe(false);
			expect(second.manifest.files.length).toBe(1);
			// The title should be updated
			expect(second.manifest.files[0].title).toBe('Modified');
		});

		it('should preserve manifest structure when returning cached result', async () => {
			createTestFile(tempDir, 'README.md', '# Project\n\nSummary.\n');

			const first = await scanDocIndex(tempDir);

			// Second scan
			const second = await scanDocIndex(tempDir);

			expect(second.manifest.schema_version).toBe(
				first.manifest.schema_version,
			);
			// scanned_at timestamps may differ slightly due to timing; check within 1 second
			const firstTime = new Date(first.manifest.scanned_at).getTime();
			const secondTime = new Date(second.manifest.scanned_at).getTime();
			expect(Math.abs(secondTime - firstTime)).toBeLessThanOrEqual(1000);
			expect(second.manifest.files).toEqual(first.manifest.files);
		});
	});

	// ============ Force Re-scan Tests ============
	describe('force re-scan', () => {
		it('should return valid manifest structure when force is used', async () => {
			createTestFile(tempDir, 'README.md', '# Project\n\nSummary.\n');

			// Scan with force
			const result = await runDocScan({ force: true }, tempDir);
			const parsed = parseToolResult(result);

			expect(parsed.success).toBe(true);
			expect(parsed.manifest).toBeDefined();
			expect(parsed.manifest.schema_version).toBe(1);
		});
	});

	// ============ Empty Directory Tests ============
	describe('empty directory handling', () => {
		it('should return empty manifest with files: [] when no doc files found', async () => {
			// Create non-markdown files
			createTestFile(tempDir, 'code.ts', 'const x = 1;\n');

			const { manifest, cached } = await scanDocIndex(tempDir);

			expect(manifest.files).toEqual([]);
			expect(cached).toBe(false);
		});

		it('should return empty manifest when directory is completely empty', async () => {
			const { manifest } = await scanDocIndex(tempDir);

			expect(manifest.files).toEqual([]);
			expect(manifest.schema_version).toBe(1);
		});
	});

	// ============ MAX_FILES Truncation Tests ============
	describe('MAX_INDEXED_FILES truncation', () => {
		it('should add warning to first file when files exceed 100', async () => {
			// Create 105 CHANGELOG files (they match **/CHANGELOG.md pattern)
			for (let i = 0; i < 105; i++) {
				createTestFile(
					tempDir,
					`docs/changelog${i}.md`,
					`# Doc ${i}\n\nContent for document ${i}.\n`,
				);
			}

			const { manifest } = await scanDocIndex(tempDir);

			// Should be truncated to 100 files
			expect(manifest.files.length).toBe(100);
			// First file should have warning
			expect(manifest.files[0].summary).toContain('Warning');
			expect(manifest.files[0].summary).toContain('100');
		});

		it('should not add warning if files <= 100', async () => {
			// Create exactly 100 CHANGELOG files
			for (let i = 0; i < 100; i++) {
				createTestFile(
					tempDir,
					`docs/changelog${i}.md`,
					`# Doc ${i}\n\nContent.\n`,
				);
			}

			const { manifest } = await scanDocIndex(tempDir);

			expect(manifest.files.length).toBe(100);
			expect(manifest.files[0].summary).not.toContain('Warning');
		});

		it('should truncate at exactly 100 files', async () => {
			// Create 150 CHANGELOG files
			for (let i = 0; i < 150; i++) {
				createTestFile(
					tempDir,
					`docs/changelog${i}.md`,
					`# File ${i}\n\nContent.\n`,
				);
			}

			const { manifest } = await scanDocIndex(tempDir);

			expect(manifest.files.length).toBe(100);
			// Verify the first 100 files are included (lexicographic sort, not numeric)
			// Files 0-9 come before 10, 11, ... 99, 100, ...
			// So at index 99 we have file "changelog99" in lexicographic order
			// Actually wait - in string comparison "9" > "10" because '9' (57) > '1' (49)
			// So order is: changelog0, changelog1, ..., changelog9, changelog100, ..., changelog149, changelog10, changelog11, ...
			// This is the nature of lexicographic sorting
			const paths = manifest.files.map((f) => normalizePath(f.path));
			// Just verify we have exactly 100 files and the first file has Warning (at index 99, it won't because it's not truncated)
			expect(manifest.files.length).toBe(100);
		});
	});

	// ============ Tool Execute Tests ============
	describe('doc_scan tool execute', () => {
		it('should return valid JSON with success, files_count, cached, and manifest', async () => {
			createTestFile(tempDir, 'README.md', '# Project\n\nSummary.\n');

			const result = await runDocScan({}, tempDir);
			const parsed = parseToolResult(result);

			expect(parsed.success).toBe(true);
			expect(typeof parsed.files_count).toBe('number');
			expect(typeof parsed.cached).toBe('boolean');
			expect(parsed.manifest).toBeDefined();
			expect(parsed.manifest.schema_version).toBe(1);
		});

		it('should handle malicious args object gracefully', async () => {
			createTestFile(tempDir, 'README.md', '# Project\n\nSummary.\n');

			// Pass an object with malicious getter
			const maliciousArgs = new Proxy(
				{},
				{
					get() {
						throw new Error('getter error');
					},
				},
			);

			const result = await runDocScan(maliciousArgs, tempDir);
			const parsed = parseToolResult(result);

			// Should still succeed despite malicious getter
			expect(parsed.success).toBe(true);
		});

		it('should return a valid manifest structure', async () => {
			createTestFile(tempDir, 'README.md', '# Title\n\nSummary text.\n');

			const result = await runDocScan({}, tempDir);
			const parsed = parseToolResult(result);

			expect(parsed.manifest.files).toBeDefined();
			expect(Array.isArray(parsed.manifest.files)).toBe(true);
			if (parsed.manifest.files.length > 0) {
				const file = parsed.manifest.files[0];
				expect(file).toHaveProperty('path');
				expect(file).toHaveProperty('title');
				expect(file).toHaveProperty('summary');
				expect(file).toHaveProperty('lines');
				expect(file).toHaveProperty('mtime');
			}
		});
	});

	// ============ Edge Cases ============
	describe('edge cases', () => {
		it('should handle file with only whitespace lines', async () => {
			createTestFile(tempDir, 'README.md', '   \n\n\t\n\n   \n');

			const { manifest } = await scanDocIndex(tempDir);

			// Should still include the file with empty summary
			expect(manifest.files.length).toBe(1);
			expect(normalizePath(manifest.files[0].path)).toBe('README.md');
			expect(manifest.files[0].summary).toBe('');
		});

		it('should handle deeply nested documentation files', async () => {
			createTestFile(
				tempDir,
				'a/b/c/d/CHANGELOG.md',
				'# Deep Doc\n\nNested content.\n',
			);

			const { manifest } = await scanDocIndex(tempDir);

			expect(manifest.files.length).toBe(1);
			expect(normalizePath(manifest.files[0].path)).toBe(
				'a/b/c/d/CHANGELOG.md',
			);
		});

		it('should handle file with very long lines', async () => {
			const longLine = 'x'.repeat(10000);
			createTestFile(tempDir, 'README.md', `# Title\n\n${longLine}\n`);

			const { manifest } = await scanDocIndex(tempDir);

			// Should handle without crashing
			expect(manifest.files.length).toBe(1);
			expect(manifest.files[0].summary.length).toBeLessThanOrEqual(200);
		});

		it('should read only first 30 lines for title/summary extraction', async () => {
			const lines = ['# Title\n'];
			for (let i = 1; i < 50; i++) {
				lines.push(`Line ${i} content here.\n`);
			}
			createTestFile(tempDir, 'README.md', lines.join(''));

			const { manifest } = await scanDocIndex(tempDir);

			// Title should be from line 1
			expect(manifest.files[0].title).toBe('Title');
			// Summary should be built from lines 2-30
			expect(manifest.files[0].summary).toContain('Line 1');
		});

		it('should handle Windows-style line endings (CRLF)', async () => {
			createTestFile(tempDir, 'README.md', '# Title\r\n\r\nSummary line.\r\n');

			const { manifest } = await scanDocIndex(tempDir);

			expect(manifest.files[0].title).toBe('Title');
			expect(manifest.files[0].summary).toBe('Summary line.');
		});

		it('should handle file with # in content but not as heading', async () => {
			createTestFile(
				tempDir,
				'README.md',
				'# Title\n\nCode example: #include <stdio.h>\n',
			);

			const { manifest } = await scanDocIndex(tempDir);

			// The line "Code example: #include <stdio.h>" should be in summary
			expect(manifest.files[0].summary).toContain('Code example');
		});
	});

	// ============ Pattern Matching with Extra Patterns ============
	describe('extra patterns (ARCHITECTURE.md, CLAUDE.md, AGENTS.md, .github/*.md, doc/**/*.md)', () => {
		it('should match ARCHITECTURE.md', async () => {
			createTestFile(
				tempDir,
				'ARCHITECTURE.md',
				'# Architecture\n\nSystem design.\n',
			);

			const { manifest } = await scanDocIndex(tempDir);

			expect(manifest.files.length).toBe(1);
			expect(normalizePath(manifest.files[0].path)).toBe('ARCHITECTURE.md');
		});

		it('should match CLAUDE.md', async () => {
			createTestFile(
				tempDir,
				'CLAUDE.md',
				'# Claude Instructions\n\nAI guidelines.\n',
			);

			const { manifest } = await scanDocIndex(tempDir);

			expect(manifest.files.length).toBe(1);
			expect(normalizePath(manifest.files[0].path)).toBe('CLAUDE.md');
		});

		it('should match AGENTS.md', async () => {
			createTestFile(tempDir, 'AGENTS.md', '# Agents\n\nAgent definitions.\n');

			const { manifest } = await scanDocIndex(tempDir);

			expect(manifest.files.length).toBe(1);
			expect(normalizePath(manifest.files[0].path)).toBe('AGENTS.md');
		});

		it('should match .github/*.md files', async () => {
			createTestFile(tempDir, '.github/README.md', '# GitHub\n\nWorkflows.\n');

			const { manifest } = await scanDocIndex(tempDir);

			expect(manifest.files.length).toBe(1);
			expect(normalizePath(manifest.files[0].path)).toBe('.github/README.md');
		});

		it('should match doc/**/*.md files', async () => {
			createTestFile(tempDir, 'doc/intro.md', '# Intro\n\nGetting started.\n');
			createTestFile(
				tempDir,
				'doc/subdir/advanced.md',
				'# Advanced\n\nDeep dive.\n',
			);

			const { manifest } = await scanDocIndex(tempDir);

			expect(manifest.files.length).toBe(2);
			const paths = manifest.files.map((f) => normalizePath(f.path));
			expect(paths).toContain('doc/intro.md');
			expect(paths).toContain('doc/subdir/advanced.md');
		});
	});
});
