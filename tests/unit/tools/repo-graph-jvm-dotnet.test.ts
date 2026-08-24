/**
 * End-to-end acceptance evidence for issue #1529 (JVM/.NET import & symbol
 * resolution, package boundary metadata, and context-pack member spans).
 *
 * These tests build a REAL workspace on disk and run the REAL graph builder
 * (no mocking of the extraction path) so they pin the actual fixed behavior,
 * not a mocked stand-in. Pre-fix baseline for the Java case was:
 *   edges: 0, symbolEdges: 0, packageBoundary: 'com' (path-derived, wrong).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildWorkspaceGraphAsync } from '../../../src/tools/repo-graph/builder';
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

describe('repo-graph: Java import/symbol resolution + ontology + context pack (issue #1529)', () => {
	beforeEach(() => {
		writeFile(
			'com/example/OrderService.java',
			[
				'package com.example;',
				'',
				'import com.example.Repo;',
				'',
				'public class OrderService {',
				'    private Repo repo;',
				'',
				'    public OrderService(Repo r) {',
				'        this.repo = r;',
				'    }',
				'',
				'    public void process() {',
				'        repo.save();',
				'    }',
				'',
				'    public void process(int n) {',
				'    }',
				'}',
				'',
			].join('\n'),
		);
		writeFile(
			'com/example/Repo.java',
			[
				'package com.example;',
				'',
				'public class Repo {',
				'    public void save() {}',
				'}',
				'',
			].join('\n'),
		);
		writeFile(
			'com/example/Broken.java',
			[
				'package com.example;',
				'',
				'import com.example.DoesNotExist;',
				'',
				'public class Broken {',
				'}',
				'',
			].join('\n'),
		);
	});

	test('criterion 5: produces a file-level import edge targeting Repo.java', async () => {
		const graph = await buildWorkspaceGraphAsync(tempDir);
		expect(graph.edges.length).toBeGreaterThanOrEqual(1);
		const repoNode = nodeFor(graph, 'com/example/Repo.java');
		expect(repoNode).toBeDefined();
		const edgeToRepo = graph.edges.find((e) => e.target === repoNode.filePath);
		expect(edgeToRepo).toBeDefined();
	});

	test('criterion 6: produces a symbol edge referencing Repo', async () => {
		const graph = await buildWorkspaceGraphAsync(tempDir);
		expect(graph.symbolEdges).toBeDefined();
		expect((graph.symbolEdges ?? []).length).toBeGreaterThan(0);
		const repoNode = nodeFor(graph, 'com/example/Repo.java');
		const symEdge = (graph.symbolEdges ?? []).find(
			(e) => e.toSymbol === 'Repo' && e.toFile === repoNode.filePath,
		);
		expect(symEdge).toBeDefined();
	});

	test('criterion 4: package boundary is the dotted Java package, not the path segment', async () => {
		const graph = await buildWorkspaceGraphAsync(tempDir);
		const orderNode = nodeFor(graph, 'com/example/OrderService.java');
		expect(orderNode.ontology).toBeDefined();
		expect(orderNode.ontology.packageBoundary).toBe('com.example');
		expect(orderNode.ontology.packageBoundary).not.toBe('com');
	});

	test('criterion 8: context pack returns full-mode spans for class and member symbols', async () => {
		const graph = await buildWorkspaceGraphAsync(tempDir);
		const orderNode = nodeFor(graph, 'com/example/OrderService.java');

		const classPack = getContextPack(
			graph,
			orderNode.moduleName,
			'OrderService',
		);
		expect(classPack.spans.length).toBeGreaterThan(0);
		expect(classPack.spans[0].mode).toBe('full');

		const methodPack = getContextPack(graph, orderNode.moduleName, 'process');
		expect(methodPack.spans.length).toBeGreaterThan(0);
		expect(methodPack.spans[0].mode).toBe('full');
	});

	test('constructor-collision guard: class exportRange is the class span, not the ctor line', async () => {
		const graph = await buildWorkspaceGraphAsync(tempDir);
		const orderNode = nodeFor(graph, 'com/example/OrderService.java');
		const classRange = orderNode.exportRanges?.OrderService;
		expect(classRange).toBeDefined();
		// The single-line constructor span would collapse startLine === endLine
		// under last-write-wins; the class span must span the whole body.
		expect(classRange.endLine).toBeGreaterThan(classRange.startLine);
	});

	test('overload collapse: exportRanges.process is the FIRST process overload', async () => {
		const graph = await buildWorkspaceGraphAsync(tempDir);
		const orderNode = nodeFor(graph, 'com/example/OrderService.java');
		const processRange = orderNode.exportRanges?.process;
		expect(processRange).toBeDefined();
		// First overload `public void process()` starts before the second
		// `public void process(int n)` — first-wins pins this ordering.
		const source = fs.readFileSync(
			path.join(tempDir, 'com/example/OrderService.java'),
			'utf8',
		);
		const lines = source.split('\n');
		expect(lines[processRange.startLine - 1]).toContain('process()');
	});

	test('unresolvable import produces no fabricated edge', async () => {
		const graph = await buildWorkspaceGraphAsync(tempDir);
		const brokenNode = nodeFor(graph, 'com/example/Broken.java');
		expect(brokenNode).toBeDefined();
		const edgesFromBroken = graph.edges.filter(
			(e) => e.source === brokenNode.filePath,
		);
		// Must not resolve DoesNotExist to some other sibling file (e.g. the
		// alphabetically-first sibling via a buggy parent-package probe).
		expect(edgesFromBroken.length).toBe(0);
	});
});

describe('repo-graph: Kotlin import/symbol resolution + ontology (issue #1529)', () => {
	beforeEach(() => {
		writeFile(
			'com/example/Service.kt',
			[
				'package com.example',
				'',
				'import com.example.helper.Widget',
				'',
				'fun run() {',
				'    Widget().build()',
				'}',
				'',
			].join('\n'),
		);
		writeFile(
			'com/example/helper/Widget.kt',
			[
				'package com.example.helper',
				'',
				'class Widget {',
				'    fun build() {}',
				'}',
				'',
			].join('\n'),
		);
	});

	test('kotlin: package boundary from source and at least one import edge', async () => {
		const graph = await buildWorkspaceGraphAsync(tempDir);
		const serviceNode = nodeFor(graph, 'com/example/Service.kt');
		expect(serviceNode.ontology?.packageBoundary).toBe('com.example');
		const widgetNode = nodeFor(graph, 'com/example/helper/Widget.kt');
		const edge = graph.edges.find(
			(e) =>
				e.source === serviceNode.filePath && e.target === widgetNode.filePath,
		);
		expect(edge).toBeDefined();
	});

	// Mutation-proven gap: removing `kotlin` from JVM_DOTNET_RANGE_GRAMMARS left
	// the whole suite green, because only Java asserted a member span or a
	// symbolEdge. The widening is the entire point of the change for Kotlin too.
	test('kotlin: member span reaches exportRanges and context_pack in full mode', async () => {
		const graph = await buildWorkspaceGraphAsync(tempDir);
		const widgetNode = nodeFor(graph, 'com/example/helper/Widget.kt');
		expect(widgetNode.exportRanges?.build).toEqual({
			startLine: 4,
			endLine: 4,
		});
		const pack = getContextPack(graph, widgetNode.moduleName, 'build');
		expect(pack.spans[0]?.mode).toBe('full');
	});

	test('kotlin: produces a symbol edge for the resolved import', async () => {
		const graph = await buildWorkspaceGraphAsync(tempDir);
		const serviceNode = nodeFor(graph, 'com/example/Service.kt');
		const widgetNode = nodeFor(graph, 'com/example/helper/Widget.kt');
		expect(graph.symbolEdges ?? []).toContainEqual({
			fromFile: serviceNode.filePath,
			fromSymbol: 'run',
			toFile: widgetNode.filePath,
			toSymbol: 'Widget',
		});
	});
});

describe('repo-graph: C# file-scoped and block namespace resolution (issue #1529)', () => {
	beforeEach(() => {
		writeFile(
			'Example/App/OrderController.cs',
			[
				'namespace Example.App;',
				'',
				'using Example.App.Services;',
				'',
				'public class OrderController {',
				'    public void Handle() {',
				'        new OrderApi().Run();',
				'    }',
				'}',
				'',
			].join('\n'),
		);
		writeFile(
			'Example/App/Services/OrderApi.cs',
			[
				'namespace Example.App.Services',
				'{',
				'    public class OrderApi',
				'    {',
				'        public void Run() {}',
				'    }',
				'}',
				'',
			].join('\n'),
		);
	});

	test('csharp: file-scoped namespace yields dotted package boundary and an import edge', async () => {
		const graph = await buildWorkspaceGraphAsync(tempDir);
		const controllerNode = nodeFor(graph, 'Example/App/OrderController.cs');
		expect(controllerNode.ontology?.packageBoundary).toBe('Example.App');
		const apiNode = nodeFor(graph, 'Example/App/Services/OrderApi.cs');
		const edge = graph.edges.find(
			(e) =>
				e.source === controllerNode.filePath && e.target === apiNode.filePath,
		);
		expect(edge).toBeDefined();
	});

	test('csharp: block-form namespace still resolves its own package boundary', async () => {
		const graph = await buildWorkspaceGraphAsync(tempDir);
		const apiNode = nodeFor(graph, 'Example/App/Services/OrderApi.cs');
		expect(apiNode.ontology?.packageBoundary).toBe('Example.App.Services');
	});

	// Mutation-proven gap: removing `csharp` from JVM_DOTNET_RANGE_GRAMMARS left
	// the whole suite green — only Java pinned a member span or a symbolEdge.
	test('csharp: member span reaches exportRanges and context_pack in full mode', async () => {
		const graph = await buildWorkspaceGraphAsync(tempDir);
		const apiNode = nodeFor(graph, 'Example/App/Services/OrderApi.cs');
		expect(apiNode.exportRanges?.Run).toEqual({ startLine: 5, endLine: 5 });
		const pack = getContextPack(graph, apiNode.moduleName, 'Run');
		expect(pack.spans[0]?.mode).toBe('full');
	});

	// A plain C# `using Namespace;` imports a NAMESPACE, not a name: it creates
	// no named binding, so there is nothing for a reference to resolve against
	// and no symbol edge is emitted. That is correct, not a gap — Kotlin's
	// `import ...Widget` is a NAMED import, which is why it does emit one.
	// Pinned so the asymmetry is deliberate rather than looking like a Kotlin/C#
	// inconsistency to the next reader.
	test('csharp: a namespace-only using yields a file edge but no symbol edge', async () => {
		const graph = await buildWorkspaceGraphAsync(tempDir);
		const controllerNode = nodeFor(graph, 'Example/App/OrderController.cs');
		const apiNode = nodeFor(graph, 'Example/App/Services/OrderApi.cs');
		expect(
			graph.edges.some(
				(e) =>
					e.source === controllerNode.filePath && e.target === apiNode.filePath,
			),
		).toBe(true);
		expect(
			(graph.symbolEdges ?? []).some(
				(e) => e.fromFile === controllerNode.filePath,
			),
		).toBe(false);
	});
});
