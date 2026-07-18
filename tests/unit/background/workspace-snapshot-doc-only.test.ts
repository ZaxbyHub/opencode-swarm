import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_internals,
	captureWorkspaceSnapshot,
	changedFilesSinceSnapshot,
	parsePorcelainPaths,
	resolveCurrentGitHead,
	resolvePrWorkflowRevisionDigest,
	resolvePrWorkflowRevisionDigestAsync,
} from '../../../src/background/workspace-snapshot';

function git(directory: string, args: string[]): void {
	const result = spawnSync('git', ['-C', directory, ...args], {
		cwd: directory,
		stdin: 'ignore',
		stdio: 'pipe',
		encoding: 'utf-8',
		timeout: 5_000,
		maxBuffer: 128 * 1024,
	});
	if (result.status !== 0) {
		throw new Error(
			result.stderr || result.stdout || `git ${args.join(' ')} failed`,
		);
	}
}

describe('task workspace change observation', () => {
	let directory: string;

	beforeEach(() => {
		directory = fs.mkdtempSync(path.join(os.tmpdir(), 'task-change-snapshot-'));
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

	test('parses tracked, untracked, and rename porcelain paths', () => {
		expect(
			parsePorcelainPaths(' M README.md\0?? docs/new.md\0R  new.md\0old.md\0'),
		).toEqual(['README.md', 'docs/new.md', 'new.md', 'old.md']);
		expect(parsePorcelainPaths('malformed\0')).toBeNull();
	});

	test('parses all supported porcelain-v2 snapshot record forms', () => {
		const hash = 'a'.repeat(40);
		expect(
			_internals.parsePorcelainV2Snapshot(
				[
					`# branch.oid ${hash}`,
					'# branch.head main',
					`1 .M N... 100644 100644 100644 ${hash} ${hash} tracked file.ts`,
					`2 R. N... 100644 100644 100644 ${hash} ${hash} R100 renamed file.ts`,
					'original file.ts',
					`u UU N... 100644 100644 100644 100644 ${hash} ${hash} ${hash} conflicted.ts`,
					'? untracked.ts',
				].join('\0'),
			),
		).toEqual({
			gitHead: hash,
			changedFiles: [
				'tracked file.ts',
				'renamed file.ts',
				'original file.ts',
				'conflicted.ts',
				'untracked.ts',
			],
		});
	});

	test('fails closed when the upstream ref changes during snapshot capture', () => {
		const originalSpawnSync = _internals.spawnSync;
		const headA = 'a'.repeat(40);
		const headB = 'b'.repeat(40);
		const porcelain = `# branch.oid ${headA}\0# branch.head main\0`;
		try {
			const responses = [headA, porcelain, headB];
			_internals.spawnSync = (() => ({
				status: 0,
				stdout: responses.shift() ?? '',
			})) as typeof _internals.spawnSync;
			expect(
				captureWorkspaceSnapshot(directory, {
					resolveCurrentPrHeadSha: true,
				}),
			).toMatchObject({ gitHead: headA, changedFiles: [], prHeadSha: null });

			const stableResponses = [headA, porcelain, headA];
			_internals.spawnSync = (() => ({
				status: 0,
				stdout: stableResponses.shift() ?? '',
			})) as typeof _internals.spawnSync;
			expect(
				captureWorkspaceSnapshot(directory, {
					resolveCurrentPrHeadSha: true,
				}),
			).toMatchObject({ gitHead: headA, changedFiles: [], prHeadSha: headA });
		} finally {
			_internals.spawnSync = originalSpawnSync;
		}
	});

	test('observes uncommitted and committed paths since the baseline', () => {
		const baseline = captureWorkspaceSnapshot(directory);
		expect(baseline.changedFiles).toEqual([]);

		fs.writeFileSync(path.join(directory, 'README.md'), '# docs\n');
		expect(changedFilesSinceSnapshot(directory, baseline)).toEqual([
			'README.md',
		]);

		git(directory, ['add', 'README.md']);
		git(directory, ['commit', '-m', 'docs: add readme']);
		expect(changedFilesSinceSnapshot(directory, baseline)).toEqual([
			'README.md',
		]);
	});

	test('keeps both paths of a porcelain-v2 rename in the atomic snapshot', () => {
		const baseline = captureWorkspaceSnapshot(directory);
		git(directory, ['mv', 'base.txt', 'renamed.txt']);
		expect(changedFilesSinceSnapshot(directory, baseline)).toEqual([
			'renamed.txt',
			'base.txt',
		]);
	});

	test('fails closed when the baseline is already dirty', () => {
		fs.writeFileSync(path.join(directory, 'src.ts'), 'export const x = 1;\n');
		const baseline = captureWorkspaceSnapshot(directory);
		fs.writeFileSync(path.join(directory, 'README.md'), '# docs\n');

		expect(changedFilesSinceSnapshot(directory, baseline)).toBeNull();
	});

	test('revision digest changes for same-path content edits', () => {
		const head = resolveCurrentGitHead(directory);
		expect(head).not.toBeNull();
		fs.writeFileSync(path.join(directory, 'base.txt'), 'first edit\n');
		const first = resolvePrWorkflowRevisionDigest(directory, head!);
		fs.writeFileSync(path.join(directory, 'base.txt'), 'second edit\n');
		const second = resolvePrWorkflowRevisionDigest(directory, head!);
		expect(first).not.toBeNull();
		expect(second).not.toBeNull();
		expect(second).not.toBe(first);
		git(directory, ['add', 'base.txt']);
		git(directory, ['commit', '-m', 'test: preserve reviewed content']);
		expect(resolvePrWorkflowRevisionDigest(directory, head!)).toBe(second);
	});

	test('async revision digest matches the bounded synchronous digest', async () => {
		const head = resolveCurrentGitHead(directory);
		expect(head).not.toBeNull();
		fs.writeFileSync(
			path.join(directory, 'base.txt'),
			Buffer.alloc(2 * 1024 * 1024, 'a'),
		);
		const synchronous = resolvePrWorkflowRevisionDigest(directory, head!);
		const asynchronous = await resolvePrWorkflowRevisionDigestAsync(
			directory,
			head!,
		);
		expect(asynchronous).toBe(synchronous);
	});

	test('async revision digest cooperatively yields across bounded file-read chunks', async () => {
		const head = resolveCurrentGitHead(directory);
		expect(head).not.toBeNull();
		fs.writeFileSync(
			path.join(directory, 'base.txt'),
			Buffer.alloc(2 * 1024 * 1024, 'b'),
		);
		const originalYield = _internals.yieldControl;
		let yieldCount = 0;
		_internals.yieldControl = async () => {
			yieldCount++;
		};
		try {
			expect(await resolvePrWorkflowRevisionDigestAsync(directory, head!)).toBe(
				resolvePrWorkflowRevisionDigest(directory, head!),
			);
			expect(yieldCount).toBeGreaterThanOrEqual(2);
		} finally {
			_internals.yieldControl = originalYield;
		}
	});

	test('does not treat unchanged pre-existing Markdown dirt as task output', () => {
		fs.writeFileSync(path.join(directory, 'README.md'), '# pre-existing\n');
		const baseline = captureWorkspaceSnapshot(directory);

		expect(changedFilesSinceSnapshot(directory, baseline)).toBeNull();
	});

	test('keeps tracked non-Markdown files under .swarm visible', () => {
		fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
		fs.writeFileSync(
			path.join(directory, '.swarm', 'payload.ts'),
			'export {};\n',
		);
		git(directory, ['add', '.swarm/payload.ts']);
		git(directory, ['commit', '-m', 'test: track swarm payload']);
		const baseline = captureWorkspaceSnapshot(directory);

		fs.writeFileSync(path.join(directory, 'README.md'), '# docs\n');
		fs.writeFileSync(
			path.join(directory, '.swarm', 'payload.ts'),
			'export const unsafe = true;\n',
		);
		expect(new Set(changedFilesSinceSnapshot(directory, baseline))).toEqual(
			new Set(['README.md', '.swarm/payload.ts']),
		);
	});
});
