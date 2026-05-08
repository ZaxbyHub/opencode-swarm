/**
 * Error-handling tests for dark-matter and simulate commands.
 * Verifies graceful degradation when detectDarkMatter throws (git errors, etc.).
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

import { _internals as coChangeAnalyzer } from '../tools/co-change-analyzer.js';
import { handleDarkMatterCommand } from './dark-matter.js';
import { handleSimulateCommand } from './simulate.js';

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('dark-matter command error handling', () => {
	const testDir = '/test/workspace';
	const originalDetectDarkMatter = coChangeAnalyzer.detectDarkMatter;

	beforeEach(() => {
		// Restore before each test to ensure clean state
		coChangeAnalyzer.detectDarkMatter = originalDetectDarkMatter;
	});

	afterEach(() => {
		// Restore original after each test
		coChangeAnalyzer.detectDarkMatter = originalDetectDarkMatter;
	});

	test('returns error message when detectDarkMatter throws git not-a-repo error', async () => {
		// Arrange: mock detectDarkMatter to throw a git-related error
		coChangeAnalyzer.detectDarkMatter = mock(async () => {
			throw new Error('fatal: not a git repository');
		});

		// Act
		const result = await handleDarkMatterCommand(testDir, []);

		// Assert: error message is formatted properly
		expect(result).toContain('## Dark Matter Analysis Failed');
		expect(result).toContain('Error analyzing git history');
		expect(result).toContain('fatal: not a git repository');
		expect(result).toContain(
			'Ensure this is a git repository with commit history',
		);
	});

	test('returns error message when detectDarkMatter throws timeout error', async () => {
		// Arrange: mock detectDarkMatter to throw a timeout error
		coChangeAnalyzer.detectDarkMatter = mock(async () => {
			throw new Error('git operation timed out after 10000ms');
		});

		// Act
		const result = await handleDarkMatterCommand(testDir, []);

		// Assert: error message is formatted properly
		expect(result).toContain('## Dark Matter Analysis Failed');
		expect(result).toContain('Error analyzing git history');
		expect(result).toContain('git operation timed out after 10000ms');
	});

	test('returns error message when detectDarkMatter throws generic error', async () => {
		// Arrange: mock detectDarkMatter to throw a generic error
		coChangeAnalyzer.detectDarkMatter = mock(async () => {
			throw new Error('Unexpected error');
		});

		// Act
		const result = await handleDarkMatterCommand(testDir, []);

		// Assert: error message is formatted properly
		expect(result).toContain('## Dark Matter Analysis Failed');
		expect(result).toContain('Unexpected error');
	});

	test('returns error message when detectDarkMatter throws non-Error object', async () => {
		// Arrange: mock detectDarkMatter to throw a string (edge case)
		coChangeAnalyzer.detectDarkMatter = mock(async () => {
			throw 'error string instead of Error object';
		});

		// Act
		const result = await handleDarkMatterCommand(testDir, []);

		// Assert: error message handles non-Error throwables
		expect(result).toContain('## Dark Matter Analysis Failed');
		expect(result).toContain('error string instead of Error object');
	});
});

describe('simulate command error handling', () => {
	const testDir = '/test/workspace';
	const originalDetectDarkMatter = coChangeAnalyzer.detectDarkMatter;

	beforeEach(() => {
		// Restore before each test to ensure clean state
		coChangeAnalyzer.detectDarkMatter = originalDetectDarkMatter;
	});

	afterEach(() => {
		// Restore original after each test
		coChangeAnalyzer.detectDarkMatter = originalDetectDarkMatter;
	});

	test('returns error message when detectDarkMatter throws git not-a-repo error', async () => {
		// Arrange: mock detectDarkMatter to throw a git-related error
		coChangeAnalyzer.detectDarkMatter = mock(async () => {
			throw new Error('fatal: not a git repository');
		});

		// Act
		const result = await handleSimulateCommand(testDir, []);

		// Assert: error message is formatted properly
		expect(result).toContain('## Simulate Report');
		expect(result).toContain('### Error');
		expect(result).toContain('Error analyzing git history');
		expect(result).toContain('fatal: not a git repository');
		expect(result).toContain(
			'Ensure this is a git repository with commit history',
		);
	});

	test('returns error message when detectDarkMatter throws permission denied error', async () => {
		// Arrange: mock detectDarkMatter to throw a permission error
		coChangeAnalyzer.detectDarkMatter = mock(async () => {
			throw new Error('EACCES: permission denied');
		});

		// Act
		const result = await handleSimulateCommand(testDir, []);

		// Assert: error message is formatted properly
		expect(result).toContain('## Simulate Report');
		expect(result).toContain('### Error');
		expect(result).toContain('Error analyzing git history');
		expect(result).toContain('EACCES: permission denied');
	});

	test('returns error message when detectDarkMatter throws empty commits error', async () => {
		// Arrange: mock detectDarkMatter to throw an error about no commits
		coChangeAnalyzer.detectDarkMatter = mock(async () => {
			throw new Error('Repository has no commits');
		});

		// Act
		const result = await handleSimulateCommand(testDir, []);

		// Assert: error message is formatted properly
		expect(result).toContain('## Simulate Report');
		expect(result).toContain('### Error');
		expect(result).toContain('Repository has no commits');
	});

	test('returns error message when detectDarkMatter throws non-Error object', async () => {
		// Arrange: mock detectDarkMatter to throw a string (edge case)
		coChangeAnalyzer.detectDarkMatter = mock(async () => {
			throw 'error string instead of Error object';
		});

		// Act
		const result = await handleSimulateCommand(testDir, []);

		// Assert: error message handles non-Error throwables
		expect(result).toContain('## Simulate Report');
		expect(result).toContain('error string instead of Error object');
	});
});
