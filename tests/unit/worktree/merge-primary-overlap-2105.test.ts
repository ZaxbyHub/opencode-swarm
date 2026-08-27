import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BunCompatSubprocess } from '../../../src/utils/bun-compat';
import {
	_internals,
	attemptMergeBackFromDirty,
} from '../../../src/worktree/merge';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const GIT_TIMEOUT_MS = 20_000;
const GIT_MAX_BUFFER = 1024 * 1024;
const tempRoots: string[] = [];
const realBunSpawn = _internals.bunSpawn;
const realPlatform = _internals.platform;

interface LaneFixture {
	root: string;
	worktreePath: string;
	branchName: string;
}

function git(cwd: string, ...args: string[]): string {
	return execFileSync('git', args, {
		cwd,
		encoding: 'utf8',
		timeout: GIT_TIMEOUT_MS,
		maxBuffer: GIT_MAX_BUFFER,
		stdio: ['ignore', 'pipe', 'pipe'],
	}).trim();
}

function gitBuffer(cwd: string, ...args: string[]): Buffer {
	return execFileSync('git', args, {
		cwd,
		encoding: 'buffer',
		timeout: GIT_TIMEOUT_MS,
		maxBuffer: GIT_MAX_BUFFER,
		stdio: ['ignore', 'pipe', 'pipe'],
	}) as Buffer;
}

function writeText(filePath: string, text: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, text);
}

function createLaneFixture(): LaneFixture {
	const root = canonicalMkdtemp('merge-overlap-2105-');
	tempRoots.push(root);
	git(root, 'init', '--initial-branch=main');
	git(root, 'config', 'user.email', 'swarm-test@example.invalid');
	git(root, 'config', 'user.name', 'Swarm Test');
	writeText(path.join(root, 'base.txt'), 'base\n');
	git(root, 'add', 'base.txt');
	git(root, 'commit', '-m', 'base');
	const branchName = 'lane';
	const worktreePath = path.join(
		root,
		'.swarm',
		'worktrees',
		'session',
		'lane',
	);
	fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
	git(root, 'worktree', 'add', '-b', branchName, worktreePath);
	return { root, worktreePath, branchName };
}

function commitLaneFile(
	fixture: LaneFixture,
	relativePath: string,
	text: string,
	message = `lane ${relativePath}`,
): void {
	writeText(path.join(fixture.worktreePath, relativePath), text);
	git(fixture.worktreePath, 'add', relativePath);
	git(fixture.worktreePath, 'commit', '-m', message);
}

function renameLaneFile(
	fixture: LaneFixture,
	fromPath: string,
	toPath: string,
	message = `rename ${fromPath} to ${toPath}`,
): void {
	fs.mkdirSync(path.dirname(path.join(fixture.worktreePath, toPath)), {
		recursive: true,
	});
	fs.renameSync(
		path.join(fixture.worktreePath, fromPath),
		path.join(fixture.worktreePath, toPath),
	);
	git(fixture.worktreePath, 'add', '-A');
	git(fixture.worktreePath, 'commit', '-m', message);
}

function makeProc(
	exitCode: number,
	stdout: string,
	stderr = '',
): BunCompatSubprocess {
	return {
		exited: Promise.resolve(exitCode),
		exitCode,
		stdout: { text: () => Promise.resolve(stdout) },
		stderr: { text: () => Promise.resolve(stderr) },
		kill: () => {},
	} as unknown as BunCompatSubprocess;
}

afterEach(() => {
	_internals.bunSpawn = realBunSpawn;
	_internals.platform = realPlatform;
	for (const root of tempRoots.splice(0)) {
		try {
			if (fs.existsSync(path.join(root, '.git'))) {
				git(root, 'worktree', 'prune');
			}
		} catch {
			// Best-effort cleanup only.
		}
		fs.rmSync(root, { recursive: true, force: true });
	}
});

for (const strategy of ['merge', 'rebase', 'cherry-pick'] as const) {
	test(`${strategy}: exact dirty overlap defers before Git mutation`, async () => {
		const fixture = createLaneFixture();
		commitLaneFile(fixture, 'shared.txt', `${strategy} lane\n`);
		writeText(path.join(fixture.root, 'shared.txt'), `${strategy} primary\n`);
		git(fixture.root, 'add', 'shared.txt');
		const beforeBytes = fs.readFileSync(
			path.join(fixture.root, 'shared.txt'),
			'utf8',
		);
		const beforeIndex = gitBuffer(
			fixture.root,
			'ls-files',
			'--stage',
			'-z',
		).toString('utf8');

		const result = await attemptMergeBackFromDirty(
			fixture.worktreePath,
			fixture.branchName,
			fixture.root,
			strategy,
		);

		expect(result).toMatchObject({
			partial: true,
			stage: 'pre-merge-overlap',
			conflictFiles: ['shared.txt'],
		});
		expect(fs.readFileSync(path.join(fixture.root, 'shared.txt'), 'utf8')).toBe(
			beforeBytes,
		);
		expect(
			gitBuffer(fixture.root, 'ls-files', '--stage', '-z').toString('utf8'),
		).toBe(beforeIndex);
		expect(git(fixture.root, 'rev-parse', 'HEAD')).not.toBe(
			git(fixture.worktreePath, 'rev-parse', 'HEAD'),
		);
	});
}

