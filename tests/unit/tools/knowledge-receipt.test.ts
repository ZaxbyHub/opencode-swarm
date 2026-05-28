import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	type ReceiptEvent,
	readKnowledgeEvents,
} from '../../../src/hooks/knowledge-events';
import {
	readKnowledge,
	resolveSwarmKnowledgePath,
} from '../../../src/hooks/knowledge-store';
import type { SwarmKnowledgeEntry } from '../../../src/hooks/knowledge-types';
import { knowledge_receipt } from '../../../src/tools/knowledge-receipt';

const ctx = (directory: string): any => ({
	directory,
	sessionID: 'sess-1',
	agent: 'coder',
});

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
	});

	it('accepts a no_relevant_knowledge receipt without emitting receipt events', async () => {
		const raw = await knowledge_receipt.execute(
			{ trace_id: 'none', no_relevant_knowledge: true } as never,
			ctx(dir),
		);
		const parsed = JSON.parse(raw);
		expect(parsed.recorded).toBe(true);
		expect(parsed.no_relevant_knowledge).toBe(true);
		expect(parsed.event_ids).toHaveLength(0);
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
});
