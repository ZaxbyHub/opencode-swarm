/**
 * SCOPE GUARD (v6.31 Task 3.1)
 *
 * CONFIRMED THROW MECHANISM: throwing in tool.execute.before propagates as tool rejection,
 * NOT as session crash. Verified from guardrails.ts multiple existing throw sites.
 * Safe blocking pattern: throw new Error(`SCOPE VIOLATION: ...`)
 *
 * Fires BEFORE write/edit tools execute. When a coder attempts to modify a file
 * outside its Task-correlated scope, blocks the call and injects an advisory.
 */

import * as path from 'node:path';
import { ORCHESTRATOR_NAME, WRITE_TOOL_NAMES } from '../config/constants';
import { stripKnownSwarmPrefix } from '../config/schema';
import { recordFullAutoSevereEvidenceEvent } from '../full-auto/severe-result.js';
import {
	isPathIdentityWithin,
	sanitizeDiagnosticText,
} from '../scope/path-identity';
import {
	describeScopeWorkspaceMismatch,
	getAuthorizedPrFeedbackScopeBinding,
} from '../scope/scope-binding';
import {
	resolveAuthorizedPrFeedbackScopeBindingFromDisk,
	resolveAuthorizedScopeBinding,
	resolveAuthorizedScopeBindingDetailed,
	resolveAuthorizedScopeBindingForSession,
	resolveAuthorizedScopeBindingForSessionDetailed,
} from '../scope/scope-persistence';
import { formatScopeResolutionDiagnostic } from '../scope/scope-resolution-diagnostic';
import {
	type AgentSessionState,
	resolveSessionWorkspaceDirectory,
	swarmState,
} from '../state';
import { normalizeToolName } from './normalize-tool-name';
import { validatePrFeedbackScopeBinding } from './pr-workflow-gate';
import { resolveWriteTargets } from './write-target-resolver';

// bash/shell tools are intentionally excluded from WRITE_TOOLS because the main
// guardrails hook has a dedicated shell-write parser. That path uses the same
// active Task-correlated binding and fails closed for coder writes with no scope.

// Tools that write files — scope guard watches these
// Derived from shared WRITE_TOOL_NAMES constant — do not edit here
const WRITE_TOOLS = new Set<string>(WRITE_TOOL_NAMES);

/**
 * Configuration for scope guard behavior.
 */
export interface ScopeGuardConfig {
	/** Whether scope guard is enabled (default: true) */
	enabled: boolean;
}

/**
 * Creates the scope-guard hook that blocks out-of-scope writes.
 * @param config - ScopeGuardConfig. Scope enforcement is never skipped in Turbo.
 * @param fallbackDirectory - The plugin-root directory (`ctx.directory`). Used
 *   ONLY as the fallback for sessions with no recorded workspace root. Issue
 *   #2002: this hook is constructed once per plugin instance and serves every
 *   session, including worktree-isolated coder children that execute in a
 *   different root — so this value must never be used directly as "the
 *   directory" inside the handler. Resolve per session instead.
 * @param injectAdvisory - Optional callback to push advisory to architect session
 */
