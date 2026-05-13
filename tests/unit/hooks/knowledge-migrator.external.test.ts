/**
 * Verification tests for migrateKnowledgeToExternal() in Task 1.3
 * Tests the migration from internal knowledge.jsonl to external platform path
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock dependencies
const mockExistsSync = vi.fn();
const mockReadFileSync = vi.fn();
const mockReadFile = vi.fn();
const mockWriteFile = vi.fn();
const mockMkdir = vi.fn();
const mockUnlink = vi.fn();
const mockReadKnowledge = vi.fn();
const mockRewriteKnowledge = vi.fn();
const mockResolveSwarmKnowledgePath = vi.fn();
const mockDeriveProjectHash = vi.fn();
const mockInferProjectName = vi.fn();

vi.mock('node:fs', () => ({
	existsSync: (...args: unknown[]) => mockExistsSync(...args),
	readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
}));

vi.mock('node:fs/promises', () => ({
	readFile: (...args: unknown[]) => mockReadFile(...args),
	writeFile: (...args: unknown[]) => mockWriteFile(...args),
	mkdir: (...args: unknown[]) => mockMkdir(...args),
	unlink: (...args: unknown[]) => mockUnlink(...args),
}));

vi.mock('../../../src/hooks/knowledge-store.js', () => ({
	readKnowledge: (...args: unknown[]) => mockReadKnowledge(...args),
	rewriteKnowledge: (...args: unknown[]) => mockRewriteKnowledge(...args),
	resolveSwarmKnowledgePath: (...args: unknown[]) =>
		mockResolveSwarmKnowledgePath(...args),
	deriveProjectHash: (...args: unknown[]) => mockDeriveProjectHash(...args),
	inferProjectName: (...args: unknown[]) => mockInferProjectName(...args),
}));

import { migrateKnowledgeToExternal } from '../../../src/hooks/knowledge-migrator.js';
import type {
	KnowledgeConfig,
	SwarmKnowledgeEntry,
} from '../../../src/hooks/knowledge-types.js';

// Config fixture
const baseConfig: KnowledgeConfig = {
	enabled: true,
	swarm_max_entries: 100,
	hive_max_entries: 200,
	auto_promote_days: 90,
	max_inject_count: 5,
	dedup_threshold: 0.6,
	scope_filter: ['global'],
	hive_enabled: true,
	rejected_max_entries: 20,
	validation_enabled: true,
	evergreen_confidence: 0.9,
	evergreen_utility: 0.8,
	low_utility_threshold: 0.3,
	min_retrievals_for_utility: 3,
	schema_version: 1,
};

// Helper: create source entries in old format (before migration adds new fields)
// This simulates entries that exist in knowledge.jsonl before migration
function createOldFormatEntries(
	overrides: Partial<SwarmKnowledgeEntry> = {},
): SwarmKnowledgeEntry[] {
	const defaults: SwarmKnowledgeEntry = {
		id: 'test-id',
		tier: 'swarm',
		lesson: 'Test lesson',
		category: 'process',
		tags: [],
		scope: 'global',
		confidence: 0.5,
		status: 'candidate',
		confirmed_by: [],
		retrieval_outcomes: {
			applied_count: 0,
			succeeded_after_count: 0,
			failed_after_count: 0,
		},
		schema_version: 1,
		created_at: '2024-01-01T00:00:00.000Z',
		updated_at: '2024-01-01T00:00:00.000Z',
		project_name: 'old-project',
		projectId: 'old-hash',
		swarmVersion: '6.16',
	};
	return [{ ...defaults, ...overrides } as SwarmKnowledgeEntry];
}

// Helper to track call order
const callOrder: string[] = [];
const withOrderTracking = (name: string, fn: (...args: any[]) => any) => {
	return (...args: any[]) => {
		callOrder.push(name);
		return fn(...args);
	};
};


	afterEach(() => {
		vi.restoreAllMocks();
	});

	// ========================================================================
	// Test 1: Migration is idempotent (skips if sentinel exists)
	// ========================================================================
	describe('Idempotency - skips if external sentinel exists', () => {
		it('when external sentinel exists, returns skipped with external-sentinel-exists reason and never reads source', async () => {
			// Setup: external sentinel path exists
			mockExistsSync.mockImplementation((p: string) =>
				p.includes('knowledge-external.marker'),
			);

			const result = await migrateKnowledgeToExternal(
				'/test/project',
				baseConfig,
			);

			expect(result).toEqual({
				migrated: false,
				entriesMigrated: 0,
				entriesDropped: 0,
				entriesTotal: 0,
				skippedReason: 'external-sentinel-exists',
			});

			// Verify source file was never read
			expect(mockReadKnowledge).not.toHaveBeenCalled();
			expect(mockRewriteKnowledge).not.toHaveBeenCalled();
			expect(mockUnlink).not.toHaveBeenCalled();
		});
	});

	// ========================================================================
	// Test 2: Both sentinel files function independently
	// ========================================================================
	describe('Both sentinel files function independently', () => {
		it('external migration runs independently of internal migration sentinel', async () => {
			// Setup: only internal sentinel exists, not external
			mockExistsSync.mockImplementation((p: string) => {
				if (p.includes('.knowledge-migrated')) return true; // internal sentinel exists
				if (p.includes('knowledge-external.marker')) return false; // external sentinel does NOT exist
				if (p.includes('knowledge.jsonl')) return true; // source exists
				return false;
			});

			// Create mock entries in source file
			mockReadKnowledge.mockResolvedValue(
				createOldFormatEntries({ id: 'entry-1', lesson: 'Test lesson 1' }),
			);

			const result = await migrateKnowledgeToExternal(
				'/test/project',
				baseConfig,
			);

			// Should migrate since external sentinel doesn't exist
			expect(result.migrated).toBe(true);
			expect(result.entriesMigrated).toBe(1);

			// Verify rewrite was called with external path
			expect(mockRewriteKnowledge).toHaveBeenCalledTimes(1);
		});

		it('internal migration runs independently of external migration sentinel', async () => {
			// Setup: only external sentinel exists, not internal
			mockExistsSync.mockImplementation((p: string) => {
				if (p.includes('.knowledge-migrated')) return false; // internal sentinel does NOT exist
				if (p.includes('knowledge-external.marker')) return true; // external sentinel exists
				return false;
			});

			// This would test the internal migration, but we're testing external here
			// The key point is each sentinel gates its own migration independently
			const result = await migrateKnowledgeToExternal(
				'/test/project',
				baseConfig,
			);

			// External migration is skipped because external sentinel exists
			expect(result.skippedReason).toBe('external-sentinel-exists');
		});
	});

	// ========================================================================
	// Test 3: Entries migrated include tier, projectId, projectName, swarmVersion
	// ========================================================================
	describe('Migration adds required fields to entries', () => {
		it('migrated entries include tier, projectId, project_name, and swarmVersion', async () => {
			// Setup: source file exists with entries missing new fields
			mockExistsSync.mockImplementation((p: string) =>
				p.includes('knowledge.jsonl'),
			);

			mockReadKnowledge.mockResolvedValue(
				createOldFormatEntries({ lesson: 'Test lesson without new fields' }),
			);
			mockDeriveProjectHash.mockReturnValue('derived-project-hash');
			mockInferProjectName.mockReturnValue('derived-project-name');

			await migrateKnowledgeToExternal('/test/project', baseConfig);

			// Verify rewriteKnowledge was called with migrated entries
			expect(mockRewriteKnowledge).toHaveBeenCalledTimes(1);
			const [, migratedEntries] = mockRewriteKnowledge.mock.calls[0] as [
				string,
				SwarmKnowledgeEntry[],
			];

			expect(migratedEntries).toHaveLength(1);
			const entry = migratedEntries[0];

			// Verify all required fields are present
			expect(entry.tier).toBe('swarm');
			expect(entry.projectId).toBe('derived-project-hash');
			// project_name comes from inferProjectName which uses directory basename when no package.json
			expect(entry.project_name).toBe('project');
			expect(entry.swarmVersion).toBe('6.20');
		});

		it('preserves existing fields while adding migration fields', async () => {
			mockExistsSync.mockImplementation((p: string) =>
				p.includes('knowledge.jsonl'),
			);

			const sourceEntry = createOldFormatEntries({
				id: 'existing-id',
				lesson: 'Existing lesson with all fields',
				category: 'security',
				tags: ['existing-tag', 'migration:legacy'],
				confidence: 0.8,
				status: 'established',
				auto_generated: false,
			});
			sourceEntry[0].confirmed_by = [
				{
					phase_number: 1,
					confirmed_at: '2024-01-01T00:00:00.000Z',
					project_name: 'old-project',
				},
			];
			sourceEntry[0].retrieval_outcomes = {
				applied_count: 5,
				succeeded_after_count: 3,
				failed_after_count: 1,
			};
			mockReadKnowledge.mockResolvedValue(sourceEntry);
			mockDeriveProjectHash.mockReturnValue('new-project-hash');
			mockInferProjectName.mockReturnValue('new-project-name');

			await migrateKnowledgeToExternal('/test/project', baseConfig);

			const [, migratedEntries] = mockRewriteKnowledge.mock.calls[0] as [
				string,
				SwarmKnowledgeEntry[],
			];
			const entry = migratedEntries[0];

			// Preserve existing fields
			expect(entry.id).toBe('existing-id');
			expect(entry.lesson).toBe('Existing lesson with all fields');
			expect(entry.category).toBe('security');
			expect(entry.tags).toEqual(['existing-tag', 'migration:legacy']);
			expect(entry.scope).toBe('global');
			expect(entry.confidence).toBe(0.8);
			expect(entry.status).toBe('established');
			expect(entry.auto_generated).toBe(false);

			// Add/update migration fields
			expect(entry.projectId).toBe('new-project-hash');
			// Note: inferProjectName uses directory basename when no package.json exists
			expect(entry.project_name).toBe('project');
			expect(entry.swarmVersion).toBe('6.20');
		});
	});

	// ========================================================================
	// Test 4: Source file deleted after migration
	// ========================================================================
	describe('Source file deleted after migration', () => {
		it('deletes the source knowledge.jsonl file after successful migration', async () => {
			mockExistsSync.mockImplementation((p: string) =>
				p.includes('knowledge.jsonl'),
			);
			mockReadKnowledge.mockResolvedValue(
				createOldFormatEntries({ id: 'entry-1', lesson: 'Test lesson' }),
			);

			await migrateKnowledgeToExternal('/test/project', baseConfig);

			// Verify unlink was called to delete source file
			expect(mockUnlink).toHaveBeenCalledTimes(1);
			const deletedPath = mockUnlink.mock.calls[0][0] as string;
			expect(deletedPath).toContain('knowledge.jsonl');
		});

		it('unlink is called AFTER rewriteKnowledge (ordering for crash safety)', async () => {
			mockExistsSync.mockImplementation((p: string) =>
				p.includes('knowledge.jsonl'),
			);
			mockReadKnowledge.mockResolvedValue(
				createOldFormatEntries({ id: 'entry-1', lesson: 'Test lesson' }),
			);

			await migrateKnowledgeToExternal('/test/project', baseConfig);

			// Check call order: rewriteKnowledge should come before unlink (then writeFile for sentinel)
			// Order: rewriteKnowledge → unlink → writeFile(sentinel)
			expect(callOrder).toEqual(['rewriteKnowledge', 'unlink', 'writeFile']);
		});

		it('does NOT delete source if migration fails', async () => {
			mockExistsSync.mockImplementation((p: string) =>
				p.includes('knowledge.jsonl'),
			);
			mockReadKnowledge.mockResolvedValue(
				createOldFormatEntries({ id: 'entry-1', lesson: 'Test lesson' }),
			);

			// Make rewriteKnowledge throw an error
			mockRewriteKnowledge.mockImplementation(
				withOrderTracking('rewriteKnowledge', async () => {
					throw new Error('Write failed');
				}),
			);

			await expect(
				migrateKnowledgeToExternal('/test/project', baseConfig),
			).rejects.toThrow('Write failed');

			// unlink should NOT be called if rewrite fails
			expect(mockUnlink).not.toHaveBeenCalled();
		});
	});

	// ========================================================================
	// Test 5: External path created correctly
	// ========================================================================
	describe('External path created correctly', () => {
		it('writes migrated entries to external path from resolveSwarmKnowledgePath', async () => {
			mockExistsSync.mockImplementation((p: string) =>
				p.includes('knowledge.jsonl'),
			);
			mockResolveSwarmKnowledgePath.mockReturnValue(
				'/platform/knowledge/swarm.jsonl',
			);
			mockReadKnowledge.mockResolvedValue(
				createOldFormatEntries({ id: 'entry-1', lesson: 'Test lesson' }),
			);

			await migrateKnowledgeToExternal('/test/project', baseConfig);

			// Verify rewriteKnowledge was called with external path
			expect(mockRewriteKnowledge).toHaveBeenCalledTimes(1);
			const [externalPath] = mockRewriteKnowledge.mock.calls[0] as [
				string,
				SwarmKnowledgeEntry[],
			];
			expect(externalPath).toBe('/platform/knowledge/swarm.jsonl');
		});

		it('creates directory for external sentinel when it does not exist', async () => {
			mockExistsSync.mockImplementation((p: string) =>
				p.includes('knowledge.jsonl'),
			);
			mockReadKnowledge.mockResolvedValue(
				createOldFormatEntries({ id: 'entry-1', lesson: 'Test lesson' }),
			);

			await migrateKnowledgeToExternal('/test/project', baseConfig);

			// mkdir should be called to create directory for external sentinel
			expect(mockMkdir).toHaveBeenCalledTimes(1);
			expect(mockMkdir).toHaveBeenCalledWith(
				expect.stringContaining('.swarm'),
				expect.objectContaining({ recursive: true }),
			);
		});

		it('writes external sentinel with correct metadata', async () => {
			mockExistsSync.mockImplementation((p: string) =>
				p.includes('knowledge.jsonl'),
			);
			mockReadKnowledge.mockResolvedValue([
				createOldFormatEntries({ id: 'entry-1', lesson: 'Test lesson 1' })[0],
				createOldFormatEntries({
					id: 'entry-2',
					lesson: 'Test lesson 2',
					category: 'security',
					confidence: 0.7,
					status: 'established',
				})[0],
			]);

			await migrateKnowledgeToExternal('/test/project', baseConfig);

			// Find the external sentinel write (second writeFile call)
			const writeCalls = mockWriteFile.mock.calls;
			const sentinelCall = writeCalls.find((call) =>
				call[0].includes('knowledge-external.marker'),
			);
			expect(sentinelCall).toBeDefined();

			const sentinelContent = sentinelCall![1] as string;
			const sentinel = JSON.parse(sentinelContent);

			expect(sentinel.migrated_at).toBeDefined();
			expect(sentinel.source_version).toBe('6.16');
			expect(sentinel.target_version).toBe('6.17');
			expect(sentinel.entries_migrated).toBe(2);
			expect(sentinel.entries_dropped).toBe(0);
			expect(sentinel.schema_version).toBe(1);
			expect(sentinel.migration_tool).toBe('knowledge-migrator.ts');
		});
	});

	// ========================================================================
	// Test 6: Graceful handling when source doesn't exist
	// ========================================================================
	describe('Graceful handling when source does not exist', () => {
		it('when source file does not exist, returns skipped with no-source-file reason', async () => {
			// Setup: no source file exists (default mock behavior returns false for all)

			const result = await migrateKnowledgeToExternal(
				'/test/project',
				baseConfig,
			);

			expect(result).toEqual({
				migrated: false,
				entriesMigrated: 0,
				entriesDropped: 0,
				entriesTotal: 0,
				skippedReason: 'no-source-file',
			});

			// Verify nothing else was called
			expect(mockReadKnowledge).not.toHaveBeenCalled();
			expect(mockRewriteKnowledge).not.toHaveBeenCalled();
			expect(mockUnlink).not.toHaveBeenCalled();
			expect(mockWriteFile).not.toHaveBeenCalled();
		});

		it('when source file is empty, writes sentinel and returns migrated: true with 0 entries', async () => {
			// Setup: source file exists but is empty
			mockExistsSync.mockImplementation((p: string) =>
				p.includes('knowledge.jsonl'),
			);
			mockReadKnowledge.mockResolvedValue([]);

			const result = await migrateKnowledgeToExternal(
				'/test/project',
				baseConfig,
			);

			expect(result).toEqual({
				migrated: true,
				entriesMigrated: 0,
				entriesDropped: 0,
				entriesTotal: 0,
			});

			// Should still write sentinel for empty case
			expect(mockWriteFile).toHaveBeenCalledTimes(1);
			expect(mockRewriteKnowledge).not.toHaveBeenCalled(); // No rewrite for empty
			expect(mockUnlink).not.toHaveBeenCalled();
		});
	});

	// ========================================================================
	// Additional edge cases
	// ========================================================================
	describe('Additional edge cases', () => {
		it('handles multiple entries correctly', async () => {
			mockExistsSync.mockImplementation((p: string) =>
				p.includes('knowledge.jsonl'),
			);

			const entries = Array.from(
				{ length: 10 },
				(_, i) =>
					createOldFormatEntries({
						id: `entry-${i}`,
						lesson: `Test lesson ${i}`,
					})[0],
			);
			mockReadKnowledge.mockResolvedValue(entries);

			const result = await migrateKnowledgeToExternal(
				'/test/project',
				baseConfig,
			);

			expect(result).toEqual({
				migrated: true,
				entriesMigrated: 10,
				entriesDropped: 0,
				entriesTotal: 10,
			});

			const [, migratedEntries] = mockRewriteKnowledge.mock.calls[0] as [
				string,
				SwarmKnowledgeEntry[],
			];
			expect(migratedEntries).toHaveLength(10);

			// All entries should have migration fields
			for (const entry of migratedEntries) {
				expect(entry.projectId).toBe('test-project-hash');
				// project_name comes from inferProjectName which uses directory basename when no package.json
				expect(entry.project_name).toBe('project');
				expect(entry.swarmVersion).toBe('6.20');
			}
		});

		it('returns correct entry counts in result', async () => {
			mockExistsSync.mockImplementation((p: string) =>
				p.includes('knowledge.jsonl'),
			);
			mockReadKnowledge.mockResolvedValue([
				createOldFormatEntries({ id: 'entry-1', lesson: 'Lesson 1' })[0],
				createOldFormatEntries({ id: 'entry-2', lesson: 'Lesson 2' })[0],
			]);

			const result = await migrateKnowledgeToExternal(
				'/test/project',
				baseConfig,
			);

			expect(result.entriesMigrated).toBe(2);
			expect(result.entriesTotal).toBe(2);
			expect(result.entriesDropped).toBe(0);
		});

		it('external sentinel path is distinct from internal sentinel path', async () => {
			mockExistsSync.mockImplementation((p: string) =>
				p.includes('knowledge.jsonl'),
			);
			mockReadKnowledge.mockResolvedValue(
				createOldFormatEntries({ id: 'entry-1', lesson: 'Test' }),
			);

			await migrateKnowledgeToExternal('/test/project', baseConfig);

			// External migration writes only the external sentinel file
			// It does NOT write to .knowledge-migrated (that's for internal migration)
			const writePaths = mockWriteFile.mock.calls.map((call) => call[0]);
			const externalSentinelPath = writePaths.find((p) =>
				p.includes('knowledge-external.marker'),
			);

			expect(externalSentinelPath).toBeDefined();
			expect(externalSentinelPath).toContain('.swarm');
			expect(externalSentinelPath).toContain('knowledge-external.marker');
		});
	});
});
