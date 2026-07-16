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
		completed: false,
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
		...overrides,
	};
}

function isNoop(r: TransitionResult, s: TraceState): boolean {
	return (
		r.nextMode === null &&
		r.directive === null &&
		r.nextLastTransition === s.lastTransition &&
		r.nextCompleted === s.completed
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

// ── Row (b): trace already completed ─────────────────────────────

describe('Row (b): trace already completed', () => {
	test('completed trace returns no-op regardless of artifacts', () => {
		const t = makeTrace({
			completed: true,
			lastTransition: 'EXECUTE_TO_COMMIT',
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

	test('completed trace with null lastTransition returns no-op', () => {
		const t = makeTrace({ completed: true });
		expect(isNoop(call(makeRef(), t), t)).toBe(true);
	});
});

// ── Row (c): cross-issue fail-closed guard ─────────────────────

describe('Row (c): cross-issue fail-closed guard', () => {
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

// ── Row (d): spec does not exist ──────────────────────────────────

describe('Row (d): spec does not exist', () => {
	test('specExists false returns no-op even with full artifacts', () => {
		const t = makeTrace();
		expect(isNoop(call(makeRef(), t, { specExists: false }), t)).toBe(true);
	});
});

// ── Row (e): spec exists, no plan → PLAN ────────────────────────

describe('Row (e): spec exists, no plan → PLAN', () => {
	test('transitions to PLAN with ISSUE_INGEST_TO_PLAN', () => {
		const r = call(makeRef(), makeTrace({ lastTransition: null }), {
			planExists: false,
		});
		expect(r).toEqual({
			...NOOP_FIELDS,
			nextLastTransition: 'ISSUE_INGEST_TO_PLAN',
			nextCompleted: false,
			nextMode: 'PLAN',
		});
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

	test('does not fire if plan exists or lastTransition is non-null', () => {
		const t = makeTrace({ lastTransition: null });
		expect(isNoop(call(makeRef(), t, { planExists: true }), t)).toBe(true);
		const t2 = makeTrace({ lastTransition: 'OTHER' });
		expect(isNoop(call(makeRef(), t2, { planExists: false }), t2)).toBe(true);
	});
});

// ── Row (f): plan exists but critic not approved → no-op ────────

describe('Row (f): plan exists but critic not approved', () => {
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

// ── planExists guard for rows (g) and (h) ─────────────────────────

describe('planExists guard: rows (g) and (h) unreachable without plan', () => {
	test('planExists=false + criticApproved=true returns no-op (row g unreachable)', () => {
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

	test('planExists=false + allPhasesComplete=true returns no-op (row h unreachable)', () => {
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

// ── Row (g): critic approved, phases incomplete → EXECUTE ────────

describe('Row (g): critic approved, phases incomplete → EXECUTE', () => {
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
			nextCompleted: false,
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

	test('does not fire if allPhasesComplete is true (falls to row h)', () => {
		const r = call(
			makeRef(),
			makeTrace({ lastTransition: 'ISSUE_INGEST_TO_PLAN' }),
			{ planExists: true, criticApproved: true, allPhasesComplete: true },
		);
		expect(r.nextLastTransition).toBe('EXECUTE_TO_COMMIT');
	});
});

// ── Row (h): all phases complete → COMMIT directive ─────────────

describe('Row (h): all phases complete → COMMIT directive', () => {
	const allDone = {
		planExists: true,
		criticApproved: true,
		allPhasesComplete: true,
	};

	test('transitions with EXECUTE_TO_COMMIT and directive', () => {
		const r = call(
			makeRef(),
			makeTrace({ lastTransition: 'PLAN_TO_EXECUTE' }),
			allDone,
		);
		expect(r.nextMode).toBeNull();
		expect(r.directive).toContain('All phases complete');
		expect(r.directive).toContain('Closes #');
		expect(r.directive).toContain('.swarm/issue-reference.json');
		expect(r.nextLastTransition).toBe('EXECUTE_TO_COMMIT');
		expect(r.nextCompleted).toBe(true);
	});

	test('transitions from any non-EXECUTE_TO_COMMIT lastTransition', () => {
		const r = call(makeRef(), makeTrace({ lastTransition: 'OTHER' }), allDone);
		expect(r.nextCompleted).toBe(true);
		expect(r.nextLastTransition).toBe('EXECUTE_TO_COMMIT');
	});

	test('idempotency: already at EXECUTE_TO_COMMIT returns no-op', () => {
		const t = makeTrace({
			lastTransition: 'EXECUTE_TO_COMMIT',
			completed: true,
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
	test('null → ISSUE_INGEST_TO_PLAN → PLAN_TO_EXECUTE → EXECUTE_TO_COMMIT with idempotency', () => {
		const ref = makeRef({ number: 42 });

		// Step 1: initial → PLAN
		const r1 = call(ref, makeTrace({ lastTransition: null }), {
			planExists: false,
			specIssueNumber: 42,
		});
		expect(r1.nextMode).toBe('PLAN');
		expect(r1.nextLastTransition).toBe('ISSUE_INGEST_TO_PLAN');

		// Step 2: plan created, critic pending → no-op (row f)
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

		// Step 3 idempotency
		const t3b = makeTrace({ lastTransition: 'PLAN_TO_EXECUTE' });
		expect(
			isNoop(
				call(ref, t3b, {
					planExists: true,
					criticApproved: true,
					allPhasesComplete: false,
				}),
				t3b,
			),
		).toBe(true);

		// Step 4: all phases complete → COMMIT
		const r4 = call(ref, makeTrace({ lastTransition: 'PLAN_TO_EXECUTE' }), {
			planExists: true,
			criticApproved: true,
			allPhasesComplete: true,
			specIssueNumber: 42,
		});
		expect(r4.nextCompleted).toBe(true);
		expect(r4.nextLastTransition).toBe('EXECUTE_TO_COMMIT');
		expect(r4.directive).not.toBeNull();

		// Step 4 idempotency
		const t4b = makeTrace({
			lastTransition: 'EXECUTE_TO_COMMIT',
			completed: true,
		});
		expect(
			isNoop(
				call(ref, t4b, {
					planExists: true,
					criticApproved: true,
					allPhasesComplete: true,
				}),
				t4b,
			),
		).toBe(true);
	});
});
