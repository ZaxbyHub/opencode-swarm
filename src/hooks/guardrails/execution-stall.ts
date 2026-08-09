/**
 * ARCHITECT EXECUTION-STALL DETECTOR (issue #2063, workstream B5)
 *
 * Shape (ii) of the reported loop is an architect that keeps making tool calls
 * — reads, greps, bash probes — while nothing in the world changes: no
 * delegation completes, no file is written, no task status moves. The no-op
 * detector (B2) observes this but is advisory by design, because read-only
 * modes legitimately make hundreds of non-write calls. This module is the hard
 * lever, and the thing that makes it safe to be hard is the EPISODE.
 *
 * ── Episode ───────────────────────────────────────────────────────────────
 * An episode ARMS when the session actually attempts execution work:
 *   (a) a `Task` dispatch to a mutating/verifying role is ATTEMPTED — counted
 *       on the ATTEMPT, in `tool.execute.before`, so a dispatch that a LATER
 *       gate denies (the motivating `ACCEPTANCE_FIELD_REQUIRED` loop) still
 *       arms the episode. Guardrails' toolBefore runs at `src/index.ts:2710`,
 *       the delegation gate at `:2719`, so ordering guarantees this; or
 *   (b) `update_task_status(..., in_progress)` succeeds.
 *
 * An episode DISARMS on either of two conditions:
 *
 *   (1) IDLENESS, not elapsed time since arming: `execution_stall_episode_minutes`
 *       with NO TOOL CALLS AT ALL. This distinction is the whole point (critic
 *       round-3 fix 1). Keying the lapse to arming time would let an hour-long
 *       slow stall time out and reset before it ever reached the hard rung;
 *       keying it to idleness means continuous non-progress activity KEEPS the
 *       episode armed and the counter climbing, while a genuinely abandoned
 *       episode ages out.
 *
 *   (2) NO OPEN TASK: the plan carries no task with status `in_progress`
 *       (reviewer round-4 fix, REQUIRED 1). Idleness alone was not enough: a
 *       CONTINUOUSLY-ACTIVE architect that finishes its execution phase with a
 *       final `update_task_status(..., completed)` and then flows into commit /
 *       CI / reporting work never goes idle, so it kept accumulating
 *       non-progress `bash`/`read` calls with no reachable progress event and
 *       was hard-denied at 60 while doing exactly the right thing. This
 *       condition is the symmetric counterpart of arming path (b): an episode
 *       that arms when a task opens must end when no task is open.
 *
 * Lapse (1) is evaluated LAZILY on the next observed tool call. There are no
 * timers — invariant 1 forbids background work on the plugin, and a timer
 * would keep the process alive. The observable consequence: an episode that
 * went idle stays nominally armed until one more tool call arrives, at which
 * point it disarms BEFORE that call is counted.
 *
 * Disarm (2) is evaluated at two places, both in `tool.execute.after`:
 *   - immediately after a successful `update_task_status` to a NON-`in_progress`
 *     status (the in-band signal — `plan.json` is current there, because
 *     `plan/manager.savePlan` writes the projection as its LAST step
 *     (`src/plan/manager.ts:215` documents this) and `updateTaskStatus` awaits
 *     it (`:2144`) before `executeUpdateTaskStatus` builds the `success: true`
 *     payload (`src/tools/update-task-status.ts:1329`) this hook reads); and
 *   - inside the periodic workspace probe, so an OUT-OF-BAND plan change (the
 *     plan file edited directly, a sub-agent path that settles the last task)
 *     eventually disarms too. The probe already does I/O once per
 *     WORKSPACE_PROBE_EVERY_CALLS calls, so the extra read is bounded.
 *
 * DEVIATION (deliberate): a MISSING, unreadable, or malformed `plan.json`
 * answers `'unknown'`, and `'unknown'` does NOT disarm. Read literally, "no
 * task with status in_progress" is also true of a plan that does not exist —
 * but a session with no plan cannot be "finishing its execution phase", and
 * treating an unreadable plan as a disarm would silently delete the lever for
 * every plan-less architect loop. Only POSITIVE evidence (a parsed plan whose
 * tasks are all non-`in_progress`) disarms.
 *
 * ── Progress ──────────────────────────────────────────────────────────────
 * A progress event resets the counter and clears any active denial rung, but
 * KEEPS the episode armed:
 *   - successful completion of a `Task` dispatch to a mutating/verifying role.
 *     Read-only roles (`explorer`, `sme`) deliberately do NOT count: otherwise
 *     "delegate the spelunking" is a trivial escape from the whole lever.
 *   - any file-write tool success (same `WRITE_TOOL_NAMES` set as B2).
 *   - `update_task_status` success, ANY status.
 *   - a periodic workspace-diff probe showing new changes.
 *
 * ── Ladder ────────────────────────────────────────────────────────────────
 *   `execution_stall_warn_calls`  (default 30) → strong advisory, once/streak.
 *   `execution_stall_stop_calls`  (default 60) → HARD DENY of non-productive
 *      tools ONLY (read/glob/grep/bash/shell). `Task`, `update_task_status`,
 *      and every plan/status/query/swarm tool stay open BY CONSTRUCTION: the
 *      deny set is a closed allowlist of denied names, not an exclusion list.
 *
 * ── Scope ─────────────────────────────────────────────────────────────────
 * Architect sessions only. A subagent has a real budget window and the
 * existing circuit breaker; this lever exists for the session that is exempt
 * from both. Determined the same way every other guardrail does it
 * (`swarmState.activeAgent` → `stripKnownSwarmPrefix` → `ORCHESTRATOR_NAME`),
 * falling back to the session's own `agentName`.
 *
 * Denials are thrown from the fail-closed chain, so they flow through the B1
 * gate-denial tracker: an architect that keeps retrying the denied read
 * escalates to the STOP directive.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BackgroundWorkspaceSnapshot } from '../../background/pending-delegations.js';
import {
	captureWorkspaceSnapshot,
	changedFilesSinceSnapshot,
} from '../../background/workspace-snapshot.js';
import { ORCHESTRATOR_NAME, WRITE_TOOL_NAMES } from '../../config/constants';
import {
	getCanonicalAgentRole,
	isKnownCanonicalRole,
	stripKnownSwarmPrefix,
} from '../../config/schema';
import { ensureAgentSession, swarmState } from '../../state';
import { telemetry } from '../../telemetry.js';
import { pushAdvisory } from '../../utils/advisory-queue';
import { normalizeToolNameLowerCase } from '../normalize-tool-name';
import { classifyTaskResult } from '../task-result-classifier';
import { setExecutionEpisodeArmed } from './execution-episode';

/** Default advisory rung (mirrors `guardrails.execution_stall_warn_calls`). */
export const DEFAULT_EXECUTION_STALL_WARN_CALLS = 30;

