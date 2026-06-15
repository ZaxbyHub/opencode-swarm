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
import { advanceTaskState, getActiveWindow, swarmState } from '../../state';
import { telemetry } from '../../telemetry.js';
import { log, warn } from '../../utils';
import * as logger from '../../utils/logger';
import { resolveAgentConflict } from '../conflict-resolution';
import { extractCurrentPhaseFromPlan } from '../extractors';
import { normalizeToolName } from '../normalize-tool-name';
import { dcCheckJunctionCreation } from './destructive-command';
import { buildEffectiveRules } from './file-authority';
import {
	createMessagesTransformHandler,
	getMostRecentAssistantText,
	getProviderFailureFingerprint,
	isTransientProviderFailureText,
} from './messages-transform';
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
 * spec-staleness marker file exists.
 */
export function enforceSpecDriftGate(
	directory: string | undefined,
	toolName: string,
): void {
	if (!directory) return;
	if (!SPEC_DRIFT_BLOCKED_TOOLS.has(toolName)) return;
	const stalePath = path.join(directory, '.swarm', 'spec-staleness.json');
	if (fsSync.existsSync(stalePath)) {
		throw new Error(
			`SPEC_DRIFT_BLOCK: tool "${toolName}" is blocked because .swarm/spec-staleness.json exists. ` +
				'Run /swarm clarify to update the spec, or /swarm acknowledge-spec-drift to dismiss, then retry.',
		);
	}
}

/**
 * v6.33: Known HTTP status codes that indicate transient provider errors.
 */
const TRANSIENT_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504, 529]);

/**
 * Extracts an HTTP status code from an error message string.
 */
