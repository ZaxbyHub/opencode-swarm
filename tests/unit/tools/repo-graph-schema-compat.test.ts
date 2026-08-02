/**
 * Old-graph compatibility (issue #1985): a 1.2.0 graph whose edges carry no
 * `targetKind` must load and query correctly under the new 1.3.0 code. The
 * `isAssetEdge` helper falls back to an extension check on untagged edges, so
 * a pre-1.3.0 asset edge (e.g. `main.ts -> data.json`) is still classified as
 * an asset and excluded from query rankings.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	buildWorkspaceGraphAsync,
	clearCache,
	getCallers,
	getImporters,
	getKeyFiles,
	loadGraph,
	saveGraph,
} from '../../../src/tools/repo-graph';

describe('schema 1.2.0 graph compatibility (A1)', () => {
	let tmp: string;

	beforeEach(() => {
		tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rg-compat-')));
		fs.mkdirSync(path.join(tmp, '.swarm'), { recursive: true });
	});

	afterEach(() => {
		clearCache(tmp);
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	test('a 1.2.0 graph with an untagged asset edge loads and queries correctly', async () => {
		// Build a real 1.3.0 graph, then downgrade it to 1.2.0 shape (strip
		// targetKind, set schema_version) and write it to .swarm/repo-graph.json.
		fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
		fs.writeFileSync(path.join(tmp, 'src/data.json'), '{ "a": 1 }');
		fs.writeFileSync(
			path.join(tmp, 'src/main.ts'),
			"import data from './data.json';\nimport { helper } from './helper';\nexport const main = helper + data;\n",
		);
		fs.writeFileSync(
			path.join(tmp, 'src/helper.ts'),
			'export const helper = 1;\n',
		);

		const built = await buildWorkspaceGraphAsync(tmp);
		// Sanity: the modern graph tags the asset edge.
		const assetEdge = built.edges.find((e) => e.target.endsWith('data.json'));
		expect(assetEdge?.targetKind).toBe('asset');

		// Downgrade to 1.2.0 shape: strip targetKind, set version.
		const downgraded = {
			...built,
			schema_version: '1.2.0',
			edges: built.edges.map(({ targetKind: _t, ...rest }) => {
				void _t;
				return rest;
			}) as typeof built.edges,
		};
		await saveGraph(tmp, downgraded);
		clearCache(tmp);

		// Re-load and query — the untagged asset edge must still be treated as
		// an asset via the extension fallback.
		const loaded = await loadGraph(tmp);
		expect(loaded).not.toBeNull();
		if (!loaded) throw new Error('expected graph to load');
		expect(loaded.schema_version).toBe('1.2.0');

		// No edge in the loaded graph carries targetKind (proves it stayed 1.2.0).
		expect(
			loaded.edges.every(
				(e) => (e as { targetKind?: string }).targetKind === undefined,
			),
		).toBe(true);

		// data.json (asset) excluded from key_files and importers despite 1
		// untagged importer edge.
		const key = getKeyFiles(loaded, 10).map((n) => n.moduleName);
		expect(key).not.toContain('src/data.json');
		expect(getImporters(loaded, 'src/data.json')).toHaveLength(0);

		// helper.ts (a real node) is queryable.
		expect(getImporters(loaded, 'src/helper.ts').length).toBe(1);
		// getCallers on helper's 'helper' export resolves via the node edge.
		expect(getCallers(loaded, 'src/helper.ts', 'helper').length).toBe(1);
	});
});
