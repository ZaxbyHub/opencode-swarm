/**
 * Verifies the G6 (#1716) `archived → active` transition via `unarchiveEntry`.
 *
 * Covers:
 *  - All three archive producers record `archived_from` so unarchive can
 *    restore the prior status: (a) the `knowledge_archive` tool, (b) the
 *    curator's `action:'archive'` recommendation, (c) the TTL sweep.
 *  - `unarchiveEntry` restores the entry to `archived_from` and re-includes it
 *    in retrieval (passes the canonical `isActiveStatus` filter).
 *  - Pre-fix archived entries (no `archived_from`) fall back to `'candidate'`.
 *  - `unarchiveEntry` returns `{restored:false}` for missing/non-archived
 *    entries without mutating state.
 *  - `unarchiveEntry` resets `recent_negative_phase_count` so a restored
 *    `promoted` entry doesn't demote almost immediately under G7.
 *  - Invalid lessons are not restored (mirrors `restoreEntry` re-validation).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	readKnowledge,
	resolveSwarmKnowledgePath,
	rewriteKnowledge,
} from '../../../src/hooks/knowledge-store';
import type { SwarmKnowledgeEntry } from '../../../src/hooks/knowledge-types';
import { isActiveStatus } from '../../../src/hooks/knowledge-types';
import { unarchiveEntry } from '../../../src/hooks/knowledge-validator';

let tempDir: string;

function baseEntry(id: string): SwarmKnowledgeEntry {
	return {
		id,
		tier: 'swarm',
		lesson: `Lesson ${id} with enough characters to be valid`,
		category: 'process',
		tags: [],
		scope: 'global',
		confidence: 0.7,
		status: 'candidate',
		confirmed_by: [],
		retrieval_outcomes: {
			applied_count: 0,
			succeeded_after_count: 0,
			failed_after_count: 0,
		},
		schema_version: 2,
		created_at: '2024-01-01T00:00:00Z',
		updated_at: '2024-01-01T00:00:00Z',
		project_name: 'test',
	};
}

async function seed(entries: SwarmKnowledgeEntry[]): Promise<void> {
	await rewriteKnowledge(resolveSwarmKnowledgePath(tempDir), entries);
}

async function readBack(): Promise<SwarmKnowledgeEntry[]> {
	return readKnowledge<SwarmKnowledgeEntry>(resolveSwarmKnowledgePath(tempDir));
}

beforeEach(async () => {
	tempDir = await mkdtemp(path.join(os.tmpdir(), 'swarm-unarchive-'));
	await mkdir(path.join(tempDir, '.swarm'), { recursive: true });
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

describe('unarchiveEntry (G6 #1716)', () => {
	describe('producer: knowledge_archive tool', () => {
		it('restores a tool-archived entry to its archived_from status', async () => {
			// Simulate the tool's archive spread: { ...e, status:'archived',
			// archived_from: prior, archived_at, updated_at }.
			const prior = baseEntry('k-tool');
			prior.status = 'established';
			const archived: SwarmKnowledgeEntry = {
				...prior,
				status: 'archived',
				archived_from: 'established',
				archived_at: '2024-06-01T00:00:00Z',
			};
			await seed([archived]);

			const result = await unarchiveEntry(tempDir, 'k-tool');
			expect(result.restored).toBe(true);
			expect(result.restored_to).toBe('established');

			const after = (await readBack())[0];
			expect(after.status).toBe('established');
			expect(after.archived_from).toBeUndefined();
			expect(after.archived_at).toBeUndefined();
			// Re-included in retrieval.
			expect(isActiveStatus(after.status)).toBe(true);
		});
	});

	describe('producer: curator action:archive', () => {
		it('restores a curator-archived entry to its archived_from status', async () => {
			const prior = baseEntry('k-curator');
			prior.status = 'promoted';
			prior.hive_eligible = true;
			const archived: SwarmKnowledgeEntry = {
				...prior,
				status: 'archived',
				archived_from: 'promoted',
				archived_at: '2024-06-01T00:00:00Z',
			};
			await seed([archived]);

			const result = await unarchiveEntry(tempDir, 'k-curator');
			expect(result.restored_to).toBe('promoted');

			const after = (await readBack())[0];
			expect(after.status).toBe('promoted');
			// Counters reset on unarchive so the restored-promoted entry gets a
			// fresh G7 window rather than inheriting stale negativity.
			expect(after.recent_negative_phase_count).toBe(0);
			expect(after.last_demotion_phase).toBeUndefined();
		});
	});

	describe('producer: TTL sweep', () => {
		it('restores a TTL-archived entry to its archived_from status', async () => {
			// The TTL sweep mutates in place: entry.archived_from = entry.status;
			// entry.archived_at = now; entry.status = 'archived'.
			const prior = baseEntry('k-ttl');
			prior.status = 'established';
			const archived: SwarmKnowledgeEntry = {
				...prior,
				status: 'archived',
				archived_from: 'established',
				archived_at: '2024-06-01T00:00:00Z',
			};
			await seed([archived]);

			const result = await unarchiveEntry(tempDir, 'k-ttl');
			expect(result.restored_to).toBe('established');
			expect((await readBack())[0].status).toBe('established');
		});
	});

	describe('pre-fix fallback (no archived_from)', () => {
		it('restores an archived entry with no archived_from to candidate', async () => {
			// Simulate an entry archived before this fix existed — no archived_from.
			const archived: SwarmKnowledgeEntry = {
				...baseEntry('k-legacy'),
				status: 'archived',
			};
			await seed([archived]);

			const result = await unarchiveEntry(tempDir, 'k-legacy');
			expect(result.restored).toBe(true);
			expect(result.restored_to).toBe('candidate');
			expect((await readBack())[0].status).toBe('candidate');
		});
	});

	describe('failure modes', () => {
		it('returns not_found for a missing entry without mutating state', async () => {
			await seed([{ ...baseEntry('present'), status: 'archived' }]);
			const result = await unarchiveEntry(tempDir, 'missing-id');
			expect(result.restored).toBe(false);
			expect(result.reason).toBe('not_found');
			// The present entry is untouched.
			expect((await readBack())[0].id).toBe('present');
		});

		it('returns not_archived for a non-archived entry without mutating state', async () => {
			const active: SwarmKnowledgeEntry = {
				...baseEntry('active'),
				status: 'established',
			};
			await seed([active]);

			const result = await unarchiveEntry(tempDir, 'active');
			expect(result.restored).toBe(false);
			expect(result.reason).toBe('not_archived');
			expect((await readBack())[0].status).toBe('established');
		});

		it('returns invalid_lesson for an archived entry whose lesson is too short', async () => {
			// Mirrors restoreEntry's re-validation. validateLesson requires
			// >=15 chars; a 5-char lesson fails.
			const archived: SwarmKnowledgeEntry = {
				...baseEntry('bad'),
				lesson: 'short',
				status: 'archived',
				archived_from: 'established',
			};
			await seed([archived]);

			const result = await unarchiveEntry(tempDir, 'bad');
			expect(result.restored).toBe(false);
			expect(result.reason).toBe('invalid_lesson');
			// Entry remains archived.
			const after = (await readBack())[0];
			expect(after.status).toBe('archived');
			expect(after.archived_from).toBe('established');
		});
	});

	it('rejects path-traversal directories', async () => {
		const result = await unarchiveEntry('../escape', 'any');
		expect(result.restored).toBe(false);
		expect(result.reason).toBe('not_found');
	});
});
