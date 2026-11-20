import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import {
	recordVerifiedPlanCriticApproval,
} from '../../../src/plan/critic-approval';
import {
	computePlanStructureHash,
	initLedger,
	loadLastPlanCriticApprovedSnapshot,
} from '../../../src/plan/ledger';
import { resetStartupLedgerCheck } from '../../../src/plan/manager';
import { derivePlanId } from '../../../src/plan/utils';
import { resetSwarmState } from '../../../src/state';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

function makePlan(title = 'Async Critic Approval'): Plan {
	return {
		schema_version: '1.0.0',
		title,
		swarm: 'async-critic',
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

describe('plan-critic strict verdict parser (r13 audit P0-1)', () => {
	let dir: string;
	let cleanup: () => void;
	let plan: Plan;

	beforeEach(() => {
		resetSwarmState();
		resetStartupLedgerCheck();
		({ dir, cleanup } = createSafeTestDir('critic-approval-'));
		plan = makePlan();
		writePlan(dir, plan);
	});

	afterEach(() => {
		resetSwarmState();
		resetStartupLedgerCheck();
		closeAllProjectDbs();
		cleanup();
	});

	test('P0-1 regression: enumeration template must never parse as APPROVED', async () => {
		await initLedger(dir, derivePlanId(plan));
		// The exact enumeration the critic system prompt carries
		// (src/agents/critic.ts "VERDICT: APPROVED | NEEDS_REVISION | REJECTED").
		// A model echoing the rubric template must not release the plan gate.
		const result = await recordVerifiedPlanCriticApproval(dir, {
			parentSessionId: 'ses_parent_1',
			callId: 'call-critic-enum',
			verdictText:
				'Plan review complete.\n\nVERDICT: APPROVED | NEEDS_REVISION | REJECTED\nPick one.',
			dispatchPlanStructureHash: computePlanStructureHash(plan),
			transport: 'async_completion',
		});
		expect(result.outcome).toBe('not_approved');
		expect(
			await loadLastPlanCriticApprovedSnapshot(dir, derivePlanId(plan)),
		).toBeNull();
	});

	test('P0-1 regression: verdict inside a fenced code block never approves', async () => {
		await initLedger(dir, derivePlanId(plan));
		for (const text of [
			// 3-backtick fence with info string
			'Analysis:\n```text\nVERDICT: APPROVED\n```\nNo final verdict yet.',
			// 4-backtick outer fence (nested-fence shape)
			'Example output:\n````\n```text\nVERDICT: APPROVED\n```\n````',
			// ~~~ fence
			'~~~\nVERDICT: APPROVED\n~~~',
			// ~~~ with info string
			'~~~text\nVERDICT: APPROVED\n~~~',
		]) {
			const result = await recordVerifiedPlanCriticApproval(dir, {
				parentSessionId: 'ses_parent_1',
				callId: 'call-critic-fence',
				verdictText: text,
				dispatchPlanStructureHash: computePlanStructureHash(plan),
				transport: 'async_completion',
			});
			expect(result.outcome).toBe('not_approved');
		}
		expect(
			await loadLastPlanCriticApprovedSnapshot(dir, derivePlanId(plan)),
		).toBeNull();
	});

	test('P0-1 regression: contradictory verdicts never approve', async () => {
		await initLedger(dir, derivePlanId(plan));
		const result = await recordVerifiedPlanCriticApproval(dir, {
			parentSessionId: 'ses_parent_1',
			callId: 'call-critic-contradiction',
			verdictText:
				'Example:\nVERDICT: APPROVED\n\nActual:\nVERDICT: REJECTED\nFundamental flaws.',
			dispatchPlanStructureHash: computePlanStructureHash(plan),
			transport: 'async_completion',
		});
		expect(result.outcome).toBe('not_approved');
		expect(
			await loadLastPlanCriticApprovedSnapshot(dir, derivePlanId(plan)),
		).toBeNull();
	});

	test('P0-1 regression: quoted template and table rows never approve', async () => {
		await initLedger(dir, derivePlanId(plan));
		for (const text of [
			// Markdown blockquote quoting the expected output format
			'> VERDICT: APPROVED\n\n(nothing else)',
			// Markdown table row
			'| Field | Value |\n| --- | --- |\n| VERDICT | APPROVED |',
			// Slashed alternatives list
			'VERDICT: APPROVED / NEEDS_REVISION / REJECTED',
			// Comma-separated alternatives list
			'VERDICT: APPROVED, NEEDS_REVISION, REJECTED',
		]) {
			const result = await recordVerifiedPlanCriticApproval(dir, {
				parentSessionId: 'ses_parent_1',
				callId: 'call-critic-quoted',
				verdictText: text,
				dispatchPlanStructureHash: computePlanStructureHash(plan),
				transport: 'async_completion',
			});
			expect(result.outcome).toBe('not_approved');
		}
		expect(
			await loadLastPlanCriticApprovedSnapshot(dir, derivePlanId(plan)),
		).toBeNull();
	});

	test('P0-1 regression: truncated terminal result never approves', async () => {
		await initLedger(dir, derivePlanId(plan));
		const result = await recordVerifiedPlanCriticApproval(dir, {
			parentSessionId: 'ses_parent_1',
			callId: 'call-critic-truncated',
			verdictText: 'Analysis so far…\n\nVERDICT: APPROV',
			verdictTruncated: true,
			dispatchPlanStructureHash: computePlanStructureHash(plan),
			transport: 'async_completion',
		});
		expect(result.outcome).toBe('not_approved');
		expect(result.reason).toContain('truncated');
		expect(
			await loadLastPlanCriticApprovedSnapshot(dir, derivePlanId(plan)),
		).toBeNull();
	});

	test('P0-1 regression: valid variants still parse (bold label, CRLF, repeated identical verdict)', async () => {
		await initLedger(dir, derivePlanId(plan));
		const dispatchHash = computePlanStructureHash(plan);
		for (const [callId, text] of [
			['call-bold', 'Review done.\r\n\r\n**VERDICT**: APPROVED\r\n'],
			['call-crlf', 'Review done.\r\nVERDICT: APPROVED\r\n'],
			[
				'call-repeated',
				'VERDICT: APPROVED\n\n…details…\n\nVERDICT: APPROVED\n',
			],
			['call-heading', '## Verdict\n\nAPPROVED\n'],
		] as const) {
			const result = await recordVerifiedPlanCriticApproval(dir, {
				parentSessionId: 'ses_parent_1',
				callId,
				verdictText: text,
				dispatchPlanStructureHash: dispatchHash,
				transport: 'async_completion',
			});
			expect(result.outcome).toBe('recorded');
		}
	});

	test('P0-1 regression: APPROVED mentioned in prose without a verdict line never approves', async () => {
		await initLedger(dir, derivePlanId(plan));
		const result = await recordVerifiedPlanCriticApproval(dir, {
			parentSessionId: 'ses_parent_1',
			callId: 'call-critic-prose',
			verdictText:
				'The overall approach looks approved for execution in principle, but I still need to check phase 2.\nI will continue the review.',
			dispatchPlanStructureHash: computePlanStructureHash(plan),
			transport: 'async_completion',
		});
		expect(result.outcome).toBe('not_approved');
		expect(
			await loadLastPlanCriticApprovedSnapshot(dir, derivePlanId(plan)),
		).toBeNull();
	});

	test('P0-1 regression: unknown verdict token never approves', async () => {
		await initLedger(dir, derivePlanId(plan));
		const result = await recordVerifiedPlanCriticApproval(dir, {
			parentSessionId: 'ses_parent_1',
			callId: 'call-critic-unknown',
			verdictText: 'VERDICT: PARTIALLY_APPROVED',
			dispatchPlanStructureHash: computePlanStructureHash(plan),
			transport: 'async_completion',
		});
		expect(result.outcome).toBe('not_approved');
	});

	test('P0-1 regression: empty output never approves', async () => {
		await initLedger(dir, derivePlanId(plan));
		const result = await recordVerifiedPlanCriticApproval(dir, {
			parentSessionId: 'ses_parent_1',
			callId: 'call-critic-empty',
			verdictText: '',
			dispatchPlanStructureHash: computePlanStructureHash(plan),
			transport: 'async_completion',
		});
		expect(result.outcome).toBe('not_approved');
	});
});
