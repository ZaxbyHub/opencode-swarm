/**
 * Epic Mode phase readiness — phase reviewer + phase critic gate.
 *
 * Epic Mode replaces Lean Turbo's `lean_turbo_readiness` gate in
 * `phase_complete` (Lean readiness is keyed on Lean lane state, which Epic's
 * visible-`Task` wave flow never produces). This module is the Epic-owned
 * replacement: before an Epic phase may close, an integrated phase reviewer
 * AND a phase critic must both have APPROVED the phase's combined result.
 *
 * ## Evidence integrity
 *
 * Verdicts are never self-reported by the architect. `runEpicPhaseReview`
 * dispatches the reviewer and then the critic itself, through the plugin's
 * read-only ephemeral review dispatcher (the same pattern `lean_turbo_review` /
 * `lean_turbo_critic` use), parses each verdict from the agent's own response
 * text, and persists the result to
 * `.swarm/evidence/{phase}/epic-phase-review.json`. An agent therefore cannot
 * obtain an APPROVED record without a real reviewer and critic dispatch.
 *
 * ## Freshness binding
 *
 * The evidence binds to:
 *   - the epic instance (`epic_key`), so a review recorded under one epic can
 *     never satisfy phase_complete under another — e.g. after the epic was
 *     closed and a new one started on the same plan,
 *   - the plan identity (`plan_id`) and status-free plan structure hash,
 *   - the phase's task ids + statuses (`phase_tasks_digest`), and
 *   - the byte content of every phase task's `.swarm/evidence/{taskId}.json`
 *     (`task_evidence_digest`), so any post-review rework that re-records
 *     reviewer/test_engineer gate evidence invalidates the approval,
 * plus a 24h TTL with a bounded forward-skew rejection (the Full-Auto phase
 * approval precedent). Any mismatch blocks with a STALE code and the
 * architect re-runs `epic_phase_review`.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadPluginConfigWithMeta } from '../config/loader';
import type { RuntimePlan } from '../config/plan-schema';
import {
	DEFAULT_READ_ONLY_TOOLS,
	type ReadOnlyToolDenials,
} from '../evaluation/ephemeral-agent-dispatcher';
import { isValidTaskId } from '../gate-evidence';
import { validateSwarmPath } from '../hooks/utils';
import { computePlanStructureHash } from '../plan/ledger';
import { loadPlan } from '../plan/manager';
import { derivePlanId } from '../plan/utils';
import type {
	ReviewDispatchResult,
	ReviewModelDispatcher,
} from '../review/contracts';
import {
	type ReviewAgentModelRegistry,
	resolveAgentForActiveSwarm,
	reviewFallbackModelStrings,
} from '../review/runtime';
import { atomicWriteSwarmFile } from '../utils/atomic-write';
import * as logger from '../utils/logger';
import {
	dispatchWithModelFallback,
	type ModelOverride,
} from '../utils/model-dispatch-fallback';
import { isTransientProviderError } from '../utils/provider-error-classification';
import { invalidateCachedArtifact } from '../utils/swarm-artifact-cache';
import { resolveEpicConfig } from './config';
import {
	type EpicRecordV1,
	type EpicTaskOutcome,
	getOpenEpic,
} from './lifecycle';
import { epicPhaseFixPath } from './next-wave-format';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Evidence filename under `.swarm/evidence/{phase}/`. */
export const EPIC_PHASE_REVIEW_FILENAME = 'epic-phase-review.json';
/** Approval lifetime; older evidence is stale (Full-Auto phase-approval precedent). */
export const EPIC_PHASE_REVIEW_TTL_MS = 24 * 60 * 60 * 1000;
/** Tolerated forward clock skew before a timestamp is treated as forged. */
export const EPIC_PHASE_REVIEW_FORWARD_SKEW_MS = 5 * 60 * 1000;
/** Default per-role dispatch timeout (`epic.phase_review.timeout_ms`). */
export const EPIC_PHASE_REVIEW_DISPATCH_TIMEOUT_MS = 300_000;

/**
 * The configured per-role timeout (`epic.phase_review.timeout_ms`), or the
 * default when it is unset or the config cannot be read (fail-open to the
 * default: a timeout is a budget, not a safety gate).
 */
export function resolveEpicPhaseReviewTimeoutMs(directory: string): number {
	try {
		const configured = resolveEpicConfig(
			loadPluginConfigWithMeta(directory).config,
		)?.phase_review?.timeout_ms;
		return typeof configured === 'number'
			? configured
			: EPIC_PHASE_REVIEW_DISPATCH_TIMEOUT_MS;
	} catch {
		return EPIC_PHASE_REVIEW_DISPATCH_TIMEOUT_MS;
	}
}
/** Recovery tool name advertised in every block message. */
export const EPIC_PHASE_REVIEW_TOOL = 'epic_phase_review';

