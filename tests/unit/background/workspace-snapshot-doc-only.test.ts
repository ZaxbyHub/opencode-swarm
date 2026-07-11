import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	captureWorkspaceSnapshot,
	changedFilesSinceSnapshot,
	parsePorcelainPaths,
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

	test('fails closed when the baseline is already dirty', () => {
		fs.writeFileSync(path.join(directory, 'src.ts'), 'export const x = 1;\n');
		const baseline = captureWorkspaceSnapshot(directory);
		fs.writeFileSync(path.join(directory, 'README.md'), '# docs\n');

		expect(changedFilesSinceSnapshot(directory, baseline)).toBeNull();
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
