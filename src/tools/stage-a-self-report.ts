/**
 * Tool-side Stage A self-report for `pre_check_batch`.
 *
 * OpenCode 2.3.1/2.3.2 regression (anomalyco/opencode#65742): tool calls
 * invoked NESTED inside a Code Mode `execute` program no longer dispatch
 * plugin `tool.execute.before`/`tool.execute.after` hooks (they did in
 * 2.3.0). The guardrails hook chain is the plugin's only Stage A receipt
 * producer, so on affected hosts every gate run an agent makes through
 * `execute` — the common architect pattern — completed green while the
 * Stage A workflow attribution silently never fired: no pending-gate-task
 * correlation, no `stage_a_passed` transition, no route event, and no
 * advisory, wedging the task later at the Stage B dispatch
 * (TASK_WORKFLOW_STAGE_A_REQUIRED) with nothing pointing back to the cause.
 *
 * This module re-issues the same receipt from INSIDE the tool, where the
 * code always runs regardless of hook dispatch. It mirrors the guardrails
 * `toolBefore`/`toolAfter` attribution chain (session currentTaskId, then
 * the durable COMMITTED-settlement fallback) and is deliberately idempotent
 * with the hook path for hosts where hooks still fire:
 *
 * - a duplicate guard skips the transition when the snapshot already shows
 *   a `pre-check*` Stage A pass for the same generation (route event
 *   `duplicate_result`);
 * - the reducer's `stage_a_passed` from `pre_check_passed` arm is an
 *   idempotent no-op, so a hook-side write racing a tool-side write is
 *   harmless;
 * - route events may legitimately double (one per producer) — they are
 *   bounded diagnostic lines, never control flow.
 *
 * Fail-open by contract: this module must never break or delay a gate run
 * beyond its own bounded I/O — every error path is warn-only.
 */

import { readDelegations } from '../background/pending-delegations';
import { scopeSetContainsFile } from '../background/stage-b-gates';
import { changedFilesSinceSnapshot } from '../background/workspace-snapshot';
import {
	getTaskWorkflowSnapshot,
	readTaskEvidence,
	transitionTaskWorkflowEvidence,
} from '../gate-evidence';
import {
	emitDurableAttributionAdvisory,
	_internals as guardrailsInternals,
} from '../hooks/guardrails';
import { decodePreCheckResult } from '../hooks/guardrails/pre-check-result';
import {
	recordStageAGateRoute,
	type StageAGateRoute,
} from '../hooks/guardrails/stage-a-route';
import { swarmState } from '../state';
import { warn } from '../utils';
import { isStrictTaskId } from '../validation/task-id';

export interface ToolSideStageAInput {
	/** Calling session — always present in host invocations (the call site
	 * gates on it); used for currentTaskId resolution and advisory push. */
	sessionID: string;
	/** Resolved project root the gate run targeted. */
	directory: string;
	/** The tool's own serialized result — decoded with the same decoder the
	 * hook uses, so verdict semantics (sast_degraded, preexisting proofs,
	 * truncation) are identical. */
	serializedResult: string;
	/** The gate run's file scope, for the durable fallback attribution. */
	files: string[] | undefined;
	/** Bounded identifier for the route-event lines (the host call id is not
	 * visible inside the tool). */
	toolCallId: string;
}

function emitRoute(
	input: ToolSideStageAInput,
	route: StageAGateRoute,
	taskId: string | null,
): void {
	recordStageAGateRoute(input.directory, {
		route,
		sessionID: input.sessionID,
		callID: input.toolCallId,
		taskId,
		guardrailsEnabled: true,
	});
}

/**
 * Report a completed `pre_check_batch` run to the Stage A workflow.
 * Never throws; never mutates the gate result.
 */
