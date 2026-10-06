/**
 * `/swarm epic start` orchestration (Epic v2 C1a).
 *
 * Refusals, checked in this order (the first one wins):
 *   1. epic-disabled-by-config   `epic.mode.enabled !== true` (fail closed)
 *   2. no-plan / plan-ledger-unreadable
 *   3. epic-state-unreadable, then an existing epic: the same plan ⇒
 *      `already-open` (idempotent success, not a refusal), another plan ⇒
 *      epic-open-for-other-plan
 *   4. turbo-active               config `turbo_mode: true`, any in-memory
 *                                 session with Turbo on, or a running durable
 *                                 Lean run (read without migrating Lean state)
 *   5. dirty-baseline             git only: changes outside `.swarm/`
 *      detached-head              git + epic-branch policy: HEAD is detached
 *                                 (or the branch has no commit yet)
 *      epic-branch-exists         git + epic-branch policy:
 *                                 `swarm/epic/<epicKey>` already exists (left
 *                                 by an earlier, abandoned epic of this plan)
 *   6. in-flight-coders           project-wide (see `findInFlightCoderWork`)
 *   7. not-epic-sized             sizing verdict (`--force` overrides; recorded)
 *   8. branch-create-failed       `git checkout -b` failed after the row was
 *                                 created — row and sentinel rolled back
 *
 * Learning (Epic v2 C6, `epic.learning.enabled` not false): before
 * the sizing dry-run the Epic v1 calibration files are imported into the
 * project prior once (`learning-store.ts`); the sizing plans with the
 * prior's learned signals; the record keeps the prior's digest
 * (`priorDigest`) and, once the epic is open, the epic's posterior starts
 * as a copy of that prior.
 *
 * Commit policy (`epic.commit_policy`, default `epic-branch`): after
 * the CAS create a git epic checks out `swarm/epic/<epicKey>` and records it
 * (`git.epicBranch`) only once the checkout succeeded (M-e). Non-git
 * projects (always `current-branch`) may open an epic but run it serially
 * (maxParallel 1, M-i).
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	isTerminalDelegationStatus,
	readDelegationsDetailed,
} from '../background/pending-delegations.js';
import { loadPluginConfigWithMeta } from '../config/index.js';
import type { Plan } from '../config/plan-schema.js';
import type { PluginConfig } from '../config/schema.js';
import { listCoordinationStates } from '../db/coordination-store.js';
import { projectDbExists } from '../db/project-db.js';
import { _internals as gitBranchInternals } from '../git/branch.js';
import {
	awaitingMergeByCallID,
	standardWorktreeByCallID,
} from '../hooks/delegation-gate/worktree-isolation.js';
import { scanWorktreeProvisioningOwnersForRecovery } from '../hooks/delegation-gate/worktree-provisioning-owner.js';
import { scanWorktreeRecoveryAuthoritiesForRecovery } from '../hooks/delegation-gate/worktree-recovery-authority.js';
import {
	computePlanStructureHash,
	readPlanEpochIdentity,
} from '../plan/ledger.js';
import { loadPlanJsonOnly } from '../plan/manager.js';
import { hasActiveTurboMode, swarmState } from '../state.js';
import {
	listRecoveryRecords,
	recoveryReadErrored,
} from '../turbo/lean/recovery.js';
import * as logger from '../utils/logger.js';
import { withTimeout } from '../utils/timeout.js';
import { listCoderSettlementWalStates } from '../workflow/coder-settlement.js';
import { getCoChangeData } from './cochange-source.js';
import {
	EPIC_MODE_CONFIG_DISABLED_MESSAGE,
	isEpicModeConfigEnabled,
} from './config-gate.js';
import { resolveEpicDeclaredScopes } from './declared-scopes.js';
import {
	checkoutNewEpicBranch,
	epicBranchName,
	listDirtyPathsOutsideSwarm,
	localBranchExists,
	readCurrentBranch,
	resolveEpicCommitPolicy,
	undoEpicBranchCreate,
} from './epic-branch.js';
import {
	type EpicLearningSettings,
	resolveEpicLearningSettings,
	summarizeEpicLearning,
} from './learning.js';
import {
	type EpicPriorRead,
	importLegacyEpicCalibrationOnce,
	initEpicPosterior,
	loadEpicLearningView,
	readEpicPrior,
} from './learning-store.js';
import {
	computeEpicKey,
	createEpicRecord,
	deleteEpicState,
	type EpicRecordV1,
	inspectEpic,
	planIdentityOf,
	readLedgerRootDigest,
	recordEpicBranch,
} from './lifecycle.js';
import { isFullSha, syncEpicRefs } from './markers.js';
import { computePlanKey, PLAN_SCOPE_RESOLVE_TIMEOUT_MS } from './plan-key.js';
import {
	type EpicPlanningSignals,
	loadEpicPlanningSignals,
} from './planning-signals.js';
import { type EpicShapingReport, shapeEpicPlan } from './shaping.js';
import {
	type EpicPlanSizing,
	type EpicPlanSizingContext,
	type EpicScopeEstimate,
	epicSizingContextFor,
	epicWaveWidth,
	estimateEpicScopes,
	isDirectoryOnDisk,
	isEpicPendingStatus,
	MAX_START_SIZING_WORK,
	sizeEpicPlan,
} from './shaping-sizing.js';
import type { EpicSizingVerdict } from './sizing.js';

export type EpicStartRefusal =
	| 'epic-disabled-by-config'
	| 'host-unsupported'
	| 'no-plan'
	| 'plan-ledger-unreadable'
	| 'epic-open-for-other-plan'
	| 'epic-state-unreadable'
	| 'turbo-active'
	| 'dirty-baseline'
	| 'detached-head'
	| 'epic-branch-exists'
	| 'in-flight-coders'
	| 'not-epic-sized'
	| 'branch-create-failed';

/** What the started epic inherited from the project prior. */
export interface EpicStartLearning {
	enabled: boolean;
	prior: EpicPriorRead['status'];
	/** Learned files / co-write edges / hot files in the inherited prior. */
	files: number;
	coWrites: number;
	hotFiles: number;
	/** The one-time Epic v1 import done by this start, if any. */
	imported: { calibrationHotModules: number; divergenceRecords: number } | null;
}

