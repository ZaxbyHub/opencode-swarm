import * as fs from 'node:fs';
import * as path from 'node:path';
import { stripKnownSwarmPrefix } from '../config/schema.js';
import {
	getTaskWorkflowSnapshot,
	readTaskEvidenceState,
	transitionTaskWorkflowEvidence,
} from '../gate-evidence.js';
import { loadPlanJsonOnly } from '../plan/manager.js';
import { sanitizeDiagnosticText } from '../scope/path-identity.js';
import { ensureAgentSession } from '../state.js';
import { ensureRecoveryRouteReceipt } from './recovery-route-receipt.js';
import {
	appendStageARepairEvent,
	hasGreenPostSettlementPreCheck,
} from './stage-a-repair.js';

export interface ReworkRecoverySummary {
	taskId: string;
	generation: number;
	state: string;
	transitionId: string;
	recordedAt: string;
	/**
	 * Whether the stage_a_repair audit event actually landed in
	 * `.swarm/events.jsonl`. The durable transition is authoritative regardless;
	 * this surfaces the best-effort append honestly instead of asserting an
	 * audit record that may not exist (issue #2755 review, FB-001).
	 */
	auditEventRecorded: boolean;
	/**
	 * 2026-11-25 (2.26 wedge): whether a baseline v1 review route receipt
	 * exists for the recovered Stage-B cycle (pre-existing or materialized by
	 * this recovery). False keeps the pre-recovery completion behavior.
	 */
	routeReceiptEnsured: boolean;
}

/**
 * Architect-supervised recovery from `rework_required` (issue #2755).
 *
 * The mechanical `stage_a_passed` transition deliberately fails closed from
 * `rework_required` (`TASK_WORKFLOW_CODER_MUTATION_REQUIRED`): a genuine code
 * defect must go back through the coder. But a Stage B verdict that failed
 * WITHOUT a code defect (e.g. a tool-argument mistake scored as a verdict —
 * sibling issue #2756) strands a task whose code is correct, reviewed, and
 * green on Stage A checks, with no agent-legal exit; the only other remedy
 * ever offered is the human-only `/swarm recover`, whose repair leg skips
 * this state entirely.
 *
 * This is the audited escape hatch the #2703 precedent
 * (`approve_retry_sounding_board`) established for exactly this class: it
 * writes the SAME durable transition the mechanical path would have written,
 * admitted ONLY by the `supervisedRecovery` flag the reducer accepts from
 * `rework_required`, and records a distinguishable `stage_a_repair` audit
 * event (action `rework_recovered`). Every precondition fails closed; the
 * mechanical path and the `/swarm recover` auto-scan are untouched.
 */
