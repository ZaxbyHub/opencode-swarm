import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { CoChangeEntry } from '../../../src/tools/co-change-analyzer.js';

// Mock the co-change-analyzer module
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
const mockEnforceKnowledgeCap = mock(async () => {});

mock.module('../../../src/tools/co-change-analyzer.js', () => ({
	_internals: {
		detectDarkMatter: mockDetectDarkMatter,
	},
	detectDarkMatter: mockDetectDarkMatter,
	formatDarkMatterOutput: mockFormatDarkMatterOutput,
	darkMatterToKnowledgeEntries: mockDarkMatterToKnowledgeEntries,
	co_change_analyzer: mock(() => {}),
}));

mock.module('../../../src/hooks/knowledge-store.js', () => ({
	getPlatformConfigDir: mock(() => ''),
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
	enforceKnowledgeCap: mockEnforceKnowledgeCap,
	sweepStaleTodos: mock(async () => ({ swept: 0, remaining: 0 })),
	sweepAgedEntries: mock(async () => ({ swept: 0, remaining: 0 })),
	bumpKnowledgeConfidenceBatch: async () => {},
	transactKnowledge: async () => false,
	transactFile: async () => false,
	readRetractionRecords: async () => [],
	appendRetractionRecord: async () => {},
	resolveSwarmRetractionsPath: () =>
		'/test/dir/.swarm/knowledge-retractions.jsonl',
	normalizeEntry: (e: unknown) => e,
	computeOutcomeSignal: () => 0,
	OUTCOME_SIGNAL_SMOOTHING: 1,
	_internals: {},
}));

// Import AFTER mock setup
const { handleDarkMatterCommand } = await import(
	'../../../src/commands/dark-matter.js'
);
const {
	handleDarkMatterCommand: handleDarkMatterFromIndex,
	createSwarmCommandHandler,
} = await import('../../../src/commands/index.js');

