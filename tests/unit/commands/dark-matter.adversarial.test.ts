import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleDarkMatterCommand } from '../../../src/commands/dark-matter.js';
import type {
	CoChangeEntry,
	DarkMatterOptions,
} from '../../../src/tools/co-change-analyzer.js';

const mockDetectDarkMatter = vi.fn();
const mockFormatDarkMatterOutput = vi.fn();
const mockDarkMatterToKnowledgeEntries = vi.fn();
const mockAppendKnowledge = vi.fn();
const mockResolveSwarmKnowledgePath = vi.fn();
const mockConsoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

vi.mock('../../../src/tools/co-change-analyzer.js', () => ({
	detectDarkMatter: mockDetectDarkMatter,
	formatDarkMatterOutput: mockFormatDarkMatterOutput,
	darkMatterToKnowledgeEntries: mockDarkMatterToKnowledgeEntries,
	// The command invokes detectDarkMatter through the `_internals` DI seam
	// (`coChangeAnalyzer.detectDarkMatter`), so the mock must expose it there too.
	_internals: {
		detectDarkMatter: mockDetectDarkMatter,
		formatDarkMatterOutput: mockFormatDarkMatterOutput,
		darkMatterToKnowledgeEntries: mockDarkMatterToKnowledgeEntries,
	},
}));

vi.mock('../../../src/hooks/knowledge-store.js', () => ({
	resolveSwarmKnowledgePath: mockResolveSwarmKnowledgePath,
	resolveSwarmRejectedPath: vi.fn(
		() => '/test/dir/.swarm/knowledge-rejected.jsonl',
	),
	resolveHiveKnowledgePath: vi.fn(() => '/hive/shared-learnings.jsonl'),
	resolveHiveRejectedPath: vi.fn(() => '/hive/shared-learnings-rejected.jsonl'),
	readKnowledge: vi.fn(async () => []),
	readRejectedLessons: vi.fn(async () => []),
	appendKnowledge: mockAppendKnowledge,
	rewriteKnowledge: vi.fn(async () => {}),
	appendRejectedLesson: vi.fn(async () => {}),
	normalize: vi.fn((text: string) => text),
	wordBigrams: vi.fn(() => new Set()),
	jaccardBigram: vi.fn(() => 0),
	findNearDuplicate: vi.fn(() => undefined),
	computeConfidence: vi.fn(() => 0.5),
	inferTags: vi.fn(() => []),
	enforceKnowledgeCap: async () => {},
	sweepAgedEntries: async () => {},
	sweepStaleTodos: async () => {},
	bumpKnowledgeConfidenceBatch: async () => {},
}));

