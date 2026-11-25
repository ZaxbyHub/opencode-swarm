import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { handleResetSessionCommand } from '../../../src/commands/reset-session';
import type { Plan } from '../../../src/config/plan-schema';
import {
	closeAllProjectDbs,
	listCoordinationStateRowsRaw,
	transitionCoordinationState,
} from '../../../src/db';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import {
	createScopeGuardHook,
	_internals as guardInternals,
} from '../../../src/hooks/scope-guard';
import {
	clearScopeBindings,
	createScopeBinding,
	type ScopeBinding,
} from '../../../src/scope/scope-binding';
import { clearSessionScopeBindingsFromDisk } from '../../../src/scope/scope-persistence';
import {
	ensureAgentSession,
	resetSwarmState,
	startAgentSession,
	swarmState,
} from '../../../src/state';
import { freezeClock, type Restore } from '../../helpers/test-clock.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir';
import {
	makeConfig,
	recordPlanCriticApproval,
} from '../hooks/_delegation-gate-helpers';

// Route-level legs of the #3889 fail-closed contract (final-critic round 1):
// the store-level ledger/resolver legs live in
// scope-failclosed-contract-3889.test.ts.
const plan: Plan = {
	schema_version: '1.0.0',
	title: 'failclosed-routes',
	swarm: 'test',
	current_phase: 1,
	phases: [
		{
			id: 1,
			name: 'P',
			status: 'in_progress',
			tasks: [
				{
					id: '1.1',
					phase: 1,
					status: 'pending',
					size: 'small',
					description: 'd',
					depends: [],
					files_touched: ['src/a.ts'],
				},
			],
		},
	],
};

const roots: string[] = [];
let restoreClock: Restore | undefined;

function fixture(name: string): string {
	const root = canonicalMkdtemp(name);
	roots.push(root);
	return root;
}

function decl(root: string, owner: string, message: string): ScopeBinding {
	const value = createScopeBinding({
		directory: root,
		plan,
		taskId: '1.1',
		files: ['src/a.ts'],
		ownerSessionId: owner,
		ownerMessageId: message,
		source: 'declare_scope',
	});
	if (!value) throw new Error('fixture failed');
	return value;
}

function seedRow(root: string, binding: ScopeBinding): void {
	const seeded = transitionCoordinationState(root, {
		namespace: 'scope-binding',
		entityKey: binding.generationId,
		generation: 1,
		status: 'live',
		payload: JSON.stringify(binding),
	});
	if (seeded.outcome !== 'applied') throw new Error('seed failed');
}

function readLedger(root: string): Record<string, { kind: string }> {
	const rows = listCoordinationStateRowsRaw(root, 'scope-binding-deny', 2);
	const payload = rows.find((row) => row.entityKey === 'deny-ledger')?.payload;
	if (!payload) return {};
	return (JSON.parse(payload) as { entries: Record<string, never> }).entries;
}

beforeEach(() => {
	restoreClock = freezeClock();
});

afterEach(() => {
	restoreClock?.();
	resetSwarmState();
	clearScopeBindings();
	closeAllProjectDbs();
	for (const root of roots.splice(0))
		fs.rmSync(root, { recursive: true, force: true });
});

describe('reset wiring (#3889, final-critic round 1)', () => {
	test('reset-session sweeps the named session durable rows through the sink (M5)', async () => {
		const root = fixture('failclosed-m5-');
		fs.mkdirSync(path.join(root, '.swarm', 'session'), { recursive: true });
		startAgentSession('victim', 'coder');
		const session = swarmState.agentSessions.get('victim');
		if (!session) throw new Error('session was not created');
		session.currentTaskId = '1.1';
		const victim = decl(root, 'victim', 'declare');
		seedRow(root, victim);
		const results = await handleResetSessionCommand(root, [], 'victim');
		const text = Array.isArray(results) ? results.join('\n') : String(results);
		expect(text).toContain('durable scope binding row(s)');
		expect(
			listCoordinationStateRowsRaw(root, 'scope-binding', 10).some(
				(row) => row.entityKey === victim.generationId,
			),
		).toBe(false);
		expect(readLedger(root)[victim.generationId]?.kind).toBe('terminal');
	}, 60_000);
});

