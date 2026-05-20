import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock knowledge-store — required because quarantine/restore handlers now call readKnowledge
// to resolve prefix matches before delegating to the backend.
const mockReadKnowledge = vi.fn().mockResolvedValue([]);
const mockResolveSwarmKnowledgePath = vi
	.fn()
	.mockImplementation((dir: string) => `${dir}/.swarm/knowledge.jsonl`);

vi.mock('../../../src/hooks/knowledge-store.js', () => ({
	readKnowledge: (path: string) => mockReadKnowledge(path),
	resolveSwarmKnowledgePath: (dir: string) =>
		mockResolveSwarmKnowledgePath(dir),
}));

// Mock knowledge-validator module
const mockQuarantineEntry = vi.fn();
const mockRestoreEntry = vi.fn();

vi.mock('../../../src/hooks/knowledge-validator.js', () => ({
	quarantineEntry: mockQuarantineEntry,
	restoreEntry: mockRestoreEntry,
}));

// Mock knowledge-migrator module
const mockMigrate = vi.fn();

vi.mock('../../../src/hooks/knowledge-migrator.js', () => ({
	migrateContextToKnowledge: mockMigrate,
}));

// Import AFTER mocking, with .js extension
import {
	handleKnowledgeListCommand,
	handleKnowledgeMigrateCommand,
	handleKnowledgeQuarantineCommand,
	handleKnowledgeRestoreCommand,
} from '../../../src/commands/knowledge.js';

// Build a minimal SwarmKnowledgeEntry for mocking
function makeEntry(id: string, overrides?: Record<string, unknown>) {
	return {
		id,
		tier: 'swarm' as const,
		lesson: 'A test lesson that is long enough for testing',
		category: 'process' as const,
		tags: [],
		scope: 'global',
		confidence: 0.75,
		status: 'candidate' as const,
		confirmed_by: [],
		project_name: 'test',
		retrieval_outcomes: {
			applied_count: 0,
			succeeded_after_count: 0,
			failed_after_count: 0,
		},
		schema_version: 1,
		created_at: '2026-01-01T00:00:00Z',
		updated_at: '2026-01-01T00:00:00Z',
		auto_generated: false,
		hive_eligible: false,
		...overrides,
	};
}