describe('handleDarkMatterCommand (adversarial)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockDetectDarkMatter.mockResolvedValue([]);
		mockFormatDarkMatterOutput.mockReturnValue(
			'## Dark Matter: Hidden Couplings\n\nNo hidden couplings detected.',
		);
	});

	describe('1. Empty string args', () => {
		it('should not crash with empty string arg', async () => {
			await expect(
				handleDarkMatterCommand('/dir', ['']),
			).resolves.toBeDefined();

			// verify detectDarkMatter called with empty options
			expect(mockDetectDarkMatter).toHaveBeenCalledWith('/dir', {});
		});
	});

	describe('2. Large arg array', () => {
		it('should not hang or crash with 1000 args', async () => {
			const largeArgs = new Array(1000).fill('--threshold');
			await expect(
				handleDarkMatterCommand('/dir', largeArgs),
			).resolves.toBeDefined();
		});
	});

	describe('3. Injection in directory', () => {
		it('should forward malicious directory as-is without execution', async () => {
			const maliciousDir = '/dir; rm -rf /';

			await expect(
				handleDarkMatterCommand(maliciousDir, []),
			).resolves.toBeDefined();

			// directory passed directly to detectDarkMatter, no sanitization
			expect(mockDetectDarkMatter).toHaveBeenCalledWith(maliciousDir, {});
		});
	});

	describe('4. Injection in threshold', () => {
		it('should parse injection attempt as valid number', async () => {
			const maliciousThreshold = '0.5; rm -rf /';

			await expect(
				handleDarkMatterCommand('/dir', ['--threshold', maliciousThreshold]),
			).resolves.toBeDefined();

			// parseFloat('0.5; rm -rf /') = 0.5
			expect(mockDetectDarkMatter).toHaveBeenCalledWith('/dir', {
				npmiThreshold: 0.5,
			});
		});
	});

	describe('5. NaN threshold', () => {
		it('should ignore NaN threshold silently', async () => {
			await expect(
				handleDarkMatterCommand('/dir', ['--threshold', 'NaN']),
			).resolves.toBeDefined();

			// NaN check in condition prevents setting
			expect(mockDetectDarkMatter).toHaveBeenCalledWith('/dir', {});
		});
	});

	describe('6. Negative threshold', () => {
		it('should ignore negative threshold', async () => {
			await expect(
				handleDarkMatterCommand('/dir', ['--threshold', '-0.1']),
			).resolves.toBeDefined();

			// Range check val >= 0 fails
			expect(mockDetectDarkMatter).toHaveBeenCalledWith('/dir', {});
		});
	});

	describe('7. Zero threshold', () => {
		it('should accept zero threshold', async () => {
			await expect(
				handleDarkMatterCommand('/dir', ['--threshold', '0']),
			).resolves.toBeDefined();

			// 0 is valid (>=0 && <=1)
			expect(mockDetectDarkMatter).toHaveBeenCalledWith('/dir', {
				npmiThreshold: 0,
			});
		});
	});

	describe('8. Threshold exactly 1.0', () => {
		it('should accept threshold of 1.0', async () => {
			await expect(
				handleDarkMatterCommand('/dir', ['--threshold', '1']),
			).resolves.toBeDefined();

			expect(mockDetectDarkMatter).toHaveBeenCalledWith('/dir', {
				npmiThreshold: 1,
			});
		});
	});

	describe('9. Negative min-commits', () => {
		it('should ignore negative min-commits', async () => {
			await expect(
				handleDarkMatterCommand('/dir', ['--min-commits', '-5']),
			).resolves.toBeDefined();

			// val > 0 check fails
			expect(mockDetectDarkMatter).toHaveBeenCalledWith('/dir', {});
		});
	});

	describe('10. Zero min-commits', () => {
		it('should ignore zero min-commits', async () => {
			await expect(
				handleDarkMatterCommand('/dir', ['--min-commits', '0']),
			).resolves.toBeDefined();

			// val > 0 check fails
			expect(mockDetectDarkMatter).toHaveBeenCalledWith('/dir', {});
		});
	});

	describe('11. Very large min-commits', () => {
		it('should accept and forward large min-commits', async () => {
			await expect(
				handleDarkMatterCommand('/dir', ['--min-commits', '999999']),
			).resolves.toBeDefined();

			expect(mockDetectDarkMatter).toHaveBeenCalledWith('/dir', {
				minCommits: 999999,
			});
		});
	});

	describe('12. detectDarkMatter throws', () => {
		it('surfaces the error gracefully instead of crashing the command', async () => {
			mockDetectDarkMatter.mockRejectedValue(new Error('git not found'));

			// The command catches analysis failures and returns a formatted failure
			// message (defensive degradation) rather than propagating the throw — the
			// error text must still reach the user, not be silently swallowed.
			const result = await handleDarkMatterCommand('/dir', []);
			expect(result).toContain('Dark Matter Analysis Failed');
			expect(result).toContain('git not found');
		});
	});

	describe('13. Unicode in directory', () => {
		it('should forward unicode directory path correctly', async () => {
			const unicodeDir = '/日本語/ディレクトリ';

			await expect(
				handleDarkMatterCommand(unicodeDir, []),
			).resolves.toBeDefined();

			expect(mockDetectDarkMatter).toHaveBeenCalledWith(unicodeDir, {});
		});
	});

	describe('14. Very long directory path', () => {
		it('should forward long directory path without truncation', async () => {
			const longDir = '/'.repeat(1000) + 'directory';

			await expect(handleDarkMatterCommand(longDir, [])).resolves.toBeDefined();

			expect(mockDetectDarkMatter).toHaveBeenCalledWith(longDir, {});
		});
	});

	// Additional edge cases
	describe('Additional edge cases', () => {
		it('should handle threshold > 1.0', async () => {
			await expect(
				handleDarkMatterCommand('/dir', ['--threshold', '1.5']),
			).resolves.toBeDefined();

			// Range check val <= 1 fails
			expect(mockDetectDarkMatter).toHaveBeenCalledWith('/dir', {});
		});

		it('should handle flag without value (missing)', async () => {
			await expect(
				handleDarkMatterCommand('/dir', ['--threshold']),
			).resolves.toBeDefined();

			// args[i + 1] check fails
			expect(mockDetectDarkMatter).toHaveBeenCalledWith('/dir', {});
		});

		it('should handle non-numeric threshold', async () => {
			await expect(
				handleDarkMatterCommand('/dir', ['--threshold', 'abc']),
			).resolves.toBeDefined();

			// parseFloat('abc') = NaN
			expect(mockDetectDarkMatter).toHaveBeenCalledWith('/dir', {});
		});

		it('should handle non-numeric min-commits', async () => {
			await expect(
				handleDarkMatterCommand('/dir', ['--min-commits', 'xyz']),
			).resolves.toBeDefined();

			// parseInt('xyz', 10) = NaN
			expect(mockDetectDarkMatter).toHaveBeenCalledWith('/dir', {});
		});

		it('should handle multiple valid flags', async () => {
			await expect(
				handleDarkMatterCommand('/dir', [
					'--threshold',
					'0.7',
					'--min-commits',
					'10',
				]),
			).resolves.toBeDefined();

			expect(mockDetectDarkMatter).toHaveBeenCalledWith('/dir', {
				npmiThreshold: 0.7,
				minCommits: 10,
			});
		});

		it('should handle decimal threshold at boundary', async () => {
			await expect(
				handleDarkMatterCommand('/dir', ['--threshold', '0.000001']),
			).resolves.toBeDefined();

			expect(mockDetectDarkMatter).toHaveBeenCalledWith('/dir', {
				npmiThreshold: 0.000001,
			});
		});

		it('should handle Infinity threshold', async () => {
			await expect(
				handleDarkMatterCommand('/dir', ['--threshold', 'Infinity']),
			).resolves.toBeDefined();

			// Infinity > 1, range check fails
			expect(mockDetectDarkMatter).toHaveBeenCalledWith('/dir', {});
		});

		it('should handle -Infinity threshold', async () => {
			await expect(
				handleDarkMatterCommand('/dir', ['--threshold', '-Infinity']),
			).resolves.toBeDefined();

			// -Infinity < 0, range check fails
			expect(mockDetectDarkMatter).toHaveBeenCalledWith('/dir', {});
		});

		it('should handle formatDarkMatterOutput returning empty string', async () => {
			mockFormatDarkMatterOutput.mockReturnValue('');

			const result = await handleDarkMatterCommand('/dir', []);
			expect(result).toBe('');
		});

		it('should handle formatDarkMatterOutput throwing', async () => {
			mockFormatDarkMatterOutput.mockImplementation(() => {
				throw new Error('Format error');
			});

			await expect(handleDarkMatterCommand('/dir', [])).rejects.toThrow(
				'Format error',
			);
		});
	});
});

