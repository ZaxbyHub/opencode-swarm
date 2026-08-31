import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { repo_map } from '../../../src/tools/repo-map';
import { canonicalMkdtemp } from '../../helpers/tmpdir';
import { writeKg15Workspace } from './repo-map-kg15.fixture';

let tmp = '';

function call(args: Record<string, unknown>): Promise<string> {
	type Executable = {
		execute: (
			args: Record<string, unknown>,
			ctx: { directory: string },
		) => Promise<string>;
	};
	return (repo_map as unknown as Executable).execute(args, { directory: tmp });
}

function parse(out: string): Record<string, unknown> {
	return JSON.parse(out) as Record<string, unknown>;
}

describe('repo_map: data_trace (KG-15, issue #1536)', () => {
	beforeEach(() => {
		tmp = canonicalMkdtemp('repo-map-kg15-data-');
		writeKg15Workspace(tmp);
	});

	afterEach(() => {
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	test('traces an entity: readers, writers, tests, and risk notes (service fixture)', async () => {
		await call({ action: 'build' });
		const r = parse(await call({ action: 'data_trace', entity: 'user' }));
		expect(r.success).toBe(true);
		expect(r.linksSupported).toBe(true);
		expect(r.subject).toBe('user');
		const readers = r.readers as Array<Record<string, unknown>>;
		const writers = r.writers as Array<Record<string, unknown>>;
		expect(readers.length).toBe(1);
		expect(readers[0]).toMatchObject({
			file: 'src/services/user-service.ts',
			kind: 'READS',
			via: 'link',
			confidence: 'medium',
		});
		expect(writers.length).toBe(1);
		expect(writers[0]).toMatchObject({
			file: 'src/services/user-service.ts',
			kind: 'WRITES',
		});
		expect(r.deleters).toEqual([]);
		expect(r.tests).toEqual(['src/services/user-service.test.ts']);
		const notes = (r.riskNotes as string[]).join('\n');
		// Tests were found, so the untested-entity note must NOT fire.
		expect(notes.includes('no tests detected')).toBe(false);
	});

	test('traces a config/env key via CONFIGURES', async () => {
		await call({ action: 'build' });
		const r = parse(
			await call({ action: 'data_trace', entity: 'USERS_TABLE' }),
		);
		expect(r.success).toBe(true);
		const configurers = r.configurers as Array<Record<string, unknown>>;
		expect(configurers.length).toBe(1);
		expect(configurers[0]).toMatchObject({
			file: 'src/services/user-service.ts',
			kind: 'CONFIGURES',
			via: 'link',
			confidence: 'medium',
		});
	});

	test('flags untested entities with a risk note (orders route)', async () => {
		await call({ action: 'build' });
		const r = parse(await call({ action: 'data_trace', entity: 'order' }));
		expect(r.success).toBe(true);
		const writers = r.writers as Array<Record<string, unknown>>;
		expect(writers.length).toBe(1);
		expect(writers[0].file).toBe('app/api/orders/route.ts');
		const routes = r.routes as Array<Record<string, unknown>>;
		expect(routes.length).toBe(1);
		expect((routes[0].fact as Record<string, unknown>).path).toBe(
			'/api/orders',
		);
		expect((r.riskNotes as string[]).join('\n')).toContain(
			'no tests detected for order',
		);
	});

	test('scopes by file and by symbol', async () => {
		await call({ action: 'build' });
		const byFile = parse(
			await call({
				action: 'data_trace',
				file: 'src/services/user-service.ts',
			}),
		);
		expect((byFile.writers as unknown[]).length).toBeGreaterThan(0);

		const bySymbol = parse(
			await call({ action: 'data_trace', symbol: 'createUser' }),
		);
		expect((bySymbol.writers as unknown[]).length).toBeGreaterThan(0);
	});

	test('falls back to DataOperationFact matches on a pre-1.7.0 graph', async () => {
		await call({ action: 'build' });
		const graphPath = `${tmp}/.swarm/repo-graph.json`;
		const graph = JSON.parse(fs.readFileSync(graphPath, 'utf-8')) as {
			schema_version: string;
			nodes: Record<string, { ontology?: { links?: unknown } }>;
		};
		graph.schema_version = '1.6.0';
		for (const node of Object.values(graph.nodes)) {
			if (node.ontology) delete node.ontology.links;
		}
		fs.writeFileSync(graphPath, JSON.stringify(graph));
		const r = parse(await call({ action: 'data_trace', entity: 'user' }));
		expect(r.success).toBe(true);
		expect(r.linksSupported).toBe(false);
		const writers = r.writers as Array<Record<string, unknown>>;
		expect(writers.length).toBe(1);
		expect(writers[0].via).toBe('fact');
		expect(writers[0].confidence).toBeNull();
		expect((r.warnings as string[]).join('\n')).toContain(
			'DataOperationFact fallback',
		);
	});

	test('rejects invalid inputs and reports unknown entities softly', async () => {
		await call({ action: 'build' });
		const noTarget = parse(await call({ action: 'data_trace' }));
		expect(noTarget.success).toBe(false);
		expect(noTarget.error).toContain('entity');

		const badEntity = parse(
			await call({ action: 'data_trace', entity: '../../*' }),
		);
		expect(badEntity.success).toBe(false);
		expect(badEntity.error).toContain('entity');

		const unknown = parse(await call({ action: 'data_trace', entity: 'nope' }));
		expect(unknown.success).toBe(true);
		expect(unknown.readers).toEqual([]);
		expect((unknown.warnings as string[]).join('\n')).toContain(
			'no data access matched entity',
		);
	});

	test('errors when the graph is missing', async () => {
		const r = parse(await call({ action: 'data_trace', entity: 'user' }));
		expect(r.success).toBe(false);
		expect(r.error).toContain('No repo graph found');
	});
});
