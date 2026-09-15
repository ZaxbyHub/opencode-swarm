/**
 * Tests for v6.13.1-hotfix HF-1b agent execution guardrails:
 * - HF-1: Prevent coder/test_engineer from self-verifying
 * - HF-1b: Prevent architect/null from running full test suite
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
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
import {
	bootSwarmPluginHost,
	createPluginHostProject,
} from '../../helpers/plugin-host';
import { safeRmRecursive } from '../../helpers/safe-test-dir';

const BASE_SYSTEM = 'Stable architect system prefix';
const HOST_CONFIG = {
	version_check: false,
	context_budget: { scoring: { enabled: false } },
	knowledge: { enabled: false, hive_enabled: false },
	memory: { enabled: false },
	hooks: { delegation_gate: false, system_enhancer: true },
};

describe('v6.13.1-hotfix HF-1b Agent Execution Guardrails', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = createPluginHostProject('swarm-hf1b-test-');
		resetSwarmState();
	});

	afterEach(async () => {
		try {
			safeRmRecursive(tempDir);
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
	async function invokeHook(sessionID = 'test-session'): Promise<string[]> {
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

		const input = { sessionID };
		const output = { system: ['Initial system prompt'] };

		await transform(input, output);

		return output.system;
	}

	async function invokeRegisteredArchitect(
		agent = 'architect',
		activeAgent: string | undefined = agent,
	): Promise<{
		messages: HostPartsMessage[];
		rendered: ReturnType<typeof hostToModelMessages>;
		system: string[];
	}> {
		await createSwarmFiles();
		if (activeAgent === undefined) {
			swarmState.activeAgent.delete('test-session');
		} else {
			swarmState.activeAgent.set('test-session', activeAgent);
		}
		const host = await bootSwarmPluginHost(tempDir, HOST_CONFIG);
		const messages: HostPartsMessage[] = [
			{
				info: {
					id: 'hf1b-user',
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
	 * Check if system output contains HF-1 injection
	 */
	function hasHF1Injection(systemOutput: string[]): boolean {
		return systemOutput.some((s) =>
			s.includes(
				'[SWARM CONFIG] You must NOT run build, test, lint, or type-check commands',
			),
		);
	}

	/**
	 * Check if system output contains HF-1b injection
	 */
	function hasHF1bInjection(systemOutput: string[]): boolean {
		return systemOutput.some((s) =>
			s.includes('[SWARM CONFIG] You must NEVER run the full test suite'),
		);
	}

	describe('HF-1: Coder and test_engineer receive self-verification guard', () => {
		it('activeAgent = "coder" → receives HF-1 injection, does NOT receive HF-1b injection', async () => {
			await createSwarmFiles();

			// Set active agent to coder
			swarmState.activeAgent.set('test-session', 'coder');

			const systemOutput = await invokeHook('test-session');

			// Should contain HF-1 injection
			expect(hasHF1Injection(systemOutput)).toBe(true);

			// Should NOT contain HF-1b injection
			expect(hasHF1bInjection(systemOutput)).toBe(false);
		});

		it('activeAgent = "test_engineer" → receives HF-1 injection, does NOT receive HF-1b injection', async () => {
			await createSwarmFiles();

			// Set active agent to test_engineer
			swarmState.activeAgent.set('test-session', 'test_engineer');

			const systemOutput = await invokeHook('test-session');

			// Should contain HF-1 injection
			expect(hasHF1Injection(systemOutput)).toBe(true);

			// Should NOT contain HF-1b injection
			expect(hasHF1bInjection(systemOutput)).toBe(false);
		});
	});

	describe('HF-1b: Architect and null receive full test suite guard', () => {
		it('activeAgent = "architect" → registered host delivers renderable HF-1b guidance', async () => {
			const result = await invokeRegisteredArchitect();

			expectArchitectGuardCarrier(result);
		});

		it('activeAgent = null/undefined → registered host uses the architect fallback', async () => {
			const result = await invokeRegisteredArchitect('architect', undefined);

			expectArchitectGuardCarrier(result);
		});
	});

	describe('Other agents receive NEITHER injection', () => {
		it('activeAgent = "reviewer" → receives NEITHER injection', async () => {
			await createSwarmFiles();

			// Set active agent to reviewer
			swarmState.activeAgent.set('test-session', 'reviewer');

			const systemOutput = await invokeHook('test-session');

			// Should NOT contain HF-1 injection
			expect(hasHF1Injection(systemOutput)).toBe(false);

			// Should NOT contain HF-1b injection
			expect(hasHF1bInjection(systemOutput)).toBe(false);
		});

		it('activeAgent = "explorer" → receives NEITHER injection (only HF-1b applies to architect/null)', async () => {
			await createSwarmFiles();

			// Set active agent to explorer
			swarmState.activeAgent.set('test-session', 'explorer');

			const systemOutput = await invokeHook('test-session');

			// Should NOT contain HF-1 injection
			expect(hasHF1Injection(systemOutput)).toBe(false);

			// Should NOT contain HF-1b injection
			expect(hasHF1bInjection(systemOutput)).toBe(false);
		});
	});

	describe('Prefix stripping behavior', () => {
		it('activeAgent = "mega_coder" (prefixed) → prefix stripped → same as coder → HF-1 injection', async () => {
			await createSwarmFiles();

			// Set active agent with prefix
			swarmState.activeAgent.set('test-session', 'mega_coder');

			const systemOutput = await invokeHook('test-session');

			// Should contain HF-1 injection (prefix stripped to 'coder')
			expect(hasHF1Injection(systemOutput)).toBe(true);

			// Should NOT contain HF-1b injection
			expect(hasHF1bInjection(systemOutput)).toBe(false);
		});

		it('activeAgent = "mega_architect" (prefixed) → registered host preserves the architect boundary', async () => {
			const result = await invokeRegisteredArchitect('mega_architect');

			expectArchitectGuardCarrier(result);
		});

		it('activeAgent = "mega_test_engineer" (prefixed) → prefix stripped → same as test_engineer → HF-1 injection', async () => {
			await createSwarmFiles();

			// Set active agent with prefix
			swarmState.activeAgent.set('test-session', 'mega_test_engineer');

			const systemOutput = await invokeHook('test-session');

			// Should contain HF-1 injection (prefix stripped to 'test_engineer')
			expect(hasHF1Injection(systemOutput)).toBe(true);

			// Should NOT contain HF-1b injection
			expect(hasHF1bInjection(systemOutput)).toBe(false);
		});
	});

	describe('Injection string content verification', () => {
		it('HF-1 injection contains the correct text about NOT running build/test/lint', async () => {
			await createSwarmFiles();

			swarmState.activeAgent.set('test-session', 'coder');

			const systemOutput = await invokeHook('test-session');

			// Find the HF-1 injection
			const hf1Line = systemOutput.find((s) =>
				s.includes(
					'[SWARM CONFIG] You must NOT run build, test, lint, or type-check commands',
				),
			);

			expect(hf1Line).toBeDefined();
			expect(hf1Line).toContain(
				'You must NOT run build, test, lint, or type-check commands',
			);
			expect(hf1Line).toContain(
				'npm run build, bun test, npx tsc, eslint, etc.',
			);
			expect(hf1Line).toContain(
				'Verification is handled by the reviewer agent',
			);
		});

		it('HF-1b carrier contains the correct full-test-suite guard text', async () => {
			const result = await invokeRegisteredArchitect();
			const carrierText = messageTextOf(
				result.messages.find(
					(message) =>
						isGuidanceCarrier(message) &&
						messageTextOf(message).includes(
							'[SWARM CONFIG] You must NEVER run the full test suite',
						),
				) as HostPartsMessage,
			);

			expectArchitectGuardCarrier(result);
			expect(carrierText).toContain(
				'You must NEVER run the full test suite or batch test files',
			);
			expect(carrierText).toContain(
				'run ONLY the specific test files for code YOU modified',
			);
			expect(carrierText).toContain('one file at a time, strictly serial');
			expect(carrierText).toContain(
				'delegate test execution to the test_engineer agent',
			);
		});
	});
});
