/**
 * Tests for handleKnowledgeListCommand and createSwarmCommandHandler routing.
 * Part 3 of 4 for knowledge.test.ts.
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import {
	handleKnowledgeListCommand,
	handleKnowledgeQuarantineCommand,
	handleKnowledgeRestoreCommand,
} from '../../../src/commands/knowledge.js';
import {
	makeEntry,
	mockQuarantineEntry,
	mockReadKnowledge,
	mockRestoreEntry,
} from './_knowledge-commands-mocks';

describe('handleKnowledgeListCommand', () => {
	beforeEach(() => {
		mockReadKnowledge.mockResolvedValue([]);
	});

	it('returns no-entries message when knowledge store is empty', async () => {
		mockReadKnowledge.mockResolvedValueOnce([]);
		const result = await handleKnowledgeListCommand('/test/dir', []);
		expect(result).toContain('No knowledge entries found');
	});

	it('shows 12-char ID prefix in list output', async () => {
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

	it('12-char prefix from list output can be used to quarantine the entry (round-trip)', async () => {
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
		mockReadKnowledge.mockResolvedValue([]);
		mockQuarantineEntry.mockReset();
		mockRestoreEntry.mockReset();
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
			// F-02: cohort-safety curationContext threaded through the command.
			expect.objectContaining({
				input: expect.objectContaining({
					action: 'quarantine',
					evidenceScope: 'local-session',
					actorRole: 'user',
				}),
			}),
		);
	});

	it('knowledge restore <id> routes to restore handler', async () => {
		// G6: handler reads swarm first (no archived match), then quarantine sidecar.
		mockReadKnowledge.mockResolvedValueOnce([]);
		mockReadKnowledge.mockResolvedValueOnce([makeEntry('test-id')]);
		mockRestoreEntry.mockResolvedValueOnce(undefined);
		const result = await handleKnowledgeRestoreCommand('/test/dir', [
			'test-id',
		]);
		expect(result).toContain('test-id');
		expect(mockRestoreEntry).toHaveBeenCalledWith(
			'/test/dir',
			'test-id',
			expect.objectContaining({
				input: expect.objectContaining({
					action: 'restore',
					evidenceScope: 'local-session',
					actorRole: 'user',
				}),
			}),
		);
	});

	it('knowledge (no subcommand) returns help text with both command descriptions', async () => {
		const helpText =
			'Knowledge commands: /swarm knowledge quarantine <id> [reason] - Quarantine a knowledge entry\n/swarm knowledge restore <id> - Restore a quarantined entry';
		expect(helpText).toContain('quarantine');
		expect(helpText).toContain('restore');
	});
});