/** Default hard rung (mirrors `guardrails.execution_stall_stop_calls`). */
export const DEFAULT_EXECUTION_STALL_STOP_CALLS = 60;

/** Default idleness lapse (mirrors `guardrails.execution_stall_episode_minutes`). */
export const DEFAULT_EXECUTION_STALL_EPISODE_MINUTES = 30;

/**
 * Canonical roles whose dispatch arms an episode and whose COMPLETION counts as
 * progress.
 *
 * `security_reviewer` is the `qa-gate-pipeline.ts` id for the security review
 * lane. It is not itself a member of `ALL_AGENT_NAMES`, so the canonicalizer
 * resolves `security_reviewer` / `security-reviewer` to `reviewer` via its
 * longest-suffix scan — which is already in this set. The explicit entry is
 * kept so the set reads as the spec states it and so a future promotion of
 * `security_reviewer` to a canonical role needs no change here.
 */
export const MUTATING_DELEGATION_ROLES: ReadonlySet<string> = new Set([
	'coder',
	'reviewer',
	'test_engineer',
	'security_reviewer',
]);

/**
 * The ONLY tools the hard rung denies.
 *
 * A closed allowlist of DENIED names — never an exclusion list — so a tool that
 * did not exist when this was written can never accidentally become deniable.
 * `shell` accompanies `bash` for the same reason as in `internals-guard.ts`:
 * `tool-before.ts` treats the pair as one tool everywhere else.
 */
