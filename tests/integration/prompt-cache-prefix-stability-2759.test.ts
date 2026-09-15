import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import {
	buildRealtimeLearningNudge,
	recordRealtimeLearningToolCall,
	resetRealtimeLearningNudgeState,
	shouldInjectRealtimeLearningNudge,
} from '../../src/hooks/realtime-learning-nudge';
import {
	isGuidanceCarrier,
	isRenderableGuidance,
	messageTextOf,
} from '../../src/hooks/system-guidance-carrier';
import { applySystemRenderBoundary } from '../../src/hooks/system-render-boundary';
import {
	ensureAgentSession,
	resetSwarmState,
	swarmState,
} from '../../src/state';
import {
	type HostPartsMessage,
	hostToModelMessages,
	renderedText,
} from '../helpers/host-contract-v1_18_3';
import {
	bootSwarmPluginHost,
	createPluginHostProject,
} from '../helpers/plugin-host';
import { createSwarmFiles } from '../helpers/system-enhancer-test-helpers';

const BASE_HEADER = 'Stable architect header';
const ARCHITECT_SESSION = 'cache-prefix-2759-architect';

const cacheCapableModel = {
	id: 'glm-5.3',
	providerID: 'openrouter',
	api: { id: 'openai-compatible', url: 'https://openrouter.ai/api/v1' },
};

const strictSingleSystemModel = {
	id: 'qwen3.6-32b',
	providerID: 'vllm-local',
	api: { id: 'openai-compatible', url: 'http://127.0.0.1:8000/v1' },
};

let hostDirectory: string;
let host: Awaited<ReturnType<typeof bootSwarmPluginHost>>;
let nudgeHostDirectory: string;
let nudgeHost: Awaited<ReturnType<typeof bootSwarmPluginHost>>;
let disabledEnhancerHostDirectory: string;
let disabledEnhancerHost: Awaited<ReturnType<typeof bootSwarmPluginHost>>;

beforeAll(async () => {
	hostDirectory = createPluginHostProject('prompt-cache-prefix-2759');
	host = await bootSwarmPluginHost(hostDirectory, {
		version_check: false,
		knowledge: { enabled: false, hive_enabled: false },
		memory: { enabled: false },
		hooks: { delegation_gate: false },
	});
	nudgeHostDirectory = createPluginHostProject('prompt-cache-nudge-2759');
	await createSwarmFiles(nudgeHostDirectory, 2);
	nudgeHost = await bootSwarmPluginHost(nudgeHostDirectory, {
		version_check: false,
		learning: { realtime_admission: { enabled: false } },
		knowledge: {
			enabled: true,
			hive_enabled: false,
			realtime_learning_nudge: {
				enabled: true,
				first_after_tool_calls: 1,
				repeat_after_tool_calls: 2,
			},
		},
		memory: { enabled: false },
		hooks: { delegation_gate: false },
	});
	disabledEnhancerHostDirectory = createPluginHostProject(
		'prompt-cache-disabled-enhancer-2759',
	);
	disabledEnhancerHost = await bootSwarmPluginHost(
		disabledEnhancerHostDirectory,
		{
			version_check: false,
			knowledge: { enabled: false, hive_enabled: false },
			memory: { enabled: false },
			hooks: { system_enhancer: false, delegation_gate: false },
		},
	);
});

afterAll(() => {
	resetSwarmState();
	resetRealtimeLearningNudgeState();
	try {
		rmSync(hostDirectory, { recursive: true, force: true, maxRetries: 3 });
	} catch {
		// SQLite handles can remain open briefly on Windows; cleanup is best effort.
	}
	try {
		rmSync(nudgeHostDirectory, {
			recursive: true,
			force: true,
			maxRetries: 3,
		});
	} catch {
		// SQLite handles can remain open briefly on Windows; cleanup is best effort.
	}
	try {
		rmSync(disabledEnhancerHostDirectory, {
			recursive: true,
			force: true,
			maxRetries: 3,
		});
	} catch {
		// SQLite handles can remain open briefly on Windows; cleanup is best effort.
	}
});

function architectHistory(
	sessionID: string,
	agent = 'architect',
): HostPartsMessage[] {
	return [
		{
			info: { id: 'history-user', role: 'user', agent, sessionID },
			parts: [{ type: 'text', text: 'Established architect history' }],
		},
		{
			info: { id: 'history-assistant', role: 'assistant', sessionID },
			parts: [{ type: 'text', text: 'Established assistant reply' }],
		},
	];
}

