import { describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import {
	type FileOntology,
	type GraphNode,
	GRAPH_SCHEMA_VERSION,
	normalizeGraphPath,
	type OntologyLink,
	validateGraphNode,
} from '../../../src/tools/repo-graph';

const root = path.resolve('/repo');
const abs = (moduleName: string): string =>
	normalizeGraphPath(path.join(root, moduleName));

function baseNode(ontology?: FileOntology): GraphNode {
	return {
		filePath: abs('src/x.ts'),
		moduleName: 'src/x.ts',
		exports: [],
		imports: [],
		language: 'typescript',
		mtime: '1',
		...(ontology !== undefined ? { ontology } : {}),
	};
}

function ontologyWith(link: Partial<OntologyLink>): FileOntology {
	return {
		roles: ['source_module'],
		packageBoundary: 'src',
		routes: [],
		dataOperations: [],
		security: [],
		conventions: [],
		findings: [],
		links: [link as OntologyLink],
	};
}

describe('validateGraphNode: ontology.links (KG-15, issue #1536)', () => {
	test('accepts every valid link kind with well-formed fields', () => {
		const kinds = [
			'HANDLES_ROUTE',
			'READS',
			'WRITES',
			'DELETES',
			'VALIDATES',
			'AUTHORIZES',
			'TESTS',
			'USES_FIXTURE',
			'CONFIGURES',
		];
		for (const kind of kinds) {
			expect(() =>
				validateGraphNode(
					baseNode(
						ontologyWith({
							kind,
							subject: 'GET /api/users/:id',
							line: 3,
							evidence: 'router.get("/api/users/:id", getUser)',
							confidence: 'high',
							symbol: 'getUser',
						}),
					),
				),
			).not.toThrow();
		}
	});

	test('accepts links without optional fields and rejects malformed lines', () => {
		expect(() =>
			validateGraphNode(
				baseNode(ontologyWith({ kind: 'READS', subject: 'user', confidence: 'low' })),
			),
		).not.toThrow();
		expect(() =>
			validateGraphNode(
				baseNode(
					ontologyWith({ kind: 'READS', subject: 'user', confidence: 'low', line: 0 }),
				),
			),
		).toThrow(/ontology\.links\.line/);
		expect(() =>
			validateGraphNode(
				baseNode(
					ontologyWith({ kind: 'READS', subject: 'user', confidence: 'low', line: 1.5 }),
				),
			),
		).toThrow(/ontology\.links\.line/);
	});

	test('rejects unknown kinds and confidences', () => {
		expect(() =>
			validateGraphNode(
				baseNode(ontologyWith({ kind: 'OWNS', confidence: 'high' })),
			),
		).toThrow(/ontology\.links\.kind/);
		expect(() =>
			validateGraphNode(
				baseNode(ontologyWith({ kind: 'READS', confidence: 'certain' })),
			),
		).toThrow(/ontology\.links\.confidence/);
	});

	test('rejects malformed subjects: control chars, traversal, bad shape, over-length', () => {
		expect(() =>
			validateGraphNode(
				baseNode(
					ontologyWith({ kind: 'CONFIGURES', subject: 'KEY\n', confidence: 'low' }),
				),
			),
		).toThrow(/control characters/);
		expect(() =>
			validateGraphNode(
				baseNode(
					ontologyWith({ kind: 'CONFIGURES', subject: '../../etc', confidence: 'low' }),
				),
			),
		).toThrow(/ontology\.links\.subject/);
		expect(() =>
			validateGraphNode(
				baseNode(ontologyWith({ kind: 'READS', subject: ' user', confidence: 'low' })),
			),
		).toThrow(/ontology\.links\.subject/);
		expect(() =>
			validateGraphNode(
				baseNode(
					ontologyWith({
						kind: 'READS',
						subject: 'u'.repeat(201),
						confidence: 'low',
					}),
				),
			),
		).toThrow(/ontology\.links\.subject/);
	});

	test('accepts router-call route subjects with query strings and regex fragments (regression)', () => {
		// KG-15 review regression: a character-whitelist subject pattern rejected
		// `GET /users?active=true` — and because a validateGraphNode failure drops
		// the whole node, the route file silently vanished from the graph.
		// FastAPI `{param}`, Flask `<int:id>`, and bracketed paths are the same class.
		for (const subject of [
			'GET /users?active=true',
			'GET /files/:path(*)',
			'GET /user(s)?',
			'GET /a,b/c',
			'GET /items/{item_id}',
			'GET /user/<int:id>',
			'GET /docs/[...slug]',
		]) {
			expect(() =>
				validateGraphNode(
					baseNode(
						ontologyWith({
							kind: 'HANDLES_ROUTE',
							subject,
							confidence: 'medium',
						}),
					),
				),
			).not.toThrow();
		}
		// Quotes and backslashes stay excluded.
		expect(() =>
			validateGraphNode(
				baseNode(
					ontologyWith({ kind: 'HANDLES_ROUTE', subject: 'GET /"x"', confidence: 'low' }),
				),
			),
		).toThrow(/ontology\.links\.subject/);
	});

	test('rejects control characters in link evidence and symbols', () => {
		expect(() =>
			validateGraphNode(
				baseNode(
					ontologyWith({
						kind: 'WRITES',
						subject: 'user',
						confidence: 'low',
						evidence: 'prisma\x02.user.create()',
					}),
				),
			),
		).toThrow(/control characters/);
		expect(() =>
			validateGraphNode(
				baseNode(
					ontologyWith({
						kind: 'HANDLES_ROUTE',
						subject: 'GET /x',
						confidence: 'low',
						symbol: 'GET\r',
					}),
				),
			),
		).toThrow(/control characters/);
	});

	test('schema constant is 1.7.0 and nodes without links stay valid', () => {
		expect(GRAPH_SCHEMA_VERSION).toBe('1.7.0');
		expect(() => validateGraphNode(baseNode())).not.toThrow();
	});
});
