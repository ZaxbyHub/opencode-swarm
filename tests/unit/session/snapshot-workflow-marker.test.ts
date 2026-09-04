import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TASK_WORKFLOW_SCHEMA_MARKER } from '../../../src/gate-evidence';
import { rehydrateState } from '../../../src/session/snapshot-reader';
import type { SnapshotData } from '../../../src/session/snapshot-writer';
import {
	SNAPSHOT_PROJECTION_FILE,
	writeSnapshot,
} from '../../../src/session/snapshot-writer';
import {
	ensureAgentSession,
	resetSwarmState,
	swarmState,
} from '../../../src/state';
import { safeRmRecursive } from '../../helpers/safe-test-dir';
import { canonicalTmpDir } from '../../helpers/tmpdir.js';

const TEST_TIME = 1_700_000_000_000;

describe('snapshot workflow marker', () => {
	let tempDir: string;

	beforeEach(() => {
		resetSwarmState();
		tempDir = mkdtempSync(
			path.join(canonicalTmpDir(), 'snapshot-workflow-marker-'),
		);
	});

	afterEach(() => {
		resetSwarmState();
		safeRmRecursive(tempDir);
	});

	it('writes version 3 snapshots with the exact-task workflow marker', async () => {
		const session = ensureAgentSession('writer-session', 'architect');
		session.taskWorkflowStates.set('1.1', 'rework_required');

		await writeSnapshot(tempDir, swarmState);

		const written = JSON.parse(
			readFileSync(
				path.join(tempDir, '.swarm', SNAPSHOT_PROJECTION_FILE),
				'utf-8',
			),
		) as SnapshotData;
		expect(written.version).toBe(3);
		expect(written.workflowSchema).toBe(TASK_WORKFLOW_SCHEMA_MARKER);
		expect(
			written.agentSessions['writer-session']?.taskWorkflowStates?.['1.1'],
		).toBe('rework_required');
	});

	it('discards legacy workflow caches when the marker is absent', async () => {
		const legacySnapshot: SnapshotData = {
			version: 2,
			writtenAt: TEST_TIME,
			toolAggregates: {},
			activeAgent: {},
			delegationChains: {},
			agentSessions: {
				legacy: {
					agentName: 'architect',
					lastToolCallTime: TEST_TIME,
					lastAgentEventTime: TEST_TIME,
					delegationActive: false,
					activeInvocationId: 0,
					lastInvocationIdByAgent: {},
					windows: {},
					lastCompactionHint: 0,
					architectWriteCount: 0,
					lastCoderDelegationTaskId: null,
					currentTaskId: null,
					turboMode: false,
					gateLog: {},
					reviewerCallCount: {},
					lastGateFailure: null,
					partialGateWarningsIssuedForTask: [],
					completionGateWarnedForTask: [],
					selfFixAttempted: false,
					selfCodingWarnedAtCount: 0,
					catastrophicPhaseWarnings: [],
					lastPhaseCompleteTimestamp: 0,
					lastPhaseCompletePhase: 0,
					phaseAgentsDispatched: [],
					lastCompletedPhaseAgentsDispatched: [],
					qaSkipCount: 0,
					qaSkipTaskIds: [],
					pendingAdvisoryMessages: [],
					taskWorkflowStates: { '1.1': 'complete' },
					stageBCompletion: { '1.1': ['reviewer', 'test_engineer'] },
					model_fallback_index: 0,
					modelFallbackExhausted: false,
					coderRevisions: 0,
					revisionLimitHit: false,
				},
			},
		};

		await rehydrateState(legacySnapshot);

		const session = swarmState.agentSessions.get('legacy');
		expect(session?.taskWorkflowStates.size).toBe(0);
		expect(session?.stageBCompletion?.size).toBe(0);
	});

	it('discards marked workflow projections so exact evidence remains authoritative', async () => {
		const markedSnapshot: SnapshotData = {
			version: 3,
			workflowSchema: TASK_WORKFLOW_SCHEMA_MARKER,
			writtenAt: TEST_TIME,
			toolAggregates: {},
			activeAgent: {},
			delegationChains: {},
			agentSessions: {
				marked: {
					agentName: 'architect',
					lastToolCallTime: TEST_TIME,
					lastAgentEventTime: TEST_TIME,
					delegationActive: false,
					activeInvocationId: 0,
					lastInvocationIdByAgent: {},
					windows: {},
					lastCompactionHint: 0,
					architectWriteCount: 0,
					lastCoderDelegationTaskId: null,
					currentTaskId: null,
					turboMode: false,
					gateLog: {},
					reviewerCallCount: {},
					lastGateFailure: null,
					partialGateWarningsIssuedForTask: [],
					completionGateWarnedForTask: [],
					selfFixAttempted: false,
					selfCodingWarnedAtCount: 0,
					catastrophicPhaseWarnings: [],
					lastPhaseCompleteTimestamp: 0,
					lastPhaseCompletePhase: 0,
					phaseAgentsDispatched: [],
					lastCompletedPhaseAgentsDispatched: [],
					qaSkipCount: 0,
					qaSkipTaskIds: [],
					pendingAdvisoryMessages: [],
					taskWorkflowStates: { '2.1': 'rework_required' },
					stageBCompletion: { '2.1': ['reviewer'] },
					model_fallback_index: 0,
					modelFallbackExhausted: false,
					coderRevisions: 0,
					revisionLimitHit: false,
				},
			},
		};

		await rehydrateState(markedSnapshot);

		const session = swarmState.agentSessions.get('marked');
		expect(session?.taskWorkflowStates.size).toBe(0);
		expect(session?.stageBCompletion?.size).toBe(0);
	});
});
