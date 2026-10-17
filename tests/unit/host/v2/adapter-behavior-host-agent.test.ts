/**
 * Host-provided agent handling on tool hooks (PR #3378 review follow-up).
 *
 * Pins: seeding from input.agent on an unseeded before-hook, the v1-shape
 * (no input.agent) stale-delegation revert staying intact, hook-level agent
 * trimming via readHostAgent with normalizeV2AgentRef returning host names
 * verbatim (no identity widening), the Task after-hook restore fallback chain,
 * and non-string agent values never throwing. Boots the real plugin under an isolated
 * global-config env (createIsolatedTestEnv) and drives its tool hooks.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { normalizeV2AgentRef } from '../../../../src/host/v2/setup';
import {
	ensureAgentSession,
	getActiveWindow,
	resetSwarmState,
	swarmState,
} from '../../../../src/state';
import { createIsolatedTestEnv } from '../../../helpers/isolated-test-env';
import { canonicalMkdtemp } from '../../../helpers/tmpdir';

type BeforeHook = (
	input: Record<string, unknown>,
	output: { args: Record<string, unknown> },
) => Promise<void>;
type AfterHook = (
	input: Record<string, unknown>,
	output: Record<string, unknown>,
) => Promise<void>;

let isolatedEnv: ReturnType<typeof createIsolatedTestEnv>;

beforeEach(() => {
	isolatedEnv = createIsolatedTestEnv();
});

afterEach(() => {
	resetSwarmState();
	isolatedEnv.cleanup();
});

async function bootPlugin(prefix: string) {
	const OpenCodeSwarm = (await import('../../../../src/index')).default;
	const directory = canonicalMkdtemp(prefix);
	// A project marker stops the plugin's project-root resolution from walking up
	// into an ancestor (e.g. the developer's home) and writing runtime state there.
	mkdirSync(path.join(directory, '.opencode'), { recursive: true });
	const plugin = await OpenCodeSwarm.server({
		directory,
		worktree: directory,
	} as never);
	return { plugin, directory };
}

function readCall(sessionID: string, extra: Record<string, unknown> = {}) {
	return {
		tool: 'read',
		sessionID,
		callID: `call-${sessionID}`,
		...extra,
	};
}

const READ_OUTPUT = () => ({ args: { filePath: 'README.md' } });

const TASK_OUTPUT = () => ({
	title: 'task',
	output:
		'<task id="child-1" state="completed"><task_result>done</task_result></task>',
	metadata: {},
});

describe('tool.execute.before host-provided agent', () => {
	test('unseeded call with agent seeds activeAgent, session and window from it', async () => {
		const { plugin } = await bootPlugin('swarm-v2-unseeded-');
		const sessionID = 'unseeded-session';
		expect(swarmState.activeAgent.has(sessionID)).toBe(false);

		const beforeHook = plugin['tool.execute.before'] as BeforeHook;
		await beforeHook(readCall(sessionID, { agent: 'coder' }), READ_OUTPUT());

		expect(swarmState.activeAgent.get(sessionID)).toBe('coder');
		expect(swarmState.agentSessions.get(sessionID)?.agentName).toBe('coder');
		expect(getActiveWindow(sessionID)?.agentName).toBe('coder');
	});

	test('v1 shape (no input.agent) still reverts a stale delegation to architect', async () => {
		const { plugin, directory } = await bootPlugin('swarm-v2-v1shape-');
		const sessionID = 'v1-shape-session';
		const session = ensureAgentSession(sessionID, 'coder', directory);
		session.delegationActive = false;
		session.lastAgentEventTime = 1_000;
		swarmState.activeAgent.set(sessionID, 'coder');

		const beforeHook = plugin['tool.execute.before'] as BeforeHook;
		await beforeHook(readCall(sessionID), READ_OUTPUT());

		expect(swarmState.agentSessions.get(sessionID)?.agentName).toBe(
			'architect',
		);
		expect(swarmState.activeAgent.get(sessionID)).toBe('architect');
	});

	test.each([
		['number', 42],
		['object', {}],
		['array', ['coder']],
	])('non-string agent (%s) does not throw and seeds architect', async (_label, agent) => {
		const { plugin } = await bootPlugin('swarm-v2-nonstring-before-');
		const sessionID = `nonstring-before-${_label}`;

		const beforeHook = plugin['tool.execute.before'] as BeforeHook;
		await beforeHook(readCall(sessionID, { agent }), READ_OUTPUT());

		expect(swarmState.activeAgent.get(sessionID)).toBe('architect');
	});
	test('whitespace-only agent is treated as no host agent and seeds architect', async () => {
		const { plugin } = await bootPlugin('swarm-v2-whitespace-before-');
		const sessionID = 'whitespace-before-session';

		const beforeHook = plugin['tool.execute.before'] as BeforeHook;
		await beforeHook(readCall(sessionID, { agent: '   ' }), READ_OUTPUT());

		expect(swarmState.activeAgent.get(sessionID)).toBe('architect');
	});
	test.each([
		['unknown placeholder', 'unknown'],
		['padded UNKNOWN placeholder', ' UNKNOWN '],
		['housekeeping compaction', 'compaction'],
		['housekeeping explore', 'explore'],
	])('host agent %s is not an identity and seeds architect', async (_label, agent) => {
		const { plugin } = await bootPlugin('swarm-v2-placeholder-before-');
		const sessionID = `placeholder-before-${_label.replaceAll(' ', '-')}`;

		const beforeHook = plugin['tool.execute.before'] as BeforeHook;
		await beforeHook(readCall(sessionID, { agent }), READ_OUTPUT());

		expect(swarmState.activeAgent.get(sessionID)).toBe('architect');
	});
	test.each([
		['no host agent', undefined, 'architect'],
		['host agent coder', 'coder', 'coder'],
	])('an existing unknown placeholder entry is treated as unmapped (%s)', async (_label, agent, expected) => {
		const { plugin, directory } = await bootPlugin('swarm-v2-unknown-entry-');
		const sessionID = `unknown-entry-${_label.replaceAll(' ', '-')}`;
		ensureAgentSession(sessionID, 'unknown', directory);
		swarmState.activeAgent.set(sessionID, 'unknown');

		const beforeHook = plugin['tool.execute.before'] as BeforeHook;
		await beforeHook(
			readCall(sessionID, agent === undefined ? {} : { agent }),
			READ_OUTPUT(),
		);

		expect(swarmState.activeAgent.get(sessionID)).toBe(expected);
	});
});

describe('normalizeV2AgentRef does not widen identity', () => {
	test('returns host names verbatim: a padded name is NOT normalized to an architect-capable name', () => {
		// tools.ts passes normalizeV2AgentRef(context.agent) to architect-only tools
		// (`?? 'architect'`). Trimming here would let a padded ' architect ' name
		// resolve to the architect, so the source keeps the raw value and only the
		// hook-level readHostAgent trims (for the stale-revert gate / Task restore).
		expect(normalizeV2AgentRef(' architect ')).toBe(' architect ');
		expect(normalizeV2AgentRef({ id: ' architect ' })).toBe(' architect ');
		expect(normalizeV2AgentRef({ name: ' y ' })).toBe(' y ');
		expect(normalizeV2AgentRef('mega_coder')).toBe('mega_coder');
	});

	test('empty and whitespace-only strings stay as-is (never undefined)', () => {
		// undefined would let tools.ts default the caller to the architect.
		expect(normalizeV2AgentRef('')).toBe('');
		expect(normalizeV2AgentRef('   ')).toBe('   ');
		expect(normalizeV2AgentRef({ id: '  ' })).toBe('  ');
	});

	test('unusable references yield undefined', () => {
		expect(normalizeV2AgentRef({})).toBeUndefined();
		expect(normalizeV2AgentRef({ id: '', name: '' })).toBeUndefined();
		expect(normalizeV2AgentRef(42)).toBeUndefined();
		expect(normalizeV2AgentRef(null)).toBeUndefined();
		expect(normalizeV2AgentRef(undefined)).toBeUndefined();
	});
});

describe('tool.execute.after Task handoff restore', () => {
	async function runTaskAfter(agent: unknown, label: string) {
		const { plugin, directory } = await bootPlugin('swarm-v2-task-after-');
		const sessionID = `task-after-${label}`;
		const session = ensureAgentSession(sessionID, 'conductor', directory);
		session.delegationActive = true;
		swarmState.activeAgent.set(sessionID, 'conductor');

		const afterHook = plugin['tool.execute.after'] as AfterHook;
		await afterHook(
			{
				tool: 'task',
				sessionID,
				callID: `task-call-${label}`,
				...(agent === undefined ? {} : { agent }),
				args: { subagent_type: 'coder' },
			},
			TASK_OUTPUT(),
		);
		return sessionID;
	}

	test('missing agent falls back to the orchestrator (architect)', async () => {
		const sessionID = await runTaskAfter(undefined, 'missing');
		expect(swarmState.activeAgent.get(sessionID)).toBe('architect');
		expect(swarmState.agentSessions.get(sessionID)?.agentName).toBe(
			'architect',
		);
	});

	test('custom orchestrator agent is preserved', async () => {
		const sessionID = await runTaskAfter('conductor', 'custom');
		expect(swarmState.activeAgent.get(sessionID)).toBe('conductor');
		expect(swarmState.agentSessions.get(sessionID)?.agentName).toBe(
			'conductor',
		);
		expect(swarmState.agentSessions.get(sessionID)?.delegationActive).toBe(
			false,
		);
	});

	test('padded custom orchestrator name is trimmed on restore', async () => {
		const sessionID = await runTaskAfter('  conductor  ', 'padded');
		expect(swarmState.activeAgent.get(sessionID)).toBe('conductor');
		expect(swarmState.agentSessions.get(sessionID)?.agentName).toBe(
			'conductor',
		);
	});

	test.each([
		['unknown', 'unknown'],
		['compaction', 'compaction'],
	])('host-sent %s agent never becomes the handoff owner', async (label, agent) => {
		const sessionID = await runTaskAfter(agent, `placeholder-${label}`);
		expect(swarmState.activeAgent.get(sessionID)).toBe('architect');
		expect(swarmState.agentSessions.get(sessionID)?.agentName).toBe(
			'architect',
		);
	});

	test('non-string agent does not throw and falls back to architect', async () => {
		const sessionID = await runTaskAfter(42, 'nonstring');
		expect(swarmState.activeAgent.get(sessionID)).toBe('architect');
		expect(swarmState.agentSessions.get(sessionID)?.agentName).toBe(
			'architect',
		);
	});
});
