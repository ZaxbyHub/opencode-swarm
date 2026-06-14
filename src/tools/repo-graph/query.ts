import * as path from 'node:path';
import type {
	BlastRadiusResult,
	FileOntology,
	FileReference,
	GraphEdge,
	GraphNode,
	LocalizationBlock,
	PackageBoundarySummary,
	RepoGraph,
	SymbolReference,
} from './types';
import { normalizeGraphPath } from './types';

let cachedReverseIndex: {
	graph: RepoGraph;
	index: Map<string, FileReference[]>;
	forwardIndex: Map<string, FileReference[]>;
	moduleNameIndex: Map<string, GraphNode>;
} | null = null;

function normalizeLookupPath(input: string): string {
	return normalizeGraphPath(input).replace(/^(?:\.\/)+/, '');
}

function graphRoot(graph: RepoGraph): string {
	return path.resolve(graph.workspaceRoot);
}

function toModuleName(graph: RepoGraph, input: string): string {
	const normalized = normalizeLookupPath(input);
	if (path.isAbsolute(normalized) || /^[A-Za-z]:\//.test(normalized)) {
		return normalizeLookupPath(path.relative(graphRoot(graph), normalized));
	}
	return normalized;
}

function absoluteKeyForModule(graph: RepoGraph, moduleName: string): string {
	return normalizeGraphPath(path.resolve(graphRoot(graph), moduleName));
}

export function getGraphNode(
	graph: RepoGraph,
	input: string,
): GraphNode | undefined {
	const moduleName = toModuleName(graph, input);
	const direct = graph.nodes[absoluteKeyForModule(graph, moduleName)];
	if (direct) return direct;
	return getQueryIndexes(graph).moduleNameIndex.get(moduleName);
}

function moduleNameForEdgePath(graph: RepoGraph, edgePath: string): string {
	const key = normalizeGraphPath(edgePath);
	const node = graph.nodes[key];
	if (node) return normalizeLookupPath(node.moduleName);
	return normalizeLookupPath(path.relative(graphRoot(graph), edgePath));
}

function buildReverseIndex(graph: RepoGraph): Map<string, FileReference[]> {
	const reverse = new Map<string, FileReference[]>();
	const forward = new Map<string, FileReference[]>();
	const moduleNameIndex = new Map<string, GraphNode>();
	for (const node of Object.values(graph.nodes)) {
		moduleNameIndex.set(normalizeLookupPath(node.moduleName), node);
	}
	for (const edge of graph.edges) {
		const source = normalizeGraphPath(edge.source);
		const target = normalizeGraphPath(edge.target);
		const sourceRef: FileReference = {
			file: moduleNameForEdgePath(graph, edge.source),
			importType: edge.importType,
		};
		const targetRef: FileReference = {
			file: moduleNameForEdgePath(graph, edge.target),
			importType: edge.importType,
		};
		const reverseRefs = reverse.get(target);
		if (reverseRefs) reverseRefs.push(sourceRef);
		else reverse.set(target, [sourceRef]);
		const forwardRefs = forward.get(source);
		if (forwardRefs) forwardRefs.push(targetRef);
		else forward.set(source, [targetRef]);
	}
	for (const refs of reverse.values()) {
		refs.sort((a, b) => a.file.localeCompare(b.file));
	}
	for (const refs of forward.values()) {
		refs.sort((a, b) => a.file.localeCompare(b.file));
	}
	cachedReverseIndex = {
		graph,
		index: reverse,
		forwardIndex: forward,
		moduleNameIndex,
	};
	return reverse;
}

function getQueryIndexes(
	graph: RepoGraph,
): NonNullable<typeof cachedReverseIndex> {
	if (cachedReverseIndex && cachedReverseIndex.graph === graph) {
		return cachedReverseIndex;
	}
	buildReverseIndex(graph);
	return cachedReverseIndex as NonNullable<typeof cachedReverseIndex>;
}

function getReverseIndex(graph: RepoGraph): Map<string, FileReference[]> {
	return getQueryIndexes(graph).index;
}

function getForwardIndex(graph: RepoGraph): Map<string, FileReference[]> {
	return getQueryIndexes(graph).forwardIndex;
}

export function resetQueryCache(): void {
	cachedReverseIndex = null;
}

export function isGraphFresh(
	graph: RepoGraph | null,
	maxAgeMs: number = 5 * 60 * 1000,
): boolean {
	if (!graph) return false;
	const built = Date.parse(graph.metadata?.generatedAt ?? '');
	if (!Number.isFinite(built)) return false;
	return Date.now() - built <= maxAgeMs;
}

export function getImporters(
	graph: RepoGraph,
	filePath: string,
): FileReference[] {
	const node = getGraphNode(graph, filePath);
	if (!node) return [];
	return getReverseIndex(graph).get(normalizeGraphPath(node.filePath)) ?? [];
}