export async function forceRecoverReworkTask(
	directory: string,
	sessionID: string,
	options: { taskId: string; reason?: string },
): Promise<ReworkRecoverySummary> {
	// Defense-in-depth mirroring forceRecordRetrySoundingBoardApproval: the
	// recover_rework_task tool is registered for the architect only, but
	// require the ACTIVE session to be the architect so a non-architect
	// context cannot self-unblock the workflow state machine.
	const session = ensureAgentSession(sessionID, undefined, directory);
	if (
		!session ||
		!session.agentName ||
		stripKnownSwarmPrefix(session.agentName) !== 'architect'
	) {
		throw new Error(
			'RECOVER_REWORK_ARCHITECT_REQUIRED: recover_rework_task requires an active architect session. ' +
				'The rework escape hatch is architect-only; a coder/reviewer/test_engineer cannot self-unblock a task.',
		);
	}

	const taskId =
		typeof options.taskId === 'string' ? options.taskId.trim() : '';
	if (!taskId) {
		throw new Error(
			'RECOVER_REWORK_UNKNOWN_TASK: recover_rework_task requires the exact plan task id (e.g. "1.1").',
		);
	}

	const plan = await loadPlanJsonOnly(directory);
	if (!plan) {
		// Same missing/corrupt distinction as forceRecordPlanCriticApproval.
		const planPath = path.join(directory, '.swarm', 'plan.json');
		if (fs.existsSync(planPath)) {
			throw new Error(
				'PLAN_CORRUPT: .swarm/plan.json exists but could not be parsed ' +
					'(corrupt or schema-invalid). Repair or re-save the plan before ' +
					'recovering a rework_required task.',
			);
		}
		throw new Error(
			'PLAN_NOT_FOUND: no .swarm/plan.json — cannot recover a rework_required ' +
				'task without a plan. Save a plan first.',
		);
	}
	const knownTaskIds = new Set(
		plan.phases.flatMap((phase) => phase.tasks.map((task) => task.id)),
	);
	if (!knownTaskIds.has(taskId)) {
		throw new Error(
			`RECOVER_REWORK_UNKNOWN_TASK: task ${taskId} is not in the current plan. Refusing to recover a foreign task id.`,
		);
	}

	// Discriminated evidence read (issue #2755 review, FB-004): readTaskEvidence
	// collapses missing and unparseable files to null, which would misreport a
	// corrupt evidence file as "no evidence exists" and steer the architect away
	// from evidence repair. Mirrors the plan missing/corrupt distinction below.
	const evidenceRead = await readTaskEvidenceState(directory, taskId);
	if (evidenceRead.kind === 'unparseable') {
		throw new Error(
			`RECOVER_REWORK_EVIDENCE_CORRUPT: the workflow evidence file for task ${taskId} exists but could not be parsed (${evidenceRead.evidencePath}). ` +
				'Repair the evidence first (repair_gate_evidence or /swarm doctor); recovery cannot classify a corrupt evidence state.',
		);
	}
	const evidence = evidenceRead.kind === 'ok' ? evidenceRead.evidence : null;
	const workflow = getTaskWorkflowSnapshot(evidence);
	if (!evidence || !workflow.authoritative) {
		throw new Error(
			`RECOVER_REWORK_NO_WORKFLOW: no durable task workflow evidence exists for task ${taskId} — there is no rework state to recover.`,
		);
	}
	if (workflow.state !== 'rework_required') {
		throw new Error(
			`RECOVER_REWORK_STATE_REQUIRED: task ${taskId} is at ${workflow.state}, not rework_required. ` +
				'This recovery applies only to a task whose Stage B verdict moved it to rework_required without a code change. ' +
				'From coder_delegated, run pre_check_batch; for a genuine code defect, delegate the coder to repair it first.',
		);
	}

	// Green pre-check proof for the wedged generation: both a secretscan and a
	// sast_scan bundle whose latest entries are green AND newer than the
	// transition that wedged the task. `workflow.updatedAt` on rework_required
	// IS that wedge moment (the stage_b_failed / stage_a_failed), which is
	// strictly newer than the accepted_mutation that created this generation —
	// so bundles newer than the wedge are necessarily newer than the mutation.
	// Same fail-closed trade-offs as the #2665 wedge repair: a project with
	// SAST disabled never persists a sast_scan bundle and cannot use this path.
	const wedgeMs = Date.parse(workflow.updatedAt);
	if (!Number.isFinite(wedgeMs)) {
		throw new Error(
			'RECOVER_REWORK_GREEN_PRECHECK_REQUIRED: cannot prove pre-check recency ' +
				`(workflow updatedAt "${workflow.updatedAt}" is not a parseable timestamp — the evidence file for task ${taskId} is likely corrupt). ` +
				'Repair the evidence (repair_gate_evidence or /swarm doctor); re-running pre_check_batch cannot fix an unparseable timestamp.',
		);
	}
	const greenness = await hasGreenPostSettlementPreCheck(directory, wedgeMs);
	if (!greenness.green) {
		// FB-007: in a SAST-disabled config this refusal is permanent (no
		// sast_scan bundle is ever persisted), so the generic retry advice would
		// dead-end; name the config cause and the working alternative.
		const sastHint =
			greenness.reason === 'no_pre_check_bundles'
				? ' Note: if gates.sast_scan.enabled is false, no sast_scan bundle is ever persisted and this recovery is unavailable by design — enable gates.sast_scan.enabled and run sast_scan, or use the coder repair loop.'
				: '';
		throw new Error(
			`RECOVER_REWORK_GREEN_PRECHECK_REQUIRED: refusing to mark Stage A passed without proof (${greenness.reason}). ` +
				"The bar is a green secretscan AND sast_scan evidence pair newer than the failing verdict — normally provided by a fresh pre_check_batch run (bundle proof is global, not correlated to the task's changed files)." +
				sastHint,
		);
	}

	// FB-005: the reason reaches the human-readable audit trail; apply the
	// repo's untrusted-diagnostic scrubber so control/bidi characters cannot
	// spoof audit renders (sibling stage-a-repair sanitizes its repair-failed
	// messages the same way). Also makes the release fragment's "sanitized
	// reason" claim true.
	const sanitizedReason =
		typeof options.reason === 'string' && options.reason.trim().length > 0
			? sanitizeDiagnosticText(options.reason.trim(), 500)
			: undefined;
	const recordedAt = new Date().toISOString();
	// Deterministic per generation: a repeat call after success can never reach
	// this line (the state precondition above fails closed on pre_check_passed).
	const transitionId = `rework-recovery:${taskId}:gen${workflow.generation}`;

	// The supervised stage_a_passed the mechanical path refuses to emit from
	// rework_required. expectedGeneration fails the write closed if a
	// concurrent accepted_mutation/repair_idle rotated the generation between
	// the read above and this write.
	const updated = await transitionTaskWorkflowEvidence(directory, taskId, {
		type: 'stage_a_passed',
		supervisedRecovery: true,
		expectedGeneration: workflow.generation,
		transitionId,
	});
	const updatedWorkflow = getTaskWorkflowSnapshot(updated);

	// Best-effort audit event through the shared #2665 stage_a_repair wrapper
	// (appendCoreEventSync seam, criticalWarn on failure): the durable
	// transition above is authoritative; this event is the human-readable
	// trail distinguishing a supervised recovery from a mechanical pass. The
	// append outcome is surfaced to the caller (FB-001) instead of asserting
	// an audit record that may not exist.
	const auditEventRecorded = await appendStageARepairEvent(directory, {
		action: 'rework_recovered',
		taskId,
		transitionId,
		generation: workflow.generation,
		sessionId: sessionID,
		...(sanitizedReason ? { reason: sanitizedReason } : {}),
	});

	// 2026-11-25 (2.26 wedge): the recovered task enters a fresh Stage-B
	// cycle — materialize the baseline route receipt so the cycle is
	// route-satisfiable at completion even when the dispatch-time allocator
	// never wrote one (the legacy-unrouted admission shape). Best-effort:
	// the durable transition above is authoritative either way.
	const routeReceiptEnsured = await ensureRecoveryRouteReceipt({
		directory,
		taskId,
		sessionId: sessionID,
	});

	return {
		taskId,
		generation: updatedWorkflow.generation,
		state: updatedWorkflow.state,
		transitionId,
		recordedAt,
		auditEventRecorded,
		routeReceiptEnsured,
	};
}
