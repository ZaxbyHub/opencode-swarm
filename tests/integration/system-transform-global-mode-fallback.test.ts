import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import { cancelDeferredMaintenanceScans } from '../../src/hooks/system-enhancer';
import type { AgentSessionState } from '../../src/state';
import { swarmState } from '../../src/state';
import {
	bootSwarmPluginHost,
	createPluginHostProject,
} from '../helpers/plugin-host';
import { withFrozenClock } from '../helpers/test-clock.js';

/**
 * Sessionless `experimental.chat.system.transform` contract (#3320, AC8).
 *
 * DELIBERATELY UPDATED from the pre-#3320 contract this file used to pin
 * (sessionless calls emitted the TURBO/FULL-AUTO banners and the PLANNING
 * PROFILE producer using another session's global mode state). The issue
 * body's Scope sanctions this replacement explicitly: "its sessionless-
 * emission assertions at :51-85, and the Path-A producer assertion at :87,
 * are replaced; they are not deleted or weakened without replacement."
 * The new contract: a sessionless call (title/summary/agent-generation
 * surfaces) has no request-correlation key and no delivery owner, so it
 * appends NO swarm-specific system text of any kind. The new-contract
 * journey is also pinned by the frozen
 * tests/integration/system-transform-sessionless-no-swarm-text.test.ts.
 */
describe('registered system.transform global mode fallback', () => {
	let directory: string;
	let host: Awaited<ReturnType<typeof bootSwarmPluginHost>>;

	beforeAll(async () => {
		directory = createPluginHostProject('system-transform-global-mode');
		host = await bootSwarmPluginHost(directory, {
			knowledge: { enabled: false, hive_enabled: false },
			memory: { enabled: false },
			hooks: { delegation_gate: false, system_enhancer: true },
			context_budget: { scoring: { enabled: false } },
		});
	});

	afterAll(() => {
		cancelDeferredMaintenanceScans(directory);
		try {
			fs.rmSync(directory, { recursive: true, force: true });
		} catch {
			// SQLite handles may remain open briefly on Windows; best effort only.
		}
	});

	it('emits no swarm text sessionless even when another session has Turbo active', async () => {
		const otherSessionId = `global-turbo-${withFrozenClock(() => Date.now())}`;
		swarmState.agentSessions.set(otherSessionId, {
			turboMode: true,
			fullAutoMode: false,
		} as AgentSessionState);
		const output = { system: ['base system seed'] };
		try {
			await host.hooks['experimental.chat.system.transform']({}, output);
			// #3320: the sessionless call must leave the system surface
			// byte-untouched — no banner borrowed from another session's mode.
			expect(output.system).toEqual(['base system seed']);
			expect(output.system.join('\n')).not.toContain('## 🚀 TURBO MODE ACTIVE');
			expect(output.system.join('\n')).not.toContain(
				'## ⚡ FULL-AUTO MODE ACTIVE',
			);
		} finally {
			swarmState.agentSessions.delete(otherSessionId);
		}
	});

	it('emits no swarm text sessionless even when another session has Full-Auto active', async () => {
		const otherSessionId = `global-full-auto-${withFrozenClock(() => Date.now())}`;
		swarmState.agentSessions.set(otherSessionId, {
			turboMode: false,
			fullAutoMode: true,
		} as AgentSessionState);
		const output = { system: ['base system seed'] };
		try {
			await host.hooks['experimental.chat.system.transform']({}, output);
			expect(output.system).toEqual(['base system seed']);
			expect(output.system.join('\n')).not.toContain(
				'## ⚡ FULL-AUTO MODE ACTIVE',
			);
			expect(output.system.join('\n')).not.toContain('## 🚀 TURBO MODE ACTIVE');
		} finally {
			swarmState.agentSessions.delete(otherSessionId);
		}
	});

	it('runs no Path-A producer and appends nothing sessionless regardless of model shape', async () => {
		const baseHeader = 'base system seed';
		const producerMarker = '[PLANNING PROFILE — CURRENT RUNTIME AUTHORITY]';
		const modelShapes = [
			{
				model: {
					id: 'qwen3.6-32b',
					providerID: 'vllm-local',
					api: {
						id: 'openai-compatible',
						url: 'http://127.0.0.1:8000/v1',
						npm: '@ai-sdk/openai-compatible',
					},
				},
			},
			{
				model: {
					id: 'gemma-3-4b',
					providerID: 'ollama-local',
					api: {
						id: 'openai-compatible',
						url: 'http://127.0.0.1:11434/v1',
						npm: '@ai-sdk/openai-compatible',
					},
				},
			},
			{
				model: {
					id: 'claude-sonnet-4-6',
					providerID: 'anthropic',
					api: {
						id: 'anthropic',
						url: 'https://api.anthropic.com/v1',
						npm: '@ai-sdk/anthropic',
					},
				},
			},
		];
		for (const input of modelShapes) {
			const output = { system: [baseHeader] };
			await host.hooks['experimental.chat.system.transform'](input, output);
			// #3320: no producer output, no strict-vs-cache-capable divergence —
			// the sessionless path returns before any model-dependent producer.
			expect(output.system).toEqual([baseHeader]);
			expect(output.system.join('\n')).not.toContain(producerMarker);
		}
	});
});
