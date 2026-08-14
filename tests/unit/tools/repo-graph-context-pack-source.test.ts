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
	tempDir = canonicalMkdtemp('cp-src-');
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

describe('getContextPack include_source', () => {
	test('default false: spans have no text field', () => {
		const graph = makeGraph({
			files: [
				{
					moduleName: 'src/util.ts',
					exports: ['add'],
					exportRanges: { add: { startLine: 1, endLine: 3 } },
				},
			],
		});
		const result = getContextPack(graph, 'src/util.ts', 'add');
		expect(result.spans.length).toBeGreaterThan(0);
		expect(result.spans[0].text).toBeUndefined();
		expect(result.sourceIncluded).toBeUndefined();
	});

	test('include_source embeds text from file', () => {
		const filePath = path.join(tempDir, 'src', 'util.ts');
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(
			filePath,
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
		const result = getContextPack(graph, 'src/util.ts', 'add', {
			includeSource: true,
			directory: tempDir,
		});
		expect(result.sourceIncluded).toBe(true);
		expect(result.spans[0].text).toContain('function add');
	});

	test('fail-open on unreadable file', () => {
		const graph = makeGraph({
			files: [
				{
					moduleName: 'src/missing.ts',
					exports: ['gone'],
					exportRanges: { gone: { startLine: 1, endLine: 1 } },
				},
			],
		});
		const result = getContextPack(graph, 'src/missing.ts', 'gone', {
			includeSource: true,
			directory: tempDir,
		});
		expect(result.spans[0].text).toBeUndefined();
		expect(result.spans[0].note).toBe('source read failed');
	});

	test('source text bounded to 80 lines', () => {
		const filePath = path.join(tempDir, 'src', 'big.ts');
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		const lines = Array.from({ length: 200 }, (_, i) => `// line ${i + 1}`);
		fs.writeFileSync(filePath, lines.join('\n'));
		const graph = makeGraph({
			files: [
				{
					moduleName: 'src/big.ts',
					exports: ['big'],
					exportRanges: { big: { startLine: 1, endLine: 200 } },
				},
			],
		});
		const result = getContextPack(graph, 'src/big.ts', 'big', {
			includeSource: true,
			directory: tempDir,
		});
		const textLines = result.spans[0].text?.split('\n') ?? [];
		expect(textLines.length).toBeLessThanOrEqual(80);
	});
});

describe('getContextPack internal-symbol fallback', () => {
	test('non-exported symbol gets signature pointer', () => {
		const graph = makeGraph({
			files: [
				{
					moduleName: 'src/util.ts',
					exports: ['add'],
					exportRanges: { add: { startLine: 1, endLine: 3 } },
				},
				{
					moduleName: 'src/helper.ts',
					exports: ['helper'],
					exportRanges: {},
				},
			],
			symbolEdges: [
				{
					fromFile: 'src/util.ts',
					fromSymbol: 'add',
					toFile: 'src/helper.ts',
					toSymbol: 'internalFn',
				},
			],
		});
		const result = getContextPack(graph, 'src/util.ts', 'add', {
			maxDepth: 2,
		});
		const internal = result.spans.find((s) => s.symbol === 'internalFn');
		expect(internal).toBeDefined();
		expect(internal!.mode).toBe('signature');
		expect(internal!.startLine).toBe(1);
		expect(internal!.note).toBe('internal symbol — span unavailable');
	});

	test('exported symbol still gets full span', () => {
		const graph = makeGraph({
			files: [
				{
					moduleName: 'src/util.ts',
					exports: ['add'],
					exportRanges: { add: { startLine: 1, endLine: 5 } },
				},
			],
		});
		const result = getContextPack(graph, 'src/util.ts', 'add');
		expect(result.spans[0].mode).toBe('full');
		expect(result.spans[0].note).toBeUndefined();
		expect(result.spans[0].startLine).toBe(1);
		expect(result.spans[0].endLine).toBe(5);
	});
});