export const EXECUTION_STALL_DENIED_TOOLS: ReadonlySet<string> = new Set([
	'read',
	'glob',
	'grep',
	'bash',
	'shell',
]);

/** Tool calls between workspace-diff probes. Bounds the git subprocess cost. */
const WORKSPACE_PROBE_EVERY_CALLS = 10;

/**
 * Bound on tracked sessions (invariant 8). Same order as the no-op detector's
 * `MAX_TRACKED_NO_OP_SESSIONS`.
 */
export const MAX_TRACKED_STALL_SESSIONS = 200;

/** Bound on remembered dispatch roles, keyed by callID. */
const MAX_PENDING_DISPATCH_ROLES = 256;

interface ExecutionStallState {
	armed: boolean;
	/** Non-progress tool calls since the last progress event. Armed only. */
	nonProgressCalls: number;
	/** Wall clock of the last observed tool call; drives the idleness lapse. */
	lastToolCallAt: number;
	/** Advisory rung latch — one advisory per non-progress streak. */
	warnIssued: boolean;
	/** Hard-rung telemetry latch — one event per non-progress streak. */
	denyTelemetryIssued: boolean;
	/** Baseline for the workspace-diff probe; null until first captured. */
	workspaceBaseline: BackgroundWorkspaceSnapshot | null;
	/** Set on arm; the baseline is captured on the next `toolAfter`. */
	needsWorkspaceBaseline: boolean;
	/** Calls counted since the last workspace probe. */
	callsSinceWorkspaceProbe: number;
}

const stallStates = new Map<string, ExecutionStallState>();

/**
 * callID → canonical role of the `Task` dispatch observed in `toolBefore`.
 *
 * This exists because `setStoredInputArgs` sits BELOW `if (!resolved) return;`
 * in `tool-before.ts`, and the architect is exactly the `resolved === null`
 * case. So for the session this lever targets, `getStoredInputArgs(callID)` is
 * always empty in `toolAfter` and the SDK's `toolAfter` input carries no
 * `args`. Recording the role at dispatch time is what makes "a coder
 * completion resets the counter, an explorer completion does not" observable
 * at all — without it, EVERY completion would look role-less and the hard rung
 * could fire on a session that is legitimately delegating.
 */
const pendingDispatchRoles = new Map<string, string>();

function newState(now: number): ExecutionStallState {
	return {
		armed: false,
		nonProgressCalls: 0,
		lastToolCallAt: now,
		warnIssued: false,
		denyTelemetryIssued: false,
		workspaceBaseline: null,
		needsWorkspaceBaseline: false,
		callsSinceWorkspaceProbe: 0,
	};
}

/**
 * Fetch-or-create with least-recently-touched eviction. `delete` before `set`
 * is load-bearing for exactly the reason documented on the no-op detector's
 * `touchNoOpSession`: plain insertion order would make the architect — the
 * first session in the process and the only one this lever watches — the
 * permanent first eviction victim.
 */
function touchState(sessionID: string, now: number): ExecutionStallState {
	const existing = stallStates.get(sessionID);
	const state = existing ?? newState(now);
	stallStates.delete(sessionID);
	stallStates.set(sessionID, state);
	while (stallStates.size > MAX_TRACKED_STALL_SESSIONS) {
		const stalest = stallStates.keys().next().value;
		if (stalest === undefined || stalest === sessionID) break;
		stallStates.delete(stalest);
	}
	return state;
}

/** Reset the non-progress streak while KEEPING the episode armed. */
function clearStreak(state: ExecutionStallState): void {
	state.nonProgressCalls = 0;
	state.warnIssued = false;
	state.denyTelemetryIssued = false;
	state.callsSinceWorkspaceProbe = 0;
}

/** Full episode reset. Used by the idleness lapse. */
function disarmEpisode(sessionID: string, state: ExecutionStallState): void {
	state.armed = false;
	state.workspaceBaseline = null;
	state.needsWorkspaceBaseline = false;
	clearStreak(state);
	setExecutionEpisodeArmed(sessionID, false);
}

