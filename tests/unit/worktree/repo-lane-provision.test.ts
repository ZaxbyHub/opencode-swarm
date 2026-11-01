import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import type { BunCompatSubprocess } from '../../../src/utils/bun-compat';
import { _internals as repoInternals } from '../../../src/vcs/repo-facade';
import { _internals as worktreeInternals, provisionWorktree } from '../../../src/worktree/core';

const realRepoSpawn = repoInternals.spawn;
const realGitSpawn = worktreeInternals.bunSpawn;

function fakeProc(exitCode: number, stdout: string, stderr = ''): BunCompatSubprocess {
	return {
		stdout: { text: async () => stdout } as BunCompatSubprocess['stdout'],
		stderr: { text: async () => stderr } as BunCompatSubprocess['stderr'],
		exited: Promise.resolve(exitCode),
		exitCode,
		signalCode: null,
		kill() {},
		killTree: () => Promise.resolve(),
	};
}

function engineRoot(): string {
	const root = mkdtempSync(path.join(tmpdir(), 'swarm-engine-'));
	mkdirSync(path.join(root, '.jj'));
	mkdirSync(path.join(root, '.purpose'), { recursive: true });
	writeFileSync(path.join(root, '.purpose', 'commands.json'), '{}');
	mkdirSync(path.join(root, 'bin'));
	const repoBin = path.join(root, 'bin', 'repo');
	writeFileSync(repoBin, '#!/bin/sh\nexit 0\n');
	chmodSync(repoBin, 0o755);
	return root;
}

afterEach(() => {
	repoInternals.spawn = realRepoSpawn;
	worktreeInternals.bunSpawn = realGitSpawn;
});

describe('provisionWorktree repo lane create', () => {
	test('uses the public repo lane create command and skips git worktree add', async () => {
		const root = engineRoot();
		const lanePath = path.join(root, 'lane');
		const repoArgv: string[][] = [];
		const gitArgv: string[][] = [];
		repoInternals.spawn = (cmd) => {
			repoArgv.push(cmd);
			return fakeProc(0, `created=swarm-ses_abc-task-1 path=${lanePath} revision=abc\n`);
		};
		worktreeInternals.bunSpawn = (cmd) => {
			gitArgv.push(cmd);
			return fakeProc(0, '');
		};

		const result = await provisionWorktree(root, 'task-1', 'ses_abc', {
			purpose: 'lane',
		});

		expect(result).toMatchObject({ worktreePath: lanePath });
		expect(existsSync(path.join(lanePath, '.swarm', 'repo-lane.json'))).toBe(true);
		expect(repoArgv).toHaveLength(1);
		expect(repoArgv[0]?.slice(0, 4)).toEqual(['direnv', 'exec', root, 'repo']);
		expect(repoArgv[0]?.slice(4)).toEqual([
			'lane',
			'create',
			'swarm-ses_abc-task-1',
			'--objective',
			'lane task-1',
			'--scope',
			'repository',
		]);
		expect(repoArgv[0]).not.toContain('lane-create');
		expect(gitArgv.some((args) => args.includes('worktree') && args.includes('add'))).toBe(
			false,
		);
	});

	test('a facade failure does not fall through to git worktree add', async () => {
		const root = engineRoot();
		const gitArgv: string[][] = [];
		repoInternals.spawn = () => fakeProc(1, '', 'lane_pool_full');
		worktreeInternals.bunSpawn = (cmd) => {
			gitArgv.push(cmd);
			return fakeProc(0, '');
		};

		const result = await provisionWorktree(root, 'task-1', 'ses_abc', {
			purpose: 'lane',
		});

		expect(result).toEqual({ error: 'repo lane create failed: lane_pool_full' });
		expect(gitArgv.some((args) => args.includes('worktree') && args.includes('add'))).toBe(
			false,
		);
	});

	test('a directory without Engine markers still uses git worktree add', async () => {
		const root = mkdtempSync(path.join(tmpdir(), 'swarm-git-'));
		const gitArgv: string[][] = [];
		const realResolve = worktreeInternals.resolveGitExecutable;
		worktreeInternals.resolveGitExecutable = () => 'git';
		worktreeInternals.bunSpawn = (cmd) => {
			gitArgv.push(cmd);
			const sub = cmd[1];
			if (sub === 'show-ref') return fakeProc(1, '');
			return fakeProc(0, sub === 'rev-parse' ? '.git\n' : '');
		};

		try {
			const result = await provisionWorktree(root, 'task-1', 'ses_abc', {
				purpose: 'lane',
			});
			expect('worktreePath' in result).toBe(true);
			expect(gitArgv.some((args) => args.includes('worktree') && args.includes('add'))).toBe(
				true,
			);
		} finally {
			worktreeInternals.resolveGitExecutable = realResolve;
		}
	});
});