export type EpicStartResult =
	| { status: 'started'; record: EpicRecordV1; learning: EpicStartLearning }
	| { status: 'already-open'; record: EpicRecordV1 }
	| {
			status: 'refused';
			reason: EpicStartRefusal;
			details: string[];
			sizing?: EpicSizingVerdict;
			/** Plan shaping advisory (`not-epic-sized` only; Epic v2 C7). */
			shaping?: EpicShapingReport;
	  };

export interface EpicStartOptions {
	directory: string;
	sessionID: string;
	force: boolean;
}

const LEAN_SESSION_NAMESPACE = 'turbo.lean.session';
const BACKGROUND_DELEGATION_NAMESPACE = 'background.pending-delegation';
const LEGACY_LEAN_STATE_FILE = 'turbo-state.json';
const MAX_LEGACY_LEAN_STATE_BYTES = 4 * 1024 * 1024;
/** Non-terminal coder settlement WAL states (same as assertNoUnsettledCoderDispatch). */
const UNSETTLED_WAL_STATES = new Set(['DISPATCHED', 'PREPARED', 'unreadable']);

/**
 * Why `/swarm epic start` refuses on a host without an OpenCode SDK client.
 * Every git-epic coder needs worktree isolation and every phase needs the
 * `epic_phase_review` dispatch, and both create sessions through that client
 * (`worktree-isolation.ts` STANDARD_WORKTREE_ISOLATION_UNAVAILABLE,
 * `src/review/contracts.ts`). The OpenCode 2 adapter initializes the plugin
 * with `client: undefined` (`src/host/v2/setup.ts`), so an epic there could
 * neither dispatch a coder nor complete a phase.
 */
export const EPIC_HOST_UNSUPPORTED_MESSAGE =
	'This OpenCode host gives the plugin no SDK client (OpenCode 2 does not yet, see docs/host/v2-hook-inventory.md). Epic needs it for worktree-isolated coders and for the epic_phase_review reviewer/critic, so an epic here could neither run its coders nor complete a phase. Run the plan in Balanced, or use an OpenCode 1.x host (1.18.29+).';