describe('rename and file-directory collisions', () => {
	test('rename overlap treats both endpoints as incoming paths', async () => {
		const fixture = createLaneFixture();
		writeText(path.join(fixture.root, 'old.txt'), 'base old\n');
		git(fixture.root, 'add', 'old.txt');
		git(fixture.root, 'commit', '-m', 'add old');
		git(fixture.worktreePath, 'merge', '--ff-only', 'main');
		renameLaneFile(fixture, 'old.txt', 'new.txt');
		writeText(path.join(fixture.root, 'old.txt'), 'primary dirt\n');
		git(fixture.root, 'add', 'old.txt');
		writeText(path.join(fixture.root, 'new.txt'), 'primary untracked dirt\n');

		const result = await attemptMergeBackFromDirty(
			fixture.worktreePath,
			fixture.branchName,
			fixture.root,
			'merge',
		);

		expect(result).toMatchObject({
			partial: true,
			stage: 'pre-merge-overlap',
			conflictFiles: ['new.txt', 'old.txt'],
		});
	});

	test('ancestor file-directory collisions are reported with both normalized paths', async () => {
		const fixture = createLaneFixture();
		commitLaneFile(fixture, 'dir/file.txt', 'lane nested\n');
		writeText(path.join(fixture.root, 'dir'), 'primary file\n');
		git(fixture.root, 'add', 'dir');

		const result = await attemptMergeBackFromDirty(
			fixture.worktreePath,
			fixture.branchName,
			fixture.root,
			'merge',
		);

		expect(result).toMatchObject({
			partial: true,
			stage: 'pre-merge-overlap',
			conflictFiles: ['dir', 'dir/file.txt'],
		});
	});
});

test('Windows case-folding treats case-only path differences as overlap', async () => {
	const fixture = createLaneFixture();
	commitLaneFile(fixture, 'shared.txt', 'lane case\n');
	writeText(path.join(fixture.root, 'Shared.TXT'), 'primary case dirt\n');
	_internals.platform = 'win32';

	const result = await attemptMergeBackFromDirty(
		fixture.worktreePath,
		fixture.branchName,
		fixture.root,
		'merge',
	);

	expect(result).toMatchObject({
		partial: true,
		stage: 'pre-merge-overlap',
		conflictFiles: ['shared.txt'],
	});
});

test('disjoint primary dirt still merges successfully', async () => {
	const fixture = createLaneFixture();
	commitLaneFile(fixture, 'lane.txt', 'lane file\n');
	writeText(path.join(fixture.root, 'primary.txt'), 'primary dirt\n');
	git(fixture.root, 'add', 'primary.txt');

	const result = await attemptMergeBackFromDirty(
		fixture.worktreePath,
		fixture.branchName,
		fixture.root,
		'merge',
	);

	expect(result).toMatchObject({ merged: true, strategy: 'merge' });
	expect(fs.existsSync(path.join(fixture.root, 'lane.txt'))).toBe(true);
	expect(
		gitBuffer(fixture.root, 'ls-files', '--stage', '-z')
			.toString('utf8')
			.includes('primary.txt'),
	).toBe(true);
});

describe('fail-closed Git parsing', () => {
	test('malformed porcelain-v2 output fails closed before merge', async () => {
		const fixture = createLaneFixture();
		commitLaneFile(fixture, 'shared.txt', 'lane malformed\n');
		const realSpawn = _internals.bunSpawn;
		const calls: string[][] = [];
		_internals.bunSpawn = (args, options) => {
			calls.push(args.slice(1));
			if (args.includes('status')) {
				return makeProc(0, '2 malformed');
			}
			return realSpawn(args, options);
		};

		const result = await attemptMergeBackFromDirty(
			fixture.worktreePath,
			fixture.branchName,
			fixture.root,
			'merge',
		);

		expect(result).toMatchObject({ failed: true, stage: 'pre-merge' });
		expect(result.message).toContain('porcelain');
		expect(calls.some((entry) => entry[0] === 'merge')).toBe(false);
	});

	test('invalid lane HEAD output fails closed before merge', async () => {
		const fixture = createLaneFixture();
		commitLaneFile(fixture, 'shared.txt', 'lane invalid head\n');
		const realSpawn = _internals.bunSpawn;
		const calls: string[][] = [];
		_internals.bunSpawn = (args, options) => {
			calls.push(args.slice(1));
			if (args[1] === 'rev-parse' && args[3] === `${fixture.branchName}^0`) {
				return makeProc(0, 'not-a-commit\n');
			}
			return realSpawn(args, options);
		};

		const result = await attemptMergeBackFromDirty(
			fixture.worktreePath,
			fixture.branchName,
			fixture.root,
			'merge',
		);

		expect(result).toMatchObject({ failed: true, stage: 'pre-merge' });
		expect(result.message).toContain('lane HEAD');
		expect(calls.some((entry) => entry[0] === 'merge')).toBe(false);
	});
});