/**
 * Tool map for the one empty-response retry: the shared read-only map with
 * only `bash` left enabled. OpenCode Zen's free tier answers a request that
 * disables `bash` with HTTP 403 ("free tier can only be used from within
 * OpenCode"), and the shared dispatcher (which disables `bash` along with
 * every mutating and plugin tool) surfaces ANY provider-side error as a
 * `completed` response with no text (or, where it reads the assistant
 * message's `info.error`, as an `error` with a `providerError`) — so the
 * retry fires on every empty completion and every structured
 * authentication/configuration refusal (HTTP 403 class), not only the Zen
 * 403; a rate limit, quota or outage `providerError` is not retried with
 * `bash` (the model-fallback chain owns it); a second refusal stays a fail-closed
 * REJECTED. Every other tool stays denied, so this profile is
 * still narrower than the standard per-task reviewer/critic agents (whose
 * own config denies only write/edit/patch among the built-ins). Their shell
 * commands pass the same guardrails, which for a scope-less non-coder role
 * block unresolvable, inline-eval and deny-listed (none by default) writes;
 * that is not a read-only sandbox, so the retry also tells the model not to
 * change anything ({@link EPIC_PHASE_REVIEW_BASH_RETRY_NOTE}).
 */
export const EPIC_PHASE_REVIEW_BASH_RETRY_NOTE =
	'You have a `bash` tool for this review. Use it only to read and inspect (for example cat, ls, grep, git log, git diff, git show). Never run a command that creates, modifies or deletes files, changes git state (checkout, stash, reset, commit), installs packages, or runs tests.';

export const EPIC_PHASE_REVIEW_BASH_RETRY_TOOLS: ReadOnlyToolDenials =
	Object.freeze(
		Object.fromEntries(
			Object.entries(DEFAULT_READ_ONLY_TOOLS).filter(
				([name]) => name !== 'bash',
			),
		),
	);

const MAX_REASON_CHARS = 2_000;

// ─── Types ────────────────────────────────────────────────────────────────────

export type EpicPhaseVerdict = 'APPROVED' | 'NEEDS_REVISION' | 'REJECTED';

export type EpicReviewToolProfile = 'read-only' | 'read-only-with-bash';

export interface EpicRoleVerdict {
	role: 'reviewer' | 'critic';
	/** Resolved agent name that was dispatched (e.g. `reviewer`, `mega_critic`). */
	agent: string;
	verdict: EpicPhaseVerdict;
	reason: string | null;
	/**
	 * `completed` — the agent responded and a single verdict was parsed;
	 * `unparseable` — the agent responded without one unambiguous verdict;
	 * `failed` — dispatch failed after fallbacks. Both non-`completed`
	 * outcomes are recorded fail-closed as REJECTED.
	 */
	dispatch: 'completed' | 'unparseable' | 'failed';
	/**
	 * Tool profile of the dispatch that produced this verdict: `read-only`
	 * (the shared map) or `read-only-with-bash` (the provider-refusal retry,
	 * see {@link EPIC_PHASE_REVIEW_BASH_RETRY_TOOLS}). Absent on evidence
	 * written before the retry existed.
	 */
	tool_profile?: EpicReviewToolProfile;
	model?: string;
	duration_ms?: number;
	dispatched_at: string;
}

export interface EpicPhaseBinding {
	/**
	 * Key of the open epic the review ran under (null if none was readable).
	 * Absent on evidence written before the field existed, which is then
	 * treated as stale rather than malformed.
	 */
	epic_key?: string | null;
	plan_id: string;
	plan_structure_hash: string;
	phase_task_ids: string[];
	phase_tasks_digest: string;
	task_evidence_digest: string;
}

export interface EpicPhaseReviewEvidence {
	schema_version: 1;
	kind: 'epic_phase_review';
	phase: number;
	reviewed_at: string;
	/** Architect session that ran `epic_phase_review` (dispatch parent). */
	parent_session_id: string;
	binding: EpicPhaseBinding;
	reviewer: EpicRoleVerdict;
	/** null when the critic was not dispatched because the reviewer did not approve. */
	critic: EpicRoleVerdict | null;
}

export type EpicPhaseReadinessCode =
	| 'EPIC_PHASE_REVIEW_MISSING'
	| 'EPIC_PHASE_REVIEW_INVALID'
	| 'EPIC_PHASE_REVIEWER_NOT_APPROVED'
	| 'EPIC_PHASE_CRITIC_MISSING'
	| 'EPIC_PHASE_CRITIC_NOT_APPROVED'
	| 'EPIC_PHASE_REVIEW_STALE'
	| 'EPIC_PHASE_PLAN_UNREADABLE'
	| 'EPIC_PHASE_WAVES_OPEN';

export type EpicPhaseReadinessResult =
	| { ok: true; evidence: EpicPhaseReviewEvidence }
	| { ok: false; code: EpicPhaseReadinessCode; reason: string };

// ─── Binding ──────────────────────────────────────────────────────────────────

