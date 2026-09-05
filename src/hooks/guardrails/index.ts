/**
 * Guardrails Hook Module
 *
 * Circuit breaker for runaway LLM agents. Monitors tool usage via OpenCode Plugin API hooks
 * and implements two-layer protection:
 * - Layer 1 (Soft Warning @ warning_threshold): Sets warning flag for messagesTransform to inject warning
 * - Layer 2 (Hard Block @ 100%): Throws error in toolBefore to block further calls, injects STOP message
 */

import * as fsSync from 'node:fs';
import * as path from 'node:path';

import {
	extractSwarmIdFromAgentName,
	getSwarmAgents,
	resolveFallbackModel,
} from '../../agents/index';
import { WRITE_TOOL_NAMES } from '../../config/constants';
import {
	type AuthorityConfig,
	type GuardrailsConfig,
	stripKnownSwarmPrefix,
} from '../../config/schema';
import {
	getTaskWorkflowSnapshot,
	readTaskEvidence,
	transitionTaskWorkflowEvidence,
} from '../../gate-evidence.js';
import { loadPlan } from '../../plan/manager';
import { assessSandboxEnforcement, getExecutor } from '../../sandbox/executor';
import { sanitizeDiagnosticText } from '../../scope/path-identity';
import {
	canonicalWorkspaceIdentity,
	normalizeScopeFiles,
} from '../../scope/scope-binding';
import { createScopeLeaseRenewalTracker } from '../../scope/scope-lease-renewal';
import {
	advanceTaskState,
	ensureAgentSession,
	getActiveWindow,
	getReviewerScopeGenerationForCoderCall,
	recordReviewerScopeGenerationCaptureFailure,
	recordReviewerScopeGenerationFileFingerprint,
	resolveSessionWorkspaceDirectory,
	swarmState,
	updateTaskWorkflowCache,
} from '../../state';
import { telemetry } from '../../telemetry.js';
import { log, warn } from '../../utils';
import { pushAdvisory } from '../../utils/advisory-queue';
import * as logger from '../../utils/logger';
import { computeSpecDiff } from '../../utils/spec-hash';
import { isStrictTaskId } from '../../validation/task-id.js';
import { listCoderSettlementWalStates } from '../../workflow/coder-settlement.js';
import { resolveAgentConflict } from '../conflict-resolution';
import { extractCurrentPhaseFromPlan } from '../extractors';
import { normalizeToolName } from '../normalize-tool-name';
import {
	captureReviewerScopeFileFingerprint,
	REVIEWER_SCOPE_CAPTURE_ATTEMPTS,
	REVIEWER_SCOPE_CAPTURE_BATCH_DEADLINE_MS,
	reviewerScopeCaptureToFingerprint,
} from '../reviewer-scope-file-fingerprint';
import { classifyTaskResult } from '../task-result-classifier';
import { dcCheckJunctionCreation } from './destructive-command';
import { recordExecutionStallToolAfter } from './execution-stall';
import { buildEffectiveRules } from './file-authority';
import { isInDeclaredScope } from './helpers';
import {
	createMessagesTransformHandler,
	getMostRecentAssistantText,
	getProviderFailureFingerprint,
	isTransientProviderFailureText,
} from './messages-transform';
import {
	classifyToolOutcome,
	clearNonTransientCircuit,
	isToolExecutionCurrent,
	recordNonTransientFailure,
	takeToolExecution,
} from './nontransient-circuit';
import { decodePreCheckResult } from './pre-check-result';
import { getStoredInputArgs } from './stored-input-args';
import { createToolBeforeHandler } from './tool-before';

const MAX_PENDING_GATE_RECEIPTS_PER_SESSION = 256;
const MAX_PENDING_GATE_RECEIPT_SESSIONS = 500;

export const _internals = {
	extractSwarmIdFromAgentName,
	getSwarmAgents,
	getMostRecentAssistantText,
	getProviderFailureFingerprint,
	isTransientProviderFailureText,
	resolveFallbackModel,
	dcCheckJunctionCreation,
	extractErrorSignal,
	getSandboxExecutor: getExecutor,
	assessSandboxEnforcement,
	/** Test-only compatibility for legacy direct-after hook tests. */
	allowUncorrelatedGateReceipts: false,
	MAX_PENDING_GATE_RECEIPTS_PER_SESSION,
	MAX_PENDING_GATE_RECEIPT_SESSIONS,
	/**
	 * Test/inspection seams for the no-op detector's bounded session state
	 * (invariant 8). Production code does not call these; they exist so the
	 * eviction bound can be asserted without exporting the maps themselves.
	 */
	noOpStateSize: (): number => toolCallsSinceLastWrite.size,
	hasNoOpState: (sessionID: string): boolean =>
		toolCallsSinceLastWrite.has(sessionID),
	/**
	 * Durable Stage-A attribution fallback seam (TASK_WORKFLOW_STAGE_A_REQUIRED
	 * post-reset wedge). This is the production call site (see `toolBefore`
	 * below); it is also a substitution point tests may override to simulate
	 * reset-flow attribution without real WAL files. See
	 * {@link resolveDurableGateTaskId}.
	 */
	resolveDurableGateTaskId: (
		directory: string,
		callerFiles: string[] | null,
	): Promise<DurableAttributionResult> =>
		resolveDurableGateTaskId(directory, callerFiles),
};

/**
 * Advisory cooldown for durable-attribution ambiguity warnings (invariant 8:
 * session-keyed, bounded, cooldown-gated). Keyed by sessionID → single
 * last-emitted key; a different key replaces the entry, so the map is bounded
 * by the sessions cap below with FIFO eviction.
 */
const DURABLE_ATTRIBUTION_ADVISORY_COOLDOWN_MS = 60_000;
const MAX_DURABLE_ATTRIBUTION_ADVISORY_SESSIONS = 500;
const durableAttributionAdvisoryBySession = new Map<
	string,
	{ key: string; at: number }
>();

export function emitDurableAttributionAdvisory(
	sessionID: string,
	key: string,
	message: string,
): void {
	const now = Date.now();
	const prior = durableAttributionAdvisoryBySession.get(sessionID);
	if (
		prior &&
		prior.key === key &&
		now - prior.at < DURABLE_ATTRIBUTION_ADVISORY_COOLDOWN_MS
	) {
		return;
	}
	if (
		!prior &&
		durableAttributionAdvisoryBySession.size >=
			MAX_DURABLE_ATTRIBUTION_ADVISORY_SESSIONS
	) {
		// Only evict when this is a genuinely NEW session key — re-setting an
		// existing session's entry never grows the map, so evicting an
		// unrelated "oldest" session in that case would drop a still-valid
		// cooldown for no size-driven reason.
		const oldest = durableAttributionAdvisoryBySession.keys().next().value;
		if (oldest !== undefined) {
			durableAttributionAdvisoryBySession.delete(oldest);
		}
	}
	durableAttributionAdvisoryBySession.set(sessionID, { key, at: now });
	const session = swarmState.agentSessions.get(sessionID);
	if (session) {
		pushAdvisory(session, message);
	} else {
		// No live session to push the advisory to (the exact post-reset
		// window this fallback exists for) — leave a log trace so a dropped
		// advisory is not entirely silent, matching the write-failure paths
		// below which always log in addition to (or instead of) advising.
		logger.criticalWarn(`[guardrails] ${message}`);
	}
}