export async function reportToolSideStageA(
	input: ToolSideStageAInput,
): Promise<void> {
	try {
		const verdict = decodePreCheckResult(input.serializedResult);
		// Only verdicts carry a Stage A receipt: a pass or a fail. Invalid or
		// skipped batches hold no verdict (hook parity).
		if (verdict.kind !== 'pass' && verdict.kind !== 'fail') return;

		// Task resolution, mirroring the guardrails toolBefore chain minus the
		// hook-only epic/parallel wave attribution (single-task sessions — the
		// shape the Code Mode regression wedges — resolve through the session
		// task or the durable COMMITTED-settlement fallback).
		let taskId: string | undefined;
		const currentTaskId = swarmState.agentSessions.get(
			input.sessionID,
		)?.currentTaskId;
		if (currentTaskId && isStrictTaskId(currentTaskId)) {
			taskId = currentTaskId;
		} else {
			const fallback = await guardrailsInternals.resolveDurableGateTaskId(
				input.directory,
				input.files ?? null,
			);
			if (fallback && 'taskId' in fallback) taskId = fallback.taskId;
			// ambiguous / unbound durable states stay unattributed here: the
			// hook-side toolBefore advisories cover them on hosts where hooks
			// fire; on regressed hosts the no-correlation advisory below still
			// communicates that the receipt was dropped.
		}

		if (!taskId) {
			// The silent-wedge communication fix, now reachable for nested
			// Code Mode calls: a PASS that cannot be attributed must not look
			// like success. Same contract as the guardrails toolAfter advisory.
			if (verdict.kind === 'pass') {
				emitDurableAttributionAdvisory(
					input.sessionID,
					`${input.directory}\u0000stage-a-unattributed-pass`,
					'STAGE A RECEIPT NOT ATTRIBUTED: pre_check_batch passed but the result could not be attributed to any task — no session task correlation (in-memory state wiped by a restart or reset, or the tool call bypassed the plugin tool hooks) and no durable settlement candidate (background-dispatched coder rounds write no settlement WAL). The green result was NOT recorded as Stage A evidence; reviewer/test_engineer dispatches will be denied with TASK_WORKFLOW_STAGE_A_REQUIRED. Remediation: if a background coder round for this task just completed, run /swarm recover <task> to settle its stale settlement, then re-run pre_check_batch; otherwise dispatch a coder round that performs a real in-scope mutation, then re-run pre_check_batch. If this was an ad-hoc gate run with no task in flight, no action is needed.',
				);
			}
			emitRoute(input, 'no_task_correlation', null);
			return;
		}

		const snapshot = getTaskWorkflowSnapshot(
			await readTaskEvidence(input.directory, taskId),
		);

		// Mis-settled background completion reconciliation: the pre-fix
		// directory-scope attribution bug recorded real mutations as
		// dispatch_no_mutation (the durable evidence still shows it), leaving
		// the task wedged at idle with the coder's changes in the working
		// tree and no path to Stage A. When the last workflow transition is a
		// background-coder no-mutation settlement, re-derive that record's
		// attribution with the fixed predicate and record the accepted
		// mutation it should have carried — the wedge then heals on this very
		// gate run instead of demanding a fresh coder round or a human
		// /swarm recover.
		let effectiveSnapshot = snapshot;
		if (
			verdict.kind === 'pass' &&
			snapshot.state === 'idle' &&
			snapshot.lastOutcome === 'dispatch_no_mutation' &&
			typeof snapshot.lastTransitionId === 'string' &&
			snapshot.lastTransitionId.startsWith('background-coder:')
		) {
			const reconciled = await reconcileMisSettledBackgroundMutation(
				input.directory,
				taskId,
				snapshot,
				input,
			);
			if (reconciled) effectiveSnapshot = reconciled;
		}

		// Duplicate guard (hook-path idempotency): a Stage A pass already
		// recorded for this generation by either producer needs no second
		// transition.
		if (
			verdict.kind === 'pass' &&
			effectiveSnapshot.state === 'pre_check_passed' &&
			effectiveSnapshot.lastOutcome === 'stage_a_passed' &&
			typeof effectiveSnapshot.lastTransitionId === 'string' &&
			effectiveSnapshot.lastTransitionId.startsWith('pre-check')
		) {
			emitRoute(input, 'duplicate_result', taskId);
			return;
		}

		try {
			await transitionTaskWorkflowEvidence(input.directory, taskId, {
				type: verdict.kind === 'pass' ? 'stage_a_passed' : 'stage_a_failed',
				expectedGeneration: effectiveSnapshot.generation,
				transitionId: `pre-check-tool:${input.toolCallId}`,
			});
			emitRoute(
				input,
				verdict.kind === 'pass' ? 'valid_pass' : 'pre_check_failed',
				taskId,
			);
		} catch (transitionError) {
			const message =
				transitionError instanceof Error
					? transitionError.message
					: String(transitionError);
			if (message.includes('TASK_WORKFLOW_CODER_MUTATION_REQUIRED')) {
				// The observed 2.3.2 wedge tail: the gate is green and the task
				// resolves, but the workflow holds no accepted coder mutation
				// for this generation — typically a background coder round that
				// completed without settling (its settlement WAL is stale).
				// Without this advisory the architect sees only a much later
				// TASK_WORKFLOW_STAGE_A_REQUIRED denial with a remediation that
				// does not terminate.
				emitDurableAttributionAdvisory(
					input.sessionID,
					`${input.directory}\u0000stage-a-mutation-required`,
					`STAGE A WRITE FAILED (TASK_WORKFLOW_CODER_MUTATION_REQUIRED) for task ${taskId}: pre_check_batch ${
						verdict.kind === 'pass' ? 'passed' : 'failed'
					} but no accepted coder mutation is recorded for the current generation. If a background coder round just completed for this task, its settlement never landed — run /swarm recover ${taskId} to settle the stale settlement, then re-run pre_check_batch. Otherwise dispatch a coder round that performs a real in-scope change, then re-run pre_check_batch.`,
				);
			} else {
				warn(
					'pre_check_batch: tool-side Stage A transition rejected (fail-open)',
					{
						taskId,
						error: message.slice(0, 120),
					},
				);
			}
		}
	} catch (error) {
		warn('pre_check_batch: tool-side Stage A self-report failed (fail-open)', {
			error:
				error instanceof Error
					? error.message.slice(0, 120)
					: String(error).slice(0, 120),
		});
	}
}

