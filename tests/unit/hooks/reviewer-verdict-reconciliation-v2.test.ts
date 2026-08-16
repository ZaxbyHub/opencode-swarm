/**
 * Exact-pair and authority-ordering regressions for reviewer reconciliation.
 *
 * Falsifiability: returning a ledger failure makes the historical diagnostic-
 * first implementation call recordKnowledgeEvent, so the ordering test fails
 * if the V2 authority check is removed or moved after legacy diagnostics.
 */

import { afterEach, describe, expect, it, mock } from 'bun:test';
import type { DirectiveToVerify } from '../../../src/agents/reviewer-directive-compliance.js';
import {
	_internals,
	reconcileReviewerVerdicts,
} from '../../../src/hooks/reviewer-verdict-parser.js';

const originals = { ..._internals };

afterEach(() => {
	Object.assign(_internals, originals);
});

function directive(
	trace_id: string,
	entry_id: string,
	priority: DirectiveToVerify['priority'] = 'medium',
): DirectiveToVerify {
	return { trace_id, entry_id, session_id: 'session-1', priority };
}

describe('reconcileReviewerVerdicts V2 authority', () => {
	it('commits and diagnoses every exact pair without minting a trace id', async () => {
		const committedInputs: Array<Record<string, unknown>> = [];
		const diagnosticTraces: string[] = [];
		_internals.validateAndCommitTerminalBatch = mock(
			async (_directory, input) => {
				committedInputs.push(input as unknown as Record<string, unknown>);
				const items = (input as { items: Array<{ entry_id: string }> }).items;
				return {
					ok: true,
					accepted: items.map((terminal) => ({
						entry_id: terminal.entry_id,
						outcome: 'applied' as const,
						event_id: `event-${terminal.entry_id}`,
					})),
					idempotent: [],
					rejected: [],
					closes_no_relevant: false,
				};
			},
		) as unknown as typeof originals.validateAndCommitTerminalBatch;
		_internals.recordKnowledgeEvent = mock(async (_directory, event) => {
			diagnosticTraces.push(event.trace_id);
		}) as unknown as typeof originals.recordKnowledgeEvent;
		_internals.escalateViolatedEntries = mock(
			async () => [],
		) as unknown as typeof originals.escalateViolatedEntries;

		const result = await reconcileReviewerVerdicts({
			directory: 'project',
			transcript: [
				'VERIFIED:trace-a:shared-entry evidence=first',
				'VERIFIED:trace-b:shared-entry evidence=second',
			].join('\n'),
			directivesToVerify: [
				{
					...directive('trace-a', 'shared-entry'),
					cohort_id: 'cohort-a',
					source_link_id: 'link-a',
				},
				directive('trace-b', 'shared-entry'),
			],
		});

		expect(committedInputs.map((input) => input.trace_id)).toEqual([
			'trace-a',
			'trace-b',
		]);
		expect(committedInputs[0]).toMatchObject({
			cohort_id: 'cohort-a',
			source_link_id: 'link-a',
		});
		expect(diagnosticTraces).toEqual(['trace-a', 'trace-b']);
		expect(result.emitted.map((item) => item.trace_id)).toEqual([
			'trace-a',
			'trace-b',
		]);
	});

	it('returns typed uncertainty and writes no diagnostic when V2 rejects', async () => {
		const order: string[] = [];
		_internals.validateAndCommitTerminalBatch = mock(async () => {
			order.push('v2-failed');
			return {
				ok: false,
				code: 'lock_timeout',
				detail: 'authoritative receipt lock timed out',
			};
		}) as unknown as typeof originals.validateAndCommitTerminalBatch;
		_internals.recordKnowledgeEvent = mock(async () => {
			order.push('diagnostic-written');
		}) as unknown as typeof originals.recordKnowledgeEvent;

		const result = await reconcileReviewerVerdicts({
			directory: 'project',
			transcript: 'VERIFIED:origin-trace:entry-1 evidence=ok',
			directivesToVerify: [directive('origin-trace', 'entry-1')],
		});

		expect(order).toEqual(['v2-failed']);
		expect(result.emitted).toEqual([]);
		expect(result.uncertainties).toEqual([
			{
				trace_id: 'origin-trace',
				entry_id: 'entry-1',
				code: 'lock_timeout',
				uncertainty: 'authoritative receipt lock timed out',
			},
		]);
	});

	it('commits an omitted critical against its originating pair', async () => {
		let captured: Record<string, unknown> | undefined;
		_internals.validateAndCommitTerminalBatch = mock(
			async (_directory, input) => {
				captured = input as unknown as Record<string, unknown>;
				return {
					ok: true,
					accepted: [
						{
							entry_id: 'critical-entry',
							outcome: 'violated' as const,
							event_id: 'critical-event',
						},
					],
					idempotent: [],
					rejected: [],
					closes_no_relevant: false,
				};
			},
		) as unknown as typeof originals.validateAndCommitTerminalBatch;
		_internals.recordKnowledgeEvent = mock(
			async () => undefined,
		) as unknown as typeof originals.recordKnowledgeEvent;
		_internals.escalateViolatedEntries = mock(
			async () => [],
		) as unknown as typeof originals.escalateViolatedEntries;

		const result = await reconcileReviewerVerdicts({
			directory: 'project',
			transcript: 'DIRECTIVE_COMPLIANCE: none',
			directivesToVerify: [
				directive('critical-trace', 'critical-entry', 'critical'),
			],
		});

		expect(captured?.trace_id).toBe('critical-trace');
		expect(captured?.items).toEqual([
			{
				entry_id: 'critical-entry',
				outcome: 'violated',
				source: 'reviewer',
				reason: 'reviewer_omitted',
			},
		]);
		expect(result.omittedCriticals).toEqual([
			{ trace_id: 'critical-trace', entry_id: 'critical-entry' },
		]);
	});

	it('rejects evidence-free VERIFIED and fails a critical pair closed (#2031)', async () => {
		// Regression finding #2031-W3. Falsification: deleting the evidence guard
		// changes the captured authoritative terminal from violated to applied.
		let captured: Record<string, unknown> | undefined;
		_internals.validateAndCommitTerminalBatch = mock(
			async (_directory, input) => {
				captured = input as unknown as Record<string, unknown>;
				return {
					ok: true,
					accepted: [
						{
							entry_id: 'evidence-entry',
							outcome: 'violated' as const,
							event_id: 'missing-evidence-event',
						},
					],
					idempotent: [],
					rejected: [],
					closes_no_relevant: false,
				};
			},
		) as unknown as typeof originals.validateAndCommitTerminalBatch;
		_internals.recordKnowledgeEvent = mock(async () => undefined) as never;
		_internals.escalateViolatedEntries = mock(async () => []) as never;

		const result = await reconcileReviewerVerdicts({
			directory: 'project',
			transcript: 'VERIFIED:evidence-trace:evidence-entry',
			directivesToVerify: [
				directive('evidence-trace', 'evidence-entry', 'critical'),
			],
		});

		expect(captured?.items).toEqual([
			{
				entry_id: 'evidence-entry',
				outcome: 'violated',
				source: 'reviewer',
				reason: 'reviewer_missing_evidence',
			},
		]);
		expect(result.uncertainties).toContainEqual({
			trace_id: 'evidence-trace',
			entry_id: 'evidence-entry',
			code: 'reviewer_missing_evidence',
			uncertainty: 'VERIFIED requires nonempty evidence',
		});
		expect(result.emitted).toContainEqual(
			expect.objectContaining({ type: 'violated' }),
		);
	});

	it('uses an explicit CAS authorization to remediate a prior violation', async () => {
		let captured: Record<string, unknown> | undefined;
		_internals.validateAndCommitTerminalBatch = mock(
			async (_directory, input) => {
				captured = input as unknown as Record<string, unknown>;
				return {
					ok: true,
					accepted: [
						{
							entry_id: 'remediated-entry',
							outcome: 'applied' as const,
							event_id: 'remediation-event',
						},
					],
					idempotent: [],
					rejected: [],
					closes_no_relevant: false,
				};
			},
		) as unknown as typeof originals.validateAndCommitTerminalBatch;
		_internals.recordKnowledgeEvent = mock(async () => undefined) as never;
		_internals.escalateViolatedEntries = mock(async () => []) as never;

		await reconcileReviewerVerdicts({
			directory: 'project',
			transcript:
				'VERIFIED:remediation-trace:remediated-entry evidence=tests passed',
			directivesToVerify: [
				{
					...directive('remediation-trace', 'remediated-entry', 'critical'),
					prior_terminal_outcome: 'violated',
					prior_terminal_event_id: 'prior-violation-event',
				},
			],
		});

		expect(captured?.authorization).toEqual({
			actor: 'reviewer-remediation',
			reason: 'reviewer_verified_remediation',
			expected_event_id: 'prior-violation-event',
			expected_outcome: 'violated',
		});
	});
});