describe('handleKnowledgeQuarantineCommand', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('returns usage message when entryId is missing (empty args)', async () => {
		const result = await handleKnowledgeQuarantineCommand('/test/dir', []);
		expect(result).toBe('Usage: /swarm knowledge quarantine <id> [reason]');
		expect(mockQuarantineEntry).not.toHaveBeenCalled();
	});

	it('returns invalid ID message when entryId contains path traversal (../secret)', async () => {
		const result = await handleKnowledgeQuarantineCommand('/test/dir', [
			'../secret',
		]);
		expect(result).toBe(
			'Invalid entry ID. IDs must be 1-64 characters: letters, digits, hyphens, underscores only.',
		);
		expect(mockQuarantineEntry).not.toHaveBeenCalled();
	});

	it('returns invalid ID message when entryId contains special chars (abc!def)', async () => {
		const result = await handleKnowledgeQuarantineCommand('/test/dir', [
			'abc!def',
		]);
		expect(result).toBe(
			'Invalid entry ID. IDs must be 1-64 characters: letters, digits, hyphens, underscores only.',
		);
		expect(mockQuarantineEntry).not.toHaveBeenCalled();
	});

	it('returns invalid ID message when entryId is > 64 chars', async () => {
		const longId = 'a'.repeat(65);
		const result = await handleKnowledgeQuarantineCommand('/test/dir', [
			longId,
		]);
		expect(result).toBe(
			'Invalid entry ID. IDs must be 1-64 characters: letters, digits, hyphens, underscores only.',
		);
		expect(mockQuarantineEntry).not.toHaveBeenCalled();
	});

	it('calls quarantineEntry with correct args when valid', async () => {
		mockReadKnowledge.mockResolvedValueOnce([makeEntry('test-id')]);
		mockQuarantineEntry.mockResolvedValueOnce(undefined);
		await handleKnowledgeQuarantineCommand('/test/dir', [
			'test-id',
			'because',
			'it',
			'is',
			'bad',
		]);
		expect(mockQuarantineEntry).toHaveBeenCalledTimes(1);
		expect(mockQuarantineEntry).toHaveBeenCalledWith(
			'/test/dir',
			'test-id',
			'because it is bad',
			'user',
		);
	});

	it('returns success message with entryId on successful quarantine', async () => {
		mockReadKnowledge.mockResolvedValueOnce([makeEntry('test-id')]);
		mockQuarantineEntry.mockResolvedValueOnce(undefined);
		const result = await handleKnowledgeQuarantineCommand('/test/dir', [
			'test-id',
		]);
		expect(result).toBe('✅ Entry test-id quarantined successfully.');
	});

	it('uses default reason when no reason args provided', async () => {
		mockReadKnowledge.mockResolvedValueOnce([makeEntry('test-id')]);
		mockQuarantineEntry.mockResolvedValueOnce(undefined);
		await handleKnowledgeQuarantineCommand('/test/dir', ['test-id']);
		expect(mockQuarantineEntry).toHaveBeenCalledWith(
			'/test/dir',
			'test-id',
			'Quarantined via /swarm knowledge quarantine command',
			'user',
		);
	});

	it('joins multi-word reason args correctly', async () => {
		mockReadKnowledge.mockResolvedValueOnce([makeEntry('abc')]);
		mockQuarantineEntry.mockResolvedValueOnce(undefined);
		const args = ['abc', 'bad', 'rule'];
		await handleKnowledgeQuarantineCommand('/test/dir', args);
		expect(mockQuarantineEntry).toHaveBeenCalledWith(
			'/test/dir',
			'abc',
			'bad rule',
			'user',
		);
	});

	it('returns generic error message (not raw error) when quarantineEntry throws', async () => {
		mockReadKnowledge.mockResolvedValueOnce([makeEntry('test-id')]);
		mockQuarantineEntry.mockRejectedValueOnce(
			new Error('Internal database error'),
		);
		const result = await handleKnowledgeQuarantineCommand('/test/dir', [
			'test-id',
		]);
		expect(result).toBe(
			'❌ Failed to quarantine entry. Check the entry ID and try again.',
		);
	});

	it('does NOT expose error message content in return value when quarantineEntry throws', async () => {
		mockReadKnowledge.mockResolvedValueOnce([makeEntry('test-id')]);
		mockQuarantineEntry.mockRejectedValueOnce(
			new Error('Sensitive information leaked'),
		);
		const result = await handleKnowledgeQuarantineCommand('/test/dir', [
			'test-id',
		]);
		expect(result).not.toContain('Sensitive information leaked');
		expect(result).not.toContain('Sensitive');
		expect(result).toBe(
			'❌ Failed to quarantine entry. Check the entry ID and try again.',
		);
	});

	it('resolves by unique prefix and quarantines the matched entry (test 7)', async () => {
		const fullId = 'abc123def456-1234-5678-abcd-ef0123456789';
		mockReadKnowledge.mockResolvedValueOnce([makeEntry(fullId)]);
		mockQuarantineEntry.mockResolvedValueOnce(undefined);
		const result = await handleKnowledgeQuarantineCommand('/test/dir', [
			'abc123def456',
		]);
		expect(mockQuarantineEntry).toHaveBeenCalledWith(
			'/test/dir',
			fullId,
			'Quarantined via /swarm knowledge quarantine command',
			'user',
		);
		expect(result).toBe(`✅ Entry ${fullId} quarantined successfully.`);
	});

	it('returns not-found error when prefix matches no entries', async () => {
		mockReadKnowledge.mockResolvedValueOnce([makeEntry('xyz999-some-uuid')]);
		const result = await handleKnowledgeQuarantineCommand('/test/dir', [
			'abc123',
		]);
		expect(mockQuarantineEntry).not.toHaveBeenCalled();
		expect(result).toContain("No entry found matching 'abc123'");
	});

	it('rejects ambiguous prefix and lists all matching candidates (test 8)', async () => {
		const id1 = 'abcd1111-entry-one-long-enough';
		const id2 = 'abcd2222-entry-two-long-enough';
		mockReadKnowledge.mockResolvedValueOnce([makeEntry(id1), makeEntry(id2)]);
		const result = await handleKnowledgeQuarantineCommand('/test/dir', [
			'abcd',
		]);
		expect(mockQuarantineEntry).not.toHaveBeenCalled();
		expect(result).toContain("Ambiguous prefix 'abcd'");
		expect(result).toContain(id1);
		expect(result).toContain(id2);
	});
});

