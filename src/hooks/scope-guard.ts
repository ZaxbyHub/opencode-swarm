/**
 * SCOPE GUARD (v6.31 Task 3.1)
 *
 * CONFIRMED THROW MECHANISM: throwing in tool.execute.before propagates as tool rejection,
 * NOT as session crash. Verified from guardrails.ts multiple existing throw sites.
 * Safe blocking pattern: throw new Error(`SCOPE VIOLATION: ...`)
 *
 * Fires BEFORE write/edit tools execute. When a non-architect agent attempts to
 * modify a file outside the declared task scope, blocks the call and injects an advisory.
 */

import * as path from 'node:path';
import { ORCHESTRATOR_NAME, WRITE_TOOL_NAMES } from '../config/constants';
import { stripKnownSwarmPrefix } from '../config/schema';
import { resolveScopeWithFallbacks } from '../scope/scope-persistence';
import { type AgentSessionState, swarmState } from '../state';
import { pendingCoderScopeByTaskId } from './delegation-gate.js';
import { normalizeToolName } from './normalize-tool-name';

// NOTE: bash/shell tools are intentionally excluded from WRITE_TOOLS.
// A coder agent using bash with shell redirections (echo > file, cp, sed -i) can
// bypass this scope check. This is a known architectural limitation — bash commands
// are opaque to static scope analysis. Post-hoc detection via guardrails.ts
// diff-scope validation provides secondary coverage.

// Tools that write files — scope guard watches these
// Derived from shared WRITE_TOOL_NAMES constant — do not edit here
const WRITE_TOOLS = new Set<string>(WRITE_TOOL_NAMES);

/**
 * Configuration for scope guard behavior.
 */
export interface ScopeGuardConfig {
	/** Whether scope guard is enabled (default: true) */
	enabled: boolean;
	/** Whether to skip in turbo mode (default: false — NOT skippable by design) */
	skip_in_turbo: boolean;
}

/**
 * Creates the scope-guard hook that blocks out-of-scope writes.
 * @param config - ScopeGuardConfig (enabled, skip_in_turbo)
 * @param _directory - The workspace directory (reserved for future use)
 * @param injectAdvisory - Optional callback to push advisory to architect session
 */
export function createScopeGuardHook(
	config: Partial<ScopeGuardConfig>,
	directory: string,
	injectAdvisory?: (sessionId: string, message: string) => void,
): {
	toolBefore: (
		input: { tool: string; sessionID: string; callID: string },
		output: { args: unknown },
	) => Promise<void>;
} {
	const enabled = config.enabled ?? true;
	const _skipInTurbo = config.skip_in_turbo ?? false; // NOT skippable by default (reserved for future turbo detection)

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

			const isArchitect =
				stripKnownSwarmPrefix(agentName) === ORCHESTRATOR_NAME;
			if (isArchitect) return; // Architect writes are always allowed

			// Get declared scope for this session.
			// v6.33.1 CRIT-1: check session first, then fallback map by taskId.
			// v6.71.1 (#519): extend with disk persistence + plan-as-scope so
			// scope survives cross-process delegation and architect plans become
			// a durable scope source.
			const taskId = session?.currentTaskId ?? null;
			const declaredScope = resolveScopeWithFallbacks({
				directory,
				taskId,
				inMemoryScope: session?.declaredCoderScope,
				pendingMapScope: taskId ? pendingCoderScopeByTaskId.get(taskId) : null,
			});
			if (!declaredScope || declaredScope.length === 0) return; // No scope declared — allow

			// Get the file path(s) from args — collect ALL candidate paths from ALL supported keys
			const argsObj = output.args as Record<string, unknown> | undefined;
			const candidatePaths: string[] = [];

			// Collect single-string paths from ALL supported keys
			const singlePathKeys = ['path', 'filePath', 'file'];
			for (const key of singlePathKeys) {
				const val = argsObj?.[key];
				if (typeof val === 'string' && val) {
					candidatePaths.push(val);
				}
			}

			// Collect array paths from all supported array keys
			const arrayPathKeys = ['files', 'paths', 'targetFiles'];
			for (const key of arrayPathKeys) {
				const val = argsObj?.[key];
				if (Array.isArray(val)) {
					for (const item of val) {
						if (typeof item === 'string' && item) {
							candidatePaths.push(item);
						}
					}
				}
			}

			if (candidatePaths.length === 0) return; // Can't determine path — allow

			// Validate every collected path
			for (const rawPath of candidatePaths) {
				const filePath = sanitizePath(rawPath);
				if (!isFileInScope(filePath, declaredScope, directory)) {
					reportScopeViolation(
						agentName,
						filePath,
						taskId,
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
			if (resolvedFile === resolvedScope) return true;
			const rel = path.relative(resolvedScope, resolvedFile);
			return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel);
		});
}

// --- Helpers for array-path scope checking ---

/**
 * Sanitize a raw file path string to prevent log injection and null-byte attacks.
 * Strips control characters (NUL, CR, LF, TAB, BS, FF, VT), ESC (ANSI escape prefix),
 * and remaining ANSI CSI sequences.
 *
 * Null bytes are removed rather than replaced because Node.js `path.resolve()`
 * throws `ERR_INVALID_ARG_VALUE` on `\0`, which would bypass the intended
 * SCOPE VIOLATION error path with a raw TypeError.
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
		// Replace C0 controls (0x00-0x1F) and DEL (0x7F) with underscore
		if (c <= 0x1f || c === 0x7f) {
			result += '_';
			continue;
		}
		// ESC (0x1B) requires split/join to avoid regex control-char rule
		if (c === 0x1b) {
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
export const _internals = { sanitizePath };

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
	session: AgentSessionState | undefined,
	injectAdvisory: ((sessionId: string, message: string) => void) | undefined,
	state: typeof swarmState,
	scopeEntries: string[],
): void {
	const taskLabel = taskId ?? 'unknown';
	const violationMessage = `SCOPE VIOLATION: ${agentName} attempted to modify '${filePath}' which is not in declared scope for task ${taskLabel}. Declared scope: [${scopeEntries.slice(0, 3).join(', ')}${scopeEntries.length > 3 ? '...' : ''}]`;

	// Log violation to session
	if (session) {
		session.lastScopeViolation = violationMessage;
		session.scopeViolationDetected = true;
	}

	// Inject advisory to architect session (if callback provided)
	if (injectAdvisory) {
		for (const [archSessionId, archSession] of state.agentSessions) {
			const archAgent =
				state.activeAgent.get(archSessionId) ?? archSession.agentName;
			if (stripKnownSwarmPrefix(archAgent) === ORCHESTRATOR_NAME) {
				try {
					injectAdvisory(archSessionId, `[SCOPE GUARD] ${violationMessage}`);
				} catch {
					/* non-blocking */
				}
				break;
			}
		}
	}

	// BLOCK the tool call by throwing
	throw new Error(violationMessage);
}
