/**
 * KG-15 change-risk pack queries (issue #1536).
 *
 * Route, data, and test packs over the persisted repo graph: `route_trace`,
 * `data_trace`, and `test_pack`. Every function is stateless and read-only:
 * inputs are validated by the `repo_map` tool layer; this module assumes
 * well-formed arguments and focuses on bounded, workspace-relative,
 * evidence-bearing output (the same contract as `symbol-query.ts`).
 *
 * Schema note: route/data packs read persisted `ontology.links` (schema
 * >= 1.7.0) and degrade with `linksSupported: false` + warnings on older
 * graphs, where the edges/facts-derived sections still populate. Test packs
 * derive TESTS / USES_FIXTURE associations at query time from persisted
 * edges plus colocated-name heuristics, so they work on every schema.
 */

import * as path from 'node:path';
import { normalizeRoutePathInput } from './ontology';
import { getDependencies, getGraphNode, getImporters } from './query';
import { getDiffContext } from './symbol-query';
import type {
	DataOperationFact,
	DataTraceAccess,
	DataTraceResult,
	DerivedAssociation,
	GraphNode,
	OntologyFinding,
	OntologyLink,
	OntologyLinkConfidence,
	RepoGraph,
	RouteFact,
	RouteMethod,
	RouteTraceResult,
	RouteTraceRoute,
	SecurityFact,
	TestPackFixture,
	TestPackResult,
	TestPackTestEntry,
} from './types';
import { isSchemaVersionAtLeast, normalizeGraphPath } from './types';

const PACK_DEFAULT_TOP_N = 25;
/** Parity with the impact-cone ontology caps (symbol-query.ts CONE_ONTOLOGY_CAP). */
const PACK_ONTOLOGY_CAP = 20;
const PACK_MAX_TARGET_FILES = 50;
/** Cap on materialized TESTS/USES_FIXTURE association records (bounded output). */
const PACK_ASSOCIATIONS_CAP = 200;
const LINKS_SCHEMA_MINIMUM = '1.7.0';

const OPERATION_KIND: Record<
	DataOperationFact['operation'],
	'READS' | 'WRITES' | 'DELETES'
> = {
	read: 'READS',
	write: 'WRITES',
	delete: 'DELETES',
	transaction: 'WRITES',
	migration: 'WRITES',
};

/** Fixture-pattern segments/basenames used for USES_FIXTURE derivation. */
const FIXTURE_SEGMENT_PATTERN = /^(fixtures?|__fixtures__|mocks?|factories)$/;
const FIXTURE_BASENAME_PATTERN =
	/(fixture|mock|factory|test-?utils?|test-?helpers?|testing-?utils)/;
const TEST_FILE_PATTERN = /\.(test|spec)\.[cm]?[jt]sx?$/;
const TEST_DIR_PATTERN = /(^|\/)(__tests__|tests?)\//;

// ============ Shared helpers ============

function graphRoot(graph: RepoGraph): string {
	return path.resolve(graph.workspaceRoot);
}

/** Workspace-relative, forward-slash display path (same contract as symbol-query.ts). */
function rel(graph: RepoGraph, file: string): string {
	const normalized = normalizeGraphPath(file);
	if (!path.isAbsolute(normalized)) return normalized.replace(/\\/g, '/');
	try {
		const relPath = path.relative(graphRoot(graph), normalized);
		if (relPath.startsWith('..') || path.isAbsolute(relPath)) {
			return normalized.replace(/\\/g, '/');
		}
		return relPath.replace(/\\/g, '/');
	} catch {
		return normalized.replace(/\\/g, '/');
	}
}

function isTestNode(node: GraphNode | undefined): boolean {
	if (!node) return false;
	if (node.ontology?.roles?.includes('test_file')) return true;
	return (
		TEST_FILE_PATTERN.test(node.moduleName) ||
		TEST_DIR_PATTERN.test(node.moduleName)
	);
}

function linksOf(node: GraphNode | undefined): OntologyLink[] {
	return node?.ontology?.links ?? [];
}

