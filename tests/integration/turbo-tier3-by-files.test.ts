/**
 * Turbo's Stage A block decides Tier 3 by the task's files at both gate sites.
 *
 * The delegation gate checks Turbo's bypass in two places: when the coder is
 * re-dispatched for a task awaiting Stage A (preflight), and when a coder for
 * ANOTHER task is dispatched while one awaits Stage A (the session loop).
 * Both used `taskId.startsWith('3.')`; both now use the planned files.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import type { PluginConfig } from '../../src/config';
import { closeAllProjectDbs } from '../../src/db/project-db.js';
import { transitionTaskWorkflowEvidence } from '../../src/gate-evidence';
import { createDelegationGateHook } from '../../src/hooks/delegation-gate';
import { ensureAgentSession, resetSwarmState } from '../../src/state';
import { writeApprovedPlan } from '../helpers/approved-plan';
import { canonicalMkdtemp } from '../helpers/tmpdir';

const CONFIG = { hooks: { delegation_gate: true } } as unknown as PluginConfig;
let dir: string;

async function awaitingStageA(taskId: string): Promise<void> {
	await transitionTaskWorkflowEvidence(dir, taskId, {
		type: 'accepted_mutation',
		agentType: 'coder',
		expectedGeneration: 0,
		transitionId: `accepted-${taskId}`,
	});
}

function dispatchCoder(sessionID: string, taskId: string) {
	const session = ensureAgentSession(sessionID, 'architect', dir);
	session.turboMode = true;
	return createDelegationGateHook(CONFIG, dir).toolBefore(
		{ tool: 'Task', sessionID, callID: `call-${taskId}` },
		{
			args: {
				subagent_type: 'coder',
				task_id: taskId,
				prompt: 'Fix it\nACCEPTANCE: task complete and covered by tests',
			},
		},
	);
}

beforeEach(async () => {
	resetSwarmState();
	dir = canonicalMkdtemp('turbo-tier3-int-');
	await writeApprovedPlan(dir, [
		{ id: '1.1', files: ['src/index.ts'] },
		{ id: '1.2', files: ['src/auth/login.ts'] },
		{ id: '3.1', files: ['src/util/format.ts'] },
	]);
});

afterEach(() => {
	resetSwarmState();
	closeAllProjectDbs();
	fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

describe('Turbo Stage A block — preflight (same task re-dispatched)', () => {
	test('a phase-3 task with ordinary files may be re-dispatched', async () => {
		await awaitingStageA('3.1');
		await dispatchCoder('s-pre-1', '3.1');
	});

	test('a phase-1 task touching auth files may not', async () => {
		await awaitingStageA('1.2');
		await expect(dispatchCoder('s-pre-2', '1.2')).rejects.toThrow(
			'STAGE_A_REQUIRED',
		);
	});
});

describe('Turbo Stage A block — another task awaiting Stage A', () => {
	test('an ordinary phase-3 task awaiting Stage A does not block another coder', async () => {
		await awaitingStageA('3.1');
		await dispatchCoder('s-loop-1', '1.1');
	});

	test('a Tier 3 task awaiting Stage A blocks another coder', async () => {
		await awaitingStageA('1.2');
		await expect(dispatchCoder('s-loop-2', '1.1')).rejects.toThrow(
			'STAGE_A_REQUIRED',
		);
	});
});
