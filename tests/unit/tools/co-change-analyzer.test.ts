import { beforeEach, describe, expect, it, mock } from 'bun:test';

// Mock only execFile while preserving every other export (#330).
const mockExecFile = mock(
	(cmd: string, args: string[], opts: unknown, cb: Function) => {
		cb(null, { stdout: '' }, '');
	},
);

const realChildProcess = await import('node:child_process');
mock.module('node:child_process', () => ({
	...realChildProcess,
	execFile: mockExecFile,
}));

// Import AFTER mock setup
const {
	buildCoChangeMatrix,
	parseGitLog,
	formatDarkMatterOutput,
	darkMatterToKnowledgeEntries,
	detectDarkMatter,
} = await import('../../../src/tools/co-change-analyzer');
const { validateActionability } = await import(
	'../../../src/hooks/knowledge-validator'
);

describe('buildCoChangeMatrix', () => {
	beforeEach(() => {
		mockExecFile.mockClear();
	});

	it('returns empty map for empty input', () => {
		const result = buildCoChangeMatrix(new Map());
		expect(result.size).toBe(0);
	});

	it('returns empty map for single-file commits (no pairs)', () => {
		const commitMap = new Map<string, Set<string>>();
		commitMap.set('c1', new Set(['src/foo.ts']));
		commitMap.set('c2', new Set(['src/bar.ts']));

		const result = buildCoChangeMatrix(commitMap);
		expect(result.size).toBe(0);
	});

	it('creates entry with coChangeCount=1, npmi=0 for two files in one commit (not enough data)', () => {
		const commitMap = new Map<string, Set<string>>();
		commitMap.set('c1', new Set(['src/foo.ts', 'src/bar.ts']));

		const result = buildCoChangeMatrix(commitMap);
		expect(result.size).toBe(1);

		const entry = result.get('src/bar.ts::src/foo.ts');
		expect(entry).toBeDefined();
		expect(entry?.coChangeCount).toBe(1);
		expect(entry?.npmi).toBe(0); // Not computed (< 3)
		expect(entry?.lift).toBe(0);
	});

	it('computes correct NPMI for 10 commits: A=4, B=3, AB=3', () => {
		// 10 commits total
		// src/a.ts appears in 4 commits
		// src/b.ts appears in 3 commits
		// Both appear together in 3 commits
		const commitMap = new Map<string, Set<string>>();

		// 3 commits: both A and B
		for (let i = 0; i < 3; i++) {
			commitMap.set(`c${i}`, new Set(['src/a.ts', 'src/b.ts']));
		}

		// 1 more commit: A only (total A = 4)
		commitMap.set('c3', new Set(['src/a.ts']));

		// Add other commits to reach 10
		for (let i = 4; i < 10; i++) {
			commitMap.set(`c${i}`, new Set(['src/other.ts']));
		}

		const result = buildCoChangeMatrix(commitMap);

		const entry = result.get('src/a.ts::src/b.ts');
		expect(entry).toBeDefined();
		expect(entry?.coChangeCount).toBe(3);
		expect(entry?.commitsA).toBe(4);
		expect(entry?.commitsB).toBe(3);
		expect(entry?.totalCommits).toBe(10);

		// Expected NPMI ≈ 0.761
		// pAB = 3/10 = 0.3, pA = 4/10 = 0.4, pB = 3/10 = 0.3
		expect(entry?.npmi).toBeCloseTo(0.761, 2); // Allow ~0.01 tolerance

		// Lift = 0.3 / (0.4 * 0.3) = 2.5
		expect(entry?.lift).toBeCloseTo(2.5, 1);
	});

	it('computes correct NPMI for 100 commits: A=20, B=30, AB=15', () => {
		const commitMap = new Map<string, Set<string>>();

		// 15 commits: both A and B
		for (let i = 0; i < 15; i++) {
			commitMap.set(`c${i}`, new Set(['src/a.ts', 'src/b.ts']));
		}

		// 5 more commits: A only (total A = 20)
		for (let i = 15; i < 20; i++) {
			commitMap.set(`c${i}`, new Set(['src/a.ts']));
		}

		// 15 more commits: B only (total B = 30)
		for (let i = 20; i < 35; i++) {
			commitMap.set(`c${i}`, new Set(['src/b.ts']));
		}

		// 65 commits: neither
		for (let i = 35; i < 100; i++) {
			commitMap.set(`c${i}`, new Set(['src/c.ts']));
		}

		const result = buildCoChangeMatrix(commitMap);

		const entry = result.get('src/a.ts::src/b.ts');
		expect(entry).toBeDefined();
		expect(entry?.coChangeCount).toBe(15);
		expect(entry?.commitsA).toBe(20);
		expect(entry?.commitsB).toBe(30);
		expect(entry?.totalCommits).toBe(100);

		// Expected NPMI ≈ 0.483
		expect(entry?.npmi).toBeCloseTo(0.483, 2);

		// Lift = 0.15 / (0.2 * 0.3) = 2.5
		expect(entry?.lift).toBeCloseTo(2.5, 1);
	});

	it('stores entries with canonical ordering (fileB < fileA alphabetically)', () => {
		const commitMap = new Map<string, Set<string>>();
		commitMap.set('c1', new Set(['src/zebra.ts', 'src/apple.ts']));

		const result = buildCoChangeMatrix(commitMap);

		// Should be stored as apple::zebra (alphabetically sorted)
		expect(result.has('src/apple.ts::src/zebra.ts')).toBe(true);
		expect(result.has('src/zebra.ts::src/apple.ts')).toBe(false);

		const entry = result.get('src/apple.ts::src/zebra.ts');
		expect(entry?.fileA).toBe('src/apple.ts');
		expect(entry?.fileB).toBe('src/zebra.ts');
	});

	it('sets npmi=0 for entries with coChangeCount=2 (under threshold)', () => {
		const commitMap = new Map<string, Set<string>>();

		// 2 commits with both files together
		for (let i = 0; i < 2; i++) {
			commitMap.set(`c${i}`, new Set(['src/a.ts', 'src/b.ts']));
		}

		// Add more commits to have sufficient total
		for (let i = 2; i < 10; i++) {
			commitMap.set(`c${i}`, new Set(['src/c.ts']));
		}

		const result = buildCoChangeMatrix(commitMap);
		const entry = result.get('src/a.ts::src/b.ts');

		expect(entry?.coChangeCount).toBe(2);
		expect(entry?.npmi).toBe(0); // Not computed (< 3)
	});

	it('handles multiple files in a single commit, creating all pairs', () => {
		const commitMap = new Map<string, Set<string>>();
		commitMap.set('c1', new Set(['src/a.ts', 'src/b.ts', 'src/c.ts']));

		const result = buildCoChangeMatrix(commitMap);

		// Should create 3 pairs: (a,b), (a,c), (b,c)
		expect(result.size).toBe(3);
		expect(result.has('src/a.ts::src/b.ts')).toBe(true);
		expect(result.has('src/a.ts::src/c.ts')).toBe(true);
		expect(result.has('src/b.ts::src/c.ts')).toBe(true);
	});

	it('correctly handles file paths with special characters', () => {
		const commitMap = new Map<string, Set<string>>();

		for (let i = 0; i < 5; i++) {
			commitMap.set(`c${i}`, new Set(['src/file-1.ts', 'src/file_2.ts']));
		}

		const result = buildCoChangeMatrix(commitMap);

		const entry = result.get('src/file-1.ts::src/file_2.ts');
		expect(entry).toBeDefined();
		expect(entry?.fileA).toBe('src/file-1.ts');
		expect(entry?.fileB).toBe('src/file_2.ts');
	});

	it('skips pair generation for commits with >500 files (#1021)', () => {
		const commitMap = new Map<string, Set<string>>();

		// Normal commit with 2 files — should be processed
		commitMap.set('normal', new Set(['src/a.ts', 'src/b.ts']));

		// Massive commit with 600 files — pair generation skipped
		const massiveFiles = new Set<string>();
		for (let i = 0; i < 600; i++) {
			massiveFiles.add(`src/file_${i}.ts`);
		}
		commitMap.set('massive', massiveFiles);

		const result = buildCoChangeMatrix(commitMap);

		// Only the pair from the normal commit should exist
		expect(result.size).toBe(1);
		expect(result.has('src/a.ts::src/b.ts')).toBe(true);
	});

	it('still counts file commit frequencies for skipped large commits (#1021)', () => {
		const commitMap = new Map<string, Set<string>>();

		// File "shared.ts" appears in both a normal and a large commit
		commitMap.set('c1', new Set(['shared.ts', 'other.ts']));
		commitMap.set('c2', new Set(['shared.ts', 'other.ts']));
		commitMap.set('c3', new Set(['shared.ts', 'other.ts']));

		// Large commit also touches shared.ts — pair gen skipped but count still updated
		const largeFiles = new Set<string>();
		largeFiles.add('shared.ts');
		for (let i = 0; i < 600; i++) {
			largeFiles.add(`bulk_${i}.ts`);
		}
		commitMap.set('large', largeFiles);

		const result = buildCoChangeMatrix(commitMap);

		// The pair (other.ts, shared.ts) should exist with coChangeCount=3
		const entry = result.get('other.ts::shared.ts');
		expect(entry).toBeDefined();
		expect(entry?.coChangeCount).toBe(3);
		// shared.ts appears in 4 commits (3 normal + 1 large), other.ts in 3
		expect(entry?.commitsA).toBe(3); // other.ts
		expect(entry?.commitsB).toBe(4); // shared.ts — includes the large commit
	});

	it('processes commits with exactly 500 files', () => {
		const commitMap = new Map<string, Set<string>>();

		const files = new Set<string>();
		for (let i = 0; i < 500; i++) {
			files.add(`src/file_${String(i).padStart(4, '0')}.ts`);
		}
		commitMap.set('boundary', files);

		const result = buildCoChangeMatrix(commitMap);

		// 500 files → 500*499/2 = 124750 pairs — should be processed (at boundary)
		expect(result.size).toBe(124750);
	});

	it('respects custom maxFilesPerCommit parameter', () => {
		const commitMap = new Map<string, Set<string>>();

		// Commit with 10 files
		const files = new Set<string>();
		for (let i = 0; i < 10; i++) {
			files.add(`src/file_${i}.ts`);
		}
		commitMap.set('c1', files);

		// With cap at 5, this commit is skipped for pair generation
		const resultCapped = buildCoChangeMatrix(commitMap, 5);
		expect(resultCapped.size).toBe(0);

		// With default (500), this commit is processed
		const resultDefault = buildCoChangeMatrix(commitMap);
		expect(resultDefault.size).toBe(45); // 10*9/2
	});
});

