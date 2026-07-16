/**
 * #1848 §3: compare-and-swap (CAS) mutation tests.
 *
 * Verifies that `transactKnowledgeWithCas` rejects a stale plan (revision
 * mismatch or content-hash mismatch) instead of silently overwriting, and that
 * an accepted mutation bumps the revision + content_hash.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
	computeContentHash,
	readKnowledge,
	resolveSwarmKnowledgePath,
	transactKnowledgeWithCas,
} from '../../../src/hooks/knowledge-store.js';
import type { SwarmKnowledgeEntry } from '../../../src/hooks/knowledge-types.js';

// Track created temp dirs so they can be removed (avoid leaking into tmpdir).
const createdTmpDirs: string[] = [];
afterEach(() => {
	while (createdTmpDirs.length > 0) {
		const dir = createdTmpDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

function makeTmpDir(): string {
	const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'swarm-cas-')));
	createdTmpDirs.push(dir);
	return dir;
}

function makeEntry(
	id: string,
	lesson: string,
	revision = 1,
): SwarmKnowledgeEntry {
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
		schema_version: 3,
		producer: { cohort_id: 'c1', worktree_id: 'wt-A' },
		revision,
		content_hash: computeContentHash(lesson),
		created_at: '2026-01-01T00:00:00Z',
		updated_at: '2026-01-01T00:00:00Z',
	};
}

function writeEntries(dir: string, entries: SwarmKnowledgeEntry[]): void {
	const storeDir = path.join(dir, '.swarm');
	writeFileSync(
		path.join(storeDir, 'knowledge.jsonl'),
		entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
	);
}

describe('transactKnowledgeWithCas', () => {
	let dir: string;

	beforeEach(() => {
		dir = makeTmpDir();
		const storeDir = path.join(dir, '.swarm');
		mkdirSync(storeDir, { recursive: true });
		writeFileSync(path.join(storeDir, 'knowledge.jsonl'), '');
	});

	it('commits a mutation when revision matches and bumps revision + content_hash', async () => {
		writeEntries(dir, [makeEntry('e1', 'original lesson text here', 1)]);
		const result = await transactKnowledgeWithCas(
			dir,
			resolveSwarmKnowledgePath(dir),
			'e1',
			1,
			computeContentHash('original lesson text here'),
			(entry) => ({
				mutated: { ...entry, lesson: 'rewritten lesson text here!' },
			}),
		);
		expect(result.committed).toBe(true);
		expect(result.casFailed).toBe(false);

		const after = await readKnowledge<SwarmKnowledgeEntry>(
			resolveSwarmKnowledgePath(dir),
		);
		expect(after[0].revision).toBe(2);
		expect(after[0].content_hash).toBe(
			computeContentHash('rewritten lesson text here!'),
		);
	});

	it('rejects a stale plan when the entry was concurrently edited (revision mismatch)', async () => {
		// Plan was built against revision 1, but the entry is now revision 2.
		writeEntries(dir, [makeEntry('e1', 'already-updated lesson here', 2)]);
		const result = await transactKnowledgeWithCas(
			dir,
			resolveSwarmKnowledgePath(dir),
			'e1',
			1, // expected revision 1 — STALE
			undefined,
			(entry) => ({ mutated: { ...entry, lesson: 'stale plan rewrite!!!!' } }),
		);
		expect(result.committed).toBe(false);
		expect(result.casFailed).toBe(true);

		const after = await readKnowledge<SwarmKnowledgeEntry>(
			resolveSwarmKnowledgePath(dir),
		);
		expect(after[0].lesson).toBe('already-updated lesson here');
		expect(after[0].revision).toBe(2); // unchanged
	});

	it('rejects when content_hash mismatches', async () => {
		writeEntries(dir, [makeEntry('e1', 'current lesson text here!!', 1)]);
		const result = await transactKnowledgeWithCas(
			dir,
			resolveSwarmKnowledgePath(dir),
			'e1',
			1,
			'deadbeefdead', // wrong hash
			(entry) => ({ mutated: { ...entry, lesson: 'should not be applied!!' } }),
		);
		expect(result.committed).toBe(false);
		expect(result.casFailed).toBe(true);
	});

	it('allows first mutation on legacy entry (revision 0) with undefined expectedRevision', async () => {
		writeEntries(dir, [makeEntry('e1', 'legacy lesson text here!', 0)]);
		const result = await transactKnowledgeWithCas(
			dir,
			resolveSwarmKnowledgePath(dir),
			'e1',
			undefined, // legacy — no CAS expectation
			undefined,
			(entry) => ({ mutated: { ...entry, confidence: 0.7 } }),
		);
		expect(result.committed).toBe(true);
		expect(result.casFailed).toBe(false);
		const after = await readKnowledge<SwarmKnowledgeEntry>(
			resolveSwarmKnowledgePath(dir),
		);
		expect(after[0].revision).toBe(1);
	});

	it('returns committed:false (no-op) for a missing entry', async () => {
		writeEntries(dir, [makeEntry('e1', 'some lesson text here!!', 1)]);
		const result = await transactKnowledgeWithCas(
			dir,
			resolveSwarmKnowledgePath(dir),
			'missing',
			undefined,
			undefined,
			() => null,
		);
		expect(result.committed).toBe(false);
		expect(result.casFailed).toBe(false);
	});
});
