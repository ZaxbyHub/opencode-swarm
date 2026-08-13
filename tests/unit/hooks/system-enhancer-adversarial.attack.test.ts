/**
 * Adversarial security attack tests for adversarial detection wiring in system-enhancer.ts
 *
 * Tests attack vectors that could compromise security or cause crashes:
 * 1. Empty pairs array [] → no crash, no warning
 * 2. Very large pairs array (50 pairs, matching pair at end) → still detects and warns
 * 3. Active agent name with XSS injection → no crash (warning output is just text)
 * 4. config.adversarial_detection = { enabled: true } with no pairs/policy → use defaults
 * 5. Both agents in a pair are the same ['reviewer','reviewer'] → detect (same model) and warn
 * 6. Multiple pairs where active agent is checker in 2 pairs → 2 warnings injected
 *
 * All tests ensure the system is robust against malformed inputs and edge cases.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSystemEnhancerHook } from '../../../src/hooks/system-enhancer';
import { resetSwarmState, swarmState } from '../../../src/state';

describe('system-enhancer: Adversarial Detection Attack Tests', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'swarm-adversarial-attack-test-'));
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

	describe('Attack 1: Empty pairs array [] → no crash, no warning', () => {
		it('does not crash and does not warn with empty pairs array - legacy path', async () => {
			await createSwarmFiles();

			const config = {
				...defaultConfig,
				agents: {
					coder: { model: 'google/gemini-2.5-flash' },
					reviewer: { model: 'google/gemini-2.5-flash' },
				},
				adversarial_detection: {
					enabled: true,
					policy: 'warn',
					pairs: [], // Empty pairs array
				},
			};

			swarmState.activeAgent.set('test-session', 'reviewer');

			const result = await invokeHook(config);

			// Should not crash
			expect(result.error).toBeUndefined();

			// Should not warn since no pairs to check
			const warning = result.output.find((s) =>
				s.includes('Same-model adversarial pair detected'),
			);
			expect(warning).toBeUndefined();
		});

		it('does not crash and does not warn with empty pairs array - scoring path', async () => {
			await createSwarmFiles();

			const config = {
				...defaultConfig,
				agents: {
					coder: { model: 'google/gemini-2.5-flash' },
					reviewer: { model: 'google/gemini-2.5-flash' },
				},
				adversarial_detection: {
					enabled: true,
					policy: 'warn',
					pairs: [], // Empty pairs array
				},
				scoring: {
					enabled: true,
					max_candidates: 100,
					weights: {
						phase: 1.0,
						current_task: 2.0,
						blocked_task: 1.5,
						recent_failure: 2.5,
						recent_success: 0.5,
						evidence_presence: 1.0,
						decision_recency: 1.5,
						dependency_proximity: 1.0,
					},
				},
			};

			swarmState.activeAgent.set('test-session', 'reviewer');

			const result = await invokeHook(config);

			expect(result.error).toBeUndefined();

			const warning = result.output.find((s) =>
				s.includes('Same-model adversarial pair detected'),
			);
			expect(warning).toBeUndefined();
		});
	});

	describe('Attack 2: Very large pairs array (50 pairs, matching pair at end)', () => {
		it('detects and warns with 50 pairs where matching pair is at end - legacy path', async () => {
			await createSwarmFiles();

			// Create 49 non-matching pairs, then 1 matching pair at the end
			const pairs: [string, string][] = [];
			for (let i = 0; i < 49; i++) {
				pairs.push([`agent_${i}`, `checker_${i}`]);
			}
			pairs.push(['coder', 'reviewer']); // Matching pair at the end

			const config = {
				...defaultConfig,
				agents: {
					coder: { model: 'google/gemini-2.5-flash' },
					reviewer: { model: 'google/gemini-2.5-flash' },
				},
				adversarial_detection: {
					enabled: true,
					policy: 'warn',
					pairs,
				},
			};

			swarmState.activeAgent.set('test-session', 'reviewer');

			const result = await invokeHook(config);

			// Should not crash
			expect(result.error).toBeUndefined();

			// Should detect and warn
			const warning = result.output.find((s) =>
				s.includes('Same-model adversarial pair detected'),
			);
			expect(warning).toBeDefined();
			expect(warning).toContain('coder and checker reviewer');
			expect(warning).toContain('google/gemini-2.5-flash');
		});

		it('detects and warns with 50 pairs where matching pair is at end - scoring path', async () => {
			await createSwarmFiles();

			const pairs: [string, string][] = [];
			for (let i = 0; i < 49; i++) {
				pairs.push([`agent_${i}`, `checker_${i}`]);
			}
			pairs.push(['coder', 'reviewer']);

			const config = {
				...defaultConfig,
				agents: {
					coder: { model: 'google/gemini-2.5-flash' },
					reviewer: { model: 'google/gemini-2.5-flash' },
				},
				adversarial_detection: {
					enabled: true,
					policy: 'warn',
					pairs,
				},
				scoring: {
					enabled: true,
					max_candidates: 100,
					weights: {
						phase: 1.0,
						current_task: 2.0,
						blocked_task: 1.5,
						recent_failure: 2.5,
						recent_success: 0.5,
						evidence_presence: 1.0,
						decision_recency: 1.5,
						dependency_proximity: 1.0,
					},
				},
			};

			swarmState.activeAgent.set('test-session', 'reviewer');

			const result = await invokeHook(config);

			expect(result.error).toBeUndefined();

			const warning = result.output.find((s) =>
				s.includes('Same-model adversarial pair detected'),
			);
			expect(warning).toBeDefined();
			expect(warning).toContain('coder and checker reviewer');
		});
	});

	describe('Attack 3: Active agent name with XSS injection', () => {
		it('does not crash when active agent contains XSS injection attempt', async () => {
			await createSwarmFiles();

			const config = {
				...defaultConfig,
				agents: {
					coder: { model: 'google/gemini-2.5-flash' },
					reviewer: { model: 'google/gemini-2.5-flash' },
				},
			};

			// XSS injection attempt in agent name
			const xssAgent = 'reviewer"><script>alert("xss")</script>';
			swarmState.activeAgent.set('test-session', xssAgent);

			const result = await invokeHook(config);

			// Should not crash
			expect(result.error).toBeUndefined();

			// Output should be just text, no script execution
			// The agent name won't match "reviewer" due to the prefix stripping
			const warning = result.output.find((s) =>
				s.includes('Same-model adversarial pair detected'),
			);
			expect(warning).toBeUndefined();
		});

		it('does not crash when active agent contains HTML tags', async () => {
			await createSwarmFiles();

			const config = {
				...defaultConfig,
				agents: {
					coder: { model: 'google/gemini-2.5-flash' },
					reviewer: { model: 'google/gemini-2.5-flash' },
				},
			};

			// HTML tags in agent name
			const htmlAgent = '<img src=x onerror=alert(1)>reviewer';
			swarmState.activeAgent.set('test-session', htmlAgent);

			const result = await invokeHook(config);

			expect(result.error).toBeUndefined();

			const warning = result.output.find((s) =>
				s.includes('Same-model adversarial pair detected'),
			);
			expect(warning).toBeUndefined();
		});

		it('does not crash when active agent contains SQL injection attempt', async () => {
			await createSwarmFiles();

			const config = {
				...defaultConfig,
				agents: {
					coder: { model: 'google/gemini-2.5-flash' },
					reviewer: { model: 'google/gemini-2.5-flash' },
				},
			};

			// SQL injection attempt in agent name
			const sqlAgent = "reviewer' OR '1'='1";
			swarmState.activeAgent.set('test-session', sqlAgent);

			const result = await invokeHook(config);

			expect(result.error).toBeUndefined();

			const warning = result.output.find((s) =>
				s.includes('Same-model adversarial pair detected'),
			);
			expect(warning).toBeUndefined();
		});
	});

	describe('Attack 4: config.adversarial_detection = { enabled: true } with no pairs/policy', () => {
		it('uses default pairs and policy when adversarial_detection is minimal - legacy path', async () => {
			await createSwarmFiles();

			const config = {
				...defaultConfig,
				agents: {
					coder: { model: 'google/gemini-2.5-flash' },
					reviewer: { model: 'google/gemini-2.5-flash' },
				},
				adversarial_detection: {
					enabled: true, // No pairs, no policy specified
				},
			};

			swarmState.activeAgent.set('test-session', 'reviewer');

			const result = await invokeHook(config);

			expect(result.error).toBeUndefined();

			// Should use default pairs [['coder', 'reviewer']] and default policy 'warn'
			const warning = result.output.find((s) =>
				s.includes('Same-model adversarial pair detected'),
			);
			expect(warning).toBeDefined();
			expect(warning).toContain('coder and checker reviewer');
			expect(warning).toContain('Review may lack independence'); // Default policy is 'warn'
		});

		it('uses default pairs and policy when adversarial_detection is minimal - scoring path', async () => {
			await createSwarmFiles();

			const config = {
				...defaultConfig,
				agents: {
					coder: { model: 'google/gemini-2.5-flash' },
					reviewer: { model: 'google/gemini-2.5-flash' },
				},
				adversarial_detection: {
					enabled: true,
				},
				scoring: {
					enabled: true,
					max_candidates: 100,
					weights: {
						phase: 1.0,
						current_task: 2.0,
						blocked_task: 1.5,
						recent_failure: 2.5,
						recent_success: 0.5,
						evidence_presence: 1.0,
						decision_recency: 1.5,
						dependency_proximity: 1.0,
					},
				},
			};

			swarmState.activeAgent.set('test-session', 'reviewer');

			const result = await invokeHook(config);

			expect(result.error).toBeUndefined();

			const warning = result.output.find((s) =>
				s.includes('Same-model adversarial pair detected'),
			);
			expect(warning).toBeDefined();
		});

		it('uses defaults when adversarial_detection.enabled is true with empty object', async () => {
			await createSwarmFiles();

			const config = {
				...defaultConfig,
				agents: {
					coder: { model: 'google/gemini-2.5-flash' },
					reviewer: { model: 'google/gemini-2.5-flash' },
				},
				adversarial_detection: {}, // Empty object, enabled should default to true
			};

			swarmState.activeAgent.set('test-session', 'reviewer');

			const result = await invokeHook(config);

			expect(result.error).toBeUndefined();

			const warning = result.output.find((s) =>
				s.includes('Same-model adversarial pair detected'),
			);
			expect(warning).toBeDefined();
		});
	});

	describe('Attack 5: Both agents in a pair are the same [reviewer,reviewer]', () => {
		it('detects as same model and warns when pair is [reviewer, reviewer] - legacy path', async () => {
			await createSwarmFiles();

			const config = {
				...defaultConfig,
				agents: {
					reviewer: { model: 'google/gemini-2.5-flash' },
				},
				adversarial_detection: {
					enabled: true,
					policy: 'warn',
					pairs: [['reviewer', 'reviewer']], // Same agent in pair
				},
			};

			swarmState.activeAgent.set('test-session', 'reviewer');

			const result = await invokeHook(config);

			expect(result.error).toBeUndefined();

			// Should detect as same model (since it's the same agent)
			const warning = result.output.find((s) =>
				s.includes('Same-model adversarial pair detected'),
			);
			expect(warning).toBeDefined();
			expect(warning).toContain('reviewer and checker reviewer');
			expect(warning).toContain('google/gemini-2.5-flash');
		});

		it('detects as same model and warns when pair is [reviewer, reviewer] - scoring path', async () => {
			await createSwarmFiles();

			const config = {
				...defaultConfig,
				agents: {
					reviewer: { model: 'google/gemini-2.5-flash' },
				},
				adversarial_detection: {
					enabled: true,
					policy: 'warn',
					pairs: [['reviewer', 'reviewer']],
				},
				scoring: {
					enabled: true,
					max_candidates: 100,
					weights: {
						phase: 1.0,
						current_task: 2.0,
						blocked_task: 1.5,
						recent_failure: 2.5,
						recent_success: 0.5,
						evidence_presence: 1.0,
						decision_recency: 1.5,
						dependency_proximity: 1.0,
					},
				},
			};

			swarmState.activeAgent.set('test-session', 'reviewer');

			const result = await invokeHook(config);

			expect(result.error).toBeUndefined();

			const warning = result.output.find((s) =>
				s.includes('Same-model adversarial pair detected'),
			);
			expect(warning).toBeDefined();
			expect(warning).toContain('reviewer and checker reviewer');
		});

		it('warns with gate policy when pair is [coder, coder]', async () => {
			await createSwarmFiles();

			const config = {
				...defaultConfig,
				agents: {
					coder: { model: 'anthropic/claude-sonnet-4-20250514' },
				},
				adversarial_detection: {
					enabled: true,
					policy: 'gate',
					pairs: [['coder', 'coder']],
				},
			};

			swarmState.activeAgent.set('test-session', 'coder');

			const result = await invokeHook(config);

			expect(result.error).toBeUndefined();

			const warning = result.output.find((s) => s.includes('GATE POLICY'));
			expect(warning).toBeDefined();
			expect(warning).toContain('coder and checker coder');
		});
	});

	describe('Attack 6: Multiple pairs where active agent is checker in 2 pairs', () => {
		it('injects 2 warnings when reviewer is checker in 2 pairs - legacy path', async () => {
			await createSwarmFiles();

			const config = {
				...defaultConfig,
				agents: {
					coder: { model: 'google/gemini-2.5-flash' },
					reviewer: { model: 'google/gemini-2.5-flash' },
					explorer: { model: 'google/gemini-2.5-flash' },
				},
				adversarial_detection: {
					enabled: true,
					policy: 'warn',
					pairs: [
						['coder', 'reviewer'], // reviewer is checker
						['explorer', 'reviewer'], // reviewer is also checker
					],
				},
			};

			swarmState.activeAgent.set('test-session', 'reviewer');

			const result = await invokeHook(config);

			expect(result.error).toBeUndefined();

			// Should have 2 warnings
			const warnings = result.output.filter((s) =>
				s.includes('Same-model adversarial pair detected'),
			);
			expect(warnings.length).toBe(2);

			// Check that both pairs are mentioned
			const hasCoderWarning = warnings.some((w) =>
				w.includes('coder and checker reviewer'),
			);
			const hasExplorerWarning = warnings.some((w) =>
				w.includes('explorer and checker reviewer'),
			);
			expect(hasCoderWarning).toBe(true);
			expect(hasExplorerWarning).toBe(true);
		});

		it('injects 2 warnings when reviewer is checker in 2 pairs - scoring path', async () => {
			await createSwarmFiles();

			const config = {
				...defaultConfig,
				agents: {
					coder: { model: 'google/gemini-2.5-flash' },
					reviewer: { model: 'google/gemini-2.5-flash' },
					explorer: { model: 'google/gemini-2.5-flash' },
				},
				adversarial_detection: {
					enabled: true,
					policy: 'warn',
					pairs: [
						['coder', 'reviewer'],
						['explorer', 'reviewer'],
					],
				},
				scoring: {
					enabled: true,
					max_candidates: 100,
					weights: {
						phase: 1.0,
						current_task: 2.0,
						blocked_task: 1.5,
						recent_failure: 2.5,
						recent_success: 0.5,
						evidence_presence: 1.0,
						decision_recency: 1.5,
						dependency_proximity: 1.0,
					},
				},
			};

			swarmState.activeAgent.set('test-session', 'reviewer');

			const result = await invokeHook(config);

			expect(result.error).toBeUndefined();

			const warnings = result.output.filter((s) =>
				s.includes('Same-model adversarial pair detected'),
			);
			expect(warnings.length).toBe(2);
		});

		it('injects 3 warnings when checker appears in 3 pairs', async () => {
			await createSwarmFiles();

			const config = {
				...defaultConfig,
				agents: {
					coder: { model: 'google/gemini-2.5-flash' },
					reviewer: { model: 'google/gemini-2.5-flash' },
					explorer: { model: 'google/gemini-2.5-flash' },
					researcher: { model: 'google/gemini-2.5-flash' },
				},
				adversarial_detection: {
					enabled: true,
					policy: 'warn',
					pairs: [
						['coder', 'reviewer'],
						['explorer', 'reviewer'],
						['researcher', 'reviewer'],
					],
				},
			};

			swarmState.activeAgent.set('test-session', 'reviewer');

			const result = await invokeHook(config);

			expect(result.error).toBeUndefined();

			const warnings = result.output.filter((s) =>
				s.includes('Same-model adversarial pair detected'),
			);
			expect(warnings.length).toBe(3);
		});
	});
});
