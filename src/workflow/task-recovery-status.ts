/**
 * Task recovery status classification (issue #2665).
 *
 * Pure classification over facts the durable receipts already carry: the
 * coder-settlement WAL inventory (`CoderSettlementWalState`), the per-task
 * evidence workflow snapshot, and (for the wedge class) the Stage A scan.
 * This module never reads the filesystem, never writes state, and never
 * repairs anything — it is the "task/generation-specific missing explanation"
 * that connects status and repair to the same transition receipts
 * (`transitionId` + `generation`), per the issue's scope quote: add the
 * explanation, not another recovery engine.
 */

import type { TaskEvidence, TaskWorkflowSnapshot } from '../gate-evidence.js';
import { sanitizeDiagnosticText } from '../scope/path-identity.js';
import type { CoderSettlementWalState } from './coder-settlement.js';

export type TaskRecoveryCategory =
	| 'healthy'
	| 'missing'
	| 'stale'
	| 'ambiguous'
	| 'corrupt'
	| 'live_wedge';

export interface TaskRecoveryStatus {
	taskId: string;
	category: TaskRecoveryCategory;
	/** Workflow generation from the durable evidence snapshot, when one exists. */
	generation?: number;
	/** Owning transition id from the settlement WAL / evidence chain tip. */
	transitionId?: string;
	/** Deterministic repair allowed without an operator assertion? */
	repairAllowed: boolean;
	/** An external (process/provider) effect may still be in flight or unresolved. */
	uncertainExternalEffect: boolean;
	explanation: string;
	/** Host-command-path form; per-shell forms live in recovery-invocation.ts. */
	suggestedNextCommand: string;
}

function identitySuffix(status: {
	transitionId?: string;
	generation?: number;
}): string {
	const parts: string[] = [];
	if (status.transitionId)
		parts.push(`transition ${sanitizeDiagnosticText(status.transitionId)}`);
	if (typeof status.generation === 'number')
		parts.push(`generation ${status.generation}`);
	return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}

/**
 * Classify one settlement-WAL entry against the task's workflow snapshot.
 *
 * Category mapping (issue #2665 AC1 vocabulary):
 * - `unreadable` → corrupt (facts corrupt; recovery refuses, never rewrites)
 * - owned in this process / by a live foreign pid → ambiguous (external
 *   effect stays uncertain; never force a foreign owner)
 * - `DISPATCHED`/`PREPARED` with a dead owner → stale (deterministic repair)
 * - terminal → healthy
 *
 * When the WAL records an `expectedGeneration` that disagrees with the
 * workflow snapshot's generation, the stale explanation names the generation
 * conflict explicitly — the settle path's CAS already refuses stale and
 * foreign receipts; this makes that refusal visible in status.
 */
