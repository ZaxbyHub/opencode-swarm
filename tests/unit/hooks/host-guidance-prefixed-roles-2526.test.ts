/**
 * Issue #2526 residual closure (AC3): guidance delivery through the REAL
 * composed `experimental.chat.messages.transform` chain for the two role
 * surfaces the exit-gate test (`host-rendered-guidance-2526.test.ts`) and the
 * OBE check never exercised — both use plain `agent: 'architect'` only:
 *
 *  (a) a MULTI-SWARM PREFIXED architect surface (`agent: 'mega_architect'`,
 *      carried both on `info.agent` and on `swarmState.activeAgent`) — the
 *      surface real multi-swarm configs (`swarms: { mega: ... }`) register.
 *      `stripKnownSwarmPrefix` must canonicalize it to `architect` so the
 *      guardrail advisory drain (architect branch) and the orchestrator
 *      knowledge path both fire.
 *  (b) a NON-ARCHITECT CHILD ROLE (`agent: 'coder'`, distinct sessionID) —
 *      the advisory drain's non-architect branch forwards only TRANSIENT
 *      advisories (`DEGRADED:` is one), and knowledge rides the delegate
 *      directive path scoped by `applies_to_agents`.
 *
 * For each surface: the intended guidance (the `DEGRADED:` advisory line and
 * the knowledge lesson keyword) must be present in the request the pinned
 * host renders (`hostToModelMessages` + `renderedText`), the transform output
 * must contain NO `role:'system'` entries (the pinned host drops them — see
 * `tests/helpers/host-contract-v1_18_3.ts`), and the conversion must not
 * throw.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
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
	bootKnowledgeHost,
	createKnowledgeProject,
} from '../../helpers/knowledge-real-host';
import { safeRmRecursive } from '../../helpers/safe-test-dir';

/** Distinctive token shared by the user messages and the seeded lessons. */
const KEYWORD = 'orbit-flanger-prefixed';

/** Schema-v2 knowledge entry shape (mirrors the sibling exit-gate test). */
function seedKnowledgeEntry(
	directory: string,
	id: string,
	lesson: string,
	appliesTo: string,
): void {
	const entry = {
		id,
		tier: 'swarm',
		lesson,
		category: 'process',
		tags: ['fixture'],
		scope: 'global',
		confidence: 0.9,
		status: 'established',
		confirmed_by: [
			{
				phase_number: 1,
				confirmed_at: '2026-01-01T00:00:00.000Z',
				project_name: 'prefixed-roles-2526',
			},
		],
		retrieval_outcomes: {
			applied_count: 0,
			succeeded_after_count: 0,
			failed_after_count: 0,
		},
		schema_version: 2,
		created_at: '2026-01-01T00:00:00.000Z',
		updated_at: '2026-01-01T00:00:00.000Z',
		project_name: 'prefixed-roles-2526',
		applies_to_agents: [appliesTo],
		forbidden_actions: [`skip the ${KEYWORD} gate`],
		directive_priority: 'critical',
	};
	writeFileSync(
		path.join(directory, '.swarm', 'knowledge.jsonl'),
		JSON.stringify(entry),
		'utf-8',
	);
}

function userMessage(
	text: string,
	id: string,
	agent: string,
	session: string,
): HostPartsMessage {
	return {
		info: { id, role: 'user', agent, sessionID: session },
		parts: [{ type: 'text', text }],
	};
}

function assistantMessage(
	text: string,
	id: string,
	agent: string,
	session: string,
): HostPartsMessage {
	return {
		info: { id, role: 'assistant', agent, sessionID: session },
		parts: [{ type: 'text', text }],
	};
}

function hasNoSystemEntries(messages: HostPartsMessage[]): boolean {
	return messages.every(
		(m) =>
			(m as unknown as { info?: { role?: string } }).info?.role !== 'system',
	);
}

