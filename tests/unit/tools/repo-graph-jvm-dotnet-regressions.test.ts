/**
 * Regression pins for defects found by the independent implementation-review
 * and final-critic passes on issue #1529. Split out of
 * `repo-graph-jvm-dotnet.test.ts` to stay under the 500-line FR-006 cap.
 *
 * Every test here corresponds to a branch that survived mutation at some point
 * during review; each one fails if its branch is reverted.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	buildWorkspaceGraph,
	buildWorkspaceGraphAsync,
} from '../../../src/tools/repo-graph/builder';
import { getContextPack } from '../../../src/tools/repo-graph/query';
import type { RepoGraph } from '../../../src/tools/repo-graph/types';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

let tempDir: string;

beforeEach(() => {
	tempDir = canonicalMkdtemp('jvm-dotnet-graph-');
});

afterEach(() => {
	fs.rmSync(tempDir, { recursive: true, force: true });
});

function writeFile(relPath: string, contents: string) {
	const full = path.join(tempDir, relPath);
	fs.mkdirSync(path.dirname(full), { recursive: true });
	fs.writeFileSync(full, contents);
}

function nodeFor(graph: RepoGraph, relPath: string) {
	const target = path.normalize(relPath).replace(/\\/g, '/');
	const match = Object.values(graph.nodes).find((n: any) =>
		n.moduleName.replace(/\\/g, '/').endsWith(target),
	);
	return match as any;
}

describe('repo-graph JVM/.NET — implementation-review regressions', () => {
	test('an exported symbol outranks a same-named non-exported member', async () => {
		// Widening admits non-exported members into exportRanges. Without an
		// exported-wins rule, source order lets a private member displace the
		// exported symbol of the same name — and because exportLines stays
		// exported-only, the two maps then disagree and context_pack serves the
		// member's body under the exported name.
		writeFile(
			'p/A.kt',
			'package p\n\nclass A {\n    fun process() {}\n}\n\nfun process() {}\n',
		);
		const graph = await buildWorkspaceGraphAsync(tempDir);
		const node = nodeFor(graph, 'p/A.kt');

		// Line 7 is the exported top-level fun; line 4 is the private member.
		expect(node.exportRanges?.process?.startLine).toBe(7);
		expect(node.exportRanges?.process?.startLine).toBe(
			node.exportLines?.process,
		);

		const pack = getContextPack(graph, node.moduleName, 'process');
		expect(pack.spans[0]?.startLine).toBe(7);
	});

	test('an exported def declared BEFORE a same-named member is not overwritten by it', async () => {
		// Order matters for this branch: here the exported top-level fun comes
		// FIRST, so only the exported-wins rule stops the later private member
		// from overwriting it. (The sibling test puts the member first, where
		// plain last-wins would coincidentally give the right answer.)
		writeFile(
			'p/B.kt',
			'package p\n\nfun process() {}\n\nclass B {\n    fun process() {}\n}\n',
		);
		const graph = await buildWorkspaceGraphAsync(tempDir);
		const node = nodeFor(graph, 'p/B.kt');

		expect(node.exportRanges?.process?.startLine).toBe(3);
		expect(node.exportRanges?.process?.startLine).toBe(
			node.exportLines?.process,
		);
	});

	test('two same-named exported defs keep exportRanges in sync with exportLines', async () => {
		// A C# partial class declares the same exported type twice. exportLines is
		// last-wins; if exportRanges used first-wins here the two maps would point
		// at different declarations and context_pack would serve the first partial
		// under a name exportLines maps to the second.
		writeFile(
			'Part.cs',
			'namespace N;\n\npublic partial class Part\n{\n}\n\npublic partial class Part\n{\n}\n',
		);
		const graph = await buildWorkspaceGraphAsync(tempDir);
		const node = nodeFor(graph, 'Part.cs');

		expect(node.exportLines?.Part).toBeDefined();
		expect(node.exportRanges?.Part?.startLine).toBe(node.exportLines?.Part);
	});

	test('sync builder parses JVM/.NET imports via the non-tree-sitter fallback', async () => {
		// buildWorkspaceGraph (sync) never calls extractFileSymbols; it routes
		// through parseFileImports, whose java/kotlin/csharp branches are the
		// fallback used when the async path's grammar load or 500ms AST budget
		// fails. Every other JVM/.NET test uses the async builder, so without
		// this those three parsers are reachable-but-uncovered.
		writeFile(
			'com/example/Main.java',
			'package com.example;\n\nimport com.example.Repo;\n\npublic class Main {}\n',
		);
		writeFile(
			'com/example/Repo.java',
			'package com.example;\n\npublic class Repo {}\n',
		);
		writeFile(
			'com/example/Svc.kt',
			'package com.example\n\nimport com.example.Repo\n\nfun go() {}\n',
		);
		writeFile(
			'com/example/Api.cs',
			'namespace Example;\n\nusing Example.Data;\n\npublic class Api {}\n',
		);
		writeFile(
			'Example/Data/Thing.cs',
			'namespace Example.Data;\n\npublic class Thing {}\n',
		);

		const graph = buildWorkspaceGraph(tempDir);

		const javaNode = nodeFor(graph, 'com/example/Main.java');
		expect(javaNode.imports).toContain('com.example.Repo');
		const kotlinNode = nodeFor(graph, 'com/example/Svc.kt');
		expect(kotlinNode.imports).toContain('com.example.Repo');
		const csharpNode = nodeFor(graph, 'com/example/Api.cs');
		expect(csharpNode.imports).toContain('Example.Data');

		// The fallback must also produce a real resolved edge, not just a
		// specifier string.
		const repoNode = nodeFor(graph, 'com/example/Repo.java');
		expect(
			graph.edges.some(
				(e) => e.source === javaNode.filePath && e.target === repoNode.filePath,
			),
		).toBe(true);
	});

	test('exportRanges widening does not change non-JVM languages', async () => {
		// The first cut applied a first-wins duplicate-name policy to EVERY
		// grammar while only the def SET was language-scoped. That silently moved
		// TypeScript from last-wins to first-wins and desynced exportRanges from
		// exportLines, which is still last-wins.
		writeFile(
			'dup.ts',
			'export interface Foo { a: number; }\n\nexport function Foo(): number { return 1; }\n',
		);
		const graph = await buildWorkspaceGraphAsync(tempDir);
		const node = nodeFor(graph, 'dup.ts');

		// Last-wins: the function at line 3, not the interface at line 1.
		expect(node.exportRanges?.Foo?.startLine).toBe(3);
		// And the two maps must agree for the same symbol.
		expect(node.exportRanges?.Foo?.startLine).toBe(node.exportLines?.Foo);
	});

	test('a container span survives even if defs arrive member-before-container', async () => {
		// exportRanges resolves a name collision by exportedness FIRST, so the
		// result cannot depend on the order tree-sitter reports defs in. Today
		// defs arrive in document order and the container is written first
		// anyway; this drives the seam with the order INVERTED so the ordering
		// independence is actually pinned rather than assumed. Without it,
		// context_pack('OrderService') would return the constructor body.
		const real = _internals.extractFileSymbols;
		try {
			_internals.extractFileSymbols = (async () => ({
				defs: [
					// Constructor FIRST (inverted vs document order).
					{
						name: 'OrderService',
						kind: 'method' as const,
						exported: false,
						startLine: 3,
						endLine: 3,
					},
					{
						name: 'OrderService',
						kind: 'class' as const,
						exported: true,
						startLine: 2,
						endLine: 6,
					},
				],
				imports: [],
				refs: [],
			})) as unknown as typeof _internals.extractFileSymbols;

			writeFile(
				'com/example/OrderService.java',
				'package com.example;\npublic class OrderService {\n    public OrderService() {}\n}\n',
			);
			const graph = await buildWorkspaceGraphAsync(tempDir);
			const node = nodeFor(graph, 'com/example/OrderService.java');

			expect(node.exportRanges?.OrderService).toEqual({
				startLine: 2,
				endLine: 6,
			});
		} finally {
			_internals.extractFileSymbols = real;
		}
	});

	test('a package import resolves to a representative file, deterministically', async () => {
		// A package specifier names a directory, so — exactly as this module
		// already does for Go package imports — the edge points at a
		// representative member. What must hold is that the choice is
		// deterministic (code-unit order, not host-dependent ICU collation) and
		// that it is a FILE, never a directory that happens to end in .java.
		writeFile(
			'com/example/Main.java',
			'package com.example;\n\nimport com.example.util.*;\n\npublic class Main { public void run() {} }\n',
		);
		writeFile(
			'com/example/util/Zzz.java',
			'package com.example.util;\n\npublic class Zzz {}\n',
		);
		writeFile(
			'com/example/util/Aaa.java',
			'package com.example.util;\n\npublic class Aaa {}\n',
		);
		// A directory whose name ends in .java must be skipped, not resolved.
		fs.mkdirSync(path.join(tempDir, 'com/example/util/Decoy.java'), {
			recursive: true,
		});

		const graph = await buildWorkspaceGraphAsync(tempDir);
		const mainNode = nodeFor(graph, 'com/example/Main.java');
		const targets = graph.edges
			.filter((e) => e.source === mainNode.filePath)
			.map((e) => path.basename(e.target));

		expect(targets).toContain('Aaa.java');
		expect(targets).not.toContain('Decoy.java');
	});

	test('a directory that looks like a source file is skipped, even when it sorts first', async () => {
		// The isFile guard only bites when the decoy sorts BEFORE any real file.
		// 'AA.java' precedes 'Aaa.java' in code-unit order, so without the guard
		// readdirSync's directory entry would be returned as the import target.
		// (It must not be a case-variant of the real file — NTFS is
		// case-insensitive, so 'AAA.java' beside 'Aaa.java' is EEXIST.)
		writeFile(
			'q/Main.java',
			'package q;\n\nimport q.pkg.*;\n\npublic class Main {}\n',
		);
		writeFile('q/pkg/Aaa.java', 'package q.pkg;\n\npublic class Aaa {}\n');
		fs.mkdirSync(path.join(tempDir, 'q/pkg/AA.java'), { recursive: true });

		const graph = await buildWorkspaceGraphAsync(tempDir);
		const mainNode = nodeFor(graph, 'q/Main.java');
		const targets = graph.edges
			.filter((e) => e.source === mainNode.filePath)
			.map((e) => path.basename(e.target));

		expect(targets).toContain('Aaa.java');
		expect(targets).not.toContain('AA.java');
	});

	test('a package prefers its same-named file over an alphabetically earlier sibling', async () => {
		writeFile(
			'r/Program.cs',
			'namespace R;\n\nusing R.Data;\n\npublic class Program {}\n',
		);
		writeFile(
			'r/Data/Alpha.cs',
			'namespace R.Data;\n\npublic class Alpha {}\n',
		);
		writeFile('r/Data/Data.cs', 'namespace R.Data;\n\npublic class Data {}\n');

		const graph = await buildWorkspaceGraphAsync(tempDir);
		const programNode = nodeFor(graph, 'r/Program.cs');
		const targets = graph.edges
			.filter((e) => e.source === programNode.filePath)
			.map((e) => path.basename(e.target));

		// Data.cs is the meaningful representative even though Alpha.cs sorts first.
		expect(targets).toContain('Data.cs');
		expect(targets).not.toContain('Alpha.cs');
	});

	test('a package representative skips test classes, but a test-only package still resolves', async () => {
		// Mirrors the Go precedent's `!entry.endsWith('_test.go')` filter. Without
		// it, alphabetical order makes AaaTests.cs beat the real type.
		writeFile('Program.cs', 'namespace App;\n\nusing Pkg;\nusing OnlyT;\n');
		writeFile(
			'Pkg/AaaTests.cs',
			'namespace Pkg;\n\npublic class AaaTests {}\n',
		);
		writeFile('Pkg/Real.cs', 'namespace Pkg;\n\npublic class Real {}\n');
		writeFile(
			'OnlyT/ZTests.cs',
			'namespace OnlyT;\n\npublic class ZTests {}\n',
		);

		const graph = await buildWorkspaceGraphAsync(tempDir);
		const programNode = nodeFor(graph, 'Program.cs');
		const targets = graph.edges
			.filter((e) => e.source === programNode.filePath)
			.map((e) => path.basename(e.target));

		expect(targets).toContain('Real.cs');
		expect(targets).not.toContain('AaaTests.cs');
		// A package containing only tests must not lose its edge entirely.
		expect(targets).toContain('ZTests.cs');
	});

	test('a symbol named after an Object.prototype member does not leak a malformed span', async () => {
		// exportRanges/exportLines are plain object literals, so `toString`,
		// `valueOf` etc. resolve through the prototype chain to a FUNCTION —
		// truthy, so the "no range" fallback would not fire and the span would
		// carry startLine: undefined and estimatedTokens: NaN. Pre-existing, but
		// this change makes such names reachable for .js files by surfacing class
		// members as defs.
		writeFile(
			'proto.js',
			'export class C {\n  constructor() {}\n  m() {}\n}\n',
		);
		const graph = await buildWorkspaceGraphAsync(tempDir);
		const node = nodeFor(graph, 'proto.js');

		for (const inherited of ['toString', 'valueOf', 'hasOwnProperty']) {
			const pack = getContextPack(graph, node.moduleName, inherited);
			expect(pack.spans[0]?.mode, `${inherited} mode`).toBe('signature');
			expect(
				Number.isFinite(pack.estimatedTokens),
				`${inherited} tokens finite`,
			).toBe(true);
		}

		// A genuinely present member still resolves to a real span.
		const real = getContextPack(graph, node.moduleName, 'm');
		expect(real.spans[0]?.mode).toBe('full');
		expect(Number.isFinite(real.estimatedTokens)).toBe(true);
	});

	test('the exportRanges widening does not reach non-JVM grammars', async () => {
		// Pins the LANGUAGE SCOPING itself, not just the widening. Adding
		// 'typescript' to JVM_DOTNET_RANGE_GRAMMARS previously survived the whole
		// suite: nothing asserted that a non-exported TypeScript helper stays OUT
		// of exportRanges, which is the entire reason the set is scoped.
		writeFile(
			'scoped.ts',
			'export function shown() {}\n\nfunction helper() {}\n',
		);
		const graph = await buildWorkspaceGraphAsync(tempDir);
		const node = nodeFor(graph, 'scoped.ts');

		expect(node.exportRanges?.shown).toBeDefined();
		expect(node.exportRanges?.helper).toBeUndefined();
		expect(node.exportLines?.helper).toBeUndefined();
	});

	test('a conventional Maven/Gradle source root resolves', async () => {
		// JVM_DOTNET_DOTTED_ROOTS carries 'src', 'src/main/java' and
		// 'src/main/kotlin' for the standard build layouts, but every other
		// fixture in these suites uses the package-rooted '' layout — deleting
		// those three entries would not have failed the suite.
		writeFile(
			'src/main/java/com/acme/App.java',
			'package com.acme;\n\nimport com.acme.Helper;\n\npublic class App {}\n',
		);
		writeFile(
			'src/main/java/com/acme/Helper.java',
			'package com.acme;\n\npublic class Helper {}\n',
		);
		writeFile(
			'src/main/kotlin/com/acme/Svc.kt',
			'package com.acme\n\nimport com.acme.Helper\n\nfun go() {}\n',
		);

		const graph = await buildWorkspaceGraphAsync(tempDir);
		const appNode = nodeFor(graph, 'src/main/java/com/acme/App.java');
		const helperNode = nodeFor(graph, 'src/main/java/com/acme/Helper.java');
		expect(
			graph.edges.some(
				(e) =>
					e.source === appNode.filePath && e.target === helperNode.filePath,
			),
		).toBe(true);
		expect(appNode.ontology?.packageBoundary).toBe('com.acme');
	});

	test('a malformed def range is skipped rather than aborting the graph build', async () => {
		// validateGraphNode throws on a non-positive or inverted range and runs
		// inside the scan, so widening (which admits non-exported defs) must not
		// let one bad def kill the whole build. No real grammar emits such a
		// range, so this drives it through the _internals seam.
		const real = _internals.extractFileSymbols;
		try {
			_internals.extractFileSymbols = (async () => ({
				defs: [
					{
						name: 'Good',
						kind: 'class' as const,
						exported: true,
						startLine: 2,
						endLine: 4,
					},
					// Inverted range.
					{
						name: 'Bad',
						kind: 'method' as const,
						exported: false,
						startLine: 9,
						endLine: 3,
					},
					// Non-positive range.
					{
						name: 'Worse',
						kind: 'method' as const,
						exported: false,
						startLine: 0,
						endLine: 0,
					},
				],
				imports: [],
				refs: [],
			})) as unknown as typeof _internals.extractFileSymbols;

			writeFile('m/Good.java', 'package m;\n\npublic class Good {\n}\n');
			const graph = await buildWorkspaceGraphAsync(tempDir);
			const node = nodeFor(graph, 'm/Good.java');

			expect(node.exportRanges?.Good).toEqual({ startLine: 2, endLine: 4 });
			expect(node.exportRanges?.Bad).toBeUndefined();
			expect(node.exportRanges?.Worse).toBeUndefined();
		} finally {
			_internals.extractFileSymbols = real;
		}
	});
});