/**
 * Reconcile a mis-settled background coder completion: the last workflow
 * transition is a `background-coder:*` `dispatch_no_mutation`, but the
 * delegation record's baseline re-derived with the fixed directory-aware
 * attribution shows real in-scope changes. Records the accepted mutation the
 * completion should have carried and returns the updated snapshot — or null
 * when nothing reconciles (record missing, later dispatch exists, baseline
 * unreadable, or genuinely no in-scope change). Fail-open, never throws.
 */
async function reconcileMisSettledBackgroundMutation(
	directory: string,
	taskId: string,
	snapshot: ReturnType<typeof getTaskWorkflowSnapshot>,
	input: ToolSideStageAInput,
): Promise<ReturnType<typeof getTaskWorkflowSnapshot> | null> {
	try {
		const correlationId = snapshot.lastTransitionId!.slice(
			'background-coder:'.length,
		);
		const taskRecords = readDelegations(directory).filter(
			(record) =>
				record.evidenceTaskId === taskId || record.planTaskId === taskId,
		);
		const record = taskRecords.find(
			(candidate) => candidate.correlationId === correlationId,
		);
		if (!record?.taskChangeContext) return null;
		// Only the LATEST dispatch for the task may reconcile: a later
		// delegation (in flight or completed) owns the working tree now.
		const laterExists = taskRecords.some(
			(candidate) => candidate.updatedAt > record.updatedAt,
		);
		if (laterExists) return null;
		const observed = changedFilesSinceSnapshot(
			directory,
			record.taskChangeContext.baseline,
		);
		if (observed === null) return null;
		const declared = new Set(record.taskChangeContext.declaredFiles ?? []);
		const attributed = observed.filter((file) =>
			scopeSetContainsFile(declared, file),
		);
		if (attributed.length === 0) return null;
		const updated = await transitionTaskWorkflowEvidence(directory, taskId, {
			type: 'accepted_mutation',
			agentType: 'coder',
			expectedGeneration: snapshot.generation,
			transitionId: `background-coder-reconcile:${correlationId}`,
		});
		emitDurableAttributionAdvisory(
			input.sessionID,
			`${directory}\u0000stage-a-reconciled`,
			`STAGE A RECONCILED for task ${taskId}: its last background coder completion had been mis-settled as dispatch_no_mutation (the pre-fix directory-scope attribution bug); ${attributed.length} changed file(s) under the declared scope are now recorded as the accepted mutation, and this green pre_check_batch records stage_a_passed. No /swarm recover or fresh coder round needed.`,
		);
		return getTaskWorkflowSnapshot(updated);
	} catch (error) {
		warn(
			'pre_check_batch: mis-settled background completion reconciliation skipped (fail-open)',
			{
				taskId,
				error:
					error instanceof Error
						? error.message.slice(0, 120)
						: String(error).slice(0, 120),
			},
		);
		return null;
	}
}
