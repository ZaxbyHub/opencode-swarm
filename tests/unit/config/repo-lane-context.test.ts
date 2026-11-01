import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'bun:test';
import { resolveLaneContext } from '../../../src/config/lane-context';
import { writeRepoLaneMarker } from '../../../src/vcs/repo-facade';
import { _internals as repoFacadeInternals } from '../../../src/vcs/repo-facade';
import { mergeLaneBranch } from '../../../src/worktree/merge';

function engineRoot(): string {
	const root = mkdtempSync(path.join(tmpdir(), 'swarm-engine-parent-'));
	mkdirSync(path.join(root, '.jj'));
	mkdirSync(path.join(root, '.purpose'), { recursive: true });
	writeFileSync(path.join(root, '.purpose', 'commands.json'), '{}');
	mkdirSync(path.join(root, 'bin'));
	const repoBin = path.join(root, 'bin', 'repo');
	writeFileSync(repoBin, '#!/bin/sh\nexit 0\n');
	chmodSync(repoBin, 0o755);
	return root;
}

describe('resolveLaneContext repo lane marker', () => {
	test('an Engine lane marker is swarm-owned without a git HEAD', () => {
		const parent = engineRoot();
		const lane = mkdtempSync(path.join(tmpdir(), 'swarm-jj-lane-'));
		writeRepoLaneMarker(lane, {
			parentProjectPath: parent,
			sessionId: 'ses_abc',
			id: 'task-1',
		});

		expect(resolveLaneContext(path.join(lane, 'src'))).toEqual({
			lanePath: lane,
			parentProjectPath: parent,
		});
		const marker = JSON.parse(
			readFileSync(path.join(lane, '.swarm', 'repo-lane.json'), 'utf-8'),
		) as { kind: string };
		expect(marker.kind).toBe('opencode-swarm-repo-lane');
	});

	test('Engine land runs repo pr create instead of git merge-back', async () => {
		const parent = engineRoot();
		const calls: string[][] = [];
		const realSpawn = repoFacadeInternals.spawn;
		repoFacadeInternals.spawn = (cmd) => {
			calls.push(cmd);
			return {
				exited: Promise.resolve(0),
				stdout: {
					text: () =>
						Promise.resolve(
							'{"number":42,"html_url":"https://git.centralcloud.net/singularity/singularity-engine/pulls/42"}',
						),
				},
				stderr: { text: () => Promise.resolve('') },
				kill: () => {},
			} as never;
		};
		try {
			const result = await mergeLaneBranch(
				parent,
				'swarm/lane/ses_abc/task-1',
				'merge',
				'Land swarm task',
			);
			expect(result).toEqual({ merged: true, strategy: 'merge' });
			expect(calls.length).toBeGreaterThan(1);
			expect(calls.some((c) => c.includes('lane') && c.includes('push'))).toBe(true);
			const prCall = calls.find((c) => c.includes('pr') && c.includes('create'));
			expect(prCall).toBeDefined();
			expect(prCall).not.toContain('lane-create');
		} finally {
			repoFacadeInternals.spawn = realSpawn;
		}
	});

	test('a marker whose parent is not an Engine root is not a lane', () => {
		const parent = mkdtempSync(path.join(tmpdir(), 'swarm-not-engine-'));
		const lane = mkdtempSync(path.join(tmpdir(), 'swarm-jj-lane-'));
		writeRepoLaneMarker(lane, {
			parentProjectPath: parent,
			sessionId: 'ses_abc',
			id: 'task-1',
		});
		expect(resolveLaneContext(lane)).toBeNull();
	});
});
