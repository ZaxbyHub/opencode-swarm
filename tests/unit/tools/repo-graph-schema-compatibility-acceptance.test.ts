/** Acceptance coverage for issue #2489 / AC4. */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { loadDatabaseCtor } from '../../../src/db/sqlite-loader';
import { upsertNode } from '../../../src/tools/repo-graph/builder';
import { clearCache } from '../../../src/tools/repo-graph/cache';
import {
	closeAllRepoMemory,
	getRepoMemoryPath,
	queryNodeByFile as queryIndexedNodeByFile,
} from '../../../src/tools/repo-graph/indexed-storage';
import {
	getGraphPath,
	loadGraphSync,
	saveGraph,
} from '../../../src/tools/repo-graph/storage';
import { createEmptyGraph } from '../../../src/tools/repo-graph/types';
import { canonicalMkdtemp } from '../../../tests/helpers/tmpdir';

const workspaces: string[] = [];

afterEach(() => {
	closeAllRepoMemory();
	for (const workspace of workspaces) {
		clearCache(workspace);
		rmSync(workspace, { recursive: true, force: true });
	}
	workspaces.length = 0;
});

async function writeSchemaVersion(
	version: string,
	storage: 'json' | 'indexed',
): Promise<string> {
	const workspace = canonicalMkdtemp('repo-graph-schema-acceptance-');
	workspaces.push(workspace);
	// The explicit project marker lets the real workspace boundary validator
	// exercise the same path used by production graph loads.
	const marker = path.join(workspace, '.opencode');
	mkdirSync(marker, { recursive: true });
	if (storage === 'indexed') {
		writeFileSync(
			path.join(marker, 'opencode-swarm.json'),
			JSON.stringify({ repo_graph: { storage: 'indexed' } }),
			'utf8',
		);
	}
	const graph = createEmptyGraph(workspace);
	upsertNode(graph, {
		filePath: path.join(workspace, 'src', 'a.ts'),
		moduleName: 'src/a.ts',
		exports: [],
		imports: [],
		language: 'typescript',
		mtime: new Date(0).toISOString(),
	});
	await saveGraph(workspace, graph);

	if (storage === 'indexed') {
		// Close the production handle before opening a second real SQLite
		// connection to mutate only the derived metadata. The source JSON remains
		// fresh, so this reaches openFreshIndex rather than a stale-index fallback.
		closeAllRepoMemory();
		const Db = loadDatabaseCtor();
		const db = new Db(getRepoMemoryPath(workspace));
		try {
			db.run('UPDATE graph_meta SET value = ? WHERE key = ?', [
				version,
				'graph_schema_version',
			]);
		} finally {
			db.close();
		}
	} else {
		const graphPath = getGraphPath(workspace);
		const persisted = JSON.parse(readFileSync(graphPath, 'utf8')) as Record<
			string,
			unknown
		>;
		persisted.schema_version = version;
		writeFileSync(graphPath, `${JSON.stringify(persisted)}\n`, 'utf8');
		clearCache(workspace);
	}
	return workspace;
}

describe('issue #2489 AC4 — persisted graph schema compatibility', () => {
	test('rejects malformed schema versions before trusting persisted nodes', async () => {
		const workspace = await writeSchemaVersion('not-a-semver', 'json');
		expect(() => loadGraphSync(workspace)).toThrow(
			/schema|version|corrupt|invalid/i,
		);

		const indexed = await writeSchemaVersion('not-a-semver', 'indexed');
		expect(queryIndexedNodeByFile(indexed, 'src/a.ts')).toBeNull();
	});

	test('rejects a future graph schema version instead of silently loading it', async () => {
		const workspace = await writeSchemaVersion('999.0.0', 'json');
		expect(() => loadGraphSync(workspace)).toThrow(
			/schema|version|supported|rebuild|corrupt/i,
		);

		const indexed = await writeSchemaVersion('999.0.0', 'indexed');
		expect(queryIndexedNodeByFile(indexed, 'src/a.ts')).toBeNull();
	});

	test('preserves a supported older schema version at both load boundaries', async () => {
		const json = await writeSchemaVersion('1.2.0', 'json');
		expect(loadGraphSync(json)?.schema_version).toBe('1.2.0');

		const indexed = await writeSchemaVersion('1.2.0', 'indexed');
		expect(queryIndexedNodeByFile(indexed, 'src/a.ts')).not.toBeNull();
	});
});
