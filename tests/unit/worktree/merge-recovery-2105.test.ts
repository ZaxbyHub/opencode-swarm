import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	type ImmutableMergeRecoveryCoordinates,
	recoverMergeBackFromImmutableCoordinates,
} from '../../../src/worktree/merge';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const GIT_TIMEOUT_MS = 20_000;
const GIT_MAX_BUFFER = 1024 * 1024;
const tempRoots: string[] = [];

interface RecoveryFixture {
	root: string;
	worktreePath: string;
	branchName: string;
	baseHead: string;
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

function writeText(filePath: string, text: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, text);
}

function createFixture(): RecoveryFixture {
	const root = canonicalMkdtemp('merge-recovery-2105-');
	tempRoots.push(root);
	git(root, 'init', '--initial-branch=main');
	git(root, 'config', 'user.email', 'swarm-test@example.invalid');
	git(root, 'config', 'user.name', 'Swarm Test');
	writeText(path.join(root, 'base.txt'), 'base\n');
	git(root, 'add', 'base.txt');
	git(root, 'commit', '-m', 'base');
	const baseHead = git(root, 'rev-parse', 'HEAD');
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
	return { root, worktreePath, branchName, baseHead };
}

function commitInLane(
	fixture: RecoveryFixture,
	relativePath: string,
	text: string,
	message: string,
): string {
	writeText(path.join(fixture.worktreePath, relativePath), text);
	git(fixture.worktreePath, 'add', relativePath);
	git(fixture.worktreePath, 'commit', '-m', message);
	return git(fixture.worktreePath, 'rev-parse', 'HEAD');
}

function commitInPrimary(
	fixture: RecoveryFixture,
	relativePath: string,
	text: string,
	message: string,
): string {
	writeText(path.join(fixture.root, relativePath), text);
	git(fixture.root, 'add', relativePath);
	git(fixture.root, 'commit', '-m', message);
	return git(fixture.root, 'rev-parse', 'HEAD');
}

function readSubject(cwd: string, revision: string): string {
	return git(cwd, 'show', '-s', '--format=%s', revision);
}

function readBody(cwd: string, revision: string): string {
	return git(cwd, 'show', '-s', '--format=%B', revision);
}

function readFileNormalized(filePath: string): string {
	return fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
}

function recover(
	fixture: RecoveryFixture,
	coordinates: ImmutableMergeRecoveryCoordinates,
) {
	return recoverMergeBackFromImmutableCoordinates(fixture.root, coordinates);
}

