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
import { getExecutor } from '../../sandbox/executor';
import { resolveScopePaths } from '../../sandbox/scope-resolver';
import { resolveScopeWithFallbacks } from '../../scope/scope-persistence';
import {
	beginInvocation,
	ensureAgentSession,
	getActiveWindow,
	type InvocationWindow,
	swarmState,
} from '../../state';
import { telemetry } from '../../telemetry.js';
import { warn } from '../../utils';
import { pendingCoderScopeByTaskId } from '../delegation-gate.js';
import { detectLoop } from '../loop-detector';
import { normalizeToolName } from '../normalize-tool-name';
import {
	detectInteractiveSession,
	detectPosixWrites,
	detectWindowsWrites,
	resolveWriteTargets,
	type WriteAnalysis,
} from '../shell-write-detect';
import { appendGuardrailDecision } from './audit-log';
import {
	DC_SAFE_TARGETS,
	dcCheckJunctionCreation,
	dcExtractPowerShellTargets,
	dcExtractWindowsCmdTargets,
	dcNormalizeCommand,
	dcSplitSegments,
	dcUnwrapWrappers,
	dcValidateTargets,
} from './destructive-command';
import type { AgentRule } from './file-authority';
import {
	checkFileAuthorityWithRules,
	checkWriteTargetForSymlink,
	hashArgs,
} from './file-authority';
import { enforceSpecDriftGate } from './index';
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
	} = ctx;

	/**
	 * Resolves declared coder scope from session state, disk persistence, and plan-as-scope.
	 */
	function resolveDeclaredScope(sessionID: string): string[] | null {
		const session = swarmState.agentSessions.get(sessionID);
		const taskId = session?.currentTaskId ?? null;
		return resolveScopeWithFallbacks({
			directory: effectiveDirectory,
			taskId,
			inMemoryScope: session?.declaredCoderScope,
			pendingMapScope: taskId ? pendingCoderScopeByTaskId.get(taskId) : null,
		});
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

		const declaredScope = isCoder ? resolveDeclaredScope(sessionID) : null;
		const toolArgs = args as Record<string, unknown> | undefined;
		const rawCommand =
			typeof toolArgs?.command === 'string' ? toolArgs.command.trim() : '';
		if (!rawCommand) return;

		const cwd = effectiveDirectory;

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

			// POSIX rm — short flags (-rf, -fr, -r -f) and long flags
			const rmShortMatch =
				/^rm\s+(-[rRfF]+(?:\s+-[rRfF]+)*|-r\s+-f|-f\s+-r)\s+(.+)$/.exec(seg);
			const rmLongMatch = /^rm\s+(?:--(?:recursive|force)\s+){1,2}(.+)$/.exec(
				seg,
			);
			const rmAnyMatch = rmShortMatch ?? rmLongMatch;
			if (rmAnyMatch) {
				const targetPart = rmAnyMatch[rmShortMatch ? 2 : 1].trim();
				const targets = targetPart.split(/\s+/);
				const validateBlock = dcValidateTargets(targets, cwd);
				if (validateBlock) throw new Error(validateBlock);
				const allSafe = targets.every((t) =>
					DC_SAFE_TARGETS.has(t.replace(/^["']|["']$/g, '').trim()),
				);
				if (!allSafe) {
					const scopeExempt =
						declaredScope != null &&
						declaredScope.length > 0 &&
						targets.every((t) =>
							isInDeclaredScope(
								t.replace(/^["']|["']$/g, '').trim(),
								declaredScope,
								cwd,
							),
						);
					if (!scopeExempt) {
						throw new Error(
							`BLOCKED: Potentially destructive shell command: rm with recursive/force flags on unsafe path(s): ${targetPart}`,
						);
					}
				}
			}

			// Windows cmd.exe: rmdir /s, rd /s
			if (/^(?:rmdir|rd)(?:\.exe)?\s+.*\/[sS]/i.test(seg)) {
				const targets = dcExtractWindowsCmdTargets(seg);
				if (targets.length === 0) {
					throw new Error(
						`BLOCKED: Windows recursive directory delete (rmdir /s or rd /s) detected. Verify the target is not a junction/symlink.`,
					);
				}
				const validateBlock = dcValidateTargets(targets, cwd);
				if (validateBlock) throw new Error(validateBlock);
				const allSafe = targets.every((t) => DC_SAFE_TARGETS.has(t.trim()));
				if (!allSafe) {
					const scopeExempt =
						declaredScope != null &&
						declaredScope.length > 0 &&
						targets.every((t) =>
							isInDeclaredScope(t.trim(), declaredScope, cwd),
						);
					if (!scopeExempt) {
						throw new Error(
							`BLOCKED: Windows recursive directory delete on unsafe path(s): ${targets.join(', ')}`,
						);
					}
				}
			}

			// Windows cmd.exe: del /s /q /f
			if (/^del(?:\.exe)?\s+.*\/[sS]/i.test(seg)) {
				const targets = dcExtractWindowsCmdTargets(seg);
				if (targets.length > 0) {
					const validateBlock = dcValidateTargets(targets, cwd);
					if (validateBlock) throw new Error(validateBlock);
					const allSafe = targets.every((t) => DC_SAFE_TARGETS.has(t.trim()));
					if (!allSafe) {
						const scopeExempt =
							declaredScope != null &&
							declaredScope.length > 0 &&
							targets.every((t) =>
								isInDeclaredScope(t.trim(), declaredScope, cwd),
							);
						if (!scopeExempt) {
							throw new Error(
								`BLOCKED: Windows recursive file delete (del /s) on unsafe path(s): ${targets.join(', ')}`,
							);
						}
					}
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
					const validateBlock = dcValidateTargets(targets, cwd);
					if (validateBlock) throw new Error(validateBlock);
					const allSafe = targets.every((t) => DC_SAFE_TARGETS.has(t.trim()));
					if (!allSafe) {
						const scopeExempt =
							declaredScope != null &&
							declaredScope.length > 0 &&
							targets.every((t) =>
								isInDeclaredScope(t.trim(), declaredScope, cwd),
							);
						if (!scopeExempt) {
							throw new Error(
								`BLOCKED: PowerShell recursive delete on unsafe path(s): ${targets.join(', ')}`,
							);
						}
					}
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

			// Git destructive operations
			if (/^git\s+push\b.*?(--force|-f)\b/.test(seg)) {
				throw new Error(
					`BLOCKED: Force push detected — git push --force is not allowed`,
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
			if (/^git\s+worktree\s+remove\s+.*--force\b/i.test(seg)) {
				throw new Error(
					`BLOCKED: "git worktree remove --force" detected — can delete working tree contents`,
				);
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
								'Present the drift to the user and ask them to run /swarm clarify or /swarm acknowledge-spec-drift.',
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
		tool: string,
		args: unknown,
	): void {
		if (tool !== 'bash' && tool !== 'shell') return;

		const toolArgs = args as Record<string, unknown> | undefined;
		const command =
			typeof toolArgs?.command === 'string' ? toolArgs.command.trim() : '';

		if (!command) return;

		const normalizedTool = tool;

		let analysis: WriteAnalysis;
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

		if (normalizedTool === 'bash') {
			analysis = detectPosixWrites(command);
		} else {
			analysis =
				shellType === 'powershell' || shellType === 'cmd'
					? detectWindowsWrites(command, shellType)
					: detectPosixWrites(command);
		}

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

		const isArch =
			stripKnownSwarmPrefix(shellWriteAgent).toLowerCase() === 'architect';
		if (!isArch && (!declaredScope || declaredScope.length === 0)) {
			return;
		}

		const resolvedWrites = resolveWriteTargets(
			command,
			analysis.writes,
			effectiveDirectory,
		);

		for (const write of resolvedWrites) {
			if (write.resolvedPath === null) {
				throw new Error(
					`BLOCKED: bash/shell write operation with unresolvable path target — rejecting for safety`,
				);
			}

			if (universalDenyPrefixes.length > 0) {
				const normalizedPath = path
					.relative(
						path.resolve(effectiveDirectory),
						path.resolve(effectiveDirectory, write.resolvedPath),
					)
					.replace(/\\/g, '/');
				for (const prefix of universalDenyPrefixes) {
					if (normalizedPath.toLowerCase().startsWith(prefix.toLowerCase())) {
						throw new Error(
							`WRITE BLOCKED: Agent "${shellWriteAgent}" is not authorised to write "${write.resolvedPath}" (via shell). Reason: Path is under universal deny prefix "${prefix}"`,
						);
					}
				}
			}

			const authorityCheck = checkFileAuthorityWithRules(
				shellWriteAgent,
				write.resolvedPath,
				effectiveDirectory,
				precomputedAuthorityRules,
				{ declaredScope },
			);
			if (!authorityCheck.allowed) {
				throw new Error(
					`WRITE BLOCKED: Agent "${shellWriteAgent}" is not authorised to write "${write.resolvedPath}" (via shell). Reason: ${authorityCheck.reason}`,
				);
			}

			if (
				declaredScope &&
				declaredScope.length > 0 &&
				!isInDeclaredScope(
					write.resolvedPath,
					declaredScope,
					effectiveDirectory,
				)
			) {
				throw new Error(
					`bash write detected outside declared scope: ${write.resolvedPath} (original: ${write.original.path})`,
				);
			}
		}
	}

	/**
	 * OS-native sandbox wrapper for bash/shell commands.
	 */
	async function applySandboxExecution(
		sessionID: string,
		tool: string,
		args: unknown,
		agent: string,
		command: string,
		auditPath: string,
		auditEnabled: boolean,
	): Promise<void> {
		if (tool !== 'bash' && tool !== 'shell') return;

		const executor = await getExecutor();
		if (!executor || !executor.isAvailable()) {
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

		const resolved = resolveScopePaths(declaredPaths, effectiveDirectory);
		if (resolved.paths.length === 0) return;

		try {
			const wrappedCommand = executor.wrapCommand(rawCommand, resolved.paths);
			toolArgs.command = wrappedCommand;

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

			const envOverrides = executor.getEnvOverrides();
			if (Object.keys(envOverrides).length > 0) {
				const existingEnv =
					(toolArgs.env as Record<string, string | null> | undefined) ?? {};
				toolArgs.env = { ...existingEnv, ...envOverrides };
			}
		} catch (err) {
			throw new Error(
				`[sandbox] BLOCKED: Failed to wrap command with ${executor.mechanism}: ${err}. Command will not be executed unsandboxed.`,
			);
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
		if (currentSession?.delegationActive) {
			if (isWriteTool(tool)) {
				const delegArgs = args as Record<string, unknown> | undefined;
				const delegTargetPath = (delegArgs?.filePath ??
					delegArgs?.path ??
					delegArgs?.file ??
					delegArgs?.target) as string | undefined;
				if (typeof delegTargetPath === 'string' && delegTargetPath.length > 0) {
					const agentName = swarmState.activeAgent.get(sessionID) ?? 'unknown';
					const cwd = effectiveDirectory;
					const authorityCheck = checkFileAuthorityWithRules(
						agentName,
						delegTargetPath,
						cwd,
						precomputedAuthorityRules,
						{ declaredScope: resolveDeclaredScope(sessionID) },
					);
					if (!authorityCheck.allowed) {
						throw new Error(
							`WRITE BLOCKED: Agent "${agentName}" is not authorised to write "${delegTargetPath}". Reason: ${authorityCheck.reason}`,
						);
					}

					if (
						isConfigFilePath(
							delegTargetPath,
							cwd,
							authorityConfig?.verifier_config_paths,
						)
					) {
						const normalizedPath = path
							.relative(path.resolve(cwd), path.resolve(cwd, delegTargetPath))
							.replace(/\\/g, '/');
						const logEntry: Record<string, unknown> = {
							agent: agentName,
							path: normalizedPath,
							allowed: authorityCheck.allowed,
							type: 'delegated_write',
						};
						if (!authorityCheck.allowed && 'reason' in authorityCheck) {
							logEntry.reason = (
								authorityCheck as { allowed: false; reason: string }
							).reason;
						}
						warn('Config file write attempt', logEntry);
					}

					if (
						!currentSession.modifiedFilesThisCoderTask.includes(delegTargetPath)
					) {
						currentSession.modifiedFilesThisCoderTask.push(delegTargetPath);
					}
				}
			}
			if (
				tool === 'apply_patch' ||
				tool === 'swarm_apply_patch' ||
				tool === 'patch'
			) {
				const agentName = swarmState.activeAgent.get(sessionID) ?? 'unknown';
				const cwd = effectiveDirectory;
				for (const p of extractPatchTargetPaths(tool, args)) {
					const authorityCheck = checkFileAuthorityWithRules(
						agentName,
						p,
						cwd,
						precomputedAuthorityRules,
						{ declaredScope: resolveDeclaredScope(sessionID) },
					);

					if (
						isConfigFilePath(p, cwd, authorityConfig?.verifier_config_paths)
					) {
						const normalizedPath = path
							.relative(path.resolve(cwd), path.resolve(cwd, p))
							.replace(/\\/g, '/');
						const logEntry: Record<string, unknown> = {
							agent: agentName,
							path: normalizedPath,
							allowed: authorityCheck.allowed,
							type: 'delegated_patch',
						};
						if (!authorityCheck.allowed && 'reason' in authorityCheck) {
							logEntry.reason = (
								authorityCheck as { allowed: false; reason: string }
							).reason;
						}
						warn('Config file write attempt', logEntry);
					}

					if (!authorityCheck.allowed) {
						throw new Error(
							`WRITE BLOCKED: Agent "${agentName}" is not authorised to write "${p}" (via patch). Reason: ${authorityCheck.reason}`,
						);
					}
					if (!currentSession.modifiedFilesThisCoderTask.includes(p)) {
						currentSession.modifiedFilesThisCoderTask.push(p);
					}
				}
			}
		} else if (isArchitect(sessionID)) {
			const coderDelegArgs = args as Record<string, unknown> | undefined;
			const rawSubagentType = coderDelegArgs?.subagent_type;
			const coderDeleg = isAgentDelegation(tool, coderDelegArgs);
			if (
				coderDeleg.isDelegation &&
				coderDeleg.targetAgent === 'coder' &&
				typeof rawSubagentType === 'string' &&
				(rawSubagentType === 'coder' || rawSubagentType.endsWith('_coder'))
			) {
				const coderSession = swarmState.agentSessions.get(sessionID);
				if (coderSession) {
					coderSession.modifiedFilesThisCoderTask = [];
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
				const modifiedFiles = loopSession.modifiedFilesThisCoderTask ?? [];
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
		for (const key of ['patch', 'input', 'diff'] as const) {
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

		const patchText = (toolArgs?.input ??
			toolArgs?.patch ??
			toolArgs?.diff ??
			(Array.isArray(toolArgs?.cmd) ? toolArgs.cmd[1] : undefined)) as
			| string
			| undefined;
		if (typeof patchText !== 'string') return Array.from(paths);
		if (patchText.length > 1_000_000) {
			throw new Error(
				'WRITE BLOCKED: Patch payload exceeds 1 MB — authority cannot be verified for all modified paths. Split into smaller patches.',
			);
		}
		const patchPathPattern = /\*\*\*\s+(?:Update|Add|Delete)\s+File:\s*(.+)/gi;
		const diffPathPattern = /\+\+\+\s+b\/(.+)/gm;
		const gitDiffPathPattern = /^diff --git a\/(.+?) b\/(.+?)$/gm;
		const minusPathPattern = /^---\s+a\/(.+)$/gm;
		const traditionalMinusPattern = /^---\s+([^\s].+?)(?:\t.*)?$/gm;
		const traditionalPlusPattern = /^\+\+\+\s+([^\s].+?)(?:\t.*)?$/gm;
		for (const match of patchText.matchAll(patchPathPattern))
			paths.add(match[1].trim());
		for (const match of patchText.matchAll(diffPathPattern)) {
			const p = match[1].trim();
			if (p !== '/dev/null') paths.add(p);
		}
		for (const match of patchText.matchAll(gitDiffPathPattern)) {
			const aPath = match[1].trim();
			const bPath = match[2].trim();
			if (aPath !== '/dev/null') paths.add(aPath);
			if (bPath !== '/dev/null') paths.add(bPath);
		}
		for (const match of patchText.matchAll(minusPathPattern)) {
			const p = match[1].trim();
			if (p !== '/dev/null') paths.add(p);
		}
		for (const match of patchText.matchAll(traditionalMinusPattern)) {
			const p = match[1].trim();
			if (p !== '/dev/null' && !p.startsWith('a/') && !p.startsWith('b/'))
				paths.add(p);
		}
		for (const match of patchText.matchAll(traditionalPlusPattern)) {
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
						'Present the drift to the user and ask them to run /swarm clarify or /swarm acknowledge-spec-drift.',
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
							'Present the drift to the user and ask them to run /swarm clarify or /swarm acknowledge-spec-drift.',
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
		// v6.35.1: Runaway output detector — reset counter on any tool call
		consecutiveNoToolTurns.set(input.sessionID, 0);

		// v6.12: Self-coding detection — MUST be first, before any exemptions
		handleDelegatedWriteTracking(input.sessionID, input.tool, output.args);

		// v6.29: Loop detection for Task tool delegations
		handleLoopDetection(input.sessionID, input.tool, output.args);

		// Block full test suite execution without file argument
		handleTestSuiteBlocking(input.tool, output.args);

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
			checkShellWriteScope(input.sessionID, input.tool, output.args);
		} catch (err) {
			const toolArgs = output.args as Record<string, unknown> | undefined;
			const declaredScope = resolveDeclaredScope(input.sessionID);
			const declaredScopeText =
				declaredScope != null && declaredScope.length > 0
					? declaredScope.join(', ')
					: '';
			const resolvedScopeText =
				declaredScope != null && declaredScope.length > 0
					? resolveScopePaths(declaredScope, effectiveDirectory).paths.join(
							', ',
						)
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

		// Issue #853 Layer B: structural spec-drift block
		enforceSpecDriftGate(effectiveDirectory, input.tool);

		// Plan state + scope protection — architect-only
		if (isArchitect(input.sessionID) && isWriteTool(input.tool)) {
			handlePlanAndScopeProtection(input.sessionID, input.tool, output.args);
		}

		// Authority + lstat + universal-deny checks for ALL agents on Write/Edit
		if (isWriteTool(input.tool)) {
			const toolArgs = output.args as Record<string, unknown> | undefined;
			const targetPath =
				toolArgs?.filePath ??
				toolArgs?.path ??
				toolArgs?.file ??
				toolArgs?.target;
			if (typeof targetPath === 'string' && targetPath.length > 0) {
				const agentName =
					swarmState.activeAgent.get(input.sessionID) ?? 'unknown';
				// lstat: block writes through symlinks
				const lstatBlock = checkWriteTargetForSymlink(
					targetPath,
					effectiveDirectory,
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

				if (!agentName) {
					throw new Error(
						`WRITE BLOCKED: No active agent registered for session "${input.sessionID}". Call startAgentSession before issuing write tool calls.`,
					);
				}

				// Universal deny prefixes
				if (universalDenyPrefixes.length > 0) {
					const normalizedPath = path
						.relative(
							path.resolve(effectiveDirectory),
							path.resolve(effectiveDirectory, targetPath),
						)
						.replace(/\\/g, '/');
					for (const prefix of universalDenyPrefixes) {
						if (normalizedPath.toLowerCase().startsWith(prefix.toLowerCase())) {
							void appendGuardrailDecision(
								{
									type: 'file_write',
									ts: new Date().toISOString(),
									sessionID: input.sessionID,
									agent: agentName,
									tool: input.tool,
									path: targetPath,
									reason: `Path is under universal deny prefix "${prefix}"`,
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
							throw new Error(
								`WRITE BLOCKED: Agent "${agentName}" is not authorised to write "${targetPath}". Reason: Path is under universal deny prefix "${prefix}"`,
							);
						}
					}
				}

				// Per-agent authority check
				const writeDeclaredScope = resolveDeclaredScope(input.sessionID);

				const authorityCheck = checkFileAuthorityWithRules(
					agentName,
					targetPath,
					effectiveDirectory,
					precomputedAuthorityRules,
					{ declaredScope: writeDeclaredScope },
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

				// Log config file write attempts
				if (
					isConfigFilePath(
						targetPath,
						effectiveDirectory,
						authorityConfig?.verifier_config_paths,
					)
				) {
					const normalizedPath = path
						.relative(
							path.resolve(effectiveDirectory),
							path.resolve(effectiveDirectory, targetPath),
						)
						.replace(/\\/g, '/');
					const logEntry: Record<string, unknown> = {
						agent: agentName,
						path: normalizedPath,
						allowed: authorityCheck.allowed,
						type: 'direct_write',
					};
					if (!authorityCheck.allowed && 'reason' in authorityCheck) {
						logEntry.reason = (
							authorityCheck as { allowed: false; reason: string }
						).reason;
					}
					warn('Config file write attempt', logEntry);
				}
			}
		}

		// Authority + lstat + universal-deny for apply_patch / swarm_apply_patch / patch
		if (
			input.tool === 'apply_patch' ||
			input.tool === 'swarm_apply_patch' ||
			input.tool === 'patch'
		) {
			const patchAgentName =
				swarmState.activeAgent.get(input.sessionID) ?? 'unknown';
			if (!swarmState.activeAgent.has(input.sessionID)) {
				throw new Error(
					`WRITE BLOCKED: No active agent registered for session "${input.sessionID}". Call startAgentSession before issuing write tool calls.`,
				);
			}
			for (const p of extractPatchTargetPaths(input.tool, output.args)) {
				const lstatBlock = checkWriteTargetForSymlink(p, effectiveDirectory);
				if (lstatBlock) {
					void appendGuardrailDecision(
						{
							type: 'file_write',
							ts: new Date().toISOString(),
							sessionID: input.sessionID,
							agent: patchAgentName,
							tool: input.tool,
							path: p,
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

				if (universalDenyPrefixes.length > 0) {
					const normalizedP = path
						.relative(
							path.resolve(effectiveDirectory),
							path.resolve(effectiveDirectory, p),
						)
						.replace(/\\/g, '/');
					for (const prefix of universalDenyPrefixes) {
						if (normalizedP.toLowerCase().startsWith(prefix.toLowerCase())) {
							void appendGuardrailDecision(
								{
									type: 'file_write',
									ts: new Date().toISOString(),
									sessionID: input.sessionID,
									agent: patchAgentName,
									tool: input.tool,
									path: p,
									reason: `Path is under universal deny prefix "${prefix}"`,
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
							throw new Error(
								`WRITE BLOCKED: Agent "${patchAgentName}" is not authorised to write "${p}" (via patch). Reason: Path is under universal deny prefix "${prefix}"`,
							);
						}
					}
				}

				const patchDeclaredScope = resolveDeclaredScope(input.sessionID);

				const authorityCheck = checkFileAuthorityWithRules(
					patchAgentName,
					p,
					effectiveDirectory,
					precomputedAuthorityRules,
					{ declaredScope: patchDeclaredScope },
				);
				if (!authorityCheck.allowed) {
					void appendGuardrailDecision(
						{
							type: 'file_write',
							ts: new Date().toISOString(),
							sessionID: input.sessionID,
							agent: patchAgentName,
							tool: input.tool,
							path: p,
							reason: authorityCheck.reason,
							resolvedScope: (() => {
								const scope = patchDeclaredScope;
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
						`WRITE BLOCKED: Agent "${patchAgentName}" is not authorised to write "${p}" (via patch). Reason: ${authorityCheck.reason}`,
					);
				}

				// Log config file write attempts for direct patches
				if (
					isConfigFilePath(
						p,
						effectiveDirectory,
						authorityConfig?.verifier_config_paths,
					)
				) {
					const normalizedPath = path
						.relative(
							path.resolve(effectiveDirectory),
							path.resolve(effectiveDirectory, p),
						)
						.replace(/\\/g, '/');
					const logEntry: Record<string, unknown> = {
						agent: patchAgentName,
						path: normalizedPath,
						allowed: authorityCheck.allowed,
						type: 'direct_patch',
					};
					if (!authorityCheck.allowed && 'reason' in authorityCheck) {
						logEntry.reason = (
							authorityCheck as { allowed: false; reason: string }
						).reason;
					}
					warn('Config file write attempt', logEntry);
				}
			}
		}

		// v6.29: PRM hard stop
		{
			const prmSession = swarmState.agentSessions.get(input.sessionID);
			if (prmSession?.prmHardStopPending) {
				throw new Error(
					'🛑 PRM HARD STOP: Pattern escalation maximum reached. Stop tool calls and return progress summary.',
				);
			}
		}

		// Resolve session — returns null if architect-exempt
		const resolved = resolveSessionAndWindow(input.sessionID);
		if (!resolved) return;

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

		// OS-level sandbox enforcement
		await applySandboxExecution(
			input.sessionID,
			input.tool,
			output.args,
			(() => {
				const rawAgent = swarmState.activeAgent.get(input.sessionID);
				return rawAgent ? stripKnownSwarmPrefix(rawAgent) : 'unknown';
			})(),
			(() => {
				const bashArgs = output.args as Record<string, unknown> | undefined;
				const rawCmd =
					typeof bashArgs?.command === 'string' ? bashArgs.command : '';
				return rawCmd;
			})(),
			shellAuditPath,
			shellAuditEnabled,
		);

		// v6.12: Store input args for delegation detection in toolAfter
		setStoredInputArgs(input.callID, output.args);
	};
}
