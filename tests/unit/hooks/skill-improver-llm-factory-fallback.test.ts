/**
 * Issue #1927 (the #1905 follow-up): the opt-in skill-improver LLM delegate
 * (`createSkillImproverLLMDelegate` in `src/hooks/skill-improver-llm-factory.ts`)
 * now fails over to a configured `fallback_models` entry on a transient/quota
 * dispatch error instead of failing the opt-in skill-improvement feature
 * outright. Mirrors `tests/unit/hooks/auto-review-fallback.test.ts`.
 *
 * DI is via `swarmState.opencodeClient` (the factory reads it directly) — no
 * `mock.module`, per AGENTS.md invariant #7. Fallback config is seeded through
 * `getAgentConfigs`, which populates the `_swarmAgentsMap` that
 * `resolveFallbackModel` reads.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { getAgentConfigs } from '../../../src/agents/index';
import type { PluginConfig } from '../../../src/config';
import { createSkillImproverLLMDelegate } from '../../../src/hooks/skill-improver-llm-factory';
import { resetSwarmState, swarmState } from '../../../src/state';
import { _internals as telemetryInternals } from '../../../src/telemetry';

const RESULT_TEXT = 'skill improvement report';

type ModelOverride = { providerID: string; modelID: string };

function fakeClient(
	prompt: (model: ModelOverride | undefined) => Promise<unknown>,
	promptCalls: Array<string | undefined>,
): typeof swarmState.opencodeClient {
	let sessionCounter = 0;
	return {
		session: {
			create: async () => ({
				data: { id: `skill-improver-session-${++sessionCounter}` },
			}),
			prompt: async (params: { body?: { model?: ModelOverride } }) => {
				const model = params.body?.model;
				promptCalls.push(
					model ? `${model.providerID}/${model.modelID}` : undefined,
				);
				return prompt(model);
			},
			delete: async () => ({}),
		},
	} as unknown as typeof swarmState.opencodeClient;
}

const QUOTA_ENVELOPE = {
	data: null,
	error: {
		code: 'RATE_LIMITED',
		message: '429 rate_limit_exceeded: too many requests',
	},
};
const OK_ENVELOPE = { data: { parts: [{ type: 'text', text: RESULT_TEXT }] } };

/** Seed the skill_improver's own fallback chain (no inheritance for this role). */
function seedSkillImproverFallback(): void {
	getAgentConfigs({
		agents: {
			skill_improver: {
				model: 'prov/primary-skill',
				fallback_models: ['prov/fb1', 'prov/fb2'],
			},
		},
	} as unknown as PluginConfig);
}

let origClient: typeof swarmState.opencodeClient;
const origEmit = telemetryInternals.emit;

beforeEach(() => {
	origClient = swarmState.opencodeClient;
	resetSwarmState();
});

afterEach(() => {
	swarmState.opencodeClient = origClient;
	telemetryInternals.emit = origEmit;
	resetSwarmState();
});

