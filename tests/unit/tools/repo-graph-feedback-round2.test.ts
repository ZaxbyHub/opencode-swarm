/**
 * Regression pins for the round-2 PR feedback on issue #1529.
 *
 * Each test here corresponds to a finding that was VERIFIED by measurement
 * before any code changed, and each dies under mutation of the specific branch
 * it covers. Findings that verification DISPROVED deliberately have no test —
 * see `.agents/issue-traces/1529-jvm-dotnet-symbol-graph/fb2-ledger.md`.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { extractFileSymbols } from '../../../src/lang/symbol-graph';
import { buildWorkspaceGraphAsync } from '../../../src/tools/repo-graph/builder';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

function withWorkspace<T>(
	files: Record<string, string>,
	fn: (root: string) => Promise<T>,
): Promise<T> {
	const root = canonicalMkdtemp('fb2-');
	for (const [rel, body] of Object.entries(files)) {
		const full = path.join(root, rel);
		fs.mkdirSync(path.dirname(full), { recursive: true });
		fs.writeFileSync(full, body);
	}
	return fn(root).finally(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});
}

describe('F-01: default-export normalization is scoped to the owning declaration', () => {
	// `isNodeInside` is pure span containment, so every member of
	// `export default class Foo { ... }` was renamed to `default` and marked
	// exported — destroying the real name `Foo`. Introduced for JavaScript by
	// this PR's `method_definition` capture; TypeScript had it already.
	for (const grammar of ['javascript', 'typescript']) {
		test(`${grammar}: only the class itself becomes 'default'`, async () => {
			const facts = await extractFileSymbols(
				grammar,
				'export default class Foo {\n  bar() {}\n  static baz() {}\n  get qux() { return 1; }\n}\n',
			);
			const names = (facts?.defs ?? []).map((d) => d.name);
			expect(names).toEqual(['default', 'bar', 'baz', 'qux']);
		});
	}

	test('javascript: a named export class is unaffected', async () => {
		const facts = await extractFileSymbols(
			'javascript',
			'export class Foo {\n  bar() {}\n}\n',
		);
		expect((facts?.defs ?? []).map((d) => d.name)).toEqual(['Foo', 'bar']);
	});

	test('javascript: export default function still normalizes', async () => {
		const facts = await extractFileSymbols(
			'javascript',
			'export default function f() {}\n',
		);
		expect((facts?.defs ?? []).map((d) => d.name)).toEqual(['default']);
	});
});

describe('F-11: exportRanges survives Object.prototype member names', () => {
	// The collision check read `exportRanges[d.name]` on a plain object, so a def
	// named `toString` matched the INHERITED Object.prototype.toString, and the
	// "name already seen" branch silently dropped the real def. `toString` is one
	// of the most common method names in Java/Kotlin/C#.
	test('java members named after Object.prototype keys are all retained', async () => {
		await withWorkspace(
			{
				'Proto.java':
					'package com.example;\n\npublic class Proto {\n    public void normalMethod() { int q = 0; }\n    public void toString2() { int a = 1; }\n    public void constructor() { int y = 2; }\n    public void toString() { int z = 3; }\n    public void hasOwnProperty() { int w = 4; }\n}\n',
			},
			async (root) => {
				const graph = await buildWorkspaceGraphAsync(root);
				const node = Object.values(graph.nodes)[0];
				const ranges = node.exportRanges ?? {};
				for (const name of [
					'toString',
					'constructor',
					'hasOwnProperty',
					'normalMethod',
				]) {
					expect(Object.hasOwn(ranges, name)).toBe(true);
				}
			},
		);
	});
});

describe('F-06: no edge claims a node that was never indexed', () => {
	// Import resolution does not consult SKIP_DIRECTORIES but the walker does, so
	// a real file inside `node_modules` resolved and produced an edge marked
	// `targetKind: 'node'` with no corresponding node.
	test('an edge into a walker-skipped directory is reclassified as asset', async () => {
		await withWorkspace(
			{
				'src/node_modules/com/example/Foo.java':
					'package node_modules.com.example;\n\npublic class Foo {}\n',
				'src/app/File0.java':
					'package app;\n\nimport node_modules.com.example.Foo;\n\npublic class File0 {}\n',
			},
			async (root) => {
				const graph = await buildWorkspaceGraphAsync(root);
				const indexed = new Set(
					Object.values(graph.nodes).map((n) =>
						n.filePath.replace(/\\/g, '/').toLowerCase(),
					),
				);
				for (const edge of graph.edges) {
					if (edge.targetKind !== 'node') continue;
					expect(
						indexed.has(edge.target.replace(/\\/g, '/').toLowerCase()),
					).toBe(true);
				}
				expect(graph.edges.length).toBeGreaterThan(0);
			},
		);
	});

	test('an ordinary resolved import keeps targetKind node', async () => {
		// Guards the fix itself: comparing raw paths against the forward-slash
		// node keys is false for EVERY edge on Windows, which would silently
		// reclassify the whole graph to 'asset' and disable importer/dead-export
		// queries. This test fails if that normalization is removed.
		await withWorkspace(
			{
				'src/lib.ts': 'export function used() { return 1; }\n',
				'src/app.ts':
					"import { used } from './lib';\nexport const y = used();\n",
			},
			async (root) => {
				const graph = await buildWorkspaceGraphAsync(root);
				const edge = graph.edges.find((e) => e.target.endsWith('lib.ts'));
				expect(edge?.targetKind).toBe('node');
			},
		);
	});
});

describe('round-2 import-parsing fixes', () => {
	// A single-line bare Go import captured the literal keyword `import` as an
	// alias, so the single-line and block forms disagreed.
	test('go: a bare single-line import binds nothing, like the block form', async () => {
		const single = await extractFileSymbols(
			'go',
			'package p\n\nimport "fmt"\n',
		);
		expect(single?.imports[0]?.bindings).toEqual([]);
		const block = await extractFileSymbols(
			'go',
			'package p\n\nimport (\n\t"fmt"\n)\n',
		);
		expect(block?.imports[0]?.bindings).toEqual([]);
	});

	test('go: an aliased import still binds', async () => {
		const facts = await extractFileSymbols(
			'go',
			'package p\n\nimport f2 "os"\n',
		);
		expect(facts?.imports[0]?.bindings).toEqual([
			{ imported: 'os', local: 'f2' },
		]);
	});

	// `finalDottedSegment` split on the last dot only, so a constructed generic
	// type produced `List<int>` as the imported NAME — which can never match a
	// declaration in the target file.
	test('csharp: a generic alias RHS binds the bare type name', async () => {
		const facts = await extractFileSymbols(
			'csharp',
			'using L = System.Collections.Generic.List<int>;\n\nnamespace N;\n',
		);
		expect(facts?.imports[0]?.bindings).toEqual([
			{ imported: 'List', local: 'L' },
		]);
	});

	test('csharp: a plain alias is unchanged', async () => {
		const facts = await extractFileSymbols(
			'csharp',
			'using A = M.Thing;\n\nnamespace N;\n',
		);
		expect(facts?.imports[0]?.bindings).toEqual([
			{ imported: 'Thing', local: 'A' },
		]);
	});
});
