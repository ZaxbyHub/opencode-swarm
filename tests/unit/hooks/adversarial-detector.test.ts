import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PluginConfig } from '../../../src/config';
import { DEFAULT_MODELS } from '../../../src/config/constants';
import {
	detectAdversarialPair,
	formatAdversarialWarning,
	resolveAgentModel,
} from '../../../src/hooks/adversarial-detector';
import { createSystemEnhancerHook } from '../../../src/hooks/system-enhancer';
import { resetSwarmState, swarmState } from '../../../src/state';

function makeConfig(overrides?: Record<string, unknown>): PluginConfig {
	return {
		max_iterations: 5,
		qa_retry_limit: 3,
		inject_phase_reminders: true,
		...overrides,
	} as PluginConfig;
}

describe('adversarial-detector hook', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'swarm-adversarial-test-'));
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
	 * Helper to invoke the system-enhancer transform hook and return the output
	 */
	async function invokeHook(
		config: any,
		sessionID = 'test-session',
	): Promise<{ output: string[]; error?: unknown }> {
		try {
			const hooks = createSystemEnhancerHook(config, tempDir);
			const transform = hooks['experimental.chat.system.transform'] as (
				input: { sessionID?: string },
				output: { system: string[] },
			) => Promise<void>;

			const input = { sessionID };
			const output = { system: ['Initial system prompt'] };

			await transform(input, output);

			return { output: output.system };
		} catch (error) {
			return { output: [], error };
		}
	}

	const defaultConfig = {
		max_iterations: 5,
		qa_retry_limit: 3,
		inject_phase_reminders: true,
		hooks: {
			system_enhancer: true,
			compaction: false,
			agent_activity: false,
			delegation_tracker: false,
			agent_awareness_max_chars: 300,
			delegation_gate: true,
			delegation_max_chars: 4000,
		},
	};

	describe('system-enhancer injection', () => {
		it('reviewer active + same model → warning in output.system', async () => {
			await createSwarmFiles();

			const config = {
				...defaultConfig,
				agents: {
					coder: { model: 'google/gemini-2.5-flash' },
					reviewer: { model: 'google/gemini-2.5-flash' },
				},
			};

			// Set active agent to reviewer (the checker in default pair ['coder', 'reviewer'])
			swarmState.activeAgent.set('test-session', 'reviewer');

			const result = await invokeHook(config);

			expect(result.error).toBeUndefined();

			// Should contain adversarial warning in output.system
			const warning = result.output.find((s) =>
				s.includes('Same-model adversarial pair detected'),
			);
			expect(warning).toBeDefined();
			expect(warning).toContain('[SWARM CONFIG]');
			expect(warning).toContain('coder and checker reviewer');
			expect(warning).toContain('google/gemini-2.5-flash');
		});

		it('coder active + same model configured → no warning (coder is not the checker)', async () => {
			await createSwarmFiles();

			const config = {
				...defaultConfig,
				agents: {
					coder: { model: 'google/gemini-2.5-flash' },
					reviewer: { model: 'google/gemini-2.5-flash' },
				},
			};

			// Set active agent to coder (NOT the checker in default pair ['coder', 'reviewer'])
			swarmState.activeAgent.set('test-session', 'coder');

			const result = await invokeHook(config);

			expect(result.error).toBeUndefined();

			// Should NOT contain adversarial warning
			const warning = result.output.find((s) =>
				s.includes('Same-model adversarial pair detected'),
			);
			expect(warning).toBeUndefined();
		});

		it('policy=ignore → no warning in output.system', async () => {
			await createSwarmFiles();

			const config = {
				...defaultConfig,
				agents: {
					coder: { model: 'google/gemini-2.5-flash' },
					reviewer: { model: 'google/gemini-2.5-flash' },
				},
				adversarial_detection: {
					enabled: true,
					policy: 'ignore',
					pairs: [['coder', 'reviewer']],
				},
			};

			swarmState.activeAgent.set('test-session', 'reviewer');

			const result = await invokeHook(config);

			expect(result.error).toBeUndefined();

			// Should NOT contain adversarial warning when policy is ignore
			const warning = result.output.find((s) =>
				s.includes('Same-model adversarial pair detected'),
			);
			expect(warning).toBeUndefined();
		});

		it('policy=gate → warning with GATE POLICY prefix in output.system', async () => {
			await createSwarmFiles();

			const config = {
				...defaultConfig,
				agents: {
					coder: { model: 'google/gemini-2.5-flash' },
					reviewer: { model: 'google/gemini-2.5-flash' },
				},
				adversarial_detection: {
					enabled: true,
					policy: 'gate',
					pairs: [['coder', 'reviewer']],
				},
			};

			swarmState.activeAgent.set('test-session', 'reviewer');

			const result = await invokeHook(config);

			expect(result.error).toBeUndefined();

			// Should contain GATE POLICY warning
			const warning = result.output.find((s) => s.includes('GATE POLICY'));
			expect(warning).toBeDefined();
			expect(warning).toContain('[SWARM CONFIG]');
			expect(warning).toContain('Same-model adversarial pair detected');
			expect(warning).toContain('requires extra scrutiny');
			expect(warning).toContain('escalate if issues are found');
		});

		it('enabled=false → no warning even when same model', async () => {
			await createSwarmFiles();

			const config = {
				...defaultConfig,
				agents: {
					coder: { model: 'google/gemini-2.5-flash' },
					reviewer: { model: 'google/gemini-2.5-flash' },
				},
				adversarial_detection: {
					enabled: false,
					policy: 'warn',
					pairs: [['coder', 'reviewer']],
				},
			};

			swarmState.activeAgent.set('test-session', 'reviewer');

			const result = await invokeHook(config);

			expect(result.error).toBeUndefined();

			// Should NOT contain adversarial warning when enabled is false
			const warning = result.output.find((s) =>
				s.includes('Same-model adversarial pair detected'),
			);
			expect(warning).toBeUndefined();
		});
	});

	describe('session isolation', () => {
		it('two different sessionIDs — session A has reviewer active, session B has coder active', async () => {
			await createSwarmFiles();

			const config = {
				...defaultConfig,
				agents: {
					coder: { model: 'google/gemini-2.5-flash' },
					reviewer: { model: 'google/gemini-2.5-flash' },
				},
			};

			// Set up swarmState.activeAgent for both sessions
			swarmState.activeAgent.set('session-a', 'reviewer');
			swarmState.activeAgent.set('session-b', 'coder');

			// Run the hook for session A → should contain warning
			const resultA = await invokeHook(config, 'session-a');

			expect(resultA.error).toBeUndefined();

			const warningA = resultA.output.find((s) =>
				s.includes('Same-model adversarial pair detected'),
			);
			expect(warningA).toBeDefined();
			expect(warningA).toContain('[SWARM CONFIG]');

			// Run the hook for session B → should NOT contain warning
			const resultB = await invokeHook(config, 'session-b');

			expect(resultB.error).toBeUndefined();

			const warningB = resultB.output.find((s) =>
				s.includes('Same-model adversarial pair detected'),
			);
			expect(warningB).toBeUndefined();
		});
	});

	describe('resolveAgentModel', () => {
		it('returns DEFAULT_MODELS[baseName] when no overrides', () => {
			const config = makeConfig();

			expect(resolveAgentModel('coder', config)).toBe(DEFAULT_MODELS.coder);
			expect(resolveAgentModel('reviewer', config)).toBe(
				DEFAULT_MODELS.reviewer,
			);
			expect(resolveAgentModel('architect', config)).toBe(
				DEFAULT_MODELS.default,
			);
		});

		it('does not invent an unconfigured mega-prefixed target', () => {
			const config = makeConfig();
			expect(resolveAgentModel('mega_coder', config)).toBe(
				DEFAULT_MODELS.default,
			);
			expect(resolveAgentModel('mega_reviewer', config)).toBe(
				DEFAULT_MODELS.reviewer,
			);
		});

		it('does not invent an unconfigured local-prefixed target', () => {
			const config = makeConfig();
			expect(resolveAgentModel('local_coder', config)).toBe(
				DEFAULT_MODELS.default,
			);
			expect(resolveAgentModel('local_reviewer', config)).toBe(
				DEFAULT_MODELS.reviewer,
			);
		});

		it('returns config.agents override when present', () => {
			const customModel = 'custom/model-x';
			const config = makeConfig({
				agents: {
					coder: { model: customModel },
					reviewer: { model: 'custom/model-y' },
				},
			});

			expect(resolveAgentModel('coder', config)).toBe(customModel);
			expect(resolveAgentModel('reviewer', config)).toBe('custom/model-y');
		});

		it('default swarm entry takes object-level precedence over top-level config', () => {
			const config = makeConfig({
				agents: {
					coder: { model: 'override/model' },
				},
				swarms: {
					default: {
						agents: {
							coder: { model: 'fast/model' },
						},
					},
				},
			});
			expect(resolveAgentModel('coder', config)).toBe('fast/model');
		});

		it('returns the exact named swarm model', () => {
			const config = makeConfig({
				swarms: {
					fast: {
						agents: {
							coder: { model: 'fast/model' },
							reviewer: { model: 'fast/reviewer' },
						},
					},
				},
			});
			expect(resolveAgentModel('fast_coder', config)).toBe('fast/model');
			expect(resolveAgentModel('fast_reviewer', config)).toBe('fast/reviewer');
		});

		it('does not borrow the first matching swarm model', () => {
			const config = makeConfig({
				swarms: {
					fast: {
						agents: {
							coder: { model: 'fast/model' },
						},
					},
					slow: {
						agents: {
							coder: { model: 'slow/model' },
						},
					},
				},
			});

			expect(resolveAgentModel('fast_coder', config)).toBe('fast/model');
			expect(resolveAgentModel('slow_coder', config)).toBe('slow/model');
			expect(resolveAgentModel('coder', config)).toBe(DEFAULT_MODELS.default);
		});

		it('returns DEFAULT_MODELS.default for unknown agent', () => {
			const config = makeConfig();

			expect(resolveAgentModel('unknown_agent', config)).toBe(
				DEFAULT_MODELS.default,
			);
		});

		it('handles prefixed unknown agent names', () => {
			const config = makeConfig();

			expect(resolveAgentModel('mega_unknown_agent', config)).toBe(
				DEFAULT_MODELS.default,
			);
		});

		it('case-insensitive agent name matching', () => {
			const config = makeConfig({
				agents: {
					coder: { model: 'custom/model' },
				},
			});

			expect(resolveAgentModel('Coder', config)).toBe('custom/model');
			expect(resolveAgentModel('CODER', config)).toBe('custom/model');
		});
	});

	describe('detectAdversarialPair', () => {
		it('returns null when agents use different models (default coder vs reviewer)', () => {
			const config = makeConfig();

			// coder defaults to 'anthropic/claude-sonnet-4-20250514'
			// reviewer defaults to 'google/gemini-2.5-flash'
			const result = detectAdversarialPair('coder', 'reviewer', config);

			expect(result).toBeNull();
		});

		it('returns null when agents use different models with overrides', () => {
			const config = makeConfig({
				agents: {
					coder: { model: 'model-a' },
					reviewer: { model: 'model-b' },
				},
			});

			const result = detectAdversarialPair('coder', 'reviewer', config);

			expect(result).toBeNull();
		});

		it('returns shared model when both agents forced to same model via config.agents', () => {
			const config = makeConfig({
				agents: {
					coder: { model: 'same/model' },
					reviewer: { model: 'same/model' },
				},
			});

			const result = detectAdversarialPair('coder', 'reviewer', config);

			expect(result).toBe('same/model');
		});

		it('case-insensitive model comparison: Model-X vs model-x', () => {
			const config = makeConfig({
				agents: {
					coder: { model: 'Model-X' },
					reviewer: { model: 'model-x' },
				},
			});

			const result = detectAdversarialPair('coder', 'reviewer', config);

			expect(result).toBe('model-x');
		});

		it('case-insensitive model comparison: uppercase vs lowercase', () => {
			const config = makeConfig({
				agents: {
					coder: { model: 'CUSTOM/MODEL' },
					reviewer: { model: 'custom/model' },
				},
			});

			const result = detectAdversarialPair('coder', 'reviewer', config);

			expect(result).toBe('custom/model');
		});

		it('handles prefixed agent names', () => {
			const config = makeConfig({
				swarms: {
					mega: { agents: { coder: { model: 'same/model' } } },
					local: { agents: { reviewer: { model: 'same/model' } } },
				},
			});

			const result = detectAdversarialPair(
				'mega_coder',
				'local_reviewer',
				config,
			);

			expect(result).toBe('same/model');
		});

		it('returns null when one agent is unknown', () => {
			const config = makeConfig();

			// unknown_agent defaults to DEFAULT_MODELS.default ('google/gemini-2.5-flash')
			// coder defaults to 'anthropic/claude-sonnet-4-20250514'
			const result = detectAdversarialPair('coder', 'unknown_agent', config);

			expect(result).toBeNull();
		});

		it('returns shared model when both unknown agents', () => {
			const config = makeConfig();

			// Both unknown agents default to DEFAULT_MODELS.default
			const result = detectAdversarialPair('unknown_a', 'unknown_b', config);

			expect(result).toBe(DEFAULT_MODELS.default.toLowerCase());
		});
	});

	describe('formatAdversarialWarning', () => {
		it('policy=warn starts with standard warning message', () => {
			const result = formatAdversarialWarning(
				'coder',
				'reviewer',
				'model-x',
				'warn',
			);

			expect(result).toMatch(/^⚠️ Same-model adversarial pair detected\./);
			expect(result).toContain('coder');
			expect(result).toContain('reviewer');
			expect(result).toContain('model-x');
			expect(result).toContain('Review may lack independence.');
		});

		it('policy=gate starts with GATE POLICY prefix', () => {
			const result = formatAdversarialWarning(
				'coder',
				'reviewer',
				'model-x',
				'gate',
			);

			expect(result).toMatch(/^⚠️ GATE POLICY:/);
			expect(result).toContain('requires extra scrutiny');
			expect(result).toContain('escalate if issues are found');
		});

		it('policy=ignore uses same format as warn', () => {
			const result = formatAdversarialWarning(
				'coder',
				'reviewer',
				'model-x',
				'ignore',
			);

			expect(result).toMatch(/^⚠️ Same-model adversarial pair detected\./);
			expect(result).toContain('Review may lack independence.');
		});

		it('unknown policy uses same format as warn', () => {
			const result = formatAdversarialWarning(
				'coder',
				'reviewer',
				'model-x',
				'unknown',
			);

			expect(result).toMatch(/^⚠️ Same-model adversarial pair detected\./);
			expect(result).toContain('Review may lack independence.');
		});

		it('includes both agent names in message', () => {
			const result = formatAdversarialWarning(
				'agent-a',
				'agent-b',
				'model-x',
				'warn',
			);

			expect(result).toContain('agent-a');
			expect(result).toContain('agent-b');
		});

		it('includes shared model name in message', () => {
			const result = formatAdversarialWarning(
				'coder',
				'reviewer',
				'anthropic/claude-sonnet-4-20250514',
				'warn',
			);

			expect(result).toContain('anthropic/claude-sonnet-4-20250514');
		});
	});

	describe('integration tests', () => {
		it('full workflow: resolve, detect, format adversarial pair', () => {
			const config = makeConfig({
				agents: {
					coder: { model: 'same/model' },
					reviewer: { model: 'SAME/MODEL' },
				},
			});

			const sharedModel = detectAdversarialPair('coder', 'reviewer', config);
			expect(sharedModel).toBe('same/model');

			const warning = formatAdversarialWarning(
				'coder',
				'reviewer',
				sharedModel!,
				'gate',
			);
			expect(warning).toMatch(/^⚠️ GATE POLICY:/);
			expect(warning).toContain('same/model');
		});

		it('full workflow: no adversarial pair detected', () => {
			const config = makeConfig();

			const sharedModel = detectAdversarialPair('coder', 'reviewer', config);
			expect(sharedModel).toBeNull();
		});

		it('complex scenario: swarm override creates adversarial pair', () => {
			const config = makeConfig({
				swarms: {
					cloud: {
						agents: {
							coder: { model: 'cloud/model' },
							reviewer: { model: 'cloud/model' },
						},
					},
				},
			});

			const sharedModel = detectAdversarialPair(
				'cloud_coder',
				'cloud_reviewer',
				config,
			);
			expect(sharedModel).toBe('cloud/model');

			const warning = formatAdversarialWarning(
				'coder',
				'reviewer',
				sharedModel!,
				'warn',
			);
			expect(warning).toMatch(/^⚠️ Same-model adversarial pair detected\./);
		});
	});
});
