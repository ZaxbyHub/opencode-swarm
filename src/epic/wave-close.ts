/**
 * Epic v2 C2 — closing a wave.
 *
 * `epic_next_wave` closes the active wave once every task in it is resolved
 * (plan status completed / closed, or removed from the plan) and none has a
 * relevant worktree merge-back failure. Closing records, in the epic record:
 *
 *   - `closeHead` (HEAD at close — every task's work is already committed:
 *     its coder's worktree landing is a merge commit and non-coder writes
 *     are residue commits, see `task-landing.ts` / `residue-commit.ts`);
 *   - one {@link EpicTaskOutcome} per wave task: resolution and time (plan
 *     ledger), evidence workflow generation, Stage A/B failure LOWER BOUNDS
 *     (the evidence `retryHistory` keeps only its last 3 entries), the merge
 *     failure snapshot observed while the wave was blocked, reopen count
 *     (ledger transitions out of `completed`), declared (frozen) and
 *     undeclared files, and the task's commit (`marker`: its newest
 *     `swarm(task <id>):` commit for this plan inside the wave, else the
 *     close HEAD) that `markers.ts` mirrors to `refs/swarm/epics/…/tasks/<id>`;
 *   - undeclared files (divergence), computed automatically: a task's actual files are its
 *     write attribution unioned across every same-project session (coder
 *     writes are attributed on the coder's CHILD session). When no session
 *     holds attribution the git fallback applies: files changed since the
 *     wave's `baseHead` (committed or not), attributed to the task only when it was the wave's single
 *     member, and otherwise kept at WAVE level (`wave.undeclared`) minus
 *     every declared and attributed file.
 *
 * After the close is committed, the epic's learning posterior applies the
 * closed wave's outcomes once ({@link recordEpicWaveLearning},
 * `learning-store.ts`): undeclared writes teach learned co-writes and,
 * with merge conflicts, rework, Stage B failures and reopens, the decaying
 * hot set the planner uses for later waves (`components.ts`). A failed
 * update never blocks the wave flow; the next close (or the epic close)
 * catches it up from the record.
 */

import type { Plan } from '../config/plan-schema.js';
import type { PluginConfig } from '../config/schema.js';
import { readTaskEvidence as readTaskEvidence_import } from '../gate-evidence.js';
import { _internals as gitBranchInternals } from '../git/branch.js';
import { readLedgerEvents as readLedgerEvents_import } from '../plan/ledger.js';
import { hydrationProjectKey as hydrationProjectKey_import } from '../session/hydration-ownership.js';
import {
	type AgentSessionState,
	getAgentSession as getAgentSession_import,
	getModifiedFilesForTask as getModifiedFilesForTask_import,
	resetModifiedFilesForTask as resetModifiedFilesForTask_import,
	swarmState,
} from '../state.js';
import * as logger from '../utils/logger.js';
import { canonicalAttributionPath } from '../utils/path.js';
import { resolveEpicLearningSettings, undeclaredFiles } from './learning.js';
import { applyClosedWavesToPosterior as applyClosedWavesToPosterior_import } from './learning-store.js';
import type {
	EpicRecordV1,
	EpicTaskOutcome,
	EpicWaveRecord,
} from './lifecycle.js';
import {
	epicCommitRange,
	epicTaskRef,
	findTaskCommits as findTaskCommits_import,
	isFullSha,
} from './markers.js';

/** Bound on the git fallback's file list (per wave). */
const MAX_FALLBACK_FILES = 2000;
const SHA_RE = /^[0-9a-f]{7,64}$/;

/** DI seam (AGENTS.md invariant 7). Restore in `afterEach`. */
export const _internals = {
	gitExec: (args: string[], cwd: string): string =>
		gitBranchInternals.gitExec(args, cwd),
	readTaskEvidence: readTaskEvidence_import,
	readLedgerEvents: readLedgerEvents_import,
	listAgentSessions: (): Iterable<[string, AgentSessionState]> =>
		swarmState.agentSessions.entries(),
	getAgentSession: getAgentSession_import,
	getModifiedFilesForTask: getModifiedFilesForTask_import,
	resetModifiedFilesForTask: resetModifiedFilesForTask_import,
	hydrationProjectKey: hydrationProjectKey_import,
	applyClosedWavesToPosterior: applyClosedWavesToPosterior_import,
	findTaskCommits: findTaskCommits_import,
};

