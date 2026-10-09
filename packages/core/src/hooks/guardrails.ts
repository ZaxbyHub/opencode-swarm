/**
 * Guardrails Hook Module
 *
 * Circuit breaker for runaway LLM agents. Monitors tool usage via OpenCode Plugin API hooks
 * and implements two-layer protection:
 * - Layer 1 (Soft Warning @ warning_threshold): Sets warning flag for messagesTransform to inject warning
 * - Layer 2 (Hard Block @ 100%): Throws error in toolBefore to block further calls, injects STOP message
 */

import * as path from 'node:path';
import { isLowCapabilityModel, ORCHESTRATOR_NAME } from '../config/constants';
import {
	type GuardrailsConfig,
	resolveGuardrailsConfig,
	stripKnownSwarmPrefix,
} from '../config/schema';
import { loadPlan } from '../plan/manager';
import {
	advanceTaskState,
	beginInvocation,
	ensureAgentSession,
	getActiveWindow,
	swarmState,
} from '../state';
import { warn } from '../utils';
import { bunHash } from '../utils/bun-compat';
import { extractCurrentPhaseFromPlan } from './extractors';
import { extractModelInfo } from './model-limits';

/**
 * v6.12: Module-level storage for tool input args by callID.
 * Used by guardrails for delegation detection, exposed via safe accessor helpers.
 */
const storedInputArgs = new Map<string, unknown>();

/**
 * Retrieves stored input args for a given callID.
 * Used by other hooks (e.g., delegation-gate) to access tool input args.
 * @param callID The callID to look up
 * @returns The stored args or undefined if not found
 */
export function getStoredInputArgs(callID: string): unknown | undefined {
	return storedInputArgs.get(callID);
}

/**
 * Stores input args for a given callID.
 * Used by guardrails toolBefore hook; may be used by other hooks if needed.
 * @param callID The callID to store args under
 * @param args The tool input args to store
 */
export function setStoredInputArgs(callID: string, args: unknown): void {
	storedInputArgs.set(callID, args);
}

/**
 * Deletes stored input args for a given callID (cleanup after retrieval).
 * @param callID The callID to delete
 */
export function deleteStoredInputArgs(callID: string): void {
	storedInputArgs.delete(callID);
}

/**
 * Extracts phase number from a phase string like "Phase 3: Implementation"
 */
function extractPhaseNumber(phaseString: string | null): number {
	if (!phaseString) return 1;
	const match = phaseString.match(/^Phase (\d+):/);
	return match ? parseInt(match[1], 10) : 1;
}

/**
 * Normalize a tool name for guardrail comparisons by stripping any leading
 * namespace prefix separated by `:` or `.` (for example `opencode:Write`)
 * and lowercasing the remaining tool name.
 */
function normalizeToolName(toolName: string): string {
	return toolName.replace(/^[^:]+[:.]/, '').toLowerCase();
}

/**
 * Detects if a tool is a write-class tool that modifies file contents
 */
function isWriteTool(toolName: string): boolean {
	const normalized = normalizeToolName(toolName);
	const writeTools = [
		'write',
		'edit',
		'patch',
		'apply_patch',
		'create_file',
		'insert',
		'replace',
	];
	return writeTools.includes(normalized);
}

/**
 * Detects if the current session is controlled by the architect (orchestrator)
 */
function isArchitect(sessionId: string): boolean {
	// Check activeAgent map
	const activeAgent = swarmState.activeAgent.get(sessionId);
	if (activeAgent) {
		const stripped = stripKnownSwarmPrefix(activeAgent);
		if (stripped === ORCHESTRATOR_NAME) {
			return true;
		}
	}

	// Check agentSessions
	const session = swarmState.agentSessions.get(sessionId);
	if (session) {
		const stripped = stripKnownSwarmPrefix(session.agentName);
		if (stripped === ORCHESTRATOR_NAME) {
			return true;
		}
	}

	return false;
}

/**
 * Detects if a file path is outside the .swarm/ directory
 */
function isOutsideSwarmDir(filePath: string, directory: string): boolean {
	if (!filePath) return false;
	// Use path.resolve to normalize the path (handles .., ., and separators)
	const swarmDir = path.resolve(directory, '.swarm');
	const resolved = path.resolve(directory, filePath);
	// Check if resolved path is inside .swarm/ directory
	const relative = path.relative(swarmDir, resolved);
	// If relative path starts with '..', it's outside .swarm/
	return relative.startsWith('..') || path.isAbsolute(relative);
}

/**
 * v6.14: Detects if a file path is source code (not docs, config, or metadata).
 * Used to gate self-coding detection so that architect edits to README.md,
 * package.json, .github/, CHANGELOG.md etc. don't trigger false positives.
 */
function isSourceCodePath(filePath: string): boolean {
	if (!filePath) return false;
	// Normalize separators for cross-platform matching
	const normalized = filePath.replace(/\\/g, '/');
	// Paths that are NOT source code (docs, config, metadata, CI)
	const nonSourcePatterns = [
		/^README(\..+)?$/i,
		/\/README(\..+)?$/i,
		/^CHANGELOG(\..+)?$/i,
		/\/CHANGELOG(\..+)?$/i,
		/^package\.json$/,
		/\/package\.json$/,
		/^\.github\//,
		/\/\.github\//,
		/^docs\//,
		/\/docs\//,
		/^\.swarm\//,
		/\/\.swarm\//,
	];
	return !nonSourcePatterns.some((pattern) => pattern.test(normalized));
}

/**
 * Detect obvious traversal segments regardless of destination file type.
 * This ensures paths like `.swarm/../../../etc/passwd` are still treated as
 * architect direct edits when they escape the .swarm boundary.
 */