export function classifySettlementWalState(
	entry: CoderSettlementWalState,
	workflow: TaskWorkflowSnapshot | null,
): TaskRecoveryStatus {
	const base = {
		taskId: entry.taskId,
		transitionId: entry.transitionId,
		generation:
			entry.expectedGeneration ??
			(workflow && workflow.authoritative ? workflow.generation : undefined),
	};

	if (entry.state === 'unreadable') {
		return {
			...base,
			category: 'corrupt',
			repairAllowed: false,
			uncertainExternalEffect: true,
			explanation:
				'settlement WAL is corrupt (unreadable bytes) — recovery refuses corrupt facts instead of rewriting them; the task stays blocked until a human reconciles the file',
			suggestedNextCommand:
				'inspect .swarm/coder-settlements/' +
				entry.taskId +
				'.json and consult docs/troubleshooting/recovery-runbook.md — do not delete or hand-edit the file',
		};
	}

	if (entry.ownedByLiveForeignPid) {
		return {
			...base,
			category: 'ambiguous',
			repairAllowed: false,
			uncertainExternalEffect: true,
			explanation: `owned by live foreign process pid ${entry.processId ?? '?'} (another OpenCode instance) — the dispatch may genuinely be in flight, so this host never interrupts it and the external effect stays uncertain`,
			suggestedNextCommand: `close that instance (or run /swarm recover ${entry.taskId} there), then re-run diagnose here`,
		};
	}
	if (entry.ownedInProcess) {
		return {
			...base,
			category: 'ambiguous',
			repairAllowed: false,
			uncertainExternalEffect: true,
			explanation:
				'in flight, in this process — the dispatch may still complete on its own; releasing it is an operator assertion, not a status claim',
			suggestedNextCommand: `wait for the dispatch to settle, or re-run /swarm recover ${entry.taskId} --force only if no coder is genuinely running`,
		};
	}

	if (entry.state === 'DISPATCHED' || entry.state === 'PREPARED') {
		const generationConflict =
			typeof entry.expectedGeneration === 'number' &&
			workflow !== null &&
			workflow.authoritative &&
			workflow.generation !== entry.expectedGeneration;
		return {
			...base,
			category: 'stale',
			repairAllowed: true,
			uncertainExternalEffect: false,
			explanation: `${entry.state.toLowerCase()} settlement whose owning process is gone${
				generationConflict
					? ` — the WAL's generation fence (${entry.expectedGeneration}) no longer matches the workflow generation (${workflow?.generation}), so the stale receipt cannot be consumed by a normal settle and recovery is the only deterministic path`
					: ''
			} — blocks dispatches with CODER_DISPATCH_IN_PROGRESS`,
			suggestedNextCommand: `/swarm recover ${entry.taskId}`,
		};
	}

	// COMMITTED / ABORTED — terminal.
	return {
		...base,
		category: 'healthy',
		repairAllowed: false,
		uncertainExternalEffect: false,
		explanation: `settlement ${entry.state.toLowerCase()}`,
		suggestedNextCommand: '',
	};
}

/**
 * Classify a task's evidence-workflow state for recovery purposes. The
 * `live_wedge` class is the "live-shaped task wedge" of issue #2665 AC2:
 * the workflow sits at `coder_delegated` with no pre_check gate proof —
 * deterministically repairable by the Stage A repair (which never re-runs
 * the coder and never edits evidence speculatively) when green
 * post-settlement pre-check proof exists.
 */
export function classifyEvidenceRecoveryTask(
	taskId: string,
	evidence: TaskEvidence | null,
	greenPreCheck: boolean | null,
): TaskRecoveryStatus {
	const snapshot: TaskWorkflowSnapshot | null =
		evidence?.workflow !== undefined && evidence.workflow !== null
			? { ...evidence.workflow, authoritative: true }
			: null;

	if (snapshot === null) {
		return {
			taskId,
			category: 'missing',
			repairAllowed: false,
			uncertainExternalEffect: false,
			explanation:
				'no durable receipt exists for this task (no settlement WAL, no evidence workflow) — nothing to repair',
			suggestedNextCommand:
				'dispatch the task normally, then re-run diagnose; if it was dispatched, see docs/troubleshooting/recovery-runbook.md',
		};
	}

	const base = {
		taskId,
		transitionId: snapshot.lastTransitionId ?? undefined,
		generation: snapshot.generation,
	};

	if (snapshot.state === 'coder_delegated') {
		const hasPreCheckProof = evidence?.gates?.pre_check !== undefined;
		if (!hasPreCheckProof) {
			return {
				...base,
				category: 'live_wedge',
				repairAllowed: greenPreCheck === true,
				uncertainExternalEffect: false,
				explanation: `live-shaped task wedge — workflow at coder_delegated with no pre_check gate proof${
					greenPreCheck === true
						? ' and green post-settlement pre-check bundles: the missing Stage A receipt is deterministically repairable without re-running the coder or editing evidence'
						: greenPreCheck === false
							? ' but pre-check proof is missing or not green: run pre_check_batch first — the repair refuses to mark Stage A passed without proof'
							: ''
				}`,
				suggestedNextCommand: `/swarm recover ${taskId}`,
			};
		}
	}

	return {
		...base,
		category: 'healthy',
		repairAllowed: false,
		uncertainExternalEffect: false,
		explanation: `workflow ${snapshot.state}`,
		suggestedNextCommand: '',
	};
}

/**
 * One diagnose-detail line per non-healthy task. Healthy tasks are rendered
 * by their COUNT only (never a per-task line) so no category token can
 * attach to a healthy task id (plan-critic B1).
 */
export function renderTaskRecoveryLine(status: TaskRecoveryStatus): string {
	if (status.category === 'healthy') return '';
	const suffix = identitySuffix(status);
	const command = status.suggestedNextCommand
		? ` — ${status.suggestedNextCommand}`
		: '';
	return `task ${status.taskId} [${status.category}] ${status.explanation}${suffix}${command}`;
}