function linksSupportedFor(graph: RepoGraph): boolean {
	return isSchemaVersionAtLeast(graph.schema_version, LINKS_SCHEMA_MINIMUM);
}

function linksRebuildWarning(): string {
	return `graph predates ontology links (schema ${LINKS_SCHEMA_MINIMUM}+); rebuild with repo_map action="build" for symbol-bound route/data links`;
}

/** Sorted, deduped importers of `fileKey` that are test files (module-name paths). */
function testImportersOf(
	graph: RepoGraph,
	fileKeys: string[],
	topN: number,
): string[] {
	const seen = new Set<string>();
	for (const fileKey of fileKeys) {
		const node = getGraphNode(graph, fileKey);
		if (!node) continue;
		for (const ref of getImporters(graph, node.filePath)) {
			if (seen.size >= topN) break;
			const importer = getGraphNode(graph, ref.file);
			if (!importer || !isTestNode(importer)) continue;
			const relFile = rel(graph, importer.filePath);
			if (relFile) seen.add(relFile);
		}
	}
	return [...seen].sort((a, b) => a.localeCompare(b));
}

/** Depth-1 non-test node dependencies of a handler file (module-name paths). */
function servicesOf(graph: RepoGraph, node: GraphNode, topN: number): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const ref of getDependencies(graph, node.filePath)) {
		const dep = getGraphNode(graph, ref.file);
		if (!dep || isTestNode(dep)) continue;
		const relFile = rel(graph, dep.filePath);
		if (!relFile || seen.has(relFile)) continue;
		seen.add(relFile);
		out.push(relFile);
		if (out.length >= topN) break;
	}
	return out.sort((a, b) => a.localeCompare(b));
}

/** Resolve the handler binding for one route fact (link first, structure fallback). */
function handlerBindingFor(
	node: GraphNode,
	fact: RouteFact,
	linksSupported: boolean,
): {
	symbol: string | null;
	confidence: OntologyLinkConfidence | null;
	evidence: string | null;
} {
	if (linksSupported) {
		const subject = `${fact.method} ${fact.path}`;
		const link = linksOf(node).find(
			(candidate) =>
				candidate.kind === 'HANDLES_ROUTE' && candidate.subject === subject,
		);
		if (link) {
			return {
				symbol: link.symbol ?? null,
				confidence: link.confidence,
				evidence: link.evidence ?? null,
			};
		}
	}
	// Structural fallback: a handler_export route's handler IS the method-named
	// export, with or without links. Confidence/evidence stay null — only a
	// link attests them.
	if (fact.source === 'handler_export') {
		return { symbol: fact.method, confidence: null, evidence: null };
	}
	return { symbol: null, confidence: null, evidence: null };
}

/** Import specifier of the first edge from `sourceNode` to `targetNode`, or ''. */
function importSpecifierFor(
	graph: RepoGraph,
	sourceNode: GraphNode,
	targetNode: GraphNode,
): string {
	const sourceKey = normalizeGraphPath(sourceNode.filePath);
	const targetKey = normalizeGraphPath(targetNode.filePath);
	for (const edge of graph.edges) {
		if (normalizeGraphPath(edge.source) !== sourceKey) continue;
		if (normalizeGraphPath(edge.target) !== targetKey) continue;
		return edge.importSpecifier;
	}
	return '';
}

// ============ route_trace ============

