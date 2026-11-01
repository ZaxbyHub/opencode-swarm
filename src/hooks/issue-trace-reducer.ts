/**
 * Issue trace reducer — a pure transition function with zero I/O.
 *
 * Determines the next mode transition for an issue-trace workflow
 * based on current trace state and workflow artifacts. Evaluated
 * top-to-bottom (first-match-wins) against the decision table below.
 *
 * Issue #2131 finding 2: the reducer no longer conflates "the engine
 * handed off to commit-pr" with "the issue is resolved." Trace state is a
 * typed `status` (`in_progress` → `publication_handoff` → `published`), and
 * the commit-pr handoff sets `publication_handoff` (NOT a terminal
 * "completed"). `published` is reachable only after a verifiable publication
 * receipt is observed. A reproduction gate (evidence OR a typed waiver) must
 * be satisfied before the PLAN transition fires.
 */

// ── Public types ──────────────────────────────────────────────────

export interface IssueReference {
	url: string;
	owner: string;
	repo: string;
	number: number;
	timestamp: string;
	flags: { plan?: boolean; trace?: boolean; noRepro?: boolean };
	noReproWaiver?: { waived: boolean; reason: string; timestamp: string };
}

/**
 * Trace lifecycle status. Replaces the boolean `completed` (issue #2131
 * finding 2.4):
 * - `in_progress`: the engine is driving PLAN → CRITIC-GATE → EXECUTE.
 * - `publication_handoff`: all phases complete; the engine has emitted the
 *   commit-pr directive and stopped driving. This is NOT "issue resolved" —
 *   publication is owned by commit-pr and has not yet been confirmed.
 * - `published`: a verifiable publication receipt was observed.
 * - `merge_approval_recorded`: a PR-head-bound merge-approval receipt was
 *   observed after publication (issue #2564). TERMINAL. The plugin RECORDS the
 *   human approval for audit; it never certifies, drives, or green-lights the
 *   merge itself — the merge is human-enforced (mirrors trace-check.sh's
 *   merge gate posture).
 */
export type TraceStatus =
	| 'in_progress'
	| 'publication_handoff'
	| 'published'
	| 'merge_approval_recorded';

export interface TraceState {
	issueNumber: number;
	lastTransition: string | null;
	status: TraceStatus;
}

export interface WorkflowArtifacts {
	specExists: boolean;
	specIssueNumber: number | null;
	planExists: boolean;
	criticApproved: boolean;
	allPhasesComplete: boolean;
	/** Reproduction evidence OR a typed waiver is present (issue #2131 2.6). */
	reproductionPermitted: boolean;
	/**
	 * Phase 0 branch-freshness receipt permits the trace: `synced`, or a
	 * fail-closed fetch failure carrying a recorded user override (issue #2564,
	 * mirroring trace-check.sh phase0). A `behind` result never permits.
	 */
	freshnessPermitted: boolean;
	/** A verifiable publication receipt has been observed (issue #2131 2.4). */
	publicationObserved: boolean;
	/** A valid recurrence-sweep receipt exists (issue #2131 residual B). */
	recurrenceSweepVerified: boolean;
	/** Fresh reviewer + critic APPROVE verdicts recorded (issue #2131 residual B). */
	implementationReviewVerified: boolean;
	/**
	 * Every recorded per-phase `trace-check.sh` validation for this issue is a
	 * pass bound to a 40-hex reviewed-commit + tree-id (issue #2564). A fail
	 * entry fails closed until that phase is re-recorded as a pass.
	 */
	traceValidationVerified: boolean;
	/** A PR-head-bound merge-approval receipt has been observed (issue #2564). */
	mergeApprovalObserved: boolean;
	/**
	 * The loaded plan is bound to the CURRENT effective spec (issue #2600):
	 * the authoritative plan carries a `specHash` equal to the current spec's
	 * SHA-256. `false` means the plan was authored against a different spec
	 * (or predates spec linkage) — executing it under this trace would run the
	 * wrong plan. Explicit `=== false` (not falsy): the hook always supplies a
	 * real boolean when a plan exists, and a v2-shaped artifacts literal from a
	 * legacy direct caller stays transparent instead of parking (same
	 * convention as `freshnessPermitted` / `traceValidationVerified`).
	 */
	planBoundToSpec?: boolean;
}

