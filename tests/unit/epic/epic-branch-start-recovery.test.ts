/**
 * Epic v2 C1b review F1 — a `git checkout -b` that REPORTS failure is judged
 * by the actual repository state, and is never retried:
 *   - a post-checkout hook exiting non-zero after the switch ⇒ HEAD is on
 *     the epic branch ⇒ the start proceeds and records it;
 *   - a timeout after the switch ⇒ same;
 *   - a failure after the branch was created but before HEAD switched ⇒
 *     the branch (still at the start commit) is deleted, row + sentinel
 *     rolled back, HEAD untouched — the user is never stranded;
 *   - a spawn timeout (ETIMEDOUT) runs `checkout -b` exactly once
 *     (`gitExec`'s transient retry would re-run a non-idempotent command).
 * Real git repositories, frozen clock, `_internals` seams.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import { checkoutNewEpicBranch } from '../../../src/epic/epic-branch';
import {
	epicSentinelExists,
	getOpenEpic,
	inspectEpic,
} from '../../../src/epic/lifecycle';
import { _internals, startEpic } from '../../../src/epic/start';
import { _internals as gitBranchInternals } from '../../../src/git/branch';
import { freezeClock, type Restore } from '../../helpers/test-clock';
import {
	git,
	headBranch,
	restoreStartInternals,
	stubStartGlobals,
} from './epic-branch-fixture';
import { createStartProject, EPIC_ON_CONFIG } from './start-fixture';

const realSpawnSync = gitBranchInternals.spawnSync;
let dir: string;
let restoreClock: Restore | null = null;

function start() {
	return startEpic({ directory: dir, sessionID: 'ses_f1', force: false });
}

function swarmBranches(): string {
	return git(dir, ['branch', '--list', 'swarm/*']).trim();
}

beforeEach(async () => {
	restoreClock = freezeClock({ isoNow: '2026-07-06T09:00:00.000Z' });
	stubStartGlobals();
	dir = await createStartProject('epic-branch-start-f1-', {
		git: true,
		config: EPIC_ON_CONFIG,
	});
});

afterEach(() => {
	restoreClock?.();
	restoreClock = null;
	restoreStartInternals();
	gitBranchInternals.spawnSync = realSpawnSync;
	closeAllProjectDbs();
	fs.rmSync(dir, { recursive: true, force: true });
});

describe('checkout -b failures are judged by the actual state', () => {
	test('post-checkout hook exits non-zero after the switch ⇒ started, branch recorded', async () => {
		const hook = path.join(dir, '.git', 'hooks', 'post-checkout');
		fs.mkdirSync(path.dirname(hook), { recursive: true });
		fs.writeFileSync(hook, '#!/bin/sh\necho "hook says no" >&2\nexit 1\n', {
			mode: 0o755,
		});
		const result = await start();
		expect(result.status).toBe('started');
		if (result.status !== 'started') return;
		expect(headBranch(dir)).toBe(`swarm/epic/${result.record.epicKey}`);
		expect(getOpenEpic(dir)?.git.epicBranch).toBe(
			`swarm/epic/${result.record.epicKey}`,
		);
	});

	test('timeout reported after the switch ⇒ started', async () => {
		_internals.checkoutNewEpicBranch = (directory, branch) => {
			checkoutNewEpicBranch(directory, branch);
			throw new Error(
				'git checkout failed to complete: spawnSync git ETIMEDOUT',
			);
		};
		const result = await start();
		expect(result.status).toBe('started');
		if (result.status === 'started') {
			expect(headBranch(dir)).toBe(result.record.git.epicBranch);
		}
	});

	test('branch created but HEAD not switched ⇒ branch deleted, rolled back, HEAD untouched', async () => {
		const before = headBranch(dir);
		_internals.checkoutNewEpicBranch = (directory, branch) => {
			git(directory, ['branch', branch]);
			throw new Error('simulated failure after the ref was created');
		};
		const result = await start();
		expect(result).toMatchObject({
			status: 'refused',
			reason: 'branch-create-failed',
		});
		expect(headBranch(dir)).toBe(before);
		expect(swarmBranches()).toBe('');
		expect(epicSentinelExists(dir)).toBe(false);
		expect(inspectEpic(dir).rowKeys).toEqual([]);
	});

	test('ETIMEDOUT spawn ⇒ checkout -b attempted exactly once, start rolled back', async () => {
		const before = headBranch(dir);
		let checkoutCalls = 0;
		gitBranchInternals.spawnSync = ((cmd, args, options) => {
			if (args[0] === 'checkout' && args[1] === '-b') {
				checkoutCalls += 1;
				const error = Object.assign(new Error('spawnSync git ETIMEDOUT'), {
					code: 'ETIMEDOUT',
				});
				return {
					pid: 0,
					output: [],
					stdout: '',
					stderr: '',
					status: null,
					signal: 'SIGTERM',
					error,
				};
			}
			return realSpawnSync(cmd, args, options);
		}) as typeof gitBranchInternals.spawnSync;
		const result = await start();
		expect(checkoutCalls).toBe(1);
		expect(result).toMatchObject({ reason: 'branch-create-failed' });
		if (result.status === 'refused') {
			expect(result.details[0]).toContain('ETIMEDOUT');
		}
		expect(headBranch(dir)).toBe(before);
		expect(swarmBranches()).toBe('');
		expect(epicSentinelExists(dir)).toBe(false);
	});
});
