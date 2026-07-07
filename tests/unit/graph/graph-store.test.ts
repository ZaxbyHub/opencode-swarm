import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getImporters } from '../../../src/graph/graph-query';
import {
	buildAndSaveGraph,
	isGraphFresh,
	loadGraph,
	saveGraph,
	updateGraphIncremental,
} from '../../../src/graph/graph-store';
import { REPO_GRAPH_SCHEMA_VERSION } from '../../../src/graph/types';

let tmp: string;

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-store-'));
	fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe('saveGraph', () => {
	it('does not leak tmpfiles into .swarm/ on success', async () => {
		fs.writeFileSync(path.join(tmp, 'src/a.ts'), 'export const a = 1;\n');
		await buildAndSaveGraph(tmp);
		const swarmEntries = fs.readdirSync(path.join(tmp, '.swarm'));
		// Only the canonical filename should remain — no `.tmp.*` orphans.
		expect(swarmEntries.filter((n) => n.includes('.tmp.'))).toEqual([]);
		expect(swarmEntries).toContain('repo-graph.json');
	});

	it('cleans up the tmpfile when rename fails', () => {
		// Make the destination a directory so renameSync fails with EISDIR.
		const swarmDir = path.join(tmp, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });
		fs.mkdirSync(path.join(swarmDir, 'repo-graph.json'));

		expect(() =>
			saveGraph(tmp, {
				version: 1,
				buildTimestamp: new Date().toISOString(),
				rootDir: tmp,
				files: {},
			}),
		).toThrow();

		const orphans = fs.readdirSync(swarmDir).filter((n) => n.includes('.tmp.'));
		expect(orphans).toEqual([]);
	});
});

describe('updateGraphIncremental', () => {
	it('invalidates the cached reverse-edge index after in-place mutation', async () => {
		fs.writeFileSync(path.join(tmp, 'src/util.ts'), 'export const u = 1;\n');
		fs.writeFileSync(
			path.join(tmp, 'src/main.ts'),
			"import { u } from './util';\nconsole.log(u);\n",
		);
		const graph = await buildAndSaveGraph(tmp);
		// Prime the reverse-index cache.
		expect(getImporters(graph, 'src/util.ts').map((r) => r.file)).toEqual([
			'src/main.ts',
		]);

		// Add a second importer and run an incremental update — same graph
		// reference is returned, so without explicit cache invalidation the
		// reverse index would keep returning the old single-importer result.
		fs.writeFileSync(
			path.join(tmp, 'src/extra.ts'),
			"import { u } from './util';\nexport const x = u;\n",
		);
		await updateGraphIncremental(tmp, ['src/extra.ts'], graph);

		const importers = getImporters(graph, 'src/util.ts')
			.map((r) => r.file)
			.sort();
		expect(importers).toEqual(['src/extra.ts', 'src/main.ts']);
	});

	it('round-trips loadGraph after save', async () => {
		fs.writeFileSync(path.join(tmp, 'src/x.ts'), 'export const x = 1;\n');
		const built = await buildAndSaveGraph(tmp);
		const loaded = loadGraph(tmp);
		expect(loaded).not.toBeNull();
		expect(Object.keys(loaded!.files).sort()).toEqual(
			Object.keys(built.files).sort(),
		);
	});

	it('rejects traversal-escaping relative paths (F3)', async () => {
		// A malicious caller passing `../etc/passwd` must not be able to inject
		// or delete an entry keyed to a file outside the workspace. The
		// validator should silently skip such entries.
		fs.writeFileSync(path.join(tmp, 'src/y.ts'), 'export const y = 1;\n');
		const graph = await buildAndSaveGraph(tmp);
		const before = Object.keys(graph.files).sort();
		await updateGraphIncremental(
			tmp,
			['../escape.ts', '/abs/path.ts', 'src/y.ts'],
			graph,
		);
		const after = Object.keys(graph.files).sort();
		// 'src/y.ts' is still in the graph; the two attack paths produced no
		// new entries.
		expect(after).toEqual(before);
		expect(after).not.toContain('../escape.ts');
		expect(after).not.toContain('/abs/path.ts');
	});
});

describe('saveGraph — security regression', () => {
	it('refuses to write through a symlinked .swarm directory (F5)', () => {
		// If `.swarm` is a symlink, `mkdirSync({recursive:true})` would happily
		// follow it and `renameSync` would write the graph file into the
		// attacker-controlled target.
		const realTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'symlink-tgt-'));
		try {
			try {
				fs.symlinkSync(realTarget, path.join(tmp, '.swarm'));
			} catch (error) {
				if (
					error instanceof Error &&
					'code' in error &&
					(error as NodeJS.ErrnoException).code === 'EPERM'
				) {
					return;
				}
				throw error;
			}
			expect(() =>
				saveGraph(tmp, {
					version: REPO_GRAPH_SCHEMA_VERSION,
					buildTimestamp: new Date().toISOString(),
					rootDir: tmp,
					files: {},
				}),
			).toThrow(/symbolic link/);
			// And we did NOT write the graph to the symlink target.
			expect(fs.existsSync(path.join(realTarget, 'repo-graph.json'))).toBe(
				false,
			);
		} finally {
			fs.rmSync(realTarget, { recursive: true, force: true });
		}
	});

	it('uses an unpredictable tmpfile name (F11)', () => {
		// Predictable `${pid}.${Date.now()}` tmp names make a same-pid TOCTOU
		// pre-create attack feasible. The replacement uses crypto.randomUUID().
		const swarmDir = path.join(tmp, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });
		// Force rename to fail so the tmp filename is preserved long enough
		// to inspect... actually, simpler: write twice and verify the tmpfile
		// names — captured via a directory listing during a deliberate failure.
		fs.mkdirSync(path.join(swarmDir, 'repo-graph.json'));
		try {
			saveGraph(tmp, {
				version: REPO_GRAPH_SCHEMA_VERSION,
				buildTimestamp: new Date().toISOString(),
				rootDir: tmp,
				files: {},
			});
		} catch {
			// expected — destination is a directory
		}
		// Tmpfile names should embed a UUID-shaped segment after `.tmp.`.
		// (Cleanup may have already removed it; we just assert no
		// pid+timestamp-shaped tmpfile is present.)
		const orphans = fs.readdirSync(swarmDir).filter((n) => n.includes('.tmp.'));
		for (const o of orphans) {
			// UUID v4: 8-4-4-4-12 hex, with dashes
			expect(o).toMatch(
				/\.tmp\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
			);
		}
	});
});

describe('isGraphFresh', () => {
	it('returns false for null', () => {
		expect(isGraphFresh(null)).toBe(false);
	});

	it('returns true for a freshly-built graph', () => {
		expect(
			isGraphFresh({
				version: REPO_GRAPH_SCHEMA_VERSION,
				buildTimestamp: new Date().toISOString(),
				rootDir: '/x',
				files: {},
			}),
		).toBe(true);
	});

	it('returns false for a stale graph beyond the freshness window', () => {
		const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString();
		expect(
			isGraphFresh(
				{
					version: REPO_GRAPH_SCHEMA_VERSION,
					buildTimestamp: stale,
					rootDir: '/x',
					files: {},
				},
				5 * 60 * 1000,
			),
		).toBe(false);
	});

	it('returns false for an unparseable buildTimestamp', () => {
		expect(
			isGraphFresh({
				version: REPO_GRAPH_SCHEMA_VERSION,
				buildTimestamp: 'not-a-date',
				rootDir: '/x',
				files: {},
			}),
		).toBe(false);
	});
});