describe('parseGitLog', () => {
	beforeEach(() => {
		mockExecFile.mockClear();
	});

	it('returns empty map for empty stdout', async () => {
		mockExecFile.mockImplementation(
			(_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
				cb(null, { stdout: '' }, '');
			},
		);

		const result = await parseGitLog('/test/dir', 100);
		expect(result.size).toBe(0);
	});

	it('parses valid git log output with 2 commits each touching 2 files', async () => {
		const stdout = `COMMIT:abc123
src/foo.ts
src/bar.ts

COMMIT:def456
src/foo.ts
src/baz.ts
`;

		mockExecFile.mockImplementation(
			(_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
				cb(null, { stdout }, '');
			},
		);

		const result = await parseGitLog('/test/dir', 100);

		expect(result.size).toBe(2);
		expect(result.has('abc123')).toBe(true);
		expect(result.has('def456')).toBe(true);

		const commit1Files = result.get('abc123');
		const commit2Files = result.get('def456');

		expect(commit1Files?.size).toBe(2);
		expect(commit1Files?.has('src/foo.ts')).toBe(true);
		expect(commit1Files?.has('src/bar.ts')).toBe(true);

		expect(commit2Files?.size).toBe(2);
		expect(commit2Files?.has('src/foo.ts')).toBe(true);
		expect(commit2Files?.has('src/baz.ts')).toBe(true);
	});

	it('filters out .swarm/ files', async () => {
		const stdout = `COMMIT:abc123
.swarm/plan.md
src/foo.ts

COMMIT:def456
src/bar.ts
`;

		mockExecFile.mockImplementation(
			(_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
				cb(null, { stdout }, '');
			},
		);

		const result = await parseGitLog('/test/dir', 100);

		const commit1Files = result.get('abc123');
		expect(commit1Files?.has('.swarm/plan.md')).toBe(false);
		expect(commit1Files?.has('src/foo.ts')).toBe(true);
	});

	it('filters out node_modules/ files', async () => {
		const stdout = `COMMIT:abc123
node_modules/package/index.js
src/foo.ts

COMMIT:def456
src/bar.ts
`;

		mockExecFile.mockImplementation(
			(_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
				cb(null, { stdout }, '');
			},
		);

		const result = await parseGitLog('/test/dir', 100);

		const commit1Files = result.get('abc123');
		expect(commit1Files?.has('node_modules/package/index.js')).toBe(false);
		expect(commit1Files?.has('src/foo.ts')).toBe(true);
	});

	it('filters out empty lines', async () => {
		const stdout = `COMMIT:abc123
src/foo.ts

src/bar.ts

`;

		mockExecFile.mockImplementation(
			(_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
				cb(null, { stdout }, '');
			},
		);

		const result = await parseGitLog('/test/dir', 100);

		const commit1Files = result.get('abc123');
		expect(commit1Files?.size).toBe(2);
	});

	it('returns empty map when execFile throws', async () => {
		mockExecFile.mockImplementation(
			(_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
				cb(new Error('Command failed'), null, '');
			},
		);

		const result = await parseGitLog('/test/dir', 100);
		expect(result.size).toBe(0);
	});

	it('passes correct git command arguments', async () => {
		mockExecFile.mockImplementation(
			(_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
				cb(null, { stdout: '' }, '');
			},
		);

		await parseGitLog('/test/dir', 250);

		expect(mockExecFile).toHaveBeenCalledTimes(1);
		expect(mockExecFile).toHaveBeenCalledWith(
			'git',
			[
				'log',
				'--name-only',
				'--pretty=format:COMMIT:%H',
				'--no-merges',
				'-n250',
			],
			expect.objectContaining({
				cwd: '/test/dir',
				timeout: 10_000,
			}),
			expect.any(Function),
		);
	});

	it('handles commits with only filtered files (results in empty commit)', async () => {
		const stdout = `COMMIT:abc123
.swarm/plan.md
node_modules/pkg/index.js

COMMIT:def456
src/real.ts
`;

		mockExecFile.mockImplementation(
			(_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
				cb(null, { stdout }, '');
			},
		);

		const result = await parseGitLog('/test/dir', 100);

		// First commit should have empty set, but still be in the map
		const commit1Files = result.get('abc123');
		expect(commit1Files?.size).toBe(0);

		const commit2Files = result.get('def456');
		expect(commit2Files?.size).toBe(1);
		expect(commit2Files?.has('src/real.ts')).toBe(true);
	});
});

