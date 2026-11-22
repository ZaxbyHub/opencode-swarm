/**
 * r13 audit repair (P0-2): the plan baseline for a background plan critic-gate
 * dispatch must be captured in tool.execute.before — BEFORE the critic child
 * starts — and the after-hook must consume exactly that baseline instead of
 * re-reading plan.json. A plan edited between child start and the after-hook's
 * record write must never re-anchor the binding (the r11 bug let the critic's
 * older APPROVED verdict release an edited plan).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { findByCorrelationId } from '../../../src/background/pending-delegations';
import type { Plan } from '../../../src/config/plan-schema';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import { computePlanStructureHash } from '../../../src/plan/ledger';
import { resetStartupLedgerCheck } from '../../../src/plan/manager';
import { derivePlanId } from '../../../src/plan/utils';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const config = {
	max_iterations: 5,
	qa_retry_limit: 3,
	inject_phase_reminders: true,
	hooks: {
		delegation_gate: true,
		background_subagents: true,
		background_pending_timeout_minutes: 30,
	},
	worktree: { policy: 'disabled' },
} as Parameters<typeof createDelegationGateHook>[0];

function makePlan(title = 'Critic Baseline Plan'): Plan {
	return {
		schema_version: '1.0.0',
		title,
		swarm: 'critic-baseline',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Implementation',
				status: 'pending',
				tasks: [
					{
						id: '1.1',
						phase: 1,
						status: 'pending',
						size: 'small',
						description: 'Do the work',
						depends: [],
						files_touched: ['src/a.ts'],
					},
				],
			},
		],
	} as Plan;
}

function writePlan(directory: string, plan: Plan): void {
	mkdirSync(join(directory, '.swarm'), { recursive: true });
	writeFileSync(
		join(directory, '.swarm', 'plan.json'),
		JSON.stringify(plan, null, 2),
	);
}

const GATE_PROMPT =
	'MODE: CRITIC-GATE\nReview the full plan before EXECUTE and return VERDICT.';

function criticDispatch(
	prompt: string,
	callID: string,
	sessionID = 'parent-architect',
) {
	return {
		input: {
			tool: 'Task',
			sessionID,
			callID,
			args: {
				subagent_type: 'critic',
				background: true,
				prompt,
			},
		},
		output: {
			state: 'running',
			output: `<task id="critic-child" state="running">Background task started</task>`,
			metadata: { background: true, jobId: 'critic-job' },
		},
	};
}

describe('plan critic-gate pre-execution baseline binding (r13 P0-2)', () => {
	let dir: string;
	let cleanup: () => void;
	let plan: Plan;

	beforeEach(() => {
		resetSwarmState();
		resetStartupLedgerCheck();
		({ dir, cleanup } = createSafeTestDir('critic-baseline-'));
		plan = makePlan();
		writePlan(dir, plan);
	});

	afterEach(() => {
		resetSwarmState();
		resetStartupLedgerCheck();
		cleanup();
	});

	test('the after-hook binding is the PRE-EXECUTION plan hash, even when plan.json changes before the record write', async () => {
		ensureAgentSession('parent-architect', 'architect', dir);
		const hook = createDelegationGateHook(config, dir);
		const { input, output } = criticDispatch(GATE_PROMPT, 'call-critic-1');

		// toolBefore runs BEFORE the child starts: the baseline is plan A.
		await hook.toolBefore(
			{ tool: 'Task', sessionID: input.sessionID, callID: input.callID },
			{ args: input.args },
		);
		const hashAtDispatch = computePlanStructureHash(plan);

		// The plan is edited AFTER the child started but BEFORE the after-hook
		// writes the durable record. The binding must still be hash(plan A).
		const edited = makePlan('Edited Between Child Start And After Hook');
		edited.phases[0].tasks[0].description = 'changed after child start';
		writePlan(dir, edited);

		await hook.toolAfter(input, output);

		const record = findByCorrelationId(dir, 'critic-child');
		expect(record).not.toBeNull();
		expect(record?.planCriticDispatch).toBeDefined();
		expect(record?.planCriticDispatch?.planStructureHash).toBe(hashAtDispatch);
		// The binding carries the plan identity and the full prompt digest
		// captured pre-execution.
		expect(record?.planCriticDispatch?.planId).toBe(derivePlanId(plan));
		expect(record?.planCriticDispatch?.promptContentDigest).toBe(
			createHash('sha256').update(GATE_PROMPT).digest('hex'),
		);
	});

	test('a plan edited BEFORE the child starts binds the edited plan', async () => {
		ensureAgentSession('parent-architect', 'architect', dir);
		const editedFirst = makePlan('Edited Before Dispatch');
		editedFirst.phases[0].tasks[0].description = 'pre-dispatch edit';
		writePlan(dir, editedFirst);

		const hook = createDelegationGateHook(config, dir);
		const { input, output } = criticDispatch(GATE_PROMPT, 'call-critic-2');
		await hook.toolBefore(
			{ tool: 'Task', sessionID: input.sessionID, callID: input.callID },
			{ args: input.args },
		);
		await hook.toolAfter(input, output);

		const record = findByCorrelationId(dir, 'critic-child');
		expect(record?.planCriticDispatch?.planStructureHash).toBe(
			computePlanStructureHash(editedFirst),
		);
	});

	test('no plan.json at dispatch time records NO binding (fail closed)', async () => {
		ensureAgentSession('parent-architect', 'architect', dir);
		writeFileSync(join(dir, '.swarm', 'plan.json'), 'not a plan');
		const hook = createDelegationGateHook(config, dir);
		const { input, output } = criticDispatch(GATE_PROMPT, 'call-critic-3');
		await hook.toolBefore(
			{ tool: 'Task', sessionID: input.sessionID, callID: input.callID },
			{ args: input.args },
		);
		await hook.toolAfter(input, output);

		const record = findByCorrelationId(dir, 'critic-child');
		// No provable baseline → no binding → a later async APPROVED can never
		// auto-approve.
		expect(record?.planCriticDispatch).toBeUndefined();
	});

	test('an ordinary critic review (no explicit gate marker) never gets a binding', async () => {
		ensureAgentSession('parent-architect', 'architect', dir);
		const hook = createDelegationGateHook(config, dir);
		const { input, output } = criticDispatch(
			'Please review the plan.md content below before implementation.',
			'call-critic-4',
		);
		await hook.toolBefore(
			{ tool: 'Task', sessionID: input.sessionID, callID: input.callID },
			{ args: input.args },
		);
		await hook.toolAfter(input, output);

		const record = findByCorrelationId(dir, 'critic-child');
		expect(record?.planCriticDispatch).toBeUndefined();
	});

	test('a baseline captured by a FOREIGN session is not consumed by another session (fail closed)', async () => {
		ensureAgentSession('parent-architect', 'architect', dir);
		ensureAgentSession('parent-imposter', 'architect', dir);
		const hook = createDelegationGateHook(config, dir);
		const { input, output } = criticDispatch(GATE_PROMPT, 'call-critic-5');
		await hook.toolBefore(
			{ tool: 'Task', sessionID: 'parent-architect', callID: input.callID },
			{ args: input.args },
		);
		// The after-hook claims a different parent session than the one that
		// captured the baseline: not provable → no binding.
		await hook.toolAfter({ ...input, sessionID: 'parent-imposter' }, output);

		const record = findByCorrelationId(dir, 'critic-child');
		expect(record?.planCriticDispatch).toBeUndefined();
	});

	test('an after-hook without a preceding toolBefore capture records NO binding (crash replay shape)', async () => {
		// A process restart between toolBefore and toolAfter loses the
		// in-memory baseline; the durable record must fail closed rather than
		// re-derive a hash from the (possibly edited) current plan.
		ensureAgentSession('parent-architect', 'architect', dir);
		const hook = createDelegationGateHook(config, dir);
		const { input, output } = criticDispatch(GATE_PROMPT, 'call-critic-6');
		await hook.toolAfter(input, output);

		const record = findByCorrelationId(dir, 'critic-child');
		expect(record?.planCriticDispatch).toBeUndefined();
	});

	test('the sync transport passes the pre-execution baseline to the shared recorder', async () => {
		ensureAgentSession('parent-architect', 'architect', dir);
		const hook = createDelegationGateHook(config, dir);
		const { input } = criticDispatch(GATE_PROMPT, 'call-critic-sync');
		await hook.toolBefore(
			{ tool: 'Task', sessionID: input.sessionID, callID: input.callID },
			{ args: input.args },
		);
		const hashAtDispatch = computePlanStructureHash(plan);

		// The plan is edited while the (synchronous) critic child ran.
		const edited = makePlan('Edited While Sync Critic Ran');
		edited.phases[0].tasks[0].description = 'changed mid-review';
		writePlan(dir, edited);

		// The inline result returns APPROVED — for the plan it was SENT. The
		// pre-execution baseline must make the recorder reject the stale
		// verdict for the edited plan (skipped/conflict, no snapshot).
		const { loadLastPlanCriticApprovedSnapshot } = await import(
			'../../../src/plan/ledger'
		);
		await hook.toolAfter(input, {
			output: 'VERDICT: APPROVED\nThe plan is solid.',
		});
		expect(
			await loadLastPlanCriticApprovedSnapshot(dir, derivePlanId(plan)),
		).toBeNull();
		// Sanity: the baseline really was the pre-edit hash.
		expect(hashAtDispatch).not.toBe(computePlanStructureHash(edited));
	});

	// P2-1 regression: ordinary critic reviews — including ones that merely
	// mention plan.md or plan-review phrasings — must NOT auto-record a
	// plan-critic approval, even with an APPROVED verdict in the output.
	const ordinaryReviewPrompts: Array<{ name: string; prompt: string }> = [
		{
			name: 'plan.md content reference without gate marker',
			prompt:
				'Please review the plan.md content below before we proceed to implementation.\n\n<plan contents>',
		},
		{
			name: '"plan critic" phrasing',
			prompt: 'You are the plan critic. Assess this plan for coverage gaps.',
		},
		{
			name: '"approve the plan" phrasing',
			prompt: 'Review and, if sound, approve the plan for the swarm.',
		},
		{
			name: '"evaluate this plan" phrasing',
			prompt: 'Evaluate this plan for soundness before we proceed.',
		},
		{
			name: '"pre-implementation review" phrasing',
			prompt: 'Perform the pre-implementation review on the plan below.',
		},
		{
			name: '"assess the plan" phrasing',
			prompt: 'Assess the plan for coverage gaps and risks.',
		},
	];

	for (const variant of ordinaryReviewPrompts) {
		test(`P2-1: ordinary critic review does NOT auto-approve: ${variant.name}`, async () => {
			const ordinaryPlan = makePlan();
			writePlan(dir, ordinaryPlan);
			ensureAgentSession('session-plan-critic-ordinary', 'architect');
			const hook = createDelegationGateHook(config, dir);

			await hook.toolAfter(
				{
					tool: 'Task',
					sessionID: 'session-plan-critic-ordinary',
					callID: 'critic-call-ordinary',
					args: {
						subagent_type: 'critic',
						prompt: variant.prompt,
					},
				},
				{ output: 'VERDICT: APPROVED\nThe plan is ready.' },
			);

			const { loadLastPlanCriticApprovedSnapshot } = await import(
				'../../../src/plan/ledger'
			);
			expect(
				await loadLastPlanCriticApprovedSnapshot(
					dir,
					derivePlanId(ordinaryPlan),
				),
			).toBeNull();
		});
	}
});