export function traceRoute(
	graph: RepoGraph,
	options: {
		routePath?: string;
		method?: RouteMethod;
		file?: string;
		symbol?: string;
		topN?: number;
	},
): RouteTraceResult {
	const topN = options.topN ?? PACK_DEFAULT_TOP_N;
	const linksSupported = linksSupportedFor(graph);
	const warnings: string[] = [];
	const normalizedInputPath = options.routePath
		? normalizeRoutePathInput(options.routePath)
		: null;

	const scopeNodes: GraphNode[] = [];
	if (options.file !== undefined) {
		const node = getGraphNode(graph, options.file);
		if (!node) {
			warnings.push(`file not found in graph: ${options.file}`);
		} else {
			scopeNodes.push(node);
		}
	} else {
		scopeNodes.push(...Object.values(graph.nodes));
	}

	if (
		options.symbol !== undefined &&
		options.routePath === undefined &&
		options.file === undefined
	) {
		// Symbol-only lookup is only meaningful for route handlers.
		const withRouteRole = scopeNodes.filter((node) =>
			node.ontology?.roles?.includes('api_route'),
		);
		if (withRouteRole.length === 0) {
			warnings.push(
				'symbol-only route_trace requires api_route-role files; none found',
			);
		}
		scopeNodes.length = 0;
		scopeNodes.push(...withRouteRole);
	}

	type Match = { node: GraphNode; fact: RouteFact };
	const matches: Match[] = [];
	for (const node of scopeNodes) {
		const routes = node.ontology?.routes ?? [];
		for (const fact of routes) {
			if (normalizedInputPath !== null) {
				const factPath = normalizeRoutePathInput(fact.path);
				if (factPath !== normalizedInputPath) continue;
			}
			// Filters compose with every target form (path, file, symbol) —
			// silently ignoring `method`/`symbol` outside the path branch was
			// a confirmed review bug.
			if (
				options.method !== undefined &&
				fact.method !== options.method &&
				fact.method !== 'ALL'
			) {
				continue;
			}
			if (options.symbol !== undefined) {
				const binding = handlerBindingFor(node, fact, linksSupported);
				if (binding.symbol !== options.symbol) continue;
			}
			matches.push({ node, fact });
		}
		if (matches.length > topN * 10) break; // defensive scan bound
	}

	const routesOut: RouteTraceRoute[] = matches
		.slice(0, topN)
		.map(({ node, fact }) => {
			const handlerFile = rel(graph, node.filePath);
			const binding = handlerBindingFor(node, fact, linksSupported);
			const services = servicesOf(graph, node, topN);
			const packFiles = [node.filePath];
			for (const service of services) {
				const serviceNode = getGraphNode(graph, service);
				if (serviceNode) packFiles.push(serviceNode.filePath);
			}
			const dataOperations: Array<{ file: string; fact: DataOperationFact }> =
				[];
			const security: Array<{ file: string; fact: SecurityFact }> = [];
			for (const fileKey of packFiles) {
				const packNode = getGraphNode(graph, fileKey);
				const fileRel = rel(graph, packNode?.filePath ?? fileKey);
				for (const dataFact of packNode?.ontology?.dataOperations ?? []) {
					if (dataOperations.length >= PACK_ONTOLOGY_CAP) break;
					dataOperations.push({ file: fileRel, fact: dataFact });
				}
				for (const securityFact of packNode?.ontology?.security ?? []) {
					if (security.length >= PACK_ONTOLOGY_CAP) break;
					security.push({ file: fileRel, fact: securityFact });
				}
			}
			const findings: Array<{ file: string; finding: OntologyFinding }> = (
				node.ontology?.findings ?? []
			).map((finding) => ({ file: handlerFile, finding }));
			const tests = testImportersOf(graph, packFiles, topN);
			return {
				route: {
					method: fact.method,
					path: fact.path,
					line: fact.line ?? null,
					source: fact.source,
				},
				file: handlerFile,
				handlerSymbol: binding.symbol,
				handlerConfidence: binding.confidence,
				handlerEvidence: binding.evidence,
				services,
				dataOperations,
				security,
				findings,
				tests,
			};
		});

	if (!linksSupported) {
		warnings.push(linksRebuildWarning());
	}
	if (matches.length === 0) {
		warnings.push(
			normalizedInputPath !== null
				? `no routes matched path ${normalizedInputPath}`
				: 'no routes matched the given target',
		);
	}
	const dropped = Math.max(0, matches.length - routesOut.length);
	if (dropped > 0) {
		warnings.push(`${dropped} route(s) omitted by top_n=${topN}`);
	}

	return {
		target: {
			routePath: normalizedInputPath,
			method: options.method ?? null,
			file: options.file ? rel(graph, options.file) : null,
			symbol: options.symbol ?? null,
		},
		routes: routesOut,
		linksSupported,
		budget: { returned: routesOut.length, dropped },
		truncated: dropped > 0,
		warnings: [...new Set(warnings)],
	};
}