export function createScopeGuardHook(
	config: Partial<ScopeGuardConfig>,
	fallbackDirectory: string,
	injectAdvisory?: (sessionId: string, message: string) => void,
): {
	toolBefore: (
		input: { tool: string; sessionID: string; callID: string },
		output: { args: unknown },
	) => Promise<void>;
} {
	const enabled = config.enabled ?? true;

	return {
		toolBefore: async (input, output) => {
			if (!enabled) return;

			// Only fire for write/edit tools
			const toolName = normalizeToolName(input.tool); // strip namespace prefix
			if (!WRITE_TOOLS.has(toolName)) return;

			// Only fire for non-architect sessions
			const sessionId = input.sessionID;
			const activeAgent = swarmState.activeAgent.get(sessionId);
			const session = swarmState.agentSessions.get(sessionId);

			const agentName = activeAgent ?? session?.agentName ?? 'unknown';

			const agentRole = stripKnownSwarmPrefix(agentName);
			const isArchitect = agentRole === ORCHESTRATOR_NAME;
			if (isArchitect) return; // Architect writes are always allowed
			// Scope bindings are a coder Task contract. Other roles remain governed
			// by the universal/lstat and per-agent authority checks in guardrails.
			if (agentRole !== 'coder') return;

			// Issue #2002: this hook is constructed ONCE at plugin init with the
			// plugin-root `ctx.directory`, but worktree-isolated coder children
			// execute in a lane root, and their scope binding is derived and
			// published against that lane. Resolve the session's own root once
			// here and use it for EVERY directory-sensitive decision below —
			// binding lookup, write-target resolution, and containment must share
			// one base, or a split base produces silent false-allows/false-denies.
			// Fail-closed: a session with no recorded root resolves to the plugin
			// root, which is byte-identical to the pre-#2002 behaviour.
			const directory = _internals.resolveSessionWorkspaceDirectory(
				sessionId,
				fallbackDirectory,
			);

			// Resolve the complete write set before looking up scope. Missing or
			// novel argument shapes must not become a no-scope bypass.
			const targets = _internals.resolveWriteTargets(toolName, output.args, {
				directory,
			});
			if (targets.status === 'unverifiable') {
				throw new Error(
					`WRITE TARGET UNVERIFIABLE: ${agentName} invoked ${toolName}: ${targets.reason}`,
				);
			}
			if (targets.paths.length === 0) return;

			// Resolve only an exact active child binding. If plugin memory restarted,
			// recover one unique binding from disk against the current plan identity.
			let taskId = _internals.resolveTaskId(session);
			const seamBinding =
				taskId &&
				_internals.resolveAuthorizedScopeBinding !==
					resolveAuthorizedScopeBinding
					? _internals.resolveAuthorizedScopeBinding({
							directory,
							taskId,
							activeSessionId: sessionId,
						})
					: null;
			const resolution = seamBinding
				? ({ status: 'found', binding: seamBinding } as const)
				: taskId
					? _internals.resolveAuthorizedScopeBindingDetailed({
							directory,
							taskId,
							activeSessionId: sessionId,
						})
					: _internals.resolveAuthorizedScopeBindingForSessionDetailed({
							directory,
							activeSessionId: sessionId,
						});
			let binding = resolution.status === 'found' ? resolution.binding : null;
			if (!binding) {
				binding =
					_internals.getAuthorizedPrFeedbackScopeBinding({
						directory,
						activeSessionId: sessionId,
						taskId: taskId ?? undefined,
					}) ??
					_internals.resolveAuthorizedPrFeedbackScopeBindingFromDisk({
						directory,
						activeSessionId: sessionId,
						taskId: taskId ?? undefined,
					});
				if (
					binding &&
					!(await _internals.validatePrFeedbackScopeBinding(directory, binding))
				) {
					binding = null;
				}
			}
			if (!taskId && binding && session) {
				taskId = binding.taskId;
				session.currentTaskId = binding.taskId;
				session.declaredCoderScope = [...binding.files];
			}
			const declaredScope = binding?.files ?? null;
			if (!declaredScope || declaredScope.length === 0) {
				const durableDiagnostic = formatScopeResolutionDiagnostic({
					resolution,
					taskId,
					sessionId,
				});
				if (durableDiagnostic) {
					denyWithArchitectAdvisory(
						durableDiagnostic,
						session,
						injectAdvisory,
						swarmState,
					);
				}
				// Issue #2002 recurrence guardrail: if a valid active binding for
				// THIS session exists but is rooted elsewhere, the gate is using the
				// wrong workspace root. Say so precisely instead of emitting a
				// generic SCOPE_NOT_DECLARED that names neither root.
				const mismatch = _internals.describeScopeWorkspaceMismatch({
					directory,
					activeSessionId: sessionId,
					taskId,
				});
				if (mismatch) {
					denyWithArchitectAdvisory(
						`${mismatch} ${agentName} cannot invoke ${toolName} for task ${taskId ?? 'unknown'}. ACTION[architect]: redeclare the exact scope against the reported active lane root with replace_existing=true, then dispatch a new Task call.`,
						session,
						injectAdvisory,
						swarmState,
					);
				}
				denyWithArchitectAdvisory(
					`SCOPE_NOT_DECLARED: ${agentName} cannot invoke ${toolName} without a validated scope for task ${taskId ?? 'unknown'}. ACTION[architect]: call declare_scope with the exact workspace-relative paths and replace_existing=true, then dispatch a new Task call.`,
					session,
					injectAdvisory,
					swarmState,
				);
			}

			// Validate every resolved target from the shared registry.
			for (const rawPath of targets.paths) {
				const filePath = sanitizePath(rawPath);
				const absoluteTarget = path.resolve(directory, filePath);
				if (!isPathIdentityWithin(absoluteTarget, directory)) {
					const fallbackRelative = isPathIdentityWithin(
						absoluteTarget,
						fallbackDirectory,
					)
						? path
								.relative(fallbackDirectory, absoluteTarget)
								.replace(/\\/g, '/')
						: null;
					const safeRetry = fallbackRelative
						? `detected workspace-relative path ${JSON.stringify(sanitizeDiagnosticText(fallbackRelative))}; retry exactly that relative path under the active root`
						: 'no safe workspace-relative retry was detected; stop and correct the command or lane root';
					denyWithArchitectAdvisory(
						`SCOPE_ROOT_ESCAPE: attempted target ${JSON.stringify(sanitizeDiagnosticText(filePath))} leaves active root ${JSON.stringify(sanitizeDiagnosticText(directory))}; ${safeRetry}. ACTION[architect]: verify the active lane root, redeclare only the exact relative path with replace_existing=true, and dispatch a new Task call.`,
						session,
						injectAdvisory,
						swarmState,
					);
				}
				if (!isFileInScope(filePath, declaredScope, directory)) {
					reportScopeViolation(
						agentName,
						filePath,
						taskId,
						input.sessionID,
						session,
						injectAdvisory,
						swarmState,
						declaredScope,
					);
				}
			}
		},
	};
}