/**
 * Stage A workflow-transition write errors that indicate an attribution or
 * correlation miss — the post-reset wedge signature. These escalate beyond a
 * log line because every silent one is exactly how tasks wedge at
 * coder_delegated with no diagnostic. Duplicate transitions never throw
 * (isDuplicateTransition returns the existing evidence), so any throw here is
 * abnormal; TASK_WORKFLOW_TERMINAL and fencing codes stay warn-only because a
 * late gate result after close/settlement is expected churn, not a wedge.
 *
 * `TASK_WORKFLOW_GENERATION_MISMATCH` is deliberately EXCLUDED: it is a CAS
 * fencing code that fires during ordinary concurrent/parallel-lane operation
 * (a sibling transition legitimately bumped the generation between this
 * call's read and write), not only after a reset. Escalating it here would
 * turn a routine race into a false "run /swarm recover" advisory during
 * normal, non-reset operation.
 */
export const STAGE_A_ATTRIBUTION_MISS_CODES = new Set([
	'TASK_WORKFLOW_CODER_MUTATION_REQUIRED',
	'TASK_WORKFLOW_STAGE_A_REQUIRED',
]);

export function stageAWriteErrorCode(error: unknown): string | null {
	const message = error instanceof Error ? error.message : String(error);
	const match = /^[A-Z][A-Z0-9_]+/.exec(message);
	return match ? match[0] : null;
}

/**
 * Best-effort extraction of the file scope a gate-tool call declared, from
 * its raw tool args. Field names vary across the ~10 gate tools
 * (`isGateTool`); this covers the shapes actually used by tools whose result
 * can drive a durable Stage-A write (`files: string[]`) plus a defensive
 * `changed_files` array-of-object fallback. Returns `null` when no file
 * scope can be determined — callers must treat that as "cannot verify",
 * never as "no restriction".
 */
function extractGateCallFiles(args: unknown): string[] | null {
	if (!args || typeof args !== 'object') return null;
	const raw = (args as Record<string, unknown>).files;
	if (Array.isArray(raw)) {
		const files = raw.filter(
			(entry): entry is string => typeof entry === 'string' && entry !== '',
		);
		return files.length > 0 ? files : null;
	}
	const changed = (args as Record<string, unknown>).changed_files;
	if (Array.isArray(changed)) {
		const files = changed
			.map((entry) =>
				typeof entry === 'string'
					? entry
					: entry &&
							typeof entry === 'object' &&
							typeof (entry as { path?: unknown }).path === 'string'
						? (entry as { path: string }).path
						: null,
			)
			.filter((entry): entry is string => entry !== null && entry !== '');
		return files.length > 0 ? files : null;
	}
	return null;
}

type DurableAttributionResult =
	| { taskId: string }
	| { ambiguous: string[] }
	| { unbound: string; reason: 'files_mismatch' | 'truncated' }
	| null;

/**
 * Resolves gate-tool task attribution from durable state when the in-memory
 * `currentTaskId` chain is dead (the `/swarm reset-session` wedge: it wipes
 * `.swarm/session/` and clears every agent session, while committed coder
 * settlement WALs survive under `.swarm/coder-settlements/`). Eligible
 * candidates are COMMITTED settlements that attributed an accepted mutation
 * AND whose flat evidence store still sits at `coder_delegated` — i.e. tasks
 * that are genuinely awaiting their Stage A write.
 *
 * Conservative by design in three layers:
 * 1. Exactly one eligible (COMMITTED+accepted+coder_delegated) candidate is
 *    required. A lane still mid-dispatch (DISPATCHED/PREPARED) whose task is
 *    already at `coder_delegated` is not itself eligible but still widens
 *    the ambiguity set, so a second lane in flight cannot be silently
 *    invisible to this guard.
 * 2. A truncated settlement-WAL scan (more than 200 distinct historical
 *    task ids) cannot prove single-candidacy — a would-be second candidate
 *    could sort past the cap — so a truncated scan never resolves to a bare
 *    `taskId`, even with exactly one candidate found.
 * 3. The sole eligible candidate's declared/changed files (from its
 *    settlement WAL) must intersect the file scope the calling gate-tool
 *    call actually declared. Task-state cardinality alone does not prove the
 *    call's result is actually about that task — attributing a
 *    `pre_check_batch` run to the wrong task would corrupt the wrong task's
 *    lifecycle (the reducer accepts `stage_a_passed` from any
 *    `coder_delegated` state) or forge Stage-A proof for files that were
 *    never scanned.
 *
 * Any of the three failure modes returns `{ unbound }` (attribution refused,
 * advisory only) or `{ ambiguous }` rather than a guess. Zero candidates
 * means there is nothing durably attributable (the normal non-swarm flow)
 * and returns `null`.
 *
 * Bounded: reuses the settlement-WAL scan cap (200 files, unreadable-tolerant)
 * plus ≤200 evidence reads, and runs only on gate-tool calls whose in-memory
 * correlation is already missing — the bounded-but-not-free cost is accepted
 * for the narrow post-reset window rather than adding cross-call cache
 * invalidation risk.
 */
async function resolveDurableGateTaskId(
	directory: string,
	callerFiles: string[] | null,
): Promise<DurableAttributionResult> {
	try {
		const { states, truncated } = await listCoderSettlementWalStates(directory);
		const eligible: (typeof states)[number][] = [];
		const inFlightAtCoderDelegated = new Set<string>();
		for (const state of states) {
			if (!isStrictTaskId(state.taskId)) continue;
			if (state.state === 'DISPATCHED' || state.state === 'PREPARED') {
				const workflow = getTaskWorkflowSnapshot(
					await readTaskEvidence(directory, state.taskId),
				);
				if (workflow.state === 'coder_delegated') {
					inFlightAtCoderDelegated.add(state.taskId);
				}
				continue;
			}
			if (state.state !== 'COMMITTED') continue;
			if (state.accepted !== true) continue;
			const workflow = getTaskWorkflowSnapshot(
				await readTaskEvidence(directory, state.taskId),
			);
			if (workflow.state === 'coder_delegated') eligible.push(state);
		}
		const ambiguousIds = new Set<string>([
			...eligible.map((s) => s.taskId),
			...inFlightAtCoderDelegated,
		]);
		if (ambiguousIds.size > 1) return { ambiguous: [...ambiguousIds].sort() };
		if (eligible.length === 1) {
			const candidate = eligible[0];
			if (truncated) return { unbound: candidate.taskId, reason: 'truncated' };
			const declared = candidate.declaredFiles;
			// `declared` is already canonicalized when written to the WAL
			// (normalizeScopePath: forward slashes, no leading `./`, no
			// absolute paths — see src/scope/scope-binding.ts). The caller's
			// raw `files` argument is not, so a genuinely-matching file could
			// otherwise fail to bind on a `./`-prefix, backslash, or duplicate
			// separator alone; normalize it the same way before comparing.
			const normalizedCallerFiles =
				callerFiles !== null ? normalizeScopeFiles(callerFiles) : null;
			const bound =
				normalizedCallerFiles !== null &&
				normalizedCallerFiles.length > 0 &&
				declared !== null &&
				declared !== undefined &&
				declared.length > 0 &&
				// Exclude empty-string entries: an empty path is never a real
				// file scope, and treating '' === '' as a match would bind on
				// a shared "no scope declared" placeholder rather than a
				// genuine file-scope intersection.
				declared.some((f) => f !== '' && normalizedCallerFiles.includes(f));
			if (bound) return { taskId: candidate.taskId };
			return { unbound: candidate.taskId, reason: 'files_mismatch' };
		}
		return null;
	} catch (error) {
		warn('Durable gate attribution fallback failed', { error: String(error) });
		return null;
	}
}

/**
 * Issue #853 Layer B: tools that are structurally blocked while
 * `.swarm/spec-staleness.json` exists.
 */
