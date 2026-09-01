import { afterEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	classifyRetrieval,
	RETRIEVAL_MODES,
} from '../../../src/tools/repo-graph';
import {
	repo_map,
	_internals as repoMapInternals,
} from '../../../src/tools/repo-map';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

let tmp = '';
const realRetrievalRouted = repoMapInternals.telemetry.retrievalRouted;
const realLoadPluginConfigWithMeta = repoMapInternals.loadPluginConfigWithMeta;

function call(
	args: Record<string, unknown>,
	sessionID?: string,
): Promise<string> {
	type Executable = {
		execute: (
			args: Record<string, unknown>,
			ctx: { directory: string; sessionID?: string },
		) => Promise<string>;
	};
	return (repo_map as unknown as Executable).execute(args, {
		directory: tmp,
		sessionID,
	});
}

function parse(out: string): Record<string, any> {
	return JSON.parse(out) as Record<string, any>;
}

afterEach(() => {
	if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
	tmp = '';
	repoMapInternals.telemetry.retrievalRouted = realRetrievalRouted;
	repoMapInternals.loadPluginConfigWithMeta = realLoadPluginConfigWithMeta;
});

describe('KG-16 retrieval router classification', () => {
	test('covers all six deterministic modes and precedence', () => {
		const cases = [
			['Find exact string `SWARM_FOO` in tests', 'lexical'],
			['Review this diff for auth tests', 'hybrid'],
			['Add tests for this change', 'test'],
			['Check auth risk', 'security'],
			['Who calls createSession?', 'graph'],
			['Where is login implemented?', 'hybrid'],
			['Find code related to onboarding', 'semantic'],
		] as const;
		for (const [question, mode] of cases)
			expect(classifyRetrieval(question).mode).toBe(mode);
		expect(new Set(cases.map((x) => x[1]))).toEqual(new Set(RETRIEVAL_MODES));
	});
});

