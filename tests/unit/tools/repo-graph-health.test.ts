import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
	buildWorkspaceGraphAsync,
	clearCache,
	createEmptyGraph,
	getGraphHealth,
	loadGraph,
	type RepoGraph,
	saveGraph,
} from '../../../src/tools/repo-graph';
import { _internals as builderInternals } from '../../../src/tools/repo-graph/builder';

describe('repo graph health diagnostics', () => {
	let tmp: string;
	let originalExtractFileSymbols: typeof builderInternals.extractFileSymbols;

	beforeEach(() => {
		// realpathSync resolves the macOS /var → /private/var symlink (and Windows
		// 8.3 short names) so the canonical workspace root matches what production
		// code compares against. Issue #1729 macOS quarantine.
		tmp = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'repo-graph-health-')),
		);
		originalExtractFileSymbols = builderInternals.extractFileSymbols;
	});

	afterEach(() => {
		builderInternals.extractFileSymbols = originalExtractFileSymbols;
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
		expect(health.lowConfidenceEdgeCount).toBe(3);
		expect(health.notes).toContain('1 binary files skipped during last build.');
		expect(health.notes).toContain(
			'1 unreadable files skipped during last build.',
		);
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
});
