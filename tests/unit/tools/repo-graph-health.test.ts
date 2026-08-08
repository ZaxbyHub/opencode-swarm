import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
	buildWorkspaceGraphAsync,
	clearCache,
	createEmptyGraph,
	type FreshnessProbe,
	getGraphHealth,
	loadGraph,
	type RepoGraph,
	saveGraph,
} from '../../../src/tools/repo-graph';
import { _internals as builderInternals } from '../../../src/tools/repo-graph/builder';

describe('repo graph health diagnostics', () => {
	let tmp: string;
	let originalExtractFileSymbols: typeof builderInternals.extractFileSymbols;
	let originalNow: typeof builderInternals.now;

	beforeEach(() => {
		// realpathSync resolves the macOS /var → /private/var symlink (and Windows
		// 8.3 short names) so the canonical workspace root matches what production
		// code compares against. Issue #1729 macOS quarantine.
		tmp = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'repo-graph-health-')),
		);
		originalExtractFileSymbols = builderInternals.extractFileSymbols;
		originalNow = builderInternals.now;
	});

	afterEach(() => {
		builderInternals.extractFileSymbols = originalExtractFileSymbols;
		builderInternals.now = originalNow;
		clearCache(tmp);
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	test('async build falls back to file-level imports and exports when symbol extraction fails', async () => {
		fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
		fs.writeFileSync(
			path.join(tmp, 'src', 'dep.ts'),
			'export const dep = 1;\n',
		);
		fs.writeFileSync(
			path.join(tmp, 'src', 'main.ts'),
			'import { dep } from "./dep";\nexport const main = dep;\n',
		);
		builderInternals.extractFileSymbols = async () => null;

		const graph = await buildWorkspaceGraphAsync(tmp);
		const mainNode = Object.values(graph.nodes).find(
			(node) => node.moduleName === 'src/main.ts',
		);

		expect(mainNode).toBeDefined();
		expect(mainNode?.imports).toEqual(['./dep']);
		expect(mainNode?.exports).toContain('main');
		expect(graph.edges).toContainEqual(
			expect.objectContaining({
				source: path.join(tmp, 'src', 'main.ts'),
				target: path.join(tmp, 'src', 'dep.ts'),
				importSpecifier: './dep',
			}),
		);
		expect(graph.symbolEdges).toBeUndefined();
		expect(graph.diagnostics?.extractionFailures).toContainEqual({
			file: 'src/main.ts',
			language: 'typescript',
			reason: 'symbol_extraction_failed',
		});
	});

	test('async build yields to host timers during synchronous extraction fallback', async () => {
		fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
		for (let index = 0; index < 64; index++) {
			fs.writeFileSync(
				path.join(tmp, 'src', `file-${index}.ts`),
				`export const value${index} = ${index};\n`,
			);
		}

		let extractionCalls = 0;
		let callsAtHeartbeat = Number.POSITIVE_INFINITY;
		let resolveHeartbeat!: () => void;
		const heartbeat = new Promise<void>((resolve) => {
			resolveHeartbeat = resolve;
		});
		builderInternals.extractFileSymbols = async () => {
			extractionCalls++;
			if (extractionCalls === 1) {
				setTimeout(() => {
					callsAtHeartbeat = extractionCalls;
					resolveHeartbeat();
				}, 0);
			}
			return null;
		};

		const build = buildWorkspaceGraphAsync(tmp);
		let watchdog: ReturnType<typeof setTimeout> | undefined;
		const watchdogFailure = new Promise<never>((_, reject) => {
			watchdog = setTimeout(
				() => reject(new Error('repo graph liveness probe timed out')),
				10_000,
			);
		});
		try {
			await heartbeat;
			await Promise.race([build, watchdogFailure]);
		} finally {
			if (watchdog !== undefined) clearTimeout(watchdog);
		}

		expect(callsAtHeartbeat).toBeLessThanOrEqual(16);
		expect(extractionCalls).toBe(64);
	});

	test('health sanitizes and caps persisted diagnostics without rejecting old graphs', async () => {
		const graph = createEmptyGraph(tmp);
		const validFailures = Array.from({ length: 60 }, (_, i) => ({
			file: `src/file-${i}.ts`,
			language: 'typescript',
			reason: 'symbol_extraction_failed',
		}));
		graph.diagnostics = {
			extractionFailures: [
				...validFailures,
				{ file: '../escape.ts', language: 'typescript', reason: 'bad' },
				{ file: 'C:\\absolute.ts', language: 'typescript', reason: 'bad' },
				{ file: 'src/bad\u0000file.ts', language: 'typescript', reason: 'bad' },
			],
			unresolvedImports: [
				{ file: 'src/main.ts', specifier: './missing' },
				{ file: '../escape.ts', specifier: './missing' },
			],
			oversizedFiles: ['src/large.ts', '../large.ts'],
			unsupportedFiles: ['README.md', '/etc/passwd'],
			binaryFiles: ['src/blob.ts'],
			unreadableFiles: ['src/secret.ts'],
			validationSkippedFiles: ['src/invalid.ts', '../invalid.ts'],
			lowConfidenceEdgeCount: 3,
		};

		const health = getGraphHealth(graph);

		expect(health.schemaVersion).toBe(graph.schema_version);
		expect(health.extractionFailures).toHaveLength(50);
		expect(
			health.extractionFailures.every((entry) => entry.file.startsWith('src/')),
		).toBe(true);
		expect(health.unresolvedImports).toEqual([
			{ file: 'src/main.ts', specifier: './missing' },
		]);
		expect(health.oversizedFiles).toEqual(['src/large.ts']);
		expect(health.unsupportedFiles).toEqual(['README.md']);
		expect(health.binaryFiles).toEqual(['src/blob.ts']);
		expect(health.unreadableFiles).toEqual(['src/secret.ts']);
		expect(health.validationSkippedFiles).toEqual(['src/invalid.ts']);
		expect(health.lowConfidenceEdgeCount).toBe(3);
		expect(health.notes).toContain('1 binary files skipped during last build.');
		expect(health.notes).toContain(
			'1 unreadable files skipped during last build.',
		);
	});

	test('health derives additions and removals from the content probe', () => {
		const graph = createEmptyGraph(tmp);
		const probe: FreshnessProbe = {
			state: 'drifted',
			changed: [path.join(tmp, 'src/new.ts')],
			removed: [path.join(tmp, 'src/removed.ts')],
			truncated: false,
			probedFiles: 2,
			elapsedMs: 1,
		};

		const health = getGraphHealth(graph, tmp, probe);

		expect(health.fresh).toBe(false);
		expect(health.probeState).toBe('drifted');
		expect(health.staleFiles).toEqual(['src/new.ts', 'src/removed.ts']);
	});

	test('health reports incomplete probe state without claiming stale content', () => {
		const graph = createEmptyGraph(tmp);
		const probe: FreshnessProbe = {
			state: 'inconclusive',
			changed: [],
			removed: [],
			truncated: true,
			probedFiles: 1,
			elapsedMs: 1,
		};

		const health = getGraphHealth(graph, tmp, probe);

		expect(health.fresh).toBe(false);
		expect(health.probeState).toBe('inconclusive');
		expect(health.notes.join('\n')).toContain('freshness is unknown');
	});

	test('old graph without diagnostics loads and reports empty health diagnostics', async () => {
		const graph: RepoGraph = {
			schema_version: '1.1.0',
			workspaceRoot: tmp,
			nodes: {},
			edges: [],
			metadata: {
				generatedAt: new Date().toISOString(),
				generator: 'test',
				nodeCount: 0,
				edgeCount: 0,
			},
		};
		await saveGraph(tmp, graph);
		const loaded = await loadGraph(tmp);

		expect(loaded).not.toBeNull();
		if (!loaded) throw new Error('expected graph to load');
		const health = getGraphHealth(loaded);
		expect(health.extractionFailures).toEqual([]);
		expect(health.unresolvedImports).toEqual([]);
		expect(health.oversizedFiles).toEqual([]);
		expect(health.unsupportedFiles).toEqual([]);
		expect(health.notes).toContain(
			'Graph has no recorded diagnostics. Rebuild with repo_map action="build" to collect health details.',
		);
	});

	test('truncated walk surfaces walkTruncated and an INCOMPLETE note (A7)', async () => {
		// Force a walk truncation by setting a tiny file cap and producing more
		// scannable files than it allows.
		fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
		for (let i = 0; i < 5; i++) {
			fs.writeFileSync(
				path.join(tmp, 'src', `f${i}.ts`),
				`export const f${i} = ${i};\n`,
			);
		}
		const graph = await buildWorkspaceGraphAsync(tmp, { maxFiles: 2 });

		expect(graph.diagnostics?.walkTruncated).toBe(true);
		expect(graph.diagnostics?.walkTruncationReason).toBe('cap');

		const health = getGraphHealth(graph);
		expect(health.walkTruncated).toBe(true);
		expect(health.walkTruncationReason).toBe('cap');
		expect(
			health.notes.some((n) =>
				n.startsWith(
					'Graph is INCOMPLETE: walk hit the file-cap/wall-clock budget',
				),
			),
		).toBe(true);
	});

	test('budget-truncated walk reports reason "budget" (A7)', async () => {
		fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
		for (let i = 0; i < 3; i++) {
			fs.writeFileSync(
				path.join(tmp, 'src', `f${i}.ts`),
				`export const f${i} = ${i};\n`,
			);
		}
		// The budget check is `now() - startedAt > walkBudgetMs`
		// (`src/tools/repo-graph/builder.ts`), so a 0ms budget needs STRICTLY MORE
		// than 0ms of elapsed wall clock to trip. Walking this 3-file fixture can
		// finish inside a single millisecond on a fast runner, leaving `0 > 0`
		// false and nothing truncated — a real `unit (macos-latest, 2)` failure
		// that survived both CI retries (run 31272876577).
		//
		// Drive the seam instead of the wall clock: the first call establishes
		// `startedAt`, every later call is 1ms further on, so the first budget
		// check is guaranteed to trip regardless of how fast the machine is. This
		// pins the ABORT REASON, which is what the test is about; it deliberately
		// does not assert how many files were visited first.
		let tick = 0;
		builderInternals.now = () => tick++;
		const graph = await buildWorkspaceGraphAsync(tmp, { walkBudgetMs: 0 });
		expect(graph.diagnostics?.walkTruncated).toBe(true);
		expect(graph.diagnostics?.walkTruncationReason).toBe('budget');
	});

	test('incrementalFallbacks surface in graph_health (A7)', () => {
		const graph = createEmptyGraph(tmp);
		graph.diagnostics = { incrementalFallbacks: 4 };
		const health = getGraphHealth(graph);
		expect(health.incrementalFallbacks).toBe(4);
		expect(
			health.notes.some((n) =>
				n.includes('incremental update(s) fell back to a full rebuild'),
			),
		).toBe(true);
	});

	test('non-truncated build reports walkTruncated false (A7)', async () => {
		fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
		fs.writeFileSync(path.join(tmp, 'src', 'a.ts'), 'export const a = 1;\n');
		const graph = await buildWorkspaceGraphAsync(tmp);
		expect(graph.diagnostics?.walkTruncated).toBe(false);
		const health = getGraphHealth(graph);
		expect(health.walkTruncated).toBe(false);
		expect(health.walkTruncationReason).toBeNull();
		expect(health.incrementalFallbacks).toBe(0);
	});
});
