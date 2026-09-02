import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	classifyRetrieval,
	ROUTER_METADATA_OVERHEAD_TOKENS,
	routeRetrieval,
} from '../../../src/tools/repo-graph';
import { repo_map } from '../../../src/tools/repo-map';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

let tmp = '';

function call(args: Record<string, unknown>): Promise<Record<string, any>> {
	type Executable = {
		execute: (
			args: Record<string, unknown>,
			ctx: { directory: string },
		) => Promise<string>;
	};
	return (repo_map as unknown as Executable)
		.execute(args, { directory: tmp })
		.then((out) => JSON.parse(out) as Record<string, any>);
}

afterEach(() => {
	if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
	tmp = '';
});

describe('retrieval router edge coverage', () => {
	test('reports graph_load_error and still serves bounded lexical fallback', async () => {
		tmp = canonicalMkdtemp('repo-map-kg16-load-error-');
		fs.mkdirSync(path.join(tmp, '.swarm'), { recursive: true });
		fs.writeFileSync(path.join(tmp, '.swarm', 'repo-graph.json'), '{not-json');
		fs.writeFileSync(path.join(tmp, 'source.ts'), 'const NEEDLE = 1;\n');
		const result = await call({
			action: 'retrieve',
			question: 'Where is NEEDLE implemented?',
		});
		expect(result.success).toBe(true);
		expect(result.fallbackReason).toBe('graph_load_error');
		expect(result.actions).toContain('lexical_search');
	});

	test('pins the closed-set algorithm mapping and classification explanation', async () => {
		const lexicalRequests = [
			['Find exact string `needle`', 'lexical', 'literal'],
			['Who calls login?', 'graph', 'graph'],
			['Find code related to onboarding', 'semantic', 'fuzzy_graph'],
			['Check auth risk', 'security', 'graph_packs'],
			['Add tests for login', 'test', 'graph_packs'],
			['Review this diff', 'hybrid', 'mixed'],
		] as const;
		for (const [question, mode, algorithm] of lexicalRequests) {
			const result = await routeRetrieval(
				null,
				{ question, maxTokens: 256 },
				async () => ({ matches: [], total: 0, engine: 'test' }),
			);
			expect(result.mode).toBe(mode);
			expect(result.algorithm).toBe(algorithm);
			expect(result.explanation[0]).toBe(`classified:${result.reason}`);
		}
	});

	test('passes validated scope and route hints to lexical fallback', async () => {
		let request: Record<string, unknown> | undefined;
		await routeRetrieval(
			null,
			{
				question: 'Check route risk',
				files: ['src/routes.ts'],
				routePath: '/admin',
				method: 'GET',
			},
			async (value) => {
				request = value as unknown as Record<string, unknown>;
				return { matches: [], total: 0, engine: 'test' };
			},
			'graph_miss',
		);
		expect(request).toEqual({
			query: '/admin GET',
			files: ['src/routes.ts'],
			routePath: '/admin',
			method: 'GET',
		});
	});

	test('makes an undersized budget explicit instead of silently dropping context', async () => {
		const result = await routeRetrieval(
			null,
			{ question: 'Find exact string `needle`', maxTokens: 1 },
			async () => ({ matches: [{ text: 'x'.repeat(1000) }], total: 1 }),
		);
		expect(result.budget.requestedTokens).toBe(1);
		expect(result.budget.usedTokens).toBeLessThanOrEqual(1);
		expect(result.warnings).toContain('context_budget_too_small');
		expect(ROUTER_METADATA_OVERHEAD_TOKENS).toBeGreaterThan(0);
	});

	test('does not classify contractions as quoted literals', () => {
		expect(classifyRetrieval("Find user's implementation").mode).toBe(
			'semantic',
		);
	});

	test('keeps exact-string intent lexical when a file hint is present', async () => {
		const result = await routeRetrieval(
			{
				schemaVersion: '1.6.0',
				files: {},
				symbols: {},
				edges: [],
			} as never,
			{
				question: 'Find exact string `NEEDLE`',
				file: 'src/login.ts',
			},
			async () => ({ matches: [], total: 0, engine: 'test' }),
		);
		expect(result.mode).toBe('lexical');
		expect(result.actions).toContain('lexical_search');
	});
});
