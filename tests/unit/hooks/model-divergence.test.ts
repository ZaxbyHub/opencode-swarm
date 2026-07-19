/**
 * Issue #1896 (sub-issue 2): architect/primary model-divergence detection.
 *
 * The architect's model is UI-driven by design (its configured `model` is
 * intentionally stripped), so "config != UI" is the normal state. The genuine
 * defects surfaced here are: (a) a model that SILENTLY changed across an
 * interrupt/resume, and (b) a configured architect model the UI has overridden
 * (expected, but worth one clarifying note). Detection is scoped to the architect
 * session (swarm fallback only mutates SUBAGENT models) and the observed model is
 * persisted through snapshots so the cross-interrupt compare is like-with-like.
 */

import { beforeEach, describe, expect, it } from 'bun:test';
import { getAgentConfigs } from '../../../src/agents/index';
import type { PluginConfig } from '../../../src/config';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import {
	deserializeAgentSession,
	TRANSIENT_SESSION_FIELDS,
} from '../../../src/session/snapshot-reader';
import { serializeAgentSession } from '../../../src/session/snapshot-writer';
import {
	ensureAgentSession,
	resetSwarmState,
	swarmState,
} from '../../../src/state';

function config(): GuardrailsConfig {
	return {
		enabled: true,
		max_tool_calls: 200,
		max_duration_minutes: 30,
		idle_timeout_minutes: 60,
		max_repetitions: 10,
		max_consecutive_errors: 5,
		warning_threshold: 0.75,
		profiles: undefined,
	};
}

function architectSession(sessionID: string) {
	const s = ensureAgentSession(sessionID, 'architect');
	swarmState.activeAgent.set(sessionID, 'architect');
	return s;
}

function assistantMsg(sessionID: string, modelID: string, providerID?: string) {
	return {
		info: {
			role: 'assistant' as const,
			sessionID,
			modelID,
			...(providerID ? { providerID } : {}),
		},
		parts: [{ type: 'text' as const, text: 'ok' }],
	};
}

// Advisories are QUEUED then injected into the message stream (a system message)
// within the same transform call, so assert on the resulting system text.
function systemText(messages: ReturnType<typeof assistantMsg>[]): string {
	return messages
		.filter((m) => m.info?.role === 'system')
		.flatMap((m) => m.parts)
		.filter((p) => p.type === 'text')
		.map((p) => (p as { text: string }).text)
		.join('\n');
}

// ===========================================================================
// 2a — persistence across rehydration
// ===========================================================================

describe('lastObservedModel persistence (#1896)', () => {
	beforeEach(() => resetSwarmState());

	it('round-trips through serialize -> deserialize', () => {
		const s = architectSession('persist-1');
		s.lastObservedModel = 'anthropic/kimi-k3';
		s.lastObservedProviderID = 'anthropic';
		const back = deserializeAgentSession(serializeAgentSession(s));
		expect(back.lastObservedModel).toBe('anthropic/kimi-k3');
		expect(back.lastObservedProviderID).toBe('anthropic');
	});

	it('is NOT a transient-reset field (survives rehydration)', () => {
		// The whole point: the pre-interrupt observation must survive the interrupt.
		const names = TRANSIENT_SESSION_FIELDS.map((f) => f.name);
		expect(names).not.toContain('lastObservedModel');
		expect(names).not.toContain('lastObservedProviderID');
	});
});

// ===========================================================================
// 2b — advisory behavior (via the guardrails messagesTransform handler)
// ===========================================================================

