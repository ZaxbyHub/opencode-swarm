/**
 * Issue #3320 AC16 (PRESERVING row — GREEN at base and head): the
 * ACCEPTANCE-field gate keys on the TARGET being a registered swarm agent,
 * not on the caller's identity.
 *
 * A Task dispatch whose target is the swarm agent `coder` must be blocked
 * with `ACCEPTANCE_FIELD_REQUIRED` when the prompt lacks an `ACCEPTANCE:`
 * line — even when the CALLER is a native OpenCode agent (`build`) that
 * issue #3320 exempts from swarm-only policy gates. The gate is target-keyed
 * (see src/hooks/delegation-gate.ts: `targetAgent === 'coder' ||
 * targetAgent === 'reviewer'`), so the native-caller exemption must not
 * widen it. Conversely, Task dispatches to native / unregistered targets
 * (`general`, `explore`) from a build session are NOT gated.
 *
 * This entire file must PASS at base: it pins the non-defect the
 * native-agent exemption has to preserve.
 *
 * Harness mirrors tests/unit/hooks/delegation-gate-acceptance-field.test.ts
 * (real createDelegationGateHook toolBefore over a plan fixture with
 * recorded plan-critic approval).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PluginConfig } from '../../../src/config';
import type { Plan } from '../../../src/config/plan-schema';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import {
	ensureAgentSession,
	resetSwarmState,
	swarmState,
} from '../../../src/state';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env.js';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir';
import { recordPlanCriticApproval } from './_delegation-gate-helpers';

function makeConfig(): PluginConfig {
	return {
		hooks: { delegation_gate: true },
	} as unknown as PluginConfig;
}

describe('Delegation gate ACCEPTANCE — native caller (issue #3320 AC16)', () => {
	let testDir: string;
	let isolatedEnv: ReturnType<typeof createIsolatedTestEnv>;

	beforeEach(async () => {
		isolatedEnv = createIsolatedTestEnv();
		resetSwarmState();
		testDir = canonicalMkdtemp('native-caller-acceptance-');
		fs.mkdirSync(path.join(testDir, '.swarm'), { recursive: true });
		fs.mkdirSync(path.join(testDir, '.opencode'), { recursive: true });
		const plan: Plan = {
			schema_version: '1.0.0',
			title: 'Native caller acceptance pinning',
			swarm: 'test',
			current_phase: 1,
			phases: [
				{
					id: 1,
					name: 'Implementation',
					status: 'in_progress',
					tasks: [
						{
							id: '1.1',
							phase: 1,
							status: 'pending',
							size: 'small',
							description: 'Pins the target-keyed ACCEPTANCE gate',
							depends: [],
							files_touched: ['src/foo.ts'],
						},
					],
				},
			],
		};
		fs.writeFileSync(
			path.join(testDir, '.swarm', 'plan.json'),
			JSON.stringify(plan),
		);
		await recordPlanCriticApproval(testDir, plan);
	});

	afterEach(() => {
		resetSwarmState();
		removeTreeWithRetry(testDir);
		isolatedEnv.cleanup();
	});

	/** Establishes a build-caller session the way chat.message does. */
	function seedBuildCaller(sessionId: string): void {
		swarmState.activeAgent.set(sessionId, 'build');
		ensureAgentSession(sessionId, 'build');
	}

	it('build dispatching Task to coder WITHOUT ACCEPTANCE is blocked (GREEN at base and head)', async () => {
		const hooks = createDelegationGateHook(makeConfig(), testDir);
		seedBuildCaller('sess-build-coder');
		// The gate is keyed on the TARGET (coder) being a registered swarm
		// agent; the native-agent caller exemption must not widen it.
		await expect(
			hooks.toolBefore(
				{
					tool: 'Task',
					sessionID: 'sess-build-coder',
					callID: 'call-build-coder',
				},
				{ args: { prompt: 'fix it', subagent_type: 'coder' } },
			),
		).rejects.toThrow('ACCEPTANCE_FIELD_REQUIRED');
	});

	it('build dispatching Task to general is NOT blocked (GREEN at base and head)', async () => {
		const hooks = createDelegationGateHook(makeConfig(), testDir);
		seedBuildCaller('sess-build-general');
		// Resolving (no throw of ANY kind) proves no gate fired — stronger
		// than asserting "not ACCEPTANCE_FIELD_REQUIRED".
		await expect(
			hooks.toolBefore(
				{
					tool: 'Task',
					sessionID: 'sess-build-general',
					callID: 'call-build-general',
				},
				{ args: { prompt: 'fix it', subagent_type: 'general' } },
			),
		).resolves.toBeUndefined();
	});

	it('build dispatching Task to explore is NOT blocked (GREEN at base and head)', async () => {
		const hooks = createDelegationGateHook(makeConfig(), testDir);
		seedBuildCaller('sess-build-explore');
		await expect(
			hooks.toolBefore(
				{
					tool: 'Task',
					sessionID: 'sess-build-explore',
					callID: 'call-build-explore',
				},
				{ args: { prompt: 'fix it', subagent_type: 'explore' } },
			),
		).resolves.toBeUndefined();
	});

	it('build dispatching Task to coder WITH ACCEPTANCE is NOT blocked by the acceptance gate (GREEN at base and head)', async () => {
		const hooks = createDelegationGateHook(makeConfig(), testDir);
		seedBuildCaller('sess-build-coder-ok');
		// Positive control: the block keys on the MISSING field, not on the
		// caller — a compliant dispatch from build resolves.
		await expect(
			hooks.toolBefore(
				{
					tool: 'Task',
					sessionID: 'sess-build-coder-ok',
					callID: 'call-build-coder-ok',
				},
				{
					args: {
						// TASK: 1.1 resolves the plan task so the scope preflight can
						// bind (without it the dispatch dies at SCOPE_NOT_DECLARED,
						// a different gate than the one pinned here).
						prompt:
							'TASK: 1.1\nfix it\nACCEPTANCE: FR-001 the feature works and is tested',
						subagent_type: 'coder',
					},
				},
			),
		).resolves.toBeUndefined();
	});
});
