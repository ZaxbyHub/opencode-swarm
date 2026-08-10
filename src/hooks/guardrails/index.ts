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
import { loadPlan } from '../../plan/manager';
import { getExecutor } from '../../sandbox/executor';
import { createScopeLeaseRenewalTracker } from '../../scope/scope-lease-renewal';
import {
	advanceTaskState,
	getActiveWindow,
	getReviewerScopeGenerationForCoderCall,
	recordReviewerScopeGenerationFileFingerprint,
	swarmState,
} from '../../state';
import { telemetry } from '../../telemetry.js';
import { log, warn } from '../../utils';
import { pushAdvisory } from '../../utils/advisory-queue';
import * as logger from '../../utils/logger';
import {
	extractStatusCode,
	TRANSIENT_MODEL_ERROR_PATTERN,
	TRANSIENT_STATUS_CODES,
} from '../../utils/provider-error-classification';
import { computeSpecDiff } from '../../utils/spec-hash';
import { resolveAgentConflict } from '../conflict-resolution';
import { extractCurrentPhaseFromPlan } from '../extractors';
import { normalizeToolName } from '../normalize-tool-name';
import {
	captureReviewerScopeFileFingerprint,
	MAX_REVIEWER_SCOPE_FINGERPRINT_AGGREGATE_BYTES,
} from '../reviewer-scope-file-fingerprint';
import { classifyTaskResult } from '../task-result-classifier';
import { dcCheckJunctionCreation } from './destructive-command';
import { recordExecutionStallToolAfter } from './execution-stall';
import { buildEffectiveRules } from './file-authority';
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
import { getStoredInputArgs } from './stored-input-args';
import { createToolBeforeHandler } from './tool-before';

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
	/**
	 * Test/inspection seams for the no-op detector's bounded session state
	 * (invariant 8). Production code does not call these; they exist so the
	 * eviction bound can be asserted without exporting the maps themselves.
	 */
	noOpStateSize: (): number => toolCallsSinceLastWrite.size,
	hasNoOpState: (sessionID: string): boolean =>
		toolCallsSinceLastWrite.has(sessionID),
};

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
			'Run /swarm clarify to update the spec, or /swarm acknowledge-spec-drift to dismiss, then retry.';

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
 * v7.12: Regex pattern for degraded model errors.
 */
const DEGRADED_ERROR_PATTERN =
	/context.?length|token.?(limit|budget)|input.?too.?long|content.?filter|exceeds?.?(maximum.?)?tokens|maximum.?context|context.?window|too.?many.?tokens|prompt.?too.?long|message.?too.?long|request.?too.?large|max.?tokens/i;

/**
 * v7.x: Subset of DEGRADED_ERROR_PATTERN for content-filter violations.
 */
const CONTENT_FILTER_PATTERN = /content.?filter/i;

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
 * v6.21 Task 5.4: Check if a file path is within declared scope entries.
 */
function isInDeclaredScope(
	filePath: string,
	scopeEntries: string[],
	cwd?: string,
): boolean {
	const dir = cwd ?? process.cwd();
	const caseInsensitive = process.platform === 'win32';
	const resolvedFileRaw = path.resolve(dir, filePath);
	const resolvedFile = caseInsensitive
		? resolvedFileRaw.toLowerCase()
		: resolvedFileRaw;
	return scopeEntries.some((scope) => {
		const resolvedScopeRaw = path.resolve(dir, scope);
		const resolvedScope = caseInsensitive
			? resolvedScopeRaw.toLowerCase()
			: resolvedScopeRaw;
		if (resolvedFile === resolvedScope) return true;
		const rel = path.relative(resolvedScope, resolvedFile);
		return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel);
	});
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
 * v6.17 Task 9.3: Get the current task ID for a session.
 */
