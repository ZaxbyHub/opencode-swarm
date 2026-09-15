/**
 * Adversarial/Attack-Vector Tests for v6.13.1-hotfix HF-1b in system-enhancer.ts
 *
 * Tests security and robustness against malicious inputs targeting the
 * agent execution guardrails (HF-1: coder/test_engineer self-verification guard,
 * HF-1b: architect/null full test suite guard).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PluginConfig } from '../../../src/config';
import { createSystemEnhancerHook } from '../../../src/hooks/system-enhancer';
import {
	isGuidanceCarrier,
	isRenderableGuidance,
	messageTextOf,
} from '../../../src/hooks/system-guidance-carrier';
import { resetSwarmState, swarmState } from '../../../src/state';
import {
	type HostPartsMessage,
	hostToModelMessages,
	renderedText,
} from '../../helpers/host-contract-v1_18_3';
import { bootSwarmPluginHost } from '../../helpers/plugin-host';

const BASE_SYSTEM = 'Stable architect system prefix';
const HOST_CONFIG = {
	version_check: false,
	context_budget: { scoring: { enabled: false } },
	knowledge: { enabled: false, hive_enabled: false },
	memory: { enabled: false },
	hooks: { delegation_gate: false, system_enhancer: true },
};

describe('system-enhancer HF-1b - Adversarial Attack Vector Testing', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'swarm-hf1b-adversarial-'));
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

		// Create minimal plan.md
		await writeFile(join(swarmDir, 'plan.md'), '# Plan\n');

		// Create minimal context.md
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

	async function invokeRegisteredArchitect(
		agent: string,
		activeAgent = agent,
	): Promise<{
		messages: HostPartsMessage[];
		rendered: ReturnType<typeof hostToModelMessages>;
		system: string[];
	}> {
		await createSwarmFiles();
		await mkdir(join(tempDir, '.opencode'), { recursive: true });
		swarmState.activeAgent.set('test-session', activeAgent);
		const host = await bootSwarmPluginHost(tempDir, HOST_CONFIG);
		const messages: HostPartsMessage[] = [
			{
				info: {
					id: 'hf1b-adversarial-user',
					role: 'user',
					agent,
					sessionID: 'test-session',
				},
				parts: [{ type: 'text', text: 'Continue the active plan.' }],
			},
		];
		await host.hooks['experimental.chat.messages.transform']({}, { messages });
		const system = [BASE_SYSTEM];
		await host.hooks['experimental.chat.system.transform'](
			{ sessionID: 'test-session' },
			{ system },
		);
		return { messages, rendered: hostToModelMessages(messages), system };
	}

	function expectArchitectGuardCarrier(
		result: Awaited<ReturnType<typeof invokeRegisteredArchitect>>,
	): void {
		const needle = '[SWARM CONFIG] You must NEVER run the full test suite';
		const carrier = result.messages.find(
			(message) =>
				isGuidanceCarrier(message) && messageTextOf(message).includes(needle),
		);
		expect(result.system).toEqual([BASE_SYSTEM]);
		expect(result.system.join('\n')).not.toContain(needle);
		expect(carrier).toBeDefined();
		expect(isRenderableGuidance(carrier)).toBe(true);
		expect(carrier?.info.role).toBe('user');
		expect(renderedText(result.rendered)).toContain(needle);
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

	describe('ATTACK 1: Empty string agent name', () => {
		it('empty string agent → falsy → baseRole = null → HF-1b fires', async () => {
			await createSwarmFiles();

			// Set active agent to empty string
			swarmState.activeAgent.set('test-session', '');

			const systemOutput = await invokeHook('test-session');

			// Empty string doesn't match 'coder' or 'test_engineer'
			expect(hasHF1Injection(systemOutput)).toBe(false);

			// Empty string is falsy in JavaScript, so baseRole = null
			// HF-1b only fires when baseRole === 'architect' || baseRole === null
			// Since baseRole is null, HF-1b SHOULD fire
			expect(hasHF1bInjection(systemOutput)).toBe(true);
		});
	});

	describe('ATTACK 2: Whitespace-only agent name', () => {
		it('whitespace-only agent → baseRole = whitespace string → NEITHER injection fires', async () => {
			await createSwarmFiles();

			// Set active agent to whitespace-only string
			swarmState.activeAgent.set('test-session', '   ');

			const systemOutput = await invokeHook('test-session');

			// Whitespace-only doesn't match 'coder' or 'test_engineer'
			expect(hasHF1Injection(systemOutput)).toBe(false);

			// Whitespace is truthy and not 'architect', so HF-1b should NOT fire
			expect(hasHF1bInjection(systemOutput)).toBe(false);
		});

		it('mixed whitespace agent → baseRole = whitespace string → NEITHER injection fires', async () => {
			await createSwarmFiles();

			// Set active agent to mixed whitespace string
			swarmState.activeAgent.set('test-session', '\t\n \r');

			const systemOutput = await invokeHook('test-session');

			// Mixed whitespace doesn't match 'coder' or 'test_engineer'
			expect(hasHF1Injection(systemOutput)).toBe(false);

			// Mixed whitespace is truthy and not 'architect', so HF-1b should NOT fire
			expect(hasHF1bInjection(systemOutput)).toBe(false);
		});
	});

	describe('ATTACK 3: Case variation bypass', () => {
		it('uppercase CODER → case-sensitive check → neither block fires (stripKnownSwarmPrefix normalizes to lowercase)', async () => {
			await createSwarmFiles();

			// Set active agent to uppercase 'CODER'
			swarmState.activeAgent.set('test-session', 'CODER');

			const systemOutput = await invokeHook('test-session');

			// stripKnownSwarmPrefix normalizes to lowercase, so 'CODER' → 'coder'
			// This actually MATCHES 'coder', so HF-1 SHOULD fire
			// This is expected behavior, not a bypass
			expect(hasHF1Injection(systemOutput)).toBe(true);
			expect(hasHF1bInjection(systemOutput)).toBe(false);
		});

		it('mixed case CoDeR → normalized to lowercase → HF-1 fires', async () => {
			await createSwarmFiles();

			// Set active agent to mixed case 'CoDeR'
			swarmState.activeAgent.set('test-session', 'CoDeR');

			const systemOutput = await invokeHook('test-session');

			// stripKnownSwarmPrefix normalizes to lowercase, so 'CoDeR' → 'coder'
			expect(hasHF1Injection(systemOutput)).toBe(true);
			expect(hasHF1bInjection(systemOutput)).toBe(false);
		});

		it('mixed case ARCHITECT → normalized to lowercase → HF-1b fires', async () => {
			const result = await invokeRegisteredArchitect('ARCHITECT');

			expectArchitectGuardCarrier(result);
		});
	});

	describe('ATTACK 4: Mixed prefix attack', () => {
		it('double prefix mega_mega_coder → iterative stripping → coder → HF-1 fires', async () => {
			await createSwarmFiles();

			// Set active agent with double prefix
			swarmState.activeAgent.set('test-session', 'mega_mega_coder');

			const systemOutput = await invokeHook('test-session');

			// stripKnownSwarmPrefix iteratively strips prefixes, so 'mega_mega_coder' → 'coder'
			expect(hasHF1Injection(systemOutput)).toBe(true);
			expect(hasHF1bInjection(systemOutput)).toBe(false);
		});

		it('triple prefix mega_mega_mega_architect → iterative stripping → architect → HF-1b fires', async () => {
			const result = await invokeRegisteredArchitect(
				'mega_mega_mega_architect',
			);

			expectArchitectGuardCarrier(result);
		});

		it('mixed prefix cloud_mega_coder → iterative stripping → coder → HF-1 fires', async () => {
			await createSwarmFiles();

			// Set active agent with mixed prefixes
			swarmState.activeAgent.set('test-session', 'cloud_mega_coder');

			const systemOutput = await invokeHook('test-session');

			// stripKnownSwarmPrefix iteratively strips prefixes, so 'cloud_mega_coder' → 'coder'
			expect(hasHF1Injection(systemOutput)).toBe(true);
			expect(hasHF1bInjection(systemOutput)).toBe(false);
		});

		it('prefix with known suffix but unknown agent mega_tester → no match → NEITHER injection fires', async () => {
			await createSwarmFiles();

			// Set active agent with prefix and unknown base agent
			swarmState.activeAgent.set('test-session', 'mega_tester');

			const systemOutput = await invokeHook('test-session');

			// 'tester' is not a known agent name, so no match
			expect(hasHF1Injection(systemOutput)).toBe(false);
			// Unknown agent is truthy and not 'architect', so HF-1b should NOT fire
			expect(hasHF1bInjection(systemOutput)).toBe(false);
		});
	});

	describe('ATTACK 5: Unknown agent type', () => {
		it('unknown_agent_xyz → no match → NEITHER injection fires', async () => {
			await createSwarmFiles();

			// Set active agent to unknown type
			swarmState.activeAgent.set('test-session', 'unknown_agent_xyz');

			const systemOutput = await invokeHook('test-session');

			// Unknown agent doesn't match 'coder' or 'test_engineer'
			expect(hasHF1Injection(systemOutput)).toBe(false);

			// Unknown agent is truthy and not 'architect', so HF-1b should NOT fire
			expect(hasHF1bInjection(systemOutput)).toBe(false);
		});

		it('random_agent_name_12345 → no match → NEITHER injection fires', async () => {
			await createSwarmFiles();

			// Set active agent to random unknown name
			swarmState.activeAgent.set('test-session', 'random_agent_name_12345');

			const systemOutput = await invokeHook('test-session');

			// Unknown agent doesn't match
			expect(hasHF1Injection(systemOutput)).toBe(false);
			expect(hasHF1bInjection(systemOutput)).toBe(false);
		});
	});

	describe('ATTACK 6: Very long agent name', () => {
		it('1000-char agent name → no crash → NEITHER injection fires', async () => {
			await createSwarmFiles();

			// Set active agent to very long string
			const longName = 'a'.repeat(1000);
			swarmState.activeAgent.set('test-session', longName);

			const systemOutput = await invokeHook('test-session');

			// Should not crash
			expect(systemOutput).toBeDefined();
			expect(Array.isArray(systemOutput)).toBe(true);

			// Long name doesn't match known agents
			expect(hasHF1Injection(systemOutput)).toBe(false);
			expect(hasHF1bInjection(systemOutput)).toBe(false);
		});

		it('10000-char agent name → no crash → NEITHER injection fires', async () => {
			await createSwarmFiles();

			// Set active agent to extremely long string
			const longName = 'b'.repeat(10000);
			swarmState.activeAgent.set('test-session', longName);

			const systemOutput = await invokeHook('test-session');

			// Should not crash
			expect(systemOutput).toBeDefined();
			expect(Array.isArray(systemOutput)).toBe(true);

			// Long name doesn't match known agents
			expect(hasHF1Injection(systemOutput)).toBe(false);
			expect(hasHF1bInjection(systemOutput)).toBe(false);
		});
	});

	describe('ATTACK 7: Null sessionID', () => {
		it("null sessionID → get('') → undefined → baseRole null → HF-1b fires", async () => {
			await createSwarmFiles();

			// Don't set any active agent, and use empty sessionID (equivalent to null)
			const systemOutput = await invokeHook('');

			// No active agent, so baseRole is null
			expect(hasHF1Injection(systemOutput)).toBe(false);
			expect(hasHF1bInjection(systemOutput)).toBe(true);
		});

		it("undefined sessionID → get('') → undefined → baseRole null → HF-1b fires", async () => {
			await createSwarmFiles();

			// Invoke hook without sessionID (undefined)
			const systemOutput = await invokeHook(undefined);

			// No active agent, so baseRole is null
			expect(hasHF1Injection(systemOutput)).toBe(false);
			expect(hasHF1bInjection(systemOutput)).toBe(true);
		});
	});
});
