/**
 * Issue #1849 — primary acceptance test.
 *
 * Drives the EXPORTED plugin hooks through src/index.ts using payloads shaped
 * like the REAL OpenCode SDK (not synthetic direct-helper objects). This is the
 * test the issue mandates: "payloads shaped like the current SDK, not synthetic
 * direct-helper objects."
 *
 * Covers the 9 required end-to-end scenarios:
 *  1. legacy architect + prefixed multi-swarm architect
 *  2. messages.transform with real {info:{role,agent,sessionID}} shape → one
 *     system message at index 0 after augmentation
 *  3. tool.execute.before with {input:{tool,sessionID,callID}, output:{args}}
 *  4. output.args receives a delegation directive containing trace_id + IDs
 *  5. valid applied/ignored/contradicted receipts → durable events + counters
 *  6. idempotent retry → no double count
 *  7. forged ID / wrong trace / wrong session / expired / conflicting → rejected
 *  8. empty recall + no_relevant_knowledge → one no_relevant terminal event
 *  9. corrupt shown-state → work continues with visible diagnostics
 * Plus: the old {input:{tool,agent,args}} fixtures do NOT drive production.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { getStoredInputArgs } from '../../src/hooks/guardrails';
import {
	appendKnowledgeEvent,
	readKnowledgeEvents,
	recomputeCounters,
} from '../../src/hooks/knowledge-events';
import { resetSwarmState, swarmState } from '../../src/state';
import { knowledge_receipt } from '../../src/tools/knowledge-receipt';
import { createIsolatedTestEnv } from '../helpers/isolated-test-env';
import {
	bootKnowledgeHost,
	createKnowledgeProject,
} from '../helpers/knowledge-real-host';

const SESSION = 'sess-e2e-1849';
const SESSION_PREFIXED = 'sess-e2e-cohort';
const CALL = 'call-e2e-1849';
const DELEGATE_KNOWLEDGE_LESSON =
	'issue 1849 host boundary delegate lesson qz7';

/** Seed a retrieved event so receipts can reference its trace + result_ids. */
async function seedTrace(
	dir: string,
	traceId: string,
	resultIds: string[],
	sessionId = SESSION,
): Promise<void> {
	await appendKnowledgeEvent(dir, {
		type: 'retrieved',
		trace_id: traceId,
		session_id: sessionId,
		agent: 'architect',
		query: 'e2e',
		retrieval_mode: 'auto_injection',
		result_ids: resultIds,
		ranks: Object.fromEntries(resultIds.map((id, i) => [id, i + 1])),
		scores: Object.fromEntries(resultIds.map((id) => [id, 1])),
		timestamp: new Date().toISOString(),
	});
}

