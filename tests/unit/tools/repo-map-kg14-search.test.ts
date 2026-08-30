import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { GRAPH_SCHEMA_VERSION } from '../../../src/tools/repo-graph';
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
	tmp = canonicalMkdtemp('repo-map-kg14-search-');
	fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
	fs.writeFileSync(
		path.join(tmp, 'src/util.ts'),
		[
			'export function add(a: number, b: number) { return a + b; }',
			'export class Calculator {',
			'  run() { return add(1, 2); }',
			'  toString() { return "Calculator"; }',
			'}',
			'',
		].join('\n'),
	);
	fs.writeFileSync(
		path.join(tmp, 'src/main.ts'),
		"import { add } from './util';\nconsole.log(add(1, 2));\n",
	);
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe('repo_map: symbol_search (KG-14)', () => {
	it('returns tiered, filtered, workspace-relative hits on a built graph', async () => {
		await call({ action: 'build' });
		const r = parse(
			await call({
				action: 'symbol_search',
				symbol: 'calc',
				kind: 'class',
				visibility: 'exported',
			}),
		);
		expect(r.success).toBe(true);
		expect(r.action).toBe('symbol_search');
		expect(r.kindSupported).toBe(true);
		const hits = r.hits as Array<Record<string, unknown>>;
		expect(hits).toHaveLength(1);
		expect(hits[0]).toMatchObject({
			file: 'src/util.ts',
			symbol: 'Calculator',
			kind: 'class',
			visibility: 'exported',
			match: 'prefix',
		});
	});

	it('Object.prototype-named symbols survive the full round trip', async () => {
		await call({ action: 'build' });
		const r = parse(
			await call({ action: 'symbol_search', symbol: 'toString' }),
		);
		const hits = r.hits as Array<Record<string, unknown>>;
		expect(hits.map((h) => h.symbol)).toEqual(['toString']);
	});

	it('errors when the graph is missing', async () => {
		const r = parse(await call({ action: 'symbol_search', symbol: 'add' }));
		expect(r.success).toBe(false);
		expect(r.action).toBe('symbol_search');
		expect(r.error).toContain('No repo graph found');
	});

	it('errors for a missing search term and control characters', async () => {
		await call({ action: 'build' });
		const missing = parse(await call({ action: 'symbol_search' }));
		expect(missing.success).toBe(false);
		expect(missing.error).toContain('requires `symbol`');
		const ctrl = parse(
			await call({ action: 'symbol_search', symbol: 'bad\u0000name' }),
		);
		expect(ctrl.success).toBe(false);
		expect(ctrl.error).toContain('control characters');
	});

	it('rejects path traversal and absolute file filters', async () => {
		await call({ action: 'build' });
		const traversal = parse(
			await call({ action: 'symbol_search', symbol: 'add', file: '../out.ts' }),
		);
		expect(traversal.success).toBe(false);
		expect(traversal.error).toContain('path traversal');
		const absolute = parse(
			await call({ action: 'symbol_search', symbol: 'add', file: 'C:/x/y.ts' }),
		);
		expect(absolute.success).toBe(false);
		expect(absolute.error).toContain('workspace-relative');
	});

	it('refreshes drift and surfaces freshness metadata in the response', async () => {
		await call({ action: 'build' });
		fs.appendFileSync(
			path.join(tmp, 'src/util.ts'),
			'\nexport const drift = 1;\n',
		);
		const r = parse(await call({ action: 'symbol_search', symbol: 'drift' }));
		expect(r.success).toBe(true);
		// The drift is within refresh_cap: the read-time incremental refresh
		// runs, the follow-up probe certifies clean, and the new symbol is
		// already searchable — freshness metadata rides along either way.
		expect(r.probeState).toBe('clean');
		expect(r.stale).toBe(false);
		expect(Number(r.refreshedFiles)).toBeGreaterThanOrEqual(1);
		const hits = r.hits as Array<Record<string, unknown>>;
		expect(hits.map((h) => h.symbol)).toContain('drift');
	});

	it('degrades kind filters on a pre-1.6.0 graph with an explicit warning', async () => {
		await call({ action: 'build' });
		expect(GRAPH_SCHEMA_VERSION).toBe('1.6.0');
		const graphPath = path.join(tmp, '.swarm/repo-graph.json');
		const graph = JSON.parse(fs.readFileSync(graphPath, 'utf-8')) as {
			schema_version: string;
			nodes: Record<string, { exportKinds?: unknown }>;
		};
		graph.schema_version = '1.5.0';
		for (const node of Object.values(graph.nodes)) delete node.exportKinds;
		fs.writeFileSync(graphPath, JSON.stringify(graph));
		const r = parse(
			await call({ action: 'symbol_search', symbol: 'calc', kind: 'class' }),
		);
		expect(r.success).toBe(true);
		expect(r.kindSupported).toBe(false);
		expect(r.hits).toEqual([]);
		expect((r.warnings as string[]).join('\n')).toContain(
			'kind filter requires graph schema 1.6.0+',
		);
	});

	it('bounds hits by top_n with budget accounting', async () => {
		await call({ action: 'build' });
		// 'a' matches `add` and `Calculator` (both substring tier) — main.ts
		// defines no exported symbols in this fixture.
		const r = parse(
			await call({ action: 'symbol_search', symbol: 'a', top_n: 1 }),
		);
		expect((r.hits as unknown[]).length).toBe(1);
		expect(r.budget).toEqual({ returned: 1, dropped: 1 });
	});
});
