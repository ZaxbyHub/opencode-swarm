import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// At top of file, before imports:
const mockExistsSync = vi.fn();
const mockReadFileSync = vi.fn();
const mockReadFile = vi.fn();
const mockWriteFile = vi.fn();
const mockMkdir = vi.fn();
const mockReadKnowledge = vi.fn();
const mockRewriteKnowledge = vi.fn();
const mockResolveSwarmKnowledgePath = vi.fn();
const mockFindNearDuplicate = vi.fn();
const mockInferTags = vi.fn();
const mockNormalize = vi.fn();
const mockValidateLesson = vi.fn();
const mockRandomUUID = vi.fn();

vi.mock('node:fs', () => ({
	existsSync: (...args: unknown[]) => mockExistsSync(...args),
	readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
}));

vi.mock('node:fs/promises', () => ({
	readFile: (...args: unknown[]) => mockReadFile(...args),
	writeFile: (...args: unknown[]) => mockWriteFile(...args),
	mkdir: (...args: unknown[]) => mockMkdir(...args),
}));

vi.mock('../../../src/hooks/knowledge-store.js', () => ({
	readKnowledge: (...args: unknown[]) => mockReadKnowledge(...args),
	rewriteKnowledge: (...args: unknown[]) => mockRewriteKnowledge(...args),
	resolveSwarmKnowledgePath: (...args: unknown[]) =>
		mockResolveSwarmKnowledgePath(...args),
	findNearDuplicate: (...args: unknown[]) => mockFindNearDuplicate(...args),
	inferTags: (...args: unknown[]) => mockInferTags(...args),
	normalize: (...args: unknown[]) => mockNormalize(...args),
	enforceKnowledgeCap: async () => {},
	sweepAgedEntries: async () => {},
	sweepStaleTodos: async () => {},
	bumpKnowledgeConfidenceBatch: async () => {},
}));

vi.mock('../../../src/hooks/knowledge-validator.js', () => ({
	validateLesson: (...args: unknown[]) => mockValidateLesson(...args),
}));

vi.mock('node:crypto', () => ({
	randomUUID: () => mockRandomUUID(),
}));

import { migrateContextToKnowledge } from '../../../src/hooks/knowledge-migrator.js';
import type { KnowledgeConfig } from '../../../src/hooks/knowledge-types.js';

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

// Helper to track call order
const callOrder: string[] = [];
const withOrderTracking = (name: string, fn: (...args: any[]) => any) => {
	return (...args: any[]) => {
		callOrder.push(name);
		return fn(...args);
	};
};