export function getDependencies(
	graph: RepoGraph,
	filePath: string,
): FileReference[] {
	const node = getGraphNode(graph, filePath);
	if (!node) return [];
	const sourceKey = normalizeGraphPath(node.filePath);
	return getForwardIndex(graph).get(sourceKey) ?? [];
}

export function getSymbolConsumers(
	graph: RepoGraph,
	filePath: string,
	symbolName: string,
): SymbolReference[] {
	const node = getGraphNode(graph, filePath);
	if (!node) return [];
	const targetKey = normalizeGraphPath(node.filePath);
	const refs: SymbolReference[] = [];
	for (const edge of graph.edges) {
		if (normalizeGraphPath(edge.target) !== targetKey) continue;
		const importedSymbols = edge.importedSymbols ?? [];
		if (edge.importType === 'namespace') {
			refs.push({
				file: moduleNameForEdgePath(graph, edge.source),
				importedAs: '*',
			});
			continue;
		}
		if (importedSymbols.includes(symbolName)) {
			refs.push({
				file: moduleNameForEdgePath(graph, edge.source),
				importedAs: symbolName,
			});
		}
	}
	refs.sort((a, b) => a.file.localeCompare(b.file));
	return refs;
}

export function getBlastRadius(
	graph: RepoGraph,
	filePaths: string[],
	maxDepth = 3,
): BlastRadiusResult {
	const targetNodes = filePaths
		.map((filePath) => getGraphNode(graph, filePath))
		.filter((node): node is GraphNode => node !== undefined);
	const targets = targetNodes.map((node) =>
		normalizeLookupPath(node.moduleName),
	);
	if (maxDepth <= 0 || targetNodes.length === 0) {
		return {
			target: filePaths.map((filePath) => toModuleName(graph, filePath)),
			directDependents: [],
			transitiveDependents: [],
			depthReached: 0,
			totalDependents: 0,
			riskLevel: 'low',
		};
	}

	const reverse = getReverseIndex(graph);
	const visited = new Set(
		targetNodes.map((node) => normalizeGraphPath(node.filePath)),
	);
	const direct = new Set<string>();
	const transitive = new Set<string>();
	let depthReached = 0;
	let queue = targetNodes.map((node) => ({
		key: normalizeGraphPath(node.filePath),
		depth: 0,
	}));

	while (queue.length > 0) {
		const next: typeof queue = [];
		for (const { key, depth } of queue) {
			const importers = reverse.get(key) ?? [];
			for (const ref of importers) {
				const importerNode = getGraphNode(graph, ref.file);
				if (!importerNode) continue;
				const importerKey = normalizeGraphPath(importerNode.filePath);
				if (visited.has(importerKey)) continue;
				visited.add(importerKey);
				if (depth === 0) direct.add(ref.file);
				else transitive.add(ref.file);
				depthReached = Math.max(depthReached, depth + 1);
				if (depth + 1 < maxDepth) {
					next.push({ key: importerKey, depth: depth + 1 });
				}
			}
		}
		queue = next;
	}

	const totalDependents = direct.size + transitive.size;
	return {
		target: targets,
		directDependents: [...direct].sort(),
		transitiveDependents: [...transitive].sort(),
		depthReached,
		totalDependents,
		riskLevel: classifyRisk(totalDependents),
	};
}

function classifyRisk(count: number): BlastRadiusResult['riskLevel'] {
	if (count <= 3) return 'low';
	if (count <= 10) return 'medium';
	if (count <= 25) return 'high';
	return 'critical';
}

export function getKeyFiles(graph: RepoGraph, topN = 10): GraphNode[] {
	const reverse = getReverseIndex(graph);
	const scored = Object.values(graph.nodes).map((node) => ({
		node,
		inDegree: reverse.get(normalizeGraphPath(node.filePath))?.length ?? 0,
	}));
	scored.sort((a, b) => {
		if (b.inDegree !== a.inDegree) return b.inDegree - a.inDegree;
		return a.node.moduleName.localeCompare(b.node.moduleName);
	});
	return scored.slice(0, topN).map((item) => item.node);
}

export function getFileOntology(
	graph: RepoGraph,
	filePath: string,
): FileOntology | null {
	return getGraphNode(graph, filePath)?.ontology ?? null;
}

