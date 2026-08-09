import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildWorkspaceGraph } from '../../../src/tools/repo-graph/builder';
import {
	_internals,
	invalidateFreshnessCache,
	probeFreshness,
	REPO_GRAPH_FINGERPRINT_FILENAME,
	writeFingerprint,
} from '../../../src/tools/repo-graph/freshness';

const realNow = _internals.now;
const realWalk = _internals.walkRepoGraphInputs;
const realRename = _internals.fsRename;
const realUnlink = _internals.fsUnlink;
const realRetryDelayMs = _internals.retryDelayMs;
const roots: string[] = [];

function workspace(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-freshness-'));
	roots.push(root);
	return root;
}

function source(
	root: string,
	name = 'src/a.ts',
	content = 'export const a = 1;\n',
) {
	const target = path.join(root, name);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, content);
	return target;
}

afterEach(() => {
	_internals.now = realNow;
	_internals.walkRepoGraphInputs = realWalk;
	_internals.fsRename = realRename;
	_internals.fsUnlink = realUnlink;
	_internals.retryDelayMs = realRetryDelayMs;
	invalidateFreshnessCache();
	for (const root of roots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

describe('repo graph freshness sidecar', () => {
	test('reports clean, changed, added, removed, and graph-wide manifest drift', async () => {
		const root = workspace();
		const a = source(root);
		const manifest = source(root, 'package.json', '{"name":"fixture"}\n');
		const graph = buildWorkspaceGraph(root);
		expect(await writeFingerprint(root, graph)).toBe(true);
		expect((await probeFreshness(root)).state).toBe('clean');

		fs.appendFileSync(a, '// changed\n');
		const added = source(root, 'src/b.ts', 'export const b = 2;\n');
		fs.rmSync(manifest);
		invalidateFreshnessCache(root);
		const drift = await probeFreshness(root);
		expect(drift.state).toBe('drifted');
		expect(drift.changed).toEqual(
			[a, added].sort((x, y) => x.localeCompare(y)),
		);
		expect(drift.removed).toEqual([manifest]);
	});

	test('missing, malformed, and exclusion-policy mismatches are no-fingerprint', async () => {
		const root = workspace();
		source(root);
		expect((await probeFreshness(root)).state).toBe('no-fingerprint');

		const graph = buildWorkspaceGraph(root);
		expect(
			await writeFingerprint(root, graph, { excludeDirs: ['generated'] }),
		).toBe(true);
		expect((await probeFreshness(root)).state).toBe('no-fingerprint');

		fs.writeFileSync(
			path.join(root, '.swarm', REPO_GRAPH_FINGERPRINT_FILENAME),
			'{broken',
		);
		invalidateFreshnessCache(root);
		expect((await probeFreshness(root)).state).toBe('no-fingerprint');
	});

	test('incomplete walks expose positive changes but never infer removals', async () => {
		const root = workspace();
		const a = source(root);
		const removed = source(root, 'src/removed.ts');
		const graph = buildWorkspaceGraph(root);
		expect(await writeFingerprint(root, graph)).toBe(true);
		fs.rmSync(removed);

		const stats = fs.statSync(a);
		_internals.walkRepoGraphInputs = async () => ({
			sourceFiles: [a],
			manifestFiles: [],
			metadata: [
				{
					absolutePath: a,
					kind: 'source',
					sizeBytes: stats.size + 1,
					mtimeMs: stats.mtimeMs,
				},
			],
			manifestDirs: new Set(),
			truncated: true,
			truncationReason: 'budget',
			incomplete: true,
			unreadableDirectories: [],
			unreadableFiles: [],
			probedFiles: 1,
			elapsedMs: 5,
		});
		invalidateFreshnessCache(root);
		const result = await probeFreshness(root);
		expect(result.state).toBe('inconclusive');
		expect(result.changed).toEqual([a]);
		expect(result.removed).toEqual([]);
		expect(result.truncated).toBe(true);
	});

	test('coalesces concurrent probes and expires cached results after 30 seconds', async () => {
		const root = workspace();
		source(root);
		const graph = buildWorkspaceGraph(root);
		expect(await writeFingerprint(root, graph)).toBe(true);

		let now = 100;
		let walks = 0;
		_internals.now = () => now;
		_internals.walkRepoGraphInputs = async (...args) => {
			walks++;
			await Promise.resolve();
			return realWalk(...args);
		};
		invalidateFreshnessCache(root);
		await Promise.all([
			probeFreshness(root),
			probeFreshness(root),
			probeFreshness(root),
		]);
		expect(walks).toBe(1);
		await probeFreshness(root);
		expect(walks).toBe(1);
		now += 30_001;
		await probeFreshness(root);
		expect(walks).toBe(2);
	});

	test('evicts the least-recently-used project after 16 cached roots', async () => {
		const projects = Array.from({ length: 17 }, () => workspace());
		for (const root of projects) {
			expect(await writeFingerprint(root, buildWorkspaceGraph(root))).toBe(
				true,
			);
		}

		const walks = new Map<string, number>();
		_internals.walkRepoGraphInputs = async (root, options) => {
			walks.set(root, (walks.get(root) ?? 0) + 1);
			return realWalk(root, options);
		};
		invalidateFreshnessCache();
		for (const root of projects.slice(0, 16)) await probeFreshness(root);
		await probeFreshness(projects[0]); // refresh root 0's LRU position
		await probeFreshness(projects[16]); // evicts root 1
		await probeFreshness(projects[0]);
		await probeFreshness(projects[1]);
		expect(walks.get(projects[0])).toBe(1);
		expect(walks.get(projects[1])).toBe(2);
	});

	test('retries transient Windows-style atomic rename failures', async () => {
		const root = workspace();
		source(root);
		const graph = buildWorkspaceGraph(root);
		let attempts = 0;
		_internals.retryDelayMs = 0;
		_internals.fsRename = async (...args) => {
			attempts++;
			if (attempts < 3) {
				throw Object.assign(new Error('locked by scanner'), { code: 'EPERM' });
			}
			return realRename(...args);
		};
		expect(await writeFingerprint(root, graph)).toBe(true);
		expect(attempts).toBe(3);
		expect((await probeFreshness(root)).state).toBe('clean');
	});

	test('bounds exhausted atomic rename retries and fails without a partial sidecar', async () => {
		const root = workspace();
		source(root);
		const graph = buildWorkspaceGraph(root);
		let attempts = 0;
		_internals.retryDelayMs = 0;
		_internals.fsRename = async () => {
			attempts++;
			throw Object.assign(new Error('still locked'), { code: 'EBUSY' });
		};
		expect(await writeFingerprint(root, graph)).toBe(false);
		expect(attempts).toBe(5);
		const files = fs.readdirSync(path.join(root, '.swarm'));
		expect(files.some((file) => file.includes('repo-graph.fingerprint'))).toBe(
			false,
		);
	});

	test('persists a truncated positive prefix that probes as inconclusive', async () => {
		const root = workspace();
		source(root, 'src/a.ts');
		source(root, 'src/b.ts');
		const options = { maxFiles: 1 };
		const graph = buildWorkspaceGraph(root, options);
		expect(graph.diagnostics?.walkTruncated).toBe(true);
		expect(await writeFingerprint(root, graph, options)).toBe(true);
		const probe = await probeFreshness(root, options);
		expect(probe.state).toBe('inconclusive');
		expect(probe.removed).toEqual([]);
		expect(probe.truncated).toBe(true);
	});
});
