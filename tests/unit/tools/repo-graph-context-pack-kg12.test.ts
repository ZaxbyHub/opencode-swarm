import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	type ContextPackSnippet,
	getContextPack,
	normalizeGraphPath,
	type RepoGraph,
} from '../../../src/tools/repo-graph';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

let tempDir: string;

beforeEach(() => {
	tempDir = canonicalMkdtemp('cp-kg12-');
});

afterEach(() => {
	fs.rmSync(tempDir, { recursive: true, force: true });
});

function makeGraph(opts: {
	files: {
		moduleName: string;
		exports: string[];
		language?: string;
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
			language: f.language ?? 'typescript',
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

const sha = (text: string): string =>
	createHash('sha256').update(text).digest('hex');

function singleNodeGraph(
	rel: string,
	symbol: string,
	range: { startLine: number; endLine: number },
	language = 'typescript',
): RepoGraph {
	return makeGraph({
		files: [
			{
				moduleName: rel,
				exports: [symbol],
				language,
				exportRanges: { [symbol]: range },
			},
		],
	});
}

describe('getContextPack snippets (issue #1533)', () => {
	const UTIL_TS =
		'export function add(a: number, b: number) {\n  return a + b;\n}\n';

	test('TS target snippet carries hash, confidence, line range, mode full', () => {
		writeFile('src/util.ts', UTIL_TS);
		const result = getContextPack(
			singleNodeGraph('src/util.ts', 'add', { startLine: 1, endLine: 3 }),
			'src/util.ts',
			'add',
			{ includeSource: true, directory: tempDir },
		);
		expect(result.snippets).toHaveLength(1);
		const sn = result.snippets![0]!;
		expect(sn).toMatchObject({
			file: normalizeGraphPath(path.join(tempDir, 'src/util.ts')),
			symbol: 'add',
			startLine: 1,
			endLine: 3,
			mode: 'full',
			confidence: 1.0,
		});
		expect(sn.text).toContain('function add');
		expect(sn.hash).toBe(sha(sn.text!));
	});

	test('source_mode signature extracts only the signature line', () => {
		writeFile('src/util.ts', UTIL_TS);
		const result = getContextPack(
			singleNodeGraph('src/util.ts', 'add', { startLine: 1, endLine: 3 }),
			'src/util.ts',
			'add',
			{ includeSource: true, sourceMode: 'signature', directory: tempDir },
		);
		expect(result.snippets![0]!.mode).toBe('signature');
		expect(result.snippets![0]!.text).toBe(
			'export function add(a: number, b: number) {',
		);
		expect(result.snippets![0]!.hash).toBe(
			sha('export function add(a: number, b: number) {'),
		);
	});

	test('python signature skips decorators and stops at the def colon', () => {
		writeFile('src/svc.py', '@cached\ndef public_fn(a):\n    return a\n');
		const result = getContextPack(
			singleNodeGraph(
				'src/svc.py',
				'public_fn',
				{ startLine: 1, endLine: 3 },
				'python',
			),
			'src/svc.py',
			'public_fn',
			{ includeSource: true, sourceMode: 'signature', directory: tempDir },
		);
		expect(result.snippets![0]!.text).toBe('def public_fn(a):');
		expect(result.snippets![0]!.mode).toBe('signature');
	});

	test('ruby signature emits only the def line (no-terminator language)', () => {
		writeFile('src/svc.rb', 'def plain(x)\n  x * 2\nend\n');
		const result = getContextPack(
			singleNodeGraph(
				'src/svc.rb',
				'plain',
				{ startLine: 1, endLine: 3 },
				'ruby',
			),
			'src/svc.rb',
			'plain',
			{ includeSource: true, sourceMode: 'signature', directory: tempDir },
		);
		expect(result.snippets![0]!.text).toBe('def plain(x)');
	});

	test('mixed: near spans get bodies, periphery gets signatures; body: all bodies', () => {
		writeFile(
			'src/a.ts',
			'export function target(x: number) {\n  return x + 1;\n}\n',
		);
		writeFile(
			'src/b.ts',
			'export function helper() {\n  return target(1);\n}\n',
		);
		writeFile('src/c.ts', 'export function leaf() {\n  return 2;\n}\n');
		const graph = makeGraph({
			files: [
				{
					moduleName: 'src/a.ts',
					exports: ['target'],
					exportRanges: { target: { startLine: 1, endLine: 3 } },
				},
				{
					moduleName: 'src/b.ts',
					exports: ['helper'],
					exportRanges: { helper: { startLine: 1, endLine: 3 } },
				},
				{
					moduleName: 'src/c.ts',
					exports: ['leaf'],
					exportRanges: { leaf: { startLine: 1, endLine: 2 } },
				},
			],
			symbolEdges: [
				{
					fromFile: 'src/b.ts',
					fromSymbol: 'helper',
					toFile: 'src/a.ts',
					toSymbol: 'target',
				},
				{
					fromFile: 'src/b.ts',
					fromSymbol: 'helper',
					toFile: 'src/c.ts',
					toSymbol: 'leaf',
				},
			],
		});
		// BFS from a.target: reverse edge reaches b.helper (depth 1, span mode
		// full); forward from b.helper reaches c.leaf (depth 2 == maxDepth,
		// span mode signature).
		const bySymbol = (snippets: ContextPackSnippet[] | undefined) =>
			new Map((snippets ?? []).map((s) => [s.symbol, s]));

		const mixed = getContextPack(graph, 'src/a.ts', 'target', {
			includeSource: true,
			directory: tempDir,
		});
		const mixedMap = bySymbol(mixed.snippets);
		expect(mixedMap.get('target')!.mode).toBe('full');
		expect(mixedMap.get('target')!.text).toContain('return x + 1');
		expect(mixedMap.get('helper')!.mode).toBe('full');
		expect(mixedMap.get('leaf')!.mode).toBe('signature');
		expect(mixedMap.get('leaf')!.text).toBe('export function leaf() {');
		expect(mixedMap.get('target')!.confidence).toBe(1.0);
		expect(mixedMap.get('leaf')!.confidence).toBe(0.8);

		const body = getContextPack(graph, 'src/a.ts', 'target', {
			includeSource: true,
			sourceMode: 'body',
			directory: tempDir,
		});
		const bodyMap = bySymbol(body.snippets);
		expect(bodyMap.get('leaf')!.mode).toBe('full');
		expect(bodyMap.get('leaf')!.text).toContain('return 2');
	});

	test('summary mode when the body is capped at 80 lines', () => {
		const lines = Array.from({ length: 200 }, (_, i) => `// line ${i + 1}`);
		writeFile('src/big.ts', `${lines.join('\n')}\n`);
		const result = getContextPack(
			singleNodeGraph('src/big.ts', 'big', { startLine: 1, endLine: 200 }),
			'src/big.ts',
			'big',
			{ includeSource: true, directory: tempDir },
		);
		const sn = result.snippets![0]!;
		expect(sn.mode).toBe('summary');
		expect(sn.text!.split('\n')).toHaveLength(80);
	});
});
