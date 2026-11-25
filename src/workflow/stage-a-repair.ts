import { readdir } from 'node:fs/promises';
import { appendCoreEventSync } from '../events/core-events.js';
import { isSecretscanEvidence, loadEvidence } from '../evidence/manager.js';
import { latestAcceptedMutationReceipt } from '../evidence/task-gate-requirements.js';
import {
	getTaskWorkflowSnapshot,
	readTaskEvidence,
	type TaskEvidence,
	transitionTaskWorkflowEvidenceWithStatus,
} from '../gate-evidence.js';
import { validateSwarmPath } from '../hooks/utils.js';
import { sanitizeDiagnosticText } from '../scope/path-identity.js';
import { getAgentSession } from '../state.js';
import * as logger from '../utils/logger.js';
import { isStrictTaskId } from '../validation/task-id.js';
import {
	type CoderSettlementWalState,
	listCoderSettlementWalStates,
} from './coder-settlement.js';
import { ensureRecoveryRouteReceipt } from './recovery-route-receipt.js';
import {
	applySessionWorkflowView,
	isStageARecoveredState,
	shouldRefreshStageARecoveryView,
} from './session-view.js';
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
 * visible. Returns whether the audit line actually landed, so callers on
 * supervised-write paths can surface audit honesty instead of asserting it
 * (issue #2755 review: the recover_rework_task tool must not claim an audit
 * record exists when the append failed).
 */
