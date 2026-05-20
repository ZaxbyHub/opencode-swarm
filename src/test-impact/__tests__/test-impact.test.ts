import { afterEach, beforeEach, describe, expect, test, vi } from 'bun:test';
import type { ToolContext } from '@opencode-ai/plugin';
import type { ToolResult } from '../../tools/create-tool';
import { test_impact } from '../../tools/test-impact.js';

/**
 * Helper to extract string from ToolResult
 */
function resultToString(result: ToolResult): string {
	return typeof result === 'string' ? result : result.output;
}

/**
 * Helper to create a minimal ToolContext mock for testing
 */
function createMockCtx(directory: string): ToolContext {
	return {
		sessionID: 'test-session',
		messageID: 'test-message-id',
		agent: 'test-agent',
		directory,
		worktree: directory,
		abort: new AbortController().signal,
		metadata: () => {},
		ask: () => Promise.resolve(undefined as never),
	} as unknown as ToolContext;
}

// Mock the analyzer module
vi.mock('../analyzer.js', () => ({
	analyzeImpact: vi.fn(),
}));

import { analyzeImpact } from '../analyzer.js';

const mockAnalyzeImpact = analyzeImpact as ReturnType<typeof vi.fn>;

describe('test_impact tool', () => {
	const mockExecute = test_impact.execute;

	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		// Clean up any temp directories if created
	});

	test('returns error when changedFiles is empty array', async () => {
		const result = await mockExecute(
			{ changedFiles: [] },
			createMockCtx('/test/dir'),
		);
		const parsed = JSON.parse(resultToString(result));

		expect(parsed.success).toBe(false);
		expect(parsed.error).toBe(
			'changedFiles must be a non-empty array of file paths',
		);
	});

	test('returns error when changedFiles is not an array', async () => {
		const result = await mockExecute(
			{ changedFiles: 'not-an-array' } as unknown as Record<string, unknown>,
			createMockCtx('/test/dir'),
		);
		const parsed = JSON.parse(resultToString(result));

		expect(parsed.success).toBe(false);
		expect(parsed.error).toBe(
			'changedFiles must be a non-empty array of file paths',
		);
	});

	test('returns error when changedFiles is missing', async () => {
		const result = await mockExecute(
			{} as unknown as Record<string, unknown>,
			createMockCtx('/test/dir'),
		);
		const parsed = JSON.parse(resultToString(result));

		expect(parsed.success).toBe(false);
		expect(parsed.error).toBe(
			'changedFiles must be a non-empty array of file paths',
		);
	});

	test('returns impacted tests for valid changed files', async () => {
		const mockResult = {
			impactedTests: ['test/a.test.ts', 'test/b.test.ts'],
			unrelatedTests: ['test/c.test.ts'],
			untestedFiles: ['src/novo.test.ts'],
			impactMap: {
				'src/file1.ts': ['test/a.test.ts'],
				'src/file2.ts': ['test/b.test.ts'],
			},
		};
		mockAnalyzeImpact.mockResolvedValue(mockResult);

		const result = await mockExecute(
			{ changedFiles: ['src/file1.ts', 'src/file2.ts'] },
			createMockCtx('/test/dir'),
		);
		const parsed = JSON.parse(resultToString(result));

		expect(parsed.impactedTests).toEqual(['test/a.test.ts', 'test/b.test.ts']);
		expect(parsed.unrelatedTests).toEqual(['test/c.test.ts']);
		expect(parsed.untestedFiles).toEqual(['src/novo.test.ts']);
		expect(mockAnalyzeImpact).toHaveBeenCalledWith(
			['src/file1.ts', 'src/file2.ts'],
			'/test/dir',
		);
	});

	test('uses working_directory when provided', async () => {
		mockAnalyzeImpact.mockResolvedValue({
			impactedTests: [],
			unrelatedTests: [],
			untestedFiles: [],
			impactMap: {},
		});

		await mockExecute(
			{ changedFiles: ['src/file.ts'], working_directory: '/custom/dir' },
			createMockCtx('/default/dir'),
		);

		expect(mockAnalyzeImpact).toHaveBeenCalledWith(
			['src/file.ts'],
			'/custom/dir',
		);
	});

	test('falls back to directory when working_directory not provided', async () => {
		mockAnalyzeImpact.mockResolvedValue({
			impactedTests: [],
			unrelatedTests: [],
			untestedFiles: [],
			impactMap: {},
		});

		await mockExecute(
			{ changedFiles: ['src/file.ts'] },
			createMockCtx('/fallback/dir'),
		);

		expect(mockAnalyzeImpact).toHaveBeenCalledWith(
			['src/file.ts'],
			'/fallback/dir',
		);
	});

	test('handles analyzeImpact throwing an error', async () => {
		mockAnalyzeImpact.mockRejectedValue(new Error('Analyzer failed'));

		const result = await mockExecute(
			{ changedFiles: ['src/file.ts'] },
			createMockCtx('/test/dir'),
		);
		const parsed = JSON.parse(resultToString(result));

		expect(parsed.success).toBe(false);
		expect(parsed.error).toBe('test_impact failed: Analyzer failed');
	});

	test('handles analyzeImpact throwing non-Error object', async () => {
		mockAnalyzeImpact.mockRejectedValue('string error');

		const result = await mockExecute(
			{ changedFiles: ['src/file.ts'] },
			createMockCtx('/test/dir'),
		);
		const parsed = JSON.parse(resultToString(result));

		expect(parsed.success).toBe(false);
		expect(parsed.error).toBe('test_impact failed: unknown error');
	});

	test('returns valid JSON structure with all required fields', async () => {
		const mockResult = {
			impactedTests: ['test/file.test.ts'],
			unrelatedTests: [],
			untestedFiles: [],
			impactMap: { 'src/file.ts': ['test/file.test.ts'] },
		};
		mockAnalyzeImpact.mockResolvedValue(mockResult);

		const result = await mockExecute(
			{ changedFiles: ['src/file.ts'] },
			createMockCtx('/test/dir'),
		);
		const parsed = JSON.parse(resultToString(result));

		expect(parsed).toHaveProperty('impactedTests');
		expect(parsed).toHaveProperty('unrelatedTests');
		expect(parsed).toHaveProperty('untestedFiles');
		expect(parsed).toHaveProperty('impactMap');
		expect(Array.isArray(parsed.impactedTests)).toBe(true);
		expect(Array.isArray(parsed.unrelatedTests)).toBe(true);
		expect(Array.isArray(parsed.untestedFiles)).toBe(true);
		expect(typeof parsed.impactMap).toBe('object');
	});
});
