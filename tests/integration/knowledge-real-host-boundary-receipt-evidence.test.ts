/**
 * Issue #1849 — real-host receipt reconciliation and promotion evidence.
 *
 * These scenarios exercise the exported plugin hooks with current OpenCode SDK
 * payloads and verify the durable evidence emitted after delegation.
 */

import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from 'bun:test';
import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { getStoredInputArgs } from '../../src/hooks/guardrails';
import {
	appendKnowledgeEvent,
	readKnowledgeEvents,
} from '../../src/hooks/knowledge-events';
import { resetSwarmState } from '../../src/state';
import { knowledge_receipt } from '../../src/tools/knowledge-receipt';
import { createIsolatedTestEnv } from '../helpers/isolated-test-env';
import {
	bootKnowledgeHost,
	createKnowledgeProject,
} from '../helpers/knowledge-real-host';
import { freezeClock } from '../helpers/test-clock.js';

const SESSION = 'sess-e2e-1849';
const CALL = 'call-e2e-1849';

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

describe('issue #1849 — real-host receipt evidence through src/index.ts', () => {
	let dir: string;
	let cleanupIsolatedEnv: () => void;
	let plugin: Awaited<ReturnType<typeof bootKnowledgeHost>>;
	let restoreClock: (() => void) | undefined;

	beforeAll(() => {
		cleanupIsolatedEnv = createIsolatedTestEnv().cleanup;
	});
	afterAll(() => {
		cleanupIsolatedEnv();
	});

	beforeEach(async () => {
		restoreClock = freezeClock({
			fixedNow: Date.parse('2026-08-13T00:00:00.000Z'),
			isoNow: '2026-08-13T00:00:00.000Z',
		});
		resetSwarmState();
		dir = createKnowledgeProject();
		plugin = await bootKnowledgeHost(dir);
	});
	afterEach(() => {
		try {
			resetSwarmState();
			// Best-effort cleanup; Windows EBUSY is common here because the plugin
			// spins background timers that briefly hold the temp dir. Never fail the
			// test on cleanup — the OS reaps tmpdir eventually.
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {
				/* ignore — tmpdir is reaped by the OS */
			}
		} finally {
			restoreClock?.();
			restoreClock = undefined;
		}
	});

	test('11. (#1849 R2) tool.execute.after reconciles delegate acks via REAL SDK shape (args from snapshot, not input)', async () => {
		// The SDK tool.execute.after input is {tool,sessionID,callID} — NO args.
		// The plugin must recover args from the callID snapshot taken in toolBefore.
		// Seed knowledge + a directive block so a delegate can ack it.
		const kp = path.join(dir, '.swarm', 'knowledge.jsonl');
		writeFileSync(
			kp,
			`${JSON.stringify({
				id: 'a1b2c3d4-e2e5-4184-9abc-def012345678',
				tier: 'swarm',
				lesson: 'e2e ack lesson',
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
				directive_priority: 'critical',
			})}\n`,
		);
		await plugin.hooks['chat.message'](
			{ sessionID: SESSION, agent: 'architect' },
			{ message: {}, parts: [] },
		);
		// tool.execute.before: real SDK shape. output.args holds the delegation
		// prompt. The fail-closed chain snapshots output.args via guardrails.
		const delegationPrompt = {
			task_id: '1.1',
			prompt:
				'ACCEPTANCE: the feature is implemented\nImplement the e2e ack lesson feature',
			subagent_type: 'user-chosen-42_coder',
		};
		const beforeOutput = { args: { ...delegationPrompt } };
		await plugin.hooks['tool.execute.before'](
			{ tool: 'Task', sessionID: SESSION, callID: CALL },
			beforeOutput,
		);
		let terminalOutput = 'Done.';
		try {
			const injectedPrompt = String(beforeOutput.args.prompt ?? '');
			expect(injectedPrompt).toContain('<delegate_knowledge_directives>');
			expect(injectedPrompt).toContain('a1b2c3d4-e2e5-4184-9abc-def012345678');
			const traceId = /trace_id:\s*(\S+)/.exec(injectedPrompt)?.[1];
			expect(traceId).toBeTruthy();
			if (!traceId) throw new Error('injected directive lacks trace_id');
			await seedTrace(dir, traceId, ['a1b2c3d4-e2e5-4184-9abc-def012345678']);
			terminalOutput =
				'Done.\nKNOWLEDGE_APPLIED:a1b2c3d4-e2e5-4184-9abc-def012345678';
		} finally {
			// The real host emits exactly one terminal posthook per successful prehook.
			await plugin.hooks['tool.execute.after'](
				{ tool: 'Task', sessionID: SESSION, callID: CALL },
				{ output: terminalOutput },
			);
		}
		expect(getStoredInputArgs(CALL)).toBeUndefined();
		// The ack was reconciled via the recovered prompt → an `applied` event
		// exists for the shown id (proving the after path is NOT dead).
		const events = await readKnowledgeEvents(dir);
		const applied = events.filter(
			(e) =>
				e.type === 'applied' &&
				e.knowledge_id === 'a1b2c3d4-e2e5-4184-9abc-def012345678',
		);
		expect(applied.length).toBeGreaterThanOrEqual(1);
	});

	test('12. (#PRR-004) knowledge_receipt writes a PromotionEvidenceRecord readable by loadPromotionEvidenceByEntry', async () => {
		const traceId = 'trace-1849-promo';
		const promoId = 'd1e2f3a4-b5c6-4789-9abc-def01234567e';
		await seedTrace(dir, traceId, [promoId]);
		const toolCtx = {
			sessionID: SESSION,
			agent: 'coder',
			directory: dir,
		} as never;
		// File a validated applied receipt — this should produce a
		// PromotionEvidenceRecord persisted to .swarm/knowledge-promotion-evidence.jsonl.
		const r = await knowledge_receipt.execute(
			{
				trace_id: traceId,
				applied: [{ id: promoId, how: 'used the lesson' }],
			} as never,
			toolCtx,
		);
		const out = JSON.parse(typeof r === 'string' ? r : JSON.stringify(r));
		expect(out.recorded).toBe(true);
		// Read the events log to get the actual applied event_id (for PRR-001 exact
		// pairing assertion below).
		const events = await readKnowledgeEvents(dir);
		// Read the promotion-evidence store back and verify the record exists.
		const { loadPromotionEvidenceByEntry } = await import(
			'../../src/hooks/promotion-evidence-store'
		);
		const evidenceByEntry = await loadPromotionEvidenceByEntry(dir);
		const records = evidenceByEntry[promoId] ?? [];
		expect(records.length).toBeGreaterThanOrEqual(1);
		const rec = records[0];
		expect(rec.entry_id).toBe(promoId);
		expect(rec.retrieval_trace_id).toBe(traceId);
		expect(rec.receipt_outcome).toBe('applied');
		expect(rec.receipt_event_id).toBeTruthy();
		expect(rec.cohort_id).toBeTruthy();
		// (#PRR-001 exact pairing) The receipt_event_id must match the ACTUAL
		// applied event's event_id in the knowledge-events log — not just be
		// truthy. This pins the per-item eventIdByKnowledgeId map against the
		// old fragile cursor arithmetic.
		const appliedEvent = events.find(
			(e) => e.type === 'applied' && e.knowledge_id === promoId,
		);
		expect(appliedEvent).toBeDefined();
		expect(appliedEvent?.event_id).toBe(rec.receipt_event_id);
	});
});