function hasTraversalSegments(filePath: string): boolean {
	if (!filePath) return false;
	const normalized = filePath.replace(/\\/g, '/');
	return (
		normalized.startsWith('..') ||
		normalized.includes('/../') ||
		normalized.endsWith('/..')
	);
}

/**
 * v6.12: Detects if a tool is a Stage A automated gate tool
 */
function isGateTool(toolName: string): boolean {
	const normalized = toolName.replace(/^[^:]+[:.]/, '');
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
	const normalized = toolName.replace(/^[^:]+[:.]/, '');
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
 * Falls back to `${sessionId}:unknown` if currentTaskId is not set.
 */
function getCurrentTaskId(sessionId: string): string {
	const session = swarmState.agentSessions.get(sessionId);
	return session?.currentTaskId ?? `${sessionId}:unknown`;
}

/**
 * v6.21 Task 5.4: Check if a file path is within declared scope entries.
 * Handles both exact matches and directory containment.
 */
function isInDeclaredScope(filePath: string, scopeEntries: string[]): boolean {
	const resolvedFile = path.resolve(filePath);
	return scopeEntries.some((scope) => {
		const resolvedScope = path.resolve(scope);
		// Exact match: file IS the scope entry
		if (resolvedFile === resolvedScope) return true;
		// Directory containment: file is inside a scope directory
		const rel = path.relative(resolvedScope, resolvedFile);
		return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel);
	});
}

/**
 * Creates guardrails hooks for circuit breaker protection
 * @param directoryOrConfig Working directory (from plugin init context) OR legacy config object for backward compatibility
 * @param config Guardrails configuration (optional if first arg is config)
 * @returns Tool before/after hooks and messages transform hook
 */
