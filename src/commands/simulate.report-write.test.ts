/**
 * Report write error handling tests for simulate command.
 * Verifies warn() is called and summary is returned when writeFile throws.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs/promises';

import { _internals as coChangeAnalyzer } from '../tools/co-change-analyzer.js';
import { handleSimulateCommand } from './simulate.js';

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('simulate command report write error handling', () => {
	const testDir = '/test/workspace';
	const originalDetectDarkMatter = coChangeAnalyzer.detectDarkMatter;

	beforeEach(() => {
		// Restore mocks before each test
		coChangeAnalyzer.detectDarkMatter = originalDetectDarkMatter;
	});

	afterEach(() => {
		// Restore originals after each test
		coChangeAnalyzer.detectDarkMatter = originalDetectDarkMatter;
		mock.restore();
	});

	test('logs warning via warn() when writeFile throws EACCES', async () => {
		// Arrange: mock detectDarkMatter to return mock data
		const mockPairs = [
			{
				fileA: 'src/a.ts',
				fileB: 'src/b.ts',
				coChangeCount: 5,
				npmi: 0.723,
				lift: 2.1,
				hasStaticEdge: false,
				totalCommits: 100,
				commitsA: 30,
				commitsB: 25,
			},
		];
		coChangeAnalyzer.detectDarkMatter = mock(async () => mockPairs);

		// Mock warn to track calls
		const warnCalls: Array<[string, unknown]> = [];
		const warnMock = mock((msg: string, data: unknown) => {
			warnCalls.push([msg, data]);
		});

		// Mock the utils module's warn
		await mock.module('../utils', () => ({
			error: () => {},
			log: () => {},
			warn: warnMock,
			deepMerge: () => ({}),
			escapeRegex: () => '',
			MAX_MERGE_DEPTH: 10,
			CLIError: class extends Error {},
			ConfigError: class extends Error {},
			HookError: class extends Error {},
			SwarmError: class extends Error {},
			ToolError: class extends Error {},
		}));

		// Mock writeFile to throw
		await mock.module('node:fs/promises', () => ({
			...fs,
			writeFile: mock(async () => {
				throw Object.assign(new Error('EACCES: permission denied'), {
					code: 'EACCES',
				});
			}),
		}));

		// Re-import simulate to get mocked utils
		const { handleSimulateCommand: mockedCommand } = await import(
			'./simulate.js'
		);

		// Act
		const result = await mockedCommand(testDir, []);

		// Assert: warn was called
		expect(warnCalls.length).toBe(1);
		const [warnMsg, warnData] = warnCalls[0];
		expect(warnMsg).toContain('simulate');
		expect(warnMsg).toContain('failed to write report');
		expect(warnData).toContain('EACCES: permission denied');
	});

	test('returns summary string when writeFile throws (not error)', async () => {
		// Arrange: mock detectDarkMatter to return mock data
		const mockPairs = [
			{
				fileA: 'src/a.ts',
				fileB: 'src/b.ts',
				coChangeCount: 5,
				npmi: 0.723,
				lift: 2.1,
				hasStaticEdge: false,
				totalCommits: 100,
				commitsA: 30,
				commitsB: 25,
			},
		];
		coChangeAnalyzer.detectDarkMatter = mock(async () => mockPairs);

		// Mock warn to be no-op
		const warnMock = mock(() => {});

		await mock.module('../utils', () => ({
			error: () => {},
			log: () => {},
			warn: warnMock,
			deepMerge: () => ({}),
			escapeRegex: () => '',
			MAX_MERGE_DEPTH: 10,
			CLIError: class extends Error {},
			ConfigError: class extends Error {},
			HookError: class extends Error {},
			SwarmError: class extends Error {},
			ToolError: class extends Error {},
		}));

		// Mock writeFile to throw
		await mock.module('node:fs/promises', () => ({
			...fs,
			writeFile: mock(async () => {
				throw Object.assign(new Error('ENOSPC: no space left on device'), {
					code: 'ENOSPC',
				});
			}),
		}));

		// Re-import simulate to get mocked utils
		const { handleSimulateCommand: mockedCommand } = await import(
			'./simulate.js'
		);

		// Act
		const result = await mockedCommand(testDir, []);

		// Assert: result is the summary string, not an error message
		expect(result).toBe('1 hidden coupling pairs detected');
		expect(result).not.toContain('## Simulate Report');
		expect(result).not.toContain('Error');
		expect(result).not.toContain('failed to write');
	});

	test('includes directory path in warning message when writeFile throws ENOENT', async () => {
		// Arrange: mock detectDarkMatter to return empty data
		coChangeAnalyzer.detectDarkMatter = mock(async () => []);

		// Mock warn to track calls
		const warnCalls: Array<[string, unknown]> = [];
		const warnMock = mock((msg: string, data: unknown) => {
			warnCalls.push([msg, data]);
		});

		await mock.module('../utils', () => ({
			error: () => {},
			log: () => {},
			warn: warnMock,
			deepMerge: () => ({}),
			escapeRegex: () => '',
			MAX_MERGE_DEPTH: 10,
			CLIError: class extends Error {},
			ConfigError: class extends Error {},
			HookError: class extends Error {},
			SwarmError: class extends Error {},
			ToolError: class extends Error {},
		}));

		// Mock writeFile to throw
		await mock.module('node:fs/promises', () => ({
			...fs,
			writeFile: mock(async () => {
				throw Object.assign(new Error('ENOENT: no such file or directory'), {
					code: 'ENOENT',
				});
			}),
		}));

		// Re-import simulate to get mocked utils
		const { handleSimulateCommand: mockedCommand } = await import(
			'./simulate.js'
		);

		// Act
		await mockedCommand(testDir, []);

		// Assert: warning includes the directory path
		expect(warnCalls.length).toBe(1);
		const [warnMsg] = warnCalls[0];
		expect(warnMsg).toContain(testDir);
		expect(warnMsg).toContain('.swarm');
		expect(warnMsg).toContain('simulate-report.md');
	});

	test('returns summary string when writeFile succeeds', async () => {
		// Arrange: mock detectDarkMatter to return mock data
		const mockPairs = [
			{
				fileA: 'src/a.ts',
				fileB: 'src/b.ts',
				coChangeCount: 5,
				npmi: 0.723,
				lift: 2.1,
				hasStaticEdge: false,
				totalCommits: 100,
				commitsA: 30,
				commitsB: 25,
			},
		];
		coChangeAnalyzer.detectDarkMatter = mock(async () => mockPairs);

		// Mock warn to be no-op
		const warnMock = mock(() => {});

		await mock.module('../utils', () => ({
			error: () => {},
			log: () => {},
			warn: warnMock,
			deepMerge: () => ({}),
			escapeRegex: () => '',
			MAX_MERGE_DEPTH: 10,
			CLIError: class extends Error {},
			ConfigError: class extends Error {},
			HookError: class extends Error {},
			SwarmError: class extends Error {},
			ToolError: class extends Error {},
		}));

		// Mock writeFile to succeed
		await mock.module('node:fs/promises', () => ({
			...fs,
			writeFile: mock(async () => {}),
		}));

		// Re-import simulate to get mocked utils
		const { handleSimulateCommand: mockedCommand } = await import(
			'./simulate.js'
		);

		// Act
		const result = await mockedCommand(testDir, []);

		// Assert: result is the summary string
		expect(result).toBe('1 hidden coupling pairs detected');
	});

	test('warn receives error message string when writeFile throws Error object', async () => {
		// Arrange
		coChangeAnalyzer.detectDarkMatter = mock(async () => []);

		const warnCalls: Array<[string, unknown]> = [];
		const warnMock = mock((msg: string, data: unknown) => {
			warnCalls.push([msg, data]);
		});

		await mock.module('../utils', () => ({
			error: () => {},
			log: () => {},
			warn: warnMock,
			deepMerge: () => ({}),
			escapeRegex: () => '',
			MAX_MERGE_DEPTH: 10,
			CLIError: class extends Error {},
			ConfigError: class extends Error {},
			HookError: class extends Error {},
			SwarmError: class extends Error {},
			ToolError: class extends Error {},
		}));

		// Mock writeFile to throw
		await mock.module('node:fs/promises', () => ({
			...fs,
			writeFile: mock(async () => {
				throw Object.assign(new Error('EACCES: permission denied'), {
					code: 'EACCES',
				});
			}),
		}));

		// Re-import simulate to get mocked utils
		const { handleSimulateCommand: mockedCommand } = await import(
			'./simulate.js'
		);

		// Act
		await mockedCommand(testDir, []);

		// Assert: warn was called with error message
		expect(warnCalls.length).toBe(1);
		const [, warnData] = warnCalls[0];
		expect(warnData).toBe('EACCES: permission denied');
	});

	test('warn receives stringified error when writeFile throws non-Error', async () => {
		// Arrange
		coChangeAnalyzer.detectDarkMatter = mock(async () => []);

		const warnCalls: Array<[string, unknown]> = [];
		const warnMock = mock((msg: string, data: unknown) => {
			warnCalls.push([msg, data]);
		});

		await mock.module('../utils', () => ({
			error: () => {},
			log: () => {},
			warn: warnMock,
			deepMerge: () => ({}),
			escapeRegex: () => '',
			MAX_MERGE_DEPTH: 10,
			CLIError: class extends Error {},
			ConfigError: class extends Error {},
			HookError: class extends Error {},
			SwarmError: class extends Error {},
			ToolError: class extends Error {},
		}));

		// Mock writeFile to throw a string
		await mock.module('node:fs/promises', () => ({
			...fs,
			writeFile: mock(async () => {
				throw 'Something went wrong';
			}),
		}));

		// Re-import simulate to get mocked utils
		const { handleSimulateCommand: mockedCommand } = await import(
			'./simulate.js'
		);

		// Act
		await mockedCommand(testDir, []);

		// Assert: warn was called with stringified error
		expect(warnCalls.length).toBe(1);
		const [, warnData] = warnCalls[0];
		expect(warnData).toBe('Something went wrong');
	});
});
