/**
 * Focused tests for Stage B state advancement when council mode is active.
 *
 * Council mode is additive at phase level — it must never suppress per-task
 * Stage B gate recording. These tests verify the fix for F5/F6: after removing
 * the `if (!councilActive)` guards in delegation-gate.ts, reviewer and
 * test_engineer Task delegations advance task state unconditionally.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PluginConfig } from '../../../src/config';
import { getOrCreateProfile, setGates } from '../../../src/db/qa-gate-profile';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import {
	ensureAgentSession,
	getTaskState,
	resetSwarmState,
	startAgentSession,
} from '../../../src/state';

function derivePlanId(plan: { swarm: string; title: string }): string {
	return `${plan.swarm}-${plan.title}`.replace(/[^a-zA-Z0-9-_]/g, '_');
}

const PLAN_FIXTURE = {
	schema_version: '1.0.0' as const,
	title: 'council-phase-test',
	swarm: 'default',
	current_phase: 1,
	phases: [
		{
			id: 1,
			name: 'Phase 1',
			status: 'in_progress' as const,
			tasks: [
				{
					id: '1.1',
					phase: 1,
					status: 'in_progress' as const,
					size: 'small' as const,
					description: 'phase test task',
					depends: [],
					files_touched: [],
				},
			],
		},
	],
};
const PLAN_ID = derivePlanId(PLAN_FIXTURE);

function makeConfig(council?: { enabled?: boolean }): PluginConfig {
	return {
		max_iterations: 5,
		qa_retry_limit: 3,
		inject_phase_reminders: true,
		hooks: {
			system_enhancer: true,
			compaction: true,
			agent_activity: true,
			delegation_tracker: false,
			agent_awareness_max_chars: 300,
			delegation_gate: true,
			delegation_max_chars: 4000,
		},
		...(council ? { council } : {}),
	} as PluginConfig;
}

let tmpDir: string;
let origCwd: string;

function writePlan(): void {
	writeFileSync(
		path.join(tmpDir, '.swarm', 'plan.json'),
		JSON.stringify(PLAN_FIXTURE),
	);
}

function enableCouncilGate(): void {
	getOrCreateProfile(tmpDir, PLAN_ID);
	setGates(tmpDir, PLAN_ID, { council_mode: true });
}

beforeEach(() => {
	resetSwarmState();
	origCwd = process.cwd();
	tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dg-council-phase-'));
	mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });
	process.chdir(tmpDir);
});

afterEach(() => {
	process.chdir(origCwd);
	resetSwarmState();
	try {
		rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		/* best effort — Windows may hold locks on SQLite files briefly */
	}
});

describe('Stage B runs per-task when council mode is active', () => {
	it('reviewer Task delegation advances state from coder_delegated → reviewer_run', async () => {
		writePlan();
		enableCouncilGate();

		const config = makeConfig({ enabled: true });
		const hook = createDelegationGateHook(config, tmpDir);

		startAgentSession('sess-phase-rev', 'architect');
		const session = ensureAgentSession('sess-phase-rev');
		session.currentTaskId = '1.1';
		session.taskWorkflowStates.set('1.1', 'coder_delegated');

		await hook.toolAfter(
			{
				tool: 'Task',
				sessionID: 'sess-phase-rev',
				callID: 'call-phase-rev-1',
				args: { subagent_type: 'reviewer' },
			},
			{},
		);

		expect(getTaskState(session, '1.1')).toBe('reviewer_run');
	});

	it('test_engineer Task delegation advances state from reviewer_run → tests_run', async () => {
		writePlan();
		enableCouncilGate();

		const config = makeConfig({ enabled: true });
		const hook = createDelegationGateHook(config, tmpDir);

		startAgentSession('sess-phase-te', 'architect');
		const session = ensureAgentSession('sess-phase-te');
		session.currentTaskId = '1.1';
		session.taskWorkflowStates.set('1.1', 'reviewer_run');

		await hook.toolAfter(
			{
				tool: 'Task',
				sessionID: 'sess-phase-te',
				callID: 'call-phase-te-1',
				args: { subagent_type: 'test_engineer' },
			},
			{},
		);

		expect(getTaskState(session, '1.1')).toBe('tests_run');
	});

	it('both reviewer and test_engineer delegations produce correct final state', async () => {
		writePlan();
		enableCouncilGate();

		const config = makeConfig({ enabled: true });
		const hook = createDelegationGateHook(config, tmpDir);

		startAgentSession('sess-phase-both', 'architect');
		const session = ensureAgentSession('sess-phase-both');
		session.currentTaskId = '1.1';
		session.taskWorkflowStates.set('1.1', 'coder_delegated');

		await hook.toolAfter(
			{
				tool: 'Task',
				sessionID: 'sess-phase-both',
				callID: 'call-phase-both-rev',
				args: { subagent_type: 'reviewer' },
			},
			{},
		);
		expect(getTaskState(session, '1.1')).toBe('reviewer_run');

		await hook.toolAfter(
			{
				tool: 'Task',
				sessionID: 'sess-phase-both',
				callID: 'call-phase-both-te',
				args: { subagent_type: 'test_engineer' },
			},
			{},
		);
		expect(getTaskState(session, '1.1')).toBe('tests_run');
	});
});
