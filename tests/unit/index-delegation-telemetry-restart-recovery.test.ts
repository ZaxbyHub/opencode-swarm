import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
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

describe('delegation telemetry restart recovery', () => {
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
		resetTelemetryForTesting();
		resetSwarmState();
		_resetDelegationTelemetryPairingForTesting();
		safeRmRecursive(directory);
	});

	test('binds exactly one unresolved delegation before correcting it', async () => {
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
		for (
			let attempt = 0;
			attempt < 100 &&
			events.filter((event) => event.event === 'delegation_cost_binding')
				.length < 1;
			attempt++
		)
			await new Promise((resolve) => setTimeout(resolve, 10));

		expect(
			events.filter((event) => event.event === 'delegation_cost_binding'),
		).toHaveLength(1);
		const corrections = events.filter(
			(event) => event.event === 'delegation_cost_correction',
		);
		expect(corrections).toHaveLength(2);
		expect(corrections.at(-1)?.data.cost_source).toBe('reported');
		expect(
			events.filter((event) => event.event === 'delegation_cost_join'),
		).toHaveLength(0);
	});

	test('ignores unrelated rejected telemetry when selecting the matching child', async () => {
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
			{ session: { get: async () => ({ data: { parentID: SESSION_ID } }) } },
		);
		addTelemetryListener((event, data) => events.push({ event, data }));
		const session = ensureAgentSession(SESSION_ID, 'architect', directory);
		session.currentTaskId = '1.1';
		swarmState.activeAgent.set(SESSION_ID, 'architect');
		const dispatch = async (callID: string, childSessionID: string) => {
			await plugin.hooks['tool.execute.before'](
				{ tool: 'task', sessionID: SESSION_ID, callID },
				{
					args: {
						description: 'explore',
						prompt: 'Explore and report.',
						subagent_type: 'explorer',
					},
				},
			);
			await plugin.hooks['tool.execute.after'](
				{ tool: 'task', sessionID: SESSION_ID, callID },
				{
					state: 'completed',
					metadata: { sessionID: childSessionID },
					output: 'done',
				},
			);
		};
		await dispatch('restart-cost-a', 'restart-cost-child-a');
		await dispatch('restart-cost-b', 'restart-cost-child-b');
		await plugin.hooks.event({
			event: {
				type: 'message.updated',
				properties: {
					info: {
						role: 'assistant',
						sessionID: 'restart-cost-child-a',
						providerID: 'provider',
						modelID: 'model',
						tokens: { input: 1_000_000, output: 0 },
					},
				},
			},
		});
		const telemetryPath = path.join(directory, '.swarm', 'telemetry.jsonl');
		const parentSessionDigest = createHash('sha256')
			.update(`delegation-cost-parent-v1\0${SESSION_ID}`)
			.digest('hex')
			.slice(0, 32);
		appendFileSync(
			telemetryPath,
			`${JSON.stringify({
				event: 'delegation_cost_correction',
				sessionId: SESSION_ID,
				agentName: 'architect',
				taskId: '1.1',
				record_id: 'noise-record',
				identity_fingerprint: 'f'.repeat(32),
				parent_session_digest: parentSessionDigest,
				version: 2,
				cost_usd: 0.01,
				cost_source: 'reported',
				tokens_input: 1,
				tokens_output: 1,
				tokens_reasoning: 0,
				tokens_cache: 0,
				model: 'provider/model',
			})}\n`,
		);
		_resetDelegationTelemetryPairingForTesting();
		await plugin.hooks.event({
			event: {
				type: 'message.updated',
				properties: {
					info: {
						role: 'assistant',
						sessionID: 'restart-cost-child-a',
						providerID: 'provider',
						modelID: 'model',
						cost: 0.5,
						tokens: { input: 1_000_000, output: 10 },
					},
				},
			},
		});
		for (
			let attempt = 0;
			attempt < 100 &&
			events.filter((event) => event.event === 'delegation_cost_binding')
				.length < 1;
			attempt++
		)
			await new Promise((resolve) => setTimeout(resolve, 10));
		expect(
			events.filter((event) => event.event === 'delegation_cost_binding'),
		).toHaveLength(1);
		expect(
			events.filter((event) => event.event === 'delegation_cost_correction'),
		).toHaveLength(2);
		expect(events.at(-1)?.data.cost_source).toBe('reported');
	});
});
