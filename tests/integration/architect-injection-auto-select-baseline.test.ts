/**
 * Issue #3320 AC11 — auto_select_architect sessions keep ALL architect
 * injections. GREEN at base and head.
 *
 * Regression floor for the fix, auto-select variant: with
 * `auto_select_architect: true` the swarm's architect is the primary agent,
 * and a `chat.message` carrying NO agent field records the architect
 * takeover for the session (the delegation tracker's no-agent branch sets
 * the orchestrator). The #3320 sessionless-guard fix must not narrow what
 * such a session receives.
 *
 * Drives the REAL registered plugin host booted with
 * `{ auto_select_architect: true }`, then asserts in the pinned host order:
 *
 *  - `chat.message` with NO agent makes `swarmState.activeAgent` 'architect'.
 *  - the following messages.transform injects ALL FOUR architect guidance
 *    kinds: the ARCHITECT WORKFLOW REMINDER, the guardrails text (advisory
 *    carrier), the delegation directive, and the architect-session
 *    (PLANNING PROFILE) directives.
 *
 * Every assertion below passes at the base commit; the file exists so the
 * fix cannot regress the auto-select path.
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

describe('auto_select_architect session keeps all architect injections (#3320 AC11)', () => {
	let directory: string;
	let booted: BootedPluginHost;
	let isolatedEnv: ReturnType<typeof createIsolatedTestEnv>;

	beforeAll(async () => {
		isolatedEnv = createIsolatedTestEnv();
		directory = createPluginHostProject('architect-autoselect-3320');
		booted = await bootSwarmPluginHost(directory, {
			version_check: false,
			auto_select_architect: true,
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

	test('no-agent chat.message selects the architect and messages.transform injects all four architect kinds', async () => {
		const s = 'ac11-autoselect-architect';

		// 1. NO agent field on chat.message: the architect takes the turn.
		await booted.hooks['chat.message'](
			{ sessionID: s },
			{ message: { id: 'm1', role: 'user' } },
		);
		expect(swarmState.activeAgent.get(s)).toBe('architect');

		// Seed one pending guardrail advisory so the guardrails guidance
		// carrier carries observable content this turn (same seeding path as
		// tests/unit/hooks/host-rendered-request-2526.test.ts).
		const session = swarmState.agentSessions.get(s);
		expect(session).toBeDefined();
		session!.pendingAdvisoryMessages = [
			'AC11 probe advisory: architect guardrail guidance must stay visible',
		];

		// 2. messages.transform injects all four architect guidance kinds.
		const messages: PartsMessage[] = [
			{
				info: { id: 'u1', role: 'user', sessionID: s },
				parts: [{ type: 'text', text: 'hi' }],
			},
		];
		await booted.hooks['experimental.chat.messages.transform'](
			{},
			{ messages },
		);

		// (i) ARCHITECT WORKFLOW REMINDER (pipeline tracker, prepended to the
		// last user message — agent-less user messages are architect turns).
		expect(joinedMessageText(messages)).toContain(
			'ARCHITECT WORKFLOW REMINDER',
		);

		// (ii) Guardrails text (advisory guidance carrier).
		const guardrailsCarrier = messages.find(
			(message) => message.info.id === 'swarm-guidance:guardrails',
		);
		expect(guardrailsCarrier).toBeDefined();
		expect(guardrailsCarrier?.info.role).toBe('user');
		expect(
			(guardrailsCarrier?.parts ?? [])
				.map((part) => part.text ?? '')
				.join('\n'),
		).toContain(
			'AC11 probe advisory: architect guardrail guidance must stay visible',
		);

		// (iii) Delegation directive ([NEXT] guidance carrier).
		const delegationCarrier = messages.find(
			(message) => message.info.id === 'swarm-guidance:delegation',
		);
		expect(delegationCarrier).toBeDefined();
		expect(
			(delegationCarrier?.parts ?? [])
				.map((part) => part.text ?? '')
				.join('\n'),
		).toContain('[NEXT] Begin the first plan task');

		// (iv) Architect-session (PLANNING PROFILE) directives.
		const architectSessionCarrier = messages.find(
			(message) => message.info.id === 'swarm-guidance:architect-session',
		);
		expect(architectSessionCarrier).toBeDefined();
		expect(architectSessionCarrier?.info.role).toBe('user');
		const architectSessionText = (architectSessionCarrier?.parts ?? [])
			.map((part) => part.text ?? '')
			.join('\n');
		expect(architectSessionText).toContain('PLANNING PROFILE');
	}, 120_000);
});
