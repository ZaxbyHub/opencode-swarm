import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	getContextPack,
	normalizeGraphPath,
	type RepoGraph,
} from '../../../src/tools/repo-graph';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

let tempDir: string;

beforeEach(() => {
	tempDir = canonicalMkdtemp('cp-cov-');
});

afterEach(() => {
	fs.rmSync(tempDir, { recursive: true, force: true });
});

function makeGraph(opts: {
	files: {
		moduleName: string;
		exports: string[];
		exportRanges?: Record<string, { startLine: number; endLine: number }>;
	}[];
	symbolEdges?: {
		fromFile: string;
		fromSymbol: string;
		toFile: string;
		toSymbol: string;
	}[];
}): RepoGraph {
	const nodes: Record<string, any> = {};
	for (const f of opts.files) {
		const absPath = normalizeGraphPath(path.resolve(tempDir, f.moduleName));
		nodes[absPath] = {
			filePath: absPath,
			moduleName: f.moduleName,
			exports: f.exports,
			exportRanges: f.exportRanges,
			imports: [],
			language: 'typescript',
			mtime: '2024-01-01T00:00:00Z',
		};
	}
	const symbolEdges = (opts.symbolEdges ?? []).map((e) => ({
		...e,
		fromFile: normalizeGraphPath(path.resolve(tempDir, e.fromFile)),
		toFile: normalizeGraphPath(path.resolve(tempDir, e.toFile)),
	}));
	return {
		schema_version: '1.4.0',
		workspaceRoot: tempDir,
		nodes,
		edges: [],
		metadata: {
			generatedAt: '2024-01-01T00:00:00Z',
			generator: 'test',
			nodeCount: opts.files.length,
			edgeCount: 0,
		},
		symbolEdges,
	};
}

function writeFile(rel: string, content: string): void {
	const filePath = path.join(tempDir, rel);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content);
}

function singleNodeGraph(
	rel: string,
	symbol: string,
	range: { startLine: number; endLine: number },
): RepoGraph {
	return makeGraph({
		files: [
			{
				moduleName: rel,
				exports: [symbol],
				exportRanges: { [symbol]: range },
			},
		],
	});
}