describe('formatDarkMatterOutput', () => {
	it('returns no-couplings message for empty array', () => {
		const result = formatDarkMatterOutput([]);

		expect(result).toContain('No hidden couplings detected');
		expect(result).toContain('Dark Matter: Hidden Couplings');
	});

	it('returns markdown table with header and row for single entry', () => {
		const pairs = [
			{
				fileA: 'src/a.ts',
				fileB: 'src/b.ts',
				coChangeCount: 10,
				npmi: 0.75,
				lift: 2.5,
				hasStaticEdge: false,
				totalCommits: 100,
				commitsA: 20,
				commitsB: 15,
			},
		];

		const result = formatDarkMatterOutput(pairs);

		expect(result).toContain('File A | File B | NPMI | Co-Changes | Lift');
		expect(result).toContain('src/a.ts | src/b.ts | 0.750 | 10 | 2.50');
		expect(result).toContain('Found 1 file pairs');
		expect(result).toContain('Dark Matter: Hidden Couplings');
	});

	it('formats NPMI to 3 decimal places', () => {
		const pairs = [
			{
				fileA: 'src/a.ts',
				fileB: 'src/b.ts',
				coChangeCount: 10,
				npmi: 0.756789,
				lift: 2.5,
				hasStaticEdge: false,
				totalCommits: 100,
				commitsA: 20,
				commitsB: 15,
			},
		];

		const result = formatDarkMatterOutput(pairs);

		expect(result).toContain('0.757'); // 3 decimal places
	});

	it('formats lift to 2 decimal places', () => {
		const pairs = [
			{
				fileA: 'src/a.ts',
				fileB: 'src/b.ts',
				coChangeCount: 10,
				npmi: 0.75,
				lift: 2.5678,
				hasStaticEdge: false,
				totalCommits: 100,
				commitsA: 20,
				commitsB: 15,
			},
		];

		const result = formatDarkMatterOutput(pairs);

		expect(result).toContain('2.57'); // 2 decimal places
	});

	it('includes multiple entries in output', () => {
		const pairs = [
			{
				fileA: 'src/a.ts',
				fileB: 'src/b.ts',
				coChangeCount: 10,
				npmi: 0.75,
				lift: 2.5,
				hasStaticEdge: false,
				totalCommits: 100,
				commitsA: 20,
				commitsB: 15,
			},
			{
				fileA: 'src/c.ts',
				fileB: 'src/d.ts',
				coChangeCount: 8,
				npmi: 0.65,
				lift: 1.8,
				hasStaticEdge: false,
				totalCommits: 100,
				commitsA: 18,
				commitsB: 12,
			},
		];

		const result = formatDarkMatterOutput(pairs);

		expect(result).toContain('Found 2 file pairs');
		expect(result).toContain('src/a.ts | src/b.ts');
		expect(result).toContain('src/c.ts | src/d.ts');
	});

	it('includes footer message about architectural concerns', () => {
		const pairs = [
			{
				fileA: 'src/a.ts',
				fileB: 'src/b.ts',
				coChangeCount: 10,
				npmi: 0.75,
				lift: 2.5,
				hasStaticEdge: false,
				totalCommits: 100,
				commitsA: 20,
				commitsB: 15,
			},
		];

		const result = formatDarkMatterOutput(pairs);

		expect(result).toContain(
			'These pairs likely share an architectural concern',
		);
		expect(result).toContain('Consider adding explicit documentation');
	});
});

