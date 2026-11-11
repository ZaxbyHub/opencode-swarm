/**
 * Turbo Mode never bypasses Stage B (issue #3165 section E).
 *
 * `checkReviewerGate` used to carry a "Turbo Mode bypass" that admitted a
 * task whose `files_touched` matched no Tier-3 pattern whenever ANY session
 * had Turbo Mode on — but only for direct callers that passed neither a
 * sessionID nor a fallbackDir. That branch is gone: completion applies the
 * same exact-task Stage B rule in every mode, and Turbo state can neither
 * satisfy nor change the gate decision.
 *
 * The final describe pins the executeUpdateTaskStatus symptom: a session-less
 * completion with Turbo on used to be admitted by the pre-lock advisory check
 * and then refused under the lock as TASK_COMPLETION_CAS_MISMATCH instead of
 * the normal "Gate check failed" result.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { canonicalMkdtemp } from '../../tests/helpers/tmpdir';
import { resetSwarmState, startAgentSession, swarmState } from '../state';
import {
	checkReviewerGate,
	executeUpdateTaskStatus,
} from './update-task-status';

/** Reason from the exact-task check (session-scoped or fallbackDir callers). */
const NO_EVIDENCE_REASON = 'has no exact-task QA evidence';
/** Reason from the legacy direct-caller path (no sessionID, no fallbackDir). */
const LEGACY_BLOCKED_REASON = 'has not passed QA gates';

let tmpDir: string;

beforeEach(() => {
	resetSwarmState();
	tmpDir = canonicalMkdtemp('turbo-no-bypass-test-');
	mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });
});

afterEach(() => {
	resetSwarmState();
	try {
		rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		/* best effort */
	}
});

/** Writes a one-task plan.json; omit `filesTouched` to leave the field unset. */
function writePlan(taskId: string, filesTouched?: string[]): void {
	const task: Record<string, unknown> = {
		id: taskId,
		phase: 1,
		status: 'pending',
		size: 'small',
		description: `task ${taskId}`,
		depends: [],
	};
	if (filesTouched !== undefined) task.files_touched = filesTouched;
	writeFileSync(
		path.join(tmpDir, '.swarm', 'plan.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			title: 'Test',
			swarm: 'test-swarm',
			current_phase: 1,
			migration_status: 'migrated',
			phases: [
				{ id: 1, name: 'Phase 1', status: 'in_progress', tasks: [task] },
			],
		}),
	);
}

function startSession(sessionId: string, turboMode: boolean): void {
	startAgentSession(sessionId, 'architect');
	const session = swarmState.agentSessions.get(sessionId);
	expect(session).toBeDefined();
	session!.turboMode = turboMode;
}

function expectStageBBlocked(
	result: { blocked: boolean; reason: string },
	expectedReason: string,
) {
	expect(result.blocked).toBe(true);
	expect(result.reason).not.toBe('Turbo Mode bypass');
	expect(result.reason).toContain(expectedReason);
}

describe('checkReviewerGate: Turbo Mode does not bypass Stage B', () => {
	it.each([
		['non-Tier-3 files', ['src/utils.ts', 'src/helpers.ts']],
		[
			'several non-Tier-3 files',
			[
				'src/components/Button.tsx',
				'src/hooks/useCustom.ts',
				'tests/unit.test.ts',
			],
		],
		['Tier-3 files', ['src/architect.ts', 'src/auth.ts']],
		['an explicitly empty files_touched', []],
		['no files_touched field', undefined],
	] as Array<
		[string, string[] | undefined]
	>)('blocks a task with %s and no Stage B evidence', (_label, filesTouched) => {
		writePlan('1.1', filesTouched);
		startSession('session-1', true);

		expectStageBBlocked(
			checkReviewerGate('1.1', tmpDir),
			LEGACY_BLOCKED_REASON,
		);
		expectStageBBlocked(
			checkReviewerGate('1.1', tmpDir, true, 'session-1', tmpDir),
			NO_EVIDENCE_REASON,
		);
	});

	it('blocks when Turbo Mode is on in a different session than the caller', () => {
		writePlan('2.1', ['src/utils.ts']);
		startSession('session-1', false);
		startSession('session-2', true);

		expectStageBBlocked(
			checkReviewerGate('2.1', tmpDir),
			LEGACY_BLOCKED_REASON,
		);
		expectStageBBlocked(
			checkReviewerGate('2.1', tmpDir, true, 'session-1', tmpDir),
			NO_EVIDENCE_REASON,
		);
	});

	it('blocks a session-scoped call from the Turbo session itself', () => {
		writePlan('2.2', ['src/utils.ts']);
		startSession('session-1', true);

		expectStageBBlocked(
			checkReviewerGate('2.2', tmpDir, true, 'session-1', tmpDir),
			NO_EVIDENCE_REASON,
		);
	});

	it('returns the same decision with Turbo Mode off and on', () => {
		writePlan('2.3', ['src/utils.ts']);
		startSession('session-1', false);
		const turboOff = checkReviewerGate('2.3', tmpDir);
		expectStageBBlocked(turboOff, LEGACY_BLOCKED_REASON);

		swarmState.agentSessions.get('session-1')!.turboMode = true;
		const turboOn = checkReviewerGate('2.3', tmpDir);
		expect(turboOn).toEqual(turboOff);
	});
});

describe('executeUpdateTaskStatus: session-less completion under Turbo Mode', () => {
	it('fails with the normal gate result, not TASK_COMPLETION_CAS_MISMATCH', async () => {
		writePlan('1.1', ['src/utils.ts', 'src/helpers.ts']);
		startSession('turbo-session', true);

		const result = await executeUpdateTaskStatus(
			{ task_id: '1.1', status: 'completed', working_directory: tmpDir },
			tmpDir,
		);

		expect(result.success).toBe(false);
		expect(result.message).toContain('Gate check failed');
		expect(result.message).not.toContain('TASK_COMPLETION_CAS_MISMATCH');
		expect(result.errors?.[0]).toContain(`Task 1.1 ${NO_EVIDENCE_REASON}`);
		for (const error of result.errors ?? []) {
			expect(error).not.toContain('TASK_COMPLETION_CAS_MISMATCH');
		}
	});
});
