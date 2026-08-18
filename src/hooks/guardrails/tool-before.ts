/**
 * Tool Before Handler Factory
 *
 * Extracted from guardrails/index.ts (task 1.4 / FR-005).
 * Creates the toolBefore handler used by createGuardrailsHooks.
 * The factory receives shared configuration and closures from the
 * guardrails hooks factory, so the handler can enforce destructive
 * command blocking, file authority, scope, self-coding gates, write
 * target checks, and circuit breaker limits.
 */

import * as path from 'node:path';
import { HUMAN_ONLY_SWARM_COMMANDS } from '../../commands/tool-policy.js';
import {
	OPENCODE_NATIVE_AGENTS,
	ORCHESTRATOR_NAME,
} from '../../config/constants';
import {
	type AuthorityConfig,
	type GuardrailsConfig,
	resolveGuardrailsConfig,
	stripKnownSwarmPrefix,
} from '../../config/schema';
import { resolveScopePaths } from '../../sandbox/scope-resolver';
import { sanitizeDiagnosticText } from '../../scope/path-identity';
import type { ScopeLeaseCandidateInput } from '../../scope/scope-lease-renewal';
import {
	resolveAuthorizedScopeBindingDetailed,
	resolveAuthorizedScopeBindingForSessionDetailed,
} from '../../scope/scope-persistence';
import { formatScopeResolutionDiagnostic } from '../../scope/scope-resolution-diagnostic';
import {
	beginInvocation,
	ensureAgentSession,
	getActiveWindow,
	getModifiedFilesForTask,
	type InvocationWindow,
	recordModifiedFileForTask,
	recordReviewerScopeGenerationFile,
	resetModifiedFilesForTask,
	resolveSessionWorkspaceDirectory,
	swarmState,
} from '../../state';
import { telemetry } from '../../telemetry.js';
import { warn } from '../../utils';
import { normalizePatchIndentation } from '../../utils/patch-dedent';
import { isPathUnderSwarmWorktreeBase } from '../../worktree/core.js';
import { detectLoop } from '../loop-detector';
import { normalizeToolName } from '../normalize-tool-name';
import {
	detectInteractiveSession,
	detectPosixWrites,
	detectWindowsWrites,
	resolveWriteTargets,
	type WriteAnalysis,
} from '../shell-write-detect';
import {
	PATCH_PAYLOAD_KEYS,
	resolveWriteTargets as resolveFileWriteTargets,
} from '../write-target-resolver';
import { appendGuardrailDecision } from './audit-log';
import {
	dcCheckJunctionCreation,
	dcEvaluateRecursiveDeleteTargets,
	dcExtractPowerShellTargets,
	dcExtractRecursiveRmTargets,
	dcExtractWindowsCmdTargets,
	dcNormalizeCommand,
	dcSplitSegments,
	dcUnwrapWrappers,
} from './destructive-command';
import {
	enforceExecutionStallDenial,
	observeExecutionStallToolCall,
} from './execution-stall';
import type { AgentRule } from './file-authority';
import {
	AUTHORITY_ROLE_CAPABILITIES,
	checkFileAuthorityWithRules,
	checkWriteTargetForSymlink,
	hashArgs,
	matchesAuthorityDenyPrefix,
} from './file-authority';
import { enforceSpecDriftGate } from './index';
import { enforceInternalsGuard } from './internals-guard';
import {
	assertNonTransientCircuitAllowsTool,
	forgetToolExecution,
	markToolExecutionSandboxWrapped,
	nonTransientHardStopMessage,
	recordNonTransientFailure,
	rememberToolExecution,
} from './nontransient-circuit';
import { setStoredInputArgs } from './stored-input-args';

// ---- Types ----

/**
 * Shared context passed from createGuardrailsHooks to the toolBefore factory.
 */
export interface ToolBeforeContext {
	/** Resolved working directory for the guardrails hooks */
	effectiveDirectory: string;
	/** Resolved guardrails configuration */
	cfg: GuardrailsConfig;
	/** Pre-computed per-agent authority rules */
	precomputedAuthorityRules: Record<string, AgentRule>;
	/** Global deny prefixes — apply to all agents regardless of per-agent rules */
	universalDenyPrefixes: string[];
	/** Shell audit log path */
	shellAuditPath: string;
	/** Whether shell audit logging is enabled */
	shellAuditEnabled: boolean;
	/** Agents allowed to use bash/shell interpreter (undefined = all allowed) */
	interpreterAllowedAgents: string[] | undefined;
	/** Authority config (for verifier config paths) */
	authorityConfig: AuthorityConfig | undefined;
	/** Shared consecutiveNoToolTurns Map (also used by messagesTransform) */
	consecutiveNoToolTurns: Map<string, number>;
	/**
	 * Configured swarm worktree-dir override(s), if any. Treated as additional
	 * trusted roots when exempting `git worktree remove --force` (issue #1708).
	 */
	worktreeBaseDirOverrides?: string[];
	/** Sandbox executor getter seam for tests and platform-specific overrides. */
	getSandboxExecutor: typeof import('../../sandbox/executor').getExecutor;
	/** Hold exact child-write provenance until the matching after-hook succeeds. */
	rememberReviewerScopeWrite?: (input: {
		callID: string;
		parentSessionID: string;
		taskId: string;
		coderCallID: string;
		file: string;
	}) => void;
	/** Snapshot an exact authorized write for success-only lease renewal. */
	rememberScopeLeaseCandidate?: (input: ScopeLeaseCandidateInput) => void;
}

// Shared helper functions extracted to helpers.ts (task 1.4 / FR-005)
import {
	hasTraversalSegments,
	isConfigFilePath,
	isInDeclaredScope,
	isOutsideSwarmDir,
	isSourceCodePath,
	isWriteTool,
	redactShellCommand,
} from './helpers';

let hasWarnedSandboxUnavailable = false;

/**
 * Creates a toolBefore handler with the given shared context.
 *
 * @param ctx Shared configuration and closures from createGuardrailsHooks
 * @returns The toolBefore handler function
 */