// ============ data_trace ============

export function traceData(
	graph: RepoGraph,
	options: {
		entity?: string;
		file?: string;
		symbol?: string;
		topN?: number;
	},
): DataTraceResult {
	const topN = options.topN ?? PACK_DEFAULT_TOP_N;
	const linksSupported = linksSupportedFor(graph);
	const warnings: string[] = [];

	// Scope: explicit file, or symbol → files exporting it, or the whole graph.
	let scopeNodes: GraphNode[] = [];
	if (options.file !== undefined) {
		const node = getGraphNode(graph, options.file);
		if (!node) warnings.push(`file not found in graph: ${options.file}`);
		else scopeNodes.push(node);
	} else if (options.symbol !== undefined) {
		scopeNodes = Object.values(graph.nodes).filter((node) =>
			node.exports.includes(options.symbol as string),
		);
		if (scopeNodes.length === 0) {
			warnings.push(`no graph file exports symbol: ${options.symbol}`);
		}
	} else {
		scopeNodes = Object.values(graph.nodes);
	}

	const entityLower = options.entity?.toLowerCase();
	const matches: DataTraceAccess[] = [];
	let subject: string | null = null;
	const seenFactKeys = new Set<string>();
	/** linkKey = file\0kind\0line\0subject — link coverage is entity-exact. */
	const linkKeys = new Set<string>();

	const isDataKind = (
		kind: OntologyLink['kind'],
	): kind is 'READS' | 'WRITES' | 'DELETES' | 'CONFIGURES' =>
		kind === 'READS' ||
		kind === 'WRITES' ||
		kind === 'DELETES' ||
		kind === 'CONFIGURES';

	for (const node of scopeNodes) {
		const fileRel = rel(graph, node.filePath);
		// Link-backed matches (schema >= 1.7.0).
		for (const link of linksOf(node)) {
			if (!isDataKind(link.kind)) continue;
			if (entityLower !== undefined) {
				if (!link.subject || link.subject.toLowerCase() !== entityLower) {
					continue;
				}
			} else if (!link.subject) {
				continue;
			}
			if (subject === null && link.subject) subject = link.subject;
			linkKeys.add(
				`${fileRel}\0${link.kind}\0${link.line ?? 0}\0${(
					link.subject ?? ''
				).toLowerCase()}`,
			);
			matches.push({
				file: fileRel,
				kind: link.kind,
				symbol: link.symbol ?? null,
				line: link.line ?? null,
				evidence: link.evidence ?? null,
				confidence: link.confidence,
				via: 'link',
			});
		}
		// Fact fallback: DataOperationFact.entity works on every schema. A link
		// already covers the same fact on 1.7.0 graphs, so prefer the link and
		// drop the duplicate fact — keyed by file + kind + line + ENTITY so a
		// same-line fact for a different entity always survives.
		for (const fact of node.ontology?.dataOperations ?? []) {
			if (!fact.entity) continue;
			if (
				entityLower !== undefined &&
				fact.entity.toLowerCase() !== entityLower
			) {
				continue;
			}
			const kind = OPERATION_KIND[fact.operation];
			const factKey = `${fileRel}\0${kind}\0${fact.line}\0${fact.entity.toLowerCase()}`;
			if (seenFactKeys.has(factKey)) continue;
			if (
				linkKeys.has(
					`${fileRel}\0${kind}\0${fact.line}\0${fact.entity.toLowerCase()}`,
				)
			) {
				continue;
			}
			seenFactKeys.add(factKey);
			if (subject === null) subject = fact.entity;
			matches.push({
				file: fileRel,
				kind,
				symbol: null,
				line: fact.line,
				evidence: fact.evidence,
				confidence: null,
				via: 'fact',
			});
		}
	}

	const cap = (
		list: DataTraceAccess[],
	): { kept: DataTraceAccess[]; dropped: number } => {
		const sorted = [...list].sort(
			(a, b) => a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0),
		);
		return {
			kept: sorted.slice(0, topN),
			dropped: Math.max(0, sorted.length - topN),
		};
	};
	const readers = cap(matches.filter((m) => m.kind === 'READS'));
	const writers = cap(matches.filter((m) => m.kind === 'WRITES'));
	const deleters = cap(matches.filter((m) => m.kind === 'DELETES'));
	const configurers = cap(matches.filter((m) => m.kind === 'CONFIGURES'));

	// Touching files (entity- or scope-bearing) drive routes/tests/risk notes.
	const touchingFiles = [...new Set(matches.map((m) => m.file))].sort();
	const routes: Array<{ file: string; fact: RouteFact }> = [];
	for (const fileRel of touchingFiles) {
		const node = getGraphNode(graph, fileRel);
		for (const fact of node?.ontology?.routes ?? []) {
			if (routes.length >= PACK_ONTOLOGY_CAP) break;
			routes.push({ file: fileRel, fact });
		}
	}
	const touchingKeys = touchingFiles
		.map((fileRel) => getGraphNode(graph, fileRel)?.filePath)
		.filter((key): key is string => typeof key === 'string');
	const tests = testImportersOf(graph, touchingKeys, topN);

	const riskNotes: string[] = [];
	const subjectLabel = options.entity ?? 'target';
	if (touchingFiles.length > 0 && tests.length === 0) {
		riskNotes.push(`no tests detected for ${subjectLabel}`);
	}
	if (deleters.kept.length > 0) {
		riskNotes.push(
			`delete operations on ${subjectLabel} in ${deleters.kept.length} file(s) — verify backup/transaction coverage`,
		);
	}
	const writerBoundaries = new Set(
		writers.kept.map((m) => {
			const node = getGraphNode(graph, m.file);
			return node?.ontology?.packageBoundary ?? 'unknown';
		}),
	);
	if (writers.kept.length > 1 && writerBoundaries.size > 1) {
		riskNotes.push(
			`${subjectLabel} is written in ${writers.kept.length} file(s) across ${writerBoundaries.size} package boundaries`,
		);
	}

	const dropped =
		readers.dropped + writers.dropped + deleters.dropped + configurers.dropped;
	if (dropped > 0) {
		warnings.push(`${dropped} access(es) omitted by top_n=${topN}`);
	}
	if (!linksSupported) {
		warnings.push(linksRebuildWarning());
		if (matches.some((m) => m.via === 'fact')) {
			warnings.push(
				'entity matching on this graph uses the DataOperationFact fallback; link-backed confidence requires a schema 1.7.0+ rebuild',
			);
		}
	}
	if (entityLower !== undefined && matches.length === 0) {
		warnings.push(`no data access matched entity: ${options.entity}`);
	}

	return {
		target: {
			entity: options.entity ?? null,
			file: options.file ? rel(graph, options.file) : null,
			symbol: options.symbol ?? null,
		},
		subject,
		readers: readers.kept,
		writers: writers.kept,
		deleters: deleters.kept,
		configurers: configurers.kept,
		routes,
		tests,
		riskNotes,
		linksSupported,
		budget: { returned: matches.length - dropped, dropped },
		truncated: dropped > 0,
		warnings: [...new Set(warnings)],
	};
}