/**
 * Check if a file path is within declared scope entries.
 * Handles exact match and directory containment.
 *
 * @param filePath - The file path to check
 * @param scopeEntries - Array of declared scope entries (files or directories)
 * @returns true if the file is within scope, false otherwise
 */
export function isFileInScope(
	filePath: string,
	scopeEntries: string[],
	directory?: string,
): boolean {
	const dir = directory ?? process.cwd();
	const resolvedFile = path.resolve(dir, filePath);
	// Filter empty strings: path.resolve(dir, '') resolves to dir itself,
	// making path.relative return non-dotdot for ANY file — silently neutering scope.
	return scopeEntries
		.filter((scope) => scope.length > 0)
		.some((scope) => {
			const resolvedScope = path.resolve(dir, scope);
			return isPathIdentityWithin(resolvedFile, resolvedScope);
		});
}

// --- Helpers for array-path scope checking ---

/**
 * Sanitize a raw file path string to prevent log injection and null-byte attacks.
 * Replaces C0 control characters (0x00-0x1F), DEL (0x7F), C1 control characters
 * (0x80-0x9F), and strips remaining ANSI CSI sequences.
 *
 * All matched control characters are replaced with underscores rather than removed,
 * so that the resulting string can still be passed to `path.resolve()` without
 * triggering `ERR_INVALID_ARG_VALUE` on embedded null bytes.
 *
 * Extracted from the original inline sanitization in the scope guard
 * to support reuse across single-path and multi-path code paths.
 *
 * @param raw - The unsanitized file path string
 * @returns The sanitized file path string safe for logging and scope matching
 */