describe('handleKnowledgeRestoreCommand', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('returns usage message when entryId is missing (empty args)', async () => {
		const result = await handleKnowledgeRestoreCommand('/test/dir', []);
		expect(result).toBe('Usage: /swarm knowledge restore <id>');
		expect(mockRestoreEntry).not.toHaveBeenCalled();
	});

	it('returns invalid ID message when entryId contains path traversal', async () => {
		const result = await handleKnowledgeRestoreCommand('/test/dir', [
			'../../etc/passwd',
		]);
		expect(result).toBe(
			'Invalid entry ID. IDs must be 1-64 characters: letters, digits, hyphens, underscores only.',
		);
		expect(mockRestoreEntry).not.toHaveBeenCalled();
	});

	it('calls restoreEntry with correct args when valid', async () => {
		mockReadKnowledge.mockResolvedValueOnce([makeEntry('test-id')]);
		mockRestoreEntry.mockResolvedValueOnce(undefined);
		await handleKnowledgeRestoreCommand('/test/dir', ['test-id']);
		expect(mockRestoreEntry).toHaveBeenCalledTimes(1);
		expect(mockRestoreEntry).toHaveBeenCalledWith('/test/dir', 'test-id');
	});

	it('returns success message with entryId on successful restore', async () => {
		mockReadKnowledge.mockResolvedValueOnce([makeEntry('test-id')]);
		mockRestoreEntry.mockResolvedValueOnce(undefined);
		const result = await handleKnowledgeRestoreCommand('/test/dir', [
			'test-id',
		]);
		expect(result).toBe('✅ Entry test-id restored successfully.');
	});

	it('returns generic error message when restoreEntry throws', async () => {
		mockReadKnowledge.mockResolvedValueOnce([makeEntry('test-id')]);
		mockRestoreEntry.mockRejectedValueOnce(new Error('Entry not found'));
		const result = await handleKnowledgeRestoreCommand('/test/dir', [
			'test-id',
		]);
		expect(result).toBe(
			'❌ Failed to restore entry. Check the entry ID and try again.',
		);
	});

	it('resolves by unique prefix and restores the matched entry', async () => {
		const fullId = 'abc123def456-quarantined-uuid';
		mockReadKnowledge.mockResolvedValueOnce([makeEntry(fullId)]);
		mockRestoreEntry.mockResolvedValueOnce(undefined);
		const result = await handleKnowledgeRestoreCommand('/test/dir', [
			'abc123def456',
		]);
		expect(mockRestoreEntry).toHaveBeenCalledWith('/test/dir', fullId);
		expect(result).toBe(`✅ Entry ${fullId} restored successfully.`);
	});

	it('rejects ambiguous prefix for restore and lists matching candidates', async () => {
		const id1 = 'abcd1111-quarantined-one';
		const id2 = 'abcd2222-quarantined-two';
		mockReadKnowledge.mockResolvedValueOnce([makeEntry(id1), makeEntry(id2)]);
		const result = await handleKnowledgeRestoreCommand('/test/dir', ['abcd']);
		expect(mockRestoreEntry).not.toHaveBeenCalled();
		expect(result).toContain("Ambiguous prefix 'abcd'");
		expect(result).toContain(id1);
		expect(result).toContain(id2);
	});
});