describe('scope guard store-unreadable route (#3889, final-critic round 1)', () => {
	test('guard denies without consulting the PR-feedback fallback (M2)', async () => {
		const root = fixture('failclosed-m2-');
		// The taskId resolution route needs a plan on disk before it ever
		// reaches the durable binding store; without it the status is
		// not_declared and the fallback would be legitimately consulted.
		fs.mkdirSync(path.join(root, '.swarm'), { recursive: true });
		fs.writeFileSync(
			path.join(root, '.swarm', 'plan.json'),
			JSON.stringify(plan),
		);
		transitionCoordinationState(root, {
			namespace: 'scope-binding',
			entityKey: 'eeeeeeee-0000-4000-a000-000000000001',
			generation: 1,
			status: 'live',
			// Valid JSON, wrong shape (the store refuses non-JSON payloads).
			payload: '{"malformed":true}',
		});
		startAgentSession('coder-m2', 'coder');
		swarmState.activeAgent.set('coder-m2', 'coder');
		const session = swarmState.agentSessions.get('coder-m2');
		if (!session) throw new Error('session was not created');
		session.currentTaskId = '1.1';
		const hook = createScopeGuardHook({ enabled: true }, root);
		// Honeypot: a valid-looking PR-feedback binding. The fixed guard must
		// never consult it while the store is unreadable; the fallback-
		// restoring mutant would authorize through it and stop rejecting.
		const honeypot = decl(root, 'prfb', 'honeypot');
		const originalGet = guardInternals.getAuthorizedPrFeedbackScopeBinding;
		const originalResolve =
			guardInternals.resolveAuthorizedPrFeedbackScopeBindingFromDisk;
		const originalValidate = guardInternals.validatePrFeedbackScopeBinding;
		guardInternals.getAuthorizedPrFeedbackScopeBinding = () => honeypot;
		guardInternals.resolveAuthorizedPrFeedbackScopeBindingFromDisk = () =>
			honeypot;
		guardInternals.validatePrFeedbackScopeBinding = () => true;
		try {
			await expect(
				hook.toolBefore(
					{ tool: 'apply_patch', sessionID: 'coder-m2', callID: 'call-m2' },
					{
						args: {
							// A well-formed patch touching the honeypot's own scope:
							// under the fallback-restoring mutant this AUTHORIZES (no
							// rejection); only the fixed guard rejects here.
							patch:
								'*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** End Patch',
						},
					},
				),
			).rejects.toThrow();
		} finally {
			guardInternals.getAuthorizedPrFeedbackScopeBinding = originalGet;
			guardInternals.resolveAuthorizedPrFeedbackScopeBindingFromDisk =
				originalResolve;
			guardInternals.validatePrFeedbackScopeBinding = originalValidate;
		}
	}, 60_000);
});

// Final-critic round-2 route legs (F3): pin the four surviving route
// mutations — session-resolver store_unreadable (R2), delegation-gate denial
// (R1), reset lineage attribution (R3), reset scoping (R4).
describe('session route store-unreadable (#3889, final-critic round 2)', () => {
	test('guard denies without the PR-feedback fallback when no task id resolves (R2)', async () => {
		const root = fixture('failclosed-r2-');
		fs.mkdirSync(path.join(root, '.swarm'), { recursive: true });
		fs.writeFileSync(
			path.join(root, '.swarm', 'plan.json'),
			JSON.stringify(plan),
		);
		transitionCoordinationState(root, {
			namespace: 'scope-binding',
			entityKey: 'ffffffff-0000-4000-a000-000000000001',
			generation: 1,
			status: 'live',
			payload: '{"malformed":true}',
		});
		startAgentSession('coder-r2', 'coder');
		swarmState.activeAgent.set('coder-r2', 'coder');
		const session = swarmState.agentSessions.get('coder-r2');
		if (!session) throw new Error('session was not created');
		// No current task: the guard falls back to the SESSION-detailed
		// resolver, whose store_unreadable propagation is under test.
		session.currentTaskId = null as never;
		const hook = createScopeGuardHook({ enabled: true }, root);
		const honeypot = decl(root, 'prfb', 'honeypot');
		const originalGet = guardInternals.getAuthorizedPrFeedbackScopeBinding;
		const originalResolve =
			guardInternals.resolveAuthorizedPrFeedbackScopeBindingFromDisk;
		const originalValidate = guardInternals.validatePrFeedbackScopeBinding;
		const originalTaskId = guardInternals.resolveTaskId;
		let consulted = false;
		guardInternals.resolveTaskId = (() => null) as typeof originalTaskId;
		guardInternals.getAuthorizedPrFeedbackScopeBinding = () => {
			consulted = true;
			return honeypot;
		};
		guardInternals.resolveAuthorizedPrFeedbackScopeBindingFromDisk = () =>
			honeypot;
		guardInternals.validatePrFeedbackScopeBinding = () => true;
		let threw = false;
		try {
			await hook.toolBefore(
				{ tool: 'apply_patch', sessionID: 'coder-r2', callID: 'call-r2' },
				{
					args: {
						patch:
							'*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** End Patch',
					},
				},
			);
		} catch {
			threw = true;
		} finally {
			guardInternals.getAuthorizedPrFeedbackScopeBinding = originalGet;
			guardInternals.resolveAuthorizedPrFeedbackScopeBindingFromDisk =
				originalResolve;
			guardInternals.validatePrFeedbackScopeBinding = originalValidate;
			guardInternals.resolveTaskId = originalTaskId;
		}
		// The session-detailed resolver must fail closed: the honeypot is
		// never consulted and the write is denied.
		expect(consulted).toBe(false);
		expect(threw).toBe(true);
	}, 60_000);
});

