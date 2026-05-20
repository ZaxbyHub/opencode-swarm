/**
 * Tests for v6.0 system-enhancer hint injection features:
 * - Security review hint injection (always_security_review)
 * - Integration analysis disabled hint injection (integration_analysis.enabled = false)
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PluginConfig } from '../../../src/config';
import { createSystemEnhancerHook } from '../../../src/hooks/system-enhancer';
import { resetSwarmState } from '../../../src/state';

describe('v6.0 System Enhancer Hint Injection', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'swarm-v6-test-'));
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
	async function invokeHook(config: PluginConfig): Promise<string[]> {
		const hooks = createSystemEnhancerHook(config, tempDir);
		const transform = hooks['experimental.chat.system.transform'] as (
			input: { sessionID?: string },
			output: { system: string[] },
		) => Promise<void>;

		const input = { sessionID: 'test-session' };
		const output = { system: ['Initial system prompt'] };

		await transform(input, output);

		return output.system;
	}

	const defaultConfig: PluginConfig = {
		max_iterations: 5,
		qa_retry_limit: 3,
		inject_phase_reminders: true,
	};

	describe('Security review hint injection', () => {
		it('injects hint when always_security_review is true', async () => {
			await createSwarmFiles();

			const config: PluginConfig = {
				...defaultConfig,
				review_passes: {
					always_security_review: true,
				},
			};

			const systemOutput = await invokeHook(config);

			// Should contain security review hint
			const hasSecurityHint = systemOutput.some((s) =>
				s.includes('[SWARM CONFIG] Security review pass is MANDATORY'),
			);
			expect(hasSecurityHint).toBe(true);
		});

		it('does NOT inject hint when always_security_review is false', async () => {
			await createSwarmFiles();

			const config: PluginConfig = {
				...defaultConfig,
				review_passes: {
					always_security_review: false,
				},
			};

			const systemOutput = await invokeHook(config);

			// Should NOT contain security review hint
			const hasSecurityHint = systemOutput.some((s) =>
				s.includes('[SWARM CONFIG] Security review pass'),
			);
			expect(hasSecurityHint).toBe(false);
		});

		it('does NOT inject hint when review_passes is missing', async () => {
			await createSwarmFiles();

			const config: PluginConfig = {
				...defaultConfig,
				// No review_passes key
			};

			const systemOutput = await invokeHook(config);

			// Should NOT contain security review hint
			const hasSecurityHint = systemOutput.some((s) =>
				s.includes('[SWARM CONFIG] Security review pass'),
			);
			expect(hasSecurityHint).toBe(false);
		});
	});

	describe('Integration analysis disabled hint injection', () => {
		it('injects hint when integration_analysis.enabled is false', async () => {
			await createSwarmFiles();

			const config: PluginConfig = {
				...defaultConfig,
				integration_analysis: {
					enabled: false,
				},
			};

			const systemOutput = await invokeHook(config);

			// Should contain integration analysis disabled hint
			const hasIntegrationHint = systemOutput.some((s) =>
				s.includes('[SWARM CONFIG] Integration analysis is DISABLED'),
			);
			expect(hasIntegrationHint).toBe(true);
		});

		it('does NOT inject hint when integration_analysis.enabled is true', async () => {
			await createSwarmFiles();

			const config: PluginConfig = {
				...defaultConfig,
				integration_analysis: {
					enabled: true,
				},
			};

			const systemOutput = await invokeHook(config);

			// Should NOT contain integration analysis disabled hint
			const hasIntegrationHint = systemOutput.some((s) =>
				s.includes('[SWARM CONFIG] Integration analysis is DISABLED'),
			);
			expect(hasIntegrationHint).toBe(false);
		});

		it('does NOT inject hint when integration_analysis is missing', async () => {
			await createSwarmFiles();

			const config: PluginConfig = {
				...defaultConfig,
				// No integration_analysis key
			};

			const systemOutput = await invokeHook(config);

			// Should NOT contain integration analysis disabled hint
			const hasIntegrationHint = systemOutput.some((s) =>
				s.includes('[SWARM CONFIG] Integration analysis is DISABLED'),
			);
			expect(hasIntegrationHint).toBe(false);
		});
	});

	describe('Combined hint injection', () => {
		it('injects BOTH hints when both conditions are true', async () => {
			await createSwarmFiles();

			const config: PluginConfig = {
				...defaultConfig,
				review_passes: {
					always_security_review: true,
				},
				integration_analysis: {
					enabled: false,
				},
			};

			const systemOutput = await invokeHook(config);

			// Should contain security review hint
			const hasSecurityHint = systemOutput.some((s) =>
				s.includes('[SWARM CONFIG] Security review pass is MANDATORY'),
			);
			expect(hasSecurityHint).toBe(true);

			// Should contain integration analysis disabled hint
			const hasIntegrationHint = systemOutput.some((s) =>
				s.includes('[SWARM CONFIG] Integration analysis is DISABLED'),
			);
			expect(hasIntegrationHint).toBe(true);
		});
	});

	describe('Full hint content verification', () => {
		it('injects correct security review hint text', async () => {
			await createSwarmFiles();

			const config: PluginConfig = {
				...defaultConfig,
				review_passes: {
					always_security_review: true,
				},
			};

			const systemOutput = await invokeHook(config);

			const expectedText =
				'[SWARM CONFIG] Security review pass is MANDATORY for ALL tasks. Skip file-pattern check — always run security-only reviewer pass after general review APPROVED.';
			const hasExactText = systemOutput.includes(expectedText);
			expect(hasExactText).toBe(true);
		});

		it('injects correct integration analysis hint text', async () => {
			await createSwarmFiles();

			const config: PluginConfig = {
				...defaultConfig,
				integration_analysis: {
					enabled: false,
				},
			};

			const systemOutput = await invokeHook(config);

			const expectedText =
				'[SWARM CONFIG] Integration analysis is DISABLED. Skip diff tool and integration impact analysis after coder tasks.';
			const hasExactText = systemOutput.includes(expectedText);
			expect(hasExactText).toBe(true);
		});
	});
});
