import { readdir } from 'node:fs/promises';
import { appendCoreEventSync } from '../events/core-events.js';
import { isSecretscanEvidence, loadEvidence } from '../evidence/manager.js';
import {
	getTaskWorkflowSnapshot,
	readTaskEvidence,
	type TaskEvidence,
	transitionTaskWorkflowEvidence,
} from '../gate-evidence.js';
import { validateSwarmPath } from '../hooks/utils.js';
import { sanitizeDiagnosticText } from '../scope/path-identity.js';
import * as logger from '../utils/logger.js';
import { isStrictTaskId } from '../validation/task-id.js';
import {
	type CoderSettlementWalState,
	listCoderSettlementWalStates,
} from './coder-settlement.js';
import {
	classifyEvidenceRecoveryTask,
	type TaskRecoveryStatus,
} from './task-recovery-status.js';

const MAX_STAGE_A_REPAIR_SCAN = 200;

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
 * never throws, appended through the canonical `appendCoreEventSync` seam
 * (which owns `.swarm` creation, lock retry, and torn-tail framing — its
 * single atomic append replaces the former EBUSY/EPERM one-retry), final
 * failure surfaced via criticalWarn so a silently missing audit line is
 * visible.
 */
async function appendStageARepairEvent(
	directory: string,
	payload: Record<string, unknown>,
): Promise<void> {
	try {
		appendCoreEventSync(directory, {
			type: 'stage_a_repair',
			timestamp: new Date().toISOString(),
			...payload,
		});
	} catch (error) {
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
 * Read-only candidate enumeration shared by the scan and the repair: flat
 * per-task evidence files only (`{taskId}.json` regular files; bundle
 * directories and non-task-named files are skipped).
 */
async function enumerateStageACandidates(
	directory: string,
	requested?: string[],
): Promise<{ selected: string[]; truncated: boolean }> {
	let entries: string[];
	try {
		const evidenceDir = validateSwarmPath(directory, 'evidence');
		entries = await readdir(evidenceDir);
	} catch {
		return { selected: [], truncated: false };
	}
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
	return {
		selected: selected
			.sort()
			.slice(0, MAX_STAGE_A_REPAIR_SCAN)
			.map((entry) => entry.slice(0, -'.json'.length)),
		truncated,
	};
}

/** Per-task scan verdict shared by the read-only scan and the repair. */
type StageATaskScan =
	| { kind: 'not_wedged'; state: string; evidence: TaskEvidence | null }
	| {
			kind: 'not_green';
			reason: 'no_pre_check_bundles' | 'pre_check_failed_or_stale';
			evidence: TaskEvidence | null;
	  }
	| {
			kind: 'repairable';
			generation: number;
			green: boolean;
			predecessorTransitionId: string | null;
			evidence: TaskEvidence | null;
	  };

/**
 * The decision core (issue #2665): identical predicates to the pre-refactor
 * repair loop — wedged means workflow `coder_delegated` with no pre_check
 * gate proof; the recency proof uses the latest COMMITTED settlement's
 * recordedAt with the task's own last-transition timestamp as fallback.
 */
async function scanStageATask(
	directory: string,
	taskId: string,
	walStates: readonly CoderSettlementWalState[],
): Promise<StageATaskScan> {
	const evidence = await readTaskEvidence(directory, taskId);
	const workflow = getTaskWorkflowSnapshot(evidence);
	if (workflow.state !== 'coder_delegated') {
		return { kind: 'not_wedged', state: workflow.state, evidence };
	}
	if (evidence?.gates?.pre_check) {
		return { kind: 'not_wedged', state: workflow.state, evidence };
	}
	// The caller supplies ONE settlement-WAL listing per invocation (hoisted:
	// neither loop mutates settlement WALs mid-pass), so N candidate tasks cost
	// one listing instead of N (PR #2697 review, PRR-004).
	let settledAfterMs: number | null = null;
	for (const state of walStates) {
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
	// An unreadable/failed WAL listing surfaces above (the caller's per-task
	// error path); here a successful-but-empty listing simply falls through to
	// the evidence-timestamp fallback below.
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
		return { kind: 'not_green', reason: greenness.reason, evidence };
	}
	return {
		kind: 'repairable',
		generation: workflow.generation,
		green: true,
		predecessorTransitionId: workflow.lastTransitionId ?? null,
		evidence,
	};
}

export interface StageAScanResult {
	/** One entry per enumerated task, classified in the shared #2665 vocabulary. */
	results: TaskRecoveryStatus[];
	truncated: boolean;
}

/**
 * Read-only wedge scan (issue #2665): classifies every enumerated task via
 * the shared recovery vocabulary WITHOUT emitting transitions, writing
 * evidence, or appending events. Tasks whose evidence cannot be read are
 * skipped (their failure surfaces through the repair path's per-task error
 * outcomes and the diagnose evidence checks). `repairAllowed` is true only
 * for the `live_wedge` category with green post-settlement pre-check proof.
 */
export async function scanWedgedStageA(
	directory: string,
	options?: { taskIds?: string[] },
): Promise<StageAScanResult> {
	const { selected, truncated } = await enumerateStageACandidates(
		directory,
		options?.taskIds,
	);
	const { states: walStates } = await listCoderSettlementWalStates(directory);
	const results: TaskRecoveryStatus[] = [];
	for (const taskId of selected) {
		// Both reads happen inside scanStageATask and share its per-task
		// error handling: an unreadable evidence file skips the task (its
		// failure surfaces through the repair path's per-task error outcomes
		// and the diagnose evidence checks) instead of failing the scan.
		try {
			const verdict = await scanStageATask(directory, taskId, walStates);
			if (verdict.kind === 'repairable') {
				results.push(
					classifyEvidenceRecoveryTask(taskId, verdict.evidence, verdict.green),
				);
			} else if (verdict.kind === 'not_green') {
				results.push(
					classifyEvidenceRecoveryTask(taskId, verdict.evidence, false),
				);
			} else {
				results.push(
					classifyEvidenceRecoveryTask(taskId, verdict.evidence, null),
				);
			}
		} catch {}
	}
	return { results, truncated };
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
	const { selected, truncated } = await enumerateStageACandidates(
		directory,
		requested,
	);
	// ONE settlement-WAL listing per invocation: the loop never mutates
	// settlement WALs (only evidence transitions + audit events), so every
	// task can share the same snapshot (PR #2697 review, PRR-004).
	const { states: walStates } = await listCoderSettlementWalStates(directory);
	const results: StageARepairOutcome[] = [];
	for (const taskId of selected) {
		try {
			const scan = await scanStageATask(directory, taskId, walStates);
			if (scan.kind === 'not_wedged') {
				results.push({
					taskId,
					outcome: 'skipped_not_wedged',
					state: scan.state,
				});
				continue;
			}
			if (scan.kind === 'not_green') {
				results.push({
					taskId,
					outcome: 'skipped_not_green',
					reason: scan.reason,
				});
				continue;
			}
			const transitionId = `stage-a-repair:${taskId}:${scan.generation}`;
			await transitionTaskWorkflowEvidence(directory, taskId, {
				type: 'stage_a_passed',
				expectedGeneration: scan.generation,
				transitionId,
			});
			await appendStageARepairEvent(directory, {
				action: 'repaired',
				taskId,
				transitionId,
				generation: scan.generation,
				// Issue #2665: the new receipt names its predecessor — the
				// transition that wedged the task (the accepted_mutation that
				// left the workflow at coder_delegated without Stage A proof).
				predecessorTransitionId: scan.predecessorTransitionId,
			});
			results.push({
				taskId,
				outcome: 'repaired',
				generation: scan.generation,
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
