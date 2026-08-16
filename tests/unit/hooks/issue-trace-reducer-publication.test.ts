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

// ── Row (g): plan exists but critic not approved → no-op ────────

describe('Row (g): plan exists but critic not approved', () => {
	test('criticApproved false returns no-op', () => {
		const t = makeTrace({ lastTransition: 'ISSUE_INGEST_TO_PLAN' });
		expect(isNoop(call(makeRef(), t, { planExists: true }), t)).toBe(true);
	});

	test('criticApproved false with allPhasesComplete true still no-op', () => {
		const t = makeTrace({ lastTransition: 'ISSUE_INGEST_TO_PLAN' });
		expect(
			isNoop(
				call(makeRef(), t, { planExists: true, allPhasesComplete: true }),
				t,
			),
		).toBe(true);
	});
});

// ── planExists guard for rows (h) and (i) ─────────────────────────

describe('planExists guard: rows (h) and (i) unreachable without plan', () => {
	test('planExists=false + criticApproved=true returns no-op (row h unreachable)', () => {
		const t = makeTrace({ lastTransition: 'ISSUE_INGEST_TO_PLAN' });
		expect(
			isNoop(
				call(makeRef(), t, {
					planExists: false,
					criticApproved: true,
					allPhasesComplete: false,
				}),
				t,
			),
		).toBe(true);
	});

	test('planExists=false + allPhasesComplete=true returns no-op (row i unreachable)', () => {
		const t = makeTrace({ lastTransition: 'ISSUE_INGEST_TO_PLAN' });
		expect(
			isNoop(
				call(makeRef(), t, {
					planExists: false,
					criticApproved: true,
					allPhasesComplete: true,
				}),
				t,
			),
		).toBe(true);
	});
});

// ── Row (h): critic approved, phases incomplete → EXECUTE ────────

describe('Row (h): critic approved, phases incomplete → EXECUTE', () => {
	const approvedIncomplete = {
		planExists: true,
		criticApproved: true,
		allPhasesComplete: false,
	};

	test('transitions to EXECUTE with PLAN_TO_EXECUTE', () => {
		const r = call(
			makeRef(),
			makeTrace({ lastTransition: 'ISSUE_INGEST_TO_PLAN' }),
			approvedIncomplete,
		);
		expect(r).toEqual({
			...NOOP_FIELDS,
			nextMode: 'EXECUTE',
			nextLastTransition: 'PLAN_TO_EXECUTE',
			nextStatus: 'in_progress',
		});
	});

	test('transitions from any non-PLAN_TO_EXECUTE lastTransition', () => {
		const r = call(
			makeRef(),
			makeTrace({ lastTransition: 'OTHER' }),
			approvedIncomplete,
		);
		expect(r.nextMode).toBe('EXECUTE');
	});

	test('idempotency: already at PLAN_TO_EXECUTE returns no-op', () => {
		const t = makeTrace({ lastTransition: 'PLAN_TO_EXECUTE' });
		expect(isNoop(call(makeRef(), t, approvedIncomplete), t)).toBe(true);
	});

	test('does not fire if allPhasesComplete is true (falls to row i)', () => {
		const r = call(
			makeRef(),
			makeTrace({ lastTransition: 'ISSUE_INGEST_TO_PLAN' }),
			{ planExists: true, criticApproved: true, allPhasesComplete: true },
		);
		expect(r.nextLastTransition).toBe('EXECUTE_TO_COMMIT');
	});
});

// ── Row (i): all phases complete → publication_handoff + COMMIT directive ─