function sha256(text: string): string {
	return createHash('sha256').update(text, 'utf8').digest('hex');
}

function taskEvidenceFingerprint(directory: string, taskId: string): string {
	if (!isValidTaskId(taskId)) return 'invalid-task-id';
	try {
		const bytes = fs.readFileSync(
			path.join(directory, '.swarm', 'evidence', `${taskId}.json`),
		);
		return createHash('sha256').update(bytes).digest('hex');
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return code === 'ENOENT' || code === 'ENAMETOOLONG'
			? 'missing'
			: 'unreadable';
	}
}

/** Key of the open epic, or null when none is open or its row is unreadable. */
function currentEpicKey(directory: string): string | null {
	try {
		return _internals.getOpenEpic(directory)?.epicKey ?? null;
	} catch {
		return null;
	}
}

/**
 * Compute the freshness binding for `phase` of `plan`. Returns the ids of
 * tasks that are not yet `completed`/`closed` so the review tool can refuse a
 * premature review.
 */
export function computeEpicPhaseBinding(
	directory: string,
	plan: RuntimePlan,
	phase: number,
):
	| { ok: true; binding: EpicPhaseBinding; incompleteTaskIds: string[] }
	| { ok: false; reason: string } {
	const target = plan.phases.find((item) => item.id === phase);
	if (!target) {
		return { ok: false, reason: `phase ${phase} is not in the current plan` };
	}
	const tasks = [...target.tasks].sort((a, b) =>
		a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
	);
	const taskIds = tasks.map((task) => task.id);
	return {
		ok: true,
		incompleteTaskIds: tasks
			.filter((task) => task.status !== 'completed' && task.status !== 'closed')
			.map((task) => task.id),
		binding: {
			epic_key: currentEpicKey(directory),
			plan_id: derivePlanId(plan),
			plan_structure_hash: computePlanStructureHash(plan),
			phase_task_ids: taskIds,
			phase_tasks_digest: sha256(
				JSON.stringify(tasks.map((task) => [task.id, task.status])),
			),
			task_evidence_digest: sha256(
				JSON.stringify(
					taskIds.map((id) => [
						id,
						_internals.taskEvidenceFingerprint(directory, id),
					]),
				),
			),
		},
	};
}

// ─── Evidence read / validation ───────────────────────────────────────────────

function evidencePath(directory: string, phase: number): string {
	return validateSwarmPath(
		directory,
		path.posix.join('evidence', String(phase), EPIC_PHASE_REVIEW_FILENAME),
	);
}

const VERDICTS: ReadonlySet<string> = new Set([
	'APPROVED',
	'NEEDS_REVISION',
	'REJECTED',
]);

function isRoleVerdict(
	value: unknown,
	role: 'reviewer' | 'critic',
): value is EpicRoleVerdict {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const v = value as Record<string, unknown>;
	return (
		v.role === role &&
		typeof v.agent === 'string' &&
		v.agent.length > 0 &&
		typeof v.verdict === 'string' &&
		VERDICTS.has(v.verdict) &&
		(v.reason === null || typeof v.reason === 'string') &&
		(v.dispatch === 'completed' ||
			v.dispatch === 'unparseable' ||
			v.dispatch === 'failed') &&
		(v.tool_profile === undefined ||
			v.tool_profile === 'read-only' ||
			v.tool_profile === 'read-only-with-bash') &&
		typeof v.dispatched_at === 'string'
	);
}

function isBinding(value: unknown): value is EpicPhaseBinding {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const v = value as Record<string, unknown>;
	return (
		(v.epic_key === undefined ||
			v.epic_key === null ||
			typeof v.epic_key === 'string') &&
		typeof v.plan_id === 'string' &&
		typeof v.plan_structure_hash === 'string' &&
		Array.isArray(v.phase_task_ids) &&
		v.phase_task_ids.every((id) => typeof id === 'string') &&
		typeof v.phase_tasks_digest === 'string' &&
		typeof v.task_evidence_digest === 'string'
	);
}

/** Strict shape check for persisted evidence (fail-closed on any drift). */
export function parseEpicPhaseReviewEvidence(
	raw: unknown,
): EpicPhaseReviewEvidence | null {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
	const v = raw as Record<string, unknown>;
	if (
		v.schema_version !== 1 ||
		v.kind !== 'epic_phase_review' ||
		typeof v.phase !== 'number' ||
		!Number.isInteger(v.phase) ||
		typeof v.reviewed_at !== 'string' ||
		typeof v.parent_session_id !== 'string' ||
		!isBinding(v.binding) ||
		!isRoleVerdict(v.reviewer, 'reviewer') ||
		!(v.critic === null || isRoleVerdict(v.critic, 'critic'))
	) {
		return null;
	}
	return raw as EpicPhaseReviewEvidence;
}

type EvidenceRead =
	| { status: 'missing' }
	| { status: 'invalid'; detail: string }
	| { status: 'found'; evidence: EpicPhaseReviewEvidence };

