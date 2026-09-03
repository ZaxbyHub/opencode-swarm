/**
 * Issue #2526 exit gate: guidance injected by the plugin's REGISTERED
 * `experimental.chat.messages.transform` chain must be present in the messages
 * the pinned host actually renders into the model request.
 *
 * This drives the real composed handler (`bootKnowledgeHost` boots the plugin
 * via `OpenCodeSwarmPlugin.server(...)` and returns the registered hooks), then
 * converts the result with the pinned host-contract distillation
 * (`tests/helpers/host-contract-v1_18_3.ts`). Before #2526 every one of these
 * injections rode a role:'system' entry that the host silently discarded (or,
 * for issue-trace's flat entries, crashed the prompt build with a TypeError).
 *
 * Legs (per the issue's required tests):
 *  1. a guardrail advisory (session advisory queue drained by the guardrails
 *     handler inside the composed chain),
 *  2. a knowledge recall (architect-tier entry retrieved from the real
 *     .swarm/knowledge.jsonl store),
 *  3. a memory recall (record written through the real sqlite memory provider,
 *     recalled through the real gateway),
 *  4. a --trace turn (issue-reference + spec + trace state) that completes
 *     with the [MODE: ...] directive delivered.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { resolveMemoryConfig } from '../../../src/memory/config';
import {
	createConfiguredMemoryProvider,
	MemoryGateway,
} from '../../../src/memory/gateway';
import {
	computeMemoryContentHash,
	createMemoryId,
} from '../../../src/memory/schema';
import type { MemoryRecord } from '../../../src/memory/types';
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
import { withFrozenClock } from '../../helpers/test-clock';

const SESSION_ID = 'rendered-guidance-2526';
// Distinctive token shared by the user message, the knowledge lesson, and the
// memory record so retrieval scoring cannot miss on vocabulary overlap.
const KEYWORD = 'orbit-flanger';

function userMessage(text: string, id: string): HostPartsMessage {
	return {
		info: { id, role: 'user', agent: 'architect', sessionID: SESSION_ID },
		parts: [{ type: 'text', text }],
	};
}

function assistantMessage(text: string, id: string): HostPartsMessage {
	return {
		info: { id, role: 'assistant', agent: 'architect', sessionID: SESSION_ID },
		parts: [{ type: 'text', text }],
	};
}

function seedKnowledgeEntry(directory: string): void {
	// Mirrors the seeding shape used by tests/integration/architect-delegation-injection.test.ts
	// (schema v2 entry, normalized on read). Architect-targeted so the
	// architect-side injection path retrieves it.
	const entry = {
		id: 'b7e5c1a2-0000-4000-8000-252600000001',
		tier: 'swarm',
		lesson: `Always run the ${KEYWORD} smoke gate before merging database changes.`,
		category: 'process',
		tags: ['fixture'],
		scope: 'global',
		confidence: 0.9,
		status: 'established',
		confirmed_by: [
			{
				phase_number: 1,
				confirmed_at: '2026-01-01T00:00:00.000Z',
				project_name: 'rendered-guidance-2526',
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
		project_name: 'rendered-guidance-2526',
		applies_to_agents: ['architect'],
		forbidden_actions: [`skip the ${KEYWORD} smoke gate`],
		directive_priority: 'critical',
	};
	writeFileSync(
		path.join(directory, '.swarm', 'knowledge.jsonl'),
		JSON.stringify(entry),
		'utf-8',
	);
}

async function seedMemoryRecordAsync(
	directory: string,
	sessionId: string,
): Promise<void> {
	const config = resolveMemoryConfig({ enabled: true });
	const context = {
		directory,
		sessionID: sessionId,
		agentRole: 'architect',
		agentId: 'architect',
		runId: sessionId,
	};
	const probe = new MemoryGateway(context, { config });
	const scopes = probe.deriveAllowedScopes();
	probe.dispose();
	const repositoryScope =
		scopes.find((s) => s.type === 'repository') ?? scopes[0]!;
	// Deterministic stamp: real-host tests must not read the wall clock
	// (check-test-clock).
	const now = withFrozenClock(() => new Date().toISOString());
	const text = `The ${KEYWORD} pipeline requires bun test before every release cut.`;
	const record: MemoryRecord = {
		id: createMemoryId({ scope: repositoryScope, kind: 'project_fact', text }),
		scope: repositoryScope,
		kind: 'project_fact',
		text,
		tags: ['fixture'],
		confidence: 0.9,
		stability: 'durable',
		source: { type: 'manual', ref: 'issue-2526-exit-gate' },
		createdAt: now,
		updatedAt: now,
		contentHash: computeMemoryContentHash({
			scope: repositoryScope,
			kind: 'project_fact',
			text,
		}),
		metadata: {},
	};
	const provider = createConfiguredMemoryProvider(directory, config);
	await provider.upsert(record);
}

function writeJson(directory: string, name: string, value: unknown): void {
	writeFileSync(
		path.join(directory, '.swarm', name),
		JSON.stringify(value, null, 2),
		'utf-8',
	);
}

describe('host-rendered guidance (issue #2526 exit gate)', () => {
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

	test('guardrail advisory, knowledge recall and memory recall each render', async () => {
		seedKnowledgeEntry(directory);
		await seedMemoryRecordAsync(directory, SESSION_ID);

		// Hermeticity only: the schema default already enables guardrails
		// (GuardrailsConfigSchema.enabled defaults to true), but the loader
		// deep-merges the USER-LEVEL config under the project config, and a
		// developer machine with `guardrails.enabled: false` there would
		// otherwise leak into this test through the boot's guardrails-less
		// project config. The explicit override pins the intended posture.
		const plugin = await bootKnowledgeHost(directory, {
			memory: { enabled: true },
			guardrails: { enabled: true },
		});

		ensureAgentSession(SESSION_ID, 'architect', directory);
		swarmState.activeAgent.set(SESSION_ID, 'architect');
		const session = swarmState.agentSessions.get(SESSION_ID)!;
		session.pendingAdvisoryMessages = [
			`DEGRADED: ${KEYWORD} context-limit error detected. No fallback models available.`,
		];

		const messages: HostPartsMessage[] = [
			userMessage(`Please handle the ${KEYWORD} release checklist.`, 'u1'),
			assistantMessage('Working on it.', 'a1'),
			userMessage(`Continue the ${KEYWORD} release checklist.`, 'u2'),
		];
		await plugin.hooks['experimental.chat.messages.transform'](
			{},
			{ messages: messages as never },
		);

		// The transform must leave no role:'system' entries (the host drops them).
		expect(
			messages.every(
				(m) =>
					(m as unknown as { info?: { role?: string } }).info?.role !==
					'system',
			),
		).toBe(true);

		const rendered = hostToModelMessages(messages);
		const text = renderedText(rendered);
		expect(text.length).toBeGreaterThan(0);

		// 1. guardrail advisory
		expect(text).toContain('DEGRADED:');
		// 2. knowledge recall (lesson text from the real store)
		expect(text.toLowerCase()).toContain(KEYWORD);
		expect(text).toContain('smoke gate');
		// 3. memory recall (record from the real sqlite provider)
		expect(text).toContain('bun test before every release cut');
	});

	test('a --trace turn completes with the MODE directive delivered (no TypeError)', async () => {
		// Spec + issue reference + trace state drive the reducer; the boot's
		// approved plan routes it to the EXECUTE transition on first drive.
		writeJson(directory, 'issue-reference.json', {
			url: 'https://github.com/owner/repo/issues/4242',
			owner: 'owner',
			repo: 'repo',
			number: 4242,
			timestamp: '2026-01-01T00:00:00Z',
			flags: { trace: true, noRepro: true },
		});
		writeJson(directory, 'issue-trace-state.json', {
			issueNumber: 4242,
			lastTransition: null,
			status: 'in_progress',
		});
		writeFileSync(
			path.join(directory, '.swarm', 'spec.md'),
			'# Spec\n\n## Source Issue\n\n- Number: 4242\n\n## Details\n',
			'utf-8',
		);

		const plugin = await bootKnowledgeHost(directory);
		ensureAgentSession(SESSION_ID, 'architect', directory);
		swarmState.activeAgent.set(SESSION_ID, 'architect');

		const messages: HostPartsMessage[] = [
			userMessage('next step please', 'u1'),
		];

		// Pre-#2526 this exact turn threw inside the host converter because
		// issue-trace pushed flat {role:'system', content:[...]} entries.
		await plugin.hooks['experimental.chat.messages.transform'](
			{},
			{ messages: messages as never },
		);

		let rendered;
		expect(() => {
			rendered = hostToModelMessages(messages);
		}).not.toThrow();
		const text = renderedText(rendered ?? []);
		expect(text).toMatch(/\[MODE: [A-Z_]+\]/);
	});
});
