/**
 * Adversarial/Attack-Vector Tests for v6.13.1-hotfix HF-1b in system-enhancer.ts
 *
 * Tests security and robustness against malicious inputs targeting the
 * agent execution guardrails (HF-1: coder/test_engineer self-verification guard,
 * HF-1b: architect/null full test suite guard).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PluginConfig } from '../../../src/config';
import { createSystemEnhancerHook } from '../../../src/hooks/system-enhancer';
import { resetSwarmState, swarmState } from '../../../src/state';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

describe('system-enhancer HF-1b - Adversarial Input Testing', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = canonicalMkdtemp('swarm-hf1b-adversarial-');
		resetSwarmState();
	});

	afterEach(async () => {
		try {
			await rm(tempDir, { recursive: true, force: true });
		} catch (error) {
			// Ignore cleanup errors
		}
	});

	/**
	 * Helper to create minimal .swarm directory with plan.md and context.md
	 */
	async function createSwarmFiles(): Promise<void> {
		const swarmDir = join(tempDir, '.swarm');
		await mkdir(swarmDir, { recursive: true });
		await writeFile(join(swarmDir, 'plan.md'), '# Plan\n');
		await writeFile(join(swarmDir, 'context.md'), '# Context\n');
	}

	/**
	 * Helper to invoke the transform hook and return the output
	 */
	async function invokeHook(sessionID?: string): Promise<string[]> {
		const config: PluginConfig = {
			max_iterations: 5,
			qa_retry_limit: 3,
			inject_phase_reminders: true,
		};

		const hooks = createSystemEnhancerHook(config, tempDir);
		const transform = hooks['experimental.chat.system.transform'] as (
			input: { sessionID?: string },
			output: { system: string[] },
		) => Promise<void>;

		const input = sessionID ? { sessionID } : {};
		const output = { system: ['Initial system prompt'] };

		await transform(input, output);

		return output.system;
	}

	/**
	 * Check if system output contains HF-1 injection (coder/test_engineer guard)
	 */
	function hasHF1Injection(systemOutput: string[]): boolean {
		return systemOutput.some((s) =>
			s.includes(
				'[SWARM CONFIG] You must NOT run build, test, lint, or type-check commands',
			),
		);
	}

	/**
	 * Check if system output contains HF-1b injection (architect/null guard)
	 */
	function hasHF1bInjection(systemOutput: string[]): boolean {
		return systemOutput.some((s) =>
			s.includes('[SWARM CONFIG] You must NEVER run the full test suite'),
		);
	}

	describe('ATTACK 8: Prototype pollution attempt', () => {
		it('__proto__ as agent name → does not crash → NEITHER injection fires', async () => {
			await createSwarmFiles();

			// Set active agent to '__proto__'
			swarmState.activeAgent.set('test-session', '__proto__');

			const systemOutput = await invokeHook('test-session');

			// Should not crash
			expect(systemOutput).toBeDefined();
			expect(Array.isArray(systemOutput)).toBe(true);

			// '__proto__' is not a known agent name
			expect(hasHF1Injection(systemOutput)).toBe(false);
			expect(hasHF1bInjection(systemOutput)).toBe(false);
		});

		it('constructor as agent name → does not crash → NEITHER injection fires', async () => {
			await createSwarmFiles();

			// Set active agent to 'constructor'
			swarmState.activeAgent.set('test-session', 'constructor');

			const systemOutput = await invokeHook('test-session');

			// Should not crash
			expect(systemOutput).toBeDefined();
			expect(Array.isArray(systemOutput)).toBe(true);

			// 'constructor' is not a known agent name
			expect(hasHF1Injection(systemOutput)).toBe(false);
			expect(hasHF1bInjection(systemOutput)).toBe(false);
		});

		it('prototype as agent name → does not crash → NEITHER injection fires', async () => {
			await createSwarmFiles();

			// Set active agent to 'prototype'
			swarmState.activeAgent.set('test-session', 'prototype');

			const systemOutput = await invokeHook('test-session');

			// Should not crash
			expect(systemOutput).toBeDefined();
			expect(Array.isArray(systemOutput)).toBe(true);

			// 'prototype' is not a known agent name
			expect(hasHF1Injection(systemOutput)).toBe(false);
			expect(hasHF1bInjection(systemOutput)).toBe(false);
		});
	});

	describe('ATTACK 9: Special characters in agent name', () => {
		it('agent with null bytes → does not crash → NEITHER injection fires', async () => {
			await createSwarmFiles();

			// Set active agent to string with null bytes
			swarmState.activeAgent.set('test-session', 'coder\x00null');

			const systemOutput = await invokeHook('test-session');

			// Should not crash
			expect(systemOutput).toBeDefined();
			expect(Array.isArray(systemOutput)).toBe(true);

			// 'coder\x00null' is not 'coder' exactly
			expect(hasHF1Injection(systemOutput)).toBe(false);
			expect(hasHF1bInjection(systemOutput)).toBe(false);
		});

		it('agent with newline characters → does not crash → NEITHER injection fires', async () => {
			await createSwarmFiles();

			// Set active agent to string with newlines
			swarmState.activeAgent.set('test-session', 'coder\narchitect');

			const systemOutput = await invokeHook('test-session');

			// Should not crash
			expect(systemOutput).toBeDefined();
			expect(Array.isArray(systemOutput)).toBe(true);

			// 'coder\narchitect' is not 'coder' exactly
			expect(hasHF1Injection(systemOutput)).toBe(false);
			expect(hasHF1bInjection(systemOutput)).toBe(false);
		});

		it('agent with control characters → does not crash → NEITHER injection fires', async () => {
			await createSwarmFiles();

			// Set active agent to string with control characters
			swarmState.activeAgent.set('test-session', '\x1b[31mcoder\x1b[0m');

			const systemOutput = await invokeHook('test-session');

			// Should not crash
			expect(systemOutput).toBeDefined();
			expect(Array.isArray(systemOutput)).toBe(true);

			// String with ANSI codes is not 'coder' exactly
			expect(hasHF1Injection(systemOutput)).toBe(false);
			expect(hasHF1bInjection(systemOutput)).toBe(false);
		});
	});

	describe('ATTACK 10: Unicode and emoji in agent name', () => {
		it('emoji agent name → does not crash → NEITHER injection fires', async () => {
			await createSwarmFiles();

			// Set active agent to emoji
			swarmState.activeAgent.set('test-session', '😀');

			const systemOutput = await invokeHook('test-session');

			// Should not crash
			expect(systemOutput).toBeDefined();
			expect(Array.isArray(systemOutput)).toBe(true);

			// Emoji is not a known agent name
			expect(hasHF1Injection(systemOutput)).toBe(false);
			expect(hasHF1bInjection(systemOutput)).toBe(false);
		});

		it('mixed Unicode and ASCII → does not crash → NEITHER injection fires', async () => {
			await createSwarmFiles();

			// Set active agent to mixed Unicode and ASCII
			swarmState.activeAgent.set('test-session', 'coder-😀-test');

			const systemOutput = await invokeHook('test-session');

			// Should not crash
			expect(systemOutput).toBeDefined();
			expect(Array.isArray(systemOutput)).toBe(true);

			// Mixed string is not 'coder' exactly
			expect(hasHF1Injection(systemOutput)).toBe(false);
			expect(hasHF1bInjection(systemOutput)).toBe(false);
		});

		it('right-to-left override characters → does not crash → NEITHER injection fires', async () => {
			await createSwarmFiles();

			// Set active agent to RTL override character
			swarmState.activeAgent.set('test-session', '\u202e');

			const systemOutput = await invokeHook('test-session');

			// Should not crash
			expect(systemOutput).toBeDefined();
			expect(Array.isArray(systemOutput)).toBe(true);

			// RTL char is not a known agent name
			expect(hasHF1Injection(systemOutput)).toBe(false);
			expect(hasHF1bInjection(systemOutput)).toBe(false);
		});
	});

	describe('ATTACK 11: SQL injection-style agent names', () => {
		it('SQL injection attempt → does not crash → NEITHER injection fires', async () => {
			await createSwarmFiles();

			// Set active agent to SQL injection string
			swarmState.activeAgent.set(
				'test-session',
				"coder'; DROP TABLE agents; --",
			);

			const systemOutput = await invokeHook('test-session');

			// Should not crash (no SQL execution)
			expect(systemOutput).toBeDefined();
			expect(Array.isArray(systemOutput)).toBe(true);

			// SQL injection string is not 'coder' exactly
			expect(hasHF1Injection(systemOutput)).toBe(false);
			expect(hasHF1bInjection(systemOutput)).toBe(false);
		});

		it('SQL injection with UNION → does not crash → NEITHER injection fires', async () => {
			await createSwarmFiles();

			// Set active agent to SQL injection with UNION
			swarmState.activeAgent.set(
				'test-session',
				"coder' UNION SELECT 'architect' --",
			);

			const systemOutput = await invokeHook('test-session');

			// Should not crash
			expect(systemOutput).toBeDefined();
			expect(Array.isArray(systemOutput)).toBe(true);

			// SQL injection string is not 'coder' exactly
			expect(hasHF1Injection(systemOutput)).toBe(false);
			expect(hasHF1bInjection(systemOutput)).toBe(false);
		});
	});

	describe('ATTACK 12: Path traversal-style agent names', () => {
		it('path traversal attempt → does not crash → NEITHER injection fires', async () => {
			await createSwarmFiles();

			// Set active agent to path traversal string
			swarmState.activeAgent.set('test-session', '../../../etc/passwd');

			const systemOutput = await invokeHook('test-session');

			// Should not crash (no file access)
			expect(systemOutput).toBeDefined();
			expect(Array.isArray(systemOutput)).toBe(true);

			// Path traversal string is not a known agent
			expect(hasHF1Injection(systemOutput)).toBe(false);
			expect(hasHF1bInjection(systemOutput)).toBe(false);
		});

		it('path traversal with null bytes → does not crash → NEITHER injection fires', async () => {
			await createSwarmFiles();

			// Set active agent to path traversal with null byte
			swarmState.activeAgent.set('test-session', '../../../etc/passwd\x00');

			const systemOutput = await invokeHook('test-session');

			// Should not crash
			expect(systemOutput).toBeDefined();
			expect(Array.isArray(systemOutput)).toBe(true);

			// Path traversal string is not a known agent
			expect(hasHF1Injection(systemOutput)).toBe(false);
			expect(hasHF1bInjection(systemOutput)).toBe(false);
		});
	});

	describe('ATTACK 13: XSS-style agent names', () => {
		it('XSS script injection → does not crash → NEITHER injection fires', async () => {
			await createSwarmFiles();

			// Set active agent to XSS script
			swarmState.activeAgent.set(
				'test-session',
				'<script>alert("XSS")</script>',
			);

			const systemOutput = await invokeHook('test-session');

			// Should not crash (no script execution)
			expect(systemOutput).toBeDefined();
			expect(Array.isArray(systemOutput)).toBe(true);

			// XSS string is not a known agent
			expect(hasHF1Injection(systemOutput)).toBe(false);
			expect(hasHF1bInjection(systemOutput)).toBe(false);
		});

		it('XSS img onerror → does not crash → NEITHER injection fires', async () => {
			await createSwarmFiles();

			// Set active agent to XSS img tag
			swarmState.activeAgent.set(
				'test-session',
				'<img src=x onerror=alert(1)>',
			);

			const systemOutput = await invokeHook('test-session');

			// Should not crash
			expect(systemOutput).toBeDefined();
			expect(Array.isArray(systemOutput)).toBe(true);

			// XSS string is not a known agent
			expect(hasHF1Injection(systemOutput)).toBe(false);
			expect(hasHF1bInjection(systemOutput)).toBe(false);
		});
	});

	describe('ATTACK 14: Nested prototype pollution', () => {
		it('__proto__.__proto__ → does not crash → NEITHER injection fires', async () => {
			await createSwarmFiles();

			// Set active agent to nested prototype chain
			swarmState.activeAgent.set('test-session', '__proto__.__proto__');

			const systemOutput = await invokeHook('test-session');

			// Should not crash
			expect(systemOutput).toBeDefined();
			expect(Array.isArray(systemOutput)).toBe(true);

			// Nested proto string is not a known agent
			expect(hasHF1Injection(systemOutput)).toBe(false);
			expect(hasHF1bInjection(systemOutput)).toBe(false);
		});

		it('constructor.prototype → does not crash → NEITHER injection fires', async () => {
			await createSwarmFiles();

			// Set active agent to constructor.prototype
			swarmState.activeAgent.set('test-session', 'constructor.prototype');

			const systemOutput = await invokeHook('test-session');

			// Should not crash
			expect(systemOutput).toBeDefined();
			expect(Array.isArray(systemOutput)).toBe(true);

			// Constructor.prototype string is not a known agent
			expect(hasHF1Injection(systemOutput)).toBe(false);
			expect(hasHF1bInjection(systemOutput)).toBe(false);
		});
	});

	describe('ATTACK 15: Combined attacks', () => {
		it('long name with null-like components and Unicode → does not crash → NEITHER injection fires', async () => {
			await createSwarmFiles();

			// Combine multiple attack vectors
			const combinedName = '__proto__-'.repeat(50) + '😀';
			swarmState.activeAgent.set('test-session', combinedName);

			const systemOutput = await invokeHook('test-session');

			// Should not crash
			expect(systemOutput).toBeDefined();
			expect(Array.isArray(systemOutput)).toBe(true);

			// Combined attack string is not a known agent
			expect(hasHF1Injection(systemOutput)).toBe(false);
			expect(hasHF1bInjection(systemOutput)).toBe(false);
		});

		it('XSS with prototype pollution → does not crash → NEITHER injection fires', async () => {
			await createSwarmFiles();

			// Combine XSS and prototype pollution
			swarmState.activeAgent.set('test-session', '<script>__proto__</script>');

			const systemOutput = await invokeHook('test-session');

			// Should not crash
			expect(systemOutput).toBeDefined();
			expect(Array.isArray(systemOutput)).toBe(true);

			// Combined string is not a known agent
			expect(hasHF1Injection(systemOutput)).toBe(false);
			expect(hasHF1bInjection(systemOutput)).toBe(false);
		});
	});
});
