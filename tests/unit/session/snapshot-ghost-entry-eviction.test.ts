/**
 * Regression tests: rehydrateState must not resurrect ghost activeAgent /
 * delegationChains entries from old snapshots.
 *
 * Prior behavior under test: rehydrateState restored activeAgent and
 * delegationChains WHOLESALE, with no filtering against the restored
 * agentSessions. Snapshots written before eviction existed carry entries for
 * long-dead sessions (observed in production: 69 activeAgent entries, only 23
 * agentSessions — 46 ghosts). Once resurrected, nothing could ever evict the
 * ghosts (sweepStaleSessions iterates agentSessions only), so the snapshot
 * writer re-serialized them on every tool call and state.json grew without
 * bound across restarts.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import * as path from 'node:path';
import {
	loadSnapshot,
	rehydrateState,
} from '../../../src/session/snapshot-reader';
import type {
	SerializedAgentSession,
	SnapshotData,
} from '../../../src/session/snapshot-writer';
import { writeSnapshot } from '../../../src/session/snapshot-writer';
import { resetSwarmState, swarmState } from '../../../src/state';
import { canonicalTmpDir } from '../../helpers/tmpdir.js';

const TEST_TIME = 1_700_000_000_000;

function makeSerializedSession(agentName: string): SerializedAgentSession {
	return {
		agentName,
		lastToolCallTime: TEST_TIME,
		lastAgentEventTime: TEST_TIME,
		delegationActive: false,
		activeInvocationId: 1,
		lastInvocationIdByAgent: {},
		windows: {},
		lastCompactionHint: 0,
		architectWriteCount: 0,
		lastCoderDelegationTaskId: null,
		currentTaskId: null,
		gateLog: {},
		reviewerCallCount: {},
		lastGateFailure: null,
		partialGateWarningsIssuedForTask: [],
		selfFixAttempted: false,
		catastrophicPhaseWarnings: [],
		lastPhaseCompleteTimestamp: 0,
		lastPhaseCompletePhase: 0,
		phaseAgentsDispatched: [],
		qaSkipCount: 0,
		qaSkipTaskIds: [],
	};
}

function makeGhostSnapshot(): SnapshotData {
	return {
		version: 3,
		writtenAt: TEST_TIME,
		toolAggregates: {},
		activeAgent: {
			'live-a': 'architect',
			'live-b': 'coder',
			'ghost-1': 'reviewer',
			'ghost-2': 'coder',
			'malformed-c': 'test_engineer',
		},
		delegationChains: {
			'live-a': [{ from: 'architect', to: 'coder', timestamp: TEST_TIME }],
			'ghost-1': [{ from: 'architect', to: 'reviewer', timestamp: TEST_TIME }],
		},
		agentSessions: {
			'live-a': makeSerializedSession('architect'),
			'live-b': makeSerializedSession('coder'),
			// Malformed: fails the required-field validation in rehydrateState
			// (agentName must be a string), so the session itself is skipped.
			'malformed-c': {
				...makeSerializedSession('test_engineer'),
				agentName: undefined as unknown as string,
			},
		},
	};
}

beforeEach(() => {
	resetSwarmState();
});

afterEach(() => {
	resetSwarmState();
});

describe('rehydrateState — regression: ghost satellite entries resurrected wholesale', () => {
	it('restores activeAgent only for sessions restored into agentSessions', async () => {
		await rehydrateState(makeGhostSnapshot());

		// Previous code restored all five activeAgent entries; the two ghosts
		// and the malformed session's entry then leaked forever.
		expect([...swarmState.activeAgent.keys()].sort()).toEqual([
			'live-a',
			'live-b',
		]);
		expect(swarmState.activeAgent.get('live-a')).toBe('architect');
		expect(swarmState.activeAgent.get('live-b')).toBe('coder');
	});

	it('restores delegationChains only for sessions restored into agentSessions', async () => {
		await rehydrateState(makeGhostSnapshot());

		expect([...swarmState.delegationChains.keys()]).toEqual(['live-a']);
		expect(swarmState.delegationChains.get('live-a')).toEqual([
			{ from: 'architect', to: 'coder', timestamp: TEST_TIME },
		]);
	});

	it('drops the satellite entries of a session rejected as malformed', async () => {
		await rehydrateState(makeGhostSnapshot());

		expect(swarmState.agentSessions.has('malformed-c')).toBe(false);
		expect(swarmState.activeAgent.has('malformed-c')).toBe(false);
	});

	it('restores nothing into satellite maps when agentSessions is empty', async () => {
		const snapshot = makeGhostSnapshot();
		snapshot.agentSessions = {};

		await rehydrateState(snapshot);

		expect(swarmState.activeAgent.size).toBe(0);
		expect(swarmState.delegationChains.size).toBe(0);
	});

	it('filters ghosts from version-2 snapshots (the shape shipped in production)', async () => {
		const snapshot = makeGhostSnapshot();
		snapshot.version = 2;

		await rehydrateState(snapshot);

		expect([...swarmState.activeAgent.keys()].sort()).toEqual([
			'live-a',
			'live-b',
		]);
	});
});

describe('snapshot round-trip — the rewritten snapshot shrinks', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(path.join(canonicalTmpDir(), 'snapshot-ghost-'));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it('loadSnapshot end-to-end: restores live entries, filters ghosts', async () => {
		const sessionDir = path.join(tempDir, '.swarm', 'session');
		mkdirSync(sessionDir, { recursive: true });
		writeFileSync(
			path.join(sessionDir, 'state.json'),
			JSON.stringify(makeGhostSnapshot(), null, 2),
		);

		await loadSnapshot(tempDir);

		expect([...swarmState.agentSessions.keys()].sort()).toEqual([
			'live-a',
			'live-b',
		]);
		expect(swarmState.activeAgent.get('live-a')).toBe('architect');
		expect(swarmState.activeAgent.get('live-b')).toBe('coder');
		expect(swarmState.activeAgent.has('ghost-1')).toBe(false);
		expect(swarmState.activeAgent.has('ghost-2')).toBe(false);
		expect(swarmState.delegationChains.has('ghost-1')).toBe(false);
	});

	it('writes back exactly one activeAgent entry per restored session', async () => {
		const ghostSnapshot = makeGhostSnapshot();
		expect(Object.keys(ghostSnapshot.activeAgent).length).toBe(5);

		await rehydrateState(ghostSnapshot);
		await writeSnapshot(tempDir, swarmState);

		const written = JSON.parse(
			readFileSync(
				path.join(tempDir, '.swarm', 'session', 'state.json'),
				'utf-8',
			),
		) as SnapshotData;

		const sessionIds = Object.keys(written.agentSessions).sort();
		expect(sessionIds).toEqual(['live-a', 'live-b']);
		// The load → write cycle previously preserved all five entries; now the
		// satellite maps carry no keys outside the restored session set.
		expect(Object.keys(written.activeAgent).sort()).toEqual(sessionIds);
		expect(Object.keys(written.delegationChains)).toEqual(['live-a']);
	});
});
