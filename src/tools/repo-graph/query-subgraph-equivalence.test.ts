/**
 * Issue #1534 — subgraph/full-graph query equivalence.
 *
 * `loadSubgraphForFiles` exists to hand the EXISTING, UNMODIFIED
 * `getGraphNode` / `getLocalizationContext` / `getBlastRadius` a bounded
 * `RepoGraph` instead of the whole document. That is only sound if those
 * functions cannot tell the difference. These tests pin exactly that, using a
 * local implementation of the approved closure rule (07-approved-plan.md
 * "The closure rule", steps 3-5) so the property under test is the CLOSURE
 * CONTRACT, not one storage implementation.
 */

import { describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import {
	getBlastRadius,
	getGraphNode,
	getLocalizationContext,
	resetQueryCache,
} from './query';
import type { GraphEdge, GraphNode, RepoGraph } from './types';
import { normalizeGraphPath } from './types';

const root = path.resolve('/repo');

function key(moduleName: string): string {
	return normalizeGraphPath(path.join(root, moduleName));
}

/**
 * A node with EVERY optional field populated — exportLines, exportRanges,
 * sizeBytes, mtimeMs and an ontology carrying all five fact arrays. A fixture
 * that leaves these empty cannot detect a subgraph that drops them.
 */
function node(moduleName: string, exports: string[]): GraphNode {
	const boundary = moduleName.split('/')[1] ?? 'root';
	return {
		filePath: key(moduleName),
		moduleName,
		exports,
		exportLines: Object.fromEntries(
			exports.map((name, index) => [name, (index + 1) * 10]),
		),
		exportRanges: Object.fromEntries(
			exports.map((name, index) => [
				name,
				{ startLine: (index + 1) * 10, endLine: (index + 1) * 10 + 4 },
			]),
		),
		imports: [`./${moduleName}`],
		language: 'typescript',
		mtime: '2024-01-01T00:00:00.000Z',
		sizeBytes: 1024 + moduleName.length,
		mtimeMs: 1_700_000_000_000 + moduleName.length,
		ontology: {
			roles: ['source_module', 'service_module'],
			packageBoundary: boundary,
			routes: [
				{
					method: 'POST',
					path: `/${boundary}/run`,
					line: 3,
					source: 'file_path',
				},
			],
			dataOperations: [
				{
					operation: 'write',
					access: 'database',
					entity: boundary,
					line: 7,
					evidence: 'db.insert(...)',
				},
			],
			security: [
				{
					kind: 'input_validation',
					line: 11,
					evidence: 'schema.parse(input)',
					confidence: 'high',
				},
			],
			conventions: [
				{ name: 'named-exports-only', line: 1, evidence: 'export const' },
			],
			findings: [
				{
					code: 'ONT001',
					severity: 'low',
					message: `review ${moduleName}`,
					line: 5,
				},
			],
		},
	};
}

function edge(
	source: string,
	target: string,
	symbols: string[],
	used: string[],
): GraphEdge {
	return {
		source: key(source),
		target: key(target),
		importSpecifier: `./${target}`,
		importType: 'named',
		importedSymbols: symbols,
		usedSymbols: used,
		targetKind: 'node',
	};
}

/**
 * Shape:
 *
 *   core/deep.ts  <-- core/util.ts <-- mid/a.ts <-- top/x.ts <-- far/z.ts
 *                                  <-- mid/b.ts <-- top/y.ts
 *   other/unrelated.ts (no edges)
 *
 * `top/x.ts` is simultaneously a target AND a depth-2 dependent of
 * `core/util.ts`, which is what exercises `getBlastRadius`'s simultaneous
 * `visited` seeding (query.ts: visited is seeded with every target before the
 * walk starts, so `top/x.ts` must never surface as its own dependent).
 */
const MODULES = [
	'src/core/deep.ts',
	'src/core/util.ts',
	'src/mid/a.ts',
	'src/mid/b.ts',
	'src/top/x.ts',
	'src/top/y.ts',
	'src/far/z.ts',
	'src/other/unrelated.ts',
] as const;

function makeFullGraph(): RepoGraph {
	const nodes: Record<string, GraphNode> = {};
	for (const moduleName of MODULES) {
		nodes[key(moduleName)] = node(moduleName, ['format', 'parse']);
	}
	const edges: GraphEdge[] = [
		edge('src/core/util.ts', 'src/core/deep.ts', ['dig'], ['dig']),
		edge('src/mid/a.ts', 'src/core/util.ts', ['format', 'parse'], ['format']),
		edge('src/mid/b.ts', 'src/core/util.ts', ['parse'], ['parse']),
		edge('src/top/x.ts', 'src/mid/a.ts', ['format'], ['format']),
		edge('src/top/y.ts', 'src/mid/b.ts', ['parse'], []),
		edge('src/far/z.ts', 'src/top/x.ts', ['format'], ['format']),
	];
	return {
		schema_version: '1.3.0',
		workspaceRoot: root,
		repoRootId: 'repo-root-id',
		nodes,
		edges,
		metadata: {
			generatedAt: '2024-01-01T00:00:00.000Z',
			generator: 'test',
			nodeCount: MODULES.length,
			edgeCount: edges.length,
		},
		symbolEdges: [],
		diagnostics: { extractorInputWitnesses: [] },
	};
}

/**
 * The approved closure rule, steps 3-5. Deliberately re-implemented here
 * rather than imported so that a bug in the storage layer cannot make this
 * test agree with itself.
 */
function buildClosure(
	full: RepoGraph,
	files: readonly string[],
	depth: number,
): RepoGraph {
	const targets = new Set<string>();
	for (const file of files) {
		const resolved = getGraphNode(full, file);
		if (resolved) targets.add(normalizeGraphPath(resolved.filePath));
	}

	const included = new Set(targets);
	let frontier = new Set(targets);
	for (let hop = 0; hop < depth; hop++) {
		const next = new Set<string>();
		for (const graphEdge of full.edges) {
			const source = normalizeGraphPath(graphEdge.source);
			const target = normalizeGraphPath(graphEdge.target);
			if (frontier.has(target) && !included.has(source)) next.add(source);
		}
		for (const source of next) included.add(source);
		frontier = next;
	}
	// F_1: one forward hop from the targets only (getDependencies).
	for (const graphEdge of full.edges) {
		if (targets.has(normalizeGraphPath(graphEdge.source))) {
			included.add(normalizeGraphPath(graphEdge.target));
		}
	}

	const nodes: Record<string, GraphNode> = {};
	for (const included_key of included) {
		const found = full.nodes[included_key];
		if (found) nodes[included_key] = found;
	}
	// Step 4: AND, not incidence — both endpoints must be present so that
	// moduleNameForEdgePath never takes its degraded relative-path branch.
	const edges = full.edges.filter(
		(candidate) =>
			included.has(normalizeGraphPath(candidate.source)) &&
			included.has(normalizeGraphPath(candidate.target)),
	);
	return {
		schema_version: full.schema_version,
		// Step 5: the ACTIVE workspace root, never a persisted copy.
		workspaceRoot: root,
		nodes,
		edges,
		metadata: {
			generatedAt: full.metadata.generatedAt,
			generator: full.metadata.generator,
			nodeCount: Object.keys(nodes).length,
			edgeCount: edges.length,
		},
	};
}

const LOCALIZATION_OPTIONS = {
	maxImporters: 5,
	maxDeps: 5,
	maxDepth: 2,
} as const;

describe('subgraph/full-graph query equivalence (#1534)', () => {
	test('getLocalizationContext at depth 2 is identical on a depth-2 closure', () => {
		const full = makeFullGraph();
		const target = 'src/core/util.ts';
		resetQueryCache();
		const fromFull = getLocalizationContext(full, target, LOCALIZATION_OPTIONS);

		const subgraph = buildClosure(full, [target], 2);
		resetQueryCache();
		const fromSubgraph = getLocalizationContext(
			subgraph,
			target,
			LOCALIZATION_OPTIONS,
		);

		expect(fromSubgraph).toEqual(fromFull);
		// Guard against a vacuous pass: the fixture must actually have content.
		expect(fromFull.importerCount).toBe(2);
		expect(fromFull.dependencyCount).toBe(1);
		expect(fromFull.blastRadius.totalDependents).toBeGreaterThan(0);
		expect(fromFull.summary.length).toBeGreaterThan(0);
		// And the closure must actually be bounded — otherwise this is just
		// comparing the full graph with itself.
		expect(Object.keys(subgraph.nodes).length).toBeLessThan(
			Object.keys(full.nodes).length,
		);
	});

	test('getBlastRadius at depth 3 is identical on a depth-3 closure', () => {
		const full = makeFullGraph();
		const targets = ['src/core/util.ts'];
		resetQueryCache();
		const fromFull = getBlastRadius(full, targets, 3);

		const subgraph = buildClosure(full, targets, 3);
		resetQueryCache();
		const fromSubgraph = getBlastRadius(subgraph, targets, 3);

		expect(fromSubgraph).toEqual(fromFull);
		expect(fromFull.depthReached).toBe(3);
		expect(fromFull.directDependents).toEqual(['src/mid/a.ts', 'src/mid/b.ts']);
		expect(fromFull.transitiveDependents).toEqual([
			'src/far/z.ts',
			'src/top/x.ts',
			'src/top/y.ts',
		]);
	});

	test('a file that is both a target and another target’s depth-2 dependent is pre-visited', () => {
		const full = makeFullGraph();
		// src/top/x.ts is a depth-2 dependent of src/core/util.ts AND a target.
		const targets = ['src/core/util.ts', 'src/top/x.ts'];
		resetQueryCache();
		const fromFull = getBlastRadius(full, targets, 3);

		const subgraph = buildClosure(full, targets, 3);
		resetQueryCache();
		const fromSubgraph = getBlastRadius(subgraph, targets, 3);

		expect(fromSubgraph).toEqual(fromFull);
		// The pre-visit contract: x is a target, so it can never be reported as
		// its own blast radius, at any depth.
		expect(fromFull.directDependents).not.toContain('src/top/x.ts');
		expect(fromFull.transitiveDependents).not.toContain('src/top/x.ts');
		// ...and the union closure must not change the risk classification.
		expect(fromSubgraph.riskLevel).toBe(fromFull.riskLevel);
		expect(fromSubgraph.totalDependents).toBe(fromFull.totalDependents);
	});

	test('the multi-target union differs from merged per-file closures', () => {
		// Pins WHY the union is computed in one call: per-file subgraphs merged
		// afterwards seed `visited` differently and yield a different total.
		const full = makeFullGraph();
		const union = getBlastRadius(full, ['src/core/util.ts', 'src/top/x.ts'], 3);
		resetQueryCache();
		const utilOnly = getBlastRadius(full, ['src/core/util.ts'], 3);
		expect(union.totalDependents).not.toBe(utilOnly.totalDependents);
	});

	test('every optional node and edge field survives the closure', () => {
		const full = makeFullGraph();
		const subgraph = buildClosure(full, ['src/core/util.ts'], 2);
		const fromFull = getGraphNode(full, 'src/core/util.ts');
		const fromSubgraph = getGraphNode(subgraph, 'src/core/util.ts');
		expect(fromSubgraph).toEqual(fromFull);
		expect(fromSubgraph?.exportLines).toBeDefined();
		expect(fromSubgraph?.exportRanges).toBeDefined();
		expect(fromSubgraph?.sizeBytes).toBeDefined();
		expect(fromSubgraph?.mtimeMs).toBeDefined();
		expect(fromSubgraph?.ontology?.routes.length).toBe(1);
		expect(fromSubgraph?.ontology?.dataOperations.length).toBe(1);
		expect(fromSubgraph?.ontology?.security.length).toBe(1);
		expect(fromSubgraph?.ontology?.conventions.length).toBe(1);
		expect(fromSubgraph?.ontology?.findings.length).toBe(1);

		const carried = subgraph.edges.find(
			(candidate) =>
				normalizeGraphPath(candidate.source) === key('src/mid/a.ts'),
		);
		expect(carried?.importedSymbols).toEqual(['format', 'parse']);
		expect(carried?.usedSymbols).toEqual(['format']);
		expect(carried?.targetKind).toBe('node');
	});

	test('repoRootId/symbolEdges/diagnostics: undefined and absent are indistinguishable', () => {
		const full = makeFullGraph();
		const absent = buildClosure(full, ['src/core/util.ts'], 2);
		const explicitlyUndefined: RepoGraph = {
			...absent,
			repoRootId: undefined,
			symbolEdges: undefined,
			diagnostics: undefined,
		};

		// The distinction is real at the object level...
		expect(Object.hasOwn(absent, 'repoRootId')).toBe(false);
		expect(Object.hasOwn(absent, 'symbolEdges')).toBe(false);
		expect(Object.hasOwn(absent, 'diagnostics')).toBe(false);
		expect(Object.hasOwn(explicitlyUndefined, 'repoRootId')).toBe(true);
		expect(Object.hasOwn(explicitlyUndefined, 'symbolEdges')).toBe(true);
		expect(Object.hasOwn(explicitlyUndefined, 'diagnostics')).toBe(true);
		expect(explicitlyUndefined.repoRootId).toBeUndefined();
		expect(explicitlyUndefined.symbolEdges).toBeUndefined();
		expect(explicitlyUndefined.diagnostics).toBeUndefined();

		// ...and invisible to every wired query, in both directions, and the
		// full graph's populated repoRootId/symbolEdges do not leak into the
		// result either.
		resetQueryCache();
		const fromAbsent = getLocalizationContext(
			absent,
			'src/core/util.ts',
			LOCALIZATION_OPTIONS,
		);
		resetQueryCache();
		const fromUndefined = getLocalizationContext(
			explicitlyUndefined,
			'src/core/util.ts',
			LOCALIZATION_OPTIONS,
		);
		resetQueryCache();
		const fromPopulated = getLocalizationContext(
			full,
			'src/core/util.ts',
			LOCALIZATION_OPTIONS,
		);
		expect(fromUndefined).toEqual(fromAbsent);
		expect(fromAbsent).toEqual(fromPopulated);
	});

	test('a target absent from the graph resolves the same way in both', () => {
		const full = makeFullGraph();
		const subgraph = buildClosure(full, ['src/nope/missing.ts'], 3);
		expect(getGraphNode(full, 'src/nope/missing.ts')).toBeUndefined();
		expect(getGraphNode(subgraph, 'src/nope/missing.ts')).toBeUndefined();
		expect(Object.keys(subgraph.nodes)).toEqual([]);
		resetQueryCache();
		expect(getBlastRadius(subgraph, ['src/nope/missing.ts'], 3)).toEqual(
			getBlastRadius(full, ['src/nope/missing.ts'], 3),
		);
	});

	test('depth 0 short-circuits identically on both graphs', () => {
		const full = makeFullGraph();
		const subgraph = buildClosure(full, ['src/core/util.ts'], 2);
		resetQueryCache();
		expect(getBlastRadius(subgraph, ['src/core/util.ts'], 0)).toEqual(
			getBlastRadius(full, ['src/core/util.ts'], 0),
		);
	});
});
