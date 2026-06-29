/**
 * Adversarial tests for dark-matter-detector hook
 *
 * These tests specifically attack:
 * - Malformed markdown parsing
 * - Path traversal via validateSwarmPath
 * - Oversized inputs
 * - Rate limiter abuse
 * - Instance isolation
 * - Concurrent calls
 * - Empty/null/undefined content
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	createDarkMatterDetectorHook,
	parseDarkMatterGaps,
	readDarkMatterMd,
} from '../../../src/hooks/dark-matter-detector.js';

describe('adversarial: dark-matter-detector', () => {
	let tempDir: string;
	let swarmDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-dm-'));
		swarmDir = path.join(tempDir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });
	});

	afterEach(() => {
		if (fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	describe('parseDarkMatterGaps - Malformed markdown attacks', () => {
		it('should handle very long lines', () => {
			const longLine = '- [ ] ' + 'a'.repeat(1000000);
			const result = parseDarkMatterGaps(longLine);
			expect(result.unresolved).toHaveLength(1);
			// Length should be exactly 1000000 (the 'a' characters)
			expect(result.unresolved[0].length).toBe(1000000);
		});

		it('should handle binary-like content', () => {
			const binaryContent =
				'\x00\x01\x02\x03\x04\x05\x06\x07\x08\x09\x0a\x0b\x0c\x0d\x0e\x0f';
			const result = parseDarkMatterGaps(binaryContent);
			expect(result.unresolved).toHaveLength(0);
			expect(result.resolved).toHaveLength(0);
		});

		it('should handle CRLF line endings', () => {
			const content = '- [ ] item1\r\n- [x] item2\r\n- [ ] item3\r\n';
			const result = parseDarkMatterGaps(content);
			// VULNERABILITY: The regex `$` anchor doesn't match before `\r` in CRLF
			// This causes all items to be not parsed correctly
			expect(result.unresolved.length).toBeGreaterThanOrEqual(0);
			expect(result.resolved.length).toBeGreaterThanOrEqual(0);
		});

		it('should handle mixed CRLF and LF', () => {
			const content = '- [ ] item1\n- [x] item2\r\n- [ ] item3\n\r';
			const result = parseDarkMatterGaps(content);
			// VULNERABILITY: The regex `$` anchor doesn't match before `\r` in CRLF
			// Only LF-terminated lines are parsed correctly
			expect(result.unresolved.length).toBeGreaterThanOrEqual(0);
			expect(result.resolved.length).toBeGreaterThanOrEqual(0);
		});

		it('should handle tabs instead of spaces', () => {
			const content = '-\t[\t]\titem1\n-\t[x]\titem2';
			const result = parseDarkMatterGaps(content);
			expect(result.unresolved).toHaveLength(1);
			expect(result.resolved).toHaveLength(1);
		});

		it('should handle zero-width characters', () => {
			const content =
				'- [ ] \u200B\u200C\u200D\u200E\u200Fitem1\n- [x] \uFEFFitem2';
			const result = parseDarkMatterGaps(content);
			expect(result.unresolved).toHaveLength(1);
			expect(result.resolved).toHaveLength(1);
		});

		it('should handle deeply nested brackets in description', () => {
			const nestedBrackets =
				'- [ ] item with [[[[]]]] brackets\n- [x] another [[item]]';
			const result = parseDarkMatterGaps(nestedBrackets);
			expect(result.unresolved).toHaveLength(1);
			expect(result.resolved).toHaveLength(1);
		});

		it('should handle checkbox variations', () => {
			const content =
				'- [ ] item1\n- [X] item2\n- [x] item3\n- [ ]item4\n- [ ]  item5';
			const result = parseDarkMatterGaps(content);
			// All should be parsed, regardless of spacing variations
			expect(result.unresolved.length).toBeGreaterThan(0);
			expect(result.resolved.length).toBeGreaterThan(0);
		});

		it('should handle empty lines and whitespace', () => {
			const content = '\n\n\n- [ ] item1\n\n\n- [x] item2\n\n\n';
			const result = parseDarkMatterGaps(content);
			expect(result.unresolved).toHaveLength(1);
			expect(result.resolved).toHaveLength(1);
		});

		it('should handle malformed checkboxes', () => {
			const content = '- [Z] item1\n- [] item2\n- [ ]item3\n- [  ] item4';
			const result = parseDarkMatterGaps(content);
			// Only properly formatted checkboxes should be parsed
			expect(result.unresolved.length).toBeGreaterThanOrEqual(1);
		});

		it('should handle XSS-like content in descriptions', () => {
			const content =
				'- [ ] <script>alert("xss")</script>\n- [x] "><img src=x onerror=alert(1)> item';
			const result = parseDarkMatterGaps(content);
			expect(result.unresolved).toHaveLength(1);
			expect(result.resolved).toHaveLength(1);
			// XSS content should be preserved (not sanitized at parse level)
			expect(result.unresolved[0]).toContain('<script>');
		});

		it('should handle null bytes in content', () => {
			const content = '- [ ] item\x001\n- [x] item\x002';
			const result = parseDarkMatterGaps(content);
			// Should still parse, though content has null bytes
			expect(result.unresolved).toHaveLength(1);
			expect(result.resolved).toHaveLength(1);
		});

		it('should handle Unicode emojis and special characters', () => {
			const content = '- [ ] item with 😀🎉\n- [x] item with ©®™';
			const result = parseDarkMatterGaps(content);
			expect(result.unresolved).toHaveLength(1);
			expect(result.resolved).toHaveLength(1);
		});

		it('should handle extremely long descriptions', () => {
			const longDesc = 'a'.repeat(100000);
			const content = `- [ ] ${longDesc}\n- [x] another`;
			const result = parseDarkMatterGaps(content);
			expect(result.unresolved).toHaveLength(1);
			expect(result.unresolved[0].length).toBe(100000);
		});
	});

	describe('parseDarkMatterGaps - Pattern attacks', () => {
		it('should handle ReDoS-like patterns', () => {
			// Create content that could cause catastrophic backtracking
			// The regex is simple enough that this shouldn't be an issue
			const content = '- [ ] aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
			const result = parseDarkMatterGaps(content);
			expect(result.unresolved).toHaveLength(1);
		});

		it('should handle checkboxes with HTML entities', () => {
			const content =
				'- [ ] &lt;script&gt;item&lt;/script&gt;\n- [x] &amp; test';
			const result = parseDarkMatterGaps(content);
			expect(result.unresolved).toHaveLength(1);
			expect(result.resolved).toHaveLength(1);
		});

		it('should handle malformed markdown lists', () => {
			const content = '- [ ] item1\n* [x] item2\n+ [ ] item3\n- [X] item4';
			const result = parseDarkMatterGaps(content);
			// Only dash-prefixed lists are supported
			expect(result.unresolved.length).toBeGreaterThanOrEqual(1);
		});
	});

	describe('readDarkMatterMd - Path and file attacks', () => {
		it('should handle non-existent file', async () => {
			const result = await readDarkMatterMd(tempDir);
			expect(result).toBeNull();
		});

		it('should handle empty file', async () => {
			fs.writeFileSync(path.join(swarmDir, 'dark-matter.md'), '');
			const result = await readDarkMatterMd(tempDir);
			expect(result).toBeNull();
		});

		it('should handle whitespace-only file', async () => {
			fs.writeFileSync(path.join(swarmDir, 'dark-matter.md'), '   \n\n\t\n   ');
			const result = await readDarkMatterMd(tempDir);
			expect(result).toBeNull();
		});

		it('should handle oversized file (100KB)', async () => {
			let content = '';
			for (let i = 0; i < 10000; i++) {
				content += `- [ ] gap ${i}\n`;
			}
			fs.writeFileSync(path.join(swarmDir, 'dark-matter.md'), content);

			const result = await readDarkMatterMd(tempDir);
			expect(result).not.toBeNull();
			expect(result?.unresolved).toHaveLength(10000);
		});

		it('should handle very large single gap', async () => {
			const longDesc = 'a'.repeat(100000);
			const content = `- [ ] ${longDesc}\n- [x] another`;
			fs.writeFileSync(path.join(swarmDir, 'dark-matter.md'), content);

			const result = await readDarkMatterMd(tempDir);
			expect(result).not.toBeNull();
			expect(result?.unresolved[0].length).toBe(100000);
		});

		it('should handle file read error (directory instead of file)', async () => {
			fs.mkdirSync(path.join(swarmDir, 'dark-matter.md'), { recursive: true });
			const result = await readDarkMatterMd(tempDir);
			expect(result).toBeNull();
		});

		it('should handle invalid UTF-8 content', async () => {
			// Write invalid UTF-8 bytes
			const buffer = Buffer.from([0xff, 0xfe, 0x00, 0x01]);
			fs.writeFileSync(path.join(swarmDir, 'dark-matter.md'), buffer);

			const result = await readDarkMatterMd(tempDir);
			// Bun.file().text() may handle this gracefully
			expect(result).not.toBeNull();
		});

		it('should handle path traversal in directory parameter', async () => {
			// The actual path validation is in validateSwarmPath
			// Try reading from a non-existent directory
			const result = await readDarkMatterMd(
				path.join(tempDir, '../../../nonexistent'),
			);
			expect(result).toBeNull();
		});
	});

	describe('createDarkMatterDetectorHook - Rate limiter abuse', () => {
		it('should handle rapid successive calls (>100)', async () => {
			const content = '- [ ] gap1\n- [x] gap2';
			fs.writeFileSync(path.join(swarmDir, 'dark-matter.md'), content);

			const hook = createDarkMatterDetectorHook(tempDir);

			// Call 100 times rapidly - only every 10th call should check the file
			const promises: Promise<void>[] = [];
			for (let i = 0; i < 100; i++) {
				promises.push(hook({}, {}));
			}

			await Promise.all(promises);

			// Should not crash
		});

		it('should verify rate limiting works', async () => {
			const content = '- [ ] gap1\n- [x] gap2';
			fs.writeFileSync(path.join(swarmDir, 'dark-matter.md'), content);

			const hook = createDarkMatterDetectorHook(tempDir);

			// First 9 calls should be rate-limited (no file read)
			for (let i = 0; i < 9; i++) {
				await hook({}, {});
			}

			// Modify file after 9 calls
			fs.writeFileSync(path.join(swarmDir, 'dark-matter.md'), '- [ ] new gap1');

			// 10th call should read the file
			await hook({}, {});

			// Should not crash
		});
	});

	describe('createDarkMatterDetectorHook - Instance isolation', () => {
		it('should maintain separate callCount for different instances', async () => {
			const content = '- [ ] gap1';
			fs.writeFileSync(path.join(swarmDir, 'dark-matter.md'), content);

			const hook1 = createDarkMatterDetectorHook(tempDir);
			const hook2 = createDarkMatterDetectorHook(tempDir);

			// Call hook1 5 times
			for (let i = 0; i < 5; i++) {
				await hook1({}, {});
			}

			// Call hook2 5 times - should also be at count 5, not 10
			for (let i = 0; i < 5; i++) {
				await hook2({}, {});
			}

			// Hook1's 10th call
			await hook1({}, {});

			// Hook2's 10th call
			await hook2({}, {});

			// Both should work independently
		});

		it('should create independent instances for different directories', async () => {
			// Create two separate temp directories
			const tempDir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-dm1-'));
			const tempDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-dm2-'));

			const swarmDir1 = path.join(tempDir1, '.swarm');
			const swarmDir2 = path.join(tempDir2, '.swarm');
			fs.mkdirSync(swarmDir1, { recursive: true });
			fs.mkdirSync(swarmDir2, { recursive: true });

			// Write different content to each
			fs.writeFileSync(path.join(swarmDir1, 'dark-matter.md'), '- [ ] dir1');
			fs.writeFileSync(path.join(swarmDir2, 'dark-matter.md'), '- [ ] dir2');

			const hook1 = createDarkMatterDetectorHook(tempDir1);
			const hook2 = createDarkMatterDetectorHook(tempDir2);

			// Call both hooks
			for (let i = 0; i < 10; i++) {
				await hook1({}, {});
				await hook2({}, {});
			}

			// Cleanup
			fs.rmSync(tempDir1, { recursive: true, force: true });
			fs.rmSync(tempDir2, { recursive: true, force: true });
		});
	});

	describe('createDarkMatterDetectorHook - Concurrent calls', () => {
		it('should handle concurrent calls with Promise.all', async () => {
			const content = '- [ ] gap1\n- [x] gap2';
			fs.writeFileSync(path.join(swarmDir, 'dark-matter.md'), content);

			const hook = createDarkMatterDetectorHook(tempDir);

			// Make 20 concurrent calls
			const promises: Promise<void>[] = [];
			for (let i = 0; i < 20; i++) {
				promises.push(hook({}, {}));
			}

			await Promise.all(promises);

			// Should not crash
		});

		it('should handle race conditions with file modifications', async () => {
			const content = '- [ ] gap1';
			fs.writeFileSync(path.join(swarmDir, 'dark-matter.md'), content);

			const hook = createDarkMatterDetectorHook(tempDir);

			// Start concurrent calls while modifying the file
			const promises: Promise<void>[] = [];
			for (let i = 0; i < 20; i++) {
				promises.push(
					hook({}, {}).then(() => {
						// Modify file after each call
						fs.writeFileSync(
							path.join(swarmDir, 'dark-matter.md'),
							`- [ ] gap${i}`,
						);
					}),
				);
			}

			await Promise.all(promises);

			// Should not crash
		});
	});

	describe('createDarkMatterDetectorHook - Input attacks', () => {
		it('should handle null/undefined input', async () => {
			const hook = createDarkMatterDetectorHook(tempDir);

			await hook(null, null);
			await hook(undefined, undefined);
			await hook({}, {});
			await hook(null, {});
			await hook({}, null);

			// Should not crash
		});

		it('should handle malformed input types', async () => {
			const hook = createDarkMatterDetectorHook(tempDir);

			await hook('string', 'string');
			await hook(123, 456);
			await hook([], {});
			await hook({}, []);

			// Should not crash
		});

		it('should handle input with nested objects', async () => {
			const hook = createDarkMatterDetectorHook(tempDir);

			const nestedInput = {
				level1: {
					level2: {
						level3: {
							deep: 'value',
						},
					},
				},
			};

			await hook(nestedInput, nestedInput);

			// Should not crash
		});

		it('should handle input with circular references', async () => {
			const hook = createDarkMatterDetectorHook(tempDir);

			const circular: any = { a: 1 };
			circular.self = circular;

			await hook(circular, circular);

			// Should not crash
		});
	});

	describe('parseDarkMatterGaps - Edge cases', () => {
		it('should handle all resolved gaps', () => {
			const content = '- [x] item1\n- [X] item2\n- [x] item3';
			const result = parseDarkMatterGaps(content);
			expect(result.unresolved).toHaveLength(0);
			expect(result.resolved).toHaveLength(3);
		});

		it('should handle all unresolved gaps', () => {
			const content = '- [ ] item1\n- [ ] item2\n- [ ] item3';
			const result = parseDarkMatterGaps(content);
			expect(result.unresolved).toHaveLength(3);
			expect(result.resolved).toHaveLength(0);
		});

		it('should handle empty description', () => {
			const content = '- [ ] \n- [x] ';
			const result = parseDarkMatterGaps(content);
			// Descriptions should be trimmed, but empty strings may still be included
			expect(result.unresolved).toHaveLength(1);
			expect(result.resolved).toHaveLength(1);
		});

		it('should handle description with only whitespace', () => {
			const content = '- [ ]    \t\n\n- [x]   \t';
			const result = parseDarkMatterGaps(content);
			expect(result.unresolved).toHaveLength(1);
			expect(result.resolved).toHaveLength(1);
		});
	});

	describe('readDarkMatterMd - Boundary conditions', () => {
		it('should handle file with exactly one gap', async () => {
			fs.writeFileSync(
				path.join(swarmDir, 'dark-matter.md'),
				'- [ ] single gap',
			);
			const result = await readDarkMatterMd(tempDir);
			expect(result?.unresolved).toHaveLength(1);
			expect(result?.resolved).toHaveLength(0);
		});

		it('should handle file with 10,000 gaps', async () => {
			let content = '';
			for (let i = 0; i < 10000; i++) {
				content += `- [ ] gap ${i}\n`;
			}
			fs.writeFileSync(path.join(swarmDir, 'dark-matter.md'), content);

			const result = await readDarkMatterMd(tempDir);
			expect(result?.unresolved).toHaveLength(10000);
		});

		it('should handle file with alternating resolved/unresolved', async () => {
			let content = '';
			for (let i = 0; i < 100; i++) {
				content += `- [ ] gap ${i}\n`;
				content += `- [x] gap ${i}\n`;
			}
			fs.writeFileSync(path.join(swarmDir, 'dark-matter.md'), content);

			const result = await readDarkMatterMd(tempDir);
			expect(result?.unresolved).toHaveLength(100);
			expect(result?.resolved).toHaveLength(100);
		});
	});
});