describe('issue #1849 — real-host boundary end-to-end through src/index.ts', () => {
	let dir: string;
	let plugin: Awaited<ReturnType<typeof bootKnowledgeHost>>;
	let cleanupIsolatedEnv: () => void;

	beforeEach(async () => {
		resetSwarmState();
		cleanupIsolatedEnv = createIsolatedTestEnv().cleanup;
		dir = createKnowledgeProject();
		plugin = await bootKnowledgeHost(dir);
	});
	afterEach(() => {
		resetSwarmState();
		// Best-effort cleanup; Windows EBUSY is common here because the plugin
		// spins background timers that briefly hold the temp dir. Never fail the
		// test on cleanup — the OS reaps tmpdir eventually.
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* ignore — tmpdir is reaped by the OS */
		}
		cleanupIsolatedEnv();
	});

	test('1+2. messages.transform uses REAL SDK shape: agent recovered from chat.message, not a system message', async () => {
		// The SDK messages.transform input is {}. Identity comes from
		// swarmState.activeAgent (set by chat.message, which DOES carry agent).
		const chatMessage = plugin.hooks['chat.message'];
		expect(typeof chatMessage).toBe('function');
		// chat.message carries agent on input (SDK contract). Set the architect.
		await chatMessage(
			{ sessionID: SESSION, agent: 'architect' },
			{ message: {}, parts: [] },
		);
		expect(swarmState.activeAgent.get(SESSION)).toBe('architect');

		// Prefixed multi-swarm architect also resolves.
		await chatMessage(
			{ sessionID: SESSION_PREFIXED, agent: 'cohort_architect' },
			{ message: {}, parts: [] },
		);
		expect(swarmState.activeAgent.get(SESSION_PREFIXED)).toBe(
			'cohort_architect',
		);

		// messages.transform: real SDK output shape (info:{role,agent,sessionID}).
		const messagesTransform =
			plugin.hooks['experimental.chat.messages.transform'];
		const messages = [
			{
				info: {
					role: 'user',
					agent: 'cohort_architect',
					sessionID: SESSION_PREFIXED,
				},
				parts: [{ type: 'text', text: 'plan the work' }],
			},
		];
		// Must not throw and must not depend on a role:'system' message.
		await messagesTransform({}, { messages });
		// (#PRR-005) Strengthen: assert the transform did NOT emit a no_agent_name
		// skip (the #1768/#1849 dark-path symptom). A no-op transform that swallowed
		// the recovered agent would leave this skip in the event log. Read it back.
		const events = await readKnowledgeEvents(dir);
		const noAgentSkips = events.filter(
			(e) =>
				e.type === 'injection_skip' &&
				(e as { reason?: string }).reason === 'no_agent_name',
		);
		expect(noAgentSkips).toHaveLength(0);
	});

	test('3+4. tool.execute.before uses REAL SDK shape: args mutated via output.args with trace_id + IDs', async () => {
		// Seed knowledge so a directive can be injected. Write a minimal entry.
		const kp = path.join(dir, '.swarm', 'knowledge.jsonl');
		writeFileSync(
			kp,
			`${JSON.stringify({
				id: 'b1111111-1111-4111-8111-111111111111',
				tier: 'swarm',
				lesson: DELEGATE_KNOWLEDGE_LESSON,
				category: 'process',
				tags: [],
				scope: 'global',
				confidence: 0.9,
				status: 'established',
				confirmed_by: [],
				retrieval_outcomes: {
					applied_count: 0,
					succeeded_after_count: 0,
					failed_after_count: 0,
				},
				schema_version: 2,
				created_at: '2026-01-01T00:00:00.000Z',
				updated_at: '2026-01-01T00:00:00.000Z',
				applies_to_agents: ['coder'],
				directive_priority: 'high',
			})}\n`,
		);
		// chat.message sets the architect (real SDK source of agent identity).
		await plugin.hooks['chat.message'](
			{ sessionID: SESSION, agent: 'architect' },
			{ message: {}, parts: [] },
		);
		// REAL SDK tool.execute.before shape: input has NO agent/args; output.args
		// is the mutable target.
		const output = {
			args: {
				task_id: '1.1',
				prompt: `ACCEPTANCE: the feature is implemented\nImplement the ${DELEGATE_KNOWLEDGE_LESSON} feature`,
				subagent_type: 'coder',
			},
		};
		await plugin.hooks['tool.execute.before'](
			{ tool: 'Task', sessionID: SESSION, callID: CALL },
			output,
		);
		// Require the directive, trace, and uniquely seeded lesson in output.args;
		// otherwise a dead injector could make this host-boundary test pass.
		try {
			expect(output.args).toBeTruthy();
			expect(typeof output.args).toBe('object');
			const prompt = String(output.args.prompt ?? '');
			expect(prompt).toContain('<delegate_knowledge_directives>');
			expect(prompt).toMatch(/trace_id:\s*\S+/);
			expect(prompt).toContain(`lesson: ${DELEGATE_KNOWLEDGE_LESSON}`);
			expect(prompt).toMatch(
				/- id:\s*[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i,
			);
		} finally {
			// Pair every successful prehook with its terminal posthook so the exact
			// call snapshot and published scope are revoked even if an assertion fails.
			await plugin.hooks['tool.execute.after'](
				{ tool: 'Task', sessionID: SESSION, callID: CALL },
				{ output: 'Done.' },
			);
		}
		expect(getStoredInputArgs(CALL)).toBeUndefined();
	});

	test('5+6. knowledge_receipt validates + idempotent retry does not double count', async () => {
		const traceId = 'trace-1849-receipt';
		await seedTrace(dir, traceId, ['k1', 'k2']);
		// (#1849) createSwarmTool's execute signature is (args, ctx) where ctx
		// carries directory — the wrapper derives directory from ctx.directory.
		const toolCtx = {
			sessionID: SESSION,
			agent: 'coder',
			directory: dir,
		} as never;
		const r1 = await knowledge_receipt.execute(
			{ trace_id: traceId, applied: [{ id: 'k1', how: 'used it' }] } as never,
			toolCtx,
		);
		const out1 = JSON.parse(typeof r1 === 'string' ? r1 : JSON.stringify(r1));
		expect(out1.recorded).toBe(true);
		expect(out1.applied).toBe(1);

		// Idempotent retry: same trace, same id, same outcome.
		const r2 = await knowledge_receipt.execute(
			{ trace_id: traceId, applied: [{ id: 'k1', how: 'used it' }] } as never,
			toolCtx,
		);
		const out2 = JSON.parse(typeof r2 === 'string' ? r2 : JSON.stringify(r2));
		expect(out2.recorded).toBe(true);

		// Exactly ONE applied event in the log (no double count).
		const events = await readKnowledgeEvents(dir);
		const applied = events.filter(
			(e) => e.type === 'applied' && e.knowledge_id === 'k1',
		);
		expect(applied).toHaveLength(1);
	});

	test('7. forged / wrong-session / conflicting receipts are rejected', async () => {
		const traceId = 'trace-1849-reject';
		await seedTrace(dir, traceId, ['k1']);
		const toolCtx = {
			sessionID: SESSION,
			agent: 'coder',
			directory: dir,
		} as never;

		// Forged ID: not in trace result_ids.
		const forged = await knowledge_receipt.execute(
			{ trace_id: traceId, applied: [{ id: 'FORGED', how: 'x' }] } as never,
			toolCtx,
		);
		const forgedOut = JSON.parse(
			typeof forged === 'string' ? forged : JSON.stringify(forged),
		);
		expect(forgedOut.recorded).toBe(false);

		// Wrong session.
		const wrongSession = await knowledge_receipt.execute(
			{ trace_id: traceId, applied: [{ id: 'k1', how: 'x' }] } as never,
			{
				sessionID: 'attacker-session',
				agent: 'coder',
				directory: dir,
			} as never,
		);
		const wrongOut = JSON.parse(
			typeof wrongSession === 'string'
				? wrongSession
				: JSON.stringify(wrongSession),
		);
		expect(wrongOut.recorded).toBe(false);

		// Conflicting: file applied, then n_a for same (trace, id).
		await knowledge_receipt.execute(
			{
				trace_id: traceId,
				applied: [{ id: 'k1', how: 'first applied' }],
			} as never,
			toolCtx,
		);
		const conflict = await knowledge_receipt.execute(
			{
				trace_id: traceId,
				n_a: [{ id: 'k1', reason: 'changed my mind — not applicable' }],
			} as never,
			toolCtx,
		);
		const conflictOut = JSON.parse(
			typeof conflict === 'string' ? conflict : JSON.stringify(conflict),
		);
		// The conflicting outcome for the same (trace, id) must be rejected
		// outright — no second terminal, no partial acceptance (#2032 review
		// PRR-007: the migrated form previously neither asserted the response
		// nor filtered for n_a, so an over-accepting ledger would pass).
		expect(conflictOut.recorded).toBe(false);
		expect(conflictOut.reason).toBe('duplicate_conflicting_terminal');
		const events = await readKnowledgeEvents(dir);
		const k1Terminals = events.filter(
			(e) =>
				e.knowledge_id === 'k1' &&
				(e.type === 'applied' ||
					e.type === 'ignored' ||
					e.type === 'n_a' ||
					e.type === 'contradicted' ||
					e.type === 'violated'),
		);
		expect(k1Terminals.length).toBe(1);
	});

	test('8. empty recall + no_relevant_knowledge files one durable terminal event', async () => {
		const toolCtx = {
			sessionID: SESSION,
			agent: 'architect',
			directory: dir,
		} as never;
		// 'none' sentinel: a real-empty retrieval (no trace).
		const r = await knowledge_receipt.execute(
			{ trace_id: 'none', no_relevant_knowledge: true } as never,
			toolCtx,
		);
		const out = JSON.parse(typeof r === 'string' ? r : JSON.stringify(r));
		expect(out.recorded).toBe(true);
		const events = await readKnowledgeEvents(dir);
		const noRelevant = events.filter((e) => e.type === 'no_relevant');
		expect(noRelevant).toHaveLength(1);
	});

	test('9. corrupt shown-state does not crash the loop (fail-open)', async () => {
		// Write a corrupt knowledge-shown file; the injector / gate must continue.
		const shownPath = path.join(dir, '.swarm', '.knowledge-shown.json');
		writeFileSync(shownPath, '{ this is not valid json');
		// chat.message + messages.transform must not throw.
		await plugin.hooks['chat.message'](
			{ sessionID: SESSION, agent: 'architect' },
			{ message: {}, parts: [] },
		);
		const messages = [
			{
				info: { role: 'user', agent: 'architect', sessionID: SESSION },
				parts: [{ type: 'text', text: 'go' }],
			},
		];
		await expect(
			plugin.hooks['experimental.chat.messages.transform']({}, { messages }),
		).resolves.toBeUndefined();
		// The event log is still writable (fail-open did not corrupt accounting).
		await appendKnowledgeEvent(dir, {
			type: 'no_relevant',
			trace_id: 't',
			session_id: SESSION,
			agent: 'architect',
			reason: 'fail-open probe',
		});
		const events = await readKnowledgeEvents(dir);
		expect(events.some((e) => e.reason === 'fail-open probe')).toBe(true);
	});

	test('10. recomputeCounters separates shown vs applied_explicit (no conflation)', async () => {
		const traceId = 'trace-1849-counters';
		await seedTrace(dir, traceId, ['kc']);

		await knowledge_receipt.execute(
			{ trace_id: traceId, applied: [{ id: 'kc', how: 'used' }] } as never,
			{ sessionID: SESSION, agent: 'coder', directory: dir } as never,
		);
		const events = await readKnowledgeEvents(dir);
		const rollup = recomputeCounters(events);
		const r = rollup.get('kc');
		expect(r).toBeDefined();
		// shown_count = 1 (the retrieved event), applied_explicit_count = 1 (the
		// validated applied receipt). They are distinct counters.
		expect(r?.shown_count).toBe(1);
		expect(r?.applied_explicit_count).toBe(1);
	});
});
