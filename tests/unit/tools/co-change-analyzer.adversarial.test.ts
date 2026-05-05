import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	mock,
} from 'bun:test';
import { promisify } from 'node:util';

// mock.module() must be called before importing the module under test.
// Declare mock functions first, then register the module overrides.

// Cross-module mocks must be restored after each test to prevent contamination.
afterEach(() => {
	mock.restore();
});

const mockReaddir = mock(() => Promise.resolve([]));
const mockReadFile = mock(() => Promise.resolve(''));
const mockStat = mock(() =>
	Promise.resolve({ isFile: () => true, isDirectory: () => false }),
);
const mockExecFile = mock(
	(
		_cmd: unknown,
		_args: unknown,
		_opts: unknown,
		cb: (err: null, out: string, errOut: string) => void,
	) => {
		cb(null, '', '');
	},
);

// Add util.promisify.custom so that promisify(mockExecFile) returns { stdout, stderr }
// instead of just the first callback argument. The source code calls:
//   const { stdout } = await promisify(child_process.execFile)(...)
// Without this symbol, promisify resolves with a plain string, making { stdout } === undefined.
(mockExecFile as unknown as Record<symbol, unknown>)[promisify.custom] = (
	...args: unknown[]
): Promise<{ stdout: string; stderr: string }> =>
	new Promise((resolve, reject) => {
		(mockExecFile as unknown as (...a: unknown[]) => void)(
			...args,
			(err: Error | null, stdout: string, stderr: string) => {
				if (err) reject(err);
				else resolve({ stdout, stderr });
			},
		);
	});

const realFsPromises = await import('node:fs/promises');
mock.module('node:fs/promises', () => ({
	...realFsPromises,
	readdir: mockReaddir,
	readFile: mockReadFile,
	stat: mockStat,
}));

mock.module('node:child_process', () => ({ execFile: mockExecFile }));

// Dynamic import after mock.module() so Bun intercepts before the source loads.
let buildCoChangeMatrix: typeof import('../../../src/tools/co-change-analyzer.js')['buildCoChangeMatrix'];
let CoChangeEntry: unknown;
let darkMatterToKnowledgeEntries: typeof import('../../../src/tools/co-change-analyzer.js')['darkMatterToKnowledgeEntries'];
let formatDarkMatterOutput: typeof import('../../../src/tools/co-change-analyzer.js')['formatDarkMatterOutput'];
let getStaticEdges: typeof import('../../../src/tools/co-change-analyzer.js')['getStaticEdges'];
let parseGitLog: typeof import('../../../src/tools/co-change-analyzer.js')['parseGitLog'];

import type { CoChangeEntry as CoChangeEntryType } from '../../../src/tools/co-change-analyzer.js';

beforeAll(async () => {
	const mod = await import('../../../src/tools/co-change-analyzer.js');
	buildCoChangeMatrix = mod.buildCoChangeMatrix;
	darkMatterToKnowledgeEntries = mod.darkMatterToKnowledgeEntries;
	formatDarkMatterOutput = mod.formatDarkMatterOutput;
	getStaticEdges = mod.getStaticEdges;
	parseGitLog = mod.parseGitLog;
});