describe('model-divergence advisories (#1896)', () => {
	beforeEach(() => resetSwarmState());

	it('fires a one-shot "MODEL CHANGED ACROSS RESUME" when the model silently changed', async () => {
		const hooks = createGuardrailsHooks(config());
		const s = architectSession('sess-resume');
		s.sessionRehydratedAt = 1; // rehydrated
		s.model_fallback_index = 0; // no swarm fallback in play
		s.lastObservedModel = 'anthropic/old-model';

		const msgs1 = [assistantMsg('sess-resume', 'new-model', 'anthropic')];
		await hooks.messagesTransform({}, { messages: msgs1 });
		expect(systemText(msgs1)).toContain('MODEL CHANGED ACROSS RESUME');
		expect(s.lastObservedModel).toBe('anthropic/new-model');

		// One-shot: even a further model change does not re-fire this resume advisory.
		const msgs2 = [assistantMsg('sess-resume', 'third-model', 'anthropic')];
		await hooks.messagesTransform({}, { messages: msgs2 });
		expect(systemText(msgs2)).not.toContain('MODEL CHANGED ACROSS RESUME');
	});

	it('does NOT fire the resume advisory while a swarm fallback is in play', async () => {
		const hooks = createGuardrailsHooks(config());
		const s = architectSession('sess-fb');
		s.sessionRehydratedAt = 1;
		s.model_fallback_index = 1; // fallback active — swarm-initiated switch, not a UI change
		s.lastObservedModel = 'anthropic/old-model';

		const msgs = [assistantMsg('sess-fb', 'fallback-model', 'anthropic')];
		await hooks.messagesTransform({}, { messages: msgs });
		expect(systemText(msgs)).not.toContain('MODEL CHANGED ACROSS RESUME');
	});

	it('does NOT fire the resume advisory when the model is unchanged', async () => {
		const hooks = createGuardrailsHooks(config());
		const s = architectSession('sess-same');
		s.sessionRehydratedAt = 1;
		s.model_fallback_index = 0;
		s.lastObservedModel = 'anthropic/same-model';

		const msgs = [assistantMsg('sess-same', 'same-model', 'anthropic')];
		await hooks.messagesTransform({}, { messages: msgs });
		expect(systemText(msgs)).not.toContain('MODEL CHANGED ACROSS RESUME');
	});

	it('fires a one-shot "MODEL CONFIG NOTE" when configured architect model != active model', async () => {
		getAgentConfigs({
			agents: { architect: { model: 'kimi-k3' } },
		} as unknown as PluginConfig);
		const hooks = createGuardrailsHooks(config());
		architectSession('sess-cfg');

		const msgs = [assistantMsg('sess-cfg', 'nemotron-3', 'nvidia')];
		await hooks.messagesTransform({}, { messages: msgs });
		expect(systemText(msgs)).toContain('MODEL CONFIG NOTE');
	});

	it('does NOT fire the config note while a fallback is active (avoids reading a mutated model)', async () => {
		getAgentConfigs({
			agents: { architect: { model: 'kimi-k3' } },
		} as unknown as PluginConfig);
		const hooks = createGuardrailsHooks(config());
		const s = architectSession('sess-cfg-fb');
		s.model_fallback_index = 1; // fallback in play — config/observed both unreliable

		const msgs = [assistantMsg('sess-cfg-fb', 'nemotron-3', 'nvidia')];
		await hooks.messagesTransform({}, { messages: msgs });
		expect(systemText(msgs)).not.toContain('MODEL CONFIG NOTE');
	});

	it('does NOT fire divergence advisories on a subagent (non-architect) session', async () => {
		const hooks = createGuardrailsHooks(config());
		const s = ensureAgentSession('sess-coder', 'coder');
		swarmState.activeAgent.set('sess-coder', 'coder');
		s.sessionRehydratedAt = 1;
		s.model_fallback_index = 0;
		s.lastObservedModel = 'anthropic/old-model';

		const msgs = [assistantMsg('sess-coder', 'new-model', 'anthropic')];
		await hooks.messagesTransform({}, { messages: msgs });
		expect(systemText(msgs)).not.toContain('MODEL CHANGED');
		// The subagent session's observation is not tracked for divergence.
		expect(s.lastObservedModel).toBe('anthropic/old-model');
	});
});
