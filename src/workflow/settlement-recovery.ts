import { stripKnownSwarmPrefix } from '../config/schema.js';
import {
	getTaskWorkflowSnapshot,
	readTaskEvidenceState,
	transitionTaskWorkflowEvidence,
} from '../gate-evidence.js';
import { sanitizeDiagnosticText } from '../scope/path-identity.js';
import { ensureAgentSession } from '../state.js';
import { listCoderSettlementWalStates } from './coder-settlement.js';
import {
	applySessionWorkflowView,
	isStageARecoveredState,
	shouldRefreshStageARecoveryView,
} from './session-view.js';
import {
	appendStageARepairEvent,
	hasGreenPostSettlementPreCheck,
	type StageASettlementJustification,
	resolveStageASettlementJustification,
} from './stage-a-repair.js';

export interface SettlementRecoverySummary {
	taskId: string;
	generation: number;
	state: string;
	transitionId: string;
	recordedAt: string;
	/** True when the recovery was a no-op because Stage A was already recorded. */
	alreadyRecovered: boolean;
	/**
	 * Whether the stage_a_repair audit event actually landed in
	 * `.swarm/events.jsonl`. The durable transition is authoritative regardless;
	 * this surfaces the best-effort append honestly instead of asserting an
	 * audit record that may not exist (issue #2755 review, FB-001 contract).
	 */
	auditEventRecorded: boolean;
	/**
	 * Which durable receipt admitted the recovery: `settlement_wal` (a
	 * COMMITTED accepted coder settlement) or `requirements_receipt` (a
	 * chain-verified accepted_mutation requirements receipt — the only durable
	 * settlement proof background-dispatched coder rounds produce). Undefined
	 * on the already-recovered no-op path.
	 */
	justification?: StageASettlementJustification['via'];
}

/**
 * Architect-supervised settlement-backed Stage A recovery (issue #2828).
 *
 * The mechanical `stage_a_passed` transition deliberately fails closed from
 * `idle` and `blocked` (`TASK_WORKFLOW_CODER_MUTATION_REQUIRED` /
 * `TASK_WORKFLOW_TERMINAL`): those labels say the task never started or was
 * deliberately stopped. But the durable receipts can disagree — a COMMITTED
 * accepted coder settlement (the code is committed) plus green
 * post-settlement pre-check bundles (it passed Stage A checks) while the
 * workflow label drifted (`repair_idle` force-repair cleared the proofs, or
 * `task_blocked` moved past a recorded pass). Until this recovery, that
 * disagreement was a total deadlock: `/swarm recover` refused, a
 * `pre_check_batch` re-run could never re-record Stage A (attribution
 * requires `coder_delegated`), `recover_rework_task` requires exactly
 * `rework_required`, and re-dispatching the coder produces no mutation.
 *
 * This is the audited escape hatch the #2755 `recover_rework_task`
 * precedent established for the same class: it writes the SAME durable
 * transition the mechanical path would have written, admitted ONLY by the
 * `settlementRecovery` flag the reducer accepts from `idle`/`blocked`, and
 * records a distinguishable `stage_a_repair` audit event. Every
 * precondition fails closed; the deterministic `/swarm recover`
 * settlement-wedge scan and the mechanical recorder are untouched.
 *
 * Unlike `recover_rework_task` there is no plan-membership precondition: the
 * durable predicates (evidence file + COMMITTED accepted settlement WAL +
 * green post-settlement bundles) already bind the repair to a task that
 * genuinely had a settled coder dispatch, and the deterministic
 * `/swarm recover` scan this tool mirrors enumerates evidence files the same
 * way, plan or no plan. Requiring plan.json here would re-introduce exactly
 * the extra-refusal wedge class this recovery removes.
 */
