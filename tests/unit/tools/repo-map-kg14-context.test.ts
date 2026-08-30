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
	tmp = canonicalMkdtemp('repo-map-kg14-context-');
	fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
	fs.writeFileSync(
		path.join(tmp, 'src/util.ts'),
		'export function add(a: number, b: number) {\n  return a + b;\n}\n',
	);
	fs.writeFileSync(
		path.join(tmp, 'src/main.ts'),
		"import { add } from './util';\nconsole.log(add(1, 2));\n",
	);
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe('repo_map: symbol_context (KG-14)', () => {
	it('answers by file+symbol with identity, signature, and neighbors', async () => {
		await call({ action: 'build' });
		const r = parse(
			await call({
				action: 'symbol_context',
				file: 'src/util.ts',
				symbol: 'add',
			}),
		);
		expect(r.success).toBe(true);
		expect(r.found).toBe(true);
		const identity = r.identity as Record<string, unknown>;
		expect(identity.file).toBe('src/util.ts');
		expect(identity.symbol).toBe('add');
		expect(identity.kind).toBe('function');
		expect(identity.symbolId).toMatch(/^[0-9a-f]{64}$/);
		expect(r.signature).toContain('export function add');
		expect(r.callers as unknown[]).toHaveLength(1);
		expect(r.callees as unknown[]).toHaveLength(0);
	});

	it('round-trips the stable symbol_id', async () => {
		await call({ action: 'build' });
		const first = parse(
			await call({
				action: 'symbol_context',
				file: 'src/util.ts',
				symbol: 'add',
			}),
		);
		const symbolId = (first.identity as Record<string, unknown>).symbolId;
		const second = parse(
			await call({ action: 'symbol_context', symbol_id: symbolId }),
		);
		expect(second.found).toBe(true);
		expect((second.identity as Record<string, unknown>).symbol).toBe('add');
	});

	it('embeds source text on include_source=true', async () => {
		await call({ action: 'build' });
		const r = parse(
			await call({
				action: 'symbol_context',
				file: 'src/util.ts',
				symbol: 'add',
				include_source: true,
			}),
		);
		const source = r.source as Record<string, unknown>;
		expect(source.text).toContain('return a + b;');
		expect(source.hash).toMatch(/^[0-9a-f]{64}$/);
	});

	it('errors when the graph is missing', async () => {
		const r = parse(
			await call({
				action: 'symbol_context',
				file: 'src/util.ts',
				symbol: 'add',
			}),
		);
		expect(r.success).toBe(false);
		expect(r.error).toContain('No repo graph found');
	});

	it('requires symbol_id or file+symbol with a structured error', async () => {
		await call({ action: 'build' });
		const r = parse(await call({ action: 'symbol_context' }));
		expect(r.success).toBe(false);
		expect(r.error).toContain('requires `symbol_id`');
	});

	it('rejects malformed symbol_id values', async () => {
		await call({ action: 'build' });
		const r = parse(
			await call({ action: 'symbol_context', symbol_id: 'not-hex' }),
		);
		expect(r.success).toBe(false);
		expect(r.error).toContain('symbol_id must be a 64-character');
	});

	it('reports missing symbols softly (found:false, not an error envelope)', async () => {
		await call({ action: 'build' });
		const r = parse(
			await call({
				action: 'symbol_context',
				file: 'src/util.ts',
				symbol: 'ghost',
			}),
		);
		expect(r.success).toBe(true);
		expect(r.found).toBe(false);
		expect(r.note).toContain('not defined in this file');
	});

	it('rejects path traversal on the file argument', async () => {
		await call({ action: 'build' });
		const r = parse(
			await call({
				action: 'symbol_context',
				file: '../../etc/passwd',
				symbol: 'add',
			}),
		);
		expect(r.success).toBe(false);
		expect(r.error).toContain('path traversal');
	});

	it('answers on a pre-1.6.0 graph with kind degradation', async () => {
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
				action: 'symbol_context',
				file: 'src/util.ts',
				symbol: 'add',
			}),
		);
		expect(r.found).toBe(true);
		expect((r.identity as Record<string, unknown>).kind).toBeNull();
	});
});