function armEpisode(sessionID: string, state: ExecutionStallState): void {
	if (!state.armed) {
		state.armed = true;
		state.needsWorkspaceBaseline = true;
		clearStreak(state);
	}
	// Idempotent: re-arming an already-armed episode must NOT reset the counter
	// (a repeated denied dispatch is not progress), but it must keep the shared
	// `executionEpisodeArmed` field true for B3's consumer.
	_internals.ensureArchitectSession(sessionID);
	setExecutionEpisodeArmed(sessionID, true);
}

/**
 * True when `sessionID` is the architect session.
 *
 * Matches the convention in `messages-transform.ts:302-307` and
 * `tool-before.ts:1838-1850`: `activeAgent` wins, the session's own `agentName`
 * is the fallback, and an unknown session is NOT the architect (fail open — a
 * lever that cannot identify its subject stays silent).
 */
export function isArchitectStallSession(sessionID: string): boolean {
	const activeAgent = swarmState.activeAgent.get(sessionID);
	if (activeAgent) {
		return stripKnownSwarmPrefix(activeAgent) === ORCHESTRATOR_NAME;
	}
	const session = swarmState.agentSessions.get(sessionID);
	if (session) {
		return stripKnownSwarmPrefix(session.agentName) === ORCHESTRATOR_NAME;
	}
	return false;
}

/**
 * Materialize the architect's `agentSessions` entry.
 *
 * DEVIATION, recorded deliberately: `execution-episode.ts` documents that its
 * setter no-ops for an unknown session so a containment lever cannot
 * materialize session state as a side effect. But the architect legitimately
 * has NO `agentSessions` entry when guardrails' `toolBefore` runs —
 * `resolveSessionAndWindow` returns `null` for it before ever calling
 * `ensureAgentSession` (`tool-before.ts:1842`), and `src/index.ts` only ensures
 * one later in the chain (`:2804`, `:2877`) and conditionally. Without this,
 * arming would silently write nothing, B3's consumer would never fire, and
 * `pushAdvisory` would have no queue — i.e. the producer would be unwired.
 *
 * The agent name is passed ONLY when creating a new entry. Passing it to an
 * existing session triggers `ensureAgentSession`'s rename path
 * (`telemetry.agentActivated`, `delegationActive = false`, circuit reset),
 * which this lever must never cause.
 */
function ensureArchitectSession(sessionID: string): void {
	try {
		if (swarmState.agentSessions.has(sessionID)) return;
		const agentName =
			swarmState.activeAgent.get(sessionID) ?? ORCHESTRATOR_NAME;
		ensureAgentSession(sessionID, agentName);
	} catch {
		/* best effort: never convert a bookkeeping failure into a hook failure */
	}
}

/**
 * Canonical role of a `Task` dispatch, or `null` when the call is not a
 * delegation. Uses the canonical resolver rather than string literals so
 * prefixed names (`mega_coder`) and hyphenated aliases resolve correctly.
 */
export function canonicalDispatchRole(
	tool: string,
	args: unknown,
): string | null {
	const normalized = normalizeToolNameLowerCase(tool ?? '');
	if (normalized !== 'task') return null;
	const subagentType = (args as Record<string, unknown> | undefined)
		?.subagent_type;
	if (typeof subagentType !== 'string' || subagentType.length === 0) {
		return null;
	}
	const stripped = stripKnownSwarmPrefix(subagentType).toLowerCase();
	if (isKnownCanonicalRole(stripped)) return stripped;
	const resolved = getCanonicalAgentRole(subagentType).toLowerCase();
	if (isKnownCanonicalRole(resolved)) return resolved;
	// Not a role the plugin knows. Return the raw lowercase form so the
	// explicit `security_reviewer` entry in MUTATING_DELEGATION_ROLES can still
	// match a future non-canonical id.
	return subagentType.toLowerCase();
}

function rememberDispatchRole(callID: string, role: string): void {
	if (!callID) return;
	pendingDispatchRoles.delete(callID);
	pendingDispatchRoles.set(callID, role);
	while (pendingDispatchRoles.size > MAX_PENDING_DISPATCH_ROLES) {
		const oldest = pendingDispatchRoles.keys().next().value;
		if (oldest === undefined) break;
		pendingDispatchRoles.delete(oldest);
	}
}

function takeDispatchRole(callID: string): string | null {
	if (!callID) return null;
	const role = pendingDispatchRoles.get(callID);
	if (role === undefined) return null;
	pendingDispatchRoles.delete(callID);
	return role;
}

