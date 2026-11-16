/**
 * Issue #3320 AC10 — explicit-architect sessions keep ALL architect
 * injections. GREEN at base and head.
 *
 * Regression floor for the fix: closing the sessionless fall-through (#3320
 * AC8) must not narrow what an EXPLICIT `chat.message`-bound architect
 * session receives. Drives the REAL registered plugin host
 * (`bootSwarmPluginHost`) in the pinned host order — chat.message →
 * experimental.chat.messages.transform → experimental.chat.system.transform
 * → tool.execute.after (Task completion) → tool.execute.before (write) — and
 * asserts the architect surface end-to-end:
 *
 *  - `chat.message` with agent 'architect' registers the session identity.
 *  - messages.transform injects the ARCHITECT WORKFLOW REMINDER and the
 *    architect-session (PLANNING PROFILE) directives; the guardrails and
 *    delegation guidance carriers are also present (all four architect
 *    guidance kinds).
 *  - system.transform for the session-bound architect leaves the system
 *    surface byte-stable: architect guidance has exactly ONE delivery owner
 *    (the messages-surface `swarm-guidance:architect-session` carrier), so
 *    nothing is appended twice to `output.system` (pinned by
 *    tests/integration/system-render-boundary-registered.test.ts AC1).
 *  - a Task-tool completion still hands the session back to the architect
 *    (`swarmState.activeAgent` reads 'architect').
 *  - the architect write gate still blocks a direct write of the
 *    verifier-owned config file biome.json with
 *    `WRITE BLOCKED: Agent "architect"`.
 *
 * Every assertion below passes at the base commit (the architect path is
 * verified-green there); the file exists so the fix cannot regress it.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { cancelDeferredMaintenanceScans } from '../../src/hooks/system-enhancer';
import { resetSwarmState, swarmState } from '../../src/state';
import { createIsolatedTestEnv } from '../helpers/isolated-test-env';
import {
	type BootedPluginHost,
	bootSwarmPluginHost,
	createPluginHostProject,
} from '../helpers/plugin-host';

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

describe('explicit architect session keeps all architect injections (#3320 AC10)', () => {
	let directory: string;
	let booted: BootedPluginHost;
	let isolatedEnv: ReturnType<typeof createIsolatedTestEnv>;

	beforeAll(async () => {
		isolatedEnv = createIsolatedTestEnv();
		directory = createPluginHostProject('architect-explicit-3320');
		booted = await bootSwarmPluginHost(directory, {
			version_check: false,
			knowledge: { enabled: false, hive_enabled: false },
			memory: { enabled: false },
			hooks: { system_enhancer: true },
			context_budget: { scoring: { enabled: false } },
		});
	});

	afterAll(() => {
		try {
			cancelDeferredMaintenanceScans(directory);
			resetSwarmState();
			rmSync(directory, {
				recursive: true,
				force: true,
				maxRetries: 5,
				retryDelay: 100,
			});
		} catch {
			// Windows EBUSY from lingering sqlite handles — best effort only.
		} finally {
			isolatedEnv.cleanup();
		}
	});

	test('chat.message → messages.transform → system.transform → Task handoff → write gate, all architect behaviors intact', async () => {
		const s = 'ac10-explicit-architect';

		// 1. Explicit architect identity via the registered chat.message hook.
		await booted.hooks['chat.message'](
			{ sessionID: s, agent: 'architect' },
			{ message: { id: 'm1', role: 'user' } },
		);
		expect(swarmState.activeAgent.get(s)).toBe('architect');

		// Seed one pending guardrail advisory so the guardrails guidance
		// carrier carries observable content this turn (same seeding path as
		// tests/unit/hooks/host-rendered-request-2526.test.ts).
		const session = swarmState.agentSessions.get(s);
		expect(session).toBeDefined();
		session!.pendingAdvisoryMessages = [
			'AC10 probe advisory: architect guardrail guidance must stay visible',
		];

		// 2. messages.transform injects the architect guidance kinds.
		const messages: PartsMessage[] = [
			{
				info: { id: 'u1', role: 'user', sessionID: s, agent: 'architect' },
				parts: [{ type: 'text', text: 'hi' }],
			},
		];
		await booted.hooks['experimental.chat.messages.transform'](
			{},
			{ messages },
		);
		const transformedText = joinedMessageText(messages);
		// ARCHITECT WORKFLOW REMINDER (pipeline tracker, prepended to the
		// last user message).
		expect(transformedText).toContain('ARCHITECT WORKFLOW REMINDER');
		// Architect-session directives (PLANNING PROFILE) ride the trailing
		// user-role guidance carrier.
		expect(transformedText).toContain('PLANNING PROFILE');
		const architectSessionCarrier = messages.find(
			(message) => message.info.id === 'swarm-guidance:architect-session',
		);
		expect(architectSessionCarrier).toBeDefined();
		expect(architectSessionCarrier?.info.role).toBe('user');
		expect(
			(architectSessionCarrier?.parts ?? [])
				.map((part) => part.text ?? '')
				.join('\n'),
		).toContain('PLANNING PROFILE');
		// The other two architect guidance kinds stay delivered.
		expect(transformedText).toContain(
			'AC10 probe advisory: architect guardrail guidance must stay visible',
		);
		expect(transformedText).toContain('[NEXT]');

		// 3. system.transform for the session-bound architect: the system
		// surface is byte-stable (single delivery owner is the messages
		// carrier — nothing appended, header preserved).
		const system = ['base system seed'];
		await booted.hooks['experimental.chat.system.transform'](
			{
				sessionID: s,
				model: {
					id: 'qwen3.6-32b',
					providerID: 'vllm-local',
					api: {
						id: 'openai-compatible',
						url: 'http://127.0.0.1:8000/v1',
						npm: '@ai-sdk/openai-compatible',
					},
				},
			},
			{ system },
		);
		expect(system).toEqual(['base system seed']);

		// 4. Task-tool completion hands the session back to the architect.
		await booted.hooks['tool.execute.after'](
			{
				tool: 'task',
				sessionID: s,
				callID: 'ac10-task-completion-1',
				args: { prompt: 'Implement the task', subagent_type: 'coder' },
			},
			{ title: 'Task completed', output: 'done', metadata: null },
		);
		expect(swarmState.activeAgent.get(s)).toBe('architect');

		// 5. The architect write gate still blocks the verifier-owned config
		// file biome.json.
		await expect(
			booted.hooks['tool.execute.before'](
				{ tool: 'write', sessionID: s, callID: 'ac10-write-biome-1' },
				{ args: { filePath: 'biome.json', content: '{}' } },
			),
		).rejects.toThrow('WRITE BLOCKED: Agent "architect"');
	}, 120_000);
});
