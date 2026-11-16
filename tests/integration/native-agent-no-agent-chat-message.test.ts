/**
 * Issue #3320 AC17 — an agent-less chat.message must not rewrite a
 * native-agent session's identity to the swarm orchestrator.
 *
 * `src/hooks/delegation-tracker.ts` treats a chat.message with no/empty
 * agent as "the architect is taking over on a new turn" and hard-codes
 * `swarmState.activeAgent.set(sessionID, ORCHESTRATOR_NAME)` +
 * `ensureAgentSession(sessionID, ORCHESTRATOR_NAME, ...)`. On a native
 * OpenCode agent session (e.g. the built-in `plan` agent), a subsequent
 * user turn that carries no agent field therefore silently converts the
 * session into an 'architect' session — which then blocks writes to
 * ordinary config files (app.config.toml lives in the architect-blocked config
 * zone, while native agents carry no swarm write restrictions).
 *
 * This test is RED at base and GREEN after the fix: at base, after the
 * agent-less chat.message, activeAgent reads 'architect' and the app.config.toml
 * write rejects with `WRITE BLOCKED: Agent "architect" is not authorised to
 * write`.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { ORCHESTRATOR_NAME } from '../../src/config/constants';
import { resetSwarmState, swarmState } from '../../src/state';
import { createIsolatedTestEnv } from '../helpers/isolated-test-env';
import {
	type BootedPluginHost,
	bootSwarmPluginHost,
	createPluginHostProject,
} from '../helpers/plugin-host';

let directory: string;
let booted: BootedPluginHost;
let isolatedEnv: ReturnType<typeof createIsolatedTestEnv>;

beforeAll(async () => {
	isolatedEnv = createIsolatedTestEnv();
	directory = createPluginHostProject('native-agent-no-agent-chat-3320');
	booted = await bootSwarmPluginHost(directory, {
		version_check: false,
		knowledge: { enabled: false, hive_enabled: false },
		memory: { enabled: false },
		hooks: { delegation_gate: false },
	});
});

afterAll(() => {
	try {
		resetSwarmState();
		rmSync(directory, {
			recursive: true,
			force: true,
			maxRetries: 5,
			retryDelay: 100,
		});
	} catch {
		// Windows EBUSY from lingering handles — best effort only.
	} finally {
		isolatedEnv.cleanup();
	}
});

describe('native agent identity survives an agent-less chat.message (#3320 AC17)', () => {
	test('plan identity is preserved when a later chat.message carries no agent', async () => {
		const sessionID = 'native-no-agent-chat-plan-3320';

		// Control (passes at base): chat.message with the native agent name.
		await booted.hooks['chat.message'](
			{ sessionID, agent: 'plan', message: { id: 'm1', role: 'user' } },
			{},
		);
		expect(swarmState.activeAgent.get(sessionID)).toBe('plan');

		// A later user turn with NO agent field. RED at base: the delegation
		// tracker hard-codes ORCHESTRATOR_NAME for agent-less messages.
		await booted.hooks['chat.message'](
			{ sessionID, message: { id: 'm2', role: 'user' } },
			{},
		);
		expect(swarmState.activeAgent.get(sessionID)).toBe('plan');
		expect(swarmState.agentSessions.get(sessionID)?.agentName).toBe('plan');
		expect(swarmState.activeAgent.get(sessionID)).not.toBe(ORCHESTRATOR_NAME);

		// RED at base: the write rejects because the rewritten 'architect'
		// identity blocks the config zone. #3120 moved biome.json under the
		// verifier-config deny for EVERY role, so the identity probe uses a
		// config-zone file OUTSIDE the verifier glob set: a preserved native
		// plan identity may still write it, a flipped architect may not.
		await booted.hooks['tool.execute.before'](
			{ tool: 'write', sessionID, callID: 'write-biome-3320' },
			{ args: { filePath: 'app.config.toml', content: '' } },
		);
	});
});
