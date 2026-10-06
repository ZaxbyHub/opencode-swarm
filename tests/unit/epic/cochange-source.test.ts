/**
 * Tests for Epic mode's co-change pair source (HEAD-keyed in-memory cache).
 * File: tests/unit/epic/cochange-source.test.ts
 *
 * Covers:
 *  - Cache hit: same directory + same HEAD => analyzer not re-invoked.
 *  - Cache miss on HEAD change: analyzer re-invoked when HEAD differs.
 *  - Cache isolation across directories.
 *  - FIFO eviction at MAX_TRACKED_DIRS.
 *  - Signal-absent behavior: not a git repo / git error / empty commit map.
 *
 * Uses the `_internals` DI seam (no `mock.module`, per AGENTS.md invariant 7).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	_cacheSize,
	_clearCache,
	_internals,
	getCoChangeData,
	getCoChangePairs,
	peekCoChangeData,
} from '../../../src/epic/cochange-source';
import type { CoChangeEntry } from '../../../src/tools/co-change-analyzer';

const realInternals = { ..._internals };

function entry(fileA: string, fileB: string, npmi = 0.7): CoChangeEntry {
	const [a, b] = fileA < fileB ? [fileA, fileB] : [fileB, fileA];
	return {
		fileA: a,
		fileB: b,
		coChangeCount: 10,
		npmi,
		lift: 1,
		hasStaticEdge: false,
		totalCommits: 100,
		commitsA: 20,
		commitsB: 20,
	};
}

interface StubControls {
	heads: Map<string, string>; // directory -> head sha
	matrix: Map<string, CoChangeEntry>; // canonical "fileA::fileB" key -> entry
	execFileCalls: string[];
	parseGitLogCalls: string[];
	buildMatrixCalls: number;
	gitErrors: Set<string>; // directories where `git rev-parse HEAD` should throw
}

function install(stub: StubControls): void {
	_internals.execFile = (async (
		_cmd: string,
		_args: string[],
		opts: { cwd?: string } | undefined,
	) => {
		const dir = opts?.cwd ?? '<no-cwd>';
		stub.execFileCalls.push(dir);
		if (stub.gitErrors.has(dir)) {
			throw new Error(`simulated git error for ${dir}`);
		}
		const head = stub.heads.get(dir);
		if (head === undefined) {
			throw new Error(`simulated: no head configured for ${dir}`);
		}
		return { stdout: `${head}\n`, stderr: '' } as ReturnType<
			typeof realInternals.execFile
		> extends Promise<infer R>
			? R
			: never;
	}) as typeof _internals.execFile;

	_internals.parseGitLog = (async (dir: string, _max: number) => {
		stub.parseGitLogCalls.push(dir);
		// Return a one-element commit map so buildCoChangeMatrix has input.
		// The stubbed buildCoChangeMatrix below returns the canned matrix
		// regardless, so the exact commitMap shape does not matter.
		return new Map<string, Set<string>>([
			['fake-commit-sha', new Set<string>(['src/a.ts', 'src/b.ts'])],
		]);
	}) as typeof _internals.parseGitLog;

	_internals.buildCoChangeMatrix = ((_commits: Map<string, Set<string>>) => {
		stub.buildMatrixCalls += 1;
		return stub.matrix;
	}) as typeof _internals.buildCoChangeMatrix;
}

let stub: StubControls;

beforeEach(() => {
	_clearCache();
	stub = {
		heads: new Map(),
		matrix: new Map(),
		execFileCalls: [],
		parseGitLogCalls: [],
		buildMatrixCalls: 0,
		gitErrors: new Set(),
	};
	install(stub);
});

afterEach(() => {
	_clearCache();
	_internals.execFile = realInternals.execFile;
	_internals.parseGitLog = realInternals.parseGitLog;
	_internals.buildCoChangeMatrix = realInternals.buildCoChangeMatrix;
});

describe('getCoChangePairs — caching', () => {
	test('cache hit: two calls with same directory+HEAD invoke analyzer once', async () => {
		stub.heads.set('/repo', 'sha-1');
		stub.matrix.set('k', entry('src/a.ts', 'src/b.ts'));

		const r1 = await getCoChangePairs('/repo');
		const r2 = await getCoChangePairs('/repo');

		expect(r1).toEqual(r2);
		expect(r1).toHaveLength(1);
		// HEAD is re-read each call (cheap), but analyzer should run only once.
		expect(stub.parseGitLogCalls).toEqual(['/repo']);
		expect(stub.buildMatrixCalls).toBe(1);
		expect(stub.execFileCalls.length).toBe(2);
	});

	test('cache miss on HEAD change: analyzer re-invoked when HEAD differs', async () => {
		stub.heads.set('/repo', 'sha-1');
		stub.matrix.set('k', entry('src/a.ts', 'src/b.ts'));
		await getCoChangePairs('/repo');

		stub.heads.set('/repo', 'sha-2');
		stub.matrix.set('k2', entry('src/c.ts', 'src/d.ts'));
		const r2 = await getCoChangePairs('/repo');

		expect(stub.parseGitLogCalls).toEqual(['/repo', '/repo']);
		expect(stub.buildMatrixCalls).toBe(2);
		// Second call sees the new matrix entries.
		expect(r2.map((e) => `${e.fileA}::${e.fileB}`)).toContain(
			'src/c.ts::src/d.ts',
		);
	});

	test('cache isolation: different directories have independent entries', async () => {
		stub.heads.set('/repo1', 'sha-1');
		stub.heads.set('/repo2', 'sha-2');
		stub.matrix.set('k', entry('src/a.ts', 'src/b.ts'));

		await getCoChangePairs('/repo1');
		await getCoChangePairs('/repo2');
		await getCoChangePairs('/repo1'); // cache hit
		await getCoChangePairs('/repo2'); // cache hit

		expect(stub.parseGitLogCalls).toEqual(['/repo1', '/repo2']);
		expect(stub.buildMatrixCalls).toBe(2);
	});

	test('FIFO eviction at MAX_TRACKED_DIRS (=10): 11th directory evicts oldest', async () => {
		stub.matrix.set('k', entry('src/a.ts', 'src/b.ts'));
		for (let i = 0; i < 10; i++) {
			stub.heads.set(`/repo-${i}`, `sha-${i}`);
			await getCoChangePairs(`/repo-${i}`);
		}
		expect(_cacheSize()).toBe(10);

		// 11th directory triggers eviction of /repo-0 (oldest).
		stub.heads.set('/repo-10', 'sha-10');
		await getCoChangePairs('/repo-10');
		expect(_cacheSize()).toBe(10);

		// Calling /repo-0 again is now a cache miss (analyzer runs).
		const callsBefore = stub.parseGitLogCalls.length;
		await getCoChangePairs('/repo-0');
		expect(stub.parseGitLogCalls.length).toBe(callsBefore + 1);
	});
});

describe('getCoChangePairs — signal absent', () => {
	test('git rev-parse error => returns [] and does not invoke analyzer', async () => {
		stub.gitErrors.add('/no-git');

		const r = await getCoChangePairs('/no-git');

		expect(r).toEqual([]);
		expect(stub.parseGitLogCalls).toEqual([]);
		expect(stub.buildMatrixCalls).toBe(0);
	});

	test('empty stdout from git => returns [] (no HEAD, not a repo)', async () => {
		// Override execFile to return an empty string (the realistic
		// "git rev-parse outside a repo" failure mode that returns empty
		// rather than throwing under some shells).
		_internals.execFile = (async () =>
			({ stdout: '', stderr: '' }) as unknown) as typeof _internals.execFile;

		const r = await getCoChangePairs('/empty-head');

		expect(r).toEqual([]);
		expect(stub.parseGitLogCalls).toEqual([]);
	});

	test('empty matrix (greenfield) => returns []', async () => {
		stub.heads.set('/young-repo', 'sha-young');
		// matrix is empty (no co-change pairs yet)

		const r = await getCoChangePairs('/young-repo');

		expect(r).toEqual([]);
		// But analyzer still ran — we wanted to ask.
		expect(stub.parseGitLogCalls).toEqual(['/young-repo']);
		expect(stub.buildMatrixCalls).toBe(1);
	});
});

describe('peekCoChangeData — warm cache only (Epic v2 C7 save_plan seam)', () => {
	test('cold: null, and no git subprocess / analyzer run', () => {
		stub.heads.set('/repo', 'sha-1');
		expect(peekCoChangeData('/repo')).toBeNull();
		expect(stub.execFileCalls).toEqual([]);
		expect(stub.parseGitLogCalls).toEqual([]);
	});

	test('warm: the cached data, without re-reading HEAD', async () => {
		stub.heads.set('/repo', 'sha-1');
		stub.matrix.set('k', entry('src/a.ts', 'src/b.ts'));
		const fresh = await getCoChangeData('/repo');
		stub.execFileCalls.length = 0;
		// HEAD moved: peek still returns the (older) cached estimate.
		stub.heads.set('/repo', 'sha-2');
		expect(peekCoChangeData('/repo')).toEqual(fresh);
		expect(peekCoChangeData('/other')).toBeNull();
		expect(stub.execFileCalls).toEqual([]);
	});
});
