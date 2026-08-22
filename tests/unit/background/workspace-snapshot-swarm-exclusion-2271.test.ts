import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	captureWorkspaceSnapshot,
	changedFilesSinceSnapshot,
	isSwarmRuntimePath,
	parsePorcelainV2Snapshot,
	workspaceSnapshotMatches,
} from '../../../src/background/workspace-snapshot';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

function git(directory: string, args: string[]): void {
	const result = spawnSync('git', ['-C', directory, ...args], {
		cwd: directory,
		stdin: 'ignore',
		stdio: 'pipe',
		encoding: 'utf-8',
		timeout: 10_000,
		maxBuffer: 1024 * 1024,
	});
	if (result.status !== 0) {
		throw new Error(
			result.stderr || result.stdout || `git ${args.join(' ')} failed`,
		);
	}
}

describe('issue #2271 bug 2 — .swarm/ runtime paths never poison settlement snapshots', () => {
	let directory: string;

	beforeEach(() => {
		directory = canonicalMkdtemp('swarm-exclusion-2271-');
		git(directory, ['init']);
		git(directory, ['config', 'user.email', 'tests@example.com']);
		git(directory, ['config', 'user.name', 'Tests']);
		fs.writeFileSync(path.join(directory, 'base.txt'), 'base\n');
		git(directory, ['add', 'base.txt']);
		git(directory, ['commit', '-m', 'test: seed repository']);
	});

	afterEach(() => {
		fs.rmSync(directory, { recursive: true, force: true });
	});

	test('isSwarmRuntimePath matches .swarm data files but not code hidden under it', () => {
		expect(isSwarmRuntimePath('.swarm')).toBe(true);
		expect(isSwarmRuntimePath('.swarm/telemetry.jsonl')).toBe(true);
		expect(isSwarmRuntimePath('.swarm/session/state.json')).toBe(true);
		expect(isSwarmRuntimePath('.swarm/evidence/run/evidence.json')).toBe(true);
		expect(isSwarmRuntimePath('.swarm/lanes/1.env')).toBe(true);
		expect(isSwarmRuntimePath('.swarm/extensionless-blob')).toBe(true);
		// Anti-evasion contract (workspace-snapshot-doc-only): source code
		// under .swarm/ is NOT plugin runtime state and stays visible.
		expect(isSwarmRuntimePath('.swarm/payload.ts')).toBe(false);
		expect(isSwarmRuntimePath('.swarm/payload.py')).toBe(false);
		expect(isSwarmRuntimePath('.swarm-ish/config.json')).toBe(false);
		expect(isSwarmRuntimePath('src/.swarm/nested.ts')).toBe(false);
		expect(isSwarmRuntimePath('swarm/telemetry.jsonl')).toBe(false);
		expect(isSwarmRuntimePath('')).toBe(false);
	});

	test('untracked .swarm/ churn is invisible in changedFiles and dirtyHash', () => {
		fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
		fs.writeFileSync(
			path.join(directory, '.swarm', 'telemetry.jsonl'),
			'{"v":1}\n',
		);
		const first = captureWorkspaceSnapshot(directory);
		expect(first.gitHead).not.toBeNull();
		expect(first.changedFiles).toEqual([]);

		// More plugin runtime writes must NOT change the dirty hash (Stage B
		// freshness compares expected vs current dirtyHash).
		fs.writeFileSync(
			path.join(directory, '.swarm', 'session-state.json'),
			'{"v":2}\n',
		);
		const second = captureWorkspaceSnapshot(directory);
		expect(workspaceSnapshotMatches(first, second)).toEqual({ ok: true });
	});

	test('tracked .swarm/ dirt is invisible while real source dirt remains visible', () => {
		fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
		fs.writeFileSync(path.join(directory, '.swarm', 'events.jsonl'), 'x\n');
		git(directory, ['add', '.swarm']);
		git(directory, ['commit', '-m', 'test: track .swarm runtime state']);
		// Plugin rewrites the tracked file (the reported bug 2 scenario).
		fs.writeFileSync(path.join(directory, '.swarm', 'events.jsonl'), 'y\n');

		const trackedDirtOnly = captureWorkspaceSnapshot(directory);
		expect(trackedDirtOnly.changedFiles).toEqual([]);

		fs.writeFileSync(path.join(directory, 'base.txt'), 'changed\n');
		const withRealDirt = captureWorkspaceSnapshot(directory);
		expect(withRealDirt.changedFiles).toEqual(['base.txt']);
	});

	test('parsePorcelainV2Snapshot stays UNFILTERED for the shared PR-workflow consumer', () => {
		// classifyPrWorkflowGitState feeds this parser RAW porcelain and relies
		// on .swarm entries surviving to fail closed (SWARM_STATE_TRACKING_ERROR).
		// Settlement immunity is applied upstream in captureWorkspaceSnapshot.
		const hash = 'a'.repeat(40);
		const headers = `# branch.oid ${hash}\0# branch.head main\0`;
		const records =
			'1 .N... 000000 000000 100644 100644 0000000000000000000000000000000000000000 0000000000000000000000000000000000000000 .swarm/tracked.json\0' +
			'1 .N... 000000 000000 100644 100644 0000000000000000000000000000000000000000 0000000000000000000000000000000000000000 src/real.ts\0' +
			'? .swarm/untracked.jsonl\0' +
			'? docs/new.md\0';
		const snapshot = parsePorcelainV2Snapshot(headers + records);
		expect(snapshot).not.toBeNull();
		expect(snapshot?.dirtyTrackedPaths).toEqual([
			'.swarm/tracked.json',
			'src/real.ts',
		]);
		expect(snapshot?.untrackedPaths).toEqual([
			'.swarm/untracked.jsonl',
			'docs/new.md',
		]);
	});

	test('changedFilesSinceSnapshot: .swarm-only dirty baseline attributes real changes', () => {
		// Legacy baseline (pre-fix plugin or hand-built WAL) that carries .swarm
		// dirt: attribution must proceed instead of failing closed.
		const clean = captureWorkspaceSnapshot(directory);
		const baseline = {
			...clean,
			changedFiles: ['.swarm/telemetry.jsonl', '.swarm/evidence/x.json'],
		};
		fs.writeFileSync(path.join(directory, 'src-real.ts'), 'export {};\n');
		const observed = changedFilesSinceSnapshot(directory, baseline);
		expect(observed).toEqual(['src-real.ts']);
	});

	test('changedFilesSinceSnapshot: non-.swarm dirty baseline still fails closed', () => {
		const clean = captureWorkspaceSnapshot(directory);
		const baseline = { ...clean, changedFiles: ['README.md'] };
		fs.writeFileSync(path.join(directory, 'src-real.ts'), 'export {};\n');
		expect(changedFilesSinceSnapshot(directory, baseline)).toBeNull();
	});

	test('coder change under .swarm/ data paths is never attributed as task output', () => {
		const baseline = captureWorkspaceSnapshot(directory);
		// With the filter, an (impossible-by-scope, but defense-in-depth)
		// .swarm runtime write does not appear as observed output…
		fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
		fs.writeFileSync(path.join(directory, '.swarm', 'rogue.json'), '{}\n');
		expect(changedFilesSinceSnapshot(directory, baseline)).toEqual([]);
	});

	test('source code hidden under .swarm/ stays visible (anti-evasion regression)', () => {
		const baseline = captureWorkspaceSnapshot(directory);
		fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
		fs.writeFileSync(
			path.join(directory, '.swarm', 'payload.ts'),
			'export const unsafe = true;\n',
		);
		expect(changedFilesSinceSnapshot(directory, baseline)).toEqual([
			'.swarm/payload.ts',
		]);
	});

	test('a tracked .swarm data file renamed into source attributes only the destination', () => {
		// Exercises filterSwarmRuntimePorcelain's rename branch directly: the
		// '2 ' record's primary path is project source, its paired original
		// path is .swarm — the filter must keep the record, replace the .swarm
		// original with the primary path (so the parser still sees a valid
		// pair), and no .swarm string may survive into digest or path arrays.
		fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
		fs.mkdirSync(path.join(directory, 'src'), { recursive: true });
		fs.writeFileSync(path.join(directory, '.swarm', 'legacy.json'), '{}\n');
		git(directory, ['add', '.swarm/legacy.json']);
		git(directory, ['commit', '-m', 'test: track legacy runtime file']);
		const baseline = captureWorkspaceSnapshot(directory);
		git(directory, ['mv', '.swarm/legacy.json', 'src/legacy.json']);

		const snapshot = captureWorkspaceSnapshot(directory);
		expect(snapshot.changedFiles).toEqual(['src/legacy.json']);
		expect(snapshot.dirtyHash).not.toBeNull();
		// Attribution through the filter observes only the destination.
		expect(changedFilesSinceSnapshot(directory, baseline)).toEqual([
			'src/legacy.json',
		]);
	});
});
