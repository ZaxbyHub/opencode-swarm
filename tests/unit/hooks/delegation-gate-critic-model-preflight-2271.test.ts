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
import type { OpencodeClient } from '@opencode-ai/sdk';
import type { PluginConfig } from '../../../src/config';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import { dispatchCriticAndWriteEvent } from '../../../src/hooks/full-auto-intercept';
import { invalidateProviderCatalogCache } from '../../../src/services/model-preflight';
import { resetSwarmState, swarmState } from '../../../src/state';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const CATALOG_MODELS = { 'big-pickle': { id: 'big-pickle' } };

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

	test('delegation gate preflight fails open when the catalog is unreachable', async () => {
		swarmState.opencodeClient = catalogClient(true);
		const hook = createDelegationGateHook(config, tempDir);
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
});
