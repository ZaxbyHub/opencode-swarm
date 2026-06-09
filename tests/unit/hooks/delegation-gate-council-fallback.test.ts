/**
 * Tests for fallback delegation-chain path with council mode active.
 *
 * When council mode is active, the fallback path (delegationChains) skips
 * Stage B advancement — council replaces Stage B per-task. qaSkip reset
 * still runs (it's outside the council guard).
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
	swarmState,
} from '../../../src/state';

function derivePlanId(plan: { swarm: string; title: string }): string {
	return `${plan.swarm}-${plan.title}`.replace(/[^a-zA-Z0-9-_]/g, '_');
}

const PLAN_FIXTURE = {
	schema_version: '1.0.0' as const,
	title: 'council-fallback-test',
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
					description: 'fallback test task',
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
	tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dg-council-fallback-'));
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

describe('Fallback path Stage B SKIPPED with council mode active', () => {
	it('fallback path does NOT advance states when council replaces Stage B', async () => {
		writePlan();
		enableCouncilGate();

		const config = makeConfig({ enabled: true });
		const hook = createDelegationGateHook(config, tmpDir);

		startAgentSession('sess-fb-test', 'architect');
		const session = ensureAgentSession('sess-fb-test');
		session.currentTaskId = '1.1';
		session.taskWorkflowStates.set('1.1', 'coder_delegated');

		// Set delegationChains on swarmState (not session) to trigger fallback path.
		// The fallback path looks up delegationChains via swarmState.delegationChains.get(sessionID).
		// Must include a 'coder' delegation for the fallback path to execute advancement logic.
		swarmState.delegationChains.set('sess-fb-test', [
			{
				from: 'architect',
				to: 'coder',
				delegatedAt: new Date().toISOString(),
			},
			{
				from: 'coder',
				to: 'reviewer',
				delegatedAt: new Date().toISOString(),
			},
			{
				from: 'reviewer',
				to: 'test_engineer',
				delegatedAt: new Date().toISOString(),
			},
		]);

		// Trigger toolAfter without stored args to force fallback path usage.
		// Empty args object should force reliance on delegationChains.
		await hook.toolAfter(
			{
				tool: 'Task',
				sessionID: 'sess-fb-test',
				callID: 'call-fb-1',
				args: {}, // Empty args triggers fallback path
			},
			{},
		);

		// Stage B is skipped when council replaces it — state stays at coder_delegated.
		expect(getTaskState(session, '1.1')).toBe('coder_delegated');
	});

	it('fallback path does NOT advance states even with both reviewer and test_engineer in chain', async () => {
		writePlan();
		enableCouncilGate();

		const config = makeConfig({ enabled: true });
		const hook = createDelegationGateHook(config, tmpDir);

		startAgentSession('sess-fb-both', 'architect');
		const session = ensureAgentSession('sess-fb-both');
		session.currentTaskId = '1.1';
		session.taskWorkflowStates.set('1.1', 'coder_delegated');

		// Set delegationChains on swarmState (must include 'coder')
		swarmState.delegationChains.set('sess-fb-both', [
			{
				from: 'architect',
				to: 'coder',
				delegatedAt: new Date().toISOString(),
			},
			{
				from: 'coder',
				to: 'reviewer',
				delegatedAt: new Date().toISOString(),
			},
			{
				from: 'reviewer',
				to: 'test_engineer',
				delegatedAt: new Date().toISOString(),
			},
		]);

		await hook.toolAfter(
			{
				tool: 'Task',
				sessionID: 'sess-fb-both',
				callID: 'call-fb-both-1',
				args: {},
			},
			{},
		);

		// Stage B is skipped when council replaces it — state stays at coder_delegated.
		expect(getTaskState(session, '1.1')).toBe('coder_delegated');
	});

	it('fallback path still resets qaSkip when both reviewer and test_engineer seen (qaSkip is outside council guard)', async () => {
		writePlan();
		enableCouncilGate();

		const config = makeConfig({ enabled: true });
		const hook = createDelegationGateHook(config, tmpDir);

		startAgentSession('sess-fb-qa', 'architect');
		const session = ensureAgentSession('sess-fb-qa');
		session.currentTaskId = '1.1';
		session.taskWorkflowStates.set('1.1', 'coder_delegated');

		// Set qaSkip state (should be reset when both roles seen)
		session.qaSkipCount = 5;
		session.qaSkipTaskIds = ['1.1'];

		// Set delegationChains on swarmState (must include 'coder')
		swarmState.delegationChains.set('sess-fb-qa', [
			{
				from: 'architect',
				to: 'coder',
				delegatedAt: new Date().toISOString(),
			},
			{
				from: 'coder',
				to: 'reviewer',
				delegatedAt: new Date().toISOString(),
			},
			{
				from: 'reviewer',
				to: 'test_engineer',
				delegatedAt: new Date().toISOString(),
			},
		]);

		await hook.toolAfter(
			{
				tool: 'Task',
				sessionID: 'sess-fb-qa',
				callID: 'call-fb-qa-1',
				args: {},
			},
			{},
		);

		// qaSkip should be reset when both roles are detected in chain
		// (qaSkip reset is outside the council guard)
		expect(session.qaSkipCount).toBe(0);
		expect(session.qaSkipTaskIds).toHaveLength(0);

		// State stays at coder_delegated — Stage B is skipped when council is active
		expect(getTaskState(session, '1.1')).toBe('coder_delegated');
	});
});
