import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { _resetDelegationTelemetryPairingForTesting } from '../../src/index';
import {
	ensureAgentSession,
	resetSwarmState,
	swarmState,
} from '../../src/state';
import {
	addTelemetryListener,
	resetTelemetryForTesting,
	type TelemetryEvent,
} from '../../src/telemetry';
import {
	bootKnowledgeHost,
	createKnowledgeProject,
} from '../helpers/knowledge-real-host';
import { safeRmRecursive } from '../helpers/safe-test-dir';

type CapturedEvent = {
	event: TelemetryEvent | 'delegation_cost_correction';
	data: Record<string, unknown>;
};

const SESSION_ID = 'delegation-pairing-parent';

describe('Task delegation telemetry — regression: delegation_begin unreachable with guardrails disabled (begin/end asymmetry)', () => {
	let directory = '';
	let events: CapturedEvent[] = [];

	beforeEach(() => {
		resetSwarmState();
		resetTelemetryForTesting();
		_resetDelegationTelemetryPairingForTesting();
		directory = createKnowledgeProject();
		events = [];
	});

	afterEach(() => {
		// resetTelemetryForTesting clears the listener registered in boot().
		resetTelemetryForTesting();
		resetSwarmState();
		_resetDelegationTelemetryPairingForTesting();
		safeRmRecursive(directory);
	});

	async function boot(configOverrides: Record<string, unknown>) {
		const plugin = await bootKnowledgeHost(directory, configOverrides);
		addTelemetryListener((event, data) => {
			events.push({ event, data });
		});
		const session = ensureAgentSession(SESSION_ID, 'architect', directory);
		session.currentTaskId = '1.1';
		swarmState.activeAgent.set(SESSION_ID, 'architect');
		return plugin;
	}

	async function dispatchTask(
		plugin: {
			hooks: Record<string, (...args: unknown[]) => Promise<unknown>>;
		},
		callID: string,
		subagentType = 'explorer',
	) {
		await plugin.hooks['tool.execute.before'](
			{ tool: 'task', sessionID: SESSION_ID, callID },
			{
				args: {
					description: 'explore',
					prompt: 'Explore the codebase and report findings.',
					subagent_type: subagentType,
				},
			},
		);
		await plugin.hooks['tool.execute.after'](
			{ tool: 'task', sessionID: SESSION_ID, callID },
			{ state: 'completed', output: 'exploration done' },
		);
	}

	function begins(): CapturedEvent[] {
		return events.filter((e) => e.event === 'delegation_begin');
	}

	function ends(): CapturedEvent[] {
		return events.filter((e) => e.event === 'delegation_end');
	}

	test('a delegation emits BOTH delegation_begin and delegation_end when guardrails are disabled (production config)', async () => {
		// Regression: disabled guardrails must not make delegation_begin unreachable.
		const plugin = await boot({ guardrails: { enabled: false } });
		await dispatchTask(plugin, 'pairing-call-both-events');

		expect(begins()).toHaveLength(1);
		expect(ends()).toHaveLength(1);
	});

	test('late exact-child usage upgrades unavailable to estimated to reported', async () => {
		const plugin = await boot({
			guardrails: { enabled: false },
			pricing: {
				reported_cost_currency: { provider: 'USD' },
				models: {
					'provider/model': { input_per_million: 0.1, output_per_million: 0 },
				},
			},
		});
		await plugin.hooks['tool.execute.before'](
			{
				tool: 'task',
				sessionID: SESSION_ID,
				callID: 'late-cost-correction',
			},
			{
				args: {
					description: 'explore',
					prompt: 'Explore and report.',
					subagent_type: 'explorer',
				},
			},
		);
		await plugin.hooks['tool.execute.after'](
			{
				tool: 'task',
				sessionID: SESSION_ID,
				callID: 'late-cost-correction',
			},
			{
				state: 'completed',
				metadata: { sessionID: 'late-cost-child' },
				output: 'done',
			},
		);
		await plugin.hooks.event({
			event: {
				type: 'message.updated',
				properties: {
					info: {
						role: 'assistant',
						sessionID: 'late-cost-child',
						providerID: 'provider',
						modelID: 'model',
						tokens: { input: 1_000_000, output: 0 },
					},
				},
			},
		});
		await plugin.hooks.event({
			event: {
				type: 'message.updated',
				properties: {
					info: {
						role: 'assistant',
						sessionID: 'late-cost-child',
						providerID: 'provider',
						modelID: 'model',
						cost: 0.25,
						tokens: { input: 1_000_000, output: 5 },
					},
				},
			},
		});

		const initial = ends().at(-1)?.data;
		const corrections = events.filter(
			(event) => event.event === 'delegation_cost_correction',
		);
		expect(initial?.record_id).toBeString();
		expect(initial?.cost_source).toBe('unavailable');
		expect(corrections).toHaveLength(2);
		expect(corrections[0]?.data.record_id).toBe(initial?.record_id);
		expect(corrections.map((event) => event.data.version)).toEqual([2, 3]);
		expect(corrections.map((event) => event.data.cost_source)).toEqual([
			'estimated',
			'reported',
		]);
		expect(corrections[1]?.data.cost_usd).toBe(0.25);
	});

	test('restart recovery binds exactly one unresolved delegation before correcting it', async () => {
		const plugin = await bootKnowledgeHost(
			directory,
			{
				guardrails: { enabled: false },
				pricing: {
					reported_cost_currency: { provider: 'USD' },
					models: {
						'provider/model': { input_per_million: 0.1, output_per_million: 0 },
					},
				},
			},
			{
				session: {
					get: async () => ({ data: { parentID: SESSION_ID } }),
				},
			},
		);
		addTelemetryListener((event, data) => events.push({ event, data }));
		const session = ensureAgentSession(SESSION_ID, 'architect', directory);
		session.currentTaskId = '1.1';
		swarmState.activeAgent.set(SESSION_ID, 'architect');

		await plugin.hooks['tool.execute.before'](
			{ tool: 'task', sessionID: SESSION_ID, callID: 'restart-cost' },
			{
				args: {
					description: 'explore',
					prompt: 'Explore and report.',
					subagent_type: 'explorer',
				},
			},
		);
		await plugin.hooks['tool.execute.after'](
			{ tool: 'task', sessionID: SESSION_ID, callID: 'restart-cost' },
			{
				state: 'completed',
				metadata: { sessionID: 'restart-cost-child' },
				output: 'done',
			},
		);
		await plugin.hooks.event({
			event: {
				type: 'message.updated',
				properties: {
					info: {
						role: 'assistant',
						sessionID: 'restart-cost-child',
						providerID: 'provider',
						modelID: 'model',
						tokens: { input: 1_000_000, output: 0 },
					},
				},
			},
		});

		const telemetryPath = path.join(directory, '.swarm', 'telemetry.jsonl');
		for (let attempt = 0; attempt < 50; attempt++) {
			if (
				existsSync(telemetryPath) &&
				readFileSync(telemetryPath, 'utf8').includes(
					'delegation_cost_correction',
				)
			)
				break;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		_resetDelegationTelemetryPairingForTesting();
		await plugin.hooks.event({
			event: {
				type: 'message.updated',
				properties: {
					info: {
						role: 'assistant',
						sessionID: 'restart-cost-child',
						providerID: 'provider',
						modelID: 'model',
						cost: 0.5,
						tokens: { input: 1_000_000, output: 10 },
					},
				},
			},
		});

		expect(
			events.filter((event) => event.event === 'delegation_cost_binding'),
		).toHaveLength(1);
		const corrections = events.filter(
			(event) => event.event === 'delegation_cost_correction',
		);
		expect(corrections.map((event) => event.data.version)).toEqual([2, 3]);
		expect(corrections.at(-1)?.data.cost_source).toBe('reported');
		expect(
			events.filter((event) => event.event === 'delegation_cost_join'),
		).toHaveLength(0);
	});

	test('begin/end pair carries identical sessionId, agentName, and taskId, with begin observed first', async () => {
		// Regression: begin/end must use one parent-side delegation identity.
		const plugin = await boot({ guardrails: { enabled: false } });
		await dispatchTask(plugin, 'pairing-call-identity');

		const begin = begins()[0];
		const end = ends()[0];
		expect(begin?.data.sessionId).toBe(SESSION_ID);
		expect(end?.data.sessionId).toBe(SESSION_ID);
		expect(begin?.data.agentName).toBe('explorer');
		expect(end?.data.agentName).toBe('explorer');
		expect(begin?.data.taskId).toBe('1.1');
		expect(end?.data.taskId).toBe('1.1');
		expect(
			events.findIndex((e) => e.event === 'delegation_begin'),
		).toBeLessThan(events.findIndex((e) => e.event === 'delegation_end'));
	});

	test('default config (guardrails enabled) emits the pair exactly once — no double begin from guardrails bookkeeping', async () => {
		// Guards the removal side of the fix: beginInvocation no longer emits
		// delegation_begin, so an enabled-guardrails session must not produce a
		// second (unpaired, child-identity) begin event for the same delegation.
		const plugin = await boot({});
		await dispatchTask(plugin, 'pairing-call-default-config');

		expect(begins()).toHaveLength(1);
		expect(ends()).toHaveLength(1);
	});

	test('interleaved delegations with distinct callIDs each produce a correctly-paired begin/end', async () => {
		// Two Task calls in flight at once: begin A, begin B, end B, end A.
		// Pairing is keyed by callID, so each end must carry ITS OWN begin's
		// agentName — not the most recent begin's.
		const plugin = await boot({ guardrails: { enabled: false } });
		const before = plugin.hooks['tool.execute.before'];
		const after = plugin.hooks['tool.execute.after'];
		const taskArgs = (subagentType: string) => ({
			args: {
				description: 'work',
				prompt: 'Do the delegated work and report back.',
				subagent_type: subagentType,
			},
		});
		await before(
			{ tool: 'task', sessionID: SESSION_ID, callID: 'interleave-a' },
			taskArgs('explorer'),
		);
		await before(
			{ tool: 'task', sessionID: SESSION_ID, callID: 'interleave-b' },
			taskArgs('sme'),
		);
		await after(
			{ tool: 'task', sessionID: SESSION_ID, callID: 'interleave-b' },
			{ state: 'completed', output: 'done b' },
		);
		await after(
			{ tool: 'task', sessionID: SESSION_ID, callID: 'interleave-a' },
			{ state: 'completed', output: 'done a' },
		);

		expect(begins().map((e) => e.data.agentName)).toEqual(['explorer', 'sme']);
		expect(ends().map((e) => e.data.agentName)).toEqual(['sme', 'explorer']);
	});

	test('pipeline continuation advisory fires from the begin-side identity, not activeAgent', async () => {
		// Handoff advisories use the begin-recorded subagent identity.
		const plugin = await boot({ guardrails: { enabled: false } });
		await dispatchTask(plugin, 'pipeline-advisory-call', 'critic');

		const session = swarmState.agentSessions.get(SESSION_ID);
		const advisories = session?.pendingAdvisoryMessages ?? [];
		expect(
			advisories.some((message) =>
				message.startsWith('[PIPELINE] critic delegation complete'),
			),
		).toBe(true);
		expect(ends()[0]?.data.agentName).toBe('critic');
	});

	test('a Task call denied by a fail-closed gate emits no delegation_begin', async () => {
		// A fail-closed gate denial must not publish a begin event.
		const plugin = await boot({ guardrails: { enabled: false } });
		await expect(
			plugin.hooks['tool.execute.before'](
				{ tool: 'task', sessionID: SESSION_ID, callID: 'denied-call' },
				{
					args: {
						description: 'explore',
						prompt: 'Explore the codebase and report findings.',
						subagent_type: 'explorer',
						background: true,
					},
				},
			),
		).rejects.toThrow();

		expect(begins()).toHaveLength(0);
		expect(ends()).toHaveLength(0);
	});

	test('Task-path taskId asymmetry: begin carries empty taskId when no task is current, end carries the taskId resolved at completion', async () => {
		// Task completion may resolve a task id that was absent at dispatch.
		const plugin = await boot({ guardrails: { enabled: false } });
		const session = swarmState.agentSessions.get(SESSION_ID);
		if (!session) throw new Error('session missing after boot');
		session.currentTaskId = null;
		await plugin.hooks['tool.execute.before'](
			{ tool: 'task', sessionID: SESSION_ID, callID: 'taskid-asymmetry' },
			{
				args: {
					description: 'explore',
					prompt: 'Explore the codebase and report findings.',
					subagent_type: 'explorer',
				},
			},
		);
		// A task id becomes current during the delegated call (e.g. populated
		// by guardrails toolAfter before the handoff runs).
		session.currentTaskId = '2.3';
		await plugin.hooks['tool.execute.after'](
			{ tool: 'task', sessionID: SESSION_ID, callID: 'taskid-asymmetry' },
			{ state: 'completed', output: 'exploration done' },
		);

		expect(begins()).toHaveLength(1);
		expect(ends()).toHaveLength(1);
		expect(begins()[0]?.data.taskId).toBe('');
		expect(ends()[0]?.data.taskId).toBe('2.3');
	});

	test('a non-Task tool call emits no delegation events', async () => {
		// The begin emit is gated on the normalized tool name being Task/task,
		// and the Task handoff in tool.execute.after is likewise task-gated.
		// A read dispatch must leave the delegation event stream silent —
		// guards against a future broadening of either predicate.
		const plugin = await boot({ guardrails: { enabled: false } });
		await plugin.hooks['tool.execute.before'](
			{ tool: 'read', sessionID: SESSION_ID, callID: 'non-task-read' },
			{ args: { path: 'README.md' } },
		);
		await plugin.hooks['tool.execute.after'](
			{ tool: 'read', sessionID: SESSION_ID, callID: 'non-task-read' },
			{ state: 'completed', output: 'file content' },
		);

		expect(begins()).toHaveLength(0);
		expect(ends()).toHaveLength(0);
	});

	test('malformed subagent_type falls back to the session activeAgent', async () => {
		// The begin-side agentName resolver only trusts
		// `typeof subagent_type === 'string' && length > 0`. An empty or
		// missing subagent_type must fall back to the session's activeAgent
		// rather than being recorded as the agentName. Removing the guard (or
		// trusting the raw value) breaks this test.
		//
		// Untested branch: the `'unknown'` terminal fallback
		// (`activeAgent.get(...) ?? 'unknown'`) is unreachable through the
		// plugin hook path — earlier steps in the before chain (ensureAgentSession
		// and the delegation tracker) repopulate activeAgent for the session
		// before the begin emit runs, observed empirically: deleting the
		// activeAgent entry still produced 'architect'.
		const plugin = await boot({ guardrails: { enabled: false } });
		const before = plugin.hooks['tool.execute.before'];
		const malformedArgs = (subagentType?: unknown) => ({
			args: {
				description: 'explore',
				prompt: 'Explore the codebase and report findings.',
				...(subagentType === undefined ? {} : { subagent_type: subagentType }),
			},
		});
		await before(
			{ tool: 'task', sessionID: SESSION_ID, callID: 'fallback-empty-string' },
			malformedArgs(''),
		);
		await before(
			{ tool: 'task', sessionID: SESSION_ID, callID: 'fallback-missing' },
			malformedArgs(),
		);

		expect(begins().map((e) => e.data.agentName)).toEqual([
			'architect',
			'architect',
		]);
	});

	test('a background running placeholder emits begin but defers end to the trusted terminal event', async () => {
		// Mirrors the existing handoff contract (see
		// index-background-placeholder-handoff.test.ts): a background Task's
		// "running" placeholder is a handoff boundary, not terminal completion,
		// so delegation_end must not fire for it — but the delegation genuinely
		// began, so delegation_begin must.
		const plugin = await boot({
			guardrails: { enabled: false },
			// Background Task dispatch is denied by delegation-gate unless the
			// experimental background_subagents hook flag is opted into.
			hooks: { background_subagents: true },
		});
		await plugin.hooks['tool.execute.before'](
			{ tool: 'task', sessionID: SESSION_ID, callID: 'background-call' },
			{
				args: {
					description: 'explore',
					prompt: 'Explore the codebase and report findings.',
					subagent_type: 'explorer',
					background: true,
				},
			},
		);
		await plugin.hooks['tool.execute.after'](
			{ tool: 'task', sessionID: SESSION_ID, callID: 'background-call' },
			{
				state: 'running',
				output:
					'<task id="background-explorer" state="running">Background task started</task>',
				metadata: { background: true, jobId: 'background-explorer' },
			},
		);

		expect(begins()).toHaveLength(1);
		expect(ends()).toHaveLength(0);
	});
});
