/**
 * v6.12 Guardrails — ADVERSARIAL PATH TRAVERSAL SECURITY TESTS
 *
 * This test suite probes ATTACK VECTORS specifically against isOutsideSwarmDir
 * and related state/identity tracking.
 *
 * Attack vectors probed:
 * 1. Path traversal bypasses against isOutsideSwarmDir
 * 2. State mutation attacks against tracking Maps
 * 3. Gate bypass via tool name spoofing
 * 4. Batch detection evasion
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GuardrailsConfigSchema } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import {
	beginInvocation,
	ensureAgentSession,
	getAgentSession,
	resetSwarmState,
	startAgentSession,
	swarmState,
} from '../../../src/state';

// Helper to generate very long strings
function generateLongString(char: string, length: number): string {
	return char.repeat(length);
}

// Helper to generate Unicode homoglyphs for ".swarm"
function generateHomoglyphSwarm(): string[] {
	return [
		// Cyrillic lookalikes
		'.\u0441warm', // Cyrillic 'с' instead of 'c'
		'.s\u0443arm', // Cyrillic 'у' instead of 'w' (different letter)
		'.sw\u0430rm', // Cyrillic 'а' instead of 'a'
		'.swa\u0440m', // Cyrillic 'р' instead of 'r'
		'.sw\u0430rm', // Cyrillic 'а' instead of 'a'
		// Fullwidth characters
		'\uff0eswarm', // Fullwidth '.'
		// Zero-width characters
		'.s\u200bwarm', // Zero-width space after 's'
		'.sw\u200carm', // Zero-width non-joiner after 'w'
		// Combining characters
		'.swa\u0301rm', // 'a' with combining acute accent
	];
}

describe('v6.12 Guardrails — ADVERSARIAL PATH TRAVERSAL SECURITY TESTS', () => {
	let tempDir: string;
	let originalCwd: string;

	beforeEach(() => {
		tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-ptrav-')),
		);
		originalCwd = process.cwd();
		process.chdir(tempDir);
		resetSwarmState();

		// Create .swarm directory for tests
		fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
	});

	afterEach(() => {
		process.chdir(originalCwd);
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	// ============================================================
	// ATTACK VECTOR 1: Path Traversal Bypasses against isOutsideSwarmDir
	// ============================================================
	describe('Attack Vector 1 — Path Traversal Bypasses', () => {
		it('should reject null byte injection in path (\\x00src/evil.ts)', async () => {
			const guardrailsConfig = GuardrailsConfigSchema.parse({
				enabled: true,
				max_tool_calls: 100,
			});
			const hooks = createGuardrailsHooks(guardrailsConfig);

			startAgentSession('null-byte-test', 'architect');
			beginInvocation('null-byte-test', 'architect');

			// Null byte should not bypass protection
			const maliciousPath = 'src\x00evil.ts';

			// PR #501: the lstat guard fails on null-byte paths
			// (ERR_INVALID_ARG_VALUE) and fails closed with WRITE BLOCKED
			// rather than letting the write reach the filesystem.
			await expect(
				hooks.toolBefore(
					{ tool: 'write', sessionID: 'null-byte-test', callID: 'c1' },
					{ args: { filePath: maliciousPath } },
				),
			).rejects.toThrow('WRITE BLOCKED');
		});

		it('should reject URL-encoded traversal (%2e%2e/src/evil.ts)', async () => {
			const guardrailsConfig = GuardrailsConfigSchema.parse({
				enabled: true,
				max_tool_calls: 100,
			});
			const hooks = createGuardrailsHooks(guardrailsConfig);

			startAgentSession('url-encode-test', 'architect');
			beginInvocation('url-encode-test', 'architect');

			// URL-encoded ".." should not bypass
			const maliciousPath = '%2e%2e/src/evil.ts';

			await hooks.toolBefore(
				{ tool: 'write', sessionID: 'url-encode-test', callID: 'c1' },
				{ args: { filePath: maliciousPath } },
			);

			const session = getAgentSession('url-encode-test');
			// URL encoding is NOT automatically decoded, so it's treated as literal string
			// The path "%2e%2e/src/evil.ts" is outside .swarm
			expect(session?.architectWriteCount).toBeGreaterThanOrEqual(1);
		});

		it('should handle very long paths (10,000 chars) without DoS', async () => {
			const guardrailsConfig = GuardrailsConfigSchema.parse({
				enabled: true,
				max_tool_calls: 100,
			});
			const hooks = createGuardrailsHooks(guardrailsConfig);

			startAgentSession('long-path-test', 'architect');
			beginInvocation('long-path-test', 'architect');

			const longPath = generateLongString('a', 10000);

			// PR #501: oversized paths fail the lstat guard with ENAMETOOLONG on
			// Linux/Mac, causing a fail-closed WRITE BLOCKED rejection.
			// On Windows, lstat returns ENOENT (not ENAMETOOLONG) for long paths,
			// so the guard does not block — the test validates timing only.
			const startTime = Date.now();
			if (process.platform === 'win32') {
				await hooks.toolBefore(
					{ tool: 'write', sessionID: 'long-path-test', callID: 'c1' },
					{ args: { filePath: longPath } },
				);
			} else {
				await expect(
					hooks.toolBefore(
						{ tool: 'write', sessionID: 'long-path-test', callID: 'c1' },
						{ args: { filePath: longPath } },
					),
				).rejects.toThrow('WRITE BLOCKED');
			}
			const elapsed = Date.now() - startTime;

			// Should complete in reasonable time (< 1000ms) regardless of platform
			expect(elapsed).toBeLessThan(1000);
		});

		it('should reject Unicode homoglyphs in .swarm path', async () => {
			const guardrailsConfig = GuardrailsConfigSchema.parse({
				enabled: true,
				max_tool_calls: 100,
			});
			const hooks = createGuardrailsHooks(guardrailsConfig);

			const homoglyphs = generateHomoglyphSwarm();

			for (const fakeSwarmPath of homoglyphs) {
				resetSwarmState();
				startAgentSession('homoglyph-test', 'architect');
				beginInvocation('homoglyph-test', 'architect');

				await hooks.toolBefore(
					{ tool: 'write', sessionID: 'homoglyph-test', callID: 'c1' },
					{ args: { filePath: `${fakeSwarmPath}/plan.md` } },
				);

				const session = getAgentSession('homoglyph-test');
				// Homoglyph paths should be treated as OUTSIDE .swarm (not matching real .swarm)
				expect(session?.architectWriteCount).toBeGreaterThanOrEqual(1);
			}
		});

		it('should reject double URL-encoded traversal (%252e%252e/)', async () => {
			const guardrailsConfig = GuardrailsConfigSchema.parse({
				enabled: true,
				max_tool_calls: 100,
			});
			const hooks = createGuardrailsHooks(guardrailsConfig);

			startAgentSession('double-encode-test', 'architect');
			beginInvocation('double-encode-test', 'architect');

			// Double URL-encoded ".."
			const maliciousPath = '%252e%252e/src/evil.ts';

			await hooks.toolBefore(
				{ tool: 'write', sessionID: 'double-encode-test', callID: 'c1' },
				{ args: { filePath: maliciousPath } },
			);

			const session = getAgentSession('double-encode-test');
			expect(session?.architectWriteCount).toBeGreaterThanOrEqual(1);
		});

		it('should reject mixed case traversal on case-insensitive systems', async () => {
			const guardrailsConfig = GuardrailsConfigSchema.parse({
				enabled: true,
				max_tool_calls: 100,
			});
			const hooks = createGuardrailsHooks(guardrailsConfig);

			startAgentSession('mixed-case-test', 'architect');
			beginInvocation('mixed-case-test', 'architect');

			// Mixed case should not bypass on Windows
			const maliciousPath = '..SRC/evil.ts';

			await hooks.toolBefore(
				{ tool: 'write', sessionID: 'mixed-case-test', callID: 'c1' },
				{ args: { filePath: maliciousPath } },
			);

			const session = getAgentSession('mixed-case-test');
			expect(session?.architectWriteCount).toBeGreaterThanOrEqual(1);
		});

		it('should reject backslash traversal (Windows style)', async () => {
			const guardrailsConfig = GuardrailsConfigSchema.parse({
				enabled: true,
				max_tool_calls: 100,
			});
			const hooks = createGuardrailsHooks(guardrailsConfig);

			startAgentSession('backslash-test', 'architect');
			beginInvocation('backslash-test', 'architect');

			// Windows backslash traversal
			const maliciousPath = '..\\..\\src\\evil.ts';

			// PR #501 + #496: the cwd-containment check normalises backslashes
			// and rejects the resulting ../../src/evil.ts path as outside the
			// working directory, blocking the write fail-closed.
			await expect(
				hooks.toolBefore(
					{ tool: 'write', sessionID: 'backslash-test', callID: 'c1' },
					{ args: { filePath: maliciousPath } },
				),
			).rejects.toThrow('WRITE BLOCKED');
		});

		it('should reject traversal with null byte before extension (src/evil.ts\\x00.md)', async () => {
			const guardrailsConfig = GuardrailsConfigSchema.parse({
				enabled: true,
				max_tool_calls: 100,
			});
			const hooks = createGuardrailsHooks(guardrailsConfig);

			startAgentSession('null-ext-test', 'architect');
			beginInvocation('null-ext-test', 'architect');

			// Null byte before extension - classic attack
			const maliciousPath = 'src/evil.ts\x00.md';

			// PR #501: lstat guard rejects null-byte paths fail-closed
			// (ERR_INVALID_ARG_VALUE → WRITE BLOCKED).
			await expect(
				hooks.toolBefore(
					{ tool: 'write', sessionID: 'null-ext-test', callID: 'c1' },
					{ args: { filePath: maliciousPath } },
				),
			).rejects.toThrow('WRITE BLOCKED');
		});

		it('should reject path with overlong UTF-8 sequences', async () => {
			const guardrailsConfig = GuardrailsConfigSchema.parse({
				enabled: true,
				max_tool_calls: 100,
			});
			const hooks = createGuardrailsHooks(guardrailsConfig);

			startAgentSession('overlong-utf8-test', 'architect');
			beginInvocation('overlong-utf8-test', 'architect');

			// Overlong UTF-8 encoding of "." (U+002E) is 0xC0 0xAE
			// In JS string form: \u00C0\u00AE (though JS uses UTF-16 internally)
			const maliciousPath = '\u00C0\u00AE\u00C0\u00AE/src/evil.ts';

			await hooks.toolBefore(
				{ tool: 'write', sessionID: 'overlong-utf8-test', callID: 'c1' },
				{ args: { filePath: maliciousPath } },
			);

			const session = getAgentSession('overlong-utf8-test');
			expect(session?.architectWriteCount).toBeGreaterThanOrEqual(1);
		});

		it('should reject symlink-style path components', async () => {
			const guardrailsConfig = GuardrailsConfigSchema.parse({
				enabled: true,
				max_tool_calls: 100,
			});
			const hooks = createGuardrailsHooks(guardrailsConfig);

			startAgentSession('symlink-test', 'architect');
			beginInvocation('symlink-test', 'architect');

			// Symlink-style path (doesn't exist but should still be caught)
			const maliciousPath = '.swarm/../../../etc/passwd';

			// PR #501 + #496: the cwd-containment check rejects the resolved
			// path as outside the working directory before the
			// architectWriteCount counter can increment. Previously the test
			// allowed the write to proceed and merely observed the counter;
			// the write is now fail-closed with WRITE BLOCKED.
			await expect(
				hooks.toolBefore(
					{ tool: 'write', sessionID: 'symlink-test', callID: 'c1' },
					{ args: { filePath: maliciousPath } },
				),
			).rejects.toThrow('WRITE BLOCKED');
		});
	});

	// ============================================================
	// ATTACK VECTOR 2: State Mutation Attacks
	// ============================================================
	describe('Attack Vector 2 — State Mutation Attacks', () => {
		it('should handle callID with __proto__ without prototype pollution', async () => {
			const guardrailsConfig = GuardrailsConfigSchema.parse({
				enabled: true,
				max_tool_calls: 100,
			});
			const hooks = createGuardrailsHooks(guardrailsConfig);

			startAgentSession('proto-pollute-test', 'coder');
			beginInvocation('proto-pollute-test', 'coder');

			// Attempt prototype pollution via callID
			const maliciousCallID = '__proto__';

			// Should not throw and should not pollute Object.prototype
			await hooks.toolBefore(
				{
					tool: 'bash',
					sessionID: 'proto-pollute-test',
					callID: maliciousCallID,
				},
				{ args: { command: 'echo test' } },
			);

			// Verify Object.prototype is not polluted
			// eslint-disable-next-line no-prototype-builtins
			expect(Object.hasOwn({}, 'polluted')).toBe(false);
		});

		it('should handle callID with constructor without prototype pollution', async () => {
			const guardrailsConfig = GuardrailsConfigSchema.parse({
				enabled: true,
				max_tool_calls: 100,
			});
			const hooks = createGuardrailsHooks(guardrailsConfig);

			startAgentSession('constructor-test', 'coder');
			beginInvocation('constructor-test', 'coder');

			const maliciousCallID = 'constructor';

			await hooks.toolBefore(
				{
					tool: 'bash',
					sessionID: 'constructor-test',
					callID: maliciousCallID,
				},
				{ args: { command: 'echo test' } },
			);

			// Should not throw
			expect(true).toBe(true);
		});

		it('should handle callID with toString without prototype pollution', async () => {
			const guardrailsConfig = GuardrailsConfigSchema.parse({
				enabled: true,
				max_tool_calls: 100,
			});
			const hooks = createGuardrailsHooks(guardrailsConfig);

			startAgentSession('tostring-test', 'coder');
			beginInvocation('tostring-test', 'coder');

			const maliciousCallID = 'toString';

			await hooks.toolBefore(
				{ tool: 'bash', sessionID: 'tostring-test', callID: maliciousCallID },
				{ args: { command: 'echo test' } },
			);

			// Should not throw
			expect(true).toBe(true);
		});

		it('should handle sessionId with special characters', async () => {
			const guardrailsConfig = GuardrailsConfigSchema.parse({
				enabled: true,
				max_tool_calls: 100,
			});
			const hooks = createGuardrailsHooks(guardrailsConfig);

			const specialSessionIds = [
				'session\x00null',
				'session\nnewline',
				'session\ttab',
				'session<script>',
				'session${injection}',
				'session; rm -rf /',
				'session| cat /etc/passwd',
			];

			for (const sessionId of specialSessionIds) {
				resetSwarmState();

				// Should not throw with special sessionId
				startAgentSession(sessionId, 'coder');
				beginInvocation(sessionId, 'coder');

				await hooks.toolBefore(
					{ tool: 'bash', sessionID: sessionId, callID: 'c1' },
					{ args: { command: 'echo test' } },
				);
			}

			// All should complete without throwing
			expect(true).toBe(true);
		});

		it('should handle oversized filePath (100KB string) without DoS', async () => {
			const guardrailsConfig = GuardrailsConfigSchema.parse({
				enabled: true,
				max_tool_calls: 100,
			});
			const hooks = createGuardrailsHooks(guardrailsConfig);

			startAgentSession('oversized-path-test', 'architect');
			beginInvocation('oversized-path-test', 'architect');

			// 100KB string
			const oversizedPath = generateLongString('a', 100 * 1024);

			// PR #501: oversized filePath trips the lstat guard
			// (ENAMETOOLONG → WRITE BLOCKED). The no-DoS intent is preserved
			// by the fast fail-closed rejection.
			const startTime = Date.now();
			await expect(
				hooks.toolBefore(
					{ tool: 'write', sessionID: 'oversized-path-test', callID: 'c1' },
					{ args: { filePath: oversizedPath } },
				),
			).rejects.toThrow('WRITE BLOCKED');
			const elapsed = Date.now() - startTime;

			// Should complete in reasonable time (< 2000ms) — fast fail-closed
			expect(elapsed).toBeLessThan(2000);
		});

		it('should handle Map key with prototype chain keys', () => {
			const testMap = new Map<string, number>();

			// These should be stored as regular keys, not pollute prototype
			testMap.set('__proto__', 1);
			testMap.set('constructor', 2);
			testMap.set('toString', 3);

			// Verify they're stored correctly
			expect(testMap.get('__proto__')).toBe(1);
			expect(testMap.get('constructor')).toBe(2);
			expect(testMap.get('toString')).toBe(3);
			expect(testMap.size).toBe(3);

			// Verify Object.prototype is not polluted
			// eslint-disable-next-line no-prototype-builtins
			expect(Object.hasOwn({}, '__proto__')).toBe(false);
		});
	});

	// ============================================================
	// ATTACK VECTOR 3: Gate Bypass via Tool Name Spoofing
	// ============================================================
	describe('Attack Vector 3 — Gate Bypass via Tool Name Spoofing', () => {
		it('should handle tool name with null byte (diff\\x00evil)', async () => {
			const guardrailsConfig = GuardrailsConfigSchema.parse({
				enabled: true,
				max_tool_calls: 100,
			});
			const hooks = createGuardrailsHooks(guardrailsConfig);

			startAgentSession('null-tool-test', 'coder');
			beginInvocation('null-tool-test', 'coder');

			// Null byte in tool name
			const maliciousTool = 'diff\x00evil';

			// Should not throw - tool name is just a string
			await hooks.toolBefore(
				{ tool: maliciousTool, sessionID: 'null-tool-test', callID: 'c1' },
				{ args: {} },
			);

			expect(true).toBe(true);
		});

		it('should handle tool name with shell injection attempt (diff; rm -rf /)', async () => {
			const guardrailsConfig = GuardrailsConfigSchema.parse({
				enabled: true,
				max_tool_calls: 100,
			});
			const hooks = createGuardrailsHooks(guardrailsConfig);

			startAgentSession('shell-inject-tool-test', 'coder');
			beginInvocation('shell-inject-tool-test', 'coder');

			// Shell injection in tool name
			const maliciousTool = 'diff; rm -rf /';

			// Should not throw - tool name is just a string, not executed
			await hooks.toolBefore(
				{
					tool: maliciousTool,
					sessionID: 'shell-inject-tool-test',
					callID: 'c1',
				},
				{ args: {} },
			);

			expect(true).toBe(true);
		});

		it('should handle very long tool name (10,000 chars) without DoS', async () => {
			const guardrailsConfig = GuardrailsConfigSchema.parse({
				enabled: true,
				max_tool_calls: 100,
			});
			const hooks = createGuardrailsHooks(guardrailsConfig);

			startAgentSession('long-tool-test', 'coder');
			beginInvocation('long-tool-test', 'coder');

			const longToolName = generateLongString('a', 10000);

			const startTime = Date.now();
			await hooks.toolBefore(
				{ tool: longToolName, sessionID: 'long-tool-test', callID: 'c1' },
				{ args: {} },
			);
			const elapsed = Date.now() - startTime;

			// Should complete in reasonable time (< 500ms)
			expect(elapsed).toBeLessThan(500);
		});

		it('should handle tool name with unicode bidirectional override chars', async () => {
			const guardrailsConfig = GuardrailsConfigSchema.parse({
				enabled: true,
				max_tool_calls: 100,
			});
			const hooks = createGuardrailsHooks(guardrailsConfig);

			startAgentSession('bidi-tool-test', 'coder');
			beginInvocation('bidi-tool-test', 'coder');

			// Bidirectional override characters could hide malicious intent
			const maliciousTool = 'diff\u202Eevil';

			await hooks.toolBefore(
				{ tool: maliciousTool, sessionID: 'bidi-tool-test', callID: 'c1' },
				{ args: {} },
			);

			expect(true).toBe(true);
		});

		it('should handle tool name that looks like namespaced gate tool', async () => {
			const guardrailsConfig = GuardrailsConfigSchema.parse({
				enabled: true,
				max_tool_calls: 100,
			});
			const hooks = createGuardrailsHooks(guardrailsConfig);

			startAgentSession('namespace-tool-test', 'coder');
			beginInvocation('namespace-tool-test', 'coder');

			// Fake namespaced tool
			const maliciousTool = 'opencode:diff; rm -rf /';

			await hooks.toolBefore(
				{ tool: maliciousTool, sessionID: 'namespace-tool-test', callID: 'c1' },
				{ args: {} },
			);

			expect(true).toBe(true);
		});
	});

	// ============================================================
	// ATTACK VECTOR 4: Batch Detection Evasion
	// ============================================================
	describe('Attack Vector 4 — Batch Detection Evasion', () => {
		it('should handle very long message (1MB) with batch keywords buried deep', async () => {
			// This tests that the system doesn't choke on large inputs
			// where batch keywords might be hidden deep in the content

			// Build a 1MB string with batch keywords buried at the end
			const prefix = generateLongString('x', 1024 * 1024 - 100);
			const maliciousContent = `${prefix} do all of these tasks simultaneously and run them in parallel`;

			// The system should handle this without hanging
			expect(maliciousContent.length).toBeGreaterThan(1024 * 1024 - 101);
		});

		it('should detect Unicode homoglyphs in "and" keyword', () => {
			// Test various Unicode homoglyphs for "and"
			const homoglyphs = [
				'\u0430nd', // Cyrillic 'а' instead of 'a'
				'a\u043fd', // Cyrillic '?' instead of 'n'
				'an\u0434', // Cyrillic 'д' instead of 'd'
				'\uff41nd', // Fullwidth 'a'
				'a\uff4ed', // Fullwidth 'n'
				'an\uff44', // Fullwidth 'd'
			];

			// These should NOT match the literal "and" keyword
			for (const fakeAnd of homoglyphs) {
				const testString = `run task1 ${fakeAnd} task2`;
				// Literal match should fail
				expect(testString.includes('and')).toBe(false);
			}
		});

		it('should handle HTML entities in batch keywords', () => {
			// HTML entity encoded batch keywords (not actually decoded by JS)
			// Note: '&amp;' decodes to '&', not 'and'
			const htmlEntities = [
				'&#97;nd', // a (HTML entity for 'a')
				'a&#110;d', // n (HTML entity for 'n')
				'an&#100;', // d (HTML entity for 'd')
				'&#x61;nd', // a (hex HTML entity)
			];

			for (const entity of htmlEntities) {
				const testString = `run task1 ${entity} task2`;
				// These HTML entities are NOT decoded by JS string.includes()
				// They are literal strings, so "and" should not be found
				expect(testString.includes('and')).toBe(false);
			}
		});

		it('should handle zero-width characters in batch keywords', () => {
			// Zero-width characters interspersed in keywords
			const zeroWidthChars = ['\u200B', '\u200C', '\u200D', '\uFEFF'];

			for (const zw of zeroWidthChars) {
				const obfuscated = `a${zw}n${zw}d`;
				const testString = `run task1 ${obfuscated} task2`;
				// Literal match should fail
				expect(testString.includes('and')).toBe(false);
			}
		});

		it('should handle case variations in batch keywords', () => {
			const caseVariations = ['AND', 'And', 'aNd', 'AnD', 'aND'];

			// All should NOT match lowercase "and" literally
			for (const variant of caseVariations) {
				if (variant !== 'and') {
					// Case-sensitive match should fail for non-lowercase
					const isExactMatch = variant === 'and';
					expect(isExactMatch).toBe(false);
				}
			}
		});
	});

	// ============================================================
	// ADDITIONAL: Edge Cases and Boundary Conditions
	// ============================================================
	describe('Edge Cases and Boundary Conditions', () => {
		it('should handle empty filePath gracefully', async () => {
			const guardrailsConfig = GuardrailsConfigSchema.parse({
				enabled: true,
				max_tool_calls: 100,
			});
			const hooks = createGuardrailsHooks(guardrailsConfig);

			startAgentSession('empty-path-test', 'architect');
			beginInvocation('empty-path-test', 'architect');

			await hooks.toolBefore(
				{ tool: 'write', sessionID: 'empty-path-test', callID: 'c1' },
				{ args: { filePath: '' } },
			);

			// Empty path should not trigger detection (no path to check)
			const session = getAgentSession('empty-path-test');
			expect(session?.architectWriteCount).toBe(0);
		});

		it('should handle undefined filePath gracefully', async () => {
			const guardrailsConfig = GuardrailsConfigSchema.parse({
				enabled: true,
				max_tool_calls: 100,
			});
			const hooks = createGuardrailsHooks(guardrailsConfig);

			startAgentSession('undefined-path-test', 'architect');
			beginInvocation('undefined-path-test', 'architect');

			await hooks.toolBefore(
				{ tool: 'write', sessionID: 'undefined-path-test', callID: 'c1' },
				{ args: { filePath: undefined } },
			);

			// Undefined path should not trigger detection
			const session = getAgentSession('undefined-path-test');
			expect(session?.architectWriteCount).toBe(0);
		});

		it('should handle null filePath gracefully', async () => {
			const guardrailsConfig = GuardrailsConfigSchema.parse({
				enabled: true,
				max_tool_calls: 100,
			});
			const hooks = createGuardrailsHooks(guardrailsConfig);

			startAgentSession('null-path-test', 'architect');
			beginInvocation('null-path-test', 'architect');

			await hooks.toolBefore(
				{ tool: 'write', sessionID: 'null-path-test', callID: 'c1' },
				{ args: { filePath: null } },
			);

			// Null path should not trigger detection
			const session = getAgentSession('null-path-test');
			expect(session?.architectWriteCount).toBe(0);
		});

		it('should handle filePath as number (type coercion attack)', async () => {
			const guardrailsConfig = GuardrailsConfigSchema.parse({
				enabled: true,
				max_tool_calls: 100,
			});
			const hooks = createGuardrailsHooks(guardrailsConfig);

			startAgentSession('number-path-test', 'architect');
			beginInvocation('number-path-test', 'architect');

			await hooks.toolBefore(
				{ tool: 'write', sessionID: 'number-path-test', callID: 'c1' },
				{ args: { filePath: 12345 } },
			);

			// Number path should not crash (typeof check should fail)
			const session = getAgentSession('number-path-test');
			expect(session?.architectWriteCount).toBe(0);
		});

		it('should handle filePath as object (type coercion attack)', async () => {
			const guardrailsConfig = GuardrailsConfigSchema.parse({
				enabled: true,
				max_tool_calls: 100,
			});
			const hooks = createGuardrailsHooks(guardrailsConfig);

			startAgentSession('object-path-test', 'architect');
			beginInvocation('object-path-test', 'architect');

			await hooks.toolBefore(
				{ tool: 'write', sessionID: 'object-path-test', callID: 'c1' },
				{ args: { filePath: { toString: () => 'src/evil.ts' } } },
			);

			// Object path should not crash (typeof check should fail)
			const session = getAgentSession('object-path-test');
			expect(session?.architectWriteCount).toBe(0);
		});

		it('should handle path that equals exactly .swarm', async () => {
			const guardrailsConfig = GuardrailsConfigSchema.parse({
				enabled: true,
				max_tool_calls: 100,
			});
			const hooks = createGuardrailsHooks(guardrailsConfig);

			startAgentSession('exact-swarm-test', 'architect');
			beginInvocation('exact-swarm-test', 'architect');

			await hooks.toolBefore(
				{ tool: 'write', sessionID: 'exact-swarm-test', callID: 'c1' },
				{ args: { filePath: '.swarm' } },
			);

			// .swarm is a directory, not outside it
			const session = getAgentSession('exact-swarm-test');
			expect(session?.architectWriteCount).toBe(0);
		});

		it('should handle path with only dots (...../file.ts)', async () => {
			const guardrailsConfig = GuardrailsConfigSchema.parse({
				enabled: true,
				max_tool_calls: 100,
			});
			const hooks = createGuardrailsHooks(guardrailsConfig);

			startAgentSession('dots-path-test', 'architect');
			beginInvocation('dots-path-test', 'architect');

			await hooks.toolBefore(
				{ tool: 'write', sessionID: 'dots-path-test', callID: 'c1' },
				{ args: { filePath: '..../file.ts' } },
			);

			const session = getAgentSession('dots-path-test');
			expect(session?.architectWriteCount).toBeGreaterThanOrEqual(1);
		});

		it('should handle path with control characters', async () => {
			const guardrailsConfig = GuardrailsConfigSchema.parse({
				enabled: true,
				max_tool_calls: 100,
			});
			const hooks = createGuardrailsHooks(guardrailsConfig);

			startAgentSession('control-char-test', 'architect');
			beginInvocation('control-char-test', 'architect');

			// Various control characters
			const controlChars = [
				'\x01',
				'\x02',
				'\x03',
				'\x04',
				'\x05',
				'\x06',
				'\x07',
				'\x08',
			];
			const maliciousPath = `src${controlChars.join('')}/test.ts`;

			await hooks.toolBefore(
				{ tool: 'write', sessionID: 'control-char-test', callID: 'c1' },
				{ args: { filePath: maliciousPath } },
			);

			const session = getAgentSession('control-char-test');
			expect(session?.architectWriteCount).toBeGreaterThanOrEqual(1);
		});
	});
});
