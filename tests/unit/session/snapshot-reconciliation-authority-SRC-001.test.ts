/**
 * SRC-001: restart-reconciliation writes must not reopen a superseded
 * hydration's shared-state publication window.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { beginHydrationScope } from '../../../src/session/hydration-ownership';
import { readRestartReconciliation } from '../../../src/session/restart-reconciliation';
import {
	rehydrateState,
	_internals as snapshotReaderInternals,
} from '../../../src/session/snapshot-reader';
import type { SnapshotData } from '../../../src/session/snapshot-writer';
import { resetSwarmState, swarmState } from '../../../src/state';
import { safeRmRecursive } from '../../helpers/safe-test-dir';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const SESSION = 'src-001-same-session';
const originalRecordInterruptedExecution =
	snapshotReaderInternals.recordInterruptedExecution;

let project: string;

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((complete) => {
		resolve = complete;
	});
	return { promise, resolve };
}

function snapshot(
	agentName: string,
	taskId: string,
	delegationActive: boolean,
): SnapshotData {
	return {
		version: 3,
		writtenAt: 1,
		toolAggregates: {},
		activeAgent: { [SESSION]: agentName },
		delegationChains: {},
		agentSessions: {
			[SESSION]: {
				agentName,
				lastToolCallTime: 1,
				lastAgentEventTime: 1,
				delegationActive,
				currentTaskId: taskId,
			},
		},
	} as unknown as SnapshotData;
}

beforeEach(() => {
	project = canonicalMkdtemp('snapshot-reconcile-src-001-');
	mkdirSync(path.join(project, '.swarm', 'session'), { recursive: true });
	snapshotReaderInternals.recordInterruptedExecution =
		originalRecordInterruptedExecution;
	resetSwarmState();
});

afterEach(() => {
	snapshotReaderInternals.recordInterruptedExecution =
		originalRecordInterruptedExecution;
	resetSwarmState();
	safeRmRecursive(project);
});

describe('restart reconciliation hydration authority (SRC-001)', () => {
	test('superseded write cannot publish stale session or advisory', async () => {
		// Before the fix, the old hydration awaited this durable write after it
		// had started applying its snapshot, then published its stale session and
		// advisory over the newer hydration when the write resolved.
		const writeStarted = deferred<void>();
		const releaseWrite = deferred<void>();
		snapshotReaderInternals.recordInterruptedExecution = async (
			directory,
			entry,
		) => {
			writeStarted.resolve();
			await releaseWrite.promise;
			return originalRecordInterruptedExecution(directory, entry);
		};

		const oldScope = beginHydrationScope(project);
		const oldApply = rehydrateState(
			snapshot('architect', 'old-task', true),
			project,
			oldScope,
		);
		await writeStarted.promise;

		const newScope = beginHydrationScope(project);
		const newOutcome = await rehydrateState(
			snapshot('coder', 'new-task', false),
			project,
			newScope,
		);
		expect(newOutcome).toEqual({ applied: true });
		const newerSession = swarmState.agentSessions.get(SESSION);
		expect(newerSession?.agentName).toBe('coder');
		expect(newerSession?.currentTaskId).toBe('new-task');

		releaseWrite.resolve();
		const oldOutcome = await oldApply;

		expect(oldOutcome).toEqual({ applied: false, reason: 'superseded' });
		expect(swarmState.agentSessions.get(SESSION)).toBe(newerSession);
		expect(newerSession?.pendingAdvisoryMessages ?? []).toHaveLength(0);
		expect(
			swarmState.agentSessions.get(SESSION)?.pendingAdvisoryMessages ?? [],
		).toHaveLength(0);
		expect(readRestartReconciliation(project).entries).toContainEqual(
			expect.objectContaining({
				sessionId: SESSION,
				taskId: 'old-task',
				classification: 'interrupted',
			}),
		);
	});
});