// ============ test_pack ============

function isFixtureModule(moduleName: string): boolean {
	const normalized = moduleName.replace(/\\/g, '/').toLowerCase();
	const segments = normalized.split('/');
	for (const segment of segments.slice(0, -1)) {
		if (FIXTURE_SEGMENT_PATTERN.test(segment)) return true;
	}
	const basename = segments[segments.length - 1] ?? '';
	return FIXTURE_BASENAME_PATTERN.test(basename.replace(/\.[^.]+$/, ''));
}

function colocatedTestFor(
	graph: RepoGraph,
	target: GraphNode,
): GraphNode | undefined {
	const normalized = target.moduleName.replace(/\\/g, '/');
	const dir = normalized.slice(0, normalized.lastIndexOf('/') + 1);
	const base = (normalized.split('/').pop() ?? '').replace(/\.[^.]+$/, '');
	if (!base) return undefined;
	for (const node of Object.values(graph.nodes)) {
		const candidate = node.moduleName.replace(/\\/g, '/');
		if (!candidate.startsWith(dir)) continue;
		if (!TEST_FILE_PATTERN.test(candidate)) continue;
		// Strip the full `.test.`/`.spec.` + extension tail so `widget.spec.ts`
		// yields base `widget` and `user.service.test.ts` yields
		// `user.service` (a second extension strip would mis-associate the
		// latter with `user.ts` — review finding).
		const candidateBase = (candidate.split('/').pop() ?? '').replace(
			/\.(test|spec)\.[cm]?[jt]sx?$/,
			'',
		);
		if (candidateBase !== base) continue;
		return node;
	}
	return undefined;
}

