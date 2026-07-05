/**
 * Hive-tier archive tests for knowledge_archive tool.
 * Part 2 of 3 for knowledge-archive.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ArchivedEvent } from '../../../src/hooks/knowledge-events';
import {
	readHiveKnowledgeEvents,
	readKnowledgeEvents,
} from '../../../src/hooks/knowledge-events';
import {
	appendKnowledge,
	readKnowledge,
	resolveHiveKnowledgePath,
} from '../../../src/hooks/knowledge-store';
import type { HiveKnowledgeEntry } from '../../../src/hooks/knowledge-types';
import { knowledge_archive } from '../../../src/tools/knowledge-archive';
import { makeCtx, makeHiveEntry } from './_knowledge-archive-helpers';

describe('knowledge_archive — hive-tier', () => {
	let dir: string;
	let previousHome: string | undefined;
	let previousXdgDataHome: string | undefined;
	let previousLocalAppData: string | undefined;

	beforeEach(async () => {
		previousHome = process.env.HOME;
		previousXdgDataHome = process.env.XDG_DATA_HOME;
		previousLocalAppData = process.env.LOCALAPPDATA;
		dir = join(
			tmpdir(),
			`hive-archive-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(dir, { recursive: true });
		// Redirect hive path resolution for all platforms:
		// macOS (darwin) uses HOME; Linux uses XDG_DATA_HOME; Windows uses LOCALAPPDATA.
		process.env.HOME = dir;
		process.env.XDG_DATA_HOME = join(dir, 'xdg-data');
		process.env.LOCALAPPDATA = join(dir, 'localappdata');
		// hivePath is computed fresh here so it picks up the redirected env vars.
		// os.homedir() is cached by Bun, but resolveHiveKnowledgePath() reads
		// process.env.* directly on every call, so this is stable within the test.
		const hivePath = resolveHiveKnowledgePath();
		await appendKnowledge(hivePath, makeHiveEntry('hive-1'));
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

	async function getHivePath(): Promise<string> {
		// Re-compute each call to pick up the current process.env values.
		return resolveHiveKnowledgePath();
	}

	it('archives hive entry when tier=hive', async () => {
		const hivePath = await getHivePath();
		const raw = await knowledge_archive.execute(
			{ id: 'hive-1', reason: 'bad lesson', tier: 'hive' },
			makeCtx(dir),
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

		const tomb = (await readHiveKnowledgeEvents()).filter(
			(e): e is ArchivedEvent => e.type === 'archived',
		);
		expect(tomb).toHaveLength(1);
		expect(tomb[0].entry_id).toBe('hive-1');
		expect(tomb[0].tier).toBe('hive');
		expect(tomb[0].previous_status).toBe('established');

		const localTomb = (await readKnowledgeEvents(dir)).filter(
			(e): e is ArchivedEvent => e.type === 'archived',
		);
		expect(localTomb).toHaveLength(0);
	});

	it('rejects quarantine when tier=hive and mode=quarantine (G5 #1716: swarm-only)', async () => {
		const hivePath = await getHivePath();
		const raw = await knowledge_archive.execute(
			{
				id: 'hive-1',
				reason: 'suspect hive lesson',
				tier: 'hive',
				mode: 'quarantine',
			},
			makeCtx(dir),
		);
		const parsed = JSON.parse(raw);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toMatch(
			/quarantine via the archive tool is swarm-only/i,
		);
		expect(parsed.error).toMatch(/\/swarm knowledge quarantine/);

		const entries = await readKnowledge<HiveKnowledgeEntry>(hivePath);
		expect(entries).toHaveLength(1);
		expect(entries[0].status).toBe('established');

		const tomb = (await readHiveKnowledgeEvents()).filter(
			(e): e is ArchivedEvent => e.type === 'archived',
		);
		expect(tomb).toHaveLength(0);
	});

	it('purges hive entry with allow_purge:true when tier=hive', async () => {
		const hivePath = await getHivePath();
		const raw = await knowledge_archive.execute(
			{
				id: 'hive-1',
				reason: 'purge bad hive',
				tier: 'hive',
				mode: 'purge',
				allow_purge: true,
			},
			makeCtx(dir),
		);
		const parsed = JSON.parse(raw);
		expect(parsed.success).toBe(true);
		expect(parsed.status).toBe('purged');
		expect(parsed.tier).toBe('hive');

		const entries = await readKnowledge<HiveKnowledgeEntry>(hivePath);
		expect(entries).toHaveLength(0);

		const tomb = (await readHiveKnowledgeEvents()).filter(
			(e): e is ArchivedEvent => e.type === 'archived',
		);
		expect(tomb[0].mode).toBe('purge');
		expect(tomb[0].tier).toBe('hive');
	});

	it('refuses to purge hive entry without allow_purge:true', async () => {
		const hivePath = await getHivePath();
		const raw = await knowledge_archive.execute(
			{ id: 'hive-1', reason: 'attempt purge', tier: 'hive', mode: 'purge' },
			makeCtx(dir),
		);
		const parsed = JSON.parse(raw);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('allow_purge');

		const entries = await readKnowledge<HiveKnowledgeEntry>(hivePath);
		expect(entries).toHaveLength(1);
		expect(entries[0].status).toBe('established');
	});

	it('returns not found for unknown hive entry', async () => {
		const raw = await knowledge_archive.execute(
			{ id: 'unknown-hive', reason: 'does not exist', tier: 'hive' },
			makeCtx(dir),
		);
		const parsed = JSON.parse(raw);
		expect(parsed.success).toBe(false);
		expect(parsed.message).toBe('entry not found');
	});

	it('records the hive tombstone in a shared log readable from any project', async () => {
		const projectA = join(dir, 'project-a');
		mkdirSync(projectA, { recursive: true });
		await knowledge_archive.execute(
			{ id: 'hive-1', reason: 'remediated from project A', tier: 'hive' },
			makeCtx(projectA),
		);

		const projectB = join(dir, 'project-b');
		mkdirSync(projectB, { recursive: true });
		const sharedTomb = (await readHiveKnowledgeEvents()).filter(
			(e): e is ArchivedEvent => e.type === 'archived',
		);
		expect(sharedTomb).toHaveLength(1);
		expect(sharedTomb[0].entry_id).toBe('hive-1');
		expect(sharedTomb[0].reason).toBe('remediated from project A');

		expect(await readKnowledgeEvents(projectA)).toHaveLength(0);
		expect(await readKnowledgeEvents(projectB)).toHaveLength(0);
	});
});
