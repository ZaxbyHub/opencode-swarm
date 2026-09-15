/**
 * Issue #2667 — project-owned, generation-fenced hydration.
 *
 * Unit-surface coverage for the ownership/fence arithmetic:
 * - rehydrateState with a directory evicts ONLY that project's own
 *   snapshot-derived sessions; other projects' live state and unowned
 *   sessions survive (fail-open toward preservation).
 * - An explicit stale scope is rejected with zero mutation (fence), and an
 *   implicit-scope stale replay cannot touch newer live state (stamp).
 * - The plan/evidence rehydration cache is per-project (no cross-project
 *   bleed in either direction).
 * - toolAggregates replace only the hydrating project's own keys.
 * - owningProjectKey/hydrationStamp never round-trip through snapshots.
 * - The per-project registries are bounded and reset with swarmState.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
	beginHydrationScope,
	clearHydrationOwnershipState,
	currentHydrationGeneration,
	hydrationProjectKey,
	MAX_TRACKED_PROJECTS,
} from '../../../src/session/hydration-ownership';
import {
	_snapshotCoordinationInternals,
	getSnapshotCoordinationStatus,
	retrySnapshotCoordinationInitialization,
	startSnapshotCoordinationInitialization,
} from '../../../src/session/snapshot-coordination-init';
import {
	loadSnapshot,
	rehydrateState,
} from '../../../src/session/snapshot-reader';
import { writeSnapshotRows } from '../../../src/session/snapshot-store';
import {
	SNAPSHOT_PROJECTION_FILE,
	type SnapshotData,
} from '../../../src/session/snapshot-writer';
import {
	buildRehydrationCache,
	resetSwarmState,
	startAgentSession,
	swarmState,
} from '../../../src/state';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const tempDirs: string[] = [];

function makeProject(prefix: string): string {
	const dir = canonicalMkdtemp(`${prefix}-2667-`);
	tempDirs.push(dir);
	mkdirSync(path.join(dir, '.swarm', 'session'), { recursive: true });
	return dir;
}

function makeSnapshot(sessionId: string, agentName: string): SnapshotData {
	return {
		version: 3,
		writtenAt: 1,
		toolAggregates: {},
		activeAgent: { [sessionId]: agentName },
		delegationChains: {},
		agentSessions: {
			[sessionId]: {
				agentName,
				lastToolCallTime: 1,
				lastAgentEventTime: 1,
				delegationActive: false,
			},
		},
	} as unknown as SnapshotData;
}

function seedSnapshot(
	dir: string,
	snapshot: SnapshotData,
	file = 'session/state.json',
): void {
	writeFileSync(path.join(dir, '.swarm', file), JSON.stringify(snapshot));
}

function writePlan(dir: string, taskId: string, status: string): void {
	writeFileSync(
		path.join(dir, '.swarm', 'plan.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			title: 't',
			swarm: 'default',
			phases: [
				{
					id: 1,
					name: 'p1',
					tasks: [{ id: taskId, phase: 1, description: taskId, status }],
				},
			],
		}),
	);
}

beforeEach(() => {
	// PRR-003: entries registry in snapshot-coordination-init is module-global;
	// clear it alongside swarmState so residue never reaches co-run siblings
	// (same discipline as tests/unit/session/snapshot-coordination-init.test.ts).
	_snapshotCoordinationInternals.entries.clear();
	resetSwarmState();
});

afterAll(() => {
	_snapshotCoordinationInternals.entries.clear();
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe('cross-project eviction is gone (issue #2667)', () => {
	test('B hydration preserves A live session, satellites, and aggregates', async () => {
		const dirA = makeProject('own-a');
		const dirB = makeProject('own-b');
		startAgentSession('sess-A', 'architect', undefined, dirA);
		swarmState.toolAggregates.set('Bash', {
			tool: 'Bash',
			count: 9,
			successCount: 9,
			failureCount: 0,
			totalDuration: 1,
		});
		seedSnapshot(dirB, makeSnapshot('sess-B', 'coder'));

		await loadSnapshot(dirB);

		expect(swarmState.agentSessions.has('sess-A')).toBe(true);
		expect(swarmState.activeAgent.get('sess-A')).toBe('architect');
		expect(swarmState.agentSessions.has('sess-B')).toBe(true);
		// B's snapshot carried no aggregates and must not clear A's runtime ones.
		expect(swarmState.toolAggregates.get('Bash')?.count).toBe(9);
	});

	test('unowned sessions survive every hydration (fail-open)', async () => {
		const dirB = makeProject('own-unowned');
		startAgentSession('sess-unowned', 'coder'); // no directory
		seedSnapshot(dirB, makeSnapshot('sess-B', 'coder'));
		await loadSnapshot(dirB);
		expect(swarmState.agentSessions.has('sess-unowned')).toBe(true);
	});

	test('own-project replace semantics preserved', async () => {
		const dirA = makeProject('own-replace');
		seedSnapshot(dirA, makeSnapshot('sess-old', 'coder'));
		await loadSnapshot(dirA);
		expect(swarmState.agentSessions.has('sess-old')).toBe(true);

		seedSnapshot(
			dirA,
			makeSnapshot('sess-new', 'coder'),
			SNAPSHOT_PROJECTION_FILE,
		);
		await loadSnapshot(dirA);
		expect(swarmState.agentSessions.has('sess-old')).toBe(false);
		expect(swarmState.agentSessions.has('sess-new')).toBe(true);
	});

	test('missing/empty/corrupt snapshots are bounded and clear nothing', async () => {
		const dirA = makeProject('own-neg-a');
		startAgentSession('sess-A3', 'architect', undefined, dirA);

		const dirEmpty = makeProject('own-neg-empty');
		writeFileSync(
			path.join(dirEmpty, '.swarm', 'session', 'state.json'),
			'   ',
		);
		await loadSnapshot(dirEmpty);

		const dirCorrupt = makeProject('own-neg-corrupt');
		writeFileSync(
			path.join(dirCorrupt, '.swarm', 'session', 'state.json'),
			'{not json',
		);
		await loadSnapshot(dirCorrupt);

		const dirAbsent = makeProject('own-neg-absent');
		await loadSnapshot(dirAbsent);

		expect(swarmState.agentSessions.has('sess-A3')).toBe(true);
	});
});

describe('generation fence and stamps (issue #2667)', () => {
	test('explicit stale scope rejected with zero mutation', async () => {
		const dirA = makeProject('fence-stale');
		const snapshot = makeSnapshot('sess-f1', 'coder');
		seedSnapshot(dirA, snapshot);
		const scope1 = beginHydrationScope(dirA);
		const outcome1 = await rehydrateState(snapshot, dirA, scope1);
		expect(outcome1.applied).toBe(true);
		// Newer generation begins before the older callback applies.
		const scope2 = beginHydrationScope(dirA);
		const outcomeLate = await rehydrateState(snapshot, dirA, scope1);
		expect(outcomeLate.applied).toBe(false);
		expect(outcomeLate.reason).toBe('superseded');
		// scope2's session state stands; the stale callback mutated nothing.
		expect(swarmState.agentSessions.has('sess-f1')).toBe(true);
		void scope2;
	});

	test('implicit-scope stale replay keeps newer live state (stamp rule)', async () => {
		const dirA = makeProject('fence-implicit');
		const oldSnapshot = makeSnapshot('sess-old-gen', 'coder');
		seedSnapshot(dirA, oldSnapshot);
		await loadSnapshot(dirA); // generation 1 applies, restores sess-old-gen

		startAgentSession('sess-newer', 'architect', undefined, dirA); // stamp 2

		// Late callback from generation 1, called with directory but no scope.
		const outcome = await rehydrateState(oldSnapshot, dirA);
		expect(outcome.applied).toBe(true);

		const newer = swarmState.agentSessions.get('sess-newer');
		expect(newer?.owningProjectKey).toBe(hydrationProjectKey(dirA));
		expect(newer?.hydrationStamp).toBe(2);
		expect(swarmState.agentSessions.has('sess-newer')).toBe(true);
	});

	test('live session created during generation g survives g, replaced only by g+1', async () => {
		const dirA = makeProject('fence-stamp');
		const scope = beginHydrationScope(dirA);
		// Session created while generation g is latest → stamp g+1: newer than
		// any hydration already begun.
		startAgentSession('sess-live', 'coder', undefined, dirA);
		expect(swarmState.agentSessions.get('sess-live')?.hydrationStamp).toBe(
			scope.generation + 1,
		);
		const snapshot = makeSnapshot('sess-snap', 'coder');
		const applied = await rehydrateState(snapshot, dirA, scope);
		expect(applied.applied).toBe(true);
		expect(swarmState.agentSessions.has('sess-live')).toBe(true);
		expect(swarmState.agentSessions.has('sess-snap')).toBe(true);

		// A foreign project still cannot touch either entry.
		const dirB = makeProject('fence-stamp-b');
		seedSnapshot(dirB, makeSnapshot('sess-other', 'coder'));
		await loadSnapshot(dirB);
		expect(swarmState.agentSessions.has('sess-live')).toBe(true);
		expect(swarmState.agentSessions.has('sess-snap')).toBe(true);
		expect(swarmState.agentSessions.has('sess-other')).toBe(true);
	});
});

describe('per-project rehydration cache (issue #2667)', () => {
	test('no cross-project cache bleed in either direction', async () => {
		const dirA = makeProject('cache-a');
		const dirB = makeProject('cache-b');
		writePlan(dirA, 'task-A', 'in_progress');
		writePlan(dirB, 'task-B', 'completed');

		await loadSnapshot(dirA);
		await loadSnapshot(dirB);

		startAgentSession('s-a', 'architect', undefined, dirA);
		startAgentSession('s-b', 'architect', undefined, dirB);

		const sessionA = swarmState.agentSessions.get('s-a');
		const sessionB = swarmState.agentSessions.get('s-b');
		expect(sessionA?.taskWorkflowStates.has('task-A')).toBe(true);
		expect(sessionA?.taskWorkflowStates.has('task-B')).toBe(false);
		expect(sessionB?.taskWorkflowStates.has('task-B')).toBe(true);
		expect(sessionB?.taskWorkflowStates.has('task-A')).toBe(false);
	});

	test('applyRehydrationCache with no project context is a no-op', async () => {
		const dirA = makeProject('cache-noop');
		writePlan(dirA, 'task-N', 'in_progress');
		await buildRehydrationCache(dirA);
		startAgentSession('s-no-dir', 'architect'); // unowned
		const session = swarmState.agentSessions.get('s-no-dir');
		expect(session?.taskWorkflowStates.size).toBe(0);
	});
});

describe('toolAggregates own-keys-only replace', () => {
	test('re-hydration drops only keys absent from the new own snapshot', async () => {
		const dirA = makeProject('agg-a');
		const dirB = makeProject('agg-b');
		seedSnapshot(dirA, {
			...makeSnapshot('agg-s1', 'coder'),
			toolAggregates: {
				Grep: {
					tool: 'Grep',
					count: 1,
					successCount: 1,
					failureCount: 0,
					totalDuration: 1,
				},
				Bash: {
					tool: 'Bash',
					count: 2,
					successCount: 2,
					failureCount: 0,
					totalDuration: 1,
				},
			},
		} as unknown as SnapshotData);
		seedSnapshot(dirB, {
			...makeSnapshot('agg-s2', 'coder'),
			toolAggregates: {
				Bash: {
					tool: 'Bash',
					count: 7,
					successCount: 7,
					failureCount: 0,
					totalDuration: 1,
				},
				Read: {
					tool: 'Read',
					count: 3,
					successCount: 3,
					failureCount: 0,
					totalDuration: 1,
				},
			},
		} as unknown as SnapshotData);

		await loadSnapshot(dirA);
		await loadSnapshot(dirB);
		expect(swarmState.toolAggregates.get('Grep')?.count).toBe(1);
		expect(swarmState.toolAggregates.get('Bash')?.count).toBe(7);
		expect(swarmState.toolAggregates.get('Read')?.count).toBe(3);

		// A re-hydrates with only Grep. Per the approved plan §2: a key in A's
		// OWN previous hydration set that is absent from A's new snapshot is
		// dropped (replace-with-newer semantics for own keys — a shared Bash
		// key may lose B's merged contribution), while a key A never published
		// (Read, B's alone) is never touched.
		seedSnapshot(
			dirA,
			{
				...makeSnapshot('agg-s3', 'coder'),
				toolAggregates: {
					Grep: {
						tool: 'Grep',
						count: 4,
						successCount: 4,
						failureCount: 0,
						totalDuration: 1,
					},
				},
			} as unknown as SnapshotData,
			SNAPSHOT_PROJECTION_FILE,
		);
		await loadSnapshot(dirA);
		expect(swarmState.toolAggregates.get('Grep')?.count).toBe(4);
		expect(swarmState.toolAggregates.has('Bash')).toBe(false);
		expect(swarmState.toolAggregates.get('Read')?.count).toBe(3);
	});
});

describe('ownership fields never round-trip through snapshots', () => {
	test('restored sessions are stamped by the hydrating directory, not snapshot bytes', async () => {
		const dirA = makeProject('roundtrip');
		const snapshot = makeSnapshot('rt-s1', 'coder');
		seedSnapshot(dirA, snapshot);
		await loadSnapshot(dirA);
		const restored = swarmState.agentSessions.get('rt-s1');
		expect(restored?.owningProjectKey).toBe(hydrationProjectKey(dirA));
		expect(typeof restored?.hydrationStamp).toBe('number');
		// The serialized form on disk carries neither field.
		const onDisk = JSON.parse(readSnapshotBytes(dirA)) as {
			agentSessions: Record<string, Record<string, unknown>>;
		};
		const serialized = onDisk.agentSessions['rt-s1'];
		expect(serialized).toBeDefined();
		expect('owningProjectKey' in serialized).toBe(false);
		expect('hydrationStamp' in serialized).toBe(false);
	});
});

function readSnapshotBytes(dir: string): string {
	return readFileSync(
		path.join(dir, '.swarm', 'session', 'state.json'),
		'utf-8',
	);
}

describe('multi-swarm shared directory (issue #2667 §6)', () => {
	test('same-directory sessions share one projectKey and survive foreign hydration', async () => {
		const dirX = makeProject('shared-x');
		const dirY = makeProject('shared-y');
		startAgentSession('sw1-arch', 'architect', undefined, dirX);
		startAgentSession('sw2-arch', 'architect', undefined, dirX);
		const projectKeyX = hydrationProjectKey(dirX);
		expect(swarmState.agentSessions.get('sw1-arch')?.owningProjectKey).toBe(
			projectKeyX,
		);
		expect(swarmState.agentSessions.get('sw2-arch')?.owningProjectKey).toBe(
			projectKeyX,
		);

		// A foreign project's hydration preserves both same-directory sessions.
		seedSnapshot(dirY, makeSnapshot('y-sess', 'coder'));
		await loadSnapshot(dirY);
		expect(swarmState.agentSessions.has('sw1-arch')).toBe(true);
		expect(swarmState.agentSessions.has('sw2-arch')).toBe(true);
		expect(swarmState.agentSessions.has('y-sess')).toBe(true);
	});
});

describe('bounded registries and reset (invariant 8)', () => {
	test('generation counter is per-project, monotonic, and FIFO-bounded', () => {
		const first = makeProject('reg-first');
		expect(currentHydrationGeneration(hydrationProjectKey(first))).toBe(0);
		beginHydrationScope(first);
		expect(currentHydrationGeneration(hydrationProjectKey(first))).toBe(1);
		beginHydrationScope(first);
		expect(currentHydrationGeneration(hydrationProjectKey(first))).toBe(2);

		// Flood past the cap: the first project's entry is evicted FIFO.
		clearHydrationOwnershipState();
		const flood = makeProject('reg-flood');
		beginHydrationScope(flood);
		for (let i = 0; i < MAX_TRACKED_PROJECTS + 2; i += 1) {
			beginHydrationScope(makeProject(`reg-p${i}`));
		}
		expect(currentHydrationGeneration(hydrationProjectKey(flood))).toBe(0);
	});

	test('resetSwarmState clears the registries', async () => {
		const dirA = makeProject('reg-reset');
		writePlan(dirA, 'task-R', 'in_progress');
		await loadSnapshot(dirA);
		expect(currentHydrationGeneration(hydrationProjectKey(dirA))).toBe(1);
		resetSwarmState();
		expect(currentHydrationGeneration(hydrationProjectKey(dirA))).toBe(0);
	});
});

describe('coordination-init generation fence (issue #2667 fault 3, deterministic)', () => {
	test('late-settling coordination initializer is fence-rejected once a newer hydration began; retry applies fresh', async () => {
		const dir = makeProject('coord-fence');
		// SQLite authority rows the REAL initializeSnapshotCoordination will read.
		writeSnapshotRows(dir, makeSnapshot('sess-coord-old', 'coder'));

		// Deterministic seam: hold the FIRST generation's underlying on a
		// manual gate, then run the REAL initializer (which calls
		// rehydrateState with the captured scope) when released.
		const realInitialize = _snapshotCoordinationInternals.initialize;
		let releaseGate1: (() => void) | undefined;
		const gate1 = new Promise<void>((resolve) => {
			releaseGate1 = resolve;
		});
		let firstCall = true;
		_snapshotCoordinationInternals.initialize = (directory, scope) => {
			if (!firstCall) return realInitialize(directory, scope);
			firstCall = false;
			return gate1.then(() => realInitialize(directory, scope));
		};

		try {
			// Generation 1 (coordination) begins and stays unsettled.
			const gen1 = startSnapshotCoordinationInitialization(dir);
			// A NEWER hydration for the same project begins while gen 1 is in
			// flight — exactly the production shape (slow/timed-out
			// coordination initializer vs a newer loadSnapshot).
			seedSnapshot(dir, makeSnapshot('sess-late', 'architect'));
			await loadSnapshot(dir);
			expect(swarmState.agentSessions.has('sess-late')).toBe(true);

			// The old generation's callback finally settles.
			releaseGate1?.();
			await gen1;

			// Fence: gen-1's rehydrateState was superseded with zero
			// mutation — its snapshot's session is NOT resurrected, and the
			// newer generation's state stands.
			expect(swarmState.agentSessions.has('sess-coord-old')).toBe(false);
			expect(swarmState.agentSessions.has('sess-late')).toBe(true);
			expect(getSnapshotCoordinationStatus(dir).state).toBe('superseded');

			// Recovery: retry (entry deletion + fresh generation) still
			// applies fresh state through the shared never-reset counter.
			// Own-replace semantics: the retry's newer generation replaces the
			// project's older snapshot-derived entry (sess-late, stamped at
			// generation 2), so only the fresh snapshot's session remains.
			writeSnapshotRows(dir, makeSnapshot('sess-coord-new', 'coder'));
			await retrySnapshotCoordinationInitialization(dir);
			expect(swarmState.agentSessions.has('sess-coord-new')).toBe(true);
			expect(swarmState.agentSessions.has('sess-late')).toBe(false);
			expect(getSnapshotCoordinationStatus(dir).state).toBe('succeeded');
		} finally {
			// PRR-003: release the gate in the finally too, so a failed
			// assertion cannot leave a permanently unsettled entry (its T+10s
			// withTimeout advisory would fire mid-run of a co-run sibling).
			releaseGate1?.();
			_snapshotCoordinationInternals.initialize = realInitialize;
		}
	}, 20_000);
});