export function getLocalizationContext(
	graph: RepoGraph,
	filePath: string,
	options: { maxImporters?: number; maxDeps?: number; maxDepth?: number } = {},
): LocalizationBlock {
	const target = toModuleName(graph, filePath);
	const node = getGraphNode(graph, target);
	const importers = getImporters(graph, target);
	const dependencies = getDependencies(graph, target);
	const blast = getBlastRadius(graph, [target], options.maxDepth ?? 2);
	const externalSymbols = collectExternallyUsedSymbols(graph, node);
	const summary = formatLocalizationSummary({
		target,
		importers,
		dependencies,
		blast,
		externalSymbols,
		ontology: node?.ontology ?? null,
		maxImporters: options.maxImporters ?? 5,
		maxDeps: options.maxDeps ?? 5,
	});

	return {
		target,
		importerCount: importers.length,
		importers: importers.slice(0, options.maxImporters ?? 5),
		dependencyCount: dependencies.length,
		dependencies: dependencies.slice(0, options.maxDeps ?? 5),
		exportedSymbolsUsedExternally: externalSymbols,
		blastRadius: blast,
		summary,
	};
}

function collectExternallyUsedSymbols(
	graph: RepoGraph,
	node: GraphNode | undefined,
): string[] {
	if (!node) return [];
	const exported = new Set(node.exports);
	const used = new Set<string>();
	const targetKey = normalizeGraphPath(node.filePath);
	for (const edge of graph.edges) {
		if (normalizeGraphPath(edge.target) !== targetKey) continue;
		for (const symbol of edge.importedSymbols ?? []) {
			if (exported.has(symbol)) used.add(symbol);
		}
	}
	return [...used].sort((a, b) => a.localeCompare(b));
}

function formatLocalizationSummary(opts: {
	target: string;
	importers: FileReference[];
	dependencies: FileReference[];
	blast: BlastRadiusResult;
	externalSymbols: string[];
	ontology: FileOntology | null;
	maxImporters: number;
	maxDeps: number;
}): string {
	const importerList =
		opts.importers.length === 0
			? '(none)'
			: opts.importers
					.slice(0, opts.maxImporters)
					.map((ref) => ref.file)
					.join(', ') +
				(opts.importers.length > opts.maxImporters
					? `, +${opts.importers.length - opts.maxImporters} more`
					: '');
	const depList =
		opts.dependencies.length === 0
			? '(none)'
			: opts.dependencies
					.slice(0, opts.maxDeps)
					.map((ref) => ref.file)
					.join(', ') +
				(opts.dependencies.length > opts.maxDeps
					? `, +${opts.dependencies.length - opts.maxDeps} more`
					: '');
	const symbolList =
		opts.externalSymbols.length === 0
			? '(none used externally)'
			: opts.externalSymbols.slice(0, 8).join(', ') +
				(opts.externalSymbols.length > 8
					? `, +${opts.externalSymbols.length - 8} more`
					: '');
	const roles = opts.ontology?.roles.join(', ') || 'unknown';
	const findings = opts.ontology?.findings.length ?? 0;
	return [
		'LOCALIZATION CONTEXT',
		`  Target: ${opts.target}`,
		`  Roles: ${roles}`,
		`  Imported by (${opts.importers.length}): ${importerList}`,
		`  Imports (${opts.dependencies.length}): ${depList}`,
		`  Exports used externally: ${symbolList}`,
		`  Blast radius: ${opts.blast.totalDependents} files (${opts.blast.riskLevel} risk)`,
		`  Ontology findings: ${findings}`,
	].join('\n');
}

export function getPackageBoundaries(
	graph: RepoGraph,
	topN = 25,
): PackageBoundarySummary[] {
	return summarizePackageBoundaries(
		Object.values(graph.nodes),
		graph.edges,
		topN,
	);
}