/**
 * Tri-state answer to "does the plan still carry an OPEN (`in_progress`) task?".
 *
 * `'unknown'` is NOT a synonym for `'none'` — see the DEVIATION note in the
 * module header. Only `'none'` disarms an episode.
 */
export type PlanOpenTaskState = 'open' | 'none' | 'unknown';

/**
 * Read `.swarm/plan.json` and report whether any task is still `in_progress`.
 *
 * Reads the PROJECTION rather than replaying the ledger, matching the existing
 * cheap in-hook predicates (`delegation-gate.ts:2046`,
 * `context-capsule-inject.ts:86`): this is a containment predicate, not a plan
 * mutation, and invariant 5 only forbids *writing* outside the ledger path.
 * Synchronous and never throws — the callers are inside a `tool.execute.after`
 * hook that must not become a failure surface.
 */
export function readPlanOpenTaskState(directory: string): PlanOpenTaskState {
	try {
		if (typeof directory !== 'string' || directory.trim().length === 0) {
			return 'unknown';
		}
		const raw = fs.readFileSync(
			path.join(directory, '.swarm', 'plan.json'),
			'utf-8',
		);
		const plan = JSON.parse(raw) as {
			phases?: Array<{ tasks?: Array<{ status?: unknown }> }>;
		};
		if (!Array.isArray(plan?.phases)) return 'unknown';
		for (const phase of plan.phases) {
			if (!Array.isArray(phase?.tasks)) continue;
			for (const task of phase.tasks) {
				if (task?.status === 'in_progress') return 'open';
			}
		}
		return 'none';
	} catch {
		// Missing plan, unreadable file, malformed JSON: no positive evidence.
		return 'unknown';
	}
}

function isWriteToolName(normalizedTool: string): boolean {
	return (WRITE_TOOL_NAMES as readonly string[]).includes(normalizedTool);
}

function positiveInt(value: number | undefined, fallback: number): number {
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
		return fallback;
	}
	return Math.floor(value);
}

export interface ExecutionStallOptions {
	/**
	 * `guardrails.enabled`. Mirrors `GateDenialOptions.enabled` (B1): when a
	 * user turns guardrails off, this lever must be fully inert — no arming, no
	 * counting, no advisory, no denial.
	 */
	enabled?: boolean;
	/** `guardrails.execution_stall_warn_calls` */
	warnCalls?: number;
	/** `guardrails.execution_stall_stop_calls` */
	stopCalls?: number;
	/** `guardrails.execution_stall_episode_minutes` */
	episodeMinutes?: number;
}

/**
 * The advisory text at the warn rung. Exported so tests pin the wording.
 */
export function executionStallAdvisoryText(count: number): string {
	return `EXECUTION STALL: ${count} tool calls with no delegation completion, no file changes, and no status update. STOP investigating; delegate the work or report BLOCKED to the user.`;
}

/**
 * The denial text at the hard rung. Leading token is the `EXECUTION_STALL`
 * code that B1's `deriveGateDenialCode` keys its streak on.
 */
export function executionStallDenialText(
	count: number,
	normalizedTool: string,
): string {
	return (
		`EXECUTION_STALL: ${count} tool calls in this execution episode with no delegation completion, ` +
		`no file changes, and no task-status update. Direct investigation with \`${normalizedTool}\` is blocked. ` +
		'Productive avenues remain OPEN and are the way out: DELEGATE the work or the verification with ' +
		'`Task` (coder / reviewer / test_engineer) — a completed dispatch clears this block and is how you ' +
		'run builds and tests from here — or call `update_task_status`, or report the blocker to the user ' +
		'with what you have already tried. Do NOT retry this call.'
	);
}

/**
 * `tool.execute.before`, EARLY (before any guardrails gate can throw).
 *
 * Pure bookkeeping: lapse evaluation, episode arming, non-progress counting,
 * and the advisory rung. NEVER throws — the denial is a separate call
 * ({@link enforceExecutionStallDenial}) placed in the handler tail so the
 * circuit-breaker accounting in `tool-before.ts` still runs for a denied call,
 * exactly as C3 required for the PRM hard stop.
 */
