/**
 * Plan identity for Epic commits (Epic v2 C0, reshaped in C3).
 *
 * Every commit Epic writes for a task — the worktree LANDING merge commit of
 * its coder and the RESIDUE commit of a non-coder writer (test_engineer,
 * docs, …) — has the subject `swarm(task <id>): …` and a final
 * `Swarm-Plan: <planKey>` trailer, where
 * `planKey = sha256(planIdentityHash + '|' + (planEpoch ?? '')).slice(0, 16)`.
 * The plan epoch is minted per ledger root, so two consecutive plans with the
 * same title (every plan has a `1.1`) get different keys. Task ids repeat
 * across plans, so a commit is attributed to a task only when its trailer
 * names the current plan.
 *
 * Predecessor evidence no longer greps history: wave close records each
 * task's commit in the epic record and mirrors it to the ref
 * `refs/swarm/epics/<epicKey>/tasks/<id>` (`markers.ts`). The marker
 * subject + trailer remain the way wave close and `/swarm epic status
 * --repair-refs` find a task's commit inside the epic's own commit range.
 *
 * Records are NUL-separated (`git log -z`); git refuses NUL bytes in commit
 * messages, so a message body cannot forge a record boundary.
 *
 * Subprocess discipline: no git call is made here; readers go through
 * `src/git/branch.ts` `gitExec` (AGENTS.md #3).
 */

import { createHash } from 'node:crypto';
import type { Plan } from '../config/plan-schema.js';
import {
	readLedgerEvents as readLedgerEvents_import,
	readPlanEpochIdentity as readPlanEpochIdentity_import,
} from '../plan/ledger.js';
import { derivePlanIdentityHash } from '../plan/utils.js';
import { canonicalRootKey } from '../utils/canonical-root.js';
import { withTimeout } from '../utils/timeout.js';

/** The commit-message trailer key binding a marker to its plan. */
export const SWARM_PLAN_TRAILER_KEY = 'Swarm-Plan';

/** Identity of the plan whose markers may be honored. */
export interface PlanMarkerScope {
	/** 16-hex-char key written into the `Swarm-Plan:` trailer. */
	planKey: string;
	/**
	 * Earliest plan-ledger event time (ms since epoch), or null when the
	 * ledger is absent / carries no parseable timestamp.
	 */
	rootTimestampMs: number | null;
}

/** One `swarm(task <id>):` commit read back from git. */
export interface ParsedTaskMarker {
	/** Full commit id (`%H`). */
	sha: string;
	taskId: string;
	/** Last `Swarm-Plan:` trailer value; null when the commit carries none. */
	planKey: string | null;
}

/** Subject shape produced by {@link formatEpicTaskCommitMessage}. */
export const SWARM_TASK_SUBJECT_RE = /^swarm\(task ([^)]+)\):/;
const TRAILER_LINE_RE = /^Swarm-Plan:[ \t]*(\S+)[ \t]*$/;
const RECORD_SEP = '\0';
const FIELD_SEP = '\x1f';
const SHA_RE = /^[0-9a-f]{40,64}$/;
/**
 * `git log -z --format` producing `<sha> US <raw message>` per commit,
 * records separated by NUL (`-z`).
 */
export const MARKER_LOG_FORMAT = '--format=%H%x1f%B';

/** Bound on scope resolution (ledger reads) so status never hangs. */
export const PLAN_SCOPE_RESOLVE_TIMEOUT_MS = 10_000;
/** Max (directory, planKey) entries in the root-timestamp cache (FIFO). */
export const MAX_ROOT_TS_CACHE_ENTRIES = 16;

/**
 * Defensive taskId scrubber for commit-subject and grep-pattern use (Phase
 * 17 C.H2). Plan-ledger dep ids flow here from LLM-authored plans without
 * re-validation; a `)` or newline would corrupt the subject regex. Keeps
 * only characters safe in both a git subject and an ERE literal.
 */
export function scrubTaskIdForGitSubject(taskId: string): string {
	return taskId.replace(/[^a-zA-Z0-9._-]/g, '_');
}

/** `sha256(planIdentityHash + '|' + (planEpoch ?? '')).slice(0, 16)`. */
export function computePlanKey(
	planIdentityHash: string,
	planEpoch: string | null,
): string {
	return createHash('sha256')
		.update(`${planIdentityHash}|${planEpoch ?? ''}`, 'utf8')
		.digest('hex')
		.slice(0, 16);
}

/** The trailer line closing every Epic task commit message. */
export function formatSwarmPlanTrailer(planKey: string): string {
	return `${SWARM_PLAN_TRAILER_KEY}: ${planKey}`;
}

/**
 * The message of an Epic task commit (landing merge or residue): subject
 * `swarm(task <id>): <summary>` — the summary whitespace-collapsed and
 * truncated to keep the subject within git's conventional 72 columns — and a
 * final `Swarm-Plan: <planKey>` trailer. The task id is scrubbed by
 * {@link scrubTaskIdForGitSubject}. Treat the shape as a stable contract.
 */
