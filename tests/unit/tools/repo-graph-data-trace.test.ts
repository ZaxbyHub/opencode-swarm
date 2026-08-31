import { beforeEach, describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import {
	type FileOntology,
	type GraphEdge,
	type GraphNode,
	normalizeGraphPath,
	type RepoGraph,
	resetQueryCache,
	traceData,
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

function fileEdge(from: string, to: string): GraphEdge {
	return {
		source: abs(from),
		target: abs(to),
		importSpecifier: `./${path.basename(to)}`,
		importType: 'named',
	};
}

function makeGraph(schemaVersion = '1.7.0', withLinks = true): RepoGraph {
	const reader = node('src/readers.ts', {
		ontology: ontology(['data_module'], {
			dataOperations: [
				{
					operation: 'read',
					access: 'orm',
					entity: 'user',
					line: 3,
					evidence: 'prisma.user.findMany',
				},
			],
			links: withLinks
				? [
						{
							kind: 'READS',
							subject: 'user',
							line: 3,
							evidence: 'prisma.user.findMany',
							confidence: 'medium',
						},
					]
				: [],
		}),
	});
	const writer = node('src/writers.ts', {
		ontology: ontology(['data_module'], {
			dataOperations: [
				{
					operation: 'write',
					access: 'orm',
					entity: 'user',
					line: 2,
					evidence: 'prisma.user.create',
				},
			],
			links: withLinks
				? [
						{
							kind: 'WRITES',
							subject: 'user',
							line: 2,
							evidence: 'prisma.user.create',
							confidence: 'medium',
						},
					]
				: [],
		}),
	});
	const deleter = node('src/deleters.ts', {
		ontology: ontology(['data_module'], {
			dataOperations: [
				{
					operation: 'delete',
					access: 'orm',
					entity: 'user',
					line: 4,
					evidence: 'prisma.user.delete',
				},
			],
			links: withLinks
				? [
						{
							kind: 'DELETES',
							subject: 'user',
							line: 4,
							evidence: 'prisma.user.delete',
							confidence: 'medium',
						},
					]
				: [],
		}),
	});
	const route = node('app/api/users/route.ts', {
		ontology: ontology(['api_route'], {
			routes: [
				{
					method: 'DELETE',
					path: '/api/users',
					line: 1,
					source: 'handler_export',
				},
			],
			dataOperations: [
				{
					operation: 'delete',
					access: 'orm',
					entity: 'user',
					line: 2,
					evidence: 'prisma.user.delete',
				},
			],
			links: withLinks
				? [
						{
							kind: 'DELETES',
							subject: 'user',
							line: 2,
							evidence: 'prisma.user.delete',
							confidence: 'medium',
						},
					]
				: [],
		}),
	});
	const config = node('src/config.ts', {
		ontology: ontology(['config'], {
			links: withLinks
				? [
						{
							kind: 'CONFIGURES',
							subject: 'USERS_TABLE',
							line: 1,
							evidence: 'process.env.USERS_TABLE',
							confidence: 'medium',
						},
					]
				: [],
		}),
	});
	const test = node('src/readers.test.ts', {
		ontology: ontology(['test_file']),
	});
	return {
		schema_version: schemaVersion,
		workspaceRoot: root,
		nodes: {
			[abs('src/readers.ts')]: reader,
			[abs('src/writers.ts')]: writer,
			[abs('src/deleters.ts')]: deleter,
			[abs('app/api/users/route.ts')]: route,
			[abs('src/config.ts')]: config,
			[abs('src/readers.test.ts')]: test,
		},
		edges: [
			fileEdge('src/readers.test.ts', 'src/readers.ts'),
			fileEdge('src/deleters.ts', 'app/api/users/route.ts'),
		],
		metadata: {
			generatedAt: '1',
			generator: 'test',
			nodeCount: 6,
			edgeCount: 2,
		},
	};
}

beforeEach(() => {
	resetQueryCache();
});

describe('traceData (KG-15, issue #1536)', () => {
	test('splits an entity into readers/writers/deleters with link provenance', () => {
		const result = traceData(makeGraph(), { entity: 'user' });
		expect(result.subject).toBe('user');
		expect(result.readers).toEqual([
			{
				file: 'src/readers.ts',
				kind: 'READS',
				symbol: null,
				line: 3,
				evidence: 'prisma.user.findMany',
				confidence: 'medium',
				via: 'link',
			},
		]);
		expect(result.writers.length).toBe(1);
		expect(result.writers[0].file).toBe('src/writers.ts');
		// route.ts also deletes the entity (deduped per file+kind+line).
		expect(result.deleters.length).toBe(2);
		expect(result.routes.length).toBe(1);
		expect(result.tests).toEqual(['src/readers.test.ts']);
		expect(result.riskNotes.join('\n')).toContain(
			'delete operations on user in 2 file(s)',
		);
	});

	test('env/config keys trace through CONFIGURES links', () => {
		const result = traceData(makeGraph(), { entity: 'USERS_TABLE' });
		expect(result.configurers.length).toBe(1);
		expect(result.configurers[0]).toMatchObject({
			file: 'src/config.ts',
			kind: 'CONFIGURES',
			via: 'link',
		});
	});

	test('entity matching is case-insensitive', () => {
		const result = traceData(makeGraph(), { entity: 'USER' });
		expect(result.readers.length).toBe(1);
		expect(result.subject).toBe('user');
	});

	test('file and symbol anchors scope the trace', () => {
		const byFile = traceData(makeGraph(), { file: 'src/writers.ts' });
		expect(byFile.writers.length).toBe(1);
		expect(byFile.readers).toEqual([]);

		const bySymbol = traceData(makeGraph(), { symbol: 'createUser' });
		expect(bySymbol.writers).toEqual([]);
		expect(bySymbol.warnings.join('\n')).toContain(
			'no graph file exports symbol',
		);
	});

	test('entity+file combine: entity filters within the file-scoped nodes', () => {
		// PRR-013: file anchors scope; entity then filters.
		const result = traceData(makeGraph(), {
			entity: 'user',
			file: 'src/writers.ts',
		});
		expect(result.writers.length).toBe(1);
		expect(result.readers).toEqual([]);
		// An entity the scoped file does not touch yields empty, not other files.
		const miss = traceData(makeGraph(), {
			entity: 'user',
			file: 'src/config.ts',
		});
		expect(miss.writers).toEqual([]);
	});

	test('pre-1.7.0 graphs fall back to DataOperationFact matches', () => {
		const result = traceData(makeGraph('1.6.0', false), { entity: 'user' });
		expect(result.linksSupported).toBe(false);
		expect(result.readers.length).toBe(1);
		expect(result.readers[0]).toMatchObject({ via: 'fact', confidence: null });
		expect(result.warnings.join('\n')).toContain('DataOperationFact fallback');
	});

	test('untested entities get the no-tests risk note', () => {
		const result = traceData(makeGraph(), { entity: 'user' });
		// readers.test.ts only imports readers.ts; writers/deleters/routes are untested,
		// but tests exist for a touching file, so the note must NOT fire.
		expect(result.riskNotes.join('\n').includes('no tests detected')).toBe(
			false,
		);

		const graph = makeGraph();
		delete graph.nodes[abs('src/readers.test.ts')];
		resetQueryCache();
		const untested = traceData(graph, { entity: 'user' });
		expect(untested.riskNotes.join('\n')).toContain(
			'no tests detected for user',
		);
	});

	test('unknown entities report softly with budget accounting', () => {
		const result = traceData(makeGraph(), { entity: 'ghost' });
		expect(result.readers).toEqual([]);
		expect(result.writers).toEqual([]);
		expect(result.subject).toBeNull();
		expect(result.warnings.join('\n')).toContain(
			'no data access matched entity',
		);
		expect(result.budget).toEqual({ returned: 0, dropped: 0 });
	});

	test('same-line facts for different entities survive link dedupe (review regression)', () => {
		const graph = makeGraph();
		const mixed = node('src/mixed.ts', {
			ontology: ontology(['data_module'], {
				dataOperations: [
					{
						operation: 'write',
						access: 'orm',
						entity: 'user',
						line: 7,
						evidence: 'tx.user.create(a); tx.order.create(b);',
					},
					{
						operation: 'write',
						access: 'orm',
						entity: 'order',
						line: 7,
						evidence: 'tx.user.create(a); tx.order.create(b);',
					},
				],
				links: [
					{
						kind: 'WRITES',
						subject: 'user',
						line: 7,
						evidence: 'tx.user.create(a);',
						confidence: 'medium',
					},
				],
			}),
		});
		graph.nodes[abs('src/mixed.ts')] = mixed;
		// File-scoped trace (no entity): the user link covers the user fact, but
		// the same-line ORDER fact must survive.
		const result = traceData(graph, { file: 'src/mixed.ts' });
		expect(result.writers.length).toBe(2);
		const orderFact = result.writers.find(
			(w) => w.via === 'fact' && w.line === 7,
		);
		expect(orderFact).toBeDefined();
	});

	test('cross-boundary writes produce the boundary risk note', () => {
		const graph = makeGraph();
		// Second writer in a different package boundary.
		const other = node('app/writers.ts', {
			ontology: ontology(['data_module'], {
				packageBoundary: 'app',
				dataOperations: [
					{
						operation: 'write',
						access: 'orm',
						entity: 'user',
						line: 1,
						evidence: 'db.user.create({})',
					},
				],
				links: [
					{
						kind: 'WRITES',
						subject: 'user',
						line: 1,
						evidence: 'db.user.create({})',
						confidence: 'medium',
					},
				],
			}),
		});
		graph.nodes[abs('app/writers.ts')] = other;
		resetQueryCache();
		const result = traceData(graph, { entity: 'user' });
		expect(result.writers.length).toBe(2);
		expect(result.riskNotes.join('\n')).toContain(
			'user is written in 2 file(s) across 2 package boundaries',
		);
	});
});