export function observeExecutionStallToolCall(params: {
	sessionID: string;
	tool: string;
	args: unknown;
	callID: string;
	options?: ExecutionStallOptions;
}): void {
	const { sessionID, tool, args, callID, options } = params;
	try {
		if (options?.enabled === false) return;
		if (!isArchitectStallSession(sessionID)) return;

		const now = _internals.now();
		const state = touchState(sessionID, now);

		// (1) LAPSE — evaluated BEFORE `lastToolCallAt` is refreshed, otherwise
		// the idle gap is always zero and the episode could never disarm.
		const episodeMs =
			positiveInt(
				options?.episodeMinutes,
				DEFAULT_EXECUTION_STALL_EPISODE_MINUTES,
			) * 60_000;
		if (state.armed && now - state.lastToolCallAt >= episodeMs) {
			disarmEpisode(sessionID, state);
		}
		state.lastToolCallAt = now;

		// (2) ARM on an ATTEMPTED dispatch to a mutating/verifying role. The role
		// is remembered for EVERY dispatch (including read-only ones) so
		// `toolAfter` can tell a coder completion from an explorer completion.
		const role = canonicalDispatchRole(tool, args);
		if (role) {
			rememberDispatchRole(callID, role);
			if (MUTATING_DELEGATION_ROLES.has(role)) armEpisode(sessionID, state);
		}

		if (!state.armed) return;

		// (3) COUNT. Every call while armed is non-progress until `toolAfter`
		// proves otherwise; a successful dispatch/write/status update resets the
		// streak there, so the net effect of a productive call is zero.
		state.nonProgressCalls += 1;
		state.callsSinceWorkspaceProbe += 1;

		const warnCalls = positiveInt(
			options?.warnCalls,
			DEFAULT_EXECUTION_STALL_WARN_CALLS,
		);
		if (state.nonProgressCalls >= warnCalls && !state.warnIssued) {
			state.warnIssued = true;
			const session = swarmState.agentSessions.get(sessionID);
			if (session) {
				pushAdvisory(
					session,
					executionStallAdvisoryText(state.nonProgressCalls),
				);
			}
			telemetry.executionStallWarning(
				sessionID,
				state.nonProgressCalls,
				warnCalls,
			);
		}
	} catch {
		/* bookkeeping must never break the hook chain */
	}
}

/**
 * `tool.execute.before`, TAIL. Throws `EXECUTION_STALL: …` when the hard rung
 * is active and the tool is one of the non-productive five.
 *
 * Placed above `if (!resolved) return;` in `tool-before.ts` for the same reason
 * the PRM hard stop is: the architect IS the `resolved === null` case, so a
 * denial below that early return would not exist for the only session this
 * lever targets.
 */
export function enforceExecutionStallDenial(params: {
	sessionID: string;
	tool: string;
	options?: ExecutionStallOptions;
}): void {
	const { sessionID, tool, options } = params;
	let denial: string | null = null;
	try {
		if (options?.enabled === false) return;
		const state = stallStates.get(sessionID);
		if (!state?.armed) return;
		if (!isArchitectStallSession(sessionID)) return;

		const stopCalls = positiveInt(
			options?.stopCalls,
			DEFAULT_EXECUTION_STALL_STOP_CALLS,
		);
		if (state.nonProgressCalls < stopCalls) return;

		const normalizedTool = normalizeToolNameLowerCase(tool ?? '');
		if (!EXECUTION_STALL_DENIED_TOOLS.has(normalizedTool)) return;

		if (!state.denyTelemetryIssued) {
			state.denyTelemetryIssued = true;
			try {
				telemetry.executionStallDenied(
					sessionID,
					normalizedTool,
					state.nonProgressCalls,
					stopCalls,
				);
			} catch {
				/* telemetry is fire-and-forget */
			}
		}
		denial = executionStallDenialText(state.nonProgressCalls, normalizedTool);
	} catch {
		// A detector failure must never invent a denial. Fail open.
		return;
	}
	if (denial) throw new Error(denial);
}