export const SPEC_DRIFT_BLOCKED_TOOLS = new Set<string>([
	'save_plan',
	'update_task_status',
	'phase_complete',
	'lean_turbo_run_phase',
	'lean_turbo_acquire_locks',
]);

/**
 * Throw SPEC_DRIFT_BLOCK if the tool is on the block-list and the
 * spec-staleness marker file exists. The error message includes a unified
 * diff of the recorded vs current spec content so the user can see what
 * changed (FR-001).
 */
export function enforceSpecDriftGate(
	directory: string | undefined,
	toolName: string,
): void {
	if (!directory) return;
	if (!SPEC_DRIFT_BLOCKED_TOOLS.has(toolName)) return;
	const stalePath = path.join(directory, '.swarm', 'spec-staleness.json');
	if (fsSync.existsSync(stalePath)) {
		let diffInfo: { diff: string; changedSections: string[] } | null = null;
		try {
			diffInfo = computeSpecDiff(directory);
		} catch {
			// Non-fatal: diff computation failure falls back to bare block message
		}

		let message =
			`SPEC_DRIFT_BLOCK: tool "${toolName}" is blocked because .swarm/spec-staleness.json exists. ` +
			'Run /swarm clarify to enter spec repair mode. Clarify alone does not clear drift: rewrite the spec so recovery can reconcile it, or run /swarm acknowledge-spec-drift to dismiss, then retry.';

		if (diffInfo) {
			const sectionSummary =
				diffInfo.changedSections.length > 0
					? `\nChanged sections: ${diffInfo.changedSections.map((s) => `## ${s}`).join(', ')}`
					: '';
			message +=
				'\n\n--- spec diff (recorded vs current) ---' +
				sectionSummary +
				'\n[Begin spec diff]\n' +
				diffInfo.diff +
				'\n[End spec diff]';
		} else {
			message += '\n\n(no recorded snapshot to diff against)';
		}

		throw new Error(message);
	}
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return (
		typeof value === 'object' &&
		value !== null &&
		(value.constructor === Object || Object.getPrototypeOf(value) === null)
	);
}

function readSignalField(
	source: Record<string, unknown>,
	key: string,
): unknown {
	try {
		return source[key];
	} catch {
		return undefined;
	}
}

function pushSignalValue(parts: string[], value: unknown): void {
	if (typeof value === 'string') {
		parts.push(value);
		return;
	}
	if (typeof value === 'number' || typeof value === 'boolean') {
		parts.push(String(value));
	}
}

function appendSelectedFields(
	parts: string[],
	source: Record<string, unknown>,
	keys: readonly string[],
): void {
	for (const key of keys) {
		pushSignalValue(parts, readSignalField(source, key));
	}
}

function appendNestedErrorSignal(parts: string[], value: unknown): void {
	if (typeof value === 'string') {
		parts.push(value);
		return;
	}
	if (value instanceof Error) {
		parts.push(value.name, value.message);
		appendSelectedFields(parts, value as unknown as Record<string, unknown>, [
			'code',
			'status',
			'statusCode',
		]);
		return;
	}
	if (!isPlainObject(value)) return;
	appendSelectedFields(parts, value, [
		'code',
		'status',
		'statusCode',
		'message',
		'error_type',
	]);
}

/**
 * Extracts bounded provider/error signal from unknown hook error payloads.
 */
function extractErrorSignal(errorContent: unknown): string {
	if (typeof errorContent === 'string') return errorContent;
	if (errorContent == null) return '';

	const parts: string[] = [];

	try {
		if (errorContent instanceof Error) {
			parts.push(errorContent.name, errorContent.message);
			appendSelectedFields(
				parts,
				errorContent as unknown as Record<string, unknown>,
				['code', 'status', 'statusCode'],
			);
			return parts.join(' ');
		}

		if (!isPlainObject(errorContent)) return '';

		appendSelectedFields(parts, errorContent, [
			'code',
			'status',
			'statusCode',
			'message',
			'error_type',
		]);

		appendNestedErrorSignal(parts, readSignalField(errorContent, 'error'));
		const metadata = readSignalField(errorContent, 'metadata');
		if (isPlainObject(metadata)) {
			appendSelectedFields(parts, metadata, [
				'code',
				'status',
				'statusCode',
				'error_type',
			]);
		}
		appendNestedErrorSignal(parts, readSignalField(errorContent, 'cause'));
	} catch {
		return parts.join(' ');
	}

	return parts.join(' ');
}

/**
 * v6.33.1: No-op work detector state.
 *
 * AGENTS.md invariant 8: module-level, session-keyed state must have an explicit
 * eviction strategy. Both containers below are keyed by `sessionID` and were
 * previously unbounded — they grew for the lifetime of the plugin process, since
 * nothing removed a key when a session ended. `noOpWarningIssued` was only ever
 * `delete`d on a reset, and `toolCallsSinceLastWrite` never shrank at all.
 *
 * Bounded LRU, evicting the LEAST-RECENTLY-TOUCHED session.
 *
 * Plain insertion-order (FIFO) eviction is wrong here and actively harmful.
 * `Map.set()` on an EXISTING key does not move it, so the first session created
 * in the process stays permanently at the front of the iteration order. In an
 * OpenCode plugin process that first session is the architect — the very session
 * this detector exists to watch — making it the guaranteed first eviction victim
 * while a session touched once and abandoned later survives. Measured: with a
 * FIFO bound, an architect climbing toward the threshold had its counter evicted
 * and reset mid-climb, and its 15th consecutive no-write call produced ZERO
 * warnings. A bound must not silence the detector it was added to protect.
 *
 * {@link touchNoOpSession} therefore deletes before setting, moving the key to
 * the back on every touch, so eviction genuinely targets quiet sessions.
 */
export const MAX_TRACKED_NO_OP_SESSIONS = 200;
const toolCallsSinceLastWrite = new Map<string, number>();
const noOpWarningIssued = new Set<string>();
/**
 * Issue #2063 B2 — latch for STAGE 2 of the no-op ladder, deliberately DISTINCT
 * from {@link noOpWarningIssued}.
 *
 * Stage 1 latches at `no_op_warning_threshold` and stays latched until a write
 * or dispatch. A single shared latch would therefore make stage 2 unreachable:
 * by the time the count doubles, the latch that stage 2 would test is already
 * held by stage 1, so the strong advisory could never fire. The whole point of
 * the ladder is that an agent which ignores the first observation gets a
 * sharper one, so the two rungs need independent latches.
 *
 * Both latches clear together on the same progress events.
 */
const noOpStrongWarningIssued = new Set<string>();

/**
 * Record a session's no-write counter, refreshing its recency. The `delete`
 * before `set` is load-bearing: it is what makes the eviction order
 * least-recently-touched rather than first-inserted.
 */
function touchNoOpSession(sessionID: string, count: number): void {
	toolCallsSinceLastWrite.delete(sessionID);
	toolCallsSinceLastWrite.set(sessionID, count);
	evictNoOpStateIfOverBound();
}

/**
 * Evict least-recently-touched entries from the no-op detector's session state
 * when either container exceeds {@link MAX_TRACKED_NO_OP_SESSIONS}. Called from
 * {@link touchNoOpSession} and from the warning-latch insertion, i.e. at every
 * site that can grow either container.
 */
