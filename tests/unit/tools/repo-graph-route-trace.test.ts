import { beforeEach, describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import {
	type FileOntology,
	type GraphEdge,
	type GraphNode,
	normalizeGraphPath,
	type RepoGraph,
	resetQueryCache,
	traceRoute,
} from '../../../src/tools/repo-graph';

const root = path.resolve('/repo');
const abs = (moduleName: string): string =>
	normalizeGraphPath(path.join(root, moduleName));

function ontology(
	roles: string[],
	extras: Partial<FileOntology> = {},
): FileOntology {
	return {
		roles: roles as FileOntology['roles'],
		packageBoundary: 'src',
		routes: [],
		dataOperations: [],
		security: [],
		conventions: [],
		findings: [],
		links: [],
		...extras,
	};
}

function node(
	moduleName: string,
	options: { exports?: string[]; ontology?: FileOntology } = {},
): GraphNode {
	return {
		filePath: abs(moduleName),
		moduleName,
		exports: options.exports ?? [],
		imports: [],
		language: 'typescript',
		mtime: '1',
		...(options.ontology !== undefined ? { ontology: options.ontology } : {}),
	};
}

function fileEdge(
	from: string,
	to: string,
	extras: Partial<GraphEdge> = {},
): GraphEdge {
	return {
		source: abs(from),
		target: abs(to),
		importSpecifier: `./${path.basename(to)}`,
		importType: 'named',
		...extras,
	};
}

function makeGraph(schemaVersion = '1.7.0'): RepoGraph {
	const route = node('app/api/users/route.ts', {
		exports: ['POST', 'GET'],
		ontology: ontology(['api_route'], {
			routes: [
				{
					method: 'POST',
					path: '/api/users',
					line: 5,
					source: 'handler_export',
				},
				{
					method: 'GET',
					path: '/api/users',
					line: 9,
					source: 'handler_export',
				},
			],
			security: [
				{
					kind: 'authentication',
					line: 6,
					evidence: 'getServerSession()',
					confidence: 'high',
				},
			],
			findings: [],
			links: [
				{
					kind: 'HANDLES_ROUTE',
					subject: 'POST /api/users',
					line: 5,
					evidence: 'export async function POST',
					confidence: 'high',
					symbol: 'POST',
				},
				{
					kind: 'HANDLES_ROUTE',
					subject: 'GET /api/users',
					line: 9,
					evidence: 'export async function GET',
					confidence: 'high',
					symbol: 'GET',
				},
			],
		}),
	});
	const service = node('src/services/user-service.ts', {
		exports: ['createUser'],
		ontology: ontology(['service_module', 'data_module'], {
			dataOperations: [
				{
					operation: 'write',
					access: 'orm',
					entity: 'user',
					line: 2,
					evidence: 'prisma.user.create',
				},
			],
			links: [
				{
					kind: 'WRITES',
					subject: 'user',
					line: 2,
					evidence: 'prisma.user.create',
					confidence: 'medium',
				},
			],
		}),
	});
	const serviceTest = node('src/services/user-service.test.ts', {
		ontology: ontology(['test_file'], {
			links: [],
		}),
	});
	return {
		schema_version: schemaVersion,
		workspaceRoot: root,
		nodes: {
			[abs('app/api/users/route.ts')]: route,
			[abs('src/services/user-service.ts')]: service,
			[abs('src/services/user-service.test.ts')]: serviceTest,
		},
		edges: [
			fileEdge('app/api/users/route.ts', 'src/services/user-service.ts', {
				importedSymbols: ['createUser'],
				usedSymbols: ['createUser'],
			}),
			fileEdge(
				'src/services/user-service.test.ts',
				'src/services/user-service.ts',
				{
					importedSymbols: ['createUser'],
					usedSymbols: ['createUser'],
				},
			),
		],
		metadata: {
			generatedAt: '1',
			generator: 'test',
			nodeCount: 3,
			edgeCount: 2,
		},
	};
}

beforeEach(() => {
	resetQueryCache();
});

describe('traceRoute (KG-15, issue #1536)', () => {
	test('matches by normalized path + method and binds the handler via links', () => {
		const graph = makeGraph();
		const result = traceRoute(graph, {
			routePath: '/api/users',
			method: 'POST',
		});
		expect(result.routes.length).toBe(1);
		const route = result.routes[0];
		expect(route.file).toBe('app/api/users/route.ts');
		expect(route.handlerSymbol).toBe('POST');
		expect(route.handlerConfidence).toBe('high');
		expect(route.services).toEqual(['src/services/user-service.ts']);
		expect(route.dataOperations.length).toBe(1);
		expect(route.security.length).toBe(1);
		expect(route.tests).toEqual(['src/services/user-service.test.ts']);
		expect(result.linksSupported).toBe(true);
		expect(result.budget).toEqual({ returned: 1, dropped: 0 });
	});

	test('dynamic-segment input normalizes to the stored :param form', () => {
		const graph = makeGraph();
		graph.nodes[abs('app/api/users/route.ts')].ontology!.routes = [
			{
				method: 'GET',
				path: '/api/users/:id',
				line: 1,
				source: 'handler_export',
			},
		];
		const result = traceRoute(graph, { routePath: '/api/users/[id]' });
		expect(result.routes.length).toBe(1);
		expect(result.routes[0].route.path).toBe('/api/users/:id');
	});

	test('symbol-only matching is restricted to api_route handlers', () => {
		const graph = makeGraph();
		const result = traceRoute(graph, { symbol: 'POST' });
		expect(result.routes.length).toBe(1);
		expect(result.routes[0].route.method).toBe('POST');

		const none = traceRoute(graph, { symbol: 'createUser' });
		expect(none.routes).toEqual([]);
		expect(none.warnings.join('\n')).toContain('no routes matched');
	});

	test('top_n bounds routes with budget + truncated accounting', () => {
		const graph = makeGraph();
		const result = traceRoute(graph, {
			file: 'app/api/users/route.ts',
			topN: 1,
		});
		expect(result.routes.length).toBe(1);
		expect(result.budget).toEqual({ returned: 1, dropped: 1 });
		expect(result.truncated).toBe(true);
		expect(result.warnings.join('\n')).toContain('omitted by top_n=1');
	});

	test('unknown file and unknown path produce soft warnings, never throws', () => {
		const graph = makeGraph();
		const unknownFile = traceRoute(graph, { file: 'src/nope.ts' });
		expect(unknownFile.routes).toEqual([]);
		expect(unknownFile.warnings.join('\n')).toContain('not found in graph');

		const unknownPath = traceRoute(graph, { routePath: '/api/ghost' });
		expect(unknownPath.routes).toEqual([]);
		expect(unknownPath.warnings.join('\n')).toContain('no routes matched');
	});

	test('pre-1.7.0 graphs degrade handler confidence but keep the pack', () => {
		const graph = makeGraph('1.6.0');
		for (const node of Object.values(graph.nodes)) node.ontology!.links = [];
		const result = traceRoute(graph, {
			routePath: '/api/users',
			method: 'POST',
		});
		expect(result.linksSupported).toBe(false);
		expect(result.routes[0].handlerSymbol).toBe('POST');
		expect(result.routes[0].handlerConfidence).toBeNull();
		expect(result.routes[0].services).toEqual(['src/services/user-service.ts']);
		expect(result.warnings.join('\n')).toContain(
			'graph predates ontology links',
		);
	});

	test('handler-file findings surface (unguarded mutating route)', () => {
		const graph = makeGraph();
		const routeNode = graph.nodes[abs('app/api/users/route.ts')];
		routeNode.ontology!.findings = [
			{
				code: 'api_route_without_detected_auth',
				severity: 'medium',
				message:
					'No authentication, authorization, or CSRF guard was detected anywhere in this file; absence of this finding does not prove an individual route is guarded.',
				line: 5,
			},
		];
		const result = traceRoute(graph, {
			routePath: '/api/users',
			method: 'POST',
		});
		expect(result.routes[0].findings.length).toBe(1);
		expect(result.routes[0].findings[0].finding.code).toBe(
			'api_route_without_detected_auth',
		);
	});

	test('method and symbol filters compose with file targets (review regression)', () => {
		const graph = makeGraph();
		// file + method: only that method's routes (was silently ignored).
		const byFileGet = traceRoute(graph, {
			file: 'app/api/users/route.ts',
			method: 'GET',
		});
		expect(byFileGet.routes.length).toBe(1);
		expect(byFileGet.routes[0].route.method).toBe('GET');
		// symbol + method: both filters apply.
		const bySymbolPost = traceRoute(graph, { symbol: 'POST', method: 'GET' });
		expect(bySymbolPost.routes).toEqual([]);
		// route_path + symbol: both filters apply (AND).
		const byPathSymbol = traceRoute(graph, {
			routePath: '/api/users',
			symbol: 'POST',
		});
		expect(byPathSymbol.routes.length).toBe(1);
		expect(byPathSymbol.routes[0].route.method).toBe('POST');
	});

	test('section-cap drops are disclosed in truncated/warnings, never silent', () => {
		// F-005a: 30 handler facts + capped 20 must report dropped > 0.
		const graph = makeGraph();
		graph.nodes[abs('app/api/users/route.ts')].ontology!.security = Array.from(
			{ length: 30 },
			(_, i) => ({
				kind: 'authentication' as const,
				line: i + 1,
				evidence: `guard ${i}`,
				confidence: 'high' as const,
			}),
		);
		const result = traceRoute(graph, {
			routePath: '/api/users',
			method: 'POST',
		});
		expect(result.routes[0].security.length).toBe(20);
		expect(result.truncated).toBe(true);
		expect(result.budget.dropped).toBeGreaterThanOrEqual(10);
		expect(result.warnings.join('\n')).toContain('-item section cap');
	});

	test('method-only input filters across the whole graph at the query layer', () => {
		// PRR-011: reachable only via direct query-layer calls (the tool layer
		// requires a target), but the filter composes with the node-wide scope.
		const graph = makeGraph();
		const result = traceRoute(graph, { method: 'GET' });
		expect(result.routes.length).toBe(1);
		expect(result.routes[0].route.method).toBe('GET');
	});

	test('dataOperations and security sections cap at 20 (PACK_ONTOLOGY_CAP)', () => {
		// PRR-024: 30 facts in must yield exactly 20 out, per section.
		const graph = makeGraph();
		graph.nodes[abs('app/api/users/route.ts')].ontology!.dataOperations =
			Array.from({ length: 30 }, (_, i) => ({
				operation: 'read' as const,
				access: 'orm' as const,
				entity: `t${i}`,
				line: i + 1,
				evidence: `prisma.t${i}.findMany`,
			}));
		graph.nodes[abs('app/api/users/route.ts')].ontology!.security = Array.from(
			{ length: 30 },
			(_, i) => ({
				kind: 'authentication' as const,
				line: i + 1,
				evidence: `guard ${i}`,
				confidence: 'high' as const,
			}),
		);
		const result = traceRoute(graph, {
			routePath: '/api/users',
			method: 'POST',
		});
		expect(result.routes[0].dataOperations.length).toBe(20);
		expect(result.routes[0].security.length).toBe(20);
	});

	test('a route stored as ALL matches any method filter', () => {
		const graph = makeGraph();
		graph.nodes[abs('app/api/users/route.ts')].ontology!.routes = [
			{ method: 'ALL', path: '/api/anything', source: 'file_path' },
		];
		const result = traceRoute(graph, {
			routePath: '/api/anything',
			method: 'DELETE',
		});
		expect(result.routes.length).toBe(1);
		expect(result.routes[0].route.method).toBe('ALL');
		expect(result.routes[0].handlerSymbol).toBeNull();
		expect(result.routes[0].handlerConfidence).toBeNull();
	});

	test('router_call routes bind the link handler symbol end-to-end', () => {
		const graph = makeGraph();
		const routeNode = graph.nodes[abs('app/api/users/route.ts')];
		routeNode.ontology!.routes = [
			{ method: 'GET', path: '/legacy', line: 3, source: 'router_call' },
		];
		routeNode.ontology!.links = [
			{
				kind: 'HANDLES_ROUTE',
				subject: 'GET /legacy',
				line: 3,
				evidence: "router.get('/legacy', legacyHandler);",
				confidence: 'medium',
				symbol: 'legacyHandler',
			},
		];
		const result = traceRoute(graph, { routePath: '/legacy' });
		expect(result.routes[0].handlerSymbol).toBe('legacyHandler');
		expect(result.routes[0].handlerConfidence).toBe('medium');
		// And by symbol filter:
		const bySymbol = traceRoute(graph, { symbol: 'legacyHandler' });
		expect(bySymbol.routes.length).toBe(1);
	});
});