async function transformArchitectMessages(
	stepGuidance: string,
	sessionID: string,
	agent = 'architect',
): Promise<{
	messages: HostPartsMessage[];
	rendered: ReturnType<typeof hostToModelMessages>;
}> {
	const session = swarmState.agentSessions.get(sessionID);
	if (!session) ensureAgentSession(sessionID, agent);
	swarmState.activeAgent.set(sessionID, agent);
	swarmState.agentSessions.get(sessionID)!.pendingAdvisoryMessages = [
		stepGuidance,
	];
	const messages = architectHistory(sessionID, agent);
	await host.hooks['experimental.chat.messages.transform']({}, { messages });
	return {
		messages,
		rendered: hostToModelMessages(messages),
	};
}

function hostMaterializeSystem(
	header: string,
	system: string[],
): Array<{ role: 'system'; content: string }> {
	if (system.length > 2 && system[0] === header) {
		const rest = system.slice(1);
		system.length = 0;
		system.push(header, rest.join('\n'));
	}
	return system.map((content) => ({ role: 'system', content }));
}

describe('issue #2759 prompt-cache prefix acceptance', () => {
	test('AC1: consecutive architect requests keep the history prefix byte-stable', async () => {
		resetSwarmState();
		const first = await transformArchitectMessages(
			'[STEP GUIDANCE A]',
			ARCHITECT_SESSION,
		);
		const second = await transformArchitectMessages(
			'[STEP GUIDANCE B]',
			ARCHITECT_SESSION,
		);

		// The two established history messages must precede changing guidance.
		expect(first.rendered.slice(0, 2)).toEqual(second.rendered.slice(0, 2));
	});

	test('AC2: changing guidance is trailing, user-role, and host-renderable', async () => {
		resetSwarmState();
		const transformed = await transformArchitectMessages(
			'[STEP GUIDANCE TRAILING]',
			`${ARCHITECT_SESSION}-position`,
		);
		const carrierIndex = transformed.messages.findIndex((message) =>
			isGuidanceCarrier(message),
		);
		const carrier = transformed.messages[carrierIndex];

		expect(carrierIndex).toBe(2);
		expect(isRenderableGuidance(carrier)).toBe(true);
		expect(transformed.rendered[carrierIndex]?.role).toBe('user');
		expect(renderedText(transformed.rendered)).toContain(
			'[STEP GUIDANCE TRAILING]',
		);
	});

	test('AC2-prefixed: multi-swarm architect identity reaches the late adapter', async () => {
		resetSwarmState();
		const transformed = await transformArchitectMessages(
			'[STEP GUIDANCE PREFIXED]',
			`${ARCHITECT_SESSION}-prefixed`,
			'mega_architect',
		);
		const carrier = transformed.messages.find(
			(message) =>
				isGuidanceCarrier(message) &&
				message.info.id === 'swarm-guidance:architect-session',
		);

		expect(carrier).toBeDefined();
		expect(renderedText(transformed.rendered)).toContain(
			'[STEP GUIDANCE PREFIXED]',
		);
		expect(messageTextOf(carrier)).toContain(
			'[opencode-swarm:swarm-command-rule]',
		);
	});

	test('AC3: cache-capable providers keep both system breakpoint entries stable', async () => {
		const sessionID = `${ARCHITECT_SESSION}-nudge`;
		resetSwarmState();
		resetRealtimeLearningNudgeState();
		ensureAgentSession(sessionID, 'architect');
		swarmState.activeAgent.set(sessionID, 'architect');
		const renderRegisteredTurn = async (
			toolCallCount: number,
			seed = [BASE_HEADER, 'Stable cache breakpoint'],
		) => {
			const expectedNudge = buildRealtimeLearningNudge({
				currentPhase: 2,
				toolCallCount,
			});
			const messages = architectHistory(sessionID);

			// Production order: messages.transform runs before system.transform.
			await nudgeHost.hooks['experimental.chat.messages.transform'](
				{},
				{ messages },
			);
			const renderedMessages = hostToModelMessages(messages);
			const output = { system: [...seed] };
			await nudgeHost.hooks['experimental.chat.system.transform'](
				{ sessionID, model: cacheCapableModel },
				output,
			);
			return {
				expectedNudge,
				messages,
				renderedMessages,
				system: hostMaterializeSystem(BASE_HEADER, output.system),
			};
		};

		// One real stateful producer trigger drives both registered surfaces for
		// this same session. The second trigger makes the nudge vary.
		recordRealtimeLearningToolCall(sessionID);
		const first = await renderRegisteredTurn(1);
		expect(
			shouldInjectRealtimeLearningNudge({
				sessionID,
				config: {
					enabled: true,
					first_after_tool_calls: 1,
					repeat_after_tool_calls: 2,
				},
				realtimeAdmission: { enabled: false },
			}),
		).toBe(false);
		recordRealtimeLearningToolCall(sessionID);
		recordRealtimeLearningToolCall(sessionID);
		const second = await renderRegisteredTurn(3);

		const carrierIndex = first.messages.findIndex(
			(message) =>
				isGuidanceCarrier(message) &&
				messageTextOf(message).includes(first.expectedNudge),
		);
		const carrier = first.messages[carrierIndex];
		const renderedCarrier = first.renderedMessages.find(
			(message) => message.id === carrier?.info.id,
		);

		// The nudge must move out of the cache-sensitive system prefix, while
		// remaining visible in a trailing, renderable user-role carrier. One
		// aggregate assertion records all obligations even on the base tree.
		expect({
			systemShape:
				first.system.length >= 2 &&
				second.system.length >= 2 &&
				first.system.every((message) => message.role === 'system') &&
				second.system.every((message) => message.role === 'system'),
			systemPrefixStable:
				first.system[0]?.content === second.system[0]?.content &&
				first.system[1]?.content === second.system[1]?.content,
			nudgeAbsentFromSystemPrefix: !first.system
				.slice(0, 2)
				.some((message) => message.content.includes(first.expectedNudge)),
			nudgeDeliveredInTrailingUserCarrier:
				carrierIndex >= 2 &&
				isRenderableGuidance(carrier) &&
				renderedCarrier?.role === 'user' &&
				renderedCarrier.parts.some((part) =>
					part.text?.includes(first.expectedNudge),
				),
		}).toEqual({
			systemShape: true,
			systemPrefixStable: true,
			nudgeAbsentFromSystemPrefix: true,
			nudgeDeliveredInTrailingUserCarrier: true,
		});
	});

	test('AC4: strict Qwen/Gemma shapes retain exactly one system entry', () => {
		const system = [BASE_HEADER, '[STEP GUIDANCE STRICT]'];
		const result = applySystemRenderBoundary(strictSingleSystemModel, system);

		expect(result.collapsed).toBe(true);
		expect(system).toHaveLength(1);
		expect(system[0]).toContain(BASE_HEADER);
		expect(system[0]).toContain('[STEP GUIDANCE STRICT]');
	});

	test('AC5: the registered messages transform mutates in place and delivers no system-role carrier', async () => {
		resetSwarmState();
		const sessionID = `${ARCHITECT_SESSION}-delivery`;
		const messages = architectHistory(sessionID);
		ensureAgentSession(sessionID, 'architect');
		swarmState.activeAgent.set(sessionID, 'architect');
		swarmState.agentSessions.get(sessionID)!.pendingAdvisoryMessages = [
			'[DELIVERY GUIDANCE]',
		];
		const output = { messages };
		await host.hooks['experimental.chat.messages.transform']({}, output);

		expect(output.messages).toBe(messages);
		expect(messages.every((message) => message.info.role !== 'system')).toBe(
			true,
		);
		expect(renderedText(hostToModelMessages(messages))).toContain(
			'[DELIVERY GUIDANCE]',
		);
	});

	test('AC6: disabled system enhancer still delivers the architect command carrier', async () => {
		resetSwarmState();
		const sessionID = `${ARCHITECT_SESSION}-disabled-enhancer`;
		ensureAgentSession(sessionID, 'architect');
		swarmState.activeAgent.set(sessionID, 'architect');
		const messages = architectHistory(sessionID);
		await disabledEnhancerHost.hooks['experimental.chat.messages.transform'](
			{},
			{ messages },
		);
		const carrier = messages.find(
			(message) =>
				isGuidanceCarrier(message) &&
				message.info.id === 'swarm-guidance:architect-session',
		);

		expect(carrier).toBeDefined();
		expect(messageTextOf(carrier)).toContain(
			'[opencode-swarm:swarm-command-rule]',
		);
	});
});
