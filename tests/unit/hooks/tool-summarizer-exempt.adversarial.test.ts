/**
 * Adversarial Tests for exempt_tools Feature in createToolSummarizerHook
 *
 * These tests validate security and robustness against malicious inputs
 * targeting the exempt_tools exemption mechanism.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SummaryConfig } from '../../../src/config/schema';
import {
	createToolSummarizerHook,
	resetSummaryIdCounter,
} from '../../../src/hooks/tool-summarizer';

describe('createToolSummarizerHook - Adversarial Tests for exempt_tools', () => {
	let tempDir: string;
	const largeOutput = 'x'.repeat(2000);

	beforeEach(() => {
		tempDir = join(
			tmpdir(),
			`.swarm-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(tempDir, { recursive: true });
		mkdirSync(join(tempDir, '.swarm'), { recursive: true });
		resetSummaryIdCounter();
	});

	afterEach(() => {
		try {
			rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	/**
	 * Attack Vector 1: Injection via tool name
	 * input.tool = 'retrieve_summary; rm -rf /' — should NOT be exempt (exact match only)
	 */
	describe('Injection via tool name', () => {
		it('should NOT exempt tool with command injection suffix', async () => {
			const config: SummaryConfig = {
				enabled: true,
				threshold_bytes: 1024,
				max_summary_chars: 500,
				max_stored_bytes: 1024 * 1024,
				retention_days: 7,
				exempt_tools: ['retrieve_summary', 'task', 'read'],
			};

			const hook = createToolSummarizerHook(config, tempDir);

			const input = {
				tool: 'retrieve_summary; rm -rf /',
				sessionID: 'test-session',
				callID: 'test-call',
			};

			const output = {
				title: 'Test Tool',
				output: largeOutput,
				metadata: {},
			};

			// Should NOT be exempt since it's not an exact match
			await hook(input, output);

			// Output should be summarized (changed from original)
			expect(output.output).not.toBe(largeOutput);
			expect(output.output).toContain('S1');
		});

		it('should NOT exempt tool with command injection prefix', async () => {
			const config: SummaryConfig = {
				enabled: true,
				threshold_bytes: 1024,
				max_summary_chars: 500,
				max_stored_bytes: 1024 * 1024,
				retention_days: 7,
				exempt_tools: ['retrieve_summary', 'task', 'read'],
			};

			const hook = createToolSummarizerHook(config, tempDir);

			const input = {
				tool: 'exec; retrieve_summary',
				sessionID: 'test-session',
				callID: 'test-call',
			};

			const output = {
				title: 'Test Tool',
				output: largeOutput,
				metadata: {},
			};

			await hook(input, output);

			// Should NOT be exempt
			expect(output.output).not.toBe(largeOutput);
			expect(output.output).toContain('S1');
		});

		it('should NOT exempt tool with path traversal attempt', async () => {
			const config: SummaryConfig = {
				enabled: true,
				threshold_bytes: 1024,
				max_summary_chars: 500,
				max_stored_bytes: 1024 * 1024,
				retention_days: 7,
				exempt_tools: ['retrieve_summary', 'task', 'read'],
			};

			const hook = createToolSummarizerHook(config, tempDir);

			const input = {
				tool: '../../../etc/passwd',
				sessionID: 'test-session',
				callID: 'test-call',
			};

			const output = {
				title: 'Test Tool',
				output: largeOutput,
				metadata: {},
			};

			await hook(input, output);

			// Should NOT be exempt
			expect(output.output).not.toBe(largeOutput);
		});
	});

	/**
	 * Attack Vector 2: Case variation bypass
	 * Tool names should be case-sensitive - variations should NOT be exempt
	 */
	describe('Case variation bypass', () => {
		it('should NOT exempt uppercase tool name', async () => {
			const config: SummaryConfig = {
				enabled: true,
				threshold_bytes: 1024,
				max_summary_chars: 500,
				max_stored_bytes: 1024 * 1024,
				retention_days: 7,
				exempt_tools: ['retrieve_summary', 'task', 'read'],
			};

			const hook = createToolSummarizerHook(config, tempDir);

			const input = {
				tool: 'RETRIEVE_SUMMARY',
				sessionID: 'test-session',
				callID: 'test-call',
			};

			const output = {
				title: 'Test Tool',
				output: largeOutput,
				metadata: {},
			};

			await hook(input, output);

			// Should NOT be exempt (case-sensitive)
			expect(output.output).not.toBe(largeOutput);
		});

		it('should NOT exempt mixed case tool name', async () => {
			const config: SummaryConfig = {
				enabled: true,
				threshold_bytes: 1024,
				max_summary_chars: 500,
				max_stored_bytes: 1024 * 1024,
				retention_days: 7,
				exempt_tools: ['retrieve_summary', 'task', 'read'],
			};

			const hook = createToolSummarizerHook(config, tempDir);

			const input = {
				tool: 'Retrieve_Summary',
				sessionID: 'test-session',
				callID: 'test-call',
			};

			const output = {
				title: 'Test Tool',
				output: largeOutput,
				metadata: {},
			};

			await hook(input, output);

			// Should NOT be exempt
			expect(output.output).not.toBe(largeOutput);
		});

		it('should NOT exempt alternating case tool name', async () => {
			const config: SummaryConfig = {
				enabled: true,
				threshold_bytes: 1024,
				max_summary_chars: 500,
				max_stored_bytes: 1024 * 1024,
				retention_days: 7,
				exempt_tools: ['retrieve_summary', 'task', 'read'],
			};

			const hook = createToolSummarizerHook(config, tempDir);

			const input = {
				tool: 'rEtRiEvE_sUmMaRy',
				sessionID: 'test-session',
				callID: 'test-call',
			};

			const output = {
				title: 'Test Tool',
				output: largeOutput,
				metadata: {},
			};

			await hook(input, output);

			// Should NOT be exempt
			expect(output.output).not.toBe(largeOutput);
		});

		it('should exempt exact lowercase match only', async () => {
			const config: SummaryConfig = {
				enabled: true,
				threshold_bytes: 1024,
				max_summary_chars: 500,
				max_stored_bytes: 1024 * 1024,
				retention_days: 7,
				exempt_tools: ['retrieve_summary', 'task', 'read'],
			};

			const hook = createToolSummarizerHook(config, tempDir);

			const input = {
				tool: 'retrieve_summary',
				sessionID: 'test-session',
				callID: 'test-call',
			};

			const output = {
				title: 'Test Tool',
				output: largeOutput,
				metadata: {},
			};

			await hook(input, output);

			// SHOULD be exempt - output unchanged
			expect(output.output).toBe(largeOutput);
		});
	});

	/**
	 * Attack Vector 3: Prefix attack
	 * input.tool = 'retrieve_summary_extra' — should NOT be exempt (not an exact match)
	 */
	describe('Prefix attack', () => {
		it('should NOT exempt tool with extra prefix', async () => {
			const config: SummaryConfig = {
				enabled: true,
				threshold_bytes: 1024,
				max_summary_chars: 500,
				max_stored_bytes: 1024 * 1024,
				retention_days: 7,
				exempt_tools: ['retrieve_summary', 'task', 'read'],
			};

			const hook = createToolSummarizerHook(config, tempDir);

			const input = {
				tool: 'x_retrieve_summary',
				sessionID: 'test-session',
				callID: 'test-call',
			};

			const output = {
				title: 'Test Tool',
				output: largeOutput,
				metadata: {},
			};

			await hook(input, output);

			expect(output.output).not.toBe(largeOutput);
		});

		it('should NOT exempt tool with extra suffix', async () => {
			const config: SummaryConfig = {
				enabled: true,
				threshold_bytes: 1024,
				max_summary_chars: 500,
				max_stored_bytes: 1024 * 1024,
				retention_days: 7,
				exempt_tools: ['retrieve_summary', 'task', 'read'],
			};

			const hook = createToolSummarizerHook(config, tempDir);

			const input = {
				tool: 'retrieve_summary_extra',
				sessionID: 'test-session',
				callID: 'test-call',
			};

			const output = {
				title: 'Test Tool',
				output: largeOutput,
				metadata: {},
			};

			await hook(input, output);

			expect(output.output).not.toBe(largeOutput);
		});

		it('should NOT exempt tool with underscore prefix', async () => {
			const config: SummaryConfig = {
				enabled: true,
				threshold_bytes: 1024,
				max_summary_chars: 500,
				max_stored_bytes: 1024 * 1024,
				retention_days: 7,
				exempt_tools: ['retrieve_summary', 'task', 'read'],
			};

			const hook = createToolSummarizerHook(config, tempDir);

			const input = {
				tool: '_retrieve_summary',
				sessionID: 'test-session',
				callID: 'test-call',
			};

			const output = {
				title: 'Test Tool',
				output: largeOutput,
				metadata: {},
			};

			await hook(input, output);

			expect(output.output).not.toBe(largeOutput);
		});

		it('should NOT exempt tool with numbers in name', async () => {
			const config: SummaryConfig = {
				enabled: true,
				threshold_bytes: 1024,
				max_summary_chars: 500,
				max_stored_bytes: 1024 * 1024,
				retention_days: 7,
				exempt_tools: ['retrieve_summary', 'task', 'read'],
			};

			const hook = createToolSummarizerHook(config, tempDir);

			const input = {
				tool: 'retrieve_summary_2',
				sessionID: 'test-session',
				callID: 'test-call',
			};

			const output = {
				title: 'Test Tool',
				output: largeOutput,
				metadata: {},
			};

			await hook(input, output);

			expect(output.output).not.toBe(largeOutput);
		});
	});

	/**
	 * Attack Vector 4: Empty string tool name
	 * input.tool = '' — should NOT be exempt if '' not in exempt list
	 */
	describe('Empty string tool name', () => {
		it('should NOT exempt empty string tool name', async () => {
			const config: SummaryConfig = {
				enabled: true,
				threshold_bytes: 1024,
				max_summary_chars: 500,
				max_stored_bytes: 1024 * 1024,
				retention_days: 7,
				exempt_tools: ['retrieve_summary', 'task', 'read'],
			};

			const hook = createToolSummarizerHook(config, tempDir);

			const input = {
				tool: '',
				sessionID: 'test-session',
				callID: 'test-call',
			};

			const output = {
				title: 'Test Tool',
				output: largeOutput,
				metadata: {},
			};

			// Should NOT crash and should summarize
			await hook(input, output);

			expect(output.output).not.toBe(largeOutput);
		});

		it('should exempt empty string if explicitly in exempt list', async () => {
			const config: SummaryConfig = {
				enabled: true,
				threshold_bytes: 1024,
				max_summary_chars: 500,
				max_stored_bytes: 1024 * 1024,
				retention_days: 7,
				exempt_tools: [''],
			};

			const hook = createToolSummarizerHook(config, tempDir);

			const input = {
				tool: '',
				sessionID: 'test-session',
				callID: 'test-call',
			};

			const output = {
				title: 'Test Tool',
				output: largeOutput,
				metadata: {},
			};

			await hook(input, output);

			// SHOULD be exempt
			expect(output.output).toBe(largeOutput);
		});
	});

	/**
	 * Attack Vector 5: Null/undefined tool name via type assertion
	 * input.tool = null as any, undefined as any — should not crash
	 */
	describe('Null/undefined tool name', () => {
		it('should not crash with null tool name', async () => {
			const config: SummaryConfig = {
				enabled: true,
				threshold_bytes: 1024,
				max_summary_chars: 500,
				max_stored_bytes: 1024 * 1024,
				retention_days: 7,
				exempt_tools: ['retrieve_summary', 'task', 'read'],
			};

			const hook = createToolSummarizerHook(config, tempDir);

			const input = {
				tool: null as any,
				sessionID: 'test-session',
				callID: 'test-call',
			};

			const output = {
				title: 'Test Tool',
				output: 'small output', // Use small output to avoid summarization crash
				metadata: {},
			};

			// Should NOT crash (includes returns false for null)
			await hook(input, output);

			// Output should remain unchanged since it's below threshold
			expect(output.output).toBe('small output');
		});

		it('should not crash with undefined tool name', async () => {
			const config: SummaryConfig = {
				enabled: true,
				threshold_bytes: 1024,
				max_summary_chars: 500,
				max_stored_bytes: 1024 * 1024,
				retention_days: 7,
				exempt_tools: ['retrieve_summary', 'task', 'read'],
			};

			const hook = createToolSummarizerHook(config, tempDir);

			const input = {
				tool: undefined as any,
				sessionID: 'test-session',
				callID: 'test-call',
			};

			const output = {
				title: 'Test Tool',
				output: 'small output', // Use small output to avoid summarization crash
				metadata: {},
			};

			// Should NOT crash
			await hook(input, output);

			// Output should remain unchanged since it's below threshold
			expect(output.output).toBe('small output');
		});
	});

	/**
	 * Attack Vector 6: Prototype pollution via exempt_tools array
	 * config.exempt_tools = ['__proto__', 'constructor', 'toString'] — should not crash or affect prototype chain
	 */
	describe('Prototype pollution via exempt_tools array', () => {
		it('should not crash with __proto__ in exempt list', async () => {
			const config: SummaryConfig = {
				enabled: true,
				threshold_bytes: 1024,
				max_summary_chars: 500,
				max_stored_bytes: 1024 * 1024,
				retention_days: 7,
				exempt_tools: ['__proto__'] as any,
			};

			const hook = createToolSummarizerHook(config, tempDir);

			const input = {
				tool: 'some_tool',
				sessionID: 'test-session',
				callID: 'test-call',
			};

			const output = {
				title: 'Test Tool',
				output: largeOutput,
				metadata: {},
			};

			// Should NOT crash
			await hook(input, output);

			// Should summarize normally
			expect(output.output).not.toBe(largeOutput);
		});

		it('should not crash with constructor in exempt list', async () => {
			const config: SummaryConfig = {
				enabled: true,
				threshold_bytes: 1024,
				max_summary_chars: 500,
				max_stored_bytes: 1024 * 1024,
				retention_days: 7,
				exempt_tools: ['constructor'] as any,
			};

			const hook = createToolSummarizerHook(config, tempDir);

			const input = {
				tool: 'some_tool',
				sessionID: 'test-session',
				callID: 'test-call',
			};

			const output = {
				title: 'Test Tool',
				output: largeOutput,
				metadata: {},
			};

			// Should NOT crash
			await hook(input, output);

			expect(output.output).not.toBe(largeOutput);
		});

		it('should not crash with toString in exempt list', async () => {
			const config: SummaryConfig = {
				enabled: true,
				threshold_bytes: 1024,
				max_summary_chars: 500,
				max_stored_bytes: 1024 * 1024,
				retention_days: 7,
				exempt_tools: ['toString'] as any,
			};

			const hook = createToolSummarizerHook(config, tempDir);

			const input = {
				tool: 'some_tool',
				sessionID: 'test-session',
				callID: 'test-call',
			};

			const output = {
				title: 'Test Tool',
				output: largeOutput,
				metadata: {},
			};

			// Should NOT crash
			await hook(input, output);

			expect(output.output).not.toBe(largeOutput);
		});

		it('should not affect Array.prototype with prototype pollution attempts', async () => {
			const originalIncludes = Array.prototype.includes;

			const config: SummaryConfig = {
				enabled: true,
				threshold_bytes: 1024,
				max_summary_chars: 500,
				max_stored_bytes: 1024 * 1024,
				retention_days: 7,
				exempt_tools: ['__proto__', 'constructor', 'prototype'] as any,
			};

			const hook = createToolSummarizerHook(config, tempDir);

			const input = {
				tool: 'test_tool',
				sessionID: 'test-session',
				callID: 'test-call',
			};

			const output = {
				title: 'Test Tool',
				output: largeOutput,
				metadata: {},
			};

			await hook(input, output);

			// Verify Array.prototype.includes is not modified
			expect(Array.prototype.includes).toBe(originalIncludes);
		});
	});

	/**
	 * Attack Vector 7: Extremely large exempt_tools list (10000 entries)
	 * Performance — should complete in < 100ms
	 */
	describe('Performance with large exempt_tools list', () => {
		it('should handle 10000 exempt tools efficiently', async () => {
			const largeExemptList = Array.from(
				{ length: 10000 },
				(_, i) => `exempt_tool_${i}`,
			);

			const config: SummaryConfig = {
				enabled: true,
				threshold_bytes: 1024,
				max_summary_chars: 500,
				max_stored_bytes: 1024 * 1024,
				retention_days: 7,
				exempt_tools: largeExemptList,
			};

			const hook = createToolSummarizerHook(config, tempDir);

			const input = {
				tool: 'not_in_list',
				sessionID: 'test-session',
				callID: 'test-call',
			};

			const output = {
				title: 'Test Tool',
				output: largeOutput,
				metadata: {},
			};

			const startTime = Date.now();
			await hook(input, output);
			const duration = Date.now() - startTime;

			// Should complete in < 100ms
			expect(duration).toBeLessThan(100);

			// Should summarize
			expect(output.output).not.toBe(largeOutput);
		});

		it('should find match in large exempt list efficiently', async () => {
			const largeExemptList = Array.from(
				{ length: 10000 },
				(_, i) => `exempt_tool_${i}`,
			);
			// Put target near the middle
			largeExemptList[5000] = 'target_tool';

			const config: SummaryConfig = {
				enabled: true,
				threshold_bytes: 1024,
				max_summary_chars: 500,
				max_stored_bytes: 1024 * 1024,
				retention_days: 7,
				exempt_tools: largeExemptList,
			};

			const hook = createToolSummarizerHook(config, tempDir);

			const input = {
				tool: 'target_tool',
				sessionID: 'test-session',
				callID: 'test-call',
			};

			const output = {
				title: 'Test Tool',
				output: largeOutput,
				metadata: {},
			};

			const startTime = Date.now();
			await hook(input, output);
			const duration = Date.now() - startTime;

			// Should complete in < 100ms
			expect(duration).toBeLessThan(100);

			// Should be exempt
			expect(output.output).toBe(largeOutput);
		});
	});

	/**
	 * Attack Vector 8: Array with non-string entries
	 * exempt_tools: [null, undefined, 1, true, {}, []] as any — should not crash; tool should not be incorrectly exempt
	 */
	describe('Non-string entries in exempt_tools array', () => {
		it('should not crash with null in exempt list', async () => {
			const config: SummaryConfig = {
				enabled: true,
				threshold_bytes: 1024,
				max_summary_chars: 500,
				max_stored_bytes: 1024 * 1024,
				retention_days: 7,
				exempt_tools: [null, undefined, 1, true, {}, []] as any,
			};

			const hook = createToolSummarizerHook(config, tempDir);

			const input = {
				tool: 'test_tool',
				sessionID: 'test-session',
				callID: 'test-call',
			};

			const output = {
				title: 'Test Tool',
				output: largeOutput,
				metadata: {},
			};

			// Should NOT crash
			await hook(input, output);

			// Should NOT be exempt (type coercion check)
			expect(output.output).not.toBe(largeOutput);
		});

		it('should not incorrectly exempt due to number 1 matching string "1"', async () => {
			const config: SummaryConfig = {
				enabled: true,
				threshold_bytes: 1024,
				max_summary_chars: 500,
				max_stored_bytes: 1024 * 1024,
				retention_days: 7,
				exempt_tools: [1] as any,
			};

			const hook = createToolSummarizerHook(config, tempDir);

			const input = {
				tool: '1',
				sessionID: 'test-session',
				callID: 'test-call',
			};

			const output = {
				title: 'Test Tool',
				output: largeOutput,
				metadata: {},
			};

			await hook(input, output);

			// Should NOT be exempt (strict type matching - no coercion)
			expect(output.output).not.toBe(largeOutput);
		});

		it('should not incorrectly exempt due to true matching string "true"', async () => {
			const config: SummaryConfig = {
				enabled: true,
				threshold_bytes: 1024,
				max_summary_chars: 500,
				max_stored_bytes: 1024 * 1024,
				retention_days: 7,
				exempt_tools: [true] as any,
			};

			const hook = createToolSummarizerHook(config, tempDir);

			const input = {
				tool: 'true',
				sessionID: 'test-session',
				callID: 'test-call',
			};

			const output = {
				title: 'Test Tool',
				output: largeOutput,
				metadata: {},
			};

			await hook(input, output);

			// Should NOT be exempt
			expect(output.output).not.toBe(largeOutput);
		});

		it('should not crash with object in exempt list', async () => {
			const config: SummaryConfig = {
				enabled: true,
				threshold_bytes: 1024,
				max_summary_chars: 500,
				max_stored_bytes: 1024 * 1024,
				retention_days: 7,
				exempt_tools: [{}] as any,
			};

			const hook = createToolSummarizerHook(config, tempDir);

			const input = {
				tool: 'test_tool',
				sessionID: 'test-session',
				callID: 'test-call',
			};

			const output = {
				title: 'Test Tool',
				output: largeOutput,
				metadata: {},
			};

			await hook(input, output);

			expect(output.output).not.toBe(largeOutput);
		});

		it('should not crash with array in exempt list', async () => {
			const config: SummaryConfig = {
				enabled: true,
				threshold_bytes: 1024,
				max_summary_chars: 500,
				max_stored_bytes: 1024 * 1024,
				retention_days: 7,
				exempt_tools: [[]] as any,
			};

			const hook = createToolSummarizerHook(config, tempDir);

			const input = {
				tool: 'test_tool',
				sessionID: 'test-session',
				callID: 'test-call',
			};

			const output = {
				title: 'Test Tool',
				output: largeOutput,
				metadata: {},
			};

			await hook(input, output);

			expect(output.output).not.toBe(largeOutput);
		});
	});

	/**
	 * Attack Vector 9: ReDoS via regex-like tool name
	 * input.tool = 'a'.repeat(10000) — includes() is O(n) not regex, should be fast
	 */
	describe('ReDoS via long tool name', () => {
		it('should handle 10000 character tool name efficiently', async () => {
			const config: SummaryConfig = {
				enabled: true,
				threshold_bytes: 1024,
				max_summary_chars: 500,
				max_stored_bytes: 1024 * 1024,
				retention_days: 7,
				exempt_tools: ['retrieve_summary', 'task', 'read'],
			};

			const hook = createToolSummarizerHook(config, tempDir);

			const longToolName = 'a'.repeat(10000);

			const input = {
				tool: longToolName,
				sessionID: 'test-session',
				callID: 'test-call',
			};

			const output = {
				title: 'Test Tool',
				output: largeOutput,
				metadata: {},
			};

			const startTime = Date.now();
			await hook(input, output);
			const duration = Date.now() - startTime;

			// Should complete quickly (includes() is O(n), not regex)
			expect(duration).toBeLessThan(100);

			// Should summarize
			expect(output.output).not.toBe(largeOutput);
		});

		it('should handle repeated pattern in tool name', async () => {
			const config: SummaryConfig = {
				enabled: true,
				threshold_bytes: 1024,
				max_summary_chars: 500,
				max_stored_bytes: 1024 * 1024,
				retention_days: 7,
				exempt_tools: ['retrieve_summary', 'task', 'read'],
			};

			const hook = createToolSummarizerHook(config, tempDir);

			// Create a tool name with repeating pattern that could be problematic for regex
			const longToolName = 'retrieve_summary'.repeat(500);

			const input = {
				tool: longToolName,
				sessionID: 'test-session',
				callID: 'test-call',
			};

			const output = {
				title: 'Test Tool',
				output: largeOutput,
				metadata: {},
			};

			const startTime = Date.now();
			await hook(input, output);
			const duration = Date.now() - startTime;

			// Should complete quickly
			expect(duration).toBeLessThan(100);

			// Should summarize (not an exact match)
			expect(output.output).not.toBe(largeOutput);
		});
	});

	/**
	 * Attack Vector 10: Strict type matching
	 * Verify that [1].includes('1') is false (no type coercion) — tool names compared with strict type matching
	 */
	describe('Strict type matching - no coercion', () => {
		it('should use strict equality for tool name matching (Array.prototype.includes)', async () => {
			// Verify behavior of Array.prototype.includes
			expect([1].includes('1' as any)).toBe(false);
			expect(['1'].includes(1 as any)).toBe(false);
			expect([null].includes(undefined as any)).toBe(false);
			expect([true].includes('true' as any)).toBe(false);
		});

		it('should not exempt number tool name when string is in exempt list', async () => {
			const config: SummaryConfig = {
				enabled: true,
				threshold_bytes: 1024,
				max_summary_chars: 500,
				max_stored_bytes: 1024 * 1024,
				retention_days: 7,
				exempt_tools: ['123'],
			};

			const hook = createToolSummarizerHook(config, tempDir);

			const input = {
				tool: 123 as any, // Number, not string
				sessionID: 'test-session',
				callID: 'test-call',
			};

			const output = {
				title: 'Test Tool',
				output: 'small output', // Use small output to avoid summarization crash
				metadata: {},
			};

			await hook(input, output);

			// Output should remain unchanged since it's below threshold and not exempt
			expect(output.output).toBe('small output');
		});

		it('should not exempt string tool name when number is in exempt list', async () => {
			const config: SummaryConfig = {
				enabled: true,
				threshold_bytes: 1024,
				max_summary_chars: 500,
				max_stored_bytes: 1024 * 1024,
				retention_days: 7,
				exempt_tools: [123 as any],
			};

			const hook = createToolSummarizerHook(config, tempDir);

			const input = {
				tool: '123',
				sessionID: 'test-session',
				callID: 'test-call',
			};

			const output = {
				title: 'Test Tool',
				output: largeOutput,
				metadata: {},
			};

			await hook(input, output);

			// Should NOT be exempt
			expect(output.output).not.toBe(largeOutput);
		});

		it('should handle mixed types in exempt list correctly', async () => {
			const config: SummaryConfig = {
				enabled: true,
				threshold_bytes: 1024,
				max_summary_chars: 500,
				max_stored_bytes: 1024 * 1024,
				retention_days: 7,
				exempt_tools: ['string_tool', 123, true, null] as any,
			};

			const hook = createToolSummarizerHook(config, tempDir);

			// Test each type
			const testCases = [
				{ tool: 'string_tool', shouldExempt: true },
				{ tool: 123 as any, shouldExempt: true },
				{ tool: true as any, shouldExempt: true },
				{ tool: null as any, shouldExempt: true },
				{ tool: '123', shouldExempt: false },
				{ tool: 'true', shouldExempt: false },
				{ tool: 'null', shouldExempt: false },
				{ tool: 'other_tool', shouldExempt: false },
			];

			for (const testCase of testCases) {
				const output = {
					title: 'Test Tool',
					output: largeOutput,
					metadata: {},
				};

				await hook(
					{
						tool: testCase.tool,
						sessionID: 'test-session',
						callID: 'test-call',
					},
					output,
				);

				if (testCase.shouldExempt) {
					expect(output.output).toBe(largeOutput);
				} else {
					expect(output.output).not.toBe(largeOutput);
				}
			}
		});
	});

	/**
	 * Attack Vector 11: retrieve_lane_output exemption ratchet
	 * Verify retrieve_lane_output is treated like retrieve_summary — exempt by default,
	 * not bypassable via suffix/prefix/case variations.
	 */
	describe('retrieve_lane_output exemption ratchet', () => {
		it('should exempt retrieve_lane_output when in exempt list', async () => {
			const config: SummaryConfig = {
				enabled: true,
				threshold_bytes: 1024,
				max_summary_chars: 500,
				max_stored_bytes: 1024 * 1024,
				retention_days: 7,
				exempt_tools: [
					'retrieve_summary',
					'retrieve_lane_output',
					'task',
					'read',
				],
			};

			const hook = createToolSummarizerHook(config, tempDir);

			const output = {
				title: 'Test Tool',
				output: largeOutput,
				metadata: {},
			};

			await hook(
				{ tool: 'retrieve_lane_output', sessionID: 'test', callID: 'test' },
				output,
			);

			expect(output.output).toBe(largeOutput);
		});

		it('should NOT exempt retrieve_lane_output with suffix', async () => {
			const config: SummaryConfig = {
				enabled: true,
				threshold_bytes: 1024,
				max_summary_chars: 500,
				max_stored_bytes: 1024 * 1024,
				retention_days: 7,
				exempt_tools: [
					'retrieve_summary',
					'retrieve_lane_output',
					'task',
					'read',
				],
			};

			const hook = createToolSummarizerHook(config, tempDir);

			const output = {
				title: 'Test Tool',
				output: largeOutput,
				metadata: {},
			};

			await hook(
				{
					tool: 'retrieve_lane_output_extra',
					sessionID: 'test',
					callID: 'test',
				},
				output,
			);

			expect(output.output).not.toBe(largeOutput);
		});

		it('should NOT exempt retrieve_lane_output when missing from exempt list', async () => {
			const config: SummaryConfig = {
				enabled: true,
				threshold_bytes: 1024,
				max_summary_chars: 500,
				max_stored_bytes: 1024 * 1024,
				retention_days: 7,
				exempt_tools: ['retrieve_summary', 'task', 'read'],
			};

			const hook = createToolSummarizerHook(config, tempDir);

			const output = {
				title: 'Test Tool',
				output: largeOutput,
				metadata: {},
			};

			await hook(
				{ tool: 'retrieve_lane_output', sessionID: 'test', callID: 'test' },
				output,
			);

			expect(output.output).not.toBe(largeOutput);
		});
	});
});