function readEpicPhaseReviewEvidence(
	directory: string,
	phase: number,
): EvidenceRead {
	let text: string;
	try {
		text = fs.readFileSync(evidencePath(directory, phase), 'utf-8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return { status: 'missing' };
		}
		return {
			status: 'invalid',
			detail: error instanceof Error ? error.message : String(error),
		};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { status: 'invalid', detail: 'evidence is not valid JSON' };
	}
	const evidence = parseEpicPhaseReviewEvidence(parsed);
	return evidence
		? { status: 'found', evidence }
		: { status: 'invalid', detail: 'evidence does not match schema v1' };
}

function rerunHint(phase: number): string {
	return `Call ${EPIC_PHASE_REVIEW_TOOL}({ phase: ${phase} }) — it dispatches the phase reviewer and then the phase critic and records both verdicts — then retry phase_complete.`;
}

/** Seqs of the epic's waves for `phase` that are issued and not closed. */
export function openEpicWavesForPhase(
	record: Pick<EpicRecordV1, 'waves'>,
	phase: number,
): number[] {
	return record.waves
		.filter((wave) => wave.phase === phase && wave.status === 'issued')
		.map((wave) => wave.seq);
}

/**
 * Epic v2 C2: a phase is reviewable / completable only when every wave
 * `epic_next_wave` issued for it is closed. Null when that holds (or no
 * epic is open); otherwise the blocking reason. An unreadable epic record
 * fails closed.
 */
export function describeOpenEpicWaves(
	directory: string,
	phase: number,
): string | null {
	let record: EpicRecordV1 | null;
	try {
		record = _internals.getOpenEpic(directory);
	} catch (error) {
		return `the open epic's record is unreadable (${error instanceof Error ? error.message : String(error)}), so its waves cannot be verified (fail closed). Ask the user to run \`/swarm epic status\`.`;
	}
	if (!record) return null;
	const open = openEpicWavesForPhase(record, phase);
	if (open.length === 0) return null;
	return `wave ${open.join(', ')} of phase ${phase} is still open. Call epic_next_wave — it closes a wave once every task in it is resolved — until it returns phase-ready-for-review.`;
}

/**
 * Verify that `phase` has fresh, APPROVED phase-reviewer and phase-critic
 * evidence and (Epic v2 C2) no open wave. Observational only: never
 * dispatches or writes.
 */
