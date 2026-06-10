/**
 * Tests for the candidate quarantine store (external-skill-store.ts).
 *
 * Covers: atomic JSON write/read, FIFO eviction protecting passed/promoted/revoked,
 * candidate CRUD, bounded retention, UUID v4 IDs, and path-traversal prevention.
 *
 * Uses the _internals DI seam — no mock.module leakage.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
	type ExternalSkillCandidate,
	ExternalSkillCandidateEvaluationVerdict,
} from '../../../src/config/schema';
import {
	_internals,
	createExternalSkillStore,
} from '../../../src/services/external-skill-store';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCandidate(
	overrides: Partial<Omit<ExternalSkillCandidate, 'id'>> = {},
): Omit<ExternalSkillCandidate, 'id'> {
	const now = new Date().toISOString();
	return {
		source_url: 'https://github.com/example/skill',
		source_type: 'github',
		publisher: 'example',
		sha256: 'a'.repeat(64),
		fetched_at: now,
		skill_body: '# Skill\nDo stuff.',
		risk_flags: [],
		evaluation_verdict: 'pending',
		evaluation_history: [],
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

let tmp: string;
let store: ReturnType<typeof createExternalSkillStore>;

beforeEach(() => {
	mock.restore();
	tmp = mkdtempSync(path.join(tmpdir(), 'swarm-ext-store-'));
	store = createExternalSkillStore(tmp, { max_candidates: 5 });
});

afterEach(() => {
	mock.restore();
	rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// add()
// ---------------------------------------------------------------------------

describe('add', () => {
	test('assigns a UUID v4 id and persists the candidate atomically', async () => {
		const input = makeCandidate();
		const result = await store.add(input);

		// UUID v4 format check
		expect(result.id).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
		);

		// File exists on disk
		const filePath = path.join(
			tmp,
			'.swarm',
			'skills',
			'candidates',
			`${result.id}.json`,
		);
		expect(existsSync(filePath)).toBe(true);

		// File contains valid JSON matching the returned object
		const raw = await readFile(filePath, 'utf-8');
		const parsed = JSON.parse(raw) as ExternalSkillCandidate;
		expect(parsed.id).toBe(result.id);
		expect(parsed.skill_name).toBeUndefined();
	});

	test('persists all input fields', async () => {
		const input = makeCandidate({
			skill_name: 'Test Skill',
			skill_description: 'A test skill',
			source_url: 'https://github.com/example/repo',
			source_type: 'github',
			publisher: 'acme',
			sha256: 'b'.repeat(64),
			risk_flags: ['network'],
		});
		const result = await store.add(input);

		const filePath = path.join(
			tmp,
			'.swarm',
			'skills',
			'candidates',
			`${result.id}.json`,
		);
		const parsed = JSON.parse(
			await readFile(filePath, 'utf-8'),
		) as ExternalSkillCandidate;
		expect(parsed.skill_name).toBe('Test Skill');
		expect(parsed.skill_description).toBe('A test skill');
		expect(parsed.source_type).toBe('github');
		expect(parsed.risk_flags).toEqual(['network']);
	});

	test('creates the store directory recursively', async () => {
		const input = makeCandidate();
		await store.add(input);

		const dirPath = path.join(tmp, '.swarm', 'skills', 'candidates');
		expect(existsSync(dirPath)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// get()
// ---------------------------------------------------------------------------

describe('get', () => {
	test('returns the candidate when it exists', async () => {
		const input = makeCandidate({ skill_name: 'My Skill' });
		const created = await store.add(input);
		const result = await store.get(created.id);

		expect(result).not.toBeNull();
		expect(result!.id).toBe(created.id);
		expect(result!.skill_name).toBe('My Skill');
	});

	test('returns null when the candidate does not exist', async () => {
		const result = await store.get('00000000-0000-4000-8000-000000000000');
		expect(result).toBeNull();
	});

	test('returns null for an invalid UUID (path traversal attempt)', async () => {
		const result = await store.get('../../../etc/passwd');
		expect(result).toBeNull();
	});

	test('returns null for a valid-UUID-shape but non-existent id', async () => {
		// Valid format, but no file on disk
		const result = await store.get('ffffffff-ffff-4fff-bfff-ffffffffffff');
		expect(result).toBeNull();
	});

	test('returns null for corrupted JSON on disk', async () => {
		// Manually write bad JSON
		const id = '11111111-1111-4111-8111-111111111111';
		const dirPath = path.join(tmp, '.swarm', 'skills', 'candidates');
		await mkdir(dirPath, { recursive: true });
		await writeFile(path.join(dirPath, `${id}.json`), '{ broken json', 'utf-8');

		const result = await store.get(id);
		expect(result).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// list()
// ---------------------------------------------------------------------------

describe('list', () => {
	test('returns empty array when store is empty', async () => {
		const result = await store.list();
		expect(result).toEqual([]);
	});

	test('returns all candidates sorted by fetched_at descending', async () => {
		const now = new Date();
		const old = new Date(now.getTime() - 10_000).toISOString();
		const newer = new Date(now.getTime() - 5_000).toISOString();
		const newest = now.toISOString();

		await store.add(makeCandidate({ fetched_at: old }));
		await store.add(makeCandidate({ fetched_at: newer }));
		const last = await store.add(makeCandidate({ fetched_at: newest }));

		const result = await store.list();
		expect(result.length).toBe(3);
		expect(result[0].id).toBe(last.id); // newest first
	});

	test('filters by verdict', async () => {
		const pending = await store.add(
			makeCandidate({ evaluation_verdict: 'pending' }),
		);
		await store.add(makeCandidate({ evaluation_verdict: 'passed' }));
		await store.add(makeCandidate({ evaluation_verdict: 'pending' }));

		const result = await store.list({ verdict: 'pending' });
		expect(result.length).toBe(2);
		for (const c of result) {
			expect(c.evaluation_verdict).toBe('pending');
		}
	});

	test('filters by source_type', async () => {
		await store.add(makeCandidate({ source_type: 'github' }));
		await store.add(makeCandidate({ source_type: 'url' }));
		await store.add(makeCandidate({ source_type: 'github' }));

		const result = await store.list({ source_type: 'url' });
		expect(result.length).toBe(1);
		expect(result[0].source_type).toBe('url');
	});

	test('filters by since (inclusive)', async () => {
		const t1 = '2024-01-01T00:00:00.000Z';
		const t2 = '2024-06-01T00:00:00.000Z';
		const t3 = '2024-12-01T00:00:00.000Z';

		await store.add(makeCandidate({ fetched_at: t1 }));
		await store.add(makeCandidate({ fetched_at: t2 }));
		await store.add(makeCandidate({ fetched_at: t3 }));

		const result = await store.list({ since: '2024-06-01T00:00:00.000Z' });
		expect(result.length).toBe(2);
	});

	test('skips files that disappear between readdir and read', async () => {
		const originalReaddir = _internals.fs.readdir;

		// Intercept readdir to return an extra file that will not be readable
		_internals.fs.readdir = mock(async (p: string) => {
			const entries = await originalReaddir(p);
			// Add a file that will fail to read
			return [...entries, 'ghost.json'];
		});

		await store.add(makeCandidate());
		const result = await store.list();
		// The ghost file fails to read and is skipped; the real candidate is still returned
		expect(result.length).toBe(1);

		_internals.fs.readdir = originalReaddir;
	});
});

// ---------------------------------------------------------------------------
// update()
// ---------------------------------------------------------------------------

describe('update', () => {
	test('returns null for invalid UUID', async () => {
		const result = await store.update('../etc/passwd', { skill_name: 'x' });
		expect(result).toBeNull();
	});

	test('returns null for non-existent candidate', async () => {
		const result = await store.update('ffffffff-ffff-4fff-bfff-ffffffffffff', {
			skill_name: 'x',
		});
		expect(result).toBeNull();
	});

	test('patches skill_name and skill_description', async () => {
		const created = await store.add(makeCandidate());
		const result = await store.update(created.id, {
			skill_name: 'Updated Name',
			skill_description: 'Updated desc',
		});

		expect(result).not.toBeNull();
		expect(result!.skill_name).toBe('Updated Name');
		expect(result!.skill_description).toBe('Updated desc');
	});

	test('appends to evaluation_history when verdict changes', async () => {
		const created = await store.add(
			makeCandidate({ evaluation_verdict: 'pending', evaluation_history: [] }),
		);

		const before = await store.get(created.id);
		expect(before!.evaluation_history).toEqual([]);

		const result = await store.update(created.id, {
			evaluation_verdict: 'in_review',
		});

		expect(result).not.toBeNull();
		expect(result!.evaluation_history.length).toBe(1);
		expect(result!.evaluation_history[0].verdict).toBe('in_review');
		expect(result!.evaluation_history[0].actor).toBe('system');
		expect(result!.evaluation_history[0].timestamp).toBeTruthy();
	});

	test('accumulates multiple verdict changes in evaluation_history', async () => {
		const created = await store.add(
			makeCandidate({ evaluation_verdict: 'pending', evaluation_history: [] }),
		);

		await store.update(created.id, { evaluation_verdict: 'in_review' });
		await store.update(created.id, { evaluation_verdict: 'quarantined' });
		const result = await store.update(created.id, {
			evaluation_verdict: 'passed',
		});

		expect(result!.evaluation_history.length).toBe(3);
		expect(result!.evaluation_history.map((h) => h.verdict)).toEqual([
			'in_review',
			'quarantined',
			'passed',
		]);
	});

	test('merges patch.evaluation_history (appends, never replaces)', async () => {
		const created = await store.add(
			makeCandidate({
				evaluation_verdict: 'pending',
				evaluation_history: [
					{
						verdict: 'pending',
						timestamp: '2024-01-01T00:00:00.000Z',
						actor: 'system',
					},
				],
			}),
		);

		const result = await store.update(created.id, {
			evaluation_history: [
				{
					verdict: 'in_review',
					timestamp: '2024-01-02T00:00:00.000Z',
					actor: 'human',
				},
			],
		});

		// Original entry preserved + new entry appended
		expect(result!.evaluation_history.length).toBe(2);
		expect(result!.evaluation_history[0].verdict).toBe('pending');
		expect(result!.evaluation_history[1].verdict).toBe('in_review');
	});

	test('persists the update to disk', async () => {
		const created = await store.add(makeCandidate());
		await store.update(created.id, { skill_name: 'Persisted' });

		// Re-read from disk without using the store
		const filePath = path.join(
			tmp,
			'.swarm',
			'skills',
			'candidates',
			`${created.id}.json`,
		);
		const raw = await readFile(filePath, 'utf-8');
		const parsed = JSON.parse(raw) as ExternalSkillCandidate;
		expect(parsed.skill_name).toBe('Persisted');
	});
});

// ---------------------------------------------------------------------------
// delete()
// ---------------------------------------------------------------------------

describe('delete', () => {
	test('returns true when candidate existed and was deleted', async () => {
		const created = await store.add(makeCandidate());
		const result = await store.delete(created.id);

		expect(result).toBe(true);
		expect(
			existsSync(
				path.join(tmp, '.swarm', 'skills', 'candidates', `${created.id}.json`),
			),
		).toBe(false);
	});

	test('returns false for invalid UUID', async () => {
		const result = await store.delete('../../../etc/passwd');
		expect(result).toBe(false);
	});

	test('returns false for non-existent candidate', async () => {
		const result = await store.delete('ffffffff-ffff-4fff-bfff-ffffffffffff');
		expect(result).toBe(false);
	});

	test('get returns null after deletion', async () => {
		const created = await store.add(makeCandidate());
		await store.delete(created.id);
		const result = await store.get(created.id);
		expect(result).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// evictIfNeeded()
// ---------------------------------------------------------------------------

describe('evictIfNeeded', () => {
	test('evicts 0 when count is at or below max_candidates', async () => {
		await store.add(makeCandidate());
		await store.add(makeCandidate());
		const result = await store.evictIfNeeded();
		expect(result).toBe(0);
		expect((await store.list()).length).toBe(2);
	});

	test('evicts oldest pending candidates when over max_candidates', async () => {
		// max_candidates = 5
		const oldPending = await store.add(
			makeCandidate({
				fetched_at: '2024-01-01T00:00:00.000Z',
				evaluation_verdict: 'pending',
			}),
		);
		const middlePending = await store.add(
			makeCandidate({
				fetched_at: '2024-06-01T00:00:00.000Z',
				evaluation_verdict: 'pending',
			}),
		);
		const newestPending = await store.add(
			makeCandidate({
				fetched_at: '2024-12-01T00:00:00.000Z',
				evaluation_verdict: 'pending',
			}),
		);
		const passed = await store.add(
			makeCandidate({
				fetched_at: '2024-11-01T00:00:00.000Z',
				evaluation_verdict: 'passed',
			}),
		);
		const promoted = await store.add(
			makeCandidate({
				fetched_at: '2024-10-01T00:00:00.000Z',
				evaluation_verdict: 'promoted',
			}),
		);
		// 5 candidates — now at limit

		// Adding a 6th should evict the oldest 2 pending (excess = 6 - 5 = 1)
		// Wait — excess = all.length - max_candidates = 6 - 5 = 1. Evict oldest 1.
		await store.add(
			makeCandidate({
				fetched_at: '2024-12-15T00:00:00.000Z',
				evaluation_verdict: 'rejected',
			}),
		);

		const evicted = await store.evictIfNeeded();
		expect(evicted).toBe(1);

		// oldPending was oldest → evicted
		expect(await store.get(oldPending.id)).toBeNull();
		// middlePending still there
		expect(await store.get(middlePending.id)).not.toBeNull();
		// passed and promoted still there (protected)
		expect(await store.get(passed.id)).not.toBeNull();
		expect(await store.get(promoted.id)).not.toBeNull();
	});

	test('never evicts passed, promoted, or revoked candidates', async () => {
		// Fill to capacity with protected verdicts
		for (let i = 0; i < 5; i++) {
			await store.add(makeCandidate({ evaluation_verdict: 'passed' }));
		}
		// Now at 5 = max_candidates
		// Adding one more should evict a pending (or rejected) — but none exist,
		// so excess eviction doesn't happen (no evictable candidates available)
		await store.add(
			makeCandidate({
				fetched_at: '2025-01-01T00:00:00.000Z',
				evaluation_verdict: 'pending',
			}),
		);

		const evicted = await store.evictIfNeeded();
		// Can't evict anything because all 6 are passed/pending and pending is oldest
		// but excess = 6 - 5 = 1, oldest pending gets evicted
		// Actually with 5 passed + 1 pending: excess = 6 - 5 = 1
		// Evictable: only the 1 pending. So it gets evicted.
		expect(evicted).toBe(1);
		expect((await store.list()).length).toBe(5);
	});

	test('eviction is ordered by fetched_at ascending, not add-order or verdict', async () => {
		// Candidates added in reverse-chronological order but eviction must use fetched_at
		// Add newest first, oldest last — eviction should still target the oldest fetched_at
		const newest = await store.add(
			makeCandidate({
				fetched_at: '2024-12-15T00:00:00.000Z',
				evaluation_verdict: 'pending',
			}),
		);
		const middle = await store.add(
			makeCandidate({
				fetched_at: '2024-06-01T00:00:00.000Z',
				evaluation_verdict: 'pending',
			}),
		);
		const oldestPending = await store.add(
			makeCandidate({
				fetched_at: '2024-01-01T00:00:00.000Z',
				evaluation_verdict: 'pending',
			}),
		);
		const passed = await store.add(
			makeCandidate({
				fetched_at: '2024-11-01T00:00:00.000Z',
				evaluation_verdict: 'passed',
			}),
		);
		const secondNewest = await store.add(
			makeCandidate({
				fetched_at: '2024-12-20T00:00:00.000Z',
				evaluation_verdict: 'rejected',
			}),
		);
		// 6th candidate pushes over max_candidates=5, making excess=1
		await store.add(
			makeCandidate({
				fetched_at: '2024-12-25T00:00:00.000Z',
				evaluation_verdict: 'pending',
			}),
		);

		// 6 candidates now: excess = 6 - 5 = 1 → evict oldest fetched_at evictable
		const evicted = await store.evictIfNeeded();
		expect(evicted).toBe(1);

		// oldestPending has oldest fetched_at → evicted even though added LAST
		expect(await store.get(oldestPending.id)).toBeNull();
		// middle and newest survive
		expect(await store.get(middle.id)).not.toBeNull();
		expect(await store.get(newest.id)).not.toBeNull();
		// passed is protected
		expect(await store.get(passed.id)).not.toBeNull();
		// secondNewest (newest by fetched_at) survives
		expect(await store.get(secondNewest.id)).not.toBeNull();
	});

	test('handles all evictable verdicts exhausted gracefully', async () => {
		// Only passed/promoted/revoked — nothing to evict
		for (let i = 0; i < 6; i++) {
			await store.add(makeCandidate({ evaluation_verdict: 'passed' }));
		}
		const evicted = await store.evictIfNeeded();
		expect(evicted).toBe(0);
		expect((await store.list()).length).toBe(6);
	});
});

// ---------------------------------------------------------------------------
// UUID v4 generation
// ---------------------------------------------------------------------------

describe('UUID v4 generation', () => {
	test('each add() produces a unique UUID', async () => {
		const ids = new Set<string>();
		for (let i = 0; i < 100; i++) {
			const result = await store.add(makeCandidate());
			ids.add(result.id);
		}
		// All 100 ids are unique
		expect(ids.size).toBe(100);
	});

	test('generated IDs pass isValidCandidateId (UUID v4 regex)', async () => {
		const uuidRegex =
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

		for (let i = 0; i < 20; i++) {
			const result = await store.add(makeCandidate());
			expect(result.id).toMatch(uuidRegex);
		}
	});
});

// ---------------------------------------------------------------------------
// Path traversal prevention
// ---------------------------------------------------------------------------

describe('path traversal prevention', () => {
	const maliciousIds = [
		'../../../etc/passwd',
		'..\\..\\windows\\system32\\config\\sam',
		'./././../../etc/passwd',
		'....//....//etc/passwd',
		'foo/../../../etc/passwd',
		'https://evil.com',
		'',
		'not-a-uuid-at-all',
		'00000000-0000-0000-0000-000000000000', // valid UUID format but broadcast
	];

	for (const id of maliciousIds) {
		test(`get rejects id: ${JSON.stringify(id)}`, async () => {
			const result = await store.get(id);
			expect(result).toBeNull();
		});
	}

	for (const id of maliciousIds) {
		test(`update rejects id: ${JSON.stringify(id)}`, async () => {
			const result = await store.update(id, { skill_name: 'x' });
			expect(result).toBeNull();
		});
	}

	for (const id of maliciousIds) {
		test(`delete rejects id: ${JSON.stringify(id)}`, async () => {
			const result = await store.delete(id);
			expect(result).toBe(false);
		});
	}
});

// ---------------------------------------------------------------------------
// _internals restore
// ---------------------------------------------------------------------------

describe('_internals DI seam', () => {
	test('mocking randomUUID uses the mocked value', async () => {
		const originalRandomUUID = _internals.randomUUID;
		_internals.randomUUID = mock(
			() => 'mocked-uuid-0000-4000-8000-000000000000',
		);

		const result = await store.add(makeCandidate());
		expect(result.id).toBe('mocked-uuid-0000-4000-8000-000000000000');

		_internals.randomUUID = originalRandomUUID;
	});

	test('mocking fs.readFile returns controlled data', async () => {
		const originalReadFile = _internals.fs.readFile;
		_internals.fs.readFile = mock(async () =>
			JSON.stringify(makeCandidate({ skill_name: 'Injected' })),
		);

		// Need a valid UUID on disk for get() to find it... but we mocked readFile
		// so we need to also make readdir return something
		const originalReaddir = _internals.fs.readdir;
		_internals.fs.readdir = mock(async () => [
			'22222222-2222-4222-8222-222222222222.json',
		]);

		const result = await store.list();
		expect(result.length).toBe(1);
		expect(result[0].skill_name).toBe('Injected');

		_internals.fs.readFile = originalReadFile;
		_internals.fs.readdir = originalReaddir;
	});
});
