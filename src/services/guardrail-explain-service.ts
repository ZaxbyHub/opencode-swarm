import path from 'node:path';
import { HUMAN_ONLY_SWARM_COMMANDS } from '../commands/tool-policy.js';
import { classifyFile, type FileZone } from '../context/zone-classifier.js';
import { redactPath } from '../hooks/guardrails/audit-log.js';
import {
	dcAnalyzeLauncherUncertainty,
	dcCheckJunctionCreation,
	dcEvaluateRecursiveDeleteTargets,
	dcExpandDestructiveSegments,
	dcExtractPowerShellTargets,
	dcExtractRecursiveRmTargets,
	dcLauncherTimedTail,
	dcNormalizeCommand,
	dcParseWindowsRecursiveDelete,
	dcPreprocessWrappers,
	dcRelocateDestructiveTarget,
	dcSegmentVerbMatch,
	dcShellFlagClusterUncertain,
	dcSplitSegments,
	dcUnwrapWrappersBounded,
} from '../hooks/guardrails/destructive-command.js';
import {
	AUTHORITY_ROLE_CAPABILITIES,
	checkFileAuthority,
} from '../hooks/guardrails/file-authority.js';
import {
	isInDeclaredScope,
	redactShellCommand,
} from '../hooks/guardrails/helpers.js';
import {
	isEmptyDirectoryRemovalWithinWorkspace,
	isPosixRmdirExecutor,
	resolveWindowsWriteAuthority,
} from '../hooks/guardrails/tool-before.js';
import { declaresWindowsWrapperLoose } from '../hooks/shell-executor-context';
import { getObservedHostShell } from '../hooks/shell-executor-context.js';
import {
	detectPosixWrites,
	detectWindowsWrites,
	isPowerShellReadOnlyPipeline,
	isPowerShellShaped,
	mergeWriteAnalyses,
	procSubSpanBodies,
	resolveWriteTargets,
} from '../hooks/shell-write-detect.js';
import { sanitizeDiagnosticText } from '../scope/path-identity.js';
import {
	classifyCommand,
	getSharedClassifierGuardrailBlock,
} from '../security/command-classifier.js';

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

