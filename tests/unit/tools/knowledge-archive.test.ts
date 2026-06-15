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
import type { HiveKnowledgeEntry, SwarmKnowledgeEntry } from '../../../src/hooks/knowledge-types';
import { knowledge_archive } from '../../../src/tools/knowledge-archive';

function makeSwarmEntry(id: string): SwarmKnowledgeEntry {
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

function makeHiveEntry(id: string): HiveKnowledgeEntry {
	return {
		id,
		tier: 'hive',
		lesson: `Hive Lesson ${id} with enough characters to be valid`,
		category: 'architecture',
		tags: [],
		scope: 'global',
		confidence: 0.8,
		status: 'active',
		confirmed_by: [],
		source_project: 'original-project',
		encounter_score: 1.5,
		retrieval_outcomes: {
			applied_count: 5,
			succeeded_after_count: 3,
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
	let swarmPath: string;
	let hivePath: string;
	let previousHome: string | undefined;
	let previousXdgDataHome: string | undefined;
	let previousLocalAppData: string | undefined;

	beforeEach(async () => {
		previousHome = process.env.HOME;
		previousXdgDataHome = process.env.XDG_DATA_HOME;
		previousLocalAppData = process.env.LOCALAPPDATA;
		dir = join(
			tmpdir(),
			`swarm-archive-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(dir, { recursive: true });
		// Redirect hive path resolution for all platforms:
		// macOS (darwin) uses HOME; Linux uses XDG_DATA_HOME; Windows uses LOCALAPPDATA.
		// resolveHiveKnowledgePath() reads process.env.HOME live per call (see knowledge-store.ts).
		process.env.HOME = dir;
		process.env.XDG_DATA_HOME = join(dir, 'xdg-data');
		process.env.LOCALAPPDATA = join(dir, 'localappdata');
		swarmPath = resolveSwarmKnowledgePath(dir);
		hivePath = resolveHiveKnowledgePath();
		await appendKnowledge(swarmPath, makeSwarmEntry('k1'));
	});

	afterEach(() => {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
		else process.env.XDG_DATA_HOME = previousXdgDataHome;
		if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA;
		else process.env.LOCALAPPDATA = previousLocalAppData;
		rmSync(dir, { recursive: true, force: true });
	});

	describe('swarm-tier (default)', () => {
		it('archives by default: sets status archived and keeps the entry', async () => {
			const raw = await knowledge_archive.execute(
				{ id: 'k1', reason: 'stale' },
				ctx(dir),
			);
			const parsed = JSON.parse(raw);
			expect(parsed.success).toBe(true);
			expect(parsed.mode).toBe('archive');
			expect(parsed.tier).toBe('swarm');
			expect(parsed.previous_status).toBe('candidate');
			expect(parsed.status).toBe('archived');

			const entries = await readKnowledge<SwarmKnowledgeEntry>(swarmPath);
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
			expect(tomb[0].tier).toBe('swarm');
		});

		it('quarantines when mode=quarantine', async () => {
			const raw = await knowledge_archive.execute(
				{ id: 'k1', reason: 'suspect', mode: 'quarantine', evidence: 'flaky' },
				ctx(dir),
			);
			const parsed = JSON.parse(raw);
			expect(parsed.status).toBe('quarantined');
			expect(parsed.tier).toBe('swarm');
			const entries = await readKnowledge<SwarmKnowledgeEntry>(swarmPath);
			expect(entries[0].status).toBe('quarantined');
			const tomb = (await readKnowledgeEvents(dir)).filter(
				(e): e is ArchivedEvent => e.type === 'archived',
			);
			expect(tomb[0].evidence).toBe('flaky');
			expect(tomb[0].tier).toBe('swarm');
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
			const entries = await readKnowledge<SwarmKnowledgeEntry>(swarmPath);
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
			expect(parsed.tier).toBe('swarm');
			const entries = await readKnowledge<SwarmKnowledgeEntry>(swarmPath);
			expect(entries).toHaveLength(0);
			const tomb = (await readKnowledgeEvents(dir)).filter(
				(e): e is ArchivedEvent => e.type === 'archived',
			);
			expect(tomb).toHaveLength(1);
			expect(tomb[0].mode).toBe('purge');
			expect(tomb[0].tier).toBe('swarm');
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

	describe('hive-tier', () => {
		beforeEach(async () => {
			await appendKnowledge(hivePath, makeHiveEntry('hive-1'));
		});

		it('archives hive entry when tier=hive', async () => {
			const raw = await knowledge_archive.execute(
				{ id: 'hive-1', reason: 'bad lesson', tier: 'hive' },
				ctx(dir),
			);
			const parsed = JSON.parse(raw);
			expect(parsed.success).toBe(true);
			expect(parsed.mode).toBe('archive');
			expect(parsed.tier).toBe('hive');
			expect(parsed.previous_status).toBe('active');
			expect(parsed.status).toBe('archived');

			const entries = await readKnowledge<HiveKnowledgeEntry>(hivePath);
			expect(entries).toHaveLength(1);
			expect(entries[0].status).toBe('archived');

			const tomb = (await readKnowledgeEvents(dir)).filter(
				(e): e is ArchivedEvent => e.type === 'archived',
			);
			expect(tomb).toHaveLength(1);
			expect(tomb[0].entry_id).toBe('hive-1');
			expect(tomb[0].tier).toBe('hive');
			expect(tomb[0].previous_status).toBe('active');
		});

		it('quarantines hive entry when tier=hive and mode=quarantine', async () => {
			const raw = await knowledge_archive.execute(
				{ id: 'hive-1', reason: 'suspect hive lesson', tier: 'hive', mode: 'quarantine' },
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
			expect(tomb[0].tier).toBe('hive');
		});

		it('purges hive entry with allow_purge:true when tier=hive', async () => {
			const raw = await knowledge_archive.execute(
				{ id: 'hive-1', reason: 'purge bad hive', tier: 'hive', mode: 'purge', allow_purge: true },
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
			expect(tomb[0].mode).toBe('purge');
			expect(tomb[0].tier).toBe('hive');
		});

		it('refuses to purge hive entry without allow_purge:true', async () => {
			const raw = await knowledge_archive.execute(
				{ id: 'hive-1', reason: 'attempt purge', tier: 'hive', mode: 'purge' },
				ctx(dir),
			);
			const parsed = JSON.parse(raw);
			expect(parsed.success).toBe(false);
			expect(parsed.error).toContain('allow_purge');

			const entries = await readKnowledge<HiveKnowledgeEntry>(hivePath);
			expect(entries).toHaveLength(1);
			expect(entries[0].status).toBe('active');
		});

		it('returns not found for unknown hive entry', async () => {
			const raw = await knowledge_archive.execute(
				{ id: 'unknown-hive', reason: 'does not exist', tier: 'hive' },
				ctx(dir),
			);
			const parsed = JSON.parse(raw);
			expect(parsed.success).toBe(false);
			expect(parsed.message).toBe('entry not found');
		});
	});
});