function evictNoOpStateIfOverBound(): void {
	while (toolCallsSinceLastWrite.size > MAX_TRACKED_NO_OP_SESSIONS) {
		const stalestKey = toolCallsSinceLastWrite.keys().next().value;
		if (stalestKey === undefined) break;
		toolCallsSinceLastWrite.delete(stalestKey);
		// Drop the paired warning latches with it, so an evicted session cannot
		// come back with a stale "already warned" flag and never warn again.
		noOpWarningIssued.delete(stalestKey);
		noOpStrongWarningIssued.delete(stalestKey);
	}
	// The latch Sets are normally subsets of the counter map, but they are not
	// guaranteed to be: a session evicted by the loop above can be re-added as a
	// latch in the same invocation, leaving a latch with no counter. Bound them
	// independently rather than relying on the subset argument.
	while (noOpWarningIssued.size > MAX_TRACKED_NO_OP_SESSIONS) {
		const stalestKey = noOpWarningIssued.values().next().value;
		if (stalestKey === undefined) break;
		noOpWarningIssued.delete(stalestKey);
	}
	while (noOpStrongWarningIssued.size > MAX_TRACKED_NO_OP_SESSIONS) {
		const stalestKey = noOpStrongWarningIssued.values().next().value;
		if (stalestKey === undefined) break;
		noOpStrongWarningIssued.delete(stalestKey);
	}
}

/**
 * Extracts phase number from a phase string like "Phase 3: Implementation".
 */
function extractPhaseNumber(phaseString: string | null): number {
	if (!phaseString) return 1;
	const match = phaseString.match(/^Phase (\d+):/);
	return match ? parseInt(match[1], 10) : 1;
}

/**
 * Detects if a tool is a write-class tool that modifies file contents.
 */
function isWriteTool(toolName: string): boolean {
	const normalized = normalizeToolName(toolName);
	return (WRITE_TOOL_NAMES as readonly string[]).includes(normalized);
}

/**
 * Redacts sensitive values from a shell command string before audit logging.
 * Single-sourced from ./helpers (which additionally redacts home paths).
 */
export { redactShellCommand } from './helpers';

/**
 * v6.12: Detects if a tool is a Stage A automated gate tool
 */
function isGateTool(toolName: string): boolean {
	const normalized = normalizeToolName(toolName);
	const gateTools = [
		'diff',
		'syntax_check',
		'placeholder_scan',
		'imports',
		'lint',
		'build_check',
		'pre_check_batch',
		'secretscan',
		'sast_scan',
		'quality_budget',
	];
	return gateTools.includes(normalized);
}

/**
 * v6.12: Detects if a tool call is an agent delegation (Task tool with subagent_type)
 */
function isAgentDelegation(
	toolName: string,
	args: unknown,
): { isDelegation: boolean; targetAgent: string | null } {
	const normalized = normalizeToolName(toolName);
	if (normalized !== 'Task' && normalized !== 'task') {
		return { isDelegation: false, targetAgent: null };
	}

	const argsObj = args as Record<string, unknown> | undefined;
	if (!argsObj) {
		return { isDelegation: false, targetAgent: null };
	}

	const subagentType = argsObj.subagent_type;
	if (typeof subagentType === 'string') {
		return {
			isDelegation: true,
			targetAgent: stripKnownSwarmPrefix(subagentType),
		};
	}

	return { isDelegation: false, targetAgent: null };
}

/**
 * Creates guardrails hooks for circuit breaker protection
 * @param directory Working directory from plugin init context (required)
 * @param directoryOrConfig Guardrails configuration object (when passed as second arg, replaces legacy config param)
 * @param config Guardrails configuration (optional)
 * @returns Tool before/after hooks and messages transform hook
 */
