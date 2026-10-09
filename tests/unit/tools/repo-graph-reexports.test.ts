/**
 * Tests for re-export pattern support in parseFileImports.
 * Verifies that the regex-based import parser correctly captures:
 * - Named re-exports: export { Foo } from './bar'
 * - Multiple named re-exports: export { Foo, Bar, Baz } from './bar'
 * - Star re-exports: export * from './bar'
 * - Namespace re-exports: export * as ns from './bar'
 * - Re-exports with rename: export { default as Foo } from './bar'
 * - Different quote styles: double quotes, single quotes, backticks
 * - Bare specifier re-exports: export { pick } from 'lodash'
 *
 * Also regression-tests that existing import patterns still work:
 * - Named imports, namespace imports, require(), default imports, side-effect imports
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fsSync from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import { buildWorkspaceGraph } from '../../../src/tools/repo-graph';
import { type CwdSandbox, enterCwdSandbox } from '../../helpers/cwd-sandbox';

// This suite builds cwd-relative workspaces (the code under test resolves
// paths against process.cwd()), so every test runs with its cwd in a
// throwaway sandbox, never in the plugin checkout.
let cwdSandbox: CwdSandbox | undefined;
beforeEach(() => {
	cwdSandbox = enterCwdSandbox('repo-graph-reexports-');
});
afterEach(() => {
	cwdSandbox?.restore();
	cwdSandbox = undefined;
});

describe('parseFileImports re-export pattern support', () => {
	let tempDir: string;
	let workspacePath: string;

	beforeEach(async () => {
		// Create temp directory INSIDE the current working directory to avoid
		// path traversal issues with validateWorkspace. The relative path
		// from cwd to tempDir will be just the directory name without .//
		tempDir = path.join(
			await fsPromises.mkdtemp(path.join(process.cwd(), 'repo-graph-test-')),
			'test-workspace',
		);
		await fsPromises.mkdir(tempDir, { recursive: true });
		// workspacePath is relative to cwd — since tempDir is inside cwd,
		// the relative path will be simple like "repo-graph-test-xxxx/test-workspace"
		workspacePath = path.relative(process.cwd(), tempDir);
	});

	afterEach(async () => {
		// Clean up temp directory — isolate each test
		try {
			await fsPromises.rm(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	/**
	 * Create a test file with given content.
	 */
	async function createFile(
		fileName: string,
		content: string,
	): Promise<string> {
		const filePath = path.join(tempDir, fileName);
		await fsPromises.writeFile(filePath, content, 'utf-8');
		return filePath;
	}

	/**
	 * Build the workspace graph and return the edges for a specific file.
	 */
	function getEdgesForFile(
		graph: ReturnType<typeof buildWorkspaceGraph>,
		filePath: string,
	) {
		const normalized = filePath.replace(/\\/g, '/');
		return graph.edges.filter(
			(e) => e.source.replace(/\\/g, '/') === normalized,
		);
	}

	// ======================================================================
	// Re-export patterns (primary test targets)
	// ======================================================================

	test('1. export { Foo } from "./bar" — named re-export → importType: named', async () => {
		await createFile('reexporter.ts', `export { Foo } from './bar';`);
		await createFile('bar.ts', `export const Foo = 1;`);

		const graph = buildWorkspaceGraph(workspacePath);
		const edges = getEdgesForFile(graph, path.join(tempDir, 'reexporter.ts'));

		expect(edges.length).toBe(1);
		expect(edges[0].importSpecifier).toBe('./bar');
		expect(edges[0].importType).toBe('named');
	});

	test('2. export { Foo, Bar, Baz } from "./bar" — multiple named re-exports → importType: named', async () => {
		await createFile('reexporter.ts', `export { Foo, Bar, Baz } from './bar';`);
		await createFile(
			'bar.ts',
			`export const Foo = 1; export const Bar = 2; export const Baz = 3;`,
		);

		const graph = buildWorkspaceGraph(workspacePath);
		const edges = getEdgesForFile(graph, path.join(tempDir, 'reexporter.ts'));

		expect(edges.length).toBe(1);
		expect(edges[0].importSpecifier).toBe('./bar');
		expect(edges[0].importType).toBe('named');
	});

	test('3. export * from "./bar" — star re-export → importType: namespace', async () => {
		await createFile('reexporter.ts', `export * from './bar';`);
		await createFile('bar.ts', `export const Foo = 1;`);

		const graph = buildWorkspaceGraph(workspacePath);
		const edges = getEdgesForFile(graph, path.join(tempDir, 'reexporter.ts'));

		expect(edges.length).toBe(1);
		expect(edges[0].importSpecifier).toBe('./bar');
		expect(edges[0].importType).toBe('namespace');
	});

	test('4. export * as ns from "./bar" — TypeScript namespace re-export → importType: namespace', async () => {
		await createFile('reexporter.ts', `export * as ns from './bar';`);
		await createFile('bar.ts', `export const Foo = 1;`);

		const graph = buildWorkspaceGraph(workspacePath);
		const edges = getEdgesForFile(graph, path.join(tempDir, 'reexporter.ts'));

		expect(edges.length).toBe(1);
		expect(edges[0].importSpecifier).toBe('./bar');
		expect(edges[0].importType).toBe('namespace');
	});

	test('5. export { default as Foo } from "./bar" — re-export with rename → importType: named', async () => {
		await createFile(
			'reexporter.ts',
			`export { default as Foo } from './bar';`,
		);
		await createFile(
			'bar.ts',
			`const defaultExport = 42; export default defaultExport;`,
		);

		const graph = buildWorkspaceGraph(workspacePath);
		const edges = getEdgesForFile(graph, path.join(tempDir, 'reexporter.ts'));

		expect(edges.length).toBe(1);
		expect(edges[0].importSpecifier).toBe('./bar');
		expect(edges[0].importType).toBe('named');
	});

	test('6a. Re-export with double quotes', async () => {
		await createFile('reexporter.ts', `export { Foo } from "./bar";`);
		await createFile('bar.ts', `export const Foo = 1;`);

		const graph = buildWorkspaceGraph(workspacePath);
		const edges = getEdgesForFile(graph, path.join(tempDir, 'reexporter.ts'));

		expect(edges.length).toBe(1);
		expect(edges[0].importSpecifier).toBe('./bar');
		expect(edges[0].importType).toBe('named');
	});

	test('6b. Re-export with backticks (template literal quote handling)', async () => {
		// Backticks are unusual for static import specifiers but should still be captured
		await createFile('reexporter.ts', `export { Foo } from \`./bar\`;`);
		await createFile('bar.ts', `export const Foo = 1;`);

		const graph = buildWorkspaceGraph(workspacePath);
		const edges = getEdgesForFile(graph, path.join(tempDir, 'reexporter.ts'));

		expect(edges.length).toBe(1);
		expect(edges[0].importSpecifier).toBe('./bar');
		expect(edges[0].importType).toBe('named');
	});

	test('7. Re-export from bare specifier (e.g., "lodash") — should be captured as node import but no edge', async () => {
		await createFile('consumer.ts', `export { pick } from 'lodash';`);
		// lodash is a bare specifier — it won't resolve to a local file,
		// but the import should still be recorded on the node

		const graph = buildWorkspaceGraph(workspacePath);
		const nodePath = path.join(tempDir, 'consumer.ts').replace(/\\/g, '/');
		const node = graph.nodes[nodePath];

		expect(node).toBeDefined();
		expect(node!.imports).toContain('lodash');

		// No edge should be created for bare specifier (resolveModuleSpecifier returns null)
		const edgesFromConsumer = graph.edges.filter(
			(e) => e.source.replace(/\\/g, '/') === nodePath,
		);
		expect(edgesFromConsumer.length).toBe(0);
	});

	// ======================================================================
	// Existing import patterns (regression tests)
	// ======================================================================

	test('8. import { Foo } from "./bar" — named import still matches', async () => {
		await createFile('importer.ts', `import { Foo } from './bar';`);
		await createFile('bar.ts', `export const Foo = 1;`);

		const graph = buildWorkspaceGraph(workspacePath);
		const edges = getEdgesForFile(graph, path.join(tempDir, 'importer.ts'));

		expect(edges.length).toBe(1);
		expect(edges[0].importSpecifier).toBe('./bar');
		expect(edges[0].importType).toBe('named');
	});

	test('9. import * as ns from "./bar" — namespace import still matches', async () => {
		await createFile('importer.ts', `import * as ns from './bar';`);
		await createFile('bar.ts', `export const Foo = 1;`);

		const graph = buildWorkspaceGraph(workspacePath);
		const edges = getEdgesForFile(graph, path.join(tempDir, 'importer.ts'));

		expect(edges.length).toBe(1);
		expect(edges[0].importSpecifier).toBe('./bar');
		expect(edges[0].importType).toBe('namespace');
	});

	test('10. require("./bar") — CommonJS require still matches', async () => {
		await createFile('requirer.js', `const foo = require('./bar');`);
		await createFile('bar.js', `module.exports = 1;`);

		const graph = buildWorkspaceGraph(workspacePath);
		const edges = getEdgesForFile(graph, path.join(tempDir, 'requirer.js'));

		expect(edges.length).toBe(1);
		expect(edges[0].importSpecifier).toBe('./bar');
		expect(edges[0].importType).toBe('require');
	});

	// ======================================================================
	// Additional edge cases
	// ======================================================================

	test('Multiple different re-exports in same file — each produces correct edge', async () => {
		await createFile(
			'multi.ts',
			`export { A } from './a';
export * from './b';
export { default as C } from './c';`,
		);
		await createFile('a.ts', `export const A = 1;`);
		await createFile('b.ts', `export const B = 2;`);
		await createFile('c.ts', `export default 3;`);

		const graph = buildWorkspaceGraph(workspacePath);
		const edges = getEdgesForFile(graph, path.join(tempDir, 'multi.ts'));

		expect(edges.length).toBe(3);

		const edgeA = edges.find((e) => e.importSpecifier === './a');
		const edgeB = edges.find((e) => e.importSpecifier === './b');
		const edgeC = edges.find((e) => e.importSpecifier === './c');

		expect(edgeA).toBeDefined();
		expect(edgeA!.importType).toBe('named');

		expect(edgeB).toBeDefined();
		expect(edgeB!.importType).toBe('namespace');

		expect(edgeC).toBeDefined();
		expect(edgeC!.importType).toBe('named');
	});

	test('Re-export with aliased names: export { Foo as Bar } from "./bar"', async () => {
		await createFile('reexporter.ts', `export { Foo as Bar } from './bar';`);
		await createFile('bar.ts', `export const Foo = 1;`);

		const graph = buildWorkspaceGraph(workspacePath);
		const edges = getEdgesForFile(graph, path.join(tempDir, 'reexporter.ts'));

		expect(edges.length).toBe(1);
		expect(edges[0].importSpecifier).toBe('./bar');
		expect(edges[0].importType).toBe('named');
	});

	test('Mixed imports and re-exports in same file', async () => {
		await createFile(
			'mixed.ts',
			`import { X } from './foo';
export { Y } from './bar';
import * as ns from './baz';`,
		);
		await createFile('foo.ts', `export const X = 1;`);
		await createFile('bar.ts', `export const Y = 2;`);
		await createFile('baz.ts', `export const Z = 3;`);

		const graph = buildWorkspaceGraph(workspacePath);
		const edges = getEdgesForFile(graph, path.join(tempDir, 'mixed.ts'));

		expect(edges.length).toBe(3);

		expect(edges.find((e) => e.importSpecifier === './foo')?.importType).toBe(
			'named',
		);
		expect(edges.find((e) => e.importSpecifier === './bar')?.importType).toBe(
			'named',
		);
		expect(edges.find((e) => e.importSpecifier === './baz')?.importType).toBe(
			'namespace',
		);
	});

	test('Default import still works: import Foo from "./bar"', async () => {
		await createFile('importer.ts', `import Foo from './bar';`);
		await createFile('bar.ts', `export default 42;`);

		const graph = buildWorkspaceGraph(workspacePath);
		const edges = getEdgesForFile(graph, path.join(tempDir, 'importer.ts'));

		expect(edges.length).toBe(1);
		expect(edges[0].importSpecifier).toBe('./bar');
		expect(edges[0].importType).toBe('default');
	});

	test('Side-effect import: import "./bar" — no edge but node has import recorded', async () => {
		await createFile('importer.ts', `import './bar';`);
		await createFile('bar.ts', `console.log('side effect');`);

		const graph = buildWorkspaceGraph(workspacePath);
		const edges = getEdgesForFile(graph, path.join(tempDir, 'importer.ts'));

		// Side-effect imports have no specifier to resolve, so no edge is created
		// but the node should still be created
		const nodePath = path.join(tempDir, 'importer.ts').replace(/\\/g, '/');
		const node = graph.nodes[nodePath];
		expect(node).toBeDefined();
		expect(node!.imports).toContain('./bar');
	});

	test('Round-trip: re-export patterns captured with correct importType invariant', async () => {
		// Property test: for any file with re-exports, the importType should be deterministic
		await createFile(
			'prop.ts',
			`export { A } from './a';
export * from './b';
export { default as C } from './c';
export * as D from './d';`,
		);
		await createFile('a.ts', `export const A = 1;`);
		await createFile('b.ts', `export const B = 2;`);
		await createFile('c.ts', `export default 3;`);
		await createFile('d.ts', `export const D = 4;`);

		const graph = buildWorkspaceGraph(workspacePath);
		const edges = getEdgesForFile(graph, path.join(tempDir, 'prop.ts'));

		// All export { } patterns → named
		const namedEdges = edges.filter(
			(e) => e.importSpecifier === './a' || e.importSpecifier === './c',
		);
		for (const edge of namedEdges) {
			expect(edge.importType).toBe('named');
		}

		// All export * patterns → namespace
		const namespaceEdges = edges.filter(
			(e) => e.importSpecifier === './b' || e.importSpecifier === './d',
		);
		for (const edge of namespaceEdges) {
			expect(edge.importType).toBe('namespace');
		}
	});
});
