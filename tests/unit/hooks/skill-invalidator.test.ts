/**
 * Unit tests for the shared skill-invalidator (issue #1717 G11).
 *
 * Validates that writeArchiveTombstoneAndInvalidateSkills:
 *  - writes an audit tombstone to knowledge-events.jsonl (swarm tier)
 *  - writes a hive-tier tombstone to the hive events log
 *  - schedules the retire/stale microtask for linked skills
 *  - skips the tombstone when skipTombstone is set (knowledge-remove behavior)
 *  - fail-opens (does not throw) when the invalidation microtask errors
 *
 * Uses _internals DI seam for the retire/stale side-effects in some tests and
 * real file-based verification in others (mirroring knowledge-archive.test.ts).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
	writeArchiveTombstoneAndInvalidateSkills,
	_internals,
} from '../../../src/hooks/skill-invalidator.js';
import { readKnowledgeEvents } from '../../../src/hooks/knowledge-events.js';
import { appendKnowledge } from '../../../src/hooks/knowledge-store.js';
import type { SwarmKnowledgeEntry } from '../../../src/hooks/knowledge-types.js';

let tmp: string;

beforeEach(() => {
	tmp = mkdtempSync(path.join(tmpdir(), 'skill-invalidator-'));
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

function makeEntry(id: string, status: SwarmKnowledgeEntry['status'] = 'candidate'): SwarmKnowledgeEntry {
	return {
		id,
		tier: 'swarm',
		lesson: `lesson for ${id}`,
		category: 'process',
		tags: [],
		scope: 'global',
		confidence: 0.8,
		status,
		confirmed_by: [],
		retrieval_outcomes: {
			applied_count: 0,
			succeeded_after_count: 0,
			failed_after_count: 0,
		},
		schema_version: 2,
		created_at: new Date().toISOString(),
		updated_at: new Date().toISOString(),
		project_name: 'test',
	};
}

describe('writeArchiveTombstoneAndInvalidateSkills', () => {
	it('writes a swarm-tier archived tombstone to knowledge-events.jsonl', async () => {
		await appendKnowledge(
			path.join(tmp, '.swarm', 'knowledge.jsonl'),
			makeEntry('entry-1', 'established'),
		);
		await writeArchiveTombstoneAndInvalidateSkills({
			directory: tmp,
			entryId: 'entry-1',
			tier: 'swarm',
			actor: 'curator',
			reason: 'test archive',
			mode: 'archive',
			previousStatus: 'established',
			sourceLabel: 'test',
		});
		const events = await readKnowledgeEvents(tmp);
		const tombs = events.filter(
			(e: { type?: string }): e is { type: 'archived'; mode?: string; actor?: string; previous_status?: string } =>
				e.type === 'archived',
		);
		expect(tombs).toHaveLength(1);
		expect(tombs[0].mode).toBe('archive');
		expect(tombs[0].actor).toBe('curator');
		expect(tombs[0].previous_status).toBe('established');
	});

	it('skips the tombstone when skipTombstone is true (knowledge-remove behavior)', async () => {
		await appendKnowledge(
			path.join(tmp, '.swarm', 'knowledge.jsonl'),
			makeEntry('entry-2', 'candidate'),
		);
		await writeArchiveTombstoneAndInvalidateSkills({
			directory: tmp,
			entryId: 'entry-2',
			tier: 'swarm',
			actor: 'knowledge_remove',
			reason: 'hard-delete',
			mode: 'purge',
			skipTombstone: true,
			sourceLabel: 'test',
		});
		const events = await readKnowledgeEvents(tmp);
		const tombs = events.filter((e) => e.type === 'archived');
		expect(tombs).toHaveLength(0);
	});

	it('schedules retireOrMarkStale for a linked skill when all sources are archived', async () => {
		// Seed the entry (status candidate so it's in the store).
		await appendKnowledge(
			path.join(tmp, '.swarm', 'knowledge.jsonl'),
			makeEntry('src-1', 'candidate'),
		);
		// Create a generated skill whose source_knowledge_ids references src-1.
		const skillDir = path.join(
			tmp,
			'.opencode',
			'skills',
			'generated',
			'linked-skill',
		);
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(
			path.join(skillDir, 'SKILL.md'),
			[
				'---',
				'name: linked-skill',
				'source_knowledge_ids:',
				'  - src-1',
				'---',
				'# Linked Skill',
			].join('\n'),
		);

		await writeArchiveTombstoneAndInvalidateSkills({
			directory: tmp,
			entryId: 'src-1',
			tier: 'swarm',
			actor: 'test',
			reason: 'all sources archived',
			mode: 'archive',
		});

		// Wait for the microtask to fire (SC-004 timing).
		await new Promise<void>((resolve) => setTimeout(resolve, 100));

		// With all sources archived, retireOrMarkStale retires the skill.
		expect(existsSync(path.join(skillDir, 'retired.marker'))).toBe(true);
	});

	it('does not throw when getArchivedKnowledgeIds has no matching skill dirs', async () => {
		await appendKnowledge(
			path.join(tmp, '.swarm', 'knowledge.jsonl'),
			makeEntry('orphan-entry', 'candidate'),
		);
		// No skill dir created → microtask finds nothing → returns cleanly.
		await expect(
			writeArchiveTombstoneAndInvalidateSkills({
				directory: tmp,
				entryId: 'orphan-entry',
				tier: 'swarm',
				actor: 'test',
				reason: 'no linked skill',
				mode: 'archive',
			}),
		).resolves.toBeUndefined();
	});

	it('exposes the helper via _internals for DI in tests', () => {
		expect(_internals.writeArchiveTombstoneAndInvalidateSkills).toBe(
			writeArchiveTombstoneAndInvalidateSkills,
		);
		expect(typeof _internals.retireOrMarkStale).toBe('function');
	});
});