describe('getContextPack coverage + warnings (issue #1533)', () => {
	function chainGraph(): RepoGraph {
		return makeGraph({
			files: [
				{
					moduleName: 'a.ts',
					exports: ['foo'],
					exportRanges: { foo: { startLine: 1, endLine: 10 } },
				},
				{
					moduleName: 'b.ts',
					exports: ['bar'],
					exportRanges: { bar: { startLine: 11, endLine: 20 } },
				},
				{
					moduleName: 'c.ts',
					exports: ['baz'],
					exportRanges: { baz: { startLine: 21, endLine: 30 } },
				},
			],
			symbolEdges: [
				{
					fromFile: 'b.ts',
					fromSymbol: 'bar',
					toFile: 'a.ts',
					toSymbol: 'foo',
				},
				{
					fromFile: 'c.ts',
					fromSymbol: 'baz',
					toFile: 'a.ts',
					toSymbol: 'foo',
				},
			],
		});
	}

	test('span-only mode still returns coverage and warnings', () => {
		const result = getContextPack(chainGraph(), 'a.ts', 'foo');
		expect(result.snippets).toBeUndefined();
		expect(result.spans[0]!.text).toBeUndefined();
		expect(result.coverage).toEqual({
			reachedSymbols: 3,
			returnedSymbols: 3,
			omittedByBudget: 0,
			unresolvedEdges: 0,
			lowConfidenceEdges: 0,
		});
		expect(result.warnings).toEqual([]);
	});

	test('budget truncation preserves the target first and reports omission', () => {
		const result = getContextPack(chainGraph(), 'a.ts', 'foo', {
			maxTokens: 250,
		});
		expect(result.truncated).toBe(true);
		expect(result.spans).toHaveLength(2);
		expect(result.spans[0]!.symbol).toBe('foo');
		expect(result.coverage).toMatchObject({
			reachedSymbols: 3,
			returnedSymbols: 2,
			omittedByBudget: 1,
		});
		expect(
			result.warnings!.some((w) => w.includes('omitted by token budget')),
		).toBe(true);
	});

	test('a single over-budget target span is still returned with a warning', () => {
		const result = getContextPack(
			singleNodeGraph('a.ts', 'foo', { startLine: 1, endLine: 100 }),
			'a.ts',
			'foo',
			{ maxTokens: 50 },
		);
		expect(result.truncated).toBe(false);
		expect(result.spans).toHaveLength(1);
		expect(result.estimatedTokens).toBe(1200);
		expect(result.warnings!.some((w) => w.includes('exceeds max_tokens'))).toBe(
			true,
		);
	});

	test('unresolved and low-confidence edge destinations are counted', () => {
		const graph = makeGraph({
			files: [
				{
					moduleName: 'a.ts',
					exports: ['foo'],
					exportRanges: { foo: { startLine: 1, endLine: 3 } },
				},
				{ moduleName: 'b.ts', exports: ['helper'], exportRanges: {} },
			],
			symbolEdges: [
				{
					fromFile: 'ghost.ts',
					fromSymbol: 'gone',
					toFile: 'a.ts',
					toSymbol: 'foo',
				},
				{
					fromFile: 'b.ts',
					fromSymbol: 'helper',
					toFile: 'a.ts',
					toSymbol: 'foo',
				},
			],
		});
		const result = getContextPack(graph, 'a.ts', 'foo');
		expect(result.coverage!.unresolvedEdges).toBe(1);
		expect(result.coverage!.lowConfidenceEdges).toBe(1);
		expect(
			result.warnings!.some((w) => w.includes('not present in the graph')),
		).toBe(true);
		expect(
			result.warnings!.some((w) => w.includes('lack an export range')),
		).toBe(true);
	});

	test('missing source file: warning, no snippet, span kept (fail-open)', () => {
		const result = getContextPack(
			singleNodeGraph('src/missing.ts', 'gone', { startLine: 1, endLine: 3 }),
			'src/missing.ts',
			'gone',
			{ includeSource: true, directory: tempDir },
		);
		expect(result.spans[0]!.note).toBe('source read failed');
		expect(result.snippets).toEqual([]);
		expect(result.warnings!.some((w) => w.includes('source read failed'))).toBe(
			true,
		);
	});

	test('outside-workspace span file fails containment with note + warning', () => {
		const otherDir = canonicalMkdtemp('cp-outside-');
		try {
			fs.mkdirSync(otherDir, { recursive: true });
			fs.writeFileSync(
				path.join(otherDir, 'secret.ts'),
				'export const s = 1;\n',
			);
			const outsidePath = normalizeGraphPath(path.join(otherDir, 'secret.ts'));
			const graph: RepoGraph = {
				schema_version: '1.4.0',
				workspaceRoot: tempDir,
				nodes: {
					[outsidePath]: {
						filePath: outsidePath,
						moduleName: 'secret.ts',
						exports: ['s'],
						exportRanges: { s: { startLine: 1, endLine: 1 } },
						imports: [],
						language: 'typescript',
						mtime: '2024-01-01T00:00:00Z',
					},
				},
				edges: [],
				metadata: {
					generatedAt: '1',
					generator: 't',
					nodeCount: 1,
					edgeCount: 0,
				},
			};
			const result = getContextPack(graph, outsidePath, 's', {
				includeSource: true,
				directory: tempDir,
			});
			expect(result.spans[0]!.note).toBe('source outside workspace');
			expect(result.spans[0]!.text).toBeUndefined();
			expect(result.snippets).toEqual([]);
			expect(
				result.warnings!.some((w) => w.includes('source outside workspace')),
			).toBe(true);
		} finally {
			fs.rmSync(otherDir, { recursive: true, force: true });
		}
	});

	test('per-span failure warnings are capped at five details plus an aggregate', () => {
		// Seven spans whose source files do not exist: the first five get
		// individual warnings, the rest collapse into one aggregate line.
		const files = Array.from({ length: 7 }, (_, i) => ({
			moduleName: `m${i}.ts`,
			exports: [`sym${i}`],
			exportRanges: { [`sym${i}`]: { startLine: 1, endLine: 2 } },
		}));
		const symbolEdges = files.slice(1).map((f, i) => ({
			fromFile: f.moduleName,
			fromSymbol: `sym${i + 1}`,
			toFile: 'm0.ts',
			toSymbol: 'sym0',
		}));
		const result = getContextPack(
			makeGraph({ files, symbolEdges }),
			'm0.ts',
			'sym0',
			{
				includeSource: true,
				directory: tempDir,
			},
		);
		const details = result.warnings!.filter((w) =>
			w.startsWith('source read failed for '),
		);
		expect(details).toHaveLength(5);
		expect(
			result.warnings!.includes('... and 2 more source read failed cases'),
		).toBe(true);
		expect(result.snippets).toEqual([]);
	});

	test('exactly five failures produce five details and no aggregate line', () => {
		const files = Array.from({ length: 5 }, (_, i) => ({
			moduleName: `e${i}.ts`,
			exports: [`sym${i}`],
			exportRanges: { [`sym${i}`]: { startLine: 1, endLine: 2 } },
		}));
		const symbolEdges = files.slice(1).map((f, i) => ({
			fromFile: f.moduleName,
			fromSymbol: `sym${i + 1}`,
			toFile: 'e0.ts',
			toSymbol: 'sym0',
		}));
		const result = getContextPack(
			makeGraph({ files, symbolEdges }),
			'e0.ts',
			'sym0',
			{ includeSource: true, directory: tempDir },
		);
		const details = result.warnings!.filter((w) =>
			w.startsWith('source read failed for '),
		);
		expect(details).toHaveLength(5);
		expect(result.warnings!.some((w) => w.startsWith('... and'))).toBe(false);
	});

	test('target without export range counts as low-confidence and stays snippet-free in body mode', () => {
		writeFile('src/a.ts', 'export function target(x) {\n  return x;\n}\n');
		const graph = makeGraph({
			files: [
				{ moduleName: 'src/a.ts', exports: ['target'], exportRanges: {} },
			],
		});
		const result = getContextPack(graph, 'src/a.ts', 'target', {
			includeSource: true,
			sourceMode: 'body',
		});
		expect(result.spans[0]!.note).toBe('internal symbol — span unavailable');
		expect(result.coverage!.lowConfidenceEdges).toBe(1);
		expect(result.snippets).toEqual([]);
		expect(
			result.warnings!.some((w) => w.includes('lack an export range')),
		).toBe(true);
	});

	test('directory option falls back to graph.workspaceRoot', () => {
		writeFile(
			'src/util.ts',
			'export function add(a: number, b: number) {\n  return a + b;\n}\n',
		);
		const graph = makeGraph({
			files: [
				{
					moduleName: 'src/util.ts',
					exports: ['add'],
					exportRanges: { add: { startLine: 1, endLine: 3 } },
				},
			],
		});
		// No directory option: extraction must resolve against workspaceRoot.
		const result = getContextPack(graph, 'src/util.ts', 'add', {
			includeSource: true,
		});
		expect(result.snippets![0]!.text).toContain('function add');
	});

	test('schema below 1.2.0: zeroed coverage + rebuild warning, note preserved', () => {
		const graph = chainGraph();
		graph.schema_version = '1.1.0';
		const result = getContextPack(graph, 'a.ts', 'foo');
		expect(result.schemaSupported).toBe(false);
		expect(result.note).toBe('rebuild with repo_map action="build"');
		expect(result.coverage).toEqual({
			reachedSymbols: 0,
			returnedSymbols: 0,
			omittedByBudget: 0,
			unresolvedEdges: 0,
			lowConfidenceEdges: 0,
		});
		expect(
			result.warnings!.some((w) => w.includes('graph schema 1.2.0+ required')),
		).toBe(true);
	});
});