function getCurrentTaskId(sessionId: string): string {
	const session = swarmState.agentSessions.get(sessionId);
	return session?.currentTaskId ?? `${sessionId}:unknown`;
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
	const shellAuditPath = path.join(
		effectiveDirectory,
		'.swarm',
		'session',
		'shell-audit.jsonl',
	);

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
	const toolBefore = createToolBeforeHandler({
		effectiveDirectory,
		cfg,
		precomputedAuthorityRules,
		universalDenyPrefixes,
		shellAuditPath,
		shellAuditEnabled,
		interpreterAllowedAgents,
		authorityConfig,
		consecutiveNoToolTurns,
		worktreeBaseDirOverrides,
		rememberReviewerScopeWrite,
		rememberScopeLeaseCandidate: scopeLeaseRenewal.remember,
		getSandboxExecutor: _internals.getSandboxExecutor,
	});

	// Create messagesTransform handler via factory
	const messagesTransform = createMessagesTransformHandler({
		effectiveDirectory,
		cfg,
		requiredQaGates,
		requireReviewerAndTestEngineer,
		consecutiveNoToolTurns,
		lastCountedAssistantMsgId,
	});

	return {
		toolBefore,
		toolAfter: async (input, output) => {
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
				if (isGateTool(input.tool)) {
					// v6.12: Use session-aware task ID to avoid cross-session collisions
					const taskId = getCurrentTaskId(input.sessionID);
					if (!session.gateLog.has(taskId)) {
						session.gateLog.set(taskId, new Set());
					}
					session.gateLog.get(taskId)?.add(input.tool);

					// Track gate failures for Task 2.5
					const outputStr =
						typeof safeOutput.output === 'string' ? safeOutput.output : '';

					// Check if this is a skip condition (all tools ran === false)
					let isSkipCondition = false;
					try {
						const result = JSON.parse(outputStr);
						if (
							result.lint?.ran === false &&
							result.secretscan?.ran === false &&
							result.sast_scan?.ran === false &&
							result.quality_budget?.ran === false
						) {
							isSkipCondition = true;
						}
					} catch {
						// Not JSON or parse error - not a skip condition
					}

					const hasFailure =
						!isSkipCondition &&
						(safeOutput.output === null ||
							safeOutput.output === undefined ||
							outputStr.includes('FAIL') ||
							outputStr.includes('error') ||
							outputStr.toLowerCase().includes('gates_passed: false'));
					if (hasFailure) {
						session.lastGateFailure = {
							tool: input.tool,
							taskId,
							timestamp: Date.now(),
						};
					} else {
						session.lastGateFailure = null; // Clear on pass

						// v6.22 Task 2.1: Advance workflow state when pre_check_batch passes
						if (input.tool === 'pre_check_batch') {
							const successStr =
								typeof safeOutput.output === 'string' ? safeOutput.output : '';
							let isPassed = false;
							try {
								const result = JSON.parse(successStr);
								isPassed = result.gates_passed === true;
							} catch (error) {
								log('[Guardrails] pre_check_batch JSON parse failed', {
									error: error instanceof Error ? error.message : String(error),
								});
								isPassed = false;
							}
							if (isPassed && session.currentTaskId) {
								try {
									advanceTaskState(
										session,
										session.currentTaskId,
										'pre_check_passed',
									);
								} catch (err) {
									// Non-fatal: state may already be at or past pre_check_passed
									warn(
										'Failed to advance task state after pre_check_batch pass',
										{
											taskId: session.currentTaskId,
											error: String(err),
										},
									);
								}
							}
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
			recordExecutionStallToolAfter({
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
			if (
				pendingReviewerScopeWrite &&
				classifyTaskResult(safeOutput) === 'success'
			) {
				const completedFingerprints: Array<{
					pendingWrite: (typeof pendingReviewerScopeWrite)[number];
					fingerprint: NonNullable<
						ReturnType<typeof captureReviewerScopeFileFingerprint>
					>;
				}> = [];
				let aggregateBytes = 0;
				let captureFailed = false;
				for (const pendingWrite of pendingReviewerScopeWrite) {
					const fingerprint = captureReviewerScopeFileFingerprint(
						effectiveDirectory,
						pendingWrite.file,
						MAX_REVIEWER_SCOPE_FINGERPRINT_AGGREGATE_BYTES - aggregateBytes,
					);
					if (!fingerprint) {
						captureFailed = true;
						break;
					}
					if (fingerprint.kind === 'file') {
						aggregateBytes += fingerprint.size;
					}
					completedFingerprints.push({ pendingWrite, fingerprint });
				}
				if (
					!captureFailed &&
					completedFingerprints.length === pendingReviewerScopeWrite.length &&
					aggregateBytes <= MAX_REVIEWER_SCOPE_FINGERPRINT_AGGREGATE_BYTES
				) {
					for (const { pendingWrite, fingerprint } of completedFingerprints) {
						recordReviewerScopeGenerationFileFingerprint({
							parentSessionID: pendingWrite.parentSessionID,
							taskId: pendingWrite.taskId,
							coderCallID: pendingWrite.coderCallID,
							fingerprint,
						});
					}
				}
			}
			if (outcome.kind === 'fatal') {
				recordNonTransientFailure(
					input.sessionID,
					outcome.category,
					outcome.signal,
				);
			} else if (outcome.kind === 'success' || outcome.kind === 'neutral') {
				clearNonTransientCircuit(input.sessionID);
			} else if (outcome.kind === 'failure') {
				const circuitSignal = extractErrorSignal(outcome.signal);
				const circuitStatus = extractStatusCode(circuitSignal);
				const circuitIsTransient =
					(circuitStatus !== null &&
						TRANSIENT_STATUS_CODES.has(circuitStatus)) ||
					TRANSIENT_MODEL_ERROR_PATTERN.test(circuitSignal);
				const circuitIsDegraded = DEGRADED_ERROR_PATTERN.test(circuitSignal);
				if (circuitIsTransient || circuitIsDegraded) {
					clearNonTransientCircuit(input.sessionID);
				} else {
					recordNonTransientFailure(
						input.sessionID,
						'general_permanent',
						outcome.signal,
					);
				}
			}

			const window = getActiveWindow(input.sessionID);
			if (!window) return; // Architect or window missing
			if (outcome.kind === 'fatal') {
				window.consecutiveErrors++;
				return;
			}

			const hasError = outcome.kind === 'failure';

			if (hasError) {
				const errorSignal = extractErrorSignal(outcome.signal);

				const extractedStatus = extractStatusCode(errorSignal);
				const isTransientStatusCode =
					extractedStatus !== null &&
					TRANSIENT_STATUS_CODES.has(extractedStatus);

				const isTransientPatternMatch =
					TRANSIENT_MODEL_ERROR_PATTERN.test(errorSignal);

				const isTransientMatch =
					isTransientStatusCode || isTransientPatternMatch;
				const maxTransientRetries = cfg.max_transient_retries ?? 5;

				const isTransient =
					!!session &&
					isTransientMatch &&
					window.transientRetryCount < maxTransientRetries;

				const isDegraded =
					!isTransient && DEGRADED_ERROR_PATTERN.test(errorSignal);

				if (isTransient) {
					window.transientRetryCount++;
				} else if (isDegraded) {
					const isContentFilter = CONTENT_FILTER_PATTERN.test(errorSignal);

					if (session && !session.modelFallbackExhausted) {
						session.model_fallback_index++;

						const swarmId = _internals.extractSwarmIdFromAgentName(
							session.agentName,
						);
						const baseAgentName = session.agentName
							? session.agentName.replace(/^[^_]+[_]/, '')
							: '';
						const swarmAgents = _internals.getSwarmAgents(swarmId);
						const fallbackModels =
							swarmAgents?.[baseAgentName]?.fallback_models;
						session.modelFallbackExhausted =
							!fallbackModels ||
							session.model_fallback_index > fallbackModels.length;

						if (isContentFilter) {
							pushAdvisory(
								session,
								`DEGRADED: Content policy violation detected (content filter). Fallback model ${session.model_fallback_index}/${fallbackModels?.length ?? 0} considered. ` +
									`The input may need content modification to comply with provider policies.`,
							);
						} else {
							pushAdvisory(
								session,
								`DEGRADED: Context-limit or token-limit error detected. Fallback model ${session.model_fallback_index}/${fallbackModels?.length ?? 0} considered. ` +
									`Consider reducing input size or using /swarm handoff to switch models.`,
							);
						}
					} else if (session) {
						if (isContentFilter) {
							pushAdvisory(
								session,
								`DEGRADED: Content policy violation detected (content filter). No fallback models available. ` +
									`The input may need content modification to comply with provider policies.`,
							);
						} else {
							pushAdvisory(
								session,
								`DEGRADED: Context-limit or token-limit error detected. No fallback models available. ` +
									`Consider reducing input size or add "fallback_models" config.`,
							);
						}
					}
				} else {
					window.consecutiveErrors++;
				}

				let modelFallbackAdvisoryEmitted = false;

				if (
					session &&
					isTransientMatch &&
					!session.modelFallbackExhausted &&
					!isDegraded
				) {
					session.model_fallback_index++;

					const swarmId = _internals.extractSwarmIdFromAgentName(
						session.agentName,
					);
					const baseAgentName = session.agentName
						? session.agentName.replace(/^[^_]+[_]/, '')
						: '';
					const swarmAgents = _internals.getSwarmAgents(swarmId);
					const fallbackModels = swarmAgents?.[baseAgentName]?.fallback_models;
					session.modelFallbackExhausted =
						!fallbackModels ||
						session.model_fallback_index > fallbackModels.length;

					const fallbackModel = _internals.resolveFallbackModel(
						baseAgentName,
						session.model_fallback_index,
						swarmAgents,
					);

					const primaryModel = swarmAgents?.[baseAgentName]?.model ?? 'default';

					if (fallbackModel) {
						if (swarmAgents?.[baseAgentName]) {
							swarmAgents[baseAgentName].model = fallbackModel;
						}

						pushAdvisory(
							session,
							`MODEL FALLBACK: Applied fallback model "${fallbackModel}" (attempt ${session.model_fallback_index}). ` +
								`Using /swarm handoff to reset to primary model.`,
						);
						modelFallbackAdvisoryEmitted = true;
					} else {
						pushAdvisory(
							session,
							`MODEL FALLBACK: Transient model error detected (attempt ${session.model_fallback_index}). ` +
								`No fallback models configured for this agent. Add "fallback_models": ["model-a", "model-b"] ` +
								`to the agent's config in opencode-swarm.json.`,
						);
						modelFallbackAdvisoryEmitted = true;
					}

					telemetry.modelFallback(
						input.sessionID,
						session.agentName,
						primaryModel,
						fallbackModel ?? 'none',
						'transient_model_error',
					);

					swarmState.pendingEvents++;
				}

				if (
					session &&
					isTransient &&
					isTransientMatch &&
					!modelFallbackAdvisoryEmitted
				) {
					if (
						!session.pendingAdvisoryMessages?.some(
							(m: string) =>
								m.startsWith('TRANSIENT ERROR:') ||
								m.startsWith('MODEL FALLBACK:'),
						)
					) {
						pushAdvisory(
							session,
							`TRANSIENT ERROR: Provider error detected (attempt ${window.transientRetryCount}/${maxTransientRetries}). Retrying...`,
						);
					}
				}
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