export async function recoverStageATaskSupervised(
	directory: string,
	sessionID: string,
	options: { taskId: string; reason?: string },
): Promise<SettlementRecoverySummary> {
	// Defense-in-depth mirroring forceRecoverReworkTask: the tool is
	// registered for the architect only, but require the ACTIVE session to be
	// the architect so a non-architect context cannot self-unblock the
	// workflow state machine.
	const session = ensureAgentSession(sessionID, undefined, directory);
	if (
		!session ||
		!session.agentName ||
		stripKnownSwarmPrefix(session.agentName) !== 'architect'
	) {
		throw new Error(
			'RECOVER_STAGE_A_ARCHITECT_REQUIRED: recover_stage_a_task requires an active architect session. ' +
				'The settlement-backed Stage A escape hatch is architect-only; a coder/reviewer/test_engineer cannot self-unblock a task.',
		);
	}

	const taskId =
		typeof options.taskId === 'string' ? options.taskId.trim() : '';
	if (!taskId) {
		throw new Error(
			'RECOVER_STAGE_A_UNKNOWN_TASK: recover_stage_a_task requires the exact task id of the settlement-wedged task (e.g. "1.1").',
		);
	}

	const sanitizedReason =
		typeof options.reason === 'string' && options.reason.trim().length > 0
			? sanitizeDiagnosticText(options.reason.trim(), 500)
			: undefined;
	if (!sanitizedReason) {
		throw new Error(
			'RECOVER_STAGE_A_REASON_REQUIRED: recover_stage_a_task requires a reason ' +
				'describing why the settlement-backed recovery is justified; it is audited to .swarm/events.jsonl.',
		);
	}

	// Discriminated evidence read (issue #2755 review, FB-004 pattern): a
	// corrupt evidence file must not masquerade as "no evidence exists".
	const evidenceRead = await readTaskEvidenceState(directory, taskId);
	if (evidenceRead.kind === 'unparseable') {
		throw new Error(
			`RECOVER_STAGE_A_EVIDENCE_CORRUPT: the workflow evidence file for task ${taskId} exists but could not be parsed (${evidenceRead.evidencePath}). ` +
				'Repair the evidence first (repair_gate_evidence or /swarm doctor); recovery cannot classify a corrupt evidence state.',
		);
	}
	const evidence = evidenceRead.kind === 'ok' ? evidenceRead.evidence : null;
	const workflow = getTaskWorkflowSnapshot(evidence);
	if (!evidence || !workflow.authoritative) {
		throw new Error(
			`RECOVER_STAGE_A_NO_WORKFLOW: no durable task workflow evidence exists for task ${taskId} — there is no settlement wedge to recover.`,
		);
	}

	// Idempotent: Stage A already recorded at/after pre_check_passed means the
	// wedge is gone; report success without writing anything.
	if (
		workflow.state === 'pre_check_passed' ||
		workflow.state === 'reviewer_run' ||
		workflow.state === 'tests_run'
	) {
		// Issue #3043: even the no-op call leaves the caller's session view
		// consistent with durable — a session whose map still says `blocked`
		// (the blocked-start wedge) is un-wedged here without any durable
		// write, mirroring the fresh-write branch below.
		if (
			isStageARecoveredState(workflow.state) &&
			shouldRefreshStageARecoveryView(
				session.taskWorkflowStates.get(taskId),
				workflow.state,
			)
		) {
			applySessionWorkflowView(session, taskId, workflow);
		}
		return {
			taskId,
			generation: workflow.generation,
			state: workflow.state,
			transitionId: `stage-a-supervised:${taskId}:noop`,
			recordedAt: new Date().toISOString(),
			alreadyRecovered: true,
			auditEventRecorded: false,
		};
	}

	if (workflow.state !== 'idle' && workflow.state !== 'blocked') {
		throw new Error(
			`RECOVER_STAGE_A_STATE_REQUIRED: task ${taskId} is at ${workflow.state}, not idle/blocked. ` +
				'This recovery applies only to the settlement-backed wedge (a durable accepted coder settlement while the workflow drifted to idle or blocked). ' +
				'From coder_delegated, run pre_check_batch or /swarm recover; from rework_required without a code change, use recover_rework_task.',
		);
	}

	// The durable receipts: a COMMITTED settlement that attributed an accepted
	// mutation (the code is committed) — resolved WAL-first. Background-
	// dispatched coder rounds never write a settlement WAL; for those tasks the
	// chain-verified `accepted_mutation` requirements receipt is the same
	// durable settlement fact, recorded by the accepted mutation itself. Only
	// when NEITHER receipt exists is this genuinely an unstarted or deliberately
	// stopped task.
	const { states: walStates } = await listCoderSettlementWalStates(directory);
	const justification = await resolveStageASettlementJustification(
		directory,
		taskId,
		walStates,
	);
	if (justification === null) {
		throw new Error(
			`RECOVER_STAGE_A_SETTLEMENT_REQUIRED: refusing to recover task ${taskId} — no durable accepted coder settlement exists for it (no COMMITTED settlement WAL, and no chain-verified accepted_mutation receipt in the task-gate-requirements ledger). ` +
				'The settlement receipt is what distinguishes this wedge from a not-yet-started or deliberately stopped task; recovery without it would fabricate Stage A justification.',
		);
	}

	// … and green post-settlement pre-check proof (it passed Stage A checks).
	// Same fail-closed trade-offs as the #2665/#2755 paths: a SAST-disabled
	// project never persists a sast_scan bundle and cannot use this recovery.
	const greenness = await hasGreenPostSettlementPreCheck(
		directory,
		justification.settledAfterMs,
	);
	if (!greenness.green) {
		const sastHint =
			greenness.reason === 'no_pre_check_bundles'
				? ' Note: if gates.sast_scan.enabled is false, no sast_scan bundle is ever persisted and this recovery is unavailable by design — enable gates.sast_scan.enabled and run sast_scan, or use the coder repair loop.'
				: '';
		throw new Error(
			`RECOVER_STAGE_A_GREEN_PRECHECK_REQUIRED: refusing to mark Stage A passed without proof (${greenness.reason}). ` +
				"The bar is a green secretscan AND sast_scan evidence pair newer than the settlement commit — normally provided by a fresh pre_check_batch run (bundle proof is global, not correlated to the task's changed files)." +
				sastHint,
		);
	}

	const recordedAt = new Date().toISOString();
	// Deterministic per generation; a repeat call after success is a no-op via
	// the already-recovered branch above.
	const transitionId = `stage-a-supervised:${taskId}:${workflow.generation}`;

	// The settlement-backed stage_a_passed the mechanical path refuses to emit
	// from idle/blocked. expectedGeneration fails the write closed if a
	// concurrent accepted_mutation/repair_idle rotated the generation between
	// the read above and this write.
	const updated = await transitionTaskWorkflowEvidence(directory, taskId, {
		type: 'stage_a_passed',
		settlementRecovery: true,
		expectedGeneration: workflow.generation,
		transitionId,
	});
	const updatedWorkflow = getTaskWorkflowSnapshot(updated);

	// Issue #3043: the blocked-start arm of the #3032 split-brain. This writer
	// just committed the audited settlement-backed stage_a_passed, so it is
	// the authority that a `blocked` (or lagging) in-memory view in THIS
	// session is drift — refresh the caller's session view from the durable
	// snapshot it just wrote. The consumer-side #3038 guard keeps refusing
	// at-or-above views; only this writer-side refresh may clear `blocked`.
	if (isStageARecoveredState(updatedWorkflow.state)) {
		if (
			shouldRefreshStageARecoveryView(
				session.taskWorkflowStates.get(taskId),
				updatedWorkflow.state,
			)
		) {
			applySessionWorkflowView(session, taskId, updatedWorkflow);
		}
	}

	// Best-effort audit event through the shared #2665 stage_a_repair wrapper;
	// the durable transition above is authoritative, and the append outcome is
	// surfaced (FB-001 contract) instead of asserting an audit record exists.
	const auditEventRecorded = await appendStageARepairEvent(directory, {
		action: 'repaired',
		via: 'recover_stage_a_task',
		taskId,
		transitionId,
		generation: workflow.generation,
		settlementRecovery: true,
		// Which durable receipt admitted the repair: 'settlement_wal' |
		// 'requirements_receipt' (background coder rounds never write a WAL).
		justification: justification.via,
		...(justification.via === 'requirements_receipt'
			? {
					justificationTransitionId: justification.sourceTransitionId,
					justificationGeneration: justification.generation,
				}
			: {}),
		predecessorTransitionId: workflow.lastTransitionId ?? null,
		sessionId: sessionID,
		reason: sanitizedReason,
	});

	return {
		taskId,
		generation: updatedWorkflow.generation,
		state: updatedWorkflow.state,
		transitionId,
		recordedAt,
		alreadyRecovered: false,
		auditEventRecorded,
		justification: justification.via,
	};
}
