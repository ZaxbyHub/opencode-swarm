import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { repo_map } from '../../../src/tools/repo-map';
import { writeKg15Workspace } from './repo-map-kg15.fixture';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

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

describe('repo_map: route_trace (KG-15, issue #1536)', () => {
	beforeEach(() => {
		tmp = canonicalMkdtemp('repo-map-kg15-route-');
		writeKg15Workspace(tmp);
	});

	afterEach(() => {
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	test('traces a guarded route by path + method with handler binding and services', async () => {
		await call({ action: 'build' });
		const r = parse(
			await call({ action: 'route_trace', route_path: '/api/users', method: 'POST' }),
		);
		expect(r.success).toBe(true);
		expect(r.linksSupported).toBe(true);
		const routes = r.routes as Array<Record<string, unknown>>;
		expect(routes.length).toBe(1);
		const route = routes[0];
		expect(route.file).toBe('app/api/users/route.ts');
		expect(route.handlerSymbol).toBe('POST');
		expect(route.handlerConfidence).toBe('high');
		expect(String(route.handlerEvidence)).toContain(
			'export async function POST',
		);
		expect(route.services).toEqual(['src/services/user-service.ts']);
		const findings = route.findings as Array<Record<string, unknown>>;
		expect(findings.length).toBe(0);
		const dataOps = route.dataOperations as Array<Record<string, unknown>>;
		expect(
			dataOps.some(
				(entry) =>
					entry.file === 'src/services/user-service.ts' &&
					(entry.fact as Record<string, unknown>).entity === 'user',
			),
		).toBe(true);
		const security = route.security as Array<Record<string, unknown>>;
		expect(
			security.some(
				(entry) => (entry.fact as Record<string, unknown>).kind === 'authentication',
			),
		).toBe(true);
		expect(
			security.some(
				(entry) => (entry.fact as Record<string, unknown>).kind === 'input_validation',
			),
		).toBe(true);
		expect(route.tests).toEqual(['src/services/user-service.test.ts']);
	});

	test('surfaces the unguarded mutating route warning (named fixture)', async () => {
		await call({ action: 'build' });
		const r = parse(
			await call({ action: 'route_trace', route_path: '/api/orders' }),
		);
		expect(r.success).toBe(true);
		const routes = r.routes as Array<Record<string, unknown>>;
		expect(routes.length).toBe(1);
		const findings = routes[0].findings as Array<Record<string, unknown>>;
		const codes = findings.map(
			(f) => (f.finding as Record<string, unknown>).code,
		);
		expect(codes).toContain('api_route_without_detected_auth');
		expect(codes).toContain('mutating_route_without_detected_validation');
	});

	test('matches by handler file and by handler symbol (method name)', async () => {
		await call({ action: 'build' });
		const byFile = parse(
			await call({ action: 'route_trace', file: 'app/api/users/route.ts' }),
		);
		expect((byFile.routes as unknown[]).length).toBe(2);

		const bySymbol = parse(await call({ action: 'route_trace', symbol: 'GET' }));
		const symbolRoutes = bySymbol.routes as Array<Record<string, unknown>>;
		expect(symbolRoutes.length).toBe(1);
		expect(symbolRoutes[0].route).toMatchObject({
			method: 'GET',
			path: '/api/users',
		});
	});

	test('rejects invalid inputs: missing target, traversal, bad method', async () => {
		await call({ action: 'build' });
		const noTarget = parse(await call({ action: 'route_trace' }));
		expect(noTarget.success).toBe(false);
		expect(noTarget.error).toContain('route_path');

		const traversal = parse(
			await call({ action: 'route_trace', route_path: '/../../etc/passwd' }),
		);
		expect(traversal.success).toBe(false);
		expect(traversal.error).toContain('traversal');

		const absolute = parse(
			await call({ action: 'route_trace', file: path.resolve(tmp, 'app/api/users/route.ts') }),
		);
		expect(absolute.success).toBe(false);
		expect(absolute.error).toContain('workspace-relative');

		const badMethod = parse(
			await call({ action: 'route_trace', route_path: '/api/users', method: 'FETCH' }),
		);
		expect(badMethod.success).toBe(false);
		expect(badMethod.error).toContain('method');
	});

	test('errors when the graph is missing', async () => {
		const r = parse(await call({ action: 'route_trace', route_path: '/api/users' }));
		expect(r.success).toBe(false);
		expect(r.error).toContain('No repo graph found');
	});

	test('degrades handler binding on a pre-1.7.0 graph but still returns the pack', async () => {
		await call({ action: 'build' });
		const graphPath = path.join(tmp, '.swarm/repo-graph.json');
		const graph = JSON.parse(fs.readFileSync(graphPath, 'utf-8')) as {
			schema_version: string;
			nodes: Record<string, { ontology?: { links?: unknown } }>;
		};
		graph.schema_version = '1.6.0';
		for (const node of Object.values(graph.nodes)) {
			if (node.ontology) delete node.ontology.links;
		}
		fs.writeFileSync(graphPath, JSON.stringify(graph));
		const r = parse(
			await call({
				action: 'route_trace',
				route_path: '/api/users',
				method: 'POST',
			}),
		);
		expect(r.success).toBe(true);
		expect(r.linksSupported).toBe(false);
		const routes = r.routes as Array<Record<string, unknown>>;
		expect(routes.length).toBe(1);
		// handler_export binding is structural: the method-named export.
		expect(routes[0].handlerSymbol).toBe('POST');
		expect(routes[0].handlerConfidence).toBeNull();
		// Edges/facts sections still populate on old graphs.
		expect(routes[0].services).toEqual(['src/services/user-service.ts']);
		expect((routes[0].dataOperations as unknown[]).length).toBeGreaterThan(0);
		expect(
			((routes[0].warnings as string[]) ?? (r.warnings as string[])).join?.('\n'),
		).toBeDefined();
		expect((r.warnings as string[]).join('\n')).toContain(
			'graph predates ontology links',
		);
	});

	test('reports unknown routes softly (empty pack + warning, not an error)', async () => {
		await call({ action: 'build' });
		const r = parse(
			await call({ action: 'route_trace', route_path: '/api/does-not-exist' }),
		);
		expect(r.success).toBe(true);
		expect(r.routes).toEqual([]);
		expect((r.warnings as string[]).join('\n')).toContain('no routes matched');
	});
});
