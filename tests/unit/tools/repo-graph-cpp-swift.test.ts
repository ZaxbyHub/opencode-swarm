/**
 * End-to-end acceptance evidence for issue #1530 (C/C++ and Swift symbol
 * graph hardening): include edges, header-declared public symbols,
 * static/anonymous-namespace conservatism, and context-pack member spans.
 *
 * These tests build a REAL workspace on disk and run the REAL graph builder
 * (no mocking of the extraction path) so they pin the actual fixed behavior,
 * not a mocked stand-in — the same contract as the KG-08 file for Java/
 * Kotlin/C# (tests/unit/tools/repo-graph-jvm-dotnet.test.ts).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildWorkspaceGraphAsync } from '../../../src/tools/repo-graph/builder';
import {
	getCallers,
	getContextPack,
	getDeadExports,
} from '../../../src/tools/repo-graph/query';
import type { RepoGraph } from '../../../src/tools/repo-graph/types';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

let tempDir: string;

beforeEach(() => {
	tempDir = canonicalMkdtemp('cpp-swift-graph-');
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

describe('repo-graph: C header/source include edges + public symbols (issue #1530)', () => {
	beforeEach(() => {
		writeFile(
			'util.h',
			[
				'#ifndef UTIL_H',
				'#define UTIL_H',
				'int add(int a, int b);',
				'char *concat(const char *a, const char *b);',
				'#endif',
				'',
			].join('\n'),
		);
		writeFile(
			'main.c',
			[
				'#include <stdio.h>',
				'#include "util.h"',
				'',
				'static int helper(int v) { return v * 2; }',
				'int add(int a, int b) { return helper(a) + b; }',
				'',
			].join('\n'),
		);
	});

	test('criterion 1: quoted include resolves to a file edge onto util.h', async () => {
		const graph = await buildWorkspaceGraphAsync(tempDir);
		const utilNode = nodeFor(graph, 'util.h');
		expect(utilNode).toBeDefined();
		const edge = graph.edges.find((e) => e.target === utilNode.filePath);
		expect(edge).toBeDefined();
		expect(edge!.importSpecifier).toBe('./util.h');
		// Whole-file (namespace) semantics: an include binds the entire header,
		// and callers/consumers/dead_exports must treat it as a whole-file
		// dependency — a 'default' edge with empty usedSymbols made callers
		// vanish and flagged every header export dead (PR #2351 review PRR-001).
		expect(edge!.importType).toBe('namespace');
		expect(edge!.usedSymbols).toBeUndefined();
	});

	test('criterion 1: angle include is external — no fabricated edge', async () => {
		const graph = await buildWorkspaceGraphAsync(tempDir);
		const mainNode = nodeFor(graph, 'main.c');
		expect(mainNode).toBeDefined();
		const stdioEdge = graph.edges.find(
			(e) =>
				e.source === mainNode.filePath && e.importSpecifier.includes('stdio'),
		);
		expect(stdioEdge).toBeUndefined();
	});

	test('criterion 2: header-declared public symbols are exported', async () => {
		const graph = await buildWorkspaceGraphAsync(tempDir);
		const utilNode = nodeFor(graph, 'util.h');
		expect(utilNode.exports).toContain('add');
		expect(utilNode.exports).toContain('concat');
		// The prototype span backs context_pack.
		expect(utilNode.exportRanges?.add).toEqual({ startLine: 3, endLine: 3 });
	});

	test('criterion 3: static helper is not exported', async () => {
		const graph = await buildWorkspaceGraphAsync(tempDir);
		const mainNode = nodeFor(graph, 'main.c');
		expect(mainNode.exports).not.toContain('helper');
		expect(mainNode.exports).toContain('add');
	});

	test('criterion 6: context_pack returns a real span for the header symbol', async () => {
		const graph = await buildWorkspaceGraphAsync(tempDir);
		const utilNode = nodeFor(graph, 'util.h');
		const pack = getContextPack(graph, utilNode.moduleName, 'add');
		expect(pack.spans.length).toBeGreaterThan(0);
		expect(pack.spans[0].mode).toBe('full');
		expect(pack.spans[0].startLine).toBe(3);
	});
});

describe('repo-graph: C++ internals conservatism + member spans (issue #1530)', () => {
	beforeEach(() => {
		writeFile(
			'engine.cpp',
			[
				'namespace engine {',
				'  class Engine {',
				'  public:',
				'    Engine(int capacity);',
				'    void start();',
				'  private:',
				'    int capacity_;',
				'  };',
				'  void run(const Engine &e);',
				'}',
				'',
				'namespace {',
				'int internal_counter = 0;',
				'void internal_fn() { internal_counter++; }',
				'}',
				'',
				'static int file_local(int x) { return x; }',
				'',
				'void engine::run(const Engine &e) { file_local(1); }',
				'',
			].join('\n'),
		);
	});

	test('criterion 3: anonymous-namespace and static symbols are not exported', async () => {
		const graph = await buildWorkspaceGraphAsync(tempDir);
		const node = nodeFor(graph, 'engine.cpp');
		expect(node.exports).not.toContain('internal_fn');
		expect(node.exports).not.toContain('file_local');
		// Namespace-level public symbols still are.
		expect(node.exports).toContain('Engine');
		expect(node.exports).toContain('run');
	});

	// Mutation-proven pin (mirrors the kotlin/csharp comments in the KG-08
	// file): removing `cpp` from RANGE_WIDENED_GRAMMARS must fail here — this
	// is the only cpp assertion that needs a non-exported member span.
	test('criterion 6: private member spans reach exportRanges and context_pack', async () => {
		const graph = await buildWorkspaceGraphAsync(tempDir);
		const node = nodeFor(graph, 'engine.cpp');
		expect(node.exportRanges?.start).toEqual({ startLine: 5, endLine: 5 });
		const pack = getContextPack(graph, node.moduleName, 'start');
		expect(pack.spans[0]?.mode).toBe('full');
		expect(pack.spans[0]?.startLine).toBe(5);
	});

	test('overload collapse caveat: same-name namespace prototypes collapse by name', async () => {
		writeFile(
			'overload.cpp',
			[
				'int process(int x);',
				'int process(int x, int y);',
				'int process(int x) { return x; }',
				'',
			].join('\n'),
		);
		const graph = await buildWorkspaceGraphAsync(tempDir);
		const node = nodeFor(graph, 'overload.cpp');
		// Each overload contributes its own entry to exports[] (pre-existing
		// per-def semantics, same as Java overload rows in the KG-08 fixture);
		// the CONSERVATIVE COLLAPSE is at the range level — one name, one span.
		const entries = node.exports.filter((n: string) => n === 'process');
		expect(entries.length).toBe(3);
		expect(node.exportRanges?.process).toBeDefined();
		// The collapsed span points at ONE of the overloads (last exported wins
		// document-order policy); it must be a real line, never undefined.
		expect(Number.isInteger(node.exportRanges?.process?.startLine)).toBe(true);
	});

	test('qualified out-of-class definition is exported under the function name', async () => {
		const graph = await buildWorkspaceGraphAsync(tempDir);
		const node = nodeFor(graph, 'engine.cpp');
		expect(node.exports).not.toContain('engine');
	});
});

describe('repo-graph: Swift visibility, members, and context pack (issue #1530)', () => {
	beforeEach(() => {
		writeFile(
			'Model.swift',
			[
				'import Foundation',
				'',
				'public class PublicService {',
				'    public func visible() -> Int { return 1 }',
				'    private func hidden() -> Int { return 2 }',
				'    func implicitInternal() -> Int { return 3 }',
				'}',
				'',
				'private func filePrivateFn() -> Int { return 4 }',
				'',
				'extension PublicService {',
				'    func extended() -> Int { return 5 }',
				'}',
				'',
			].join('\n'),
		);
	});

	test('criterion 4/5: public symbols exported, private ones not', async () => {
		const graph = await buildWorkspaceGraphAsync(tempDir);
		const node = nodeFor(graph, 'Model.swift');
		expect(node.exports).toContain('PublicService');
		expect(node.exports).not.toContain('filePrivateFn');
	});

	test('criterion 5: Swift module imports are recorded', async () => {
		const graph = await buildWorkspaceGraphAsync(tempDir);
		const node = nodeFor(graph, 'Model.swift');
		expect(node.imports).toContain('Foundation');
	});

	// Mutation-proven pin (mirrors the kotlin/csharp comments in the KG-08
	// file): removing `swift` from RANGE_WIDENED_GRAMMARS must fail here.
	test('criterion 6: member spans reach exportRanges and context_pack in full mode', async () => {
		const graph = await buildWorkspaceGraphAsync(tempDir);
		const node = nodeFor(graph, 'Model.swift');
		expect(node.exportRanges?.visible).toEqual({ startLine: 4, endLine: 4 });
		const pack = getContextPack(graph, node.moduleName, 'visible');
		expect(pack.spans[0]?.mode).toBe('full');
		// A private member also gets a real span (widened), not a placeholder.
		const hiddenPack = getContextPack(graph, node.moduleName, 'hidden');
		expect(hiddenPack.spans[0]?.mode).toBe('full');
		expect(hiddenPack.spans[0]?.startLine).toBe(5);
	});

	test('criterion 6: protocol/class/function ranges back context_pack', async () => {
		writeFile(
			'Proto.swift',
			[
				'protocol Serializable {',
				'    func serialize() -> Int',
				'}',
				'',
				'func globalFn() -> Int { return 9 }',
				'',
			].join('\n'),
		);
		const graph = await buildWorkspaceGraphAsync(tempDir);
		const node = nodeFor(graph, 'Proto.swift');
		expect(node.exportRanges?.Serializable).toEqual({
			startLine: 1,
			endLine: 3,
		});
		expect(node.exportRanges?.globalFn).toEqual({ startLine: 5, endLine: 5 });
		const pack = getContextPack(graph, node.moduleName, 'Serializable');
		expect(pack.spans[0]?.mode).toBe('full');
	});
});

describe('repo-graph: PR #2351 review fixes (F-001 / PRR-001 / PRR-005 / PRR-006 / PRR-014)', () => {
	beforeEach(() => {
		writeFile(
			'util.h',
			[
				'#ifndef UTIL_H',
				'#define UTIL_H',
				'int add(int a, int b);',
				'#endif',
				'',
			].join('\n'),
		);
		writeFile(
			'main.c',
			[
				'#include <stdio.h>',
				'#include "util.h"',
				'',
				'int add(int a, int b) { return a + b; }',
				'',
			].join('\n'),
		);
	});

	test('F-001: same-file extension keeps the class declaration span (executed repro)', async () => {
		writeFile(
			'Model.swift',
			[
				'public class PublicService {',
				'    public func visible() -> Int { return 1 }',
				'}',
				'',
				'extension PublicService {',
				'    func extended() -> Int { return 5 }',
				'}',
				'',
			].join('\n'),
		);
		const graph = await buildWorkspaceGraphAsync(tempDir);
		const node = nodeFor(graph, 'Model.swift');
		// The extension def is non-exported: the class declaration keeps the
		// exports slot AND the span (pre-fix the extension deterministically
		// displaced it — extensions are always textually after their type).
		expect(
			node.exports.filter((n: string) => n === 'PublicService').length,
		).toBe(1);
		expect(node.exportRanges?.PublicService).toEqual({
			startLine: 1,
			endLine: 3,
		});
		const pack = getContextPack(graph, node.moduleName, 'PublicService');
		expect(pack.spans[0]?.startLine).toBe(1);
		expect(pack.spans[0]?.endLine).toBe(3);
		// Extension members are still attributed.
		expect(node.exportRanges?.extended).toEqual({ startLine: 6, endLine: 6 });
	});

	test('F-001 cross-file: extension file does not re-export the extended type', async () => {
		writeFile(
			'Type.swift',
			'public class Payload {\n    public func base() -> Int { return 1 }\n}\n',
		);
		writeFile(
			'Ext.swift',
			'import Foundation\n\nextension Payload {\n    func extra() -> Int { return 2 }\n}\n',
		);
		const graph = await buildWorkspaceGraphAsync(tempDir);
		const typeNode = nodeFor(graph, 'Type.swift');
		const extNode = nodeFor(graph, 'Ext.swift');
		expect(typeNode.exports).toContain('Payload');
		expect(extNode.exports).not.toContain('Payload');
		expect(typeNode.exportRanges?.Payload).toEqual({
			startLine: 1,
			endLine: 3,
		});
	});

	test('PRR-001: quoted include consumers — callers report imported, dead exports skip header', async () => {
		const graph = await buildWorkspaceGraphAsync(tempDir);
		const utilNode = nodeFor(graph, 'util.h');
		// Whole-file include: main.c is a caller with resolution 'imported'.
		const callers = getCallers(graph, utilNode.moduleName, 'add');
		expect(callers).toContainEqual({ file: 'main.c', resolution: 'imported' });
		// The header's usage is per-symbol-unresolvable → skipped, not flagged.
		const dead = getDeadExports(graph);
		expect(dead.candidates.filter((c) => c.file.endsWith('util.h'))).toEqual(
			[],
		);
	});

	test('PRR-005: unresolvable quoted include lands in unresolvedImports diagnostics', async () => {
		writeFile(
			'broken.c',
			'#include "missing.h"\n\nint broken() { return 0; }\n',
		);
		const graph = await buildWorkspaceGraphAsync(tempDir);
		const entries = (graph.diagnostics?.unresolvedImports ?? []).filter(
			(e) => e.specifier === './missing.h',
		);
		expect(entries.length).toBe(1);
		expect(entries[0]!.file).toContain('broken.c');
	});

	test('PRR-006: bare Swift module imports produce no file edges', async () => {
		writeFile(
			'Only.swift',
			'import Foundation\n\nfunc f() -> Int { return 1 }\n',
		);
		const graph = await buildWorkspaceGraphAsync(tempDir);
		const node = nodeFor(graph, 'Only.swift');
		expect(node.imports).toContain('Foundation');
		expect(graph.edges.filter((e) => e.source === node.filePath)).toEqual([]);
	});

	test('PRR-014: header file nodes carry the cpp language id', async () => {
		const graph = await buildWorkspaceGraphAsync(tempDir);
		const utilNode = nodeFor(graph, 'util.h');
		expect(utilNode.language).toBe('cpp');
	});
});
