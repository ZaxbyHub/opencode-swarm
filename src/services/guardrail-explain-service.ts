import path from 'node:path';
import { HUMAN_ONLY_SWARM_COMMANDS } from '../commands/tool-policy.js';
import { classifyFile, type FileZone } from '../context/zone-classifier.js';
import { redactPath } from '../hooks/guardrails/audit-log.js';
import {
	DC_SAFE_TARGETS,
	dcCheckJunctionCreation,
	dcExtractPowerShellTargets,
	dcExtractWindowsCmdTargets,
	dcNormalizeCommand,
	dcSplitSegments,
	dcUnwrapWrappers,
	dcValidateTargets,
} from '../hooks/guardrails/destructive-command.js';
import { checkFileAuthority } from '../hooks/guardrails/file-authority.js';
import {
	isInDeclaredScope,
	redactShellCommand,
} from '../hooks/guardrails/helpers.js';
import {
	detectPosixWrites,
	detectWindowsWrites,
	resolveWriteTargets,
} from '../hooks/shell-write-detect.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Result of dry-run shell analysis.
 */
export interface GuardrailShellResult {
	decision: 'allow' | 'block';
	firingRule: string;
	resolvedScope: string;
	writeCategories: string[];
	command: string;
}

/**
 * Result of dry-run write-target analysis for a single path.
 */
export interface GuardrailWriteTargetResult {
	path: string;
	decision: 'allow' | 'block';
	firingRule: string;
	resolvedScope: string;
	zone: FileZone;
}

/**
 * Top-level result returned by handleGuardrailExplain.
 */
export interface GuardrailExplainResult {
	mode: 'shell' | 'write';
	shell?: GuardrailShellResult;
	writeTargets?: GuardrailWriteTargetResult[];
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

interface ParsedArgs {
	agent: string;
	scope: string | null;
	writeTargets: string[];
	shellCommand: string;
}

/**
 * Parse command-line arguments for the guardrail-explain command.
 *
 * Supported flags:
 *   --agent <role>       Agent role (default: 'coder')
 *   --scope <path>       Override declared scope path
 *   --write <path>       Write-target mode (repeatable)
 *
 * Any non-flag tokens are joined as the positional shell command.
 */
function parseGuardrailExplainArgs(args: string[]): ParsedArgs {
	let agent = 'coder';
	let scope: string | null = null;
	const writeTargets: string[] = [];
	const positional: string[] = [];

	let i = 0;
	while (i < args.length) {
		const token = args[i];
		if (token === '--agent' && i + 1 < args.length) {
			agent = args[i + 1];
			i += 2;
		} else if (token === '--scope' && i + 1 < args.length) {
			scope = args[i + 1];
			i += 2;
		} else if (token === '--write' && i + 1 < args.length) {
			writeTargets.push(args[i + 1]);
			i += 2;
		} else {
			positional.push(token);
			i++;
		}
	}

	return {
		agent,
		scope,
		writeTargets,
		shellCommand: positional.join(' '),
	};
}

// ---------------------------------------------------------------------------
// Shell-type resolution
// ---------------------------------------------------------------------------

/**
 * Heuristic shell-type detection used for write-target detection.
 * Mirrors the logic in tool-before.ts.
 */
function resolveShellType(command: string): 'posix' | 'powershell' | 'cmd' {
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
		/^(cmd|cmd\.exe|c:\/|set \w+=|\.\d+|del \/|rd \/|mkdir|chdir|echo |copy |move |ren |fc |diskpart)/i.test(
			command,
		) ||
		/%[^%\s]+%/.test(command) ||
		/\b(set|echo|if|exist)\s+/i.test(command)
	) {
		return 'cmd';
	}
	// The real hook distinguishes bash/unix internally, but both route through
	// POSIX write detection. Keep explain's public type collapsed to posix.
	return 'posix';
}

// ---------------------------------------------------------------------------
// Destructive-command dry-run (mirrors checkDestructiveCommand)
// ---------------------------------------------------------------------------

// TODO(#1274): checkDestructiveCommand is a nested closure in tool-before.ts:182
// (captures cfg.block_destructive_commands, effectiveDirectory, resolveDeclaredScope) and
// cannot be exported without refactoring the guardrail hot path. This block mirrors its
// destructive-pattern detection; the heavy helpers (dc*, isInDeclaredScope, DC_SAFE_TARGETS)
// are shared imports. Future refactor: extract a top-level evaluateDestructiveDecision().

