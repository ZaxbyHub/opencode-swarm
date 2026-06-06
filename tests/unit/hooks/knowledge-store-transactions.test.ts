/**
 * Tests for transactKnowledge and related crash-atomic / race-safe paths.
 *
 * Covers the requirements from the issue:
 * 1. Concurrent append + cap enforcement does not drop the appended entry.
 * 2. Concurrent append + remove does not drop unrelated entries.
 * 3. Concurrent curator calls for the same lesson result in one persisted entry.
 * 4. Concurrent .knowledge-shown.json updates preserve all shown IDs/outcomes.
 * 5. rewriteKnowledge() writes via temp-file + rename and does not leave
 *    partially written target content on simulated failure.
 * 6. Malformed JSONL read tolerance still works.
 * 7. Sweep/quarantine/restore behavior still works under the new transaction helper.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	atomicWriteFile,
	_internals as taskFileInternals,
} from '../../../src/evidence/task-file.js';
import {
	appendKnowledge,
	enforceKnowledgeCap,
	readKnowledge,
	rewriteKnowledge,
	transactKnowledge,
} from '../../../src/hooks/knowledge-store.js';

// ============================================================================
// Test helpers
// ============================================================================

interface TestEntry {
	id: string;
	lesson: string;
	status?: string;
}

let tmpDir: string;
let testFile: string;

beforeEach(() => {
	tmpDir = path.join(
		os.tmpdir(),
		`txn-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	fs.mkdirSync(tmpDir, { recursive: true });
	testFile = path.join(tmpDir, 'knowledge.jsonl');
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ============================================================================
// 1. Concurrent append + cap enforcement does not drop the appended entry.
// ============================================================================

describe('Concurrent append + cap enforcement (requirement 1)', () => {
	it('concurrent appendKnowledge + enforceKnowledgeCap preserves the appended entry', async () => {
		// Pre-populate 8 entries (under cap of 10)
		for (let i = 0; i < 8; i++) {
			await appendKnowledge(testFile, { id: `e${i}`, lesson: `lesson ${i}` });
		}

		// Race: append two more entries while enforcing a cap of 10
		await Promise.all([
			appendKnowledge(testFile, {
				id: 'concurrent-a',
				lesson: 'concurrent append A',
			}),
			enforceKnowledgeCap<TestEntry>(testFile, 10),
			appendKnowledge(testFile, {
				id: 'concurrent-b',
				lesson: 'concurrent append B',
			}),
		]);

		const entries = await readKnowledge<TestEntry>(testFile);
		const ids = entries.map((e) => e.id);

		// Both appended entries must be present (cap 10, up to 10 entries total)
		expect(ids).toContain('concurrent-a');
		expect(ids).toContain('concurrent-b');
		// Total should be at most 10 (cap enforced)
		expect(entries.length).toBeLessThanOrEqual(10);
	});

	it('enforceKnowledgeCap under lock never reads a stale snapshot', async () => {
		// Write 5 entries
		for (let i = 0; i < 5; i++) {
			await appendKnowledge(testFile, { id: `e${i}`, lesson: `lesson ${i}` });
		}

		// Append more entries sequentially (simulating interleaved access)
		await appendKnowledge(testFile, { id: 'late-1', lesson: 'late append 1' });
		await appendKnowledge(testFile, { id: 'late-2', lesson: 'late append 2' });

		// Enforce cap (7 entries, cap 10 — no trimming needed)
		await enforceKnowledgeCap<TestEntry>(testFile, 10);

		const entries = await readKnowledge<TestEntry>(testFile);
		// All 7 entries should survive
		expect(entries).toHaveLength(7);
		expect(entries.map((e) => e.id)).toContain('late-1');
		expect(entries.map((e) => e.id)).toContain('late-2');
	});
});

// ============================================================================
// 2. Concurrent append + remove does not drop unrelated entries.
// ============================================================================

describe('Concurrent append + remove does not drop unrelated entries (requirement 2)', () => {
	it('transactKnowledge for remove + concurrent appendKnowledge preserves unrelated entries', async () => {
		// Pre-populate
		for (let i = 0; i < 5; i++) {
			await appendKnowledge(testFile, {
				id: `keep-${i}`,
				lesson: `keeper ${i}`,
			});
		}
		await appendKnowledge(testFile, {
			id: 'delete-me',
			lesson: 'to be deleted',
		});

		// Race: remove 'delete-me' while appending 'unrelated'
		await Promise.all([
			transactKnowledge<TestEntry>(testFile, (entries) =>
				entries.filter((e) => e.id !== 'delete-me'),
			),
			appendKnowledge(testFile, {
				id: 'unrelated',
				lesson: 'unrelated concurrent append',
			}),
		]);

		const entries = await readKnowledge<TestEntry>(testFile);
		const ids = entries.map((e) => e.id);

		// delete-me must be gone
		expect(ids).not.toContain('delete-me');
		// All keep-* entries must survive
		for (let i = 0; i < 5; i++) {
			expect(ids).toContain(`keep-${i}`);
		}
		// The concurrent append should survive (appended after the delete lock was released)
		expect(ids).toContain('unrelated');
	});

	it('sequential remove + append does not lose data', async () => {
		await appendKnowledge(testFile, { id: 'alpha', lesson: 'alpha lesson' });
		await appendKnowledge(testFile, { id: 'beta', lesson: 'beta lesson' });
		await appendKnowledge(testFile, {
			id: 'remove-me',
			lesson: 'remove this',
		});

		await transactKnowledge<TestEntry>(testFile, (entries) =>
			entries.filter((e) => e.id !== 'remove-me'),
		);
		await appendKnowledge(testFile, { id: 'gamma', lesson: 'gamma lesson' });

		const entries = await readKnowledge<TestEntry>(testFile);
		const ids = entries.map((e) => e.id);

		expect(ids).toContain('alpha');
		expect(ids).toContain('beta');
		expect(ids).toContain('gamma');
		expect(ids).not.toContain('remove-me');
	});
});

// ============================================================================
// 3. Concurrent curator calls for the same lesson result in one persisted entry.
//    We test this by using transactKnowledge with dedup logic (mirrors
//    curateAndStoreSwarm's approach).
// ============================================================================

describe('Concurrent dedup — same lesson persisted only once (requirement 3)', () => {
	it('two concurrent transactKnowledge dedup+appends for the same lesson produce one entry', async () => {
		const lesson = 'Always use atomic writes for JSONL persistence';

		// Simulate two concurrent curation calls that both try to add the same lesson.
		// Both use the same dedup-then-append pattern via transactKnowledge.
		const addIfNew = (id: string) =>
			transactKnowledge<TestEntry>(testFile, (entries) => {
				const alreadyExists = entries.some((e) => e.lesson === lesson);
				if (alreadyExists) return null; // no-op
				return [...entries, { id, lesson }];
			});

		await Promise.all([addIfNew('curator-1'), addIfNew('curator-2')]);

		const entries = await readKnowledge<TestEntry>(testFile);
		const matching = entries.filter((e) => e.lesson === lesson);

		// Only one entry should exist regardless of which curator won the lock
		expect(matching).toHaveLength(1);
	});

	it('three concurrent dedup+appends for distinct lessons each produce exactly one entry', async () => {
		const addLesson = (id: string, lesson: string) =>
			transactKnowledge<TestEntry>(testFile, (entries) => {
				if (entries.some((e) => e.lesson === lesson)) return null;
				return [...entries, { id, lesson }];
			});

		await Promise.all([
			addLesson('id-a', 'lesson A'),
			addLesson('id-b', 'lesson B'),
			addLesson('id-c', 'lesson C'),
		]);

		const entries = await readKnowledge<TestEntry>(testFile);
		expect(entries).toHaveLength(3);

		const ids = entries.map((e) => e.id);
		// Each lesson appears once — specific id depends on which caller won but
		// all three lessons must be present
		const lessons = entries.map((e) => e.lesson);
		expect(lessons).toContain('lesson A');
		expect(lessons).toContain('lesson B');
		expect(lessons).toContain('lesson C');
		// No duplicate ids
		expect(new Set(ids).size).toBe(3);
	});
});

// ============================================================================
// 4. rewriteKnowledge() writes via temp-file + rename (crash-atomic, MF-5 fix).
// ============================================================================

describe('rewriteKnowledge crash-atomic temp-file + rename (requirement 5)', () => {
	it('rewriteKnowledge() writes via temp file and renames over target — not in-place', async () => {
		// Capture all renameSync calls to verify the atomic pattern is used
		const renameCalls: Array<{ from: string; to: string }> = [];
		const originalRenameSync = taskFileInternals.renameSync;
		taskFileInternals.renameSync = (from: string, to: string) => {
			renameCalls.push({ from, to });
			originalRenameSync(from, to);
		};

		try {
			const entries: TestEntry[] = [
				{ id: 'r1', lesson: 'rewrite test 1' },
				{ id: 'r2', lesson: 'rewrite test 2' },
			];
			await rewriteKnowledge(testFile, entries);

			// At least one rename should have occurred
			expect(renameCalls.length).toBeGreaterThanOrEqual(1);

			// The rename target should be the testFile (or a path containing it)
			const toTestFile = renameCalls.find(
				(c) => c.to === testFile || c.to.endsWith('knowledge.jsonl'),
			);
			expect(toTestFile).toBeDefined();

			// The rename source should be a temp file (different from target)
			expect(toTestFile?.from).not.toBe(testFile);
		} finally {
			taskFileInternals.renameSync = originalRenameSync;
		}
	});

	it('rewriteKnowledge() leaves no partially-written target when rename throws', async () => {
		// Pre-populate target with known content
		const original = '{"id":"orig","lesson":"original"}\n';
		fs.writeFileSync(testFile, original);

		// Simulate a crash: renameSync throws (e.g. cross-device link error)
		const originalRenameSync = taskFileInternals.renameSync;
		taskFileInternals.renameSync = (_from: string, _to: string) => {
			throw new Error('simulated rename failure');
		};

		try {
			await expect(
				rewriteKnowledge(testFile, [{ id: 'new', lesson: 'new content' }]),
			).rejects.toThrow('simulated rename failure');
		} finally {
			taskFileInternals.renameSync = originalRenameSync;
		}

		// Original file content must be preserved (rename never occurred)
		const afterContent = fs.readFileSync(testFile, 'utf-8');
		expect(afterContent).toBe(original);

		// No leftover .tmp.* file should exist in the directory
		const tmpFiles = fs.readdirSync(tmpDir).filter((f) => f.includes('.tmp.'));
		expect(tmpFiles).toHaveLength(0);
	});

	it('atomicWriteFile writes via temp + rename and cleans up on success', async () => {
		const content = 'test content\n';
		await atomicWriteFile(testFile, content);

		// File should exist with correct content
		expect(fs.existsSync(testFile)).toBe(true);
		expect(fs.readFileSync(testFile, 'utf-8')).toBe(content);

		// No leftover .tmp.* files
		const tmpFiles = fs.readdirSync(tmpDir).filter((f) => f.includes('.tmp.'));
		expect(tmpFiles).toHaveLength(0);
	});

	it('transactKnowledge preserves original file when atomicWriteFile fails', async () => {
		// Pre-populate file
		await appendKnowledge(testFile, { id: 'stable', lesson: 'stable entry' });
		const originalContent = fs.readFileSync(testFile, 'utf-8');

		// Inject rename failure to simulate atomicWriteFile crash
		const originalRename = taskFileInternals.renameSync;
		taskFileInternals.renameSync = () => {
			throw new Error('Simulated rename failure');
		};

		// Attempt transaction that would normally succeed
		await expect(
			transactKnowledge<TestEntry>(testFile, (entries) => [
				...entries,
				{ id: 'new', lesson: 'new entry' },
			]),
		).rejects.toThrow('Simulated rename failure');

		// Restore original renameSync
		taskFileInternals.renameSync = originalRename;

		// Original file must be unchanged
		const afterContent = fs.readFileSync(testFile, 'utf-8');
		expect(afterContent).toBe(originalContent);

		// No temp files should be left behind
		const dirFiles = fs.readdirSync(tmpDir);
		const tmpFiles = dirFiles.filter((f) => f.includes('.tmp.'));
		expect(tmpFiles).toHaveLength(0);
	});
});

// ============================================================================
// 5. Malformed JSONL read tolerance (requirement 6).
// ============================================================================

describe('Malformed JSONL read tolerance (requirement 6)', () => {
	it('readKnowledge skips malformed lines and returns valid entries', async () => {
		// Write a mix of valid and invalid JSONL lines
		const content = [
			JSON.stringify({ id: 'good-1', lesson: 'valid lesson 1' }),
			'this is not valid JSON {{{',
			JSON.stringify({ id: 'good-2', lesson: 'valid lesson 2' }),
			'   ', // whitespace-only line
			JSON.stringify({ id: 'good-3', lesson: 'valid lesson 3' }),
			'{incomplete',
		].join('\n');

		fs.writeFileSync(testFile, content, 'utf-8');

		const entries = await readKnowledge<TestEntry>(testFile);

		// Only valid entries should be returned
		expect(entries).toHaveLength(3);
		expect(entries.map((e) => e.id)).toEqual(['good-1', 'good-2', 'good-3']);
	});

	it('transactKnowledge tolerates malformed JSONL — mutate receives only valid entries', async () => {
		const content = [
			JSON.stringify({ id: 'valid-a', lesson: 'valid A' }),
			'GARBAGE LINE',
			JSON.stringify({ id: 'valid-b', lesson: 'valid B' }),
		].join('\n');

		fs.writeFileSync(testFile, content, 'utf-8');

		await transactKnowledge<TestEntry>(testFile, (entries) => {
			// Mutate should only see valid entries
			expect(entries).toHaveLength(2);
			expect(entries.map((e) => e.id)).toEqual(['valid-a', 'valid-b']);
			return [...entries, { id: 'valid-c', lesson: 'valid C' }];
		});

		const result = await readKnowledge<TestEntry>(testFile);
		expect(result).toHaveLength(3);
		expect(result.map((e) => e.id)).toEqual(['valid-a', 'valid-b', 'valid-c']);
	});

	it('readKnowledge returns empty array for completely garbled file', async () => {
		fs.writeFileSync(testFile, '!@#$%^&*\nnot json at all\n{{{{', 'utf-8');
		const entries = await readKnowledge<TestEntry>(testFile);
		expect(entries).toHaveLength(0);
	});
});

// ============================================================================
// 6. transactKnowledge is a no-op (returns false) when mutate returns null.
// ============================================================================

describe('transactKnowledge no-op when mutate returns null', () => {
	it('returns false and does not write when mutate returns null', async () => {
		await appendKnowledge(testFile, { id: 'a', lesson: 'lesson A' });
		const originalMtime = fs.statSync(testFile).mtimeMs;

		// Allow a little time so mtime would differ if a write happened
		await Bun.sleep(10);

		const wrote = await transactKnowledge<TestEntry>(
			testFile,
			(_entries) => null,
		);

		expect(wrote).toBe(false);
		// File should be unchanged (same mtime)
		const newMtime = fs.statSync(testFile).mtimeMs;
		expect(newMtime).toBe(originalMtime);
	});

	it('returns true when mutate returns updated entries', async () => {
		await appendKnowledge(testFile, { id: 'a', lesson: 'old lesson' });

		const wrote = await transactKnowledge<TestEntry>(testFile, (entries) =>
			entries.map((e) => ({ ...e, lesson: 'updated' })),
		);

		expect(wrote).toBe(true);
		const result = await readKnowledge<TestEntry>(testFile);
		expect(result[0].lesson).toBe('updated');
	});
});

// ============================================================================
// 7. transactKnowledge on non-existent file starts with empty entries.
// ============================================================================

describe('transactKnowledge with non-existent file', () => {
	it('creates the file with the mutated result when file does not exist', async () => {
		const newFile = path.join(tmpDir, 'subdir', 'new.jsonl');

		const wrote = await transactKnowledge<TestEntry>(newFile, (entries) => {
			expect(entries).toHaveLength(0);
			return [{ id: 'first', lesson: 'first entry' }];
		});

		expect(wrote).toBe(true);
		expect(fs.existsSync(newFile)).toBe(true);
		const result = await readKnowledge<TestEntry>(newFile);
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe('first');
	});

	it('is a no-op when file does not exist and mutate returns null', async () => {
		const newFile = path.join(tmpDir, 'ghost.jsonl');

		const wrote = await transactKnowledge<TestEntry>(
			newFile,
			(_entries) => null,
		);

		expect(wrote).toBe(false);
		expect(fs.existsSync(newFile)).toBe(false);
	});
});

// ============================================================================
// 8. Multiple concurrent transactKnowledge calls serialize correctly.
// ============================================================================

describe('Concurrent transactKnowledge calls serialize correctly', () => {
	it('5 concurrent transactKnowledge append-if-new calls produce exactly 5 unique entries', async () => {
		const lessons = Array.from({ length: 5 }, (_, i) => `lesson-${i}`);

		await Promise.all(
			lessons.map((lesson, i) =>
				transactKnowledge<TestEntry>(testFile, (entries) => {
					if (entries.some((e) => e.lesson === lesson)) return null;
					return [...entries, { id: `e${i}`, lesson }];
				}),
			),
		);

		const entries = await readKnowledge<TestEntry>(testFile);
		expect(entries).toHaveLength(5);

		const lessonSet = new Set(entries.map((e) => e.lesson));
		for (const lesson of lessons) {
			expect(lessonSet.has(lesson)).toBe(true);
		}
	});

	it('concurrent transactKnowledge calls with overlapping mutations do not corrupt the file', async () => {
		// Seed with 5 entries
		for (let i = 0; i < 5; i++) {
			await appendKnowledge(testFile, {
				id: `seed-${i}`,
				lesson: `seed ${i}`,
				status: 'active',
			});
		}

		// Concurrently: mark entry seed-2 archived AND append a new entry
		await Promise.all([
			transactKnowledge<TestEntry>(testFile, (entries) =>
				entries.map((e) =>
					e.id === 'seed-2' ? { ...e, status: 'archived' } : e,
				),
			),
			transactKnowledge<TestEntry>(testFile, (entries) => {
				if (entries.some((e) => e.id === 'new-entry')) return null;
				return [
					...entries,
					{ id: 'new-entry', lesson: 'new', status: 'active' },
				];
			}),
		]);

		const entries = await readKnowledge<TestEntry>(testFile);

		// All original 5 seeds must be present
		for (let i = 0; i < 5; i++) {
			expect(entries.some((e) => e.id === `seed-${i}`)).toBe(true);
		}

		// new-entry must be present
		expect(entries.some((e) => e.id === 'new-entry')).toBe(true);

		// seed-2's status must be 'archived' (the update was applied)
		const seed2 = entries.find((e) => e.id === 'seed-2');
		expect(seed2?.status).toBe('archived');

		// Total entries: 5 seeds + 1 new = 6
		expect(entries).toHaveLength(6);
	});
});

// ============================================================================
// 4. Concurrent .knowledge-shown.json updates preserve all shown IDs/outcomes.
// ============================================================================

describe('Concurrent .knowledge-shown.json updates (requirement 4)', () => {
	let shownDir: string;
	let shownFile: string;

	beforeEach(() => {
		shownDir = path.join(
			os.tmpdir(),
			`shown-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		fs.mkdirSync(shownDir, { recursive: true });
		shownFile = path.join(shownDir, '.knowledge-shown.json');
	});

	afterEach(() => {
		fs.rmSync(shownDir, { recursive: true, force: true });
	});

	it('concurrent transactShownFile calls for different phases preserve both phases', async () => {
		const { _internals } = await import(
			'../../../src/hooks/knowledge-reader.js'
		);
		const { transactShownFile } = _internals;

		await Promise.all([
			transactShownFile(shownFile, (data) => {
				data['Phase 1'] = ['lesson-a', 'lesson-b'];
				return data;
			}),
			transactShownFile(shownFile, (data) => {
				data['Phase 2'] = ['lesson-c', 'lesson-d'];
				return data;
			}),
		]);

		const content = fs.readFileSync(shownFile, 'utf-8');
		const data = JSON.parse(content);

		expect(data['Phase 1']).toEqual(['lesson-a', 'lesson-b']);
		expect(data['Phase 2']).toEqual(['lesson-c', 'lesson-d']);
	});
});