/**
 * One workspace-diff probe. Returns whether new changes appeared and the
 * snapshot that becomes the NEXT baseline.
 *
 * Re-baselining on every probe is required for correctness: without it, a
 * single change made at call 5 would keep reading as "progress" at every later
 * probe and the hard rung could never be reached in a workspace that is dirty
 * at all.
 *
 * `changedFilesSinceSnapshot` is the authoritative signal when it can answer,
 * but it returns `null` whenever the baseline was DIRTY
 * (`workspace-snapshot.ts:1259`) — which is the common case for a real stalled
 * session. It returns that `null` WITHOUT spawning git, so the fallback below
 * costs exactly one `git status` on the common path and two only when the
 * baseline was clean.
 */
function probeWorkspaceProgress(
	directory: string,
	baseline: BackgroundWorkspaceSnapshot | null,
): { progress: boolean; next: BackgroundWorkspaceSnapshot | null } {
	try {
		const authoritative = baseline
			? _internals.changedFilesSinceSnapshot(directory, baseline)
			: null;
		const current = _internals.captureWorkspaceSnapshot(directory);
		if (!baseline) return { progress: false, next: current };
		if (authoritative !== null) {
			return { progress: authoritative.length > 0, next: current };
		}
		// Dirty-baseline fallback: a moved HEAD means commits landed; a changed
		// path absent from the baseline set means new edits landed.
		if (
			baseline.gitHead &&
			current?.gitHead &&
			baseline.gitHead !== current.gitHead
		) {
			return { progress: true, next: current };
		}
		const before = new Set(baseline.changedFiles ?? []);
		const progress = (current?.changedFiles ?? []).some(
			(entry) => !before.has(entry),
		);
		return { progress, next: current };
	} catch {
		// Git unavailable / not a repo / timeout: no signal, keep the baseline.
		return { progress: false, next: baseline };
	}
}

/**
 * `tool.execute.after`. Records progress events, arms on a successful
 * `update_task_status(in_progress)`, and runs the periodic workspace probe.
 * NEVER throws.
 */
export function recordExecutionStallToolAfter(params: {
	sessionID: string;
	tool: string;
	callID: string;
	args?: Record<string, unknown>;
	output: unknown;
	directory: string;
	options?: ExecutionStallOptions;
}): void {
	const { sessionID, tool, callID, args, output, directory, options } = params;
	try {
		// The dispatch-role note is keyed by callID and must be released even
		// when this lever is otherwise inert, or the map leaks.
		const dispatchRole = takeDispatchRole(callID);
		if (options?.enabled === false) return;
		if (!isArchitectStallSession(sessionID)) return;

		const normalizedTool = normalizeToolNameLowerCase(tool ?? '');
		const succeeded = classifyTaskResult(output) === 'success';

		let progress = false;
		let armOnStatus = false;
		/**
		 * A successful status update that SETTLED a task (anything other than
		 * `in_progress`). This is the in-band trigger for disarm condition (2) —
		 * the moment the plan can have gone from "has an open task" to "has none".
		 */
		let taskSettled = false;

		if (normalizedTool === 'update_task_status') {
			const status = readUpdateTaskStatusOutcome(output, args);
			if (status.ok) {
				progress = true;
				armOnStatus = status.value === 'in_progress';
				taskSettled = !armOnStatus;
			}
		} else if (dispatchRole !== null) {
			progress = succeeded && MUTATING_DELEGATION_ROLES.has(dispatchRole);
		} else if (isWriteToolName(normalizedTool)) {
			progress = succeeded;
		}

		const now = _internals.now();
		const existing = stallStates.get(sessionID);
		if (!existing && !armOnStatus) return;
		const state = existing ?? touchState(sessionID, now);

		if (armOnStatus) armEpisode(sessionID, state);
		if (!state.armed) return;

		// (2) DISARM ON NO OPEN TASK — in-band edge. MUST sit above the `progress`
		// branch below: a settling status update is ALSO a progress event, and
		// that branch returns, so a check placed after it would never run.
		if (taskSettled && _internals.readPlanOpenTaskState(directory) === 'none') {
			disarmEpisode(sessionID, state);
			return;
		}

		if (progress) {
			clearStreak(state);
			// A progress event invalidates the old baseline: re-capture on the
			// next probe so later probes measure change since HERE.
			state.needsWorkspaceBaseline = true;
			return;
		}

		// Periodic workspace probe. Bounded to one git subprocess per
		// WORKSPACE_PROBE_EVERY_CALLS non-progress calls, and only while armed.
		if (state.needsWorkspaceBaseline) {
			state.needsWorkspaceBaseline = false;
			state.callsSinceWorkspaceProbe = 0;
			try {
				state.workspaceBaseline =
					_internals.captureWorkspaceSnapshot(directory);
			} catch {
				state.workspaceBaseline = null;
			}
			return;
		}
		if (state.callsSinceWorkspaceProbe < WORKSPACE_PROBE_EVERY_CALLS) return;
		state.callsSinceWorkspaceProbe = 0;
		// (2) DISARM ON NO OPEN TASK — out-of-band edge. The in-band check above
		// only sees status changes this session made through `update_task_status`;
		// a directly-edited plan file or a settlement on another path would leave
		// the episode armed forever. Piggy-backing on the probe keeps the cost
		// bounded to one extra small read per WORKSPACE_PROBE_EVERY_CALLS calls,
		// alongside the git subprocess the probe already pays for.
		if (_internals.readPlanOpenTaskState(directory) === 'none') {
			disarmEpisode(sessionID, state);
			return;
		}
		const probe = probeWorkspaceProgress(directory, state.workspaceBaseline);
		state.workspaceBaseline = probe.next;
		if (probe.progress) clearStreak(state);
	} catch {
		/* observational only */
	}
}

