import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import { _internals as delegationGateInternals } from '../../../src/hooks/delegation-gate';
import {
	computePlanStructureHash,
	initLedger,
	loadLastApprovedPlan,
	takeSnapshotEvent,
} from '../../../src/plan/ledger';
import { updateTaskStatus } from '../../../src/plan/manager';
import { derivePlanId } from '../../../src/plan/utils';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
import { withFrozenClock } from '../../helpers/test-clock.js';
import {
	createDelegationGateHook,
	makeConfig,
} from './_delegation-gate-helpers';

function makePlan(overrides?: Partial<Plan>): Plan {
	return {
		schema_version: '1.0.0',
		title: 'Plan Critic Gate Test',
		swarm: 'mega',
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
						description: 'Implement issue fix',
						depends: [],
						files_touched: ['src/index.ts'],
					},
				],
			},
		],
		...overrides,
	};
}

async function writePlan(dir: string, plan: Plan): Promise<void> {
	await mkdir(join(dir, '.swarm'), { recursive: true });
	writeFileSync(
		join(dir, '.swarm', 'plan.json'),
		JSON.stringify(plan, null, 2),
	);
	await initLedger(dir, derivePlanId(plan));
}

function coderDispatch(sessionID = 'session-plan-critic-gate') {
	return {
		input: {
			tool: 'Task',
			sessionID,
			callID: `${sessionID}-coder`,
		},
		output: {
			args: {
				subagent_type: 'coder',
				prompt:
					'TASK: 1.1\nImplement the approved plan.\nACCEPTANCE: task complete and covered by tests',
			},
		},
	};
}

// Record a plan-critic-approval snapshot the SAME way production does
// (`recordPlanCriticApprovalSnapshotIfApplicable`): tagged `plan_critic_gate`
// and storing the STATUS-EXCLUDED structural hash as payload_hash.
async function recordPlanCriticSnapshot(
	dir: string,
	plan: Plan,
): Promise<void> {
	await takeSnapshotEvent(dir, plan, {
		source: 'critic_approved',
		approvalMetadata: { verdict: 'APPROVED', source: 'plan_critic_gate' },
		payloadHashOverride: computePlanStructureHash(plan),
	});
}

