import { describe, expect, test } from 'bun:test';
import type { GraphNode } from '../../../src/tools/repo-graph/types';
import { validateGraphNode } from '../../../src/tools/repo-graph/validation';

function node(overrides: Partial<GraphNode> = {}): GraphNode {
	return {
		filePath:
			process.platform === 'win32' ? 'C:\\workspace\\a.ts' : '/workspace/a.ts',
		moduleName: 'a.ts',
		exports: [],
		imports: [],
		language: 'typescript',
		mtime: new Date(0).toISOString(),
		...overrides,
	};
}

describe('GraphNode freshness witnesses', () => {
	test('accepts legacy nodes and paired finite non-negative witnesses', () => {
		expect(() => validateGraphNode(node())).not.toThrow();
		expect(() =>
			validateGraphNode(node({ sizeBytes: 12, mtimeMs: 123.456 })),
		).not.toThrow();
	});

	test('rejects unpaired, negative, and non-finite witnesses', () => {
		expect(() => validateGraphNode(node({ sizeBytes: 1 }))).toThrow(
			/must either both be present/,
		);
		expect(() =>
			validateGraphNode(node({ sizeBytes: -1, mtimeMs: 1 })),
		).toThrow(/sizeBytes/);
		expect(() =>
			validateGraphNode(node({ sizeBytes: 1, mtimeMs: Number.NaN })),
		).toThrow(/mtimeMs/);
	});
});
