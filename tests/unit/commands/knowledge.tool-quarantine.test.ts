/**
 * Tests for handleKnowledgeQuarantineCommand.
 * Part 1 of 4 for knowledge.test.ts.
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import { handleKnowledgeQuarantineCommand } from '../../../src/commands/knowledge.js';
import {
	makeEntry,
	mockQuarantineEntry,
	mockReadKnowledge,
} from './_knowledge-commands-mocks';

describe('handleKnowledgeQuarantineCommand', () => {
	beforeEach(() => {
		mockReadKnowledge.mockResolvedValue([]);
		mockQuarantineEntry.mockReset();
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

	it('resolves by unique prefix and quarantines the matched entry', async () => {
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

	it('rejects ambiguous prefix and lists all matching candidates', async () => {
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
