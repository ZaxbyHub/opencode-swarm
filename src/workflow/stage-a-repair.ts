import { appendFile, mkdir, readdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isSecretscanEvidence, loadEvidence } from '../evidence/manager.js';
import {
	getTaskWorkflowSnapshot,
	readTaskEvidence,
	transitionTaskWorkflowEvidence,
} from '../gate-evidence.js';
import { validateSwarmPath } from '../hooks/utils.js';
import { sanitizeDiagnosticText } from '../scope/path-identity.js';
import * as logger from '../utils/logger.js';
import { isStrictTaskId } from '../validation/task-id.js';
import { listCoderSettlementWalStates } from './coder-settlement.js';

const MAX_STAGE_A_REPAIR_SCAN = 200;
/** Same EBUSY/EPERM one-retry policy as coder-settlement's lifecycle events. */
const RETRYABLE_EVENT_CODES = new Set(['EBUSY', 'EPERM']);

export type StageARepairOutcome =
	| {
			taskId: string;
			outcome: 'repaired';
			generation: number;
			transitionId: string;
	  }
	| { taskId: string; outcome: 'skipped_not_wedged'; state: string }
	| {
			taskId: string;
			outcome: 'skipped_not_green';
			reason: 'no_pre_check_bundles' | 'pre_check_failed_or_stale';
	  }
	| { taskId: string; outcome: 'error'; message: string };

export interface StageARepairResult {
	results: StageARepairOutcome[];
	truncated: boolean;
}

/**
 * Appends a stage_a_repair lifecycle event to `.swarm/events.jsonl`.
 * Mirrors coder-settlement's appendSettlementEvent contract: best-effort,
 * never throws, parent dir created, one EBUSY/EPERM retry, final failure
 * surfaced via criticalWarn so a silently missing audit line is visible.
 */
