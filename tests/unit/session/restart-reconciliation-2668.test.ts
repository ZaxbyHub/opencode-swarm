/**
 * Issue #2668 restart reconciliation boundaries.
 *
 * These checks exercise the production hydration reducer, cache publisher,
 * snapshot projection writer, and post-resolution coordinator.  The deferred
 * barriers are deliberately placed immediately before each publication point
 * so a superseded generation cannot publish a late result.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	mkdirSync,
	readdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { resetStartupLedgerCheck } from '../../../src/plan/manager';
import {
	clearDeferredWarnings,
	getDeferredWarnings,
} from '../../../src/services/warning-buffer';
import {
	beginHydrationScope,
	hydrationProjectKey,
} from '../../../src/session/hydration-ownership';
import {
	_snapshotCoordinationInternals,
	getSnapshotCoordinationStatus,
	startSnapshotCoordinationInitialization,
} from '../../../src/session/snapshot-coordination-init';
import {
	loadSnapshot,
	rehydrateState,
} from '../../../src/session/snapshot-reader';
import {
	SNAPSHOT_PROJECTION_FILE,
	type SnapshotData,
	writeSnapshotProjection,
} from '../../../src/session/snapshot-writer';
import {
	buildRehydrationCache,
	getRehydrationCache,
	resetSwarmState,
	startAgentSession,
	_internals as stateInternals,
	swarmState,
} from '../../../src/state';
import { writeApprovedPlan } from '../../helpers/approved-plan';
import { safeRmRecursive } from '../../helpers/safe-test-dir';
import { withFrozenClock } from '../../helpers/test-clock';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const tempDirs: string[] = [];
const originalStateBuildRehydrationCache = stateInternals.buildRehydrationCache;
const originalStateRehydrateSessionFromDisk =
	stateInternals.rehydrateSessionFromDisk;

function makeProject(prefix: string): string {
	const directory = canonicalMkdtemp(`swarm-2668-${prefix}-`);
	mkdirSync(path.join(directory, '.git'));
	tempDirs.push(directory);
	return directory;
}

function snapshot(sessionID: string, agentName = 'coder'): SnapshotData {
	return {
		version: 3,
		writtenAt: withFrozenClock(() => Date.now()),
		toolAggregates: {},
		activeAgent: { [sessionID]: agentName },
		delegationChains: {},
		agentSessions: {
			[sessionID]: {
				agentName,
				lastToolCallTime: 1,
				lastAgentEventTime: 1,
				delegationActive: false,
			},
		},
	} as unknown as SnapshotData;
}

function projectionPath(directory: string): string {
	return path.join(directory, '.swarm', SNAPSHOT_PROJECTION_FILE);
}

async function waitFor(check: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (check()) return;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	throw new Error('timed out waiting for the deferred hydration boundary');
}

beforeEach(() => {
	_snapshotCoordinationInternals.entries.clear();
	stateInternals.buildRehydrationCache = originalStateBuildRehydrationCache;
	stateInternals.rehydrateSessionFromDisk =
		originalStateRehydrateSessionFromDisk;
	resetStartupLedgerCheck();
	resetSwarmState();
	clearDeferredWarnings();
});

afterEach(() => {
	_snapshotCoordinationInternals.entries.clear();
	stateInternals.buildRehydrationCache = originalStateBuildRehydrationCache;
	stateInternals.rehydrateSessionFromDisk =
		originalStateRehydrateSessionFromDisk;
	resetSwarmState();
	clearDeferredWarnings();
	for (const directory of tempDirs.splice(0)) safeRmRecursive(directory);
});

describe('reducer and cache publication fences (#2668)', () => {
	test('a generation superseded during the reducer barrier publishes nothing', async () => {
		const directory = makeProject('reducer');
		const old = snapshot('old-session');
		const scope = beginHydrationScope(directory);
		const aggregate = {
			tool: 'sentinel',
			count: 7,
			successCount: 7,
			failureCount: 0,
			totalDuration: 1,
		};
		swarmState.toolAggregates.set('sentinel', aggregate);
		startAgentSession('live-session', 'architect');

		let release!: () => void;
		const barrier = new Promise<void>((resolve) => {
			release = resolve;
		});
		swarmState.pendingRehydrations.add(barrier);
		const applying = rehydrateState(old, directory, scope);
		await Promise.resolve();
		beginHydrationScope(directory);
		release();

		expect(await applying).toEqual({ applied: false, reason: 'superseded' });
		expect(swarmState.toolAggregates.get('sentinel')).toEqual(aggregate);
		expect(swarmState.agentSessions.has('live-session')).toBe(true);
		expect(swarmState.agentSessions.has('old-session')).toBe(false);
		swarmState.pendingRehydrations.delete(barrier);
	});

	test('superseded loadSnapshot retains its cache but cannot apply it to a newer live session', async () => {
		const directory = makeProject('load-snapshot');
		await writeApprovedPlan(directory, [
			{ id: '1.1', files: ['src/load-snapshot.ts'], status: 'completed' },
		]);
		await writeSnapshotProjection(directory, snapshot('old-load-session'));
		let release!: () => void;
		let entered = false;
		const barrier = {
			then(resolve: () => void) {
				entered = true;
				return new Promise<void>((finish) => {
					release = () => {
						finish();
						resolve();
					};
				});
			},
		} as unknown as Promise<void>;
		swarmState.pendingRehydrations.add(barrier);
		const loading = loadSnapshot(directory);
		await waitFor(() => entered);
		beginHydrationScope(directory);
		startAgentSession('live-load-session', 'architect', undefined, directory);
		const live = swarmState.agentSessions.get('live-load-session');
		expect(live).toBeDefined();
		const liveRehydration = [...swarmState.pendingRehydrations].find(
			(pending) => pending !== barrier,
		);
		if (liveRehydration) await liveRehydration;
		// This is newer in-memory workflow state.  The stale load must not
		// overwrite it with the cache it built before its reducer was superseded.
		live!.taskWorkflowStates.set('1.1', 'idle');
		release();
		await loading;
		expect(swarmState.agentSessions.has('old-load-session')).toBe(false);
		expect(swarmState.agentSessions.has('live-load-session')).toBe(true);
		const cache = getRehydrationCache(hydrationProjectKey(directory)) as {
			planTaskStates: Map<string, string>;
		};
		expect(cache.planTaskStates.get('1.1')).toBe('complete');
		expect(live!.taskWorkflowStates.get('1.1')).toBe('idle');
		swarmState.pendingRehydrations.delete(barrier);
	});

	test('a superseded cache build leaves the prior project cache intact', async () => {
		const directory = makeProject('cache');
		const planPath = path.join(directory, '.swarm', 'plan.json');
		await writeApprovedPlan(directory, [
			{ id: '1.1', files: ['src/cache.ts'], status: 'completed' },
		]);
		await buildRehydrationCache(directory);
		const key = hydrationProjectKey(directory);
		const before = getRehydrationCache(key) as {
			planTaskStates: Map<string, string>;
		};
		expect(before.planTaskStates.get('1.1')).toBe('complete');

		const changed = JSON.parse(readFileSync(planPath, 'utf8')) as {
			phases: Array<{ tasks: Array<{ status: string }> }>;
		};
		changed.phases[0]!.tasks[0]!.status = 'pending';
		writeFileSync(planPath, JSON.stringify(changed));
		const result = await buildRehydrationCache(directory, {
			shouldCommit: () => false,
		});
		expect(result).toEqual({ committed: false, reason: 'superseded' });
		const after = getRehydrationCache(key) as {
			planTaskStates: Map<string, string>;
		};
		expect(after.planTaskStates.get('1.1')).toBe('complete');
	});

	test('a delayed session refresh cannot replace newer cache or apply old state', async () => {
		const directory = makeProject('delayed-session-refresh');
		const oldPlan = await writeApprovedPlan(directory, [
			{ id: '1.1', files: ['src/old-refresh.ts'], status: 'completed' },
		]);
		await buildRehydrationCache(directory);
		beginHydrationScope(directory);

		let releaseOldRefresh!: () => void;
		let refreshEntered = false;
		const oldRefreshBarrier = new Promise<void>((resolve) => {
			releaseOldRefresh = resolve;
		});
		stateInternals.buildRehydrationCache = async (root, options) => {
			if (!refreshEntered) {
				refreshEntered = true;
				await oldRefreshBarrier;
				// Reproduce the delayed operation's old read: it publishes the
				// plan that was current when startAgentSession began.
				return originalStateBuildRehydrationCache(root, {
					...options,
					planOverride: oldPlan,
				});
			}
			return originalStateBuildRehydrationCache(root, options);
		};

		startAgentSession(
			'delayed-refresh-session',
			'architect',
			undefined,
			directory,
		);
		await waitFor(() => refreshEntered);
		const newerScope = beginHydrationScope(directory);
		expect(newerScope.generation).toBeGreaterThan(1);

		const planPath = path.join(directory, '.swarm', 'plan.json');
		const newerProjection = JSON.parse(readFileSync(planPath, 'utf8')) as {
			phases: Array<{ tasks: Array<{ status: string }> }>;
		};
		newerProjection.phases[0]!.tasks[0]!.status = 'in_progress';
		writeFileSync(planPath, JSON.stringify(newerProjection));
		await originalStateBuildRehydrationCache(directory);
		const newerCache = getRehydrationCache(hydrationProjectKey(directory)) as {
			planTaskStates: Map<string, string>;
		};
		expect(newerCache.planTaskStates.get('1.1')).toBe('idle');

		const live = swarmState.agentSessions.get('delayed-refresh-session');
		expect(live).toBeDefined();
		live!.taskWorkflowStates.set('1.1', 'idle');
		const refresh = [...swarmState.pendingRehydrations][0];
		releaseOldRefresh();
		if (refresh) await refresh;

		const finalCache = getRehydrationCache(hydrationProjectKey(directory)) as {
			planTaskStates: Map<string, string>;
		};
		expect(finalCache.planTaskStates.get('1.1')).toBe('idle');
		expect(live!.taskWorkflowStates.get('1.1')).toBe('idle');
	});

	test('a superseded projection writer preserves the canonical file and cleans temp output', async () => {
		const directory = makeProject('projection');
		const old = snapshot('projection-old');
		const next = snapshot('projection-new', 'architect');
		await writeSnapshotProjection(directory, old);
		// The approved contract adds the predicate as an optional third argument;
		// this local type keeps the regression check readable while the source
		// remains backward-compatible for its existing two-argument callers.
		const fencedWriter = writeSnapshotProjection as unknown as (
			root: string,
			value: SnapshotData,
			shouldCommit?: () => boolean,
		) => Promise<void>;
		await fencedWriter(directory, next, () => false);
		expect(JSON.parse(readFileSync(projectionPath(directory), 'utf8'))).toEqual(
			old,
		);
		const leftovers = readdirSync(path.join(directory, '.swarm')).filter(
			(name) => name.startsWith(`${SNAPSHOT_PROJECTION_FILE}.tmp.`),
		).length;
		expect(leftovers).toBe(0);
	});
});

describe('authoritative plan recovery at the post-resolution boundary (#2668)', () => {
	async function assertLedgerRecovery(
		mode: 'missing' | 'corrupt',
	): Promise<void> {
		const directory = makeProject(`ledger-${mode}`);
		const executionProfile = {
			parallelization_enabled: true,
			max_concurrent_tasks: 3,
			council_parallel: false,
			locked: false,
			auto_proceed: false,
			commit_after_each_completed_task: true,
			planning_profile: 'strict' as const,
		};
		const expected = await writeApprovedPlan(
			directory,
			[{ id: '1.1', files: ['src/recovered.ts'], status: 'completed' }],
			{ executionProfile },
		);
		const planPath = path.join(directory, '.swarm', 'plan.json');
		const markdownPath = path.join(directory, '.swarm', 'plan.md');
		if (mode === 'missing') {
			unlinkSync(planPath);
			unlinkSync(markdownPath);
		} else {
			writeFileSync(planPath, '{not valid json');
			unlinkSync(markdownPath);
		}

		await startSnapshotCoordinationInitialization(directory);
		expect(getSnapshotCoordinationStatus(directory).state).toBe('succeeded');
		const rebuilt = JSON.parse(
			readFileSync(planPath, 'utf8'),
		) as typeof expected;
		expect(rebuilt.swarm).toBe(expected.swarm);
		expect(rebuilt.title).toBe(expected.title);
		expect(rebuilt.execution_profile).toEqual(expected.execution_profile);
		expect(rebuilt.phases[0]!.tasks[0]!.id).toBe('1.1');
		expect(rebuilt.phases[0]!.tasks[0]!.status).toBe('completed');
		startAgentSession(`restored-${mode}`, 'architect', undefined, directory);
		expect(
			swarmState.agentSessions
				.get(`restored-${mode}`)
				?.taskWorkflowStates.get('1.1'),
		).toBe('complete');
	}

	test('missing plan projection is rebuilt from the valid ledger', async () => {
		await assertLedgerRecovery('missing');
	});

	test('corrupt plan projection is rebuilt from the valid ledger', async () => {
		await assertLedgerRecovery('corrupt');
	});

	test('a corrupt projection cannot replace the ledger execution profile with legacy markdown defaults', async () => {
		const directory = makeProject('ledger-profile-authority');
		const executionProfile = {
			parallelization_enabled: true,
			max_concurrent_tasks: 4,
			council_parallel: true,
			locked: true,
			auto_proceed: true,
			commit_after_each_completed_task: true,
			planning_profile: 'strict' as const,
		};
		const expected = await writeApprovedPlan(
			directory,
			[{ id: '1.1', files: ['src/profile-authority.ts'], status: 'completed' }],
			{ executionProfile },
		);
		const planPath = path.join(directory, '.swarm', 'plan.json');
		const markdownPath = path.join(directory, '.swarm', 'plan.md');
		writeFileSync(planPath, '{not valid json');
		// A valid legacy projection intentionally omits execution_profile and has
		// different identity/status.  Only the verified ledger can preserve the
		// approved profile and completed task here.
		writeFileSync(
			markdownPath,
			'# Legacy Markdown Default\nSwarm: legacy-default\nPhase: 1\n\n## Phase 1: Legacy Phase [PENDING]\n- [ ] 1.1: Legacy task [SMALL]\n',
		);

		await startSnapshotCoordinationInitialization(directory);
		expect(getSnapshotCoordinationStatus(directory).state).toBe('succeeded');
		const rebuilt = JSON.parse(
			readFileSync(planPath, 'utf8'),
		) as typeof expected;
		expect(rebuilt.swarm).toBe(expected.swarm);
		expect(rebuilt.title).toBe(expected.title);
		expect(rebuilt.execution_profile).toEqual(expected.execution_profile);
		expect(rebuilt.phases[0]!.tasks[0]!.status).toBe('completed');
	});

	test('a valid ledger with no snapshot rows still refreshes plan-derived session state', async () => {
		const directory = makeProject('ledger-no-snapshot');
		const executionProfile = {
			parallelization_enabled: true,
			max_concurrent_tasks: 2,
			council_parallel: true,
			locked: false,
			auto_proceed: true,
			commit_after_each_completed_task: false,
			planning_profile: 'balanced' as const,
		};
		const expected = await writeApprovedPlan(
			directory,
			[{ id: '1.1', files: ['src/no-snapshot.ts'], status: 'completed' }],
			{ executionProfile },
		);
		unlinkSync(path.join(directory, '.swarm', 'plan.json'));
		unlinkSync(path.join(directory, '.swarm', 'plan.md'));

		await startSnapshotCoordinationInitialization(directory);
		const rebuilt = JSON.parse(
			readFileSync(path.join(directory, '.swarm', 'plan.json'), 'utf8'),
		) as typeof expected;
		expect(rebuilt.swarm).toBe(expected.swarm);
		expect(rebuilt.execution_profile).toEqual(expected.execution_profile);
		startAgentSession('no-snapshot-session', 'architect', undefined, directory);
		expect(
			swarmState.agentSessions
				.get('no-snapshot-session')
				?.taskWorkflowStates.get('1.1'),
		).toBe('complete');
	});
});

describe('fail-open readiness when authoritative recovery is unavailable (#2668)', () => {
	test('a plan-less load succeeds without an advisory or stale cache', async () => {
		const directory = makeProject('planless');
		await buildRehydrationCache(directory);
		const original = _snapshotCoordinationInternals.loadPlan;
		_snapshotCoordinationInternals.loadPlan = async () => null;
		try {
			await startSnapshotCoordinationInitialization(directory);
			expect(getSnapshotCoordinationStatus(directory).state).toBe('succeeded');
			expect(getRehydrationCache(hydrationProjectKey(directory))).toMatchObject(
				{
					planTaskStates: new Map(),
				},
			);
		} finally {
			_snapshotCoordinationInternals.loadPlan = original;
		}
	});

	test('a throwing authoritative loader keeps readiness successful and retains cache with an advisory', async () => {
		const directory = makeProject('plan-throw');
		await writeApprovedPlan(directory, [
			{ id: '1.1', files: ['src/retained.ts'], status: 'completed' },
		]);
		await buildRehydrationCache(directory);
		const original = _snapshotCoordinationInternals.loadPlan;
		_snapshotCoordinationInternals.loadPlan = async () => {
			throw new Error('injected ledger unavailable');
		};
		try {
			await startSnapshotCoordinationInitialization(directory);
			expect(getSnapshotCoordinationStatus(directory).state).toBe('succeeded');
			const cache = getRehydrationCache(hydrationProjectKey(directory)) as {
				planTaskStates: Map<string, string>;
			};
			expect(cache.planTaskStates.get('1.1')).toBe('complete');
			expect(getDeferredWarnings().join('\n')).toContain(
				'Authoritative plan recovery failed',
			);
		} finally {
			_snapshotCoordinationInternals.loadPlan = original;
		}
	});
});