describe('Row (i): all phases complete → publication_handoff (NOT completed)', () => {
	const allDone = {
		planExists: true,
		criticApproved: true,
		allPhasesComplete: true,
	};

	test('transitions with EXECUTE_TO_COMMIT, publication_handoff status, directive', () => {
		const r = call(
			makeRef(),
			makeTrace({ lastTransition: 'PLAN_TO_EXECUTE' }),
			allDone,
		);
		expect(r.nextMode).toBeNull();
		expect(r.directive).toContain('All implementation phases are complete');
		expect(r.directive).toContain('Closes #');
		expect(r.directive).toContain('.swarm/issue-reference.json');
		// Issue #2131 finding 2.4: the handoff is publication_handoff, NOT a
		// terminal "completed/resolved" claim.
		expect(r.nextStatus).toBe('publication_handoff');
		expect(r.nextLastTransition).toBe('EXECUTE_TO_COMMIT');
		expect(r.directive).toContain('trace is NOT complete');
	});

	test('transitions from any non-EXECUTE_TO_COMMIT lastTransition', () => {
		const r = call(makeRef(), makeTrace({ lastTransition: 'OTHER' }), allDone);
		expect(r.nextStatus).toBe('publication_handoff');
		expect(r.nextLastTransition).toBe('EXECUTE_TO_COMMIT');
	});

	test('idempotency: already at EXECUTE_TO_COMMIT returns no-op', () => {
		const t = makeTrace({
			lastTransition: 'EXECUTE_TO_COMMIT',
			status: 'publication_handoff',
		});
		expect(isNoop(call(makeRef(), t, allDone), t)).toBe(true);
	});
});

// ── Null and edge-case inputs ────────────────────────────────────

describe('null and edge-case inputs', () => {
	test('empty flags → no-op', () => {
		const t = makeTrace();
		const r = computeNextMode({
			issueReference: {
				url: '',
				owner: '',
				repo: '',
				number: 0,
				timestamp: '',
				flags: {},
			},
			traceState: t,
			workflowArtifacts: makeArt(),
		});
		expect(isNoop(r, t)).toBe(true);
	});

	test('noRepro flag without trace → no-op', () => {
		const t = makeTrace();
		expect(isNoop(call(makeRef({ flags: { noRepro: true } }), t), t)).toBe(
			true,
		);
	});

	test('noReproWaiver without trace flag → no-op', () => {
		const t = makeTrace();
		const r = computeNextMode({
			issueReference: makeRef({
				flags: { noRepro: true },
				noReproWaiver: {
					waived: true,
					reason: 'risk',
					timestamp: '2026-01-01T00:00:00Z',
				},
			}),
			traceState: t,
			workflowArtifacts: makeArt(),
		});
		expect(isNoop(r, t)).toBe(true);
	});
});

// ── Full lifecycle integration ────────────────────────────────────

describe('full lifecycle', () => {
	test('in_progress → PLAN → EXECUTE → publication_handoff → published', () => {
		const ref = makeRef({ number: 42 });

		// Step 1: initial → PLAN
		const r1 = call(ref, makeTrace({ lastTransition: null }), {
			planExists: false,
			specIssueNumber: 42,
		});
		expect(r1.nextMode).toBe('PLAN');
		expect(r1.nextLastTransition).toBe('ISSUE_INGEST_TO_PLAN');

		// Step 2: plan created, critic pending → no-op (row g)
		const t2 = makeTrace({ lastTransition: 'ISSUE_INGEST_TO_PLAN' });
		expect(isNoop(call(ref, t2, { planExists: true }), t2)).toBe(true);

		// Step 3: critic approved → EXECUTE
		const r3 = call(
			ref,
			makeTrace({ lastTransition: 'ISSUE_INGEST_TO_PLAN' }),
			{
				planExists: true,
				criticApproved: true,
				allPhasesComplete: false,
				specIssueNumber: 42,
			},
		);
		expect(r3.nextMode).toBe('EXECUTE');
		expect(r3.nextLastTransition).toBe('PLAN_TO_EXECUTE');

		// Step 4: all phases complete → publication_handoff (NOT completed)
		const r4 = call(ref, makeTrace({ lastTransition: 'PLAN_TO_EXECUTE' }), {
			planExists: true,
			criticApproved: true,
			allPhasesComplete: true,
			specIssueNumber: 42,
		});
		expect(r4.nextStatus).toBe('publication_handoff');
		expect(r4.nextLastTransition).toBe('EXECUTE_TO_COMMIT');
		expect(r4.directive).not.toBeNull();

		// Step 5: publication observed → published (terminal)
		const r5 = call(
			ref,
			makeTrace({
				lastTransition: 'EXECUTE_TO_COMMIT',
				status: 'publication_handoff',
			}),
			{
				planExists: true,
				criticApproved: true,
				allPhasesComplete: true,
				publicationObserved: true,
			},
		);
		expect(r5.nextStatus).toBe('published');
		expect(r5.nextLastTransition).toBe('PUBLISHED');
	});
});