describe('Knowledge persistence adversarial tests', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockDetectDarkMatter.mockResolvedValue([]);
		mockFormatDarkMatterOutput.mockReturnValue(
			'## Dark Matter: Hidden Couplings\n\nNo hidden couplings detected.',
		);
		mockDarkMatterToKnowledgeEntries.mockReturnValue([]);
		mockAppendKnowledge.mockResolvedValue(undefined);
		mockResolveSwarmKnowledgePath.mockReturnValue(
			'/dir/.swarm/knowledge.jsonl',
		);
		mockConsoleWarn.mockClear();
	});

	describe('1. appendKnowledge throws', () => {
		it('should call console.warn and return plain output (not the "[N saved]" string)', async () => {
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

			mockDetectDarkMatter.mockResolvedValue(mockPairs);
			mockFormatDarkMatterOutput.mockReturnValue(mockOutput);
			mockDarkMatterToKnowledgeEntries.mockReturnValue(mockEntries);
			mockAppendKnowledge.mockRejectedValue(
				new Error('Write failed: permission denied'),
			);

			const result = await handleDarkMatterCommand('/dir', []);

			expect(mockConsoleWarn).toHaveBeenCalledWith(
				'dark-matter: failed to save knowledge entries:',
				expect.any(Error),
			);
			expect(result).toBe(mockOutput);
			expect(result).not.toContain('[1 dark matter finding(s) saved]');
		});
	});

	describe('2. darkMatterToKnowledgeEntries throws', () => {
		it('should be caught by try-catch and return plain output', async () => {
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

			mockDetectDarkMatter.mockResolvedValue(mockPairs);
			mockFormatDarkMatterOutput.mockReturnValue(mockOutput);
			mockDarkMatterToKnowledgeEntries.mockImplementation(() => {
				throw new Error('Failed to create knowledge entries');
			});

			const result = await handleDarkMatterCommand('/dir', []);

			expect(mockConsoleWarn).toHaveBeenCalledWith(
				'dark-matter: failed to save knowledge entries:',
				expect.any(Error),
			);
			expect(result).toBe(mockOutput);
			expect(result).not.toContain('[1 dark matter finding(s) saved]');
		});
	});

	describe('3. directory path traversal attack ("../../evil")', () => {
		it('should resolve the path and pass resolved knowledge path to appendKnowledge without crashing', async () => {
			const maliciousDir = '../../evil';
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
			const resolvedKnowledgePath = 'C:\\evil\\.swarm\\knowledge.jsonl';

			mockDetectDarkMatter.mockResolvedValue(mockPairs);
			mockFormatDarkMatterOutput.mockReturnValue(mockOutput);
			mockDarkMatterToKnowledgeEntries.mockReturnValue(mockEntries);
			mockResolveSwarmKnowledgePath.mockReturnValue(resolvedKnowledgePath);

			const result = await handleDarkMatterCommand(maliciousDir, []);

			// Should not crash
			expect(result).toBeDefined();
			// resolveSwarmKnowledgePath is called with the original malicious directory
			expect(mockResolveSwarmKnowledgePath).toHaveBeenCalledWith(maliciousDir);
			// appendKnowledge receives the resolved knowledge path
			expect(mockAppendKnowledge).toHaveBeenCalledWith(
				resolvedKnowledgePath,
				mockEntries[0],
			);
		});
	});

	describe('4. appendKnowledge succeeds on first entry, throws on second', () => {
		it('should warn and return output; partial writes accepted', async () => {
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

			mockDetectDarkMatter.mockResolvedValue(mockPairs);
			mockFormatDarkMatterOutput.mockReturnValue(mockOutput);
			mockDarkMatterToKnowledgeEntries.mockReturnValue(mockEntries);

			let callCount = 0;
			mockAppendKnowledge.mockImplementation(() => {
				callCount++;
				if (callCount === 2) {
					return Promise.reject(new Error('Disk full'));
				}
				return Promise.resolve();
			});

			const result = await handleDarkMatterCommand('/dir', []);

			// First append succeeded, second failed
			expect(mockAppendKnowledge).toHaveBeenCalledTimes(2);
			expect(mockConsoleWarn).toHaveBeenCalledWith(
				'dark-matter: failed to save knowledge entries:',
				expect.any(Error),
			);
			// Returns plain output, not "[2 saved]" message
			expect(result).toBe(mockOutput);
			expect(result).not.toContain('[2 dark matter finding(s) saved]');
		});
	});

	describe('5. Multiple failure scenarios', () => {
		it('should handle null entries returned from darkMatterToKnowledgeEntries', async () => {
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

			mockDetectDarkMatter.mockResolvedValue(mockPairs);
			mockFormatDarkMatterOutput.mockReturnValue(mockOutput);
			mockDarkMatterToKnowledgeEntries.mockReturnValue(null as unknown);

			const result = await handleDarkMatterCommand('/dir', []);

			// TypeError from entries.length is caught by try-catch, returns plain output
			expect(mockConsoleWarn).toHaveBeenCalledWith(
				'dark-matter: failed to save knowledge entries:',
				expect.any(Error),
			);
			expect(result).toBe(mockOutput);
			expect(result).not.toContain('[1 dark matter finding(s) saved]');
		});

		it('should handle undefined entries returned from darkMatterToKnowledgeEntries', async () => {
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

			mockDetectDarkMatter.mockResolvedValue(mockPairs);
			mockFormatDarkMatterOutput.mockReturnValue(mockOutput);
			mockDarkMatterToKnowledgeEntries.mockReturnValue(undefined);

			const result = await handleDarkMatterCommand('/dir', []);

			// TypeError from entries.length is caught by try-catch, returns plain output
			expect(mockConsoleWarn).toHaveBeenCalledWith(
				'dark-matter: failed to save knowledge entries:',
				expect.any(Error),
			);
			expect(result).toBe(mockOutput);
			expect(result).not.toContain('[1 dark matter finding(s) saved]');
		});

		it('should handle very large number of entries', async () => {
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
			const mockEntries = Array(1000)
				.fill(null)
				.map((_, i) => ({
					id: `entry${i}`,
					category: 'architecture',
				})) as unknown[];

			mockDetectDarkMatter.mockResolvedValue(mockPairs);
			mockFormatDarkMatterOutput.mockReturnValue(mockOutput);
			mockDarkMatterToKnowledgeEntries.mockReturnValue(mockEntries);

			const result = await handleDarkMatterCommand('/dir', []);

			expect(mockAppendKnowledge).toHaveBeenCalledTimes(1000);
			expect(result).toContain(
				'[1000 dark matter finding(s) saved to .swarm/knowledge.jsonl]',
			);
		});
	});
});