afterEach(() => {
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

describe('recoverMergeBackFromImmutableCoordinates', () => {
	test('merge recovery lands the captured source head even after primary advances and the lane branch drifts', async () => {
		const fixture = createFixture();
		const capturedSourceHead = commitInLane(
			fixture,
			'lane.txt',
			'captured lane\n',
			'lane captured',
		);
		commitInPrimary(
			fixture,
			'primary.txt',
			'primary advance\n',
			'primary advance',
		);
		const driftHead = commitInLane(
			fixture,
			'drift.txt',
			'branch drift\n',
			'lane drift',
		);

		const result = await recover(fixture, {
			sourceBaseOid: fixture.baseHead,
			sourceHeadOid: capturedSourceHead,
			targetHeadOid: fixture.baseHead,
			strategy: 'merge',
		});

		expect(result).toMatchObject({ merged: true, strategy: 'merge' });
		expect(readFileNormalized(path.join(fixture.root, 'lane.txt'))).toBe(
			'captured lane\n',
		);
		expect(fs.existsSync(path.join(fixture.root, 'drift.txt'))).toBe(false);
		expect(
			git(
				fixture.root,
				'merge-base',
				'--is-ancestor',
				capturedSourceHead,
				'HEAD',
			),
		).toBe('');
		expect(
			(() => {
				try {
					git(fixture.root, 'merge-base', '--is-ancestor', driftHead, 'HEAD');
					return true;
				} catch {
					return false;
				}
			})(),
		).toBe(false);
	});

	test('rebase recovery uses exact --onto coordinates from the captured lane head', async () => {
		const fixture = createFixture();
		const capturedSourceHead = commitInLane(
			fixture,
			'lane.txt',
			'lane base\n',
			'lane captured',
		);
		commitInPrimary(
			fixture,
			'primary.txt',
			'primary advance\n',
			'primary advance',
		);
		commitInLane(fixture, 'drift.txt', 'drift\n', 'lane drift');

		const result = await recover(fixture, {
			sourceBaseOid: fixture.baseHead,
			sourceHeadOid: capturedSourceHead,
			targetHeadOid: fixture.baseHead,
			strategy: 'rebase',
		});

		expect(result).toMatchObject({ merged: true, strategy: 'rebase' });
		expect(git(fixture.root, 'rev-parse', 'HEAD^')).toBe(capturedSourceHead);
		expect(readSubject(fixture.root, 'HEAD')).toBe('primary advance');
		expect(fs.existsSync(path.join(fixture.root, 'drift.txt'))).toBe(false);
		expect(readFileNormalized(path.join(fixture.root, 'lane.txt'))).toBe(
			'lane base\n',
		);
		expect(readFileNormalized(path.join(fixture.root, 'primary.txt'))).toBe(
			'primary advance\n',
		);
	});

	test('cherry-pick recovery replays the captured lane commits in exact order on the advanced primary head', async () => {
		const fixture = createFixture();
		const firstCommit = commitInLane(fixture, 'one.txt', 'one\n', 'lane one');
		const capturedSourceHead = commitInLane(
			fixture,
			'two.txt',
			'two\n',
			'lane two',
		);
		commitInPrimary(
			fixture,
			'primary.txt',
			'primary advance\n',
			'primary advance',
		);
		commitInLane(fixture, 'drift.txt', 'drift\n', 'lane drift');

		const result = await recover(fixture, {
			sourceBaseOid: fixture.baseHead,
			sourceHeadOid: capturedSourceHead,
			targetHeadOid: fixture.baseHead,
			strategy: 'cherry-pick',
		});

		expect(result).toMatchObject({
			merged: true,
			strategy: 'cherry-pick',
			sourceCommitOrder: [firstCommit, capturedSourceHead],
		});
		if (!('merged' in result) || !result.merged) {
			throw new Error('expected merged cherry-pick recovery');
		}
		expect(result.rewrittenCommitOrder).toHaveLength(2);
		expect(readSubject(fixture.root, 'HEAD')).toBe('lane two');
		expect(readSubject(fixture.root, 'HEAD~1')).toBe('lane one');
		expect(readSubject(fixture.root, 'HEAD~2')).toBe('primary advance');
		expect(readBody(fixture.root, 'HEAD')).toContain(
			`(cherry picked from commit ${capturedSourceHead})`,
		);
		expect(readBody(fixture.root, 'HEAD~1')).toContain(
			`(cherry picked from commit ${firstCommit})`,
		);
		expect(fs.existsSync(path.join(fixture.root, 'drift.txt'))).toBe(false);
	});

	test('cherry-pick recovery aborts cleanly on conflict and preserves the exact source commit order', async () => {
		const fixture = createFixture();
		const capturedSourceHead = commitInLane(
			fixture,
			'shared.txt',
			'lane value\n',
			'lane conflict',
		);
		commitInPrimary(
			fixture,
			'shared.txt',
			'primary conflict\n',
			'primary conflict',
		);

		const result = await recover(fixture, {
			sourceBaseOid: fixture.baseHead,
			sourceHeadOid: capturedSourceHead,
			targetHeadOid: fixture.baseHead,
			strategy: 'cherry-pick',
		});

		expect(result).toMatchObject({
			conflict: true,
			sourceCommitOrder: [capturedSourceHead],
		});
		expect(readFileNormalized(path.join(fixture.root, 'shared.txt'))).toBe(
			'primary conflict\n',
		);
		expect(git(fixture.root, 'diff', '--name-only', '--diff-filter=U')).toBe(
			'',
		);
		expect(
			fs.existsSync(path.join(fixture.root, '.git', 'CHERRY_PICK_HEAD')),
		).toBe(false);
	});

	test('recovery overlap preflight blocks dirty primary paths before immutable merge', async () => {
		const fixture = createFixture();
		const capturedSourceHead = commitInLane(
			fixture,
			'shared.txt',
			'lane value\n',
			'lane shared change',
		);
		writeText(path.join(fixture.root, 'shared.txt'), 'primary dirty\n');

		const result = await recover(fixture, {
			sourceBaseOid: fixture.baseHead,
			sourceHeadOid: capturedSourceHead,
			targetHeadOid: fixture.baseHead,
			strategy: 'merge',
		});

		expect(result).toMatchObject({
			error:
				'Primary checkout has overlapping dirty paths with incoming preserved lane changes: shared.txt',
		});
		expect(readFileNormalized(path.join(fixture.root, 'shared.txt'))).toBe(
			'primary dirty\n',
		);
		expect(git(fixture.root, 'rev-parse', 'HEAD')).toBe(fixture.baseHead);
	});

	test('recovery aborts a non-conflict cherry-pick failure that leaves a sequencer', async () => {
		const fixture = createFixture();
		const firstCommit = commitInLane(fixture, 'one.txt', 'one\n', 'lane one');
		const capturedSourceHead = commitInLane(
			fixture,
			'two.txt',
			'two\n',
			'lane two',
		);
		commitInPrimary(fixture, 'two.txt', 'two\n', 'primary two');

		const result = await recover(fixture, {
			sourceBaseOid: fixture.baseHead,
			sourceHeadOid: capturedSourceHead,
			targetHeadOid: fixture.baseHead,
			strategy: 'cherry-pick',
		});

		expect(result).toMatchObject({
			conflict: true,
			sourceCommitOrder: [firstCommit, capturedSourceHead],
		});
		expect(git(fixture.root, 'rev-parse', 'HEAD')).not.toBe(firstCommit);
		expect(fs.existsSync(path.join(fixture.root, '.git', 'sequencer'))).toBe(
			false,
		);
	});

	test('fails closed when the current primary head no longer descends from the captured target head', async () => {
		const fixture = createFixture();
		const capturedSourceHead = commitInLane(
			fixture,
			'lane.txt',
			'lane value\n',
			'lane captured',
		);
		commitInPrimary(
			fixture,
			'primary.txt',
			'primary advance\n',
			'primary advance',
		);

		const result = await recover(fixture, {
			sourceBaseOid: fixture.baseHead,
			sourceHeadOid: capturedSourceHead,
			targetHeadOid: capturedSourceHead,
			strategy: 'merge',
		});

		expect(result).toMatchObject({
			error:
				'Current primary HEAD no longer descends from the captured recovery target',
		});
		expect(fs.existsSync(path.join(fixture.root, 'lane.txt'))).toBe(false);
	});
});