function sanitizePath(raw: string): string {
	let result = '';
	for (let i = 0; i < raw.length; i++) {
		const c = raw.charCodeAt(i);
		// Replace C0 controls (0x00-0x1F), DEL (0x7F), and C1 controls (0x80-0x9F) with underscore
		if (c <= 0x1f || c === 0x7f || (c >= 0x80 && c <= 0x9f)) {
			result += '_';
			continue;
		}
		result += raw[i];
	}
	// Strip remaining ANSI CSI sequences
	return result.replace(/\[[\d;]*m/g, '');
}

/**
 * Internal implementation details exposed for unit testing.
 * DO NOT use these in production code.
 */
export const _internals = {
	sanitizePath,
	resolveWriteTargets,
	resolveAuthorizedScopeBindingDetailed,
	resolveAuthorizedScopeBindingForSessionDetailed,
	resolveAuthorizedScopeBinding,
	resolveAuthorizedScopeBindingForSession,
	getAuthorizedPrFeedbackScopeBinding,
	resolveAuthorizedPrFeedbackScopeBindingFromDisk,
	validatePrFeedbackScopeBinding,
	resolveSessionWorkspaceDirectory,
	describeScopeWorkspaceMismatch,
	resolveTaskId: (session: AgentSessionState | undefined): string | null =>
		session?.currentTaskId ?? null,
};

function denyWithArchitectAdvisory(
	message: string,
	session: AgentSessionState | undefined,
	injectAdvisory: ((sessionId: string, message: string) => void) | undefined,
	state: typeof swarmState,
): never {
	if (session) {
		session.lastScopeViolation = message;
		session.scopeViolationDetected = true;
	}
	if (injectAdvisory) {
		for (const [architectSessionId, architectSession] of state.agentSessions) {
			const role =
				state.activeAgent.get(architectSessionId) ?? architectSession.agentName;
			if (stripKnownSwarmPrefix(role) !== ORCHESTRATOR_NAME) continue;
			try {
				injectAdvisory(architectSessionId, `[SCOPE GUARD] ${message}`);
			} catch {
				/* Advisory delivery is non-blocking; the write still fails closed. */
			}
			break;
		}
	}
	throw new Error(message);
}

/**
 * Report a scope violation for an out-of-scope file path.
 * Logs the violation to the session state, injects an advisory to the
 * architect session, and throws an Error to block the tool call.
 *
 * @param agentName - Name of the agent that caused the violation
 * @param filePath - The sanitized file path that is out of scope
 * @param taskId - The current task ID (or null if unknown)
 * @param session - The agent session state (or undefined)
 * @param injectAdvisory - Optional callback to push advisory to architect session
 * @param state - The swarm state singleton for finding architect sessions
 * @param scopeEntries - The declared scope entries for scope mismatch display
 * @throws Error - Always throws to block the violating tool call
 */
function reportScopeViolation(
	agentName: string,
	filePath: string,
	taskId: string | null,
	sessionID: string,
	session: AgentSessionState | undefined,
	injectAdvisory: ((sessionId: string, message: string) => void) | undefined,
	state: typeof swarmState,
	scopeEntries: string[],
): void {
	const taskLabel = taskId ?? 'unknown';
	const safeAgentName = sanitizeDiagnosticText(agentName, 128);
	const safeFilePath = sanitizeDiagnosticText(filePath, 256);
	const safeScope = scopeEntries
		.slice(0, 3)
		.map((entry) => sanitizeDiagnosticText(entry, 128))
		.join(', ');
	const evidenceEventID = session
		? recordFullAutoSevereEvidenceEvent({
				sessionID,
				childSessionID: sessionID,
				category: 'out_of_scope_files',
				paths: [filePath],
			})
		: undefined;
	const violationMessage = `SCOPE_VIOLATION: SCOPE VIOLATION: ${safeAgentName} attempted to modify '${safeFilePath}' which is not in declared scope for task ${taskLabel}. Declared scope: [${safeScope}${scopeEntries.length > 3 ? '...' : ''}].${evidenceEventID ? ` Evidence event: ${evidenceEventID}.` : ''} Coder: correct a mistaken target; otherwise stop and ask the architect to expand declare_scope and dispatch a new Task call.`;

	denyWithArchitectAdvisory(violationMessage, session, injectAdvisory, state);
}
