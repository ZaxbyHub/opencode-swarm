/**
 * Critic-gate model-resolution preflight wiring — issue #2271 bug 4.
 *
 * Gate-level coverage (the service itself is covered in
 * tests/unit/services/model-preflight-2271.test.ts):
 * - The delegation gate denies an architect's critic dispatch with
 *   PLAN_CRITIC_MODEL_UNRESOLVED when the catalog POSITIVELY reports the
 *   critic model unresolvable (instead of letting the dispatch fail
 *   permanently after leaving the gate and wedging the plan-critic gate).
 * - Catalog unavailable → fail-open (the dispatch proceeds past the
 *   preflight; no PLAN_CRITIC_MODEL_UNRESOLVED denial).
 * - The full-auto oversight critic returns PENDING + escalation with an
 *   actionable reason instead of silently failing every dispatch.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { OpencodeClient } from '@opencode-ai/sdk';
import { getAgentConfigs } from '../../../src/agents';
import type { PluginConfig } from '../../../src/config';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import { dispatchCriticAndWriteEvent } from '../../../src/hooks/full-auto-intercept';
import { invalidateProviderCatalogCache } from '../../../src/services/model-preflight';
import { resetSwarmState, swarmState } from '../../../src/state';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const CATALOG_MODELS = { 'big-pickle': { id: 'big-pickle' } };

const CRITIC_VARIANTS = [
	'critic_sounding_board',
	'critic_drift_verifier',
	'critic_hallucination_verifier',
	'critic_architecture_supervisor',
	'critic_finding_validator',
	'critic_oversight',
] as const;

function catalogClient(fail = false): OpencodeClient {
	return {
		provider: {
			list: async () => {
				if (fail) throw new Error('catalog unreachable');
				return {
					data: {
						all: [{ id: 'opencode', name: 'opencode', models: CATALOG_MODELS }],
					},
				};
			},
		},
	} as unknown as OpencodeClient;
}

function catalogClientFor(providerID: string, modelID: string): OpencodeClient {
	return {
		provider: {
			list: async () => ({
				data: {
					all: [
						{
							id: providerID,
							name: providerID,
							models: { [modelID]: { id: modelID } },
						},
					],
				},
			}),
		},
	} as unknown as OpencodeClient;
}

async function expectNoUnresolvedModelError(
	configUnderTest: PluginConfig,
	tempDir: string,
	target: string,
): Promise<void> {
	const registeredAgents = getAgentConfigs(configUnderTest, tempDir);
	const hook = createDelegationGateHook(
		configUnderTest,
		tempDir,
		registeredAgents,
	);
	const outcome = await hook
		.toolBefore(
			{ tool: 'Task', sessionID: 'architect-1', callID: `call-${target}` },
			{ args: { subagent_type: target, prompt: 'review the plan' } },
		)
		.catch((error: unknown) => error as Error);
	expect(
		outcome instanceof Error &&
			outcome.message.includes('PLAN_CRITIC_MODEL_UNRESOLVED'),
	).toBe(false);
}

const config = {
	max_iterations: 5,
	qa_retry_limit: 3,
	inject_phase_reminders: true,
	hooks: { delegation_gate: true },
	worktree: { policy: 'disabled' },
	agents: {
		critic: { model: 'opencode/nemotron-3-ultra-free' },
	},
} as unknown as PluginConfig;

describe('issue #2271 bug 4 — critic-gate model preflight wiring', () => {
	let tempDir: string;

	beforeEach(() => {
		resetSwarmState();
		invalidateProviderCatalogCache();
		tempDir = canonicalMkdtemp('critic-preflight-2271-');
	});

	afterEach(() => {
		resetSwarmState();
		invalidateProviderCatalogCache();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test('delegation gate denies a critic dispatch whose model does not resolve', async () => {
		swarmState.opencodeClient = catalogClient();
		const hook = createDelegationGateHook(config, tempDir);
		const outcome = hook.toolBefore(
			{ tool: 'Task', sessionID: 'architect-1', callID: 'critic-call-1' },
			{ args: { subagent_type: 'critic', prompt: 'review the plan' } },
		);
		await expect(outcome).rejects.toThrow('PLAN_CRITIC_MODEL_UNRESOLVED');
		await expect(outcome).rejects.toThrow('opencode/nemotron-3-ultra-free');
	});

	test('delegation gate validates the injected runtime model for base critic', async () => {
		swarmState.opencodeClient = catalogClientFor('custom', 'base-critic');
		const baseConfig = {
			...config,
			agents: { critic: { model: 'custom/base-critic' } },
		} as unknown as PluginConfig;
		await expectNoUnresolvedModelError(baseConfig, tempDir, 'critic');
	});

	test.each(
		CRITIC_VARIANTS,
	)('delegation gate validates the inherited critic model for %s', async (target) => {
		swarmState.opencodeClient = catalogClientFor(
			'ollama-cloud',
			'minimax-m2.7',
		);
		const inheritedConfig = {
			...config,
			agents: { critic: { model: 'ollama-cloud/minimax-m2.7' } },
		} as unknown as PluginConfig;
		await expectNoUnresolvedModelError(inheritedConfig, tempDir, target);
	});

	test('exact critic variant override wins over inherited critic model', async () => {
		swarmState.opencodeClient = catalogClientFor('custom', 'variant-model');
		const overrideConfig = {
			...config,
			agents: {
				critic: { model: 'custom/inherited-model' },
				critic_sounding_board: { model: 'custom/variant-model' },
			},
		} as unknown as PluginConfig;
		await expectNoUnresolvedModelError(
			overrideConfig,
			tempDir,
			'critic_sounding_board',
		);
	});

	test('named swarm resolves the exact prefixed critic target', async () => {
		swarmState.opencodeClient = catalogClientFor('custom', 'swarm-model');
		const swarmConfig = {
			...config,
			swarms: {
				mega: {
					name: 'Mega',
					agents: { critic: { model: 'custom/swarm-model' } },
				},
			},
		} as unknown as PluginConfig;
		await expectNoUnresolvedModelError(
			swarmConfig,
			tempDir,
			'mega_critic_sounding_board',
		);
	});

	test('named swarm exact variant override wins over its inherited critic model', async () => {
		swarmState.opencodeClient = catalogClientFor('custom', 'swarm-variant');
		const swarmConfig = {
			...config,
			swarms: {
				mega: {
					name: 'Mega',
					agents: {
						critic: { model: 'custom/swarm-inherited' },
						critic_sounding_board: { model: 'custom/swarm-variant' },
					},
				},
			},
		} as unknown as PluginConfig;
		await expectNoUnresolvedModelError(
			swarmConfig,
			tempDir,
			'mega_critic_sounding_board',
		);
	});

	test('named swarm unresolved error identifies the exact effective target', async () => {
		swarmState.opencodeClient = catalogClientFor('custom', 'different-model');
		const swarmConfig = {
			...config,
			swarms: {
				mega: {
					name: 'Mega',
					agents: { critic: { model: 'custom/missing-model' } },
				},
			},
		} as unknown as PluginConfig;
		const registeredAgents = getAgentConfigs(swarmConfig, tempDir);
		const hook = createDelegationGateHook(
			swarmConfig,
			tempDir,
			registeredAgents,
		);
		const outcome = hook.toolBefore(
			{ tool: 'Task', sessionID: 'architect-1', callID: 'named-unresolved' },
			{
				args: {
					subagent_type: 'mega_critic_sounding_board',
					prompt: 'review the plan',
				},
			},
		);
		await expect(outcome).rejects.toThrow('custom/missing-model');
		await expect(outcome).rejects.toThrow('mega_critic_sounding_board');
		await expect(outcome).rejects.toThrow('effective model configuration');
	});

	test('composition root injects agents and the hook never rebuilds them', () => {
		const hookSource = fs.readFileSync(
			path.join(process.cwd(), 'src', 'hooks', 'delegation-gate.ts'),
			'utf8',
		);
		const indexSource = fs.readFileSync(
			path.join(process.cwd(), 'src', 'index.ts'),
			'utf8',
		);
		expect(hookSource).not.toContain('getAgentConfigs');
		expect(indexSource).toMatch(
			/createDelegationGateHook\(\s*configWithResolvedAutoReview,\s*ctx\.directory,\s*agents,\s*\)/,
		);
	});

	test('delegation gate preflight fails open when the catalog is unreachable', async () => {
		swarmState.opencodeClient = catalogClient(true);
		const registeredAgents = getAgentConfigs(config, tempDir);
		const hook = createDelegationGateHook(config, tempDir, registeredAgents);
		const outcome = await hook
			.toolBefore(
				{ tool: 'Task', sessionID: 'architect-1', callID: 'critic-call-2' },
				{ args: { subagent_type: 'critic', prompt: 'review the plan' } },
			)
			.catch((error: unknown) => error as Error);
		// The dispatch must not be denied by the preflight itself. Downstream
		// gate stages may still reject for unrelated reasons — only the
		// sentinel matters here.
		expect(
			outcome instanceof Error &&
				outcome.message.includes('PLAN_CRITIC_MODEL_UNRESOLVED'),
		).toBe(false);
	});

	test('non-critic Task dispatches are never blocked by the critic preflight', async () => {
		swarmState.opencodeClient = catalogClient();
		const hook = createDelegationGateHook(config, tempDir);
		const outcome = await hook
			.toolBefore(
				{ tool: 'Task', sessionID: 'architect-1', callID: 'explorer-call' },
				{ args: { subagent_type: 'explorer', prompt: 'map the repo' } },
			)
			.catch((error: unknown) => error as Error);
		expect(
			outcome instanceof Error &&
				outcome.message.includes('PLAN_CRITIC_MODEL_UNRESOLVED'),
		).toBe(false);
	});

	test('full-auto oversight critic returns actionable PENDING on unresolved model', async () => {
		swarmState.opencodeClient = catalogClient();
		const result = await dispatchCriticAndWriteEvent(
			tempDir,
			'architect output',
			'critic context',
			'opencode/nemotron-3-ultra-free',
			'phase_completion',
			0,
			0,
			'critic_oversight',
			'session-1',
		);
		expect(result.verdict).toBe('PENDING');
		expect(result.escalationNeeded).toBe(true);
		expect(result.reasoning).toContain('does not resolve');
		expect(result.reasoning).toContain('agents.critic_oversight.model');
	});

	test('PRR-004: unresolved-model refusal survives an oversight-event write failure', async () => {
		// Make the durable audit write fail (events.jsonl path occupied by a
		// directory) — the refusal itself must still be returned instead of
		// falling through to dispatching the known-unresolvable model.
		swarmState.opencodeClient = catalogClient();
		const swarmDir = path.join(tempDir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });
		fs.mkdirSync(path.join(swarmDir, 'events.jsonl'));
		const result = await dispatchCriticAndWriteEvent(
			tempDir,
			'architect output',
			'critic context',
			'opencode/nemotron-3-ultra-free',
			'phase_completion',
			0,
			0,
			'critic_oversight',
			'session-1',
		);
		expect(result.verdict).toBe('PENDING');
		expect(result.escalationNeeded).toBe(true);
		expect(result.reasoning).toContain('does not resolve');
	});
});
