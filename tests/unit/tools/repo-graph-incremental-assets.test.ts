/**
 * Regression test for issue #1985 defect A1: asset edges (e.g.
 * `import data from './data.json'`) must NOT permanently disable incremental
 * updates.
 *
 * Before the fix, one asset edge anywhere in the graph forced
 * `validationFailed = true` on every incremental update (the target is a real
 * file but never a graph node), causing a silent full-rebuild fallback on
 * every agent write. After the fix, asset edges are tagged `targetKind:
 * 'asset'` and only require their source node during validation, so an
 * unrelated file edit rescans only that file.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { clearCache } from '../../../src/tools/repo-graph';

// Dynamic import bypasses any mock.module from sibling test files (Bun's
// shared-runner mock isolation caveat — AGENTS.md invariant 7).
const getRealRepoGraph = async () => {
	const module = await import('../../../src/tools/repo-graph');
	return {
		buildWorkspaceGraph: module.buildWorkspaceGraph,
		buildWorkspaceGraphAsync: module.buildWorkspaceGraphAsync,
		loadGraph: module.loadGraph,
		saveGraph: module.saveGraph,
		updateGraphForFiles: module.updateGraphForFiles,
	};
};

describe('incremental updates with asset edges (A1)', () => {
	let tempDir: string;
	let workspacePath: string;

	/** Normalize a path to a graph key (forward slashes, matching normalizeGraphPath). */
	function normalizeKey(p: string): string {
		return path.normalize(p).replace(/\\/g, '/');
	}

	async function real() {
		const m = await getRealRepoGraph();
		return {
			buildWorkspaceGraph: m.buildWorkspaceGraph,
			buildWorkspaceGraphAsync: m.buildWorkspaceGraphAsync,
			loadGraph: m.loadGraph,
			saveGraph: m.saveGraph,
			updateGraphForFiles: m.updateGraphForFiles,
		};
	}

	beforeEach(async () => {
		tempDir = await fsSync.promises.mkdtemp(
			path.join(process.cwd(), 'rg-assets-test-'),
		);
		workspacePath = path.relative(process.cwd(), tempDir);
		await fsSync.promises.mkdir(path.join(tempDir, '.swarm'), {
			recursive: true,
		});
	});

	afterEach(async () => {
		clearCache(workspacePath);
		try {
			await fsSync.promises.rm(tempDir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});

	test('asset import no longer forces a full rebuild on an unrelated edit', async () => {
		const m = await real();
		// Workspace mirrors the issue's repro: main.ts imports a JSON asset and
		// a real helper.
		await fsSync.promises.mkdir(path.join(tempDir, 'src'));
		await fsSync.promises.writeFile(
			path.join(tempDir, 'src/data.json'),
			'{ "a": 1 }',
		);
		await fsSync.promises.writeFile(
			path.join(tempDir, 'src/main.ts'),
			[
				`import data from './data.json';`,
				`import { helper } from './helper';`,
				`export function main(): number { return helper() + (data as { a: number }).a; }`,
			].join('\n'),
		);
		await fsSync.promises.writeFile(
			path.join(tempDir, 'src/helper.ts'),
			'export function helper(): number { return 41; }\n',
		);

		// Initial full build.
		const initial = await m.buildWorkspaceGraphAsync(workspacePath);
		await m.saveGraph(workspacePath, initial);

		// The asset edge main.ts -> data.json must exist and be tagged 'asset'.
		const mainAbs = path.join(tempDir, 'src/main.ts');
		const dataAbs = path.join(tempDir, 'src/data.json');
		const assetEdge = initial.edges.find(
			(e) =>
				path.resolve(e.source) === mainAbs &&
				path.resolve(e.target) === dataAbs,
		);
		expect(assetEdge).toBeDefined();
		expect(assetEdge?.targetKind).toBe('asset');

		// The node edge main.ts -> helper.ts must be tagged 'node'.
		const helperAbs = path.join(tempDir, 'src/helper.ts');
		const nodeEdge = initial.edges.find(
			(e) =>
				path.resolve(e.source) === mainAbs &&
				path.resolve(e.target) === helperAbs,
		);
		expect(nodeEdge).toBeDefined();
		expect(nodeEdge?.targetKind).toBe('node');

		// Capture the initial helper.ts node identity so we can confirm the
		// incremental update re-scanned it (mtime changes) rather than
		// discarding it via a full rebuild. We assert "no fallback" two ways:
		//   1. the returned graph carries NO incrementalFallbacks counter bump
		//      (a fallback sets diagnostics.incrementalFallbacks >= 1);
		//   2. main.ts's asset edge survives intact (a full rebuild would also
		//      recreate it, so this is necessary-but-not-sufficient — paired
		//      with the counter it is decisive).
		const initialFallbacks =
			(initial.diagnostics?.incrementalFallbacks as number | undefined) ?? 0;

		// Edit helper.ts (unrelated to the JSON import).
		await fsSync.promises.writeFile(
			path.join(tempDir, 'src/helper.ts'),
			'export function helper(): number { return 42; }\nexport const NEW = 99;\n',
		);

		const updated = await m.updateGraphForFiles(workspacePath, [helperAbs]);

		// Decisive no-fallback assertion: the incrementalFallbacks counter did
		// not increase. A fallback path always bumps it by 1.
		const updatedFallbacks =
			(updated.diagnostics?.incrementalFallbacks as number | undefined) ?? 0;
		expect(updatedFallbacks).toBe(initialFallbacks);

		// The helper.ts node reflects the new edit (proves re-scan happened).
		const helperNode =
			updated.nodes[path.normalize(helperAbs).replace(/\\/g, '/')];
		expect(helperNode).toBeDefined();
		expect(helperNode?.exports).toContain('NEW');

		// The asset edge survived intact and is still tagged 'asset'.
		const updatedAssetEdge = updated.edges.find(
			(e) =>
				path.resolve(e.source) === mainAbs &&
				path.resolve(e.target) === dataAbs,
		);
		expect(updatedAssetEdge?.targetKind).toBe('asset');
	});

	test('asset targets are excluded from key_files in-degree and importers', async () => {
		const m = await real();
		await fsSync.promises.mkdir(path.join(tempDir, 'src'));
		await fsSync.promises.writeFile(
			path.join(tempDir, 'src/config.json'),
			'{ "v": 1 }',
		);
		// Three files import config.json (the asset) — without exclusion it
		// would dominate key_files by in-degree 3.
		for (const name of ['a.ts', 'b.ts', 'c.ts']) {
			await fsSync.promises.writeFile(
				path.join(tempDir, `src/${name}`),
				`import c from './config.json';\nimport { shared } from './shared';\nexport const x = shared;\n`,
			);
		}
		await fsSync.promises.writeFile(
			path.join(tempDir, 'src/shared.ts'),
			'export const shared = 1;\n',
		);

		const graph = await m.buildWorkspaceGraphAsync(workspacePath);
		await m.saveGraph(workspacePath, graph);

		const { getKeyFiles, getImporters } = await import(
			'../../../src/tools/repo-graph/query'
		);
		const key = getKeyFiles(graph, 10);
		const keyFiles = key.map((n) => n.moduleName);

		// config.json must NOT appear in key_files despite 3 importers.
		expect(keyFiles).not.toContain('src/config.json');

		// shared.ts (a real node imported by 3 files) SHOULD rank highly.
		expect(keyFiles).toContain('src/shared.ts');

		// getImporters of config.json returns [] (asset edges excluded).
		const importers = getImporters(graph, 'src/config.json');
		expect(importers.length).toBe(0);

		// getImporters of shared.ts returns the 3 consumers.
		const sharedImporters = getImporters(graph, 'src/shared.ts');
		expect(sharedImporters.length).toBe(3);
	});

	test('a genuine node-to-node orphan edge still triggers a full rebuild', async () => {
		// Guards against over-relaxing validation: relaxing the asset rule must
		// NOT also let a real node→node edge whose target genuinely disappeared
		// slip through. The fallback reconciles it via a full rebuild.
		const m = await real();
		await fsSync.promises.writeFile(
			path.join(tempDir, 'index.ts'),
			`import { foo } from './foo';\nexport const indexExport = 'hello';\n`,
		);
		await fsSync.promises.writeFile(
			path.join(tempDir, 'foo.ts'),
			`export const foo = 'foo';\n`,
		);

		const initial = await m.buildWorkspaceGraphAsync(workspacePath);
		await m.saveGraph(workspacePath, initial);

		// Corrupt the graph: add a node→node edge from foo.ts (a file we will
		// NOT touch) to a file that has no node. Re-scanning a different file
		// leaves this orphan in place, so validation must catch it.
		const loaded = await m.loadGraph(workspacePath);
		expect(loaded).not.toBeNull();
		loaded!.edges.push({
			source: path.join(tempDir, 'foo.ts'),
			target: path.join(tempDir, 'ghost.ts'),
			importSpecifier: './ghost',
			importType: 'named',
			targetKind: 'node',
		});
		await m.saveGraph(workspacePath, loaded!);

		// Trigger an incremental update on index.ts (NOT foo.ts). The orphan
		// node→node edge from foo.ts survives the re-scan and must force a
		// fallback (incrementalFallbacks bumps to 1).
		const updated = await m.updateGraphForFiles(workspacePath, [
			path.join(tempDir, 'index.ts'),
		]);
		const fallbacks =
			(updated.diagnostics?.incrementalFallbacks as number | undefined) ?? 0;
		expect(fallbacks).toBeGreaterThanOrEqual(1);
	});

	test('a rescan that returns node:null removes the stale node (review fix)', async () => {
		// If a previously-tracked source file becomes oversized/binary/
		// unreadable, scanFileAsync returns node:null. The stale node must be
		// removed so any incoming node→node edges are caught by validation and
		// trigger the fallback (rather than silently leaving an inconsistent
		// graph: stale node, removed outgoing edges).
		const m = await real();
		await fsSync.promises.writeFile(
			path.join(tempDir, 'a.ts'),
			`import { b } from './b';\nexport const a = b;\n`,
		);
		await fsSync.promises.writeFile(
			path.join(tempDir, 'b.ts'),
			`export const b = 1;\n`,
		);
		const initial = await m.buildWorkspaceGraphAsync(workspacePath);
		await m.saveGraph(workspacePath, initial);
		expect(
			initial.nodes[normalizeKey(path.join(tempDir, 'b.ts'))],
		).toBeDefined();

		// Make b.ts "binary" (null byte) so scanFileAsync returns node:null.
		await fsSync.promises.writeFile(
			path.join(tempDir, 'b.ts'),
			'binary\x00\x00content',
		);

		const updated = await m.updateGraphForFiles(workspacePath, [
			path.join(tempDir, 'b.ts'),
		]);

		// The stale b.ts node was removed (rescan returned null).
		expect(
			updated.nodes[normalizeKey(path.join(tempDir, 'b.ts'))],
		).toBeUndefined();
		// The incoming a.ts -> b.ts node edge now has a missing target, so a
		// fallback should have fired.
		const fallbacks =
			(updated.diagnostics?.incrementalFallbacks as number | undefined) ?? 0;
		expect(fallbacks).toBeGreaterThanOrEqual(1);
	});

	test('direct updateGraphForFiles on an unsupported extension does not create a node (review fix)', async () => {
		// updateGraphForFiles is a public entry point; a direct caller (not via
		// the write hook) passing a .css file must not inject an 'unknown'-
		// language node. isScannableSourcePath guards the incremental path.
		const m = await real();
		await fsSync.promises.writeFile(
			path.join(tempDir, 'a.ts'),
			`export const a = 1;\n`,
		);
		await fsSync.promises.writeFile(
			path.join(tempDir, 'style.css'),
			'.x { color: red; }\n',
		);
		const initial = await m.buildWorkspaceGraphAsync(workspacePath);
		await m.saveGraph(workspacePath, initial);

		await m.updateGraphForFiles(workspacePath, [
			path.join(tempDir, 'style.css'),
		]);
		const loaded = await m.loadGraph(workspacePath);
		const cssNode = Object.values(loaded!.nodes).find((n) =>
			n.filePath.endsWith('style.css'),
		);
		expect(cssNode).toBeUndefined();
	});
});
