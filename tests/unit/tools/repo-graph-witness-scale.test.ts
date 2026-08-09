import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
	buildWorkspaceGraphAsync,
	clearCache,
	invalidateFreshnessCache,
	loadGraph,
	probeFreshness,
	saveGraph,
	updateGraphForFiles,
	writeFingerprint,
} from '../../../src/tools/repo-graph';

const roots: string[] = [];

async function workspace(): Promise<string> {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), 'repo-graph-witness-scale-'),
	);
	roots.push(root);
	return root;
}

afterEach(async () => {
	invalidateFreshnessCache();
	for (const root of roots.splice(0)) {
		clearCache(root);
		await fs.rm(root, { recursive: true, force: true });
	}
});

describe('repo graph correctness witnesses above the display cap', () => {
	test('certifies 201 stable skips even though display diagnostics stop at 200', async () => {
		const root = await workspace();
		for (let index = 0; index < 201; index++) {
			await fs.writeFile(
				path.join(root, `oversized-${index}.ts`),
				'export const oversized = true;\n',
			);
		}

		const graph = await buildWorkspaceGraphAsync(root, {
			maxFileSizeBytes: 1,
		});
		expect(graph.diagnostics?.oversizedFiles).toHaveLength(200);
		expect(
			graph.diagnostics?.extractorInputWitnesses?.filter(
				(entry) => entry.kind === 'stable-skip',
			),
		).toHaveLength(201);
		await saveGraph(root, graph);
		expect(await writeFingerprint(root, graph)).toBe(true);
		expect((await probeFreshness(root)).state).toBe('clean');
	});

	test('retains and certifies 201 manifests after a small incremental refresh', async () => {
		const root = await workspace();
		for (let index = 0; index < 201; index++) {
			const directory = path.join(root, 'packages', `p${index}`);
			await fs.mkdir(directory, { recursive: true });
			await fs.writeFile(
				path.join(directory, 'package.json'),
				`{"name":"p${index}"}\n`,
			);
		}
		const source = path.join(root, 'source.ts');
		await fs.writeFile(source, 'export const value = 1;\n');

		const graph = await buildWorkspaceGraphAsync(root);
		await saveGraph(root, graph);
		expect(await writeFingerprint(root, graph)).toBe(true);
		await fs.writeFile(source, 'export const value = 2;\n');

		await updateGraphForFiles(root, [source]);
		const updated = await loadGraph(root);
		expect(
			updated?.diagnostics?.extractorInputWitnesses?.filter(
				(entry) => entry.kind === 'manifest',
			),
		).toHaveLength(201);
		expect((await probeFreshness(root)).state).toBe('clean');
	});
});