describe('darkMatterToKnowledgeEntries', () => {
	it('returns empty array for empty pairs', () => {
		const result = darkMatterToKnowledgeEntries([], 'test-project');

		expect(result).toEqual([]);
	});

	it('returns single SwarmKnowledgeEntry for one pair', () => {
		const pairs = [
			{
				fileA: 'src/a.ts',
				fileB: 'src/b.ts',
				coChangeCount: 10,
				npmi: 0.75,
				lift: 2.5,
				hasStaticEdge: false,
				totalCommits: 100,
				commitsA: 20,
				commitsB: 15,
			},
		];

		const result = darkMatterToKnowledgeEntries(pairs, 'test-project');

		expect(result).toHaveLength(1);

		const entry = result[0];

		expect(entry.tier).toBe('swarm');
		expect(entry.category).toBe('architecture');
		expect(entry.tags).toEqual(['hidden-coupling', 'co-change', 'dark-matter']);
		expect(entry.auto_generated).toBe(true);
		expect(entry.status).toBe('candidate');
		expect(entry.schema_version).toBe(1);
		expect(entry.project_name).toBe('test-project');
		expect(entry.scope).toBe('global');
		expect(typeof entry.id).toBe('string');
		expect(typeof entry.created_at).toBe('string');
		expect(typeof entry.updated_at).toBe('string');
	});

	it('emits Layer-5 actionable entries (Change 4): scope + predicate fields from the structured pair', () => {
		// Dark-matter findings know the exact file pair, so the v3 fields are
		// emitted deterministically — these entries must pass the actionability
		// gate without LLM enrichment.
		const pairs = [
			{
				fileA: 'src/alpha.ts',
				fileB: 'src/beta.ts',
				coChangeCount: 10,
				npmi: 0.75,
				lift: 2.5,
				hasStaticEdge: false,
				totalCommits: 100,
				commitsA: 20,
				commitsB: 15,
			},
		];
		const [entry] = darkMatterToKnowledgeEntries(pairs, 'test-project');
		expect(entry.applies_to_agents).toEqual(['coder', 'reviewer']);
		expect(entry.required_actions?.[0]).toContain('alpha.ts');
		expect(entry.required_actions?.[0]).toContain('beta.ts');
		expect(entry.verification_checks?.length).toBeGreaterThan(0);
		expect(entry.triggers).toEqual(['alpha.ts', 'beta.ts']);
		expect(validateActionability(entry).actionable).toBe(true);
	});

	it('generates valid confidence in range [0.3, 0.5]', () => {
		const pairs = [
			{
				fileA: 'src/a.ts',
				fileB: 'src/b.ts',
				coChangeCount: 10,
				npmi: 0.75,
				lift: 2.5,
				hasStaticEdge: false,
				totalCommits: 100,
				commitsA: 20,
				commitsB: 15,
			},
		];

		const result = darkMatterToKnowledgeEntries(pairs, 'test-project');
		const entry = result[0];

		expect(entry.confidence).toBeGreaterThanOrEqual(0.3);
		expect(entry.confidence).toBeLessThanOrEqual(0.5);
	});

	it('confidence formula: coChangeCount=10 → 0.5, coChangeCount=0 → 0.3, coChangeCount=5 → 0.4', () => {
		// coChangeCount=0
		let pairs = [
			{
				fileA: 'src/a.ts',
				fileB: 'src/b.ts',
				coChangeCount: 0,
				npmi: 0.75,
				lift: 2.5,
				hasStaticEdge: false,
				totalCommits: 100,
				commitsA: 20,
				commitsB: 15,
			},
		];

		let result = darkMatterToKnowledgeEntries(pairs, 'test-project');
		expect(result[0].confidence).toBe(0.3);

		// coChangeCount=5
		pairs = [
			{
				fileA: 'src/a.ts',
				fileB: 'src/b.ts',
				coChangeCount: 5,
				npmi: 0.75,
				lift: 2.5,
				hasStaticEdge: false,
				totalCommits: 100,
				commitsA: 20,
				commitsB: 15,
			},
		];

		result = darkMatterToKnowledgeEntries(pairs, 'test-project');
		expect(result[0].confidence).toBe(0.4);

		// coChangeCount=10
		pairs = [
			{
				fileA: 'src/a.ts',
				fileB: 'src/b.ts',
				coChangeCount: 10,
				npmi: 0.75,
				lift: 2.5,
				hasStaticEdge: false,
				totalCommits: 100,
				commitsA: 20,
				commitsB: 15,
			},
		];

		result = darkMatterToKnowledgeEntries(pairs, 'test-project');
		expect(result[0].confidence).toBe(0.5);
	});

	it('confidence caps at 0.5 for coChangeCount > 10', () => {
		const pairs = [
			{
				fileA: 'src/a.ts',
				fileB: 'src/b.ts',
				coChangeCount: 20,
				npmi: 0.75,
				lift: 2.5,
				hasStaticEdge: false,
				totalCommits: 100,
				commitsA: 20,
				commitsB: 15,
			},
		];

		const result = darkMatterToKnowledgeEntries(pairs, 'test-project');
		expect(result[0].confidence).toBe(0.5);
	});

	it('lesson contains both filenames', () => {
		const pairs = [
			{
				fileA: 'src/a.ts',
				fileB: 'src/b.ts',
				coChangeCount: 10,
				npmi: 0.75,
				lift: 2.5,
				hasStaticEdge: false,
				totalCommits: 100,
				commitsA: 20,
				commitsB: 15,
			},
		];

		const result = darkMatterToKnowledgeEntries(pairs, 'test-project');
		const lesson = result[0].lesson;

		expect(lesson).toContain('src/a.ts');
		expect(lesson).toContain('src/b.ts');
	});

	it('caps results at 10 entries even when more pairs provided', () => {
		const pairs = Array.from({ length: 15 }, (_, i) => ({
			fileA: `src/a${i}.ts`,
			fileB: `src/b${i}.ts`,
			coChangeCount: 10,
			npmi: 0.75,
			lift: 2.5,
			hasStaticEdge: false,
			totalCommits: 100,
			commitsA: 20,
			commitsB: 15,
		}));

		const result = darkMatterToKnowledgeEntries(pairs, 'test-project');

		expect(result).toHaveLength(10);
	});

	it('includes NPMI in lesson text', () => {
		const pairs = [
			{
				fileA: 'src/a.ts',
				fileB: 'src/b.ts',
				coChangeCount: 10,
				npmi: 0.756789,
				lift: 2.5,
				hasStaticEdge: false,
				totalCommits: 100,
				commitsA: 20,
				commitsB: 15,
			},
		];

		const result = darkMatterToKnowledgeEntries(pairs, 'test-project');
		const lesson = result[0].lesson;

		expect(lesson).toContain('0.757'); // 3 decimal places
	});

	it('truncates lesson to 280 chars for very long paths', () => {
		// Create very long filenames
		const longPathA = 'src/' + 'x'.repeat(200) + '.ts';
		const longPathB = 'src/' + 'y'.repeat(200) + '.ts';

		const pairs = [
			{
				fileA: longPathA,
				fileB: longPathB,
				coChangeCount: 10,
				npmi: 0.75,
				lift: 2.5,
				hasStaticEdge: false,
				totalCommits: 100,
				commitsA: 20,
				commitsB: 15,
			},
		];

		const result = darkMatterToKnowledgeEntries(pairs, 'test-project');
		const lesson = result[0].lesson;

		expect(lesson.length).toBeLessThanOrEqual(280);
	});

	it('initializes retrieval_outcomes with zeros', () => {
		const pairs = [
			{
				fileA: 'src/a.ts',
				fileB: 'src/b.ts',
				coChangeCount: 10,
				npmi: 0.75,
				lift: 2.5,
				hasStaticEdge: false,
				totalCommits: 100,
				commitsA: 20,
				commitsB: 15,
			},
		];

		const result = darkMatterToKnowledgeEntries(pairs, 'test-project');
		const entry = result[0];

		expect(entry.retrieval_outcomes).toEqual({
			applied_count: 0,
			succeeded_after_count: 0,
			failed_after_count: 0,
		});
	});

	it('confirmed_by is empty array for new entries', () => {
		const pairs = [
			{
				fileA: 'src/a.ts',
				fileB: 'src/b.ts',
				coChangeCount: 10,
				npmi: 0.75,
				lift: 2.5,
				hasStaticEdge: false,
				totalCommits: 100,
				commitsA: 20,
				commitsB: 15,
			},
		];

		const result = darkMatterToKnowledgeEntries(pairs, 'test-project');
		const entry = result[0];

		expect(entry.confirmed_by).toEqual([]);
	});
});