describe('repo_map retrieve production path', () => {
	test('routes every mode through a real bounded action and explains it', async () => {
		tmp = canonicalMkdtemp('repo-map-kg16-');
		fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
		fs.mkdirSync(path.join(tmp, 'tests'), { recursive: true });
		fs.writeFileSync(
			path.join(tmp, 'src', 'session.ts'),
			"export function createSession() { return 'SWARM_FOO'; }\n",
		);
		fs.writeFileSync(
			path.join(tmp, 'src', 'login.ts'),
			"import { createSession } from './session';\nexport function login() { return createSession(); }\n",
		);
		fs.writeFileSync(
			path.join(tmp, 'tests', 'login.test.ts'),
			"import { login } from '../src/login';\nlogin();\n",
		);
		expect(parse(await call({ action: 'build' })).success).toBe(true);

		const requests = [
			{ question: 'Find exact string `SWARM_FOO`', expected: 'lexical' },
			{
				question: 'Who calls createSession?',
				symbol: 'createSession',
				expected: 'graph',
			},
			{ question: 'Find code related to onboarding', expected: 'semantic' },
			{
				question: 'Check auth risk',
				file: 'src/login.ts',
				expected: 'security',
			},
			{
				question: 'Add tests for this change',
				file: 'src/login.ts',
				expected: 'test',
			},
			{ question: 'Where is login implemented?', expected: 'hybrid' },
		];
		const seen = new Set<string>();
		for (const request of requests) {
			const result = parse(
				await call({ action: 'retrieve', max_tokens: 800, ...request }, 'kg16'),
			);
			expect(result.success).toBe(true);
			expect(result.mode).toBe(request.expected);
			expect(result.algorithm).toBe(
				{
					lexical: 'literal',
					graph: 'graph',
					semantic: 'fuzzy_graph',
					security: 'graph_packs',
					test: 'graph_packs',
					hybrid: 'mixed',
				}[request.expected],
			);
			seen.add(result.mode);
			expect(result.actions.length).toBeGreaterThan(0);
			expect(result.explanation.length).toBeGreaterThan(0);
			expect(result.budget.usedTokens).toBeLessThanOrEqual(800);
			expect(result.budget.omittedContextCount).toBeGreaterThanOrEqual(0);
			expect(
				Math.ceil(Buffer.byteLength(JSON.stringify(result), 'utf8') / 4),
			).toBeLessThanOrEqual(800 + result.budget.metadataOverheadTokens);
		}
		expect(seen).toEqual(new Set(RETRIEVAL_MODES));
		const noHintSecurity = parse(
			await call({ action: 'retrieve', question: 'Check auth risk' }),
		);
		expect(noHintSecurity.actions).toContain('preflight_packet');
		const genericHybrid = parse(
			await call({
				action: 'retrieve',
				question: 'Where is login implemented?',
			}),
		);
		expect(genericHybrid.actions).toContain('ask');
		expect(genericHybrid.actions).toContain('graph_explain');

		const bounded = parse(
			await call({
				action: 'retrieve',
				question: 'Find code related to login',
				top_n: 1,
			}),
		);
		const ask = bounded.context.find(
			(entry: Record<string, unknown>) => entry.action === 'ask',
		);
		expect(ask.data.hits.length).toBeLessThanOrEqual(1);
	});

	test('falls back to literal search when the graph is missing and rejects empty questions', async () => {
		tmp = canonicalMkdtemp('repo-map-kg16-fallback-');
		fs.writeFileSync(
			path.join(tmp, 'source.ts'),
			'export const createSession = 1;\n',
		);
		const result = parse(
			await call({
				action: 'retrieve',
				question: 'Who calls createSession?',
				symbol: 'createSession',
			}),
		);
		expect(result.success).toBe(true);
		expect(result.mode).toBe('graph');
		expect(result.graphHit).toBe(false);
		expect(result.fallbackReason).toBe('graph_missing');
		expect(result.actions).toContain('lexical_search');
		const empty = parse(await call({ action: 'retrieve', question: '  ' }));
		expect(empty.success).toBe(false);
	});

	test('uses the same bounded lexical fallback when repository graphs are disabled', async () => {
		tmp = canonicalMkdtemp('repo-map-kg16-disabled-');
		fs.writeFileSync(path.join(tmp, 'source.ts'), 'const NEEDLE = 1;\n');
		repoMapInternals.loadPluginConfigWithMeta = (() => ({
			config: { repo_graph: { enabled: false } },
			recovery: 'none',
			removedKeys: [],
			warnings: [],
			loadedFromFile: false,
			configHadErrors: false,
		})) as typeof repoMapInternals.loadPluginConfigWithMeta;

		const result = parse(
			await call({ action: 'retrieve', question: 'Who calls NEEDLE?' }),
		);
		expect(result.success).toBe(true);
		expect(result.graphHit).toBe(false);
		expect(result.fallbackReason).toBe('graph_disabled');
		expect(result.actions).toEqual(['lexical_search']);
	});

	test('falls back on empty graph, security, test, and hybrid pack results', async () => {
		tmp = canonicalMkdtemp('repo-map-kg16-pack-miss-');
		fs.writeFileSync(path.join(tmp, 'source.ts'), 'const NEEDLE = 1;\n');
		expect(parse(await call({ action: 'build' })).success).toBe(true);
		const requests = [
			{
				mode: 'graph',
				question: 'What is the impact of this file?',
				file: 'missing.ts',
			},
			{
				mode: 'security',
				question: 'Check auth risk for this route',
				route_path: '/missing',
			},
			{
				mode: 'test',
				question: 'Add tests for this change',
				file: 'missing.ts',
			},
			{
				mode: 'hybrid',
				question: 'Review this file',
				files: ['missing.ts'],
			},
		];
		for (const request of requests) {
			const result = parse(await call({ action: 'retrieve', ...request }));
			expect({ mode: result.mode, graphHit: result.graphHit }).toEqual({
				mode: request.mode,
				graphHit: false,
			});
			expect(result.fallbackReason).toBe('graph_miss');
			expect(result.actions.at(-1)).toBe('lexical_search');
		}
	});

	test('applies direct-action validation to every routed auxiliary input', async () => {
		tmp = canonicalMkdtemp('repo-map-kg16-validation-');
		const attacks = [
			{ question: 'Review this file', file: '' },
			{ question: 'Review this file', file: '../escape.ts' },
			{ question: 'Review files', files: ['C:\\escape.ts'] },
			{ question: 'Who calls it?', symbol: '' },
			{ question: 'Who calls it?', symbol: 'bad\u0000symbol' },
			{ question: 'Check auth route', route_path: '' },
			{ question: 'Check auth route', route_path: 'missing-slash' },
			{ question: 'Check data risk', entity: '' },
			{ question: 'Check data risk', entity: '../users' },
			{ question: 'Review this diff', diff: '' },
			{ question: 'Review this diff', diff: '+++ b/a.ts\n+\u202ehidden' },
			{ question: 'Check data risk', entity: 'users', file: 'src/a.ts' },
			{
				question: 'Check route risk',
				route_path: '/users',
				files: ['src/a.ts'],
			},
			{ question: 'Check route risk', method: 'GET' },
		];
		for (const attack of attacks) {
			const result = parse(await call({ action: 'retrieve', ...attack }));
			expect(result.success).toBe(false);
		}
	});

	test('normalizes Windows-relative paths and treats empty file lists as omitted', async () => {
		tmp = canonicalMkdtemp('repo-map-kg16-path-parity-');
		fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
		fs.writeFileSync(
			path.join(tmp, 'src', 'login.ts'),
			'export const login = 1;\n',
		);
		expect(parse(await call({ action: 'build' })).success).toBe(true);

		const windowsPath = parse(
			await call({
				action: 'retrieve',
				question: 'Review this file',
				file: 'src\\login.ts',
			}),
		);
		expect(windowsPath.graphHit).toBe(true);
		expect(windowsPath.actions).not.toContain('lexical_search');

		for (const question of [
			'Add tests for login behavior',
			'Where is login implemented?',
		]) {
			const omitted = parse(await call({ action: 'retrieve', question }));
			const empty = parse(
				await call({ action: 'retrieve', question, files: [] }),
			);
			expect({
				mode: empty.mode,
				actions: empty.actions,
				graphHit: empty.graphHit,
				fallbackReason: empty.fallbackReason,
			}).toEqual({
				mode: omitted.mode,
				actions: omitted.actions,
				graphHit: omitted.graphHit,
				fallbackReason: omitted.fallbackReason,
			});
		}

		const dispatchCases = [
			{
				args: { question: 'Who calls login?', symbol: 'login' },
				action: 'callers',
			},
			{
				args: {
					question: 'Review these files',
					files: ['src/login.ts'],
					symbol: 'login',
				},
				action: 'diff_context',
			},
			{
				args: {
					question: 'Review this change',
					diff: '--- a/src/login.ts\n+++ b/src/login.ts\n@@ -1 +1 @@\n',
				},
				action: 'diff_context',
			},
			{
				args: { question: 'Find account data', entity: 'account' },
				action: 'data_trace',
			},
			{
				args: {
					question: 'Review auth route',
					route_path: '/admin',
					method: 'GET',
				},
				action: 'route_trace',
			},
		] as const;
		for (const dispatch of dispatchCases) {
			const result = parse(
				await call({ action: 'retrieve', ...dispatch.args }),
			);
			expect(result.actions).toContain(dispatch.action);
			if ('symbol' in dispatch.args && 'files' in dispatch.args) {
				const pack = result.context.find(
					(entry: Record<string, unknown>) => entry.action === 'test_pack',
				);
				expect(pack.data.target.symbol).toBe(dispatch.args.symbol);
			}
		}

		for (const args of [
			{ question: 'Find account data', entity: 'account' },
			{ question: 'Check auth route', route_path: '/admin' },
		]) {
			const omitted = parse(await call({ action: 'retrieve', ...args }));
			const empty = parse(
				await call({ action: 'retrieve', ...args, files: [] }),
			);
			expect(empty).toEqual(omitted);
		}
	});

	test('emits exactly one content-free telemetry record and remains fail-open', async () => {
		tmp = canonicalMkdtemp('repo-map-kg16-telemetry-');
		fs.writeFileSync(path.join(tmp, 'source.ts'), 'const TOKEN = 1;\n');
		const events: Array<Record<string, unknown>> = [];
		repoMapInternals.telemetry.retrievalRouted = mock((sessionId, data) => {
			events.push({ sessionId, ...data });
		});
		const result = parse(
			await call({ action: 'retrieve', question: 'Find exact string `TOKEN`' }),
		);
		expect(result.success).toBe(true);
		expect(events).toHaveLength(0);
		const sessionResult = parse(
			await call(
				{ action: 'retrieve', question: 'Find exact string `TOKEN`' },
				'kg16-telemetry',
			),
		);
		expect(sessionResult.success).toBe(true);
		expect(events).toHaveLength(1);
		expect(events[0]?.sessionId).toBe('kg16-telemetry');
		const serialized = JSON.stringify(events[0]);
		for (const forbidden of [
			'TOKEN',
			'source.ts',
			'question',
			'source',
			'symbol',
			'result',
		])
			expect(serialized).not.toContain(forbidden);

		events.length = 0;
		expect(parse(await call({ action: 'build' })).success).toBe(true);
		for (const question of [
			'Find exact string `TOKEN`',
			'Who calls TOKEN?',
			'Find code related to TOKEN',
			'Check auth risk',
			'Add tests for TOKEN',
			'Where is TOKEN implemented?',
		]) {
			const routed = parse(
				await call({ action: 'retrieve', question }, 'kg16-telemetry'),
			);
			expect(routed.success).toBe(true);
		}
		expect(events).toHaveLength(6);
		for (const event of events) {
			const serializedEvent = JSON.stringify(event);
			for (const forbidden of ['TOKEN', 'source.ts', 'question', 'result'])
				expect(serializedEvent).not.toContain(forbidden);
		}

		repoMapInternals.telemetry.retrievalRouted = mock(() => {
			throw new Error('telemetry unavailable');
		});
		const failOpen = parse(
			await call({ action: 'retrieve', question: 'Find exact string `TOKEN`' }),
		);
		expect(failOpen.success).toBe(true);
	});

	test('preserves fallback file scope and mixed quote delimiters', async () => {
		tmp = canonicalMkdtemp('repo-map-kg16-hints-');
		fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
		fs.writeFileSync(
			path.join(tmp, 'src', 'target.ts'),
			"export const target = 'needle';\n",
		);
		fs.writeFileSync(
			path.join(tmp, 'src', 'other.ts'),
			"export const target = 'needle';\n",
		);
		const scoped = parse(
			await call({
				action: 'retrieve',
				question: 'Find exact string `needle`',
				files: ['src/target.ts'],
			}),
		);
		expect(scoped.success).toBe(true);
		const lexical = scoped.context.find(
			(entry: Record<string, unknown>) => entry.action === 'lexical_search',
		);
		expect(
			lexical.data.matches.every(
				(match: Record<string, unknown>) => match.file === 'src/target.ts',
			),
		).toBe(true);
		expect(classifyRetrieval('Find user\'s value in "needle"').mode).toBe(
			'lexical',
		);
	});

	test('infers caller symbols and considers duplicate definitions', async () => {
		tmp = canonicalMkdtemp('repo-map-kg16-callers-');
		fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
		fs.writeFileSync(
			path.join(tmp, 'src', 'a.ts'),
			'export function target() {}\n',
		);
		fs.writeFileSync(
			path.join(tmp, 'src', 'b.ts'),
			'export function target() {}\n',
		);
		fs.writeFileSync(
			path.join(tmp, 'src', 'caller-a.ts'),
			"import { target } from './a'; target();\n",
		);
		fs.writeFileSync(
			path.join(tmp, 'src', 'caller-b.ts'),
			"import { target } from './b'; target();\n",
		);
		expect(parse(await call({ action: 'build' })).success).toBe(true);
		const result = parse(
			await call({
				action: 'retrieve',
				question: 'Which functions invoke target?',
			}),
		);
		expect(result.success).toBe(true);
		expect(result.actions).toContain('callers');
		expect(result.graphHit).toBe(true);
		expect(
			result.warnings.some((warning: string) =>
				warning.includes('ambiguous symbol'),
			),
		).toBe(true);
	});
});