function summarizePackageBoundaries(
	nodes: GraphNode[],
	edges: GraphEdge[],
	topN: number,
): PackageBoundarySummary[] {
	const groups = new Map<string, PackageBoundarySummary>();
	const ensure = (node: GraphNode): PackageBoundarySummary => {
		const ontology = node.ontology;
		const name = ontology?.packageBoundary || inferBoundary(node.moduleName);
		let group = groups.get(name);
		if (!group) {
			group = {
				name,
				root: name,
				fileCount: 0,
				roles: {},
				dependsOn: [],
				dependedOnBy: [],
				routeCount: 0,
				dataOperationCount: 0,
				findingCount: 0,
				publicFiles: [],
			};
			groups.set(name, group);
		}
		return group;
	};

	const boundaryByPath = new Map<string, string>();
	for (const node of nodes) {
		const group = ensure(node);
		boundaryByPath.set(normalizeGraphPath(node.filePath), group.name);
		group.fileCount++;
		const ontology = node.ontology;
		for (const role of ontology?.roles ?? ['source_module']) {
			group.roles[role] = (group.roles[role] ?? 0) + 1;
		}
		group.routeCount += ontology?.routes.length ?? 0;
		group.dataOperationCount += ontology?.dataOperations.length ?? 0;
		group.findingCount += ontology?.findings.length ?? 0;
		if (node.exports.length > 0) {
			group.publicFiles.push(node.moduleName);
		}
	}

	const dependsOn = new Map<string, Set<string>>();
	const dependedOnBy = new Map<string, Set<string>>();
	for (const edge of edges) {
		const sourceBoundary = boundaryByPath.get(normalizeGraphPath(edge.source));
		const targetBoundary = boundaryByPath.get(normalizeGraphPath(edge.target));
		if (
			!sourceBoundary ||
			!targetBoundary ||
			sourceBoundary === targetBoundary
		) {
			continue;
		}
		if (!dependsOn.has(sourceBoundary))
			dependsOn.set(sourceBoundary, new Set());
		if (!dependedOnBy.has(targetBoundary)) {
			dependedOnBy.set(targetBoundary, new Set());
		}
		dependsOn.get(sourceBoundary)?.add(targetBoundary);
		dependedOnBy.get(targetBoundary)?.add(sourceBoundary);
	}

	for (const group of groups.values()) {
		group.dependsOn = [...(dependsOn.get(group.name) ?? [])].sort();
		group.dependedOnBy = [...(dependedOnBy.get(group.name) ?? [])].sort();
		group.publicFiles.sort((a, b) => a.localeCompare(b));
		group.publicFiles = group.publicFiles.slice(0, 20);
	}

	return [...groups.values()]
		.sort((a, b) => {
			if (b.findingCount !== a.findingCount) {
				return b.findingCount - a.findingCount;
			}
			if (b.fileCount !== a.fileCount) return b.fileCount - a.fileCount;
			return a.name.localeCompare(b.name);
		})
		.slice(0, topN);
}

function summarizeSelectedPackageBoundaries(
	nodes: GraphNode[],
	topN = 25,
): PackageBoundarySummary[] {
	return summarizePackageBoundaries(nodes, [], topN);
}

function inferBoundary(moduleName: string): string {
	const parts = normalizeLookupPath(moduleName).split('/').filter(Boolean);
	if (parts[0] === 'src' && parts.length >= 2) return `src/${parts[1]}`;
	if (parts.length >= 2 && (parts[0] === 'packages' || parts[0] === 'crates')) {
		return `${parts[0]}/${parts[1]}`;
	}
	return parts[0] || '.';
}

export function buildOntologyPreflightPacket(
	graph: RepoGraph,
	filePaths: string[] = [],
	options: {
		maxFiles?: number;
		maxFindings?: number;
		maxBoundaries?: number;
	} = {},
): Record<string, unknown> {
	const maxFiles = options.maxFiles ?? 12;
	const maxFindings = options.maxFindings ?? 20;
	const selectedNodes =
		filePaths.length > 0
			? filePaths
					.map((filePath) => getGraphNode(graph, filePath))
					.filter((node): node is GraphNode => node !== undefined)
			: getKeyFiles(graph, maxFiles);
	const boundedNodes = selectedNodes.slice(0, maxFiles);
	const findings = boundedNodes
		.flatMap((node) =>
			(node.ontology?.findings ?? []).map((finding) => ({
				file: node.moduleName,
				...finding,
			})),
		)
		.slice(0, maxFindings);
	const routes = boundedNodes.flatMap((node) =>
		(node.ontology?.routes ?? []).map((route) => ({
			file: node.moduleName,
			...route,
		})),
	);
	const dataOperations = boundedNodes.flatMap((node) =>
		(node.ontology?.dataOperations ?? []).map((fact) => ({
			file: node.moduleName,
			...fact,
		})),
	);
	const security = boundedNodes.flatMap((node) =>
		(node.ontology?.security ?? []).map((fact) => ({
			file: node.moduleName,
			...fact,
		})),
	);

	return {
		generatedAt: new Date().toISOString(),
		targets: boundedNodes.map((node) => node.moduleName),
		summary: {
			fileCount: Object.keys(graph.nodes).length,
			edgeCount: graph.edges.length,
			targetCount: boundedNodes.length,
			findingCount: findings.length,
			routeCount: routes.length,
			dataOperationCount: dataOperations.length,
			securityFactCount: security.length,
		},
		files: boundedNodes.map((node) => ({
			file: node.moduleName,
			roles: node.ontology?.roles ?? [],
			packageBoundary:
				node.ontology?.packageBoundary ?? inferBoundary(node.moduleName),
			importerCount: getImporters(graph, node.moduleName).length,
			dependencyCount: getDependencies(graph, node.moduleName).length,
			routeCount: node.ontology?.routes.length ?? 0,
			dataOperationCount: node.ontology?.dataOperations.length ?? 0,
			securityFactCount: node.ontology?.security.length ?? 0,
			findingCount: node.ontology?.findings.length ?? 0,
		})),
		routes,
		dataOperations,
		security,
		findings,
		packageBoundaries: summarizeSelectedPackageBoundaries(
			boundedNodes,
			options.maxBoundaries ?? 10,
		),
	};
}
