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
	resolveHiveKnowledgePath,
	resolveSwarmKnowledgePath,
} from '../../../src/hooks/knowledge-store';
import type {
	HiveKnowledgeEntry,
	SwarmKnowledgeEntry,
} from '../../../src/hooks/knowledge-types';
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

	it('returns tier:swarm by default', async () => {
		const raw = await knowledge_archive.execute(
			{ id: 'k1', reason: 'stale' },
			ctx(dir),
		);
		const parsed = JSON.parse(raw);
		expect(parsed.tier).toBe('swarm');
	});
});

// ---------------------------------------------------------------------------
// Hive-tier tests
// ---------------------------------------------------------------------------

function makeHiveEntry(id: string): HiveKnowledgeEntry {
	return {
		id,
		tier: 'hive',
		lesson: `Hive lesson ${id} with enough characters to be valid`,
		category: 'process',
		tags: [],
		scope: 'global',
		confidence: 0.5,
		status: 'established',
		confirmed_by: [],
		source_project: 'test-project',
		encounter_score: 1.0,
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

describe('knowledge_archive (hive tier)', () => {
	let dir: string;
	let hiveDir: string;
	let hivePath: string;
	let origHome: string | undefined;

	beforeEach(async () => {
		dir = join(
			tmpdir(),
			`swarm-archive-hive-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(dir, { recursive: true });

		// Redirect HOME so resolveHiveKnowledgePath() writes into our temp dir.
		origHome = process.env.HOME;
		hiveDir = join(dir, 'xdg-data');
		mkdirSync(hiveDir, { recursive: true });
		process.env.HOME = dir;
		process.env.XDG_DATA_HOME = hiveDir;

		hivePath = resolveHiveKnowledgePath();
		await appendKnowledge(hivePath, makeHiveEntry('h1'));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		if (origHome !== undefined) {
			process.env.HOME = origHome;
		} else {
			delete process.env.HOME;
		}
		delete process.env.XDG_DATA_HOME;
	});

	it('archives a hive entry when tier=hive', async () => {
		const raw = await knowledge_archive.execute(
			{ id: 'h1', reason: 'bad cross-project lesson', tier: 'hive' },
			ctx(dir),
		);
		const parsed = JSON.parse(raw);
		expect(parsed.success).toBe(true);
		expect(parsed.mode).toBe('archive');
		expect(parsed.tier).toBe('hive');
		expect(parsed.previous_status).toBe('established');
		expect(parsed.status).toBe('archived');

		const entries = await readKnowledge<HiveKnowledgeEntry>(hivePath);
		expect(entries).toHaveLength(1);
		expect(entries[0].status).toBe('archived');

		const tomb = (await readKnowledgeEvents(dir)).filter(
			(e): e is ArchivedEvent => e.type === 'archived',
		);
		expect(tomb).toHaveLength(1);
		expect(tomb[0].tier).toBe('hive');
		expect(tomb[0].entry_id).toBe('h1');
	});

	it('quarantines a hive entry when mode=quarantine, tier=hive', async () => {
		const raw = await knowledge_archive.execute(
			{ id: 'h1', reason: 'suspect', mode: 'quarantine', tier: 'hive', evidence: 'flaky' },
			ctx(dir),
		);
		const parsed = JSON.parse(raw);
		expect(parsed.success).toBe(true);
		expect(parsed.status).toBe('quarantined');
		expect(parsed.tier).toBe('hive');

		const entries = await readKnowledge<HiveKnowledgeEntry>(hivePath);
		expect(entries[0].status).toBe('quarantined');

		const tomb = (await readKnowledgeEvents(dir)).filter(
			(e): e is ArchivedEvent => e.type === 'archived',
		);
		expect(tomb[0].evidence).toBe('flaky');
		expect(tomb[0].tier).toBe('hive');
	});

	it('purges a hive entry with allow_purge:true, tier=hive', async () => {
		const raw = await knowledge_archive.execute(
			{ id: 'h1', reason: 'gone', mode: 'purge', allow_purge: true, tier: 'hive' },
			ctx(dir),
		);
		const parsed = JSON.parse(raw);
		expect(parsed.success).toBe(true);
		expect(parsed.status).toBe('purged');
		expect(parsed.tier).toBe('hive');

		const entries = await readKnowledge<HiveKnowledgeEntry>(hivePath);
		expect(entries).toHaveLength(0);

		const tomb = (await readKnowledgeEvents(dir)).filter(
			(e): e is ArchivedEvent => e.type === 'archived',
		);
		expect(tomb).toHaveLength(1);
		expect(tomb[0].mode).toBe('purge');
		expect(tomb[0].tier).toBe('hive');
	});

	it('returns not found when tier=hive but id only exists in swarm', async () => {
		// Put an entry in swarm only.
		const swarmPath = resolveSwarmKnowledgePath(dir);
		await appendKnowledge(swarmPath, makeEntry('s1'));

		const raw = await knowledge_archive.execute(
			{ id: 's1', reason: 'x', tier: 'hive' },
			ctx(dir),
		);
		const parsed = JSON.parse(raw);
		expect(parsed.success).toBe(false);
		expect(parsed.message).toBe('entry not found');

		// Swarm entry untouched.
		const swarmEntries = await readKnowledge<SwarmKnowledgeEntry>(swarmPath);
		expect(swarmEntries).toHaveLength(1);
		expect(swarmEntries[0].status).toBe('candidate');
	});

	it('does not affect swarm store when archiving from hive', async () => {
		// Also put an entry in swarm with a different id.
		const swarmPath = resolveSwarmKnowledgePath(dir);
		await appendKnowledge(swarmPath, makeEntry('s1'));

		await knowledge_archive.execute(
			{ id: 'h1', reason: 'hive only', tier: 'hive' },
			ctx(dir),
		);

		const swarmEntries = await readKnowledge<SwarmKnowledgeEntry>(swarmPath);
		expect(swarmEntries).toHaveLength(1);
		expect(swarmEntries[0].status).toBe('candidate');
	});
});
