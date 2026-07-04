import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	buildRepoGraph,
	findSourceFiles,
	processFile,
} from '../../../src/graph/graph-builder';

let tmp: string;

beforeAll(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-builder-'));
	// Lay out a small repo:
	//   src/util.ts        — exports `add`
	//   src/main.ts        — imports `add` from './util'
	//   src/internal/x.ts  — imports `add` from '../util'
	//   node_modules/dep/  — must be skipped
	//   .git/              — must be skipped
	fs.mkdirSync(path.join(tmp, 'src/internal'), { recursive: true });
	fs.mkdirSync(path.join(tmp, 'node_modules/dep'), { recursive: true });
	fs.mkdirSync(path.join(tmp, '.git'), { recursive: true });

	fs.writeFileSync(
		path.join(tmp, 'src/util.ts'),
		'export function add(a: number, b: number) { return a + b; }\n',
	);
	fs.writeFileSync(
		path.join(tmp, 'src/main.ts'),
		"import { add } from './util';\nconsole.log(add(1, 2));\n",
	);
	fs.writeFileSync(
		path.join(tmp, 'src/internal/x.ts'),
		"import { add } from '../util';\nexport const r = add(2, 3);\n",
	);
	fs.writeFileSync(
		path.join(tmp, 'node_modules/dep/index.ts'),
		'export const skip = 1;\n',
	);
	fs.writeFileSync(path.join(tmp, '.git/config'), '[core]\nbare = false\n');
});

describe('buildRepoGraph - Python, Rust, and Go exports', () => {
	it('extracts conservative exports for .pyw, .rs, and .go files', async () => {
		const mixedTmp = fs.mkdtempSync(
			path.join(os.tmpdir(), 'graph-builder-mixed-'),
		);
		try {
			fs.writeFileSync(
				path.join(mixedTmp, 'service.pyw'),
				"__all__ = ['_private_api']\n\ndef _private_api():\n    pass\n\ndef hidden():\n    pass\n",
			);
			fs.writeFileSync(
				path.join(mixedTmp, 'lib.rs'),
				'pub fn public_api() {}\npub(crate) struct InternalThing;\nfn hidden() {}\n',
			);
			fs.writeFileSync(
				path.join(mixedTmp, 'main.go'),
				'package main\n\nfunc PublicFunc() {}\nfunc privateFunc() {}\nconst MaxRetries = 3\n',
			);

			const graph = await buildRepoGraph(mixedTmp);

			expect(graph.files['service.pyw'].exports.map((s) => s.name)).toEqual([
				'_private_api',
			]);
			expect(graph.files['lib.rs'].exports.map((s) => s.name)).toEqual([
				'public_api',
				'InternalThing',
			]);
			expect(graph.files['main.go'].exports.map((s) => s.name)).toEqual([
				'PublicFunc',
				'MaxRetries',
			]);
		} finally {
			fs.rmSync(mixedTmp, { recursive: true, force: true });
		}
	});
});

afterAll(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe('findSourceFiles', () => {
	it('skips node_modules and .git', () => {
		const files = findSourceFiles(tmp);
		const rels = files
			.map((f) => path.relative(tmp, f).replace(/\\/g, '/'))
			.sort();
		expect(rels).toEqual(['src/internal/x.ts', 'src/main.ts', 'src/util.ts']);
	});
});

describe('processFile', () => {
	it('returns a FileNode with imports and forward-slash path', async () => {
		const node = await processFile(path.join(tmp, 'src/main.ts'), tmp);
		expect(node).not.toBeNull();
		expect(node!.path).toBe('src/main.ts');
		expect(node!.language).toBe('typescript');
		expect(node!.imports).toHaveLength(1);
		expect(node!.imports[0].target).toBe('src/util.ts');
		expect(node!.imports[0].importedSymbols).toEqual(['add']);
	});

	it('returns null for unsupported files', async () => {
		const f = path.join(tmp, 'README.md');
		fs.writeFileSync(f, '# hi\n');
		const node = await processFile(f, tmp);
		expect(node).toBeNull();
	});
});

describe('buildRepoGraph', () => {
	it('builds a complete graph for the fixture repo', async () => {
		const graph = await buildRepoGraph(tmp);
		expect(graph.version).toBe(1);
		expect(graph.rootDir).toBe(tmp);
		expect(Object.keys(graph.files).sort()).toEqual([
			'src/internal/x.ts',
			'src/main.ts',
			'src/util.ts',
		]);
		// util.ts has 0 imports (it's a leaf)
		expect(graph.files['src/util.ts'].imports).toHaveLength(0);
		// main.ts and x.ts each import util
		expect(graph.files['src/main.ts'].imports[0].target).toBe('src/util.ts');
		expect(graph.files['src/internal/x.ts'].imports[0].target).toBe(
			'src/util.ts',
		);
	});

	it('respects maxFiles cap', async () => {
		const graph = await buildRepoGraph(tmp, { maxFiles: 1 });
		expect(Object.keys(graph.files).length).toBeLessThanOrEqual(1);
	});
});

describe('buildRepoGraph — regression: control characters in import specifiers (F3)', () => {
	// Prior to the fix in import-extractor.ts, a file containing a control
	// character (e.g. CR \r) in an import specifier would cause the dirty
	// rawModule to propagate into the graph's ImportEdge records and ultimately
	// into the persisted graph JSON.  buildRepoGraph must not throw and must
	// produce clean data when encountering such files.

	it('does not throw and produces clean edges when a source file has a CR in an import path', async () => {
		const dirtyTmp = fs.mkdtempSync(
			path.join(os.tmpdir(), 'graph-builder-ctrl-'),
		);
		try {
			const cr = String.fromCharCode(13);
			// dirty.ts: one dirty import (specifier has CR) + one clean import
			fs.writeFileSync(
				path.join(dirtyTmp, 'dirty.ts'),
				`import bad from './bar${cr}.js';\nimport ok from './clean-file';\n`,
				'binary',
			);
			// clean target so the clean edge resolves
			fs.writeFileSync(
				path.join(dirtyTmp, 'clean-file.ts'),
				'export default 1;\n',
			);

			// Must not throw
			const graph = await buildRepoGraph(dirtyTmp);

			// Both files appear as graph nodes
			expect(Object.keys(graph.files)).toContain('dirty.ts');
			expect(Object.keys(graph.files)).toContain('clean-file.ts');

			// No edge or rawModule in the graph contains control characters
			for (const node of Object.values(graph.files)) {
				for (const edge of node.imports) {
					expect(/[\0\t\r\n]/.test(edge.rawModule)).toBe(false);
					expect(/[\0\t\r\n]/.test(edge.target)).toBe(false);
				}
			}

			// The clean import survives
			const dirtyNode = graph.files['dirty.ts'];
			const cleanEdge = dirtyNode?.imports.find(
				(e) => e.rawModule === './clean-file',
			);
			expect(cleanEdge).toBeDefined();
		} finally {
			fs.rmSync(dirtyTmp, { recursive: true, force: true });
		}
	});
});