/**
 * Read whether an `update_task_status` call actually succeeded, and to which
 * status. The tool returns a JSON string carrying `success` and `new_status`
 * (`src/tools/update-task-status.ts:1384`); the requested status from the input
 * args is the fallback when the projection omits `new_status`.
 *
 * A non-JSON or `success: false` payload is NOT progress — a status update the
 * gate refused must not clear a stall streak.
 */
function readUpdateTaskStatusOutcome(
	output: unknown,
	args: Record<string, unknown> | undefined,
): { ok: boolean; value: string | null } {
	const text =
		output && typeof output === 'object'
			? (output as { output?: unknown }).output
			: undefined;
	if (typeof text !== 'string') return { ok: false, value: null };
	try {
		const parsed = JSON.parse(text) as {
			success?: unknown;
			new_status?: unknown;
		};
		if (parsed?.success !== true) return { ok: false, value: null };
		const fromOutput =
			typeof parsed.new_status === 'string' ? parsed.new_status : null;
		// Load-bearing dependency note: for architect sessions the stored-args
		// snapshot is only populated when knowledge_application is enabled (the
		// guardrails-owned snapshot site sits behind the null-window early return),
		// so in practice this fallback may be absent and arming clause (b) rests on
		// `new_status` from update-task-status's success payload. If that field is
		// ever dropped upstream, clause-(b) arming dies silently — keep `new_status`
		// emission in src/tools/update-task-status.ts or add a negative test here.
		const fromArgs = typeof args?.status === 'string' ? args.status : null;
		return { ok: true, value: (fromOutput ?? fromArgs)?.toLowerCase() ?? null };
	} catch {
		return { ok: false, value: null };
	}
}

/**
 * Test/DI seam (AGENTS.md invariant 7). `now` is the fake-clock seam the
 * idleness-lapse tests drive; the two workspace functions are indirected so a
 * test never spawns git, and `readPlanOpenTaskState` so a test can drive the
 * disarm edge without a plan fixture (the disarm tests exercise the REAL reader
 * against a real `.swarm/plan.json` as well).
 */
export const _internals = {
	now: (): number => Date.now(),
	captureWorkspaceSnapshot,
	changedFilesSinceSnapshot,
	ensureArchitectSession,
	readPlanOpenTaskState,
};

export const _test_exports = {
	WORKSPACE_PROBE_EVERY_CALLS,
	stateCount: (): number => stallStates.size,
	peekState: (sessionID: string): Readonly<ExecutionStallState> | undefined =>
		stallStates.get(sessionID),
	pendingDispatchRoleCount: (): number => pendingDispatchRoles.size,
	reset: (): void => {
		stallStates.clear();
		pendingDispatchRoles.clear();
	},
} as const;
