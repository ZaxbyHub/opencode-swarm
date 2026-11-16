/**
 * Lean Turbo never bypasses Stage B in update_task_status (issue #3165 E).
 *
 * checkReviewerGate used to admit a task without Stage B evidence when Lean
 * Turbo was active in ANY session and the task sat in a completed lane with
 * lane evidence on disk ("Lean Turbo bypass"). That branch and its verifier
 * (src/turbo/lean/task-completion.ts) are removed: completion applies the same
 * exact-task Stage B rule in every mode. These tests set up the exact state
 * that used to earn the bypass and assert the gate still blocks.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import {
	hasActiveLeanTurbo,
	resetSwarmState,
	startAgentSession,
	swarmState,
} from '../../../src/state';
import { checkReviewerGate } from '../../../src/tools/update-task-status';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const TASK_ID = '1.1';
const LANE_ID = 'lane-1';

let tmpDir: string;

function writeSwarmFile(relPath: string, value: unknown): void {
	const full = path.join(tmpDir, '.swarm', relPath);
	mkdirSync(path.dirname(full), { recursive: true });
	writeFileSync(full, JSON.stringify(value));
}

/** plan.json + turbo-state.json + lane evidence that formerly earned the bypass. */
function writeCompletedLeanLaneState(): void {
	const now = '2026-01-01T00:00:00.000Z'; // fixed: no clock needed
	writeSwarmFile('plan.json', {
		schema_version: '1.0.0',
		title: 'Lean Turbo Test Plan',
		swarm: 'lean-turbo-test',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'in_progress',
				tasks: [
					{
						id: TASK_ID,
						phase: 1,
						status: 'in_progress',
						size: 'small',
						description: `task ${TASK_ID}`,
						depends: [],
						files_touched: ['src/utils.ts'],
					},
				],
			},
		],
	});
	writeSwarmFile('turbo-state.json', {
		version: 1,
		updatedAt: now,
		sessions: {
			'session-lean': {
				status: 'running',
				sessionID: 'session-lean',
				strategy: 'lean',
				phase: 1,
				maxParallelCoders: 2,
				lanes: [
					{
						laneId: LANE_ID,
						taskIds: [TASK_ID],
						files: ['src/utils.ts'],
						status: 'completed',
						startedAt: now,
						completedAt: now,
					},
				],
				degradedTasks: [],
				counters: {
					lanesPlanned: 1,
					lanesStarted: 1,
					lanesCompleted: 1,
					lanesFailed: 0,
					tasksSerialized: 1,
					tasksDegraded: 0,
				},
			},
		},
	});
	writeSwarmFile(path.join('evidence', '1', 'lean-turbo', `${LANE_ID}.json`), {
		laneId: LANE_ID,
		status: 'completed',
	});
}

function startLeanTurboSession(sessionId: string): void {
	startAgentSession(sessionId, 'architect');
	const session = swarmState.agentSessions.get(sessionId);
	expect(session).toBeDefined();
	session!.turboMode = true;
	session!.turboStrategy = 'lean';
	session!.leanTurboActive = true;
}

describe('update_task_status gate: Lean Turbo does not bypass Stage B', () => {
	beforeEach(() => {
		resetSwarmState();
		tmpDir = canonicalMkdtemp('lean-turbo-gate-test-');
		writeCompletedLeanLaneState();
		startLeanTurboSession('session-lean');
		// Precondition: the setup really is "Lean Turbo active".
		expect(hasActiveLeanTurbo()).toBe(true);
		expect(hasActiveLeanTurbo('session-lean')).toBe(true);
	});

	afterEach(() => {
		resetSwarmState();
		try {
			rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			/* best-effort */
		}
	});

	it('blocks a direct caller (no session, no fallbackDir) for a completed-lane task', () => {
		const result = checkReviewerGate(TASK_ID, tmpDir);
		expect(result.blocked).toBe(true);
		expect(result.reason).not.toContain('Lean Turbo bypass');
		expect(result.reason).toContain(`Task ${TASK_ID} has not passed QA gates`);
	});

	it('blocks a session-scoped call from the Lean Turbo session itself', () => {
		const result = checkReviewerGate(
			TASK_ID,
			tmpDir,
			true,
			'session-lean',
			tmpDir,
		);
		expect(result.blocked).toBe(true);
		expect(result.reason).not.toContain('Lean Turbo bypass');
		expect(result.reason).toContain(
			`Task ${TASK_ID} has no exact-task QA evidence`,
		);
	});
});
