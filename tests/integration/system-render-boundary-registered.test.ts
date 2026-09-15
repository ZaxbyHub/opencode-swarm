import { afterAll, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import {
	beginTurnLedger,
	getTurnLedgerSummary,
} from '../../src/services/injection-budget';
import { swarmState } from '../../src/state';
import {
	type HostPartsMessage,
	hostToModelMessages,
	renderedText,
} from '../helpers/host-contract-v1_18_3';
import {
	bootSwarmPluginHost,
	createPluginHostProject,
} from '../helpers/plugin-host';

/**
 * Issue #2673 registered-host journeys: the boundary's behavior through the
 * REAL plugin hooks, driven in pinned-host order (chat.message, then
 * experimental.chat.messages.transform, then experimental.chat.system.transform)
 * with the host's v1.18.3 LLMRequestPrep.prepare materialization applied
 * verbatim. Architect guidance is asserted on the trailing user-role carrier;
 * the system assertions cover only the host's cache-sensitive system surface.
 */
const BASE_HEADER =
	'You are OpenCode, an agent. Base prompt bytes that the host pre-joined.';

function strictLocalModel(): Record<string, unknown> {
	return {
		id: 'qwen3.6-32b',
		providerID: 'vllm-local',
		api: {
			id: 'openai-compatible',
			url: 'http://127.0.0.1:8000/v1',
			npm: '@ai-sdk/openai-compatible',
		},
	};
}

function auxiliaryStrictModel(): Record<string, unknown> {
	return {
		id: 'gemma-3-4b',
		providerID: 'ollama-local',
		api: {
			id: 'openai-compatible',
			url: 'http://127.0.0.1:11434/v1',
			npm: '@ai-sdk/openai-compatible',
		},
	};
}

function cacheCapableModel(): Record<string, unknown> {
	return {
		id: 'claude-sonnet-4-6',
		providerID: 'anthropic',
		api: {
			id: 'anthropic',
			url: 'https://api.anthropic.com/v1',
			npm: '@ai-sdk/anthropic',
		},
	};
}

/**
 * VERBATIM host v1.18.3 materialization (LLMRequestPrep.prepare). The header
 * is captured by the host BEFORE the plugin hooks run, so callers pass it in
 * pre-hook — capturing it inside this function would make the
 * system[0] === header reshape precondition tautological.
 */
function hostMaterialize(
	header: string | undefined,
	system: string[],
): Array<{ role: string; content: string }> {
	if (system.length > 2 && system[0] === header) {
		const rest = system.slice(1);
		system.length = 0;
		system.push(header, rest.join('\n'));
	}
	return system.map((x) => ({ role: 'system', content: x }));
}

const directory = createPluginHostProject('system-render-2673');
let booted: Awaited<ReturnType<typeof bootSwarmPluginHost>> | undefined;

afterAll(async () => {
	// Review finding M2: the booted plugin populates module-level swarmState
	// singletons (activeAgent, liveContextWindows, ...); reset them so local
	// multi-file bun runs cannot inherit this suite's session state. CI runs
	// per-file, where this is defense in depth.
	try {
		const { resetSwarmState } = await import('../../src/state');
		resetSwarmState();
	} catch {
		// The suite must not fail on cleanup of advisory process state.
	}
	try {
		rmSync(directory, {
			recursive: true,
			force: true,
			maxRetries: 3,
			retryDelay: 100,
		});
	} catch {
		// Windows EBUSY from lingering sqlite handles — best effort only.
	}
});

async function driveTurn(args: {
	sessionID: string;
	agent: string;
	model: unknown;
	seed: string[];
}): Promise<{
	system: Array<{ role: string; content: string }>;
	messages: ReturnType<typeof hostToModelMessages>;
}> {
	booted ??= await bootSwarmPluginHost(directory, { version_check: false });
	await booted.hooks['chat.message'](
		{ sessionID: args.sessionID, agent: args.agent },
		{},
	);
	const requestMessages: HostPartsMessage[] = [
		{
			info: {
				id: `request-${args.sessionID}`,
				role: 'user',
				agent: args.agent,
				sessionID: args.sessionID,
			},
			parts: [{ type: 'text', text: 'continue' }],
		},
	];
	await booted.hooks['experimental.chat.messages.transform'](
		{},
		{ messages: requestMessages },
	);
	const system = [...args.seed];
	// Host fidelity (review finding M1): the host captures header BEFORE the
	// transform hooks run; capture here, pre-hook, not inside hostMaterialize.
	const header = system[0];
	await booted.hooks['experimental.chat.system.transform'](
		{ sessionID: args.sessionID, model: args.model },
		{ system },
	);
	return {
		system: hostMaterialize(header, system),
		messages: hostToModelMessages(requestMessages),
	};
}

describe('system render boundary through the registered host (#2673)', () => {
	test('strict architect turn renders exactly one system message with guidance retained (AC1)', async () => {
		const result = await driveTurn({
			sessionID: 'reg-architect-strict',
			agent: 'architect',
			model: strictLocalModel(),
			seed: [BASE_HEADER],
		});
		expect(result.system).toHaveLength(1);
		expect(result.system[0].role).toBe('system');
		expect(result.system[0].content).toBe(BASE_HEADER);
		expect(renderedText(result.messages)).toContain('PLANNING PROFILE');
		// The base header appears exactly once (no duplication from the join).
		const occurrences = result.system[0].content.split(BASE_HEADER).length - 1;
		expect(occurrences).toBe(1);
	});

	test('build-agent turn with producer entries collapses to one joined entry (AC2)', async () => {
		const result = await driveTurn({
			sessionID: 'reg-build-strict',
			agent: 'build',
			model: strictLocalModel(),
			seed: [
				BASE_HEADER,
				'[swarm-build] producer entry that a non-enhancer producer could push',
			],
		});
		expect(result.system).toHaveLength(1);
		expect(result.system[0].content.startsWith(BASE_HEADER)).toBe(true);
		expect(result.system[0].content).toContain('[swarm-build] producer entry');
	});

	test('auxiliary title turn on a small strict model collapses to one joined entry (AC2, reported separately)', async () => {
		const result = await driveTurn({
			sessionID: 'reg-title-strict',
			agent: 'title',
			model: auxiliaryStrictModel(),
			seed: [BASE_HEADER, '[swarm-aux] auxiliary producer entry'],
		});
		expect(result.system).toHaveLength(1);
		expect(result.system[0].content).toContain(
			'[swarm-aux] auxiliary producer entry',
		);
	});

	test('guidance-free strict turn stays byte-identical, nothing fabricated (AC3 negative)', async () => {
		const result = await driveTurn({
			sessionID: 'reg-general-strict',
			agent: 'general',
			model: strictLocalModel(),
			seed: [BASE_HEADER],
		});
		expect(result.system).toHaveLength(1);
		expect(result.system[0].content).toBe(BASE_HEADER);
	});

	test('cache-capable architect retains the stable system prefix while guidance trails in a carrier (AC4)', async () => {
		const result = await driveTurn({
			sessionID: 'reg-architect-cache',
			agent: 'architect',
			model: cacheCapableModel(),
			seed: [BASE_HEADER],
		});
		expect(result.system[0]?.content).toBe(BASE_HEADER);
		expect(
			result.system.every(
				(entry) => !entry.content.includes('PLANNING PROFILE'),
			),
		).toBe(true);
		expect(renderedText(result.messages)).toContain('PLANNING PROFILE');
	});

	test('cold active-agent identity uses the session fallback without a second system ledger (AC5)', async () => {
		booted ??= await bootSwarmPluginHost(directory, { version_check: false });
		const sessionID = 'reg-architect-cold-identity';
		const agent = 'mega_architect';
		const model = strictLocalModel();

		// chat.message establishes the authoritative model identity and leaves the
		// session record populated. Simulate a cold activeAgent map before the host's
		// messages-before-system transform order; the missing message agent forces
		// the restored session record to supply the architect identity.
		await booted.hooks['chat.message'](
			{ sessionID, agent },
			{ message: { model } },
		);
		expect(swarmState.agentSessions.get(sessionID)?.agentName).toBe(agent);
		swarmState.activeAgent.delete(sessionID);

		const requestMessages: HostPartsMessage[] = [
			{
				info: {
					id: `request-${sessionID}`,
					role: 'user',
					sessionID,
				},
				parts: [{ type: 'text', text: 'continue' }],
			},
		];
		await booted.hooks['experimental.chat.messages.transform'](
			{},
			{ messages: requestMessages },
		);
		// Final accounting consumes the messages-stage ledger. Seed a sentinel
		// generation immediately before the system hook so a second begin/reset is
		// observable without depending on accounting implementation details.
		const sentinelGeneration = beginTurnLedger(sessionID, 777, false);
		const beforeSystem = getTurnLedgerSummary(sessionID);
		expect(beforeSystem?.generation).toBe(sentinelGeneration);

		const system = [BASE_HEADER];
		await booted.hooks['experimental.chat.system.transform'](
			{ sessionID, model },
			{ system },
		);
		const afterSystem = getTurnLedgerSummary(sessionID);

		expect(afterSystem?.generation).toBe(sentinelGeneration);
		expect(afterSystem?.totalBudget).toBe(777);
		expect(system).toEqual([BASE_HEADER]);
		const rendered = hostToModelMessages(requestMessages);
		const carrierIndex = requestMessages.findIndex(
			(message) => message.info.id === 'swarm-guidance:architect-session',
		);
		expect(carrierIndex).toBe(requestMessages.length - 1);
		expect(requestMessages[carrierIndex]?.info.role).toBe('user');
		expect(renderedText(rendered)).toContain('PLANNING PROFILE');
		expect(renderedText(rendered)).toContain(
			'[opencode-swarm:swarm-command-rule]',
		);
		expect(system.some((entry) => entry.includes('PLANNING PROFILE'))).toBe(
			false,
		);
	});

	test('cold session state does not override a newer real user agent', async () => {
		booted ??= await bootSwarmPluginHost(directory, { version_check: false });
		const sessionID = 'reg-agent-precedence';
		const model = strictLocalModel();
		await booted.hooks['chat.message'](
			{ sessionID, agent: 'mega_architect' },
			{ message: { model } },
		);
		swarmState.activeAgent.delete(sessionID);

		const requestMessages: HostPartsMessage[] = [
			{
				info: {
					id: `request-${sessionID}`,
					role: 'user',
					agent: 'build',
					sessionID,
				},
				parts: [{ type: 'text', text: 'continue' }],
			},
		];
		await booted.hooks['experimental.chat.messages.transform'](
			{},
			{ messages: requestMessages },
		);
		expect(
			requestMessages.some(
				(message) => message.info.id === 'swarm-guidance:architect-session',
			),
		).toBe(false);
	});
});