describe('handleDarkMatterCommand', () => {
	beforeEach(() => {
		mockDetectDarkMatter.mockClear();
		mockFormatDarkMatterOutput.mockClear();
	});

	it('No args — uses defaults', async () => {
		const mockPairs: CoChangeEntry[] = [];
		const mockOutput =
			'## Dark Matter: Hidden Couplings\n\nNo hidden couplings...';
		mockDetectDarkMatter.mockImplementation(async () => mockPairs);
		mockFormatDarkMatterOutput.mockImplementation(() => mockOutput);

		const result = await handleDarkMatterCommand('/test/dir', []);

		expect(mockDetectDarkMatter).toHaveBeenCalledWith('/test/dir', {});
		expect(mockFormatDarkMatterOutput).toHaveBeenCalledWith(mockPairs);
		expect(result).toBe(mockOutput);
	});

	it('--threshold flag parsed correctly', async () => {
		const mockPairs: CoChangeEntry[] = [];
		const mockOutput = 'output';
		mockDetectDarkMatter.mockImplementation(async () => mockPairs);
		mockFormatDarkMatterOutput.mockImplementation(() => mockOutput);

		await handleDarkMatterCommand('/dir', ['--threshold', '0.7']);

		expect(mockDetectDarkMatter).toHaveBeenCalledWith('/dir', {
			npmiThreshold: 0.7,
		});
	});

	it('--min-commits flag parsed correctly', async () => {
		const mockPairs: CoChangeEntry[] = [];
		const mockOutput = 'output';
		mockDetectDarkMatter.mockImplementation(async () => mockPairs);
		mockFormatDarkMatterOutput.mockImplementation(() => mockOutput);

		await handleDarkMatterCommand('/dir', ['--min-commits', '50']);

		expect(mockDetectDarkMatter).toHaveBeenCalledWith('/dir', {
			minCommits: 50,
		});
	});

	it('Both flags together', async () => {
		const mockPairs: CoChangeEntry[] = [];
		const mockOutput = 'output';
		mockDetectDarkMatter.mockImplementation(async () => mockPairs);
		mockFormatDarkMatterOutput.mockImplementation(() => mockOutput);

		await handleDarkMatterCommand('/dir', [
			'--threshold',
			'0.6',
			'--min-commits',
			'30',
		]);

		expect(mockDetectDarkMatter).toHaveBeenCalledWith('/dir', {
			npmiThreshold: 0.6,
			minCommits: 30,
		});
	});

	it('Invalid threshold (out of range) → silently ignored', async () => {
		const mockPairs: CoChangeEntry[] = [];
		const mockOutput = 'output';
		mockDetectDarkMatter.mockImplementation(async () => mockPairs);
		mockFormatDarkMatterOutput.mockImplementation(() => mockOutput);

		await handleDarkMatterCommand('/dir', ['--threshold', '1.5']);

		expect(mockDetectDarkMatter).toHaveBeenCalledWith('/dir', {});
		expect('npmiThreshold' in mockDetectDarkMatter.mock.calls[0][1]).toBe(
			false,
		);
	});

	it('Invalid threshold (non-numeric) → silently ignored', async () => {
		const mockPairs: CoChangeEntry[] = [];
		const mockOutput = 'output';
		mockDetectDarkMatter.mockImplementation(async () => mockPairs);
		mockFormatDarkMatterOutput.mockImplementation(() => mockOutput);

		await handleDarkMatterCommand('/dir', ['--threshold', 'abc']);

		expect(mockDetectDarkMatter).toHaveBeenCalledWith('/dir', {});
		expect('npmiThreshold' in mockDetectDarkMatter.mock.calls[0][1]).toBe(
			false,
		);
	});

	it('--threshold at end of args (no value) → silently ignored', async () => {
		const mockPairs: CoChangeEntry[] = [];
		const mockOutput = 'output';
		mockDetectDarkMatter.mockImplementation(async () => mockPairs);
		mockFormatDarkMatterOutput.mockImplementation(() => mockOutput);

		await handleDarkMatterCommand('/dir', ['--threshold']);

		expect(mockDetectDarkMatter).toHaveBeenCalledWith('/dir', {});
		expect('npmiThreshold' in mockDetectDarkMatter.mock.calls[0][1]).toBe(
			false,
		);
	});

	it('Returns formatted output string', async () => {
		const mockPairs: CoChangeEntry[] = [];
		const mockOutput =
			'## Dark Matter: Hidden Couplings\n\nNo hidden couplings detected. Either the repository has fewer than 20 commits, or all frequently co-changing files have explicit import relationships.';
		mockDetectDarkMatter.mockImplementation(async () => mockPairs);
		mockFormatDarkMatterOutput.mockImplementation(() => mockOutput);

		const result = await handleDarkMatterCommand('/dir', []);

		expect(mockFormatDarkMatterOutput).toHaveBeenCalledWith(mockPairs);
		expect(result).toBe(mockOutput);
	});
});

describe('commands/index.ts integration', () => {
	beforeEach(() => {
		mockDetectDarkMatter.mockClear();
		mockFormatDarkMatterOutput.mockClear();
	});

	it('exports handleDarkMatterCommand as a function', () => {
		expect(typeof handleDarkMatterFromIndex).toBe('function');
	});

	it('HELP_TEXT contains dark-matter', async () => {
		const mockPairs: CoChangeEntry[] = [];
		const mockOutput =
			'## Dark Matter: Hidden Couplings\n\nNo hidden couplings...';
		mockDetectDarkMatter.mockImplementation(async () => mockPairs);
		mockFormatDarkMatterOutput.mockImplementation(() => mockOutput);

		const handler = createSwarmCommandHandler('/dir', {});
		const output = { parts: [] };
		await handler({ command: 'swarm', sessionID: 's1', arguments: '' }, output);

		const text = (output.parts[0] as { text: string }).text;
		expect(text).toContain('dark-matter');
	});
});
