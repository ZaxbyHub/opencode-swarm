/**
 * Tests for handleKnowledgeMigrateCommand.
 * Part 4 of 4 for knowledge.test.ts.
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import { handleKnowledgeMigrateCommand } from '../../../src/commands/knowledge.js';
import { mockMigrate } from './_knowledge-commands-mocks';

describe('handleKnowledgeMigrateCommand', () => {
	beforeEach(() => {
		mockMigrate.mockReset();
	});

	it('successful migration returns string containing "Migration complete" with correct counts', async () => {
		mockMigrate.mockResolvedValueOnce({
			migrated: true,
			entriesMigrated: 3,
			entriesDropped: 1,
			entriesTotal: 4,
		});
		const result = await handleKnowledgeMigrateCommand('/test/dir', []);
		expect(result).toContain('Context migration');
		expect(result).toContain('3 entries added');
		expect(result).toContain('1 dropped');
		expect(mockMigrate).toHaveBeenCalledWith('/test/dir', expect.any(Object));
	});

	it('skippedReason "sentinel-exists" returns string containing "already completed"', async () => {
		mockMigrate.mockResolvedValueOnce({
			migrated: false,
			entriesMigrated: 0,
			entriesDropped: 0,
			entriesTotal: 0,
			skippedReason: 'sentinel-exists',
		});
		const result = await handleKnowledgeMigrateCommand('/test/dir', []);
		expect(result).toContain('already completed');
		expect(result).toContain('.swarm/.knowledge-migrated');
		expect(mockMigrate).toHaveBeenCalledWith('/test/dir', expect.any(Object));
	});

	it('skippedReason "no-context-file" returns string containing "No .swarm/context.md"', async () => {
		mockMigrate.mockResolvedValueOnce({
			migrated: false,
			entriesMigrated: 0,
			entriesDropped: 0,
			entriesTotal: 0,
			skippedReason: 'no-context-file',
		});
		const result = await handleKnowledgeMigrateCommand('/test/dir', []);
		expect(result).toContain('No .swarm/context.md');
		expect(result).toContain('nothing to migrate');
		expect(mockMigrate).toHaveBeenCalledWith('/test/dir', expect.any(Object));
	});

	it('skippedReason "empty-context" returns string containing "empty"', async () => {
		mockMigrate.mockResolvedValueOnce({
			migrated: false,
			entriesMigrated: 0,
			entriesDropped: 0,
			entriesTotal: 0,
			skippedReason: 'empty-context',
		});
		const result = await handleKnowledgeMigrateCommand('/test/dir', []);
		expect(result).toContain('empty');
		expect(result).toContain('nothing to migrate');
		expect(mockMigrate).toHaveBeenCalledWith('/test/dir', expect.any(Object));
	});

	it('skippedReason unknown value returns empty string (no default case)', async () => {
		mockMigrate.mockResolvedValueOnce({
			migrated: false,
			entriesMigrated: 0,
			entriesDropped: 0,
			entriesTotal: 0,
			skippedReason: 'some-unknown-reason' as never,
		});
		const result = await handleKnowledgeMigrateCommand('/test/dir', []);
		expect(result).toBe('');
		expect(mockMigrate).toHaveBeenCalledWith('/test/dir', expect.any(Object));
	});

	it('error thrown by migrateContextToKnowledge returns string containing "failed"', async () => {
		mockMigrate.mockRejectedValueOnce(new Error('Database connection failed'));
		const result = await handleKnowledgeMigrateCommand('/test/dir', []);
		expect(result).toContain('failed');
		expect(result).toContain('Check that knowledge source files are readable');
		expect(result).not.toContain('Database connection failed');
	});

	it('args[0] provided uses args[0] as targetDir (not directory)', async () => {
		mockMigrate.mockResolvedValueOnce({
			migrated: true,
			entriesMigrated: 1,
			entriesDropped: 0,
			entriesTotal: 1,
		});
		const result = await handleKnowledgeMigrateCommand('/test/dir', [
			'/custom/target',
		]);
		expect(result).toContain('Context migration');
		expect(mockMigrate).toHaveBeenCalledWith(
			'/custom/target',
			expect.any(Object),
		);
		expect(mockMigrate).not.toHaveBeenCalledWith(
			'/test/dir',
			expect.any(Object),
		);
	});

	it('args empty uses directory as targetDir', async () => {
		mockMigrate.mockResolvedValueOnce({
			migrated: true,
			entriesMigrated: 1,
			entriesDropped: 0,
			entriesTotal: 1,
		});
		const result = await handleKnowledgeMigrateCommand('/test/dir', []);
		expect(result).toContain('Context migration');
		expect(mockMigrate).toHaveBeenCalledWith('/test/dir', expect.any(Object));
	});

	it('does NOT expose error message content when migrateContextToKnowledge throws', async () => {
		mockMigrate.mockRejectedValueOnce(
			new Error('Sensitive data leaked: password=12345'),
		);
		const result = await handleKnowledgeMigrateCommand('/test/dir', []);
		expect(result).toContain('failed');
		expect(result).not.toContain('Sensitive data leaked');
		expect(result).not.toContain('password');
	});
});
