import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	type ArchivedEvent,
	readKnowledgeEvents,
} from '../../../src/hooks/knowledge-events';
import {
	appendKnowledge,
	readKnowledge,
	resolveSwarmKnowledgePath,
} from '../../../src/hooks/knowledge-store';
import type { SwarmKnowledgeEntry } from '../../../src/hooks/knowledge-types';
import { knowledge_archive } from '../../../src/tools/knowledge-archive';

function makeEntry(id: string): SwarmKnowledgeEntry {
	return {
		id,
		tier: 'swarm',
		lesson: `Lesson ${id} with enough characters to be valid`,
		category: 'process',
		tags: [],
		scope: 'global',
		confidence: 0.5,
		status: 'candidate',
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

describe('knowledge_archive', () => {
	let dir: string;
	let kp: string;
	beforeEach(async () => {
		dir = join(
			tmpdir(),
			`swarm-archive-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(dir, { recursive: true });
		kp = resolveSwarmKnowledgePath(dir);
		await appendKnowledge(kp, makeEntry('k1'));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it('archives by default: sets status archived and keeps the entry', async () => {
		const raw = await knowledge_archive.execute(
			{ id: 'k1', reason: 'stale' },
			ctx(dir),
		);
		const parsed = JSON.parse(raw);
		expect(parsed.success).toBe(true);
		expect(parsed.mode).toBe('archive');
		expect(parsed.previous_status).toBe('candidate');
		expect(parsed.status).toBe('archived');

		const entries = await readKnowledge<SwarmKnowledgeEntry>(kp);
		expect(entries).toHaveLength(1);
		expect(entries[0].status).toBe('archived');

		const tomb = (await readKnowledgeEvents(dir)).filter(
			(e): e is ArchivedEvent => e.type === 'archived',
		);
		expect(tomb).toHaveLength(1);
		expect(tomb[0].entry_id).toBe('k1');
		expect(tomb[0].actor).toBe('architect');
		expect(tomb[0].reason).toBe('stale');
		expect(tomb[0].previous_status).toBe('candidate');
		expect(tomb[0].mode).toBe('archive');
	});

	it('quarantines when mode=quarantine', async () => {
		const raw = await knowledge_archive.execute(
			{ id: 'k1', reason: 'suspect', mode: 'quarantine', evidence: 'flaky' },
			ctx(dir),
		);
		const parsed = JSON.parse(raw);
		expect(parsed.status).toBe('quarantined');
		const entries = await readKnowledge<SwarmKnowledgeEntry>(kp);
		expect(entries[0].status).toBe('quarantined');
		const tomb = (await readKnowledgeEvents(dir)).filter(
			(e): e is ArchivedEvent => e.type === 'archived',
		);
		expect(tomb[0].evidence).toBe('flaky');
	});

	it('refuses to purge without the admin flag', async () => {
		const raw = await knowledge_archive.execute(
			{ id: 'k1', reason: 'gone', mode: 'purge' },
			ctx(dir),
		);
		const parsed = JSON.parse(raw);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('allow_purge');
		// Entry untouched.
		const entries = await readKnowledge<SwarmKnowledgeEntry>(kp);
		expect(entries).toHaveLength(1);
		expect(entries[0].status).toBe('candidate');
	});

	it('purges (hard-deletes) with allow_purge:true and still writes a tombstone', async () => {
		const raw = await knowledge_archive.execute(
			{ id: 'k1', reason: 'gone', mode: 'purge', allow_purge: true },
			ctx(dir),
		);
		const parsed = JSON.parse(raw);
		expect(parsed.success).toBe(true);
		expect(parsed.status).toBe('purged');
		const entries = await readKnowledge<SwarmKnowledgeEntry>(kp);
		expect(entries).toHaveLength(0);
		const tomb = (await readKnowledgeEvents(dir)).filter(
			(e): e is ArchivedEvent => e.type === 'archived',
		);
		expect(tomb).toHaveLength(1);
		expect(tomb[0].mode).toBe('purge');
	});

	it('returns not found for an unknown id and writes no tombstone', async () => {
		const raw = await knowledge_archive.execute(
			{ id: 'missing', reason: 'x' },
			ctx(dir),
		);
		const parsed = JSON.parse(raw);
		expect(parsed.success).toBe(false);
		expect(parsed.message).toBe('entry not found');
		expect(await readKnowledgeEvents(dir)).toHaveLength(0);
	});

	it('requires id and reason', async () => {
		const noId = JSON.parse(
			await knowledge_archive.execute({ reason: 'x' } as never, ctx(dir)),
		);
		expect(noId.success).toBe(false);
		const noReason = JSON.parse(
			await knowledge_archive.execute({ id: 'k1' } as never, ctx(dir)),
		);
		expect(noReason.success).toBe(false);
	});
});
