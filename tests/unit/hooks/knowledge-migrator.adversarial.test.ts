import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Local mock variables (same pattern as verification tests)
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

describe('knowledge-migrator adversarial tests', () => {
	beforeEach(() => {
		vi.clearAllMocks();

		// defaults
		mockExistsSync.mockReturnValue(false);
		mockReadFile.mockResolvedValue('');
		mockWriteFile.mockResolvedValue(undefined);
		mockMkdir.mockResolvedValue(undefined);
		mockReadKnowledge.mockResolvedValue([]);
		mockRewriteKnowledge.mockResolvedValue(undefined);
		mockResolveSwarmKnowledgePath.mockReturnValue(
			'/test/.swarm/knowledge.jsonl',
		);
		mockFindNearDuplicate.mockReturnValue(undefined);
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

	describe('Oversized / boundary inputs', () => {
		it('lesson text exactly 280 chars → not truncated', async () => {
			const exactly280 = 'A'.repeat(280);
			const contextContent = `## Lessons Learned\n- ${exactly280}\n`;
			mockExistsSync.mockImplementation((p: string) =>
				p.includes('context.md'),
			);
			mockReadFile.mockResolvedValue(contextContent);

			await migrateContextToKnowledge('/test/project', baseConfig);

			const entries = mockRewriteKnowledge.mock.calls[0][1] as unknown[];
			const entry = entries[0] as { lesson: string };

			expect(entry.lesson).toBe(exactly280);
			expect(entry.lesson).toHaveLength(280);
			expect(entry.lesson).not.toContain('...');
		});

		it('lesson text 281 chars → truncated to 277 + ...', async () => {
			const exactly281 = 'A'.repeat(281);
			const contextContent = `## Lessons Learned\n- ${exactly281}\n`;
			mockExistsSync.mockImplementation((p: string) =>
				p.includes('context.md'),
			);
			mockReadFile.mockResolvedValue(contextContent);

			await migrateContextToKnowledge('/test/project', baseConfig);

			const entries = mockRewriteKnowledge.mock.calls[0][1] as unknown[];
			const entry = entries[0] as { lesson: string };

			expect(entry.lesson).toHaveLength(280);
			expect(entry.lesson).toBe('A'.repeat(277) + '...');
		});

		it('lesson text with 1000 characters → truncated safely', async () => {
			const longLesson = 'B'.repeat(1000);
			const contextContent = `## Lessons Learned\n- ${longLesson}\n`;
			mockExistsSync.mockImplementation((p: string) =>
				p.includes('context.md'),
			);
			mockReadFile.mockResolvedValue(contextContent);

			await migrateContextToKnowledge('/test/project', baseConfig);

			const entries = mockRewriteKnowledge.mock.calls[0][1] as unknown[];
			const entry = entries[0] as { lesson: string };

			expect(entry.lesson).toHaveLength(280);
			expect(entry.lesson).toBe('B'.repeat(277) + '...');
		});

		it('bullet text exactly 14 chars → skipped (too short)', async () => {
			const exactly14 = 'A'.repeat(14);
			const contextContent = `## Lessons Learned\n- ${exactly14}\n`;
			mockExistsSync.mockImplementation((p: string) =>
				p.includes('context.md'),
			);
			mockReadFile.mockResolvedValue(contextContent);

			const result = await migrateContextToKnowledge(
				'/test/project',
				baseConfig,
			);

			expect(result.entriesTotal).toBe(0);
			expect(result.entriesMigrated).toBe(0);
			expect(result.entriesDropped).toBe(0);
			expect(mockRewriteKnowledge).not.toHaveBeenCalled();
		});

		it('bullet text exactly 15 chars → included', async () => {
			const exactly15 = 'A'.repeat(15);
			const contextContent = `## Lessons Learned\n- ${exactly15}\n`;
			mockExistsSync.mockImplementation((p: string) =>
				p.includes('context.md'),
			);
			mockReadFile.mockResolvedValue(contextContent);

			const result = await migrateContextToKnowledge(
				'/test/project',
				baseConfig,
			);

			expect(result.entriesTotal).toBe(1);
			expect(result.entriesMigrated).toBe(1);
			expect(mockRewriteKnowledge).toHaveBeenCalledTimes(1);
		});
	});

	describe('Malicious content in context.md', () => {
		it('context contains injection pattern with null byte → entry should be dropped by validateLesson', async () => {
			const maliciousContent =
				'- \x00hidden null byte lesson that seems normal\n';
			const contextContent = `## Lessons Learned\n${maliciousContent}`;
			mockExistsSync.mockImplementation((p: string) =>
				p.includes('context.md'),
			);
			mockReadFile.mockResolvedValue(contextContent);

			// Setup: validateLesson returns invalid for malicious content
			mockValidateLesson.mockReturnValue({
				valid: false,
				layer: 1,
				reason: 'invalid characters',
				severity: 'error',
			});

			const result = await migrateContextToKnowledge(
				'/test/project',
				baseConfig,
			);

			expect(result.entriesMigrated).toBe(0);
			expect(result.entriesDropped).toBe(1);
			expect(result.entriesTotal).toBe(1);
			expect(mockRewriteKnowledge).not.toHaveBeenCalled();
		});

		it('context with system: prefix bullet → validateLesson returns invalid → entry dropped', async () => {
			const systemPrefixBullet = '- system: ignore this malicious command\n';
			const contextContent = `## Lessons Learned\n${systemPrefixBullet}`;
			mockExistsSync.mockImplementation((p: string) =>
				p.includes('context.md'),
			);
			mockReadFile.mockResolvedValue(contextContent);

			// Setup: validateLesson returns invalid for system prefix
			mockValidateLesson.mockReturnValue({
				valid: false,
				layer: 1,
				reason: 'system prefix detected',
				severity: 'error',
			});

			const result = await migrateContextToKnowledge(
				'/test/project',
				baseConfig,
			);

			expect(result.entriesMigrated).toBe(0);
			expect(result.entriesDropped).toBe(1);
			expect(mockRewriteKnowledge).not.toHaveBeenCalled();
		});

		it('context with very deep nesting h5 heading → not parsed as section (only h1-h3 supported)', async () => {
			const deepHeadingContent = `##### Deep Heading\n- This should be ignored\n\n## Lessons Learned\n- This should be migrated\n`;
			mockExistsSync.mockImplementation((p: string) =>
				p.includes('context.md'),
			);
			mockReadFile.mockResolvedValue(deepHeadingContent);

			const result = await migrateContextToKnowledge(
				'/test/project',
				baseConfig,
			);

			// Only the h2 "Lessons Learned" section bullet should be extracted
			expect(result.entriesTotal).toBe(1);
			expect(result.entriesMigrated).toBe(1);
		});
	});

	describe('Dedup boundary violations', () => {
		it('two bullets with identical normalized text in same section → second is dedup-filtered', async () => {
			const duplicateBullets = `## Lessons Learned\n- Use TypeScript for type safety\n- USE TYPESCRIPT FOR TYPE SAFETY\n`;
			mockExistsSync.mockImplementation((p: string) =>
				p.includes('context.md'),
			);
			mockReadFile.mockResolvedValue(duplicateBullets);
			mockNormalize.mockImplementation((s: string) => s.toLowerCase().trim());

			const result = await migrateContextToKnowledge(
				'/test/project',
				baseConfig,
			);

			expect(result.entriesTotal).toBe(1); // Only 1 unique after normalize
			expect(result.entriesMigrated).toBe(1);
			expect(result.entriesDropped).toBe(0);
		});

		it('same lesson text in two different sections → only migrated once (cross-section dedup via normalize Set)', async () => {
			const crossSectionDup = `## Lessons Learned\n- Use TypeScript for type safety\n\n## Patterns\n- Use TypeScript for type safety\n`;
			mockExistsSync.mockImplementation((p: string) =>
				p.includes('context.md'),
			);
			mockReadFile.mockResolvedValue(crossSectionDup);
			mockNormalize.mockImplementation((s: string) => s.toLowerCase().trim());

			const result = await migrateContextToKnowledge(
				'/test/project',
				baseConfig,
			);

			expect(result.entriesTotal).toBe(1);
			expect(result.entriesMigrated).toBe(1);
		});

		it('bullet matching an existing knowledge entry at exactly dedup_threshold → dropped', async () => {
			const bulletText = 'This matches existing entry';
			const contextContent = `## Lessons Learned\n- ${bulletText}\n`;
			mockExistsSync.mockImplementation((p: string) =>
				p.includes('context.md'),
			);
			mockReadFile.mockResolvedValue(contextContent);

			// Setup: findNearDuplicate returns a match (simulating exact threshold match)
			mockFindNearDuplicate.mockReturnValue({
				id: 'existing-id',
				lesson: bulletText,
				score: 0.6,
			});

			const result = await migrateContextToKnowledge(
				'/test/project',
				baseConfig,
			);

			expect(result.entriesMigrated).toBe(0);
			expect(result.entriesDropped).toBe(1);
			expect(mockRewriteKnowledge).not.toHaveBeenCalled();
		});

		it('bullet matching at just below threshold → allowed through', async () => {
			const bulletText = 'This is below threshold match';
			const contextContent = `## Lessons Learned\n- ${bulletText}\n`;
			mockExistsSync.mockImplementation((p: string) =>
				p.includes('context.md'),
			);
			mockReadFile.mockResolvedValue(contextContent);

			// Setup: findNearDuplicate returns undefined (no duplicate at threshold)
			mockFindNearDuplicate.mockReturnValue(undefined);

			const result = await migrateContextToKnowledge(
				'/test/project',
				baseConfig,
			);

			expect(result.entriesMigrated).toBe(1);
			expect(result.entriesDropped).toBe(0);
			expect(mockRewriteKnowledge).toHaveBeenCalledTimes(1);
		});
	});

	describe('Config edge cases', () => {
		it('config.dedup_threshold = 0 → all entries are considered duplicates when findNearDuplicate returns a match', async () => {
			const contextContent = `## Lessons Learned\n- This will be a duplicate\n`;
			mockExistsSync.mockImplementation((p: string) =>
				p.includes('context.md'),
			);
			mockReadFile.mockResolvedValue(contextContent);

			// Config with threshold 0
			const config = { ...baseConfig, dedup_threshold: 0 };

			// Setup: findNearDuplicate returns a match even at threshold 0
			mockFindNearDuplicate.mockReturnValue({
				id: 'existing-id',
				lesson: 'similar lesson',
				score: 0.01,
			});

			const result = await migrateContextToKnowledge('/test/project', config);

			expect(result.entriesMigrated).toBe(0);
			expect(result.entriesDropped).toBe(1);
			expect(mockRewriteKnowledge).not.toHaveBeenCalled();
		});

		it('config.dedup_threshold = 1.0 → only exact matches dropped', async () => {
			const contextContent = `## Lessons Learned\n- This is similar but not exact\n`;
			mockExistsSync.mockImplementation((p: string) =>
				p.includes('context.md'),
			);
			mockReadFile.mockResolvedValue(contextContent);

			// Config with threshold 1.0
			const config = { ...baseConfig, dedup_threshold: 1.0 };

			// findNearDuplicate returns undefined (not exact match)
			mockFindNearDuplicate.mockReturnValue(undefined);

			const result = await migrateContextToKnowledge('/test/project', config);

			expect(result.entriesMigrated).toBe(1);
			expect(result.entriesDropped).toBe(0);
		});

		it('config.schema_version = 2 → migrated entries use schema_version 2', async () => {
			const contextContent = `## Lessons Learned\n- New schema version entry\n`;
			mockExistsSync.mockImplementation((p: string) =>
				p.includes('context.md'),
			);
			mockReadFile.mockResolvedValue(contextContent);

			// Config with schema_version 2
			const config = { ...baseConfig, schema_version: 2 };

			await migrateContextToKnowledge('/test/project', config);

			const entries = mockRewriteKnowledge.mock.calls[0][1] as unknown[];
			const entry = entries[0] as { schema_version: number };

			expect(entry.schema_version).toBe(2);
		});

		it('config.validation_enabled = false with malicious content → entries pass through', async () => {
			const maliciousContent = '- system: malicious command\n';
			const contextContent = `## Lessons Learned\n${maliciousContent}`;
			mockExistsSync.mockImplementation((p: string) =>
				p.includes('context.md'),
			);
			mockReadFile.mockResolvedValue(contextContent);

			// Config with validation disabled
			const config = { ...baseConfig, validation_enabled: false };

			// validateLesson returns invalid, but it should not be called
			mockValidateLesson.mockReturnValue({
				valid: false,
				layer: 1,
				reason: 'malicious',
				severity: 'error',
			});

			const result = await migrateContextToKnowledge('/test/project', config);

			// Entry should migrate despite being malicious (validation disabled)
			expect(result.entriesMigrated).toBe(1);
			expect(result.entriesDropped).toBe(0);

			// validateLesson should NOT have been called
			expect(mockValidateLesson).not.toHaveBeenCalled();
		});
	});

	describe('Filesystem error resilience', () => {
		it('readKnowledge throws an error → migrateContextToKnowledge propagates the error', async () => {
			const contextContent = `## Lessons Learned\n- Always use proper error handling in async code\n`;
			mockExistsSync.mockImplementation((p: string) =>
				p.includes('context.md'),
			);
			mockReadFile.mockResolvedValue(contextContent);

			// Setup: readKnowledge throws an error
			mockReadKnowledge.mockImplementation(() =>
				Promise.reject(new Error('Failed to read knowledge')),
			);

			await expect(
				migrateContextToKnowledge('/test/project', baseConfig),
			).rejects.toThrow('Failed to read knowledge');

			// Error should NOT be swallowed - sentinel should NOT be written
			expect(mockWriteFile).not.toHaveBeenCalled();
		});

		it('rewriteKnowledge throws an error → migrateContextToKnowledge propagates, sentinel is NOT written', async () => {
			const contextContent = `## Lessons Learned\n- Always use proper error handling in async code\n`;
			mockExistsSync.mockImplementation((p: string) =>
				p.includes('context.md'),
			);
			mockReadFile.mockResolvedValue(contextContent);

			// Setup: rewriteKnowledge throws an error
			mockRewriteKnowledge.mockImplementation(() =>
				Promise.reject(new Error('Failed to write knowledge')),
			);

			await expect(
				migrateContextToKnowledge('/test/project', baseConfig),
			).rejects.toThrow('Failed to write knowledge');

			// Sentinel should NOT be written when rewriteKnowledge fails
			expect(mockWriteFile).not.toHaveBeenCalled();
		});

		it('writeFile (sentinel) throws after rewriteKnowledge succeeds → error propagates', async () => {
			const contextContent = `## Lessons Learned\n- Always use proper error handling in async code\n`;
			mockExistsSync.mockImplementation((p: string) =>
				p.includes('context.md'),
			);
			mockReadFile.mockResolvedValue(contextContent);

			// Setup: writeFile throws an error, rewriteKnowledge succeeds
			mockWriteFile.mockImplementation(() =>
				Promise.reject(new Error('Failed to write sentinel')),
			);
			mockRewriteKnowledge.mockResolvedValue(undefined);

			await expect(
				migrateContextToKnowledge('/test/project', baseConfig),
			).rejects.toThrow('Failed to write sentinel');

			// rewriteKnowledge should have been called before error
			expect(mockRewriteKnowledge).toHaveBeenCalledTimes(1);
		});
	});

	describe('Race condition / interruption safety', () => {
		it('partial knowledge.jsonl exists (readKnowledge returns 5 entries, no sentinel) → re-run succeeds, deduplicates existing entries', async () => {
			const existingEntries = [
				{ id: 'existing-1', lesson: 'existing lesson one' },
				{ id: 'existing-2', lesson: 'existing lesson two' },
				{ id: 'existing-3', lesson: 'existing lesson three' },
				{ id: 'existing-4', lesson: 'existing lesson four' },
				{ id: 'existing-5', lesson: 'existing lesson five' },
			];

			const contextContent = `## Lessons Learned\n- existing lesson one\n- new unique lesson\n`;
			mockExistsSync.mockImplementation((p: string) =>
				p.includes('context.md'),
			);
			mockReadFile.mockResolvedValue(contextContent);

			// Setup: knowledge.jsonl exists with entries (no sentinel, so re-run)
			mockReadKnowledge.mockResolvedValue(existingEntries);

			// Setup: findNearDuplicate returns a match for "existing lesson one"
			mockFindNearDuplicate.mockImplementation((text: string) => {
				if (text.includes('existing lesson one')) {
					return { id: 'existing-1', lesson: 'existing lesson one' };
				}
				return undefined;
			});

			const result = await migrateContextToKnowledge(
				'/test/project',
				baseConfig,
			);

			// "existing lesson one" should be dropped as duplicate via findNearDuplicate
			// "new unique lesson" should be migrated
			expect(result.entriesMigrated).toBe(1);
			expect(result.entriesDropped).toBe(1);
			expect(result.entriesTotal).toBe(2);
		});

		it('knowledge.jsonl exists with entries that perfectly match context.md bullets → all are dropped as duplicates', async () => {
			const existingEntries = [
				{ id: 'existing-1', lesson: 'perfect match one' },
				{ id: 'existing-2', lesson: 'perfect match two' },
				{ id: 'existing-3', lesson: 'perfect match three' },
			];

			const contextContent = `## Lessons Learned\n- perfect match one\n- perfect match two\n- perfect match three\n`;
			mockExistsSync.mockImplementation((p: string) =>
				p.includes('context.md'),
			);
			mockReadFile.mockResolvedValue(contextContent);

			// Setup: findNearDuplicate returns matches for all bullets
			mockFindNearDuplicate.mockImplementation((text: string) => {
				if (text.includes('perfect match')) {
					return { id: 'existing-id', lesson: text, score: 1.0 };
				}
				return undefined;
			});

			mockReadKnowledge.mockResolvedValue(existingEntries);

			const result = await migrateContextToKnowledge(
				'/test/project',
				baseConfig,
			);

			expect(result.entriesMigrated).toBe(0);
			expect(result.entriesDropped).toBe(3);
			expect(result.entriesTotal).toBe(3);

			// rewriteKnowledge should NOT be called (no new entries)
			expect(mockRewriteKnowledge).not.toHaveBeenCalled();
		});
	});

	describe('Malformed context.md structure', () => {
		it('context with only a heading and no body → no bullets extracted, sentinel written', async () => {
			const headingOnlyContent = '## Lessons Learned\n\n';
			mockExistsSync.mockImplementation((p: string) =>
				p.includes('context.md'),
			);
			mockReadFile.mockResolvedValue(headingOnlyContent);

			const result = await migrateContextToKnowledge(
				'/test/project',
				baseConfig,
			);

			expect(result.migrated).toBe(true);
			expect(result.entriesMigrated).toBe(0);
			expect(result.entriesDropped).toBe(0);
			expect(result.entriesTotal).toBe(0);

			// Sentinel should be written even with no entries
			expect(mockWriteFile).toHaveBeenCalledTimes(1);
		});

		it('context with bullets NOT under known headings → bullets ignored, sentinel written', async () => {
			const unknownSectionContent = `## Unknown Section\n- This should be ignored\n- This too should be ignored\n\n## Another Unknown\n- Also ignored\n`;
			mockExistsSync.mockImplementation((p: string) =>
				p.includes('context.md'),
			);
			mockReadFile.mockResolvedValue(unknownSectionContent);

			const result = await migrateContextToKnowledge(
				'/test/project',
				baseConfig,
			);

			expect(result.entriesTotal).toBe(0);
			expect(result.entriesMigrated).toBe(0);

			// Sentinel should be written
			expect(mockWriteFile).toHaveBeenCalledTimes(1);
		});

		it('context with mixed valid/invalid section names → only valid sections parsed', async () => {
			const mixedSectionsContent = `## Lessons Learned\n- Valid lesson from lessons learned\n\n## Invalid Section\n- Should be ignored\n\n## Patterns\n- Valid pattern entry\n\n## Yet Another Invalid\n- Also ignored\n`;
			mockExistsSync.mockImplementation((p: string) =>
				p.includes('context.md'),
			);
			mockReadFile.mockResolvedValue(mixedSectionsContent);

			const result = await migrateContextToKnowledge(
				'/test/project',
				baseConfig,
			);

			expect(result.entriesTotal).toBe(2);
			expect(result.entriesMigrated).toBe(2);
		});

		it('context with unicode emoji in bullet text → handled gracefully (no crash)', async () => {
			const emojiContent = `## Lessons Learned\n- Use 🚀 for performance optimization\n- Add ✅ for validation checks\n- Handle 💾 data carefully\n`;
			mockExistsSync.mockImplementation((p: string) =>
				p.includes('context.md'),
			);
			mockReadFile.mockResolvedValue(emojiContent);

			// Should not throw and should process all bullets
			const result = await migrateContextToKnowledge(
				'/test/project',
				baseConfig,
			);

			expect(result.entriesTotal).toBe(3);
			expect(result.entriesMigrated).toBe(3);
			expect(mockRewriteKnowledge).toHaveBeenCalledTimes(1);
		});

		it('context with CRLF line endings (\\r\\n) → bullets extracted correctly', async () => {
			const crlfContent =
				'## Lessons Learned\r\n- First CRLF lesson\r\n- Second CRLF lesson\r\n';
			mockExistsSync.mockImplementation((p: string) =>
				p.includes('context.md'),
			);
			mockReadFile.mockResolvedValue(crlfContent);

			const result = await migrateContextToKnowledge(
				'/test/project',
				baseConfig,
			);

			expect(result.entriesTotal).toBe(2);
			expect(result.entriesMigrated).toBe(2);
		});
	});
});