export function createGuardrailsHooks(
	directory: string,
	directoryOrConfig?: string | GuardrailsConfig,
	config?: GuardrailsConfig,
	authorityConfig?: AuthorityConfig,
	worktreeBaseDirOverrides?: string[],
	resolveAgentModel?: (agentName: string) => string | undefined,
): {
	toolBefore: (
		input: { tool: string; sessionID: string; callID: string },
		output: { args: unknown },
	) => Promise<void>;
	toolAfter: (
		input: {
			tool: string;
			sessionID: string;
			callID: string;
			args?: Record<string, unknown>;
		},
		output: { title: string; output: string; metadata: unknown },
	) => Promise<void>;
	messagesTransform: (
		input: Record<string, never>,
		output: {
			messages?: Array<{
				info: { role: string; agent?: string; sessionID?: string };
				parts: Array<{ type: string; text?: string; [key: string]: unknown }>;
			}>;
		},
	) => Promise<void>;
} {
	// Backward compatibility: detect if called with legacy signature (config only)
	let guardrailsConfig: GuardrailsConfig | undefined;

	if (directory && typeof directory === 'object' && 'enabled' in directory) {
		logger.warn(
			'[guardrails] Legacy call without directory, falling back to process.cwd()',
		);
		guardrailsConfig = directory as GuardrailsConfig;
	} else if (
		directoryOrConfig &&
		typeof directoryOrConfig === 'object' &&
		'enabled' in directoryOrConfig
	) {
		guardrailsConfig = directoryOrConfig as GuardrailsConfig;
	} else {
		guardrailsConfig = config;
	}

	// Normalize directory
	const effectiveDirectory = (() => {
		if (typeof directory === 'string') return directory;
		const cwd = process.cwd();
		logger.warn(
			`[guardrails] effectiveDirectory resolved to process.cwd() "${cwd}" — ` +
				'pass an explicit directory string to createGuardrailsHooks to avoid .swarm artifacts in wrong locations',
		);
		return cwd;
	})();

	// If guardrails are disabled, return no-op handlers
	if (guardrailsConfig?.enabled === false) {
		return {
			toolBefore: async () => {},
			toolAfter: async () => {},
			messagesTransform: async () => {},
		};
	}

	// Pre-compute effective authority rules once
	const precomputedAuthorityRules = buildEffectiveRules(authorityConfig);

	// Merge user-supplied verifier config globs into architect's blockedGlobs
	const verifierPaths = authorityConfig?.verifier_config_paths;
	if (verifierPaths && verifierPaths.length > 0) {
		const existingArchitect = precomputedAuthorityRules.architect ?? {};
		precomputedAuthorityRules.architect = {
			...existingArchitect,
			blockedGlobs: [
				...(existingArchitect.blockedGlobs ?? []),
				...verifierPaths,
			],
		};
	}

	const universalDenyPrefixes: string[] =
		authorityConfig?.universal_deny_prefixes ?? [];

	const cfg = guardrailsConfig!;
	const requiredQaGates = cfg.qa_gates?.required_tools ?? [
		'diff',
		'syntax_check',
		'placeholder_scan',
		'lint',
		'pre_check_batch',
	];
	const requireReviewerAndTestEngineer =
		cfg.qa_gates?.require_reviewer_test_engineer ?? true;

	const interpreterAllowedAgents: string[] | undefined =
		cfg.interpreter_allowed_agents;

	const shellAuditEnabled: boolean = cfg.shell_audit_log ?? true;

	// Shared consecutiveNoToolTurns Map (shared between toolBefore and messagesTransform)
	const consecutiveNoToolTurns = new Map<string, number>();
	// Issue #2063 B3: sessionID → id of the assistant turn the MEDIUM band last
	// counted. Owned by messagesTransform (producer and consumer both live
	// there); declared here so it shares the handler's lifetime, exactly like
	// consecutiveNoToolTurns. Bounded inside messages-transform.ts.
	const lastCountedAssistantMsgId = new Map<string, string>();
	const pendingReviewerScopeWrites = new Map<
		string,
		Array<{
			parentSessionID: string;
			taskId: string;
			coderCallID: string;
			file: string;
		}>
	>();
	const pendingGateTasksBySession = new Map<
		string,
		Map<string, { sessionID: string; taskId: string; generation: number }>
	>();
	const takePendingGateTask = (sessionID: string, callID: string) => {
		const sessionTasks = pendingGateTasksBySession.get(sessionID);
		const pending = sessionTasks?.get(callID);
		if (sessionTasks) {
			sessionTasks.delete(callID);
			if (sessionTasks.size === 0) pendingGateTasksBySession.delete(sessionID);
		}
		return pending;
	};
	const rememberPendingGateTask = (
		sessionID: string,
		callID: string,
		taskId: string,
		generation: number,
	): void => {
		let sessionTasks = pendingGateTasksBySession.get(sessionID);
		if (!sessionTasks) {
			if (pendingGateTasksBySession.size >= MAX_PENDING_GATE_RECEIPT_SESSIONS) {
				throw new Error(
					'GATE_RECEIPT_CAPACITY: too many sessions have live gate calls; wait for a pending gate call to finish',
				);
			}
			sessionTasks = new Map();
			pendingGateTasksBySession.set(sessionID, sessionTasks);
		}
		if (
			!sessionTasks.has(callID) &&
			sessionTasks.size >= MAX_PENDING_GATE_RECEIPTS_PER_SESSION
		) {
			throw new Error(
				'GATE_RECEIPT_CAPACITY: this session has too many live gate calls; wait for a pending gate call to finish',
			);
		}
		sessionTasks.set(callID, { sessionID, taskId, generation });
	};
	const scopeLeaseRenewal = createScopeLeaseRenewalTracker();
	const rememberReviewerScopeWrite = (input: {
		callID: string;
		parentSessionID: string;
		taskId: string;
		coderCallID: string;
		file: string;
	}): void => {
		if (
			!pendingReviewerScopeWrites.has(input.callID) &&
			pendingReviewerScopeWrites.size >= 256
		) {
			const oldest = pendingReviewerScopeWrites.keys().next().value;
			if (oldest !== undefined) pendingReviewerScopeWrites.delete(oldest);
		}
		const pending = pendingReviewerScopeWrites.get(input.callID) ?? [];
		const candidate = {
			parentSessionID: input.parentSessionID,
			taskId: input.taskId,
			coderCallID: input.coderCallID,
			file: input.file,
		};
		const duplicate = pending.some(
			(entry) =>
				entry.parentSessionID === candidate.parentSessionID &&
				entry.taskId === candidate.taskId &&
				entry.coderCallID === candidate.coderCallID &&
				entry.file === candidate.file,
		);
		if (!duplicate && pending.length < 256) pending.push(candidate);
		pendingReviewerScopeWrites.set(input.callID, pending);
	};

	/**
	 * Issue #2063 B5 — execution-stall knobs for the toolAfter side.
	 *
	 * Reads the TOP-LEVEL `cfg`, matching `tool-before.ts`. Not an oversight:
	 * `GuardrailsProfileSchema` (schema.ts:916-924) is a closed seven-key budget
	 * subset and Zod strips unknown keys, so a per-agent
	 * `profiles.<agent>.execution_stall_*` (or `enabled`) is dropped at parse time
	 * and `resolveGuardrailsConfig` provably returns the base value for all four.
	 * See the longer note at the matching site in `tool-before.ts`; the assumption
	 * is pinned by `tests/unit/hooks/execution-stall-wiring.test.ts`.
	 */
	const executionStallOptions = {
		enabled: cfg.enabled,
		warnCalls: cfg.execution_stall_warn_calls,
		stopCalls: cfg.execution_stall_stop_calls,
		episodeMinutes: cfg.execution_stall_episode_minutes,
	};

	// Create toolBefore handler via factory
	const baseToolBefore = createToolBeforeHandler({
		effectiveDirectory,
		cfg,
		precomputedAuthorityRules,
		universalDenyPrefixes,
		shellAuditEnabled,
		interpreterAllowedAgents,
		authorityConfig,
		consecutiveNoToolTurns,
		worktreeBaseDirOverrides,
		rememberReviewerScopeWrite,
		rememberScopeLeaseCandidate: scopeLeaseRenewal.remember,
		getSandboxExecutor: _internals.getSandboxExecutor,
		assessSandboxEnforcement: _internals.assessSandboxEnforcement,
	});
	const toolBefore: ReturnType<typeof createToolBeforeHandler> = async (
		input,
		output,
	) => {
		if (isGateTool(input.tool)) {
			let taskId = swarmState.agentSessions.get(input.sessionID)?.currentTaskId;
			if (!taskId) {
				// Post-reset durable attribution fallback: reset-session wiped the
				// in-memory chain (currentTaskId/lastCoderDelegationTaskId), so
				// resolve the task from committed settlement WALs before giving up
				// and silently skipping every Stage A write.
				const callerFiles = extractGateCallFiles(output.args);
				const fallback = await _internals.resolveDurableGateTaskId(
					effectiveDirectory,
					callerFiles,
				);
				if (fallback) {
					if ('taskId' in fallback) {
						taskId = fallback.taskId;
					} else if ('ambiguous' in fallback && fallback.ambiguous.length > 0) {
						const shown = fallback.ambiguous.slice(0, 10);
						const more = fallback.ambiguous.length - shown.length;
						emitDurableAttributionAdvisory(
							input.sessionID,
							`${effectiveDirectory}\u0000${fallback.ambiguous.join(',')}`,
							`STAGE A ATTRIBUTION AMBIGUOUS: ${fallback.ambiguous.length} tasks are settled at coder_delegated (${shown.join(', ')}${more > 0 ? `, +${more} more` : ''}) but this session has no task correlation after reset-session. Stage A evidence cannot be attributed safely. Run /swarm recover to repair Stage A attribution, then re-run the gate.`,
						);
					} else if ('unbound' in fallback) {
						emitDurableAttributionAdvisory(
							input.sessionID,
							`${effectiveDirectory}\u0000unbound\u0000${fallback.unbound}`,
							fallback.reason === 'truncated'
								? `STAGE A ATTRIBUTION UNVERIFIABLE: task ${fallback.unbound} looks like the sole durable candidate at coder_delegated, but the settlement scan is truncated (more than 200 historical settlements) so a second candidate cannot be ruled out. Stage A evidence cannot be safely attributed. Run /swarm recover ${fallback.unbound} if this task is genuinely wedged.`
								: `STAGE A ATTRIBUTION UNBOUND: task ${fallback.unbound} is the sole durable candidate at coder_delegated, but this gate call's scanned files do not match its declared changes (or no file scope was provided). Stage A evidence cannot be safely attributed. Run /swarm recover ${fallback.unbound} if this task is genuinely wedged.`,
						);
					}
				}
			}
			if (taskId) {
				const workflow = isStrictTaskId(taskId)
					? getTaskWorkflowSnapshot(
							await readTaskEvidence(effectiveDirectory, taskId),
						)
					: null;
				rememberPendingGateTask(
					input.sessionID,
					input.callID,
					taskId,
					workflow?.generation ?? 0,
				);
			}
		}
		try {
			await baseToolBefore(input, output);
		} catch (error) {
			takePendingGateTask(input.sessionID, input.callID);
			throw error;
		}
	};

	// Create messagesTransform handler via factory
	const messagesTransform = createMessagesTransformHandler({
		effectiveDirectory,
		cfg,
		requiredQaGates,
		requireReviewerAndTestEngineer,
		consecutiveNoToolTurns,
		lastCountedAssistantMsgId,
		resolveAgentModel,
	});

	return {
		toolBefore,
		toolAfter: async (input, output) => {
			const pendingGateTask =
				takePendingGateTask(input.sessionID, input.callID) ??
				(_internals.allowUncorrelatedGateReceipts
					? (() => {
							const testSession = swarmState.agentSessions.get(input.sessionID);
							return testSession
								? {
										sessionID: input.sessionID,
										taskId:
											testSession.currentTaskId ?? `${input.sessionID}:unknown`,
										generation:
											testSession.currentTaskId &&
											isStrictTaskId(testSession.currentTaskId)
												? (testSession.taskWorkflowCache?.get(
														testSession.currentTaskId,
													)?.generation ?? 0)
												: 0,
									}
								: undefined;
						})()
					: undefined);
			const pendingReviewerScopeWrite = pendingReviewerScopeWrites.get(
				input.callID,
			);
			pendingReviewerScopeWrites.delete(input.callID);
			const correlatedExecution = takeToolExecution(
				input.sessionID,
				input.callID,
			);
			if (
				correlatedExecution &&
				!isToolExecutionCurrent(input.sessionID, correlatedExecution)
			) {
				await scopeLeaseRenewal.consume({ ...input, output: null });
				return;
			}
			// OpenCode should provide a ToolResult-shaped object, but malformed or
			// third-party hook payloads must not crash the plugin's after-hook. Keep a
			// safe shape for downstream bookkeeping while classifying it as unknown so
			// it cannot erase an existing non-transient circuit.
			const malformedOutput = !output || typeof output !== 'object';
			const safeOutput = malformedOutput
				? { title: '', output: '', metadata: null }
				: output;
			await scopeLeaseRenewal.consume({
				...input,
				output: malformedOutput ? null : safeOutput,
			});
			// v6.12: Gate completion tracking (moved above window check for architect sessions)
			const session = swarmState.agentSessions.get(input.sessionID);
			if (session) {
				// Track gate tools
				if (
					isGateTool(input.tool) &&
					pendingGateTask?.sessionID === input.sessionID
				) {
					const taskId = pendingGateTask.taskId;
					if (!session.gateLog.has(taskId)) {
						session.gateLog.set(taskId, new Set());
					}
					session.gateLog.get(taskId)?.add(input.tool);

					// Track gate failures for Task 2.5. The batch result has an
					// exact structured contract; nested diagnostic text is data.
					const outputStr =
						typeof safeOutput.output === 'string' ? safeOutput.output : '';
					if (normalizeToolName(input.tool) === 'pre_check_batch') {
						const verdict = decodePreCheckResult(safeOutput.output);
						if (verdict.kind === 'fail' || verdict.kind === 'invalid') {
							session.lastGateFailure = {
								tool: input.tool,
								taskId,
								timestamp: Date.now(),
								code: verdict.code,
							};
							if (verdict.kind === 'fail' && isStrictTaskId(taskId))
								try {
									const updated = await transitionTaskWorkflowEvidence(
										effectiveDirectory,
										taskId,
										{
											type: 'stage_a_failed',
											expectedGeneration: pendingGateTask.generation,
											transitionId: `pre-check:${input.callID}`,
										},
									);
									const next = getTaskWorkflowSnapshot(updated);
									session.taskWorkflowStates.set(taskId, next.state);
									updateTaskWorkflowCache(session, taskId, next);
								} catch (err) {
									const code = stageAWriteErrorCode(err);
									if (code && STAGE_A_ATTRIBUTION_MISS_CODES.has(code)) {
										logger.criticalWarn(
											`[guardrails] Stage A failure write failed for task ${taskId}: ${code}. Run /swarm recover ${taskId}.`,
										);
										pushAdvisory(
											session,
											`STAGE A WRITE FAILED (${code}) for task ${taskId}: pre_check_batch failed but the rework transition was rejected. Run /swarm recover ${taskId} to repair attribution.`,
										);
									} else {
										warn('Failed to persist Stage A failure', {
											taskId,
											error: String(err),
										});
									}
								}
						} else if (verdict.kind === 'pass') {
							if (
								session.lastGateFailure?.taskId === taskId &&
								normalizeToolName(session.lastGateFailure.tool) ===
									'pre_check_batch'
							) {
								session.lastGateFailure = null;
							}
							if (!isStrictTaskId(taskId)) {
								advanceTaskState(session, taskId, 'pre_check_passed');
							}
							try {
								const updated = await transitionTaskWorkflowEvidence(
									effectiveDirectory,
									taskId,
									{
										type: 'stage_a_passed',
										expectedGeneration: pendingGateTask.generation,
										transitionId: `pre-check:${input.callID}`,
									},
								);
								const next = getTaskWorkflowSnapshot(updated);
								session.taskWorkflowStates.set(taskId, next.state);
								updateTaskWorkflowCache(session, taskId, next);
							} catch (err) {
								// Duplicate transitions return existing evidence without
								// throwing, so any error here is abnormal. Attribution-miss
								// codes are exactly how tasks silently wedge at
								// coder_delegated post-reset — escalate them to a visible
								// advisory instead of swallowing (TASK_WORKFLOW_TERMINAL and
								// WAL-fencing codes stay log-only: late gate results after
								// close/settlement are expected churn, not a wedge).
								const code = stageAWriteErrorCode(err);
								if (code && STAGE_A_ATTRIBUTION_MISS_CODES.has(code)) {
									logger.criticalWarn(
										`[guardrails] Stage A write failed for task ${taskId}: ${code} — pre_check_batch result was NOT attributed. Run /swarm recover ${taskId}.`,
									);
									pushAdvisory(
										session,
										`STAGE A WRITE FAILED (${code}) for task ${taskId}: pre_check_batch passed but the workflow transition was rejected, so Stage B dispatches will be denied with TASK_WORKFLOW_STAGE_A_REQUIRED. Run /swarm recover ${taskId} to repair attribution.`,
									);
								} else {
									// Non-fatal: state may already be at or past pre_check_passed
									warn(
										'Failed to advance task state after pre_check_batch pass',
										{
											taskId,
											error: String(err),
										},
									);
								}
							}
						}
					} else {
						const hasFailure =
							safeOutput.output === null ||
							safeOutput.output === undefined ||
							outputStr.includes('FAIL') ||
							outputStr.includes('error') ||
							outputStr.toLowerCase().includes('gates_passed: false');
						if (hasFailure) {
							session.lastGateFailure = {
								tool: input.tool,
								taskId,
								timestamp: Date.now(),
							};
						} else if (
							session.lastGateFailure?.taskId === taskId &&
							normalizeToolName(session.lastGateFailure.tool) ===
								normalizeToolName(input.tool)
						) {
							session.lastGateFailure = null;
						}
					}
				}

				// v6.12: Track reviewer AND test_engineer delegations
				const inputArgs = input.args ?? getStoredInputArgs(input.callID);
				const delegation = isAgentDelegation(input.tool, inputArgs);
				if (
					delegation.isDelegation &&
					(delegation.targetAgent === 'reviewer' ||
						delegation.targetAgent === 'test_engineer')
				) {
					let currentPhase = 1;
					try {
						const plan = await loadPlan(effectiveDirectory);
						if (plan) {
							const phaseString = extractCurrentPhaseFromPlan(plan);
							currentPhase = extractPhaseNumber(phaseString);
						}
					} catch (error) {
						log('[Guardrails] loadPlan failed during reviewer tracking', {
							error: error instanceof Error ? error.message : String(error),
						});
					}
					const count = session.reviewerCallCount.get(currentPhase) ?? 0;
					session.reviewerCallCount.set(currentPhase, count + 1);
				}

				// v6.17 Task 9.3: Track currentTaskId when coder delegation completes
				if (delegation.isDelegation && delegation.targetAgent === 'coder') {
					const exactGeneration = getReviewerScopeGenerationForCoderCall({
						parentSessionID: input.sessionID,
						coderCallID: input.callID,
					});
					const completedTaskId =
						exactGeneration?.taskId ?? session.lastCoderDelegationTaskId;
					if (completedTaskId) {
						session.currentTaskId = completedTaskId;
						const exactGenerationFiles =
							exactGeneration?.modifiedFiles ??
							session.modifiedFilesThisCoderTask;
						if (!session.revisionLimitHit) {
							session.coderRevisions++;
							if (session.coderRevisions > 1 && session.qaSkipCount === 0) {
								let conflictPhase = 1;
								try {
									const plan = await loadPlan(effectiveDirectory);
									if (plan) {
										conflictPhase = extractPhaseNumber(
											extractCurrentPhaseFromPlan(plan),
										);
									}
								} catch {
									// Non-fatal: default to phase 1
								}
								resolveAgentConflict({
									sessionID: input.sessionID,
									phase: conflictPhase,
									taskId: session.currentTaskId ?? undefined,
									sourceAgent: 'reviewer',
									targetAgent: 'coder',
									conflictType: 'feedback_rejection',
									rejectionCount: session.coderRevisions - 1,
									summary: `Coder revision ${session.coderRevisions} for task ${session.currentTaskId ?? 'unknown'}`,
								});
								session.lastDelegationReason = 'review_rejected';
							}
							const maxRevisions = cfg.max_coder_revisions ?? 5;
							if (session.coderRevisions >= maxRevisions) {
								session.revisionLimitHit = true;
								telemetry.revisionLimitHit(input.sessionID, session.agentName);
								pushAdvisory(
									session,
									`CODER REVISION LIMIT: Agent has been revised ${session.coderRevisions} times ` +
										`(max: ${maxRevisions}) for task ${session.currentTaskId ?? 'unknown'}. ` +
										`Escalate to user or consider a fundamentally different approach.`,
								);
								swarmState.pendingEvents++;
							}
						}
						session.partialGateWarningsIssuedForTask?.delete(
							session.currentTaskId,
						);

						// v6.21 Task 5.4: Scope containment check
						if (session.declaredCoderScope !== null) {
							const undeclaredFiles = exactGenerationFiles
								.map((f) => f.replace(/[\r\n\t]/g, '_'))
								.filter(
									(f) =>
										!isInDeclaredScope(
											f,
											session.declaredCoderScope!,
											directory,
										),
								);
							if (undeclaredFiles.length >= 1) {
								const safeTaskId = String(session.currentTaskId ?? '').replace(
									/[\r\n\t]/g,
									'_',
								);
								session.lastScopeViolation =
									`Scope violation for task ${safeTaskId}: ` +
									`${undeclaredFiles.length} undeclared files modified: ` +
									undeclaredFiles.join(', ');
								session.scopeViolationDetected = true;
								telemetry.scopeViolation(
									input.sessionID,
									session.agentName,
									session.currentTaskId ?? 'unknown',
									'undeclared files modified',
								);
							}
						}
						session.modifiedFilesThisCoderTask = [];
					}
				}
			}

			// Issue #2063 B5 — execution-stall progress/arming events.
			//
			// Placed with the no-op detector because it is the same class of
			// bookkeeping over the same signal (did this session make progress?),
			// and above it so a progress event is recorded before the advisory
			// ladder reads its own counters. Never throws.
			//
			// `input.args` is passed through unchanged: the SDK's toolAfter input
			// carries no args for the architect, which is exactly why the module
			// remembers the dispatched role at toolBefore time instead of relying
			// on it — see `pendingDispatchRoles` there.
			// Issue #2472 W7: awaited because the recorder's workspace captures
			// route through the bounded async snapshot twin — an un-awaited call
			// would let the no-op detector below read pre-probe counters.
			await recordExecutionStallToolAfter({
				sessionID: input.sessionID,
				tool: input.tool,
				callID: input.callID,
				args:
					input.args ??
					(getStoredInputArgs(input.callID) as
						| Record<string, unknown>
						| undefined),
				output: safeOutput,
				directory: effectiveDirectory,
				options: executionStallOptions,
			});

			// v6.33.1: No-op work detector
			const sessionId = input.sessionID;
			const normalizedToolName = normalizeToolName(input.tool);
			// Handing work to a subagent IS progress, and it is the ONLY kind of
			// progress an orchestrating architect makes.
			//
			// Before this, the counter reset solely on `isWriteTool`. A subagent's
			// writes land under a DIFFERENT sessionID, and this counter is keyed by
			// `input.sessionID`, so those writes could never reset the architect's
			// count. An architect that delegates and reads therefore climbed toward
			// the "you may be stuck" warning forever — in every mode, not just PR
			// review: deep-dive, council, research, consult, discover, issue
			// tracing, plain planning.
			//
			// Both dispatch mechanisms count. `isAgentDelegation` matches only
			// `Task`/`task` (see its early return), but `/swarm pr-review` dispatches
			// its lanes through `dispatch_lanes_async` — and the `task` tool is
			// BLOCKED outright while a PR_REVIEW gate is active
			// (pr-workflow-gate.ts, "PR_REVIEW is read-only and fail-closed").
			// Keying on `Task` alone would therefore have left the originally
			// reported case — a PR review told it was stuck — completely unfixed.
			const laneDispatchTools = new Set([
				'dispatch_lanes',
				'dispatch_lanes_async',
			]);
			const isSubagentDispatch =
				laneDispatchTools.has(normalizedToolName) ||
				isAgentDelegation(
					input.tool,
					input.args ?? getStoredInputArgs(input.callID),
				).isDelegation;
			if (isWriteTool(normalizedToolName) || isSubagentDispatch) {
				touchNoOpSession(sessionId, 0);
				// Issue #2063 B2: BOTH ladder latches re-arm on progress. Leaving the
				// stage-2 latch set would silence the strong rung for the remaining
				// life of the session after a single episode.
				noOpWarningIssued.delete(sessionId);
				noOpStrongWarningIssued.delete(sessionId);
			} else {
				const count = (toolCallsSinceLastWrite.get(sessionId) ?? 0) + 1;
				touchNoOpSession(sessionId, count);
				const threshold = cfg.no_op_warning_threshold ?? 15;
				// Issue #2063 B2 stage 2 — no new config key by design. The strong
				// rung is derived as 2× the stage-1 threshold so a user who tunes
				// `no_op_warning_threshold` moves the whole ladder coherently instead
				// of having to keep two knobs consistent.
				const strongThreshold = threshold * 2;
				if (
					count >= threshold &&
					!noOpWarningIssued.has(sessionId) &&
					session?.pendingAdvisoryMessages
				) {
					noOpWarningIssued.add(sessionId);
					// BL-B: the latch Set can grow here independently of the counter
					// map, so it needs its own bound check — the "it is a subset"
					// argument does not hold in the self-eviction case.
					evictNoOpStateIfOverBound();
					// The old text advised `/swarm handoff`, which resets the session —
					// discarding exactly the context an orchestrating architect has
					// been assembling. Advice that destroys the user's work is worse
					// than no advice, so the recovery hint is gone; the observation
					// remains. Route through pushAdvisory for dedupe + cap (issue #1976).
					pushAdvisory(
						session,
						`WARNING: Agent has made ${count} tool calls with no file modifications and no subagent dispatches. If you are stuck, state what is blocking you and report BLOCKED rather than continuing to probe.`,
					);
				}
				// Deliberately a separate `if`, not an `else if`: a session that
				// crosses both rungs in one call (possible after an eviction dropped
				// its latches mid-climb) must still receive the strong rung.
				//
				// Advisory-only, like stage 1. Read-only modes (deep-dive, council,
				// research, consult, PR review) legitimately make hundreds of
				// non-write calls, so denying here would break correct workflows; the
				// hard levers for a genuinely wedged session live elsewhere in the
				// containment set.
				if (
					count >= strongThreshold &&
					!noOpStrongWarningIssued.has(sessionId) &&
					session?.pendingAdvisoryMessages
				) {
					noOpStrongWarningIssued.add(sessionId);
					evictNoOpStateIfOverBound();
					pushAdvisory(
						session,
						`CRITICAL: Agent has made ${count} tool calls with no file modifications and no subagent dispatches — twice the point at which you were first warned. STOP investigating; report BLOCKED to the user now with what you tried.`,
					);
					telemetry.noOpStrongWarning(
						sessionId,
						session.agentName,
						count,
						strongThreshold,
					);
				}
			}

			const outcome = malformedOutput
				? ({ kind: 'unknown', signal: '' } as const)
				: classifyToolOutcome(
						input,
						safeOutput as typeof output & Record<string, unknown>,
						correlatedExecution,
					);
			// The sandbox wrapper mutates command before execution. Circuit identity
			// must stay bound to the agent's original semantic action so that a
			// result can settle the attempt toolBefore armed, rather than creating a
			// second, unarmed wrapped-command identity.
			const circuitArgs =
				correlatedExecution &&
				typeof input.args === 'object' &&
				input.args !== null &&
				!Array.isArray(input.args)
					? { ...input.args, command: correlatedExecution.originalCommand }
					: input.args;
			if (
				pendingReviewerScopeWrite &&
				classifyTaskResult(safeOutput) === 'success'
			) {
				// Issue #2100: capture from the child coder session's workspace
				// root (the lane when worktree-isolated, the primary checkout
				// otherwise) — never the ambient plugin root. Each file gets a
				// typed capture result; one failure never abandons the batch,
				// retryable classes get a bounded inline retry, and permanent
				// failures are retained on the generation as actionable
				// recovery metadata instead of silently dropping evidence.
				const sessionCaptureRoot = resolveSessionWorkspaceDirectory(
					input.sessionID,
					effectiveDirectory,
				);
				const sessionRootIdentity =
					canonicalWorkspaceIdentity(sessionCaptureRoot);
				const batchDeadline =
					Date.now() + REVIEWER_SCOPE_CAPTURE_BATCH_DEADLINE_MS;
				for (const pendingWrite of pendingReviewerScopeWrite) {
					const generation = getReviewerScopeGenerationForCoderCall({
						parentSessionID: pendingWrite.parentSessionID,
						taskId: pendingWrite.taskId,
						coderCallID: pendingWrite.coderCallID,
					});
					if (
						generation &&
						sessionRootIdentity &&
						generation.workspaceIdentity !== sessionRootIdentity
					) {
						recordReviewerScopeGenerationCaptureFailure({
							parentSessionID: pendingWrite.parentSessionID,
							taskId: pendingWrite.taskId,
							coderCallID: pendingWrite.coderCallID,
							file: pendingWrite.file,
							code: 'workspace_mismatch',
							retryable: false,
						});
						const mismatchSession = ensureAgentSession(
							pendingWrite.parentSessionID,
						);
						pushAdvisory(
							mismatchSession,
							`REVIEWER_CAPTURE_FAILED: task ${pendingWrite.taskId}: file ${sanitizeDiagnosticText(pendingWrite.file, 160)} was written from workspace ${sessionRootIdentity} but the coder generation is bound to ${generation.workspaceIdentity} (code workspace_mismatch, retryable=false, responsible: architect). ACTION[architect]: verify the coder dispatch lane/scope binding, then redispatch`,
							{ dedupeKey: `reviewer-capture-failed:${pendingWrite.taskId}` },
						);
						continue;
					}
					const captureRoot =
						generation?.captureDirectory?.trim() || sessionCaptureRoot;
					let lastFailure: {
						code: string;
						retryable: boolean;
					} | null = null;
					let attempts = 0;
					while (attempts < REVIEWER_SCOPE_CAPTURE_ATTEMPTS) {
						attempts += 1;
						const captured = captureReviewerScopeFileFingerprint(
							captureRoot,
							pendingWrite.file,
							{ deadlineAt: batchDeadline },
						);
						if (captured.kind !== 'capture_failed') {
							const fingerprint = reviewerScopeCaptureToFingerprint(captured);
							if (fingerprint) {
								recordReviewerScopeGenerationFileFingerprint({
									parentSessionID: pendingWrite.parentSessionID,
									taskId: pendingWrite.taskId,
									coderCallID: pendingWrite.coderCallID,
									fingerprint,
								});
							}
							lastFailure = null;
							break;
						}
						lastFailure = {
							code: captured.code,
							retryable: captured.retryable,
						};
						if (!captured.retryable) break;
					}
					if (lastFailure) {
						recordReviewerScopeGenerationCaptureFailure({
							parentSessionID: pendingWrite.parentSessionID,
							taskId: pendingWrite.taskId,
							coderCallID: pendingWrite.coderCallID,
							file: pendingWrite.file,
							code: lastFailure.code,
							retryable: lastFailure.retryable,
						});
						const captureSession = ensureAgentSession(
							pendingWrite.parentSessionID,
						);
						pushAdvisory(
							captureSession,
							`REVIEWER_CAPTURE_FAILED: task ${pendingWrite.taskId}: file ${sanitizeDiagnosticText(pendingWrite.file, 160)} could not be fingerprinted exactly (code ${lastFailure.code}, retryable=${lastFailure.retryable}, attempts=${attempts}/${REVIEWER_SCOPE_CAPTURE_ATTEMPTS}, responsible: architect). ACTION[architect]: ${
								lastFailure.retryable
									? 'retry the coder write or re-dispatch the coder so capture re-runs'
									: `resolve the ${lastFailure.code} condition for the file, then retry or route explicit manual review`
							}`,
							{ dedupeKey: `reviewer-capture-failed:${pendingWrite.taskId}` },
						);
					}
				}
			}
			if (outcome.kind === 'fatal') {
				recordNonTransientFailure(
					input.sessionID,
					outcome.category,
					outcome.signal,
					{
						tool: input.tool,
						args: circuitArgs,
						// A current correlated execution is proof this result belongs to
						// the attempt recorded in toolBefore. Re-arm that exact action so
						// wrapper mutation cannot turn its result into a dropped event.
						armAttempt: correlatedExecution !== undefined,
					},
				);
			} else if (outcome.kind === 'success' || outcome.kind === 'neutral') {
				clearNonTransientCircuit(input.sessionID, {
					tool: input.tool,
					args: circuitArgs,
				});
			} else if (outcome.kind === 'failure') {
				// Tool output is not a provider SDK channel. A command that prints
				// "429", "quota", or "temporarily unavailable" must never arm model
				// retry/fallback authority. Structured provider failures arrive through
				// the session.error request boundary in index.ts.
				recordNonTransientFailure(
					input.sessionID,
					'general_permanent',
					outcome.signal,
					{
						tool: input.tool,
						args: circuitArgs,
						armAttempt: correlatedExecution !== undefined,
					},
				);
			}

			const window = getActiveWindow(input.sessionID);
			if (!window) return; // Architect or window missing
			if (outcome.kind === 'fatal') {
				window.consecutiveErrors++;
				return;
			}

			const hasError = outcome.kind === 'failure';

			if (hasError) {
				window.consecutiveErrors++;
			} else {
				window.consecutiveErrors = 0;
				window.transientRetryCount = 0;
				window.lastSuccessTimeMs = Date.now();

				if (session) {
					if (session.model_fallback_index > 0) {
						session.model_fallback_index = 0;
						session.modelFallbackExhausted = false;
					}
				}
			}
		},
		messagesTransform,
	};
}
