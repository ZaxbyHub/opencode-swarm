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
 * - `published`: a verifiable publication receipt was observed. Terminal.
 */
export type TraceStatus = 'in_progress' | 'publication_handoff' | 'published';

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
	/** A verifiable publication receipt has been observed (issue #2131 2.4). */
	publicationObserved: boolean;
	/** A valid recurrence-sweep receipt exists (issue #2131 residual B). */
	recurrenceSweepVerified: boolean;
	/** Fresh reviewer + critic APPROVE verdicts recorded (issue #2131 residual B). */
	implementationReviewVerified: boolean;
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
 *   (b) Trace already published (terminal)               → no-op
 *   (c) publication_handoff: observe publication → PUBLISHED; else no-op
 *   (d) Cross-issue guard (spec issue ≠ current issue)   → no-op
 *   (e) Spec does not exist                              → no-op
 *   (f) Spec exists, no plan, reproduction permitted,
 *       never transitioned (or re-entrant idempotency)   → PLAN
 *   (f-block) Spec exists, no plan, reproduction NOT permitted → no-op
 *   (g) Plan exists but critic not approved              → no-op
 *   (h) Critic approved, phases incomplete, not yet PLAN_TO_EXECUTE → EXECUTE
 *   (i-pre1) Phases complete, impl-review receipt missing → one-shot REVIEW_GATE directive
 *   (i-pre2) Impl-review ok, recurrence-sweep receipt missing → one-shot RECURRENCE_GATE directive
 *   (i) All phases complete + both gates verified, not yet EXECUTE_TO_COMMIT → publication_handoff + COMMIT directive
 *
 * Idempotency: rows (f), (h), (i) return no-op when
 * `traceState.lastTransition` already equals the target transition value.
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

	// Row (b): trace already published (truly terminal)
	if (traceState.status === 'published') {
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

	// Row (d): cross-issue fail-closed guard (spec AND trace state must match)
	if (
		workflowArtifacts.specIssueNumber === null ||
		workflowArtifacts.specIssueNumber !== issueReference.number ||
		traceState.issueNumber !== issueReference.number
	) {
		return noop;
	}

	// Row (e): spec does not exist yet
	if (!workflowArtifacts.specExists) {
		return noop;
	}

	// Row (f): spec exists, no plan → ISSUE_INGEST_TO_PLAN (requires reproduction)
	if (!workflowArtifacts.planExists) {
		if (!workflowArtifacts.reproductionPermitted) {
			// Reproduction evidence (or a typed waiver) is required before the
			// trace can leave localization and transition to PLAN. Emit a ONE-SHOT
			// directive (sentinel lastTransition REPRO_GATE) so the mode-driving
			// engine is not silently idle while it waits for evidence — silence
			// here is indistinguishable from a stuck engine.
			if (traceState.lastTransition === null) {
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
			traceState.lastTransition === 'REPRO_GATE'
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

	// Row (g): plan exists but critic has not approved
	if (!workflowArtifacts.criticApproved) {
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

	// Row (i): all phases complete + both residual-B gates verified →
	// publication_handoff + COMMIT directive. While either gate receipt is
	// still missing, wait quietly (the one-shot directive above already fired).
	if (
		!workflowArtifacts.implementationReviewVerified ||
		!workflowArtifacts.recurrenceSweepVerified
	) {
		return noop;
	}
	if (traceState.lastTransition === 'EXECUTE_TO_COMMIT') {
		return noop;
	}
	return {
		nextMode: null,
		directive:
			'All implementation phases are complete. Compose commit-pr to publish the PR. Read .swarm/issue-reference.json for Closes #N. After the PR is created/updated, call record_issue_publication (with the issue number, PR number, URL, and HEAD sha) so this trace reaches its terminal published state — the trace is NOT complete until publication is confirmed.',
		nextLastTransition: 'EXECUTE_TO_COMMIT',
		nextStatus: 'publication_handoff',
	};
}