describe('delegation gate store-unreadable (#3889, final-critic round 2)', () => {
	test('Task dispatch throws the store-unreadable diagnostic on a corrupt store (R1)', async () => {
		const root = fixture('failclosed-r1-');
		fs.mkdirSync(path.join(root, '.swarm'), { recursive: true });
		fs.writeFileSync(
			path.join(root, '.swarm', 'plan.json'),
			JSON.stringify(plan),
		);
		await recordPlanCriticApproval(root, plan);
		ensureAgentSession('parent-r1', 'architect', root);
		transitionCoordinationState(root, {
			namespace: 'scope-binding',
			entityKey: '99999999-0000-4000-a000-000000000001',
			generation: 1,
			status: 'live',
			payload: '{"malformed":true}',
		});
		const hook = createDelegationGateHook(makeConfig(), root);
		await expect(
			hook.toolBefore(
				{ tool: 'Task', sessionID: 'parent-r1', callID: 'task-r1' },
				{
					args: {
						subagent_type: 'coder',
						prompt: 'TASK: 1.1\nACCEPTANCE: implemented and tested',
					},
				},
			),
		).rejects.toThrow('SCOPE_BINDING_STORE_UNREADABLE');
	}, 60_000);
});

describe('reset lineage attribution (#3889, final-critic round 2)', () => {
	test('sweep removes owner-, parent- and workflow-attributed rows only (R3, R4)', async () => {
		const root = fixture('failclosed-r34-');
		const ownerRow = decl(root, 'victim', 'owner');
		seedRow(root, ownerRow);
		const parentRow = {
			...decl(root, 'other-owner', 'parent'),
			parentOwnerSessionId: 'victim',
		};
		seedRow(root, parentRow);
		const workflowRow = {
			...decl(root, 'other-owner', 'workflow'),
			workflowSessionId: 'victim',
		};
		seedRow(root, workflowRow);
		const unrelated = decl(root, 'stranger', 'unrelated');
		seedRow(root, unrelated);
		const sweep = await clearSessionScopeBindingsFromDisk(root, ['victim']);
		// Exactly the three attributed rows go; the unrelated session's row
		// must survive (R4 scoping) and lineage must be honored (R3).
		expect(sweep).toMatchObject({ removed: 3 });
		const survivors = listCoordinationStateRowsRaw(root, 'scope-binding', 10);
		expect(survivors.map((row) => row.entityKey)).toEqual([
			unrelated.generationId,
		]);
		const ledger = readLedger(root);
		expect(ledger[ownerRow.generationId]?.kind).toBe('terminal');
		expect(ledger[parentRow.generationId]?.kind).toBe('terminal');
		expect(ledger[workflowRow.generationId]?.kind).toBe('terminal');
		expect(ledger[unrelated.generationId]).toBeUndefined();
	}, 60_000);
});
