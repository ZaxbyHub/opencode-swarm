import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	appendKnowledgeEvent,
	type ReceiptEvent,
	readKnowledgeEvents,
} from '../../../src/hooks/knowledge-events';
import { queryLiveMemberships } from '../../../src/hooks/knowledge-receipt-ledger.js';
import {
	readKnowledge,
	resolveSwarmKnowledgePath,
} from '../../../src/hooks/knowledge-store';
import type { SwarmKnowledgeEntry } from '../../../src/hooks/knowledge-types';
import {
	_internals,
	knowledge_receipt,
} from '../../../src/tools/knowledge-receipt';

const ctx = (directory: string): any => ({
	directory,
	sessionID: 'sess-1',
	agent: 'coder',
});

// Fixed RECENT instant (string literal — no clock read; see PRR-009 note in
// the matrix test file).
const FIXED_NOW_ISO = '2026-01-01T00:00:00.000Z';

describe('knowledge_receipt', () => {
	let dir: string;
	beforeEach(() => {
		dir = join(
			tmpdir(),
			`swarm-receipt-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(dir, { recursive: true });
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it('requires a trace_id', async () => {
		const raw = await knowledge_receipt.execute(
			{ applied: [{ id: 'k1', how: 'used it' }] } as never,
			ctx(dir),
		);
		const parsed = JSON.parse(raw);
		expect(parsed.recorded).toBe(false);
		expect(parsed.error).toContain('trace_id');
	});

	it('rejects an empty receipt', async () => {
		const raw = await knowledge_receipt.execute(
			{ trace_id: 't1' } as never,
			ctx(dir),
		);
		const parsed = JSON.parse(raw);
		expect(parsed.recorded).toBe(false);
		expect(parsed.error).toContain('empty receipt');
	});

	it('emits applied / ignored / contradicted events with the shared trace_id', async () => {
		// (#1849) Seed the retrieval trace the receipt references so the shared
		// validator's trace-existence + cited-ID membership checks pass.
		await appendKnowledgeEvent(dir, {
			type: 'retrieved',
			trace_id: 'trace-xyz',
			session_id: 'sess-1',
			task_id: 'task-1',
			phase: 'Phase 2',
			agent: 'coder',
			query: 'q',
			retrieval_mode: 'auto_injection',
			result_ids: ['k-applied', 'k-ignored', 'k-bad'],
			ranks: { 'k-applied': 1, 'k-ignored': 2, 'k-bad': 3 },
			scores: { 'k-applied': 1, 'k-ignored': 1, 'k-bad': 1 },
			timestamp: new Date().toISOString(),
		});
		const raw = await knowledge_receipt.execute(
			{
				trace_id: 'trace-xyz',
				task_id: 'task-1',
				phase: 'Phase 2',
				applied: [
					{
						id: 'k-applied',
						how: 'enforced the retry bound',
						evidence_files: ['src/x.ts'],
						verified_by: 'reviewer',
					},
				],
				ignored: [
					{ id: 'k-ignored', reason: 'stale', note: 'superseded by v2' },
				],
				contradicted: [
					{
						id: 'k-bad',
						evidence: 'current tests prove the opposite',
						proposed_action: 'archive',
					},
				],
			} as never,
			ctx(dir),
		);
		const parsed = JSON.parse(raw);
		expect(parsed.recorded).toBe(true);
		expect(parsed.applied).toBe(1);
		expect(parsed.ignored).toBe(1);
		expect(parsed.contradicted).toBe(1);
		expect(parsed.event_ids).toHaveLength(3);

		const events = (await readKnowledgeEvents(dir)).filter(
			(e): e is ReceiptEvent => e.type !== 'retrieved' && e.type !== 'outcome',
		);
		const byType = Object.fromEntries(events.map((e) => [e.type, e]));

		expect(byType.applied).toBeDefined();
		expect(byType.applied.knowledge_id).toBe('k-applied');
		expect(byType.applied.trace_id).toBe('trace-xyz');
		expect(byType.applied.task_id).toBe('task-1');
		expect(byType.applied.phase).toBe('Phase 2');
		expect(byType.applied.agent).toBe('coder');
		expect(byType.applied.evidence?.files).toEqual(['src/x.ts']);
		expect(byType.applied.evidence?.summary).toContain('reviewer');

		expect(byType.ignored.knowledge_id).toBe('k-ignored');
		expect(byType.ignored.reason).toContain('stale');

		expect(byType.contradicted.knowledge_id).toBe('k-bad');
		expect(byType.contradicted.reason).toContain('archive');

		const authority = await queryLiveMemberships(dir, {
			include_terminal: true,
		});
		if (!authority.ok) throw new Error(authority.detail);
		const reasons = Object.fromEntries(
			authority.memberships.map((membership) => [
				membership.entry_id,
				membership.terminal?.reason,
			]),
		);
		expect(reasons).toEqual({
			'k-applied': 'enforced the retry bound',
			'k-ignored': 'stale: superseded by v2',
			'k-bad': 'archive: current tests prove the opposite',
		});
	});

	it('accepts a no_relevant_knowledge receipt and files one durable no_relevant terminal', async () => {
		const raw = await knowledge_receipt.execute(
			{ trace_id: 'none', no_relevant_knowledge: true } as never,
			ctx(dir),
		);
		const parsed = JSON.parse(raw);
		expect(parsed.recorded).toBe(true);
		expect(parsed.no_relevant_knowledge).toBe(true);
		// (#1849) no_relevant now files exactly ONE durable terminal event so the
		// empty-retrieval cycle is accountable (previously zero events).
		expect(parsed.event_ids).toHaveLength(1);
		const events = await readKnowledgeEvents(dir);
		expect(events.some((e) => e.type === 'no_relevant')).toBe(true);
	});

	it('threads configured receipt grace into an empty authoritative trace', async () => {
		const configDir = join(dir, '.opencode');
		mkdirSync(configDir, { recursive: true });
		writeFileSync(
			join(configDir, 'opencode-swarm.json'),
			JSON.stringify({ knowledge: { receipt_close_grace_days: 0 } }),
		);

		const raw = await knowledge_receipt.execute(
			{ trace_id: 'none', no_relevant_knowledge: true } as never,
			ctx(dir),
		);
		expect(JSON.parse(raw).recorded).toBe(true);

		const journal = readFileSync(
			join(dir, '.swarm', 'knowledge-receipts-v2.jsonl'),
			'utf8',
		)
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		const emptyCommit = journal.find(
			(record) => record.kind === 'empty_retrieval_committed',
		);
		expect(emptyCommit).toBeDefined();
		expect(
			(emptyCommit?.payload as { trace: { grace_days: number } }).trace
				.grace_days,
		).toBe(0);
	});

	it('persists new_lessons through the knowledge_add path', async () => {
		const raw = await knowledge_receipt.execute(
			{
				trace_id: 'none',
				new_lessons: [
					{
						lesson: 'Bound every subprocess with an explicit timeout and kill',
						category: 'process',
						evidence: 'observed a hung child in CI',
						// v3 actionability fields are required for the lesson to pass
						// knowledge_add's Layer-5 gate and persist to the active store
						// rather than being quarantined to the unactionable queue.
						applies_to_tools: ['bash'],
						required_actions: [
							'pass an explicit timeout and call proc.kill() in finally',
						],
					},
				],
			} as never,
			ctx(dir),
		);
		const parsed = JSON.parse(raw);
		expect(parsed.recorded).toBe(true);
		expect(parsed.new_lessons).toHaveLength(1);
		expect(parsed.new_lessons[0].success).toBe(true);

		const entries = await readKnowledge<SwarmKnowledgeEntry>(
			resolveSwarmKnowledgePath(dir),
		);
		expect(
			entries.some((e) => e.lesson.includes('Bound every subprocess')),
		).toBe(true);
	});

	it('regression: accepts reasoned n_a items as neutral terminals with delegate source (#2032)', async () => {
		// Previous behavior: the tool had no n_a channel, so a not-applicable
		// entry could only be filed through the NEGATIVE ignored path (whose
		// enum even contained 'not_relevant'). Irrelevance damaged ranking.
		await appendKnowledgeEvent(dir, {
			type: 'retrieved',
			trace_id: 'trace-na',
			session_id: 'sess-1',
			agent: 'coder',
			query: 'q',
			retrieval_mode: 'auto_injection',
			result_ids: ['k-na'],
			ranks: { 'k-na': 1 },
			scores: { 'k-na': 1 },
			timestamp: FIXED_NOW_ISO,
		});
		const raw = await knowledge_receipt.execute(
			{
				trace_id: 'trace-na',
				n_a: [
					{
						id: 'k-na',
						reason: 'directive targets web routing; task is CLI-only',
					},
				],
			} as never,
			ctx(dir),
		);
		const parsed = JSON.parse(raw);
		expect(parsed.recorded).toBe(true);
		expect(parsed.n_a).toBe(1);

		const events = (await readKnowledgeEvents(dir)).filter(
			(e): e is ReceiptEvent => e.type === 'n_a',
		);
		expect(events).toHaveLength(1);
		expect(events[0].knowledge_id).toBe('k-na');
		expect(events[0].reason).toContain('CLI-only');
		expect(events[0].source).toBe('delegate');

		const authority = await queryLiveMemberships(dir, {
			include_terminal: true,
		});
		if (!authority.ok) throw new Error(authority.detail);
		const terminal = authority.memberships.find(
			(m) => m.entry_id === 'k-na',
		)?.terminal;
		expect(terminal?.outcome).toBe('n_a');
		expect(terminal?.source).toBe('delegate');
	});

	it('stamps the caller-class source on diagnostic events (prefixed agent variants included) (#2032)', async () => {
		await appendKnowledgeEvent(dir, {
			type: 'retrieved',
			trace_id: 'trace-rev',
			session_id: 'sess-1',
			agent: 'reviewer',
			query: 'q',
			retrieval_mode: 'auto_injection',
			result_ids: ['k-rev'],
			ranks: { 'k-rev': 1 },
			scores: { 'k-rev': 1 },
			timestamp: FIXED_NOW_ISO,
		});
		const reviewerCtx = { ...ctx(dir), agent: 'mega_reviewer' };
		const raw = await knowledge_receipt.execute(
			{
				trace_id: 'trace-rev',
				applied: [{ id: 'k-rev', how: 'verified the bound' }],
			} as never,
			reviewerCtx,
		);
		expect(JSON.parse(raw).recorded).toBe(true);
		const events = (await readKnowledgeEvents(dir)).filter(
			(e): e is ReceiptEvent => e.type === 'applied',
		);
		expect(events).toHaveLength(1);
		expect(events[0].agent).toBe('mega_reviewer');
		expect(events[0].source).toBe('reviewer');

		const authority = await queryLiveMemberships(dir, {
			include_terminal: true,
		});
		if (!authority.ok) throw new Error(authority.detail);
		const terminal = authority.memberships.find(
			(m) => m.entry_id === 'k-rev',
		)?.terminal;
		expect(terminal?.source).toBe('reviewer');
	});

	it('receiptSourceForAgent allowlist: verifier roles map to their class, all other roles to delegate (#2032)', () => {
		const map = _internals.receiptSourceForAgent;
		expect(map('reviewer')).toBe('reviewer');
		expect(map('mega_reviewer')).toBe('reviewer');
		expect(map('test_engineer')).toBe('test_engineer');
		expect(map('local_test_engineer')).toBe('test_engineer');
		expect(map('architect')).toBe('architect');
		expect(map('mega_architect')).toBe('architect');
		expect(map('coder')).toBe('delegate');
		expect(map('spec_writer')).toBe('delegate');
		expect(map('sme')).toBe('delegate');
		expect(map('custom_planner')).toBe('delegate');
		expect(map('unknown')).toBe('unknown');
		expect(map('')).toBe('unknown');
		// Whitespace-bearing names classify by their trimmed form (PRR-004):
		// 'reviewer ' must not silently degrade to 'delegate'.
		expect(map('reviewer ')).toBe('reviewer');
		expect(map(' mega_architect')).toBe('architect');
	});

	it('ignored reason enum no longer accepts not_relevant; n_a requires a reason (#2032)', () => {
		// Atomic semantic migration: mere irrelevance must file n_a, so the
		// zod arg contract (enforced by the OpenCode host from these schemas)
		// rejects the old escape hatch loudly.
		expect(
			_internals.ignoredItemSchema.safeParse({
				id: 'k1',
				reason: 'not_relevant',
			}).success,
		).toBe(false);
		expect(
			_internals.ignoredItemSchema.safeParse({ id: 'k1', reason: 'stale' })
				.success,
		).toBe(true);
		// Reasoned n_a: an empty reason is rejected (no silent evasion channel).
		expect(
			_internals.notApplicableItemSchema.safeParse({ id: 'k1', reason: '' })
				.success,
		).toBe(false);
		// A whitespace-only reason is rejected exactly like an empty one
		// (PRR-005/020: min(1) alone would accept it, diverging from the phase
		// gate's reason.trim() resolution rule).
		expect(
			_internals.notApplicableItemSchema.safeParse({ id: 'k1', reason: '   ' })
				.success,
		).toBe(false);
		expect(
			_internals.notApplicableItemSchema.safeParse({
				id: 'k1',
				reason: 'different subsystem',
			}).success,
		).toBe(true);
	});

	it('regression: n_a against an unknown trace is rejected, not silently dropped (PRR-020)', async () => {
		const raw = await knowledge_receipt.execute(
			{
				trace_id: 'trace-never-seeded',
				n_a: [{ id: 'k-ghost', reason: 'not applicable' }],
			} as never,
			ctx(dir),
		);
		const parsed = JSON.parse(raw);
		expect(parsed.recorded).toBe(false);
		expect(parsed.reason).toBe('legacy_unverifiable');
		const events = await readKnowledgeEvents(dir);
		expect(events.filter((e) => e.type === 'n_a')).toHaveLength(0);
	});

	it('regression: an empty n_a array alongside real items is inert (PRR-020)', async () => {
		await appendKnowledgeEvent(dir, {
			type: 'retrieved',
			trace_id: 'trace-empty-na',
			session_id: 'sess-1',
			agent: 'coder',
			query: 'q',
			retrieval_mode: 'auto_injection',
			result_ids: ['k-one'],
			ranks: { 'k-one': 1 },
			scores: { 'k-one': 1 },
			timestamp: FIXED_NOW_ISO,
		});
		const raw = await knowledge_receipt.execute(
			{
				trace_id: 'trace-empty-na',
				applied: [{ id: 'k-one', how: 'used it' }],
				n_a: [],
			} as never,
			ctx(dir),
		);
		const parsed = JSON.parse(raw);
		expect(parsed.recorded).toBe(true);
		expect(parsed.applied).toBe(1);
		expect(parsed.n_a).toBe(0);
		const events = (await readKnowledgeEvents(dir)).filter(
			(e): e is ReceiptEvent => e.type === 'applied',
		);
		expect(events).toHaveLength(1);
	});
});
