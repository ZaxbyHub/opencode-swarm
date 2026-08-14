/**
 * Issue #2131 residual criterion B — recurrence-sweep + implementation-review
 * receipt tools, their state readers, and trace-hook gate wiring.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AGENT_TOOL_MAP } from '../../../src/config/constants';
import {
	createIssueTraceHook,
	_internals as hookInternals,
	resetPhaseStatusCache,
} from '../../../src/hooks/issue-trace';
import {
	implementationReviewReceiptExists,
	recurrenceSweepReceiptExists,
	_internals as stateInternals,
} from '../../../src/hooks/issue-trace-state';
import { TOOL_MANIFEST } from '../../../src/tools/manifest.js';
import {
	executeRecordImplementationReview,
	record_implementation_review,
} from '../../../src/tools/record-implementation-review';
import {
	executeRecordRecurrenceSweep,
	record_recurrence_sweep,
} from '../../../src/tools/record-recurrence-sweep';
import { TOOL_NAMES } from '../../../src/tools/tool-names.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

function makeTempDir(): string {
	const dir = canonicalMkdtemp('residual-b-');
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	return dir;
}

let dir = '';
beforeEach(() => {
	dir = makeTempDir();
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const stateSnapshot = { ...stateInternals };
const hookSnapshot = { ...hookInternals };
afterEach(() => {
	Object.assign(stateInternals, stateSnapshot);
	Object.assign(hookInternals, hookSnapshot);
	resetPhaseStatusCache();
});

describe('registration (invariant 11)', () => {
	test('both tools are registered architect tools', () => {
		for (const name of [
			'record_recurrence_sweep',
			'record_implementation_review',
		]) {
			expect(TOOL_NAMES).toContain(name);
			expect(TOOL_MANIFEST[name as 'record_recurrence_sweep']).toBeDefined();
			expect(AGENT_TOOL_MAP.architect).toContain(name);
		}
		expect(record_recurrence_sweep.args.issueNumber).toBeDefined();
		expect(record_implementation_review.args.issueNumber).toBeDefined();
	});
});

describe('record_recurrence_sweep', () => {
	test('defect-class sweep with predicates + dispositions + guardrail satisfies the gate', async () => {
		const result = await executeRecordRecurrenceSweep(
			{
				issueNumber: 42,
				defectClass: 'unbounded await on init-path filesystem scan',
				predicates: ['withTimeout(', 'fs.readdir'],
				dispositions: [
					{ ref: 'src/index.ts:210', disposition: 'FIX' },
					{ ref: 'src/repo/graph.ts:88', disposition: 'FALSE_POSITIVE' },
				],
				guardrail: {
					kind: 'ci-check',
					description: 'repro-704 init deadline check',
					proof: 'fails when an init-path await exceeds the deadline',
				},
			},
			dir,
			{ sessionID: 's1' },
		);
		expect(JSON.parse(result).success).toBe(true);
		expect(await recurrenceSweepReceiptExists(dir, 42)).toBe(true);
	});

	test('"no defect class" fast path requires a justification', async () => {
		const bad = await executeRecordRecurrenceSweep(
			{ issueNumber: 42, defectClass: 'no defect class' },
			dir,
		);
		expect(JSON.parse(bad).success).toBe(false);

		const good = await executeRecordRecurrenceSweep(
			{
				issueNumber: 42,
				defectClass: 'no defect class',
				justification: 'docs-only change corrects no behavior',
			},
			dir,
		);
		expect(JSON.parse(good).success).toBe(true);
		expect(await recurrenceSweepReceiptExists(dir, 42)).toBe(true);
	});

	test('a defect-class sweep without predicates/dispositions/guardrail is rejected', async () => {
		const result = await executeRecordRecurrenceSweep(
			{ issueNumber: 42, defectClass: 'some real defect class' },
			dir,
		);
		expect(JSON.parse(result).success).toBe(false);
		expect(await recurrenceSweepReceiptExists(dir, 42)).toBe(false);
	});

	test('receipt is issue-bound', async () => {
		await executeRecordRecurrenceSweep(
			{
				issueNumber: 999,
				defectClass: 'no defect class',
				justification: 'n/a',
			},
			dir,
		);
		expect(await recurrenceSweepReceiptExists(dir, 42)).toBe(false);
	});
});

describe('record_implementation_review', () => {
	test('dual APPROVE receipt satisfies the gate', async () => {
		const result = await executeRecordImplementationReview(
			{
				issueNumber: 42,
				reviewerVerdict: 'APPROVE',
				criticVerdict: 'APPROVE',
				diffBase: 'abc1234',
				diffHead: 'def5678',
				notes: 'fresh contexts approved the diff',
			},
			dir,
			{ sessionID: 's1' },
		);
		expect(JSON.parse(result).success).toBe(true);
		expect(await implementationReviewReceiptExists(dir, 42)).toBe(true);
	});

	test('a non-approving verdict cannot satisfy the gate', async () => {
		const result = await executeRecordImplementationReview(
			{
				issueNumber: 42,
				reviewerVerdict: 'NEEDS_REVISION',
				criticVerdict: 'APPROVE',
				diffBase: 'abc1234',
				diffHead: 'def5678',
				notes: 'reviewer found issues',
			},
			dir,
		);
		expect(JSON.parse(result).success).toBe(false);
		expect(await implementationReviewReceiptExists(dir, 42)).toBe(false);
	});

	test('receipt is issue-bound', async () => {
		await executeRecordImplementationReview(
			{
				issueNumber: 999,
				reviewerVerdict: 'APPROVE',
				criticVerdict: 'APPROVE',
				diffBase: 'abc1234',
				diffHead: 'def5678',
				notes: 'approved for another issue',
			},
			dir,
		);
		expect(await implementationReviewReceiptExists(dir, 42)).toBe(false);
	});
});

describe('trace hook residual-B gates (issue #2131)', () => {
	function writeTraceState(dir: string): void {
		fs.writeFileSync(
			path.join(dir, '.swarm', 'issue-trace-state.json'),
			JSON.stringify({
				issueNumber: 42,
				lastTransition: 'PLAN_TO_EXECUTE',
				status: 'in_progress',
			}),
		);
	}

	function writePrereqs(dir: string): void {
		fs.writeFileSync(
			path.join(dir, '.swarm', 'issue-reference.json'),
			JSON.stringify({
				url: 'https://github.com/owner/repo/issues/42',
				owner: 'owner',
				repo: 'repo',
				number: 42,
				timestamp: '2026-01-01T00:00:00Z',
				flags: { trace: true, noRepro: true },
			}),
		);
		fs.writeFileSync(
			path.join(dir, '.swarm', 'spec.md'),
			'# Spec\n\n## Source Issue\n\n- Number: 42\n',
		);
	}

	test('missing review receipt → one-shot REVIEW_GATE directive; then quiet', async () => {
		writePrereqs(dir);
		writeTraceState(dir);
		hookInternals.readPlanPhaseStatus = () =>
			Promise.resolve({ planExists: true, allComplete: true });
		hookInternals.isPlanCriticApproved = () => Promise.resolve(true);

		const hook = createIssueTraceHook({}, dir, 50);
		const output1 = { messages: [] as unknown[] };
		await hook.messagesTransform({}, output1);
		const text1 = JSON.stringify(output1.messages);
		expect(text1).toContain('record_implementation_review');
		const state1 = JSON.parse(
			fs.readFileSync(
				path.join(dir, '.swarm', 'issue-trace-state.json'),
				'utf-8',
			),
		);
		expect(state1.lastTransition).toBe('REVIEW_GATE');

		// One-shot: second cycle without the receipt is quiet.
		const output2 = { messages: [] as unknown[] };
		await hook.messagesTransform({}, output2);
		expect(output2.messages).toHaveLength(0);
	});

	test('review approved, sweep missing → one-shot RECURRENCE_GATE directive', async () => {
		writePrereqs(dir);
		writeTraceState(dir);
		hookInternals.readPlanPhaseStatus = () =>
			Promise.resolve({ planExists: true, allComplete: true });
		hookInternals.isPlanCriticApproved = () => Promise.resolve(true);
		fs.writeFileSync(
			path.join(dir, '.swarm', 'implementation-review.json'),
			JSON.stringify({
				issueNumber: 42,
				reviewerVerdict: 'APPROVE',
				criticVerdict: 'APPROVE',
				diffBase: 'abc1234',
				diffHead: 'def5678',
				notes: 'approved',
			}),
		);

		const hook = createIssueTraceHook({}, dir, 50);
		const output = { messages: [] as unknown[] };
		await hook.messagesTransform({}, output);
		expect(JSON.stringify(output.messages)).toContain(
			'record_recurrence_sweep',
		);
		const state = JSON.parse(
			fs.readFileSync(
				path.join(dir, '.swarm', 'issue-trace-state.json'),
				'utf-8',
			),
		);
		expect(state.lastTransition).toBe('RECURRENCE_GATE');
	});

	test('both receipts present → commit-pr handoff fires', async () => {
		writePrereqs(dir);
		writeTraceState(dir);
		hookInternals.readPlanPhaseStatus = () =>
			Promise.resolve({ planExists: true, allComplete: true });
		hookInternals.isPlanCriticApproved = () => Promise.resolve(true);
		fs.writeFileSync(
			path.join(dir, '.swarm', 'implementation-review.json'),
			JSON.stringify({
				issueNumber: 42,
				reviewerVerdict: 'APPROVE',
				criticVerdict: 'APPROVE',
				diffBase: 'abc1234',
				diffHead: 'def5678',
				notes: 'approved',
			}),
		);
		fs.writeFileSync(
			path.join(dir, '.swarm', 'recurrence-sweep.json'),
			JSON.stringify({
				issueNumber: 42,
				defectClass: 'no defect class',
				justification: 'docs-only change',
			}),
		);

		const hook = createIssueTraceHook({}, dir, 50);
		const output = { messages: [] as unknown[] };
		await hook.messagesTransform({}, output);
		expect(JSON.stringify(output.messages)).toContain('commit-pr');
		const state = JSON.parse(
			fs.readFileSync(
				path.join(dir, '.swarm', 'issue-trace-state.json'),
				'utf-8',
			),
		);
		expect(state.lastTransition).toBe('EXECUTE_TO_COMMIT');
		expect(state.status).toBe('publication_handoff');
	});
});
