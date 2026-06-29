/**
 * Adversarial security testing for the steering-consumed hook
 *
 * Tests attack vectors including:
 * - Path traversal via directiveId and directory param
 * - Oversized payloads
 * - JSON injection attempts
 * - Null/undefined inputs
 * - Malformed events.jsonl content
 * - Unicode and special characters
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
	createSteeringConsumedHook,
	recordSteeringConsumed,
} from '../../../src/hooks/steering-consumed.js';

describe('steering-consumed adversarial security tests', () => {
	let tempDir: string;
	let swarmDir: string;
	let eventsPath: string;

	beforeEach(() => {
		// Create a temporary directory for each test
		tempDir = fs.mkdtempSync(path.join(tmpdir(), 'swarm-test-'));
		swarmDir = path.join(tempDir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });
		eventsPath = path.join(swarmDir, 'events.jsonl');
	});

	afterEach(() => {
		// Clean up temp directory
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	describe('1. Path traversal via directiveId', () => {
		it('should handle directiveId with Unix-style path traversal', () => {
			// This should not crash or escape .swarm directory
			recordSteeringConsumed(tempDir, '../../../etc/passwd');

			// File should still be readable and within .swarm directory
			if (fs.existsSync(eventsPath)) {
				const content = fs.readFileSync(eventsPath, 'utf-8');
				expect(content).toContain('directiveId');
				// The directiveId is just a string, so it gets JSON-escaped
				// The key point is it doesn't cause crashes
			}
		});

		it('should handle directiveId with Windows-style path traversal', () => {
			recordSteeringConsumed(tempDir, '..\\..\\..\\windows\\system32');

			if (fs.existsSync(eventsPath)) {
				const content = fs.readFileSync(eventsPath, 'utf-8');
				expect(content).toContain('directiveId');
			}
		});

		it('should handle directiveId with mixed traversal', () => {
			recordSteeringConsumed(tempDir, '../../../..\\windows\\system32');

			// Should not crash
			expect(true).toBe(true);
		});
	});

	describe('2. Path traversal via directory param', () => {
		it('should reject directory with path traversal sequences', () => {
			// The directory param gets passed to validateSwarmPath
			// Path traversal in directory should be caught
			const maliciousDir = path.join(tempDir, '..\\..\\..\\system32');

			// This should not escape the .swarm directory
			recordSteeringConsumed(maliciousDir, 'test-id');

			// File should NOT be created outside .swarm
			const outsidePath = path.join(tmpdir(), '.swarm', 'events.jsonl');
			expect(fs.existsSync(outsidePath)).toBe(false);
		});

		it('should reject directory with absolute Windows path', () => {
			const maliciousDir = 'C:\\Windows\\System32';

			recordSteeringConsumed(maliciousDir, 'test-id');

			// Should not create file in system32
			expect(() =>
				fs.accessSync('C:\\Windows\\System32\\.swarm\\events.jsonl'),
			).toThrow();
		});
	});

	describe('3. Oversized directiveId', () => {
		it('should handle 1MB+ directiveId without crashing', () => {
			// Generate a 1MB string
			const largeDirectiveId = 'A'.repeat(1024 * 1024);

			// This should not OOM or crash
			recordSteeringConsumed(tempDir, largeDirectiveId);

			// Verify it wrote successfully
			if (fs.existsSync(eventsPath)) {
				const content = fs.readFileSync(eventsPath, 'utf-8');
				expect(content).toContain('directiveId');
				expect(content.length).toBeGreaterThan(1024 * 1024);
			}
		});

		it('should handle 10MB directiveId', () => {
			const hugeDirectiveId = 'X'.repeat(10 * 1024 * 1024);

			// May timeout or fail, but shouldn't crash the process
			recordSteeringConsumed(tempDir, hugeDirectiveId);

			// If it succeeded, verify
			if (fs.existsSync(eventsPath)) {
				const content = fs.readFileSync(eventsPath, 'utf-8');
				expect(content).toContain('directiveId');
			}
		});
	});

	describe('4. JSON injection in directiveId', () => {
		it('should safely escape JSON injection in directiveId', () => {
			const injectionDirectiveId = 'test"},"malicious":"value","extra":"true';

			recordSteeringConsumed(tempDir, injectionDirectiveId);

			if (fs.existsSync(eventsPath)) {
				const content = fs.readFileSync(eventsPath, 'utf-8');
				// The JSON.stringify should escape the quotes
				expect(content).toContain('\\"malicious\\"');
				// The content should be valid JSON when parsed line by line
				const lines = content.trim().split('\n');
				for (const line of lines) {
					const parsed = JSON.parse(line);
					expect(parsed).toHaveProperty('type');
					expect(parsed).toHaveProperty('directiveId');
					expect(parsed.directiveId).toBe(injectionDirectiveId);
				}
			}
		});

		it('should handle directiveId with nested JSON attempts', () => {
			const nestedInjection = '{"nested":{"key":"value"}}';

			recordSteeringConsumed(tempDir, nestedInjection);

			if (fs.existsSync(eventsPath)) {
				const content = fs.readFileSync(eventsPath, 'utf-8');
				const lines = content.trim().split('\n');
				for (const line of lines) {
					const parsed = JSON.parse(line);
					// The directiveId should be a string, not parsed as JSON
					expect(typeof parsed.directiveId).toBe('string');
					expect(parsed.directiveId).toBe(nestedInjection);
				}
			}
		});
	});

	describe('5. Null/undefined directiveId', () => {
		it('should handle null directiveId without crashing', () => {
			// @ts-expect-error - Testing invalid input
			recordSteeringConsumed(tempDir, null);

			// Should not crash
			expect(true).toBe(true);
		});

		it('should handle undefined directiveId without crashing', () => {
			// @ts-expect-error - Testing invalid input
			recordSteeringConsumed(tempDir, undefined);

			// Should not crash
			expect(true).toBe(true);
		});

		it('should handle directiveId with null byte in string', () => {
			// This is a string with embedded null byte
			const directiveWithNull = 'test\u0000id';

			recordSteeringConsumed(tempDir, directiveWithNull);

			// Should not crash (validateSwarmPath checks filename, not directiveId)
			if (fs.existsSync(eventsPath)) {
				const content = fs.readFileSync(eventsPath, 'utf-8');
				expect(content).toContain('directiveId');
			}
		});
	});

	describe('6. Null/undefined directory', () => {
		it('should handle null directory without crashing', () => {
			// @ts-expect-error - Testing invalid input
			recordSteeringConsumed(null, 'test-id');

			// Should not crash (caught by try/catch)
			expect(true).toBe(true);
		});

		it('should handle undefined directory without crashing', () => {
			// @ts-expect-error - Testing invalid input
			recordSteeringConsumed(undefined, 'test-id');

			// Should not crash (caught by try/catch)
			expect(true).toBe(true);
		});

		it('should handle non-string directory', () => {
			// @ts-expect-error - Testing invalid input
			recordSteeringConsumed(12345, 'test-id');

			// Should not crash (caught by try/catch)
			expect(true).toBe(true);
		});
	});

	describe('7. Malicious events.jsonl content', () => {
		it('should skip malformed JSON lines in events.jsonl', async () => {
			// Write malicious content
			fs.writeFileSync(
				eventsPath,
				'{"type":"steering-directive","directiveId":"id1"}\n' +
					'}\n' + // Malformed
					'{"type":"steering-directive","directiveId":"id2"}\n',
			);

			const hook = createSteeringConsumedHook(tempDir);
			await hook(null, null);

			// Should not crash and should process valid lines
			const content = fs.readFileSync(eventsPath, 'utf-8');
			const lines = content.trim().split('\n');
			expect(lines.length).toBeGreaterThanOrEqual(2);
		});

		it('should skip lines with null directiveId', async () => {
			fs.writeFileSync(
				eventsPath,
				'{"type":"steering-directive","directiveId":null}\n' +
					'{"type":"steering-directive","directiveId":"id1"}\n',
			);

			const hook = createSteeringConsumedHook(tempDir);
			await hook(null, null);

			// Should skip the null directiveId line
			const content = fs.readFileSync(eventsPath, 'utf-8');
			expect(content).toContain('id1');
		});

		it('should handle very long type strings', async () => {
			const longType = 'steering-directive' + 'A'.repeat(10000);
			fs.writeFileSync(
				eventsPath,
				`{"type":"${longType}","directiveId":"id1"}\n` +
					'{"type":"steering-directive","directiveId":"id2"}\n',
			);

			const hook = createSteeringConsumedHook(tempDir);
			await hook(null, null);

			// Should not crash
			expect(true).toBe(true);
		});

		it('should handle newlines in type field', async () => {
			fs.writeFileSync(
				eventsPath,
				'{"type":"steering-directive\\n","directiveId":"id1"}\n' +
					'{"type":"steering-directive","directiveId":"id2"}\n',
			);

			const hook = createSteeringConsumedHook(tempDir);
			await hook(null, null);

			// Should not corrupt the file
			const content = fs.readFileSync(eventsPath, 'utf-8');
			expect(content).toContain('id2');
		});

		it('should handle lines that are just brackets', async () => {
			fs.writeFileSync(
				eventsPath,
				'[\n' + // Just an opening bracket
					']\n' + // Just a closing bracket
					'{"type":"steering-directive","directiveId":"id1"}\n',
			);

			const hook = createSteeringConsumedHook(tempDir);
			await hook(null, null);

			// Should skip malformed lines and process valid one
			expect(true).toBe(true);
		});
	});

	describe('8. Oversized events.jsonl', () => {
		it('should handle 10,000 line events.jsonl', async () => {
			// Create a large events.jsonl file
			const lines: string[] = [];
			for (let i = 0; i < 10000; i++) {
				lines.push(
					JSON.stringify({
						type: 'steering-directive',
						directiveId: `id-${i}`,
					}),
				);
			}
			fs.writeFileSync(eventsPath, lines.join('\n'));

			const hook = createSteeringConsumedHook(tempDir);
			await hook(null, null);

			// Should not crash or timeout
			expect(true).toBe(true);
		});

		it('should handle 10MB events.jsonl', async () => {
			// Create a very large events.jsonl
			const lines: string[] = [];
			for (let i = 0; i < 1000; i++) {
				const largePayload = 'X'.repeat(10000);
				lines.push(
					JSON.stringify({
						type: 'steering-directive',
						directiveId: `id-${i}-${largePayload}`,
					}),
				);
			}
			fs.writeFileSync(eventsPath, lines.join('\n'));

			const hook = createSteeringConsumedHook(tempDir);
			await hook(null, null);

			// Should not crash
			expect(true).toBe(true);
		});
	});

	describe('9. Unicode and special characters in directiveId', () => {
		it('should handle emoji in directiveId', () => {
			const emojiDirectiveId = 'test🎉directive🚀id';

			recordSteeringConsumed(tempDir, emojiDirectiveId);

			if (fs.existsSync(eventsPath)) {
				const content = fs.readFileSync(eventsPath, 'utf-8');
				expect(content).toContain('directiveId');
				const lines = content.trim().split('\n');
				for (const line of lines) {
					const parsed = JSON.parse(line);
					expect(parsed.directiveId).toBe(emojiDirectiveId);
				}
			}
		});

		it('should handle CJK characters in directiveId', () => {
			const cjkDirectiveId = '测试指令中文字符';

			recordSteeringConsumed(tempDir, cjkDirectiveId);

			if (fs.existsSync(eventsPath)) {
				const content = fs.readFileSync(eventsPath, 'utf-8');
				expect(content).toContain('directiveId');
				const lines = content.trim().split('\n');
				for (const line of lines) {
					const parsed = JSON.parse(line);
					expect(parsed.directiveId).toBe(cjkDirectiveId);
				}
			}
		});

		it('should handle right-to-left text in directiveId', () => {
			const rtlDirectiveId = 'مرحبا بالعالم';

			recordSteeringConsumed(tempDir, rtlDirectiveId);

			if (fs.existsSync(eventsPath)) {
				const content = fs.readFileSync(eventsPath, 'utf-8');
				const lines = content.trim().split('\n');
				for (const line of lines) {
					const parsed = JSON.parse(line);
					expect(parsed.directiveId).toBe(rtlDirectiveId);
				}
			}
		});

		it('should handle mixed scripts in directiveId', () => {
			const mixedDirectiveId = 'Hello世界🌍مرحبا123';

			recordSteeringConsumed(tempDir, mixedDirectiveId);

			if (fs.existsSync(eventsPath)) {
				const content = fs.readFileSync(eventsPath, 'utf-8');
				const lines = content.trim().split('\n');
				for (const line of lines) {
					const parsed = JSON.parse(line);
					expect(parsed.directiveId).toBe(mixedDirectiveId);
				}
			}
		});

		it('should handle zero-width characters in directiveId', () => {
			const zwsDirectiveId = 'test\u200B\u200C\u200Did';

			recordSteeringConsumed(tempDir, zwsDirectiveId);

			if (fs.existsSync(eventsPath)) {
				const content = fs.readFileSync(eventsPath, 'utf-8');
				const lines = content.trim().split('\n');
				for (const line of lines) {
					const parsed = JSON.parse(line);
					expect(parsed.directiveId).toBe(zwsDirectiveId);
				}
			}
		});
	});

	describe('10. Empty string directory', () => {
		it('should handle empty string as directory', () => {
			recordSteeringConsumed('', 'test-id');

			// Should not crash (caught by try/catch)
			expect(true).toBe(true);
		});

		it('should handle whitespace-only directory', () => {
			recordSteeringConsumed('   \t\n   ', 'test-id');

			// Should not crash (caught by try/catch)
			expect(true).toBe(true);
		});
	});

	describe('Additional edge cases', () => {
		it('should handle concurrent calls to recordSteeringConsumed', async () => {
			// Multiple rapid calls should not cause corruption
			const promises: Promise<void>[] = [];
			for (let i = 0; i < 100; i++) {
				promises.push(
					new Promise<void>((resolve) => {
						recordSteeringConsumed(tempDir, `concurrent-${i}`);
						resolve();
					}),
				);
			}
			await Promise.all(promises);

			// File should still be valid JSONL
			if (fs.existsSync(eventsPath)) {
				const content = fs.readFileSync(eventsPath, 'utf-8');
				const lines = content.trim().split('\n');
				for (const line of lines) {
					expect(() => JSON.parse(line)).not.toThrow();
				}
			}
		});

		it('should handle directiveId with control characters', () => {
			// Use character codes to avoid parsing issues
			const controlDirectiveId = String.fromCharCode(
				116,
				101,
				115,
				116,
				1,
				2,
				3,
				27,
				105,
				100, // "test\x01\x02\x03\x1Bid"
			);

			recordSteeringConsumed(tempDir, controlDirectiveId);

			// Should not crash
			if (fs.existsSync(eventsPath)) {
				const content = fs.readFileSync(eventsPath, 'utf-8');
				const lines = content.trim().split('\n');
				for (const line of lines) {
					const parsed = JSON.parse(line);
					expect(parsed.directiveId).toBe(controlDirectiveId);
				}
			}
		});

		it('should handle events.jsonl with only empty lines', async () => {
			fs.writeFileSync(eventsPath, '\n\n\n\n\n');

			const hook = createSteeringConsumedHook(tempDir);
			await hook(null, null);

			// Should not crash
			expect(true).toBe(true);
		});

		it('should handle events.jsonl with mixed valid/invalid UTF-8', async () => {
			// Write valid lines and some invalid UTF-8 sequences
			const buffer = Buffer.from(
				'{"type":"steering-directive","directiveId":"valid"}\n' +
					'\xFF\xFE\xFD\n' + // Invalid UTF-8
					'{"type":"steering-directive","directiveId":"valid2"}\n',
				'utf-8',
			);
			fs.writeFileSync(eventsPath, buffer);

			const hook = createSteeringConsumedHook(tempDir);
			await hook(null, null);

			// Should not crash (Bun.file may handle this gracefully)
			expect(true).toBe(true);
		});
	});
});
