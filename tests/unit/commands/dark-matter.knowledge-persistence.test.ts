import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { CoChangeEntry } from '../../../src/tools/co-change-analyzer.js';

// Mock the co-change-analyzer module with all needed exports
const mockDetectDarkMatter = mock(async () => []);
const mockFormatDarkMatterOutput = mock(() => '');
const mockDarkMatterToKnowledgeEntries = mock(() => []);

// Mock the knowledge-store module with all common exports
const mockAppendKnowledge = mock(async () => {});
const mockResolveSwarmKnowledgePath = mock(
	() => '/test/dir/.swarm/knowledge.jsonl',
);
const mockReadKnowledge = mock(async () => []);
const mockReadRejectedLessons = mock(async () => []);
const mockRewriteKnowledge = mock(async () => {});
const mockAppendRejectedLesson = mock(async () => {});
const mockNormalize = mock((text: string) => text);
const mockWordBigrams = mock(() => new Set());
const mockJaccardBigram = mock(() => 0);
const mockFindNearDuplicate = mock(() => undefined);
const mockComputeConfidence = mock(() => 0.5);
const mockInferTags = mock(() => []);

mock.module('../../../src/tools/co-change-analyzer.js', () => ({
	detectDarkMatter: mockDetectDarkMatter,
	formatDarkMatterOutput: mockFormatDarkMatterOutput,
	darkMatterToKnowledgeEntries: mockDarkMatterToKnowledgeEntries,
	// The dark-matter command invokes `detectDarkMatter` through the
	// `_internals` DI seam (`coChangeAnalyzer.detectDarkMatter`), so the mock
	// must expose it there too. `formatDarkMatterOutput` and
	// `darkMatterToKnowledgeEntries` are consumed via the top-level named
	// exports above, but are mirrored here for completeness of the seam.
	_internals: {
		detectDarkMatter: mockDetectDarkMatter,
		formatDarkMatterOutput: mockFormatDarkMatterOutput,
		darkMatterToKnowledgeEntries: mockDarkMatterToKnowledgeEntries,
	},
}));

mock.module('../../../src/hooks/knowledge-store.js', () => ({
	resolveSwarmKnowledgePath: mockResolveSwarmKnowledgePath,
	resolveSwarmRejectedPath: mock(
		() => '/test/dir/.swarm/knowledge-rejected.jsonl',
	),
	resolveHiveKnowledgePath: mock(() => '/hive/shared-learnings.jsonl'),
	resolveHiveRejectedPath: mock(() => '/hive/shared-learnings-rejected.jsonl'),
	readKnowledge: mockReadKnowledge,
	readRejectedLessons: mockReadRejectedLessons,
	appendKnowledge: mockAppendKnowledge,
	rewriteKnowledge: mockRewriteKnowledge,
	appendRejectedLesson: mockAppendRejectedLesson,
	normalize: mockNormalize,
	wordBigrams: mockWordBigrams,
	jaccardBigram: mockJaccardBigram,
	findNearDuplicate: mockFindNearDuplicate,
	computeConfidence: mockComputeConfidence,
	inferTags: mockInferTags,
	enforceKnowledgeCap: async () => {},
	sweepAgedEntries: async () => {},
	sweepStaleTodos: async () => {},
	bumpKnowledgeConfidenceBatch: async () => {},
}));

// Import AFTER mock setup
const { handleDarkMatterCommand } = await import(
	'../../../src/commands/dark-matter.js'
);

afterEach(() => {
	mock.restore();
});