// Symlink-escape hardening: directory junctions on Windows (file symlinks
// need admin), directory symlinks elsewhere. Sandboxes that disallow link
// creation skip this test.
function canCreateLinks(): boolean {
	const dir = canonicalMkdtemp('cp-link-');
	try {
		const targetDir = path.join(dir, 'realdir');
		fs.mkdirSync(targetDir, { recursive: true });
		fs.writeFileSync(path.join(targetDir, 'real.ts'), 'export const r = 1;\n');
		const linkDir = path.join(dir, 'linkdir');
		fs.symlinkSync(
			targetDir,
			linkDir,
			process.platform === 'win32' ? 'junction' : 'dir',
		);
		return fs.existsSync(path.join(linkDir, 'real.ts'));
	} catch {
		return false;
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}
const LINK_CAPABLE = canCreateLinks();

describe('getContextPack containment hardening (issue #1533)', () => {
	test.skipIf(!LINK_CAPABLE)(
		'symlinked directory inside the workspace pointing outside fails closed',
		() => {
			const outsideDir = canonicalMkdtemp('cp-esc-');
			try {
				fs.mkdirSync(outsideDir, { recursive: true });
				const outsideFile = path.join(outsideDir, 'escaped.ts');
				fs.writeFileSync(outsideFile, 'export const secret = 42;\n');
				const linkDir = path.join(tempDir, 'linkeddir');
				fs.symlinkSync(
					outsideDir,
					linkDir,
					process.platform === 'win32' ? 'junction' : 'dir',
				);
				const linkGraphPath = normalizeGraphPath(
					path.join(linkDir, 'escaped.ts'),
				);
				const graph: RepoGraph = {
					schema_version: '1.4.0',
					workspaceRoot: tempDir,
					nodes: {
						[linkGraphPath]: {
							filePath: linkGraphPath,
							moduleName: 'linkeddir/escaped.ts',
							exports: ['secret'],
							exportRanges: { secret: { startLine: 1, endLine: 1 } },
							imports: [],
							language: 'typescript',
							mtime: '2024-01-01T00:00:00Z',
						},
					},
					edges: [],
					metadata: {
						generatedAt: '1',
						generator: 't',
						nodeCount: 1,
						edgeCount: 0,
					},
				};
				const result = getContextPack(graph, linkGraphPath, 'secret', {
					includeSource: true,
					directory: tempDir,
				});
				expect(result.spans[0]!.note).toBe('source outside workspace');
				expect(result.spans[0]!.text).toBeUndefined();
				expect(result.snippets).toEqual([]);
				expect(
					result.warnings!.some((w) => w.includes('source outside workspace')),
				).toBe(true);
			} finally {
				fs.rmSync(outsideDir, { recursive: true, force: true });
			}
		},
	);
});
