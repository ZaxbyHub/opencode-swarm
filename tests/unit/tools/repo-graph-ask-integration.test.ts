import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	test,
} from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { askGraph, type RepoGraph } from '../../../src/tools/repo-graph';
import { buildWorkspaceGraphAsync } from '../../../src/tools/repo-graph/builder';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

let tempDir: string;
let graph: RepoGraph;

beforeAll(async () => {
	tempDir = canonicalMkdtemp('ask-integ-');

	const src = path.join(tempDir, 'src');
	fs.mkdirSync(src, { recursive: true });

	fs.writeFileSync(
		path.join(src, 'types.ts'),
		[
			'export interface Config { name: string; }',
			'export interface Result { ok: boolean; }',
			'export type Status = "idle" | "running";',
		].join('\n'),
	);

	fs.writeFileSync(
		path.join(src, 'storage.ts'),
		[
			"import { Config } from './types';",
			'export function saveConfig(c: Config) { return JSON.stringify(c); }',
			'export function loadConfig(s: string): Config { return JSON.parse(s); }',
		].join('\n'),
	);

	fs.writeFileSync(
		path.join(src, 'cache.ts'),
		[
			"import { Config } from './types';",
			'const _cache = new Map<string, Config>();',
			'export function getCached(key: string) { return _cache.get(key); }',
			'export function setCached(key: string, v: Config) { _cache.set(key, v); }',
		].join('\n'),
	);

	fs.writeFileSync(
		path.join(src, 'builder.ts'),
		[
			"import { saveConfig } from './storage';",
			"import { Config } from './types';",
			'export function buildConfig(name: string): Config { return { name }; }',
			'export function persistConfig(name: string) { return saveConfig(buildConfig(name)); }',
		].join('\n'),
	);

	fs.writeFileSync(
		path.join(src, 'validator.ts'),
		[
			"import { Result } from './types';",
			'export function validate(input: string): Result { return { ok: input.length > 0 }; }',
		].join('\n'),
	);

	graph = await buildWorkspaceGraphAsync(tempDir, { walkBudgetMs: 10000 });
}, 30000);

afterEach(() => {});

// Clean up after all tests
afterAll(() => {
	if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('askGraph integration with real graph', () => {
	test('graph has expected nodes', () => {
		const moduleNames = Object.values(graph.nodes).map((n) => n.moduleName);
		expect(moduleNames.length).toBeGreaterThanOrEqual(5);
	});

	test('discriminates: "cache" ranks cache.ts first', () => {
		const result = askGraph(graph, 'cache');
		expect(result.hits.length).toBeGreaterThan(0);
		expect(result.hits[0].file).toContain('cache');
	});

	test('discriminates: "validate" ranks validator.ts first', () => {
		const result = askGraph(graph, 'validate');
		expect(result.hits.length).toBeGreaterThan(0);
		expect(result.hits[0].file).toContain('validator');
	});

	test('discriminates: "storage" ranks storage.ts in top 2', () => {
		const result = askGraph(graph, 'storage saveConfig');
		const top2 = result.hits.slice(0, 2).map((h) => h.file);
		expect(top2.some((f) => f.includes('storage'))).toBe(true);
	});

	test('types.ts does not dominate unrelated queries', () => {
		const cacheResult = askGraph(graph, 'cache getCached');
		const builderResult = askGraph(graph, 'persistConfig builder');
		expect(cacheResult.hits[0].file).not.toContain('types');
		expect(builderResult.hits[0].file).not.toContain('types');
	});

	test('budget counts are coherent', () => {
		const result = askGraph(graph, 'config', { topN: 2 });
		expect(result.budget.requested).toBe(2);
		expect(result.budget.returned).toBeLessThanOrEqual(2);
		expect(result.budget.returned + result.budget.dropped).toBeLessThanOrEqual(
			Object.keys(graph.nodes).length,
		);
	});

	test('expandedTerms reflect real vocabulary', () => {
		const result = askGraph(graph, 'buildConfig persistConfig');
		expect(result.expandedTerms.length).toBeGreaterThan(0);
	});

	test('hits include community from real ontology', () => {
		const result = askGraph(graph, 'storage');
		for (const hit of result.hits) {
			expect(typeof hit.community).toBe('string');
			expect(hit.community.length).toBeGreaterThan(0);
		}
	});
});
