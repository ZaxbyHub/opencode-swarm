/**
 * Tests for handleKnowledgeRestoreCommand.
 * Part 2 of 4 for knowledge.test.ts.
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import { handleKnowledgeRestoreCommand } from '../../../src/commands/knowledge.js';
import {
	makeEntry,
	mockReadKnowledge,
	mockRestoreEntry,
	mockUnarchiveEntry,
} from './_knowledge-commands-mocks';

describe('handleKnowledgeRestoreCommand', () => {
	beforeEach(() => {
		mockReadKnowledge.mockResolvedValue([]);
		mockRestoreEntry.mockReset();
		mockUnarchiveEntry.mockReset();
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
		// G6 (#1716): swarm read returns nothing (quarantined entries are in sidecar)
		mockReadKnowledge.mockResolvedValueOnce([]);
		// quarantine sidecar read: the entry
		mockReadKnowledge.mockResolvedValueOnce([makeEntry('test-id')]);
		mockRestoreEntry.mockResolvedValueOnce(undefined);
		await handleKnowledgeRestoreCommand('/test/dir', ['test-id']);
		expect(mockRestoreEntry).toHaveBeenCalledTimes(1);
		expect(mockRestoreEntry).toHaveBeenCalledWith('/test/dir', 'test-id');
	});

	it('returns success message with entryId on successful restore', async () => {
		mockReadKnowledge.mockResolvedValueOnce([]);
		mockReadKnowledge.mockResolvedValueOnce([makeEntry('test-id')]);
		mockRestoreEntry.mockResolvedValueOnce(undefined);
		const result = await handleKnowledgeRestoreCommand('/test/dir', [
			'test-id',
		]);
		expect(result).toBe('✅ Entry test-id restored successfully.');
	});

	it('returns generic error message when restoreEntry throws', async () => {
		mockReadKnowledge.mockResolvedValueOnce([]);
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
		mockReadKnowledge.mockResolvedValueOnce([]);
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
		mockReadKnowledge.mockResolvedValueOnce([]);
		mockReadKnowledge.mockResolvedValueOnce([makeEntry(id1), makeEntry(id2)]);
		const result = await handleKnowledgeRestoreCommand('/test/dir', ['abcd']);
		expect(mockRestoreEntry).not.toHaveBeenCalled();
		expect(result).toContain("Ambiguous prefix 'abcd'");
		expect(result).toContain(id1);
		expect(result).toContain(id2);
	});

	// G6 (#1716): an archived entry in the main swarm store routes to
	// `unarchiveEntry` instead of `restoreEntry`.
	it('G6: routes an archived entry to unarchiveEntry', async () => {
		mockReadKnowledge.mockResolvedValueOnce([
			makeEntry('archived-id', { status: 'archived' }),
		]);
		mockUnarchiveEntry.mockResolvedValueOnce({
			restored: true,
			restored_to: 'established',
		});
		const result = await handleKnowledgeRestoreCommand('/test/dir', [
			'archived-id',
		]);
		expect(mockUnarchiveEntry).toHaveBeenCalledTimes(1);
		expect(mockUnarchiveEntry).toHaveBeenCalledWith('/test/dir', 'archived-id');
		expect(mockRestoreEntry).not.toHaveBeenCalled();
		expect(result).toContain('archived-id');
		expect(result).toContain('established');
	});

	it('G6: reports failure when unarchiveEntry cannot restore', async () => {
		mockReadKnowledge.mockResolvedValueOnce([
			makeEntry('bad-id', { status: 'archived' }),
		]);
		mockUnarchiveEntry.mockResolvedValueOnce({
			restored: false,
			reason: 'invalid_lesson',
		});
		const result = await handleKnowledgeRestoreCommand('/test/dir', ['bad-id']);
		expect(result).toContain('could not be unarchived');
		expect(result).toContain('invalid_lesson');
	});

	it('G6: clear error for a non-archived, non-quarantined entry', async () => {
		// Swarm read returns a candidate (active) entry; quarantine read empty.
		mockReadKnowledge.mockResolvedValueOnce([
			makeEntry('active-id', { status: 'candidate' }),
		]);
		mockReadKnowledge.mockResolvedValueOnce([]);
		const result = await handleKnowledgeRestoreCommand('/test/dir', [
			'active-id',
		]);
		expect(result).toContain('neither archived nor quarantined');
		expect(mockRestoreEntry).not.toHaveBeenCalled();
		expect(mockUnarchiveEntry).not.toHaveBeenCalled();
	});

	// PRR-007: when a prefix matches BOTH an archived swarm entry AND a
	// quarantined sidecar entry, the dispatch documented precedence is
	// archived-swarm wins (the new G6 path is checked first).
	it('G6/PRR-007: prefix collision — archived swarm wins over quarantined sidecar', async () => {
		// Swarm read: an archived entry whose id starts with the prefix.
		// (The quarantine read is never reached because the archived branch
		// returns, so we only mock the swarm read here.)
		mockReadKnowledge.mockResolvedValueOnce([
			makeEntry('colliding-id', { status: 'archived' }),
		]);
		mockUnarchiveEntry.mockResolvedValueOnce({
			restored: true,
			restored_to: 'candidate',
		});
		const result = await handleKnowledgeRestoreCommand('/test/dir', [
			'colliding',
		]);
		expect(mockUnarchiveEntry).toHaveBeenCalledWith(
			'/test/dir',
			'colliding-id',
		);
		expect(mockRestoreEntry).not.toHaveBeenCalled();
		expect(result).toContain('colliding-id');
	});
});