async function appendStageARepairEvent(
	directory: string,
	payload: Record<string, unknown>,
): Promise<void> {
	const line = `${JSON.stringify({
		type: 'stage_a_repair',
		timestamp: new Date().toISOString(),
		...payload,
	})}\n`;
	try {
		const eventsPath = validateSwarmPath(directory, 'events.jsonl');
		await mkdir(dirname(eventsPath), { recursive: true });
		await appendFile(eventsPath, line, 'utf-8');
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code && RETRYABLE_EVENT_CODES.has(code)) {
			try {
				const eventsPath = validateSwarmPath(directory, 'events.jsonl');
				await appendFile(eventsPath, line, 'utf-8');
				return;
			} catch (retryError) {
				logger.criticalWarn(
					`[stage-a-repair] audit event write failed after retry: ${
						retryError instanceof Error
							? retryError.message
							: String(retryError)
					}`,
				);
				return;
			}
		}
		logger.criticalWarn(
			`[stage-a-repair] audit event write failed: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}

export type PreCheckGreennessResult =
	| { green: true }
	| {
			green: false;
			reason: 'no_pre_check_bundles' | 'pre_check_failed_or_stale';
	  };

/**
 * Decides whether durable post-settlement Stage A proof exists for a wedged
 * task. "Green" REQUIRES BOTH a secretscan evidence bundle whose latest entry
 * is pass/approved/info with full coverage and zero findings, AND a sast_scan
 * evidence bundle whose latest entry is pass/approved/info. Also requires
 * every considered entry to be newer than the settlement commit when
 * `settledAfterMs` is supplied (a scan taken before the coder's mutation
 * proves nothing about it).
 *
 * Deliberately more conservative than `pre_check_batch`'s own default bar in
 * two edge cases it cannot reproduce from persisted evidence alone: (1) a
 * degraded-but-tolerated SAST run (Semgrep process failure with zero
 * findings) persists an ordinary `verdict: 'fail'` entry structurally
 * indistinguishable from a genuine failure — `failure_kind` is only present
 * on the tool's transient return value, not the persisted bundle — so this
 * function treats it as failing rather than risk silently waving through a
 * scan that never actually completed; (2) a project running with SAST
 * disabled (`sast_enabled: false`) never persists a `sast_scan` bundle at
 * all, so a wedged task from such a project cannot be auto-repaired via this
 * path and needs manual attention. Both are intentional fail-closed
 * trade-offs for a security-relevant repair tool, not bugs — see PR #2316
 * review finding ST-001/UIB-004 for why an absent-SAST-is-fine policy was
 * removed in the first place.
 *
 * Evidence bucket names vs. entry type tags differ for SAST: the scanner
 * persists its bundle under bucket `sast_scan` (see `src/tools/sast-scan.ts`)
 * with individual entries tagged `type: 'sast'`.
 */
async function hasGreenPostSettlementPreCheck(
	directory: string,
	settledAfterMs: number | null,
): Promise<PreCheckGreennessResult> {
	let sawSecretscanGreen = false;
	let sawSastGreen = false;
	for (const evidenceType of ['secretscan', 'sast_scan'] as const) {
		let result: Awaited<ReturnType<typeof loadEvidence>>;
		try {
			result = await loadEvidence(directory, evidenceType, { migrate: false });
		} catch {
			continue;
		}
		if (result.status !== 'found') continue;
		const entryTypeTag = evidenceType === 'sast_scan' ? 'sast' : evidenceType;
		const typed = result.bundle.entries.filter(
			(entry) => entry.type === entryTypeTag,
		);
		if (typed.length === 0) continue;
		const last = typed[typed.length - 1];
		const ts = Date.parse(String(last.timestamp ?? ''));
		if (settledAfterMs !== null && Number.isFinite(ts) && ts < settledAfterMs) {
			return { green: false, reason: 'pre_check_failed_or_stale' };
		}
		if (evidenceType === 'secretscan') {
			if (
				(last.verdict === 'pass' ||
					last.verdict === 'approved' ||
					last.verdict === 'info') &&
				isSecretscanEvidence(last) &&
				(last.incomplete_files ?? 0) === 0 &&
				(last.files_scanned ?? 0) > 0 &&
				(last.findings_count ?? 0) === 0
			) {
				sawSecretscanGreen = true;
				continue;
			}
		} else if (
			last.verdict === 'pass' ||
			last.verdict === 'approved' ||
			last.verdict === 'info'
		) {
			sawSastGreen = true;
			continue;
		}
		if (last.verdict === 'fail' || last.verdict === 'rejected') {
			return { green: false, reason: 'pre_check_failed_or_stale' };
		}
	}
	// Both a green secretscan AND a green sast_scan bundle are REQUIRED — see
	// this function's docstring above for the two known cases where this is
	// intentionally more conservative than pre_check_batch's own bar.
	if (!sawSecretscanGreen || !sawSastGreen) {
		return { green: false, reason: 'no_pre_check_bundles' };
	}
	return { green: true };
}

/**
 * Repair path for tasks already wedged at `coder_delegated`
 * (TASK_WORKFLOW_STAGE_A_REQUIRED post-reset wedge). For each flat task
 * evidence file whose workflow store sits at `coder_delegated` with no
 * pre_check gate proof AND a green post-settlement pre-check bundle, emits
 * the missing `stage_a_passed` transition directly and appends an audit
 * event. Never re-runs the coder; live DISPATCHED/PREPARED settlement WALs
 * refuse the transition loudly (CODER_SETTLEMENT_IN_PROGRESS) and surface as
 * per-task errors without blocking siblings.
 */
export async function repairWedgedStageA(
	directory: string,
	options?: { taskIds?: string[] },
): Promise<StageARepairResult> {
	const requested = options?.taskIds;
	let entries: string[];
	try {
		const evidenceDir = validateSwarmPath(directory, 'evidence');
		entries = await readdir(evidenceDir);
	} catch {
		return { results: [], truncated: false };
	}
	// Flat per-task evidence files only: `{taskId}.json` regular files. Bundle
	// directories (`{name}/`) and non-task-named files are skipped.
	const candidates = entries.filter(
		(entry) =>
			entry.endsWith('.json') &&
			isStrictTaskId(entry.slice(0, -'.json'.length)),
	);
	const selected = requested?.length
		? candidates.filter((entry) =>
				requested.includes(entry.slice(0, -'.json'.length)),
			)
		: candidates;
	const truncated =
		!requested?.length && candidates.length > MAX_STAGE_A_REPAIR_SCAN;
	const results: StageARepairOutcome[] = [];
	for (const entry of selected.sort().slice(0, MAX_STAGE_A_REPAIR_SCAN)) {
		const taskId = entry.slice(0, -'.json'.length);
		try {
			const evidence = await readTaskEvidence(directory, taskId);
			const workflow = getTaskWorkflowSnapshot(evidence);
			if (workflow.state !== 'coder_delegated') {
				results.push({
					taskId,
					outcome: 'skipped_not_wedged',
					state: workflow.state,
				});
				continue;
			}
			if (evidence?.gates?.pre_check) {
				results.push({
					taskId,
					outcome: 'skipped_not_wedged',
					state: workflow.state,
				});
				continue;
			}
			let settledAfterMs: number | null = null;
			try {
				const { states } = await listCoderSettlementWalStates(directory);
				for (const state of states) {
					if (state.taskId !== taskId) continue;
					if (state.state !== 'COMMITTED') continue;
					if (state.recordedAt === undefined) continue;
					const parsed = Date.parse(state.recordedAt);
					if (!Number.isFinite(parsed)) continue;
					// Pre-check bundles are global (not task-scoped): require them
					// to be newer than the latest committed settlement for this
					// task so a scan taken before the coder's mutation cannot
					// repair it.
					settledAfterMs =
						settledAfterMs === null ? parsed : Math.max(settledAfterMs, parsed);
				}
			} catch {
				// WAL read failure falls through to the evidence-timestamp
				// fallback below rather than disabling the recency check.
			}
			if (settledAfterMs === null) {
				// No settlement WAL exists for this task (background-dispatched
				// coder tasks never create one — see stage-b-gates.ts), or the
				// WAL read failed. Fall back to the task's own last-transition
				// timestamp (the accepted_mutation that put it at
				// coder_delegated) so recency is still provable rather than
				// silently disabled.
				const fallbackTs = Date.parse(workflow.updatedAt);
				if (Number.isFinite(fallbackTs)) settledAfterMs = fallbackTs;
			}
			const greenness = await hasGreenPostSettlementPreCheck(
				directory,
				settledAfterMs,
			);
			if (!greenness.green) {
				results.push({
					taskId,
					outcome: 'skipped_not_green',
					reason: greenness.reason,
				});
				continue;
			}
			const transitionId = `stage-a-repair:${taskId}:${workflow.generation}`;
			await transitionTaskWorkflowEvidence(directory, taskId, {
				type: 'stage_a_passed',
				expectedGeneration: workflow.generation,
				transitionId,
			});
			await appendStageARepairEvent(directory, {
				action: 'repaired',
				taskId,
				transitionId,
				generation: workflow.generation,
			});
			results.push({
				taskId,
				outcome: 'repaired',
				generation: workflow.generation,
				transitionId,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await appendStageARepairEvent(directory, {
				action: 'repair-failed',
				taskId,
				message: sanitizeDiagnosticText(message, 512),
			});
			results.push({ taskId, outcome: 'error', message });
		}
	}
	return { results, truncated };
}
