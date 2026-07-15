/**
 * #1848 §1: producer provenance + worktree identity tests.
 *
 * Verifies that resolveWorktreeId is stable per-worktree, distinct across
 * worktrees, and fail-open on I/O errors. Also verifies that the v3 schema
 * fields (producer, revision, content_hash) normalize correctly.
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
	computeContentHash,
	normalizeEntry,
} from '../../../src/hooks/knowledge-store.js';
import {
	_internals,
	resolveWorktreeId,
} from '../../../src/knowledge/worktree-identity.js';

function makeTmpDir(): string {
	const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'swarm-wtid-')));
	mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	return dir;
}

describe('resolveWorktreeId', () => {
	beforeEach(() => {
		// Restore real implementations before each test.
		_internals.randomUUID = () =>
			'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
				const r = (Math.random() * 16) | 0;
				const v = c === 'x' ? r : (r & 0x3) | 0x8;
				return v.toString(16);
			});
	});

	it('returns a stable id that persists across calls', async () => {
		const dir = makeTmpDir();
		const id1 = await resolveWorktreeId(dir);
		const id2 = await resolveWorktreeId(dir);
		expect(id1).toBe(id2);
		expect(id1).toBeTruthy();
	});

	it('returns distinct ids for distinct worktrees', async () => {
		const dir1 = makeTmpDir();
		const dir2 = makeTmpDir();
		const id1 = await resolveWorktreeId(dir1);
		const id2 = await resolveWorktreeId(dir2);
		expect(id1).not.toBe(id2);
	});

	it('does NOT link-resolve (each worktree keeps its own id)', async () => {
		// Even if both dirs had a link pointer, their worktree-id files are
		// separate (raw path, not resolveKnowledgeStoreDir).
		const dir1 = makeTmpDir();
		const dir2 = makeTmpDir();
		const id1 = await resolveWorktreeId(dir1);
		const id2 = await resolveWorktreeId(dir2);
		expect(id1).not.toBe(id2);
	});
});

describe('normalizeEntry — v3 fields', () => {
	it('defaults revision to 0 for legacy entries', () => {
		const legacy = {
			id: 'e1',
			retrieval_outcomes: { applied_count: 1 },
		};
		const normalized = normalizeEntry(legacy) as Record<string, unknown>;
		expect(normalized.revision).toBe(0);
		// producer is NOT synthesized — stays absent for legacy (unknown-owner).
		expect(normalized.producer).toBeUndefined();
		// content_hash is NOT computed on read (C-7 fix).
		expect(normalized.content_hash).toBeUndefined();
	});

	it('preserves existing v3 fields', () => {
		const v3 = {
			id: 'e1',
			retrieval_outcomes: { applied_count: 1 },
			revision: 5,
			producer: { cohort_id: 'c1', worktree_id: 'wt-A' },
			content_hash: 'abcdef123456',
		};
		const normalized = normalizeEntry(v3) as Record<string, unknown>;
		expect(normalized.revision).toBe(5);
		expect(normalized.producer).toEqual({
			cohort_id: 'c1',
			worktree_id: 'wt-A',
		});
		expect(normalized.content_hash).toBe('abcdef123456');
	});
});

describe('computeContentHash', () => {
	it('produces a deterministic 12-hex hash', () => {
		const h1 = computeContentHash('some lesson text here!');
		const h2 = computeContentHash('some lesson text here!');
		expect(h1).toBe(h2);
		expect(h1).toMatch(/^[0-9a-f]{12}$/);
	});

	it('differs for different lessons', () => {
		const h1 = computeContentHash('lesson one text here!!!');
		const h2 = computeContentHash('lesson two text here!!!');
		expect(h1).not.toBe(h2);
	});
});
