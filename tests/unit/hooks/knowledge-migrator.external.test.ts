/**
 * Verification tests for migrateKnowledgeToExternal() in Task 1.3
 * Tests the migration from internal knowledge.jsonl to external platform path
 *
 * Uses _internals DI seam pattern to mock filesystem operations without mock.module leakage.
 * Follows AGENTS.md §7: bun:test with spread-real-exports pattern.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as path from 'node:path';
import { _internals } from '../../../src/hooks/knowledge-migrator';

// Bun:test mock functions for filesystem operations
const mockExistsSync = mock(() => false);
const mockReadFileSync = mock(() => '');
const mockMkdir = mock(() => Promise.resolve());
const mockReadFile = mock(() => Promise.resolve(''));
const mockWriteFile = mock(() => Promise.resolve());

// Save original _internals reference before any tests run
// We need to save the actual object reference so we can restore it
const originalInternals: Record<string, unknown> = {};
for (const key of Object.keys(_internals)) {
	originalInternals[key] = _internals[key as keyof typeof _internals];
}

beforeEach(() => {
	// Reset mocks before each test (mockReset clears all internal state including queued return values)
	mockExistsSync.mockReset();
	mockReadFileSync.mockReset();
	mockMkdir.mockReset();
	mockReadFile.mockReset();
	mockWriteFile.mockReset();

	// Replace _internals with mocked versions via DI seam
	// This is the _internals DI seam pattern for bun:test
	// First restore to clean state, then add mocks
	Object.assign(_internals, originalInternals);
	Object.assign(_internals, {
		existsSync: mockExistsSync,
		readFileSync: mockReadFileSync,
		mkdir: mockMkdir,
		readFile: mockReadFile,
		writeFile: mockWriteFile,
		// writeSentinel uses _internals.writeFile and _internals.mkdir internally
	});
});

afterEach(() => {
	// Restore original _internals by clearing and re-assigning
	for (const key of Object.keys(_internals)) {
		delete _internals[key as keyof typeof _internals];
	}
	Object.assign(_internals, originalInternals);
});

describe('migrateKnowledgeToExternal', () => {
	test('returns { migrated: false, skippedReason: "external-sentinel-exists" } when external sentinel exists', async () => {
		// Arrange
		mockExistsSync
			.mockReturnValueOnce(true) // external sentinel exists
			.mockReturnValueOnce(false); // context.md does not exist

		// Act
		const result = await _internals.migrateKnowledgeToExternal(
			'/fake/path',
			{},
		);

		// Assert
		expect(result).toEqual({
			migrated: false,
			entriesMigrated: 0,
			entriesDropped: 0,
			entriesTotal: 0,
			skippedReason: 'external-sentinel-exists',
		});
		expect(mockExistsSync).toHaveBeenCalledWith(
			path.join('/fake/path', '.swarm', '.knowledge-external-migrated'),
		);
	});

	test('returns { migrated: false, skippedReason: "no-context-file" } when context.md does not exist', async () => {
		// Arrange
		mockExistsSync
			.mockReturnValueOnce(false) // external sentinel does not exist
			.mockReturnValueOnce(false); // context.md does not exist

		// Act
		const result = await _internals.migrateKnowledgeToExternal(
			'/fake/path',
			{},
		);

		// Assert
		expect(result).toEqual({
			migrated: false,
			entriesMigrated: 0,
			entriesDropped: 0,
			entriesTotal: 0,
			skippedReason: 'no-context-file',
		});
		expect(mockExistsSync).toHaveBeenCalledWith(
			path.join('/fake/path', '.swarm', '.knowledge-external-migrated'),
		);
		expect(mockExistsSync).toHaveBeenCalledWith(
			path.join('/fake/path', '.swarm', 'context.md'),
		);
	});

	test('returns { migrated: false, skippedReason: "empty-context" } when context.md is empty', async () => {
		// Arrange
		mockExistsSync
			.mockReturnValueOnce(false) // external sentinel does not exist
			.mockReturnValueOnce(true); // context.md exists
		mockReadFile.mockResolvedValue('');

		// Act
		const result = await _internals.migrateKnowledgeToExternal(
			'/fake/path',
			{},
		);

		// Assert
		expect(result).toEqual({
			migrated: false,
			entriesMigrated: 0,
			entriesDropped: 0,
			entriesTotal: 0,
			skippedReason: 'empty-context',
		});
		expect(mockExistsSync).toHaveBeenCalledWith(
			path.join('/fake/path', '.swarm', '.knowledge-external-migrated'),
		);
		expect(mockExistsSync).toHaveBeenCalledWith(
			path.join('/fake/path', '.swarm', 'context.md'),
		);
		expect(mockReadFile).toHaveBeenCalledWith(
			path.join('/fake/path', '.swarm', 'context.md'),
			'utf-8',
		);
	});

	test('returns { migrated: true, entriesMigrated: 1 } when context.md has one valid entry', async () => {
		// Arrange
		mockExistsSync
			.mockReturnValueOnce(false) // external sentinel does not exist
			.mockReturnValueOnce(true); // context.md exists
		mockReadFile.mockResolvedValue('# lessons-learned\n- Test lesson');

		// Act
		const result = await _internals.migrateKnowledgeToExternal(
			'/fake/path',
			{},
		);

		// Assert
		expect(result).toEqual({
			migrated: true,
			entriesMigrated: 1,
			entriesDropped: 0,
			entriesTotal: 1,
		});
		expect(mockExistsSync).toHaveBeenCalledWith(
			path.join('/fake/path', '.swarm', '.knowledge-external-migrated'),
		);
		expect(mockExistsSync).toHaveBeenCalledWith(
			path.join('/fake/path', '.swarm', 'context.md'),
		);
		expect(mockReadFile).toHaveBeenCalledWith(
			path.join('/fake/path', '.swarm', 'context.md'),
			'utf-8',
		);
		// writeSentinel calls _internals.writeFile which is mocked above
		expect(mockWriteFile).toHaveBeenCalled();
	});
});
