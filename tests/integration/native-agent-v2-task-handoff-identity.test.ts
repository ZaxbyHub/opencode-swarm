/**
 * Issue #3320 AC18 — a v2-seeded native-agent identity must survive the
 * Task-tool completion handoff.
 *
 * On an OpenCode 2 host, the tool-event adapters seed the v1 session state
 * for the event's agent via `seedV1SessionState` (src/host/v2/setup.ts)
 * BEFORE invoking the registered v1 `tool.execute.after`. When the host's
 * native `task` tool completes, the task-handoff block in src/index.ts then
 * unconditionally rewrites the identity:
 *   `swarmState.activeAgent.set(sessionId, ORCHESTRATOR_NAME)` +
 *   `ensureAgentSession(sessionId, ORCHESTRATOR_NAME, bootstrapRoot)`
 * — discarding the v2-seeded native agent identity (e.g. the built-in
 * `plan` agent) in both the active-agent map and the durable session
 * record (`ensureAgentSession` rewrites `agentSessions[s].agentName`).
 *
 * RED at base, GREEN after the fix: immediately after the task-tool
 * tool.execute.after fires, activeAgent reads 'architect' and
 * agentSessions[s3].agentName reads 'architect'.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { ORCHESTRATOR_NAME } from '../../src/config/constants';
import { seedV1SessionState } from '../../src/host/v2/setup';
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
	directory = createPluginHostProject('native-agent-v2-task-3320');
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

describe('v2-seeded native agent identity survives a task-tool completion (#3320 AC18)', () => {
	test('plan identity seeded via seedV1SessionState is preserved across tool.execute.after for the task tool', async () => {
		const sessionID = 'native-v2-task-plan-3320';

		// Mirror the v2 tool-event adapter: seed the v1 session state for
		// the event's native agent before the v1 hook chain runs.
		seedV1SessionState(sessionID, { id: 'plan' } as never, directory);
		expect(swarmState.activeAgent.get(sessionID)).toBe('plan');
		expect(swarmState.agentSessions.get(sessionID)?.agentName).toBe('plan');

		// The host's native task tool completes for this session.
		await booted.hooks['tool.execute.after'](
			{
				tool: 'task',
				sessionID,
				callID: 'task-call-v2-3320',
				args: {
					prompt: 'Summarize the workspace',
					subagent_type: 'explore',
				},
			},
			{ title: 'Task completed', output: 'summary done', metadata: null },
		);

		// RED at base: the task-handoff block rewrote the identity to
		// ORCHESTRATOR_NAME in the active map...
		expect(swarmState.activeAgent.get(sessionID)).toBe('plan');
		// ...and ensureAgentSession rewrote the durable session record too.
		expect(swarmState.agentSessions.get(sessionID)?.agentName).toBe('plan');
		expect(swarmState.activeAgent.get(sessionID)).not.toBe(ORCHESTRATOR_NAME);
	});
});
