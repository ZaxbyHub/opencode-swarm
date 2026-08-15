import { describe, expect, test } from 'bun:test';
import {
	computeNextMode,
	type IssueReference,
	type TraceState,
	type TransitionResult,
	type WorkflowArtifacts,
} from '../../../src/hooks/issue-trace-reducer';

// ── Helpers ────────────────────────────────────────────────────────

const NOOP_FIELDS = { nextMode: null, directive: null };

function makeRef(overrides: Partial<IssueReference> = {}): IssueReference {
	return {
		url: 'https://github.com/acme/repo/issues/42',
		owner: 'acme',
		repo: 'repo',
		number: 42,
		timestamp: '2026-01-01T00:00:00Z',
		flags: { trace: true },
		...overrides,
	};
}

function makeTrace(overrides: Partial<TraceState> = {}): TraceState {
	return {
		issueNumber: 42,
		lastTransition: null,
		status: 'in_progress',
		...overrides,
	};
}

function makeArt(
	overrides: Partial<WorkflowArtifacts> = {},
): WorkflowArtifacts {
	return {
		specExists: true,
		specIssueNumber: 42,
		planExists: false,
		criticApproved: false,
		allPhasesComplete: false,
		reproductionPermitted: true,
		publicationObserved: false,
		implementationReviewVerified: true,
		recurrenceSweepVerified: true,
		...overrides,
	};
}

function isNoop(r: TransitionResult, s: TraceState): boolean {
	return (
		r.nextMode === null &&
		r.directive === null &&
		r.nextLastTransition === s.lastTransition &&
		r.nextStatus === s.status
	);
}

function call(
	issueRef: IssueReference | null,
	trace: TraceState,
	art: Partial<WorkflowArtifacts> = {},
) {
	return computeNextMode({
		issueReference: issueRef,
		traceState: trace,
		workflowArtifacts: makeArt(art),
	});
}

// ── Row (a): null issueReference or trace flag not set ────────────

describe('Row (a): no issue reference or trace flag missing', () => {
	test('null issueReference returns no-op', () => {
		const t = makeTrace();
		expect(isNoop(call(null, t), t)).toBe(true);
	});

	test('trace flag not set / false / only plan → no-op', () => {
		const t = makeTrace();
		for (const flags of [
			{},
			{ trace: false },
			{ plan: true },
		] as Partial<IssueReference>['flags'][]) {
			expect(isNoop(call(makeRef({ flags }), t), t)).toBe(true);
		}
	});
});

// ── Row (b): trace terminal (published) ──────────────────────────

describe('Row (b): trace already published (terminal)', () => {
	test('published trace returns no-op regardless of artifacts', () => {
		const t = makeTrace({
			status: 'published',
			lastTransition: 'PUBLISHED',
		});
		expect(
			isNoop(
				call(makeRef(), t, {
					planExists: true,
					criticApproved: true,
					allPhasesComplete: true,
				}),
				t,
			),
		).toBe(true);
	});
});

// ── Row (c): publication_handoff observation ─────────────────────

describe('Row (c): publication_handoff', () => {
	test('publication_handoff with publicationObserved → published', () => {
		const t = makeTrace({
			status: 'publication_handoff',
			lastTransition: 'EXECUTE_TO_COMMIT',
		});
		const r = call(makeRef(), t, { publicationObserved: true });
		expect(r.nextStatus).toBe('published');
		expect(r.nextLastTransition).toBe('PUBLISHED');
		expect(r.directive).toContain('Publication confirmed');
	});

	test('publication_handoff WITHOUT publicationObserved → no-op (waiting)', () => {
		const t = makeTrace({
			status: 'publication_handoff',
			lastTransition: 'EXECUTE_TO_COMMIT',
		});
		expect(isNoop(call(makeRef(), t, { publicationObserved: false }), t)).toBe(
			true,
		);
	});

	test('publication_handoff already PUBLISHED is idempotent', () => {
		const t = makeTrace({
			status: 'publication_handoff',
			lastTransition: 'PUBLISHED',
		});
		// Even if publicationObserved is true, PUBLISHED idempotency holds via row (b)?
		// No — status is still publication_handoff; lastTransition PUBLISHED means we
		// already emitted the published transition once. Re-running must no-op.
		expect(isNoop(call(makeRef(), t, { publicationObserved: true }), t)).toBe(
			true,
		);
	});
});