describe('Knowledge persistence wiring verification tests', () => {
	beforeEach(() => {
		mockDetectDarkMatter.mockClear();
		mockFormatDarkMatterOutput.mockClear();
		mockDarkMatterToKnowledgeEntries.mockClear();
		mockAppendKnowledge.mockClear();
		mockResolveSwarmKnowledgePath.mockClear();
	});

	it('When 2 pairs and 2 entries → appendKnowledge called twice with correct path; output contains "[2 saved]"', async () => {
		const mockPairs: CoChangeEntry[] = [
			{
				fileA: 'src/a.ts',
				fileB: 'src/b.ts',
				coChangeCount: 30,
				npmi: 0.8,
				lift: 2.5,
				hasStaticEdge: false,
				totalCommits: 100,
				commitsA: 50,
				commitsB: 60,
			},
			{
				fileA: 'src/c.ts',
				fileB: 'src/d.ts',
				coChangeCount: 25,
				npmi: 0.7,
				lift: 2.0,
				hasStaticEdge: false,
				totalCommits: 100,
				commitsA: 45,
				commitsB: 55,
			},
		];
		const mockOutput =
			'## Dark Matter: Hidden Couplings\n\n2 hidden couplings found.';
		const mockEntries = [
			{ id: 'entry1', category: 'architecture', tags: ['dark-matter'] },
			{ id: 'entry2', category: 'architecture', tags: ['dark-matter'] },
		] as unknown[];

		mockDetectDarkMatter.mockImplementation(async () => mockPairs);
		mockFormatDarkMatterOutput.mockImplementation(() => mockOutput);
		mockDarkMatterToKnowledgeEntries.mockReturnValue(mockEntries);

		const result = await handleDarkMatterCommand('/test/dir', []);

		expect(mockDarkMatterToKnowledgeEntries).toHaveBeenCalledWith(
			mockPairs,
			'dir',
		);
		expect(mockResolveSwarmKnowledgePath).toHaveBeenCalledWith('/test/dir');
		expect(mockAppendKnowledge).toHaveBeenCalledTimes(2);
		expect(mockAppendKnowledge).toHaveBeenCalledWith(
			'/test/dir/.swarm/knowledge.jsonl',
			mockEntries[0],
		);
		expect(mockAppendKnowledge).toHaveBeenCalledWith(
			'/test/dir/.swarm/knowledge.jsonl',
			mockEntries[1],
		);
		expect(result).toContain(
			'[2 dark matter finding(s) saved to .swarm/knowledge.jsonl]',
		);
	});

	it('When 0 pairs → appendKnowledge NOT called; returns plain output only', async () => {
		const mockPairs: CoChangeEntry[] = [];
		const mockOutput =
			'## Dark Matter: Hidden Couplings\n\nNo hidden couplings found.';

		mockDetectDarkMatter.mockImplementation(async () => mockPairs);
		mockFormatDarkMatterOutput.mockImplementation(() => mockOutput);

		const result = await handleDarkMatterCommand('/test/dir', []);

		expect(mockResolveSwarmKnowledgePath).not.toHaveBeenCalled();
		expect(mockDarkMatterToKnowledgeEntries).not.toHaveBeenCalled();
		expect(mockAppendKnowledge).not.toHaveBeenCalled();
		expect(result).toBe(mockOutput);
	});

	it('When entries empty despite non-empty pairs → appendKnowledge NOT called; returns plain output (no "[0 saved]" message)', async () => {
		const mockPairs: CoChangeEntry[] = [
			{
				fileA: 'src/a.ts',
				fileB: 'src/b.ts',
				coChangeCount: 30,
				npmi: 0.8,
				lift: 2.5,
				hasStaticEdge: false,
				totalCommits: 100,
				commitsA: 50,
				commitsB: 60,
			},
		];
		const mockOutput =
			'## Dark Matter: Hidden Couplings\n\n1 hidden coupling found.';

		mockDetectDarkMatter.mockImplementation(async () => mockPairs);
		mockFormatDarkMatterOutput.mockImplementation(() => mockOutput);
		mockDarkMatterToKnowledgeEntries.mockReturnValue([]);

		const result = await handleDarkMatterCommand('/test/dir', []);

		expect(mockResolveSwarmKnowledgePath).not.toHaveBeenCalled();
		expect(mockAppendKnowledge).not.toHaveBeenCalled();
		expect(result).toBe(mockOutput);
		expect(result).not.toContain('[0 dark matter finding(s) saved]');
	});

	it('directory="." → projectName is resolved from path.resolve, never "."', async () => {
		const mockPairs: CoChangeEntry[] = [
			{
				fileA: 'src/a.ts',
				fileB: 'src/b.ts',
				coChangeCount: 30,
				npmi: 0.8,
				lift: 2.5,
				hasStaticEdge: false,
				totalCommits: 100,
				commitsA: 50,
				commitsB: 60,
			},
		];
		const mockOutput =
			'## Dark Matter: Hidden Couplings\n\n1 hidden coupling found.';
		const mockEntries = [{ id: 'entry1' }] as unknown[];

		mockDetectDarkMatter.mockImplementation(async () => mockPairs);
		mockFormatDarkMatterOutput.mockImplementation(() => mockOutput);
		mockDarkMatterToKnowledgeEntries.mockImplementation(
			(pairs, projectName) => {
				// projectName should be the actual directory name, not "."
				expect(projectName).not.toBe('.');
				expect(typeof projectName).toBe('string');
				return mockEntries;
			},
		);

		await handleDarkMatterCommand('.', []);

		expect(mockDarkMatterToKnowledgeEntries).toHaveBeenCalled();
	});

	it('resolveSwarmKnowledgePath(directory) is called with the original directory (not the resolved path)', async () => {
		const mockPairs: CoChangeEntry[] = [
			{
				fileA: 'src/a.ts',
				fileB: 'src/b.ts',
				coChangeCount: 30,
				npmi: 0.8,
				lift: 2.5,
				hasStaticEdge: false,
				totalCommits: 100,
				commitsA: 50,
				commitsB: 60,
			},
		];
		const mockOutput =
			'## Dark Matter: Hidden Couplings\n\n1 hidden coupling found.';
		const mockEntries = [{ id: 'entry1' }] as unknown[];

		mockDetectDarkMatter.mockImplementation(async () => mockPairs);
		mockFormatDarkMatterOutput.mockImplementation(() => mockOutput);
		mockDarkMatterToKnowledgeEntries.mockReturnValue(mockEntries);

		const directory = '/test/dir';
		await handleDarkMatterCommand(directory, []);

		expect(mockResolveSwarmKnowledgePath).toHaveBeenCalledWith(directory);
		// Should NOT be called with path.resolve(directory) or absolute path
		expect(mockResolveSwarmKnowledgePath).not.toHaveBeenCalledWith(
			expect.stringContaining('C:\\'),
		);
	});
});
