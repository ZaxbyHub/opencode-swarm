import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	type RetrievedEvent,
	readKnowledgeEvents,
} from '../../../src/hooks/knowledge-events';
import {
	appendKnowledge,
	resolveSwarmKnowledgePath,
} from '../../../src/hooks/knowledge-store';
import type { SwarmKnowledgeEntry } from '../../../src/hooks/knowledge-types';
import { knowledge_recall } from '../../../src/tools/knowledge-recall';

function makeEntry(id: string, lesson: string): SwarmKnowledgeEntry {
	return {
		id,
		tier: 'swarm',
		lesson,
		category: 'process',
		tags: [],
		scope: 'global',
		confidence: 0.5,
		status: 'established',
		confirmed_by: [],
		project_name: 'test',
		retrieval_outcomes: {
			applied_count: 0,
			succeeded_after_count: 0,
			failed_after_count: 0,
		},
		schema_version: 2,
		created_at: new Date().toISOString(),
		updated_at: new Date().toISOString(),
	};
}

const ctx = (directory: string): any => ({
	directory,
	sessionID: 'sess-1',
	agent: 'architect',
});

describe('knowledge_recall — retrieved event emission', () => {
	let dir: string;
	beforeEach(() => {
		dir = join(
			tmpdir(),
			`swarm-recall-ev-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(dir, { recursive: true });
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it('emits one manual retrieved event with ranks/scores and returns its trace_id', async () => {
		const kp = resolveSwarmKnowledgePath(dir);
		await appendKnowledge(
			kp,
			makeEntry('k1', 'Always validate user input before processing requests'),
		);
		await appendKnowledge(kp, makeEntry('k2', 'Use CSS grid for layouts'));

		const raw = await knowledge_recall.execute(
			{ query: 'validate user input', tier: 'swarm' },
			ctx(dir),
		);
		const parsed = JSON.parse(raw);
		expect(typeof parsed.trace_id).toBe('string');
		expect(parsed.trace_id.length).toBeGreaterThan(0);

		const retrieved = (await readKnowledgeEvents(dir)).filter(
			(e): e is RetrievedEvent => e.type === 'retrieved',
		);
		expect(retrieved).toHaveLength(1);
		const ev = retrieved[0];
		expect(ev.trace_id).toBe(parsed.trace_id);
		expect(ev.retrieval_mode).toBe('manual');
		expect(ev.session_id).toBe('sess-1');
		expect(ev.agent).toBe('architect');
		expect(ev.result_ids[0]).toBe('k1');
		expect(ev.ranks.k1).toBe(1);
		expect(typeof ev.scores.k1).toBe('number');
	});

	it('emits a retrieved event with empty result_ids on an empty store', async () => {
		const raw = await knowledge_recall.execute(
			{ query: 'anything at all', tier: 'swarm' },
			ctx(dir),
		);
		const parsed = JSON.parse(raw);
		expect(parsed.total).toBe(0);
		expect(typeof parsed.trace_id).toBe('string');

		const retrieved = (await readKnowledgeEvents(dir)).filter(
			(e): e is RetrievedEvent => e.type === 'retrieved',
		);
		expect(retrieved).toHaveLength(1);
		expect(retrieved[0].result_ids).toEqual([]);
	});

	it('does not emit an event when the query is invalid (no retrieval occurred)', async () => {
		const raw = await knowledge_recall.execute(
			{ query: 'ab', tier: 'swarm' },
			ctx(dir),
		);
		const parsed = JSON.parse(raw);
		expect(parsed.error).toBeTruthy();
		expect(await readKnowledgeEvents(dir)).toHaveLength(0);
	});
});