describe('host-rendered guidance on prefixed + child role surfaces (issue #2526 AC3)', () => {
	let directory = '';

	beforeEach(() => {
		resetSwarmState();
		directory = createKnowledgeProject();
	});

	afterEach(() => {
		resetSwarmState();
		try {
			safeRmRecursive(directory);
		} catch {
			// Best-effort teardown only (Windows EBUSY from background workers).
		}
	});

	test('multi-swarm prefixed architect (mega_architect) receives advisory + knowledge in the rendered request', async () => {
		seedKnowledgeEntry(
			directory,
			'b7e5c1a2-0000-4000-8000-2526000000a1',
			`Always run the ${KEYWORD} smoke gate before merging database changes.`,
			'architect',
		);

		// Hermeticity: pin guardrails on (a developer machine's user-level
		// `guardrails.enabled: false` must not leak through the deep-merged
		// loader — same posture as the sibling exit-gate test).
		const plugin = await bootKnowledgeHost(directory, {
			guardrails: { enabled: true },
		});

		const sessionId = 'prefixed-mega-2526';
		ensureAgentSession(sessionId, 'mega_architect', directory);
		swarmState.activeAgent.set(sessionId, 'mega_architect');
		const session = swarmState.agentSessions.get(sessionId)!;
		session.pendingAdvisoryMessages = [
			`DEGRADED: ${KEYWORD} context-limit error detected. No fallback models available.`,
		];

		const messages: HostPartsMessage[] = [
			userMessage(
				`Please handle the ${KEYWORD} release checklist.`,
				'u1',
				'mega_architect',
				sessionId,
			),
			assistantMessage('Working on it.', 'a1', 'mega_architect', sessionId),
			userMessage(
				`Continue the ${KEYWORD} release checklist.`,
				'u2',
				'mega_architect',
				sessionId,
			),
		];
		await plugin.hooks['experimental.chat.messages.transform'](
			{},
			{ messages: messages as never },
		);

		expect(hasNoSystemEntries(messages)).toBe(true);

		let rendered;
		expect(() => {
			rendered = hostToModelMessages(messages);
		}).not.toThrow();
		const text = renderedText(rendered ?? []);
		expect(text.length).toBeGreaterThan(0);

		// Guardrail advisory reached the rendered request through the
		// architect advisory drain (prefix-stripped role recognition).
		expect(text).toContain('DEGRADED:');
		expect(text).toContain(`${KEYWORD} context-limit error detected`);
		// Knowledge recall reached the rendered request through the
		// orchestrator injection path.
		expect(text).toContain(`${KEYWORD} smoke gate`);
		expect(text).toContain('<swarm_knowledge_directives>');
	});

	test('non-architect child role (coder) receives the transient advisory + delegate knowledge in the rendered request', async () => {
		seedKnowledgeEntry(
			directory,
			'b7e5c1a2-0000-4000-8000-2526000000c2',
			`Coder must run the ${KEYWORD} unit sweep after every patch.`,
			'coder',
		);

		const plugin = await bootKnowledgeHost(directory, {
			guardrails: { enabled: true },
		});

		// Distinct sessionID from the architect leg — child-role sessions are
		// their own surface, never a reuse of the orchestrator's session state.
		const sessionId = 'child-coder-2526';
		ensureAgentSession(sessionId, 'coder', directory);
		swarmState.activeAgent.set(sessionId, 'coder');
		const session = swarmState.agentSessions.get(sessionId)!;
		// `DEGRADED:` is a TRANSIENT_PREFIX; the non-architect advisory drain
		// forwards exactly those (non-transient advisories are discarded for
		// subagent sessions — see guardrails/messages-transform.ts).
		session.pendingAdvisoryMessages = [
			`DEGRADED: ${KEYWORD} provider 503 detected. Retrying.`,
		];

		const messages: HostPartsMessage[] = [
			userMessage(
				`Implement the ${KEYWORD} checklist item.`,
				'u1',
				'coder',
				sessionId,
			),
			assistantMessage('On it.', 'a1', 'coder', sessionId),
			userMessage(`Continue the ${KEYWORD} work.`, 'u2', 'coder', sessionId),
		];
		await plugin.hooks['experimental.chat.messages.transform'](
			{},
			{ messages: messages as never },
		);

		expect(hasNoSystemEntries(messages)).toBe(true);

		let rendered;
		expect(() => {
			rendered = hostToModelMessages(messages);
		}).not.toThrow();
		const text = renderedText(rendered ?? []);
		expect(text.length).toBeGreaterThan(0);

		// Transient guardrail advisory forwarded to the child-role session.
		expect(text).toContain('DEGRADED:');
		expect(text).toContain(`${KEYWORD} provider 503 detected`);
		// Delegate-path knowledge directives scoped to the coder role.
		expect(text).toContain(`${KEYWORD} unit sweep`);
		expect(text).toContain('<delegate_knowledge_directives>');
	});
});