describe('handleKnowledgeListCommand', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('returns no-entries message when knowledge store is empty', async () => {
		mockReadKnowledge.mockResolvedValueOnce([]);
		const result = await handleKnowledgeListCommand('/test/dir', []);
		expect(result).toContain('No knowledge entries found');
	});

	it('shows 12-char ID prefix in list output (test 7 — enables quarantine workflow)', async () => {
		const fullId = 'abc123def456-1234-5678-abcd-ef0123456789';
		mockReadKnowledge.mockResolvedValueOnce([makeEntry(fullId)]);
		const result = await handleKnowledgeListCommand('/test/dir', []);
		expect(result).toContain('abc123def456');
		expect(result).toContain('…');
	});

	it('list output includes prefix-matching usage hint', async () => {
		const fullId = 'abc123def456-1234-5678-abcd-ef0123456789';
		mockReadKnowledge.mockResolvedValueOnce([makeEntry(fullId)]);
		const result = await handleKnowledgeListCommand('/test/dir', []);
		expect(result).toContain('quarantine');
		expect(result).toContain('Prefix matching is supported');
	});

	it('12-char prefix from list output can be used to quarantine the entry (test 7 round-trip)', async () => {
		const fullId = 'abc123def456-1234-5678-abcd-ef0123456789';
		const entry = makeEntry(fullId);

		// Step 1: list — get the prefix shown
		mockReadKnowledge.mockResolvedValueOnce([entry]);
		const listResult = await handleKnowledgeListCommand('/test/dir', []);
		const shownPrefix = fullId.slice(0, 12);
		expect(listResult).toContain(shownPrefix);

		// Step 2: quarantine using only that prefix
		mockReadKnowledge.mockResolvedValueOnce([entry]);
		mockQuarantineEntry.mockResolvedValueOnce(undefined);
		const quarantineResult = await handleKnowledgeQuarantineCommand(
			'/test/dir',
			[shownPrefix],
		);
		expect(quarantineResult).toBe(
			`✅ Entry ${fullId} quarantined successfully.`,
		);
	});

	it('returns error message when readKnowledge throws', async () => {
		mockReadKnowledge.mockRejectedValueOnce(new Error('File not readable'));
		const result = await handleKnowledgeListCommand('/test/dir', []);
		expect(result).toContain('Failed to list knowledge entries');
		expect(result).not.toContain('File not readable');
	});
});

describe('createSwarmCommandHandler routing (in index.ts)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('knowledge quarantine <id> routes to quarantine handler', async () => {
		mockReadKnowledge.mockResolvedValueOnce([makeEntry('test-id')]);
		mockQuarantineEntry.mockResolvedValueOnce(undefined);
		const result = await handleKnowledgeQuarantineCommand('/test/dir', [
			'test-id',
			'test reason',
		]);
		expect(result).toContain('test-id');
		expect(mockQuarantineEntry).toHaveBeenCalledWith(
			'/test/dir',
			'test-id',
			'test reason',
			'user',
		);
	});

	it('knowledge restore <id> routes to restore handler', async () => {
		mockReadKnowledge.mockResolvedValueOnce([makeEntry('test-id')]);
		mockRestoreEntry.mockResolvedValueOnce(undefined);
		const result = await handleKnowledgeRestoreCommand('/test/dir', [
			'test-id',
		]);
		expect(result).toContain('test-id');
		expect(mockRestoreEntry).toHaveBeenCalledWith('/test/dir', 'test-id');
	});

	it('knowledge (no subcommand) returns help text with both command descriptions', async () => {
		const helpText =
			'Knowledge commands: /swarm knowledge quarantine <id> [reason] - Quarantine a knowledge entry\n/swarm knowledge restore <id> - Restore a quarantined entry';
		expect(helpText).toContain('quarantine');
		expect(helpText).toContain('restore');
	});
});

describe('handleKnowledgeMigrateCommand', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('successful migration returns string containing "Migration complete" with correct counts (entriesMigrated=3, entriesDropped=1, entriesTotal=4)', async () => {
		mockMigrate.mockResolvedValueOnce({
			migrated: true,
			entriesMigrated: 3,
			entriesDropped: 1,
			entriesTotal: 4,
		});
		const result = await handleKnowledgeMigrateCommand('/test/dir', []);
		expect(result).toContain('Migration complete');
		expect(result).toContain('3 entries added');
		expect(result).toContain('1 dropped');
		expect(result).toContain('4 total processed');
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

	it('skippedReason unknown value returns string containing "unknown reason"', async () => {
		mockMigrate.mockResolvedValueOnce({
			migrated: false,
			entriesMigrated: 0,
			entriesDropped: 0,
			entriesTotal: 0,
			skippedReason: 'some-unknown-reason' as never,
		});
		const result = await handleKnowledgeMigrateCommand('/test/dir', []);
		expect(result).toContain('unknown reason');
		expect(mockMigrate).toHaveBeenCalledWith('/test/dir', expect.any(Object));
	});

	it('error thrown by migrateContextToKnowledge returns string containing "failed"', async () => {
		mockMigrate.mockRejectedValueOnce(new Error('Database connection failed'));
		const result = await handleKnowledgeMigrateCommand('/test/dir', []);
		expect(result).toContain('failed');
		expect(result).toContain('Check .swarm/context.md');
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
		expect(result).toContain('Migration complete');
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
		expect(result).toContain('Migration complete');
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