export async function verifyEpicPhaseReadiness(
	directory: string,
	phase: number,
	nowMs: number,
): Promise<EpicPhaseReadinessResult> {
	const openWaves = describeOpenEpicWaves(directory, phase);
	if (openWaves !== null) {
		return {
			ok: false,
			code: 'EPIC_PHASE_WAVES_OPEN',
			reason: `Phase ${phase} cannot complete: ${openWaves}`,
		};
	}
	const read = _internals.readEvidence(directory, phase);
	const rel = `.swarm/evidence/${phase}/${EPIC_PHASE_REVIEW_FILENAME}`;
	if (read.status === 'missing') {
		return {
			ok: false,
			code: 'EPIC_PHASE_REVIEW_MISSING',
			reason: `Epic Mode requires an APPROVED phase reviewer and phase critic before phase ${phase} can complete, but ${rel} does not exist. ${rerunHint(phase)}`,
		};
	}
	if (read.status === 'invalid') {
		return {
			ok: false,
			code: 'EPIC_PHASE_REVIEW_INVALID',
			reason: `Epic phase review evidence ${rel} is unreadable or malformed (${read.detail}). Do not edit it by hand. ${rerunHint(phase)}`,
		};
	}
	const evidence = read.evidence;
	if (evidence.phase !== phase) {
		return {
			ok: false,
			code: 'EPIC_PHASE_REVIEW_INVALID',
			reason: `Epic phase review evidence at ${rel} records phase ${evidence.phase}, not phase ${phase}. ${rerunHint(phase)}`,
		};
	}
	if (evidence.reviewer.verdict !== 'APPROVED') {
		return {
			ok: false,
			code: 'EPIC_PHASE_REVIEWER_NOT_APPROVED',
			reason: `Epic phase reviewer (${evidence.reviewer.agent}) returned ${evidence.reviewer.verdict} for phase ${phase}${evidence.reviewer.reason ? `: ${evidence.reviewer.reason}` : ''}. ${epicPhaseFixPath(phase)} Then retry phase_complete.`,
		};
	}
	if (!evidence.critic) {
		return {
			ok: false,
			code: 'EPIC_PHASE_CRITIC_MISSING',
			reason: `Epic phase critic verdict is missing for phase ${phase}. ${rerunHint(phase)}`,
		};
	}
	if (evidence.critic.verdict !== 'APPROVED') {
		return {
			ok: false,
			code: 'EPIC_PHASE_CRITIC_NOT_APPROVED',
			reason: `Epic phase critic (${evidence.critic.agent}) returned ${evidence.critic.verdict} for phase ${phase}${evidence.critic.reason ? `: ${evidence.critic.reason}` : ''}. ${epicPhaseFixPath(phase)} Then retry phase_complete.`,
		};
	}

	const reviewedAtMs = Date.parse(evidence.reviewed_at);
	if (!Number.isFinite(reviewedAtMs)) {
		return {
			ok: false,
			code: 'EPIC_PHASE_REVIEW_INVALID',
			reason: `Epic phase review evidence for phase ${phase} has an invalid reviewed_at timestamp. ${rerunHint(phase)}`,
		};
	}
	const age = nowMs - reviewedAtMs;
	if (age < -EPIC_PHASE_REVIEW_FORWARD_SKEW_MS) {
		return {
			ok: false,
			code: 'EPIC_PHASE_REVIEW_STALE',
			reason: `Epic phase review evidence for phase ${phase} is future-dated (${evidence.reviewed_at}); rejected as forged or clock-skewed. ${rerunHint(phase)}`,
		};
	}
	if (age > EPIC_PHASE_REVIEW_TTL_MS) {
		return {
			ok: false,
			code: 'EPIC_PHASE_REVIEW_STALE',
			reason: `Epic phase review evidence for phase ${phase} is older than 24h. ${rerunHint(phase)}`,
		};
	}

	let plan: RuntimePlan | null;
	try {
		plan = await _internals.loadPlan(directory);
	} catch {
		plan = null;
	}
	if (!plan) {
		return {
			ok: false,
			code: 'EPIC_PHASE_PLAN_UNREADABLE',
			reason: `Cannot verify Epic phase review freshness for phase ${phase}: the plan could not be loaded.`,
		};
	}
	const current = computeEpicPhaseBinding(directory, plan, phase);
	if (!current.ok) {
		return {
			ok: false,
			code: 'EPIC_PHASE_PLAN_UNREADABLE',
			reason: `Cannot verify Epic phase review freshness: ${current.reason}.`,
		};
	}
	const recorded = evidence.binding;
	const drift: string[] = [];
	if ((recorded.epic_key ?? null) !== current.binding.epic_key) {
		drift.push('epic instance');
	}
	if (recorded.plan_id !== current.binding.plan_id) drift.push('plan identity');
	if (recorded.plan_structure_hash !== current.binding.plan_structure_hash) {
		drift.push('plan structure');
	}
	if (recorded.phase_tasks_digest !== current.binding.phase_tasks_digest) {
		drift.push('phase task set/status');
	}
	if (recorded.task_evidence_digest !== current.binding.task_evidence_digest) {
		drift.push('task gate evidence (rework after review)');
	}
	if (drift.length > 0) {
		return {
			ok: false,
			code: 'EPIC_PHASE_REVIEW_STALE',
			reason: `Epic phase review evidence for phase ${phase} is stale — ${drift.join(', ')} changed after the review. ${rerunHint(phase)}`,
		};
	}
	return { ok: true, evidence };
}

// ─── Dispatch ─────────────────────────────────────────────────────────────────

/**
 * Parse exactly one verdict from agent response text. Every `VERDICT:` line
 * is collected; zero or conflicting verdicts are unparseable (fail-closed),
 * so a template echo such as `VERDICT: APPROVED | REJECTED` cannot count.
 */
export function parseEpicPhaseVerdict(
	text: string,
): { verdict: EpicPhaseVerdict; reason: string | null } | null {
	const lines = text.split(/\r?\n/);
	const found: Array<{ verdict: EpicPhaseVerdict; index: number }> = [];
	for (let i = 0; i < lines.length; i++) {
		const match =
			/^\s*(?:\*\*)?VERDICT(?:\*\*)?\s*:\s*(?:\*\*)?\s*(APPROVED|NEEDS_REVISION|REJECTED)\s*(?:\*\*)?\s*$/i.exec(
				lines[i],
			);
		if (match) {
			found.push({
				verdict: match[1].toUpperCase() as EpicPhaseVerdict,
				index: i,
			});
		}
	}
	if (found.length === 0) return null;
	if (new Set(found.map((item) => item.verdict)).size > 1) return null;
	const last = found[found.length - 1];
	let reason: string | null = null;
	for (
		let i = last.index + 1;
		i < Math.min(lines.length, last.index + 4);
		i++
	) {
		const reasonMatch = /^\s*(?:\*\*)?REASON(?:\*\*)?\s*:\s*(.+)$/i.exec(
			lines[i],
		);
		if (reasonMatch) {
			reason = reasonMatch[1].trim().slice(0, MAX_REASON_CHARS);
			break;
		}
	}
	return { verdict: last.verdict, reason };
}

