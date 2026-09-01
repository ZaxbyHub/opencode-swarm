import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	buildWorkspaceGraphAsync,
	clearCache,
	GRAPH_SCHEMA_VERSION,
	loadGraph,
	saveGraph,
	updateGraphForFiles,
	validateGraphNode,
} from '../../../src/tools/repo-graph';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

let tmp = '';

function writeFixture(): void {
	fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
	fs.writeFileSync(
		path.join(tmp, 'src/util.ts'),
		[
			'export function add(a: number, b: number) { return a + b; }',
			'export class Calculator {',
			'  run() { return add(1, 2); }',
			'}',
			'export const VALUE = 1;',
			'export type Id = string;',
			'export interface Shape { id: Id; }',
			'export enum Mode { On, Off }',
			'function hidden() { return 2; }',
			'',
		].join('\n'),
	);
}

beforeEach(() => {
	tmp = canonicalMkdtemp('repo-graph-export-kinds-');
	writeFixture();
});

afterEach(() => {
	clearCache(tmp);
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe('exportKinds persistence (schema 1.6.0)', () => {
	test('builder persists declaration kinds for exported symbols', async () => {
		const graph = await buildWorkspaceGraphAsync(tmp);
		expect(graph.schema_version).toBe(GRAPH_SCHEMA_VERSION);
		expect(GRAPH_SCHEMA_VERSION).toBe('1.7.0');
		const node = Object.values(graph.nodes).find((n) =>
			n.moduleName.endsWith('util.ts'),
		);
		expect(node).toBeDefined();
		const kinds = node?.exportKinds;
		expect(kinds).toBeDefined();
		expect(kinds?.add).toBe('function');
		expect(kinds?.Calculator).toBe('class');
		expect(kinds?.VALUE).toBe('const');
		expect(kinds?.Id).toBe('type');
		expect(kinds?.Shape).toBe('interface');
		expect(kinds?.Mode).toBe('enum');
		// Non-exported defs stay out of exportRanges/kinds for typescript
		// (widening is JVM/.NET/C++/Swift/dynamic-member grammars only).
		expect(kinds?.hidden).toBeUndefined();
		expect(node?.exportRanges?.hidden).toBeUndefined();
		// Kind keys are a subset of range keys (re-exports add ranges, not kinds).
		for (const key of Object.keys(kinds ?? {})) {
			expect(Object.hasOwn(node?.exportRanges ?? {}, key)).toBe(true);
		}
	});

	test('save/load round-trip validates exportKinds', async () => {
		const graph = await buildWorkspaceGraphAsync(tmp);
		await saveGraph(tmp, graph);
		const loaded = await loadGraph(tmp);
		expect(loaded).not.toBeNull();
		const node = Object.values(loaded?.nodes ?? {}).find((n) =>
			n.moduleName.endsWith('util.ts'),
		);
		expect(node?.exportKinds?.Calculator).toBe('class');
	});

	test('incremental update refreshes exportKinds for changed files', async () => {
		const graph = await buildWorkspaceGraphAsync(tmp);
		await saveGraph(tmp, graph);
		fs.writeFileSync(
			path.join(tmp, 'src/util.ts'),
			'export class Fresh { ok() { return 1; } }\n',
		);
		// updateGraphForFiles resolves given paths against the process cwd, so
		// callers pass absolute paths (same form as repo-graph-incremental.test.ts).
		const updated = await updateGraphForFiles(tmp, [
			path.join(tmp, 'src/util.ts'),
		]);
		const node = Object.values(updated.nodes).find((n) =>
			n.moduleName.endsWith('util.ts'),
		);
		expect(node?.exportKinds?.Fresh).toBe('class');
		expect(node?.exportKinds?.add).toBeUndefined();
	});

	test('a pre-1.6.0 graph without exportKinds still loads', async () => {
		const graph = await buildWorkspaceGraphAsync(tmp);
		const legacy = {
			...graph,
			schema_version: '1.5.0',
			nodes: Object.fromEntries(
				Object.values(graph.nodes).map((n) => {
					const { exportKinds: _drop, ...rest } = n;
					return [n.filePath, rest];
				}),
			),
		};
		await saveGraph(tmp, legacy);
		const loaded = await loadGraph(tmp);
		expect(loaded?.schema_version).toBe('1.5.0');
		const node = Object.values(loaded?.nodes ?? {}).find((n) =>
			n.moduleName.endsWith('util.ts'),
		);
		expect(node?.exportKinds).toBeUndefined();
		expect(node?.exportRanges?.add).toEqual({ startLine: 1, endLine: 1 });
	});
});

describe('exportKinds validation', () => {
	test('validateGraphNode rejects an unknown kind value', () => {
		const node = {
			filePath: path.join(tmp, 'src/x.ts'),
			moduleName: 'src/x.ts',
			exports: ['A'],
			imports: [],
			language: 'typescript',
			mtime: '1',
			exportKinds: { A: 'subroutine' },
		};
		expect(() => validateGraphNode(node)).toThrow(/exportKinds value/);
	});

	test('validateGraphNode rejects control characters in kind keys', () => {
		const node = {
			filePath: path.join(tmp, 'src/x.ts'),
			moduleName: 'src/x.ts',
			exports: [],
			imports: [],
			language: 'typescript',
			mtime: '1',
			exportKinds: { 'bad\u0000name': 'function' },
		};
		expect(() => validateGraphNode(node)).toThrow(/control characters/);
	});

	test('validateGraphNode accepts the full kind union', () => {
		const node = {
			filePath: path.join(tmp, 'src/x.ts'),
			moduleName: 'src/x.ts',
			exports: [],
			imports: [],
			language: 'typescript',
			mtime: '1',
			// The subset invariant (OW-5) requires every kind key to carry an
			// exportRanges entry — kinds never exist without a definition span.
			exportRanges: {
				a: { startLine: 1, endLine: 1 },
				b: { startLine: 2, endLine: 3 },
				c: { startLine: 4, endLine: 4 },
				d: { startLine: 5, endLine: 5 },
				e: { startLine: 6, endLine: 6 },
				f: { startLine: 7, endLine: 7 },
				g: { startLine: 8, endLine: 9 },
			},
			exportKinds: {
				a: 'function',
				b: 'class',
				c: 'const',
				d: 'type',
				e: 'interface',
				f: 'enum',
				g: 'method',
			} as Record<string, 'function'>,
		};
		expect(() => validateGraphNode(node)).not.toThrow();
	});

	test('validateGraphNode rejects a kind without a matching exportRanges entry (OW-5)', () => {
		const node = {
			filePath: path.join(tmp, 'src/x.ts'),
			moduleName: 'src/x.ts',
			exports: [],
			imports: [],
			language: 'typescript',
			mtime: '1',
			exportRanges: { a: { startLine: 1, endLine: 1 } },
			exportKinds: { a: 'function', orphan: 'class' } as Record<
				string,
				'function'
			>,
		};
		expect(() => validateGraphNode(node)).toThrow(
			/exportKinds key "orphan" has no matching exportRanges entry/,
		);
	});
});