export interface EpicWaveCloseComputation {
	closeHead: string | null;
	outcomes: EpicTaskOutcome[];
	waveUndeclared: string[];
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function readHead(directory: string): string | null {
	try {
		const head = _internals.gitExec(['rev-parse', 'HEAD'], directory).trim();
		return SHA_RE.test(head) ? head : null;
	} catch {
		return null;
	}
}

function isSwarmPath(file: string): boolean {
	return file === '.swarm' || file.startsWith('.swarm/');
}

/**
 * Files changed since `baseHead` — committed (`git diff baseHead HEAD`) or
 * not (`git status`, untracked included) — outside `.swarm/`. Null when git
 * fails or there is no base.
 */
export function changedFilesSinceBase(
	directory: string,
	baseHead: string | null,
): string[] | null {
	if (!baseHead || !SHA_RE.test(baseHead)) return null;
	try {
		const files = new Set<string>();
		const committed = _internals.gitExec(
			['diff', '--name-only', '-z', baseHead, 'HEAD'],
			directory,
		);
		for (const file of committed.split('\0')) {
			if (file.length > 0) files.add(file.replace(/\\/g, '/'));
		}
		const status = _internals.gitExec(
			['status', '--porcelain=v1', '-z', '--untracked-files=all'],
			directory,
		);
		const records = status.split('\0');
		for (let i = 0; i < records.length; i += 1) {
			const record = records[i];
			if (record.length < 4) continue;
			const code = record.slice(0, 2);
			files.add(record.slice(3).replace(/\\/g, '/'));
			if (code.includes('R') || code.includes('C')) i += 1;
		}
		return [...files]
			.filter((file) => !isSwarmPath(file))
			.sort()
			.slice(0, MAX_FALLBACK_FILES);
	} catch (error) {
		logger.warn(
			`[epic/wave-close] git fallback for divergence unavailable: ${errorText(error)}`,
		);
		return null;
	}
}

/**
 * The task's write attribution unioned across the calling session and every
 * session owned by the same project (read-only), canonicalized
 * repo-relative. Sessions without an owning project key are never read
 * (cross-project safety), except the calling session itself.
 */
export function collectTaskAttribution(
	directory: string,
	callerSessionID: string | undefined,
	taskId: string,
): string[] {
	const collected: string[] = [];
	const add = (session: AgentSessionState | undefined): void => {
		if (!session) return;
		try {
			collected.push(..._internals.getModifiedFilesForTask(session, taskId));
		} catch {
			// one malformed session must not abort the union
		}
	};
	const caller = callerSessionID
		? _internals.getAgentSession(callerSessionID)
		: undefined;
	add(caller);
	let projectKey: string | null = null;
	try {
		projectKey = _internals.hydrationProjectKey(directory);
	} catch {
		projectKey = null;
	}
	if (projectKey !== null) {
		try {
			for (const [, session] of _internals.listAgentSessions()) {
				if (session === caller) continue;
				if (!session || !(session.modifiedFilesByTask instanceof Map)) continue;
				if (session.owningProjectKey !== projectKey) continue;
				add(session);
			}
		} catch {
			// iteration failure: keep whatever was collected
		}
	}
	const canonical = new Set<string>();
	for (const file of collected) {
		const normalized = canonicalAttributionPath(file, directory);
		if (normalized !== null) canonical.add(normalized);
	}
	return [...canonical].sort();
}

type LedgerEvents = Awaited<ReturnType<typeof readLedgerEvents_import>>;

function lastTransitionAt(
	events: LedgerEvents,
	taskId: string,
	resolution: EpicTaskOutcome['resolution'],
): string | null {
	let at: string | null = null;
	for (const event of events) {
		if (event.task_id !== taskId) continue;
		if (
			(resolution === 'removed' && event.event_type === 'task_removed') ||
			(event.event_type === 'task_status_changed' &&
				event.to_status === resolution)
		) {
			at = event.timestamp;
		}
	}
	return at;
}

function countReopens(
	events: LedgerEvents,
	taskId: string,
	sinceIso: string,
): number {
	const since = Date.parse(sinceIso);
	return events.filter(
		(event) =>
			event.task_id === taskId &&
			event.event_type === 'task_status_changed' &&
			event.from_status === 'completed' &&
			event.to_status !== 'completed' &&
			(!Number.isFinite(since) || Date.parse(event.timestamp) >= since),
	).length;
}

async function readWorkflowCounts(
	directory: string,
	taskId: string,
): Promise<{ generation: number; stageA: number; stageB: number }> {
	try {
		const evidence = await _internals.readTaskEvidence(directory, taskId);
		const workflow = evidence?.workflow;
		if (!workflow) return { generation: 0, stageA: 0, stageB: 0 };
		const history = Array.isArray(workflow.retryHistory)
			? workflow.retryHistory
			: [];
		return {
			generation: Number.isFinite(workflow.generation)
				? workflow.generation
				: 0,
			stageA: history.filter((o) => o === 'stage_a_failed').length,
			stageB: history.filter((o) => o === 'stage_b_failed').length,
		};
	} catch {
		return { generation: 0, stageA: 0, stageB: 0 };
	}
}

function resolutionOf(
	plan: Plan,
	taskId: string,
): EpicTaskOutcome['resolution'] | null {
	for (const phase of plan.phases) {
		const task = (phase.tasks ?? []).find((t) => t.id === taskId);
		if (!task) continue;
		if (task.status === 'completed') return 'completed';
		if (task.status === 'closed') return 'closed';
		return null;
	}
	return 'removed';
}

function markerFor(
	epic: EpicRecordV1,
	taskId: string,
	resolution: EpicTaskOutcome['resolution'],
	closeHead: string | null,
	taskCommits: Map<string, string>,
): EpicTaskOutcome['marker'] {
	if (resolution !== 'completed') return null;
	if (!epic.git.isRepo) return { ref: null, sha: null, provenance: 'no-git' };
	const landed = taskCommits.get(taskId);
	const sha = landed ?? closeHead;
	return {
		ref: isFullSha(sha) ? epicTaskRef(epic.epicKey, taskId) : null,
		sha,
		provenance: landed ? 'landing-commit' : 'wave-close-head',
	};
}

/**
 * Compute everything a wave close records. Reads only (git, ledger,
 * evidence, in-memory attribution); the caller CASes the result into the
 * record with {@link applyWaveClose}.
 */
export async function computeWaveClose(args: {
	directory: string;
	epic: EpicRecordV1;
	wave: EpicWaveRecord;
	plan: Plan;
	sessionID: string | undefined;
	nowIso: string;
}): Promise<EpicWaveCloseComputation> {
	const { directory, epic, wave, plan, sessionID, nowIso } = args;
	const isRepo = epic.git.isRepo;
	const closeHead = isRepo ? readHead(directory) : null;
	let events: LedgerEvents = [];
	try {
		events = await _internals.readLedgerEvents(directory);
	} catch (error) {
		logger.warn(
			`[epic/wave-close] plan ledger unreadable; outcome times fall back to now: ${errorText(error)}`,
		);
	}
	const changed = isRepo
		? changedFilesSinceBase(directory, wave.baseHead)
		: null;
	const completedIds = wave.taskIds.filter(
		(taskId) => resolutionOf(plan, taskId) === 'completed',
	);
	let taskCommits = new Map<string, string>();
	if (isRepo && closeHead && completedIds.length > 0) {
		try {
			taskCommits = _internals.findTaskCommits(
				directory,
				isFullSha(wave.baseHead)
					? `${wave.baseHead}..HEAD`
					: epicCommitRange(epic),
				epic.planKey,
				completedIds,
			);
		} catch (error) {
			logger.warn(
				`[epic/wave-close] task commit lookup failed; markers fall back to the close HEAD: ${errorText(error)}`,
			);
		}
	}

	const outcomes: EpicTaskOutcome[] = [];
	const attributedAll = new Set<string>();
	for (const taskId of wave.taskIds) {
		const resolution = resolutionOf(plan, taskId) ?? 'removed';
		const declared = [...(wave.files[taskId] ?? [])];
		const counts =
			resolution === 'removed'
				? { generation: 0, stageA: 0, stageB: 0 }
				: await readWorkflowCounts(directory, taskId);
		let undeclared: string[] = [];
		let attribution: EpicTaskOutcome['attribution'] = isRepo
			? 'unavailable'
			: 'no-git';
		if (resolution === 'completed') {
			const attributed = collectTaskAttribution(directory, sessionID, taskId);
			for (const file of attributed) attributedAll.add(file);
			let actual: string[] | null = null;
			if (attributed.length > 0) {
				actual = attributed;
				attribution = 'session';
			} else if (changed !== null && wave.taskIds.length === 1) {
				actual = changed;
				attribution = 'git-single-task';
			}
			if (actual !== null) undeclared = undeclaredFiles(declared, actual);
		}
		const snapshot = wave.mergeFailures?.[taskId];
		outcomes.push({
			taskId,
			phase: wave.phase,
			waveSeq: wave.seq,
			resolution,
			resolvedAt: lastTransitionAt(events, taskId, resolution) ?? nowIso,
			generation: counts.generation,
			stageAFailures: counts.stageA,
			stageBFailures: counts.stageB,
			mergeFailure: snapshot
				? { outcome: snapshot.outcome, stage: snapshot.stage }
				: null,
			declared,
			undeclared,
			attribution,
			reopened: countReopens(events, taskId, epic.startedAt),
			marker: markerFor(epic, taskId, resolution, closeHead, taskCommits),
		});
	}

	let waveUndeclared: string[] = [];
	if (changed !== null) {
		const declaredAll = Object.values(wave.files).flat();
		waveUndeclared = undeclaredFiles(declaredAll, changed).filter(
			(file) => !attributedAll.has(file),
		);
	}
	return { closeHead, outcomes, waveUndeclared };
}

/**
 * Pure record mutation for a wave close. Returns the record unchanged when
 * the wave is no longer the issued active wave (a concurrent close won).
 */
export function applyWaveClose(
	record: EpicRecordV1,
	seq: number,
	computation: EpicWaveCloseComputation,
	nowIso: string,
): EpicRecordV1 {
	const wave = record.waves.find((w) => w.seq === seq);
	if (!wave || wave.status !== 'issued' || record.activeWaveSeq !== seq) {
		return record;
	}
	const tasks = { ...record.tasks };
	for (const outcome of computation.outcomes) {
		// A task run again (reopened) keeps its earlier counters so learning
		// charges only the delta (`learning.ts`).
		const before = Object.hasOwn(record.tasks, outcome.taskId)
			? record.tasks[outcome.taskId]
			: undefined;
		tasks[outcome.taskId] =
			before && before.waveSeq !== outcome.waveSeq
				? {
						...outcome,
						previous: {
							waveSeq: before.waveSeq,
							generation: before.generation,
							stageBFailures: before.stageBFailures,
							reopened: before.reopened,
						},
					}
				: outcome;
	}
	return {
		...record,
		activeWaveSeq: null,
		tasks,
		waves: record.waves.map((w) =>
			w.seq === seq
				? {
						...w,
						status: 'closed' as const,
						closedAt: nowIso,
						closeHead: computation.closeHead,
						undeclared: computation.waveUndeclared,
					}
				: w,
		),
	};
}

/**
 * After a committed close (by the call that closed the wave): apply every
 * closed wave's outcomes not applied yet to the epic's learning posterior
 * (idempotent per wave seq, `learning-store.ts`) unless
 * `epic.learning.enabled` is false. Never throws: a failure is a
 * critical warning and the next update (or the epic close) catches it up.
 */
export function recordEpicWaveLearning(args: {
	directory: string;
	config: PluginConfig;
	record: EpicRecordV1;
}): number[] {
	const settings = resolveEpicLearningSettings(args.config);
	if (!settings.enabled) return [];
	try {
		return _internals.applyClosedWavesToPosterior(
			args.directory,
			args.record,
			settings,
		).appliedWaves;
	} catch (error) {
		logger.criticalWarn(
			`[epic/wave-close] learning update failed (the wave flow continues; the next wave close catches it up): ${errorText(error)}`,
		);
		return [];
	}
}

/**
 * Release the closed wave's retained write attribution (Epic retains
 * completed-task attribution until its wave closes — see
 * `completeModifiedFilesForTask`) in the calling session and in EVERY
 * session owned by the same project (coder child sessions hold it too).
 * Sessions of other projects are never touched. Best-effort.
 */
export function releaseWaveAttribution(
	directory: string,
	sessionID: string | undefined,
	taskIds: readonly string[],
): void {
	const sessions = new Set<AgentSessionState>();
	const caller = sessionID ? _internals.getAgentSession(sessionID) : undefined;
	if (caller) sessions.add(caller);
	try {
		const projectKey = _internals.hydrationProjectKey(directory);
		for (const [, session] of _internals.listAgentSessions()) {
			if (session && session.owningProjectKey === projectKey) {
				sessions.add(session);
			}
		}
	} catch {
		// keep the caller only
	}
	for (const session of sessions) {
		for (const taskId of taskIds) {
			try {
				_internals.resetModifiedFilesForTask(session, taskId, {
					remove: true,
				});
			} catch {
				// best-effort
			}
		}
	}
}
