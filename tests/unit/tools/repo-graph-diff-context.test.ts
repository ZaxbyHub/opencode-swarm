import { beforeEach, describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import {
	type GraphNode,
	getDiffContext,
	normalizeGraphPath,
	type RepoGraph,
	resetQueryCache,
} from '../../../src/tools/repo-graph';

const root = path.resolve('/repo');
const abs = (moduleName: string): string =>
	normalizeGraphPath(path.join(root, moduleName));

function node(
	moduleName: string,
	options: {
		exports?: string[];
		ranges?: Record<string, { startLine: number; endLine: number }>;
		testFile?: boolean;
	} = {},
): GraphNode {
	return {
		filePath: abs(moduleName),
		moduleName,
		exports: options.exports ?? [],
		imports: [],
		language: 'typescript',
		mtime: '1',
		...(options.ranges !== undefined ? { exportRanges: options.ranges } : {}),
		...(options.testFile === true
			? {
					ontology: {
						roles: ['test_file' as const],
						packageBoundary: 'src',
						routes: [],
						dataOperations: [],
						security: [],
						conventions: [],
						findings: [],
					},
				}
			: {}),
	};
}

function makeGraph(): RepoGraph {
	const util = node('src/util.ts', {
		exports: ['add', 'sub'],
		ranges: {
			add: { startLine: 1, endLine: 2 },
			sub: { startLine: 4, endLine: 6 },
			internal: { startLine: 8, endLine: 9 },
		},
	});
	const main = node('src/main.ts');
	const spec = node('src/util.spec.ts', { testFile: true });
	return {
		schema_version: '1.6.0',
		workspaceRoot: root,
		nodes: {
			[util.filePath]: util,
			[main.filePath]: main,
			[spec.filePath]: spec,
		},
		edges: [
			{
				source: abs('src/main.ts'),
				target: abs('src/util.ts'),
				importSpecifier: './util',
				importType: 'named',
			},
			{
				source: abs('src/util.spec.ts'),
				target: abs('src/util.ts'),
				importSpecifier: './util',
				importType: 'named',
			},
		],
		metadata: {
			generatedAt: '1',
			generator: 'test',
			nodeCount: 3,
			edgeCount: 2,
		},
	};
}

beforeEach(() => {
	resetQueryCache();
});

describe('getDiffContext: hunk mode', () => {
	test('maps hunk line ranges to intersecting symbols', () => {
		// Well-formed hunks (old/new counts match delivered body lines) — the
		// parser's hunk-state guard consumes by the promised counts.
		const diff = [
			'diff --git a/src/util.ts b/src/util.ts',
			'--- a/src/util.ts',
			'+++ b/src/util.ts',
			'@@ -1,1 +1,2 @@',
			' context',
			'+changed add body',
			'@@ -12,1 +12,1 @@',
			'+changed tail',
		].join('\n');
		const result = getDiffContext(makeGraph(), { diff });
		expect(result.granularity).toBe('hunk');
		expect(result.files).toHaveLength(1);
		const file = result.files[0];
		expect(file?.file).toBe('src/util.ts');
		expect(file?.known).toBe(true);
		expect(file?.symbols.map((s) => s.symbol)).toEqual(['add']);
		expect(file?.symbols[0]?.changedLines).toEqual([1, 2]);
		expect(result.impact.files).toContain('src/main.ts');
		expect(result.impact.tests).toContain('src/util.spec.ts');
	});

	test('a symbol is reported only when a hunk intersects its span', () => {
		const diff = [
			'--- a/src/util.ts',
			'+++ b/src/util.ts',
			'@@ -8,1 +8,1 @@',
			'+internal tweak',
		].join('\n');
		const result = getDiffContext(makeGraph(), { diff });
		expect(result.files[0]?.symbols.map((s) => s.symbol)).toEqual(['internal']);
	});

	test('duplicate sections for one file merge into a single entry', () => {
		const diff = [
			'diff --git a/src/util.ts b/src/util.ts',
			'--- a/src/util.ts',
			'+++ b/src/util.ts',
			'@@ -1,1 +1,1 @@',
			'+a',
			'diff --git a/src/util.ts b/src/util.ts',
			'--- a/src/util.ts',
			'+++ b/src/util.ts',
			'@@ -4,1 +4,1 @@',
			'+b',
		].join('\n');
		const result = getDiffContext(makeGraph(), { diff });
		expect(result.files).toHaveLength(1);
		expect(result.files[0]?.symbols.map((s) => s.symbol).sort()).toEqual([
			'add',
			'sub',
		]);
		// Duplicate +++ headers for one path are merges, not truncation drops.
		expect(result.truncated).toBe(false);
		expect(result.budget.dropped).toBe(0);
		expect(result.warnings.join('\n')).not.toContain('file parse capped');
	});

	test('multiple --- lines before a +++ do not lose the earlier files', () => {
		const diff = [
			'--- a/src/main.ts',
			'--- a/src/util.ts',
			'+++ b/src/util.ts',
			'@@ -1,1 +1,1 @@',
			'+changed',
		].join('\n');
		const result = getDiffContext(makeGraph(), { diff });
		const names = result.files.map((f) => f.file).sort();
		// The +++ names util.ts (hunk entry); the orphaned old-side name for
		// main.ts must survive as a file-granularity entry, not vanish.
		expect(names).toEqual(['src/main.ts', 'src/util.ts']);
		const main = result.files.find((f) => f.file === 'src/main.ts');
		expect(main?.note).toContain('file-level granularity');
		const util = result.files.find((f) => f.file === 'src/util.ts');
		expect(util?.symbols.map((s) => s.symbol)).toEqual(['add']);
	});

	test('a rename section keeps both the old and new paths', () => {
		const diff = [
			'diff --git a/src/main.ts b/src/renamed.ts',
			'--- a/src/main.ts',
			'+++ b/src/renamed.ts',
			'@@ -1,1 +1,1 @@',
			'+moved',
		].join('\n');
		const graph = makeGraph();
		graph.nodes[abs('src/renamed.ts')] = node('src/renamed.ts', {
			exports: ['moved'],
			ranges: { moved: { startLine: 1, endLine: 1 } },
		});
		const result = getDiffContext(graph, { diff });
		const names = result.files.map((f) => f.file).sort();
		expect(names).toEqual(['src/main.ts', 'src/renamed.ts']);
	});

	test('deleted files (+++ /dev/null) still appear as file-level entries', () => {
		const diff = [
			'diff --git a/src/main.ts b/src/main.ts',
			'--- a/src/main.ts',
			'+++ /dev/null',
			'@@ -1,1 +0,0 @@',
			'-gone',
		].join('\n');
		const result = getDiffContext(makeGraph(), { diff });
		expect(result.files.map((f) => f.file)).toEqual(['src/main.ts']);
		expect(result.files[0]?.known).toBe(true);
	});

	test('unparseable diff throws for the tool layer to envelope', () => {
		expect(() =>
			getDiffContext(makeGraph(), { diff: 'just some text\nno headers' }),
		).toThrow(/no parseable file headers/);
	});

	test('PRR-004: added body lines starting with "++ " are not file headers', () => {
		// A real diff of a file that ADDS a line whose content is '++ x' emits
		// the body line '+++ x' — byte-identical to a file header. The
		// hunk-state guard must keep it in the body (empirical repro: without
		// the guard this produced a phantom file "x" and derailed the hunk).
		const diff = [
			'diff --git a/src/util.ts b/src/util.ts',
			'--- a/src/util.ts',
			'+++ b/src/util.ts',
			'@@ -1,3 +1,4 @@',
			' context line',
			'+added normal line',
			'+++ x',
			'+another added line',
		].join('\n');
		const result = getDiffContext(makeGraph(), { diff });
		expect(result.files.map((f) => f.file)).toEqual(['src/util.ts']);
		expect(result.files[0]?.symbols.map((s) => s.symbol).sort()).toEqual([
			'add',
			'sub',
		]);
	});

	test('PRR-018: CRLF diffs parse identically', () => {
		const diff = [
			'--- a/src/util.ts',
			'+++ b/src/util.ts',
			'@@ -1,1 +1,1 @@',
			'+crlf change',
		].join('\r\n');
		const result = getDiffContext(makeGraph(), { diff });
		expect(result.files[0]?.symbols.map((s) => s.symbol)).toEqual(['add']);
	});

	test('PRR-018: count-less hunk headers default to one line', () => {
		const diff = [
			'--- a/src/util.ts',
			'+++ b/src/util.ts',
			'@@ -4 +4 @@',
			'+no count segment',
		].join('\n');
		const result = getDiffContext(makeGraph(), { diff });
		expect(result.files[0]?.symbols.map((s) => s.symbol)).toEqual(['sub']);
		expect(result.files[0]?.symbols[0]?.changedLines).toEqual([4]);
	});

	test('PRR-018: whitelisted space-bearing paths survive sanitization', () => {
		const graph = makeGraph();
		graph.nodes[abs('my src/a file.ts')] = node('my src/a file.ts', {
			exports: ['spaced'],
			ranges: { spaced: { startLine: 1, endLine: 1 } },
		});
		const diff = [
			'--- a/my src/a file.ts',
			'+++ b/my src/a file.ts',
			'@@ -1,1 +1,1 @@',
			'+spaced change',
		].join('\n');
		const result = getDiffContext(graph, { diff });
		expect(result.files[0]?.file).toBe('my src/a file.ts');
		expect(result.files[0]?.symbols.map((s) => s.symbol)).toEqual(['spaced']);
	});
});

describe('getDiffContext: files mode', () => {
	test('lists all symbols at file granularity with a note', () => {
		const result = getDiffContext(makeGraph(), { files: ['src/util.ts'] });
		expect(result.granularity).toBe('file');
		const file = result.files[0];
		expect(file?.symbols.map((s) => s.symbol).sort()).toEqual([
			'add',
			'internal',
			'sub',
		]);
		expect(file?.symbols.every((s) => s.changedLines.length === 0)).toBe(true);
		expect(file?.note).toContain('file-level granularity');
	});

	test('unknown files are reported as not-in-graph rather than dropped', () => {
		const result = getDiffContext(makeGraph(), {
			files: ['src/brand-new.ts'],
		});
		expect(result.files[0]).toMatchObject({
			file: 'src/brand-new.ts',
			known: false,
			symbols: [],
		});
		expect(result.files[0]?.note).toContain('not present in graph');
	});

	test('neither files nor diff throws', () => {
		expect(() => getDiffContext(makeGraph(), {})).toThrow(
			/requires `files` or `diff`/,
		);
	});
});

describe('getDiffContext: unsafe diff paths', () => {
	test('traversal paths inside the diff are skipped with a warning', () => {
		const diff = [
			'--- a/../../../etc/passwd',
			'+++ b/../../../etc/passwd',
			'@@ -1,1 +1,1 @@',
			'+x',
		].join('\n');
		const result = getDiffContext(makeGraph(), { diff });
		expect(result.files).toEqual([]);
		expect(result.warnings.join('\n')).toContain(
			'skipped unsafe or non-graph path',
		);
		// OW-1: an unsafe-path skip is a DROP — the budget envelope must not
		// report a false all-clear alongside the warning.
		expect(result.truncated).toBe(true);
		expect(result.budget.dropped).toBeGreaterThanOrEqual(1);
	});

	test('absolute and drive-letter paths in the diff are skipped', () => {
		const diff = [
			'--- a/C:/Windows/system32/x.ts',
			'+++ b/C:/Windows/system32/x.ts',
			'@@ -1,1 +1,1 @@',
			'+x',
		].join('\n');
		const result = getDiffContext(makeGraph(), { diff });
		expect(result.files).toEqual([]);
		expect(result.warnings.join('\n')).toContain('skipped unsafe');
		expect(result.budget.dropped).toBeGreaterThanOrEqual(1);
	});
});

describe('getDiffContext: bounding', () => {
	test('top_n caps symbols per file and reports drops', () => {
		const diff = [
			'--- a/src/util.ts',
			'+++ b/src/util.ts',
			'@@ -1,9 +1,9 @@',
			'+whole file churn',
		].join('\n');
		const result = getDiffContext(makeGraph(), { diff, topN: 2 });
		expect(result.files[0]?.symbols).toHaveLength(2);
		expect(result.warnings.join('\n')).toContain(
			'omitted in src/util.ts by top_n=2',
		);
		// OW-1: per-file symbol drops roll into the top-level budget.
		expect(result.truncated).toBe(true);
		expect(result.budget.dropped).toBeGreaterThanOrEqual(1);
	});

	test('changedLines per symbol are capped', () => {
		const graph = makeGraph();
		graph.nodes[abs('src/big.ts')] = node('src/big.ts', {
			ranges: { wide: { startLine: 1, endLine: 500 } },
		});
		const diff = [
			'--- a/src/big.ts',
			'+++ b/src/big.ts',
			'@@ -1,400 +1,400 @@',
			'+massive',
		].join('\n');
		const result = getDiffContext(graph, { diff });
		const wide = result.files[0]?.symbols[0];
		expect(wide?.changedLines.length).toBeLessThanOrEqual(50);
	});

	test('PRR-009: diffs with more than 50 files truncate with drop accounting', () => {
		const sections = Array.from({ length: 51 }, (_, i) =>
			[
				`--- a/gen/f${i}.ts`,
				`+++ b/gen/f${i}.ts`,
				'@@ -1,0 +1,1 @@',
				'+new',
			].join('\n'),
		);
		const result = getDiffContext(makeGraph(), { diff: sections.join('\n') });
		expect(result.files).toHaveLength(50);
		expect(result.truncated).toBe(true);
		expect(result.budget.dropped).toBeGreaterThanOrEqual(1);
		expect(result.warnings.join('\n')).toContain(
			'diff file parse capped at 50 files (51 seen)',
		);
	});

	test('PRR-009: diffs with more than 200 hunks truncate with a warning', () => {
		const hunks = Array.from(
			{ length: 201 },
			(_, i) => `@@ -1,0 +${i + 1},1 @@\n+line ${i}`,
		);
		const diff = ['--- a/src/util.ts', '+++ b/src/util.ts', ...hunks].join(
			'\n',
		);
		const result = getDiffContext(makeGraph(), { diff });
		expect(result.warnings.join('\n')).toContain(
			'diff hunk parse capped at 200 hunks',
		);
	});
});