describe('createSkillImproverLLMDelegate — model failover (#1927)', () => {
	test('fails over to a fallback model on a quota dispatch error and returns the fallback result', async () => {
		seedSkillImproverFallback();
		const promptCalls: Array<string | undefined> = [];
		swarmState.opencodeClient = fakeClient(async (model) => {
			if (model?.modelID === 'primary-skill') return QUOTA_ENVELOPE;
			return OK_ENVELOPE;
		}, promptCalls);

		const delegate = createSkillImproverLLMDelegate('/tmp/proj', 'sess-1');
		expect(delegate).toBeDefined();
		const out = await delegate!('sys prompt', 'user input');

		expect(out).toBe(RESULT_TEXT);
		expect(promptCalls[0]).toBe('prov/primary-skill');
		expect(promptCalls[1]).toBe('prov/fb1');
	});

	test('starts each delegate call at the primary model', async () => {
		seedSkillImproverFallback();
		const promptCalls: Array<string | undefined> = [];
		let primaryFailures = 0;
		swarmState.opencodeClient = fakeClient(async (model) => {
			if (model?.modelID === 'primary-skill' && primaryFailures++ === 0) {
				return QUOTA_ENVELOPE;
			}
			return OK_ENVELOPE;
		}, promptCalls);

		const delegate = createSkillImproverLLMDelegate('/tmp/proj', 'sess-1');
		await delegate!('sys', 'first');
		await delegate!('sys', 'second');

		expect(promptCalls).toEqual([
			'prov/primary-skill',
			'prov/fb1',
			'prov/primary-skill',
		]);
	});

	test('emits telemetry.modelFallback on a quota failover', async () => {
		seedSkillImproverFallback();
		const emitted: Array<{ event: string; data: Record<string, unknown> }> = [];
		telemetryInternals.emit = (event, data) => {
			emitted.push({ event, data });
		};
		const promptCalls: Array<string | undefined> = [];
		swarmState.opencodeClient = fakeClient(async (model) => {
			if (model?.modelID === 'primary-skill') return QUOTA_ENVELOPE;
			return OK_ENVELOPE;
		}, promptCalls);

		const delegate = createSkillImproverLLMDelegate('/tmp/proj', 'sess-1');
		await delegate!('sys prompt', 'user input');

		const fallbackEvents = emitted.filter((e) => e.event === 'model_fallback');
		expect(fallbackEvents).toHaveLength(1);
		expect(fallbackEvents[0]?.data.toModel).toBe('prov/fb1');
		expect(fallbackEvents[0]?.data.agentName).toBe('skill_improver');
		expect(fallbackEvents[0]?.data.reason).toBe('transient_model_error');
	});

	test('a permanent dispatch error does not fail over and surfaces the primary error', async () => {
		seedSkillImproverFallback();
		const promptCalls: Array<string | undefined> = [];
		swarmState.opencodeClient = fakeClient(
			async () => ({
				data: null,
				error: {
					code: 'UNAUTHORIZED',
					message: '401 unauthorized: invalid api key',
				},
			}),
			promptCalls,
		);

		const delegate = createSkillImproverLLMDelegate('/tmp/proj', 'sess-1');
		await expect(delegate!('sys prompt', 'user input')).rejects.toThrow(
			/401 unauthorized/,
		);
		expect(promptCalls).toHaveLength(1);
		expect(promptCalls[0]).toBe('prov/primary-skill');
	});

	test('an abort during dispatch maps to SKILL_IMPROVER_LLM_TIMEOUT with no failover', async () => {
		seedSkillImproverFallback();
		const promptCalls: Array<string | undefined> = [];
		swarmState.opencodeClient = fakeClient(async () => {
			const err = new Error('The operation was aborted');
			err.name = 'AbortError';
			throw err;
		}, promptCalls);

		const delegate = createSkillImproverLLMDelegate('/tmp/proj', 'sess-1');
		await expect(delegate!('sys prompt', 'user input')).rejects.toThrow(
			'SKILL_IMPROVER_LLM_TIMEOUT',
		);
		expect(promptCalls).toHaveLength(1);
	});

	test('with no fallback chain configured, a quota error degrades exactly as before (primary error surfaces)', async () => {
		// Explicitly seed an empty default-swarm config: `_swarmAgentsMap` is
		// module-global and NOT cleared by resetSwarmState, so this overwrites any
		// chain a prior test seeded, making the no-fallback case order-independent.
		getAgentConfigs({ agents: {} } as unknown as PluginConfig);
		const promptCalls: Array<string | undefined> = [];
		swarmState.opencodeClient = fakeClient(
			async () => QUOTA_ENVELOPE,
			promptCalls,
		);

		const delegate = createSkillImproverLLMDelegate('/tmp/proj', 'sess-1');
		await expect(delegate!('sys prompt', 'user input')).rejects.toThrow(
			/skill_improver LLM prompt failed/,
		);
		expect(promptCalls).toHaveLength(1);
	});

	test('routes failover through the correct swarm chain for a prefixed agent name', async () => {
		getAgentConfigs({
			swarms: {
				swarm1: {
					name: 'Swarm1',
					agents: {
						skill_improver: {
							model: 'prov/s1-primary',
							fallback_models: ['prov/s1-fb1'],
						},
					},
				},
			},
		} as unknown as PluginConfig);
		swarmState.skillImproverAgentNames = ['swarm1_skill_improver'];
		const promptCalls: Array<string | undefined> = [];
		const agentNames: Array<string | undefined> = [];
		swarmState.opencodeClient = {
			session: {
				create: async () => ({ data: { id: 'skill-improver-session-1' } }),
				prompt: async (params: {
					body?: { agent?: string; model?: ModelOverride };
				}) => {
					agentNames.push(params.body?.agent);
					const model = params.body?.model;
					promptCalls.push(
						model ? `${model.providerID}/${model.modelID}` : undefined,
					);
					if (model?.modelID === 's1-primary') return QUOTA_ENVELOPE;
					return OK_ENVELOPE;
				},
				delete: async () => ({}),
			},
		} as unknown as typeof swarmState.opencodeClient;

		const delegate = createSkillImproverLLMDelegate('/tmp/proj', 'sess-1');
		const out = await delegate!('sys prompt', 'user input');

		expect(out).toBe(RESULT_TEXT);
		expect(agentNames[0]).toBe('swarm1_skill_improver');
		expect(promptCalls[0]).toBe('prov/s1-primary');
		expect(promptCalls[1]).toBe('prov/s1-fb1');
	});
});