export interface TransitionResult {
	nextMode: string | null;
	directive: string | null;
	nextLastTransition: string | null;
	nextStatus: TraceStatus;
}

export interface ComputeNextModeParams {
	issueReference: IssueReference | null;
	traceState: TraceState;
	workflowArtifacts: WorkflowArtifacts;
}

// ── Reducer ───────────────────────────────────────────────────────

/**
 * Pure reducer: given trace state + workflow artifacts, return the
 * next mode transition (or a no-op).
 *
 * Decision table (top-to-bottom, first match wins):
 *   (a) No issue reference or trace not requested        → no-op
 *   (b) merge_approval_recorded (truly terminal)         → no-op
 *   (b') published + merge-approval receipt observed     → merge_approval_recorded (RECORDED, never certified)
 *   (c) publication_handoff: observe publication → PUBLISHED; else no-op
 *   (d) Cross-issue guard (spec issue ≠ current issue)   → one-shot SPEC_MISMATCH_GATE directive (issue #2600)
 *   (e) Spec does not exist                              → no-op
 *   (f-0) Spec exists, no plan, branch-freshness NOT
 *       permitted                                        → one-shot FRESHNESS_GATE directive
 *   (f) Spec exists, no plan, freshness permitted, reproduction permitted,
 *       never transitioned (or re-entrant idempotency)   → PLAN
 *   (f-block) Spec exists, no plan, reproduction NOT permitted → one-shot REPRO_GATE directive
 *   (g-binding) Plan exists but NOT bound to the current
 *       spec (foreign/unverifiable)                      → one-shot PLAN_BINDING_GATE directive (issue #2600)
 *   (g-repro) Plan exists, bound, reproduction NOT permitted → one-shot REPRO_GATE_LATE directive (issue #2600)
 *   (g) Plan exists, bound, repro permitted, critic not approved → one-shot CRITIC_GATE directive (issue #2600)
 *   (h) Critic approved, phases incomplete, not yet PLAN_TO_EXECUTE → EXECUTE
 *   (i-pre1) Phases complete, impl-review receipt missing → one-shot REVIEW_GATE directive
 *   (i-pre2) Impl-review ok, recurrence-sweep receipt missing → one-shot RECURRENCE_GATE directive
 *   (i-pre3) Both ok, trace-validation receipts missing/failing → one-shot TRACE_VALIDATION_GATE directive
 *   (i) All phases complete + all gates verified, not yet EXECUTE_TO_COMMIT → publication_handoff + COMMIT directive
 *
 * Idempotency: rows (f), (h), (i) return no-op when
 * `traceState.lastTransition` already equals the target transition value.
 * Every gate row is ONE-SHOT: it fires from `lastTransition === null` or from
 * the sentinel of a gate that precedes it in the ladder, then waits quietly
 * for its receipt (issue #2600: silence is indistinguishable from a stuck
 * engine, so each wait state names its recovery exactly once).
 */