describe('detectDarkMatter integration test', () => {
	beforeEach(() => {
		mockExecFile.mockClear();
	});

	it('filters out test↔implementation pairs', async () => {
		// Mock git rev-list to return sufficient commits
		mockExecFile.mockImplementation(
			(cmd: string, args: string[], _opts: unknown, cb: Function) => {
				if (cmd === 'git' && args[0] === 'rev-list') {
					cb(null, { stdout: '100' }, '');
					return;
				}
				if (cmd === 'git' && args[0] === 'log') {
					// Create 10 commits where test and impl appear together
					const lines: string[] = [];
					for (let i = 0; i < 10; i++) {
						lines.push(`COMMIT:commit${i}`);
						lines.push('src/hooks/knowledge-store.ts');
						lines.push('src/hooks/knowledge-store.test.ts');
						lines.push('');
					}
					cb(null, { stdout: lines.join('\n') }, '');
					return;
				}
				cb(new Error('Unexpected command'), null, '');
			},
		);

		const result = await detectDarkMatter('/test/dir');

		// Should be filtered out (test↔implementation pair)
		expect(result).toEqual([]);
	});

	it('returns empty array when repo has fewer than minCommits', async () => {
		mockExecFile.mockImplementation(
			(cmd: string, args: string[], _opts: unknown, cb: Function) => {
				if (cmd === 'git' && args[0] === 'rev-list') {
					cb(null, { stdout: '15' }, ''); // Only 15 commits
					return;
				}
				cb(new Error('Unexpected command'), null, '');
			},
		);

		const result = await detectDarkMatter('/test/dir', { minCommits: 20 });

		expect(result).toEqual([]);
	});

	it('returns empty array when git rev-list fails', async () => {
		mockExecFile.mockImplementation(
			(cmd: string, args: string[], _opts: unknown, cb: Function) => {
				if (cmd === 'git' && args[0] === 'rev-list') {
					cb(new Error('Git error'), null, '');
					return;
				}
				cb(new Error('Unexpected command'), null, '');
			},
		);

		const result = await detectDarkMatter('/test/dir');

		expect(result).toEqual([]);
	});

	it('respects custom npmiThreshold option', async () => {
		// This test verifies filtering behavior
		// In a real scenario, we'd need to mock both git calls and file system
		mockExecFile.mockImplementation(
			(cmd: string, args: string[], _opts: unknown, cb: Function) => {
				if (cmd === 'git' && args[0] === 'rev-list') {
					cb(null, { stdout: '100' }, '');
					return;
				}
				if (cmd === 'git' && args[0] === 'log') {
					const lines = `COMMIT:c1
src/a.ts
src/b.ts
`;
					cb(null, { stdout: lines }, '');
					return;
				}
				cb(new Error('Unexpected command'), null, '');
			},
		);

		// With npmiThreshold=1.0 (higher than any realistic NPMI), should filter everything
		const result = await detectDarkMatter('/test/dir', { npmiThreshold: 1.0 });

		expect(result).toEqual([]);
	});
});
