import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PluginConfig } from '../../../src/config';
import {
	isGuidanceCarrier,
	isRenderableGuidance,
	messageTextOf,
} from '../../../src/hooks/system-guidance-carrier';
import {
	ensureAgentSession,
	resetSwarmState,
	swarmState,
} from '../../../src/state';
import {
	type HostPartsMessage,
	hostToModelMessages,
	renderedText,
} from '../../helpers/host-contract-v1_18_3';
import {
	bootSwarmPluginHost,
	createPluginHostProject,
} from '../../helpers/plugin-host';
import { safeRmRecursive } from '../../helpers/safe-test-dir';

// Helper to create tool aggregate (only uses fields that exist in ToolAggregate)
function createToolAggregate(count: number) {
	return {
		tool: 'bash',
		count,
		successCount: 0,
		failureCount: 0,
		totalDuration: 0,
	};
}

describe('v6.2 System Enhancer Compaction Advisory', () => {
	let tempDir: string;
	const sessionID = 'test-session';
	const compactionMarker = '[SWARM HINT] Session has';
	const BASE_SYSTEM = 'Stable architect system prefix';

	beforeEach(() => {
		tempDir = createPluginHostProject('swarm-compaction-test-');
		resetSwarmState();
		swarmState.activeAgent.set(sessionID, 'architect');
	});

	afterEach(() => {
		try {
			safeRmRecursive(tempDir);
		} catch {}
	});

	async function createSwarmFiles(): Promise<void> {
		const swarmDir = join(tempDir, '.swarm');
		await mkdir(swarmDir, { recursive: true });
		await writeFile(join(swarmDir, 'plan.md'), '# Plan\n');
		await writeFile(join(swarmDir, 'context.md'), '# Context\n');
	}

	async function invokeRegisteredArchitect(
		configOverrides: Partial<PluginConfig> = {},
	): Promise<{
		messages: HostPartsMessage[];
		rendered: ReturnType<typeof hostToModelMessages>;
		system: string[];
	}> {
		const host = await bootSwarmPluginHost(tempDir, {
			version_check: false,
			knowledge: { enabled: false, hive_enabled: false },
			memory: { enabled: false },
			hooks: { delegation_gate: false, system_enhancer: true },
			...defaultConfig,
			...configOverrides,
		});
		const messages: HostPartsMessage[] = [
			{
				info: {
					id: 'compaction-user-message',
					role: 'user',
					agent: 'architect',
					sessionID,
				},
				parts: [{ type: 'text', text: 'Continue the active plan.' }],
			},
		];
		await host.hooks['experimental.chat.messages.transform']({}, { messages });
		const system = [BASE_SYSTEM];
		await host.hooks['experimental.chat.system.transform'](
			{ sessionID },
			{ system },
		);
		return { messages, rendered: hostToModelMessages(messages), system };
	}

	function findCompactionGuidance(
		messages: HostPartsMessage[],
		rendered: ReturnType<typeof hostToModelMessages>,
	): string {
		const carrier = messages.find(
			(message) =>
				isGuidanceCarrier(message) &&
				messageTextOf(message).includes(compactionMarker),
		);
		expect(carrier).toBeDefined();
		expect(isRenderableGuidance(carrier)).toBe(true);
		expect(carrier?.info.role).toBe('user');
		const carrierIndex = messages.indexOf(carrier as HostPartsMessage);
		const triggeringUserIndex = messages.findIndex(
			(message) => message.info.id === 'compaction-user-message',
		);
		expect(carrierIndex).toBeGreaterThan(triggeringUserIndex);
		expect(messages.slice(carrierIndex).every(isGuidanceCarrier)).toBe(true);
		const text = messageTextOf(carrier);
		expect(renderedText(rendered)).toContain(compactionMarker);
		return text;
	}

	function expectStableArchitectSystem(system: string[]): void {
		expect(system).toEqual([BASE_SYSTEM]);
	}

	const defaultConfig: PluginConfig = {
		max_iterations: 5,
		qa_retry_limit: 3,
		inject_phase_reminders: true,
	};

	it('injects compaction hint at first threshold crossing (50 tool calls)', async () => {
		// 1. createSwarmFiles()
		await createSwarmFiles();

		// 2. ensureAgentSession(sessionID, 'architect')
		ensureAgentSession(sessionID, 'architect');

		// 3. Set session.lastCompactionHint = 0
		const session = swarmState.agentSessions.get('test-session')!;
		session.lastCompactionHint = 0;

		// 4. swarmState.toolAggregates.set('bash', createToolAggregate(52))
		swarmState.toolAggregates.set('bash', createToolAggregate(52));

		// 5. invokeHook(defaultConfig) — no compaction_advisory config (defaults apply)
		const result = await invokeRegisteredArchitect();

		const guidance = findCompactionGuidance(result.messages, result.rendered);
		expectStableArchitectSystem(result.system);

		// The rendered advisory reports the actual aggregate count.
		expect(guidance).toContain('52 tool calls');
	});

	it('does not re-inject at same threshold (lastCompactionHint = 50, total = 52)', async () => {
		// 1. createSwarmFiles()
		await createSwarmFiles();

		// 2. ensureAgentSession(sessionID, 'architect')
		ensureAgentSession(sessionID, 'architect');

		// 3. Set session.lastCompactionHint = 50
		const session = swarmState.agentSessions.get('test-session')!;
		session.lastCompactionHint = 50;

		// 4. swarmState.toolAggregates.set('bash', createToolAggregate(52))
		swarmState.toolAggregates.set('bash', createToolAggregate(52));

		// 5. invokeHook(defaultConfig)
		const result = await invokeRegisteredArchitect();

		// The session has already crossed this threshold, so the one-shot
		// advisory is absent from the registered host transform.
		expect(
			result.messages.some((message) =>
				messageTextOf(message).includes(compactionMarker),
			),
		).toBe(false);
		expectStableArchitectSystem(result.system);
	});

	it('injects at next threshold when last hint was at prior threshold', async () => {
		// 1. createSwarmFiles()
		await createSwarmFiles();

		// 2. ensureAgentSession(sessionID, 'architect')
		ensureAgentSession(sessionID, 'architect');

		// 3. Set session.lastCompactionHint = 50
		const session = swarmState.agentSessions.get('test-session')!;
		session.lastCompactionHint = 50;

		// 4. swarmState.toolAggregates.set('bash', createToolAggregate(77)) — crosses 75 threshold
		swarmState.toolAggregates.set('bash', createToolAggregate(77));

		// 5. invokeHook(defaultConfig)
		const result = await invokeRegisteredArchitect();

		const guidance = findCompactionGuidance(result.messages, result.rendered);
		expectStableArchitectSystem(result.system);
		expect(guidance).toContain('77 tool calls');

		// 7. Check session.lastCompactionHint is now 75
		expect(session.lastCompactionHint).toBe(75);
	});

	it('enabled:false skips compaction advisory entirely', async () => {
		// 1. createSwarmFiles()
		await createSwarmFiles();

		// 2. ensureAgentSession(sessionID, 'architect')
		ensureAgentSession(sessionID, 'architect');

		// 3. Set session.lastCompactionHint = 0
		const session = swarmState.agentSessions.get('test-session')!;
		session.lastCompactionHint = 0;

		// 4. swarmState.toolAggregates.set('bash', createToolAggregate(200))
		swarmState.toolAggregates.set('bash', createToolAggregate(200));

		// 5. config = { ...defaultConfig, compaction_advisory: { enabled: false } }
		const config = {
			...defaultConfig,
			compaction_advisory: {
				enabled: false,
			} as PluginConfig['compaction_advisory'],
		};

		// 6. invokeHook(config)
		const result = await invokeRegisteredArchitect(config);

		// An explicit disable remains authoritative and produces no compaction
		// carrier, while the stable architect system surface is preserved.
		expect(
			result.messages.some((message) =>
				messageTextOf(message).includes(compactionMarker),
			),
		).toBe(false);
		expectStableArchitectSystem(result.system);
	});

	it('lastCompactionHint initializes to 0 (new session)', async () => {
		// 1. ensureAgentSession('test-session', 'architect')
		ensureAgentSession('test-session', 'architect');

		// 2. const session = swarmState.agentSessions.get(sessionID)!
		const session = swarmState.agentSessions.get(sessionID)!;

		// 3. Assert: session.lastCompactionHint === 0
		expect(session.lastCompactionHint).toBe(0);
	});

	it('custom thresholds accepted and used', async () => {
		// 1. createSwarmFiles()
		await createSwarmFiles();

		// 2. ensureAgentSession(sessionID, 'architect')
		ensureAgentSession(sessionID, 'architect');

		// 3. Set session.lastCompactionHint = 0
		const session = swarmState.agentSessions.get('test-session')!;
		session.lastCompactionHint = 0;

		// 4. swarmState.toolAggregates.set('bash', createToolAggregate(25))
		swarmState.toolAggregates.set('bash', createToolAggregate(25));

		// 5. config = { ...defaultConfig, compaction_advisory: { enabled: true, thresholds: [20, 40, 60] } }
		const config = {
			...defaultConfig,
			compaction_advisory: {
				enabled: true,
				thresholds: [20, 40, 60],
			} as PluginConfig['compaction_advisory'],
		};

		// 6. invokeHook(config)
		const result = await invokeRegisteredArchitect(config);

		const guidance = findCompactionGuidance(result.messages, result.rendered);
		expectStableArchitectSystem(result.system);
		expect(guidance).toContain('25 tool calls');
	});
});