export function computeNextMode(
	params: ComputeNextModeParams,
): TransitionResult {
	const { issueReference, traceState, workflowArtifacts } = params;
	const noop: TransitionResult = {
		nextMode: null,
		directive: null,
		nextLastTransition: traceState.lastTransition,
		nextStatus: traceState.status,
	};

	// Row (a): issueReference is null OR trace flag is not set
	if (!issueReference || issueReference.flags.trace !== true) {
		return noop;
	}

	// Row (b): merge_approval_recorded — the only truly terminal status.
	if (traceState.status === 'merge_approval_recorded') {
		return noop;
	}

	// Row (b'): published + merge-approval receipt observed → RECORDED, never
	// certified (issue #2564). nextMode stays null: the plugin never drives,
	// certifies, or green-lights a merge — the merge decision is human-enforced,
	// exactly the posture trace-check.sh's merge gate documents ("human-enforced
	// gate; this validator checks presence and binding only").
	if (traceState.status === 'published') {
		if (
			workflowArtifacts.mergeApprovalObserved &&
			traceState.lastTransition !== 'MERGE_APPROVAL_RECORDED'
		) {
			return {
				nextMode: null,
				directive:
					'Merge approval recorded for this trace, bound to the PR head SHA in .swarm/merge-approval.json. The merge decision is human-enforced: the human user owns and executes it through the host. This plugin records the approval verbatim for audit; it does not drive, gate, or green-light the merge itself.',
				nextLastTransition: 'MERGE_APPROVAL_RECORDED',
				nextStatus: 'merge_approval_recorded',
			};
		}
		return noop;
	}

	// Row (c): publication_handoff — observe publication → PUBLISHED; else wait
	if (traceState.status === 'publication_handoff') {
		if (
			workflowArtifacts.publicationObserved &&
			traceState.lastTransition !== 'PUBLISHED'
		) {
			return {
				nextMode: null,
				directive:
					'Publication confirmed. The issue-trace workflow is complete.',
				nextLastTransition: 'PUBLISHED',
				nextStatus: 'published',
			};
		}
		return noop;
	}

	// Row (d): cross-issue fail-closed guard (spec AND trace state must match).
	// Issue #2600 (DD-C002): a DEFINITE mismatch (a spec exists but belongs to
	// another issue, or the trace state is bound to another issue) emits a
	// one-shot directive instead of a bare noop — silence here is
	// indistinguishable from a stuck engine. `specIssueNumber === null` (spec
	// not yet generated, or Source Issue unparseable) keeps the silent
	// fail-closed park: the ingest flow legitimately has no spec mid-flight,
	// and nudging it with a mismatch directive would contradict the very
	// transition it is working toward. Fires from a fresh trace AND from any
	// later sentinel except its own (review pr2837-r1 M1): a spec edited to a
	// different issue MID-TRACE (while parked at, say, CRITIC_GATE) is exactly
	// the mismatch class this row exists to catch, so the gate re-arms — its
	// own sentinel keeps each nudge one-shot, and once the spec is corrected
	// the normal ladder re-drives from SPEC_MISMATCH_GATE (every later gate
	// row accepts it).
	if (
		workflowArtifacts.specIssueNumber === null ||
		workflowArtifacts.specIssueNumber !== issueReference.number ||
		traceState.issueNumber !== issueReference.number
	) {
		if (
			traceState.lastTransition !== 'SPEC_MISMATCH_GATE' &&
			(workflowArtifacts.specIssueNumber !== null ||
				traceState.issueNumber !== issueReference.number)
		) {
			return {
				nextMode: 'ISSUE_INGEST',
				directive:
					'The spec on disk (## Source Issue) does not match the traced issue #N. Regenerate the spec for this issue through the issue-ingest flow (/swarm issue), or correct the ## Source Issue number in .swarm/spec.md. The trace will not advance while the spec belongs to a different issue.',
				nextLastTransition: 'SPEC_MISMATCH_GATE',
				nextStatus: 'in_progress',
			};
		}
		return noop;
	}

	// Row (e): spec does not exist yet
	if (!workflowArtifacts.specExists) {
		return noop;
	}

	// Row (f): spec exists, no plan → ISSUE_INGEST_TO_PLAN (requires freshness
	// AND reproduction evidence)
	if (!workflowArtifacts.planExists) {
		// Row (f-0): Phase 0 branch-freshness gate — fail-closed like
		// trace-check.sh phase0 (issue #2564): a `behind` result or a bare
		// `fetch-failed` (no recorded user override) must park the trace before
		// PLAN. One-shot (sentinel FRESHNESS_GATE) so the engine is not
		// silently idle — silence here is indistinguishable from a stuck engine.
		// Explicit `=== false` (not falsy): the hook always supplies a real
		// boolean, and a v2-shaped artifacts literal from a legacy direct caller
		// stays transparent instead of silently parking (pinned by the frozen
		// C6 preserving check).
		if (workflowArtifacts.freshnessPermitted === false) {
			if (
				traceState.lastTransition === null ||
				traceState.lastTransition === 'REPRO_GATE' ||
				traceState.lastTransition === 'SPEC_MISMATCH_GATE'
			) {
				return {
					nextMode: 'ISSUE_INGEST',
					directive:
						'Branch freshness is not established for this trace (behind, or fetch failed without a recorded user override). Re-sync with the default branch (git fetch + rebase/merge), then call record_branch_freshness (issueNumber, freshness: "synced") — or, when the fetch genuinely failed and the user has accepted proceeding on the stale base, record freshness: "fetch-failed:<reason>" together with the verbatim override string the user provided. The trace will not transition to PLAN until this receipt permits.',
					nextLastTransition: 'FRESHNESS_GATE',
					nextStatus: 'in_progress',
				};
			}
			// Already nudged once (FRESHNESS_GATE or later); wait quietly for
			// the receipt.
			return noop;
		}
		if (!workflowArtifacts.reproductionPermitted) {
			// Reproduction evidence (or a typed waiver) is required before the
			// trace can leave localization and transition to PLAN. Emit a ONE-SHOT
			// directive (sentinel lastTransition REPRO_GATE) so the mode-driving
			// engine is not silently idle while it waits for evidence — silence
			// here is indistinguishable from a stuck engine. FRESHNESS_GATE and
			// SPEC_MISMATCH_GATE also count as "nothing has fired yet": a receipt
			// or spec correction landing after those nudges must still get the
			// reproduction nudge.
			if (
				traceState.lastTransition === null ||
				traceState.lastTransition === 'FRESHNESS_GATE' ||
				traceState.lastTransition === 'SPEC_MISMATCH_GATE'
			) {
				return {
					nextMode: 'ISSUE_INGEST',
					directive:
						'Reproduction evidence (or a typed --no-repro waiver) is required before this trace can transition to PLAN. Attempt a minimal reproduction and call record_issue_reproduction (performed: true, commands, output_summary), or restart with /swarm issue --no-repro.',
					nextLastTransition: 'REPRO_GATE',
					nextStatus: 'in_progress',
				};
			}
			// Already nudged once (REPRO_GATE or later); wait silently for evidence.
			return noop;
		}
		if (
			traceState.lastTransition === null ||
			traceState.lastTransition === 'ISSUE_INGEST_TO_PLAN' ||
			traceState.lastTransition === 'REPRO_GATE' ||
			traceState.lastTransition === 'FRESHNESS_GATE' ||
			traceState.lastTransition === 'SPEC_MISMATCH_GATE'
		) {
			if (traceState.lastTransition === 'ISSUE_INGEST_TO_PLAN') {
				return noop;
			}
			return {
				nextMode: 'PLAN',
				directive: null,
				nextLastTransition: 'ISSUE_INGEST_TO_PLAN',
				nextStatus: 'in_progress',
			};
		}
		// planExists is false but lastTransition implies a later phase —
		// inconsistent state; do not drive.
		return noop;
	}

	// Row (g-binding): plan exists but is NOT bound to the current spec
	// (issue #2600, DD-C001). `planBoundToSpec === false` means the loaded plan
	// carries a specHash that differs from the current effective spec (or no
	// specHash at all) — executing it under this trace would run a plan
	// authored for a different spec/issue. Fail closed with a ONE-SHOT
	// directive (sentinel PLAN_BINDING_GATE); EXECUTE is unreachable on a
	// foreign plan. Explicit `=== false` keeps legacy v2-shaped artifacts
	// literals transparent (mirrors freshnessPermitted/traceValidationVerified).
	// Fires from a fresh trace or from ANY later sentinel (review pr2837-r1
	// F6): whichever gate fired last, a spec changing under an active trace
	// must be binding-checked before anything else can drive — an unbound
	// plan can never reach rows (g-repro)/(g)/(h) because the guard below
	// returns unconditionally, but re-emitting the directive here turns that
	// fail-closed silence into an actionable re-nudge.
	if (workflowArtifacts.planBoundToSpec === false) {
		if (traceState.lastTransition !== 'PLAN_BINDING_GATE') {
			return {
				nextMode: 'PLAN',
				directive:
					'The loaded plan cannot be bound to the current spec for issue #N — its recorded specHash differs from the current spec (or the plan predates spec linkage), so executing it under this trace would run the wrong plan. Re-save the plan against the current spec (save_plan after the spec is correct), or run /swarm reset to clear the foreign plan and re-plan (note: reset also deletes .swarm/spec.md and the recorded review receipts, so re-run /swarm issue --trace afterwards to regenerate them). The trace will not transition to EXECUTE on a plan it cannot bind.',
				nextLastTransition: 'PLAN_BINDING_GATE',
				nextStatus: 'in_progress',
			};
		}
		return noop;
	}

	// Row (g-repro): a plan already exists and is bound, but reproduction
	// evidence (or a typed waiver) was never recorded for THIS issue (issue
	// #2600: the reproduction gate used to live only inside the !planExists
	// branch and was structurally skipped when a plan existed). ONE-SHOT
	// directive (sentinel REPRO_GATE_LATE) — the waived-with-directive path:
	// record the receipt or restart with --no-repro.
	if (!workflowArtifacts.reproductionPermitted) {
		if (
			traceState.lastTransition === null ||
			traceState.lastTransition === 'SPEC_MISMATCH_GATE' ||
			traceState.lastTransition === 'PLAN_BINDING_GATE' ||
			traceState.lastTransition === 'FRESHNESS_GATE' ||
			traceState.lastTransition === 'REPRO_GATE' ||
			traceState.lastTransition === 'ISSUE_INGEST_TO_PLAN'
		) {
			return {
				nextMode: 'ISSUE_INGEST',
				directive:
					'A plan already exists for this trace, but reproduction evidence has not been recorded for issue #N. Attempt a minimal reproduction and call record_issue_reproduction (performed: true, commands, output_summary), or restart with /swarm issue --no-repro. The trace will not transition to EXECUTE until reproduction is permitted.',
				nextLastTransition: 'REPRO_GATE_LATE',
				nextStatus: 'in_progress',
			};
		}
		return noop;
	}

	// Row (g): plan exists, bound, repro permitted, but the critic has not
	// approved (issue #2600, DD-C002): ONE-SHOT directive (sentinel
	// CRITIC_GATE) naming the #2012-class recovery instead of a bare noop.
	if (!workflowArtifacts.criticApproved) {
		if (
			traceState.lastTransition === null ||
			traceState.lastTransition === 'SPEC_MISMATCH_GATE' ||
			traceState.lastTransition === 'PLAN_BINDING_GATE' ||
			traceState.lastTransition === 'REPRO_GATE_LATE' ||
			traceState.lastTransition === 'FRESHNESS_GATE' ||
			traceState.lastTransition === 'REPRO_GATE' ||
			traceState.lastTransition === 'ISSUE_INGEST_TO_PLAN'
		) {
			return {
				nextMode: 'CRITIC-GATE',
				directive:
					'The plan for issue #N is not yet critic-approved. Dispatch MODE: CRITIC-GATE and wait for VERDICT: APPROVED before EXECUTE. If the critic already returned APPROVED but the snapshot was not recorded (issue #2012), call approve_plan_critic with a reason, or run /swarm approve-plan-critic <reason>, to record the approval.',
				nextLastTransition: 'CRITIC_GATE',
				nextStatus: 'in_progress',
			};
		}
		return noop;
	}

	// Row (h): critic approved, phases incomplete → PLAN_TO_EXECUTE
	if (workflowArtifacts.planExists && !workflowArtifacts.allPhasesComplete) {
		if (traceState.lastTransition === 'PLAN_TO_EXECUTE') {
			return noop;
		}
		return {
			nextMode: 'EXECUTE',
			directive: null,
			nextLastTransition: 'PLAN_TO_EXECUTE',
			nextStatus: 'in_progress',
		};
	}

	// Rows (i-pre): all phases complete — issue #2131 residual B gates. Before
	// the trace may hand off to commit-pr, the independent implementation
	// review AND the recurrence sweep must be recorded. Each missing gate emits
	// a ONE-SHOT directive (distinct sentinel) so the engine is never silently
	// idle waiting for evidence; once fired it waits quietly for the receipt.
	if (!workflowArtifacts.planExists) {
		return noop;
	}
	if (
		!workflowArtifacts.implementationReviewVerified &&
		traceState.lastTransition !== 'REVIEW_GATE' &&
		traceState.lastTransition !== 'RECURRENCE_GATE' &&
		traceState.lastTransition !== 'EXECUTE_TO_COMMIT'
	) {
		return {
			nextMode: 'EXECUTE',
			directive:
				'All implementation phases are complete, but the independent implementation review is not yet recorded. Dispatch a FRESH-context reviewer and then a FRESH-context critic over the implementation diff (separate contexts from the implementer); when both approve, call record_implementation_review (issueNumber, reviewerVerdict APPROVE, criticVerdict APPROVE, the reviewed diff base/head, and notes). The trace will not hand off to commit-pr until this receipt exists.',
			nextLastTransition: 'REVIEW_GATE',
			nextStatus: 'in_progress',
		};
	}
	if (
		workflowArtifacts.implementationReviewVerified &&
		!workflowArtifacts.recurrenceSweepVerified &&
		traceState.lastTransition !== 'RECURRENCE_GATE' &&
		traceState.lastTransition !== 'EXECUTE_TO_COMMIT'
	) {
		return {
			nextMode: 'EXECUTE',
			directive:
				'The implementation review is approved, but the recurrence sweep is not yet recorded. Characterize the defect class, search the repository with explicit predicates, disposition every hit (FIX / FALSE_POSITIVE / OUT_OF_CLASS / DEFERRED_WITH_USER_APPROVAL), and install a guardrail that provably catches the original defect — or record the "no defect class" fast path with a one-line justification. Then call record_recurrence_sweep. The trace will not hand off to commit-pr until this receipt exists.',
			nextLastTransition: 'RECURRENCE_GATE',
			nextStatus: 'in_progress',
		};
	}

	// Row (i-pre3): both residual-B gates verified — the per-phase trace-check.sh
	// validator receipts must also be recorded and green before the trace may
	// hand off to commit-pr (issue #2564). A missing receipt set, or any fail
	// entry, parks the trace with a ONE-SHOT directive (sentinel
	// TRACE_VALIDATION_GATE) naming the validator re-run. The precondition on
	// both prior gates keeps the directive's text truthful (implementation
	// review round 3: without it, a vanished review/sweep receipt after its
	// sentinel fired made this row claim the prior gates were satisfied). The
	// exclusion set excludes only THIS row's own sentinel plus the handoff
	// sentinel — REVIEW_GATE/RECURRENCE_GATE must NOT be excluded, because when
	// the recurrence receipt lands right after RECURRENCE_GATE fired, the ladder
	// must chain into this directive rather than parking silently (final-critic
	// round 1; mirrors how row i-pre2 does not exclude REVIEW_GATE). When a
	// prior receipt VANISHES after its sentinel fired, this row declines and
	// the final guard no-ops — the same exhausted-one-shot semantics every gate
	// row already has (the silent-stall surfacing for those rows is #2600's
	// DD-C002 scope, pinned by the frozen C8 preserving check).
	if (
		workflowArtifacts.implementationReviewVerified &&
		workflowArtifacts.recurrenceSweepVerified &&
		workflowArtifacts.traceValidationVerified === false &&
		traceState.lastTransition !== 'TRACE_VALIDATION_GATE' &&
		traceState.lastTransition !== 'EXECUTE_TO_COMMIT'
	) {
		return {
			nextMode: 'EXECUTE',
			directive:
				'The review and recurrence gates are satisfied, but the trace-check.sh validator receipts are not yet green. Run the issue-tracer phase validator for every completed phase (trace-check.sh phase <N> --slug <slug>) and record each outcome with record_trace_validation (issueNumber, phase, outcome, the reviewedCommit, and the treeId the validator reported). Any fail entry must be fixed and re-recorded as a pass before the trace can hand off to commit-pr.',
			nextLastTransition: 'TRACE_VALIDATION_GATE',
			nextStatus: 'in_progress',
		};
	}

	// Row (i): all phases complete + all gates verified →
	// publication_handoff + COMMIT directive. While any gate receipt is
	// still missing, wait quietly (the one-shot directive above already fired).
	// The residual-B guards keep their original falsy form (they pair with the
	// falsy fire rows above); only the new validator gate uses explicit
	// `=== false` for v2-shaped-literal transparency.
	if (
		!workflowArtifacts.implementationReviewVerified ||
		!workflowArtifacts.recurrenceSweepVerified ||
		workflowArtifacts.traceValidationVerified === false
	) {
		return noop;
	}
	if (traceState.lastTransition === 'EXECUTE_TO_COMMIT') {
		return noop;
	}
	return {
		nextMode: null,
		directive:
			'All implementation phases are complete. Compose commit-pr to publish the PR (Engine worktrees: repo pr create — do not use gh against Forgejo). Read .swarm/issue-reference.json for Closes #N. After the PR is created/updated, call record_issue_publication with the issue number, PR number, canonical Forgejo URL (https://git.centralcloud.net/<owner>/<repo>/pulls/<N>), and HEAD sha — the trace is NOT complete until publication is confirmed.',
		nextLastTransition: 'EXECUTE_TO_COMMIT',
		nextStatus: 'publication_handoff',
	};
}