export async function appendStageARepairEvent(
	directory: string,
	payload: Record<string, unknown>,
): Promise<boolean> {
	try {
		appendCoreEventSync(directory, {
			type: 'stage_a_repair',
			timestamp: new Date().toISOString(),
			...payload,
		});
		return true;
	} catch (error) {
		logger.criticalWarn(
			`[stage-a-repair] audit event write failed: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		return false;
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
export async function hasGreenPostSettlementPreCheck(
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
				isSecretscanEvidence(last)
			) {
				// #2918: vacuous coverage — every requested file deliberately
				// skipped by secretscan scan policy (extension exclusion), with
				// zero findings and zero incomplete coverage — is green evidence
				// for repair. Same normative predicate as every other enforcing
				// site; evidence missing the optional policy counters is
				// non-vacuous and keeps the previous strict bar.
				const policySkipped = last.policy_skipped_files;
				const requestedFiles = last.requested_files;
				const vacuousCoverage =
					(last.files_scanned ?? 0) === 0 &&
					typeof policySkipped === 'number' &&
					Number.isSafeInteger(policySkipped) &&
					policySkipped >= 0 &&
					typeof requestedFiles === 'number' &&
					Number.isSafeInteger(requestedFiles) &&
					requestedFiles > 0 &&
					policySkipped >= requestedFiles &&
					(last.findings_count ?? 0) === 0 &&
					(last.incomplete_files ?? 0) === 0 &&
					last.incomplete_paths.length === 0;
				if (
					(last.incomplete_files ?? 0) === 0 &&
					(last.incomplete_paths?.length ?? 0) === 0 &&
					((last.files_scanned ?? 0) > 0 || vacuousCoverage) &&
					// #3092: green means zero NEW secrets on changed lines. The
					// new-findings counter preserves 0 explicitly (no truthiness
					// fallback — that would collapse the zero-new pass onto the
					// total and re-wedge the repair loop); legacy evidence without
					// the counter falls back to the TOTAL (previous behavior).
					(() => {
						const total = last.findings_count ?? 0;
						const newFindingsRaw: unknown = last.new_findings_count;
						const preexistingRaw: unknown = last.preexisting_findings_count;
						const newValid =
							typeof newFindingsRaw === 'number' &&
							Number.isSafeInteger(newFindingsRaw) &&
							newFindingsRaw >= 0;
						if (!newValid) return total === 0;
						// #3128 review PRR-010: internally inconsistent counters
						// (new + preexisting ≠ total) cannot prove the zero-new
						// claim — fall back to the TOTAL, fail-closed.
						const preValid =
							typeof preexistingRaw === 'number' &&
							Number.isSafeInteger(preexistingRaw) &&
							preexistingRaw >= 0;
						if (preValid && newFindingsRaw + preexistingRaw !== total) {
							return total === 0;
						}
						return newFindingsRaw === 0;
					})()
				) {
					sawSecretscanGreen = true;
					continue;
				}
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
			/**
			 * Which durable receipts justify the repair: the #2665 live_wedge
			 * (workflow at coder_delegated with no pre_check gate proof) or the
			 * #2828 settlement wedge (idle/blocked with a COMMITTED accepted
			 * coder settlement). Drives the reducer's guarded entry flag.
			 */
			mode: 'live_wedge' | 'settlement_wedge';
			generation: number;
			green: boolean;
			predecessorTransitionId: string | null;
			evidence: TaskEvidence | null;
			/**
			 * Settlement-wedge only: which durable receipt justified the repair
			 * (settlement WAL vs chain-verified requirements-ledger
			 * accepted_mutation receipt — background coder rounds never write a
			 * WAL). Null on the live_wedge path.
			 */
			justification: StageASettlementJustification | null;
	  };

/** Latest COMMITTED settlement facts for one task, from the shared WAL listing. */
export function latestCommittedAcceptedSettlementMs(
	taskId: string,
	walStates: readonly CoderSettlementWalState[],
): number | null {
	let latest: number | null = null;
	for (const state of walStates) {
		if (state.taskId !== taskId) continue;
		if (state.state !== 'COMMITTED') continue;
		if (state.accepted !== true) continue;
		if (state.recordedAt === undefined) continue;
		const parsed = Date.parse(state.recordedAt);
		if (!Number.isFinite(parsed)) continue;
		latest = latest === null ? parsed : Math.max(latest, parsed);
	}
	return latest;
}

/**
 * Which durable receipt justifies a settlement-backed Stage A recovery, and
 * the timestamp post-settlement pre-check bundles must beat.
 *
 * - `settlement_wal`: a COMMITTED accepted coder-settlement WAL (the original
 *   #2828 bar; foreground coder rounds).
 * - `requirements_receipt`: no settlement WAL exists, but the append-only
 *   requirements ledger carries a chain-verified coder `accepted_mutation`
 *   receipt. Background-dispatched coder rounds never write a settlement WAL,
 *   so without this arm every task whose coder round was background-dispatched
 *   is permanently locked out of the settlement wedge recovery — the wedge
 *   then has NO sanctioned path at all (deliveries committed before a campaign
 *   rebuild re-settle as `dispatch_no_mutation` forever, so neither a fresh
 *   coder round nor pre_check attribution can open Stage A). The receipt is
 *   the same audited fact the WAL path reads, recorded by the accepted
 *   mutation itself.
 *
 * Null only when NEITHER durable receipt exists — the honest "not a settled
 * task" answer. Corrupt requirements chains propagate their
 * TASK_GATE_REQUIREMENTS_* errors (fail closed).
 */
export type StageASettlementJustification =
	| { via: 'settlement_wal'; settledAfterMs: number }
	| {
			via: 'requirements_receipt';
			settledAfterMs: number;
			sourceTransitionId: string | null;
			generation: number;
	  };

export async function resolveStageASettlementJustification(
	directory: string,
	taskId: string,
	walStates: readonly CoderSettlementWalState[],
): Promise<StageASettlementJustification | null> {
	const walMs = latestCommittedAcceptedSettlementMs(taskId, walStates);
	if (walMs !== null) {
		return { via: 'settlement_wal', settledAfterMs: walMs };
	}
	const receipt = await latestAcceptedMutationReceipt(directory, taskId);
	if (!receipt) return null;
	return {
		via: 'requirements_receipt',
		settledAfterMs: receipt.recordedAtMs,
		sourceTransitionId: receipt.sourceTransitionId,
		generation: receipt.generation,
	};
}

/**
 * The decision core (issue #2665): identical predicates to the pre-refactor
 * repair loop — wedged means workflow `coder_delegated` with no pre_check
 * gate proof; the recency proof uses the latest COMMITTED settlement's
 * recordedAt with the task's own last-transition timestamp as fallback.
 *
 * Issue #2828 adds the settlement wedge: workflow drifted to `idle` (a
 * force-repair's `repair_idle` rotated the generation and cleared the gate
 * proofs) or `blocked` (a `task_blocked` label past a recorded or missing
 * Stage A), while a COMMITTED accepted settlement WAL plus green
 * post-settlement pre-check bundles still justify Stage A. The state label
 * alone never proves health when those receipts disagree with it — the
 * disagreement is the repairable wedge.
 */
async function scanStageATask(
	directory: string,
	taskId: string,
	walStates: readonly CoderSettlementWalState[],
): Promise<StageATaskScan> {
	const evidence = await readTaskEvidence(directory, taskId);
	const workflow = getTaskWorkflowSnapshot(evidence);
	if (workflow.state === 'coder_delegated') {
		if (!evidence?.gates?.pre_check) {
			// #2665 live_wedge path (unchanged).
			const greenness = await hasGreenPostSettlementPreCheck(
				directory,
				liveWedgeSettledAfterMs(taskId, workflow, walStates),
			);
			if (!greenness.green) {
				return { kind: 'not_green', reason: greenness.reason, evidence };
			}
			return {
				kind: 'repairable',
				mode: 'live_wedge',
				generation: workflow.generation,
				green: true,
				predecessorTransitionId: workflow.lastTransitionId ?? null,
				evidence,
				justification: null,
			};
		}
		return { kind: 'not_wedged', state: workflow.state, evidence };
	}
	if (workflow.state === 'idle' || workflow.state === 'blocked') {
		// #2828 settlement wedge: the durable receipts, not the state label,
		// decide. `idle` additionally requires the pre_check proof to be absent
		// (the normal post-repair_idle shape); `blocked` admits a previously
		// recorded proof too — the wedge there is the state regression, and
		// re-recording Stage A is idempotent for the gate entry. The receipts
		// are resolved WAL-first: background-dispatched coder rounds never
		// write a settlement WAL, so their chain-verified accepted_mutation
		// requirements receipt is the durable settlement proof instead.
		const justification = await resolveStageASettlementJustification(
			directory,
			taskId,
			walStates,
		);
		if (
			justification !== null &&
			(workflow.state === 'blocked' || !evidence?.gates?.pre_check)
		) {
			const greenness = await hasGreenPostSettlementPreCheck(
				directory,
				justification.settledAfterMs,
			);
			if (!greenness.green) {
				return { kind: 'not_green', reason: greenness.reason, evidence };
			}
			return {
				kind: 'repairable',
				mode: 'settlement_wedge',
				generation: workflow.generation,
				green: true,
				predecessorTransitionId: workflow.lastTransitionId ?? null,
				evidence,
				justification,
			};
		}
		return { kind: 'not_wedged', state: workflow.state, evidence };
	}
	return { kind: 'not_wedged', state: workflow.state, evidence };
}

/**
 * Recency anchor for the #2665 live_wedge: the latest COMMITTED settlement
 * for this task (accepted or not), falling back to the task's own
 * last-transition timestamp (the accepted_mutation that put it at
 * coder_delegated) so recency is still provable rather than silently
 * disabled for WAL-less tasks.
 */
function liveWedgeSettledAfterMs(
	taskId: string,
	workflow: { updatedAt: string },
	walStates: readonly CoderSettlementWalState[],
): number | null {
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
	if (settledAfterMs === null) {
		const fallbackTs = Date.parse(workflow.updatedAt);
		if (Number.isFinite(fallbackTs)) settledAfterMs = fallbackTs;
	}
	return settledAfterMs;
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
					classifyEvidenceRecoveryTask(
						taskId,
						verdict.evidence,
						verdict.green,
						{
							settlementCommittedAccepted: verdict.mode === 'settlement_wedge',
						},
					),
				);
			} else if (verdict.kind === 'not_green') {
				const idleOrBlocked =
					verdict.evidence !== null &&
					['idle', 'blocked'].includes(
						getTaskWorkflowSnapshot(verdict.evidence).state,
					);
				const settlementJustified =
					idleOrBlocked &&
					(await resolveStageASettlementJustification(
						directory,
						taskId,
						walStates,
					)) !== null;
				results.push(
					classifyEvidenceRecoveryTask(taskId, verdict.evidence, false, {
						settlementCommittedAccepted: settlementJustified,
					}),
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
 * Repair path for tasks wedged without a recorded Stage A (issue #2665 live
 * wedge; issue #2828 settlement wedge). For each flat task evidence file
 * whose workflow store sits at `coder_delegated` with no pre_check gate proof
 * AND a green post-settlement pre-check bundle — or whose workflow drifted to
 * `idle`/`blocked` while a COMMITTED accepted coder settlement plus green
 * post-settlement pre-check proof still justify Stage A — emits the missing
 * `stage_a_passed` transition directly and appends an audit event. Never
 * re-runs the coder; live DISPATCHED/PREPARED settlement WALs refuse the
 * transition loudly (CODER_SETTLEMENT_IN_PROGRESS) and surface as per-task
 * errors without blocking siblings.
 */
export async function repairWedgedStageA(
	directory: string,
	options?: { taskIds?: string[]; sessionId?: string },
): Promise<StageARepairResult> {
	const requested = options?.taskIds;
	// Issue #3043: when invoked from a session context (/swarm recover), this
	// writer refreshes THAT session's in-memory workflow view alongside its
	// durable writes — otherwise a blocked-start repair leaves the invoking
	// session's map at `blocked` and every later Stage B verdict in it is
	// silently skipped (the #3032 split-brain, blocked-start arm). Resolved
	// with the NON-creating lookup: an unknown session id (including the CLI's
	// empty dispatch shape) skips the refresh rather than materializing an
	// 'unknown' session.
	const refreshSession = options?.sessionId
		? getAgentSession(options.sessionId)
		: undefined;
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
				// Issue #3043 skip-path extension: "not wedged" because Stage A
				// is ALREADY recorded durably still leaves the invoking
				// session's view potentially wedged (e.g. blocked). One bounded
				// evidence re-read; the band is re-checked on the RE-READ
				// snapshot so a concurrent rotation between scan and re-read
				// cannot apply a below-pre_check_passed view.
				if (refreshSession && isStageARecoveredState(scan.state)) {
					const snapshot = getTaskWorkflowSnapshot(
						await readTaskEvidence(directory, taskId),
					);
					if (
						snapshot.authoritative &&
						isStageARecoveredState(snapshot.state) &&
						shouldRefreshStageARecoveryView(
							refreshSession.taskWorkflowStates.get(taskId),
							snapshot.state,
						)
					) {
						applySessionWorkflowView(refreshSession, taskId, snapshot);
					}
				}
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
			const { evidence: updatedEvidence, duplicated } =
				await transitionTaskWorkflowEvidenceWithStatus(directory, taskId, {
					type: 'stage_a_passed',
					...(scan.mode === 'settlement_wedge'
						? { settlementRecovery: true as const }
						: {}),
					expectedGeneration: scan.generation,
					transitionId,
				});
			// Issue #3043: refresh the invoking session's view from the
			// transition result's OWN evidence snapshot — in both the fresh
			// and duplicated cases (durable is the authority either way; the
			// scan snapshot is never used here).
			if (refreshSession) {
				const snapshot = getTaskWorkflowSnapshot(updatedEvidence);
				if (
					isStageARecoveredState(snapshot.state) &&
					shouldRefreshStageARecoveryView(
						refreshSession.taskWorkflowStates.get(taskId),
						snapshot.state,
					)
				) {
					applySessionWorkflowView(refreshSession, taskId, snapshot);
				}
			}
			// A concurrent same-generation repair (or any writer that recorded
			// the identical transition first) makes this write a duplicate
			// no-op detected inside the evidence lock. Skip the audit append so
			// a no-op repair never logs a second `repaired` event.
			if (!duplicated) {
				await appendStageARepairEvent(directory, {
					action: 'repaired',
					taskId,
					transitionId,
					generation: scan.generation,
					...(scan.mode === 'settlement_wedge'
						? {
								settlementRecovery: true,
								// Which durable receipt admitted the repair:
								// 'settlement_wal' | 'requirements_receipt'
								// (background coder rounds never write a WAL).
								justification: scan.justification?.via ?? 'settlement_wal',
								...(scan.justification?.via === 'requirements_receipt'
									? {
											justificationTransitionId:
												scan.justification.sourceTransitionId,
											justificationGeneration: scan.justification.generation,
										}
									: {}),
							}
						: {}),
					via: 'swarm-recover',
					// Issue #2665: the new receipt names its predecessor — the
					// transition that wedged the task (the accepted_mutation that
					// left the workflow at coder_delegated without Stage A proof).
					predecessorTransitionId: scan.predecessorTransitionId,
				});
			}
			// 2026-11-25 (2.26 wedge): the repaired task re-enters the Stage-B
			// cycle — materialize the baseline route receipt (idempotent: a
			// pre-existing readable receipt is never overwritten) so the
			// cycle is route-satisfiable at completion even when no
			// dispatch-time allocator ever wrote one. Requires a session
			// identity for the receipt; the CLI's empty shape keeps the
			// pre-repair behavior.
			if (options?.sessionId) {
				await ensureRecoveryRouteReceipt({
					directory,
					taskId,
					sessionId: options.sessionId,
				});
			}
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