function extractStatusCode(errorMsg: string): number | null {
	const match = errorMsg.match(/\b(408|429|500|502|503|504|529)\b/);
	if (match) {
		return parseInt(match[1], 10);
	}
	return null;
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
 * v6.33: Regex pattern for transient model errors that should trigger fallback.
 */
const TRANSIENT_MODEL_ERROR_PATTERN =
	/rate.?limit|429|500|502|503|504|529|timeout|overloaded|model.?not.?found|temporarily.?unavailable|provider[_\s-]?unavailable|server.?error|network.?connection.?lost|connection.?(refused|reset|timeout|lost)|bad.?gateway|gateway.?timeout|internal.?server.?error|service.?unavailable|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|ENOTFOUND|broken.?pipe|dns(?:[\s_-]+(?:resolution)?)?[\s_-]+fail|name.?not.?resolved|EAI_AGAIN/i;

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
 */
const toolCallsSinceLastWrite = new Map<string, number>();
const noOpWarningIssued = new Set<string>();

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
 */
export function redactShellCommand(cmd: string): string {
	if (typeof cmd !== 'string') return '';
	let out = cmd.replace(
		/\b([A-Z_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API[_]?KEY|APIKEY|AUTH|CREDENTIAL|PRIVATE[_]?KEY|ACCESS[_]?KEY|_KEY)[A-Z_0-9]*)\s*=\s*(\S+)/gi,
		'$1=[REDACTED]',
	);

	out = out.replace(
		/--([a-zA-Z-]*(?:token|secret|password|passwd|api[_-]?key|apikey|auth|credential|private[_-]?key|access[_-]?key)[a-zA-Z-]*)=(\S+)/gi,
		'--$1=[REDACTED]',
	);

	out = out.replace(
		/(--[a-zA-Z-]*(?:token|secret|password|passwd|api[_-]?key|apikey|auth|credential|private[_-]?key|access[_-]?key)[a-zA-Z-]*)(\s+)(?!--)(\S+)/gi,
		'$1$2[REDACTED]',
	);

	out = out.replace(
		/\b(Bearer|Basic)\s+[A-Za-z0-9+/=._-]{4,}/gi,
		'$1 [REDACTED]',
	);

	out = out.replace(
		/(-H\s+['"]?(?:Authorization|X-API-Key|X-Auth-Token|[A-Za-z][A-Za-z-]*-(?:key|token|secret|auth|credential)):\s*)([^'">\s][^'">\n]*)(['"]?)/gi,
		'$1[REDACTED]$3',
	);

	return out;
}

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
	});

	// Create messagesTransform handler via factory
	const messagesTransform = createMessagesTransformHandler({
		effectiveDirectory,
		cfg,
		requiredQaGates,
		requireReviewerAndTestEngineer,
		consecutiveNoToolTurns,
	});

	return {
		toolBefore,
		toolAfter: async (input, output) => {
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
						typeof output.output === 'string' ? output.output : '';

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
						(output.output === null ||
							output.output === undefined ||
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
								typeof output.output === 'string' ? output.output : '';
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
				if (
					delegation.isDelegation &&
					delegation.targetAgent === 'coder' &&
					session.lastCoderDelegationTaskId
				) {
					session.currentTaskId = session.lastCoderDelegationTaskId;
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
							session.pendingAdvisoryMessages ??= [];
							session.pendingAdvisoryMessages.push(
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
						const undeclaredFiles = session.modifiedFilesThisCoderTask
							.map((f) => f.replace(/[\r\n\t]/g, '_'))
							.filter(
								(f) =>
									!isInDeclaredScope(f, session.declaredCoderScope!, directory),
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

			// v6.33.1: No-op work detector
			const sessionId = input.sessionID;
			const normalizedToolName = normalizeToolName(input.tool);
			if (isWriteTool(normalizedToolName)) {
				toolCallsSinceLastWrite.set(sessionId, 0);
				noOpWarningIssued.delete(sessionId);
			} else {
				const count = (toolCallsSinceLastWrite.get(sessionId) ?? 0) + 1;
				toolCallsSinceLastWrite.set(sessionId, count);
				const threshold = cfg.no_op_warning_threshold ?? 15;
				if (
					count >= threshold &&
					!noOpWarningIssued.has(sessionId) &&
					session?.pendingAdvisoryMessages
				) {
					noOpWarningIssued.add(sessionId);
					session.pendingAdvisoryMessages.push(
						`WARNING: Agent has made ${count} tool calls with no file modifications. If you are stuck, use /swarm handoff to reset or /swarm turbo to reduce overhead.`,
					);
				}
			}

			const window = getActiveWindow(input.sessionID);
			if (!window) return; // Architect or window missing

			const hasError = output.output === null || output.output === undefined;

			if (hasError) {
				const outputStr =
					typeof output.output === 'string' ? output.output : '';
				const errorContent =
					(output as Record<string, unknown>).error ?? outputStr;
				const errorSignal = extractErrorSignal(errorContent);

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

						session.pendingAdvisoryMessages ??= [];
						if (isContentFilter) {
							session.pendingAdvisoryMessages.push(
								`DEGRADED: Content policy violation detected (content filter). Fallback model ${session.model_fallback_index}/${fallbackModels?.length ?? 0} considered. ` +
									`The input may need content modification to comply with provider policies.`,
							);
						} else {
							session.pendingAdvisoryMessages.push(
								`DEGRADED: Context-limit or token-limit error detected. Fallback model ${session.model_fallback_index}/${fallbackModels?.length ?? 0} considered. ` +
									`Consider reducing input size or using /swarm handoff to switch models.`,
							);
						}
					} else if (session) {
						session.pendingAdvisoryMessages ??= [];
						if (isContentFilter) {
							session.pendingAdvisoryMessages.push(
								`DEGRADED: Content policy violation detected (content filter). No fallback models available. ` +
									`The input may need content modification to comply with provider policies.`,
							);
						} else {
							session.pendingAdvisoryMessages.push(
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

						session.pendingAdvisoryMessages ??= [];
						session.pendingAdvisoryMessages.push(
							`MODEL FALLBACK: Applied fallback model "${fallbackModel}" (attempt ${session.model_fallback_index}). ` +
								`Using /swarm handoff to reset to primary model.`,
						);
						modelFallbackAdvisoryEmitted = true;
					} else {
						session.pendingAdvisoryMessages ??= [];
						session.pendingAdvisoryMessages.push(
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
					session.pendingAdvisoryMessages ??= [];
					if (
						!session.pendingAdvisoryMessages.some(
							(m: string) =>
								m.startsWith('TRANSIENT ERROR:') ||
								m.startsWith('MODEL FALLBACK:'),
						)
					) {
						session.pendingAdvisoryMessages.push(
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