function refused(
	reason: EpicStartRefusal,
	details: string[],
	sizing?: EpicSizingVerdict,
): Extract<EpicStartResult, { status: 'refused' }> {
	return { status: 'refused', reason, details, sizing };
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Durable Lean run marked `running` — read without the migrating Lean reader. */
function findRunningLeanRun(directory: string): string | null {
	if (projectDbExists(directory)) {
		const rows = listCoordinationStates(directory, LEAN_SESSION_NAMESPACE);
		const running = rows.find((row) => row.status === 'running');
		if (running)
			return `durable Lean Turbo run for session ${running.entityKey}`;
		if (rows.length > 0) return null;
	}
	const legacyPath = path.join(directory, '.swarm', LEGACY_LEAN_STATE_FILE);
	try {
		const stat = fs.statSync(legacyPath);
		if (!stat.isFile() || stat.size > MAX_LEGACY_LEAN_STATE_BYTES) return null;
		const parsed = JSON.parse(fs.readFileSync(legacyPath, 'utf-8')) as {
			sessions?: Record<string, { status?: unknown }>;
		};
		for (const [sessionID, state] of Object.entries(parsed.sessions ?? {})) {
			if (state?.status === 'running') {
				return `durable Lean Turbo run for session ${sessionID} (.swarm/${LEGACY_LEAN_STATE_FILE})`;
			}
		}
	} catch {
		// absent / unreadable legacy projection ⇒ no evidence of a running run
	}
	return null;
}

/** Why Turbo blocks the start, or null (M-a). */
export function findTurboActivity(
	directory: string,
	config: Pick<PluginConfig, 'turbo_mode'>,
): string[] {
	const reasons: string[] = [];
	if (config.turbo_mode === true) {
		reasons.push(
			'config `turbo_mode: true` seeds Turbo into every new session — set it to false',
		);
	}
	if (_internals.hasActiveTurboMode()) {
		reasons.push(
			'a session in this process has Turbo on — run `/swarm turbo off` in it',
		);
	}
	const lean = _internals.findRunningLeanRun(directory);
	if (lean) reasons.push(`${lean} — finish it or run \`/swarm turbo off\``);
	return reasons;
}

/** Changes outside `.swarm/` (git only). Throws when git fails. */
export function findDirtyBaseline(directory: string): string[] {
	return listDirtyPathsOutsideSwarm(directory, _internals.gitExec);
}

/**
 * Project-wide in-flight coder work (MINOR 2), read-only:
 *  - tracked standard worktree dispatches / lanes awaiting merge-back
 *    (in-memory, this process);
 *  - non-terminal durable background delegations;
 *  - unsettled coder settlement WALs (DISPATCHED / PREPARED / unreadable);
 *  - preserved Lean recovery lanes, preserved/claimed worktree recovery
 *    authorities, and lanes being provisioned.
 * Uncertain stores fail closed (reported as in flight).
 */
export async function findInFlightCoderWork(
	directory: string,
): Promise<string[]> {
	const found: string[] = [];
	const dispatches = _internals.countTrackedWorktreeDispatches();
	if (dispatches > 0) {
		found.push(
			`${dispatches} worktree-isolated coder dispatch(es) running or awaiting merge-back — let them finish (\`/swarm lanes\` shows them)`,
		);
	}

	if (projectDbExists(directory)) {
		const rows = listCoordinationStates(
			directory,
			BACKGROUND_DELEGATION_NAMESPACE,
		);
		const open = rows.filter(
			(row) =>
				!isTerminalDelegationStatus(
					row.status as Parameters<typeof isTerminalDelegationStatus>[0],
				),
		);
		if (open.length > 0) {
			found.push(
				`${open.length} non-terminal background delegation(s) — let them finish`,
			);
		}
	} else {
		const outcome = _internals.readDelegationsDetailed(directory);
		if (outcome.status !== 'ok') {
			found.push(
				'background delegation state is uncertain — cannot prove no coder is running',
			);
		} else {
			const open = outcome.records.filter(
				(record) => !isTerminalDelegationStatus(record.status),
			);
			if (open.length > 0) {
				found.push(
					`${open.length} non-terminal background delegation(s) — let them finish`,
				);
			}
		}
	}

	const wal = await _internals.listCoderSettlementWalStates(directory);
	const unsettled = wal.states.filter((state) =>
		UNSETTLED_WAL_STATES.has(state.state),
	);
	// A settlement whose owner is alive (this process or a live foreign pid)
	// is a coder still running; a stale one (owner gone) or an unreadable WAL
	// would wedge that task's next dispatch — both block, with their remedy.
	const live = unsettled.filter(
		(state) =>
			state.state !== 'unreadable' &&
			(state.ownedInProcess || state.ownedByLiveForeignPid),
	);
	const stale = unsettled.filter((state) => !live.includes(state));
	const describe = (states: typeof unsettled) =>
		states
			.slice(0, 5)
			.map((state) => `${state.taskId} (${state.state})`)
			.join(', ');
	if (live.length > 0) {
		found.push(
			`${live.length} coder settlement(s) still owned by a running dispatch: ${describe(live)} — let them finish`,
		);
	}
	if (stale.length > 0) {
		found.push(
			`${stale.length} stale or unreadable coder settlement(s): ${describe(stale)} — run \`/swarm recover <taskId>\` for each (it settles WALs whose owner process is gone)`,
		);
	}
	if (wal.truncated) {
		found.push(
			'coder settlement directory exceeds the scan bound — cannot prove every settlement is final; run `/swarm recover` to settle stale WALs',
		);
	}

	const recovery = _internals.listRecoveryRecords(directory);
	if (recovery.length > 0) {
		found.push(
			`${recovery.length} preserved Lean recovery lane(s) in .swarm/recovery/ — finish them with Lean Turbo (\`/swarm turbo lean on\`, then \`/swarm turbo off\`) or discard those lanes`,
		);
	} else if (_internals.recoveryReadErrored(directory)) {
		found.push(
			'Lean recovery records in .swarm/recovery/ are unreadable — inspect and repair or remove them',
		);
	}

	const authorities =
		_internals.scanWorktreeRecoveryAuthoritiesForRecovery(directory);
	if (authorities.status === 'ok') {
		const liveLanes = authorities.authorities.filter(
			(authority) =>
				authority.status === 'preserved' || authority.status === 'claimed',
		);
		if (liveLanes.length > 0) {
			found.push(
				`${liveLanes.length} preserved/claimed worktree recovery lane(s) — inspect with \`/swarm lanes\`; merge or discard them (\`/swarm reset-session\` can purge dirty lanes)`,
			);
		}
	} else {
		found.push(
			`worktree recovery state is ${authorities.status} — inspect .swarm/worktree-merge-recovery-v2.json`,
		);
	}

	const owners =
		_internals.scanWorktreeProvisioningOwnersForRecovery(directory);
	if (owners.status === 'ok') {
		if (owners.owners.length > 0) {
			found.push(
				`${owners.owners.length} worktree lane(s) being provisioned — let the dispatch finish (\`/swarm lanes\`)`,
			);
		}
	} else {
		found.push(`worktree provisioning state is uncertain (${owners.reason})`);
	}
	return found;
}

/** The refusal detail when the sizing stopped at its work budget. */
const SIZING_ABORTED_DETAIL =
	'The plan is too large or densely coupled to size exactly within the sizing work budget: the tasks left unplanned were counted as serial steps. Run it in Balanced, or open it anyway with `/swarm epic start --force`.';

function isPending(status: string | undefined): boolean {
	return isEpicPendingStatus(status);
}

/** Sizing of the plan plus the scope estimate it used (start + shaping). */
interface StartSizing {
	plan: EpicPlanSizing;
	estimate: EpicScopeEstimate;
	context: EpicPlanSizingContext;
}

function sizeStartPlan(
	directory: string,
	plan: Plan,
	config: PluginConfig,
	maxParallel: number,
	signals: EpicPlanningSignals,
): StartSizing {
	const estimate = estimatePlanScopes(directory, plan);
	const context = epicSizingContextFor(directory, config, maxParallel, signals);
	return {
		plan: sizeEpicPlan(context, plan.phases, estimate, MAX_START_SIZING_WORK),
		estimate,
		context,
	};
}

/**
 * Sizing inputs from the plan: pending tasks, scoped tasks, and the serial
 * step count L of a dry run of the Epic component planner
 * (`components.ts`, the planner `epic_next_wave` issues waves with) over
 * every phase, under `maxParallel`, over the estimated scopes and the same
 * planning signals (learned hot files and co-writes, co-change, density
 * threshold). L = waves
 * + tasks the planner can never schedule (a dependency cycle). Cross-phase
 * dependencies count as satisfied (phases run in order). The computation
 * is `sizeEpicPlan` (`shaping-sizing.ts`), shared with plan shaping, bounded
 * by {@link MAX_START_SIZING_WORK} (beyond it the remaining tasks count as
 * serial — a pessimistic L).
 */
export function computeEpicSizing(
	directory: string,
	plan: Plan,
	config: PluginConfig,
	maxParallel: number,
	signals: EpicPlanningSignals,
): EpicSizingVerdict {
	return sizeStartPlan(directory, plan, config, maxParallel, signals).plan
		.verdict;
}

/** Estimated scopes of the plan's pending tasks (live declared, else plan). */
function estimatePlanScopes(directory: string, plan: Plan): EpicScopeEstimate {
	const pendingIds: string[] = [];
	for (const phase of plan.phases) {
		for (const task of phase.tasks ?? []) {
			if (isPending(task.status)) pendingIds.push(task.id);
		}
	}
	return estimateEpicScopes(
		plan.phases,
		_internals.resolveEpicDeclaredScopes(directory, plan, pendingIds),
	);
}

/**
 * Plan shaping for a `not-epic-sized` refusal: the start's own sizing (no
 * second baseline) and scopes, so the suggestions say how to make THIS
 * start succeed. Fails open (no suggestions).
 */
function shapeRefusedPlan(
	directory: string,
	plan: Plan,
	sizing: StartSizing,
): EpicShapingReport | undefined {
	try {
		return _internals.shapeEpicPlan({
			...sizing.context,
			phases: plan.phases,
			declared: Object.fromEntries(
				sizing.estimate.pendingIds.map((id) => [
					id,
					sizing.estimate.scopes[id],
				]),
			),
			baseline: sizing.plan,
			isDirectory: (entry) => isDirectoryOnDisk(directory, entry),
		});
	} catch (error) {
		logger.warn(
			`[epic/start] plan shaping failed (the refusal carries no suggestions): ${errorText(error)}`,
		);
		return undefined;
	}
}

/**
 * Phases already finished when the epic starts (every task completed or
 * closed, or the phase closed) are recorded complete: `epic_next_wave`
 * starts at the first unfinished phase. Later phases become complete only
 * through `phase_complete` (phases are iterations).
 */
export function initialEpicPhases(plan: Plan): EpicRecordV1['phases'] {
	const phases: EpicRecordV1['phases'] = {};
	for (const phase of plan.phases) {
		const tasks = phase.tasks ?? [];
		const finished =
			phase.status === 'closed' ||
			(tasks.length > 0 && tasks.every((task) => !isPending(task.status)));
		if (finished) {
			phases[String(phase.id)] = {
				status: 'complete',
				completeAtStart: true,
				reviewRuns: 0,
				verdicts: [],
			};
		}
	}
	return phases;
}

function readGitFacts(directory: string): EpicRecordV1['git'] {
	if (!_internals.getGitRepositoryStatus(directory).isRepo) {
		return {
			isRepo: false,
			baseCommit: null,
			originalBranch: null,
			epicBranch: null,
		};
	}
	let baseCommit: string | null = null;
	let originalBranch: string | null = null;
	try {
		baseCommit = _internals.gitExec(['rev-parse', 'HEAD'], directory).trim();
	} catch {
		baseCommit = null; // unborn branch
	}
	try {
		originalBranch = _internals
			.gitExec(['rev-parse', '--abbrev-ref', 'HEAD'], directory)
			.trim();
	} catch {
		originalBranch = null;
	}
	// `rev-parse --abbrev-ref` prints the literal `HEAD` when detached.
	if (originalBranch === 'HEAD' || originalBranch === '') originalBranch = null;
	return { isRepo: true, baseCommit, originalBranch, epicBranch: null };
}

export async function startEpic(
	options: EpicStartOptions,
): Promise<EpicStartResult> {
	const { directory, sessionID, force } = options;

	// 1. Config master gate.
	let config: PluginConfig;
	try {
		config = _internals.loadPluginConfigWithMeta(directory).config;
	} catch {
		return refused('epic-disabled-by-config', [
			EPIC_MODE_CONFIG_DISABLED_MESSAGE,
		]);
	}
	if (!isEpicModeConfigEnabled(config)) {
		return refused('epic-disabled-by-config', [
			EPIC_MODE_CONFIG_DISABLED_MESSAGE,
		]);
	}

	// 1b. Host capability: Epic dispatches coders and the phase review through
	// the OpenCode SDK client (see EPIC_HOST_UNSUPPORTED_MESSAGE).
	if (!_internals.hostProvidesClient()) {
		return refused('host-unsupported', [EPIC_HOST_UNSUPPORTED_MESSAGE]);
	}

	// 2. Plan + ledger identity.
	let plan: Plan | null;
	try {
		plan = await _internals.loadPlanJsonOnly(directory);
	} catch (error) {
		return refused('no-plan', [
			`plan could not be loaded: ${errorText(error)}`,
		]);
	}
	if (!plan) {
		return refused('no-plan', [
			'No plan found at `.swarm/plan.json` — create and approve a plan first.',
		]);
	}
	let planEpoch: string | null;
	let planIdentityHashFromLedger: string | null;
	try {
		const identity = await withTimeout(
			_internals.readPlanEpochIdentity(directory, plan),
			PLAN_SCOPE_RESOLVE_TIMEOUT_MS,
			new Error(
				`plan ledger read timed out after ${PLAN_SCOPE_RESOLVE_TIMEOUT_MS}ms`,
			),
		);
		planEpoch = identity?.planEpoch ?? null;
		planIdentityHashFromLedger = identity?.planIdentityHash ?? null;
	} catch (error) {
		return refused('plan-ledger-unreadable', [errorText(error)]);
	}
	// The epic binds to the plan ledger's root (and its epoch). Without a
	// ledger — or with a legacy ledger that has not adopted an epoch yet —
	// the next save/completion re-roots or adopts, which would orphan the
	// epic (or change its plan key) right after it opened.
	const ledgerRootDigest = readLedgerRootDigest(directory);
	if (
		planEpoch === null ||
		ledgerRootDigest === null ||
		ledgerRootDigest === 'unreadable'
	) {
		return refused('plan-ledger-unreadable', [
			ledgerRootDigest === 'unreadable'
				? 'The plan ledger (.swarm/plan-ledger.jsonl) could not be read.'
				: 'The plan has no plan ledger with a plan epoch yet.',
			'Save the plan first (save_plan) so the plan ledger exists, then retry `/swarm epic start`.',
		]);
	}
	const identity = planIdentityOf(plan);
	const planKey = computePlanKey(
		planIdentityHashFromLedger ?? identity.planIdentityHash,
		planEpoch,
	);
	const epicKey = computeEpicKey(identity.planId, planKey);

	// 3. Existing epic.
	const inspection = _internals.inspectEpic(directory, plan);
	if (inspection.unreadable) {
		return refused('epic-state-unreadable', [
			inspection.unreadable,
			'Run `/swarm epic status` to diagnose or `/swarm epic close --abandon` to repair.',
		]);
	}
	if (inspection.record) {
		const existing = inspection.record;
		if (
			existing.epicKey === epicKey &&
			existing.status === 'open' &&
			inspection.orphanReason === null
		) {
			return { status: 'already-open', record: existing };
		}
		return refused('epic-open-for-other-plan', [
			`Epic ${existing.epicKey} (plan ${existing.planId}) is ${existing.status}${inspection.orphanReason ? ` and orphaned (${inspection.orphanReason})` : ''}.`,
			'Close it first: `/swarm epic close` (or `/swarm epic close --abandon`).',
		]);
	}

	// 4. Turbo must not be active (M-a).
	let turbo: string[];
	try {
		turbo = findTurboActivity(directory, config);
	} catch (error) {
		turbo = [`Turbo state could not be verified: ${errorText(error)}`];
	}
	if (turbo.length > 0) return refused('turbo-active', turbo);

	// 5. Clean baseline (git only).
	const git = readGitFacts(directory);
	const commitPolicy = git.isRepo
		? resolveEpicCommitPolicy(config)
		: 'current-branch';
	let epicBranch: string | null = null;
	if (git.isRepo) {
		let dirty: string[];
		try {
			dirty = findDirtyBaseline(directory);
		} catch (error) {
			return refused('dirty-baseline', [
				`git status failed: ${errorText(error)}`,
			]);
		}
		if (dirty.length > 0) {
			return refused('dirty-baseline', [
				`${dirty.length} uncommitted change(s) outside .swarm/: ${dirty.slice(0, 10).join(', ')}${dirty.length > 10 ? ', …' : ''}`,
				'Commit or stash them, then retry.',
			]);
		}
		if (commitPolicy === 'epic-branch') {
			if (git.originalBranch === null || git.baseCommit === null) {
				return refused('detached-head', [
					git.baseCommit === null
						? 'The current branch has no commit yet, so there is nothing to branch the epic from.'
						: 'HEAD is detached, so there is no branch to land the epic back onto at close.',
					'Check out (or create) a branch with at least one commit, then retry — or set `epic.commit_policy: "current-branch"`.',
				]);
			}
			epicBranch = epicBranchName(epicKey);
			let exists: boolean;
			try {
				exists = _internals.localBranchExists(directory, epicBranch);
			} catch (error) {
				return refused('branch-create-failed', [
					`git could not check for the epic branch \`${epicBranch}\`: ${errorText(error)}`,
				]);
			}
			if (exists) {
				return refused('epic-branch-exists', [
					`The epic branch \`${epicBranch}\` already exists (left by an earlier epic of this plan that was abandoned or not landed).`,
					`Land or inspect what you need from it, delete it with \`git branch -D ${epicBranch}\`, then retry.`,
				]);
			}
		}
	}

	// 6. No coder work in flight anywhere in the project.
	let inFlight: string[];
	try {
		inFlight = await findInFlightCoderWork(directory);
	} catch (error) {
		inFlight = [
			`in-flight coder state could not be verified: ${errorText(error)}`,
		];
	}
	if (inFlight.length > 0) return refused('in-flight-coders', inFlight);

	// 7. Sizing.
	const maxParallel = epicWaveWidth(config, git.isRepo);
	// Learning: import Epic v1 files once, then snapshot the prior the
	// sizing (and, once open, the epic's posterior) inherits.
	const learningSettings = resolveEpicLearningSettings(config);
	let imported: EpicStartLearning['imported'] = null;
	let priorSnapshot: EpicPriorRead = { status: 'absent', digest: null };
	if (learningSettings.enabled) {
		const migration = _internals.importLegacyEpicCalibrationOnce(
			directory,
			_internals.now(),
		);
		if (migration.status === 'imported') {
			imported = {
				calibrationHotModules: migration.calibrationHotModules,
				divergenceRecords: migration.divergenceRecords,
			};
		} else if (migration.status === 'failed') {
			logger.warn(
				`[epic/start] Epic v1 calibration import failed (retried at the next start): ${migration.detail}`,
			);
		}
		priorSnapshot = _internals.readEpicPrior(directory);
	}
	const signals = await loadEpicPlanningSignals(
		directory,
		config,
		{
			loadLearningView: _internals.loadEpicLearningView,
			getCoChangeData: _internals.getCoChangeData,
			now: _internals.now,
		},
		null,
	);
	const startSizing = sizeStartPlan(
		directory,
		plan,
		config,
		maxParallel,
		signals,
	);
	const sizing = startSizing.plan.verdict;
	if (sizing.pendingTasks === 0) {
		// Nothing to run: --force cannot open an empty epic.
		return refused(
			'not-epic-sized',
			['Every task is already completed or closed — there is nothing to run.'],
			sizing,
		);
	}
	if (!sizing.epicSized && !force) {
		// Epic v2 C7: say how to reshape the plan (same scopes + signals —
		// the co-change data was just read fresh by loadEpicPlanningSignals).
		return {
			...refused(
				'not-epic-sized',
				startSizing.plan.aborted ? [SIZING_ABORTED_DETAIL] : [],
				sizing,
			),
			shaping: shapeRefusedPlan(directory, plan, startSizing),
		};
	}

	const record: EpicRecordV1 = {
		schema: 'epic-record-v1',
		epicKey,
		token: _internals.newToken(),
		planId: identity.planId,
		planIdentityHash: identity.planIdentityHash,
		planEpoch,
		planKey,
		ledgerRootDigest,
		status: 'open',
		startedAt: new Date(_internals.now()).toISOString(),
		startedBySession: sessionID,
		forced: !sizing.epicSized,
		structureHashAtStart: computePlanStructureHash(plan),
		config: {
			commitPolicy,
			isolation: git.isRepo ? 'worktree' : 'main-tree-nogit',
			maxParallel,
		},
		git,
		sizing,
		priorDigest: priorSnapshot.digest,
		waves: [],
		activeWaveSeq: null,
		tasks: {},
		phases: initialEpicPhases(plan),
		closing: null,
	};
	const created = _internals.createEpicRecord(directory, record);
	if (created.outcome !== 'created') {
		// Lost the CAS race to a concurrent start.
		const winner = _internals.inspectEpic(directory, plan).record;
		if (winner && winner.epicKey === epicKey && winner.status === 'open') {
			return { status: 'already-open', record: winner };
		}
		return refused('epic-open-for-other-plan', [
			`Another epic was opened concurrently (${created.existingKeys.join(', ')}).`,
		]);
	}
	const result =
		epicBranch === null || git.originalBranch === null
			? ({ status: 'started', record: created.record } as const)
			: switchToEpicBranch(
					directory,
					created.record,
					git.originalBranch,
					epicBranch,
				);
	if (result.status !== 'started') return result;
	writeBaseRef(directory, result.record);
	if (learningSettings.enabled) {
		try {
			_internals.initEpicPosterior(directory, result.record, priorSnapshot);
		} catch (error) {
			// The first wave close rebuilds the posterior from the prior.
			logger.warn(
				`[epic/start] learning posterior for ${result.record.epicKey} not written yet: ${errorText(error)}`,
			);
		}
	}
	return {
		...result,
		learning: describeStartLearning(learningSettings, priorSnapshot, imported),
	};
}

function describeStartLearning(
	settings: EpicLearningSettings,
	snapshot: EpicPriorRead,
	imported: EpicStartLearning['imported'],
): EpicStartLearning {
	const enabled = settings.enabled;
	if (!enabled || snapshot.status !== 'ok') {
		return {
			enabled,
			prior: snapshot.status,
			files: 0,
			coWrites: 0,
			hotFiles: 0,
			imported,
		};
	}
	const summary = summarizeEpicLearning(
		snapshot.prior.stats,
		settings.hotExcess,
		0,
	);
	return {
		enabled,
		prior: 'ok',
		files: summary.files,
		coWrites: summary.edges,
		hotFiles: summary.hotFiles.length,
		imported,
	};
}

/**
 * Epic v2 C3: `refs/swarm/epics/<epicKey>/base` → the start commit (create-
 * only; see `markers.ts`). Best-effort: the record holds the base commit and
 * the refs are re-synced from it later, so a failure only warns.
 */
function writeBaseRef(directory: string, record: EpicRecordV1): void {
	if (!record.git.isRepo || !isFullSha(record.git.baseCommit)) return;
	try {
		_internals.syncEpicRefs(directory, record);
	} catch (error) {
		logger.warn(
			`[epic/start] base ref for ${record.epicKey} not written yet: ${errorText(error)}`,
		);
	}
}

/**
 * Epic-branch policy, after the CAS create: `git checkout -b` the epic
 * branch (one attempt, no transient retry), then record it (M-e — never
 * before HEAD is verified on it). A `checkout -b` that reports failure is
 * judged by the ACTUAL state: when HEAD is on the epic branch anyway (for
 * example a post-checkout hook exited non-zero after the switch, or the
 * command timed out after switching) the start proceeds — `checkout -b`
 * from HEAD changes no files, only the ref. Otherwise, and on a record
 * failure, the start is rolled back: the branch is undone when it still
 * points at the start commit (HEAD switched back first), and the row +
 * sentinel are compare-and-deleted on this start's token.
 */
function switchToEpicBranch(
	directory: string,
	record: EpicRecordV1,
	originalBranch: string,
	epicBranch: string,
):
	| { status: 'started'; record: EpicRecordV1 }
	| Extract<EpicStartResult, { status: 'refused' }> {
	const baseCommit = record.git.baseCommit ?? '';
	const rollbackState = (): string[] => {
		try {
			_internals.deleteEpicState(directory, record.epicKey, record.token);
			return [];
		} catch (error) {
			return [
				`rolling back the epic record failed: ${errorText(error)} — run \`/swarm epic close --abandon\``,
			];
		}
	};
	let checkoutError: string | null = null;
	try {
		_internals.checkoutNewEpicBranch(directory, epicBranch);
	} catch (error) {
		checkoutError = errorText(error);
	}
	if (checkoutError !== null) {
		let current: string | null = null;
		try {
			current = _internals.readCurrentBranch(directory);
		} catch {
			current = null;
		}
		if (current !== epicBranch) {
			return refused('branch-create-failed', [
				`git checkout -b ${epicBranch} failed: ${checkoutError}`,
				..._internals.undoEpicBranchCreate(
					directory,
					originalBranch,
					epicBranch,
					baseCommit,
				),
				...rollbackState(),
				'The epic was not opened; fix the git problem and retry.',
			]);
		}
		// HEAD is on the new branch: the switch happened despite the error.
	}
	let updated: EpicRecordV1 | null = null;
	let updateError: string | null = null;
	try {
		updated = _internals.recordEpicBranch(
			directory,
			record.epicKey,
			record.token,
			epicBranch,
		);
	} catch (error) {
		updateError = errorText(error);
	}
	if (updated) return { status: 'started', record: updated };
	return refused('branch-create-failed', [
		`the epic branch \`${epicBranch}\` was created but could not be recorded${updateError ? `: ${updateError}` : ' (the epic row vanished)'}`,
		..._internals.undoEpicBranchCreate(
			directory,
			originalBranch,
			epicBranch,
			baseCommit,
		),
		...rollbackState(),
		'The epic was not opened; retry `/swarm epic start`.',
	]);
}

/**
 * DI seam (AGENTS.md invariant 7) — tests replace collaborators without
 * `mock.module`. Restore in `afterEach`.
 */
export const _internals = {
	loadPluginConfigWithMeta,
	loadPlanJsonOnly,
	readPlanEpochIdentity,
	inspectEpic,
	createEpicRecord,
	deleteEpicState,
	recordEpicBranch,
	localBranchExists,
	checkoutNewEpicBranch,
	readCurrentBranch,
	undoEpicBranchCreate,
	resolveEpicDeclaredScopes,
	loadEpicLearningView,
	readEpicPrior,
	importLegacyEpicCalibrationOnce,
	initEpicPosterior,
	getCoChangeData,
	shapeEpicPlan,
	hasActiveTurboMode: (): boolean => hasActiveTurboMode(),
	/**
	 * False only when the plugin was initialized on a host that supplies no
	 * SDK client: the v1 init stores the host client, the OpenCode 2 adapter
	 * stores `undefined`, and an uninitialized process (tests, scripts) keeps
	 * the initial `null` — which is not a host verdict, so it is allowed.
	 * Capability-based: once a v2 client is wired, Epic starts there too.
	 */
	hostProvidesClient: (): boolean => swarmState.opencodeClient !== undefined,
	findRunningLeanRun,
	gitExec: (args: string[], cwd: string): string =>
		gitBranchInternals.gitExec(args, cwd),
	getGitRepositoryStatus: (cwd: string) =>
		gitBranchInternals.getGitRepositoryStatus(cwd),
	/** In-memory worktree dispatches (lazy: the maps live in an import cycle). */
	countTrackedWorktreeDispatches: (): number =>
		standardWorktreeByCallID.size + awaitingMergeByCallID.size,
	readDelegationsDetailed,
	listCoderSettlementWalStates,
	listRecoveryRecords,
	recoveryReadErrored,
	scanWorktreeRecoveryAuthoritiesForRecovery,
	scanWorktreeProvisioningOwnersForRecovery,
	syncEpicRefs,
	now: (): number => Date.now(),
	newToken: (): string => randomUUID(),
};