describe('delegation gate plan critic approval', () => {
	let dir: string;

	beforeEach(async () => {
		resetSwarmState();
		dir = await mkdtemp(join(tmpdir(), 'plan-critic-gate-'));
	});

	afterEach(async () => {
		resetSwarmState();
		closeAllProjectDbs();
		if (dir && existsSync(dir)) {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test('blocks coder dispatch when no approved plan critic snapshot exists', async () => {
		await writePlan(dir, makePlan());
		const hook = createDelegationGateHook(makeConfig(), dir);
		const { input, output } = coderDispatch();

		await expect(hook.toolBefore(input, output)).rejects.toThrow(
			'PLAN_CRITIC_GATE_VIOLATION',
		);
	});

	test('allows coder dispatch when current plan has an approved critic snapshot', async () => {
		const plan = makePlan();
		await writePlan(dir, plan);
		await recordPlanCriticSnapshot(dir, plan);
		const hook = createDelegationGateHook(makeConfig(), dir);
		const { input, output } = coderDispatch();

		await hook.toolBefore(input, output);
	});

	test('blocks coder dispatch when approved snapshot is not plan-critic evidence', async () => {
		const plan = makePlan();
		await writePlan(dir, plan);
		await takeSnapshotEvent(dir, plan, {
			source: 'critic_approved',
			approvalMetadata: {
				phase: 1,
				verdict: 'APPROVED',
				summary: 'Phase drift verification approved',
			},
		});
		const hook = createDelegationGateHook(makeConfig(), dir);
		const { input, output } = coderDispatch();

		await expect(hook.toolBefore(input, output)).rejects.toThrow(
			'PLAN_CRITIC_GATE_VIOLATION',
		);
	});

	test('blocks coder dispatch when the approved snapshot is stale', async () => {
		const plan = makePlan();
		await writePlan(dir, plan);
		await recordPlanCriticSnapshot(dir, plan);

		const changedPlan = makePlan({
			phases: [
				{
					...plan.phases[0],
					tasks: [
						{
							...plan.phases[0].tasks[0],
							description: 'Changed after approval',
						},
					],
				},
			],
		});
		writeFileSync(
			join(dir, '.swarm', 'plan.json'),
			JSON.stringify(changedPlan, null, 2),
		);
		const hook = createDelegationGateHook(makeConfig(), dir);
		const { input, output } = coderDispatch();

		await expect(hook.toolBefore(input, output)).rejects.toThrow(
			'PLAN_CRITIC_GATE_VIOLATION',
		);
		// The description change is a genuine STRUCTURAL change, so it must move
		// the structural hash — proving the F-A1 fix didn't neuter staleness.
		expect(computePlanStructureHash(changedPlan)).not.toBe(
			computePlanStructureHash(plan),
		);
	});

	test('records an approved snapshot after approved plan critic output', async () => {
		const plan = makePlan();
		await writePlan(dir, plan);
		ensureAgentSession('session-plan-critic-record', 'architect');
		const hook = createDelegationGateHook(makeConfig(), dir);

		await hook.toolAfter(
			{
				tool: 'Task',
				sessionID: 'session-plan-critic-record',
				callID: 'critic-call',
				args: {
					subagent_type: 'critic',
					prompt: 'MODE: CRITIC-GATE\nTASK: Review plan before EXECUTE',
				},
			},
			{
				output:
					'VERDICT: APPROVED\nThe plan is mechanically covered and ready.',
			},
		);

		const approved = await loadLastApprovedPlan(dir, derivePlanId(plan));
		expect(approved).not.toBeNull();
		// Production now stores the status-excluded structural hash so the gate
		// survives the architect's pre-delegation `in_progress` status flip.
		expect(approved?.payloadHash).toBe(computePlanStructureHash(plan));
		expect(approved?.approval?.verdict).toBe('APPROVED');
		expect(approved?.approval?.source).toBe('plan_critic_gate');
	});

	// F-B1: the recorder's heuristic (`taskLooksLikePlanCritic`) must have high
	// recall for realistic freeform architect phrasings of "review this plan
	// before execution" — NOT just the hand-crafted "MODE: CRITIC-GATE" +
	// "review plan"+"execute" shape the original test happened to match. Each
	// variant below deliberately omits the old narrow trigger pairing.
	const planCriticPromptVariants: Array<{ name: string; prompt: string }> = [
		{
			name: 'plan.md content reference without MODE header or execute pairing',
			prompt:
				'Please review the plan.md content below before we proceed to implementation.\n\n<plan contents>',
		},
		{
			name: 'critic-gate prefix on pasted plan content',
			prompt: 'Critic-gate review:\n\n# Phase 1\n- Task 1.1 do the thing',
		},
		{
			name: '"plan critic" phrasing',
			prompt: 'You are the plan critic. Assess this plan for coverage gaps.',
		},
		{
			name: '"approve the plan" phrasing',
			prompt: 'Review and, if sound, approve the plan for the swarm.',
		},
	];

	for (const variant of planCriticPromptVariants) {
		test(`records an approved snapshot for realistic variant: ${variant.name}`, async () => {
			const plan = makePlan();
			await writePlan(dir, plan);
			ensureAgentSession('session-plan-critic-variant', 'architect');
			const hook = createDelegationGateHook(makeConfig(), dir);

			await hook.toolAfter(
				{
					tool: 'Task',
					sessionID: 'session-plan-critic-variant',
					callID: 'critic-call-variant',
					args: {
						subagent_type: 'critic',
						prompt: variant.prompt,
					},
				},
				{ output: 'VERDICT: APPROVED\nThe plan is ready.' },
			);

			const approved = await loadLastApprovedPlan(dir, derivePlanId(plan));
			expect(approved).not.toBeNull();
			expect(approved?.approval?.verdict).toBe('APPROVED');
			expect(approved?.approval?.source).toBe('plan_critic_gate');
			expect(approved?.payloadHash).toBe(computePlanStructureHash(plan));
		});
	}

	test('does NOT record a plan-critic snapshot for an unrelated critic dispatch even when output is APPROVED', async () => {
		// A generic (non-plan) critic dispatch whose prompt contains none of the
		// trigger signals must NOT record a plan-critic approval, even if its
		// output happens to contain VERDICT: APPROVED. This proves the broadened
		// heuristic did not degenerate into "always true for any critic dispatch".
		const plan = makePlan();
		await writePlan(dir, plan);
		ensureAgentSession('session-plan-critic-negative', 'architect');
		const hook = createDelegationGateHook(makeConfig(), dir);

		await hook.toolAfter(
			{
				tool: 'Task',
				sessionID: 'session-plan-critic-negative',
				callID: 'critic-call-negative',
				args: {
					subagent_type: 'critic',
					prompt:
						'Review this authentication module diff for security vulnerabilities and race conditions.',
				},
			},
			{ output: 'VERDICT: APPROVED\nNo issues found in the diff.' },
		);

		const approved = await loadLastApprovedPlan(dir, derivePlanId(plan));
		expect(approved).toBeNull();
	});

	test('allows coder dispatch after task advances to in_progress (F-A1)', async () => {
		// The EXECUTE skill mandates flipping the current task to `in_progress`
		// (dual-written into plan.json) BEFORE delegating its coder. Before the
		// fix, that status mutation changed the status-inclusive plan hash and the
		// gate rejected the very first conforming coder dispatch.
		const plan = makePlan();
		await writePlan(dir, plan);
		// Normalize plan.json through the same savePlan pipeline the assert path
		// reads from, so the ONLY structural delta below is the status field.
		await updateTaskStatus(dir, '1.1', 'pending');
		ensureAgentSession('session-fa1', 'architect');
		const hook = createDelegationGateHook(makeConfig(), dir);

		// Record the plan-critic approval via the real production recorder path.
		await hook.toolAfter(
			{
				tool: 'Task',
				sessionID: 'session-fa1',
				callID: 'critic-call',
				args: {
					subagent_type: 'critic',
					prompt: 'MODE: CRITIC-GATE\nTASK: Review plan before EXECUTE',
				},
			},
			{ output: 'VERDICT: APPROVED\nThe plan is ready for EXECUTE.' },
		);

		// Architect advances the current task before delegating its coder.
		await updateTaskStatus(dir, '1.1', 'in_progress');

		const { input, output } = coderDispatch();
		// Must be ALLOWED now (previously threw PLAN_CRITIC_GATE_VIOLATION).
		await hook.toolBefore(input, output);
	});

	test('allows coder dispatch when a later drift snapshot shadows the plan-critic approval (F-A2)', async () => {
		// write-drift-evidence.ts writes `source: 'critic_approved'` snapshots on
		// every APPROVED phase drift verification — with no `plan_critic_gate`
		// marker. If one lands after a valid plan-critic approval, the gate must
		// look past it rather than treat it as the latest approval.
		const plan = makePlan();
		await writePlan(dir, plan);
		await recordPlanCriticSnapshot(dir, plan);

		// Mimic write-drift-evidence.ts's per-phase drift snapshot shape.
		await takeSnapshotEvent(dir, plan, {
			source: 'critic_approved',
			approvalMetadata: {
				phase: 1,
				verdict: 'APPROVED',
				summary: 'Phase 1 drift verification approved',
				approved_at: withFrozenClock(() => new Date().toISOString()),
			},
		});

		const hook = createDelegationGateHook(makeConfig(), dir);
		const { input, output } = coderDispatch();
		// The gate must scan past the shadowing drift snapshot to the earlier,
		// still-valid plan-critic approval and ALLOW the dispatch.
		await hook.toolBefore(input, output);
	});

	// F-B1 coupling guard: critic-gate/SKILL.md tells the architect to
	// reference "plan.md" or "critic-gate" in its dispatch. If a future edit to
	// either the skill wording or PLAN_CRITIC_TASK_SIGNALS drops one of these
	// tokens from the other side, the recording heuristic silently stops
	// matching the documented dispatch shape and the total-block bug (F-B1)
	// regresses. This test fails loudly instead.
	test('SKILL.md-recommended detection tokens stay a subset of the heuristic signals (F-B1 coupling guard)', () => {
		const skillPath = join(
			__dirname,
			'../../../.opencode/skills/critic-gate/SKILL.md',
		);
		const skillText = readFileSync(skillPath, 'utf8').toLowerCase();
		const recommendedTokens = ['plan.md', 'critic-gate'];
		const signals = delegationGateInternals.PLAN_CRITIC_TASK_SIGNALS;

		for (const token of recommendedTokens) {
			expect(skillText.includes(token)).toBe(true);
			expect(signals.some((signal) => signal.includes(token))).toBe(true);
		}
	});

	// ── Issue #2012: robust verdict extraction (Change B) ──────────────────
	// The mechanical recorder must capture APPROVED even when the critic emits
	// the verdict with formatting variance. A silent miss permanently wedges
	// the ratchet-tighter critic_pre_plan gate with no recovery.
	describe('extractPlanCriticVerdict (issue #2012 robustness)', () => {
		const { extractPlanCriticVerdict } = delegationGateInternals;

		test('primary: matches VERDICT: APPROVED', () => {
			expect(extractPlanCriticVerdict('VERDICT: APPROVED\nok')).toBe(
				'APPROVED',
			);
		});

		// PRR-006 (swarm-pr-review): the extractor supports all three verdicts
		// across every fallback path; exercise NEEDS_REVISION and REJECTED so a
		// future regression that hardcodes APPROVED is caught.
		test('primary: matches VERDICT: NEEDS_REVISION', () => {
			expect(
				extractPlanCriticVerdict('VERDICT: NEEDS_REVISION\nfix the gaps'),
			).toBe('NEEDS_REVISION');
		});

		test('primary: matches VERDICT: REJECTED', () => {
			expect(
				extractPlanCriticVerdict('VERDICT: REJECTED\nfundamental issues'),
			).toBe('REJECTED');
		});

		test('bold label: matches **VERDICT**: NEEDS_REVISION', () => {
			expect(
				extractPlanCriticVerdict(
					'**VERDICT**: NEEDS_REVISION\nSeveral concerns.',
				),
			).toBe('NEEDS_REVISION');
		});

		test('heading: matches ## Verdict followed by REJECTED', () => {
			expect(extractPlanCriticVerdict('## Verdict\nREJECTED')).toBe('REJECTED');
		});

		test('bare token in final lines: matches a trailing bare NEEDS_REVISION', () => {
			expect(
				extractPlanCriticVerdict(
					'PLAN REVIEW:\nSeveral gaps.\n\nNEEDS_REVISION',
				),
			).toBe('NEEDS_REVISION');
		});

		test('bold label: matches **VERDICT**: APPROVED', () => {
			expect(extractPlanCriticVerdict('**VERDICT**: APPROVED\nAll good.')).toBe(
				'APPROVED',
			);
		});

		test('heading: matches ## Verdict followed by token', () => {
			expect(extractPlanCriticVerdict('## Verdict\nAPPROVED')).toBe('APPROVED');
		});

		test('bare token in final lines: matches a trailing bare APPROVED', () => {
			expect(
				extractPlanCriticVerdict('PLAN REVIEW:\nLooks good.\n\nAPPROVED'),
			).toBe('APPROVED');
		});

		test('NEGATIVE: rubric template enumeration does NOT false-positive', () => {
			// The critic's own output-format template line contains
			// "VERDICT: APPROVED | NEEDS_REVISION | REJECTED" as an enumeration.
			// The primary regex matches APPROVED here (correct — it IS a VERDICT:
			// line), but the bare-line fallback must NOT additionally misfire on
			// a mid-output bare token. This pins the behavior: a VERDICT: line
			// with a pipe-separated enumeration still resolves to APPROVED (the
			// first token), which is the documented behavior.
			const template = 'VERDICT: APPROVED | NEEDS_REVISION | REJECTED';
			expect(extractPlanCriticVerdict(template)).toBe('APPROVED');
		});

		test('NEGATIVE: bare token mid-output (not in tail) does NOT match', () => {
			// A bare "APPROVED" in the middle of a long review (e.g. "task 1.1 is
			// approved for execution") must not trigger a false approval.
			const mid = [
				'APPROVED for execution in the current phase',
				'line 2',
				'line 3',
				'line 4',
				'line 5',
				'line 6',
				'line 7',
			].join('\n');
			expect(extractPlanCriticVerdict(mid)).toBeNull();
		});

		test('NEGATIVE: bare token inside a code fence does NOT match', () => {
			const fenced = '```\nAPPROVED\n```';
			expect(extractPlanCriticVerdict(fenced)).toBeNull();
		});

		test('NEGATIVE: pipe-separated bare line does NOT match', () => {
			// The rubric enumeration as a bare line (no VERDICT: prefix) must
			// not match because it contains a pipe separator.
			const pipeLine = 'APPROVED | NEEDS_REVISION | REJECTED';
			expect(extractPlanCriticVerdict(pipeLine)).toBeNull();
		});

		test('NEGATIVE: bare token inside a 4-backtick fence does NOT match', () => {
			// A 4-backtick fenced block (common for nested code blocks) must also
			// toggle the fence state, not just exactly 3 backticks.
			const fenced = '````\nAPPROVED\n````';
			expect(extractPlanCriticVerdict(fenced)).toBeNull();
		});
	});

	// ── Issue #2012: broadened dispatch signals (Change C) ─────────────────
	const broadenedPromptVariants: Array<{ name: string; prompt: string }> = [
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

	for (const variant of broadenedPromptVariants) {
		test(`records an approved snapshot for broadened signal: ${variant.name}`, async () => {
			const plan = makePlan();
			await writePlan(dir, plan);
			ensureAgentSession('session-broadened', 'architect');
			const hook = createDelegationGateHook(makeConfig(), dir);

			await hook.toolAfter(
				{
					tool: 'Task',
					sessionID: 'session-broadened',
					callID: 'critic-broadened',
					args: {
						subagent_type: 'critic',
						prompt: variant.prompt,
					},
				},
				{ output: 'VERDICT: APPROVED\nThe plan is ready.' },
			);

			const approved = await loadLastApprovedPlan(dir, derivePlanId(plan));
			expect(approved).not.toBeNull();
			expect(approved?.approval?.verdict).toBe('APPROVED');
			expect(approved?.approval?.source).toBe('plan_critic_gate');
		});
	}

	// ── Issue #2012: escape hatch (Change A) ──────────────────────────────
	describe('forceRecordPlanCriticApproval escape hatch (issue #2012)', () => {
		test('records a manual-override snapshot that satisfies the gate', async () => {
			const plan = makePlan();
			await writePlan(dir, plan);
			ensureAgentSession('session-escape', 'architect');

			const summary =
				await delegationGateInternals.forceRecordPlanCriticApproval(
					dir,
					'session-escape',
					{ reason: 'critic returned APPROVED but format mismatched' },
				);

			expect(summary.planId).toBe(derivePlanId(plan));
			expect(summary.userConfirmed).toBe(false); // tool path default

			// The snapshot must satisfy the gate: a coder dispatch now succeeds.
			const hook = createDelegationGateHook(makeConfig(), dir);
			const { input, output } = coderDispatch('session-escape');
			await hook.toolBefore(input, output); // must NOT throw
		});

		test('snapshot carries the manual_override audit marker', async () => {
			const plan = makePlan();
			await writePlan(dir, plan);
			ensureAgentSession('session-marker', 'architect');

			await delegationGateInternals.forceRecordPlanCriticApproval(
				dir,
				'session-marker',
				{ reason: 'test reason', userConfirmed: true },
			);

			// loadLastPlanCriticApprovedSnapshot finds it (source plan_critic_gate)
			const approved = await loadLastApprovedPlan(dir, derivePlanId(plan));
			expect(approved).not.toBeNull();
			expect(approved?.approval?.method).toBe('manual_override');
			expect(approved?.approval?.reason).toBe('test reason');
			expect(approved?.approval?.user_confirmed).toBe(true);
		});

		test('appends an audit event to .swarm/events.jsonl', async () => {
			const plan = makePlan();
			await writePlan(dir, plan);
			ensureAgentSession('session-audit', 'architect');

			await delegationGateInternals.forceRecordPlanCriticApproval(
				dir,
				'session-audit',
				{ reason: 'audit test' },
			);

			const eventsPath = join(dir, '.swarm', 'events.jsonl');
			expect(existsSync(eventsPath)).toBe(true);
			const events = readFileSync(eventsPath, 'utf8')
				.split('\n')
				.filter((l) => l.trim().length > 0);
			const last = JSON.parse(events[events.length - 1]);
			expect(last.type).toBe('plan_critic_gate_manual_approval');
			expect(last.sessionID).toBe('session-audit');
			expect(last.reason).toBe('audit test');
		});

		test('rejects a non-architect session (NOT_AUTHORIZED)', async () => {
			const plan = makePlan();
			await writePlan(dir, plan);
			// Coder session — must NOT be allowed to self-unblock.
			ensureAgentSession('session-coder', 'coder');

			await expect(
				delegationGateInternals.forceRecordPlanCriticApproval(
					dir,
					'session-coder',
					{ reason: 'coder tries to self-unblock' },
				),
			).rejects.toThrow('NOT_AUTHORIZED');
		});

		test('rejects when no plan.json exists (PLAN_NOT_FOUND)', async () => {
			await mkdir(join(dir, '.swarm'), { recursive: true });
			ensureAgentSession('session-noplan', 'architect');

			await expect(
				delegationGateInternals.forceRecordPlanCriticApproval(
					dir,
					'session-noplan',
					{ reason: 'no plan' },
				),
			).rejects.toThrow('PLAN_NOT_FOUND');
		});

		test('rejects with PLAN_CORRUPT when plan.json is unparseable', async () => {
			await mkdir(join(dir, '.swarm'), { recursive: true });
			// Write a corrupt plan.json (invalid JSON).
			writeFileSync(join(dir, '.swarm', 'plan.json'), '{ not valid json');
			ensureAgentSession('session-corrupt', 'architect');

			await expect(
				delegationGateInternals.forceRecordPlanCriticApproval(
					dir,
					'session-corrupt',
					{ reason: 'corrupt plan' },
				),
			).rejects.toThrow('PLAN_CORRUPT');
		});
	});

	// ── Issue #2012: background critic is blocked upstream (Change 3 drop) ─
	// Per the plan critic (Kimi K3): a background critic dispatch is fail-closed
	// blocked at the toolBefore surface and never reaches the writer. This test
	// is a regression guard so a future background-enablement does not silently
	// reintroduce the phantom "writer bypass" concern.
	test('background critic dispatch is blocked upstream and does not reach the writer', async () => {
		const plan = makePlan();
		await writePlan(dir, plan);
		ensureAgentSession('session-bg', 'architect');
		const hook = createDelegationGateHook(makeConfig(), dir);

		// A background=true critic dispatch must be blocked in toolBefore.
		await expect(
			hook.toolBefore(
				{
					tool: 'Task',
					sessionID: 'session-bg',
					callID: 'bg-critic',
				},
				{
					args: {
						subagent_type: 'critic',
						background: true,
						prompt: 'MODE: CRITIC-GATE\nReview the plan.',
					},
				},
			),
		).rejects.toThrow('SWARM_BACKGROUND_TASK_BLOCKED');

		// And no plan-critic snapshot was recorded.
		const approved = await loadLastApprovedPlan(dir, derivePlanId(plan));
		expect(approved).toBeNull();
	});
});
