import { beforeEach, describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import {
	buildTestPack,
	type FileOntology,
	type GraphEdge,
	type GraphNode,
	normalizeGraphPath,
	type RepoGraph,
	resetQueryCache,
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

function makeGraph(): RepoGraph {
	const calc = node('src/lib/calc.ts', {
		exports: ['add', 'unusedHelper'],
	});
	const calcTest = node('src/lib/calc.test.ts', {
		ontology: ontology(['test_file']),
	});
	const widget = node('src/lib/widget.ts', { exports: ['makeWidget'] });
	const widgetSpec = node('src/lib/widget.spec.ts', {
		ontology: ontology(['test_file']),
	});
	const other = node('src/lib/other.ts', { exports: ['other'] });
	const fixture = node('src/test-fixtures/users.fixture.ts', {
		exports: ['userFixture'],
	});
	const service = node('src/services/user-service.ts', {
		exports: ['createUser'],
	});
	const serviceTest = node('src/services/user-service.test.ts', {
		ontology: ontology(['test_file']),
	});
	const serviceTest2 = node('src/services/user-service.extra.test.ts', {
		ontology: ontology(['test_file']),
	});
	return {
		schema_version: '1.7.0',
		workspaceRoot: root,
		nodes: {
			[abs('src/lib/calc.ts')]: calc,
			[abs('src/lib/calc.test.ts')]: calcTest,
			[abs('src/lib/widget.ts')]: widget,
			[abs('src/lib/widget.spec.ts')]: widgetSpec,
			[abs('src/lib/other.ts')]: other,
			[abs('src/test-fixtures/users.fixture.ts')]: fixture,
			[abs('src/services/user-service.ts')]: service,
			[abs('src/services/user-service.test.ts')]: serviceTest,
			[abs('src/services/user-service.extra.test.ts')]: serviceTest2,
		},
		edges: [
			fileEdge('src/lib/calc.test.ts', 'src/lib/calc.ts', {
				importedSymbols: ['add'],
				usedSymbols: ['add'],
			}),
			// widget.spec.ts does NOT import widget.ts (colocated-only heuristic).
			fileEdge(
				'src/services/user-service.test.ts',
				'src/services/user-service.ts',
				{
					importedSymbols: ['createUser'],
					usedSymbols: ['createUser'],
				},
			),
			fileEdge(
				'src/services/user-service.test.ts',
				'src/test-fixtures/users.fixture.ts',
				{
					importedSymbols: ['userFixture'],
				},
			),
			// Both service tests import calc.ts: a shared non-fixture helper.
			fileEdge('src/services/user-service.test.ts', 'src/lib/calc.ts', {
				importedSymbols: ['add'],
			}),
			fileEdge(
				'src/services/user-service.extra.test.ts',
				'src/services/user-service.ts',
				{
					importedSymbols: ['createUser'],
				},
			),
			fileEdge('src/services/user-service.extra.test.ts', 'src/lib/calc.ts', {
				importedSymbols: ['add'],
			}),
		],
		metadata: {
			generatedAt: '1',
			generator: 'test',
			nodeCount: 9,
			edgeCount: 5,
		},
	};
}

beforeEach(() => {
	resetQueryCache();
});

describe('buildTestPack (KG-15, issue #1536)', () => {
	test('discovers import-based tests with covered symbols and coverage hints', () => {
		const result = buildTestPack(makeGraph(), { file: 'src/lib/calc.ts' });
		expect(result.target).toEqual({ files: ['src/lib/calc.ts'], symbol: null });
		// calc.test.ts plus both service tests (they import calc as a helper).
		expect(result.tests.length).toBe(3);
		expect(result.tests[0]).toMatchObject({
			file: 'src/lib/calc.test.ts',
			basis: 'import',
			confidence: 'high',
			evidence: './calc.ts',
			coveredSymbols: ['add'],
		});
		// Import-based associations carry the import specifier as evidence.
		expect(result.associations).toContainEqual({
			kind: 'TESTS',
			fromFile: 'src/lib/calc.test.ts',
			toFile: 'src/lib/calc.ts',
			evidence: './calc.ts',
			confidence: 'high',
		});
		// uncovered = only unusedHelper.
		expect(result.uncoveredExports).toEqual([
			{ file: 'src/lib/calc.ts', symbol: 'unusedHelper' },
		]);
		expect(result.riskNotes.join('\n')).toContain(
			'1 exported symbol(s) without detected test coverage in src/lib/calc.ts',
		);
	});

	test('associates non-importing colocated specs at medium confidence with a note', () => {
		const result = buildTestPack(makeGraph(), { file: 'src/lib/widget.ts' });
		expect(result.tests).toEqual([
			{
				file: 'src/lib/widget.spec.ts',
				confidence: 'medium',
				basis: 'colocated',
				evidence: 'colocated sibling of widget.ts',
				coveredSymbols: [],
			},
		]);
		// The derived TESTS association surfaces the kind with evidence.
		expect(result.associations).toEqual([
			{
				kind: 'TESTS',
				fromFile: 'src/lib/widget.spec.ts',
				toFile: 'src/lib/widget.ts',
				evidence: 'colocated sibling of widget.ts',
				confidence: 'medium',
			},
		]);
		expect(result.riskNotes.join('\n')).toContain(
			'test association for src/lib/widget.ts relies on colocated-name heuristics only',
		);
		// No test references makeWidget → uncovered + hint.
		expect(result.uncoveredExports).toEqual([
			{ file: 'src/lib/widget.ts', symbol: 'makeWidget' },
		]);
	});

	test('fixtures are imported-by-test files matching fixture patterns; unimported fixtures absent', () => {
		const graph = makeGraph();
		const result = buildTestPack(graph, {
			file: 'src/services/user-service.ts',
		});
		expect(result.fixtures).toEqual([
			{
				file: 'src/test-fixtures/users.fixture.ts',
				usedBy: ['src/services/user-service.test.ts'],
				confidence: 'medium',
				evidence: './users.fixture.ts',
			},
		]);
		// The USES_FIXTURE association surfaces the kind with evidence.
		expect(result.associations).toContainEqual({
			kind: 'USES_FIXTURE',
			fromFile: 'src/services/user-service.test.ts',
			toFile: 'src/test-fixtures/users.fixture.ts',
			evidence: './users.fixture.ts',
			confidence: 'medium',
		});

		// A fixture file with no importing test never appears.
		const result2 = buildTestPack(graph, { files: ['src/lib/other.ts'] });
		expect(result2.tests).toEqual([]);
		expect(result2.fixtures).toEqual([]);
		expect(
			result2.associations.filter((a) => a.kind === 'USES_FIXTURE'),
		).toEqual([]);
	});

	test('helpers are non-fixture deps shared by >= 2 discovered tests', () => {
		const result = buildTestPack(makeGraph(), {
			file: 'src/services/user-service.ts',
		});
		// calc.ts is imported by calc.test.ts AND user-service.extra.test.ts.
		expect(result.helpers).toContain('src/lib/calc.ts');
		// The fixture matches the fixture pattern, so it is not a helper.
		expect(result.helpers).not.toContain('src/test-fixtures/users.fixture.ts');
	});

	test('symbol targets resolve to owning files', () => {
		const result = buildTestPack(makeGraph(), { symbol: 'add' });
		expect(result.target).toEqual({
			files: ['src/lib/calc.ts'],
			symbol: 'add',
		});
		expect(result.tests.length).toBe(3);

		const unknown = buildTestPack(makeGraph(), { symbol: 'ghost' });
		expect(unknown.target.files).toEqual([]);
		expect(unknown.warnings.join('\n')).toContain(
			'no graph file exports symbol',
		);
	});

	test('diff input resolves changed files through getDiffContext', () => {
		const diff = [
			'diff --git a/src/lib/calc.ts b/src/lib/calc.ts',
			'--- a/src/lib/calc.ts',
			'+++ b/src/lib/calc.ts',
			'@@ -1,2 +1,2 @@',
			'-old',
			'+new',
		].join('\n');
		const result = buildTestPack(makeGraph(), { diff });
		expect(result.target.files).toEqual(['src/lib/calc.ts']);
		expect(result.tests[0].file).toBe('src/lib/calc.test.ts');
	});

	test('missing tests produce the no-tests risk note; unknown files warn softly', () => {
		const result = buildTestPack(makeGraph(), { file: 'src/lib/other.ts' });
		expect(result.tests).toEqual([]);
		expect(result.riskNotes).toContain(
			'no tests detected for src/lib/other.ts',
		);

		const unknown = buildTestPack(makeGraph(), { file: 'src/ghost.ts' });
		expect(unknown.target.files).toEqual([]);
		expect(unknown.warnings.join('\n')).toContain('not found in graph');
	});

	test('duplicate files[] entries are deduped (no double-counted output)', () => {
		// PRR-004: a repeated path must not duplicate associations/uncovered
		// exports or inflate the budget.
		const single = buildTestPack(makeGraph(), { files: ['src/lib/widget.ts'] });
		const duplicated = buildTestPack(makeGraph(), {
			files: ['src/lib/widget.ts', 'src/lib/widget.ts'],
		});
		expect(duplicated.target.files).toEqual(single.target.files);
		expect(duplicated.associations).toEqual(single.associations);
		expect(duplicated.uncoveredExports).toEqual(single.uncoveredExports);
		expect(duplicated.budget).toEqual(single.budget);
	});

	test('per-target coverage: a same-named export covered on one target does not mask another', () => {
		const graph = makeGraph();
		// calc.ts exports `add` (covered by calc.test.ts). Give `other.ts` the
		// same export name with NO covering test: it must still report uncovered.
		graph.nodes[abs('src/lib/other.ts')].exports = ['add'];
		const result = buildTestPack(graph, {
			files: ['src/lib/calc.ts', 'src/lib/other.ts'],
		});
		const uncoveredFiles = result.uncoveredExports.map((e) => e.file);
		// The regression case: other.ts's `add` must NOT be masked by calc.ts's
		// covered same-named export…
		expect(result.uncoveredExports).toContainEqual({
			file: 'src/lib/other.ts',
			symbol: 'add',
		});
		// …and calc.ts's covered `add` must not be reported uncovered.
		expect(result.uncoveredExports).not.toContainEqual({
			file: 'src/lib/calc.ts',
			symbol: 'add',
		});
		// (calc.ts's `unusedHelper` stays legitimately uncovered.)
		expect(uncoveredFiles).toContain('src/lib/calc.ts');
	});

	test('files take precedence over symbol when both are given', () => {
		// PRR-012: repo-map forwards both; files win. Current contract echoes
		// the ignored symbol in target.symbol — pinned so a change is deliberate.
		const result = buildTestPack(makeGraph(), {
			files: ['src/lib/calc.ts'],
			symbol: 'makeWidget',
		});
		expect(result.target).toEqual({
			files: ['src/lib/calc.ts'],
			symbol: 'makeWidget',
		});
		expect(result.tests.map((t) => t.file)).toEqual([
			'src/lib/calc.test.ts',
			'src/services/user-service.extra.test.ts',
			'src/services/user-service.test.ts',
		]);
	});

	test('associations cap at 200 with reconcilable budget accounting', () => {
		// 210 test files importing one target -> 210 TESTS associations.
		const graph = makeGraph();
		const nodes: Record<string, GraphNode> = { ...graph.nodes };
		const edges = [...graph.edges];
		for (let i = 0; i < 210; i++) {
			const name = `src/gen/test-${i}.test.ts`;
			nodes[abs(name)] = node(name, { ontology: ontology(['test_file']) });
			edges.push(
				fileEdge(name, 'src/lib/calc.ts', { importedSymbols: ['add'] }),
			);
		}
		graph.nodes = nodes;
		graph.edges = edges;
		resetQueryCache();
		const result = buildTestPack(graph, { file: 'src/lib/calc.ts', topN: 100 });
		expect(result.associations.length).toBe(200);
		expect(result.associations.every((a) => a.kind === 'TESTS')).toBe(true);
		expect(result.warnings.join('\n')).toContain(
			'derived association record(s) omitted by the cap of 200',
		);
		expect(result.truncated).toBe(true);
		// Budget must reconcile: returned counts every returned section
		// (incl. associations); dropped includes the 10 capped records.
		expect(result.budget.returned).toBe(
			result.tests.length +
				result.fixtures.length +
				result.helpers.length +
				result.associations.length,
		);
		expect(result.budget.dropped).toBeGreaterThanOrEqual(10);
	});

	test('top_n bounds tests/fixtures/helpers with budget + truncated', () => {
		const result = buildTestPack(makeGraph(), {
			file: 'src/lib/calc.ts',
			topN: 1,
		});
		expect(result.tests.length).toBe(1);
		expect(result.budget.dropped).toBeGreaterThan(0);
		expect(result.truncated).toBe(true);
		expect(result.warnings.join('\n')).toContain('omitted by top_n=1');
	});
});
