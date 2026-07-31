/**
 * Epic Mode divergence-record tool (Capability D — capture leg).
 *
 * After the architect marks a task `completed` via `update_task_status`, it
 * calls this tool with `{ directory, taskId, sessionID }`. The tool:
 *
 *   1. Reads the task's DECLARED scope from `.swarm/scopes/scope-{taskId}.json`
 *      (the same on-disk record `readScopeFromDisk` consults).
 *   2. Reads the ACTUAL files attributed to this exact task by the guardrails
 *      write hook and background-completion ingestion.
 *   3. Appends one record to `.swarm/epic/divergence.jsonl` via
 *      `recordTaskDivergence`. The calibration engine reads that file on the
 *      next `epic_decide_phase` invocation (the architect-facing decide
 *      tool — `epic_run_phase` is the legacy unified path, retained as
 *      `executeEpicRunPhase` for composition users only).
 *
 * Best-effort by design — failure to record divergence is logged but never
 * surfaces as a task-blocking error. Worst case: a single observation is
 * missed and the calibration loop sees one fewer data point.
 *
 * Composition contract: this tool does NOT modify `update_task_status` or
 * any maintainer file. The architect is instructed to call it via the
 * `EPIC_MODE_BANNER` system-enhancer injection. If the architect forgets,
 * the only effect is missing calibration signal — Epic Mode keeps working.
 */

import type { ToolDefinition } from '@opencode-ai/plugin/tool';
import { z } from 'zod';
import { loadPlanJsonOnly as loadPlanJsonOnly_import } from '../plan/manager.js';
import { readScopeFromDisk as readScopeFromDisk_import } from '../scope/scope-persistence.js';
import {
	getAgentSession as getAgentSession_import,
	getModifiedFilesForTask as getModifiedFilesForTask_import,
	hasActiveEpicMode as hasActiveEpicMode_import,
	resetModifiedFilesForTask as resetModifiedFilesForTask_import,
} from '../state.js';
import { recordTaskDivergence as recordTaskDivergence_import } from '../turbo/epic/divergence-recorder.js';
import * as logger from '../utils/logger.js';
import { createSwarmTool } from './create-tool.js';

export interface EpicRecordDivergenceArgs {
	directory: string;
	taskId: string;
	sessionID: string;
}

export interface EpicRecordDivergenceResult {
	success: boolean;
	/**
	 * Either:
	 *  - `'recorded'` — a record was appended to divergence.jsonl.
	 *  - `'epic-mode-not-active'` — session has not toggled Epic Mode; no-op.
	 *  - `'no-scope'` — no declared scope on disk for this task (could be a
	 *    pure verification task that bypassed `declare_scope`). Skipped.
	 *  - `'no-session'` — no agent session for `sessionID`; skipped.
	 *  - `'persist-failed'` — write to JSONL failed (logged); skipped.
	 */
	reason: string;
	/** When `reason === 'recorded'`, summarises the record without the full file lists. */
	summary?: {
		declaredCount: number;
		actualCount: number;
		undeclaredCount: number;
		unusedCount: number;
		divergenceRatio: number;
		isClean: boolean;
	};
}

/**
 * Test-only DI seam (AGENTS.md invariant 7). Mutating this object is
 * file-scoped and trivially restorable via afterEach, avoiding Bun's
 * cross-file `mock.module` leak.
 */
export const _internals = {
	hasActiveEpicMode: hasActiveEpicMode_import,
	getAgentSession: getAgentSession_import,
	getModifiedFilesForTask: getModifiedFilesForTask_import,
	resetModifiedFilesForTask: resetModifiedFilesForTask_import,
	readScopeFromDisk: readScopeFromDisk_import,
	loadPlanJsonOnly: loadPlanJsonOnly_import,
	recordTaskDivergence: recordTaskDivergence_import,
};

/**
 * Look up the phase number that contains the given task id, by reading
 * `plan.json`. Returns `undefined` when the plan can't be loaded or the
 * task isn't in any phase — divergence is still recorded without it.
 */
async function findPhaseForTask(
	directory: string,
	taskId: string,
): Promise<number | undefined> {
	try {
		const plan = await _internals.loadPlanJsonOnly(directory);
		if (!plan) return undefined;
		for (const phase of plan.phases) {
			if (phase.tasks.some((t: { id: string }) => t.id === taskId)) {
				return phase.id;
			}
		}
	} catch {
		// best-effort
	}
	return undefined;
}

export async function executeEpicRecordDivergence(
	args: EpicRecordDivergenceArgs,
): Promise<EpicRecordDivergenceResult> {
	const { directory, taskId, sessionID } = args;

	if (!_internals.hasActiveEpicMode(sessionID)) {
		return { success: true, reason: 'epic-mode-not-active' };
	}

	const session = _internals.getAgentSession(sessionID);
	if (!session) {
		return { success: true, reason: 'no-session' };
	}

	try {
		const declaredScope = _internals.readScopeFromDisk(directory, taskId);
		if (declaredScope === null) {
			// No declared scope means the coder skipped declare_scope, the file
			// expired its TTL, or the task is a non-code phase. Record nothing —
			// calibration only learns from tasks with a declared baseline.
			return { success: true, reason: 'no-scope' };
		}

		const actualFiles = _internals.getModifiedFilesForTask(session, taskId);
		const phaseNumber = await findPhaseForTask(directory, taskId);

		const result = _internals.recordTaskDivergence({
			directory,
			sessionID,
			taskId,
			phaseNumber,
			declaredScope,
			actualFiles,
		});

		if (!result) {
			logger.warn(
				`[epic_record_divergence] persist failed for ${taskId}; calibration will miss one observation`,
			);
			return { success: true, reason: 'persist-failed' };
		}

		const { record } = result;
		return {
			success: true,
			reason: 'recorded',
			summary: {
				declaredCount: record.declaredScope.length,
				actualCount: record.actualFiles.length,
				undeclaredCount: record.undeclared.length,
				unusedCount: record.unused.length,
				divergenceRatio: record.divergenceRatio,
				isClean: record.isClean,
			},
		};
	} finally {
		// Epic retains completed-task attribution until this calibration attempt,
		// then releases it regardless of the tool's best-effort outcome.
		_internals.resetModifiedFilesForTask(session, taskId, { remove: true });
	}
}

export const epic_record_divergence: ToolDefinition = createSwarmTool({
	description:
		'Record divergence between a completed task\'s declared scope and the files actually modified, for Epic Mode calibration (Capability D). Call this immediately after update_task_status sets status="completed". Appends one line to .swarm/epic/divergence.jsonl. Best-effort — never fails the calling agent. Use only when /swarm epic is on for the session.',
	args: {
		directory: z.string().describe('Project root directory'),
		taskId: z.string().describe('Task id whose divergence should be recorded'),
		sessionID: z.string().describe('Active session ID'),
	},
	execute: async (args: unknown, _directory: string, ctx) => {
		const { taskId, sessionID: argSessionID } =
			args as EpicRecordDivergenceArgs;
		// Same rationale as epic_run_phase: prefer the framework-supplied
		// session over a model-hallucinated value, since `hasActiveEpicMode`
		// is strictly per-session.
		const sessionID =
			ctx?.sessionID && ctx.sessionID.length > 0 ? ctx.sessionID : argSessionID;
		return JSON.stringify(
			await executeEpicRecordDivergence({
				directory: _directory,
				taskId,
				sessionID,
			}),
			null,
			2,
		);
	},
});
