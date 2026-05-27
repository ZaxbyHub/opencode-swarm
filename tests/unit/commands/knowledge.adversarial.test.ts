/**
 * Adversarial Security Tests for knowledge.ts
 *
 * Converted to bun:test with mock.module() for knowledge-validator and knowledge-migrator.
 * Does NOT mock src/config/schema.js to avoid contaminating config tests in --smol mode.
 * Uses real KnowledgeConfigSchema.parse({}) which returns default values.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Mock factories — must be declared before mock.module()
const mockQuarantineEntry = mock(
	async (_dir: string, _id: string, _reason: string, _by: string) => undefined,
);
const mockRestoreEntry = mock(async (_dir: string, _id: string) => undefined);
const mockMigrateContextToKnowledge = mock(
	async (_dir: string, _config: unknown) => ({
		entriesMigrated: 5,
		entriesDropped: 1,
		entriesTotal: 6,
		skippedReason: undefined as string | undefined,
	}),
);

// knowledge-store mock — quarantine/restore handlers call readKnowledge to resolve prefixes
// before delegating to the backend. Default returns empty; tests that expect success must
// call mockReadKnowledge.mockResolvedValueOnce([{ id: <expectedId> }]) first.
const mockReadKnowledge = mock(
	async (_path: string) => [] as Array<{ id: string }>,
);

mock.module('../../../src/hooks/knowledge-store.js', () => ({
	readKnowledge: mockReadKnowledge,
	resolveSwarmKnowledgePath: (_dir: string) => `${_dir}/.swarm/knowledge.jsonl`,
	enforceKnowledgeCap: async () => {},
	sweepAgedEntries: async () => {},
	sweepStaleTodos: async () => {},
	bumpKnowledgeConfidenceBatch: async () => {},
}));

mock.module('../../../src/hooks/knowledge-validator.js', () => ({
	quarantineEntry: mockQuarantineEntry,
	restoreEntry: mockRestoreEntry,
}));

mock.module('../../../src/hooks/knowledge-migrator.js', () => ({
	migrateContextToKnowledge: mockMigrateContextToKnowledge,
}));

// Import AFTER mock setup
const {
	handleKnowledgeQuarantineCommand,
	handleKnowledgeRestoreCommand,
	handleKnowledgeMigrateCommand,
} = await import('../../../src/commands/knowledge.js');

afterEach(() => {
	mock.restore();
});

describe('Adversarial Security Tests for knowledge.ts', () => {
	const testDirectory = '/test/directory';

	beforeEach(() => {
		mockQuarantineEntry.mockClear();
		mockRestoreEntry.mockClear();
		mockMigrateContextToKnowledge.mockClear();
		mockReadKnowledge.mockClear();
	});

	describe('Input injection attacks on entryId', () => {
		it('1. ANSI escape sequence in entryId should return invalid ID message', async () => {
			const result = await handleKnowledgeQuarantineCommand(testDirectory, [
				'\x1b[31mmalicious\x1b[0m',
			]);
			expect(result).toBe(
				'Invalid entry ID. IDs must be 1-64 characters: letters, digits, hyphens, underscores only.',
			);
			expect(mockQuarantineEntry).not.toHaveBeenCalled();
		});

		it('2. Null byte in entryId should return invalid ID message', async () => {
			const result = await handleKnowledgeQuarantineCommand(testDirectory, [
				'abc\x00def',
			]);
			expect(result).toBe(
				'Invalid entry ID. IDs must be 1-64 characters: letters, digits, hyphens, underscores only.',
			);
			expect(mockQuarantineEntry).not.toHaveBeenCalled();
		});

		it('3. Newline in entryId should return invalid ID message', async () => {
			const result = await handleKnowledgeRestoreCommand(testDirectory, [
				'abc\ndef',
			]);
			expect(result).toBe(
				'Invalid entry ID. IDs must be 1-64 characters: letters, digits, hyphens, underscores only.',
			);
			expect(mockRestoreEntry).not.toHaveBeenCalled();
		});

		it('4. Shell metacharacter should return invalid ID message', async () => {
			const result = await handleKnowledgeQuarantineCommand(testDirectory, [
				'abc;rm -rf',
			]);
			expect(result).toBe(
				'Invalid entry ID. IDs must be 1-64 characters: letters, digits, hyphens, underscores only.',
			);
			expect(mockQuarantineEntry).not.toHaveBeenCalled();
		});

		it('5. Path traversal (forward slash) should return invalid ID message', async () => {
			const result = await handleKnowledgeRestoreCommand(testDirectory, [
				'../../../etc/passwd',
			]);
			expect(result).toBe(
				'Invalid entry ID. IDs must be 1-64 characters: letters, digits, hyphens, underscores only.',
			);
			expect(mockRestoreEntry).not.toHaveBeenCalled();
		});

		it('6. Path traversal (backslash) should return invalid ID message', async () => {
			const result = await handleKnowledgeQuarantineCommand(testDirectory, [
				'..\\..\\Windows',
			]);
			expect(result).toBe(
				'Invalid entry ID. IDs must be 1-64 characters: letters, digits, hyphens, underscores only.',
			);
			expect(mockQuarantineEntry).not.toHaveBeenCalled();
		});

		it('7. Null-byte only should return invalid ID message', async () => {
			const result = await handleKnowledgeRestoreCommand(testDirectory, [
				'\x00',
			]);
			expect(result).toBe(
				'Invalid entry ID. IDs must be 1-64 characters: letters, digits, hyphens, underscores only.',
			);
			expect(mockRestoreEntry).not.toHaveBeenCalled();
		});

		it('8. Whitespace only should return invalid ID message', async () => {
			const result = await handleKnowledgeQuarantineCommand(testDirectory, [
				'   ',
			]);
			expect(result).toBe(
				'Invalid entry ID. IDs must be 1-64 characters: letters, digits, hyphens, underscores only.',
			);
			expect(mockQuarantineEntry).not.toHaveBeenCalled();
		});

		it('9. Empty string should return USAGE message', async () => {
			const result = await handleKnowledgeQuarantineCommand(testDirectory, [
				'',
			]);
			expect(result).toBe('Usage: /swarm knowledge quarantine <id> [reason]');
			expect(mockQuarantineEntry).not.toHaveBeenCalled();
		});

		it('10. Maximum valid ID (exactly 64 chars) should SUCCEED', async () => {
			const validId = 'a'.repeat(64);
			mockReadKnowledge.mockResolvedValueOnce([{ id: validId }]);
			mockQuarantineEntry.mockImplementationOnce(async () => undefined);
			const result = await handleKnowledgeQuarantineCommand(testDirectory, [
				validId,
			]);
			expect(result).toBe(`✅ Entry ${validId} quarantined successfully.`);
			expect(mockQuarantineEntry).toHaveBeenCalledWith(
				testDirectory,
				validId,
				'Quarantined via /swarm knowledge quarantine command',
				'user',
			);
		});

		it('11. One character over limit (65 chars) should return invalid ID message', async () => {
			const result = await handleKnowledgeRestoreCommand(testDirectory, [
				'a'.repeat(65),
			]);
			expect(result).toBe(
				'Invalid entry ID. IDs must be 1-64 characters: letters, digits, hyphens, underscores only.',
			);
			expect(mockRestoreEntry).not.toHaveBeenCalled();
		});

		it('12. Unicode in entryId should return invalid ID message', async () => {
			const result = await handleKnowledgeQuarantineCommand(testDirectory, [
				'lesson-αβγ',
			]);
			expect(result).toBe(
				'Invalid entry ID. IDs must be 1-64 characters: letters, digits, hyphens, underscores only.',
			);
			expect(mockQuarantineEntry).not.toHaveBeenCalled();
		});

		it('13. HTML injection in entryId should return invalid ID message', async () => {
			const result = await handleKnowledgeRestoreCommand(testDirectory, [
				'<script>alert(1)</script>',
			]);
			expect(result).toBe(
				'Invalid entry ID. IDs must be 1-64 characters: letters, digits, hyphens, underscores only.',
			);
			expect(mockRestoreEntry).not.toHaveBeenCalled();
		});

		it('14. SQL injection in entryId should return invalid ID message', async () => {
			const result = await handleKnowledgeQuarantineCommand(testDirectory, [
				"'; DROP TABLE --",
			]);
			expect(result).toBe(
				'Invalid entry ID. IDs must be 1-64 characters: letters, digits, hyphens, underscores only.',
			);
			expect(mockQuarantineEntry).not.toHaveBeenCalled();
		});
	});

	describe('Information disclosure attacks', () => {
		it('15. quarantineEntry error should NOT expose file paths or error codes', async () => {
			const error = new Error(
				'ENOENT: no such file or directory, open /home/user/.swarm/knowledge.jsonl',
			);
			mockReadKnowledge.mockResolvedValueOnce([{ id: 'valid-id' }]);
			mockQuarantineEntry.mockImplementationOnce(async () => {
				throw error;
			});

			const result = await handleKnowledgeQuarantineCommand(testDirectory, [
				'valid-id',
			]);

			expect(result).toBe(
				'❌ Failed to quarantine entry. Check the entry ID and try again.',
			);
			expect(result).not.toContain('/home/user/.swarm/knowledge.jsonl');
			expect(result).not.toContain('ENOENT');
		});

		it('16. restoreEntry error should NOT expose sensitive error messages', async () => {
			const error = new Error(
				'EACCES: permission denied, open /etc/sensitive-config',
			);
			mockReadKnowledge.mockResolvedValueOnce([{ id: 'valid-id' }]);
			mockRestoreEntry.mockImplementationOnce(async () => {
				throw error;
			});

			const result = await handleKnowledgeRestoreCommand(testDirectory, [
				'valid-id',
			]);

			expect(result).toBe(
				'❌ Failed to restore entry. Check the entry ID and try again.',
			);
			expect(result).not.toContain('/etc/sensitive-config');
			expect(result).not.toContain('EACCES');
		});
	});

	describe('Reason parameter attacks (pass through tests)', () => {
		it('17. Extremely long reason (10000 chars) should pass to underlying function', async () => {
			const longReason = 'x'.repeat(10000);
			const validId = 'valid-123';
			mockReadKnowledge.mockResolvedValueOnce([{ id: validId }]);
			mockQuarantineEntry.mockImplementationOnce(async () => undefined);

			const result = await handleKnowledgeQuarantineCommand(testDirectory, [
				validId,
				longReason,
			]);

			expect(mockQuarantineEntry).toHaveBeenCalledWith(
				testDirectory,
				validId,
				longReason,
				'user',
			);
			expect(result).toBe(`✅ Entry ${validId} quarantined successfully.`);
		});

		it('18. Control characters in reason should pass to underlying function', async () => {
			const reasonWithControls = 'reason\x1b[31m\x00with\x07controls\n\r';
			const validId = 'valid-123';
			mockReadKnowledge.mockResolvedValueOnce([{ id: validId }]);
			mockQuarantineEntry.mockImplementationOnce(async () => undefined);

			const result = await handleKnowledgeQuarantineCommand(testDirectory, [
				validId,
				reasonWithControls,
			]);

			expect(mockQuarantineEntry).toHaveBeenCalledWith(
				testDirectory,
				validId,
				reasonWithControls,
				'user',
			);
			expect(result).toBe(`✅ Entry ${validId} quarantined successfully.`);
		});
	});
});

describe('Adversarial Security Tests for handleKnowledgeMigrateCommand', () => {
	const testDirectory = '/test/directory';

	beforeEach(() => {
		mockMigrateContextToKnowledge.mockClear();
		// Default: migration succeeds
		mockMigrateContextToKnowledge.mockImplementation(
			async (_dir: string, _config: unknown) => ({
				entriesMigrated: 5,
				entriesDropped: 1,
				entriesTotal: 6,
				skippedReason: undefined as string | undefined,
			}),
		);
	});

	describe('Path and directory attacks', () => {
		it('19. Path traversal in args[0] (../../../etc/passwd) should not crash or leak path', async () => {
			mockMigrateContextToKnowledge.mockRejectedValueOnce(
				new Error(
					'ENOENT: no such file or directory, open ../../../etc/passwd',
				),
			);

			const result = await handleKnowledgeMigrateCommand(testDirectory, [
				'../../../etc/passwd',
			]);

			expect(result).toBe(
				'❌ Migration failed. Check .swarm/context.md is readable.',
			);
			expect(result).not.toContain('../../../etc/passwd');
			expect(result).not.toContain('/etc/passwd');
			expect(result).not.toContain('ENOENT');
		});

		it('20. Null/undefined args[0] should fall back to directory', async () => {
			const result = await handleKnowledgeMigrateCommand(testDirectory, [
				null as any,
			]);

			// Should use the fallback directory (real schema returns full defaults object)
			expect(mockMigrateContextToKnowledge).toHaveBeenCalledWith(
				testDirectory,
				expect.any(Object),
			);
			expect(result).toBe(
				'✅ Migration complete: 5 entries added, 1 dropped (validation/dedup), 6 total processed.',
			);
		});

		it('21. Empty string args[0] should fall back to directory', async () => {
			const result = await handleKnowledgeMigrateCommand(testDirectory, ['']);

			// Should use the fallback directory since '' is falsy
			expect(mockMigrateContextToKnowledge).toHaveBeenCalledWith(
				testDirectory,
				expect.any(Object),
			);
			expect(result).toBe(
				'✅ Migration complete: 5 entries added, 1 dropped (validation/dedup), 6 total processed.',
			);
		});

		it('22. Very long directory string (10000 chars) should not hang or crash', async () => {
			const longDirectory = 'a'.repeat(10000);
			const result = await handleKnowledgeMigrateCommand(longDirectory, []);

			expect(mockMigrateContextToKnowledge).toHaveBeenCalledWith(
				longDirectory,
				expect.any(Object),
			);
			expect(result).toBe(
				'✅ Migration complete: 5 entries added, 1 dropped (validation/dedup), 6 total processed.',
			);
		});

		it('23. args[0] is a non-string (123) should not throw', async () => {
			const result = await handleKnowledgeMigrateCommand(testDirectory, [
				123 as any,
			]);

			// Since 123 is truthy, it gets passed to migrateContextToKnowledge
			expect(mockMigrateContextToKnowledge).toHaveBeenCalledWith(
				123,
				expect.any(Object),
			);
			expect(result).toBe(
				'✅ Migration complete: 5 entries added, 1 dropped (validation/dedup), 6 total processed.',
			);
		});
	});

	describe('Error handling and information disclosure', () => {
		it('24. migrateContextToKnowledge throws with sensitive path in error message', async () => {
			const sensitiveError = new Error(
				'Error: ENOENT /home/user/.ssh/known_hosts',
			);
			mockMigrateContextToKnowledge.mockRejectedValueOnce(sensitiveError);

			const result = await handleKnowledgeMigrateCommand(testDirectory, []);

			expect(result).toBe(
				'❌ Migration failed. Check .swarm/context.md is readable.',
			);
			expect(result).not.toContain('/home/user/.ssh/known_hosts');
			expect(result).not.toContain('.ssh');
			expect(result).not.toContain('known_hosts');
		});

		it('25. migrateContextToKnowledge throws a non-Error value (string "oops")', async () => {
			mockMigrateContextToKnowledge.mockRejectedValueOnce('oops');

			const result = await handleKnowledgeMigrateCommand(testDirectory, []);

			expect(result).toBe(
				'❌ Migration failed. Check .swarm/context.md is readable.',
			);
		});

		it('26. migrateContextToKnowledge throws null/undefined', async () => {
			mockMigrateContextToKnowledge.mockRejectedValueOnce(null);

			const result = await handleKnowledgeMigrateCommand(testDirectory, []);

			expect(result).toBe(
				'❌ Migration failed. Check .swarm/context.md is readable.',
			);
		});

		it('27. Error containing ZodError-like message should not be exposed', async () => {
			// Verify that any error (e.g. with schema-related content) is sanitized
			mockMigrateContextToKnowledge.mockRejectedValueOnce(
				new Error('ZodError: Invalid config at swarm_max_entries'),
			);

			const result = await handleKnowledgeMigrateCommand(testDirectory, []);

			expect(result).toBe(
				'❌ Migration failed. Check .swarm/context.md is readable.',
			);
			expect(result).not.toContain('ZodError');
			expect(result).not.toContain('swarm_max_entries');
		});

		it('28. Non-Error thrown from migration path should be caught', async () => {
			mockMigrateContextToKnowledge.mockRejectedValueOnce(
				'schema parse failed',
			);

			const result = await handleKnowledgeMigrateCommand(testDirectory, []);

			expect(result).toBe(
				'❌ Migration failed. Check .swarm/context.md is readable.',
			);
		});
	});

	describe('Successful migration paths', () => {
		it('29. Migration with sentinel-exists skip reason', async () => {
			mockMigrateContextToKnowledge.mockResolvedValueOnce({
				entriesMigrated: 0,
				entriesDropped: 0,
				entriesTotal: 0,
				skippedReason: 'sentinel-exists',
			});

			const result = await handleKnowledgeMigrateCommand(testDirectory, []);

			expect(result).toBe(
				'⏭ Migration already completed for this project. Delete .swarm/.knowledge-migrated to re-run.',
			);
		});

		it('30. Migration with no-context-file skip reason', async () => {
			mockMigrateContextToKnowledge.mockResolvedValueOnce({
				entriesMigrated: 0,
				entriesDropped: 0,
				entriesTotal: 0,
				skippedReason: 'no-context-file',
			});

			const result = await handleKnowledgeMigrateCommand(testDirectory, []);

			expect(result).toBe('ℹ️ No .swarm/context.md found — nothing to migrate.');
		});

		it('31. Migration with empty-context skip reason', async () => {
			mockMigrateContextToKnowledge.mockResolvedValueOnce({
				entriesMigrated: 0,
				entriesDropped: 0,
				entriesTotal: 0,
				skippedReason: 'empty-context',
			});

			const result = await handleKnowledgeMigrateCommand(testDirectory, []);

			expect(result).toBe('ℹ️ .swarm/context.md is empty — nothing to migrate.');
		});

		it('32. Migration with unknown skip reason', async () => {
			mockMigrateContextToKnowledge.mockResolvedValueOnce({
				entriesMigrated: 0,
				entriesDropped: 0,
				entriesTotal: 0,
				skippedReason: 'unknown-reason',
			});

			const result = await handleKnowledgeMigrateCommand(testDirectory, []);

			expect(result).toBe('⚠️ Migration skipped for an unknown reason.');
		});
	});
});