function coveredSymbolsFor(
	graph: RepoGraph,
	testNode: GraphNode,
	targetNode: GraphNode,
): string[] {
	const testKey = normalizeGraphPath(testNode.filePath);
	const targetKey = normalizeGraphPath(targetNode.filePath);
	const referenced = new Set<string>();
	for (const edge of graph.edges) {
		if (normalizeGraphPath(edge.source) !== testKey) continue;
		if (normalizeGraphPath(edge.target) !== targetKey) continue;
		for (const symbol of edge.importedSymbols ?? []) referenced.add(symbol);
		for (const symbol of edge.usedSymbols ?? []) referenced.add(symbol);
	}
	return targetNode.exports
		.filter((symbol) => referenced.has(symbol))
		.sort((a, b) => a.localeCompare(b));
}

export function buildTestPack(
	graph: RepoGraph,
	options: {
		file?: string;
		files?: string[];
		symbol?: string;
		diff?: string;
		topN?: number;
	},
): TestPackResult {
	const topN = options.topN ?? PACK_DEFAULT_TOP_N;
	const warnings: string[] = [];

	// Resolve target files: files > file > symbol-owning files > diff-derived.
	// The 50-file cap is disclosed via a warning (silent truncation was a
	// review finding) and counted into budget.dropped.
	let targetFiles: string[] = [];
	let droppedTargets = 0;
	const noteTargetCap = (total: number): void => {
		if (total > PACK_MAX_TARGET_FILES) {
			droppedTargets = total - PACK_MAX_TARGET_FILES;
			warnings.push(
				`${droppedTargets} target file(s) omitted by the ${PACK_MAX_TARGET_FILES}-file cap`,
			);
		}
	};
	const inputFiles = options.files?.length
		? [...new Set(options.files)]
		: options.file
			? [options.file]
			: [];
	if (inputFiles.length > 0) {
		noteTargetCap(inputFiles.length);
		for (const input of inputFiles.slice(0, PACK_MAX_TARGET_FILES)) {
			const node = getGraphNode(graph, input);
			if (!node) {
				warnings.push(`file not found in graph: ${input}`);
				continue;
			}
			targetFiles.push(rel(graph, node.filePath));
		}
	} else if (options.symbol !== undefined) {
		const owners = Object.values(graph.nodes).filter((node) =>
			node.exports.includes(options.symbol as string),
		);
		noteTargetCap(owners.length);
		targetFiles = owners
			.slice(0, PACK_MAX_TARGET_FILES)
			.map((node) => rel(graph, node.filePath));
		if (targetFiles.length === 0) {
			warnings.push(`no graph file exports symbol: ${options.symbol}`);
		}
	} else if (options.diff !== undefined) {
		const diffContext = getDiffContext(graph, { diff: options.diff, topN });
		const knownFiles = diffContext.files.filter((summary) => summary.known);
		noteTargetCap(knownFiles.length);
		targetFiles = knownFiles
			.slice(0, PACK_MAX_TARGET_FILES)
			.map((summary) => summary.file);
		warnings.push(...diffContext.warnings);
		if (targetFiles.length === 0) {
			warnings.push('diff resolved to no known graph files');
		}
	}

	const testsByFile = new Map<string, TestPackTestEntry>();
	const colocatedOnlyTargets = new Set<string>();
	// Materialized TESTS / USES_FIXTURE associations so the two derived link
	// kinds are consumer-visible with evidence and confidence.
	const associations: DerivedAssociation[] = [];
	let droppedAssociations = 0;
	const noteAssociation = (entry: DerivedAssociation): void => {
		if (associations.length < PACK_ASSOCIATIONS_CAP) associations.push(entry);
		else droppedAssociations += 1;
	};
	// Per-target covered symbols: an export covered on one target must not be
	// masked by a same-named export covered on a different target.
	const targetCovered = new Map<string, Set<string>>();
	const noteCovered = (targetRel: string, symbols: string[]): void => {
		const set = targetCovered.get(targetRel) ?? new Set<string>();
		for (const symbol of symbols) set.add(symbol);
		targetCovered.set(targetRel, set);
	};
	for (const targetRel of targetFiles) {
		const targetNode = getGraphNode(graph, targetRel);
		if (!targetNode) continue;
		let importBasisCount = 0;
		for (const ref of getImporters(graph, targetNode.filePath)) {
			const testNode = getGraphNode(graph, ref.file);
			if (!testNode || !isTestNode(testNode)) continue;
			const testRel = rel(graph, testNode.filePath);
			const covered = coveredSymbolsFor(graph, testNode, targetNode);
			noteCovered(targetRel, covered);
			const specifier = importSpecifierFor(graph, testNode, targetNode);
			noteAssociation({
				kind: 'TESTS',
				fromFile: testRel,
				toFile: targetRel,
				evidence: specifier,
				confidence: 'high',
			});
			const existing = testsByFile.get(testRel);
			if (existing) {
				existing.coveredSymbols = [
					...new Set([...existing.coveredSymbols, ...covered]),
				].sort((a, b) => a.localeCompare(b));
			} else {
				testsByFile.set(testRel, {
					file: testRel,
					confidence: 'high',
					basis: 'import',
					evidence: specifier,
					coveredSymbols: covered,
				});
			}
			importBasisCount += 1;
		}
		const colocated = colocatedTestFor(graph, targetNode);
		if (colocated && !testsByFile.has(rel(graph, colocated.filePath))) {
			const colocatedRel = rel(graph, colocated.filePath);
			const covered = coveredSymbolsFor(graph, colocated, targetNode);
			noteCovered(targetRel, covered);
			const evidence = `colocated sibling of ${targetNode.moduleName
				.split('/')
				.pop()}`;
			noteAssociation({
				kind: 'TESTS',
				fromFile: colocatedRel,
				toFile: targetRel,
				evidence,
				confidence: 'medium',
			});
			testsByFile.set(colocatedRel, {
				file: colocatedRel,
				confidence: 'medium',
				basis: 'colocated',
				evidence,
				coveredSymbols: covered,
			});
		}
		if (importBasisCount === 0 && colocated) {
			colocatedOnlyTargets.add(targetRel);
		}
	}

	const allTests = [...testsByFile.values()].sort((a, b) =>
		a.file.localeCompare(b.file),
	);
	const tests = allTests.slice(0, topN);

	// Fixtures (USES_FIXTURE): fixture-pattern deps of discovered tests only.
	const fixtureUsedBy = new Map<
		string,
		{ users: Set<string>; evidence: string }
	>();
	const helperCount = new Map<string, Set<string>>();
	for (const test of allTests) {
		const testNode = getGraphNode(graph, test.file);
		if (!testNode) continue;
		for (const ref of getDependencies(graph, testNode.filePath)) {
			const depNode = getGraphNode(graph, ref.file);
			if (!depNode || isTestNode(depNode)) continue;
			const depRel = rel(graph, depNode.filePath);
			if (isFixtureModule(depNode.moduleName)) {
				const specifier = importSpecifierFor(graph, testNode, depNode);
				const entry = fixtureUsedBy.get(depRel) ?? {
					users: new Set<string>(),
					evidence: specifier,
				};
				entry.users.add(test.file);
				fixtureUsedBy.set(depRel, entry);
				noteAssociation({
					kind: 'USES_FIXTURE',
					fromFile: test.file,
					toFile: depRel,
					evidence: specifier,
					confidence: 'medium',
				});
			} else if (!targetFiles.includes(depRel)) {
				const users = helperCount.get(depRel) ?? new Set<string>();
				users.add(test.file);
				helperCount.set(depRel, users);
			}
		}
	}
	const fixtures: TestPackFixture[] = [...fixtureUsedBy.entries()]
		.map(([file, entry]) => ({
			file,
			usedBy: [...entry.users].sort(),
			confidence: 'medium' as const,
			evidence: entry.evidence,
		}))
		.sort((a, b) => a.file.localeCompare(b.file))
		.slice(0, topN);
	const helpers = [...helperCount.entries()]
		.filter(([, users]) => users.size >= 2)
		.map(([file]) => file)
		.sort((a, b) => a.localeCompare(b))
		.slice(0, topN);

	// Coverage hints: target exports no discovered test references (per-target,
	// so same-named exports on other targets cannot mask). The per-target cap
	// prevents a target with many exports from flooding the shared budget —
	// every target gets its own PACK_ONTOLOGY_CAP slots (review finding).
	const UNCOVERED_PER_TARGET_CAP = PACK_ONTOLOGY_CAP;
	const uncoveredExports: Array<{ file: string; symbol: string }> = [];
	let droppedUncovered = 0;
	for (const targetRel of targetFiles) {
		const targetNode = getGraphNode(graph, targetRel);
		if (!targetNode) continue;
		const covered = targetCovered.get(targetRel) ?? new Set<string>();
		let perTarget = 0;
		for (const symbol of targetNode.exports) {
			if (!covered.has(symbol)) {
				if (perTarget < UNCOVERED_PER_TARGET_CAP) {
					uncoveredExports.push({ file: targetRel, symbol });
					perTarget += 1;
				} else {
					droppedUncovered += 1;
				}
			}
		}
	}
	if (droppedUncovered > 0) {
		warnings.push(
			`${droppedUncovered} uncovered export hint(s) omitted by the per-target cap of ${UNCOVERED_PER_TARGET_CAP}`,
		);
	}

	const riskNotes: string[] = [];
	if (targetFiles.length > 0 && allTests.length === 0) {
		for (const targetRel of targetFiles.slice(0, PACK_ONTOLOGY_CAP)) {
			riskNotes.push(`no tests detected for ${targetRel}`);
		}
	}
	for (const targetRel of [...colocatedOnlyTargets].sort()) {
		riskNotes.push(
			`test association for ${targetRel} relies on colocated-name heuristics only`,
		);
	}
	const perTargetUncovered = uncoveredExports.reduce<Record<string, number>>(
		(acc, entry) => {
			acc[entry.file] = (acc[entry.file] ?? 0) + 1;
			return acc;
		},
		{},
	);
	for (const [file, count] of Object.entries(perTargetUncovered).slice(
		0,
		PACK_ONTOLOGY_CAP,
	)) {
		riskNotes.push(
			`${count} exported symbol(s) without detected test coverage in ${file}`,
		);
	}

	const topNDrivenDropped =
		Math.max(0, allTests.length - tests.length) +
		Math.max(0, fixtureUsedBy.size - fixtures.length) +
		Math.max(0, helperCount.size - helpers.length);
	const dropped =
		topNDrivenDropped + droppedUncovered + droppedTargets + droppedAssociations;
	if (topNDrivenDropped > 0) {
		warnings.push(
			`${topNDrivenDropped} test pack entr(ies) omitted by top_n=${topN}`,
		);
	}
	if (droppedAssociations > 0) {
		warnings.push(
			`${droppedAssociations} derived association record(s) omitted by the cap of ${PACK_ASSOCIATIONS_CAP}`,
		);
	}

	return {
		target: { files: targetFiles, symbol: options.symbol ?? null },
		tests,
		fixtures,
		helpers,
		uncoveredExports,
		riskNotes: [...new Set(riskNotes)],
		associations,
		// Aggregate across every bounded section (tests, fixtures, helpers,
		// associations) so returned/dropped always reconcile with the output.
		budget: {
			returned:
				tests.length + fixtures.length + helpers.length + associations.length,
			dropped,
		},
		truncated: dropped > 0,
		warnings: [...new Set(warnings)],
	};
}
