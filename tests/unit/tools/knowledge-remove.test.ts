/**
 * Verification tests for knowledge_remove tool (FR-A2)
 * Covers: successful removal, entry not found, double-deletion idempotency, file read/write errors
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { knowledge_add } from '../../../src/tools/knowledge-add';
import { knowledge_remove } from '../../../src/tools/knowledge-remove';

describe('knowledge_remove tool verification tests', () => {
	let tmpDir: string;
	let originalCwd: string;

	beforeEach(async () => {
		// Create a temporary directory for each test
		tmpDir = await fs.realpath(
			await fs.mkdtemp(path.join(os.tmpdir(), 'knowledge-remove-test-')),
		);
		// Ensure .swarm/ directory exists
		await fs.mkdir(path.join(tmpDir, '.swarm'), { recursive: true });
		// Save original cwd and change to tmpDir for tests
		originalCwd = process.cwd();
		process.chdir(tmpDir);
	});

	afterEach(async () => {
		// Restore original cwd
		process.chdir(originalCwd);
		// Clean up the temporary directory
		try {
			await fs.rm(tmpDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	// Helper to read knowledge.jsonl and parse entries
	function readKnowledgeEntries(): Array<Record<string, unknown>> {
		const knowledgePath = path.join(tmpDir, '.swarm', 'knowledge.jsonl');
		try {
			const content = readFileSync(knowledgePath, 'utf-8');
			return content
				.trim()
				.split('\n')
				.filter((line) => line.length > 0)
				.map((line) => JSON.parse(line));
		} catch {
			return [];
		}
	}

	// ========== Test 1: Successful removal ==========
	describe('Successful removal', () => {
		it('Returns {success: true, removed: 1} when entry exists and is removed', async () => {
			// First add an entry using knowledge_add
			const addResult = await knowledge_add.execute(
				{
					lesson: 'This lesson should be removed successfully',
					category: 'process',
					tags: ['test', 'removal'],
				},
				tmpDir,
			);

			const addParsed = JSON.parse(addResult);
			expect(addParsed.success).toBe(true);
			const entryId = addParsed.id;

			// Verify entry was stored
			let entries = readKnowledgeEntries();
			expect(entries).toHaveLength(1);

			// Remove the entry
			const removeResult = await knowledge_remove.execute(
				{ id: entryId },
				tmpDir,
			);

			const removeParsed = JSON.parse(removeResult);
			expect(removeParsed.success).toBe(true);
			expect(removeParsed.removed).toBe(1);
			expect(removeParsed.remaining).toBe(0);

			// Verify entry was actually removed
			entries = readKnowledgeEntries();
			expect(entries).toHaveLength(0);
		});

		it('Remaining entries are preserved after removal', async () => {
			// Add two entries
			const addResult1 = await knowledge_add.execute(
				{
					lesson: 'First lesson that should remain after removal',
					category: 'process',
					tags: ['test'],
				},
				tmpDir,
			);

			const addResult2 = await knowledge_add.execute(
				{
					lesson: 'Second lesson that should be removed',
					category: 'tooling',
					tags: ['test'],
				},
				tmpDir,
			);

			const parsed1 = JSON.parse(addResult1);
			const parsed2 = JSON.parse(addResult2);
			const idToRemove = parsed2.id;

			// Verify both entries exist
			let entries = readKnowledgeEntries();
			expect(entries).toHaveLength(2);

			// Remove only the second entry
			const removeResult = await knowledge_remove.execute(
				{ id: idToRemove },
				tmpDir,
			);

			const removeParsed = JSON.parse(removeResult);
			expect(removeParsed.success).toBe(true);
			expect(removeParsed.removed).toBe(1);
			expect(removeParsed.remaining).toBe(1);

			// Verify only the first entry remains
			entries = readKnowledgeEntries();
			expect(entries).toHaveLength(1);
			expect(entries[0].id).toBe(parsed1.id);
			expect(entries[0].lesson).toBe(
				'First lesson that should remain after removal',
			);
		});
	});

	// ========== Test 2: Entry not found ==========
	describe('Entry not found', () => {
		it('Returns {success: false, message: "entry not found"} for non-existent id', async () => {
			const nonExistentId = '00000000-0000-0000-0000-000000000000';

			const result = await knowledge_remove.execute(
				{ id: nonExistentId },
				tmpDir,
			);

			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(false);
			expect(parsed.message).toBe('entry not found');
		});

		it('Returns entry not found when knowledge file is empty', async () => {
			const result = await knowledge_remove.execute(
				{ id: 'any-id-here' },
				tmpDir,
			);

			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(false);
			expect(parsed.message).toBe('entry not found');
		});
	});

	// ========== Test 3: Double-deletion idempotency ==========
	describe('Double-deletion idempotency', () => {
		it('Deleting the same entry twice returns not found both times without crashing', async () => {
			// Add an entry
			const addResult = await knowledge_add.execute(
				{
					lesson: 'This entry will be deleted twice to test idempotency',
					category: 'process',
					tags: ['test', 'idempotency'],
				},
				tmpDir,
			);

			const addParsed = JSON.parse(addResult);
			const entryId = addParsed.id;

			// First deletion - should succeed
			const firstRemoveResult = await knowledge_remove.execute(
				{ id: entryId },
				tmpDir,
			);

			const firstParsed = JSON.parse(firstRemoveResult);
			expect(firstParsed.success).toBe(true);
			expect(firstParsed.removed).toBe(1);

			// Second deletion - should return not found without crashing
			const secondRemoveResult = await knowledge_remove.execute(
				{ id: entryId },
				tmpDir,
			);

			const secondParsed = JSON.parse(secondRemoveResult);
			expect(secondParsed.success).toBe(false);
			expect(secondParsed.message).toBe('entry not found');

			// Verify file is still valid (no corruption)
			const entries = readKnowledgeEntries();
			expect(entries).toHaveLength(0);
		});

		it('Multiple consecutive deletions of non-existent IDs all return not found', async () => {
			const fakeId1 = '11111111-1111-1111-1111-111111111111';
			const fakeId2 = '22222222-2222-2222-2222-222222222222';

			// First non-existent deletion
			const result1 = await knowledge_remove.execute({ id: fakeId1 }, tmpDir);
			const parsed1 = JSON.parse(result1);
			expect(parsed1.success).toBe(false);
			expect(parsed1.message).toBe('entry not found');

			// Second non-existent deletion
			const result2 = await knowledge_remove.execute({ id: fakeId2 }, tmpDir);
			const parsed2 = JSON.parse(result2);
			expect(parsed2.success).toBe(false);
			expect(parsed2.message).toBe('entry not found');
		});
	});

	// ========== Test 4: File read/write error handling ==========
	describe('File read/write error handling', () => {
		it('Handles corrupt JSONL gracefully - corrupt lines are skipped', async () => {
			// Write corrupted JSONL content
			const knowledgePath = path.join(tmpDir, '.swarm', 'knowledge.jsonl');
			await fs.writeFile(knowledgePath, '{ invalid json here\n', 'utf-8');

			// readKnowledge skips corrupt lines and returns valid entries (empty in this case)
			// So removal returns not found
			const result = await knowledge_remove.execute({ id: 'any-id' }, tmpDir);

			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(false);
			expect(parsed.message).toBe('entry not found');
		});

		it('Handles missing .swarm directory gracefully', async () => {
			// Remove .swarm directory
			await fs.rm(path.join(tmpDir, '.swarm'), {
				recursive: true,
				force: true,
			});

			const result = await knowledge_remove.execute({ id: 'any-id' }, tmpDir);

			const parsed = JSON.parse(result);
			// Should return not found when file doesn't exist
			expect(parsed.success).toBe(false);
			expect(parsed.message).toBe('entry not found');
		});

		it('Handles empty knowledge file', async () => {
			// Create empty knowledge file
			const knowledgePath = path.join(tmpDir, '.swarm', 'knowledge.jsonl');
			await fs.writeFile(knowledgePath, '', 'utf-8');

			const result = await knowledge_remove.execute({ id: 'any-id' }, tmpDir);

			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(false);
			expect(parsed.message).toBe('entry not found');
		});

		it('Handles file with only whitespace', async () => {
			const knowledgePath = path.join(tmpDir, '.swarm', 'knowledge.jsonl');
			await fs.writeFile(knowledgePath, '   \n\n   \n', 'utf-8');

			const result = await knowledge_remove.execute({ id: 'any-id' }, tmpDir);

			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(false);
			expect(parsed.message).toBe('entry not found');
		});

		it('Returns write error when file permissions prevent rewriting', async () => {
			// Add an entry first so we have something to remove
			const addResult = await knowledge_add.execute(
				{
					lesson: 'This entry will trigger a write error when removed',
					category: 'process',
					tags: ['test'],
				},
				tmpDir,
			);
			const addParsed = JSON.parse(addResult);
			const entryId = addParsed.id;

			// Make the knowledge file read-only so rewriteKnowledge fails
			const knowledgePath = path.join(tmpDir, '.swarm', 'knowledge.jsonl');

			// On Windows, use chmod to make file read-only
			// 0o444 = read-only
			await fs.chmod(knowledgePath, 0o444);

			try {
				const result = await knowledge_remove.execute({ id: entryId }, tmpDir);

				const parsed = JSON.parse(result);
				expect(parsed.success).toBe(false);
				expect(parsed.error).toBeDefined();
				expect(typeof parsed.error).toBe('string');
				expect(parsed.error.length).toBeGreaterThan(0);
			} finally {
				// Restore write permissions before cleanup
				await fs.chmod(knowledgePath, 0o644).catch(() => {});
			}
		});

		it('Returns read error when file permissions prevent reading', async () => {
			// Create knowledge file with an entry
			const knowledgePath = path.join(tmpDir, '.swarm', 'knowledge.jsonl');
			const entry = {
				id: '44444444-4444-4444-4444-444444444444',
				tier: 'swarm' as const,
				lesson: 'Test entry for read error',
				category: 'process' as const,
				tags: ['test'],
				scope: 'global',
				confidence: 0.5,
				status: 'candidate' as const,
				confirmed_by: [],
				project_name: '',
				retrieval_outcomes: {
					shown_count: 0,
					acknowledged_count: 0,
					applied_explicit_count: 0,
					ignored_count: 0,
					violated_count: 0,
					succeeded_after_shown_count: 0,
					failed_after_shown_count: 0,
				},
				schema_version: 1,
				created_at: new Date().toISOString(),
				updated_at: new Date().toISOString(),
				auto_generated: false,
				hive_eligible: false,
			};
			await fs.writeFile(knowledgePath, JSON.stringify(entry) + '\n', 'utf-8');

			// Make the file unreadable by removing read permissions
			await fs.chmod(knowledgePath, 0o000);

			try {
				const result = await knowledge_remove.execute({ id: entry.id }, tmpDir);

				const parsed = JSON.parse(result);
				expect(parsed.success).toBe(false);
				expect(parsed.error).toBeDefined();
				expect(typeof parsed.error).toBe('string');
				expect(parsed.error.length).toBeGreaterThan(0);
			} finally {
				// Restore read permissions before cleanup
				await fs.chmod(knowledgePath, 0o644).catch(() => {});
			}
		});
	});

	// ========== Test 5: Malicious getter defense ==========
	describe('Malicious getter defense', () => {
		it('Handles object with throwing getter for id property', async () => {
			// Create a mock args object with a getter that throws
			const maliciousArgs = new Proxy(
				{},
				{
					get(_target, prop) {
						if (prop === 'id') {
							throw new Error('malicious getter');
						}
						return undefined;
					},
				},
			);

			// This should not crash - should return error about invalid id
			// Note: The tool validates after safe extraction, so it checks typeof idInput !== 'string'
			const result = await (knowledge_remove as any).execute(
				maliciousArgs,
				tmpDir,
			);

			const parsed = JSON.parse(result);
			// The safe extraction catches the thrown getter and idInput is undefined
			expect(parsed.success).toBe(false);
			expect(parsed.error).toBe('id must be a non-empty string');
		});

		it('Handles null args object', async () => {
			const result = await (knowledge_remove as any).execute(null, tmpDir);

			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(false);
			expect(parsed.error).toBe('id must be a non-empty string');
		});

		it('Handles undefined args object', async () => {
			const result = await (knowledge_remove as any).execute(undefined, tmpDir);

			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(false);
			expect(parsed.error).toBe('id must be a non-empty string');
		});
	});

	// ========== Test 6: Input validation ==========
	describe('Input validation', () => {
		it('Rejects empty string id', async () => {
			const result = await knowledge_remove.execute({ id: '' }, tmpDir);

			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(false);
			expect(parsed.error).toBe('id must be a non-empty string');
		});

		it('Handles whitespace-only id as not found (passes length validation)', async () => {
			const result = await knowledge_remove.execute({ id: '   ' }, tmpDir);

			const parsed = JSON.parse(result);
			// '   ' is a non-empty string so it passes validation
			// then returns not found since no entry matches
			expect(parsed.success).toBe(false);
			expect(parsed.message).toBe('entry not found');
		});

		it('Accepts valid UUID format', async () => {
			// This should return not found (entry doesn't exist), not validation error
			const result = await knowledge_remove.execute(
				{ id: '550e8400-e29b-41d4-a716-446655440000' },
				tmpDir,
			);

			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(false);
			expect(parsed.message).toBe('entry not found');
		});
	});

	// ========== Test 7: Swarm/hive tier isolation ==========
	describe('Swarm/hive tier isolation', () => {
		it('Removes only swarm tier entry, leaving hive tier untouched', async () => {
			// Use a test-specific hive path instead of the real platform hive path
			const testHivePath = path.join(tmpDir, '.swarm', 'hive-knowledge.jsonl');

			// Create a swarm entry using knowledge_add
			const swarmAddResult = await knowledge_add.execute(
				{
					lesson: 'This is a swarm tier lesson that will be removed',
					category: 'process',
					tags: ['test', 'swarm-tier'],
				},
				tmpDir,
			);
			const swarmParsed = JSON.parse(swarmAddResult);
			const swarmId = swarmParsed.id;

			// Create a hive entry
			const hiveEntry = {
				id: '55555555-5555-5555-5555-555555555555',
				tier: 'hive' as const,
				lesson: 'This is a hive tier lesson that must remain',
				category: 'process' as const,
				tags: ['test', 'hive-tier'],
				scope: 'global',
				confidence: 0.7,
				status: 'promoted' as const,
				confirmed_by: [],
				project_name: '',
				retrieval_outcomes: {
					shown_count: 5,
					acknowledged_count: 3,
					applied_explicit_count: 2,
					ignored_count: 0,
					violated_count: 0,
					succeeded_after_shown_count: 1,
					failed_after_shown_count: 0,
				},
				schema_version: 1,
				created_at: new Date().toISOString(),
				updated_at: new Date().toISOString(),
				auto_generated: false,
				hive_eligible: true,
			};

			// Write hive entry to test-specific hive path
			const { appendKnowledge } = await import(
				'../../../src/hooks/knowledge-store.js'
			);
			await fs.mkdir(path.dirname(testHivePath), { recursive: true });
			await appendKnowledge(testHivePath, hiveEntry);

			// Verify swarm entry exists (only in swarm file)
			const entriesBeforeRemove = readKnowledgeEntries();
			expect(entriesBeforeRemove).toHaveLength(1);
			expect(entriesBeforeRemove[0].id).toBe(swarmId);

			// Read hive entries to verify hive entry exists
			const { readKnowledge: readHiveKnowledge } = await import(
				'../../../src/hooks/knowledge-store.js'
			);
			const hiveEntriesBefore = await readHiveKnowledge(testHivePath);
			expect(hiveEntriesBefore).toHaveLength(1);
			expect((hiveEntriesBefore[0] as any).id).toBe(
				'55555555-5555-5555-5555-555555555555',
			);
			expect((hiveEntriesBefore[0] as any).lesson).toBe(
				'This is a hive tier lesson that must remain',
			);

			// Remove the swarm entry
			const removeResult = await knowledge_remove.execute(
				{ id: swarmId },
				tmpDir,
			);
			const removeParsed = JSON.parse(removeResult);
			expect(removeParsed.success).toBe(true);
			expect(removeParsed.removed).toBe(1);

			// Verify swarm entry is removed
			const entriesAfterRemove = readKnowledgeEntries();
			expect(entriesAfterRemove).toHaveLength(0);

			// Verify hive entry is STILL intact (not affected by swarm removal)
			const hiveEntriesAfter = await readHiveKnowledge(testHivePath);
			expect(hiveEntriesAfter).toHaveLength(1);
			expect((hiveEntriesAfter[0] as any).id).toBe(
				'55555555-5555-5555-5555-555555555555',
			);
			expect((hiveEntriesAfter[0] as any).lesson).toBe(
				'This is a hive tier lesson that must remain',
			);
		});
	});
});