// ── Row (d): cross-issue fail-closed guard ─────────────────────

describe('Row (d): cross-issue fail-closed guard', () => {
	test('null specIssueNumber returns no-op', () => {
		const t = makeTrace();
		expect(isNoop(call(makeRef(), t, { specIssueNumber: null }), t)).toBe(true);
	});

	test('mismatched specIssueNumber returns no-op', () => {
		const t = makeTrace();
		expect(
			isNoop(call(makeRef({ number: 42 }), t, { specIssueNumber: 99 }), t),
		).toBe(true);
	});

	test('correct specIssueNumber does not block transitions', () => {
		const r = call(
			makeRef({ number: 42 }),
			makeTrace({ lastTransition: null }),
			{ specIssueNumber: 42, planExists: false },
		);
		expect(r.nextMode).toBe('PLAN');
		expect(r.nextLastTransition).toBe('ISSUE_INGEST_TO_PLAN');
	});

	test('mismatched traceState.issueNumber returns no-op even when specIssueNumber matches', () => {
		const t = makeTrace({ issueNumber: 99 }); // trace belongs to issue 99
		expect(
			isNoop(
				call(makeRef({ number: 42 }), t, {
					specIssueNumber: 42,
					planExists: false,
				}),
				t,
			),
		).toBe(true);
	});
});

// ── Row (e): spec does not exist ──────────────────────────────────

describe('Row (e): spec does not exist', () => {
	test('specExists false returns no-op even with full artifacts', () => {
		const t = makeTrace();
		expect(isNoop(call(makeRef(), t, { specExists: false }), t)).toBe(true);
	});
});

// ── Row (f): spec exists, no plan, reproduction permitted → PLAN ─

describe('Row (f): spec exists, no plan → PLAN (reproduction gate)', () => {
	test('transitions to PLAN with ISSUE_INGEST_TO_PLAN when reproduction permitted', () => {
		const r = call(makeRef(), makeTrace({ lastTransition: null }), {
			planExists: false,
			reproductionPermitted: true,
		});
		expect(r).toEqual({
			...NOOP_FIELDS,
			nextLastTransition: 'ISSUE_INGEST_TO_PLAN',
			nextStatus: 'in_progress',
			nextMode: 'PLAN',
		});
	});

	test('emits a ONE-SHOT reproduction-required directive when NOT permitted', () => {
		// First drive: lastTransition null + no repro → one-shot directive.
		const t = makeTrace({ lastTransition: null });
		const r = call(makeRef(), t, {
			planExists: false,
			reproductionPermitted: false,
		});
		expect(r.nextMode).toBe('ISSUE_INGEST');
		expect(r.nextLastTransition).toBe('REPRO_GATE');
		expect(r.directive).toContain('record_issue_reproduction');

		// Second drive: already at REPRO_GATE + still no repro → silent noop
		// (one-shot already fired; waits for evidence without re-nagging).
		const t2 = makeTrace({ lastTransition: 'REPRO_GATE' });
		expect(
			isNoop(
				call(makeRef(), t2, {
					planExists: false,
					reproductionPermitted: false,
				}),
				t2,
			),
		).toBe(true);
	});

	test('PLAN fires from REPRO_GATE once reproduction becomes permitted', () => {
		const r = call(makeRef(), makeTrace({ lastTransition: 'REPRO_GATE' }), {
			planExists: false,
			reproductionPermitted: true,
		});
		expect(r.nextMode).toBe('PLAN');
		expect(r.nextLastTransition).toBe('ISSUE_INGEST_TO_PLAN');
	});

	test('works with non-42 issue numbers', () => {
		const r = computeNextMode({
			issueReference: makeRef({ number: 7 }),
			traceState: makeTrace({ issueNumber: 7, lastTransition: null }),
			workflowArtifacts: makeArt({ specIssueNumber: 7, planExists: false }),
		});
		expect(r.nextMode).toBe('PLAN');
	});

	test('idempotency: already at ISSUE_INGEST_TO_PLAN returns no-op', () => {
		const t = makeTrace({ lastTransition: 'ISSUE_INGEST_TO_PLAN' });
		expect(isNoop(call(makeRef(), t, { planExists: false }), t)).toBe(true);
	});

	test('does not fire if plan exists', () => {
		const t = makeTrace({ lastTransition: null });
		expect(isNoop(call(makeRef(), t, { planExists: true }), t)).toBe(true);
	});
});