export function formatEpicTaskCommitMessage(
	taskId: string,
	planKey: string,
	summary?: string,
): string {
	const safeId = scrubTaskIdForGitSubject(taskId);
	const text = (summary ?? 'completed').replace(/\s+/g, ' ').trim();
	const truncated = text.length > 60 ? `${text.slice(0, 57)}...` : text;
	return `swarm(task ${safeId}): ${truncated || 'completed'}\n\n${formatSwarmPlanTrailer(planKey)}`;
}

const rootTimestampCache = new Map<string, number>();

function cacheRootTimestamp(key: string, value: number): void {
	if (rootTimestampCache.has(key)) rootTimestampCache.delete(key);
	rootTimestampCache.set(key, value);
	while (rootTimestampCache.size > MAX_ROOT_TS_CACHE_ENTRIES) {
		const oldest = rootTimestampCache.keys().next().value;
		if (oldest === undefined) break;
		rootTimestampCache.delete(oldest);
	}
}

async function resolveRootTimestampMs(
	directory: string,
	planKey: string,
	cacheable: boolean,
): Promise<number | null> {
	const cacheKey = `${canonicalRootKey(directory)}\0${planKey}`;
	if (cacheable) {
		const cached = rootTimestampCache.get(cacheKey);
		if (cached !== undefined) return cached;
	}
	const events = await _internals.readLedgerEvents(directory);
	let earliest: number | null = null;
	for (const event of events) {
		const ms = Date.parse(event.timestamp);
		if (Number.isFinite(ms) && (earliest === null || ms < earliest)) {
			earliest = ms;
		}
	}
	// Only epoch-bearing plans are cached: an epoch is minted per ledger
	// root, so (directory, planKey) can never map to a different root. A
	// null-epoch (legacy) key is shared by every same-title plan and is
	// therefore re-read each time.
	if (cacheable && earliest !== null) cacheRootTimestamp(cacheKey, earliest);
	return earliest;
}

async function resolvePlanMarkerScopeUnbounded(
	directory: string,
	plan: Plan,
): Promise<PlanMarkerScope> {
	const identity = await _internals.readPlanEpochIdentity(directory, plan);
	const planKey = computePlanKey(
		identity?.planIdentityHash ?? derivePlanIdentityHash(plan),
		identity?.planEpoch ?? null,
	);
	const rootTimestampMs = await resolveRootTimestampMs(
		directory,
		planKey,
		identity !== null,
	);
	return { planKey, rootTimestampMs };
}

/**
 * Resolve the plan scope (planKey + plan root time) for `plan` — used by
 * `/swarm epic status` to date recorded merge failures. Throws when the
 * ledger identity is invalid/conflicting or the read exceeds
 * {@link PLAN_SCOPE_RESOLVE_TIMEOUT_MS}; the caller then reports the root as
 * unknown (every failure blocking).
 */
export async function resolvePlanMarkerScope(
	directory: string,
	plan: Plan,
): Promise<PlanMarkerScope> {
	return withTimeout(
		resolvePlanMarkerScopeUnbounded(directory, plan),
		_internals.resolveTimeoutMs,
		new Error(
			`plan marker scope resolution timed out after ${_internals.resolveTimeoutMs}ms`,
		),
	);
}

/**
 * Parse `git log -z` output produced with {@link MARKER_LOG_FORMAT}. Records
 * whose subject is not a `swarm(task <id>):` marker are dropped (a squash
 * message may quote a marker in its body).
 */
export function parseTaskMarkerLog(output: string): ParsedTaskMarker[] {
	const markers: ParsedTaskMarker[] = [];
	for (const record of output.split(RECORD_SEP)) {
		const sep = record.indexOf(FIELD_SEP);
		if (sep < 0) continue;
		const sha = record.slice(0, sep).trim();
		if (!SHA_RE.test(sha)) continue;
		const lines = record
			.slice(sep + 1)
			.split('\n')
			.map((line) => line.replace(/\r$/, ''));
		const subject = (lines[0] ?? '').trim();
		const match = SWARM_TASK_SUBJECT_RE.exec(subject);
		if (!match) continue;
		let planKey: string | null = null;
		for (const line of lines.slice(1)) {
			const trailer = TRAILER_LINE_RE.exec(line);
			if (trailer) planKey = trailer[1];
		}
		markers.push({ sha, taskId: match[1], planKey });
	}
	return markers;
}

/** Test-only: number of cached root timestamps. */
export function _rootTimestampCacheSizeForTest(): number {
	return rootTimestampCache.size;
}

/** Test-only: clear the root-timestamp cache. */
export function _resetRootTimestampCacheForTest(): void {
	rootTimestampCache.clear();
}

/**
 * DI seam (AGENTS.md invariant 7) — tests substitute ledger readers and the
 * resolution deadline without `mock.module`. Restore in `afterEach`.
 */
export const _internals = {
	readLedgerEvents: readLedgerEvents_import,
	readPlanEpochIdentity: readPlanEpochIdentity_import,
	resolveTimeoutMs: PLAN_SCOPE_RESOLVE_TIMEOUT_MS,
};