/**
 * Evaluate the destructive-command decision for a shell command in dry-run mode.
 * Returns { decision, firingRule } without throwing.
 *
 * Assumes block_destructive_commands is TRUE (explain predicts default guardrail behavior).
 * cwd = the directory parameter. declaredScope = --scope override or null.
 */
function evaluateDestructiveDecision(
	rawCommand: string,
	cwd: string,
	declaredScope: string[] | null,
): { decision: 'allow' | 'block'; firingRule: string } {
	if (!rawCommand) {
		return { decision: 'allow', firingRule: 'allow: no rule matched' };
	}

	const command = dcNormalizeCommand(rawCommand);

	// Fork bomb (mirror real checkDestructiveCommand: allows whitespace after the leading ':')
	if (/:\s*\(\s*\)\s*\{[^}]*\|[^}]*:/.test(command)) {
		return {
			decision: 'block',
			firingRule: 'destructive_block: fork bomb pattern',
		};
	}

	const unwrapped = dcUnwrapWrappers(command);
	const outerSegments = dcSplitSegments(command);
	const innerSegments = dcSplitSegments(unwrapped);
	const perSegmentUnwrapped = outerSegments.map((s) => dcUnwrapWrappers(s));
	const allSegments = [
		...new Set([...outerSegments, ...innerSegments, ...perSegmentUnwrapped]),
	];

	for (const segment of allSegments) {
		const seg = segment.trim();
		if (!seg) continue;

		// Junction/symlink creation with out-of-cwd target
		const junctionBlock = dcCheckJunctionCreation(seg, cwd);
		if (junctionBlock) {
			return {
				decision: 'block',
				firingRule: 'destructive_block: junction creation',
			};
		}

		// POSIX rm — short flags (-rf, -fr, -r -f) and long flags
		const rmShortMatch = seg.match(
			/^rm\s+(-[rRfF]+(?:\s+-[rRfF]+)*|-r\s+-f|-f\s+-r)\s+(.+)$/,
		);
		const rmLongMatch = seg.match(
			/^rm\s+(?:--(?:recursive|force)\s+){1,2}(.+)$/,
		);
		const rmAnyMatch = rmShortMatch ?? rmLongMatch;
		if (rmAnyMatch) {
			const targetPart = rmAnyMatch[rmShortMatch ? 2 : 1].trim();
			const targets = targetPart.split(/\s+/);
			const validateBlock = dcValidateTargets(targets, cwd);
			if (validateBlock) {
				return {
					decision: 'block',
					firingRule: `destructive_block: rm with unsafe target: ${redactPath(targetPart)}`,
				};
			}
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
					return {
						decision: 'block',
						firingRule: `destructive_block: rm recursive/force on unsafe path: ${redactPath(targetPart)}`,
					};
				}
			}
		}

		// Windows cmd.exe: rmdir /s, rd /s
		if (/^(?:rmdir|rd)(?:\.exe)?\s+.*\/[sS]/i.test(seg)) {
			const targets = dcExtractWindowsCmdTargets(seg);
			if (targets.length === 0) {
				return {
					decision: 'block',
					firingRule:
						'destructive_block: Windows recursive directory delete (rmdir /s)',
				};
			}
			const validateBlock = dcValidateTargets(targets, cwd);
			if (validateBlock) {
				return {
					decision: 'block',
					firingRule: `destructive_block: rmdir /s unsafe: ${redactPath(targets.join(', '))}`,
				};
			}
			const allSafe = targets.every((t) => DC_SAFE_TARGETS.has(t.trim()));
			if (!allSafe) {
				const scopeExempt =
					declaredScope != null &&
					declaredScope.length > 0 &&
					targets.every((t) => isInDeclaredScope(t.trim(), declaredScope, cwd));
				if (!scopeExempt) {
					return {
						decision: 'block',
						firingRule: `destructive_block: rmdir /s on unsafe path: ${redactPath(targets.join(', '))}`,
					};
				}
			}
		}

		// Windows cmd.exe: del /s /q /f
		if (/^del(?:\.exe)?\s+.*\/[sS]/i.test(seg)) {
			const targets = dcExtractWindowsCmdTargets(seg);
			if (targets.length > 0) {
				const validateBlock = dcValidateTargets(targets, cwd);
				if (validateBlock) {
					return {
						decision: 'block',
						firingRule: `destructive_block: del /s unsafe: ${redactPath(targets.join(', '))}`,
					};
				}
				const allSafe = targets.every((t) => DC_SAFE_TARGETS.has(t.trim()));
				if (!allSafe) {
					const scopeExempt =
						declaredScope != null &&
						declaredScope.length > 0 &&
						targets.every((t) =>
							isInDeclaredScope(t.trim(), declaredScope, cwd),
						);
					if (!scopeExempt) {
						return {
							decision: 'block',
							firingRule: `destructive_block: del /s on unsafe path: ${redactPath(targets.join(', '))}`,
						};
					}
				}
			}
		}

		// PowerShell: Remove-Item / aliases with -Recurse
		if (
			/^(?:Remove-Item|ri|rm|rmdir|del|erase|rd)\b.*-[Rr]ecurse\b/i.test(seg) ||
			/^(?:Remove-Item|ri|rm|rmdir|del|erase|rd)\b.*-[Rr]\b/i.test(seg)
		) {
			const targets = dcExtractPowerShellTargets(seg);
			if (targets.length > 0) {
				const validateBlock = dcValidateTargets(targets, cwd);
				if (validateBlock) {
					return {
						decision: 'block',
						firingRule: `destructive_block: PowerShell recursive delete unsafe: ${redactPath(targets.join(', '))}`,
					};
				}
				const allSafe = targets.every((t) => DC_SAFE_TARGETS.has(t.trim()));
				if (!allSafe) {
					const scopeExempt =
						declaredScope != null &&
						declaredScope.length > 0 &&
						targets.every((t) =>
							isInDeclaredScope(t.trim(), declaredScope, cwd),
						);
					if (!scopeExempt) {
						return {
							decision: 'block',
							firingRule: `destructive_block: PowerShell recursive delete on unsafe path: ${redactPath(targets.join(', '))}`,
						};
					}
				}
			} else {
				return {
					decision: 'block',
					firingRule:
						'destructive_block: PowerShell Remove-Item -Recurse (target unverifiable)',
				};
			}
		}

		// PowerShell: Get-ChildItem | Remove-Item -Recurse (pipe form)
		if (
			/Get-ChildItem\b.*\|\s*Remove-Item\b.*-[Rr]ecurse/i.test(seg) ||
			/gci\b.*\|\s*ri\b.*-[Rr]ecurse/i.test(seg)
		) {
			return {
				decision: 'block',
				firingRule:
					'destructive_block: PowerShell pipeline Get-ChildItem | Remove-Item -Recurse',
			};
		}

		// Ransomware-grade / disk-level destruction
		if (/^vssadmin(?:\.exe)?\s+delete\b/i.test(seg)) {
			return {
				decision: 'block',
				firingRule: 'destructive_block: vssadmin delete (ransomware-grade)',
			};
		}
		if (/^wbadmin(?:\.exe)?\s+delete\b/i.test(seg)) {
			return {
				decision: 'block',
				firingRule:
					'destructive_block: wbadmin delete (backup catalog deletion)',
			};
		}
		if (/^diskpart(?:\.exe)?$/i.test(seg)) {
			return {
				decision: 'block',
				firingRule:
					'destructive_block: diskpart (interactive disk partitioning)',
			};
		}
		if (/^bcdedit(?:\.exe)?\s+\/delete\b/i.test(seg)) {
			return {
				decision: 'block',
				firingRule:
					'destructive_block: bcdedit /delete (boot config modification)',
			};
		}
		if (/^sdelete(?:\.exe)?\s+/i.test(seg)) {
			return {
				decision: 'block',
				firingRule: 'destructive_block: sdelete (secure file deletion)',
			};
		}
		if (
			/^fsutil(?:\.exe)?\s+reparsepoint\s+delete\b/i.test(seg) ||
			/^fsutil(?:\.exe)?\s+file\s+setzerodata\b/i.test(seg)
		) {
			return {
				decision: 'block',
				firingRule: 'destructive_block: fsutil destructive subcommand',
			};
		}
		if (/^takeown(?:\.exe)?\s+.*\/[rR]\b/i.test(seg)) {
			return {
				decision: 'block',
				firingRule:
					'destructive_block: takeown /R (recursive ownership takeover)',
			};
		}
		if (/^cipher(?:\.exe)?\s+\/[wW]\b/i.test(seg)) {
			return {
				decision: 'block',
				firingRule: 'destructive_block: cipher /w (free disk space wipe)',
			};
		}
		if (/^format\s+[A-Za-z]:/i.test(seg)) {
			return {
				decision: 'block',
				firingRule: 'destructive_block: Windows disk format command',
			};
		}
		if (/^robocopy(?:\.exe)?\s+.*\/(?:MIR|mir)\b/.test(seg)) {
			return {
				decision: 'block',
				firingRule: 'destructive_block: robocopy /MIR (mirror delete)',
			};
		}

		// POSIX: chmod/chattr/icacls denial-of-service patterns
		if (/^chmod\s+.*-[rR]\b.*000\b/.test(seg)) {
			return {
				decision: 'block',
				firingRule: 'destructive_block: chmod -R 000 (permission wipe)',
			};
		}
		if (/^chattr\s+.*\+i\b/.test(seg)) {
			return {
				decision: 'block',
				firingRule: 'destructive_block: chattr +i (immutable flag)',
			};
		}
		if (/^icacls(?:\.exe)?\s+.*\/deny\b/i.test(seg)) {
			return {
				decision: 'block',
				firingRule: 'destructive_block: icacls /deny (permission denial)',
			};
		}

		// dd data-wipe patterns
		if (/^dd\b.*\bif=\/dev\/(zero|null|urandom)\b/.test(seg)) {
			return {
				decision: 'block',
				firingRule:
					'destructive_block: dd with /dev/zero|null|urandom (data wipe)',
			};
		}

		// Git destructive operations. Mirror tool-before.ts: `--force-with-lease`
		// is exempt (safe force push); bare `--force`/`-f` stay blocked. (#1692)
		if (/^git\s+push\b.*?(--force(?!-with-lease)|-f)\b/.test(seg)) {
			return {
				decision: 'block',
				firingRule: 'destructive_block: git push --force',
			};
		}
		if (/^git\s+reset\s+--hard/.test(seg)) {
			return {
				decision: 'block',
				firingRule: 'destructive_block: git reset --hard',
			};
		}
		if (/^git\s+reset\s+--mixed\s+\S+/.test(seg)) {
			return {
				decision: 'block',
				firingRule: 'destructive_block: git reset --mixed with target',
			};
		}
		if (/^git\s+clean\s+.*-[fF].*[dD]/.test(seg)) {
			return {
				decision: 'block',
				firingRule: 'destructive_block: git clean -fd',
			};
		}
		if (/^git\s+worktree\s+remove\s+.*--force\b/i.test(seg)) {
			return {
				decision: 'block',
				firingRule: 'destructive_block: git worktree remove --force',
			};
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
				return {
					decision: 'block',
					firingRule: `destructive_block: rsync --delete (target: ${redactPath(rsyncTarget ?? 'unknown')})`,
				};
			}
		}

		// kubectl / docker
		if (/^kubectl\s+delete\b/.test(seg)) {
			return {
				decision: 'block',
				firingRule: 'destructive_block: kubectl delete',
			};
		}
		if (/^docker\s+system\s+prune\b/.test(seg)) {
			return {
				decision: 'block',
				firingRule: 'destructive_block: docker system prune',
			};
		}

		// SQL DDL
		if (/^\s*DROP\s+(TABLE|DATABASE|SCHEMA)\b/i.test(seg)) {
			return {
				decision: 'block',
				firingRule: 'destructive_block: SQL DROP statement',
			};
		}
		if (/^\s*TRUNCATE\s+TABLE\b/i.test(seg)) {
			return {
				decision: 'block',
				firingRule: 'destructive_block: SQL TRUNCATE TABLE statement',
			};
		}

		// POSIX mv targeting .swarm/ paths
		if (/^\\?mv\s/i.test(seg)) {
			const mvMatch = seg.match(/^\\?mv\s+(.+)$/i);
			if (mvMatch) {
				const argsStr = mvMatch[1].replace(/["']/g, '');
				if (/\.swarm(?:[\x5c/\s]|$)/.test(argsStr)) {
					return {
						decision: 'block',
						firingRule:
							'destructive_block: "mv" targeting .swarm/ detected — move operations under .swarm/ are not allowed from shell commands',
					};
				}
			}
		}

		// Windows cmd move/ren targeting .swarm\ paths
		if (/^\\?(?:move|ren)(?:\.exe)?\s/i.test(seg)) {
			const moveMatch = seg.match(/^\\?(?:move|ren)(?:\.exe)?\s+(.+)$/i);
			if (moveMatch) {
				const argsStr = moveMatch[1].replace(/["']/g, '');
				if (/\.swarm(?:[\x5c/\s]|$)/i.test(argsStr)) {
					return {
						decision: 'block',
						firingRule:
							'destructive_block: "move" or "ren" targeting .swarm/ detected — move/rename operations under .swarm/ are not allowed from shell commands',
					};
				}
			}
		}

		// PowerShell Move-Item/Rename-Item targeting .swarm/ paths
		if (
			/^\\?(?:Move-Item|Rename-Item|move|mi|mv|ren|rni)\b.*\.swarm(?:[\x5c/\s]|$)/i.test(
				seg,
			)
		) {
			return {
				decision: 'block',
				firingRule:
					'destructive_block: PowerShell Move-Item or Rename-Item targeting .swarm/ detected — move/rename operations under .swarm/ are not allowed from shell commands',
			};
		}

		// Non-recursive rm targeting .swarm/ paths
		if (
			/^\\?rm\b/i.test(seg) &&
			!/^\\?rm\s+(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\b/i.test(seg) &&
			/\.swarm(?:[\x5c/\s]|$)/i.test(seg)
		) {
			return {
				decision: 'block',
				firingRule:
					'destructive_block: "rm" targeting .swarm/ detected — deleting files under .swarm/ is not allowed from shell commands',
			};
		}

		// cp + rm chain detection (copy-then-delete bypass)
		if (
			/\bcp\b.*\.swarm(?:[\x5c/\s]|$)/i.test(seg) &&
			/\brm\b.*\.swarm(?:[\x5c/\s]|$)/i.test(seg)
		) {
			return {
				decision: 'block',
				firingRule:
					'destructive_block: "cp" of .swarm/ file followed by "rm" of .swarm/ source detected — copy-and-delete bypass is not allowed',
			};
		}

		// Archive tools with delete-source flags targeting .swarm/
		if (
			/^rsync\b.*--remove-source-files\b/i.test(seg) &&
			/\.swarm(?:[\x5c/\s]|$)/i.test(seg)
		) {
			return {
				decision: 'block',
				firingRule:
					'destructive_block: "rsync" with delete-source flag targeting .swarm/ detected — archive with source deletion under .swarm/ is not allowed',
			};
		}
		if (
			/^tar\b.*--remove-files\b/i.test(seg) &&
			/\.swarm(?:[\x5c/\s]|$)/i.test(seg)
		) {
			return {
				decision: 'block',
				firingRule:
					'destructive_block: "tar" with delete-source flag targeting .swarm/ detected — archive with source deletion under .swarm/ is not allowed',
			};
		}
		if (/^zip\b.*\s-m\b/i.test(seg) && /\.swarm(?:[\x5c/\s]|$)/i.test(seg)) {
			return {
				decision: 'block',
				firingRule:
					'destructive_block: "zip" with delete-source flag targeting .swarm/ detected — archive with source deletion under .swarm/ is not allowed',
			};
		}
		if (/^7z\b.*\s-sdel\b/i.test(seg) && /\.swarm(?:[\x5c/\s]|$)/i.test(seg)) {
			return {
				decision: 'block',
				firingRule:
					'destructive_block: "7z" with delete-source flag targeting .swarm/ detected — archive with source deletion under .swarm/ is not allowed',
			};
		}

		// Disk format (mkfs only — matches real checkDestructiveCommand). NOTE: wipefs/shred/
		// truncate/sed -i/perl -i are NOT in real enforcement, so explain must NOT block them
		// either (over-mirroring causes drift — explain would predict a block that never fires).
		if (/^mkfs[./]/.test(seg)) {
			return {
				decision: 'block',
				firingRule: 'destructive_block: mkfs (filesystem format)',
			};
		}

		// Human-only swarm CLI bypass — mirror real checkDestructiveCommand (tool-before.ts:598-702).
		// Agents must not invoke human-only /swarm subcommands via shell (e.g. `opencode-swarm run reset`).
		{
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
			const swarmCliMatches = [
				probe.match(
					/^\\?(?:bunx|npx|pnpx|npm(?:\s+(?:exec|x)(?:\s+--)?)?|pnpm(?:\s+(?:dlx|exec))?|yarn(?:\s+(?:dlx|exec))?|bun(?:\s+x)?|node|deno\s+run|tsx|ts-node)\b[^|;&]*?\bopencode-swarm\b[^|;&]*?\brun\s+([A-Za-z0-9_-]+(?:\s+(?!-)[A-Za-z0-9_-]+)?)/i,
				),
				probe.match(
					/^\\?opencode-swarm\b[^|;&]*?\brun\s+([A-Za-z0-9_-]+(?:\s+(?!-)[A-Za-z0-9_-]+)?)/i,
				),
				probe.match(
					/\bcli[/\\]+index\.[mc]?(?:js|ts)\b[^|;&]*?\brun\s+([A-Za-z0-9_-]+(?:\s+(?!-)[A-Za-z0-9_-]+)?)/i,
				),
			];
			for (const m of swarmCliMatches) {
				if (!m) continue;
				const captured = m[1];
				const normalized = captured.trim().split(/\s+/).join(' ');
				const firstToken = normalized.includes(' ')
					? normalized.split(' ')[0]!
					: normalized;
				if (
					HUMAN_ONLY_SWARM_COMMANDS.has(normalized) ||
					HUMAN_ONLY_SWARM_COMMANDS.has(firstToken)
				) {
					const cmdName = HUMAN_ONLY_SWARM_COMMANDS.has(normalized)
						? normalized
						: firstToken;
					return {
						decision: 'block',
						firingRule: `human_only_command: "${cmdName}" is a human-only swarm command (not invocable from shell by an agent)`,
					};
				}
			}
		}

		// Direct shell manipulation of .swarm/spec-staleness.json — mirror real checkDestructiveCommand:704-725.
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
					return {
						decision: 'block',
						firingRule:
							'system_file_tampering: shell command targeting .swarm/spec-staleness.json (system-managed file)',
					};
				}
			}
		}
	}

	return {
		decision: 'allow',
		firingRule: 'allow: no destructive/scope rule matched',
	};
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

/**
 * Dry-run guardrail explainer — analyzes a shell command or write target
 * WITHOUT executing anything. Returns a markdown report of what the
 * guardrails WOULD do.
 *
 * Arg interface:
 *   guardrail explain <command>                    — shell mode
 *   guardrail explain --agent <role> <command>     — shell mode with agent override
 *   guardrail explain --scope <path> <command>     — shell mode with scope override
 *   guardrail explain --write <path>               — write-target mode
 *   guardrail explain --write <p1> --write <p2>    — multiple write targets
 */
export async function handleGuardrailExplain(
	directory: string,
	args: string[],
): Promise<string> {
	const { agent, scope, writeTargets, shellCommand } =
		parseGuardrailExplainArgs(args);

	const resolvedScope = scope ?? directory;
	// Build scope entries array for isInDeclaredScope checks. When no --scope override is
	// given, default to the project directory (== resolvedScope) so in-project writes are
	// allowed — matching the displayed "resolved scope". An empty array here would wrongly
	// block every write as out-of-scope.
	const scopeEntries: string[] =
		scope != null && scope.length > 0 ? [scope] : [resolvedScope];

	// ---------------------------------------------------------------
	// WRITE-TARGET mode
	// ---------------------------------------------------------------
	if (writeTargets.length > 0) {
		const results: GuardrailWriteTargetResult[] = [];

		for (const rawPath of writeTargets) {
			const absolutePath = path.resolve(directory, rawPath);
			const decision = checkFileAuthority(
				agent,
				absolutePath,
				directory,
				undefined,
				{ declaredScope: scope != null ? [scope] : null },
			);
			const zoneResult = classifyFile(absolutePath);
			const allowed = decision.allowed === true;
			const zone = allowed
				? zoneResult.zone
				: (decision.zone ?? zoneResult.zone);

			results.push({
				path: rawPath,
				decision: allowed ? 'allow' : 'block',
				firingRule: allowed ? 'allow: no rule matched' : decision.reason,
				resolvedScope,
				zone,
			});
		}

		const redactedResolvedScope = redactPath(resolvedScope);
		const lines: string[] = [
			'## Guardrail Explain (dry-run)',
			'',
			`**Mode**: write-target | **Agent**: ${agent} | **Resolved scope**: ${redactedResolvedScope}`,
			'',
			'| Path | Decision | Firing Rule | Resolved Scope | Zone |',
			'| --- | --- | --- | --- | --- |',
			...results.map(
				(r) =>
					`| ${redactPath(r.path)} | ${r.decision} | ${r.firingRule} | ${redactPath(r.resolvedScope)} | ${r.zone} |`,
			),
			'',
		];

		return lines.join('\n');
	}

	// ---------------------------------------------------------------
	// SHELL mode
	// ---------------------------------------------------------------
	if (!shellCommand) {
		return [
			'## Guardrail Explain (dry-run)',
			'',
			'Provide a shell command to analyze, or use `--write <path>` for write-target mode.',
			'',
			'```',
			'/swarm guardrail explain <command>',
			'/swarm guardrail explain --agent <role> --scope <path> <command>',
			'/swarm guardrail explain --write <path> [--write <path2> ...]',
			'```',
			'',
		].join('\n');
	}

	let decision: 'allow' | 'block' = 'allow';
	let firingRule = 'allow: no rule matched';
	const writeCategories = new Set<string>();

	// --- Destructive-command dry-run (self-contained, mirrors checkDestructiveCommand) ---
	const destructiveEval = evaluateDestructiveDecision(
		shellCommand,
		directory,
		scopeEntries,
	);
	if (destructiveEval.decision === 'block') {
		decision = 'block';
		firingRule = destructiveEval.firingRule;
	}

	// --- Shell-write-scope check (mirrors checkShellWriteScope decision) ---
	if (decision === 'allow') {
		const shellType = resolveShellType(shellCommand);
		const analysis =
			shellType === 'powershell' || shellType === 'cmd'
				? detectWindowsWrites(shellCommand, shellType)
				: detectPosixWrites(shellCommand);

		if (analysis.parseError) {
			decision = 'block';
			firingRule =
				'parse_error: write detection failed to parse command — rejecting for safety';
		} else if (analysis.hasWrites) {
			const resolvedWrites = resolveWriteTargets(
				shellCommand,
				analysis.writes,
				directory,
			);

			for (const write of resolvedWrites) {
				if (write.resolvedPath) {
					// Architect is exempt from scope checks
					if (agent !== 'architect') {
						const inScope = isInDeclaredScope(
							write.resolvedPath,
							scopeEntries,
							directory,
						);
						if (!inScope) {
							decision = 'block';
							firingRule = `scope_violation: write outside declared scope: ${redactPath(write.resolvedPath)}`;
							break;
						}
					}
					writeCategories.add(write.original.category);
				} else {
					writeCategories.add(write.original.category);
				}
			}
		}
	} else {
		// Already blocked; still collect write categories for reporting.
		const shellType = resolveShellType(shellCommand);
		const analysis =
			shellType === 'powershell' || shellType === 'cmd'
				? detectWindowsWrites(shellCommand, shellType)
				: detectPosixWrites(shellCommand);

		if (!analysis.parseError && analysis.hasWrites) {
			for (const write of analysis.writes) {
				writeCategories.add(write.category);
			}
		}
	}

	const redactedCommand = redactShellCommand(shellCommand);

	const redactedResolvedScopeShell = redactPath(resolvedScope);
	const shellResult: GuardrailShellResult = {
		decision,
		firingRule,
		resolvedScope: redactedResolvedScopeShell,
		writeCategories: writeCategories.size > 0 ? [...writeCategories] : [],
		command: redactedCommand,
	};

	const lines: string[] = [
		'## Guardrail Explain (dry-run)',
		'',
		`**Mode**: shell | **Agent**: ${agent} | **Resolved scope**: ${redactedResolvedScopeShell}`,
		'',
		'| Field | Value |',
		'| --- | --- |',
		`| Command | \`${shellResult.command}\` |`,
		`| Decision | ${shellResult.decision} |`,
		`| Firing Rule | ${shellResult.firingRule} |`,
		`| Resolved Scope | ${shellResult.resolvedScope} |`,
		`| Write Categories | ${shellResult.writeCategories.length > 0 ? shellResult.writeCategories.join(', ') : '(none)'} |`,
		'',
	];

	return lines.join('\n');
}
