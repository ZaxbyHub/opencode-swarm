/**
 * Issue #3320 AC1 — native-agent identity must survive a Task-tool completion.
 *
 * The swarm plugin rewrites a native-agent session's identity to the swarm
 * orchestrator ('architect') whenever the host's native `task` tool completes
 * (src/index.ts `tool.execute.after` task-handoff block unconditionally does
 * `swarmState.activeAgent.set(sessionId, ORCHESTRATOR_NAME)` +
 * `ensureAgentSession(sessionId, ORCHESTRATOR_NAME, ...)`).
 *
 * Opencode native built-in agents (`build`, `plan`) carry NO swarm write
 * restrictions in DEFAULT_AGENT_AUTHORITY_RULES, while the rewritten
 * 'architect' identity blocks the config zone — so the identity rewrite also
 * breaks writes to ordinary config files (package.json) and injects the
 * architect PLANNING PROFILE guidance into the native agent's turns.
 *
 * These tests are RED at base and GREEN after the fix:
 * at base, after the Task tool completes, activeAgent reads 'architect',
 * agentSessions[s].agentName reads 'architect', the package.json write
 * rejects with `WRITE BLOCKED: Agent "architect" is not authorised to write`,
 * and the messages transform injects PLANNING PROFILE directives.
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
	directory = createPluginHostProject('native-agent-task-handoff-3320');
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

interface PartsMessage {
	info: { id: string; role: string; sessionID?: string; agent?: string };
	parts: Array<{ type: string; text?: string }>;
}

function joinedMessageText(messages: PartsMessage[]): string {
	return messages
		.flatMap((message) => message.parts ?? [])
		.filter((part) => part.type === 'text' && typeof part.text === 'string')
		.map((part) => part.text as string)
		.join('\n');
}

async function runTaskHandoffScenario(agent: string): Promise<void> {
	const sessionID = `native-task-handoff-${agent}-3320`;

	// Control (passes at base): chat.message seeds the native identity.
	await booted.hooks['chat.message'](
		{ sessionID, agent, message: { id: 'm1', role: 'user' } },
		{},
	);
	expect(swarmState.activeAgent.get(sessionID)).toBe(agent);

	// The host's native task tool completes for this session.
	await booted.hooks['tool.execute.after'](
		{
			tool: 'task',
			sessionID,
			callID: `task-call-${agent}-3320`,
			args: {
				prompt: `Summarize the workspace as ${agent}`,
				subagent_type: 'explore',
			},
		},
		{ title: 'Task completed', output: 'summary done', metadata: null },
	);

	// RED at base: identity was rewritten to ORCHESTRATOR_NAME.
	expect(swarmState.activeAgent.get(sessionID)).toBe(agent);
	// RED at base: ensureAgentSession rewrote the durable agentName too.
	expect(swarmState.agentSessions.get(sessionID)?.agentName).toBe(agent);
	// Guard against the value silently becoming architect post-fix.
	expect(swarmState.activeAgent.get(sessionID)).not.toBe(ORCHESTRATOR_NAME);

	// RED at base: the write rejects because the rewritten 'architect'
	// identity blocks the config zone (package.json).
	await booted.hooks['tool.execute.before'](
		{ tool: 'write', sessionID, callID: `write-call-${agent}-3320` },
		{ args: { filePath: 'package.json', content: '{}' } },
	);

	// RED at base: with activeAgent='architect', the messages transform
	// injects the architect-session guidance (PLANNING PROFILE directives).
	const messages: PartsMessage[] = [
		{
			info: { id: `msg-${agent}-3320`, role: 'user', sessionID, agent },
			parts: [{ type: 'text', text: 'hi' }],
		},
	];
	await booted.hooks['experimental.chat.messages.transform']({}, { messages });
	const transformedText = joinedMessageText(messages);
	expect(transformedText).not.toContain('PLANNING PROFILE');
	expect(transformedText).not.toContain(
		'You must NEVER run the full test suite',
	);
}

describe('native agent identity survives Task tool completion (#3320 AC1)', () => {
	test('build identity is preserved across a task-tool handoff', async () => {
		await runTaskHandoffScenario('build');
	});

	test('plan identity is preserved across a task-tool handoff', async () => {
		await runTaskHandoffScenario('plan');
	});
});
