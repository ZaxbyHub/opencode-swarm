/**
 * r14 audit repair (P1-6): harden the critic verdict extraction and the
 * plan-critic approval binding.
 *
 * 6.1 — CommonMark INDENTED code blocks are excluded from the verdict
 * search: an "Example:" template with a 4-space-indented `VERDICT: APPROVED`
 * line must never approve. Tabs, nested lists, and multi-verdict examples
 * are covered.
 *
 * 6.2 — the approval binds the plan IDENTITY and the dispatch prompt
 * payload digest; a mismatch is a final refusal.
 *
 * 6.3 — a MISSING pre-execution plan binding (no dispatch-time structure
 * hash) records NOTHING: an unproven automatic approval is refused
 * (unbound_dispatch); the audited manual escape hatch remains.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import {
	extractPlanCriticVerdict,
	recordVerifiedPlanCriticApproval,
} from '../../../src/plan/critic-approval';
import { computePlanStructureHash, initLedger } from '../../../src/plan/ledger';
import { resetStartupLedgerCheck } from '../../../src/plan/manager';
import { derivePlanId } from '../../../src/plan/utils';
import { resetSwarmState } from '../../../src/state';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

function makePlan(title = 'P6 Hardening Plan'): Plan {
	return {
		schema_version: '1.0.0',
		title,
		swarm: 'p6-hardening',
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

const APPROVED = 'VERDICT: APPROVED';
const REJECTED = 'VERDICT: REJECTED';

describe('extractPlanCriticVerdict — indented code blocks (r14 P1-6.1)', () => {
	test('an indented VERDICT example after a blank line is excluded', () => {
		// The audit's exact case: "Example:" followed by a 4-space indented
		// VERDICT: APPROVED line — CommonMark indented code, never a verdict.
		expect(
			extractPlanCriticVerdict(
				'Here is the required output format.\n\nExample:\n\n    VERDICT: APPROVED\n',
			),
		).toBeNull();
		expect(
			extractPlanCriticVerdict('Example:\n    VERDICT: APPROVED'),
		).toBeNull();
	});

	test('a TAB-indented VERDICT example is excluded', () => {
		expect(
			extractPlanCriticVerdict('Example:\n\n\tVERDICT: APPROVED'),
		).toBeNull();
		// Tab stops: two tabs also reach ≥4 columns.
		expect(
			extractPlanCriticVerdict('Example:\n\n\t\tVERDICT: APPROVED'),
		).toBeNull();
	});

	test('the indented exclusion zone spans the whole block', () => {
		expect(
			extractPlanCriticVerdict(
				'Example:\n\n    Some preamble line.\n    VERDICT: APPROVED\n    More detail.\n\nReal conclusion follows.',
			),
		).toBeNull();
	});

	test('a real unindented verdict still approves after an example block', () => {
		expect(
			extractPlanCriticVerdict(
				`Example:\n\n    VERDICT: APPROVED\n\nReview complete.\n${REJECTED}\n`,
			),
		).toBe('REJECTED');
		expect(
			extractPlanCriticVerdict(
				`Example:\n\n    VERDICT: REJECTED\n\nReview complete.\n${APPROVED}\n`,
			),
		).toBe('APPROVED');
	});

	test('an indented contradictory example does not poison the real verdict', () => {
		// The indented REJECTED is excluded (example material), so the real
		// flush-left APPROVED stands — no false contradiction.
		expect(
			extractPlanCriticVerdict(
				`Example:\n    VERDICT: REJECTED\n\nBut actually:\nVERDICT: APPROVED\n`,
			),
		).toBe('APPROVED');
		// Two REAL flush-left contradictory verdicts still fail closed.
		expect(
			extractPlanCriticVerdict(
				'VERDICT: REJECTED\n\nBut actually:\nVERDICT: APPROVED\n',
			),
		).toBeNull();
	});

	test('deeply nested list verdicts fail closed (conservative by design)', () => {
		// A verdict indented ≥4 columns inside a nested list is excluded too —
		// deliberately MORE conservative than CommonMark (which would keep
		// list continuations): a missed approval is recoverable (re-run the
		// gate with a flush-left verdict), a false one is not.
		expect(
			extractPlanCriticVerdict(
				'- summary:\n  - verdict line:\n    VERDICT: APPROVED\n',
			),
		).toBeNull();
		// A shallow (≤3-column) indented verdict still works.
		expect(extractPlanCriticVerdict('  VERDICT: APPROVED\n')).toBe('APPROVED');
		expect(extractPlanCriticVerdict('   VERDICT: APPROVED\n')).toBe('APPROVED');
	});

	test('fenced and indented exclusions compose', () => {
		expect(
			extractPlanCriticVerdict(
				'```\nVERDICT: APPROVED\n```\n\nExample:\n\n    VERDICT: APPROVED\n\nVERDICT: NEEDS_REVISION\n',
			),
		).toBe('NEEDS_REVISION');
	});

	test('an all-indented verdict-only body never approves', () => {
		// The entire output is an indented code block — no verdict at all.
		expect(extractPlanCriticVerdict('    VERDICT: APPROVED\n')).toBeNull();
	});

	test('the bare-token fallback ignores indented code too', () => {
		// A bare APPROVED inside an indented block near the end must not
		// trigger the tail fallback.
		expect(extractPlanCriticVerdict('Example:\n\n    APPROVED\n')).toBeNull();
		// ...while a real bare verdict at the end still works.
		expect(extractPlanCriticVerdict('Summary.\n\nAPPROVED\n')).toBe('APPROVED');
	});
});

describe('recordVerifiedPlanCriticApproval — binding hardening (r14 P1-6.2/6.3)', () => {
	let directory: string;
	let cleanup: () => void;
	let plan: Plan;

	beforeEach(() => {
		resetSwarmState();
		resetStartupLedgerCheck();
		({ dir: directory, cleanup } = createSafeTestDir('critic-p6-'));
		plan = makePlan();
		mkdirSync(join(directory, '.swarm'), { recursive: true });
		writeFileSync(
			join(directory, '.swarm', 'plan.json'),
			JSON.stringify(plan, null, 2),
		);
	});

	afterEach(() => {
		resetSwarmState();
		resetStartupLedgerCheck();
		closeAllProjectDbs();
		cleanup();
	});

	test('a missing pre-execution binding is refused — no unproven auto-approval (6.3)', async () => {
		await initLedger(directory, derivePlanId(plan));
		const result = await recordVerifiedPlanCriticApproval(directory, {
			parentSessionId: 'ses_p6',
			callId: 'call-p6-unbound',
			verdictText: `${APPROVED}\nSolid plan.`,
			transport: 'async_completion',
		});
		expect(result.outcome).toBe('skipped');
		expect(result.outcome === 'skipped' && result.reasonCode).toBe(
			'unbound_dispatch',
		);
		expect(
			result.outcome === 'skipped' &&
				result.reason.includes('approve_plan_critic'),
		).toBe(true);
	});

	test('a plan identity change is a final refusal (6.2)', async () => {
		await initLedger(directory, derivePlanId(plan));
		const result = await recordVerifiedPlanCriticApproval(directory, {
			parentSessionId: 'ses_p6',
			callId: 'call-p6-id',
			verdictText: `${APPROVED}\nSolid plan.`,
			dispatchPlanStructureHash: computePlanStructureHash(plan),
			// A DIFFERENT plan id than the current plan's.
			dispatchPlanId: derivePlanId(makePlan('A Different Plan')),
			transport: 'async_completion',
		});
		expect(result.outcome).toBe('skipped');
		expect(result.outcome === 'skipped' && result.reasonCode).toBe('conflict');
		expect(
			result.outcome === 'skipped' && result.reason.includes('identity'),
		).toBe(true);
	});

	test('a matching plan id records (6.2)', async () => {
		await initLedger(directory, derivePlanId(plan));
		const result = await recordVerifiedPlanCriticApproval(directory, {
			parentSessionId: 'ses_p6',
			callId: 'call-p6-id-ok',
			verdictText: `${APPROVED}\nSolid plan.`,
			dispatchPlanStructureHash: computePlanStructureHash(plan),
			dispatchPlanId: derivePlanId(plan),
			transport: 'async_completion',
		});
		expect(result.outcome).toBe('recorded');
	});

	test('a prompt digest mismatch is a final refusal (6.2)', async () => {
		await initLedger(directory, derivePlanId(plan));
		const dispatchPrompt = 'MODE: CRITIC-GATE\n<the plan>';
		const observedPrompt = 'MODE: CRITIC-GATE\n<the EDITED plan>';
		const result = await recordVerifiedPlanCriticApproval(directory, {
			parentSessionId: 'ses_p6',
			callId: 'call-p6-prompt',
			verdictText: `${APPROVED}\nSolid plan.`,
			dispatchPlanStructureHash: computePlanStructureHash(plan),
			dispatchPromptDigest: createHash('sha256')
				.update(dispatchPrompt)
				.digest('hex'),
			observedPromptDigest: createHash('sha256')
				.update(observedPrompt)
				.digest('hex'),
			transport: 'async_completion',
		});
		expect(result.outcome).toBe('skipped');
		expect(result.outcome === 'skipped' && result.reasonCode).toBe('conflict');
		expect(
			result.outcome === 'skipped' && result.reason.includes('prompt binding'),
		).toBe(true);
	});

	test('an unobservable prompt payload with a bound digest is refused (6.2)', async () => {
		await initLedger(directory, derivePlanId(plan));
		const result = await recordVerifiedPlanCriticApproval(directory, {
			parentSessionId: 'ses_p6',
			callId: 'call-p6-prompt-null',
			verdictText: `${APPROVED}\nSolid plan.`,
			dispatchPlanStructureHash: computePlanStructureHash(plan),
			dispatchPromptDigest: createHash('sha256')
				.update('MODE: CRITIC-GATE\n<the plan>')
				.digest('hex'),
			observedPromptDigest: null,
			transport: 'async_completion',
		});
		expect(result.outcome).toBe('skipped');
		expect(result.outcome === 'skipped' && result.reasonCode).toBe('conflict');
	});

	test('a matching prompt digest records (6.2)', async () => {
		await initLedger(directory, derivePlanId(plan));
		const dispatchPrompt = 'MODE: CRITIC-GATE\n<the plan>';
		const digest = createHash('sha256').update(dispatchPrompt).digest('hex');
		const result = await recordVerifiedPlanCriticApproval(directory, {
			parentSessionId: 'ses_p6',
			callId: 'call-p6-prompt-ok',
			verdictText: `${APPROVED}\nSolid plan.`,
			dispatchPlanStructureHash: computePlanStructureHash(plan),
			dispatchPromptDigest: digest,
			observedPromptDigest: digest,
			transport: 'async_completion',
		});
		expect(result.outcome).toBe('recorded');
	});

	test('a legacy binding without a prompt digest still records on the hash fence (documented weaker guarantee)', async () => {
		await initLedger(directory, derivePlanId(plan));
		const result = await recordVerifiedPlanCriticApproval(directory, {
			parentSessionId: 'ses_p6',
			callId: 'call-p6-legacy',
			verdictText: `${APPROVED}\nSolid plan.`,
			dispatchPlanStructureHash: computePlanStructureHash(plan),
			dispatchPromptDigest: null,
			observedPromptDigest: null,
			transport: 'async_completion',
		});
		expect(result.outcome).toBe('recorded');
	});

	test('an indented-example-only APPROVED never reaches the recorder path', async () => {
		// Even with a perfect binding, a verdict that ONLY exists inside an
		// indented code example is not an APPROVED verdict (6.1 + recorder
		// integration).
		await initLedger(directory, derivePlanId(plan));
		const result = await recordVerifiedPlanCriticApproval(directory, {
			parentSessionId: 'ses_p6',
			callId: 'call-p6-indented',
			verdictText: 'Example:\n\n    VERDICT: APPROVED\n',
			dispatchPlanStructureHash: computePlanStructureHash(plan),
			transport: 'async_completion',
		});
		expect(result.outcome).toBe('not_approved');
	});
});
