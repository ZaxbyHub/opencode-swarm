import { appendFile, mkdir, readdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isSecretscanEvidence, loadEvidence } from '../evidence/manager.js';
import {
	getTaskWorkflowSnapshot,
	readTaskEvidence,
	transitionTaskWorkflowEvidence,
} from '../gate-evidence.js';
import { validateSwarmPath } from '../hooks/utils.js';
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

/**
 * Decides whether durable post-settlement Stage A proof exists for a wedged
 * task. "Green" REQUIRES a secretscan evidence bundle whose latest entry is
 * pass/approved/info with full coverage and zero findings (the only Stage A
 * artifact pre_check_batch persists), plus no failing/rejected latest sast
 * entry, and every considered entry newer than the settlement commit when
 * `settledAfterMs` is supplied (a scan taken before the coder's mutation
 * proves nothing about it).
 */
async function hasGreenPostSettlementPreCheck(
	directory: string,
	settledAfterMs: number | null,
): Promise<{
	green: boolean;
	reason: 'no_pre_check_bundles' | 'pre_check_failed_or_stale';
}> {
	let sawSecretscanGreen = false;
	for (const evidenceType of ['secretscan', 'sast'] as const) {
		let result: Awaited<ReturnType<typeof loadEvidence>>;
		try {
			result = await loadEvidence(directory, evidenceType, { migrate: false });
		} catch {
			continue;
		}
		if (result.status !== 'found') continue;
		const typed = result.bundle.entries.filter(
			(entry) => entry.type === evidenceType,
		);
		if (typed.length === 0) continue;
		const last = typed[typed.length - 1];
		const ts = Date.parse(String(last.timestamp ?? ''));
		if (settledAfterMs !== null && Number.isFinite(ts) && ts < settledAfterMs) {
			return { green: false, reason: 'pre_check_failed_or_stale' };
		}
		if (
			evidenceType === 'secretscan' &&
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
		if (last.verdict === 'fail' || last.verdict === 'rejected') {
			return { green: false, reason: 'pre_check_failed_or_stale' };
		}
	}
	// A green secretscan bundle is REQUIRED: it is the only pre-check artifact
	// pre_check_batch persists today, and a sast-only record cannot vouch for
	// the full Stage A gate.
	if (!sawSecretscanGreen) {
		return { green: false, reason: 'no_pre_check_bundles' };
	}
	return { green: true, reason: 'no_pre_check_bundles' };
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
				// WAL read failure must not block repair; recency check degrades
				// to timestamp-agnostic greenness.
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
				message: message.slice(0, 512),
			});
			results.push({ taskId, outcome: 'error', message });
		}
	}
	return { results, truncated };
}