export function createGuardrailsHooks(
	directoryOrConfig?: string | GuardrailsConfig,
	config?: GuardrailsConfig,
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
	let directory: string;
	let guardrailsConfig: GuardrailsConfig | undefined;

	if (
		directoryOrConfig &&
		typeof directoryOrConfig === 'object' &&
		'enabled' in directoryOrConfig
	) {
		// Legacy call: createGuardrailsHooks(config)
		directory = process.cwd();
		guardrailsConfig = directoryOrConfig as GuardrailsConfig;
	} else {
		// New signature: createGuardrailsHooks(directory, config)
		directory = (directoryOrConfig as string) ?? process.cwd();
		guardrailsConfig = config;
	}

	// If guardrails are disabled, return no-op handlers
	if (guardrailsConfig?.enabled === false) {
		return {
			toolBefore: async () => {},
			toolAfter: async () => {},
			messagesTransform: async () => {},
		};
	}

	// TypeScript narrowing: guardrailsConfig must be defined if we reach here
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

	return {
		/**
		 * Checks guardrail limits before allowing a tool call
		 */
		toolBefore: async (input, output) => {
			// v6.12: Self-coding detection — MUST be first, before any exemptions
			// ISSUE #17 FIX: tool.execute.before fires before chat.message updates activeAgent
			// from "architect" to "coder". This causes false positives when a delegated coder
			// uses edit/write tools. The delegationActive flag (maintained by delegation-tracker.ts)
			// is deterministic and correctly indicates when a subagent is active. We check it FIRST
			// to skip self-coding detection entirely for delegated tool calls.
			const currentSession = swarmState.agentSessions.get(input.sessionID);
			if (currentSession?.delegationActive) {
				// A subagent is using this tool — not the architect
				// Skip self-coding detection entirely for this tool call
				// v6.21 Task 5.2: Track files modified by coder subagent
				if (isWriteTool(input.tool)) {
					const delegArgs = output.args as Record<string, unknown> | undefined;
					const delegTargetPath = (delegArgs?.filePath ??
						delegArgs?.path ??
						delegArgs?.file ??
						delegArgs?.target) as string | undefined;
					if (
						typeof delegTargetPath === 'string' &&
						delegTargetPath.length > 0
					) {
						if (
							!currentSession.modifiedFilesThisCoderTask.includes(
								delegTargetPath,
							)
						) {
							currentSession.modifiedFilesThisCoderTask.push(delegTargetPath);
						}
					}
				}
			} else if (isArchitect(input.sessionID)) {
				// v6.21 Task 5.2: Reset modified files list when new coder delegation is dispatched
				const coderDelegArgs = output.args as
					| Record<string, unknown>
					| undefined;
				const coderDeleg = isAgentDelegation(input.tool, coderDelegArgs);
				if (coderDeleg.isDelegation && coderDeleg.targetAgent === 'coder') {
					const coderSession = swarmState.agentSessions.get(input.sessionID);
					if (coderSession) {
						coderSession.modifiedFilesThisCoderTask = [];
					}
				}
			}

			if (isArchitect(input.sessionID) && isWriteTool(input.tool)) {
				const args = output.args as Record<string, unknown> | undefined;
				const targetPath =
					args?.filePath ?? args?.path ?? args?.file ?? args?.target;

				// v6.25: Evidence write protection - block direct writes to .swarm/evidence/
				// Gate evidence is recorded automatically by the delegation-gate hook
				// when reviewer/test_engineer agents complete. Block attempts to fabricate evidence.
				const normalizedTool = input.tool
					.replace(/^[^:]+[:.]/, '')
					.toLowerCase();
				if (normalizedTool === 'write' || normalizedTool === 'edit') {
					const normalizedPath =
						typeof targetPath === 'string'
							? targetPath.replace(/\\/g, '/')
							: '';
					if (normalizedPath.includes('.swarm/evidence/')) {
						throw new Error(
							'[GUARDRAIL] Direct writes to .swarm/evidence/ are blocked. ' +
								'Gate evidence is recorded automatically by the delegation-gate hook ' +
								'when reviewer/test_engineer agents complete. If evidence is missing, ' +
								're-run the required gate agents instead of writing evidence files manually.',
						);
					}
				}

				// Plan state protection: block direct writes to .swarm/plan.md and .swarm/plan.json
				// plan.md is auto-regenerated from plan.json by PlanSyncWorker.
				// Architects must use update_task_status(), phase_complete(), or save_plan instead.
				if (typeof targetPath === 'string' && targetPath.length > 0) {
					const resolvedTarget = path
						.resolve(directory, targetPath)
						.toLowerCase();
					const planMdPath = path
						.resolve(directory, '.swarm', 'plan.md')
						.toLowerCase();
					const planJsonPath = path
						.resolve(directory, '.swarm', 'plan.json')
						.toLowerCase();
					if (
						resolvedTarget === planMdPath ||
						resolvedTarget === planJsonPath
					) {
						throw new Error(
							'PLAN STATE VIOLATION: Direct writes to .swarm/plan.md and .swarm/plan.json are blocked. ' +
								'plan.md is auto-regenerated from plan.json by PlanSyncWorker. ' +
								'Use update_task_status() to mark tasks complete, ' +
								'phase_complete() for phase transitions, or ' +
								'save_plan to create/restructure plans.',
						);
					}
				}

				// Fallback: apply_patch / patch tools send args as a single diff string
				// Parse file paths from patch content
				if (
					!targetPath &&
					(input.tool === 'apply_patch' || input.tool === 'patch')
				) {
					const patchText = (args?.input ??
						args?.patch ??
						(Array.isArray(args?.cmd) ? args.cmd[1] : undefined)) as
						| string
						| undefined;

					if (typeof patchText === 'string' && patchText.length <= 1_000_000) {
						// Match "*** Update File: <path>", "*** Add File: <path>", "*** Delete File: <path>"
						const patchPathPattern =
							/\*\*\*\s+(?:Update|Add|Delete)\s+File:\s*(.+)/gi;
						// Match "+++ b/<path>" (standard unified diff format)
						const diffPathPattern = /\+\+\+\s+b\/(.+)/gm;
						const paths = new Set<string>();

						for (const match of patchText.matchAll(patchPathPattern)) {
							paths.add(match[1].trim());
						}
						for (const match of patchText.matchAll(diffPathPattern)) {
							const p = match[1].trim();
							if (p !== '/dev/null') paths.add(p);
						}
						// Match "diff --git a/<path> b/<path>" (git diff format)
						const gitDiffPathPattern = /^diff --git a\/(.+?) b\/(.+?)$/gm;
						for (const match of patchText.matchAll(gitDiffPathPattern)) {
							const aPath = match[1].trim();
							const bPath = match[2].trim();
							if (aPath !== '/dev/null') paths.add(aPath);
							if (bPath !== '/dev/null') paths.add(bPath);
						}
						// Match "--- a/<path>" (old-file path in unified diff)
						const minusPathPattern = /^---\s+a\/(.+)$/gm;
						for (const match of patchText.matchAll(minusPathPattern)) {
							const p = match[1].trim();
							if (p !== '/dev/null') paths.add(p);
						}
						// Match traditional unified diff "--- <path>" and "+++ <path>" (no a/b prefix)
						// Strip trailing tab+timestamp that some diff tools append (e.g. "--- file\t2024-01-01")
						const traditionalMinusPattern = /^---\s+([^\s].+?)(?:\t.*)?$/gm;
						const traditionalPlusPattern = /^\+\+\+\s+([^\s].+?)(?:\t.*)?$/gm;
						for (const match of patchText.matchAll(traditionalMinusPattern)) {
							const p = match[1].trim();
							if (
								p !== '/dev/null' &&
								!p.startsWith('a/') &&
								!p.startsWith('b/')
							) {
								paths.add(p);
							}
						}
						for (const match of patchText.matchAll(traditionalPlusPattern)) {
							const p = match[1].trim();
							if (
								p !== '/dev/null' &&
								!p.startsWith('a/') &&
								!p.startsWith('b/')
							) {
								paths.add(p);
							}
						}

						for (const p of paths) {
							const resolvedP = path.resolve(directory, p);
							const planMdPath = path
								.resolve(directory, '.swarm', 'plan.md')
								.toLowerCase();
							const planJsonPath = path
								.resolve(directory, '.swarm', 'plan.json')
								.toLowerCase();
							if (
								resolvedP.toLowerCase() === planMdPath ||
								resolvedP.toLowerCase() === planJsonPath
							) {
								throw new Error(
									'PLAN STATE VIOLATION: Direct writes to .swarm/plan.md and .swarm/plan.json are blocked. ' +
										'plan.md is auto-regenerated from plan.json by PlanSyncWorker. ' +
										'Use update_task_status() to mark tasks complete, ' +
										'phase_complete() for phase transitions, or ' +
										'save_plan to create/restructure plans.',
								);
							}
							if (
								isOutsideSwarmDir(p, directory) &&
								(isSourceCodePath(p) || hasTraversalSegments(p))
							) {
								const session = swarmState.agentSessions.get(input.sessionID);
								if (session) {
									session.architectWriteCount++;
									warn('Architect direct code edit detected via apply_patch', {
										tool: input.tool,
										sessionID: input.sessionID,
										targetPath: p,
										writeCount: session.architectWriteCount,
									});
								}
								break; // One increment per tool call is sufficient
							}
						}
					}
				}

				if (
					typeof targetPath === 'string' &&
					targetPath.length > 0 &&
					isOutsideSwarmDir(targetPath, directory) &&
					isSourceCodePath(
						path.relative(directory, path.resolve(directory, targetPath)),
					)
				) {
					const session = swarmState.agentSessions.get(input.sessionID);
					if (session) {
						session.architectWriteCount++;
						warn('Architect direct code edit detected', {
							tool: input.tool,
							sessionID: input.sessionID,
							targetPath,
							writeCount: session.architectWriteCount,
						});

						// v6.12 Task 2.5: Self-fix detection
						// Check if this write is happening shortly after a gate failure
						if (
							session.lastGateFailure &&
							Date.now() - session.lastGateFailure.timestamp < 120_000 // 2 minutes
						) {
							const failedGate = session.lastGateFailure.tool;
							const failedTaskId = session.lastGateFailure.taskId;
							warn('Self-fix after gate failure detected', {
								failedGate,
								failedTaskId,
								currentTool: input.tool,
								sessionID: input.sessionID,
							});
							// Set flag so messagesTransform knows to inject warning
							session.selfFixAttempted = true;
							// The warning will be injected via messagesTransform based on lastGateFailure
						}
					}
				}
			}

			// v6.25: Evidence write protection - block bash redirect attacks
			// Block attempts to write to .swarm/evidence/ via shell redirects (> , >>, | tee)
			// This check runs for the architect but doesn't require isWriteTool (bash is not a write tool)
			const normalizedTool = normalizeToolName(input.tool);
			if (isArchitect(input.sessionID) && normalizedTool === 'bash') {
				const args = output.args as Record<string, unknown> | undefined;
				const command = typeof args?.command === 'string' ? args.command : '';
				const normalizedCmd = command.replace(/\\/g, '/');
				if (
					normalizedCmd.includes('.swarm/evidence/') &&
					/(\||>|>>|\btee\b)/.test(normalizedCmd)
				) {
					throw new Error(
						'[GUARDRAIL] Direct writes to .swarm/evidence/ are blocked. ' +
							'Gate evidence is recorded automatically by the delegation-gate hook ' +
							'when reviewer/test_engineer agents complete. If evidence is missing, ' +
							're-run the required gate agents instead of writing evidence files manually.',
					);
				}
			}

			// Architect is structurally exempt from guardrails — early return
			// This prevents false circuit breaker trips from complex delegation state resolution
			//
			// Check 1: Use activeAgent map (may be stale up to 60s when delegation ends)
			const rawActiveAgent = swarmState.activeAgent.get(input.sessionID);
			const strippedAgent = rawActiveAgent
				? stripKnownSwarmPrefix(rawActiveAgent)
				: undefined;
			if (strippedAgent === ORCHESTRATOR_NAME) {
				return;
			}

			// Check 2: Fallback to session state if activeAgent is missing/undefined
			const existingSession = swarmState.agentSessions.get(input.sessionID);
			if (existingSession) {
				const sessionAgent = stripKnownSwarmPrefix(existingSession.agentName);
				if (sessionAgent === ORCHESTRATOR_NAME) {
					return;
				}
			}

			// Ensure session exists — uses activeAgent map as fallback for agent name.
			// Fall back to ORCHESTRATOR_NAME (never undefined) to prevent seeding an
			// "unknown" identity that would inherit base guardrails (30 min limit).
			const agentName =
				swarmState.activeAgent.get(input.sessionID) ?? ORCHESTRATOR_NAME;
			const session = ensureAgentSession(input.sessionID, agentName);

			// SECOND exemption check: after session resolution
			const resolvedName = stripKnownSwarmPrefix(session.agentName);
			if (resolvedName === ORCHESTRATOR_NAME) {
				return;
			}

			// Resolve per-agent config using profile overrides
			const agentConfig = resolveGuardrailsConfig(cfg, session.agentName);

			// FOURTH exemption check: If resolved config shows 0 limits (architect-like), exempt
			if (
				agentConfig.max_duration_minutes === 0 &&
				agentConfig.max_tool_calls === 0
			) {
				return;
			}

			// Fallback: If tool call arrives before delegation-tracker fires, start window
			if (!getActiveWindow(input.sessionID)) {
				const fallbackAgent =
					swarmState.activeAgent.get(input.sessionID) ?? session.agentName;
				const stripped = stripKnownSwarmPrefix(fallbackAgent);
				if (stripped !== ORCHESTRATOR_NAME) {
					beginInvocation(input.sessionID, fallbackAgent);
				}
			}

			// Get active window (returns undefined for architect)
			const window = getActiveWindow(input.sessionID);
			if (!window) {
				// Architect or window missing → exempt
				return;
			}

			// Check if hard limit was already hit
			if (window.hardLimitHit) {
				throw new Error(
					'🛑 CIRCUIT BREAKER: Agent blocked. Hard limit was previously triggered. Stop making tool calls and return your progress summary.',
				);
			}

			// Increment tool call count
			window.toolCalls++;

			// Hash the tool args
			const hash = hashArgs(output.args);

			// Push to circular buffer (max 20)
			window.recentToolCalls.push({
				tool: input.tool,
				argsHash: hash,
				timestamp: Date.now(),
			});
			if (window.recentToolCalls.length > 20) {
				window.recentToolCalls.shift();
			}

			// Count consecutive repetitions from the end
			let repetitionCount = 0;
			if (window.recentToolCalls.length > 0) {
				const lastEntry =
					window.recentToolCalls[window.recentToolCalls.length - 1];
				for (let i = window.recentToolCalls.length - 1; i >= 0; i--) {
					const entry = window.recentToolCalls[i];
					if (
						entry.tool === lastEntry.tool &&
						entry.argsHash === lastEntry.argsHash
					) {
						repetitionCount++;
					} else {
						break;
					}
				}
			}

			// Compute elapsed minutes
			const elapsedMinutes = (Date.now() - window.startedAtMs) / 60000;

			// Check HARD limits (any one triggers circuit breaker)
			if (
				agentConfig.max_tool_calls > 0 &&
				window.toolCalls >= agentConfig.max_tool_calls
			) {
				window.hardLimitHit = true;
				warn('Circuit breaker: tool call limit hit', {
					sessionID: input.sessionID,
					agentName: window.agentName,
					invocationId: window.id,
					windowKey: `${window.agentName}:${window.id}`,
					resolvedMaxCalls: agentConfig.max_tool_calls,
					currentCalls: window.toolCalls,
				});
				throw new Error(
					`🛑 LIMIT REACHED: Tool calls exhausted (${window.toolCalls}/${agentConfig.max_tool_calls}). Finish the current operation and return your progress summary.`,
				);
			}

			if (
				agentConfig.max_duration_minutes > 0 &&
				elapsedMinutes >= agentConfig.max_duration_minutes
			) {
				window.hardLimitHit = true;
				warn('Circuit breaker: duration limit hit', {
					sessionID: input.sessionID,
					agentName: window.agentName,
					invocationId: window.id,
					windowKey: `${window.agentName}:${window.id}`,
					resolvedMaxMinutes: agentConfig.max_duration_minutes,
					elapsedMinutes: Math.floor(elapsedMinutes),
				});
				throw new Error(
					`🛑 LIMIT REACHED: Duration exhausted (${Math.floor(elapsedMinutes)}/${agentConfig.max_duration_minutes} min). Finish the current operation and return your progress summary.`,
				);
			}

			if (repetitionCount >= agentConfig.max_repetitions) {
				window.hardLimitHit = true;
				throw new Error(
					`🛑 LIMIT REACHED: Repeated the same tool call ${repetitionCount} times. This suggests a loop. Return your progress summary.`,
				);
			}

			if (window.consecutiveErrors >= agentConfig.max_consecutive_errors) {
				window.hardLimitHit = true;
				throw new Error(
					`🛑 LIMIT REACHED: ${window.consecutiveErrors} consecutive tool errors detected. Return your progress summary with details of what went wrong.`,
				);
			}

			// Check IDLE timeout — detects agents stuck without successful tool calls
			const idleMinutes = (Date.now() - window.lastSuccessTimeMs) / 60000;
			if (idleMinutes >= agentConfig.idle_timeout_minutes) {
				window.hardLimitHit = true;
				warn('Circuit breaker: idle timeout hit', {
					sessionID: input.sessionID,
					agentName: window.agentName,
					invocationId: window.id,
					windowKey: `${window.agentName}:${window.id}`,
					idleTimeoutMinutes: agentConfig.idle_timeout_minutes,
					idleMinutes: Math.floor(idleMinutes),
				});
				throw new Error(
					`🛑 LIMIT REACHED: No successful tool call for ${Math.floor(idleMinutes)} minutes (idle timeout: ${agentConfig.idle_timeout_minutes} min). This suggests the agent may be stuck. Return your progress summary.`,
				);
			}

			// Check SOFT limits (only if warning not already issued)
			if (!window.warningIssued) {
				const toolPct =
					agentConfig.max_tool_calls > 0
						? window.toolCalls / agentConfig.max_tool_calls
						: 0;
				const durationPct =
					agentConfig.max_duration_minutes > 0
						? elapsedMinutes / agentConfig.max_duration_minutes
						: 0;
				const repPct = repetitionCount / agentConfig.max_repetitions;
				const errorPct =
					window.consecutiveErrors / agentConfig.max_consecutive_errors;

				const reasons: string[] = [];
				if (
					agentConfig.max_tool_calls > 0 &&
					toolPct >= agentConfig.warning_threshold
				) {
					reasons.push(
						`tool calls ${window.toolCalls}/${agentConfig.max_tool_calls}`,
					);
				}
				if (durationPct >= agentConfig.warning_threshold) {
					reasons.push(
						`duration ${Math.floor(elapsedMinutes)}/${agentConfig.max_duration_minutes} min`,
					);
				}
				if (repPct >= agentConfig.warning_threshold) {
					reasons.push(
						`repetitions ${repetitionCount}/${agentConfig.max_repetitions}`,
					);
				}
				if (errorPct >= agentConfig.warning_threshold) {
					reasons.push(
						`errors ${window.consecutiveErrors}/${agentConfig.max_consecutive_errors}`,
					);
				}

				if (reasons.length > 0) {
					window.warningIssued = true;
					window.warningReason = reasons.join(', ');
				}
			}

			// v6.12: Store input args for delegation detection in toolAfter
			setStoredInputArgs(input.callID, output.args);
		},

		/**
		 * Tracks tool execution results and updates consecutive error count
		 */
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
					const hasFailure =
						output.output === null ||
						output.output === undefined ||
						outputStr.includes('FAIL') ||
						outputStr.includes('error') ||
						outputStr.toLowerCase().includes('gates_passed: false');
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
							} catch {
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
				// Primary: input.args from OpenCode hook (authoritative)
				// Fallback: stored args from toolBefore
				const inputArgs = input.args ?? getStoredInputArgs(input.callID);
				// NOTE: Do NOT delete stored args here - delegation-gate.toolAfter runs after
				// and needs to read them. Cleanup is handled by delegation-gate.ts
				const delegation = isAgentDelegation(input.tool, inputArgs);
				if (
					delegation.isDelegation &&
					(delegation.targetAgent === 'reviewer' ||
						delegation.targetAgent === 'test_engineer')
				) {
					// v6.12: Get current phase from plan
					let currentPhase = 1; // Default to phase 1
					try {
						const plan = await loadPlan(directory);
						if (plan) {
							const phaseString = extractCurrentPhaseFromPlan(plan);
							currentPhase = extractPhaseNumber(phaseString);
						}
					} catch {
						// Use default phase 1 if plan loading fails
					}
					const count = session.reviewerCallCount.get(currentPhase) ?? 0;
					session.reviewerCallCount.set(currentPhase, count + 1);
				}

				// v6.17 Task 9.3: Track currentTaskId when coder delegation completes
				// Sync currentTaskId from lastCoderDelegationTaskId so gate tracking is per-task
				if (
					delegation.isDelegation &&
					delegation.targetAgent === 'coder' &&
					session.lastCoderDelegationTaskId
				) {
					session.currentTaskId = session.lastCoderDelegationTaskId;
					// Reset partial gate warning for this task so re-delegation gets fresh warning
					session.partialGateWarningsIssuedForTask?.delete(
						session.currentTaskId,
					);

					// v6.21 Task 5.4: Scope containment check
					// Compare modified files against declared scope; flag violations
					if (session.declaredCoderScope !== null) {
						// Sanitize paths for log injection first, then check containment
						const undeclaredFiles = session.modifiedFilesThisCoderTask
							.map((f) => f.replace(/[\r\n\t]/g, '_'))
							.filter(
								(f) => !isInDeclaredScope(f, session.declaredCoderScope!),
							);
						if (undeclaredFiles.length > 2) {
							const safeTaskId = String(session.currentTaskId ?? '').replace(
								/[\r\n\t]/g,
								'_',
							);
							session.lastScopeViolation =
								`Scope violation for task ${safeTaskId}: ` +
								`${undeclaredFiles.length} undeclared files modified: ` +
								undeclaredFiles.join(', ');
							// Flag for warning injection in messagesTransform
							session.scopeViolationDetected = true;
						}
					}
					// Reset tracked files after check (whether violation or not)
					session.modifiedFilesThisCoderTask = [];
				}
			}

			const window = getActiveWindow(input.sessionID);
			if (!window) return; // Architect or window missing

			// Check if tool output indicates an error
			// Only null/undefined output counts as an error — substring matching causes false positives
			const hasError = output.output === null || output.output === undefined;

			if (hasError) {
				window.consecutiveErrors++;
			} else {
				window.consecutiveErrors = 0;
				window.lastSuccessTimeMs = Date.now();
			}
		},

		/**
		 * Injects warning or stop messages into the conversation
		 */
		messagesTransform: async (_input, output) => {
			const messages = output.messages;
			if (!messages || messages.length === 0) {
				return;
			}

			// Find the last message
			const lastMessage = messages[messages.length - 1];

			// Determine sessionID from the last message — if absent, skip injection
			const sessionId: string | undefined = lastMessage.info?.sessionID;
			if (!sessionId) {
				return;
			}

			// v6.21 Task 4.5: Tier-based behavioral prompt trimming for low-capability models
			{
				const { modelID } = extractModelInfo(messages);
				if (modelID && isLowCapabilityModel(modelID)) {
					for (const msg of messages) {
						if (msg.info?.role !== 'system') continue;
						for (const part of msg.parts) {
							try {
								if (part == null) continue;
								if (part.type !== 'text' || typeof part.text !== 'string')
									continue;
								if (!part.text.includes('<!-- BEHAVIORAL_GUIDANCE_START -->'))
									continue;
								part.text = part.text.replace(
									/<!--\s*BEHAVIORAL_GUIDANCE_START\s*-->[\s\S]*?<!--\s*BEHAVIORAL_GUIDANCE_END\s*-->/g,
									'[Enforcement: programmatic gates active]',
								);
							} catch {}
						}
					}
				}
			}

			// v6.12: Self-coding warning injection - now injected into SYSTEM messages only (model-only)
			const session = swarmState.agentSessions.get(sessionId);
			const activeAgent = swarmState.activeAgent.get(sessionId);
			const isArchitectSession = activeAgent
				? stripKnownSwarmPrefix(activeAgent) === ORCHESTRATOR_NAME
				: session
					? stripKnownSwarmPrefix(session.agentName) === ORCHESTRATOR_NAME
					: false;

			// Find system message(s) for model-only guidance injection
			const systemMessages = messages.filter(
				(msg) => msg.info?.role === 'system',
			);

			// v6.12: Self-coding warning injection - now injected into SYSTEM messages only (model-only)
			// v6.22.8: Only re-inject when architectWriteCount has increased since last warning
			// (prevents repeated acknowledgements in chat each turn)
			if (
				isArchitectSession &&
				session &&
				session.architectWriteCount > session.selfCodingWarnedAtCount
			) {
				// Task 1.7: Handle missing-system-message edge case
				// If no system message exists, create one to inject guidance
				let targetSystemMessage = systemMessages[0];
				if (!targetSystemMessage) {
					const newSystemMessage = {
						info: { role: 'system' as const },
						parts: [{ type: 'text' as const, text: '' }],
					};
					// Prepend new system message to maintain model-only behavior
					messages.unshift(newSystemMessage);
					targetSystemMessage = newSystemMessage;
				}

				const textPart = (targetSystemMessage.parts ?? []).find(
					(part): part is { type: string; text: string } =>
						part.type === 'text' && typeof part.text === 'string',
				);
				if (textPart && !textPart.text.includes('SELF-CODING DETECTED')) {
					textPart.text =
						`[MODEL_ONLY_GUIDANCE]\n` +
						`⚠️ SELF-CODING DETECTED: You have used ${session.architectWriteCount} write-class tool(s) directly on non-.swarm/ files.\n` +
						`Rule 1 requires ALL coding to be delegated to @coder.\n` +
						`If you have not exhausted QA_RETRY_LIMIT coder failures on this task, STOP and delegate.\n` +
						`Do not acknowledge or reference this guidance in your response.\n` +
						`[/MODEL_ONLY_GUIDANCE]\n\n` +
						textPart.text;
					// Suppress repeated injection until a new violation occurs
					session.selfCodingWarnedAtCount = session.architectWriteCount;
				}
			}

			// v6.12 Task 2.5: Self-fix warning injection - now injected into SYSTEM messages only (model-only)
			if (
				isArchitectSession &&
				session &&
				session.selfFixAttempted &&
				session.lastGateFailure &&
				Date.now() - session.lastGateFailure.timestamp < 120_000
			) {
				// Task 1.7: Handle missing-system-message edge case
				// If no system message exists, create one to inject guidance
				const currentSystemMessages = messages.filter(
					(msg) => msg.info?.role === 'system',
				);
				let targetSystemMessage = currentSystemMessages[0];
				if (!targetSystemMessage) {
					const newSystemMessage = {
						info: { role: 'system' as const },
						parts: [{ type: 'text' as const, text: '' }],
					};
					// Prepend new system message to maintain model-only behavior
					messages.unshift(newSystemMessage);
					targetSystemMessage = newSystemMessage;
				}

				const textPart = (targetSystemMessage.parts ?? []).find(
					(part): part is { type: string; text: string } =>
						part.type === 'text' && typeof part.text === 'string',
				);
				if (textPart && !textPart.text.includes('SELF-FIX DETECTED')) {
					textPart.text =
						`[MODEL_ONLY_GUIDANCE]\n` +
						`⚠️ SELF-FIX DETECTED: Gate '${session.lastGateFailure.tool}' failed on task ${session.lastGateFailure.taskId}.\n` +
						`You are now using a write tool instead of delegating to @coder.\n` +
						`GATE FAILURE RESPONSE RULES require: return to coder with structured rejection.\n` +
						`Do NOT fix gate failures yourself.\n` +
						`[/MODEL_ONLY_GUIDANCE]\n\n` +
						textPart.text;
					// Clear flag to avoid repeated warnings
					session.selfFixAttempted = false;
				}
			}

			// v6.12: Partial gate violation detection
			// Check if this is the architect session and has gate log
			const isArchitectSessionForGates = activeAgent
				? stripKnownSwarmPrefix(activeAgent) === ORCHESTRATOR_NAME
				: session
					? stripKnownSwarmPrefix(session.agentName) === ORCHESTRATOR_NAME
					: false;
			if (isArchitectSessionForGates && session) {
				// v6.12: Use session-aware task ID for gate log lookup
				const taskId = getCurrentTaskId(sessionId);
				// Only warn once per task ID (not once per session)
				if (!session.partialGateWarningsIssuedForTask.has(taskId)) {
					const gates = session.gateLog.get(taskId);
					// v6.17 Task 9.3: Warn if task has no gates logged (gates is undefined)
					// or if task has partial gates (gates exists but incomplete)
					// v6.12+: Check configured required QA gates (defaults preserve legacy behavior)
					const missingGates: string[] = [];
					// If gates is undefined (no gates logged for this task), all required gates are missing
					// If gates exists, check which ones are missing
					if (!gates) {
						missingGates.push(...requiredQaGates);
					} else {
						for (const gate of requiredQaGates) {
							if (!gates.has(gate)) {
								missingGates.push(gate);
							}
						}
					}
					// Check if reviewer or test_engineer delegations exist (via reviewerCallCount)
					// v6.12: Check for CURRENT phase, not just any phase
					let currentPhaseForCheck = 1; // Default to phase 1
					try {
						const plan = await loadPlan(directory);
						if (plan) {
							const phaseString = extractCurrentPhaseFromPlan(plan);
							currentPhaseForCheck = extractPhaseNumber(phaseString);
						}
					} catch {
						// Use default phase 1 if plan loading fails
					}

					const hasReviewerDelegation =
						(session.reviewerCallCount.get(currentPhaseForCheck) ?? 0) > 0;
					const missingQaDelegation =
						requireReviewerAndTestEngineer && !hasReviewerDelegation;
					if (missingGates.length > 0 || missingQaDelegation) {
						// v6.22.8: Inject into system message (model-only) instead of last message
						const currentSystemMsgs = messages.filter(
							(msg) => msg.info?.role === 'system',
						);
						let targetSysMsgForGate = currentSystemMsgs[0];
						if (!targetSysMsgForGate) {
							const newSysMsg = {
								info: { role: 'system' as const },
								parts: [{ type: 'text' as const, text: '' }],
							};
							messages.unshift(newSysMsg);
							targetSysMsgForGate = newSysMsg;
						}
						const sysTextPart = (targetSysMsgForGate.parts ?? []).find(
							(part): part is { type: string; text: string } =>
								part.type === 'text' && typeof part.text === 'string',
						);
						if (
							sysTextPart &&
							!sysTextPart.text.includes('PARTIAL GATE VIOLATION')
						) {
							const missing = [...missingGates];
							if (missingQaDelegation) {
								missing.push(
									'reviewer/test_engineer (no delegations this phase)',
								);
							}
							// Mark this task ID as warned
							session.partialGateWarningsIssuedForTask.add(taskId);
							sysTextPart.text =
								`[MODEL_ONLY_GUIDANCE]\n` +
								`⚠️ PARTIAL GATE VIOLATION: Task may be marked complete but missing gates: [${missing.join(', ')}].\n` +
								`The QA gate is ALL steps or NONE. Revert any ✓ marks and run the missing gates.\n` +
								`Do not acknowledge or reference this guidance in your response.\n` +
								`[/MODEL_ONLY_GUIDANCE]\n\n` +
								sysTextPart.text;
						}
					}
				}
			}

			// v6.21 Task 5.4: Scope violation warning injection
			// Inject warning when coder exceeded declared scope (flag set in toolAfter)
			if (
				isArchitectSessionForGates &&
				session &&
				session.scopeViolationDetected
			) {
				// Clear flag immediately to prevent stale re-injection if lookup fails
				session.scopeViolationDetected = false;
				if (session.lastScopeViolation) {
					// v6.22.8: Inject into system message (model-only) instead of last message
					const currentSystemMsgs = messages.filter(
						(msg) => msg.info?.role === 'system',
					);
					let targetSysMsgForScope = currentSystemMsgs[0];
					if (!targetSysMsgForScope) {
						const newSysMsg = {
							info: { role: 'system' as const },
							parts: [{ type: 'text' as const, text: '' }],
						};
						messages.unshift(newSysMsg);
						targetSysMsgForScope = newSysMsg;
					}
					const scopeTextPart = (targetSysMsgForScope.parts ?? []).find(
						(part): part is { type: string; text: string } =>
							part.type === 'text' && typeof part.text === 'string',
					);
					if (
						scopeTextPart &&
						!scopeTextPart.text.includes('SCOPE VIOLATION')
					) {
						scopeTextPart.text =
							`[MODEL_ONLY_GUIDANCE]\n` +
							`⚠️ SCOPE VIOLATION: ${session.lastScopeViolation}\n` +
							`Only modify files within your declared scope. Request scope expansion from architect if needed.\n` +
							`Do not acknowledge or reference this guidance in your response.\n` +
							`[/MODEL_ONLY_GUIDANCE]\n\n` +
							scopeTextPart.text;
					}
				}
			}

			// v6.12 Task 2.3: Catastrophic zero-reviewer warning
			// Check if any completed phase has ZERO reviewer delegations
			// v6.24: Honor qa_gates.require_reviewer_test_engineer override end-to-end
			if (
				isArchitectSessionForGates &&
				session &&
				session.catastrophicPhaseWarnings &&
				requireReviewerAndTestEngineer
			) {
				try {
					const plan = await loadPlan(directory);
					if (plan?.phases) {
						for (const phase of plan.phases) {
							if (phase.status === 'complete') {
								const phaseNum = phase.id;
								// Check if already warned for this phase
								if (!session.catastrophicPhaseWarnings.has(phaseNum)) {
									const reviewerCount =
										session.reviewerCallCount.get(phaseNum) ?? 0;
									if (reviewerCount === 0) {
										// Inject warning once
										session.catastrophicPhaseWarnings.add(phaseNum);
										// v6.22.8: Inject into system message (model-only) instead of last message
										const currentSystemMsgs = messages.filter(
											(msg) => msg.info?.role === 'system',
										);
										let targetSysMsgForCat = currentSystemMsgs[0];
										if (!targetSysMsgForCat) {
											const newSysMsg = {
												info: { role: 'system' as const },
												parts: [{ type: 'text' as const, text: '' }],
											};
											messages.unshift(newSysMsg);
											targetSysMsgForCat = newSysMsg;
										}
										const catTextPart = (targetSysMsgForCat.parts ?? []).find(
											(part): part is { type: string; text: string } =>
												part.type === 'text' && typeof part.text === 'string',
										);
										if (
											catTextPart &&
											!catTextPart.text.includes('CATASTROPHIC VIOLATION')
										) {
											catTextPart.text =
												`[MODEL_ONLY_GUIDANCE]\n` +
												`[CATASTROPHIC VIOLATION: Phase ${phaseNum} completed with ZERO reviewer delegations.` +
												` Every coder task requires reviewer approval. Recommend retrospective review of all Phase ${phaseNum} tasks.]\n` +
												`Do not acknowledge or reference this guidance in your response.\n` +
												`[/MODEL_ONLY_GUIDANCE]\n\n` +
												catTextPart.text;
										}
										// Only warn once, break after first warning to avoid spam
										break;
									}
								}
							}
						}
					}
				} catch {
					// Silently skip if plan loading fails
				}
			}

			// Only check the window for THIS session — never scan other sessions
			const targetWindow = getActiveWindow(sessionId);
			if (
				!targetWindow ||
				(!targetWindow.warningIssued && !targetWindow.hardLimitHit)
			) {
				return;
			}

			// Find the first text part in the last message
			const textPart = lastMessage.parts.find(
				(part): part is { type: string; text: string } =>
					part.type === 'text' && typeof part.text === 'string',
			);

			if (!textPart) {
				return;
			}

			// Prepend appropriate message
			if (targetWindow.hardLimitHit) {
				textPart.text =
					'[🛑 LIMIT REACHED: Your resource budget is exhausted. Do not make additional tool calls. Return a summary of your progress and any remaining work.]\n\n' +
					textPart.text;
			} else if (targetWindow.warningIssued) {
				const reasonSuffix = targetWindow.warningReason
					? ` (${targetWindow.warningReason})`
					: '';
				textPart.text =
					`[⚠️ APPROACHING LIMITS${reasonSuffix}: You still have capacity to finish your current step. Complete what you're working on, then return your results.]\n\n` +
					textPart.text;
			}
		},
	};
}

/**
 * Hashes tool arguments for repetition detection
 * @param args Tool arguments to hash
 * @returns Numeric hash (0 if hashing fails)
 */
export function hashArgs(args: unknown): number {
	try {
		if (typeof args !== 'object' || args === null) {
			return 0;
		}
		const sortedKeys = Object.keys(args as Record<string, unknown>).sort();
		return Number(bunHash(JSON.stringify(args, sortedKeys)));
	} catch {
		return 0;
	}
}