interface EpicPhaseReviewPackage {
	phase: number;
	phase_name: string;
	tasks: Array<{
		id: string;
		status: string;
		description: string;
		acceptance?: string;
		files_touched: string[];
		depends: string[];
		divergence?: {
			declared_scope: string[];
			undeclared: string[];
			/**
			 * Where `undeclared` came from; `unavailable` / `no-git` mean the
			 * actual writes are unknown — an empty `undeclared` is NOT clean.
			 */
			attribution: EpicTaskOutcome['attribution'];
		};
	}>;
	files_changed: string[];
}

function buildReviewPackage(
	directory: string,
	plan: RuntimePlan,
	phase: number,
): EpicPhaseReviewPackage {
	const target = plan.phases.find((item) => item.id === phase);
	const tasks = target?.tasks ?? [];
	// Declared (frozen) and undeclared files per task, as the open epic
	// recorded them when each task's wave closed.
	let outcomes: Record<string, EpicTaskOutcome> = {};
	try {
		outcomes = _internals.getOpenEpic(directory)?.tasks ?? {};
	} catch (error) {
		logger.warn(
			`[epic-phase-readiness] epic record unreadable; reviewing without divergence: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const filesChanged = new Set<string>();
	const packaged = tasks.map((task) => {
		const outcome = Object.hasOwn(outcomes, task.id)
			? outcomes[task.id]
			: undefined;
		const divergence =
			outcome && outcome.resolution !== 'removed' ? outcome : undefined;
		const attributed =
			divergence?.attribution === 'session' ||
			divergence?.attribution === 'git-single-task';
		for (const file of divergence && attributed
			? [...divergence.declared, ...divergence.undeclared]
			: [...(divergence?.declared ?? []), ...task.files_touched]) {
			filesChanged.add(file);
		}
		return {
			id: task.id,
			status: task.status,
			description: task.description,
			...(task.acceptance ? { acceptance: task.acceptance } : {}),
			files_touched: [...task.files_touched],
			depends: [...task.depends],
			...(divergence
				? {
						divergence: {
							declared_scope: [...divergence.declared],
							undeclared: [...divergence.undeclared],
							attribution: divergence.attribution,
						},
					}
				: {}),
		};
	});
	return {
		phase,
		phase_name: target?.name ?? `Phase ${phase}`,
		tasks: packaged,
		files_changed: [...filesChanged].sort(),
	};
}

const VERDICT_FOOTER = `Conclude with exactly ONE verdict line followed by a REASON line:

VERDICT: APPROVED
REASON: <brief explanation>

(or VERDICT: NEEDS_REVISION / VERDICT: REJECTED with what must change).`;

const REVIEWER_SYSTEM = `You are the read-only PHASE REVIEWER for an Epic Mode phase.
Epic Mode ran this phase's tasks as concurrent waves of coders, so per-task review cannot see cross-task integration problems.
Review the phase as one integrated change: read the changed files with your read-only tools; check each task's acceptance criteria against the actual code; look for conflicts or inconsistencies between tasks that edited adjacent code, undeclared writes (divergence), missing wiring (exports, registration, call sites), and regressions.
Be specific and evidence-based (file + line). Never approve work you did not inspect.`;

const CRITIC_SYSTEM = `You are the read-only PHASE CRITIC for an Epic Mode phase.
A phase reviewer has APPROVED this phase. Your job is to challenge that approval: probe boundary conditions, unverified claims, missed integration risks between concurrently executed tasks, and anything the reviewer glossed over. Read the changed files with your read-only tools.
Approve only if the approval survives your challenge; otherwise return NEEDS_REVISION or REJECTED with concrete, evidence-based reasons.`;

function buildPrompt(
	pkg: EpicPhaseReviewPackage,
	reviewer?: EpicRoleVerdict,
): string {
	const reviewerSection = reviewer
		? `\n\n## Phase Reviewer Verdict\n\nVERDICT (reviewer): ${reviewer.verdict}\nREASON (reviewer): ${reviewer.reason ?? '(none given)'}\n`
		: '';
	return `## Epic Phase Review Package

\`\`\`json
${JSON.stringify(pkg, null, 2)}
\`\`\`${reviewerSection}

${VERDICT_FOOTER}`;
}

export interface EpicPhaseReviewOptions {
	dispatcher?: ReviewModelDispatcher;
	generatedAgentNames?: readonly string[];
	activeAgentName?: string;
	agentModelRegistry?: ReviewAgentModelRegistry;
	timeoutMs?: number;
}

async function dispatchRole(
	directory: string,
	parentSessionId: string,
	role: 'reviewer' | 'critic',
	agentName: string,
	system: string,
	prompt: string,
	options: EpicPhaseReviewOptions,
): Promise<EpicRoleVerdict> {
	const dispatcher = options.dispatcher as ReviewModelDispatcher;
	const dispatchedAt = new Date(_internals.now()).toISOString();
	const fallbackModels = reviewFallbackModelStrings(
		agentName,
		options.agentModelRegistry,
	);
	const timeoutMs = options.timeoutMs ?? EPIC_PHASE_REVIEW_DISPATCH_TIMEOUT_MS;
	let toolProfile: EpicReviewToolProfile = 'read-only';
	try {
		const { result, modelUsed } = await dispatchWithModelFallback<
			ReviewDispatchResult & { status: 'completed' }
		>({
			dispatch: async (model: ModelOverride | undefined) => {
				const request = {
					directory,
					parentSessionId,
					agentName,
					model,
					system,
					prompt,
					title: `epic_phase_review ${role}`,
					timeoutMs,
				};
				toolProfile = 'read-only';
				let response = await dispatcher.dispatch(request);
				// A provider-side error (e.g. the Zen free tier's 403 for a
				// bash-less request) arrives as `completed` with no text (see
				// EPIC_PHASE_REVIEW_BASH_RETRY_TOOLS), or — from a dispatcher that
				// reads the assistant message's `info.error` — as `error` with a
				// structured `providerError` of the authentication/configuration
				// class: retry once keeping `bash`, within
				// what is left of this attempt's timeout so one model attempt
				// never exceeds `timeoutMs`. A model that answers — even without
				// a verdict — and any other failed dispatch are not retried.
				const remainingMs = timeoutMs - response.durationMs;
				// Only an authentication/configuration refusal (the Zen 403 class)
				// can be cured by re-enabling `bash`; a rate limit, quota or
				// outage is left to the model-fallback chain below.
				const providerRefused =
					(response.status === 'completed' && response.text.trim() === '') ||
					(response.status === 'error' &&
						(response.providerError?.category ===
							'provider.authentication_configuration' ||
							response.providerError?.statusCode === 403));
				if (providerRefused && remainingMs > 0) {
					toolProfile = 'read-only-with-bash';
					const firstMs = response.durationMs;
					const retry = await dispatcher.dispatch({
						...request,
						system: `${system}\n\n${EPIC_PHASE_REVIEW_BASH_RETRY_NOTE}`,
						timeoutMs: remainingMs,
						tools: EPIC_PHASE_REVIEW_BASH_RETRY_TOOLS,
					});
					response = { ...retry, durationMs: firstMs + retry.durationMs };
				}
				if (response.status === 'completed') {
					return response as ReviewDispatchResult & { status: 'completed' };
				}
				if (response.status === 'timeout') {
					throw new Error(
						`Epic phase ${role} dispatch timed out after ${timeoutMs}ms`,
					);
				}
				throw new Error(
					response.error ?? `Epic phase ${role} dispatch ${response.status}`,
				);
			},
			resolveFallback: (index) => fallbackModels[index - 1] ?? null,
			maxTransientRetriesPerModel: 0,
			classify: (error) => {
				const message = error instanceof Error ? error.message : String(error);
				if (/dispatch timed out/i.test(message)) return 'permanent';
				return isTransientProviderError(message) ? 'transient' : 'permanent';
			},
		});
		const parsed = parseEpicPhaseVerdict(result.text);
		const base = {
			role,
			agent: agentName,
			dispatched_at: dispatchedAt,
			tool_profile: toolProfile,
			duration_ms: result.durationMs,
			...((modelUsed ?? result.modelId)
				? { model: modelUsed ?? result.modelId }
				: {}),
		};
		return parsed
			? {
					...base,
					verdict: parsed.verdict,
					reason: parsed.reason,
					dispatch: 'completed',
				}
			: {
					...base,
					verdict: 'REJECTED',
					reason: `${role} response did not contain exactly one unambiguous VERDICT line`,
					dispatch: 'unparseable',
				};
	} catch (error) {
		return {
			role,
			agent: agentName,
			verdict: 'REJECTED',
			reason:
				`${role} dispatch failed: ${error instanceof Error ? error.message : String(error)}`.slice(
					0,
					MAX_REASON_CHARS,
				),
			dispatch: 'failed',
			tool_profile: toolProfile,
			dispatched_at: dispatchedAt,
		};
	}
}

export type EpicPhaseReviewRunResult =
	| {
			success: true;
			phase: number;
			ready: boolean;
			reviewer: EpicRoleVerdict;
			critic: EpicRoleVerdict | null;
			evidencePath: string;
			message: string;
	  }
	| {
			success: false;
			phase: number;
			reason:
				| 'dispatcher-unavailable'
				| 'no-plan'
				| 'no-phase'
				| 'tasks-incomplete'
				| 'agent-resolution-failed'
				| 'persist-failed';
			message: string;
	  };

/**
 * Dispatch the phase reviewer, then (only when it APPROVES) the phase critic,
 * and persist the bound verdicts for the phase_complete Epic readiness gate.
 */
export async function runEpicPhaseReview(
	directory: string,
	phase: number,
	parentSessionId: string,
	options: EpicPhaseReviewOptions = {},
): Promise<EpicPhaseReviewRunResult> {
	if (!options.dispatcher) {
		return {
			success: false,
			phase,
			reason: 'dispatcher-unavailable',
			message:
				'The review dispatcher is not available in this context, so the Epic phase reviewer/critic cannot be dispatched. Retry from the architect session of a running plugin instance.',
		};
	}
	let plan: RuntimePlan | null;
	try {
		plan = await _internals.loadPlan(directory);
	} catch {
		plan = null;
	}
	if (!plan) {
		return {
			success: false,
			phase,
			reason: 'no-plan',
			message:
				'No readable plan; save a plan before running the Epic phase review.',
		};
	}
	const binding = computeEpicPhaseBinding(directory, plan, phase);
	if (!binding.ok) {
		return {
			success: false,
			phase,
			reason: 'no-phase',
			message: `Cannot review: ${binding.reason}.`,
		};
	}
	if (binding.incompleteTaskIds.length > 0) {
		return {
			success: false,
			phase,
			reason: 'tasks-incomplete',
			message: `Phase ${phase} still has unfinished tasks (${binding.incompleteTaskIds.join(', ')}). Complete every task (update_task_status completed), then call epic_next_wave until it returns phase-ready-for-review.`,
		};
	}

	const names = options.generatedAgentNames ?? [];
	let reviewerAgent: string;
	let criticAgent: string;
	try {
		reviewerAgent = resolveAgentForActiveSwarm(
			names,
			'reviewer',
			options.activeAgentName,
		);
		criticAgent = resolveAgentForActiveSwarm(
			names,
			'critic',
			options.activeAgentName,
		);
	} catch (error) {
		return {
			success: false,
			phase,
			reason: 'agent-resolution-failed',
			message: `Cannot resolve the reviewer/critic agents for this swarm: ${error instanceof Error ? error.message : String(error)}`,
		};
	}

	const pkg = buildReviewPackage(directory, plan, phase);
	const reviewer = await dispatchRole(
		directory,
		parentSessionId,
		'reviewer',
		reviewerAgent,
		REVIEWER_SYSTEM,
		buildPrompt(pkg),
		options,
	);
	const critic =
		reviewer.verdict === 'APPROVED'
			? await dispatchRole(
					directory,
					parentSessionId,
					'critic',
					criticAgent,
					CRITIC_SYSTEM,
					buildPrompt(pkg, reviewer),
					options,
				)
			: null;

	const evidence: EpicPhaseReviewEvidence = {
		schema_version: 1,
		kind: 'epic_phase_review',
		phase,
		reviewed_at: new Date(_internals.now()).toISOString(),
		parent_session_id: parentSessionId,
		binding: binding.binding,
		reviewer,
		critic,
	};
	const rel = `.swarm/evidence/${phase}/${EPIC_PHASE_REVIEW_FILENAME}`;
	try {
		const target = evidencePath(directory, phase);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		await _internals.writeEvidence(
			target,
			`${JSON.stringify(evidence, null, 2)}\n`,
		);
		invalidateCachedArtifact(target);
	} catch (error) {
		return {
			success: false,
			phase,
			reason: 'persist-failed',
			message: `Epic phase review ran but ${rel} could not be written: ${error instanceof Error ? error.message : String(error)}`,
		};
	}

	const ready =
		reviewer.verdict === 'APPROVED' && critic?.verdict === 'APPROVED';
	const bashRetry = [reviewer, critic].some(
		(verdict) => verdict?.tool_profile === 'read-only-with-bash',
	)
		? ' (an empty dispatch response was retried with bash enabled; see tool_profile in the evidence)'
		: '';
	const message =
		(ready
			? `Phase ${phase} reviewer and critic both APPROVED. Evidence recorded at ${rel}. Now run the normal PHASE-WRAP (load the phase-wrap skill: dispatch the docs agent, write the retrospective with write_retro, …), then phase_complete({ phase: ${phase} }), then epic_next_wave.`
			: reviewer.verdict !== 'APPROVED'
				? `Phase reviewer returned ${reviewer.verdict}${reviewer.reason ? `: ${reviewer.reason}` : ''}. The critic was not dispatched. ${epicPhaseFixPath(phase)}`
				: `Phase critic returned ${critic?.verdict}${critic?.reason ? `: ${critic.reason}` : ''}. ${epicPhaseFixPath(phase)}`) +
		bashRetry;
	return {
		success: true,
		phase,
		ready,
		reviewer,
		critic,
		evidencePath: rel,
		message,
	};
}

// ─── Test seam ────────────────────────────────────────────────────────────────

/** Dependency-injection seam (AGENTS.md invariant 7); restore in afterEach. */
export const _internals = {
	loadPlan: (directory: string): Promise<RuntimePlan | null> =>
		loadPlan(directory),
	readEvidence: readEpicPhaseReviewEvidence,
	taskEvidenceFingerprint,
	writeEvidence: (target: string, content: string): Promise<void> =>
		atomicWriteSwarmFile(target, content),
	now: (): number => Date.now(),
	getOpenEpic,
};