// Pattern extraction remains local, but every recursive target is decided by
// the same shared evaluator as the live hook. CLI `--scope` is hypothetical and
// never becomes verified active authority for a nested delete (#2096).

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

	const shared = classifyCommand(rawCommand);
	const sharedFiringRule = `shared_classifier: ${shared.aggregate}`;
	if (getSharedClassifierGuardrailBlock(shared)) {
		return { decision: 'block', firingRule: sharedFiringRule };
	}

	const command = dcNormalizeCommand(rawCommand);

	// #3491 W3 parity: deny-on-uncertainty launcher shapes and the paranoid
	// unwrap-depth bound mirror the live destructive arm's early denies.
	const launcherUncertainty = dcAnalyzeLauncherUncertainty(command);
	if (launcherUncertainty.deny) {
		return { decision: 'block', firingRule: launcherUncertainty.reason };
	}
	const boundedUnwrap = dcUnwrapWrappersBounded(command);
	if (boundedUnwrap.depthExceeded) {
		return {
			decision: 'block',
			firingRule:
				boundedUnwrap.shCWithdrawal === true
					? 'BLOCKED: shell chain nests 3 or more sh -c layers whose quote structure cannot be re-parsed faithfully — denying for safety (deny-on-uncertainty; #3570)'
					: 'BLOCKED: shell wrapper nesting exceeds the inspection bound — rejecting for safety',
		};
	}
	const unwrapped = boundedUnwrap.command;
	const outerSegments = dcSplitSegments(command);
	const innerSegments = dcSplitSegments(unwrapped);
	const perSegmentBounded = outerSegments.map((s) =>
		dcUnwrapWrappersBounded(s),
	);
	// #3491 W3 review (REQUIRED) parity: the per-segment depth consult — the
	// whole-command chain stops at the first non-wrapper segment, so a
	// compound depth chain must deny here exactly as the live arm denies.
	for (const bounded of perSegmentBounded) {
		if (bounded.depthExceeded) {
			return {
				decision: 'block',
				firingRule:
					bounded.shCWithdrawal === true
						? 'BLOCKED: shell chain nests 3 or more sh -c layers whose quote structure cannot be re-parsed faithfully — denying for safety (deny-on-uncertainty; #3570)'
						: 'BLOCKED: shell wrapper nesting exceeds the inspection bound — rejecting for safety',
			};
		}
	}
	const perSegmentUnwrapped = perSegmentBounded.map((b) => b.command);
	// #3491 W2 parity: the same evolving per-segment directory context the
	// live destructive arm uses — chdir-bearing wrapper segments relocate
	// their rm/rmdir/del targets from the child cwd to session-root-relative
	// forms; an unresolvable context lands on the escaping sentinel.
	// #3491 W2 fix-round-1 (F-2) parity: the context is keyed per OCCURRENCE,
	// never per segment TEXT — `env -C src rm -rf dist; env -C .. rm -rf
	// dist` yields two `rm -rf dist` occurrences with DIFFERENT child cwds;
	// a text-keyed first-wins map applied the first occurrence's context to
	// both and answered allow for the escaping second one. Each (segment,
	// context) pair is evaluated once; occurrences from the raw/legacy
	// unwrap lists carry a null context (base behavior), and every expanded
	// entry carries its own evolving context.
	const expandedSegments = dcExpandDestructiveSegments(command, cwd);
	const segmentOccurrences: Array<{
		segment: string;
		resolveFrom: string | 'uncertain' | null;
	}> = [];
	const seenOccurrences = new Set<string>();
	const pushSegmentOccurrence = (
		segment: string,
		resolveFrom: string | 'uncertain' | null,
	): void => {
		if (segment.length === 0) return;
		const key = `${resolveFrom ?? ''}\u0000${segment}`;
		if (seenOccurrences.has(key)) return;
		seenOccurrences.add(key);
		segmentOccurrences.push({ segment, resolveFrom });
	};
	for (const segment of outerSegments) pushSegmentOccurrence(segment, null);
	for (const segment of innerSegments) pushSegmentOccurrence(segment, null);
	for (const segment of perSegmentUnwrapped)
		pushSegmentOccurrence(segment, null);
	for (const entry of expandedSegments)
		pushSegmentOccurrence(entry.segment, entry.resolveFrom);
	// #3569 residual 3: process-substitution span bodies execute their own
	// command text — push each body's split segments with an uncertain
	// child-cwd context (the #3568 review F-01 shape; restores parity with
	// the gate's destructive pipeline, both `>` and `<` operators).
	for (const body of procSubSpanBodies(command)) {
		for (const sub of dcSplitSegments(body)) {
			pushSegmentOccurrence(sub, 'uncertain');
			// #3569 4.5 review Critical 2 (explain parity): unwrap launcher/
			// chdir-wrapped body verbs before the push. #3590 PRR-009: the
			// gate REFUSES on the same bodies when their unwrap exceeds the
			// bound — mirror that refusal so explain cannot content-evaluate
			// a span body the gate rejects (wsl/cmd wrapper families).
			const unwrappedBody = dcUnwrapWrappersBounded(sub);
			if (unwrappedBody.depthExceeded) {
				return {
					decision: 'block',
					firingRule:
						unwrappedBody.shCWithdrawal === true
							? 'destructive_block: BLOCKED: shell chain nests 3 or more sh -c layers whose quote structure cannot be re-parsed faithfully — denying for safety (deny-on-uncertainty; #3570)'
							: 'destructive_block: BLOCKED: shell wrapper nesting exceeds the inspection bound — rejecting for safety',
				};
			}
			if (unwrappedBody.command !== sub) {
				pushSegmentOccurrence(unwrappedBody.command, 'uncertain');
			}
		}
		for (const entry of dcExpandDestructiveSegments(body, cwd)) {
			pushSegmentOccurrence(entry.segment, 'uncertain');
		}
	}
	// #3572 N-02 parity: the GNU `time -o FILE` timed tail is judged with the
	// SEGMENT's own directory context exactly like the live gate's push (time
	// runs its command in the current shell — no cwd ambiguity), so explain
	// cannot answer allow for a command the gate blocks.
	for (const segment of outerSegments) {
		const tail = dcLauncherTimedTail(segment);
		if (tail !== null) {
			for (const sub of dcSplitSegments(tail)) {
				pushSegmentOccurrence(sub, null);
			}
		}
	}
	const relocate = (
		resolveFrom: string | 'uncertain' | null,
		targets: string[],
	): string[] =>
		resolveFrom === null
			? targets
			: targets.map((t) => dcRelocateDestructiveTarget(t, resolveFrom, cwd));

	for (const occurrence of segmentOccurrences) {
		const seg = occurrence.segment.trim();
		if (!seg) continue;

		// Junction/symlink creation with out-of-cwd target
		const junctionBlock = dcCheckJunctionCreation(seg, cwd);
		if (junctionBlock) {
			return {
				decision: 'block',
				firingRule: 'destructive_block: junction creation',
			};
		}

		// POSIX rm — use the exact live parser so explain cannot disagree with
		// enforcement on stacked flags, long options, quoting, or multi-targets.
		const targets = dcExtractRecursiveRmTargets(seg);
		if (targets) {
			const targetDecision = dcEvaluateRecursiveDeleteTargets({
				targets: relocate(occurrence.resolveFrom, targets),
				cwd,
			});
			if (!targetDecision.allowed) {
				return {
					decision: 'block',
					firingRule: `${targetDecision.code}: ${targetDecision.reason}`,
				};
			}
		}

		// Windows cmd.exe: rmdir/rd — the SAME grammar-modeled parse as the
		// enforcement gate (cmd scans each unquoted argument for the first
		// `/`; issue #3495, PR #3499 review round).
		const explainRmdirVerb = /^(?:[({\s])*(?:rmdir|rd)(?:\.exe)?\s*/i.exec(seg);
		if (explainRmdirVerb) {
			const parsed = dcParseWindowsRecursiveDelete(
				seg.slice(explainRmdirVerb[0].length),
			);
			if (parsed.fires) {
				if (parsed.targets.length === 0) {
					return {
						decision: 'block',
						firingRule:
							'destructive_block: Windows recursive directory delete (rmdir /s)',
					};
				}
				const targetDecision = dcEvaluateRecursiveDeleteTargets({
					targets: relocate(occurrence.resolveFrom, parsed.targets),
					cwd,
				});
				if (!targetDecision.allowed) {
					return {
						decision: 'block',
						firingRule: `${targetDecision.code}: ${targetDecision.reason}`,
					};
				}
			}
		}

		// Windows cmd.exe: del — the same grammar-modeled parse as the gate.
		const explainDelVerb = /^(?:[({\s])*del(?:\.exe)?\s*/i.exec(seg);
		if (explainDelVerb) {
			const parsed = dcParseWindowsRecursiveDelete(
				seg.slice(explainDelVerb[0].length),
			);
			if (parsed.fires) {
				if (parsed.targets.length === 0) {
					return {
						decision: 'block',
						firingRule:
							'destructive_block: Windows recursive file delete (del /s)',
					};
				}
				const targetDecision = dcEvaluateRecursiveDeleteTargets({
					targets: relocate(occurrence.resolveFrom, parsed.targets),
					cwd,
				});
				if (!targetDecision.allowed) {
					return {
						decision: 'block',
						firingRule: `${targetDecision.code}: ${targetDecision.reason}`,
					};
				}
			}
		}

		// PowerShell: Remove-Item / aliases with -Recurse — whitespace-delimited
		// switch tokens, mirroring the gate (a `-r` substring inside a path
		// operand like `rm some-r/x` is a plain delete; issue #3495 class).
		// #3572 review N-27 parity: the verb word matches through
		// dcSegmentVerbMatch exactly like the gate's arm — the W6 path-qualified
		// normalization (`/bin/RM -R /outside/x`, `"ri" -Recurse …`) fired in
		// the gate while this anchored regex missed it and explain answered
		// allow for a command the gate blocks.
		const explainPsVerb = dcSegmentVerbMatch(seg, [
			'remove-item',
			'ri',
			'rm',
			'rmdir',
			'del',
			'erase',
			'rd',
		]);
		if (
			explainPsVerb &&
			(/\s-[Rr]ecurse\b/i.test(explainPsVerb.rest) ||
				/\s-[Rr]\b/i.test(explainPsVerb.rest))
		) {
			const targets = dcExtractPowerShellTargets(seg);
			if (targets.length > 0) {
				const targetDecision = dcEvaluateRecursiveDeleteTargets({
					targets: relocate(occurrence.resolveFrom, targets),
					cwd,
				});
				if (!targetDecision.allowed) {
					return {
						decision: 'block',
						firingRule: `${targetDecision.code}: ${targetDecision.reason}`,
					};
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

		if (/^git\s+worktree\s+remove\s+.*--force\b/i.test(seg)) {
			const worktreeRemoveMatch = /^git\s+worktree\s+remove\s+(.+)$/i.exec(seg);
			if (worktreeRemoveMatch) {
				const normalizedArgs = worktreeRemoveMatch[1]
					.trim()
					.split(/\s+/)
					.filter(Boolean)
					.map((token) => token.replace(/^["']|["']$/g, ''));
				const pathArgs = normalizedArgs.filter(
					(token) => !token.startsWith('-'),
				);
				const target = pathArgs.length === 1 ? pathArgs[0]?.trim() : null;
				const scopeExempt =
					target != null &&
					target.length > 0 &&
					declaredScope != null &&
					declaredScope.length > 0 &&
					isInDeclaredScope(target, declaredScope, cwd);
				if (!scopeExempt) {
					return {
						decision: 'block',
						firingRule: 'destructive_block: git worktree remove --force',
					};
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
				return {
					decision: 'block',
					firingRule: `destructive_block: rsync --delete (target: ${redactPath(rsyncTarget ?? 'unknown')})`,
				};
			}
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
	// #3099: routed through the SAME authority ladder + union the gate uses
	// (resolveWindowsWriteAuthority + mergeWriteAnalyses), so explain cannot
	// answer "allow" for a command the gate blocks. Explain has no tool
	// context, so it evaluates the command as the `shell` tool — the surface
	// this preview has always modeled.
	// Mirror the gate's unwrap preprocessing (tool-before.ts write-detection
	// path): segment the command, unwrap wrapper segments, rejoin with '\n'
	// when any segment changed, and run write detection on that normalized
	// form. A `;`-joined wrapper write (`echo done; cmd /c copy a.md
	// OUTSIDE.md`) is invisible to the whole-string detectors — the gate sees
	// it only through this normalization — so explain must share it or answer
	// allow where the gate blocks (round-6 review finding). Authority and the
	// wrapper flag below stay computed from the raw command, exactly like the
	// gate; detection and target resolution use the same normalized string,
	// because resolveWriteTargets re-parses it for cwd tracking.
	// #3491 W2 parity: explain shares the gate's chdir-wrapper preprocessing —
	// chdir-bearing wrapper segments (env -C / env -S / sudo -D) rewrite as
	// correctly-quoted subshells so the wrapped writes resolve under the child
	// cwd. A fail-closed DIR (empty/NUL static operand) blocks here exactly
	// like the gate's parse-error rejection.
	const preprocessed = dcPreprocessWrappers(shellCommand);
	if (preprocessed.failClosed) {
		decision = 'block';
		firingRule =
			'parse_error: write detection failed to parse command — rejecting for safety';
	}
	// #3567 final-critic round: mirror the gate's shell flag-cluster
	// deny-on-uncertainty channel (tool-before.ts) — without it explain
	// answered allow for `bash -oc pipefail 'rm -rf …'` shapes the gate
	// blocks.
	const uncertainCluster = dcShellFlagClusterUncertain(shellCommand);
	if (uncertainCluster !== null) {
		decision = 'block';
		firingRule = `inline_eval: shell interpreter invocation "${uncertainCluster}" carries a flag cluster the guard cannot statically model (unknown option or glued argument) — deny-on-uncertainty`;
	}
	const didUnwrap = preprocessed.changed;
	const detectionCommand = didUnwrap ? preprocessed.command : shellCommand;

	if (decision === 'allow') {
		const detected = resolveShellType(shellCommand) as
			| 'posix'
			| 'powershell'
			| 'cmd'
			| 'unix'
			| 'bash';
		const authority = resolveWindowsWriteAuthority(
			'shell',
			shellCommand,
			detected,
			isPowerShellShaped(shellCommand),
			// #3346 gate parity: explain evaluates as the `shell` tool, so it
			// keys grammar inheritance on the same observed host shell the
			// gate consumes (never wider than the platform interim when no
			// host report exists).
			process.platform,
			getObservedHostShell(),
		);
		// Mirrors the gate's wrapper-priority flag (round-5 blocker: omitting it
		// made explain keep the POSIX reading for explicit cmd/powershell -Command
		// wrappers while the gate kept the Windows one — explain answered allow
		// for commands the gate blocked). Input contract (round 6): every
		// production path into this service tokenizes arguments with
		// `argumentText.trim().split(/\s+/)` (src/commands/command-dispatch.ts),
		// which destroys literal newlines before the command string is joined,
		// so the gate's newline command boundary cannot fire here — callers
		// re-express multi-line commands with `;`/`&&`/`|` separators, which
		// drive the same wrapper match and the same verdict. The declaration
		// predicate is the shared one from shell-executor-context.ts — the
		// same object the gate uses, so parity is structural rather than
		// conventional; pinned by the wrapper parity rows in
		// guardrail-explain-service-accuracy.test.ts.
		const wrapperDeclaredHere = declaresWindowsWrapperLoose(shellCommand);
		const posix = detectPosixWrites(detectionCommand);
		let analysis =
			authority === null
				? posix
				: mergeWriteAnalyses(
						posix,
						detectWindowsWrites(detectionCommand, authority),
						true,
						wrapperDeclaredHere,
					);
		// #3567 review P-R2: mirror the gate's union-back (tool-before.ts):
		// the rewritten command can LOSE writes the original analysis saw, so
		// every non-eval-artifact original write unions back into the explain
		// analysis — without it explain answered allow for
		// `env -C src echo hi > /tmp/x` (hoist-less shapes) where the gate
		// unions the redirect back and denies.
		if (didUnwrap) {
			const primaryAnalysis = detectPosixWrites(shellCommand);
			const regained = primaryAnalysis.writes.filter(
				(w) =>
					!(
						w.category === 'interpreter_eval' &&
						w.path === null &&
						!w.operator.endsWith('[eval stdin]')
					),
			);
			if (regained.length > 0) {
				analysis = {
					...analysis,
					writes: [...analysis.writes, ...regained],
					hasWrites: analysis.hasWrites || regained.length > 0,
				};
			}
		}

		// The gate runs its fail-closed parse gate on the ORIGINAL command as
		// well as the unwrapped form (tool-before.ts): a wrapper must not
		// launder a malformed payload — `cmd /c "echo hi` (unclosed quote)
		// must block even though the unwrapped `echo hi` parses cleanly.
		// Mirror both parse gates, raw first (round-7 review finding).
		const rawPosix = detectPosixWrites(shellCommand);
		const rawAnalysis =
			authority === null
				? rawPosix
				: mergeWriteAnalyses(
						rawPosix,
						detectWindowsWrites(shellCommand, authority),
						true,
						wrapperDeclaredHere,
					);
		const rawParseFailure =
			rawAnalysis.parseError && !isPowerShellReadOnlyPipeline(shellCommand);

		if (rawParseFailure) {
			decision = 'block';
			firingRule =
				'parse_error: write detection failed to parse command — rejecting for safety';
		} else if (
			analysis.parseError &&
			!isPowerShellReadOnlyPipeline(detectionCommand)
		) {
			decision = 'block';
			firingRule =
				'parse_error: write detection failed to parse command — rejecting for safety';
		} else if (
			analysis.unwrapDepthExceeded ||
			rawPosix.unwrapDepthExceeded ||
			rawAnalysis.unwrapDepthExceeded
		) {
			// #3491 W3 (v4 constraint 8) parity: consulted BEFORE the no-write
			// early return — depth abuse denies in explain exactly as in the
			// gate. #3491 W3 review (REQUIRED): the RAW analyses' depth
			// refusal (original command text) must survive the preprocessing
			// substitution — a compound depth chain launders the detection
			// command's flag exactly as it laundered the gate's.
			decision = 'block';
			firingRule =
				'unwrap_depth: shell wrapper nesting exceeds the inspection bound — rejecting for safety';
		} else if (dcAnalyzeLauncherUncertainty(shellCommand).deny) {
			// #3491 W3 parity: deny-on-uncertainty launcher shapes.
			decision = 'block';
			firingRule =
				'launcher_uncertainty: unrecognized launcher option with a potential execution tail';
		} else {
			// #3569 4.5 r4 (reviewer Important): the gate compensates for the
			// preprocessor serializing brace words QUOTED (the preprocessed
			// text loses the expansion) by unioning the RAW analysis's writes
			// back (PRR-006 filter). Explain must union too or it renders
			// allow for wrapper+brace shapes the gate denies.
			if (didUnwrap && !rawAnalysis.parseError) {
				const regained = rawAnalysis.writes.filter(
					(w) =>
						!(
							w.category === 'interpreter_eval' &&
							w.path === null &&
							!w.operator.endsWith('[eval stdin]')
						),
				);
				if (regained.length > 0) {
					analysis = {
						...analysis,
						writes: [...analysis.writes, ...regained],
						hasWrites: true,
					};
				}
			}
		}
		if (decision === 'allow' && analysis.hasWrites) {
			const resolvedWrites = resolveWriteTargets(
				// #3539 W5 parity: the gate resolves against the procsub
				// masking residual when the analysis carries one; explain
				// must share the same resolution text or it answers allow
				// for outer writes the gate blocks under tracked cd context.
				analysis.residualCommand ?? detectionCommand,
				analysis.writes,
				directory,
			);

			for (const write of resolvedWrites) {
				if (write.resolvedPath) {
					// Architect is exempt from scope checks
					if (agent !== 'architect') {
						// Mirrors the live gate for the `shell` tool: a bare POSIX
						// rmdir inside the workspace needs no declared-scope
						// membership (ENOTEMPTY-safe); Windows executors and
						// control state (.git/.swarm) never qualify. Explain has no
						// tool or platform flag, so it always evaluates as the
						// `shell` tool: on a Windows host that is not a POSIX
						// executor, so explain conservatively reports `block` for a
						// bare rmdir the live `bash` tool admits (fail-closed).
						const inScope =
							isInDeclaredScope(write.resolvedPath, scopeEntries, directory) ||
							(write.original.emptyDirectoryRemoval === true &&
								isPosixRmdirExecutor('shell', authority, detectionCommand) &&
								isEmptyDirectoryRemovalWithinWorkspace(
									write.resolvedPath,
									directory,
								));
						if (!inScope) {
							decision = 'block';
							firingRule = `scope_violation: write outside declared scope: ${redactPath(write.resolvedPath)}`;
							break;
						}
					}
					writeCategories.add(write.original.category);
				} else {
					// #3491 fix-round-1 (F-3) parity: mirror the gate's
					// null-path decision tree instead of treating the write as
					// a category only — explain used to answer allow for
					// inputs the gate blocks on EVERY withdrawal class
					// (`cd -; echo x > f`, uncertain env -C DIR, `popd; …`).
					// The gate skips exactly one null-path shape: the bare
					// here-doc marker (`<< EOF` feeds stdin, not a file).
					if (
						write.original.category === 'here_doc' &&
						write.original.path === null
					) {
						writeCategories.add(write.original.category);
						continue;
					}
					if (write.original.category === 'interpreter_eval') {
						// The gate's #3347/#1902 scope-gated routing for the
						// inspectable capability class: agents WITH a declared
						// scope authorize the eval's (cd-tracked) working
						// directory as the target. A WITHDRAWN eval
						// (#3491 W1 `unresolved`) never routes — the walk could
						// not stand behind any working directory.
						// #3567 review PRR-010 (revision): mirror the gate's
						// routing gate (tool-before.ts) — a routed eval needs a
						// REAL declared scope (the defaulted `scopeEntries`
						// cannot fabricate one) or an immutable non-writer role.
						// The bare `scopeEntries.length > 0` let an architect
						// explain-ALLOW an eval the gate blocks.
						const hasRealDeclaredScope = scope != null && scope.length > 0;
						const roleCapability =
							AUTHORITY_ROLE_CAPABILITIES[
								agent as keyof typeof AUTHORITY_ROLE_CAPABILITIES
							];
						const isImmutableNonWriter =
							roleCapability === 'read-only' ||
							roleCapability === 'dedicated-tool-only';
						if (
							write.original.capability === true &&
							write.unresolved !== true &&
							(isImmutableNonWriter || hasRealDeclaredScope)
						) {
							const evalTarget = write.evalDirectory ?? directory;
							// #3567 review PRR-010: mirror the gate's FULL
							// decision tail (universal-deny prefixes and the
							// file-authority layer) before the declared-scope
							// check — the bare scope-only branch let architect
							// identities explain-ALLOW evaluations the gate
							// blocks (scopeEntries is never empty here).
							const authorityDecision = checkFileAuthority(
								agent,
								path.resolve(directory, evalTarget),
								directory,
								undefined,
								{ declaredScope: scope != null ? [scope] : null },
							);
							if (authorityDecision.allowed !== true) {
								decision = 'block';
								firingRule = `file_authority: ${authorityDecision.reason ?? 'path not authorized'}`;
								break;
							}
							if (!isInDeclaredScope(evalTarget, scopeEntries, directory)) {
								decision = 'block';
								firingRule = `scope_violation: write outside declared scope: ${redactPath(evalTarget)}`;
								break;
							}
							writeCategories.add(write.original.category);
							continue;
						}
						decision = 'block';
						firingRule = `inline_eval: ${write.original.operator} evaluates inline code whose write targets cannot be verified against the declared scope — rejecting for safety`;
						break;
					}
					// Every other null-path write (a withdrawn/dynamic redirect
					// or builtin target, a patch_apply that produced no
					// targets) fails closed exactly like the gate's
					// dynamic-path-target rejection. #3491 W8 final-critic
					// advisory: a brace-refused write renders the user's
					// SOURCE word, matching the gate's message.
					decision = 'block';
					// #3568 review F-10: sanitize + bound the untrusted source
					// word (parity with the gate's render).
					const explainDynamicLabel = sanitizeDiagnosticText(
						write.original.path ?? write.original.dynamicSourceWord ?? '',
						160,
					);
					// UNION of the g1 fix (PRR-015 redact) and the g2 label
					// selection (dynamicSourceWord fallback): redact whichever
					// word renders.
					firingRule = `dynamic_target: write target${explainDynamicLabel ? ` "${redactPath(explainDynamicLabel)}"` : ''} cannot be statically resolved (dynamic path or withdrawn directory state) — rejecting for safety`;
					break;
				}
			}
		}
	} else {
		// Already blocked; still collect write categories for reporting. Same
		// #3099 authority routing as the allow branch — no stale second path.
		const detected = resolveShellType(shellCommand) as
			| 'posix'
			| 'powershell'
			| 'cmd'
			| 'unix'
			| 'bash';
		const authority = resolveWindowsWriteAuthority(
			'shell',
			shellCommand,
			detected,
			isPowerShellShaped(shellCommand),
			// #3346 gate parity (see the allow branch).
			process.platform,
			getObservedHostShell(),
		);
		// Same wrapper-priority flag as the allow branch; recomputed because
		// the gate's detect() closure recomputes it on its blocked path too.
		const wrapperDeclaredElse = declaresWindowsWrapperLoose(shellCommand);
		const posix = detectPosixWrites(detectionCommand);
		const analysis =
			authority === null
				? posix
				: mergeWriteAnalyses(
						posix,
						detectWindowsWrites(detectionCommand, authority),
						true,
						wrapperDeclaredElse,
					);

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