export function createToolBeforeHandler(ctx: ToolBeforeContext) {
	const {
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
		getSandboxExecutor,
		rememberReviewerScopeWrite,
		rememberScopeLeaseCandidate,
	} = ctx;

	/**
	 * Issue #2063 B4/B5 — containment options, computed once per handler.
	 *
	 * These read the TOP-LEVEL `cfg` and deliberately do NOT go through
	 * `resolveGuardrailsConfig`. That is safe, and verified rather than assumed:
	 * `GuardrailsProfileSchema` (schema.ts:916-924) is a CLOSED seven-key budget
	 * subset — `max_tool_calls`, `max_duration_minutes`, `max_repetitions`,
	 * `max_consecutive_errors`, `warning_threshold`, `idle_timeout_minutes`,
	 * `max_transient_retries`. Zod strips unknown keys, so a user writing
	 * `guardrails.profiles.architect.execution_stall_stop_calls` (or a per-agent
	 * `enabled`) has it dropped at PARSE time and
	 * `resolveGuardrailsConfig(cfg, 'architect').execution_stall_stop_calls`
	 * provably equals `cfg.execution_stall_stop_calls`. Resolving per agent here
	 * would therefore be machinery that can never change an answer.
	 *
	 * `tests/unit/hooks/execution-stall-wiring.test.ts` pins that assumption: if
	 * `GuardrailsProfileSchema` ever gains `enabled` or an `execution_stall_*`
	 * key, that test fails and points here.
	 *
	 * `enabled` is threaded explicitly even though `createGuardrailsHooks`
	 * already short-circuits to no-op handlers when guardrails are disabled: the
	 * two containment modules are also callable directly (and are unit-tested
	 * that way), so each must own its own inert path rather than relying on a
	 * caller-side guard. Same contract as `GateDenialOptions.enabled` (B1).
	 */
	const executionStallOptions = {
		enabled: cfg.enabled,
		warnCalls: cfg.execution_stall_warn_calls,
		stopCalls: cfg.execution_stall_stop_calls,
		episodeMinutes: cfg.execution_stall_episode_minutes,
	};
	const internalsGuardOptions = { enabled: cfg.enabled };

	/**
	 * Issue #2002: `effectiveDirectory` is the plugin-root `ctx.directory`,
	 * captured once when this handler is built and shared by EVERY session.
	 * Worktree-isolated coder children execute in a lane root and have their
	 * scope binding derived and published against that lane, so resolving their
	 * binding, containment, sandbox grants, or lstat checks against the project
	 * root is always wrong.
	 *
	 * Use this for SESSION-SCOPED decisions ("where is this agent actually
	 * working"). Do NOT use it for PROJECT-SCOPED governance checks — the
	 * plan/spec write guards and the spec-drift gate protect *the project's*
	 * artifacts and must keep `effectiveDirectory`.
	 *
	 * Fail-closed: a session with no recorded lane root resolves to
	 * `effectiveDirectory`, i.e. the pre-#2002 behaviour.
	 */
	const sessionWorkspaceDirectory = (sessionID: string): string =>
		resolveSessionWorkspaceDirectory(sessionID, effectiveDirectory);

	/**
	 * Resolves only an active, child-owned, Task-correlated v2 binding.
	 * Legacy v1 disk/session entries are intentionally not authorization sources.
	 */
	function resolveActiveScopeBinding(sessionID: string) {
		const session = swarmState.agentSessions.get(sessionID);
		const taskId = session?.currentTaskId ?? null;
		const bindingDirectory = sessionWorkspaceDirectory(sessionID);
		const resolution = taskId
			? resolveAuthorizedScopeBindingDetailed({
					directory: bindingDirectory,
					taskId,
					activeSessionId: sessionID,
				})
			: resolveAuthorizedScopeBindingForSessionDetailed({
					directory: bindingDirectory,
					activeSessionId: sessionID,
				});
		const binding = resolution.status === 'found' ? resolution.binding : null;
		if (!binding) {
			const diagnostic = formatScopeResolutionDiagnostic({
				resolution,
				taskId,
				sessionId: sessionID,
			});
			if (diagnostic) throw new Error(diagnostic);
		}
		if (!taskId && binding && session) {
			session.currentTaskId = binding.taskId;
			session.declaredCoderScope = [...binding.files];
		}
		return binding;
	}

	function resolveDeclaredScope(sessionID: string): string[] | null {
		return resolveActiveScopeBinding(sessionID)?.files ?? null;
	}

	/**
	 * Detects if the current session is controlled by the architect (orchestrator).
	 */
	function isArchitect(sessionId: string): boolean {
		const activeAgent = swarmState.activeAgent.get(sessionId);
		if (activeAgent) {
			const stripped = stripKnownSwarmPrefix(activeAgent);
			if (stripped === ORCHESTRATOR_NAME) return true;
		}

		const session = swarmState.agentSessions.get(sessionId);
		if (session) {
			const stripped = stripKnownSwarmPrefix(session.agentName);
			if (stripped === ORCHESTRATOR_NAME) return true;
		}

		return false;
	}

	/**
	 * Blocks bash/shell tool calls from agent roles not in interpreter_allowed_agents.
	 */
	function handleInterpreterGating(sessionID: string, tool: string): void {
		const normalizedTool = normalizeToolName(tool).toLowerCase();
		if (normalizedTool !== 'bash' && normalizedTool !== 'shell') return;
		if (!interpreterAllowedAgents) return;

		const rawAgent = swarmState.activeAgent.get(sessionID);
		const agentRole = rawAgent
			? stripKnownSwarmPrefix(rawAgent).toLowerCase()
			: 'unknown';

		const allowed = interpreterAllowedAgents.some(
			(a) => a.toLowerCase() === agentRole,
		);
		if (!allowed) {
			throw new Error(
				`BLOCKED: Agent "${agentRole}" is not permitted to use the bash/shell interpreter. ` +
					`Allowed agents: [${interpreterAllowedAgents.map((a) => `"${a}"`).join(', ')}]`,
			);
		}
	}

	/**
	 * Check if a bash/shell command is potentially destructive and should be blocked.
	 */
	function checkDestructiveCommand(
		sessionID: string,
		tool: string,
		args: unknown,
	): void {
		if (tool !== 'bash' && tool !== 'shell') return;
		if (cfg.block_destructive_commands === false) return;

		const rawAgent = swarmState.activeAgent.get(sessionID);
		const agentRole = rawAgent
			? stripKnownSwarmPrefix(rawAgent).toLowerCase()
			: 'unknown';
		const isCoder = agentRole === 'coder';

		const activeBinding = isCoder ? resolveActiveScopeBinding(sessionID) : null;
		const bindingIdentity = activeBinding as
			| (typeof activeBinding & {
					bindingId?: unknown;
					generationId?: unknown;
			  })
			| null;
		const verifiedScope =
			bindingIdentity &&
			typeof bindingIdentity.bindingId === 'string' &&
			typeof bindingIdentity.generationId === 'string'
				? {
						bindingId: bindingIdentity.bindingId,
						generationId: bindingIdentity.generationId,
						files: bindingIdentity.files,
					}
				: undefined;
		const declaredScope = activeBinding?.files ?? null;
		const toolArgs = args as Record<string, unknown> | undefined;
		const rawCommand =
			typeof toolArgs?.command === 'string' ? toolArgs.command.trim() : '';
		if (!rawCommand) return;

		// Issue #2002: a lane coder's shell command runs with the lane as cwd, so
		// destructive-target containment must be evaluated against the lane root.
		const cwd = sessionWorkspaceDirectory(sessionID);

		// --- Normalize the top-level command (NFKC + evasion collapse) ---
		const command = dcNormalizeCommand(rawCommand);

		// --- Fork bomb ---
		if (/:\s*\(\s*\)\s*\{[^}]*\|[^}]*:/.test(command)) {
			throw new Error(
				`BLOCKED: Potentially destructive shell command detected: fork bomb pattern`,
			);
		}

		// --- Unwrap all shell wrappers to the innermost command ---
		const unwrapped = dcUnwrapWrappers(command);

		// --- Split compound command into segments ---
		const outerSegments = dcSplitSegments(command);
		const innerSegments = dcSplitSegments(unwrapped);
		const perSegmentUnwrapped = outerSegments.map((s) => dcUnwrapWrappers(s));
		const allSegments = [
			...new Set([...outerSegments, ...innerSegments, ...perSegmentUnwrapped]),
		];

		for (const segment of allSegments) {
			const seg = segment.trim();
			if (!seg) continue;

			// Junction/symlink CREATION with out-of-cwd target
			const junctionBlock = dcCheckJunctionCreation(seg, cwd);
			if (junctionBlock) throw new Error(junctionBlock);

			// POSIX rm — recursive/force delete detection.
			// Extract leading flag tokens then targets, and require a
			// recursive/force flag. Matching flags generically (instead of a
			// strict -[rRfF]+ class) catches stacked non-rf letters such as
			// `rm -rfv` / `rm -vrf` that the old pattern missed (issue #1778 H3),
			// while still catching -r/-f alone and --recursive/--force in any order.
			const rmTargets = dcExtractRecursiveRmTargets(seg);
			if (rmTargets) {
				const decision = dcEvaluateRecursiveDeleteTargets({
					targets: rmTargets,
					cwd,
					verifiedScope,
				});
				if (!decision.allowed) throw new Error(decision.reason);
			}

			// Windows cmd.exe: rmdir /s, rd /s
			if (/^(?:rmdir|rd)(?:\.exe)?\s+.*\/[sS]/i.test(seg)) {
				const targets = dcExtractWindowsCmdTargets(seg);
				if (targets.length === 0) {
					throw new Error(
						`BLOCKED: Windows recursive directory delete (rmdir /s or rd /s) detected. Verify the target is not a junction/symlink.`,
					);
				}
				const decision = dcEvaluateRecursiveDeleteTargets({
					targets,
					cwd,
					verifiedScope,
				});
				if (!decision.allowed) throw new Error(decision.reason);
			}

			// Windows cmd.exe: del /s /q /f
			if (/^del(?:\.exe)?\s+.*\/[sS]/i.test(seg)) {
				const targets = dcExtractWindowsCmdTargets(seg);
				if (targets.length > 0) {
					const decision = dcEvaluateRecursiveDeleteTargets({
						targets,
						cwd,
						verifiedScope,
					});
					if (!decision.allowed) throw new Error(decision.reason);
				}
			}

			// PowerShell: Remove-Item / aliases with -Recurse
			if (
				/^(?:Remove-Item|ri|rm|rmdir|del|erase|rd)\b.*-[Rr]ecurse\b/i.test(
					seg,
				) ||
				/^(?:Remove-Item|ri|rm|rmdir|del|erase|rd)\b.*-[Rr]\b/i.test(seg)
			) {
				const targets = dcExtractPowerShellTargets(seg);
				if (targets.length > 0) {
					const decision = dcEvaluateRecursiveDeleteTargets({
						targets,
						cwd,
						verifiedScope,
					});
					if (!decision.allowed) throw new Error(decision.reason);
				} else {
					throw new Error(
						`BLOCKED: PowerShell Remove-Item with -Recurse detected — cannot verify target safety`,
					);
				}
			}

			// PowerShell: Get-ChildItem | Remove-Item -Recurse (pipe form)
			if (
				/Get-ChildItem\b.*\|\s*Remove-Item\b.*-[Rr]ecurse/i.test(seg) ||
				/gci\b.*\|\s*ri\b.*-[Rr]ecurse/i.test(seg)
			) {
				throw new Error(
					`BLOCKED: PowerShell pipeline "Get-ChildItem | Remove-Item -Recurse" detected — verify target safety and avoid recursive deletion through symlinks/junctions`,
				);
			}

			// Ransomware-grade / disk-level destruction
			if (/^vssadmin(?:\.exe)?\s+delete\b/i.test(seg)) {
				throw new Error(
					`BLOCKED: "vssadmin delete" detected — deletes Volume Shadow Copies (ransomware-grade operation)`,
				);
			}
			if (/^wbadmin(?:\.exe)?\s+delete\b/i.test(seg)) {
				throw new Error(
					`BLOCKED: "wbadmin delete" detected — deletes Windows backup catalog (ransomware-grade operation)`,
				);
			}
			if (/^diskpart(?:\.exe)?$/i.test(seg)) {
				throw new Error(
					`BLOCKED: "diskpart" detected — interactive disk partitioning tool`,
				);
			}
			if (/^bcdedit(?:\.exe)?\s+\/delete\b/i.test(seg)) {
				throw new Error(
					`BLOCKED: "bcdedit /delete" detected — modifies Windows boot configuration`,
				);
			}
			if (/^sdelete(?:\.exe)?\s+/i.test(seg)) {
				throw new Error(
					`BLOCKED: "sdelete" detected — secure file deletion (Sysinternals)`,
				);
			}
			if (
				/^fsutil(?:\.exe)?\s+reparsepoint\s+delete\b/i.test(seg) ||
				/^fsutil(?:\.exe)?\s+file\s+setzerodata\b/i.test(seg)
			) {
				throw new Error(`BLOCKED: "fsutil" destructive subcommand detected`);
			}
			if (/^takeown(?:\.exe)?\s+.*\/[rR]\b/i.test(seg)) {
				throw new Error(
					`BLOCKED: "takeown /R" (recursive ownership takeover) detected — often precedes destructive operations`,
				);
			}
			if (/^cipher(?:\.exe)?\s+\/[wW]\b/i.test(seg)) {
				throw new Error(
					`BLOCKED: "cipher /w" detected — overwrites free disk space (data wipe operation)`,
				);
			}
			if (/^format\s+[A-Za-z]:/i.test(seg)) {
				throw new Error(`BLOCKED: Windows disk format command detected`);
			}
			if (/^robocopy(?:\.exe)?\s+.*\/(?:MIR|mir)\b/.test(seg)) {
				throw new Error(
					`BLOCKED: "robocopy /MIR" (mirror) detected — can delete files in the destination that don't exist in the source`,
				);
			}

			// POSIX: chmod/chattr/icacls denial-of-service patterns
			if (/^chmod\s+.*-[rR]\b.*000\b/.test(seg)) {
				throw new Error(
					`BLOCKED: "chmod -R 000" detected — removes all permissions recursively`,
				);
			}
			if (/^chattr\s+.*\+i\b/.test(seg)) {
				throw new Error(
					`BLOCKED: "chattr +i" detected — makes files immutable`,
				);
			}
			if (/^icacls(?:\.exe)?\s+.*\/deny\b/i.test(seg)) {
				throw new Error(
					`BLOCKED: "icacls /deny" detected — denies filesystem permissions`,
				);
			}

			// dd data-wipe patterns
			if (/^dd\b.*\bif=\/dev\/(zero|null|urandom)\b/.test(seg)) {
				throw new Error(
					`BLOCKED: "dd" with /dev/zero, /dev/null, or /dev/urandom as input detected — data wipe operation`,
				);
			}

			// Git destructive operations.
			// `--force-with-lease` is exempt: it refuses to overwrite work the
			// remote gained since your last fetch, so it is the safe force-push the
			// publication protocol (commit-pr) mandates for fork/rebase flows. This
			// matches full-auto/policy.ts, which already exempts it. Bare `--force`
			// and `-f` remain blocked. (#1692)
			if (/^git\s+push\b.*?(--force(?!-with-lease)|-f)\b/.test(seg)) {
				throw new Error(
					`BLOCKED: Force push detected — git push --force is not allowed (use --force-with-lease instead)`,
				);
			}
			if (/^git\s+reset\s+--hard/.test(seg)) {
				throw new Error(
					`BLOCKED: "git reset --hard" detected — use --soft or --mixed with caution`,
				);
			}
			if (/^git\s+reset\s+--mixed\s+\S+/.test(seg)) {
				throw new Error(
					`BLOCKED: "git reset --mixed" with a target branch/commit is not allowed`,
				);
			}
			if (/^git\s+clean\s+.*-[fF].*[dD]/.test(seg)) {
				throw new Error(
					`BLOCKED: "git clean -fd" detected — permanently deletes untracked files and directories`,
				);
			}
			// git worktree remove --force: scope-exempt when the target resolves inside
			// the swarm-managed worktree base directory or a coder's declared scope.
			// Mirrors the rsync --delete scopeExempt pattern below. Unlike rsync, this
			// call path often runs with no declared coder scope (orchestrator/cleanup),
			// so the swarm worktree base directory is also a trusted root — see
			// isPathUnderSwarmWorktreeBase in src/worktree/core.ts.
			const worktreeRemoveMatch = /^git\s+worktree\s+remove\s+(.+)$/i.exec(seg);
			if (worktreeRemoveMatch) {
				const rawArgs = worktreeRemoveMatch[1]
					.trim()
					.split(/\s+/)
					.filter(Boolean);
				// Strip a single surrounding quote pair from every token BEFORE the
				// force check. A real shell strips these quotes before git ever sees
				// the args, so `git worktree remove "--force" <path>` is executed by
				// git exactly as `--force`. dcNormalizeCommand only collapses *doubled*
				// quotes, not a single surrounding pair, so `"--force"`/`'--force'`
				// reach us with quotes attached. Without this normalization the exact
				// force check below fails and the entire containment guard is skipped —
				// a bypass. (Mirrors the quote-stripping already done on the path arg.)
				const normalizedArgs = rawArgs.map((a) =>
					a.replace(/^["']|["']$/g, ''),
				);
				// Recognize the force flag spellings git actually honors, so no
				// abbreviation slips past the containment check:
				//   - short form: -f and stacked repeats (-ff, -fff, …) → /^-f+$/
				//   - long form: any non-empty prefix of --force that is longer than
				//     the bare "--" end-of-options marker (--f, --fo, --for, --forc,
				//     --force) → length > 2 && '--force'.startsWith(token)
				// Case-insensitive to preserve the prior /i regex's behavior (an
				// uppercase "--FORCE" evasion attempt is still treated as force intent).
				const isForceToken = (a: string): boolean => {
					const lower = a.toLowerCase();
					return (
						/^-f+$/.test(lower) ||
						(lower.length > 2 && '--force'.startsWith(lower))
					);
				};
				const hasForce = normalizedArgs.some(isForceToken);
				if (hasForce) {
					// Every force spelling (isForceToken) begins with '-', so the
					// leading-dash filter already excludes them along with any other
					// flag; positional path args are what remain.
					const pathArgs = normalizedArgs.filter((a) => !a.startsWith('-'));
					const target = pathArgs.length === 1 ? pathArgs[0].trim() : null;
					const scopeExempt =
						target != null &&
						target.length > 0 &&
						((declaredScope != null &&
							declaredScope.length > 0 &&
							isInDeclaredScope(target, declaredScope, cwd)) ||
							isPathUnderSwarmWorktreeBase(
								target,
								cwd,
								worktreeBaseDirOverrides ?? [],
							));
					if (!scopeExempt) {
						throw new Error(
							`BLOCKED: "git worktree remove --force" detected — can delete working tree contents`,
						);
					}
				}
			}

			// rsync mirror / sync with delete
			if (/^rsync\b.*--delete(?:-after|-before|-during|-delay)?\b/.test(seg)) {
				const rsyncArgs = seg.split(/\s+/).slice(1);
				const rsyncTarget = rsyncArgs
					.filter((a) => !a.startsWith('-') && !a.includes('@'))
					.pop();
				const scopeExempt =
					rsyncTarget != null &&
					declaredScope != null &&
					declaredScope.length > 0 &&
					isInDeclaredScope(rsyncTarget, declaredScope, cwd);
				if (!scopeExempt) {
					throw new Error(
						`BLOCKED: "rsync --delete" detected — can delete files in the destination. Verify source is not empty.`,
					);
				}
			}

			// kubectl / docker
			if (/^kubectl\s+delete\b/.test(seg)) {
				throw new Error(
					`BLOCKED: "kubectl delete" detected — destructive cluster operation`,
				);
			}
			if (/^docker\s+system\s+prune\b/.test(seg)) {
				throw new Error(
					`BLOCKED: "docker system prune" detected — destructive container operation`,
				);
			}

			// SQL DDL
			if (/^\s*DROP\s+(TABLE|DATABASE|SCHEMA)\b/i.test(seg)) {
				throw new Error(
					`BLOCKED: SQL DROP command detected — destructive database operation`,
				);
			}
			if (/^\s*TRUNCATE\s+TABLE\b/i.test(seg)) {
				throw new Error(
					`BLOCKED: SQL TRUNCATE command detected — destructive database operation`,
				);
			}

			// Disk format
			if (/^mkfs[./]/.test(seg)) {
				throw new Error(
					`BLOCKED: Disk format command (mkfs) detected — disk formatting operation`,
				);
			}

			// POSIX mv targeting .swarm/ paths
			if (/^\\?mv\s/i.test(seg)) {
				const mvMatch = seg.match(/^\\?mv\s+(.+)$/i);
				if (mvMatch) {
					const argsStr = mvMatch[1].replace(/["']/g, '');
					if (/\.swarm(?:[\x5c/\s]|$)/.test(argsStr)) {
						throw new Error(
							`BLOCKED: "mv" targeting .swarm/ detected — move operations under .swarm/ are not allowed from shell commands`,
						);
					}
				}
			}

			// Windows cmd move/ren targeting .swarm\ paths
			if (/^\\?(?:move|ren)(?:\.exe)?\s/i.test(seg)) {
				const moveMatch = seg.match(/^\\?(?:move|ren)(?:\.exe)?\s+(.+)$/i);
				if (moveMatch) {
					const argsStr = moveMatch[1].replace(/["']/g, '');
					if (/\.swarm(?:[\x5c/\s]|$)/i.test(argsStr)) {
						throw new Error(
							`BLOCKED: "move" or "ren" targeting .swarm/ detected — move/rename operations under .swarm/ are not allowed from shell commands`,
						);
					}
				}
			}

			// PowerShell Move-Item/Rename-Item targeting .swarm/ paths
			if (
				/^\\?(?:Move-Item|Rename-Item|move|mi|mv|ren|rni)\b.*\.swarm(?:[\x5c/\s]|$)/i.test(
					seg,
				)
			) {
				throw new Error(
					`BLOCKED: PowerShell Move-Item or Rename-Item targeting .swarm/ detected — move/rename operations under .swarm/ are not allowed from shell commands`,
				);
			}

			// Non-recursive rm targeting .swarm/ paths
			if (
				/^\\?rm\b/i.test(seg) &&
				!/^\\?rm\s+(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\b/i.test(seg) &&
				/\.swarm(?:[\x5c/\s]|$)/i.test(seg)
			) {
				throw new Error(
					`BLOCKED: "rm" targeting .swarm/ detected — deleting files under .swarm/ is not allowed from shell commands`,
				);
			}

			// cp + rm chain detection (copy-then-delete bypass)
			if (
				/\bcp\b.*\.swarm(?:[\x5c/\s]|$)/i.test(seg) &&
				/\brm\b.*\.swarm(?:[\x5c/\s]|$)/i.test(seg)
			) {
				throw new Error(
					`BLOCKED: "cp" of .swarm/ file followed by "rm" of .swarm/ source detected — copy-and-delete bypass is not allowed`,
				);
			}

			// Archive tools with delete-source flags targeting .swarm/
			if (
				/^rsync\b.*--remove-source-files\b/i.test(seg) &&
				/\.swarm(?:[\x5c/\s]|$)/i.test(seg)
			) {
				throw new Error(
					`BLOCKED: "rsync" with delete-source flag targeting .swarm/ detected — archive with source deletion under .swarm/ is not allowed`,
				);
			}
			if (
				/^tar\b.*--remove-files\b/i.test(seg) &&
				/\.swarm(?:[\x5c/\s]|$)/i.test(seg)
			) {
				throw new Error(
					`BLOCKED: "tar" with delete-source flag targeting .swarm/ detected — archive with source deletion under .swarm/ is not allowed`,
				);
			}
			if (/^zip\b.*\s-m\b/i.test(seg) && /\.swarm(?:[\x5c/\s]|$)/i.test(seg)) {
				throw new Error(
					`BLOCKED: "zip" with delete-source flag targeting .swarm/ detected — archive with source deletion under .swarm/ is not allowed`,
				);
			}
			if (
				/^7z\b.*\s-sdel\b/i.test(seg) &&
				/\.swarm(?:[\x5c/\s]|$)/i.test(seg)
			) {
				throw new Error(
					`BLOCKED: "7z" with delete-source flag targeting .swarm/ detected — archive with source deletion under .swarm/ is not allowed`,
				);
			}

			// Swarm CLI bypass — human-only `/swarm` subcommands
			{
				// Derived from COMMAND_REGISTRY via tool-policy.ts (single source of truth).
				// Includes both 'human-only' (refusal) and 'restricted' (blocked) commands.
				const HUMAN_ONLY_SWARM_SUBCOMMANDS = HUMAN_ONLY_SWARM_COMMANDS;

				let probe = seg
					.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)+/, '')
					.replace(/^eval(?:\s+--)?\s+["']?/, '')
					.replace(/["']\s*$/, '')
					.replace(/^\$\(\s*/, '')
					.replace(/^\(\s*/, '')
					.replace(/\s*\)$/, '')
					.replace(/^`/, '')
					.replace(/`$/, '')
					.trim();

				for (let i = 0; i < 4; i++) {
					const before = probe;
					probe = probe
						.replace(
							/^env\s+(?:-i\b|--ignore-environment\b|-u\s+\S+|-[a-zA-Z]+\s+)*\s*/,
							'',
						)
						.replace(/^command\s+(?:-[pvV]\s+)*/, '')
						.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)+/, '')
						.trim();
					if (probe === before) break;
				}

				// Form A: <runner> ... opencode-swarm ... run <subcmd> [subsubcmd]
				const swarmCliBypassMatch = probe.match(
					/^\\?(?:bunx|npx|pnpx|npm(?:\s+(?:exec|x)(?:\s+--)?)?|pnpm(?:\s+(?:dlx|exec))?|yarn(?:\s+(?:dlx|exec))?|bun(?:\s+x)?|node|deno\s+run|tsx|ts-node)\b[^|;&]*?\bopencode-swarm\b[^|;&]*?\brun\s+([A-Za-z0-9_-]+(?:\s+(?!-)[A-Za-z0-9_-]+)?)/i,
				);
				if (swarmCliBypassMatch) {
					const captured = swarmCliBypassMatch[1];
					// Normalize all whitespace (tabs, multiple spaces) to single spaces for consistent lookup
					const normalized = captured.trim().split(/\s+/).join(' ');
					const firstToken = normalized.includes(' ')
						? normalized.split(' ')[0]
						: normalized;
					const cmdName = HUMAN_ONLY_SWARM_SUBCOMMANDS.has(normalized)
						? normalized
						: firstToken;
					if (
						HUMAN_ONLY_SWARM_SUBCOMMANDS.has(normalized) ||
						HUMAN_ONLY_SWARM_SUBCOMMANDS.has(firstToken)
					) {
						throw new Error(
							`BLOCKED: "${cmdName}" is a human-only swarm command and may not be invoked from shell by an agent. ` +
								`Present the situation to the user and ask them to run \`/swarm ${cmdName}\` themselves.`,
						);
					}
				}

				// Form B: bare `opencode-swarm` on PATH
				const swarmBareBinMatch = probe.match(
					/^\\?opencode-swarm\b[^|;&]*?\brun\s+([A-Za-z0-9_-]+(?:\s+(?!-)[A-Za-z0-9_-]+)?)/i,
				);
				if (swarmBareBinMatch) {
					const captured = swarmBareBinMatch[1];
					// Normalize all whitespace (tabs, multiple spaces) to single spaces for consistent lookup
					const normalized = captured.trim().split(/\s+/).join(' ');
					const firstToken = normalized.includes(' ')
						? normalized.split(' ')[0]
						: normalized;
					const cmdName = HUMAN_ONLY_SWARM_SUBCOMMANDS.has(normalized)
						? normalized
						: firstToken;
					if (
						HUMAN_ONLY_SWARM_SUBCOMMANDS.has(normalized) ||
						HUMAN_ONLY_SWARM_SUBCOMMANDS.has(firstToken)
					) {
						throw new Error(
							`BLOCKED: "${cmdName}" is a human-only swarm command and may not be invoked from shell by an agent. ` +
								`Present the situation to the user and ask them to run \`/swarm ${cmdName}\` themselves.`,
						);
					}
				}

				// Secondary: dist-relative CLI path invocation
				const swarmCliPathMatch = probe.match(
					/\bcli[/\\]+index\.[mc]?(?:js|ts)\b[^|;&]*?\brun\s+([A-Za-z0-9_-]+(?:\s+(?!-)[A-Za-z0-9_-]+)?)/i,
				);
				if (swarmCliPathMatch) {
					const captured = swarmCliPathMatch[1];
					// Normalize all whitespace (tabs, multiple spaces) to single spaces for consistent lookup
					const normalized = captured.trim().split(/\s+/).join(' ');
					const firstToken = normalized.includes(' ')
						? normalized.split(' ')[0]
						: normalized;
					const cmdName = HUMAN_ONLY_SWARM_SUBCOMMANDS.has(normalized)
						? normalized
						: firstToken;
					if (
						HUMAN_ONLY_SWARM_SUBCOMMANDS.has(normalized) ||
						HUMAN_ONLY_SWARM_SUBCOMMANDS.has(firstToken)
					) {
						throw new Error(
							`BLOCKED: "${cmdName}" is a human-only swarm command and may not be invoked from shell by an agent. ` +
								`Present the situation to the user and ask them to run \`/swarm ${cmdName}\` themselves.`,
						);
					}
				}
			}

			// Direct shell manipulation of .swarm/spec-staleness.json
			{
				const normForPathCheck = seg
					.replace(/\\/g, '/')
					.replace(/\/(?:\.\/+)+/g, '/')
					.replace(/\/{2,}/g, '/');
				if (/\.swarm\/spec-staleness\.json\b/i.test(normForPathCheck)) {
					const trimmed = seg.trim();
					const looksReadOnly =
						/^(?:cat|less|more|head|tail|file|stat|ls|dir|Get-Content|gc|Get-Item|gi|type)\b/i.test(
							trimmed,
						);
					const hasWriteRedirect = />{1,2}\s*[^\s>]/.test(trimmed);
					if (!looksReadOnly || hasWriteRedirect) {
						throw new Error(
							'BLOCKED: shell command targeting .swarm/spec-staleness.json detected. ' +
								'This file is system-managed and gates plan-mutating tools while spec drift is unresolved. ' +
								'Present the drift to the user and ask them to run /swarm acknowledge-spec-drift.',
						);
					}
				}
			}
		}
	}

	/**
	 * Detects the shell type from command content for the 'shell' tool.
	 */
	function detectShellType(
		command: string,
	): 'bash' | 'powershell' | 'cmd' | 'unix' {
		if (
			/^(powershell|ps1|\.\s*\\|Remove-Item|Copy-Item|Move-Item|Start-Process|New-Object|Get-ChildItem|Set-Content|Add-Content|Out-File|Invoke-WebRequest|Invoke-RestMethod|IEX|iex)\b/i.test(
				command,
			) ||
			command.includes('$PSVersionTable') ||
			command.includes('$env:') ||
			/-EncodedCommand|-ExecutionPolicy|Enable-PSRemoting/i.test(command)
		) {
			return 'powershell';
		}

		if (
			/^(cmd|c:\/|set \w+=|\.\d+|del \/|rd \/|mkdir|chdir|echo |copy |move |ren |fc |diskpart)/i.test(
				command,
			) ||
			/%[^%\s]+%/.test(command) ||
			/\b(set|echo|if|exist)\s+/i.test(command)
		) {
			return 'cmd';
		}

		if (
			/^(bash|sh|zsh|ksh|ash|dash|fish|ruby|python|perl|npm|yarn|node|cargo|go|rustc|mv|cp|rm|chmod|chown|mkdir|ln|tar|gzip|gunzip|ssh|scp|rsync|sudo|su -|export |source |\.\s+)/i.test(
				command,
			) ||
			command.includes('|') ||
			command.includes('&&') ||
			command.includes('>>') ||
			/\$\{?\w+\}?/.test(command)
		) {
			return 'bash';
		}

		return 'unix';
	}

	/**
	 * Checks shell write operations against declared scope.
	 */
	function checkShellWriteScope(
		sessionID: string,
		callID: string,
		tool: string,
		args: unknown,
		commandOverride?: string,
	): void {
		if (tool !== 'bash' && tool !== 'shell') return;

		const toolArgs = args as Record<string, unknown> | undefined;
		const command =
			typeof commandOverride === 'string'
				? commandOverride.trim()
				: typeof toolArgs?.command === 'string'
					? toolArgs.command.trim()
					: '';

		if (!command) return;

		const normalizedTool = tool;

		let shellType: 'posix' | 'powershell' | 'cmd' | 'unix' | 'bash' = 'posix';

		if (normalizedTool === 'bash') {
			shellType = 'posix';
		} else {
			shellType = detectShellType(command) as
				| 'posix'
				| 'powershell'
				| 'cmd'
				| 'unix'
				| 'bash';
		}

		const interactiveShellType =
			shellType === 'unix' || shellType === 'bash' ? 'posix' : shellType;
		if (detectInteractiveSession(command, interactiveShellType)) {
			throw new Error(
				`BLOCKED: interactive/session tool detected — rejecting for safety`,
			);
		}

		const detect = (c: string): WriteAnalysis =>
			normalizedTool === 'bash'
				? detectPosixWrites(c)
				: shellType === 'powershell' || shellType === 'cmd'
					? detectWindowsWrites(c, shellType)
					: detectPosixWrites(c);

		// Fail-closed parse gate runs on the ORIGINAL command so a genuinely
		// malformed command (e.g. an unclosed quote) is still rejected for safety.
		const primaryAnalysis = detect(command);
		if (primaryAnalysis.parseError) {
			throw new Error(
				`BLOCKED: bash write detection failed to parse command — rejecting for safety`,
			);
		}

		// Unwrap shell wrappers (bash -c '…', sh -c '…', eval '…') on the
		// write-detection path so a redirect hidden inside a one-layer wrapper is
		// not invisible to the detector (issue #1778 H3). Only take the unwrapped
		// form when an actual unwrap occurred, so normal (unwrapped) commands are
		// analyzed byte-for-byte as before. Detection and resolveWriteTargets must
		// use the SAME string (resolveWriteTargets re-parses it for cwd tracking).
		const commandSegments = dcSplitSegments(command);
		const unwrappedSegments = commandSegments.map((s) => dcUnwrapWrappers(s));
		const didUnwrap = commandSegments.some(
			(s, i) => unwrappedSegments[i] !== s,
		);
		const detectionCommand = didUnwrap ? unwrappedSegments.join('\n') : command;

		const analysis = didUnwrap ? detect(detectionCommand) : primaryAnalysis;

		// A wrapped command whose unwrapped inner form fails to parse is also
		// rejected for safety.
		if (analysis.parseError) {
			throw new Error(
				`BLOCKED: bash write detection failed to parse command — rejecting for safety`,
			);
		}

		if (!analysis.hasWrites || analysis.writes.length === 0) return;

		const declaredScope = resolveDeclaredScope(sessionID);

		const shellWriteAgent = swarmState.activeAgent.get(sessionID);
		if (!shellWriteAgent) {
			throw new Error(
				`WRITE BLOCKED: No active agent registered for session "${sessionID}". Call startAgentSession before issuing shell write operations.`,
			);
		}

		const shellWriteRole = stripKnownSwarmPrefix(shellWriteAgent).toLowerCase();
		const isArch = shellWriteRole === 'architect';
		const isCoder = shellWriteRole === 'coder';
		const shellRoleCapability =
			AUTHORITY_ROLE_CAPABILITIES[
				shellWriteRole as keyof typeof AUTHORITY_ROLE_CAPABILITIES
			];
		const isImmutableNonWriter =
			shellRoleCapability === 'read-only' ||
			shellRoleCapability === 'dedicated-tool-only';
		if (isCoder && (!declaredScope || declaredScope.length === 0)) {
			throw new Error(
				`SCOPE_NOT_DECLARED: ${shellWriteAgent} cannot perform shell writes without an active Task-correlated scope binding. ACTION[architect]: call declare_scope with the exact workspace-relative paths and replace_existing=true, then dispatch a new Task call.`,
			);
		}
		// Coders fail closed without a Task-correlated scope. Other non-architect
		// roles retain legacy no-scope leniency, but universal deny prefixes still
		// apply to them (issue #1778 H3).
		const noScopeLenient =
			!isArch &&
			!isCoder &&
			!isImmutableNonWriter &&
			(!declaredScope || declaredScope.length === 0);

		// Issue #2002: a lane coder's shell runs with the lane as cwd and its scope
		// is lane-rooted. Every path decision in this loop must share that base.
		const shellDirectory = sessionWorkspaceDirectory(sessionID);

		const resolvedWrites = resolveWriteTargets(
			detectionCommand,
			analysis.writes,
			shellDirectory,
		);

		for (const write of resolvedWrites) {
			if (write.resolvedPath === null) {
				// A null resolved path has three distinct causes that must NOT be
				// collapsed into one blanket "unresolvable path target" block:
				if (
					write.original.category === 'here_doc' &&
					write.original.path === null
				) {
					// A bare here-doc marker (`<< EOF`) feeds stdin, not a file — it is
					// not itself a write target. Any accompanying `> file` redirect is
					// detected and scope-checked as its own resolved write, so skip the
					// phantom marker instead of hard-blocking the whole command.
					continue;
				}
				if (write.original.category === 'interpreter_eval') {
					// Inline code (`python -c`, `node -e`, …) can write to arbitrary
					// files whose targets are not statically knowable, so it cannot be
					// verified against the declared scope. This stays fail-closed (it is
					// how the scope/config-zone protections resist an eval bypass), but
					// with an actionable message — the old text claimed an "unresolvable
					// path target" that never existed for an eval.
					throw new Error(
						`BLOCKED: ${write.original.operator} evaluates inline code whose write targets cannot be verified against the declared scope — rejecting for safety. Write files with the write/edit tools or a checked-in script, and invoke installed tools directly (e.g. \`pytest\`, \`ruff\`) instead of an inline \`python -c\` / \`node -e\` eval.`,
					);
				}
				// A concrete redirect/builtin target that resolved to null because it
				// uses a shell variable or command substitution ($VAR, $(cmd)) —
				// genuinely unverifiable, so keep failing closed.
				throw new Error(
					`BLOCKED: bash/shell write to a dynamic path target${
						write.original.path ? ` "${write.original.path}"` : ''
					} that cannot be statically resolved (shell variable or command substitution) — rejecting for safety.`,
				);
			}

			if (noScopeLenient && universalDenyPrefixes.length > 0) {
				for (const prefix of universalDenyPrefixes) {
					if (
						matchesAuthorityDenyPrefix(
							write.resolvedPath,
							prefix,
							shellDirectory,
						)
					) {
						throw new Error(
							`WRITE BLOCKED: Agent "${shellWriteAgent}" is not authorised to write "${write.resolvedPath}" (via shell). Reason: Path is under universal deny prefix "${prefix}"`,
						);
					}
				}
			}

			// No-scope agents: enforce only the universal deny list above, then
			// preserve the prior leniency for the declared-scope authority checks.
			if (noScopeLenient) continue;

			const authorityCheck = checkFileAuthorityWithRules(
				shellWriteAgent,
				write.resolvedPath,
				shellDirectory,
				precomputedAuthorityRules,
				{
					declaredScope,
					authorityEnabled: authorityConfig?.enabled,
					universalDenyPrefixes,
					verifierConfigPaths: authorityConfig?.verifier_config_paths,
				},
			);
			if (!authorityCheck.allowed) {
				throw new Error(
					`WRITE BLOCKED: Agent "${shellWriteAgent}" is not authorised to write "${write.resolvedPath}" (via shell). Reason: ${authorityCheck.reason}`,
				);
			}

			if (
				declaredScope &&
				declaredScope.length > 0 &&
				!isInDeclaredScope(write.resolvedPath, declaredScope, shellDirectory)
			) {
				const safeTarget = sanitizeDiagnosticText(write.resolvedPath, 320);
				const scopeSummary = declaredScope
					.slice(0, 10)
					.map((entry) => sanitizeDiagnosticText(entry, 160))
					.join(', ');
				const omitted = Math.max(0, declaredScope.length - 10);
				throw new Error(
					`WRITE BLOCKED: SCOPE_VIOLATION: shell write target "${safeTarget}" is outside the active scope [${scopeSummary}${omitted > 0 ? `, ... (+${omitted} more)` : ''}]. ACTION[architect]: if the target is intended, call declare_scope for the exact workspace-relative path and redispatch; otherwise correct the command.`,
				);
			}
			if (isCoder) {
				const writeBinding = resolveActiveScopeBinding(sessionID);
				if (
					writeBinding?.activation === 'active' &&
					writeBinding.parentOwnerSessionId &&
					writeBinding.parentCallId
				) {
					const relativeTarget = path
						.relative(
							path.resolve(shellDirectory),
							path.resolve(shellDirectory, write.resolvedPath),
						)
						.replace(/\\/g, '/');
					const routed = recordReviewerScopeGenerationFile({
						parentSessionID: writeBinding.parentOwnerSessionId,
						taskId: writeBinding.taskId,
						coderCallID: writeBinding.parentCallId,
						file: relativeTarget,
					});
					if (routed) {
						rememberReviewerScopeWrite?.({
							callID,
							parentSessionID: writeBinding.parentOwnerSessionId,
							taskId: writeBinding.taskId,
							coderCallID: writeBinding.parentCallId,
							file: relativeTarget,
						});
					}
				}
			}
		}
		if (isCoder) {
			const binding = resolveActiveScopeBinding(sessionID);
			if (binding) {
				rememberScopeLeaseCandidate?.({
					callID,
					sessionID,
					tool,
					directory: shellDirectory,
					binding,
					targets: resolvedWrites.flatMap((write) =>
						write.resolvedPath === null
							? []
							: [path.resolve(shellDirectory, write.resolvedPath)],
					),
					args,
				});
			}
		}
	}

	/**
	 * OS-native sandbox wrapper for bash/shell commands.
	 */
	async function applySandboxExecution(
		sessionID: string,
		callID: string,
		tool: string,
		args: unknown,
		agent: string,
		command: string,
		auditPath: string,
		auditEnabled: boolean,
	): Promise<void> {
		if (tool !== 'bash' && tool !== 'shell') return;

		const executor = await getSandboxExecutor();
		if (!executor || !executor.isAvailable()) {
			if (!hasWarnedSandboxUnavailable) {
				hasWarnedSandboxUnavailable = true;
				warn(
					'[guardrails] sandbox executor unavailable; shell commands will run unsandboxed',
				);
			}
			void appendGuardrailDecision(
				{
					type: 'sandbox_skip',
					ts: new Date().toISOString(),
					sessionID,
					agent,
					tool,
					command,
					executorMechanism: executor?.mechanism ?? 'none',
					skipReason: 'executor not available',
				},
				{ auditPath, enabled: auditEnabled },
			);
			return;
		}

		const toolArgs = args as Record<string, unknown> | undefined;
		const rawCommand =
			typeof toolArgs?.command === 'string' ? toolArgs.command.trim() : '';
		if (!rawCommand || !toolArgs) return;

		const declaredPaths = resolveDeclaredScope(sessionID);
		if (!declaredPaths || declaredPaths.length === 0) return;

		// Issue #2002: these become the filesystem paths the OS sandbox is allowed
		// to touch. For a lane command they must be lane-rooted, or the sandbox is
		// granted project-root paths the command will never write and denied the
		// lane paths it actually needs.
		const resolved = resolveScopePaths(
			declaredPaths,
			sessionWorkspaceDirectory(sessionID),
		);
		if (resolved.paths.length === 0) return;

		try {
			const wrappedCommand = executor.wrapCommand(rawCommand, resolved.paths);
			toolArgs.command = wrappedCommand;
			markToolExecutionSandboxWrapped(sessionID, callID);

			void appendGuardrailDecision(
				{
					type: 'sandbox_wrap',
					ts: new Date().toISOString(),
					sessionID,
					agent,
					tool,
					command: rawCommand,
					executorMechanism: executor.mechanism,
				},
				{ auditPath, enabled: auditEnabled },
			);
		} catch (err) {
			forgetToolExecution(sessionID, callID);
			const message =
				`[sandbox] BLOCKED: Failed to wrap command with ${executor.mechanism}: ${err}. ` +
				'Command will not be executed unsandboxed.';
			const circuit = recordNonTransientFailure(
				sessionID,
				'sandbox_wrapper_failure',
				message,
			);
			if (circuit?.hardStop) {
				throw new Error(nonTransientHardStopMessage(circuit));
			}
			throw new Error(message);
		}
	}

	/**
	 * Checks gate limits (hard limits, idle timeout, soft warnings).
	 */
	async function checkGateLimits(params: {
		sessionID: string;
		window: InvocationWindow;
		agentConfig: GuardrailsConfig;
		elapsedMinutes: number;
		repetitionCount: number;
	}): Promise<void> {
		const { sessionID, window, agentConfig, elapsedMinutes, repetitionCount } =
			params;

		if (
			agentConfig.max_tool_calls > 0 &&
			window.toolCalls >= agentConfig.max_tool_calls
		) {
			window.hardLimitHit = true;
			telemetry.hardLimitHit(
				sessionID,
				window.agentName,
				'tool_calls',
				window.toolCalls,
			);
			warn('Circuit breaker: tool call limit hit', {
				sessionID,
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
			telemetry.hardLimitHit(
				sessionID,
				window.agentName,
				'duration',
				elapsedMinutes,
			);
			warn('Circuit breaker: duration limit hit', {
				sessionID,
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
			telemetry.hardLimitHit(
				sessionID,
				window.agentName,
				'repetition',
				repetitionCount,
			);
			throw new Error(
				`🛑 LIMIT REACHED: Repeated the same tool call ${repetitionCount} times. This suggests a loop. Return your progress summary.`,
			);
		}

		if (window.consecutiveErrors >= agentConfig.max_consecutive_errors) {
			window.hardLimitHit = true;
			telemetry.hardLimitHit(
				sessionID,
				window.agentName,
				'consecutive_errors',
				window.consecutiveErrors,
			);
			throw new Error(
				`🛑 LIMIT REACHED: ${window.consecutiveErrors} consecutive tool errors detected. Return your progress summary with details of what went wrong. Run /swarm reset-session to clear the circuit breaker without restarting your session.`,
			);
		}

		// Check IDLE timeout
		const idleMinutes = (Date.now() - window.lastSuccessTimeMs) / 60000;
		if (idleMinutes >= agentConfig.idle_timeout_minutes) {
			window.hardLimitHit = true;
			telemetry.hardLimitHit(
				sessionID,
				window.agentName,
				'idle_timeout',
				idleMinutes,
			);
			warn('Circuit breaker: idle timeout hit', {
				sessionID,
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
	}

	/**
	 * Handles delegated write tracking and coder delegation reset.
	 * MUST be called first — before any exemptions.
	 */
	function handleDelegatedWriteTracking(
		sessionID: string,
		tool: string,
		args: unknown,
	): void {
		const currentSession = swarmState.agentSessions.get(sessionID);
		if (!currentSession?.delegationActive && isArchitect(sessionID)) {
			const coderDelegArgs = args as Record<string, unknown> | undefined;
			const coderDeleg = isAgentDelegation(tool, coderDelegArgs);
			if (coderDeleg.isDelegation && coderDeleg.targetAgent === 'coder') {
				const coderSession = swarmState.agentSessions.get(sessionID);
				if (coderSession) {
					const taskId =
						coderSession.currentTaskId ??
						coderSession.lastCoderDelegationTaskId ??
						`${sessionID}:unknown`;
					coderSession.currentTaskId = taskId;
					resetModifiedFilesForTask(coderSession, taskId);
					if (!coderSession.revisionLimitHit) {
						coderSession.coderRevisions = 0;
					}
				}
			}
		}
	}

	/**
	 * Detects if a tool call is an agent delegation.
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
	 * Detects and breaks delegation loops for Task tool calls.
	 */
	function handleLoopDetection(
		sessionID: string,
		tool: string,
		args: unknown,
	): void {
		if (tool !== 'Task') return;

		const loopArgs = args as Record<string, unknown> | undefined;
		const loopResult = detectLoop(sessionID, tool, loopArgs);

		if (loopResult.count >= 5) {
			throw new Error(
				`CIRCUIT BREAKER: Delegation loop detected (${loopResult.count} identical patterns). Session paused. Ask the user for guidance.`,
			);
		} else if (loopResult.count >= 3 && loopResult.count < 5) {
			const agentName =
				typeof loopArgs?.subagent_type === 'string'
					? loopArgs.subagent_type
					: 'agent';
			const loopSession = swarmState.agentSessions.get(sessionID);
			if (loopSession) {
				const loopPattern = loopResult.pattern;
				const modifiedFiles = loopSession.currentTaskId
					? getModifiedFilesForTask(loopSession, loopSession.currentTaskId)
					: [];
				const accomplishmentSummary =
					modifiedFiles.length > 0
						? `Modified ${modifiedFiles.length} file(s): ${modifiedFiles.slice(0, 3).join(', ')}${modifiedFiles.length > 3 ? '...' : ''}`
						: 'No files modified yet';

				const alternativeSuggestions: Record<string, string> = {
					coder:
						'Try a different task spec, simplify the constraint, or escalate to user',
					reviewer: 'Try a different review dimension or escalate to user',
					test_engineer: 'Run a specific test file with targeted scope',
					explorer: 'Narrow the search scope or check a specific file directly',
				};
				const cleanAgent = stripKnownSwarmPrefix(agentName).toLowerCase();
				const suggestion =
					alternativeSuggestions[cleanAgent] ??
					'Try a different agent, different instructions, or escalate to the user';

				loopSession.loopWarningPending = {
					agent: agentName,
					message: [
						`LOOP DETECTED: Pattern "${loopPattern}" repeated 3 times.`,
						`Agent: ${agentName}`,
						`Accomplished: ${accomplishmentSummary}`,
						`Suggested action: ${suggestion}`,
						`If still stuck after trying alternatives, escalate to the user.`,
					].join('\n'),
					timestamp: Date.now(),
				};
			}
		}
	}

	/**
	 * Blocks full test suite execution without a specific file argument.
	 */
	function handleTestSuiteBlocking(tool: string, args: unknown): void {
		if (tool !== 'bash' && tool !== 'shell') return;

		const bashArgs = args as Record<string, unknown> | undefined;
		const cmd = (
			typeof bashArgs?.command === 'string' ? bashArgs.command : ''
		).trim();
		const testRunnerPrefixPattern =
			/^(bun\s+test|npm\s+test|npx\s+vitest|bunx\s+vitest)\b/;
		if (testRunnerPrefixPattern.test(cmd)) {
			const tokens = cmd.split(/\s+/);
			const runnerTokenCount =
				tokens[0] === 'npx' || tokens[0] === 'bunx' ? 3 : 2;
			const remainingTokens = tokens.slice(runnerTokenCount);
			const hasFileArg = remainingTokens.some(
				(token) =>
					token.length > 0 &&
					!token.startsWith('-') &&
					(token.includes('/') ||
						token.includes('\\') ||
						token.endsWith('.ts') ||
						token.endsWith('.js') ||
						token.endsWith('.tsx') ||
						token.endsWith('.jsx') ||
						token.endsWith('.mts') ||
						token.endsWith('.mjs')),
			);
			if (!hasFileArg) {
				throw new Error(
					'BLOCKED: Full test suite execution is not allowed in-session. Run a specific test file instead: bun test path/to/file.test.ts',
				);
			}
		}
	}

	/**
	 * Collects every patch-payload field that an apply_patch / patch tool
	 * invocation might carry.
	 */
	function extractAllPatchPayloads(args: unknown): string[] {
		const toolArgs = args as Record<string, unknown> | undefined;
		if (!toolArgs) return [];
		const out: string[] = [];
		for (const key of PATCH_PAYLOAD_KEYS) {
			const v = toolArgs[key];
			if (typeof v === 'string' && v.length > 0) out.push(v);
		}
		const cmd = toolArgs.cmd;
		if (Array.isArray(cmd)) {
			for (const entry of cmd) {
				if (typeof entry === 'string' && entry.length > 0) out.push(entry);
			}
		}
		return out;
	}

	/**
	 * Builds a regex alternation from the registry-derived human-only command
	 * set. Longer alternatives are listed first to avoid partial prefix matches
	 * (e.g. "acknowledge-spec-drift" before "acknowledge").
	 */
	function getHumanOnlyAlternation(): string {
		return [...HUMAN_ONLY_SWARM_COMMANDS]
			.map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
			.sort((a, b) => b.length - a.length)
			.join('|');
	}

	/**
	 * Returns true if any of the apply_patch / patch payloads contain an
	 * invocation of a human-only swarm CLI subcommand.
	 */
	function patchPayloadHasHumanOnlyInvocation(args: unknown): boolean {
		const payloads = extractAllPatchPayloads(args);
		if (payloads.length === 0) return false;
		const alternation = getHumanOnlyAlternation();
		const re = new RegExp(
			`\\bopencode-swarm\\b[\\s\\S]*?\\brun\\s+(${alternation})\\b`,
			'i',
		);
		return payloads.some((p) => re.test(p));
	}

	/**
	 * Extracts target file paths from apply_patch / swarm_apply_patch / patch tool arguments.
	 * For native apply_patch (no files[] arg), extracts paths from the patch text itself.
	 * For swarm_apply_patch, the files[] arg is required and is the primary source.
	 */
	function extractPatchTargetPaths(tool: string, args: unknown): string[] {
		if (
			tool !== 'apply_patch' &&
			tool !== 'swarm_apply_patch' &&
			tool !== 'patch'
		)
			return [];
		const toolArgs = args as Record<string, unknown> | undefined;

		// For swarm_apply_patch, the files[] arg is the declared scope — include it
		// as the primary source of target paths (it is required by the tool schema).
		// For native apply_patch, files[] may not be present; fall back to patch text.
		const paths = new Set<string>();
		if (Array.isArray(toolArgs?.files)) {
			for (const f of toolArgs.files as unknown[]) {
				if (typeof f === 'string' && f.length > 0 && f !== '/dev/null') {
					paths.add(f);
				}
			}
		}

		// Resolve the patch payload field, preserving the historical precedence
		// (`input` > `patch` > `diff`) before the additional aliases added for
		// issue #2059, and falling back to `cmd[1]` last. `PATCH_PAYLOAD_KEYS`
		// is the single source of truth for the recognized field set, but its
		// declared order is not the legacy precedence, so we check the legacy
		// three explicitly first.
		let patchText: string | undefined;
		for (const key of ['input', 'patch', 'diff'] as const) {
			const v = toolArgs?.[key];
			if (typeof v === 'string') {
				patchText = v;
				break;
			}
		}
		if (patchText === undefined) {
			for (const key of PATCH_PAYLOAD_KEYS) {
				if (key === 'patch' || key === 'input' || key === 'diff') continue;
				const v = toolArgs?.[key];
				if (typeof v === 'string') {
					patchText = v;
					break;
				}
			}
		}
		if (patchText === undefined && Array.isArray(toolArgs?.cmd)) {
			patchText = toolArgs.cmd[1] as string | undefined;
		}
		if (typeof patchText !== 'string') return Array.from(paths);
		if (patchText.length > 1_000_000) {
			throw new Error(
				'WRITE BLOCKED: Patch payload exceeds 1 MB — authority cannot be verified for all modified paths. Split into smaller patches.',
			);
		}
		// #2206: strip a uniform leading indentation block (models emit diffs
		// indented inside fenced/YAML blocks) so the column-0 anchored patterns
		// below resolve the real target paths. A column-0 patch is a byte-identical
		// no-op, so hunk context lines whose file content itself starts with `---`
		// can never gain a phantom match.
		const normalizedPatchText = normalizePatchIndentation(patchText);
		const patchPathPattern = /\*\*\*\s+(?:Update|Add|Delete)\s+File:\s*(.+)/gi;
		const diffPathPattern = /\+\+\+\s+b\/(.+)/gm;
		const gitDiffPathPattern = /^diff --git a\/(.+?) b\/(.+?)$/gm;
		const minusPathPattern = /^---\s+a\/(.+)$/gm;
		const traditionalMinusPattern = /^---\s+([^\s].+?)(?:\t.*)?$/gm;
		const traditionalPlusPattern = /^\+\+\+\s+([^\s].+?)(?:\t.*)?$/gm;
		for (const match of normalizedPatchText.matchAll(patchPathPattern))
			paths.add(match[1].trim());
		for (const match of normalizedPatchText.matchAll(diffPathPattern)) {
			const p = match[1].trim();
			if (p !== '/dev/null') paths.add(p);
		}
		for (const match of normalizedPatchText.matchAll(gitDiffPathPattern)) {
			const aPath = match[1].trim();
			const bPath = match[2].trim();
			if (aPath !== '/dev/null') paths.add(aPath);
			if (bPath !== '/dev/null') paths.add(bPath);
		}
		for (const match of normalizedPatchText.matchAll(minusPathPattern)) {
			const p = match[1].trim();
			if (p !== '/dev/null') paths.add(p);
		}
		for (const match of normalizedPatchText.matchAll(traditionalMinusPattern)) {
			const p = match[1].trim();
			if (p !== '/dev/null' && !p.startsWith('a/') && !p.startsWith('b/'))
				paths.add(p);
		}
		for (const match of normalizedPatchText.matchAll(traditionalPlusPattern)) {
			const p = match[1].trim();
			if (p !== '/dev/null' && !p.startsWith('a/') && !p.startsWith('b/'))
				paths.add(p);
		}
		return Array.from(paths);
	}

	/**
	 * Protects plan state files and detects architect direct writes.
	 */
	function handlePlanAndScopeProtection(
		sessionID: string,
		tool: string,
		args: unknown,
	): void {
		const toolArgs = args as Record<string, unknown> | undefined;
		const targetPath =
			toolArgs?.filePath ??
			toolArgs?.path ??
			toolArgs?.file ??
			toolArgs?.target;

		if (
			tool === 'apply_patch' ||
			tool === 'swarm_apply_patch' ||
			tool === 'patch'
		) {
			if (patchPayloadHasHumanOnlyInvocation(args)) {
				throw new Error(
					'BLOCKED: apply_patch/swarm_apply_patch would introduce a script invoking a human-only swarm CLI subcommand. ' +
						'Present the situation to the user and ask them to run the command themselves.',
				);
			}
		}

		if (typeof targetPath === 'string' && targetPath.length > 0) {
			const resolvedTarget = path
				.resolve(effectiveDirectory, targetPath)
				.toLowerCase();
			const planMdPath = path
				.resolve(effectiveDirectory, '.swarm', 'plan.md')
				.toLowerCase();
			const planJsonPath = path
				.resolve(effectiveDirectory, '.swarm', 'plan.json')
				.toLowerCase();
			if (resolvedTarget === planMdPath || resolvedTarget === planJsonPath) {
				throw new Error(
					'PLAN STATE VIOLATION: Direct writes to .swarm/plan.md and .swarm/plan.json are blocked. ' +
						'plan.md is auto-regenerated from plan.json by PlanSyncWorker. ' +
						'Use save_plan for ALL structural plan changes (adding/removing tasks, updating descriptions, dependencies, or phase names). ' +
						'Use update_task_status() for task status only. ' +
						'Use phase_complete() for phase transitions only.',
				);
			}
			const specStalenessPath = path
				.resolve(effectiveDirectory, '.swarm', 'spec-staleness.json')
				.toLowerCase();
			if (resolvedTarget === specStalenessPath) {
				throw new Error(
					'SPEC_DRIFT_VIOLATION: Direct writes to .swarm/spec-staleness.json are blocked. ' +
						'This file is system-managed and gates plan-mutating tools while spec drift is unresolved. ' +
						'Present the drift to the user and ask them to run /swarm acknowledge-spec-drift.',
				);
			}
			const content =
				toolArgs?.content ??
				toolArgs?.text ??
				toolArgs?.new_string ??
				toolArgs?.newText;
			if (
				typeof content === 'string' &&
				new RegExp(
					`\\bopencode-swarm\\b[\\s\\S]*?\\brun\\s+(${getHumanOnlyAlternation()})\\b`,
					'i',
				).test(content)
			) {
				throw new Error(
					'BLOCKED: write/edit tool would create a script invoking a human-only swarm CLI subcommand. ' +
						'Present the situation to the user and ask them to run the command themselves.',
				);
			}
		}

		if (
			!targetPath &&
			(tool === 'apply_patch' ||
				tool === 'swarm_apply_patch' ||
				tool === 'patch')
		) {
			for (const p of extractPatchTargetPaths(tool, args)) {
				const resolvedP = path.resolve(effectiveDirectory, p);
				const planMdPath = path
					.resolve(effectiveDirectory, '.swarm', 'plan.md')
					.toLowerCase();
				const planJsonPath = path
					.resolve(effectiveDirectory, '.swarm', 'plan.json')
					.toLowerCase();
				const specStalenessPath = path
					.resolve(effectiveDirectory, '.swarm', 'spec-staleness.json')
					.toLowerCase();
				if (
					resolvedP.toLowerCase() === planMdPath ||
					resolvedP.toLowerCase() === planJsonPath
				) {
					throw new Error(
						'PLAN STATE VIOLATION: Direct writes to .swarm/plan.md and .swarm/plan.json are blocked. ' +
							'plan.md is auto-regenerated from plan.json by PlanSyncWorker. ' +
							'Use save_plan for ALL structural plan changes (adding/removing tasks, updating descriptions, dependencies, or phase names). ' +
							'Use update_task_status() for task status only. ' +
							'Use phase_complete() for phase transitions only.',
					);
				}
				if (resolvedP.toLowerCase() === specStalenessPath) {
					throw new Error(
						'SPEC_DRIFT_VIOLATION: Direct writes to .swarm/spec-staleness.json are blocked. ' +
							'This file is system-managed and gates plan-mutating tools while spec drift is unresolved. ' +
							'Present the drift to the user and ask them to run /swarm acknowledge-spec-drift.',
					);
				}
				if (
					isOutsideSwarmDir(p, effectiveDirectory) &&
					(isSourceCodePath(p) || hasTraversalSegments(p))
				) {
					const session = swarmState.agentSessions.get(sessionID);
					if (session) {
						session.architectWriteCount++;
						warn('Architect direct code edit detected via patch tool', {
							tool,
							sessionID,
							targetPath: p,
							writeCount: session.architectWriteCount,
						});
					}
					break;
				}
			}
		}

		if (
			typeof targetPath === 'string' &&
			targetPath.length > 0 &&
			isOutsideSwarmDir(targetPath, effectiveDirectory) &&
			isSourceCodePath(
				path.relative(
					effectiveDirectory,
					path.resolve(effectiveDirectory, targetPath),
				),
			)
		) {
			const session = swarmState.agentSessions.get(sessionID);
			if (session) {
				session.architectWriteCount++;
				warn('Architect direct code edit detected', {
					tool,
					sessionID,
					targetPath,
					writeCount: session.architectWriteCount,
				});

				if (
					session.lastGateFailure &&
					Date.now() - session.lastGateFailure.timestamp < 120_000
				) {
					const failedGate = session.lastGateFailure.tool;
					const failedTaskId = session.lastGateFailure.taskId;
					warn('Self-fix after gate failure detected', {
						failedGate,
						failedTaskId,
						currentTool: tool,
						sessionID,
					});
					session.selfFixAttempted = true;
				}
			}
		}
	}

	/**
	 * Resolves session, checks architect exemptions, initializes invocation window.
	 */
	function resolveSessionAndWindow(sessionID: string): {
		agentConfig: GuardrailsConfig;
		window: InvocationWindow;
	} | null {
		const rawActiveAgent = swarmState.activeAgent.get(sessionID);
		const strippedAgent = rawActiveAgent
			? stripKnownSwarmPrefix(rawActiveAgent)
			: undefined;
		if (strippedAgent === ORCHESTRATOR_NAME) return null;
		if (strippedAgent && isNativeOpencodeAgent(strippedAgent)) return null;

		const existingSession = swarmState.agentSessions.get(sessionID);
		if (existingSession) {
			const sessionAgent = stripKnownSwarmPrefix(existingSession.agentName);
			if (sessionAgent === ORCHESTRATOR_NAME) return null;
			if (isNativeOpencodeAgent(sessionAgent)) return null;
		}

		const agentName =
			swarmState.activeAgent.get(sessionID) ?? ORCHESTRATOR_NAME;
		const session = ensureAgentSession(sessionID, agentName);

		const resolvedName = stripKnownSwarmPrefix(session.agentName);
		if (resolvedName === ORCHESTRATOR_NAME) return null;
		if (isNativeOpencodeAgent(resolvedName)) return null;

		const agentConfig = resolveGuardrailsConfig(cfg, session.agentName);

		if (
			agentConfig.max_duration_minutes === 0 &&
			agentConfig.max_tool_calls === 0
		) {
			return null;
		}

		if (!getActiveWindow(sessionID)) {
			const fallbackAgent =
				swarmState.activeAgent.get(sessionID) ?? session.agentName;
			const stripped = stripKnownSwarmPrefix(fallbackAgent);
			if (stripped !== ORCHESTRATOR_NAME) {
				beginInvocation(sessionID, fallbackAgent);
			}
		}

		const window = getActiveWindow(sessionID);
		if (!window) return null;

		return { agentConfig, window };
	}

	/**
	 * Returns true when agentName is one of opencode's built-in native agents.
	 */
	function isNativeOpencodeAgent(agentName: string): boolean {
		return OPENCODE_NATIVE_AGENTS.has(agentName.toLowerCase() as never);
	}

	/**
	 * Tracks tool calls in the invocation window and computes repetition metrics.
	 */
	function trackToolCall(
		window: InvocationWindow,
		tool: string,
		args: unknown,
	): { repetitionCount: number; elapsedMinutes: number } {
		if (window.hardLimitHit) {
			throw new Error(
				'🛑 CIRCUIT BREAKER: Agent blocked. Hard limit was previously triggered. Stop making tool calls and return your progress summary.',
			);
		}

		window.toolCalls++;

		const hash = hashArgs(args);
		window.recentToolCalls.push({
			tool,
			argsHash: hash,
			timestamp: Date.now(),
		});
		if (window.recentToolCalls.length > 20) {
			window.recentToolCalls.shift();
		}

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

		const elapsedMinutes = (Date.now() - window.startedAtMs) / 60000;
		return { repetitionCount, elapsedMinutes };
	}

	// ---- Return the toolBefore handler ----

	return async (
		input: { tool: string; sessionID: string; callID: string },
		output: { args: unknown },
	): Promise<void> => {
		assertNonTransientCircuitAllowsTool(input.sessionID);
		// Establish the lazy fallback invocation before recording this tool's
		// before/after correlation. Beginning it later would clear the command we
		// just stored, losing whether a parser error came from the sandbox wrapper.
		const hasKnownSession =
			swarmState.agentSessions.has(input.sessionID) ||
			swarmState.activeAgent.has(input.sessionID);
		const resolvedSessionWindow = hasKnownSession
			? resolveSessionAndWindow(input.sessionID)
			: null;

		// v6.35.1: Runaway output detector — reset counter on any tool call
		consecutiveNoToolTurns.set(input.sessionID, 0);

		// Issue #2063 B5 — execution-stall OBSERVATION. Deliberately the first
		// thing after the runaway-counter reset and BEFORE every guardrails POLICY
		// gate that can throw (`handleLoopDetection`'s CIRCUIT BREAKER,
		// `handleTestSuiteBlocking`, interpreter gating, file authority, …).
		//
		// It is NOT the first throwable thing in this handler:
		// `assertNonTransientCircuitAllowsTool` runs above it. That is deliberate
		// and harmless — a non-transient hard stop is a terminal invocation-owned
		// failure that only a verified new invocation/session can clear
		// (AGENTS.md invariant 9), so there is no retry loop left for an episode
		// to contain, and arming one would be bookkeeping for a session that is
		// already stopped.
		//
		// The spec requires an episode to arm on an ATTEMPTED dispatch even when
		// a later gate denies it — the motivating loop is exactly a `Task` that
		// `delegation-gate` rejects — so the observation cannot sit behind any
		// throw. It never throws itself; the matching DENIAL is a separate call
		// in the handler tail so budget/circuit accounting still runs first
		// (same argument as C3's PRM-hard-stop placement).
		observeExecutionStallToolCall({
			sessionID: input.sessionID,
			tool: input.tool,
			args: output.args,
			callID: input.callID,
			options: executionStallOptions,
		});

		// v6.12: Self-coding detection — MUST be first, before any exemptions
		handleDelegatedWriteTracking(input.sessionID, input.tool, output.args);

		// v6.29: Loop detection for Task tool delegations
		handleLoopDetection(input.sessionID, input.tool, output.args);

		// Block full test suite execution without file argument
		handleTestSuiteBlocking(input.tool, output.args);

		const rawShellCommand = (() => {
			const bashArgs = output.args as Record<string, unknown> | undefined;
			return typeof bashArgs?.command === 'string' ? bashArgs.command : '';
		})();

		// Shell audit log
		const normalizedAuditTool = normalizeToolName(input.tool).toLowerCase();
		if (normalizedAuditTool === 'bash' || normalizedAuditTool === 'shell') {
			void appendGuardrailDecision(
				{
					type: 'shell',
					ts: new Date().toISOString(),
					sessionID: input.sessionID,
					agent: (() => {
						const rawAgent = swarmState.activeAgent.get(input.sessionID);
						return rawAgent ? stripKnownSwarmPrefix(rawAgent) : 'unknown';
					})(),
					tool: input.tool,
					command: (() => {
						const bashArgs = output.args as Record<string, unknown> | undefined;
						const rawCmd =
							typeof bashArgs?.command === 'string' ? bashArgs.command : '';
						return redactShellCommand(rawCmd);
					})(),
				},
				{
					auditPath: shellAuditPath,
					enabled: shellAuditEnabled,
				},
			);
		}

		// Interpreter gating
		handleInterpreterGating(input.sessionID, input.tool);

		// Block destructive shell commands
		try {
			checkDestructiveCommand(input.sessionID, input.tool, output.args);
		} catch (err) {
			const destructiveCategory = (() => {
				const msg = err instanceof Error ? err.message : String(err);
				if (/fork bomb/i.test(msg)) return 'fork bomb';
				if (/rm\b.*recursive|recursive.*rm/i.test(msg))
					return 'recursive delete';
				if (/rmdir|rd\b/i.test(msg)) return 'recursive directory delete';
				if (/\bdel\b/i.test(msg)) return 'recursive file delete';
				if (/Remove-Item|ri\b/i.test(msg)) return 'recursive remove';
				if (/format/i.test(msg)) return 'disk format';
				if (/robocopy/i.test(msg)) return 'mirror sync';
				if (/chmod.*000/i.test(msg)) return 'permission wipe';
				if (/chattr/i.test(msg)) return 'immutable flag';
				if (/icacls/i.test(msg)) return 'permission deny';
				if (/\bdd\b/i.test(msg)) return 'data wipe';
				if (/git push.*--force|git push.*-f/i.test(msg)) return 'force push';
				if (/git reset/i.test(msg)) return 'git reset';
				if (/git clean/i.test(msg)) return 'git clean';
				if (/git worktree/i.test(msg)) return 'git worktree remove';
				if (/rsync.*--delete/i.test(msg)) return 'rsync delete';
				if (/kubectl delete/i.test(msg)) return 'kubectl delete';
				if (/docker system prune/i.test(msg)) return 'docker prune';
				if (/DROP\s+TABLE|DROP\s+DATABASE|DROP\s+SCHEMA/i.test(msg))
					return 'sql drop';
				if (/TRUNCATE\s+TABLE/i.test(msg)) return 'sql truncate';
				if (/mkfs/i.test(msg)) return 'disk format';
				if (/\bmv\b.*\.swarm/i.test(msg)) return 'swarm path move';
				if (/\bmove\b|\bren\b/i.test(msg)) return 'move/rename';
				if (/Move-Item|Rename-Item/i.test(msg)) return 'move/rename';
				if (/\brm\b.*\.swarm/i.test(msg)) return 'swarm path delete';
				if (/cp\b.*\.swarm.*rm\b|rm\b.*\.swarm/i.test(msg))
					return 'copy-and-delete bypass';
				if (
					/rsync.*remove-source|tar.*remove-files|zip.*-m\b|7z.*-sdel/i.test(
						msg,
					)
				)
					return 'archive delete source';
				if (/human-only swarm command/i.test(msg))
					return 'human-only swarm command';
				if (/spec-staleness\.json/i.test(msg)) return 'system file tampering';
				return 'destructive shell command';
			})();
			void appendGuardrailDecision(
				{
					type: 'destructive_block',
					ts: new Date().toISOString(),
					sessionID: input.sessionID,
					agent: (() => {
						const rawAgent = swarmState.activeAgent.get(input.sessionID);
						return rawAgent ? stripKnownSwarmPrefix(rawAgent) : 'unknown';
					})(),
					tool: input.tool,
					command: (() => {
						const bashArgs = output.args as Record<string, unknown> | undefined;
						const rawCmd =
							typeof bashArgs?.command === 'string' ? bashArgs.command : '';
						return rawCmd;
					})(),
					destructiveCategory,
				},
				{
					auditPath: shellAuditPath,
					enabled: shellAuditEnabled,
				},
			);
			throw err;
		}

		// Shell write scope enforcement
		try {
			checkShellWriteScope(
				input.sessionID,
				input.callID,
				input.tool,
				output.args,
				rawShellCommand,
			);
		} catch (err) {
			const toolArgs = output.args as Record<string, unknown> | undefined;
			const declaredScope = resolveDeclaredScope(input.sessionID);
			const declaredScopeText =
				declaredScope != null && declaredScope.length > 0
					? declaredScope.join(', ')
					: '';
			const resolvedScopeText =
				declaredScope != null && declaredScope.length > 0
					? resolveScopePaths(
							declaredScope,
							sessionWorkspaceDirectory(input.sessionID),
						).paths.join(', ')
					: '';
			const pathMatch = /[^\s]+/.exec(
				err instanceof Error ? err.message : String(err),
			);
			const targetPath = (() => {
				const p =
					toolArgs?.filePath ??
					toolArgs?.path ??
					toolArgs?.file ??
					toolArgs?.target;
				if (typeof p === 'string' && p.length > 0) return p;

				const rawMessage = err instanceof Error ? err.message : String(err);

				// Extract the violating write target from known guardrail error formats
				// before falling back to the first error-message token or placeholder.
				const extracted =
					/(?:write|target|file|path|scope|prefix)[^:]*:\s*(?:"([^"]+)"|'([^']+)'|(\S+))/i.exec(
						rawMessage,
					) ??
					/(?:write|target|file|path)\s+(?:"([^"]+)"|'([^']+)'|(\S+))/i.exec(
						rawMessage,
					);

				const candidate =
					extracted != null
						? (extracted[1] ??
							extracted[2] ??
							extracted[3] ??
							extracted[4] ??
							extracted[5] ??
							extracted[6])
						: null;

				if (candidate && candidate.length > 0 && candidate.length < 200) {
					return candidate;
				}

				if (pathMatch) return pathMatch[0];
				return '<shell write>';
			})();
			const agentName = (() => {
				const rawAgent = swarmState.activeAgent.get(input.sessionID);
				return rawAgent ? stripKnownSwarmPrefix(rawAgent) : 'unknown';
			})();
			void appendGuardrailDecision(
				{
					type: 'scope_violation',
					ts: new Date().toISOString(),
					sessionID: input.sessionID,
					agent: agentName,
					tool: input.tool,
					path: targetPath,
					declaredScope: declaredScopeText,
					resolvedScope: resolvedScopeText,
					action: 'bash',
				},
				{
					auditPath: shellAuditPath,
					enabled: shellAuditEnabled,
				},
			);
			throw err;
		}

		// Apply sandbox wrapping / advisories for shell tools after guardrail
		// checks have inspected the original command text.
		const agentNameForSandbox = (() => {
			const rawAgent = swarmState.activeAgent.get(input.sessionID);
			return rawAgent ? stripKnownSwarmPrefix(rawAgent) : 'unknown';
		})();
		rememberToolExecution(
			input.sessionID,
			input.callID,
			input.tool,
			rawShellCommand,
		);
		await applySandboxExecution(
			input.sessionID,
			input.callID,
			input.tool,
			output.args,
			agentNameForSandbox,
			rawShellCommand,
			shellAuditPath,
			shellAuditEnabled,
		);

		// Issue #853 Layer B: structural spec-drift block
		enforceSpecDriftGate(effectiveDirectory, input.tool);

		// Preserve architect plan/config protection even when a malformed payload
		// cannot be fully resolved for the universal guard pass below.
		if (isArchitect(input.sessionID) && isWriteTool(input.tool)) {
			handlePlanAndScopeProtection(input.sessionID, input.tool, output.args);
		}

		// Issue #1875: resolve the complete write set once, before any authority,
		// lstat, universal-deny, scope, or tracking decision. Non-architect write
		// shapes that cannot be proven are blocked rather than becoming bypasses.
		// Issue #2002: every path decision for this write — target resolution,
		// lstat, universal deny, authority, containment, audit — must share ONE
		// base, and for a worktree-isolated coder that base is the lane root, not
		// the plugin-root `ctx.directory` this handler was built with. A partial
		// re-root would produce a split base and silent false-allows/false-denies.
		const writeDirectory = sessionWorkspaceDirectory(input.sessionID);

		let resolvedFileTargets: string[] | null = null;
		if (isWriteTool(input.tool)) {
			const resolution = resolveFileWriteTargets(
				normalizeToolName(input.tool),
				output.args,
				{ directory: writeDirectory },
			);
			if (resolution.status === 'unverifiable') {
				// Universal deny, containment, and lstat checks cannot be proven when
				// the complete write set is unknown. This is unsafe for every role,
				// including architect; plan/config guards remain additional checks.
				throw new Error(`WRITE TARGET UNVERIFIABLE: ${resolution.reason}`);
			} else {
				resolvedFileTargets = resolution.paths;
			}
			const writeBinding = resolveActiveScopeBinding(input.sessionID);
			if (writeBinding) {
				rememberScopeLeaseCandidate?.({
					callID: input.callID,
					sessionID: input.sessionID,
					tool: input.tool,
					directory: writeDirectory,
					binding: writeBinding,
					targets: (resolvedFileTargets ?? []).map((target) =>
						path.resolve(writeDirectory, target),
					),
					args: output.args,
				});
			}
		}

		// Authority + lstat + universal-deny checks for ALL agents on Write/Edit
		if (isWriteTool(input.tool)) {
			for (const targetPath of resolvedFileTargets ?? []) {
				const agentName = swarmState.activeAgent.get(input.sessionID);
				if (!agentName) {
					throw new Error(
						`WRITE BLOCKED: No active agent registered for session "${input.sessionID}". Call startAgentSession before issuing write tool calls.`,
					);
				}
				// lstat: block writes through symlinks
				const lstatBlock = checkWriteTargetForSymlink(
					targetPath,
					writeDirectory,
				);
				if (lstatBlock) {
					void appendGuardrailDecision(
						{
							type: 'file_write',
							ts: new Date().toISOString(),
							sessionID: input.sessionID,
							agent: agentName,
							tool: input.tool,
							path: targetPath,
							reason: lstatBlock,
							resolvedScope: (() => {
								const scope = resolveDeclaredScope(input.sessionID);
								return scope != null && scope.length > 0
									? scope.join(', ')
									: '';
							})(),
						},
						{
							auditPath: shellAuditPath,
							enabled: shellAuditEnabled,
						},
					);
					throw new Error(lstatBlock);
				}

				// Per-agent authority check
				const writeBinding = resolveActiveScopeBinding(input.sessionID);
				const writeDeclaredScope = writeBinding?.files ?? null;

				const authorityCheck = checkFileAuthorityWithRules(
					agentName,
					targetPath,
					writeDirectory,
					precomputedAuthorityRules,
					{
						declaredScope: writeDeclaredScope,
						authorityEnabled: authorityConfig?.enabled,
						universalDenyPrefixes,
						verifierConfigPaths: authorityConfig?.verifier_config_paths,
					},
				);
				if (!authorityCheck.allowed) {
					void appendGuardrailDecision(
						{
							type: 'file_write',
							ts: new Date().toISOString(),
							sessionID: input.sessionID,
							agent: agentName,
							tool: input.tool,
							path: targetPath,
							reason: authorityCheck.reason,
							resolvedScope: (() => {
								const scope = writeDeclaredScope;
								return scope != null && scope.length > 0
									? scope.join(', ')
									: '';
							})(),
						},
						{
							auditPath: shellAuditPath,
							enabled: shellAuditEnabled,
						},
					);
					throw new Error(
						`WRITE BLOCKED: Agent "${agentName}" is not authorised to write "${targetPath}". Reason: ${authorityCheck.reason}`,
					);
				}

				const trackingSession = swarmState.agentSessions.get(input.sessionID);
				// Preserve the public audit taxonomy while sharing one target resolver.
				const auditContext = trackingSession?.delegationActive
					? 'delegated'
					: 'direct';
				const auditOperation = [
					'apply_patch',
					'swarm_apply_patch',
					'patch',
				].includes(normalizeToolName(input.tool))
					? 'patch'
					: 'write';

				// Log config file write attempts
				if (
					isConfigFilePath(
						targetPath,
						writeDirectory,
						authorityConfig?.verifier_config_paths,
					)
				) {
					const normalizedPath = path
						.relative(
							path.resolve(writeDirectory),
							path.resolve(writeDirectory, targetPath),
						)
						.replace(/\\/g, '/');
					const logEntry: Record<string, unknown> = {
						agent: agentName,
						path: normalizedPath,
						allowed: authorityCheck.allowed,
						type: `${auditContext}_${auditOperation}`,
					};
					if (!authorityCheck.allowed && 'reason' in authorityCheck) {
						logEntry.reason = (
							authorityCheck as { allowed: false; reason: string }
						).reason;
					}
					warn('Config file write attempt', logEntry);
				}

				if (trackingSession?.delegationActive) {
					const taskId =
						trackingSession.currentTaskId ??
						trackingSession.lastCoderDelegationTaskId ??
						`${input.sessionID}:unknown`;
					trackingSession.currentTaskId = taskId;
					recordModifiedFileForTask(trackingSession, taskId, targetPath);
				}
				if (
					writeBinding?.activation === 'active' &&
					writeBinding.parentOwnerSessionId &&
					writeBinding.parentCallId
				) {
					const relativeTarget = path
						.relative(
							path.resolve(writeDirectory),
							path.resolve(writeDirectory, targetPath),
						)
						.replace(/\\/g, '/');
					const routed = recordReviewerScopeGenerationFile({
						parentSessionID: writeBinding.parentOwnerSessionId,
						taskId: writeBinding.taskId,
						coderCallID: writeBinding.parentCallId,
						file: relativeTarget,
					});
					if (routed) {
						rememberReviewerScopeWrite?.({
							callID: input.callID,
							parentSessionID: writeBinding.parentOwnerSessionId,
							taskId: writeBinding.taskId,
							coderCallID: writeBinding.parentCallId,
							file: relativeTarget,
						});
					}
				}
			}
		}

		// Resolve session — null when the session is architect-exempt (no window).
		const resolved = resolvedSessionWindow;

		// (1) Budget / circuit-breaker accounting. Issue #2063 C3: this now runs
		// BEFORE the PRM hard stop. Previously the hard stop threw first, so the
		// call that tripped it — and every call after it until the flag was
		// consumed — never reached `trackToolCall`/`checkGateLimits`. A session
		// wedged behind a hard stop therefore stopped accruing tool-call, duration
		// and repetition budget, i.e. the circuit breaker went blind at exactly
		// the moment containment mattered most.
		if (resolved) {
			const { agentConfig, window } = resolved;
			const { repetitionCount, elapsedMinutes } = trackToolCall(
				window,
				input.tool,
				output.args,
			);

			await checkGateLimits({
				sessionID: input.sessionID,
				window,
				agentConfig,
				elapsedMinutes,
				repetitionCount,
			});
		}

		// (2) v6.29 / issue #2063 C2+C3: PRM hard stop — DENY once.
		//
		// Deliberately OUTSIDE the `if (resolved)` block and ABOVE the
		// `if (!resolved) return` below. Simply moving these lines beneath the
		// early return would fail-open the hard stop for every null-window
		// (architect-exempt) session — the containment would silently not exist
		// for the sessions that have no budget window. The conditional-block
		// shape above is the only arrangement with both properties: accounting
		// runs when there IS a window, and the denial runs regardless.
		//
		// One-shot: the token is cleared before throwing, so the NEXT tool call
		// proceeds. The stop is a directive to report progress, not a permanent
		// wedge — and `EscalationTracker` re-arms both tokens on any further
		// detection at count >= 3, so a session that ignores it is stopped again.
		{
			const prmSession = swarmState.agentSessions.get(input.sessionID);
			if (prmSession?.prmHardStopPending) {
				prmSession.prmHardStopPending = false;
				// Delivery observability is the `prm_hard_stop_delivered` event
				// emitted just below — it already carries sessionID, pattern, level,
				// and count. A `prmHardStopDeliveredAt` session field used to be
				// stamped here too; it had no readers and was not serialized, so it
				// was removed (reviewer round-4 REQUIRED 3).
				const patternType =
					prmSession.prmLastPatternDetected?.pattern ?? 'unknown';
				telemetry.prmHardStopDelivered(
					input.sessionID,
					patternType,
					prmSession.prmEscalationLevel,
					prmSession.prmPatternCounts?.get(patternType) ?? 0,
				);
				throw new Error(
					'🛑 PRM HARD STOP: Pattern escalation maximum reached. Stop tool calls and return progress summary.',
				);
			}
		}

		// (2b) Issue #2063 B4 — plugin-internals read guard, and B5 — execution
		// stall hard rung.
		//
		// Both sit here for the SAME reason the PRM hard stop above does: the
		// architect session is precisely the `resolved === null` case
		// (`resolveSessionAndWindow` returns null for ORCHESTRATOR_NAME), so a
		// denial placed below the early return would silently not exist for the
		// only session B5 targets, and would miss every architect read for B4.
		// Placing them AFTER block (1) keeps the C3 property that a denied call
		// still accrues tool-call/duration/repetition budget — the circuit
		// breaker must not go blind at the moment containment matters most.
		//
		// B4 runs first: it is unconditional and its guidance is the more
		// specific of the two ("the plugin's files are never the fix"), so when
		// a stalled architect starts spelunking the installed package it reads
		// the message that names the actual mistake.
		enforceInternalsGuard({
			sessionID: input.sessionID,
			tool: input.tool,
			args: output.args,
			directory: effectiveDirectory,
			options: internalsGuardOptions,
		});
		enforceExecutionStallDenial({
			sessionID: input.sessionID,
			tool: input.tool,
			options: executionStallOptions,
		});

		// (3) Nothing below this point applies to a windowless session.
		if (!resolved) return;

		// (4) v6.12: Store input args for delegation detection in toolAfter
		setStoredInputArgs(input.callID, output.args);
	};
}
