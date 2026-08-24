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

describe('F-06b: reconcileEdgeTargetKinds normalizes case, not just separators', () => {
	// `resolveModuleSpecifier` builds `target` by joining the workspace root
	// with the LITERAL specifier text and confirming existence with `existsSync`,
	// which is case-INSENSITIVE on Windows/macOS default filesystems. The walker,
	// meanwhile, records `node.filePath` and the `graph.nodes` key with the file's
	// ACTUAL on-disk casing. A specifier that differs only in case from the real
	// file therefore resolves successfully but does not string-match either map
	// unless the comparison also folds case — exactly what `toComparablePath`
	// does on win32. Without it, every such edge is wrongly reclassified 'asset',
	// silently disabling importer/dead-export queries for it.
	test('an import whose case differs from the file on disk still reconciles to node', async () => {
		await withWorkspace(
			{
				'Foo.ts': 'export function used() { return 1; }\n',
				'app.ts': "import { used } from './foo';\nexport const y = used();\n",
			},
			async (root) => {
				const graph = await buildWorkspaceGraphAsync(root);
				const edge = graph.edges.find((e) =>
					e.target.toLowerCase().endsWith('foo.ts'),
				);
				expect(edge).toBeDefined();
				expect(edge?.targetKind).toBe('node');
			},
		);
	});

	// Guards against a cheap but wrong fix: folding case must not fold DISTINCT
	// paths together. Two files sharing a basename in different directories must
	// stay distinguishable, or the reconciler could mark an edge 'node' by
	// matching the wrong file's node entry.
	test('same basename in two different directories is not confused', async () => {
		await withWorkspace(
			{
				'a/lib.ts': 'export const A = 1;\n',
				'b/lib.ts': 'export const B = 2;\n',
				'a/app.ts': "import { A } from './lib';\nexport const y = A;\n",
			},
			async (root) => {
				const graph = await buildWorkspaceGraphAsync(root);
				const aLib = Object.values(graph.nodes).find((n) =>
					n.filePath.replace(/\\/g, '/').endsWith('a/lib.ts'),
				);
				const bLib = Object.values(graph.nodes).find((n) =>
					n.filePath.replace(/\\/g, '/').endsWith('b/lib.ts'),
				);
				expect(aLib).toBeDefined();
				expect(bLib).toBeDefined();
				const edge = graph.edges.find((e) => e.target === aLib?.filePath);
				expect(edge).toBeDefined();
				expect(edge?.targetKind).toBe('node');
				// The edge must resolve to a/lib.ts specifically, not b/lib.ts.
				expect(edge?.target).not.toBe(bLib?.filePath);
			},
		);
	});
});

describe('Stage B findings: annotation bound and unwired invariant', () => {
	// The header-scan bound was originally applied to the RAW text, so an
	// annotation prefix longer than the limit consumed the whole window and the
	// modifier never entered the scan — turning a `private class` into exported
	// public API that reaches `exports`/`exportLines`/`dead_exports`. 4 KiB
	// annotation payloads are real (a JPA `@Query` holding SQL, a generated
	// `@ApiModelProperty`). Dies if the bound moves back before the strip.
	for (const [grammar, source] of [
		[
			'java',
			(f: string) =>
				`@SuppressWarnings({"${f}"})\nprivate class Hidden { void m() {} }\n`,
		],
		[
			'kotlin',
			(f: string) =>
				`@Deprecated("${f}")\nprivate class Hidden { fun m() {} }\n`,
		],
	] as Array<[string, (f: string) => string]>) {
		test(`${grammar}: a long annotation prefix does not expose a private declaration`, async () => {
			const facts = await extractFileSymbols(grammar, source('x'.repeat(5000)));
			const def = facts?.defs.find((d) => d.name === 'Hidden');
			expect(def?.exported).toBe(false);
			expect(def?.visibilityInfo?.visibility).toBe('private');
		});
	}

	// The sync export collector had the same Object.prototype read as the async
	// one, 750 lines away and unfixed: `exportLines['toString']` returned the
	// inherited function, so the first-wins guard dropped the real line.
	test('sync builder keeps lines for exports named after Object.prototype keys', async () => {
		await withWorkspace(
			{
				'a.ts':
					'export function toString() {}\nexport function valueOf() {}\nexport function ok() {}\n',
			},
			async (root) => {
				const { buildWorkspaceGraph } = await import(
					'../../../src/tools/repo-graph/builder'
				);
				const graph = buildWorkspaceGraph(root);
				const node = Object.values(graph.nodes)[0];
				for (const name of ['toString', 'valueOf', 'ok']) {
					expect(Object.hasOwn(node.exportLines ?? {}, name)).toBe(true);
				}
			},
		);
	});
});

describe('F-06c: the edge-target invariant holds on the incremental path too', () => {
	// `reconcileEdgeTargetKinds` originally ran only on full builds; it is now
	// also called from `finalizeAndSave` so the invariant holds on every path
	// that mutates edges.
	//
	// HONEST LABEL — this is a SMOKE CHECK, not a mutation-proven pin. Removing
	// the `finalizeAndSave` call does NOT make it fail: with this fixture the
	// incremental path never produces a dangling edge for the reconciler to
	// catch, so the wiring is defence-in-depth whose reachable trigger I could
	// not construct. It is kept because it asserts a real invariant over the
	// incremental result, but it must not be cited as evidence that the wiring
	// is covered. Do not "fix" it by weakening the assertion.
	test('an incremental update does not re-introduce a dangling node edge', async () => {
		await withWorkspace(
			{
				'src/node_modules/com/example/Foo.java':
					'package node_modules.com.example;\n\npublic class Foo {}\n',
				'src/app/File0.java':
					'package app;\n\nimport node_modules.com.example.Foo;\n\npublic class File0 {}\n',
			},
			async (root) => {
				const { updateGraphForFiles } = await import(
					'../../../src/tools/repo-graph/incremental'
				);
				await buildWorkspaceGraphAsync(root);
				const changed = path.join(root, 'src', 'app', 'File0.java');
				fs.writeFileSync(
					changed,
					'package app;\n\nimport node_modules.com.example.Foo;\n\npublic class File0 { void added() {} }\n',
				);
				const graph = await updateGraphForFiles(root, [changed]);
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
			},
		);
	});
});

describe('closeout: a long doc comment cannot hide a modifier either', () => {
	// The annotation-only version of the leading skip was already fixed once.
	// Closeout review found the same hole one construct over: a block comment
	// between the annotation and the modifier is not an annotation, so it stayed
	// in the bounded window and consumed the whole budget — reporting a
	// `private class` as exported public API again.
	test('a 5000-char block comment before the modifier keeps it private', async () => {
		const facts = await extractFileSymbols(
			'java',
			`@Ann\n/* ${'x'.repeat(5000)} */\nprivate class Hidden { void m() {} }\n`,
		);
		const def = facts?.defs.find((d) => d.name === 'Hidden');
		expect(def?.exported).toBe(false);
		expect(def?.visibilityInfo?.visibility).toBe('private');
	});

	test('a 5000-char line comment before the modifier keeps it private', async () => {
		const facts = await extractFileSymbols(
			'java',
			`@Ann\n// ${'x'.repeat(5000)}\nprivate class Hidden { void m() {} }\n`,
		);
		const def = facts?.defs.find((d) => d.name === 'Hidden');
		expect(def?.exported).toBe(false);
	});
});
