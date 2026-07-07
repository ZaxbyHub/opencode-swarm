/**
 * Swarm-tier archive tests for knowledge_archive tool.
 * Part 1 of 3 for knowledge-archive.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ArchivedEvent } from '../../../src/hooks/knowledge-events';
import { readKnowledgeEvents } from '../../../src/hooks/knowledge-events';
import {
	appendKnowledge,
	readKnowledge,
	resolveSwarmKnowledgePath,
} from '../../../src/hooks/knowledge-store';
import type { SwarmKnowledgeEntry } from '../../../src/hooks/knowledge-types';
import { knowledge_archive } from '../../../src/tools/knowledge-archive';
import { makeCtx, makeSwarmEntry } from './_knowledge-archive-helpers';

describe('knowledge_archive — swarm-tier', () => {
	let dir: string;
	let swarmPath: string;
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
		process.env.HOME = dir;
		process.env.XDG_DATA_HOME = join(dir, 'xdg-data');
		process.env.LOCALAPPDATA = join(dir, 'localappdata');
		swarmPath = resolveSwarmKnowledgePath(dir);
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

	it('archives by default: sets status archived and keeps the entry', async () => {
		const raw = await knowledge_archive.execute(
			{ id: 'k1', reason: 'stale' },
			makeCtx(dir),
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
		// PRR-002: producer-side archived_from assertion
		expect(entries[0].archived_from).toBe('candidate');
		expect(entries[0].archived_at).toBeTruthy();

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

	it('quarantines when mode=quarantine (routes through quarantineEntry — G5 #1716)', async () => {
		const raw = await knowledge_archive.execute(
			{ id: 'k1', reason: 'suspect', mode: 'quarantine', evidence: 'flaky' },
			makeCtx(dir),
		);
		const parsed = JSON.parse(raw);
		expect(parsed.success).toBe(true);
		expect(parsed.status).toBe('quarantined');
		expect(parsed.tier).toBe('swarm');

		const swarmEntries = await readKnowledge<SwarmKnowledgeEntry>(swarmPath);
		expect(swarmEntries).toHaveLength(0);

		const quarantinePath = join(
			resolveSwarmKnowledgePath(dir).replace(/knowledge\.jsonl$/, ''),
			'knowledge-quarantined.jsonl',
		);
		const quarantined = await readKnowledge<
			SwarmKnowledgeEntry & {
				original_status: string;
				quarantine_reason: string;
			}
		>(quarantinePath);
		expect(quarantined).toHaveLength(1);
		expect(quarantined[0].id).toBe('k1');
		expect(quarantined[0].status).toBe('quarantined');
		expect(quarantined[0].original_status).toBe('candidate');
		expect(quarantined[0].quarantine_reason).toBe('suspect');

		const tomb = (await readKnowledgeEvents(dir)).filter(
			(e): e is ArchivedEvent => e.type === 'archived',
		);
		expect(tomb).toHaveLength(0);

		await new Promise((resolve) => queueMicrotask(resolve));
		const skillEvents = (await readKnowledgeEvents(dir)).filter(
			(e) => (e as { type?: string }).type === 'skill-stale-batch',
		);
		expect(skillEvents).toHaveLength(0);
	});

	it('refuses to purge without the admin flag', async () => {
		const raw = await knowledge_archive.execute(
			{ id: 'k1', reason: 'gone', mode: 'purge' },
			makeCtx(dir),
		);
		const parsed = JSON.parse(raw);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('allow_purge');

		const entries = await readKnowledge<SwarmKnowledgeEntry>(swarmPath);
		expect(entries).toHaveLength(1);
		expect(entries[0].status).toBe('candidate');
	});

	it('PRR-003: quarantine returns not-found (not false-success) for a missing id', async () => {
		const raw = await knowledge_archive.execute(
			{ id: 'missing', reason: 'suspect', mode: 'quarantine' },
			makeCtx(dir),
		);
		const parsed = JSON.parse(raw);
		expect(parsed.success).toBe(false);
		expect(parsed.message).toBe('entry not found');
	});

	it('purges (hard-deletes) with allow_purge:true and still writes a tombstone', async () => {
		const raw = await knowledge_archive.execute(
			{ id: 'k1', reason: 'gone', mode: 'purge', allow_purge: true },
			makeCtx(dir),
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
			makeCtx(dir),
		);
		const parsed = JSON.parse(raw);
		expect(parsed.success).toBe(false);
		expect(parsed.message).toBe('entry not found');
		expect(await readKnowledgeEvents(dir)).toHaveLength(0);
	});

	it('requires id and reason', async () => {
		const noId = JSON.parse(
			await knowledge_archive.execute({ reason: 'x' } as never, makeCtx(dir)),
		);
		expect(noId.success).toBe(false);
		const noReason = JSON.parse(
			await knowledge_archive.execute({ id: 'k1' } as never, makeCtx(dir)),
		);
		expect(noReason.success).toBe(false);
	});

	it('PRR-015: re-archive is a no-op that preserves original archived_from', async () => {
		// First archive: k1 (candidate) → archived, archived_from: 'candidate'
		const first = JSON.parse(
			await knowledge_archive.execute(
				{ id: 'k1', reason: 'first' },
				makeCtx(dir),
			),
		);
		expect(first.success).toBe(true);
		expect(first.status).toBe('archived');

		const after1 = (await readKnowledge<SwarmKnowledgeEntry>(swarmPath)).find(
			(e) => e.id === 'k1',
		)!;
		expect(after1.status).toBe('archived');
		expect(after1.archived_from).toBe('candidate');
		const archivedAt1 = after1.archived_at;

		// Second archive (re-archive): should be a no-op
		const second = JSON.parse(
			await knowledge_archive.execute(
				{ id: 'k1', reason: 'duplicate' },
				makeCtx(dir),
			),
		);
		expect(second.success).toBe(true);

		const after2 = (await readKnowledge<SwarmKnowledgeEntry>(swarmPath)).find(
			(e) => e.id === 'k1',
		)!;
		// CRITICAL: archived_from must NOT be corrupted to 'archived'
		expect(after2.archived_from).toBe('candidate');
		expect(after2.status).toBe('archived');
		// archived_at may be unchanged (prefer equality, not deep equality)
		expect(after2.archived_at).toBe(archivedAt1);
	});
});
