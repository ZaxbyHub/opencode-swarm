import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	listDeadLaneReclaims,
	reclaimDeadLanes,
	recordDeadLaneReclaim,
} from '../../../../src/hooks/delegation-gate/dead-lane-reclaim';
import { canonicalRootKeyFresh } from '../../../../src/utils/canonical-root';
import { canonicalMkdtemp } from '../../../helpers/tmpdir';

const originals = {
	removeWorktree: _internals.removeWorktree,
	closeProjectDb: _internals.closeProjectDb,
	isLaneOwnedByActiveSession: _internals.isLaneOwnedByActiveSession,
	isLaneDirty: _internals.isLaneDirty,
	pathExists: _internals.pathExists,
};

describe('dead-lane-reclaim (#2599)', () => {
	let directory: string;
	let lanePath: string;
	let removalResults: Array<
		{ success: true } | { success: false; error: string }
	>;
	let closedPaths: string[];
	let dirty: boolean;
	let owned: boolean;

	beforeEach(() => {
		directory = canonicalMkdtemp('dead-lane-reclaim-');
		lanePath = path.join(directory, '.swarm-worktrees', 'ses-1', 'task-1');
		fs.mkdirSync(lanePath, { recursive: true });
		fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
		removalResults = [];
		closedPaths = [];
		dirty = false;
		owned = false;
		_internals.removeWorktree = mock(async () => {
			const result = removalResults.shift() ?? { success: true as const };
			if ('error' in result) return result;
			fs.rmSync(lanePath, { recursive: true, force: true });
			return result;
		});
		_internals.closeProjectDb = mock((p: string) => {
			closedPaths.push(p);
		});
		_internals.isLaneDirty = mock(async () => dirty);
		_internals.isLaneOwnedByActiveSession = mock(() => owned);
	});

	afterEach(() => {
		Object.assign(_internals, originals);
		fs.rmSync(directory, { recursive: true, force: true });
	});

	test('record → reclaim round trip closes the DB before removal and drops the entry', async () => {
		recordDeadLaneReclaim(directory, {
			lanePath,
			branchName: 'swarm/lane/ses-1/task-1',
			parentSessionId: 'ses-1',
			taskId: 'task-1',
			reason: 'EBUSY: resource busy or locked',
		});
		expect(listDeadLaneReclaims(directory)).toHaveLength(1);
		const result = await reclaimDeadLanes(directory);
		expect(result.reclaimed).toEqual([lanePath]);
		expect(closedPaths).toEqual([lanePath]);
		expect(listDeadLaneReclaims(directory)).toHaveLength(0);
	});

	test('EBUSY-then-success across two reclaim runs retains then drops the entry', async () => {
		recordDeadLaneReclaim(directory, {
			lanePath,
			branchName: 'swarm/lane/ses-1/task-1',
			parentSessionId: 'ses-1',
			taskId: 'task-1',
			reason: 'EBUSY',
		});
		removalResults.push({ success: false, error: 'EBUSY: still locked' });
		const first = await reclaimDeadLanes(directory);
		expect(first.reclaimed).toEqual([]);
		expect(first.retained[0]?.reason).toBe('EBUSY: still locked');
		expect(listDeadLaneReclaims(directory)).toHaveLength(1);
		const second = await reclaimDeadLanes(directory);
		expect(second.reclaimed).toEqual([lanePath]);
		expect(listDeadLaneReclaims(directory)).toHaveLength(0);
	});

	test('dirty lane is preserved and the entry retained (fail closed, #2508)', async () => {
		dirty = true;
		recordDeadLaneReclaim(directory, {
			lanePath,
			branchName: 'swarm/lane/ses-1/task-1',
			parentSessionId: 'ses-1',
			taskId: 'task-1',
			reason: 'EBUSY',
		});
		const result = await reclaimDeadLanes(directory);
		expect(result.reclaimed).toEqual([]);
		expect(result.retained[0]?.reason).toBe('dirty-lane-preserved');
		expect(fs.existsSync(lanePath)).toBe(true);
		expect(listDeadLaneReclaims(directory)).toHaveLength(1);
	});

	test('lane owned by an active session is skipped and retained (#2527)', async () => {
		owned = true;
		recordDeadLaneReclaim(directory, {
			lanePath,
			branchName: 'swarm/lane/ses-1/task-1',
			parentSessionId: 'ses-1',
			taskId: 'task-1',
			reason: 'EBUSY',
		});
		const result = await reclaimDeadLanes(directory, {
			activeSessionIds: ['ses-1'],
		});
		expect(result.reclaimed).toEqual([]);
		expect(result.retained[0]?.reason.includes('owned-by-active-session')).toBe(
			true,
		);
		expect(listDeadLaneReclaims(directory)).toHaveLength(1);
	});

	test('recording the same lanePath twice dedupes to one entry', () => {
		for (let i = 0; i < 2; i += 1) {
			recordDeadLaneReclaim(directory, {
				lanePath,
				branchName: 'swarm/lane/ses-1/task-1',
				parentSessionId: 'ses-1',
				taskId: 'task-1',
				reason: `attempt-${i}`,
			});
		}
		expect(listDeadLaneReclaims(directory)).toHaveLength(1);
	});

	test('store is bounded to 512 entries', async () => {
		for (let i = 0; i < 600; i += 1) {
			recordDeadLaneReclaim(directory, {
				lanePath: `${lanePath}-${i}`,
				branchName: 'b',
				parentSessionId: 'ses-1',
				taskId: `task-${i}`,
				reason: 'EBUSY',
			});
		}
		expect(listDeadLaneReclaims(directory)).toHaveLength(512);
		expect(listDeadLaneReclaims(directory)[0]?.taskId).toBe('task-88');
	}, 60_000); // per-file budget but over bun's 5s local default. // 600 durable (fsync-backed) store rewrites; well under CI's 120s

	test('stale entries (lane already gone) are dropped without removal', async () => {
		fs.rmSync(lanePath, { recursive: true, force: true });
		recordDeadLaneReclaim(directory, {
			lanePath,
			branchName: 'swarm/lane/ses-1/task-1',
			parentSessionId: 'ses-1',
			taskId: 'task-1',
			reason: 'EBUSY',
		});
		const result = await reclaimDeadLanes(directory);
		expect(result.reclaimed).toEqual([]);
		expect(result.retained).toEqual([]);
		expect(listDeadLaneReclaims(directory)).toHaveLength(0);
		expect(closedPaths).toEqual([]);
	});

	test('protected lanes match via the production caller canonical form (critic round 1)', async () => {
		// The production caller (init-orphan-recovery) builds
		// protectedWorktreePaths with worktreePathKey() — realpath-resolved
		// and lowercased on win32 — while the store records the raw
		// strand-time spelling. On win32 the forms differ (drive-letter
		// case), which made the pre-fix raw-only Set.has() a guaranteed
		// miss — the exact data-loss class this gate exists to prevent.
		recordDeadLaneReclaim(directory, {
			lanePath,
			branchName: 'swarm/lane/ses-1/task-1',
			parentSessionId: 'ses-1',
			taskId: 'task-1',
			reason: 'EBUSY',
		});
		const canonicalProtected = new Set([canonicalRootKeyFresh(lanePath)]);
		const result = await reclaimDeadLanes(directory, {
			protectedWorktreePaths: canonicalProtected,
		});
		expect(result.reclaimed).toEqual([]);
		expect(result.retained).toEqual([
			{
				lanePath,
				reason: 'owned-by-active-session-or-protected',
			},
		]);
		expect(fs.existsSync(lanePath)).toBe(true);
		expect(listDeadLaneReclaims(directory)).toHaveLength(1);
	});
});