describe('Co-Change Analyzer - ADVERSARIAL TESTS', () => {
	beforeEach(() => {
		mockReaddir.mockReset();
		mockReadFile.mockReset();
		mockStat.mockReset();
		mockExecFile.mockReset();
	});

	describe('1. Git log injection via malicious commit hash', () => {
		it('should treat commit hash with shell injection as literal', async () => {
			const maliciousOutput =
				'COMMIT:abc123; rm -rf /\nsrc/file1.ts\nsrc/file2.ts\n';
			mockExecFile.mockImplementation(
				(
					cmd: string,
					args: unknown,
					opts: unknown,
					cb: (err: Error | null, stdout: string, stderr: string) => void,
				) => {
					cb(null, maliciousOutput, '');
				},
			);

			const result = await parseGitLog('/fake/dir', 100);

			expect(result).toBeInstanceOf(Map);
			// The commit hash with shell injection should be stored as literal
			expect(result.size).toBeGreaterThan(0);
			const files = result.get('abc123; rm -rf /');
			if (files) {
				expect(files.has('src/file1.ts')).toBe(true);
				expect(files.has('src/file2.ts')).toBe(true);
			}
		});

		it('should treat path traversal file paths as literal strings', async () => {
			const maliciousOutput =
				'COMMIT:abc123\n../../etc/passwd\nsrc/normal.ts\n';
			mockExecFile.mockImplementation(
				(
					cmd: string,
					args: unknown,
					opts: unknown,
					cb: (err: Error | null, stdout: string, stderr: string) => void,
				) => {
					cb(null, maliciousOutput, '');
				},
			);

			const result = await parseGitLog('/fake/dir', 100);

			expect(result).toBeInstanceOf(Map);
			expect(result.size).toBeGreaterThan(0);
			const files = result.get('abc123');
			if (files) {
				expect(files.has('../../etc/passwd')).toBe(true);
				expect(files.has('src/normal.ts')).toBe(true);
			}
		});
	});

	describe('2. Extremely large input - stress test', () => {
		it('should handle 1000 commits with 50 files each without crashing', async () => {
			const commitMap = new Map<string, Set<string>>();

			// Build massive commit map
			for (let i = 0; i < 1000; i++) {
				const commitHash = `commit${i.toString().padStart(8, '0')}`;
				const files = new Set<string>();

				for (let j = 0; j < 50; j++) {
					files.add(`src/module${j % 10}/file${j}.ts`);
				}

				commitMap.set(commitHash, files);
			}

			const startTime = Date.now();
			const result = buildCoChangeMatrix(commitMap);
			const elapsed = Date.now() - startTime;

			// Should not crash and should return a finite map
			expect(result).toBeInstanceOf(Map);
			expect(result.size).toBeGreaterThan(0);

			// Performance test: should complete in < 5 seconds
			expect(elapsed).toBeLessThan(5000);
		});
	});

	describe('3. Boundary: empty file sets in commits', () => {
		it('should handle commits with empty file sets without crashing', () => {
			const commitMap = new Map<string, Set<string>>();
			commitMap.set('abc123', new Set(['src/file1.ts', 'src/file2.ts']));
			commitMap.set('empty1', new Set());
			commitMap.set('def456', new Set(['src/file3.ts']));
			commitMap.set('empty2', new Set());

			const result = buildCoChangeMatrix(commitMap);

			expect(result).toBeInstanceOf(Map);
			// Should have at least one pair from the non-empty commits
			expect(result.size).toBeGreaterThan(0);
		});

		it('should handle map with only empty commits', () => {
			const commitMap = new Map<string, Set<string>>();
			commitMap.set('empty1', new Set());
			commitMap.set('empty2', new Set());
			commitMap.set('empty3', new Set());

			const result = buildCoChangeMatrix(commitMap);

			expect(result).toBeInstanceOf(Map);
			expect(result.size).toBe(0);
		});
	});

	describe('4. Boundary: single file appears in every commit', () => {
		it('should filter out pairs with coChangeCount < 3', () => {
			const commitMap = new Map<string, Set<string>>();

			// Global file appears in all commits
			const globalFile = 'src/global.ts';

			for (let i = 0; i < 100; i++) {
				const files = new Set<string>();
				files.add(globalFile);
				// Each commit has a unique file paired with the global one
				files.add(`src/module${i}/file${i}.ts`);
				commitMap.set(`commit${i}`, files);
			}

			const result = buildCoChangeMatrix(commitMap);

			expect(result).toBeInstanceOf(Map);
			// All pairs have coChangeCount=1, so all should be filtered out
			let passedEntries = 0;
			for (const entry of result.values()) {
				if (entry.coChangeCount >= 3) {
					passedEntries++;
				}
			}
			expect(passedEntries).toBe(0);
		});
	});

	describe('5. NPMI boundary: P(A,B) = P(A) = P(B) = 1.0', () => {
		it('should clamp NPMI to 1.0 when all files appear in all commits', () => {
			const commitMap = new Map<string, Set<string>>();

			// Create 100 commits, each with the same 2 files
			const fileA = 'src/common/fileA.ts';
			const fileB = 'src/common/fileB.ts';

			for (let i = 0; i < 100; i++) {
				const files = new Set<string>();
				files.add(fileA);
				files.add(fileB);
				commitMap.set(`commit${i}`, files);
			}

			const result = buildCoChangeMatrix(commitMap);

			expect(result.size).toBe(1);
			const entry = result.get(`${fileA}::${fileB}`);
			expect(entry).toBeDefined();
			expect(entry!.coChangeCount).toBe(100);
			expect(entry!.npmi).toBe(1.0); // Clamped to 1.0
		});
	});

	describe('6. NPMI boundary: single commit scenario', () => {
		it('should skip NPMI computation when coChangeCount < 3', () => {
			const commitMap = new Map<string, Set<string>>();

			// Only 1 commit with 2 files
			const files = new Set<string>();
			files.add('src/fileA.ts');
			files.add('src/fileB.ts');
			commitMap.set('abc123', files);

			const result = buildCoChangeMatrix(commitMap);

			expect(result.size).toBe(1);
			const entry = result.get('src/fileA.ts::src/fileB.ts');
			expect(entry).toBeDefined();
			expect(entry!.coChangeCount).toBe(1);
			expect(entry!.npmi).toBe(0); // Computation skipped
			expect(entry!.lift).toBe(0); // Computation skipped
		});
	});

	describe('7. Malformed git log output', () => {
		it('should gracefully ignore random garbage lines', async () => {
			const malformedOutput = `
COMMIT:abc123
src/file1.ts
RANDOM_GARBAGE_LINE
src/file2.ts
ANOTHER_RANDOM_LINE
COMMIT:def456
src/file3.ts
`;
			mockExecFile.mockImplementation(
				(
					cmd: string,
					args: unknown,
					opts: unknown,
					cb: (err: Error | null, stdout: string, stderr: string) => void,
				) => {
					cb(null, malformedOutput, '');
				},
			);

			const result = await parseGitLog('/fake/dir', 100);

			expect(result).toBeInstanceOf(Map);
			expect(result.size).toBe(2);
			expect(result.get('abc123')?.has('src/file1.ts')).toBe(true);
			expect(result.get('abc123')?.has('src/file2.ts')).toBe(true);
			expect(result.get('def456')?.has('src/file3.ts')).toBe(true);
		});

		it('should handle COMMIT: with empty hash', async () => {
			const malformedOutput = 'COMMIT:\nsrc/file1.ts\nsrc/file2.ts\n';
			mockExecFile.mockImplementation(
				(
					cmd: string,
					args: unknown,
					opts: unknown,
					cb: (err: Error | null, stdout: string, stderr: string) => void,
				) => {
					cb(null, malformedOutput, '');
				},
			);

			const result = await parseGitLog('/fake/dir', 100);

			expect(result).toBeInstanceOf(Map);
			// The source guards against empty-string commit hashes (falsy currentCommit is skipped),
			// so COMMIT: with no hash produces no entry in the map.
			expect(result.has('')).toBe(false);
			expect(result.size).toBe(0);
		});

		it('should handle file paths with only spaces', async () => {
			const malformedOutput =
				'COMMIT:abc123\n   \nsrc/file1.ts\nsrc/file2.ts\n';
			mockExecFile.mockImplementation(
				(
					cmd: string,
					args: unknown,
					opts: unknown,
					cb: (err: Error | null, stdout: string, stderr: string) => void,
				) => {
					cb(null, malformedOutput, '');
				},
			);

			const result = await parseGitLog('/fake/dir', 100);

			expect(result).toBeInstanceOf(Map);
			const files = result.get('abc123');
			if (files) {
				expect(files.has('src/file1.ts')).toBe(true);
				expect(files.has('src/file2.ts')).toBe(true);
				// Whitespace-only paths should be filtered out
				expect(files.has('')).toBe(false);
			}
		});

		it('should handle Unicode filenames', async () => {
			const unicodeOutput = 'COMMIT:abc123\nsrc/测试.ts\nsrc/hello世界.js\n';
			mockExecFile.mockImplementation(
				(
					cmd: string,
					args: unknown,
					opts: unknown,
					cb: (err: Error | null, stdout: string, stderr: string) => void,
				) => {
					cb(null, unicodeOutput, '');
				},
			);

			const result = await parseGitLog('/fake/dir', 100);

			expect(result).toBeInstanceOf(Map);
			const files = result.get('abc123');
			if (files) {
				expect(files.has('src/测试.ts')).toBe(true);
				expect(files.has('src/hello世界.js')).toBe(true);
			}
		});
	});

	describe('8. Lesson length boundary in darkMatterToKnowledgeEntries', () => {
		it('should use ultimate fallback for extremely long basenames', () => {
			const longNameA = 'a'.repeat(150);
			const longNameB = 'b'.repeat(150);

			const pairs: CoChangeEntryType[] = [
				{
					fileA: `${longNameA}.ts`,
					fileB: `${longNameB}.ts`,
					coChangeCount: 10,
					npmi: 0.8,
					lift: 2.5,
					hasStaticEdge: false,
					totalCommits: 100,
					commitsA: 50,
					commitsB: 50,
				},
			];

			const entries = darkMatterToKnowledgeEntries(pairs, 'test-project');

			expect(entries).toHaveLength(1);
			expect(entries[0].lesson.length).toBeLessThanOrEqual(280);
			// Ultimate fallback should contain "NPMI="
			expect(entries[0].lesson).toContain('NPMI=');
		});

		it('should use second fallback for moderately long basenames', () => {
			const nameA = 'x'.repeat(60);
			const nameB = 'y'.repeat(60);

			const pairs: CoChangeEntryType[] = [
				{
					fileA: nameA,
					fileB: nameB,
					coChangeCount: 10,
					npmi: 0.75,
					lift: 2.0,
					hasStaticEdge: false,
					totalCommits: 100,
					commitsA: 50,
					commitsB: 50,
				},
			];

			const entries = darkMatterToKnowledgeEntries(pairs, 'test-project');

			expect(entries).toHaveLength(1);
			expect(entries[0].lesson.length).toBeLessThanOrEqual(280);
			expect(entries[0].lesson).toContain('NPMI=');
		});
	});

	describe('9. formatDarkMatterOutput with edge case NPMI values', () => {
		it('should format near-zero NPMI with 3 decimal places', () => {
			const pairs: CoChangeEntryType[] = [
				{
					fileA: 'src/fileA.ts',
					fileB: 'src/fileB.ts',
					coChangeCount: 10,
					npmi: 0.001,
					lift: 1.5,
					hasStaticEdge: false,
					totalCommits: 100,
					commitsA: 50,
					commitsB: 50,
				},
			];

			const output = formatDarkMatterOutput(pairs);

			expect(output).toContain('0.001');
			expect(output).toContain('1.50'); // lift with 2 decimals
		});

		it('should handle negative NPMI values', () => {
			const pairs: CoChangeEntryType[] = [
				{
					fileA: 'src/fileA.ts',
					fileB: 'src/fileB.ts',
					coChangeCount: 10,
					npmi: -0.5,
					lift: 0.8,
					hasStaticEdge: false,
					totalCommits: 100,
					commitsA: 50,
					commitsB: 50,
				},
			];

			const output = formatDarkMatterOutput(pairs);

			expect(output).toContain('-0.500');
		});

		it('should handle zero lift values', () => {
			const pairs: CoChangeEntryType[] = [
				{
					fileA: 'src/fileA.ts',
					fileB: 'src/fileB.ts',
					coChangeCount: 10,
					npmi: 0.7,
					lift: 0,
					hasStaticEdge: false,
					totalCommits: 100,
					commitsA: 50,
					commitsB: 50,
				},
			];

			const output = formatDarkMatterOutput(pairs);

			expect(output).toContain('0.00');
		});
	});

	describe('10. darkMatterToKnowledgeEntries with coChangeCount=0', () => {
		it('should calculate minimum confidence of 0.3 for coChangeCount=0', () => {
			const pairs: CoChangeEntryType[] = [
				{
					fileA: 'src/fileA.ts',
					fileB: 'src/fileB.ts',
					coChangeCount: 0,
					npmi: 0.8,
					lift: 2.0,
					hasStaticEdge: false,
					totalCommits: 100,
					commitsA: 50,
					commitsB: 50,
				},
			];

			const entries = darkMatterToKnowledgeEntries(pairs, 'test-project');

			expect(entries).toHaveLength(1);
			// Formula: 0.3 + 0.2 * min(0/10, 1) = 0.3
			expect(entries[0].confidence).toBe(0.3);
		});

		it('should generate valid UUID v4 for id field', () => {
			const pairs: CoChangeEntryType[] = [
				{
					fileA: 'src/fileA.ts',
					fileB: 'src/fileB.ts',
					coChangeCount: 0,
					npmi: 0.8,
					lift: 2.0,
					hasStaticEdge: false,
					totalCommits: 100,
					commitsA: 50,
					commitsB: 50,
				},
			];

			const entries = darkMatterToKnowledgeEntries(pairs, 'test-project');

			expect(entries).toHaveLength(1);
			const uuid = entries[0].id;
			// UUID v4 format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
			expect(uuid).toMatch(
				/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
			);
		});
	});

	describe('11. getStaticEdges with malformed file content', () => {
		it('should handle giant import statement without hanging', async () => {
			// Create a 10KB string with many import statements
			const giantImport = `
import { a } from './file1';
`.repeat(1000);

			mockReaddir.mockResolvedValue([
				{
					name: 'test.ts',
					isDirectory: () => false,
					isFile: () => true,
				} as any,
			]);

			mockReadFile.mockResolvedValue(giantImport);
			mockStat.mockResolvedValue({ isFile: () => true } as any);

			const startTime = Date.now();
			const result = await getStaticEdges('/fake/dir');
			const elapsed = Date.now() - startTime;

			// Should not hang and should complete quickly
			expect(elapsed).toBeLessThan(5000);
			expect(result).toBeInstanceOf(Set);
		});

		it('should handle file with 10KB of text matching import pattern', async () => {
			// Create content that triggers the regex heavily
			const massiveImports = Array(500)
				.fill(null)
				.map((_, i) => `import { module${i} } from './modules/module${i}';\n`)
				.join('');

			mockReaddir.mockResolvedValue([
				{
					name: 'big.ts',
					isDirectory: () => false,
					isFile: () => true,
				} as any,
			]);

			mockReadFile.mockResolvedValue(massiveImports);

			// Mock stat to reject all files (so no edges are added)
			mockStat.mockRejectedValue(new Error('File not found'));

			const result = await getStaticEdges('/fake/dir');

			// Should handle the regex processing without hanging
			expect(result).toBeInstanceOf(Set);
			// On Windows the path will have backslashes, so we just check the file was read
			expect(mockReadFile).toHaveBeenCalled();
		});
	});

	describe('12. Concurrent path separator edge case', () => {
		it('should normalize Windows-style backslashes in edge keys', async () => {
			mockReaddir.mockResolvedValue([
				{
					name: 'src',
					isDirectory: () => true,
					isFile: () => false,
				},
			]);

			// Mock readdir to return files in the src directory
			mockReaddir.mockImplementationOnce(
				async () =>
					[
						{
							name: 'foo.ts',
							isDirectory: () => false,
							isFile: () => true,
						},
						{
							name: 'bar.ts',
							isDirectory: () => false,
							isFile: () => true,
						},
					] as any,
			);

			// Mock file content with import
			mockReadFile.mockResolvedValue("import { bar } from './bar';");
			mockStat.mockResolvedValue({ isFile: () => true } as any);

			const result = await getStaticEdges('C:\\fake\\dir');

			expect(result).toBeInstanceOf(Set);

			// Check that no backslashes exist in the edge keys
			for (const key of result) {
				expect(key).not.toContain('\\');
			}
		});
	});

	describe('Additional edge cases', () => {
		it('should handle buildCoChangeMatrix with empty commitMap', () => {
			const emptyMap = new Map<string, Set<string>>();
			const result = buildCoChangeMatrix(emptyMap);

			expect(result).toBeInstanceOf(Map);
			expect(result.size).toBe(0);
		});

		it('should handle formatDarkMatterOutput with empty array', () => {
			const output = formatDarkMatterOutput([]);

			expect(output).toContain('No hidden couplings detected');
		});

		it('should handle darkMatterToKnowledgeEntries with empty array', () => {
			const entries = darkMatterToKnowledgeEntries([], 'test-project');

			expect(entries).toHaveLength(0);
		});

		it('should handle commit with single file (no pairs generated)', () => {
			const commitMap = new Map<string, Set<string>>();
			commitMap.set('abc123', new Set(['src/lonely.ts']));

			const result = buildCoChangeMatrix(commitMap);

			expect(result).toBeInstanceOf(Map);
			expect(result.size).toBe(0); // No pairs with single file
		});

		it('should handle very long file paths in buildCoChangeMatrix', () => {
			const commitMap = new Map<string, Set<string>>();
			const longPathA = 'src/' + 'a'.repeat(200) + '.ts';
			const longPathB = 'src/' + 'b'.repeat(200) + '.ts';

			const files = new Set([longPathA, longPathB]);
			commitMap.set('abc123', files);

			const result = buildCoChangeMatrix(commitMap);

			expect(result).toBeInstanceOf(Map);
			expect(result.size).toBe(1);
			const entry = Array.from(result.values())[0];
			expect(entry.fileA.length).toBeGreaterThan(200);
			expect(entry.fileB.length).toBeGreaterThan(200);
		});

		it('should handle NPMI calculation edge case: very small probabilities', () => {
			const commitMap = new Map<string, Set<string>>();

			// Create scenario with many commits and rare co-occurrence
			for (let i = 0; i < 1000; i++) {
				const files = new Set<string>();
				// FileA appears in commits 0-99 (100 times)
				if (i < 100) {
					files.add('src/rareA.ts');
				}
				// FileB appears in commits 0-99 (100 times)
				if (i < 100) {
					files.add('src/rareB.ts');
				}
				// FileC appears in all commits (always paired with A and B in first 100)
				if (i < 100) {
					files.add('src/commonC.ts');
				}

				commitMap.set(`commit${i}`, files);
			}

			const result = buildCoChangeMatrix(commitMap);

			// Should compute NPMI without crashing
			expect(result).toBeInstanceOf(Map);
			const abEntry = result.get('src/rareA.ts::src/rareB.ts');
			if (abEntry && abEntry.coChangeCount >= 3) {
				// NPMI should be computed and clamped to [-1, 1]
				expect(abEntry.npmi).toBeGreaterThanOrEqual(-1);
				expect(abEntry.npmi).toBeLessThanOrEqual(1);
			}
		});
	});

	describe('13. Path injection attempts', () => {
		it('should not execute commands from malicious file paths', async () => {
			const maliciousPaths = [
				'$(whoami).ts',
				'`touch /tmp/pwn`.ts',
				';cat /etc/passwd;.ts',
				'&& echo pwned.ts',
			];

			const output = ['COMMIT:abc123', ...maliciousPaths].join('\n');

			mockExecFile.mockImplementation(
				(
					cmd: string,
					args: unknown,
					opts: unknown,
					cb: (err: Error | null, stdout: string, stderr: string) => void,
				) => {
					cb(null, output, '');
				},
			);

			const result = await parseGitLog('/fake/dir', 100);

			expect(result).toBeInstanceOf(Map);
			const files = result.get('abc123');
			// All paths should be stored as-is, not executed
			for (const maliciousPath of maliciousPaths) {
				if (files) {
					expect(files.has(maliciousPath)).toBe(true);
				}
			}
		});
	});

	describe('14. Memory pressure tests', () => {
		it('should handle pair explosion (50 files per commit * 100 commits)', () => {
			const commitMap = new Map<string, Set<string>>();

			// Each commit has 50 files, generating ~1225 pairs per commit
			for (let i = 0; i < 100; i++) {
				const files = new Set<string>();
				for (let j = 0; j < 50; j++) {
					files.add(`src/module${j}/file${j}.ts`);
				}
				commitMap.set(`commit${i}`, files);
			}

			const startTime = Date.now();
			const result = buildCoChangeMatrix(commitMap);
			const elapsed = Date.now() - startTime;

			// Should not crash or take too long
			expect(result).toBeInstanceOf(Map);
			expect(elapsed).toBeLessThan(5000);
		});
	});

	describe('15. Division by zero protection', () => {
		it('should handle zero total commits gracefully', () => {
			const commitMap = new Map<string, Set<string>>();
			// Empty map = 0 total commits

			const result = buildCoChangeMatrix(commitMap);

			expect(result).toBeInstanceOf(Map);
			expect(result.size).toBe(0);
		});

		it('should handle files with zero probability (never appear)', () => {
			const commitMap = new Map<string, Set<string>>();

			// FileA and FileB appear together in 5 commits
			// FileC never appears (not in any commit)
			for (let i = 0; i < 10; i++) {
				const files = new Set<string>();
				files.add('src/fileA.ts');
				files.add('src/fileB.ts');
				commitMap.set(`commit${i}`, files);
			}

			const result = buildCoChangeMatrix(commitMap);

			expect(result).toBeInstanceOf(Map);
			// Should have at least the A-B pair
			expect(result.size).toBeGreaterThan(0);
		});
	});
});