describe('migrateContextToKnowledge', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		callOrder.length = 0; // Clear order tracking

		// defaults
		mockExistsSync.mockReturnValue(false); // no files exist by default
		mockReadFile.mockResolvedValue('');
		mockWriteFile.mockImplementation(
			withOrderTracking('writeFile', async () => undefined),
		);
		mockMkdir.mockResolvedValue(undefined);
		mockReadKnowledge.mockResolvedValue([]);
		mockRewriteKnowledge.mockImplementation(
			withOrderTracking('rewriteKnowledge', async () => undefined),
		);
		mockResolveSwarmKnowledgePath.mockReturnValue(
			'/test/.swarm/knowledge.jsonl',
		);
		mockFindNearDuplicate.mockReturnValue(undefined); // no duplicate
		mockInferTags.mockReturnValue([]);
		mockNormalize.mockImplementation((s: string) => s.toLowerCase().trim());
		mockValidateLesson.mockReturnValue({
			valid: true,
			layer: null,
			reason: null,
			severity: null,
		});
		mockRandomUUID.mockReturnValue('test-uuid-1234');
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('Gate 1 — sentinel exists', () => {
		it('when sentinel exists, returns skipped with sentinel-exists reason and never reads context.md', async () => {
			// Setup: sentinel path exists
			mockExistsSync.mockImplementation((p: string) =>
				p.includes('.knowledge-migrated'),
			);

			const result = await migrateContextToKnowledge(
				'/test/project',
				baseConfig,
			);

			expect(result).toEqual({
				migrated: false,
				entriesMigrated: 0,
				entriesDropped: 0,
				entriesTotal: 0,
				skippedReason: 'sentinel-exists',
			});

			// Verify context.md was never read
			expect(mockReadFile).not.toHaveBeenCalled();
		});
	});

	describe('Gate 2 — no context.md', () => {
		it('when no context.md exists, returns skipped with no-context-file reason', async () => {
			// Setup: no files exist (default mock behavior)

			const result = await migrateContextToKnowledge(
				'/test/project',
				baseConfig,
			);

			expect(result).toEqual({
				migrated: false,
				entriesMigrated: 0,
				entriesDropped: 0,
				entriesTotal: 0,
				skippedReason: 'no-context-file',
			});

			expect(mockReadFile).not.toHaveBeenCalled();
		});
	});

	describe('Empty context.md', () => {
		it('when context.md exists but content is empty/whitespace, returns skipped with empty-context reason', async () => {
			// Setup: existsSync returns true only for context.md; readFile returns whitespace
			mockExistsSync.mockImplementation((p: string) =>
				p.includes('context.md'),
			);
			mockReadFile.mockResolvedValue('   \n\t  \n');

			const result = await migrateContextToKnowledge(
				'/test/project',
				baseConfig,
			);

			expect(result).toEqual({
				migrated: false,
				entriesMigrated: 0,
				entriesDropped: 0,
				entriesTotal: 0,
				skippedReason: 'empty-context',
			});

			expect(mockReadFile).toHaveBeenCalledTimes(1);
			expect(mockWriteFile).not.toHaveBeenCalled();
		});
	});

	describe('No parseable entries', () => {
		it('when context.md exists with content but no bullet points in known sections, writes sentinel and returns migrated: true with 0 entries', async () => {
			// Setup: readFile returns prose without bullets in known sections
			mockExistsSync.mockImplementation((p: string) =>
				p.includes('context.md'),
			);
			mockReadFile.mockResolvedValue(
				'# Context\nSome prose without bullets\nMore text here\n',
			);

			const result = await migrateContextToKnowledge(
				'/test/project',
				baseConfig,
			);

			expect(result).toEqual({
				migrated: true,
				entriesMigrated: 0,
				entriesDropped: 0,
				entriesTotal: 0,
			});

			// Sentinel should be written even though no entries were migrated
			expect(mockWriteFile).toHaveBeenCalledTimes(1);
			const sentinelPath = mockWriteFile.mock.calls[0][0] as string;
			const sentinelContent = mockWriteFile.mock.calls[0][1] as string;
			expect(sentinelPath).toContain('.knowledge-migrated');
			expect(sentinelContent).toContain('entries_migrated');

			// rewriteKnowledge should NOT be called since no entries were migrated
			expect(mockRewriteKnowledge).not.toHaveBeenCalled();
		});
	});

	describe('Successful migration from Lessons Learned section', () => {
		it('context.md has Lessons Learned with one bullet >= 15 chars, migrates 1 entry, writes knowledge and sentinel', async () => {
			const contextContent =
				'## Lessons Learned\n- Always use the .js extension in TypeScript ESM imports\n';
			mockExistsSync.mockImplementation((p: string) =>
				p.includes('context.md'),
			);
			mockReadFile.mockResolvedValue(contextContent);

			const result = await migrateContextToKnowledge(
				'/test/project',
				baseConfig,
			);

			expect(result).toEqual({
				migrated: true,
				entriesMigrated: 1,
				entriesDropped: 0,
				entriesTotal: 1,
			});

			// Verify rewriteKnowledge was called
			expect(mockRewriteKnowledge).toHaveBeenCalledTimes(1);

			// Verify sentinel was written
			expect(mockWriteFile).toHaveBeenCalledTimes(1);
			const sentinelPath = mockWriteFile.mock.calls[0][0] as string;
			expect(sentinelPath).toContain('.knowledge-migrated');
		});
	});

	describe('Migration extracts from all 4 sections', () => {
		it('context.md has all 4 sections with one bullet each (all >= 15 chars), migrates 4 entries', async () => {
			const contextContent = `## Lessons Learned
- Always use the .js extension in TypeScript ESM imports

## Patterns
- Use dependency injection to decouple components

## SME Cache
- Avoid premature optimization in data structures

## Decisions
- Chose Bun runtime for faster development cycle
`;
			mockExistsSync.mockImplementation((p: string) =>
				p.includes('context.md'),
			);
			mockReadFile.mockResolvedValue(contextContent);

			const result = await migrateContextToKnowledge(
				'/test/project',
				baseConfig,
			);

			expect(result).toEqual({
				migrated: true,
				entriesMigrated: 4,
				entriesDropped: 0,
				entriesTotal: 4,
			});

			expect(mockRewriteKnowledge).toHaveBeenCalledTimes(1);
			expect(mockWriteFile).toHaveBeenCalledTimes(1);
		});
	});

	describe('Bullets shorter than 15 chars are skipped', () => {
		it('bullets shorter than 15 chars are silently skipped, not counted as dropped', async () => {
			const contextContent =
				'## Lessons Learned\n- short\n- Long enough lesson text here\n';
			mockExistsSync.mockImplementation((p: string) =>
				p.includes('context.md'),
			);
			mockReadFile.mockResolvedValue(contextContent);

			const result = await migrateContextToKnowledge(
				'/test/project',
				baseConfig,
			);

			expect(result).toEqual({
				migrated: true,
				entriesMigrated: 1,
				entriesDropped: 0,
				entriesTotal: 1, // Only long bullet counted
			});

			expect(mockRewriteKnowledge).toHaveBeenCalledTimes(1);
		});
	});

	describe('Validation failure drops entry', () => {
		it('when validateLesson returns invalid for one entry, that entry is dropped', async () => {
			const contextContent =
				'## Lessons Learned\n- This lesson will fail validation\n';
			mockExistsSync.mockImplementation((p: string) =>
				p.includes('context.md'),
			);
			mockReadFile.mockResolvedValue(contextContent);

			// Setup: validation fails
			mockValidateLesson.mockReturnValue({
				valid: false,
				layer: 1,
				reason: 'too short',
				severity: 'error',
			});

			const result = await migrateContextToKnowledge(
				'/test/project',
				baseConfig,
			);

			expect(result).toEqual({
				migrated: true,
				entriesMigrated: 0,
				entriesDropped: 1,
				entriesTotal: 1,
			});

			// rewriteKnowledge should NOT be called since no entries were migrated
			expect(mockRewriteKnowledge).not.toHaveBeenCalled();

			// Sentinel should still be written
			expect(mockWriteFile).toHaveBeenCalledTimes(1);
		});
	});

	describe('Dedup drops entry', () => {
		it('when findNearDuplicate returns an existing entry, that entry is dropped', async () => {
			const contextContent =
				'## Lessons Learned\n- This lesson is a duplicate of existing\n';
			mockExistsSync.mockImplementation((p: string) =>
				p.includes('context.md'),
			);
			mockReadFile.mockResolvedValue(contextContent);

			// Setup: duplicate found
			mockFindNearDuplicate.mockReturnValue({
				id: 'existing-id',
				lesson: 'similar lesson',
			});

			const result = await migrateContextToKnowledge(
				'/test/project',
				baseConfig,
			);

			expect(result).toEqual({
				migrated: true,
				entriesMigrated: 0,
				entriesDropped: 1,
				entriesTotal: 1,
			});

			expect(mockRewriteKnowledge).not.toHaveBeenCalled();
			expect(mockWriteFile).toHaveBeenCalledTimes(1);
		});
	});

	describe('Sentinel written after successful migration', () => {
		it('after successful migration, writeFile is called with sentinel path', async () => {
			const contextContent =
				'## Lessons Learned\n- Successfully migrated lesson\n';
			mockExistsSync.mockImplementation((p: string) =>
				p.includes('context.md'),
			);
			mockReadFile.mockResolvedValue(contextContent);

			await migrateContextToKnowledge('/test/project', baseConfig);

			// Verify sentinel was written
			expect(mockWriteFile).toHaveBeenCalledTimes(1);
			const sentinelPath = mockWriteFile.mock.calls[0][0] as string;
			expect(sentinelPath).toContain('.knowledge-migrated');
		});
	});

	describe('Sentinel NOT written before rewriteKnowledge', () => {
		it('verifies writeFile is called AFTER rewriteKnowledge (ordering matters for crash safety)', async () => {
			const contextContent =
				'## Lessons Learned\n- Successfully migrated lesson\n';
			mockExistsSync.mockImplementation((p: string) =>
				p.includes('context.md'),
			);
			mockReadFile.mockResolvedValue(contextContent);

			await migrateContextToKnowledge('/test/project', baseConfig);

			// Check order of calls
			expect(callOrder).toEqual(['rewriteKnowledge', 'writeFile']);
		});
	});

	describe('Validation disabled via config', () => {
		it('when config.validation_enabled === false, validateLesson is NOT called and entries are migrated', async () => {
			const contextContent =
				'## Lessons Learned\n- This lesson will bypass validation\n';
			mockExistsSync.mockImplementation((p: string) =>
				p.includes('context.md'),
			);
			mockReadFile.mockResolvedValue(contextContent);

			const config = { ...baseConfig, validation_enabled: false };

			const result = await migrateContextToKnowledge('/test/project', config);

			expect(result).toEqual({
				migrated: true,
				entriesMigrated: 1,
				entriesDropped: 0,
				entriesTotal: 1,
			});

			// validateLesson should NOT be called
			expect(mockValidateLesson).not.toHaveBeenCalled();

			// But entry should still be migrated
			expect(mockRewriteKnowledge).toHaveBeenCalledTimes(1);
		});
	});

	describe('Migration source tag added to entry', () => {
		it('entry migrated from Lessons Learned should have migration:lessons-learned tag', async () => {
			const contextContent =
				'## Lessons Learned\n- Always use the .js extension in TypeScript ESM imports\n';
			mockExistsSync.mockImplementation((p: string) =>
				p.includes('context.md'),
			);
			mockReadFile.mockResolvedValue(contextContent);

			// Setup: inferTags returns some tags
			mockInferTags.mockReturnValue(['typescript', 'esm']);

			await migrateContextToKnowledge('/test/project', baseConfig);

			// Capture the entry passed to rewriteKnowledge
			expect(mockRewriteKnowledge).toHaveBeenCalledTimes(1);
			const knowledgePath = mockRewriteKnowledge.mock.calls[0][0];
			const entries = mockRewriteKnowledge.mock.calls[0][1] as unknown[];

			expect(knowledgePath).toBe('/test/.swarm/knowledge.jsonl');
			expect(entries).toHaveLength(1);

			const entry = entries[0] as { tags: string[] };
			expect(entry.tags).toContain('migration:lessons-learned');
			expect(entry.tags).toContain('typescript');
			expect(entry.tags).toContain('esm');
		});
	});

	describe('Additional edge cases', () => {
		it('handles multiple bullets from same section, deduplicating by normalized text', async () => {
			const contextContent =
				'## Lessons Learned\n- Use TypeScript for type safety\n- USE TYPESCRIPT FOR TYPE SAFETY\n- Another different lesson\n';
			mockExistsSync.mockImplementation((p: string) =>
				p.includes('context.md'),
			);
			mockReadFile.mockResolvedValue(contextContent);

			const result = await migrateContextToKnowledge(
				'/test/project',
				baseConfig,
			);

			// Should only migrate 2 entries (dedup by normalize)
			expect(result).toEqual({
				migrated: true,
				entriesMigrated: 2,
				entriesDropped: 0,
				entriesTotal: 2,
			});

			expect(mockRewriteKnowledge).toHaveBeenCalledTimes(1);
		});

		it('handles bullets with hyphen and asterisk bullet markers', async () => {
			const contextContent = `## Lessons Learned
- Lesson with hyphen marker
* Lesson with asterisk marker
`;
			mockExistsSync.mockImplementation((p: string) =>
				p.includes('context.md'),
			);
			mockReadFile.mockResolvedValue(contextContent);

			const result = await migrateContextToKnowledge(
				'/test/project',
				baseConfig,
			);

			expect(result).toEqual({
				migrated: true,
				entriesMigrated: 2,
				entriesDropped: 0,
				entriesTotal: 2,
			});
		});

		it('handles section headers with different heading levels (h1, h2, h3)', async () => {
			const contextContent = `# Lessons Learned
- H1 section lesson

## Patterns
- H2 section pattern

### SME Cache
- H3 section cache
`;
			mockExistsSync.mockImplementation((p: string) =>
				p.includes('context.md'),
			);
			mockReadFile.mockResolvedValue(contextContent);

			const result = await migrateContextToKnowledge(
				'/test/project',
				baseConfig,
			);

			expect(result).toEqual({
				migrated: true,
				entriesMigrated: 3,
				entriesDropped: 0,
				entriesTotal: 3,
			});
		});

		it('ignores unknown section headers', async () => {
			const contextContent = `## Lessons Learned
- This is a valid lesson from lessons learned section

## Unknown Section
- This should be ignored
`;
			mockExistsSync.mockImplementation((p: string) =>
				p.includes('context.md'),
			);
			mockReadFile.mockResolvedValue(contextContent);

			const result = await migrateContextToKnowledge(
				'/test/project',
				baseConfig,
			);

			expect(result).toEqual({
				migrated: true,
				entriesMigrated: 1,
				entriesDropped: 0,
				entriesTotal: 1,
			});
		});

		it('handles case-insensitive section matching', async () => {
			const contextContent = `## lessons learned
- case insensitive match

## PATTERNS
- also case insensitive
`;
			mockExistsSync.mockImplementation((p: string) =>
				p.includes('context.md'),
			);
			mockReadFile.mockResolvedValue(contextContent);

			const result = await migrateContextToKnowledge(
				'/test/project',
				baseConfig,
			);

			expect(result).toEqual({
				migrated: true,
				entriesMigrated: 2,
				entriesDropped: 0,
				entriesTotal: 2,
			});
		});

		it('creates directory for sentinel when it does not exist', async () => {
			const contextContent = '## Lessons Learned\n- New lesson\n';
			mockExistsSync.mockImplementation((p: string) =>
				p.includes('context.md'),
			);
			mockReadFile.mockResolvedValue(contextContent);

			await migrateContextToKnowledge('/test/project', baseConfig);

			// mkdir should be called to create directory for sentinel
			expect(mockMkdir).toHaveBeenCalledTimes(1);
			expect(mockMkdir).toHaveBeenCalledWith(
				expect.stringContaining('.swarm'),
				expect.objectContaining({ recursive: true }),
			);
		});

		it('entry contains correct metadata fields after migration', async () => {
			const contextContent =
				'## Lessons Learned\n- Important migration lesson\n';
			mockExistsSync.mockImplementation((p: string) =>
				p.includes('context.md'),
			);
			mockReadFile.mockResolvedValue(contextContent);

			await migrateContextToKnowledge('/test/project', baseConfig);

			const entries = mockRewriteKnowledge.mock.calls[0][1] as unknown[];
			const entry = entries[0] as Record<string, unknown>;

			expect(entry.id).toBe('test-uuid-1234');
			expect(entry.tier).toBe('swarm');
			expect(entry.status).toBe('candidate');
			expect(entry.scope).toBe('global');
			expect(entry.confidence).toBe(0.3);
			expect(entry.auto_generated).toBe(true);
			expect(entry.schema_version).toBe(1);
			expect(entry.project_name).toBe('project'); // basename of /test/project
			expect(entry.retrieval_outcomes).toEqual({
				applied_count: 0,
				succeeded_after_count: 0,
				failed_after_count: 0,
			});
			expect(entry.created_at).toBeDefined();
			expect(entry.updated_at).toBeDefined();
		});

		it('uses schema_version from config when provided', async () => {
			const contextContent =
				'## Lessons Learned\n- Lesson with custom schema version\n';
			mockExistsSync.mockImplementation((p: string) =>
				p.includes('context.md'),
			);
			mockReadFile.mockResolvedValue(contextContent);

			const config = { ...baseConfig, schema_version: 2 };

			await migrateContextToKnowledge('/test/project', config);

			const entries = mockRewriteKnowledge.mock.calls[0][1] as unknown[];
			const entry = entries[0] as { schema_version: number };

			expect(entry.schema_version).toBe(2);
		});

		it('writes sentinel with correct metadata', async () => {
			const contextContent =
				'## Lessons Learned\n- This is the first valid lesson\n- This is the second valid lesson\n';
			mockExistsSync.mockImplementation((p: string) =>
				p.includes('context.md'),
			);
			mockReadFile.mockResolvedValue(contextContent);

			await migrateContextToKnowledge('/test/project', baseConfig);

			const sentinelContent = mockWriteFile.mock.calls[0][1] as string;
			const sentinel = JSON.parse(sentinelContent);

			expect(sentinel.migrated_at).toBeDefined();
			expect(sentinel.source_version).toBe('6.16');
			expect(sentinel.target_version).toBe('6.17');
			expect(sentinel.entries_migrated).toBe(2);
			expect(sentinel.entries_dropped).toBe(0);
			expect(sentinel.schema_version).toBe(1);
			expect(sentinel.migration_tool).toBe('knowledge-migrator.ts');
		});

		it('handles lesson text longer than 280 characters by truncating', async () => {
			const longLesson = 'A'.repeat(300);
			const contextContent = `## Lessons Learned\n- ${longLesson}\n`;
			mockExistsSync.mockImplementation((p: string) =>
				p.includes('context.md'),
			);
			mockReadFile.mockResolvedValue(contextContent);

			await migrateContextToKnowledge('/test/project', baseConfig);

			const entries = mockRewriteKnowledge.mock.calls[0][1] as unknown[];
			const entry = entries[0] as { lesson: string };

			expect(entry.lesson).toHaveLength(280);
			expect(entry.lesson).toContain('...');
		});
	});
});
