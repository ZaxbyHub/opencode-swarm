import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { repo_map } from '../../../src/tools/repo-map';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

let tmp = '';

function call(args: Record<string, unknown>): Promise<string> {
	type Executable = {
		execute: (
			args: Record<string, unknown>,
			ctx: { directory: string },
		) => Promise<string>;
	};
	return (repo_map as unknown as Executable).execute(args, {
		directory: tmp,
	});
}

function parse(out: string): Record<string, unknown> {
	return JSON.parse(out) as Record<string, unknown>;
}

beforeEach(() => {
	tmp = canonicalMkdtemp('repo-map-kg14-explain-');
	fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
	fs.writeFileSync(
		path.join(tmp, 'src/util.ts'),
		'export function add(a: number, b: number) {\n  return a + b;\n}\n',
	);
	fs.writeFileSync(
		path.join(tmp, 'src/main.ts'),
		"import { add } from './util';\nexport function run() { return add(1, 2); }\n",
	);
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe('repo_map: graph_explain (KG-14)', () => {
	it('explains a symbol with definition, edges, and import reasons', async () => {
		await call({ action: 'build' });
		const r = parse(
			await call({
				action: 'graph_explain',
				file: 'src/util.ts',
				symbol: 'add',
			}),
		);
		expect(r.success).toBe(true);
		expect(r.fileKnown).toBe(true);
		const types = (r.reasons as Array<Record<string, unknown>>).map(
			(x) => x.type,
		);
		expect(types).toContain('definition');
		expect(types).toContain('referenced_by');
		expect(types).toContain('imported_by');
		const def = (r.reasons as Array<Record<string, unknown>>).find(
			(x) => x.type === 'definition',
		);
		expect(def).toMatchObject({ file: 'src/util.ts', symbol: 'add' });
		expect(r.definition).toMatchObject({
			symbol: 'add',
			visibility: 'exported',
		});
	});

	it('resolves a line to the enclosing symbol', async () => {
		await call({ action: 'build' });
		const r = parse(
			await call({ action: 'graph_explain', file: 'src/util.ts', line: 2 }),
		);
		expect(r.resolvedSpan).toMatchObject({
			symbol: 'add',
			startLine: 1,
			endLine: 3,
		});
		expect((r.target as Record<string, unknown>).symbol).toBe('add');
	});

	it('errors when the graph is missing', async () => {
		const r = parse(
			await call({ action: 'graph_explain', file: 'src/util.ts' }),
		);
		expect(r.success).toBe(false);
		expect(r.error).toContain('No repo graph found');
	});

	it('requires a file argument', async () => {
		await call({ action: 'build' });
		const r = parse(await call({ action: 'graph_explain' }));
		expect(r.success).toBe(false);
		expect(r.error).toContain('requires `file`');
	});

	it('rejects traversal and absolute file inputs', async () => {
		await call({ action: 'build' });
		const traversal = parse(
			await call({ action: 'graph_explain', file: '../x.ts' }),
		);
		expect(traversal.success).toBe(false);
		expect(traversal.error).toContain('path traversal');
		const absolute = parse(
			await call({ action: 'graph_explain', file: '/etc/passwd' }),
		);
		expect(absolute.success).toBe(false);
	});

	it('keeps unknown files answer-shaped with a warning', async () => {
		await call({ action: 'build' });
		const r = parse(
			await call({ action: 'graph_explain', file: 'src/ghost.ts' }),
		);
		expect(r.success).toBe(true);
		expect(r.fileKnown).toBe(false);
		expect((r.warnings as string[]).join('\n')).toContain(
			'target file not found in graph',
		);
	});

	it('answers on a pre-1.6.0 graph (old schema fallback)', async () => {
		await call({ action: 'build' });
		const graphPath = path.join(tmp, '.swarm/repo-graph.json');
		const graph = JSON.parse(fs.readFileSync(graphPath, 'utf-8')) as {
			schema_version: string;
			nodes: Record<string, { exportKinds?: unknown }>;
		};
		graph.schema_version = '1.5.0';
		for (const node of Object.values(graph.nodes)) delete node.exportKinds;
		fs.writeFileSync(graphPath, JSON.stringify(graph));
		const r = parse(
			await call({
				action: 'graph_explain',
				file: 'src/util.ts',
				symbol: 'add',
			}),
		);
		expect(r.success).toBe(true);
		const def = (r.reasons as Array<Record<string, unknown>>).find(
			(x) => x.type === 'definition',
		);
		expect(def?.kind).toBeNull();
	});
});
