/**
 * Issue trace reducer — a pure transition function with zero I/O.
 *
 * Determines the next mode transition for an issue-trace workflow
 * based on current trace state and workflow artifacts. Evaluated
 * top-to-bottom (first-match-wins) against an 8-row decision table.
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

export interface TraceState {
	issueNumber: number;
	lastTransition: string | null;
	completed: boolean;
}

export interface WorkflowArtifacts {
	specExists: boolean;
	specIssueNumber: number | null;
	planExists: boolean;
	criticApproved: boolean;
	allPhasesComplete: boolean;
}

export interface TransitionResult {
	nextMode: string | null;
	directive: string | null;
	nextLastTransition: string | null;
	nextCompleted: boolean;
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
 *   (b) Trace already completed                           → no-op
 *   (c) Cross-issue guard (spec issue ≠ current issue)   → no-op
 *   (d) Spec does not exist                              → no-op
 *   (e) Spec exists, no plan, never transitioned          → PLAN
 *   (f) Plan exists but critic not approved               → no-op
 *   (g) Critic approved, phases incomplete, not yet PLAN_TO_EXECUTE → EXECUTE
 *   (h) All phases complete, not yet EXECUTE_TO_COMMIT    → COMMIT directive
 *
 * Idempotency: rows (e), (g), (h) return no-op when
 * `traceState.lastTransition` already equals the target
 * transition value.
 */
export function computeNextMode(
	params: ComputeNextModeParams,
): TransitionResult {
	const { issueReference, traceState, workflowArtifacts } = params;
	const noop: TransitionResult = {
		nextMode: null,
		directive: null,
		nextLastTransition: traceState.lastTransition,
		nextCompleted: traceState.completed,
	};

	// Row (a): issueReference is null OR trace flag is not set
	if (!issueReference || issueReference.flags.trace !== true) {
		return noop;
	}

	// Row (b): trace already completed
	if (traceState.completed) {
		return noop;
	}

	// Row (c): cross-issue fail-closed guard (spec AND trace state must match)
	if (
		workflowArtifacts.specIssueNumber === null ||
		workflowArtifacts.specIssueNumber !== issueReference.number ||
		traceState.issueNumber !== issueReference.number
	) {
		return noop;
	}

	// Row (d): spec does not exist yet
	if (!workflowArtifacts.specExists) {
		return noop;
	}

	// Row (e): spec exists, no plan, never transitioned → ISSUE_INGEST_TO_PLAN
	// Condition expanded to include idempotency: null or already at target
	if (
		!workflowArtifacts.planExists &&
		(traceState.lastTransition === null ||
			traceState.lastTransition === 'ISSUE_INGEST_TO_PLAN')
	) {
		if (traceState.lastTransition === 'ISSUE_INGEST_TO_PLAN') {
			return noop;
		}
		return {
			nextMode: 'PLAN',
			directive: null,
			nextLastTransition: 'ISSUE_INGEST_TO_PLAN',
			nextCompleted: false,
		};
	}

	// Row (f): plan exists but critic has not approved
	if (!workflowArtifacts.criticApproved) {
		return noop;
	}

	// Row (g): critic approved, phases incomplete → PLAN_TO_EXECUTE
	// Requires plan to exist; idempotency: if already at PLAN_TO_EXECUTE, return no-op
	if (workflowArtifacts.planExists && !workflowArtifacts.allPhasesComplete) {
		if (traceState.lastTransition === 'PLAN_TO_EXECUTE') {
			return noop;
		}
		return {
			nextMode: 'EXECUTE',
			directive: null,
			nextLastTransition: 'PLAN_TO_EXECUTE',
			nextCompleted: false,
		};
	}

	// Row (h): all phases complete → EXECUTE_TO_COMMIT
	// Requires plan to exist; idempotency: if already at EXECUTE_TO_COMMIT, return no-op
	if (!workflowArtifacts.planExists) {
		return noop;
	}
	if (traceState.lastTransition === 'EXECUTE_TO_COMMIT') {
		return noop;
	}
	return {
		nextMode: null,
		directive:
			'All phases complete. Compose commit-pr to publish the PR. Read .swarm/issue-reference.json for Closes #N.',
		nextLastTransition: 'EXECUTE_TO_COMMIT',
		nextCompleted: true,
	};
}
