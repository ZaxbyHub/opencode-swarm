import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import lockfile from 'proper-lockfile';
import {
	readKnowledge,
	sweepAgedEntries,
	sweepStaleTodos,
} from '../../../src/hooks/knowledge-store';
import type { SwarmKnowledgeEntry } from '../../../src/hooks/knowledge-types';
import { safeRmRecursive } from '../../helpers/safe-test-dir';

let tmpDir: string;
let knowledgePath: string;

beforeEach(() => {
	tmpDir = path.join(
		os.tmpdir(),
		`sweep-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	fs.mkdirSync(tmpDir, { recursive: true });
	knowledgePath = path.join(tmpDir, '.swarm', 'knowledge.jsonl');
	// Create .swarm directory for knowledge JSONL
	fs.mkdirSync(path.dirname(knowledgePath), { recursive: true });
});

afterEach(async () => {
	// Force-release any lingering locks on the .swarm directory
	const dir = path.dirname(knowledgePath);
	try {
		const release = await lockfile.lock(dir, {
			retries: { retries: 1, minTimeout: 50 },
		});
		await release();
	} catch {
		// Ignore if lock is already free or cannot be acquired
	}

	// Clean up lock files explicitly before removing directory
	const lockPath = path.join(dir, '.lock');
	try {
		if (fs.existsSync(lockPath)) {
			fs.rmSync(lockPath, { force: true, recursive: true });
		}
	} catch {
		// Ignore lock cleanup errors
	}

	// Give time for lock filesystem to settle
	await new Promise((resolve) => setTimeout(resolve, 100));

	safeRmRecursive(tmpDir);
});

function makeEntry(
	overrides: Partial<SwarmKnowledgeEntry> & { id: string; lesson: string },
): SwarmKnowledgeEntry {
	return {
		tier: 'swarm',
		category: 'process',
		tags: [],
		scope: 'global',
		confidence: 0.5,
		status: 'candidate',
		confirmed_by: [],
		project_name: 'test-project',
		retrieval_outcomes: {
			applied_count: 0,
			succeeded_after_count: 0,
			failed_after_count: 0,
		},
		schema_version: 1,
		created_at: new Date().toISOString(),
		updated_at: new Date().toISOString(),
		auto_generated: true,
		hive_eligible: false,
		...overrides,
	};
}

describe('sweepAgedEntries', () => {
	test('increments phases_alive from undefined → 1 → 2', async () => {
		const entry1 = makeEntry({
			id: '1',
			lesson: 'test lesson 1',
			status: 'candidate',
		});
		const entry2 = makeEntry({
			id: '2',
			lesson: 'test lesson 2',
			status: 'candidate',
		});
		fs.writeFileSync(knowledgePath, '');
		fs.appendFileSync(knowledgePath, JSON.stringify(entry1) + '\n');
		fs.appendFileSync(knowledgePath, JSON.stringify(entry2) + '\n');

		// First sweep
		const result1 = await sweepAgedEntries(knowledgePath, 10);
		expect(result1.aged).toBe(2);
		const entries1 = await readKnowledge<SwarmKnowledgeEntry>(knowledgePath);
		expect(entries1[0].phases_alive).toBe(1);
		expect(entries1[1].phases_alive).toBe(1);

		// Second sweep
		const result2 = await sweepAgedEntries(knowledgePath, 10);
		expect(result2.aged).toBe(2);
		const entries2 = await readKnowledge<SwarmKnowledgeEntry>(knowledgePath);
		expect(entries2[0].phases_alive).toBe(2);
		expect(entries2[1].phases_alive).toBe(2);
	});

	test('archives entry at exactly max_phases (boundary)', async () => {
		const entry = makeEntry({
			id: '1',
			lesson: 'test lesson',
			status: 'candidate',
			max_phases: 3,
			phases_alive: 2,
		});
		fs.writeFileSync(knowledgePath, JSON.stringify(entry) + '\n');

		// Before max_phases, entry should not be archived
		const result1 = await sweepAgedEntries(knowledgePath, 10);
		expect(result1.archived).toBe(0);
		const entries1 = await readKnowledge<SwarmKnowledgeEntry>(knowledgePath);
		expect(entries1[0].status).toBe('candidate');
		expect(entries1[0].phases_alive).toBe(3);

		// At max_phases, entry should be archived
		const result2 = await sweepAgedEntries(knowledgePath, 10);
		expect(result2.archived).toBe(1);
		const entries2 = await readKnowledge<SwarmKnowledgeEntry>(knowledgePath);
		expect(entries2[0].status).toBe('archived');
	});

	test('uses defaultMaxPhases when max_phases is not set', async () => {
		const entry = makeEntry({
			id: '1',
			lesson: 'test lesson',
			status: 'candidate',
			phases_alive: 4,
			// max_phases is undefined, should fall back to defaultMaxPhases
		});
		fs.writeFileSync(knowledgePath, JSON.stringify(entry) + '\n');

		// With defaultMaxPhases: 5, entry at 4 phases should not archive yet
		const result1 = await sweepAgedEntries(knowledgePath, 5);
		expect(result1.archived).toBe(0);
		const entries1 = await readKnowledge<SwarmKnowledgeEntry>(knowledgePath);
		expect(entries1[0].status).toBe('candidate');

		// One more sweep → reaches 5 phases and archives
		const result2 = await sweepAgedEntries(knowledgePath, 5);
		expect(result2.archived).toBe(1);
	});

	test('promoted entries are NOT aged and never archived', async () => {
		const promoted = makeEntry({
			id: '1',
			lesson: 'promoted lesson',
			status: 'promoted',
			phases_alive: 9,
			max_phases: 3,
		});
		fs.writeFileSync(knowledgePath, JSON.stringify(promoted) + '\n');

		const result = await sweepAgedEntries(knowledgePath, 10);
		expect(result.skipped_promoted).toBe(1);
		expect(result.archived).toBe(0);
		expect(result.aged).toBe(0); // promoted are not aged

		const entries = await readKnowledge<SwarmKnowledgeEntry>(knowledgePath);
		expect(entries[0].status).toBe('promoted');
		expect(entries[0].phases_alive).toBe(9); // unchanged
	});

	test('archived entries are skipped (no age bump, no re-archive)', async () => {
		const archived = makeEntry({
			id: '1',
			lesson: 'archived lesson',
			status: 'archived',
			phases_alive: 5,
		});
		fs.writeFileSync(knowledgePath, JSON.stringify(archived) + '\n');

		const result = await sweepAgedEntries(knowledgePath, 10);
		expect(result.aged).toBe(0); // archived entries not counted as aged
		expect(result.archived).toBe(0); // no archive transitions

		const entries = await readKnowledge<SwarmKnowledgeEntry>(knowledgePath);
		expect(entries[0].phases_alive).toBe(5); // unchanged
		expect(entries[0].status).toBe('archived'); // still archived
	});

	test('no-op on empty file', async () => {
		fs.writeFileSync(knowledgePath, '');

		const result = await sweepAgedEntries(knowledgePath, 10);
		expect(result.scanned).toBe(0);
		expect(result.aged).toBe(0);
		expect(result.archived).toBe(0);
	});
});

describe('sweepStaleTodos', () => {
	test('hard-removes todo entries past todoMaxPhases', async () => {
		const todo1 = makeEntry({
			id: '1',
			lesson: 'TODO: fix bug',
			category: 'todo',
			status: 'candidate',
			phases_alive: 2,
		});
		const todo2 = makeEntry({
			id: '2',
			lesson: 'TODO: refactor',
			category: 'todo',
			status: 'candidate',
			phases_alive: 4,
		});
		const process1 = makeEntry({
			id: '3',
			lesson: 'process lesson',
			category: 'process',
			status: 'candidate',
			phases_alive: 4,
		});
		fs.writeFileSync(knowledgePath, '');
		fs.appendFileSync(knowledgePath, JSON.stringify(todo1) + '\n');
		fs.appendFileSync(knowledgePath, JSON.stringify(todo2) + '\n');
		fs.appendFileSync(knowledgePath, JSON.stringify(process1) + '\n');

		// todoMaxPhases: 3, so todo2 (4 phases) should be removed
		const result = await sweepStaleTodos(knowledgePath, 3);
		expect(result.removed).toBe(1);

		const entries = await readKnowledge<SwarmKnowledgeEntry>(knowledgePath);
		expect(entries).toHaveLength(2);
		expect(entries.map((e) => e.id)).toEqual(['1', '3']);
	});

	test('leaves non-todo entries untouched even when aged', async () => {
		const process1 = makeEntry({
			id: '1',
			lesson: 'process lesson',
			category: 'process',
			status: 'candidate',
			phases_alive: 10,
		});
		const architecture1 = makeEntry({
			id: '2',
			lesson: 'architecture lesson',
			category: 'architecture',
			status: 'candidate',
			phases_alive: 99,
		});
		fs.writeFileSync(knowledgePath, '');
		fs.appendFileSync(knowledgePath, JSON.stringify(process1) + '\n');
		fs.appendFileSync(knowledgePath, JSON.stringify(architecture1) + '\n');

		const result = await sweepStaleTodos(knowledgePath, 3);
		expect(result.removed).toBe(0);

		const entries = await readKnowledge<SwarmKnowledgeEntry>(knowledgePath);
		expect(entries).toHaveLength(2);
		expect(entries[0].category).toBe('process');
		expect(entries[1].category).toBe('architecture');
	});

	test('no-op on empty file', async () => {
		fs.writeFileSync(knowledgePath, '');

		const result = await sweepStaleTodos(knowledgePath, 3);
		expect(result.scanned).toBe(0);
		expect(result.removed).toBe(0);
	});

	test('promoted TODO entries are NOT removed (TTL-exempt per design)', async () => {
		const promotedTodo = makeEntry({
			id: '1',
			lesson: 'TODO: critical blocker',
			category: 'todo',
			status: 'promoted',
			phases_alive: 100, // Way past todoMaxPhases: 3
		});
		const regularTodo = makeEntry({
			id: '2',
			lesson: 'TODO: old task',
			category: 'todo',
			status: 'candidate',
			phases_alive: 5, // Past todoMaxPhases: 3
		});
		fs.writeFileSync(knowledgePath, '');
		fs.appendFileSync(knowledgePath, JSON.stringify(promotedTodo) + '\n');
		fs.appendFileSync(knowledgePath, JSON.stringify(regularTodo) + '\n');

		const result = await sweepStaleTodos(knowledgePath, 3);
		expect(result.removed).toBe(1); // only regularTodo removed

		const entries = await readKnowledge<SwarmKnowledgeEntry>(knowledgePath);
		expect(entries).toHaveLength(1);
		expect(entries[0].id).toBe('1'); // promoted survives
	});
});

describe('sweep regression tests', () => {
	test('age bumps persist across separate sweep calls (not just archives)', async () => {
		const entry = makeEntry({
			id: '1',
			lesson: 'test lesson',
			status: 'candidate',
			max_phases: 10, // High TTL so we test age persistence, not archival
		});
		fs.writeFileSync(knowledgePath, JSON.stringify(entry) + '\n');

		// Sweep 1: undefined → 1
		const result1 = await sweepAgedEntries(knowledgePath, 10);
		expect(result1.aged).toBe(1);

		// Sweep 2: should read phases_alive: 1 from disk, bump to 2 (NOT reset to 1)
		const result2 = await sweepAgedEntries(knowledgePath, 10);
		expect(result2.aged).toBe(1);
		const entries2 = await readKnowledge<SwarmKnowledgeEntry>(knowledgePath);
		expect(entries2[0].phases_alive).toBe(2); // proves persistence
	});

	test('nested sweep does not deadlock (direct writeFile under held lock)', async () => {
		const entry = makeEntry({
			id: '1',
			lesson: 'test lesson',
			status: 'candidate',
			max_phases: 0, // Archives on sweep 1 (0+1=1, 1 > 0 → archive)
		});
		fs.writeFileSync(knowledgePath, JSON.stringify(entry) + '\n');

		// Under nested lock bug, this hangs on stale timeout (~5s).
		// After fix, should complete quickly.
		const start = Date.now();
		const result = await sweepAgedEntries(knowledgePath, 10);
		const elapsed = Date.now() - start;

		expect(result.archived).toBe(1);
		expect(elapsed).toBeLessThan(2000); // proves no 5s stall
	});

	test('sweep succeeds on fresh directory (mkdir before lock)', async () => {
		// Delete .swarm dir entirely to simulate fresh install
		safeRmRecursive(path.dirname(knowledgePath));

		// Under the bug (no mkdir), lock on non-existent dir crashes.
		// After fix, mkdir precedes lock so this succeeds.
		const result = await sweepAgedEntries(knowledgePath, 10);
		expect(result.scanned).toBe(0); // No file yet, but no crash
		expect(fs.existsSync(path.dirname(knowledgePath))).toBe(true);
	});
});
