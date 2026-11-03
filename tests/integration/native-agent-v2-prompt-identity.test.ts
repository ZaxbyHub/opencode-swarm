/**
 * Issue #3320 AC6 — the v2 prompt adapter must not rewrite a native
 * plan session's identity to architect (registered-host journey).
 *
 * The defect: `onV2Prompt` (src/host/v2/hooks.ts) calls the v1
 * `chat.message` chain with an input that has NO agent field. The
 * delegation-tracker's no-agent branch (src/hooks/delegation-tracker.ts:47)
 * interprets that as "the architect is taking over on a new turn" and
 * rewrites the session identity:
 *   - `swarmState.activeAgent[sessionID]` -> 'architect',
 *   - `agentSessions[sessionID].agentName` -> 'architect' (ensureAgentSession
 *     rewrite), and
 *   - `beginInvocation(sessionID, 'architect')` — the architect branch, which
 *     returns no budget window.
 * Consequences observable through the registered hooks:
 *   - the session's plan identity is lost ('architect' instead of 'plan'),
 *   - a write of app.config.toml through the registered `tool.execute.before`
 *     throws `WRITE BLOCKED: Agent "architect" ...` (architect authority
 *     rules block the config zone), and
 *   - the resolved invocation identity is architect, not the seeded plan
 *     agent (getActiveWindow resolves the plan window only while the session
 *     identity stays 'plan').
 *
 * RED at base, GREEN after the fix.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { registerV2SessionHooks } from '../../src/host/v2/hooks';
import type { V2SessionPromptEvent } from '../../src/host/v2/types';
import { getActiveWindow, resetSwarmState, swarmState } from '../../src/state';
import { createIsolatedTestEnv } from '../helpers/isolated-test-env';
import {
	type BootedPluginHost,
	bootSwarmPluginHost,
	createPluginHostProject,
} from '../helpers/plugin-host';
import { removeTreeWithRetry } from '../helpers/tmpdir';

/** Minimal v2 session-domain capture client (adapter-behavior pattern). */
function sessionHookCapture() {
	const calls: Array<{ name: string; cb: (event: never) => unknown }> = [];
	return {
		calls,
		session: {
			hook: async (name: string, cb: (event: never) => unknown) => {
				calls.push({ name, cb });
				return { dispose: async () => {} };
			},
		},
	};
}

const isolated = createIsolatedTestEnv();
const directory = createPluginHostProject('native-agent-v2-prompt-');
let booted: BootedPluginHost | undefined;

afterAll(() => {
	try {
		resetSwarmState();
	} catch {
		// Advisory process state — cleanup must not fail the suite.
	}
	try {
		removeTreeWithRetry(directory);
	} finally {
		isolated.cleanup();
	}
});

describe('issue #3320 AC6 — v2 prompt path preserves the native plan identity', () => {
	test('RED at base, GREEN after the fix — driving the v2 prompt keeps activeAgent "plan", allows the app.config.toml write, and opens no architect invocation', async () => {
		booted ??= await bootSwarmPluginHost(directory, { version_check: false });
		const sessionID = 'v2-prompt-plan-session';

		// 1. Establish the session's last-known agent as the native `plan`
		//    agent through the registered chat.message hook (the host surface
		//    that normally carries the agent identity).
		await booted.hooks['chat.message'](
			{ sessionID, agent: 'plan' },
			{ message: { role: 'user' }, parts: [] },
		);
		expect(swarmState.activeAgent.get(sessionID)).toBe('plan');

		// 2. Drive the v2 prompt path exactly as a v2 host would: register the
		//    session hooks against the registered v1 chain, then fire the
		//    `prompt` callback. The SessionPrompt event carries NO agent field.
		const capture = sessionHookCapture();
		await registerV2SessionHooks(
			capture as never,
			booted.hooks as never,
			'.',
			[],
		);
		const promptHook = capture.calls.find((call) => call.name === 'prompt');
		expect(typeof promptHook?.cb).toBe('function');
		await promptHook?.cb({
			sessionID,
			messageID: 'm1',
			prompt: { text: 'do it' },
		} as never as V2SessionPromptEvent);

		// 3a. The session identity survives the v2 prompt boundary.
		//    Base defect: the delegation-tracker no-agent branch rewrote the
		//    identity to architect.
		expect(swarmState.activeAgent.get(sessionID)).toBe('plan');

		// 3b. The resolved invocation identity is the plan agent, not an
		//     architect invocation (beginInvocation returns no window for the
		//     architect, so an architect rewrite leaves getActiveWindow
		//     undefined and drops the plan:1 budget window).
		expect(swarmState.agentSessions.get(sessionID)?.agentName).toBe('plan');
		expect(getActiveWindow(sessionID)?.agentName).toBe('plan');

		// 3c. A config-zone write through the registered tool.execute.before
		//     does NOT throw. Base defect: the rewritten architect identity
		//     hits the architect authority rules (config zone) and the hook
		//     rejects with `WRITE BLOCKED: Agent "architect" is not authorised
		//     to write it`; the plan agent's native pass-through
		//     rules allow it.
		let writeError: unknown;
		try {
			await booted.hooks['tool.execute.before'](
				{ tool: 'write', sessionID, callID: 'call-biome-write' },
				{ args: { path: 'app.config.toml', content: '' } },
			);
		} catch (error) {
			writeError = error;
		}
		expect(writeError).toBeUndefined();
	});
});
