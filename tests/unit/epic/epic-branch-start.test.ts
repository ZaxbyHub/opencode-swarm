/**
 * Epic v2 C1b — `/swarm epic start` under the epic-branch commit policy
 * (the default): the epic branch is checked out after the CAS create and
 * recorded only once the checkout succeeded (M-e); detached HEAD and an
 * existing epic branch are refused; a checkout / record failure rolls the
 * start back (row + sentinel compare-and-deleted, branch undone).
 * Real git repositories in canonical temp dirs, frozen clock.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import { closeEpic } from '../../../src/epic/close';
import {
	epicSentinelExists,
	getOpenEpic,
	inspectEpic,
} from '../../../src/epic/lifecycle';
import { _internals, startEpic } from '../../../src/epic/start';
import { freezeClock, type Restore } from '../../helpers/test-clock';
import {
	git,
	headBranch,
	restoreStartInternals,
	startedGitEpic,
	stubStartGlobals,
} from './epic-branch-fixture';
import { createStartProject, EPIC_ON_CONFIG } from './start-fixture';

const dirs: string[] = [];
let restoreClock: Restore | null = null;

function start(dir: string) {
	return startEpic({ directory: dir, sessionID: 'ses_b', force: false });
}

async function project(config?: Record<string, unknown>): Promise<string> {
	const dir = await createStartProject('epic-branch-start-', {
		git: true,
		config,
	});
	dirs.push(dir);
	return dir;
}

function expectNothingOpen(dir: string): void {
	expect(epicSentinelExists(dir)).toBe(false);
	expect(inspectEpic(dir).rowKeys).toEqual([]);
}

beforeEach(() => {
	restoreClock = freezeClock({ isoNow: '2026-07-01T09:00:00.000Z' });
	stubStartGlobals();
});

afterEach(() => {
	restoreClock?.();
	restoreClock = null;
	restoreStartInternals();
	closeAllProjectDbs();
	for (const dir of dirs.splice(0))
		fs.rmSync(dir, { recursive: true, force: true });
});

describe('epic-branch start', () => {
	test('checks out swarm/epic/<epicKey> and records original branch, base commit and epic branch', async () => {
		const started = await startedGitEpic('epic-branch-start-');
		dirs.push(started.dir);
		const { record, dir, originalBranch } = started;
		expect(record.config.commitPolicy).toBe('epic-branch');
		expect(record.git).toMatchObject({
			isRepo: true,
			originalBranch,
			epicBranch: `swarm/epic/${record.epicKey}`,
		});
		expect(record.git.baseCommit).toBe(
			git(dir, ['rev-parse', originalBranch]).trim(),
		);
		expect(headBranch(dir)).toBe(`swarm/epic/${record.epicKey}`);
		// The probe sees the recorded branch (the row was updated, not just
		// the returned object).
		expect(getOpenEpic(dir)?.git.epicBranch).toBe(record.git.epicBranch);
	});

	test('current-branch policy: no branch is created and nothing changes in git', async () => {
		const dir = await project({
			epic: { mode: { enabled: true }, commit_policy: 'current-branch' },
		});
		const before = headBranch(dir);
		const result = await start(dir);
		expect(result.status).toBe('started');
		if (result.status !== 'started') return;
		expect(result.record.config.commitPolicy).toBe('current-branch');
		expect(result.record.git.epicBranch).toBeNull();
		expect(headBranch(dir)).toBe(before);
		expect(git(dir, ['branch', '--list', 'swarm/*']).trim()).toBe('');
	});

	test('detached HEAD ⇒ detached-head, nothing created', async () => {
		const dir = await project(EPIC_ON_CONFIG);
		git(dir, ['checkout', '-q', '--detach']);
		const result = await start(dir);
		expect(result).toMatchObject({
			status: 'refused',
			reason: 'detached-head',
		});
		if (result.status === 'refused') {
			expect(result.details.join(' ')).toContain('HEAD is detached');
			expect(result.details.join(' ')).toContain('current-branch');
		}
		expectNothingOpen(dir);
	});

	test('an existing epic branch (earlier abandoned epic) ⇒ epic-branch-exists naming git branch -D', async () => {
		const started = await startedGitEpic('epic-branch-start-');
		dirs.push(started.dir);
		const abandoned = await closeEpic({
			directory: started.dir,
			abandon: true,
		});
		expect(abandoned.status).toBe('closed');
		expect(headBranch(started.dir)).toBe(started.originalBranch);

		const again = await start(started.dir);
		expect(again).toMatchObject({
			status: 'refused',
			reason: 'epic-branch-exists',
		});
		if (again.status === 'refused') {
			expect(again.details.join(' ')).toContain(
				`git branch -D ${started.epicBranch}`,
			);
		}
		expectNothingOpen(started.dir);
		// After deleting it, the same plan starts again.
		git(started.dir, ['branch', '-D', started.epicBranch]);
		expect((await start(started.dir)).status).toBe('started');
	});

	test('real git checkout failure ⇒ branch-create-failed with git stderr; row + sentinel rolled back', async () => {
		const dir = await project(EPIC_ON_CONFIG);
		const before = headBranch(dir);
		// A branch named `swarm` makes `swarm/epic/<key>` impossible to create
		// (ref directory/file conflict) while `branch --list` still finds no
		// such branch — a genuine `git checkout -b` failure.
		git(dir, ['branch', 'swarm']);
		const result = await start(dir);
		expect(result).toMatchObject({
			status: 'refused',
			reason: 'branch-create-failed',
		});
		if (result.status === 'refused') {
			expect(result.details[0]).toContain('git checkout -b swarm/epic/');
			expect(result.details[0].length).toBeGreaterThan(
				'git checkout -b swarm/epic/ failed: '.length + 20,
			);
		}
		expectNothingOpen(dir);
		expect(headBranch(dir)).toBe(before);
	});

	test('checkout failure via the seam ⇒ rolled back on this start token only', async () => {
		const dir = await project(EPIC_ON_CONFIG);
		_internals.checkoutNewEpicBranch = () => {
			throw new Error('fatal: simulated checkout failure');
		};
		const result = await start(dir);
		expect(result).toMatchObject({ reason: 'branch-create-failed' });
		if (result.status === 'refused') {
			expect(result.details[0]).toContain('simulated checkout failure');
		}
		expectNothingOpen(dir);
	});

	test('branch created but not recorded ⇒ branch undone, back on the original branch, rolled back', async () => {
		const dir = await project(EPIC_ON_CONFIG);
		const before = headBranch(dir);
		_internals.recordEpicBranch = () => {
			throw new Error('simulated record contention');
		};
		const result = await start(dir);
		expect(result).toMatchObject({ reason: 'branch-create-failed' });
		if (result.status === 'refused') {
			expect(result.details[0]).toContain('simulated record contention');
		}
		expectNothingOpen(dir);
		expect(headBranch(dir)).toBe(before);
		expect(git(dir, ['branch', '--list', 'swarm/*']).trim()).toBe('');
	});
});
