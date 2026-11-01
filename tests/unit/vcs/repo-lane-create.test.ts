import { mkdirSync, mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { readGitStatusAsync } from '../../../src/commands/git-status-read';
import {
	_internals,
	findRepoRoot,
	laneNameFromSwarmId,
	parseRepoLaneCreateStdout,
	repoLaneCreateArgs,
	repoVcsReadArgs,
} from '../../../src/vcs/repo-facade';

const temps: string[] = [];

afterEach(() => {
	for (const dir of temps.splice(0)) {
		// leave temp dirs; the suite is short-lived
		void dir;
	}
});

describe('repo lane create contract', () => {
	test('argv is the public command', () => {
		const args = repoLaneCreateArgs('swarm-ses-1', 'coder task 1');
		expect(args).toEqual([
			'lane',
			'create',
			'swarm-ses-1',
			'--objective',
			'coder task 1',
			'--scope',
			'repository',
		]);
		expect(args).not.toContain('lane-create');
	});

	test('parses the facade success line', () => {
		expect(
			parseRepoLaneCreateStdout(
				'created=swarm-ses-1 path=/tmp/lanes/swarm-ses-1 revision=abc\n',
			),
		).toEqual({ name: 'swarm-ses-1', path: '/tmp/lanes/swarm-ses-1' });
	});

	test('findRepoRoot requires .jj, commands.json, and executable bin/repo', () => {
		const root = mkdtempSync(path.join(tmpdir(), 'swarm-repo-'));
		temps.push(root);
		const child = path.join(root, 'src', 'nested');
		mkdirSync(child, { recursive: true });
		expect(findRepoRoot(child)).toBeNull();

		mkdirSync(path.join(root, '.jj'));
		mkdirSync(path.join(root, '.purpose'), { recursive: true });
		writeFileSync(path.join(root, '.purpose', 'commands.json'), '{}');
		mkdirSync(path.join(root, 'bin'));
		const repoBin = path.join(root, 'bin', 'repo');
		writeFileSync(repoBin, '#!/bin/sh\nexit 0\n');
		expect(findRepoRoot(child)).toBeNull();

		chmodSync(repoBin, 0o755);
		expect(findRepoRoot(child)).toBe(root);
	});

	test('status diff and log mirror to repo vcs and flags stay on git', () => {
		expect(repoVcsReadArgs(['status'])).toEqual(['vcs', 'status']);
		expect(repoVcsReadArgs(['diff'])).toEqual(['vcs', 'diff']);
		expect(repoVcsReadArgs(['log'])).toEqual(['vcs', 'log']);
		expect(repoVcsReadArgs(['status', '--porcelain'])).toBeNull();
		expect(repoVcsReadArgs(['rev-parse', '--git-dir'])).toBeNull();
	});

	test('readGitStatusAsync uses repo vcs status on an Engine root', async () => {
		const root = mkdtempSync(path.join(tmpdir(), 'swarm-repo-'));
		temps.push(root);
		mkdirSync(path.join(root, '.jj'));
		mkdirSync(path.join(root, '.purpose'), { recursive: true });
		writeFileSync(path.join(root, '.purpose', 'commands.json'), '{}');
		mkdirSync(path.join(root, 'bin'));
		const repoBin = path.join(root, 'bin', 'repo');
		writeFileSync(repoBin, '#!/bin/sh\nexit 0\n');
		chmodSync(repoBin, 0o755);
		const realSpawn = _internals.spawn;
		const argv: string[][] = [];
		_internals.spawn = (cmd) => {
			argv.push(cmd);
			return {
				stdout: { text: async () => 'clean\n' },
				stderr: { text: async () => '' },
				exited: Promise.resolve(0),
				exitCode: 0,
				signalCode: null,
				kill() {},
				killTree: () => Promise.resolve(),
			} as never;
		};
		try {
			const result = await readGitStatusAsync(['status'], root);
			expect(result).toEqual({ ok: true, stdout: 'clean\n' });
			expect(argv[0]?.slice(4)).toEqual(['vcs', 'status']);
			expect(argv[0]).not.toContain('lane-create');
		} finally {
			_internals.spawn = realSpawn;
		}
	});

	test('lane names stay inside the facade grammar', () => {
		expect(laneNameFromSwarmId('ses_abc', 'task-1')).toBe('swarm-ses_abc-task-1');
		expect(laneNameFromSwarmId('ses_abc', '../default')).toBeNull();
	});
});
