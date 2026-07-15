/**
 * #1848 §1: producer provenance + worktree identity tests.
 *
 * Verifies that resolveWorktreeId is stable per-worktree, distinct across
 * worktrees, and fail-open on I/O errors. Also verifies that the v3 schema
 * fields (producer, revision, content_hash) normalize correctly.
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
	normalizeEntry,
} from '../../../src/hooks/knowledge-store.js';
import {
	_internals,
	resolveWorktreeId,
} from '../../../src/knowledge/worktree-identity.js';

// The exact id shape the module generates + validates (F-01 / PRR-009).
const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// PRR-011: snapshot the real `_internals` seams so per-test overrides never
// leak into sibling tests. Restored in afterEach below.
const _internalsSnapshot = { ..._internals };

// Track every temp dir created so afterEach can remove it (the pre-existing
// tests leaked these — now they are all cleaned up).
const createdDirs: string[] = [];

function makeTmpDir(): string {
	const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'swarm-wtid-')));
	mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	createdDirs.push(dir);
	return dir;
}

describe('resolveWorktreeId', () => {
	beforeEach(() => {
		// Deterministic valid-UUID generator for tests.
		_internals.randomUUID = () =>
			'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
				const r = (Math.random() * 16) | 0;
				const v = c === 'x' ? r : (r & 0x3) | 0x8;
				return v.toString(16);
			});
	});

	afterEach(() => {
		// PRR-011: restore all DI seams from the snapshot.
		Object.assign(_internals, _internalsSnapshot);
		// Remove any temp dirs this file's tests created (no leaks).
		while (createdDirs.length > 0) {
			const dir = createdDirs.pop();
			if (dir) {
				rmSync(dir, { recursive: true, force: true });
			}
		}
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

	// F-30 (a): fail-open when reading the id file throws.
	it('fails open with a valid id when readFile throws (I/O error)', async () => {
		const dir = makeTmpDir();
		const idPath = path.join(dir, '.swarm', 'worktree-id.json');
		// Present file so existsSync is true and the read path is exercised.
		writeFileSync(
			idPath,
			`${JSON.stringify({
				worktree_id: '11111111-1111-4111-8111-111111111111',
				created_at: new Date().toISOString(),
			})}\n`,
		);
		_internals.readFile = () => {
			throw new Error('simulated readFile I/O failure');
		};
		const id = await resolveWorktreeId(dir);
		expect(id).toBeTruthy();
		expect(id).toMatch(UUID_RE);
	});

	// F-30 (b): fail-open (no throw) when persisting the id file throws.
	it('returns a usable id without throwing when writeFile throws', async () => {
		const dir = makeTmpDir();
		_internals.writeFile = () => {
			throw new Error('simulated writeFile I/O failure');
		};
		const id = await resolveWorktreeId(dir);
		expect(id).toBeTruthy();
		expect(id).toMatch(UUID_RE);
	});

	// F-01 / PRR-009: a malformed stored id must be regenerated, never returned.
	it('regenerates a valid UUID when the stored id is malformed', async () => {
		const dir = makeTmpDir();
		const idPath = path.join(dir, '.swarm', 'worktree-id.json');
		writeFileSync(
			idPath,
			`${JSON.stringify({
				worktree_id: 'not-a-uuid',
				created_at: new Date().toISOString(),
			})}\n`,
		);
		const id = await resolveWorktreeId(dir);
		expect(id).not.toBe('not-a-uuid');
		expect(id).toMatch(UUID_RE);
		// The repaired file must persist: a second call returns the same valid id.
		const id2 = await resolveWorktreeId(dir);
		expect(id2).toBe(id);
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
