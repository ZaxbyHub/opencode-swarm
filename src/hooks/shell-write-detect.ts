/**
 * Shell Write Detector — POSIX AST + Windows regex-based write-operation detection
 *
 * Parses POSIX shell commands using bash-parser and statically detects
 * file-system write operations using regex heuristics for Windows shells.
 * Used by guardrails and scope-validation hooks to catch opaque shell
 * commands that would bypass direct tool coverage.
 *
 * DOCUMENTED BOUNDARY (#3120, issue-sanctioned "accept and document"):
 * script-runner commands — `npm run <script>`, `bun run <script>`,
 * `pnpm|yarn run <script>`, `node <file>` — are not treated as write vectors.
 * Their write targets are not statically knowable (a script body
 * can do anything), and blanket-blocking them would break every legitimate
 * build invocation (the deliberate `node <script>` non-flag pin in
 * shell-write-detect.test.ts and the safe-classifier listing of
 * `npm run` reflect the same decision). What protects owner policy instead:
 * the verifier-config file class (`.secretscanignore` et al.) is denied for
 * EVERY agent role and independent of `guardrails.enabled` (#3120 legs 1-2),
 * and the secretscan Stage-A gate's own accounting is fail-closed (#3107).
 * Patch-application (`git apply` / `patch`) and directory-copy destinations
 * (`rsync`) ARE detected — see detectPatchApply / detectRsyncWrites.
 *
 * @module shell-write-detect
 */

import { readFileSync, statSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
	BashCommand,
	BashCompoundList,
	BashHereDocMarker,
	BashNode,
	BashOperator,
	BashRedirect,
	BashSubshell,
	BashWord,
} from 'bash-parser';
import parse from 'bash-parser';
import { unsafePathTextReason } from '../scope/path-identity';
import { dcParseWindowsRecursiveDelete } from './guardrails/cmd-delete-grammar';
import {
	CMD_BUILTIN_PREFIX,
	CMD_STRIP_PREFIX,
	PS_STRIP_PREFIX,
} from './shell-executor-context';

/**
 * Validate command text without treating shell line separators as path data.
 * Newlines (and the carriage returns paired with them) are valid command
 * syntax, notably in here-documents. Other control and bidi characters remain
 * fail-closed through the shared path-text validator.
 */
function unsafeShellCommandTextReason(value: string): string | null {
	return unsafePathTextReason(value.replace(/[\r\n]/g, ''));
}

/**
 * All write-operation categories detected by this module.
 */
export type WriteCategory =
	| 'redirect'
	| 'here_doc'
	| 'builtin_write'
	| 'inplace_edit'
	| 'interpreter_eval'
	| 'network_download'
	| 'archive_extract'
	| 'git_destructive'
	| 'patch_apply'
	| 'launcher_write';

/**
 * A single write target detected in a shell command.
 */
export interface WriteTarget {
	/** The category of write operation. */
	category: WriteCategory;
	/** The tool or operator that triggered this write, e.g. "cp", ">", "sed -i". */
	operator: string;
	/** The file path written to, or null when the path cannot be determined statically. */
	path: string | null;
	/**
	 * Present ONLY on inspectable POSIX inline-code interpreter evals
	 * (`python -c`, `node -e`, `bash -c`, `eval`, … — the detectInterpreterEval
	 * sites). Marks a capability write whose target the gate routes through
	 * declared scope / file authority at the eval's working directory
	 * (#1902/#3347). The opaque interpreter_eval classes (PowerShell
	 * -EncodedCommand, nested script blocks, dynamic `&`/IEX invocation,
	 * unsafe-text parse failures) deliberately do NOT set it and keep the
	 * blanket block.
	 */
	capability?: true;
	/**
	 * Set only for a bare POSIX `rmdir <dir>`: no options, exactly one literal
	 * operand (no expansion, glob, brace or quote characters). rmdir(2) refuses
	 * a non-empty directory (ENOTEMPTY), so this form cannot destroy file data.
	 * The shell write-scope gate uses it to skip declared-scope membership for
	 * a target that resolves inside the workspace; every other check still
	 * applies. `rmdir -p` (removes parents) and all other forms never carry it,
	 * and neither does any write of a line that runs a command outside
	 * CWD_NEUTRAL_COMMANDS or holds a character outside PLAIN_COMMAND_LINE
	 * (see detectPosixWrites).
	 */
	emptyDirectoryRemoval?: true;
	/**
	 * Present ONLY on string-fallback writes whose operand or context cannot be
	 * resolved safely (#3518): a process-substitution write emitted by the
	 * parse-failure fallback when the same line carries a `cd` (its resolution
	 * cwd is unknowable without an AST), or a fallback operand whose quoting is
	 * ambiguous (fragmented/unbalanced quotes — the whitespace tokenizer cannot
	 * recover the real operand). The resolver withdraws such writes to
	 * `{ resolvedPath: null, resolved: false }` on every return path so the
	 * live gate denies them (fail-closed), instead of resolving at the starting
	 * cwd or at a quote-fragment path.
	 */
	unresolvedContext?: true;
	/**
	 * #3491 W8 (final-critic advisory): the user's SOURCE word for a
	 * brace-refused dynamic write — a write whose `{…}` destination is a
	 * real expansion this model refuses to enumerate (nested, over-cap,
	 * empty alternative, alpha/signed/zero-padded/stepped sequence, or any
	 * branch carrying a `$`/command-substitution expansion). The write
	 * itself carries `path: null` (the gate's dynamic-target block denies
	 * it); this field lets that denial message render what the user
	 * actually typed (`src/{a..e}`) instead of a brace-substituted branch
	 * text the shell never received verbatim. Never set on any other write.
	 */
	dynamicSourceWord?: string;
	/**
	 * Present ONLY on `patch_apply` writes (#3120 LEG 3b): the literal
	 * patch-file operands of a `git apply <patch>` / `patch [-pN] <patch>`
	 * invocation, resolved by the gate against the write's tracked working
	 * directory (the targets named INSIDE the patch are extracted at
	 * authorization time — see tool-before's patch_apply branch). Empty for
	 * stdin patches and for invocations carrying options outside the closed
	 * supported set (both fail closed at the gate).
	 */
	patchSources?: string[];
	/**
	 * The `-p<n>` strip level the patch targets are extracted with (#3120):
	 * `git apply` defaults to 1; explicit `-p<n>` overrides for both tools.
	 */
	patchStrip?: number;
}

/**
 * Result of analyzing a single shell command.
 */
export interface WriteAnalysis {
	/** All write targets detected in the command (empty if none). */
	writes: WriteTarget[];
	/** Whether the command contains any detected writes. */
	hasWrites: boolean;
	/** Whether the command could not be parsed (fail-closed). */
	parseError?: boolean;
	/**
	 * #3539 W5: present ONLY when the command's process-substitution spans
	 * were masked and the RESIDUAL (the command with every unquoted
	 * `>(…)`/`<(…)` span replaced by a token-preserving placeholder) parsed
	 * clean. It is the text the resolver must re-parse for cwd tracking: the
	 * surviving OUTER writes resolve under the tracked directory context of
	 * the residual, while the masked INNER writes are withdrawn
	 * (`unresolvedContext`) whenever their body or outer prefix carries a
	 * directory change. Absent for every parse that did not go through the
	 * masking path (including the legacy no-mask fallback).
	 */
	residualCommand?: string;
	/**
	 * #3491 W3: true when any leaf command's wrapper-chain walk exceeded the
	 * paranoid absolute bound (DETECTOR_UNWRAP_PARANOID_BOUND, 64) — a
	 * machine-generated depth chain the model refuses to inspect. The gate
	 * and the explain mirror consult this BEFORE every no-write early return
	 * and fail closed on it.
	 */
	unwrapDepthExceeded?: boolean;
}

/**
 * A write target with its resolved absolute path.
 */
export interface ResolvedWriteTarget {
	/** The original write target. */
	original: WriteTarget;
	/**
	 * The resolved absolute path, or null if the path could not be determined
	 * (null original path) or was marked unresolvable (dynamic path).
	 */
	resolvedPath: string | null;
	/**
	 * Whether the path was successfully resolved to an absolute path.
	 * false when: path is null, path contains env vars ($VAR), or path
	 * contains command substitution ($(cmd) or `cmd`).
	 */
	resolved: boolean;
	/**
	 * For capability interpreter-eval writes only: the working directory the
	 * eval runs at, tracked through subshell `cd` commands (the starting cwd
	 * when none precedes it). The gate authorizes the eval against this
	 * directory (#1902/#3347); absent for every other write kind.
	 */
	evalDirectory?: string;
	/**
	 * For `patch_apply` writes only: the working directory the patch
	 * invocation runs at, tracked through subshell `cd` commands (the
	 * starting cwd when none precedes it). The gate resolves the literal
	 * patch-file operands against this directory before extracting the
	 * targets named inside each patch (#3120). Absent for every other write
	 * kind.
	 */
	writeContext?: string;
	/**
	 * #3491 W1: present when the write was WITHDRAWN by the directory-state
	 * walk (an unresolvable cd/pushd/popd word form, a dynamic cd operand, or
	 * control-flow divergence over the complete state). Distinct from an
	 * ordinary null-path eval: a withdrawn write must be denied outright, and
	 * a withdrawn capability eval must NOT route through its tracked working
	 * directory — there is none the model can stand behind.
	 */
	unresolved?: true;
}

/**
 * Issue #3099 R2 (executor context): merge a POSIX analysis with a Windows
 * analysis under a declared AUTHORITY for shared constructs.
 *
 * Both grammars may report the same syntactic construct (e.g. a `>` redirect)
 * with different path readings, because POSIX treats `\` as an escape: the
 * same command yields `src\out.txt` under the Windows reading and `srcout`
 * under POSIX. Only one of those describes what the real executor writes, and
 * the guard cannot observe the executor — so the reading of the AUTHORITY
 * grammar (the one matching the declared executor context: an explicit
 * `cmd /c` / `powershell -Command` wrapper, or a PowerShell-shaped body that
 * POSIX cannot execute at all) is kept, and the supplementary grammar
 * contributes ONLY constructs the authority does not report at all (e.g. a
 * POSIX `cp` inside a PowerShell pipeline). Lexical resemblance alone never
 * discards a reading.
 *
 * `parseError` is carried from the POSIX analysis unchanged: it is the
 * fail-closed backstop, and recomputing it over merged writes would let a
 * malformed command that also writes escape it.
 */
export function mergeWriteAnalyses(
	primary: WriteAnalysis,
	additional: WriteAnalysis,
	additionalIsAuthoritative = true,
	wrapperDeclared = false,
): WriteAnalysis {
	if (
		additional.writes.length === 0 &&
		!additional.hasWrites &&
		!additional.unwrapDepthExceeded
	) {
		return primary;
	}
	// #3099 round-4 Critical 2: when BOTH grammars claim the same construct
	// and the POSIX parse SUCCEEDED (no parse error), the POSIX reading is the
	// one the bash/git-bash executor actually performs (`> src\OUT.txt` writes
	// srcOUT.txt). The authority reading wins shared constructs only when the
	// primary grammar could not read the command (wrapper-quoted cmd/pwsh).
	const posixAuthoritative = wrapperDeclared
		? false
		: !additionalIsAuthoritative || !primary.parseError;
	const authority = posixAuthoritative ? primary : additional;
	const supplementary = posixAuthoritative ? additional : primary;
	// #3145 PRR-003: when NO wrapper declares the executor, the two grammars
	// can report the same construct (a redirect) with DIFFERENT resolved
	// paths — `echo y > src/..\..\OUT2.md` reads in-scope under POSIX
	// backslash-unescaping but out-of-scope under the Windows grammar the
	// shell executor actually runs. Dropping by construct silently discarded
	// the out-of-scope reading and admitted the escape, so the supplementary
	// drop is per DEDUPE KEY: true duplicates collapse, path-disagreements
	// keep BOTH readings and the scope check fails closed on whichever
	// resolves outside. With a DECLARED wrapper the executor is known, so
	// the authority reading alone governs shared constructs — the POSIX leg
	// of an unwrapped cmd/powershell payload is an unescape artifact
	// (`src\out.txt` reads as `srcout.txt`) that must not out-vote it (this
	// is what keeps the frozen C4 in-scope case admitting).
	// Quote-artifact refinement (#3145 CI round): one grammar's
	// single-quote handling can emit the SAME target twice — the clean path
	// plus a literal-quoted variant (`Get-Process>'a.md'` → `a.md` and
	// `'a.md'`). A quoted variant that strips back to an authority path is
	// an artifact of that grammar's quoting, not a genuine disagreement, so
	// it collapses; genuinely different targets never match after stripping
	// and both survive.
	const authorityConstructs = new Set(
		authority.writes.map((write) => `${write.category}|${write.operator}`),
	);
	const authorityKeys = new Set(
		authority.writes.map((write) =>
			buildDedupeKey(write.category, write.operator, write.path),
		),
	);
	const stripQuotes = (p: string | null | undefined) =>
		p === null || p === undefined
			? p
			: p.replace(/^['"]+/, '').replace(/['"]+$/, '');
	const isQuoteArtifact = (write: WriteTarget): boolean => {
		const stripped = stripQuotes(write.path);
		if (stripped === write.path) return false;
		return authority.writes.some(
			(other) =>
				other.category === write.category &&
				other.operator === write.operator &&
				stripQuotes(other.path) === stripped,
		);
	};
	// A key collision that involves an emptyDirectoryRemoval write demotes the
	// kept write (issue #3450 / PR #3456 review F-2): the two readings may be
	// different targets or operations, so neither keeps the bare-rmdir
	// exemption.
	const keptIndex = new Map<string, number>();
	const writes: WriteTarget[] = [];
	const demoteKept = (key: string): void => {
		const index = keptIndex.get(key);
		if (index !== undefined) {
			writes[index] = withoutEmptyDirectoryRemoval(writes[index]);
		}
	};
	for (const write of [...authority.writes, ...supplementary.writes]) {
		const key = buildDedupeKey(write.category, write.operator, write.path);
		if (supplementary.writes.includes(write)) {
			if (wrapperDeclared) {
				const construct = `${write.category}|${write.operator}`;
				// #3572 review (delta, N-07 correction): a null-path or
				// DYNAMIC-BEARING supplementary write is a fail-closed refusal
				// carrier, not an unescape artifact — dropping it under a
				// declared wrapper admitted `cmd /k echo hi ; echo y >
				// src/$(echo ../../esc)` (the `;` statement runs under bash)
				// while the plain twin denied. Path-bearing static duplicates
				// still collapse to the authority reading.
				if (
					authorityConstructs.has(construct) &&
					write.path !== null &&
					!isDynamicPath(write.path)
				) {
					continue;
				}
			} else {
				if (authorityKeys.has(key)) {
					demoteKept(key);
					continue;
				}
				if (isQuoteArtifact(write)) continue;
			}
		}
		if (keptIndex.has(key)) {
			demoteKept(key);
			continue;
		}
		keptIndex.set(key, writes.length);
		writes.push(write);
	}
	return {
		writes,
		hasWrites: writes.length > 0 || primary.hasWrites || additional.hasWrites,
		parseError: primary.parseError,
		// #3539 W5: the residual channel is additive and POSIX-only (the
		// Windows detectors never mask), so the primary's residual — when
		// present — is the one the gate/explain resolver must use.
		residualCommand: primary.residualCommand,
		// #3491 W3: the depth-exceeded flag is fail-closed on EITHER side —
		// a Windows-only reading of a depth-abuse chain must not launder the
		// POSIX side's refusal to inspect.
		unwrapDepthExceeded:
			primary.unwrapDepthExceeded || additional.unwrapDepthExceeded,
	};
}

export function buildDedupeKey(
	category: string,
	operator: string,
	path: string | null | undefined,
): string {
	return `${category}|${operator}|${path ?? 'null'}`;
}

/**
 * A copy of `write` without the empty-directory-removal tag. Copies rather
 * than mutating: the writes passed to merge/resolve belong to the caller.
 */
function withoutEmptyDirectoryRemoval(write: WriteTarget): WriteTarget {
	if (write.emptyDirectoryRemoval !== true) return write;
	const { emptyDirectoryRemoval: _dropped, ...rest } = write;
	return rest;
}

// ---------------------------------------------------------------------------
// Operator token → category mapping
// ---------------------------------------------------------------------------

/** Tokens that represent output-file redirections (write / clobber / append / read-write). */
const REDIRECT_WRITE_TOKENS = new Set([
	'GREAT',
	'DGREAT',
	'CLOBBER',
	'LESSGREAT',
]);

/** Tokens that represent here-document / here-string redirections. */
const REDIRECT_HERE_TOKENS = new Set(['DLESS', 'DLESSDASH']);

/** `>&word` redirects an output descriptor; a numeric word copies a descriptor. */
const REDIRECT_GREATAND_TOKENS = new Set(['GREATAND']);

/** All write-effect redirections. */
const REDIRECT_ALL_WRITE_TOKENS = new Set([
	...REDIRECT_WRITE_TOKENS,
	...REDIRECT_HERE_TOKENS,
	...REDIRECT_GREATAND_TOKENS,
]);

// ---------------------------------------------------------------------------
// Builtin write-effect commands
// ---------------------------------------------------------------------------

/** Builtins that copy / move / link / resize files. */
const BUILTIN_WRITE_COMMANDS = new Set([
	'cp',
	'mv',
	'install',
	'ln',
	'truncate',
	'unlink',
	'rmdir',
	// #3591 Fix 6a: `rm` joins through its own dedicated arm in
	// detectBuiltinWrites (scope containment modeled on unlink/rmdir —
	// every operand of a NON-destructive rm is a scope-checked write
	// target; recursive/forced shapes emit nothing here and stay owned by
	// the destructive arm, which the gate runs first).
	'rm',
	// #3568 parallel-review F-01: touch CREATES each named file (or updates
	// its mtime) — every operand is a filesystem write and was previously
	// invisible to both walks (`touch ../../esc` admitted at base too; the
	// procsub-body form inherited the same hole).
	'touch',
]);

/**
 * A literal `rmdir` operand eligible for the empty-directory-removal tag: not
 * an option, and free of glob, brace, expansion, quote, escape, comment and
 * whitespace characters, so the text is exactly the single path the command
 * receives. A LEADING `=` is excluded (#3475 AC12 decision, comment
 * 6434634384): on zsh any word beginning with an unquoted `=` undergoes
 * command-path expansion, so the static containment check would evaluate a
 * literal the shell never runs (`rmdir =name` targets a PATH location, not
 * `./=name`). On bash this conservatively withdraws a literal-filename
 * convenience form. `FOO=1 rmdir a` prefix assignments are separate prefix
 * words and unaffected.
 */
const BARE_RMDIR_OPERAND = /^[^-*?[\]{}$`~"'=\\#\s][^*?[\]{}$`~"'\\#\s]*$/;

/**
 * Whether `word` may carry the empty-directory-removal tag. Beyond
 * BARE_RMDIR_OPERAND, a `..` path segment disqualifies it: the gate resolves
 * the operand lexically (`link/../x` collapses to `x`) before it realpaths
 * the parent, while the kernel follows `link` first, so the two can name
 * different directories (PR #3456 review F-3). Such an operand falls back to
 * the ordinary declared-scope check.
 */
function isBareRmdirOperand(word: string): boolean {
	return BARE_RMDIR_OPERAND.test(word) && !word.split('/').includes('..');
}

/** Builtins with in-place editing semantics (modify file argument in place). */
const INPLACE_EDIT_COMMANDS = new Set(['sed', 'perl', 'awk']);

/**
 * GNU sed 4.9 long options that take no argument, spelled in full. An
 * abbreviation (`--quie`, `--expr=`) is not listed on purpose: the in-place
 * picker reports any option word it does not recognise (detectInplaceEdit).
 */
const SED_LONG_SWITCHES = new Set([
	'--quiet',
	'--silent',
	'--debug',
	'--follow-symlinks',
	'--binary',
	'--posix',
	'--regexp-extended',
	'--separate',
	'--sandbox',
	'--unbuffered',
	'--null-data',
	'--zero-terminated',
	'--help',
	'--version',
]);

/** gawk long options that take no argument, spelled in full (see above). */
const AWK_LONG_SWITCHES = new Set([
	'--posix',
	'--traditional',
	'--lint',
	'--re-interval',
	'--sandbox',
	'--version',
	'--help',
]);

/** Interpreters that accept inline code via -c / -e / -p / -r flags (NOT -m, which runs an installed module — see detectInterpreterEval). deno (#3491 W7) evaluates ONLY at subcommand position (`deno eval CODE`). */
const INTERPRETER_EVAL_COMMANDS = new Set([
	'python',
	'python3',
	'python2',
	'py',
	'node',
	'bun',
	'ruby',
	'perl',
	'php',
	'bash',
	'sh',
	'dash',
	'zsh',
	'ksh',
	'deno',
	'eval',
]);

/** Network downloaders. */
const NETWORK_DOWNLOAD_COMMANDS = new Set(['curl', 'wget', 'scp']);

/** Archive extraction commands. */
const ARCHIVE_EXTRACT_COMMANDS = new Set([
	'tar',
	'unzip',
	'gunzip',
	'gzip',
	'bzip2',
	'xz',
	'7z',
	'rar',
]);

/**
 * Real bash builtins (#3485 feedback): `builtin CMD` executes CMD only when
 * CMD names a shell builtin — for anything external (`builtin rm …`,
 * `builtin curl …`) bash errors "not a shell builtin" and runs nothing, so
 * neither the dc unwrap nor the detector walk may unwrap those forms (doing
 * so fabricated destructive/write detections of commands that never ran).
 * Not exhaustive: membership only gates UNWRAPPING, and missing an exotic
 * builtin degrades to the safe no-unwrap direction.
 */
export const BASH_BUILTIN_COMMANDS = new Set([
	'echo',
	'printf',
	'cd',
	'pwd',
	'true',
	'false',
	'test',
	'[',
	':',
	'eval',
	'wait',
	'read',
	'mapfile',
	'source',
	'.',
	'alias',
	'bg',
	'fg',
	'jobs',
	'kill',
	'type',
	'ulimit',
	'umask',
	'unset',
	'times',
	'trap',
	'getopts',
	'help',
	'fc',
	'hash',
	'history',
	'let',
	'local',
	'declare',
	'logout',
	'pushd',
	'popd',
	'dirs',
	'shopt',
	'set',
	'shift',
	'caller',
	'compgen',
	'complete',
]);

/** Git commands (subcommand determines if destructive). */
const GIT_COMMAND = 'git';

// ---------------------------------------------------------------------------
// Issue #3099 — PowerShell shape and read-only classification
// ---------------------------------------------------------------------------

/**
 * Cmdlets whose NAME alone proves the command is PowerShell-shaped.
 *
 * Read verbs and write verbs are listed separately because they are consumed
 * by two different decisions: the shape predicate below (which opens the
 * Windows detector) and the read-only allowlist (which suppresses a
 * parse-failure throw). A cmdlet may appear in the write set while having no
 * matcher in detectPowerShellWrites — that combination is a bypass, because the
 * shape gate would open a detector that then reported the command write-free.
 * `Rename-Item` is deliberately NOT listed for exactly that reason; see the
 * Phase 4.2 recurrence sweep for its disposition.
 */
const POWERSHELL_WRITE_CMDLETS = new Set([
	'set-content',
	'add-content',
	'out-file',
	'clear-content',
	'copy-item',
	'move-item',
	'remove-item',
	'new-item',
	// Aliases that are unambiguously PowerShell — they are not POSIX or cmd
	// builtins, so naming them here cannot over-trigger the shape gate.
	'ni',
	'ac',
	'sc',
	'epcsv',
]);

/**
 * Write tokens that are AMBIGUOUS across shells — a PowerShell alias for one
 * cmdlet and a POSIX/cmd builtin for another.
 *
 * These are deliberately NOT in the shape vocabulary: `cp a.md b.md` is a POSIX
 * command that the POSIX detector already catches, and adding it to the shape
 * set would open the Windows detector on ordinary POSIX input for no gain. They
 * ARE in the read-only predicate's scan set, where the opposite is true — there,
 * missing `cp` would switch off the parse-failure protection that keeps a `cp`
 * hidden inside a PowerShell script block blocked.
 */
const AMBIGUOUS_WRITE_ALIASES = new Set([
	'cp',
	'cpi',
	'mv',
	'rm',
	'del',
	'ren',
	'rd',
	'md',
	'type',
]);

/** Cmdlets that only observe. Their presence never implies a write. */
const POWERSHELL_READ_ONLY_COMMANDS = new Set([
	'get-content',
	'gc',
	'get-item',
	'gi',
	'get-childitem',
	'gci',
	'get-location',
	'pwd',
	'get-command',
	'get-member',
	'get-date',
	'get-help',
	'get-itemproperty',
	'select-string',
	'select-object',
	'where-object',
	'foreach-object',
	'sort-object',
	'group-object',
	'measure-object',
	'compare-object',
	'resolve-path',
	'test-path',
	'format-table',
	'out-string',
	'write-output',
	'write-host',
	'write-verbose',
	'write-warning',
]);

/**
 * POSIX write builtins and in-place editors. Used by the read-only predicate's
 * whole-command scan: suppressing the parse-failure throw on a command that
 * actually writes is a bypass, and bash-parser cannot parse a PowerShell script
 * block, so the braces alone are what kept `cp` inside `{ ... }` blocked at
 * base. If the scan missed `cp`, that protection would be switched off.
 */
const POSIX_WRITE_TOKENS = new Set([
	'cp',
	'mv',
	'rm',
	'rmdir',
	'tee',
	'dd',
	'ln',
	'touch',
	'truncate',
	'unlink',
	'install',
]);

/**
 * Split a command into unquoted word tokens. Quoted regions never yield a
 * token, so a read whose ARGUMENT merely mentions a write verb
 * (`Where-Object { $_.Name -like '*Remove-Item*' }`) is not misread.
 */
function unquotedWordTokens(command: string): string[] {
	const tokens: string[] = [];
	let current = '';
	let quote: '"' | "'" | null = null;
	const flush = () => {
		if (current.length > 0) tokens.push(current);
		current = '';
	};
	for (let i = 0; i < command.length; i += 1) {
		const ch = command[i];
		if (quote) {
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === '"' || ch === "'") {
			flush();
			quote = ch;
			continue;
		}
		if (/\s/.test(ch)) {
			flush();
			continue;
		}
		current += ch;
	}
	flush();
	// Strip the punctuation that groups a cmdlet inside a script block or
	// sub-expression, so `(Copy-Item` and `{ Remove-Item` are recognised as
	// `Copy-Item` and `Remove-Item`.
	return tokens.map((token) =>
		token.replace(/^[({]+/, '').replace(/[)}]+$/, ''),
	);
}

/** True when any unquoted word token is a known PowerShell cmdlet. */
export function isPowerShellShaped(command: string): boolean {
	if (!command) return false;
	return unquotedWordTokens(command).some((token) => {
		const lower = token.toLowerCase();
		return (
			POWERSHELL_WRITE_CMDLETS.has(lower) ||
			POWERSHELL_READ_ONLY_COMMANDS.has(lower)
		);
	});
}

/**
 * PowerShell comparison/logic operators that may appear inside a read-only
 * script block. Anything not in this closed set is treated as unrecognized.
 */
const READ_ONLY_SCRIPT_BLOCK_OPERATORS = new Set(
	[
		'-gt',
		'-ge',
		'-lt',
		'-le',
		'-eq',
		'-ne',
		'-match',
		'-notmatch',
		'-like',
		'-notlike',
		'-replace',
		'-contains',
		'-notcontains',
		'-in',
		'-notin',
		'-is',
		'-isnot',
		'-join',
		'-split',
		'-f',
		'-band',
		'-bor',
		'-bnot',
		'-shl',
		'-shr',
		'-and',
		'-or',
		'-not',
		'-xor',
	].map((op) => op.toLowerCase()),
);

/**
 * POSITIVELY validate a script-block body as a read-only expression.
 *
 * Issue #3099 repair (SolCritic contract clause 1): the original predicate
 * admitted a body when it merely contained no KNOWN write token — a denylist.
 * `Rename-Item`, `mkdir`, `tar`, `chmod`, `ri`, `Tee-Object`,
 * `[System.IO.File]::WriteAllText(...)` and `$_.Delete()` all slipped past it,
 * converting the bash tool's fail-closed parse backstop into a fail-open.
 *
 * This validator inverts the default: every token inside the braces must be a
 * `$_`/`$this` property chain, a member of the closed operator set, a numeric
 * literal, a quoted string, or a bare comma. Any bare identifier, parenthesis,
 * bracket, assignment, sub-expression, nested pipeline or unknown punctuation
 * fails the body — and a failed body means NO suppression, so the parse-error
 * rejection stands exactly as it did before this change.
 */
function isReadOnlyScriptBlockBody(body: string): boolean {
	// Characters that cannot occur in the admitted expression shapes. Parens
	// kill method calls ($_.Delete()) and .NET invocations; brackets kill type
	// literals ([System.IO.File]::...); '=' kills assignment; '::' kills static
	// member access; '@' kills hashtables/array subexpressions; '|' kills
	// nested pipelines; '`' and '$(' are already rejected globally.
	if (/[()[\]=@|`;]/.test(body) || body.includes('::') || body.includes('$(')) {
		return false;
	}
	const tokens =
		body
			.match(/"[^"]*"|'[^']*'|\S+/g)
			?.map((token) => token.replace(/^[({]+/, '').replace(/[)}]+$/, '')) ?? [];
	if (tokens.length === 0) return false;
	for (const token of tokens) {
		if (token === ',') continue;
		if (/^(?:"[^"]*"|'[^']*')$/.test(token)) continue; // quoted literal
		if (/^-?\d+(?:\.\d+)?$/.test(token)) continue; // numeric literal
		if (READ_ONLY_SCRIPT_BLOCK_OPERATORS.has(token.toLowerCase())) continue;
		if (/^(?:\$_|\$this)(?:\.[A-Za-z_]\w*)*$/.test(token)) continue;
		return false; // unrecognized — deny by default
	}
	return true;
}

/**
 * Extract every unquoted brace region from a command, honoring quotes.
 * Returns null (invalid) when a brace region never closes.
 */
function extractScriptBlockBodies(command: string): string[] | null {
	const bodies: string[] = [];
	let depth = 0;
	let start = -1;
	let quote: '"' | "'" | null = null;
	for (let i = 0; i < command.length; i += 1) {
		const ch = command[i];
		if (quote) {
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			continue;
		}
		if (ch === '{') {
			if (depth === 0) start = i + 1;
			depth += 1;
			continue;
		}
		if (ch === '}') {
			depth -= 1;
			if (depth < 0) return null;
			if (depth === 0 && start >= 0) {
				bodies.push(command.slice(start, i));
				start = -1;
			}
		}
	}
	if (quote !== null || depth !== 0) return null;
	return bodies;
}

/**
 * True only when the command is positively a read-only PowerShell pipeline.
 *
 * Every condition must hold and the default is fail-closed: anything not
 * positively proven read-only stays subject to the parse-failure rejection.
 *
 *  1. no redirect, `;`, `&`, backtick or `$(` anywhere;
 *  2. quoting and braces balance — a malformed command is never "read-only";
 *  3. splitting on `|` respects quotes (`Select-String -Pattern 'a|b'` is one
 *     segment, not two);
 *  4. no write-shaped token of ANY family appears as an unquoted word
 *     anywhere (PowerShell Verb-Noun writes, their aliases, POSIX write
 *     builtins, in-place editors with an edit flag);
 *  5. every segment head is a known read-only cmdlet (case-insensitive);
 *  6. every script-block body is POSITIVELY validated as a read-only
 *     expression by `isReadOnlyScriptBlockBody` — deny-by-default, so a body
 *     containing anything unrecognized (including write mechanisms the
 *     detectors cannot see) fails and the command stays blocked.
 */
export function isPowerShellReadOnlyPipeline(command: string): boolean {
	if (!command) return false;
	// LF and CR are statement separators in PowerShell and POSIX shells alike
	// (#3145 PRR-001): a second statement after a newline inside a brace
	// pipeline stayed in the last segment, the brace broke the POSIX parse,
	// and this predicate's suppression let the trailing write through. A
	// read-only classification must be single-statement.
	if (/[>;&`\r\n]/.test(command) || /\$\(/.test(command)) return false;

	// Condition 2 — balanced quoting and braces.
	let quote: '"' | "'" | null = null;
	let braceDepth = 0;
	for (const ch of command) {
		if (quote) {
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			continue;
		}
		if (ch === '{') braceDepth += 1;
		if (ch === '}') braceDepth -= 1;
		if (braceDepth < 0) return false;
	}
	if (quote !== null || braceDepth !== 0) return false;

	// Condition 4 — no write token of any family, anywhere, unquoted.
	for (const token of unquotedWordTokens(command)) {
		const lower = token.toLowerCase();
		if (
			POWERSHELL_WRITE_CMDLETS.has(lower) ||
			AMBIGUOUS_WRITE_ALIASES.has(lower) ||
			POSIX_WRITE_TOKENS.has(lower)
		) {
			return false;
		}
		if (
			(token === 'sed' || token === 'perl' || token === 'awk') &&
			/(^|[\s'"])--?[a-zA-Z-]*(?:\bi|\bin-place|\bpi)\b/.test(command)
		) {
			return false;
		}
	}

	// Condition 6 — every script-block body positively validated.
	const bodies = extractScriptBlockBodies(command);
	if (bodies === null) return false;
	for (const body of bodies) {
		if (!isReadOnlyScriptBlockBody(body)) return false;
	}

	// Condition 3 — quote-aware split on the pipeline separator.
	const segments: string[] = [];
	let current = '';
	quote = null;
	for (let i = 0; i < command.length; i += 1) {
		const ch = command[i];
		if (quote) {
			if (ch === quote) quote = null;
			current += ch;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			current += ch;
			continue;
		}
		if (ch === '|') {
			segments.push(current);
			current = '';
			continue;
		}
		current += ch;
	}
	segments.push(current);

	// Condition 5 — every segment head is read-only (case-insensitive).
	for (const segment of segments) {
		const tokens = unquotedWordTokens(segment.trim());
		if (tokens.length === 0) return false;
		if (!POWERSHELL_READ_ONLY_COMMANDS.has(tokens[0].toLowerCase())) {
			return false;
		}
	}
	return segments.length > 0;
}
/**
 * True only when the command is positively a read-only PowerShell pipeline.
 *
 * Every condition must hold. The default is therefore fail-closed: anything not
 * positively recognised stays subject to the parse-failure rejection.
 *
 *  1. no redirect, redirection, `;`, `&&`, `||`, `$(` or backtick;
 *  2. quoting and braces are balanced — an unclosed quote or brace means the
 *     command is malformed, and a malformed command is never "read-only";
 *  3. splitting on `|` respects quotes, so `Select-String -Pattern 'a|b'` is one
 *     segment rather than two;
 *  4. no write-shaped token of ANY family appears as an unquoted word
 *     anywhere — not merely at a segment head, because a script block can hide
 *     a write behind read-only-looking heads;
 *  5. every segment head is a known read-only cmdlet.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * #3569 residual 3: analyze one process-substitution inner body by routing
 * the WHOLE body through the SAME mainline recursive detection the outer
 * command gets (parse, compound/cwd walk, and every write family: builtin
 * writes incl. tee/dd, redirects, in-place, interpreter eval, launcher
 * writes, git destructive, patch, rsync, archive extract, network download).
 * One design, no second stage splitter — the body is a complete command
 * string. Nested procsub inside a body re-enters this function through the
 * masked path; {@link PROCSUB_RECURSION_CAP} bounds that recursion and any
 * exceedance, parse error, or unwrap-depth refusal WITHDRAWS fail-closed
 * (the null-path unresolvedContext marker the resolver denies) — a write-free
 * body that PARSES stays admitted.
 */
const PROCSUB_RECURSION_CAP = 8;
let procsubRecursionDepth = 0;

function analyzeProcSubInnerStages(innerCommand: string): WriteTarget[] {
	const results: WriteTarget[] = [];
	if (procsubRecursionDepth >= PROCSUB_RECURSION_CAP) {
		results.push({
			category: 'redirect',
			operator: '>',
			path: null,
			unresolvedContext: true,
		});
		return results;
	}
	procsubRecursionDepth += 1;
	let analysis: WriteAnalysis;
	try {
		analysis = detectPosixWrites(innerCommand);
	} finally {
		procsubRecursionDepth -= 1;
	}
	for (const write of analysis.writes) results.push(write);
	if (analysis.parseError) {
		// Fail-closed propagation: an unparseable body refuses even when it
		// yielded zero writes.
		results.push({
			category: 'redirect',
			operator: '>',
			path: null,
			unresolvedContext: true,
		});
	}
	if (analysis.unwrapDepthExceeded) {
		results.push({
			category: 'redirect',
			operator: '>',
			path: null,
			unresolvedContext: true,
		});
	}
	return results;
}

/**
 * Bodies of every masked `>(…)` / `<(…)` span in a command (#3569 residual
 * 3, both operators execute). Returns [] when the command has no maskable
 * span or masking is ambiguous (the parse-failure path handles the latter).
 */
export function procSubSpanBodies(command: string): string[] {
	const masked = maskProcSubSpans(command);
	return masked !== null ? masked.spans.map((span) => span.body) : [];
}

/**
 * Detect process substitution writes using regex when bash-parser fails.
 * Process substitution: >(command) creates implicit writes, <(command) is read-only.
 *
 * bash-parser does not support process substitution syntax, so we use regex to
 * extract and analyze >(...) patterns when the main parse fails.
 *
 * #3539 W5: this legacy whole-command regex stays ONLY for the no-mask
 * fallback path (masking failed or found nothing); the masked-span path
 * analyzes each balanced span body through the shared per-stage scan.
 */
function detectProcessSubstitutionWrites(command: string): WriteTarget[] {
	const results: WriteTarget[] = [];

	// Match >(...) patterns (write process substitution)
	// We only flag >(...) (Great) as writes; <(...) (Less) is read-only.
	// This regex matches simple process substitution without nested parens.
	const writeProcSubPattern = />\s*\(([^)]+)\)/g;
	while (true) {
		const match = writeProcSubPattern.exec(command);
		if (match === null) break;
		const innerCommand = match[1].trim();
		if (!innerCommand) continue;

		for (const write of analyzeProcSubInnerStages(innerCommand)) {
			results.push(write);
		}
	}

	return results;
}

/**
 * One masked process-substitution span (#3539 W5): the `>`/`<` operator, the
 * span body (the text between the parentheses), and where the placeholder
 * begins in the RESIDUAL string (the outer-prefix cd test reads the residual
 * up to this index).
 */
interface MaskedProcSubSpan {
	op: '>' | '<';
	body: string;
	residualPlaceholderStart: number;
}

/**
 * The placeholder that replaces a masked process-substitution span in the
 * residual (#3539 W5). It is a token-preserving bare word — the residual
 * tokenizes exactly like the original except the span is one inert operand —
 * and it is the one string the detector ALREADY treats as a non-target in
 * every destination position through the existing sink-device exemption:
 * `tee PLACEHOLDER` (detectBuiltinWrites isNullDevice), `> PLACEHOLDER`
 * (isNullDeviceWord in the detection walk, isNullDevice in the resolver
 * walk), `dd of=PLACEHOLDER`. That suppression is metadata the detectors
 * already apply to the literal device path — no new string matching, and a
 * real user operand can never be suppressed by a placeholder collision: a
 * genuine `/dev/null` operand was already a non-target before W5, and every
 * other operand text passes through untouched.
 */
const PROC_SUB_PLACEHOLDER = '/dev/null';

/**
 * The length of the bash redirect operator starting at `raw[start]` (a `<`
 * or `>`), by maximal munch: `<<<` (here-string), `<<-`, `<<`, `>>`, `<>`,
 * `>&`, `<&`, `>|` are multi-character operators; a bare `>`/`<` is length
 * 1. `>>>` is NOT an operator — bash lexes `>>` then a separate `>` — which
 * is exactly why `>>>(cmd)` masks its `>(…)` span while `>>(cmd)` masks
 * nothing (#3539 W5 review round 1; boundaries verified by executed bash
 * 5.x ground truth).
 */
function bashRedirectOperatorLength(raw: string, start: number): number {
	const c = raw[start];
	const next = raw[start + 1] ?? '';
	if (c === '<') {
		if (next === '<') {
			const third = raw[start + 2] ?? '';
			if (third === '<' || third === '-') return 3;
			return 2;
		}
		if (next === '>' || next === '&') return 2;
		return 1;
	}
	if (next === '>' || next === '&' || next === '|') return 2;
	return 1;
}

/**
 * Mask every UNQUOTED, UNESCAPED, balanced `>(…)`/`<(…)` span of a
 * parse-failing POSIX command (#3539 W5; RC-5).
 *
 * The scanner is quote-aware (single/double quotes, backslash escapes with
 * the bash double-quote escape set) and comment-aware (a `#` at a word start
 * begins a comment; `>(` inside a comment or quotes is never masked — real
 * bash does not run it).
 *
 * OPERATOR BOUNDARIES (#3539 W5 review round 1): a process substitution is
 * introduced only by a `>` or `<` that STANDS ALONE as an operator
 * immediately before `(`. The scanner consumes each redirect operator with
 * bash's maximal munch before deciding, so (all executed-verified against
 * bash 5.x): `<<(x)`, `>>(x)`, `<<<(x)`, `<>(x)`, `>&(x)`, `<&(x)`, `>|(x)`
 * and `&>(x)`/`&>>(x)` are operator + `(` — genuine bash syntax errors
 * (rc=2, nothing runs) that keep the fail-closed parse-error block (no span
 * masks, so the line still fails to parse), while `>>>(x)` is `>>` plus a
 * glued `>(x)` whose body bash RUNS (the span masks and is analyzed), and
 * `><(x)` is `>` plus `<(x)` (redirect-to-procsub; the span masks). An
 * escaped `\&` before `>(x)` is word content, not the `&>` operator — the
 * backslash branch consumed it before the `>` is considered, so
 * `\&>(cmd)` masks too. A spaced `> (x)` never masks (not glued).
 * Parenthesis nesting inside a masked span is counted.
 *
 * Returns null — masking FAILED, the caller keeps the fail-closed
 * parseError — when any unquoted procsub span is unbalanced, when the scan
 * hits an ambiguity (an unterminated quote), or when no span was maskable at
 * all. Otherwise returns the residual text plus one record per masked span.
 */
function maskProcSubSpans(
	command: string,
): { residual: string; spans: MaskedProcSubSpan[] } | null {
	const spans: MaskedProcSubSpan[] = [];
	const parts: string[] = [];
	// #3569 residual 3 + #3568 PRR-005 (both rounds landed the same linear
	// masking counter; this delta adds the placeholder-length term).
	let maskedRunningLength = 0;
	let cursor = 0; // start of the pending unmasked slice
	let i = 0;
	let state: 'none' | 'single' | 'double' = 'none';
	const atWordStart = (idx: number): boolean =>
		idx === 0 || /[\s;|&()<>]/.test(command[idx - 1] ?? '');

	while (i < command.length) {
		const ch = command[i];
		if (state === 'single') {
			if (ch === "'") state = 'none';
			i++;
			continue;
		}
		if (state === 'double') {
			if (ch === '\\') {
				i += 2;
				continue;
			}
			if (ch === '"') state = 'none';
			i++;
			continue;
		}
		if (ch === '\\') {
			i += 2;
			continue;
		}
		if (ch === "'") {
			state = 'single';
			i++;
			continue;
		}
		if (ch === '"') {
			state = 'double';
			i++;
			continue;
		}
		// A `#` at a word start begins a comment: nothing inside it runs, so
		// a `>(` there is never masked and the comment is copied verbatim.
		if (ch === '#' && atWordStart(i)) {
			const newline = command.indexOf('\n', i);
			i = newline === -1 ? command.length : newline;
			continue;
		}
		// `&>` / `&>>` (redirect both streams) is one bash operator: the `>`
		// belongs to it, so a `(` after it is operator + `(` — a syntax
		// error, never a procsub. An ESCAPED `\&` never reaches here (the
		// backslash branch consumed the pair), so `\&>(cmd)` still masks.
		if (ch === '&' && command[i + 1] === '>') {
			i += command[i + 2] === '>' ? 3 : 2;
			continue;
		}
		if (ch === '>' || ch === '<') {
			// Operator-boundary aware (#3539 W5 review round 1): consume the
			// maximal redirect operator first; only a LENGTH-1 operator
			// glued to `(` introduces a process substitution. This keeps
			// `<<(`/`>>(`/`<<<(`/`<>`/`>&`/`>|` + `(` unmasked (bash rc=2)
			// while `>>>(` still masks its trailing `>(…)` and `><(` masks
			// its `<(…)`.
			const opLength = bashRedirectOperatorLength(command, i);
			if (opLength !== 1 || command[i + 1] !== '(') {
				i += opLength;
				continue;
			}
			const op: '>' | '<' = ch === '>' ? '>' : '<';
			const bodyStart = i + 2;
			let depth = 1;
			let j = bodyStart;
			let bodyState: 'none' | 'single' | 'double' = 'none';
			let closedAt = -1;
			while (j < command.length) {
				const c = command[j];
				if (bodyState === 'single') {
					if (c === "'") bodyState = 'none';
					j++;
					continue;
				}
				if (bodyState === 'double') {
					if (c === '\\') {
						j += 2;
						continue;
					}
					if (c === '"') bodyState = 'none';
					j++;
					continue;
				}
				if (c === '\\') {
					j += 2;
					continue;
				}
				if (c === "'") {
					bodyState = 'single';
					j++;
					continue;
				}
				if (c === '"') {
					bodyState = 'double';
					j++;
					continue;
				}
				if (c === '(') depth++;
				else if (c === ')') {
					depth--;
					if (depth === 0) {
						closedAt = j;
						break;
					}
				}
				j++;
			}
			if (closedAt === -1) return null; // unbalanced span: fail-closed
			parts.push(command.slice(cursor, i));
			// #3569 residual 3 + #3568 PRR-005: a running length counter —
			// parts.join('').length per span is quadratic on span-dense input
			// (measured 21.3s at 300KB); a running total keeps masking linear.
			// The counter must ALSO include each earlier span's placeholder
			// length (4.5 review Critical 1: omitting it shorted every later
			// span's recorded offset by 9*(k-1) chars, so the outer-prefix
			// cd-context test read the wrong residual slice and a post-cd
			// span lost its uncertain context).
			maskedRunningLength += i - cursor;
			const residualPlaceholderStart = maskedRunningLength;
			parts.push(PROC_SUB_PLACEHOLDER);
			maskedRunningLength += PROC_SUB_PLACEHOLDER.length;
			spans.push({
				op,
				body: command.slice(bodyStart, closedAt),
				residualPlaceholderStart,
			});
			i = closedAt + 1;
			cursor = i;
			continue;
		}
		i++;
	}
	if (state !== 'none') return null; // unterminated quote: ambiguous
	if (spans.length === 0) return null; // nothing maskable
	parts.push(command.slice(cursor));
	return { residual: parts.join(''), spans };
}

/**
 * The #3518 P-3 cd-context word scan (W1 form: bare cd / pushd / popd word
 * alternatives, word-boundary anchored), applied to a PREFIX of the residual
 * — the text before a masked span's placeholder. A directory-selection word
 * before the span moves the span body's execution context off the starting
 * cwd; the static model withdraws the span's inner writes instead of
 * guessing the landing (#3539 W5, v4 constraint 6). Over-matching (a `cd`
 * inside a string the prefix cut mid-quote) withdraws: fail-closed.
 */
// #3568 parallel-review F-04: a BACKSLASH-PREFIXED verb (`\cd ..`) is a
// quoted-word spelling bash executes exactly like the bare verb — the
// character class below deliberately excludes a preceding backslash (to
// keep `dir\cd`-style word tails out), so the escaped-verb spelling gets
// its own alternative anchored after a non-word character or line start.
const PROCSUB_CD_CONTEXT =
	/(^|[^\w\\])(?:cd|pushd|popd)\b|(^|[^\w\\])\\(?:cd|pushd|popd)\b/;

function procsubContextWithdraws(prefix: string, body: string): boolean {
	return PROCSUB_CD_CONTEXT.test(prefix) || PROCSUB_CD_CONTEXT.test(body);
}

/** Extract the text value from an AST Word node. */
function wordText(node: unknown): string | null {
	if (!node || typeof node !== 'object') return null;
	if (isBashWord(node)) {
		// #3475: recover `#`-truncated words. bash-parser's QUOTE-REMOVAL
		// stage (rules/quote-removal.js → shell-quote-word) stops an UNQUOTED
		// word at a mid-word `#`, while the word's loc still spans the full
		// source. When the raw slice dequotes to something that starts with
		// the parsed text and the next dequoted character is an UNQUOTED `#`,
		// the shell receives the full dequoted form — use it. Word-start `#`
		// comments are unaffected (their words are not truncated), fully
		// quoted `#` operands are unaffected (not truncated), and words with
		// expansions never take this path.
		const raw = RAW_WORD_TEXT.get(node);
		if (raw !== undefined) {
			const expansions = (node as { expansion?: unknown }).expansion;
			if (!Array.isArray(expansions) || expansions.length === 0) {
				const { projection, dequoted } = scanQuoting(raw);
				if (
					dequoted.length > node.text.length &&
					dequoted.startsWith(node.text) &&
					dequoted[node.text.length] === '#' &&
					projection[node.text.length] !== '\0'
				) {
					return dequoted;
				}
			}
		}
		return node.text;
	}
	return null;
}

/** Type guard: check if a node is a BashWord. */
function isBashWord(node: unknown): node is BashWord {
	return (
		!!node &&
		typeof node === 'object' &&
		(node as BashWord).type === 'Word' &&
		typeof (node as BashWord).text === 'string'
	);
}

/**
 * The source text of each Word node, quotes and backslashes included, keyed
 * by node. bash-parser strips quotes from a word without an expansion
 * (`'*'`, `"*"`, `a\*` and `*` all read `*`), so only the source slice can
 * tell a quoted glob character from one the shell expands. Filled by
 * annotateRawWordText from the parser's insertLOC offsets.
 */
const RAW_WORD_TEXT = new WeakMap<object, string>();

function annotateRawWordText(node: unknown, source: string): void {
	// bash-parser's loc offsets count code points, not UTF-16 units, so a
	// character outside the BMP (an emoji) shifts every later JS index by one.
	// Map code-point offsets to string indices before slicing.
	let unitIndex: number[] | null = null;
	if (/[\uD800-\uDFFF]/.test(source)) {
		unitIndex = [];
		let u = 0;
		for (const cp of source) {
			unitIndex.push(u);
			u += cp.length;
		}
		unitIndex.push(u);
	}
	const toUnit = (cp: number): number | undefined =>
		unitIndex === null ? cp : unitIndex[cp];
	const stack: unknown[] = [node];
	const seen = new Set<object>();
	while (stack.length > 0) {
		const n = stack.pop();
		if (!n || typeof n !== 'object' || seen.has(n)) continue;
		seen.add(n);
		if (isBashWord(n)) {
			const loc = (
				n as { loc?: { start?: { char?: unknown }; end?: { char?: unknown } } }
			).loc;
			const start = loc?.start?.char;
			const end = loc?.end?.char;
			if (
				typeof start === 'number' &&
				typeof end === 'number' &&
				end >= start
			) {
				const from = toUnit(start);
				const to = toUnit(end + 1);
				if (from !== undefined && to !== undefined) {
					RAW_WORD_TEXT.set(n, source.slice(from, to));
				}
			}
		}
		for (const value of Object.values(n)) {
			if (value && typeof value === 'object') stack.push(value);
		}
	}
}

/**
 * Whether the word's source holds a glob character (`*`, `?`, `[`) outside
 * single quotes, double quotes and backslash escapes, which the shell
 * expands into several words when it matches. Without source text the word
 * counts as holding one (fail-safe).
 */
function hasUnquotedGlob(word: unknown): boolean {
	const projection = unquotedProjection(word);
	return projection === null || /[*?[]/.test(projection);
}

/**
 * Whether the word holds a brace expansion (`{a,b}`, `{1..3}`) that the
 * shell expands, i.e. one written outside quotes and backslash escapes
 * (`'{print $1,$2}'` is one word). Without trusted source text the parsed
 * text decides (fail-safe: the parser drops quotes).
 */
function hasUnquotedBraceExpansion(word: unknown, text: string): boolean {
	const projection = unquotedProjection(word);
	return BRACE_EXPANSION.test(projection === null ? text : projection);
}

const BRACE_EXPANSION = /\{[^{}]*(?:,|\.\.)[^{}]*\}/;

/**
 * The word's source text with every quoted or backslash-escaped character
 * replaced by NUL and the quote characters removed, so a test on it sees
 * only what the shell reads unquoted. Null when the source text is missing
 * or does not read back as the parsed word (not trusted).
 */
function unquotedProjection(word: unknown): string | null {
	if (!word || typeof word !== 'object') return null;
	const raw = RAW_WORD_TEXT.get(word);
	if (raw === undefined) return null;
	const { projection, dequoted } = scanQuoting(raw);
	// A slice that does not read back as the parsed word (an offset the
	// parser did not anchor to this source) is not trusted. bash-parser
	// decodes C escapes inside quotes (`'s/\t/ /'` parses to a real TAB), so
	// the slice also reads back when decoding those escapes explains the
	// difference.
	const hasExpansion =
		Array.isArray((word as { expansion?: unknown }).expansion) &&
		((word as { expansion: unknown[] }).expansion.length ?? 0) > 0;
	const text = (word as { text?: unknown }).text;
	if (
		!hasExpansion &&
		dequoted !== text &&
		decodeParserEscapes(dequoted) !== text
	) {
		return null;
	}
	return projection;
}

/**
 * What bash's quote removal makes of a word's source text (`dequoted`, no
 * C-escape decoding: `'\x41'` stays the four characters `\x41`), and the
 * same text with every quoted or escaped character replaced by NUL
 * (`projection`).
 */
function scanQuoting(raw: string): { projection: string; dequoted: string } {
	let state: 'none' | 'single' | 'double' = 'none';
	let projection = '';
	let dequoted = '';
	for (let c = 0; c < raw.length; c++) {
		const ch = raw[c];
		if (state === 'single') {
			if (ch === "'") state = 'none';
			else {
				dequoted += ch;
				projection += '\0';
			}
		} else if (ch === '\\') {
			const next = raw[c + 1] ?? '';
			// Inside double quotes a backslash escapes only $ ` " \ newline;
			// before any other character it is kept and that character is read
			// normally (`"\[ab]"` is the four characters \[ab]).
			if (state === 'double' && !/[$`"\\\n]/.test(next)) {
				dequoted += ch;
				projection += '\0';
				continue;
			}
			if (next !== '\n') {
				dequoted += next;
				projection += '\0';
			}
			c++;
		} else if (ch === '"') {
			state = state === 'double' ? 'none' : 'double';
		} else if (state === 'none' && ch === "'") {
			state = 'single';
		} else {
			dequoted += ch;
			projection += state === 'none' ? ch : '\0';
		}
	}
	return { projection, dequoted };
}

const PARSER_CHAR_ESCAPES: Record<string, string> = {
	t: '\t',
	n: '\n',
	r: '\r',
	b: '\b',
	f: '\f',
	v: '\v',
};

// ---------------------------------------------------------------------------
// #3491 W8 — brace-expanded write destinations (RC-9)
// ---------------------------------------------------------------------------

/** The outcome of expanding one write-destination word's brace regions. */
export type BraceDestinationExpansion =
	| { kind: 'none' }
	| { kind: 'branches'; branches: string[] }
	| { kind: 'dynamic' };

/** At most this many regions multiply per destination word (plan cap). */
const BRANCH_REGION_CAP = 2;
/** At most this many expanded branches per destination word (plan cap). */
const BRANCH_TOTAL_CAP = 8;

/**
 * A pure-decimal sequence endpoint without zero padding: `0`, `3`, `12`.
 * Bash zero-pads `{01..03}` and expands signed `{-1..2}` — both are REAL
 * expansions this model refuses (dynamic), never literals.
 */
const PLAIN_SEQUENCE_ENDPOINT = /^(?:0|[1-9][0-9]*)$/;
/** A single alpha endpoint — bash expands `{a..c}`; refused here (dynamic). */
const SINGLE_ALPHA_ENDPOINT = /^[A-Za-z]$/;

/**
 * Expand the unquoted brace regions of one WRITE DESTINATION word (#3491
 * W8, RC-9): comma lists (`{a,b}`) and plain numeric ranges (`{1..3}`),
 * Cartesian across at most {@link BRANCH_REGION_CAP} regions and at most
 * {@link BRANCH_TOTAL_CAP} branches — each branch is emitted as its own
 * destination so the scope gate judges every file bash writes.
 *
 * Ground truth (bash 5.x, executed probes in the issue trace): quoted or
 * backslash-escaped braces/commas never expand (`'{a,b}'`, `"\{a,b\}"`,
 * `{a\,b}` stay literal — kind 'none'); a `{…}` with an unquoted comma is a
 * LIST and the `..` inside an alternative is literal (`{1..3,x}` → `1..3`,
 * `x`); a `{…}` without a comma is a SEQUENCE only when both endpoints are
 * integers or single letters, else bash keeps it literal (`{a..}`, `{..3}`,
 * `{ab..cd}`, `{a..1}` → literal); a `$` immediately before `{` starts a
 * parameter expansion (`${a,b}` is not a brace region).
 *
 * Every REAL expansion this model cannot enumerate exactly — nested braces,
 * empty alternatives (`{a,,b}`), alpha or signed or zero-padded or stepped
 * sequences, over-cap shapes — is 'dynamic': the caller reclassifies the
 * write so the gate fails closed on it, because bash writes MORE files than
 * any literal reading of the word.
 *
 * `word` supplies the trusted raw source text (quote-aware; falls back to
 * `text` when the node or its raw slice is missing — the parser drops
 * quotes, so that fallback can only over-expand, never miss an expansion).
 */
function expandBraceDestinations(
	word: unknown,
	text: string,
): BraceDestinationExpansion {
	const raw =
		word && typeof word === 'object'
			? (RAW_WORD_TEXT.get(word as object) ?? text)
			: text;
	return expandBraceRaw(raw);
}

/** The raw-text engine shared by the AST sites and the fallback sites. */
export function expandBraceRaw(raw: string): BraceDestinationExpansion {
	// Segments: literal pieces (kept raw for later dequoting) and regions.
	const literals: string[] = [];
	const regions: Array<{ alternatives: string[]; count: number }> = [];
	let cursor = 0;
	let i = 0;
	let state: 'none' | 'single' | 'double' = 'none';
	while (i < raw.length) {
		const ch = raw[i];
		if (state === 'single') {
			if (ch === "'") state = 'none';
			i++;
			continue;
		}
		if (state === 'double') {
			if (ch === '\\') {
				i += 2;
				continue;
			}
			if (ch === '"') state = 'none';
			i++;
			continue;
		}
		if (ch === '\\') {
			i += 2;
			continue;
		}
		if (ch === "'" || ch === '"') {
			state = ch === "'" ? 'single' : 'double';
			i++;
			continue;
		}
		if (ch === '$' && raw[i + 1] === '{') {
			// Parameter expansion: `${a,b}` is not a brace region. Skip to
			// its closing unquoted `}` (the content stays literal); an
			// unterminated one is an anomaly the caller must not expand.
			const close = scanToUnquotedClose(raw, i + 2, '}');
			if (close === -1) return { kind: 'dynamic' };
			i = close + 1;
			continue;
		}
		if (ch === '{') {
			const region = parseBraceRegion(raw, i);
			if (region === 'ambiguous') return { kind: 'dynamic' };
			if (region !== null) {
				literals.push(raw.slice(cursor, i));
				regions.push(region);
				i = region.end + 1;
				cursor = i;
				continue;
			}
			// Not a region: bash keeps the brace literal. Continue after
			// the `{` so its content is still scanned (an inner real region
			// like `x{a{b,c}` keeps working).
			i++;
			continue;
		}
		i++;
	}
	if (regions.length === 0) return { kind: 'none' };
	literals.push(raw.slice(cursor));
	if (regions.length > BRANCH_REGION_CAP) return { kind: 'dynamic' };
	let total = 1;
	for (const region of regions) {
		total *= region.count;
		if (total > BRANCH_TOTAL_CAP) return { kind: 'dynamic' };
	}
	// Assemble: Cartesian product in bash order, each literal piece and each
	// alternative dequoted exactly like bash quote removal (no C-escape
	// decoding — the branch is the operand text the shell passes on).
	const dequotedLiterals = literals.map((piece) => scanQuoting(piece).dequoted);
	const branches: string[] = [];
	const build = (index: number, prefix: string): void => {
		if (index === regions.length) {
			branches.push(prefix);
			return;
		}
		for (const alternative of regions[index].alternatives) {
			build(
				index + 1,
				prefix +
					scanQuoting(alternative).dequoted +
					dequotedLiterals[index + 1],
			);
		}
	};
	build(0, dequotedLiterals[0]);
	// Final-critic advisory: a branch carrying a dynamic expansion (`$VAR`,
	// `$(…)`, a backtick substitution, `%VAR%`, a leading `~`) makes the
	// word's whole filename set unknowable — bash expands every branch and
	// writes whichever the substitution yields. The word refuses as a whole
	// (one null-path dynamic write rendering the SOURCE word) instead of
	// emitting the non-dynamic siblings and a brace-substituted dynamic
	// branch the user never typed verbatim.
	if (branches.some((branch) => isDynamicPath(branch))) {
		return { kind: 'dynamic' };
	}
	return { kind: 'branches', branches };
}

/**
 * Index of the next unquoted, unescaped `closer` at or after `from`, or -1.
 * Tracks single/double quotes and backslash escapes (the bash double-quote
 * escape set).
 */
function scanToUnquotedClose(
	raw: string,
	from: number,
	closer: string,
): number {
	let state: 'none' | 'single' | 'double' = 'none';
	for (let i = from; i < raw.length; i++) {
		const ch = raw[i];
		if (state === 'single') {
			if (ch === "'") state = 'none';
			continue;
		}
		if (state === 'double') {
			if (ch === '\\') {
				i++;
				continue;
			}
			if (ch === '"') state = 'none';
			continue;
		}
		if (ch === '\\') {
			i++;
			continue;
		}
		if (ch === "'") state = 'single';
		else if (ch === '"') state = 'double';
		else if (ch === closer) return i;
	}
	return -1;
}

/**
 * Parse one brace region starting at `raw[start] === '{'`.
 *
 * Returns null when bash keeps this `{…}` LITERAL (no unquoted comma and no
 * bash-valid sequence: `{a}`, `{a..}`, `{..3}`, `{ab..cd}`, `{a..1}`), a
 * region record for a comma list or plain numeric range, or 'ambiguous' for
 * a REAL expansion this model refuses to enumerate (nested unquoted braces,
 * empty alternatives, alpha/signed/zero-padded/stepped sequences) — the
 * caller must classify the whole write dynamic, fail-closed.
 */
function parseBraceRegion(
	raw: string,
	start: number,
): { alternatives: string[]; count: number; end: number } | null | 'ambiguous' {
	// Find the matching `}` with nesting awareness: a nested unquoted `{`
	// inside is a real expansion shape this model refuses.
	let depth = 1;
	let j = start + 1;
	let state: 'none' | 'single' | 'double' = 'none';
	let close = -1;
	while (j < raw.length) {
		const ch = raw[j];
		if (state === 'single') {
			if (ch === "'") state = 'none';
			j++;
			continue;
		}
		if (state === 'double') {
			if (ch === '\\') {
				j += 2;
				continue;
			}
			if (ch === '"') state = 'none';
			j++;
			continue;
		}
		if (ch === '\\') {
			j += 2;
			continue;
		}
		if (ch === "'") {
			state = 'single';
			j++;
			continue;
		}
		if (ch === '"') {
			state = 'double';
			j++;
			continue;
		}
		if (ch === '$' && raw[j + 1] === '{') {
			const paramClose = scanToUnquotedClose(raw, j + 2, '}');
			if (paramClose === -1) return 'ambiguous';
			j = paramClose + 1;
			continue;
		}
		if (ch === '{') return 'ambiguous'; // nested brace region
		if (ch === '}') {
			depth--;
			if (depth === 0) {
				close = j;
				break;
			}
		}
		j++;
	}
	if (close === -1) return null; // no `}`: bash keeps the `{` literal
	const content = raw.slice(start + 1, close);

	// Split on UNQUOTED commas (a comma list). A quoted or escaped comma
	// (`{a\,b}`, `{"a,b"}`) is not a separator and the shape stays
	// literal/sequence. Alternatives keep their RAW text; the assembler's
	// scanQuoting dequotes them exactly once.
	const alternatives: string[] = [];
	let altStart = 0;
	let k = 0;
	let altState: 'none' | 'single' | 'double' = 'none';
	let sawUnquotedComma = false;
	while (k < content.length) {
		const ch = content[k];
		if (altState === 'single') {
			if (ch === "'") altState = 'none';
			k++;
			continue;
		}
		if (altState === 'double') {
			if (ch === '\\') {
				k += 2;
				continue;
			}
			if (ch === '"') altState = 'none';
			k++;
			continue;
		}
		if (ch === '\\') {
			k += 2;
			continue;
		}
		if (ch === "'" || ch === '"') {
			altState = ch === "'" ? 'single' : 'double';
			k++;
			continue;
		}
		if (ch === '$' && content[k + 1] === '{') {
			const paramClose = scanToUnquotedClose(content, k + 2, '}');
			if (paramClose === -1) return 'ambiguous';
			k = paramClose + 1;
			continue;
		}
		if (ch === ',') {
			sawUnquotedComma = true;
			if (k === altStart) return 'ambiguous'; // empty alternative: refuse
			alternatives.push(content.slice(altStart, k));
			altStart = k + 1;
			k++;
			continue;
		}
		k++;
	}
	if (altState !== 'none') return 'ambiguous'; // unterminated quote inside
	if (sawUnquotedComma) {
		if (altStart === content.length) return 'ambiguous'; // trailing empty
		alternatives.push(content.slice(altStart));
		return { alternatives, count: alternatives.length, end: close };
	}

	// No comma: a sequence only when both endpoints are integers or both are
	// single letters (bash's rule). Anything else is a literal `{…}`.
	const parts = content.split('..');
	const isPlain = (s: string): boolean => PLAIN_SEQUENCE_ENDPOINT.test(s);
	const isIntegerLike = (s: string): boolean => /^[+-]?[0-9]+$/.test(s);
	const isSingleAlpha = (s: string): boolean => SINGLE_ALPHA_ENDPOINT.test(s);
	if (parts.length >= 2 && parts[0] !== '' && parts[1] !== '') {
		const [lo, hi] = parts;
		if (parts.length === 2 && isPlain(lo) && isPlain(hi)) {
			const loN = Number.parseInt(lo, 10);
			const hiN = Number.parseInt(hi, 10);
			const count = Math.abs(hiN - loN) + 1;
			// #3569 F3: an adversarial range ({1..30000000}) must refuse
			// BEFORE materialization - building the sequence first and capping
			// afterwards costs ~2.2 GB inside the gate (measured); 'ambiguous'
			// routes the caller to its dynamic refusal, fail-closed.
			if (!Number.isSafeInteger(count) || count > BRANCH_TOTAL_CAP) {
				return 'ambiguous';
			}
			const step = loN <= hiN ? 1 : -1;
			const seq: string[] = [];
			for (let n = loN; seq.length < count; n += step) seq.push(String(n));
			return { alternatives: seq, count, end: close };
		}
		// Real bash expansions this model refuses: zero-padded or signed
		// integers (`{01..3}`, `{-1..2}`), single letters (`{a..c}`), step
		// syntax (`{1..9..2}`) — bash writes more files than any literal
		// reading, so the caller classifies the write dynamic (fail-closed).
		if (
			(isIntegerLike(lo) && isIntegerLike(hi)) ||
			(isSingleAlpha(lo) && isSingleAlpha(hi))
		) {
			return 'ambiguous';
		}
	}
	// `{a}`, `{a..}`, `{..3}`, `{..}`, `{ab..cd}`, `{a..1}`: bash literal.
	return null;
}

/**
 * The C escapes bash-parser 0.5.0 decodes inside a quoted word, as measured
 * against the parser: `\xHH`, `\uHHHH`, `\UHHHHHHHH`, octal `\N` to `\NNN`,
 * and `\\`, `\t`, `\n`, `\r`, `\b`, `\f`, `\v`, `\"`, `\'`. Other sequences
 * (`\e`, `\a`, `\cX`, a one-digit `\x4`) are kept as written.
 */
function decodeParserEscapes(s: string): string {
	return s.replace(
		/\\(?:x([0-9A-Fa-f]{2})|u([0-9A-Fa-f]{4})|U([0-9A-Fa-f]{8})|([0-7]{1,3})|([\\tnrbfv"']))/g,
		(m, x, u, big, octal, c) => {
			const hex = x ?? u ?? big;
			if (hex !== undefined) {
				const cp = Number.parseInt(hex, 16);
				return cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
			}
			if (octal !== undefined) {
				return String.fromCodePoint(Number.parseInt(octal, 8));
			}
			return PARSER_CHAR_ESCAPES[c] ?? c;
		},
	);
}

/**
 * Recursively walk an AST node and collect all commands at the leaf level.
 * Handles: Script, Pipeline, CompoundList, LogicalExpression, Subshell, and Command nodes.
 *
 * CompoundList (from brace groups) is pushed as a node because it can carry redirections.
 * Subshell is pushed so detectRedirects can see its redirections.
 */
function collectLeafCommands(node: BashNode, out: BashNode[]): void {
	if (!node || typeof node !== 'object') return;

	switch (node.type) {
		case 'Script':
			if (Array.isArray(node.commands)) {
				for (const cmd of node.commands) {
					collectLeafCommands(cmd, out);
				}
			}
			break;

		case 'Pipeline':
		case 'Sequence':
			if (Array.isArray(node.commands)) {
				for (const cmd of node.commands) {
					collectLeafCommands(cmd, out);
				}
			}
			break;

		case 'CompoundList':
			// CompoundList can carry redirections; push it then recurse into commands.
			out.push(node);
			if (Array.isArray(node.commands)) {
				for (const cmd of node.commands) {
					collectLeafCommands(cmd, out);
				}
			}
			break;

		case 'LogicalExpression':
			if (node.left) collectLeafCommands(node.left, out);
			if (node.right) collectLeafCommands(node.right, out);
			break;

		case 'And':
		case 'Or':
			if (node.left) collectLeafCommands(node.left, out);
			if (node.right) collectLeafCommands(node.right, out);
			break;

		case 'Subshell':
			// Push subshell so its redirections are detected, then recurse into list.
			out.push(node);
			if (node.list) collectLeafCommands(node.list, out);
			break;

		case 'ProcessSubstitution':
			// ProcessSubstitution: >(cmd) creates a write fd, <(cmd) is read-only.
			// bash-parser currently does not emit ProcessSubstitution nodes (see line ~1508).
			// This case is kept for future bash-parser versions that may add support.
			// Currently the regex fallback in detectProcessSubstitutionWrites handles
			// process substitution detection when bash-parser fails to parse.
			// Only >(...) (Great operator) is a potential write — recurse into inner command.
			// Skip <(...) (Less operator) since it is read-only.
			{
				const opNode = node.op;
				if (opNode && typeof opNode === 'object') {
					const opType = opNode.type?.toUpperCase();
					if (opType === 'GREAT') {
						// >(...) is a write — recurse into the inner command
						if (node.command) {
							collectLeafCommands(node.command, out);
						}
					}
					// LESS operator (<) is read-only — skip entirely
				}
			}
			break;

		// Issue #3099 (R1e): control-flow bodies were never recursed. A `cp`
		// inside an `if`/`while`/`until`/`for`/`case` body reached `default:`
		// as the un-descended compound node, so it reported no write at all.
		// Push the compound node FIRST — the same reason CompoundList and
		// Subshell are pushed — so its own `redirections` stay visible to
		// detectRedirects (`if a; then echo x; fi > OUT` must keep reporting
		// the redirect), then recurse into the parts that actually execute.
		case 'If':
			out.push(node);
			if (node.clause) collectLeafCommands(node.clause, out);
			if (node.then) collectLeafCommands(node.then, out);
			if (node.else) collectLeafCommands(node.else, out);
			break;

		case 'While':
		case 'Until':
			out.push(node);
			if (node.clause) collectLeafCommands(node.clause, out);
			if (node.do) collectLeafCommands(node.do, out);
			break;

		case 'For':
			out.push(node);
			if (node.do) collectLeafCommands(node.do, out);
			break;

		case 'Case':
			out.push(node);
			// `clause` on a Case is a bare Word (the case subject), never a
			// command — recursing into it would push a non-command node.
			if (Array.isArray(node.cases)) {
				for (const entry of node.cases) {
					if (entry?.body) collectLeafCommands(entry.body, out);
				}
			}
			break;

		case 'Function':
			out.push(node);
			if (node.body) collectLeafCommands(node.body, out);
			break;
		default:
			out.push(node);
			break;
	}
}

/** Extract the command name from a Command/SimpleCommand AST node. */
function getCommandName(cmd: unknown): string | null {
	if (!cmd || typeof cmd !== 'object') return null;
	const c = cmd as BashCommand;
	if (typeof c.name === 'string') return c.name;
	return wordText(c.name);
}

/**
 * Separator-independent basename: splits on BOTH `/` and `\` so a Windows
 * path (`C:\Python311\python.exe`) yields the same leaf under any host
 * platform, then strips a case-insensitive `.exe` suffix. Used by the
 * interpreter-spelling normalizer (#3343) and the host-shell classifier
 * (#3346) — never `path.basename`, which is separator-bound to the host.
 */
export function basenameAnySep(word: string): string {
	return basenameAnySepCase(word).toLowerCase();
}

/**
 * Case-preserving variant of {@link basenameAnySep}: basename across either
 * separator, `.exe` stripped, original case kept. Dedupe keys for bash
 * commands must stay case-sensitive (`rmdir` and `RMDIR` are different
 * programs and must not collapse into one dedupe entry).
 */
function basenameAnySepCase(word: string): string {
	const leaf = word.split(/[\\/]/).filter(Boolean).pop() ?? word;
	return leaf.replace(/\.exe$/i, '');
}

/**
 * Issue #3343: normalize an interpreter invocation to the canonical name the
 * eval tables key on, regardless of spelling. Consumes the ORDERED COMMAND
 * WORDS (name + suffix words) with a scan CURSOR, not just the first word,
 * so transparent `env`/`command`/`exec` prefixes unwrap to the interpreter
 * that actually runs — including WRAPPER CHAINS (`command env python -c`)
 * and `env` flags that take a separate ARGUMENT (GNU env `-u NAME`, `-S
 * "opts"`, `-C dir`): the argument is consumed together with its flag and
 * never mistaken for the interpreter (final-critic round-1 Critical).
 *   - `env` skips its own flags — arg-taking ones (`-u`/`-U`/`-C`/`-S`/
 *     `--split-string`) skip their following argument too — and `VAR=VALUE`
 *     assignments; `command`/`exec` (with their own `-p/-v/-V/-l` flags)
 *     take the next word directly; the cursor advances through the whole
 *     chain (`/usr/bin/env python3.12`, `exec env python -c`).
 *   - basename (separator-independent `basenameAnySep`) handles
 *     `/usr/bin/python3` and `C:/Python311/python.exe`.
 *   - DUAL-FORM version lookup: strip a trailing digit-run version
 *     `\d+(\.\d+)*` and accept when EITHER the stripped form OR the full
 *     form is a known eval interpreter. A dotted-only strip would leave
 *     `ruby3`/`perl5`/`php8`/`node22` — none are table keys — so the full
 *     form is checked first and the stripped form (`ruby3.2`→`ruby`,
 *     `node22.0.0`→`node`, `ksh93`→`ksh`) second. `python3.11-config`
 *     ends non-digit, so it never strips and never matches.
 * Returns null when no canonical interpreter matches (the caller leaves the
 * command unclassified, exactly as before).
 */
// env flags whose value is a SEPARATE argument — the COMPLETE GNU coreutils
// env set (9.x manual): -u/--unset NAME, -C/--chdir DIR, -S/--split-string
// "opts", -a/--argv0 NAME (argv[0] override, the env sibling of exec a —
// final-critic r3), --env0-from FILE.
const ENV_FLAGS_WITH_ARG = new Set([
	'-u',
	'-U',
	'-C',
	'-S',
	'-a',
	'-P', // BSD/macOS env: -P altpath (required arg; final-critic r6)
	'--split-string',
	'--unset',
	'--chdir',
	'--argv0',
	'--env0-from',
]);

/**
 * True when an `env` flag token consumes the FOLLOWING word as its argument
 * (final-critic r4: GNU getopt accepts unambiguous long-option ABBREVIATIONS
 * (`--un` = `--unset`) and short-option CLUSTERS whose last member takes an
 * argument (`-iu FOO` = `-i -u FOO`) — both re-opened the arg-taking-flag
 * evasion until canonicalized). The five long arg-taking flags have unique
 * first letters (u/c/a/s/e), so any prefix of length ≥3 is unambiguous
 * across the set. Attached short forms (`-uFOO`) and mid-cluster arg-takers
 * carry their argument inside the token and stay safe without it.
 */
function envFlagConsumesNextWord(token: string): boolean {
	if (token.startsWith('--')) {
		const exact = ENV_FLAGS_WITH_ARG.has(token);
		if (exact) return true;
		// GNU getopt accepts unambiguous long-option abbreviations of ANY
		// length (`--u` = `--unset`; final-critic r5). The five arg-taking
		// long flags have unique first letters, so any `--x…` prefix that
		// matches exactly one is unambiguous.
		if (token.length < 3) return false; // bare `--` terminator
		return (
			[...ENV_FLAGS_WITH_ARG].filter(
				(flag) => flag.startsWith('--') && flag.startsWith(token),
			).length === 1
		);
	}
	if (token.startsWith('-') && token.length > 2) {
		// Short cluster (final-critic r5): getopt walks left-to-right — the
		// FIRST arg-taking member either is the final char (its argument is
		// the NEXT word: `-iu FOO` = -i -u FOO) or swallows the REST of the
		// token as its attached argument (`-uu` = -u u, `-Cu` = -C u) and
		// the token consumes NO next word. Only the first shape skips a word.
		const chars = token.slice(1).split('');
		const argTaking = ['u', 'U', 'C', 'S', 'a', 'P'];
		const firstArgIndex = chars.findIndex((c) => argTaking.includes(c));
		return (
			firstArgIndex === chars.length - 1 &&
			chars.slice(0, -1).every((c) => !argTaking.includes(c))
		);
	}
	return ENV_FLAGS_WITH_ARG.has(token);
}

/**
 * Walk the transparent wrapper chain (env/command/exec + their own flags)
 * over `[commandName, ...suffixWords]` and return the index of the
 * INTERPRETER word, or -1 when a wrapper has no program word (#3491 W4
 * fix-round-2: extracted from canonicalInterpreterName so the shell-family
 * flag walk can start at the interpreter's own arguments).
 *
 * The cursor only moves forward, so `command env python -c` advances
 * name→env→python instead of re-reading the first suffix word on every hop
 * (the round-1 critic chain bug). No hop cap: every iteration consumes at
 * least the wrapper word, so the cursor bound alone terminates the loop
 * (impl-review r3 finding 4 — a fixed cap re-opened a depth-N+1 bypass for
 * no safety benefit).
 */
function canonicalInterpreterAt(words: string[]): number {
	let i = 0;
	for (let hop = 0; hop < words.length; hop++) {
		const base = basenameAnySep(words[i] ?? '');
		if (base !== 'env' && base !== 'command' && base !== 'exec') return i;
		i += 1; // consume the wrapper word
		if (base === 'env') {
			while (i < words.length) {
				const token = words[i];
				if (token === undefined) break;
				if (envFlagConsumesNextWord(token)) {
					i += 2; // flag + its separate argument
					continue;
				}
				if (token.startsWith('-')) {
					i += 1; // env's own no-argument flag (-i, --ignore-environment…)
					continue;
				}
				if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
					i += 1; // VAR=VALUE assignment
					continue;
				}
				break; // the interpreter word
			}
		} else {
			// command/exec: only their own flags precede the program word.
			// exec's `-a NAME` (argv[0] override) takes a separate argument
			// (impl-review r3 finding 3) — consume it with the flag like the
			// env branch does.
			while (i < words.length) {
				const token = words[i];
				if (token === undefined) break;
				if (token === '-a' || token === '--arg0') {
					i += 2;
					continue;
				}
				if (token.startsWith('-')) {
					i += 1;
					continue;
				}
				break;
			}
		}
		if (i >= words.length) return -1; // wrapper with no program word
	}
	return i;
}

function canonicalInterpreterName(cmd: unknown): string | null {
	const name = getCommandName(cmd);
	if (!name) return null;
	const words = [name, ...getSuffixWords(cmd)];
	const i = canonicalInterpreterAt(words);
	if (i < 0) return null;
	const word = words[i];
	if (word === undefined) return null;
	const full = basenameAnySep(word);
	if (INTERPRETER_EVAL_COMMANDS.has(full)) return full;
	const stripped = full.replace(/\d+(\.\d+)*$/, '');
	if (
		stripped !== '' &&
		stripped !== full &&
		INTERPRETER_EVAL_COMMANDS.has(stripped)
	) {
		return stripped;
	}
	return null;
}

/**
 * Get the suffix (arguments after command name) from a command node. Returns
 * array of word texts.
 *
 * Only Word nodes are arguments. A Redirect node in the suffix (`cp a b
 * 2>/dev/null`) is not an argument and is skipped; it used to be mapped to
 * an empty string, which made every "last argument is the destination"
 * picker (cp, mv, install, ln) report an empty path that resolved to the
 * workspace root instead of the real destination.
 */
/**
 * Raw (quote-preserving) text of each suffix Word node of a parsed command,
 * or null when ANY word lacks its raw slice. bash-parser strips quotes into
 * `Word.text` (`"/s"` reads `/s`), so the cmd.exe switch grammar needs the
 * RAW slice (RAW_WORD_TEXT, populated by annotateRawWordText) to tell a
 * quoted `"/s"` path operand from an unquoted `/s` switch. The null
 * return is the fail-safe direction: the caller must not defer an rmdir to
 * the destructive guard on unprovable quoting.
 */
function rawSuffixWords(cmd: unknown): string[] | null {
	const c = cmd as BashCommand;
	const suffix = c.suffix;
	if (!Array.isArray(suffix)) return [];
	const words: string[] = [];
	for (const s of suffix) {
		if (!isBashWord(s)) continue;
		const raw = RAW_WORD_TEXT.get(s);
		// Fail-safe: without the raw slice a dequoted `/s` is
		// indistinguishable from a quoted `"/s"`, and deferring on the
		// dequoted form could leave the command with no checking layer.
		// Callers must NOT defer when null.
		if (raw === undefined) return null;
		words.push(raw);
	}
	return words;
}

function getSuffixWords(cmd: unknown): string[] {
	if (!cmd || typeof cmd !== 'object') return [];
	const c = cmd as BashCommand;
	const suffix = c.suffix;
	if (!Array.isArray(suffix)) return [];
	const words: string[] = [];
	for (const s of suffix) {
		const text = wordText(s);
		if (text !== null) words.push(text);
	}
	return words;
}

/**
 * The suffix WORD NODES index-aligned with {@link getSuffixWords} (#3491
 * W8): destination expansion needs the node's raw source slice to tell a
 * quoted `'{a,b}'` (literal) from an unquoted region (a real expansion).
 */
function getSuffixNodes(cmd: unknown): unknown[] {
	if (!cmd || typeof cmd !== 'object') return [];
	const c = cmd as BashCommand;
	const suffix = c.suffix;
	if (!Array.isArray(suffix)) return [];
	const nodes: unknown[] = [];
	for (const s of suffix) {
		if (wordText(s) !== null) nodes.push(s);
	}
	return nodes;
}

/**
 * Emit one builtin destination write, brace-expanded (#3491 W8): every
 * branch of an unquoted `{a,b}`/`{1..3}` region becomes its own write
 * target; a real-but-refused expansion shape (nested, over-cap, empty
 * alternative, alpha/signed/zero-padded/stepped sequence, or any branch
 * carrying a dynamic expansion) emits the caller's `dynamic()` write — a
 * single null-path write carrying the user's SOURCE word
 * (`dynamicSourceWord`) that the gate's dynamic-target block denies
 * (fail-closed). `rawSkip` drops a brace-free literal prefix before
 * scanning (`dd of=`).
 *
 * PER-SITE bash semantics (final-critic GT, executed bash 5.x — the choice
 * is documented per site because the branches' write behavior differs):
 * - `tee` positionals, `truncate`/`rmdir` operands: bash writes EVERY
 *   expanded operand — the per-branch emission is bash-EXACT.
 * - `cp`/`mv`/`install`/`ln` destination: a ≥2-branch destination makes the
 *   command fail ("target is not a directory", no write). The per-branch
 *   emission is a deliberate conservative over-approximation: it denies
 *   when any branch escapes and admits when every branch is in scope (a
 *   superset of bash's no-write), rather than modeling the refusal.
 * - `dd of=`: bash keeps only the LAST expanded `of=` operand — which can
 *   itself be the escaping branch (GT: `dd of=src/{a,../ddesc}` writes the
 *   OUTSIDE file). Emitting every branch is the same conservative
 *   superset: it always covers the branch bash actually writes.
 */
function pushExpandedDestination(
	out: WriteTarget[],
	node: unknown,
	text: string,
	rawSkip: number,
	emit: (path: string) => WriteTarget | null,
	dynamic: () => WriteTarget,
	/** #3590 merge reconciliation: only the dd/tee W8 sites (whose `of=` /
	 * positional word is the ANCHOR token main's F-02 strip was written for)
	 * pass true. The inplace/launcher call sites feed parser-preserved
	 * quoted words whose branch contract reports the RAW word verbatim —
	 * stripping there dequoted operands the branch pins expect quoted
	 * (18 frozen-battery failures). */
	stripOuterQuote = false,
): void {
	const rawBase =
		node && typeof node === 'object'
			? RAW_WORD_TEXT.get(node as object)
			: undefined;
	// #3568 parallel-review F-02 (opt-in): the dd/tee word text can retain
	// its quote wrapper (`"of=../../src/{a,b}"`), and a fully-quoted token
	// never brace-expands (bash keeps the braces literal). Strip a matching
	// outer wrapper first — the literal path slices the DEQUOTED text at
	// rawSkip, and a quoted token takes the no-expansion branch — while a
	// raw token without an outer wrapper keeps the quote-aware engine path.
	const outerQuoted = stripOuterQuote
		? (/^(['"])(.*)\1$/.exec(text) ??
			(rawBase !== undefined ? /^(['"])(.*)\1$/.exec(rawBase) : null))
		: null;
	const dequoted = outerQuoted !== null ? (outerQuoted[2] ?? '') : text;
	const fullyQuoted = outerQuoted !== null;
	const rawText = fullyQuoted ? dequoted : (rawBase ?? text);
	const expansion = fullyQuoted
		? ({ kind: 'none' } as const)
		: expandBraceRaw(rawText.slice(rawSkip));
	if (expansion.kind === 'dynamic') {
		// Unconditional (final-critic F-1): the refusal write must be
		// emitted whatever `emit('')` would do with an empty path — the
		// tee/dd closures return null for falsy paths, and dropping the
		// scaffold here admitted commands whose branches bash writes.
		out.push(dynamic());
		return;
	}
	if (expansion.kind === 'none') {
		// F-02 scoping (final): the mis-slice only bites when rawSkip>0
		// crosses the quote wrapper (dd of=); rawSkip=0 sites (inplace
		// editors, tee) keep the quote-wrapped emission the resolver and the
		// shipped pins expect.
		const target = emit(
			fullyQuoted && rawSkip > 0
				? dequoted.slice(rawSkip)
				: text.slice(rawSkip),
		);
		if (target !== null) out.push(target);
		return;
	}
	for (const branch of expansion.branches) {
		const target = emit(branch);
		if (target !== null) out.push(target);
	}
}

// ============================================================================
// Per-manual launcher option grammar (#3491 W3)
// ============================================================================

/**
 * Outcome of walking ONE launcher's own option region over the words that
 * follow the launcher word (#3491 W3). Single source of truth for BOTH the
 * destructive arm's wrapper strip (destructive-command.ts consumes
 * {@link walkLauncherOptions} through the shared word list) and the write
 * arm's leaf walk (`detectorCommandPartsFromWords` delegates here).
 *
 * - `inner`: an execution tail exists — the wrapped command starts at
 *   `innerIndex` (0-based into the words the walk received). `timeOutputFile`
 *   carries the GNU `-o FILE` timing-report destination when present (an
 *   ADDITIONAL write target, emitted by detectLauncherWrites).
 * - `benign`: nothing executes (query modes, option-only invocations,
 *   `--help`). The caller must NOT unwrap and must not deny.
 * - `edit`: `sudo -e` — the operands from `editStartIndex` are EDIT TARGETS
 *   (write-class), not an execution tail.
 * - `interactive`: `sudo -i`/`-s` with no command word — an interactive root
 *   shell. The gate denies (fail-closed; the plan round-2 mode boundary).
 * - `uncertain`: an unknown option cluster with remaining words — "every
 *   remaining word is a potential execution tail" from `tailIndex`
 *   (deny-on-uncertainty; `tailIndex` beyond the last word means benign).
 */
export type LauncherWalkOutcome =
	| {
			kind: 'inner';
			innerIndex: number;
			timeOutputFile?: string;
			/** sudo -D/--chdir operand (first wins) — the W2 chdir composition. */
			sudoChdir?: string;
			/**
			 * #3572 delta: for a NESTED GNU `time -o` outcome under sudo, the
			 * word index matchSudoChdir should slice `rest` from (the nested
			 * `time` word, so the rewritten subshell keeps the timed launcher
			 * and its -o operand inside the child cwd) — the plain innerIndex
			 * points past it at the timed command.
			 */
			chdirTailIndex?: number;
	  }
	| { kind: 'benign' }
	| {
			kind: 'edit';
			editStartIndex: number;
			/**
			 * #3588 item 4 (Fix 5): sudo -D/--chdir operand captured when the
			 * edit outcome was decided — RELATIVE edit targets resolve under it
			 * (sudoedit re-bases them on the chdir directory; absolute targets
			 * are unaffected and stay absolute).
			 */
			sudoChdir?: string;
	  }
	| { kind: 'interactive' }
	| { kind: 'uncertain'; tailIndex: number };

/**
 * sudo(8) (1.9.x) short-option members, grouped by the mode table of
 * 05-fix-plan W3 (doc-sourced; the Windows host's sudo 1.0.1 prints no
 * option list — "Sudo is disabled" — so the binding source is the manual):
 * - argument-less execution options (transparent, skippable):
 *   -E --preserve-env, -n --non-interactive, -b --background, -B --bell,
 *   -A --askpass, -H --set-home, -P --preserve-groups, -S --stdin,
 *   -k --reset-timestamp (the tail still executes after a timestamp reset).
 * - query modes (non-execution; -l is documented with an optional [command]
 *   it only LISTS for): -l --list, -v --validate, -V --version,
 *   -K --remove-timestamp, -L --list-defaults.
 * - interactive modes: -i --login, -s --shell.
 * - edit mode: -e --edit (operands are edit targets — write-class).
 * - argument-taking (each consumes one argument; -D is the chdir option the
 *   W2 structured transform handles, -R chroots and keeps executing):
 *   -u --user, -g --group, -p --prompt, -r --role, -t --type (the task's
 *   binding arg-taking set), plus -C --close-from, -T --command-timeout,
 *   -U --other-user, -D --chdir, -R --chroot per sudo(8).
 * - `-h` is deliberately UNKNOWN: sudo(8) documents both `-h, --help` and
 *   `-h host` (the -l/run synopses), and the host form EXECUTES the command
 *   on another machine — deny-on-uncertainty is the only safe reading.
 */
const SUDO_ARGLESS_EXEC_CHARS = new Set([...'EnBbBAHPSk']);
const SUDO_QUERY_CHARS = new Set([...'lvVKL']);
const SUDO_INTERACTIVE_CHARS = new Set([...'is']);
const SUDO_ARG_TAKING_SHORT = new Set([...'ugprtCTUDR']);
const SUDO_LONG_ARGLESS_EXEC = new Set([
	'--preserve-env',
	'--non-interactive',
	'--background',
	'--bell',
	'--askpass',
	'--set-home',
	'--preserve-groups',
	'--stdin',
	'--reset-timestamp',
]);
const SUDO_LONG_QUERY = new Set([
	'--list',
	'--validate',
	'--version',
	'--remove-timestamp',
	'--list-defaults',
	'--help',
]);
const SUDO_LONG_INTERACTIVE = new Set(['--login', '--shell']);
const SUDO_LONG_ARG_TAKING = [
	'--user',
	'--group',
	'--prompt',
	'--role',
	'--type',
	'--close-from',
	'--command-timeout',
	'--other-user',
	'--chdir',
	'--chroot',
];

/**
 * GNU time(1) (1.9) options for the ABSOLUTE-path spelling; the bare `time`
 * word is the bash KEYWORD, which accepts only POSIX `-p` (ground-truthed on
 * bash 5.3.9: `time -v cmd` runs the COMMAND `-v` — an unrecognized dash word
 * IS the timed command word). GNU binary options (doc-sourced from GNU time
 * 1.9, `info time`): -p/--portability, -v/--verbose, -q/--quiet, -i/--idle,
 * -h/--help, -V/--version (all argument-less); -a/--append (argument-less,
 * only modifies -o); -f FORMAT/--format=FORMAT and -o FILE/--output=FILE
 * (argument-taking; -o names the timing-report WRITE target).
 */
const TIME_GNU_ARGLESS_CHARS = new Set([...'pvqhiVa']);
const TIME_GNU_ARG_TAKING_CHARS = new Set([...'fo']);
const TIME_GNU_LONG_ARGLESS = new Set([
	'--portability',
	'--verbose',
	'--quiet',
	'--idle',
	'--help',
	'--version',
	'--append',
]);
const TIME_GNU_LONG_ARG_TAKING = ['--format', '--output'];

/** Absolute-path spelling: drive letter or leading separator (either slash). */
function isAbsolutePathSpelling(word: string): boolean {
	return /^([A-Za-z]:[\\/]|[\\/])/.test(word);
}

/**
 * Whether a raw launcher spelling QUOTED or ESCAPED the bare word
 * (#3491 W3 review advisory 1): bash recognizes reserved WORDS like the
 * `time` keyword only in their unquoted, unescaped spelling — `\time`,
 * `'time'`, `"time"` suppress the keyword and PATH-resolve a program instead
 * (ground truth on bash 5.3.9: `\time -p true` → "time: command not found"),
 * so the GNU-binary grammar governs those spellings. True when `raw` differs
 * from the dequoted `word` and equals it after stripping ONE leading
 * backslash or ONE matched quote pair.
 */
function isKeywordSuppressedSpelling(raw: string, word: string): boolean {
	if (raw === word) return false;
	let s = raw;
	if (
		s.length >= 2 &&
		((s.startsWith("'") && s.endsWith("'")) ||
			(s.startsWith('"') && s.endsWith('"')))
	) {
		s = s.slice(1, -1);
	} else if (s.startsWith('\\')) {
		s = s.slice(1);
	} else {
		return false;
	}
	return s === word;
}

/**
 * Walk one launcher's option region (#3491 W3). `launcherWord` is the
 * QUOTE-REMOVED word (case preserved — the `time` keyword-vs-GNU-binary
 * distinction is by spelling: an absolute path OR a keyword-suppressing
 * quoted/escaped spelling selects the GNU binary grammar, the bare word is
 * the bash keyword); `rawLauncherWord` carries the pre-quote-removal
 * spelling when the caller can see it (the DC offset splitter and the AST
 * raw-word map). `words` are the words AFTER the launcher word
 * (quote-removed). Returns null when the launcher word is not one of
 * sudo/time/nice/nohup.
 */
export function walkLauncherOptions(
	launcherWord: string,
	words: readonly string[],
	rawLauncherWord?: string,
): LauncherWalkOutcome | null {
	const base = basenameAnySep(launcherWord);
	if (base === 'sudo') return walkSudoOptions(words);
	if (base === 'time') {
		// #3572 N-03: keyword-suppression must be PROVEN by a defined raw
		// spelling — when the caller cannot supply one (dequoted chain words
		// in the leaf walk), the GNU binary grammar wins. The GNU grammar
		// detects the `-o` write target where the keyword grammar emits
		// nothing, so the unresolved case is deny-direction (an
		// over-approximated launcher_write, never a lost one).
		const binaryGrammar =
			isAbsolutePathSpelling(launcherWord) ||
			rawLauncherWord === undefined ||
			isKeywordSuppressedSpelling(rawLauncherWord, launcherWord);
		return binaryGrammar
			? walkGnuTimeOptions(words)
			: walkKeywordTimeOptions(words);
	}
	if (base === 'nice') return walkNiceOptions(words);
	if (base === 'nohup') return walkNohupOptions(words);
	return null;
}

/** Whether `token` is a glued `--flag=value` spelling of a long flag. */
function splitGluedLong(
	token: string,
): { head: string; value: string | null } | null {
	if (!token.startsWith('--') || token.length < 4) return null;
	const eq = token.indexOf('=');
	if (eq === -1) return { head: token, value: null };
	if (eq < 3) return null; // `--=x` nonsense
	return { head: token.slice(0, eq), value: token.slice(eq + 1) };
}

/**
 * Long-option arg-taking match: exact membership, or a glued `--flag=value`,
 * or (GNU getopt) an UNAMBIGUOUS prefix abbreviation of length ≥ 3 — the
 * same rule envFlagConsumesNextWord applies for env. `flag` names the
 * matched canonical flag so callers can distinguish --output from --format.
 */
function longFlagTakesArg(
	token: string,
	argTaking: readonly string[],
): {
	takes: boolean;
	glued: boolean;
	value: string | null;
	flag: string | null;
} {
	for (const flag of argTaking) {
		if (token === flag) return { takes: true, glued: false, value: null, flag };
	}
	const glued = splitGluedLong(token);
	if (glued && argTaking.includes(glued.head))
		return { takes: true, glued: true, value: glued.value, flag: glued.head };
	const matches = argTaking.filter((flag) => flag.startsWith(token));
	if (token.length >= 3 && matches.length === 1) {
		return { takes: true, glued: false, value: null, flag: matches[0] ?? null };
	}
	return { takes: false, glued: false, value: null, flag: null };
}

/**
 * #3572 delta-critic: ONE launcher nesting another (`sudo time -o FILE
 * cmd`) — sudo/nice/nohup EXEC the inner command directly (no shell), so a
 * `time` inner word IS the GNU binary regardless of spelling; walk its
 * option grammar for the `-o` outcome, adjusting the inner index past the
 * nested launcher word. Returns null when the inner word is not `time` or
 * the GNU walk finds no timed tail (plain `sudo time true` keeps the
 * original outcome).
 */
function nestedTimeTail(
	words: readonly string[],
	innerIndex: number,
): { innerIndex: number; timeOutputFile: string } | null {
	if (basenameAnySep(words[innerIndex] ?? '') !== 'time') return null;
	const gnu = walkGnuTimeOptions(words.slice(innerIndex + 1));
	if (
		gnu.kind !== 'inner' ||
		gnu.timeOutputFile === undefined ||
		gnu.timeOutputFile === ''
	) {
		return null;
	}
	return {
		innerIndex: innerIndex + 1 + gnu.innerIndex,
		timeOutputFile: gnu.timeOutputFile,
	};
}

/**
 * #3588 item 3 (Fix 4): under `-i`/`-s`, sudo runs the command words through
 * the login shell as `shell -c "<words joined by spaces>"` — a tail word that
 * carries whitespace or shell-operator structure AFTER quote removal is
 * re-parsed as shell syntax by that join, which the static per-word walk
 * cannot judge. Conservative deny on ANY such word of the execution tail
 * (not only the first); genuinely plain multiword tails (`sudo -i make
 * build`, every word a bare word) keep the per-word judged 'inner' outcome.
 */
function interactiveTailDeniesOnRejoin(
	words: readonly string[],
	startIndex: number,
): boolean {
	for (let w = startIndex; w < words.length; w += 1) {
		const word = words[w];
		if (word === undefined) break;
		// Whitespace or an operator/quote character the re-joined string
		// would read unquoted (a leading `#` starts a comment there too).
		// PR #3615 feedback PRR-001: `$`, `{`, `}`, `,` are also rejoin-
		// dangerous — parameter/brace expansion synthesizes word separators
		// and operators at runtime (`touch${IFS}esc.txt`, `{rm,-rf,../outside}`)
		// with NO literal operator in the word, so any expansion-bearing or
		// brace-bearing tail word is unjudgeable here and fails closed.
		if (/[\s;|&<>()`'"${},]/.test(word) || word.startsWith('#')) return true;
	}
	return false;
}

function walkSudoOptions(words: readonly string[]): LauncherWalkOutcome {
	let i = 0;
	let edit = false;
	let interactive = false;
	let listMode = false;
	let queryOther = false;
	// #3572 delta-critic: `-k` alone (credential reset) is the documented
	// no-command NO-OP; any other execution option implies the root shell.
	let resetOnly = true;
	let execOrResetSeen = false;
	let chdirDir: string | undefined;
	while (i < words.length) {
		const token = words[i];
		if (token === undefined) break;
		if (token === '--') {
			// End of sudo's options; the wrapped command follows.
			// #3572 N-01: an accumulated `-e`/`--edit` survives `--` — the
			// edit outcome must be checked BEFORE the generic inner return
			// or `sudo -e -- FILE` loses its write classification entirely.
			if (edit) {
				return i + 1 < words.length
					? {
							kind: 'edit',
							editStartIndex: i + 1,
							...(chdirDir !== undefined ? { sudoChdir: chdirDir } : {}),
						}
					: { kind: 'benign' };
			}
			if (i + 1 >= words.length) {
				// #3572 delta-critic: a command-less `sudo --` is getopt-
				// identical to bare sudo (the `--` tokens stay in argv, so
				// parse_args.c still reaches argc==0 and fires the implied
				// interactive root shell) — the SAME end-of-walk decision
				// applies, with the query/reset carve-outs.
				if (listMode) return { kind: 'benign' };
				if (queryOther) return { kind: 'benign' };
				if (resetOnly && execOrResetSeen && !interactive) {
					return { kind: 'benign' };
				}
				return { kind: 'interactive' };
			}
			if (listMode) return { kind: 'benign' };
			if (queryOther) return { kind: 'uncertain', tailIndex: i + 1 };
			// #3588 item 3 (Fix 4): under -i/-s, a post-`--` tail word the
			// login shell's `-c` rejoin would parse as shell structure is
			// unjudgeable — deny as interactive instead of returning 'inner'.
			if (interactive && interactiveTailDeniesOnRejoin(words, i + 1)) {
				return { kind: 'interactive' };
			}
			// #3572 delta review: parse_args.c BLOCKS env consumption after
			// the sentinel (got_end_of_args) — post-`--` VAR=value words are
			// the literal command, so no assignment scan here.
			// #3572 delta-critic: the nested GNU `time` lookup runs on the
			// post-`--` word exactly like the non-sentinel path.
			const nested = nestedTimeTail(words, i + 1);
			if (nested !== null) {
				return {
					kind: 'inner',
					innerIndex: nested.innerIndex,
					timeOutputFile: nested.timeOutputFile,
					chdirTailIndex: i + 1,
					...(chdirDir !== undefined ? { sudoChdir: chdirDir } : {}),
				};
			}
			return {
				kind: 'inner',
				innerIndex: i + 1,
				...(chdirDir !== undefined ? { sudoChdir: chdirDir } : {}),
			};
		}
		if (token.startsWith('--') && token.length > 2) {
			const arg = longFlagTakesArg(token, SUDO_LONG_ARG_TAKING);
			if (arg.takes) {
				if (arg.glued) {
					if (arg.flag === '--chdir' && chdirDir === undefined)
						chdirDir = arg.value ?? undefined;
					i += 1;
					continue;
				}
				if (i + 1 >= words.length) return { kind: 'benign' };
				if (arg.flag === '--chdir' && chdirDir === undefined)
					chdirDir = words[i + 1];
				i += 2;
				continue;
			}
			if (SUDO_LONG_ARGLESS_EXEC.has(token)) {
				execOrResetSeen = true;
				if (token !== '--reset-timestamp') resetOnly = false;
				i += 1;
				continue;
			}
			if (SUDO_LONG_QUERY.has(token)) {
				listMode = listMode || token === '--list';
				queryOther = queryOther || token !== '--list';
				i += 1;
				continue;
			}
			if (SUDO_LONG_INTERACTIVE.has(token)) {
				interactive = true;
				i += 1;
				continue;
			}
			if (token === '--edit') {
				edit = true;
				i += 1;
				continue;
			}
			return { kind: 'uncertain', tailIndex: i + 1 };
		}
		if (token.startsWith('-') && token.length > 1) {
			// Short cluster, getopt left-to-right: the FIRST arg-taking member
			// either is last (argument = next word) or swallows the token tail.
			const members = token.slice(1);
			let consumedNext = false;
			let mode: 'none' | 'arg' = 'none';
			let argMember = '';
			let argTail = '';
			let unknown = false;
			for (let m = 0; m < members.length; m++) {
				const ch = members[m];
				if (ch === undefined) break;
				if (SUDO_ARG_TAKING_SHORT.has(ch)) {
					mode = 'arg';
					argMember = ch;
					if (m === members.length - 1) {
						consumedNext = true;
					} else {
						argTail = members.slice(m + 1);
					}
					break;
				}
				if (SUDO_ARGLESS_EXEC_CHARS.has(ch)) {
					execOrResetSeen = true;
					if (ch !== 'k') resetOnly = false;
					continue;
				}
				if (SUDO_QUERY_CHARS.has(ch)) {
					listMode = listMode || ch === 'l';
					queryOther = queryOther || ch !== 'l';
					continue;
				}
				if (SUDO_INTERACTIVE_CHARS.has(ch)) {
					interactive = true;
					continue;
				}
				if (ch === 'e') {
					edit = true;
					continue;
				}
				unknown = true;
				break;
			}
			if (unknown) return { kind: 'uncertain', tailIndex: i + 1 };
			i += 1;
			if (mode === 'arg') {
				if (consumedNext) {
					if (i >= words.length) return { kind: 'benign' };
					if (argMember === 'D' && chdirDir === undefined) chdirDir = words[i];
					i += 1; // the argument word
				} else if (argMember === 'D' && chdirDir === undefined) {
					chdirDir = argTail;
				}
			}
			continue;
		}
		// First non-option word. parse_args.c consumes VAR=value words as
		// environment settings and RESUMES getopt after each ("crank optind
		// and resume getopt" — the post-assignment word may be an option or
		// `--`), so an assignment here resumes the option loop; a real
		// command word returns the walk outcome.
		if (edit)
			return {
				kind: 'edit',
				editStartIndex: i,
				...(chdirDir !== undefined ? { sudoChdir: chdirDir } : {}),
			};
		if (listMode) return { kind: 'benign' }; // -l [command]: lists privileges, never executes
		if (queryOther)
			// -v/-V/-K/-L with a trailing command: sudo(8)'s synopsis gives
			// these modes no command operand — deny-on-uncertainty.
			return { kind: 'uncertain', tailIndex: i };
		const firstWord = words[i] ?? '';
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(firstWord)) {
			let j = i;
			while (
				j < words.length &&
				/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[j] ?? '')
			) {
				j += 1;
			}
			if (j >= words.length) {
				// Assignments-only leaves argc==0 → the implied interactive
				// root shell (same decision as bare command-less sudo).
				if (resetOnly && execOrResetSeen && !interactive) {
					return { kind: 'benign' };
				}
				return { kind: 'interactive' };
			}
			// #3572 delta review: assignments are interspersed with options
			// (parse_args.c:284) — resume the option walk instead of
			// treating the next word as the command.
			i = j;
			continue;
		}
		// #3588 item 3 (Fix 4): under -i/-s, a tail word the login shell's
		// `-c` rejoin would parse as shell structure is unjudgeable — deny as
		// interactive instead of returning 'inner' (AC7's sanctioned deny
		// leg; genuinely plain multiword tails keep the judged outcome).
		if (interactive && interactiveTailDeniesOnRejoin(words, i)) {
			return { kind: 'interactive' };
		}
		// #3572 delta-critic: a nested `time` inner word is the GNU binary
		// (sudo execs directly, no shell) — surface its -o outcome.
		const nested = nestedTimeTail(words, i);
		if (nested !== null) {
			return {
				kind: 'inner',
				innerIndex: nested.innerIndex,
				timeOutputFile: nested.timeOutputFile,
				chdirTailIndex: i,
				...(chdirDir !== undefined ? { sudoChdir: chdirDir } : {}),
			};
		}
		return {
			kind: 'inner',
			innerIndex: i,
			...(chdirDir !== undefined ? { sudoChdir: chdirDir } : {}),
		};
	}
	if (edit) return { kind: 'benign' }; // -e with no operand: usage error, nothing runs
	if (listMode) return { kind: 'benign' };
	if (queryOther) return { kind: 'benign' }; // -v/-V/-K alone: never executes
	// `-k` alone (seen, nothing else): the documented no-command no-op.
	// An explicit -i/-s beside it still opens the shell (after the reset).
	if (resetOnly && execOrResetSeen && !interactive) {
		return { kind: 'benign' };
	}
	// #3572 delta-critic: a command-less sudo with no query/reset mode is
	// the IMPLIED INTERACTIVE ROOT SHELL (sudo parse_args.c ground truth —
	// the same NewArgc==0 branch the fragment's N-23 disclosure cites), so
	// it denies exactly like the explicit `sudo -i`; bare execution options
	// alone (`sudo -n`) imply the root shell under parse_args.c too — deny.
	return { kind: 'interactive' };
}

function walkKeywordTimeOptions(words: readonly string[]): LauncherWalkOutcome {
	// bash keyword (ground truth, bash 5.3.9): ONLY -p exists; any other dash
	// word IS the command word of the timed pipeline (`time -v cmd` → "command
	// not found: -v"). The keyword has no `--`.
	let i = 0;
	while (i < words.length && words[i] === '-p') i++;
	return i < words.length
		? { kind: 'inner', innerIndex: i }
		: { kind: 'benign' };
}

function walkGnuTimeOptions(words: readonly string[]): LauncherWalkOutcome {
	let i = 0;
	let timeOutputFile: string | undefined;
	while (i < words.length) {
		const token = words[i];
		if (token === undefined) break;
		if (token === '--') {
			return i + 1 < words.length
				? { kind: 'inner', innerIndex: i + 1, timeOutputFile }
				: { kind: 'benign' };
		}
		if (token.startsWith('--') && token.length > 2) {
			const arg = longFlagTakesArg(token, TIME_GNU_LONG_ARG_TAKING);
			if (arg.takes) {
				if (arg.glued) {
					if (arg.flag === '--output' && arg.value !== null)
						timeOutputFile = arg.value;
					i += 1;
					continue;
				}
				if (i + 1 >= words.length) return { kind: 'benign' };
				if (arg.flag === '--output') timeOutputFile = words[i + 1];
				i += 2;
				continue;
			}
			if (TIME_GNU_LONG_ARGLESS.has(token)) {
				i += 1;
				continue;
			}
			return { kind: 'uncertain', tailIndex: i + 1 };
		}
		if (token.startsWith('-') && token.length > 1) {
			const members = token.slice(1);
			let outputFlag = false;
			let consumedNext = false;
			let mode: 'none' | 'arg' = 'none';
			let unknown = false;
			for (let m = 0; m < members.length; m++) {
				const ch = members[m];
				if (ch === undefined) break;
				if (TIME_GNU_ARG_TAKING_CHARS.has(ch)) {
					mode = 'arg';
					outputFlag = ch === 'o';
					if (m === members.length - 1) consumedNext = true;
					// Attached tail is the argument (glued `-oFILE` / `-fFMT`).
					if (!consumedNext && outputFlag)
						timeOutputFile = members.slice(m + 1);
					break;
				}
				if (TIME_GNU_ARGLESS_CHARS.has(ch)) continue;
				unknown = true;
				break;
			}
			if (unknown) return { kind: 'uncertain', tailIndex: i + 1 };
			i += 1;
			if (mode === 'arg' && consumedNext) {
				if (i >= words.length) return { kind: 'benign' };
				if (outputFlag) timeOutputFile = words[i];
				i += 1;
			}
			continue;
		}
		return {
			kind: 'inner',
			innerIndex: i,
			...(timeOutputFile !== undefined ? { timeOutputFile } : {}),
		};
	}
	// Options with no command: GNU time reports "missing command" and runs
	// nothing (rc 1) — benign.
	return { kind: 'benign' };
}

function walkNiceOptions(words: readonly string[]): LauncherWalkOutcome {
	let i = 0;
	while (i < words.length) {
		const token = words[i];
		if (token === undefined) break;
		if (token === '--') {
			if (i + 1 >= words.length) return { kind: 'benign' };
			// #3572 delta-critic: the nested GNU `time` lookup runs on the
			// post-`--` word exactly like the non-sentinel path (sudo/nice/nohup
			// exec the inner command directly — `--` does not stop it).
			const nested = nestedTimeTail(words, i + 1);
			if (nested !== null) {
				return {
					kind: 'inner',
					innerIndex: nested.innerIndex,
					timeOutputFile: nested.timeOutputFile,
				};
			}
			return { kind: 'inner', innerIndex: i + 1 };
		}
		if (token === '--help' || token === '--version') return { kind: 'benign' };
		// GNU nice(1): -n N / --adjustment=N / --adjustment N, plus the legacy
		// ATTACHED adjustment spelling `-N` / `+N` (ground-truthed: `nice -10
		// cmd` adjusts by 10 and runs cmd).
		if (token === '-n' || token === '--adjustment') {
			if (i + 1 >= words.length) return { kind: 'benign' };
			i += 2;
			continue;
		}
		if (/^--adjustment=/.test(token)) {
			i += 1;
			continue;
		}
		if (/^-n\d+$/.test(token) || /^[-+]\d+$/.test(token)) {
			i += 1;
			continue;
		}
		if (token.startsWith('-') && token.length > 1) {
			return { kind: 'uncertain', tailIndex: i + 1 };
		}
		// #3572 delta-critic: a nested `time` inner word is the GNU binary
		// (nice execs directly, no shell) — surface its -o outcome.
		const nested = nestedTimeTail(words, i);
		if (nested !== null) {
			return {
				kind: 'inner',
				innerIndex: nested.innerIndex,
				timeOutputFile: nested.timeOutputFile,
			};
		}
		return { kind: 'inner', innerIndex: i };
	}
	// No operands: prints the current niceness (read-only).
	return { kind: 'benign' };
}

function walkNohupOptions(words: readonly string[]): LauncherWalkOutcome {
	// GNU nohup(1) takes NO options (ground-truthed --help output); bare and
	// `--` are transparent. nohup.out creation is stdout-tty-gated and outside
	// static reach — DISCLOSED, not modeled. Any other dash-led word is
	// treated as deny-on-uncertainty (the plan's binding; real nohup would
	// exec a program literally named `-x`).
	const i = 0;
	while (i < words.length) {
		const token = words[i];
		if (token === undefined) break;
		if (token === '--') {
			if (i + 1 >= words.length) return { kind: 'benign' };
			// #3572 delta-critic: the nested GNU `time` lookup runs on the
			// post-`--` word exactly like the non-sentinel path (sudo/nice/nohup
			// exec the inner command directly — `--` does not stop it).
			const nested = nestedTimeTail(words, i + 1);
			if (nested !== null) {
				return {
					kind: 'inner',
					innerIndex: nested.innerIndex,
					timeOutputFile: nested.timeOutputFile,
				};
			}
			return { kind: 'inner', innerIndex: i + 1 };
		}
		if (token === '--help' || token === '--version') return { kind: 'benign' };
		if (token.startsWith('-') && token.length > 1) {
			return { kind: 'uncertain', tailIndex: i + 1 };
		}
		// #3572 delta-critic: a nested `time` inner word is the GNU binary
		// (nohup execs directly, no shell) — surface its -o outcome.
		const nested = nestedTimeTail(words, i);
		if (nested !== null) {
			return {
				kind: 'inner',
				innerIndex: nested.innerIndex,
				timeOutputFile: nested.timeOutputFile,
			};
		}
		return { kind: 'inner', innerIndex: i };
	}
	return { kind: 'benign' };
}

/**
 * Canonical detector command model (#3474): classify write-vector commands
 * through their canonical spelling so versioned (`curl8.5`, `bzip2.5`),
 * path-qualified (`/usr/bin/curl`), and execution-wrapper-prefixed
 * (`command rmdir`, `env -u X curl`) invocations cannot sidestep detection.
 *
 * The wrapper walk is EXECUTION-ONLY and shared conceptually with the dc
 * unwrap layer: `command -v` / `-V` (standalone or glued) are QUERY forms
 * and abort the walk — the canonical name stays `command`, which is no set
 * member — while `command [-p]`, `builtin`, `exec [-c|-l|-a NAME]` and `env`
 * (own flags consumed exactly like canonicalInterpreterName's env hop) are
 * transparent. This deliberately diverges from canonicalInterpreterName's
 * generic dash-skip (which would canonicalize `command -v rmdir …` into a
 * write); the plan critic's round-2 blocker 1.
 */
function isQueryFlag(token: string): boolean {
	// `-v` / `-V` alone or glued into a short cluster (`-pv`, `-vp`).
	if (token === '-v' || token === '-V') return true;
	return /^-[pvVP]+$/.test(token) && /[vV]/.test(token);
}

/**
 * Walk execution-only wrappers over the suffix words and return the leaf of
 * the real command word (canonical basename, `.exe` stripped, lowercased).
 * Returns the wrapper itself when a query form or a malformed hop appears.
 */
function detectorCommandLeaf(cmd: unknown): string {
	return detectorCommandParts(cmd).leaf;
}

/**
 * Case-preserving sibling of {@link detectorCommandLeaf} — the resolved real
 * command's basename with its original spelling kept. Dedupe operators use
 * this so wrapper spellings collapse onto the real command (PRR-008) without
 * also collapsing case-distinct commands into each other.
 */
function detectorCommandRawLeaf(cmd: unknown): string {
	return detectorCommandPartsFromWords(getCommandName(cmd), getSuffixWords(cmd))
		.rawLeaf;
}

/**
 * #3485 (PRR-006): the canonical leaf PLUS the unconsumed token tail after
 * the transparent wrapper chain — `env python` yields leaf 'python' with an
 * EMPTY tail, which is what stdin-shape checks must inspect (the raw suffix
 * still holds the wrapper word and would defeat the wrapper-aware lookup).
 */
function detectorCommandParts(cmd: unknown): { leaf: string; rest: string[] } {
	const suffix = getSuffixWords(cmd);
	return {
		leaf: detectorCommandLeafFromWords(getCommandName(cmd), suffix),
		rest: suffix,
	};
}

function detectorCommandLeafFromWords(
	cmdName: string | null | undefined,
	suffix: string[],
): string {
	return detectorCommandPartsFromWords(cmdName, suffix).leaf;
}

/**
 * Paranoid absolute bound for the wrapper-chain walk (#3491 W3): every loop
 * iteration consumes at least one word, so the cursor alone terminates the
 * loop (no fixed cap re-opens a depth-N+1 bypass — the hop-8 cap let
 * `command`x14 hide a write). 64 stands in for "absurdly nested but
 * machine-generatable"; exceedance FAILS CLOSED through the additive
 * `unwrapDepthExceeded` analysis flag the gate and explain consult before
 * every no-write early return.
 */
export const DETECTOR_UNWRAP_PARANOID_BOUND = 64;

interface DetectorCommandParts {
	leaf: string;
	rest: string[];
	rawLeaf: string;
	depthExceeded: boolean;
}

function detectorCommandPartsFromWordsBounded(
	cmdName: string | null | undefined,
	suffix: string[],
): DetectorCommandParts {
	let name = cmdName;
	if (!name)
		return { leaf: '', rest: suffix, rawLeaf: '', depthExceeded: false };
	let cursor = 0;
	for (let hop = 0; ; hop++) {
		if (hop >= DETECTOR_UNWRAP_PARANOID_BOUND) {
			// Paranoid bound exceeded: the wrapper chain is machine-generated
			// depth abuse. Report it so consumers fail closed (the flag is the
			// channel; the leaf is the last resolved name).
			return {
				leaf: basenameAnySep(name),
				rest: suffix.slice(cursor),
				rawLeaf: basenameAnySepCase(name),
				depthExceeded: true,
			};
		}
		const base = basenameAnySep(name);
		const rawBase = basenameAnySepCase(name);
		if (
			base !== 'env' &&
			base !== 'command' &&
			base !== 'builtin' &&
			base !== 'exec' &&
			base !== 'sudo' &&
			base !== 'time' &&
			base !== 'nice' &&
			base !== 'nohup'
		) {
			return {
				leaf: base,
				rest: suffix.slice(cursor),
				rawLeaf: rawBase,
				depthExceeded: false,
			};
		}
		// Consume the wrapper's own tokens before the wrapped command name.
		if (base === 'env') {
			while (cursor < suffix.length) {
				const token = suffix[cursor];
				if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
					cursor++;
					continue;
				}
				if (token.startsWith('-') && token !== '-') {
					cursor++;
					if (envFlagConsumesNextWord(token) && cursor < suffix.length)
						cursor++;
					continue;
				}
				break;
			}
		} else if (base === 'command') {
			while (cursor < suffix.length && suffix[cursor] === '-p') cursor++;
			if (cursor < suffix.length && isQueryFlag(suffix[cursor])) {
				// Query form (`command -v NAME …`): never an execution wrapper.
				return {
					leaf: base,
					rest: suffix.slice(cursor),
					rawLeaf: rawBase,
					depthExceeded: false,
				};
			}
			if (cursor < suffix.length && suffix[cursor] === '--') cursor++;
		} else if (base === 'builtin') {
			// #3485 (PRR-015): `builtin rm …` errors in bash ("not a shell
			// builtin") and runs nothing for every external command — only
			// unwrap when the wrapped name is a real builtin; anything else
			// stays at the `builtin` leaf (correctly no write detected).
			if (cursor < suffix.length) {
				const wrapped = basenameAnySep(suffix[cursor]);
				if (!BASH_BUILTIN_COMMANDS.has(wrapped))
					return {
						leaf: base,
						rest: suffix.slice(cursor),
						rawLeaf: rawBase,
						depthExceeded: false,
					};
			}
			if (cursor < suffix.length && suffix[cursor] === '--') cursor++;
		} else if (base === 'exec') {
			while (cursor < suffix.length && /^-[cl]$/.test(suffix[cursor])) cursor++;
			if (cursor < suffix.length && suffix[cursor] === '-a') cursor += 2;
			// #3485 (PRR-015): glued `-aNAME` and pure `-cl`/`-lc` clusters
			// (bash internal_getopt) execute the wrapped command.
			if (cursor < suffix.length && /^-a\S+$/.test(suffix[cursor])) cursor++;
			if (cursor < suffix.length && /^-[cl]{2,}$/.test(suffix[cursor]))
				cursor++;
			if (cursor < suffix.length && suffix[cursor] === '--') cursor++;
		} else {
			// #3491 W3: sudo/time/nice/nohup unwrap through the shared
			// per-manual launcher table (walkLauncherOptions).
			const walk = walkLauncherOptions(name, suffix.slice(cursor));
			if (walk === null || walk.kind === 'benign') {
				// Benign/query forms execute nothing: stay at the launcher leaf
				// (no set member — no detection), the deny channels handle the
				// rest.
				return {
					leaf: base,
					rest: suffix.slice(cursor),
					rawLeaf: rawBase,
					depthExceeded: false,
				};
			}
			if (walk.kind === 'edit' || walk.kind === 'interactive') {
				// sudo -e operands are WRITE targets emitted by
				// detectLauncherWrites; sudo -i/-s alone is denied through the
				// launcher-uncertainty channel. No execution leaf here.
				return {
					leaf: base,
					rest: suffix.slice(cursor),
					rawLeaf: rawBase,
					depthExceeded: false,
				};
			}
			// inner / uncertain-with-tail: the potential execution tail starts
			// at the walked index (every remaining word is a potential tail on
			// uncertainty — deny-on-uncertainty DIRECTION: classify more). The
			// common tail below advances name/cursor onto the tail word.
			const tailIndex =
				walk.kind === 'inner' ? walk.innerIndex : walk.tailIndex;
			const next = cursor + tailIndex;
			if (next >= suffix.length)
				return {
					leaf: base,
					rest: suffix.slice(cursor),
					rawLeaf: rawBase,
					depthExceeded: false,
				};
			cursor = next;
		}
		if (cursor >= suffix.length)
			return {
				leaf: base,
				rest: suffix.slice(cursor),
				rawLeaf: rawBase,
				depthExceeded: false,
			};
		// Advance to the wrapped command's name word.
		name = suffix[cursor];
		cursor++;
		if (!name)
			return {
				leaf: base,
				rest: suffix.slice(cursor - 1),
				rawLeaf: rawBase,
				depthExceeded: false,
			};
	}
}

function detectorCommandPartsFromWords(
	cmdName: string | null | undefined,
	suffix: string[],
): { leaf: string; rest: string[]; rawLeaf: string } {
	const { leaf, rest, rawLeaf } = detectorCommandPartsFromWordsBounded(
		cmdName,
		suffix,
	);
	return { leaf, rest, rawLeaf };
}

/**
 * #3491 W3: launcher-owned WRITE targets — the two launcher options that
 * write files by themselves:
 *   - `sudo -e FILE…` / `sudo --edit FILE…`: the operands are EDIT TARGETS
 *     (sudo(8); the editor runs as root against each file).
 *   - GNU `time -o FILE` (`/usr/bin/time` absolute spelling, --output=FILE
 *     and glued/spaced/abbreviated forms per the shared walk): the timing
 *     report is written to FILE (an ADDITIONAL write target beside whatever
 *     the timed command does; `-a` only switches it to append).
 * The chain walk mirrors the wrapper consumption grammar (env/command/
 * builtin/exec prefixes may precede the launcher) so `env FOO=1 sudo -e f`
 * emits the same targets.
 */
/**
 * Raw (quote-preserving) text of a command's NAME word when the AST carries
 * it (annotateRawWordText populates RAW_WORD_TEXT for Word nodes, including
 * the name node): `\time`/`'time'` are distinguishable from the bare keyword
 * spelling here, routing the launcher grammar (#3491 W3 review advisory 1).
 * Null when the raw slice is unavailable — callers then keep the dequoted
 * spelling only.
 */
function rawCommandName(cmd: unknown): string | null {
	if (!cmd || typeof cmd !== 'object') return null;
	const name = (cmd as BashCommand).name;
	if (name && typeof name === 'object') {
		const raw = RAW_WORD_TEXT.get(name);
		if (raw !== undefined) return raw;
	}
	return null;
}

function detectLauncherWrites(cmd: unknown): WriteTarget[] {
	const results: WriteTarget[] = [];
	const firstName = getCommandName(cmd);
	if (!firstName) return results;
	const suffix = getSuffixWords(cmd);
	// Suffix NODES carry the raw word slices the W8 engine needs (the
	// #3491 closure round-3 terminal literal-emitter site: launcher_write
	// destinations route through pushExpandedDestination like every other
	// destination family).
	const suffixNodes = (
		Array.isArray((cmd as BashCommand).suffix)
			? ((cmd as BashCommand).suffix as unknown[])
			: []
	).filter((s) => wordText(s) !== null);
	// The FIRST word keeps its raw spelling (keyword-suppression routing);
	// deeper chain words are only available dequoted.
	const firstRaw = rawCommandName(cmd) ?? undefined;
	let name: string | null = firstName;
	let nameRaw = firstRaw;
	let cursor = 0;
	for (let hop = 0; hop < DETECTOR_UNWRAP_PARANOID_BOUND; hop++) {
		if (!name) return results;
		const base = basenameAnySep(name);
		// #3572 delta-critic: nice/nohup carry nested-time outcomes too (the
		// walks surface a nested GNU `time -o`); include them in the
		// launcher-write emission gate.
		if (
			base === 'sudo' ||
			base === 'time' ||
			base === 'nice' ||
			base === 'nohup'
		) {
			const walk = walkLauncherOptions(name, suffix.slice(cursor), nameRaw);
			if (walk?.kind === 'edit') {
				// #3588 item 4 (Fix 5): -D/--chdir re-bases RELATIVE edit
				// targets under the chdir directory (sudoedit semantics);
				// ABSOLUTE or drive-qualified operands are emitted UNCHANGED —
				// path.join would fabricate in-scope targets for
				// `sudo -D src -e /etc/passwd` while real sudoedit ignores -D
				// for absolute paths. The qualification lives INSIDE the
				// expanded-branch emitter so brace behavior stays per-branch.
				// PR #3615 feedback PRR-015 (Copilot): TILDE-leading operands
				// are also emitted unchanged — joining would bury the leading
				// `~` inside the chdir (`src/~/shadow`), hiding it from the
				// dynamic-path marker and admitting an out-of-workspace
				// sudoedit target as a literal in-scope path; unqualified,
				// the raw `~`-leading operand is flagged dynamic (fail
				// closed), matching sudo's home-relative sudoedit semantics.
				const sudoChdir = walk.sudoChdir;
				const qualifyChdir = (operandPath: string): string =>
					sudoChdir !== undefined &&
					operandPath !== '' &&
					!isAbsolutePathSpelling(operandPath) &&
					!operandPath.startsWith('~')
						? path.join(sudoChdir, operandPath)
						: operandPath;
				// sudo -e operands are EDIT TARGETS (write-class) — each one
				// expands per-branch (bash hands sudo every expanded word);
				// refusal classes land on the unconditional dynamic() path.
				for (let t = cursor + walk.editStartIndex; t < suffix.length; t++) {
					const operand = suffix[t];
					if (operand === undefined || operand === '') continue;
					pushExpandedDestination(
						results,
						suffixNodes[t],
						operand,
						0,
						(branchPath) => ({
							category: 'launcher_write',
							operator: 'sudo -e',
							path: qualifyChdir(branchPath),
						}),
						() => ({
							category: 'launcher_write',
							operator: 'sudo -e',
							path: null,
							dynamicSourceWord: operand,
						}),
					);
				}
			} else if (
				walk?.kind === 'inner' &&
				walk.timeOutputFile !== undefined &&
				walk.timeOutputFile !== ''
			) {
				// GNU time -o FILE: the timing-report destination expands
				// per-branch too — the glued -osrc/{a,../esc} is two -o
				// spellings with getopt FILE-option last-wins (the same
				// rationale the wget site accepted). The walk returns the
				// dequoted tail only; the engine judges it on that text
				// (quoted-brace false expansion is the deny direction).
				pushExpandedDestination(
					results,
					undefined,
					walk.timeOutputFile,
					0,
					(path) => ({
						category: 'launcher_write',
						operator: 'time -o',
						path,
					}),
					() => ({
						category: 'launcher_write',
						operator: 'time -o',
						path: null,
						dynamicSourceWord: walk.timeOutputFile as string,
					}),
				);
			}
			// #3588 item 1 (Fix 2): a launcher walk whose execution tail HEADS
			// with another launcher hops one level deeper instead of stopping —
			// `nice sudo time -o src/ok.txt true` previously returned here with
			// no emission (the depth-1 `nestedTimeTail` probe only sees one
			// level). Every hop consumes at least the tail head word, so the
			// DETECTOR_UNWRAP_PARANOID_BOUND loop stays structurally
			// terminating. All other outcome kinds (benign/interactive/
			// uncertain/edit, or a non-launcher tail head) keep the return.
			if (walk?.kind === 'inner') {
				const tailWord = suffix[cursor + walk.innerIndex];
				const tailBase = tailWord === undefined ? '' : basenameAnySep(tailWord);
				if (
					tailBase === 'sudo' ||
					tailBase === 'time' ||
					tailBase === 'nice' ||
					tailBase === 'nohup'
				) {
					name = tailWord ?? null;
					// Clear the stale raw launcher spelling — the deeper word
					// has no trusted raw slice (walkLauncherOptions then
					// selects the GNU-binary grammar for a bare `time`,
					// which is the deny direction).
					nameRaw = undefined;
					cursor = cursor + walk.innerIndex + 1;
					continue;
				}
			}
			return results; // non-launcher tail (or a terminal outcome) — stop here
		}
		if (
			base !== 'env' &&
			base !== 'command' &&
			base !== 'builtin' &&
			base !== 'exec'
		) {
			return results;
		}
		// Consume the transparent wrapper's own tokens (same grammar as the
		// bounded leaf walk) and advance to the wrapped word.
		if (base === 'env') {
			while (cursor < suffix.length) {
				const token = suffix[cursor];
				if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
					cursor++;
					continue;
				}
				if (token.startsWith('-') && token !== '-') {
					cursor++;
					if (envFlagConsumesNextWord(token) && cursor < suffix.length)
						cursor++;
					continue;
				}
				break;
			}
		} else if (base === 'command') {
			while (cursor < suffix.length && suffix[cursor] === '-p') cursor++;
			if (cursor < suffix.length && isQueryFlag(suffix[cursor])) return results;
			if (cursor < suffix.length && suffix[cursor] === '--') cursor++;
		} else if (base === 'builtin') {
			if (cursor < suffix.length) {
				const wrapped = basenameAnySep(suffix[cursor]);
				if (!BASH_BUILTIN_COMMANDS.has(wrapped)) return results;
			}
			if (cursor < suffix.length && suffix[cursor] === '--') cursor++;
		} else {
			while (cursor < suffix.length && /^-[cl]$/.test(suffix[cursor])) cursor++;
			if (cursor < suffix.length && suffix[cursor] === '-a') cursor += 2;
			if (cursor < suffix.length && /^-a\S+$/.test(suffix[cursor])) cursor++;
			if (cursor < suffix.length && /^-[cl]{2,}$/.test(suffix[cursor]))
				cursor++;
			if (cursor < suffix.length && suffix[cursor] === '--') cursor++;
		}
		if (cursor >= suffix.length) return results;
		name = suffix[cursor] ?? null;
		nameRaw = undefined; // deeper chain words carry no raw spelling
		cursor++;
	}
	return results;
}

/**
 * Three-tier version lookup (#3474): the full spelling first (canonical
 * `bzip2` stays itself), then the `.digit+`-stripped candidate (`bzip2.5` →
 * `bzip2`), then the full digit-run-stripped candidate (`python2.7` /
 * `curl8.5` → `python` / `curl`). First candidate that is a set member wins;
 * null when none is.
 */
function detectorSetMember(leaf: string, set: Set<string>): string | null {
	if (leaf && set.has(leaf)) return leaf;
	const dotted = leaf.replace(/\.\d+(\.\d+)*$/, '');
	if (dotted !== leaf && set.has(dotted)) return dotted;
	const stripped = dotted.replace(/\d+(\.\d+)*$/, '');
	if (stripped !== dotted && set.has(stripped)) return stripped;
	return null;
}

/**
 * For each word getSuffixWords returns (same order and filter), whether the
 * parser attached an expansion to it: a parameter (`$D`, `${D}`), command
 * (`$(...)`, backticks) or arithmetic expansion. Such a word's text is not
 * the word the command receives. A single-quoted word carries none.
 */
function getSuffixWordExpansionFlags(cmd: unknown): boolean[] {
	if (!cmd || typeof cmd !== 'object') return [];
	const suffix = (cmd as BashCommand).suffix;
	if (!Array.isArray(suffix)) return [];
	const flags: boolean[] = [];
	for (const s of suffix) {
		if (!isBashWord(s)) continue;
		const expansion = (s as { expansion?: unknown }).expansion;
		flags.push(Array.isArray(expansion) && expansion.length > 0);
	}
	return flags;
}

/**
 * For each word getSuffixWords returns, whether its expansions may split it
 * into several words (fail-safe: when in doubt, it may). Only a plain
 * double-quoted parameter expansion (`"$X"`, `"${X}"`, `"${X:-a b}"`,
 * `"s/$a/$b/"`) is treated as staying one word. A word that has an
 * expansion is treated as splitting when ANY of these holds:
 * - its raw text contains a command or arithmetic substitution (`$(`,
 *   `$((`, a backtick) anywhere: quote characters inside a substitution
 *   (`"$(: "'")"$X`) would mislead a flat quote scan, so such a word is
 *   never trusted to stay one word, even when the substitution is quoted;
 * - its raw text contains a positional or array expansion that splits even
 *   inside double quotes (`$@`, `$*`, `${@...}`, `${A[@]}`, `${A[*]}`);
 * - an expansion starts outside double quotes, by a flat quote scan of the
 *   raw text (the parser keeps the raw text of a word with an expansion and
 *   gives each expansion's start offset). An unknown offset counts as
 *   splitting.
 * Single-quoted words carry no expansion and never split.
 */
function getSuffixWordUnquotedExpansionFlags(cmd: unknown): boolean[] {
	if (!cmd || typeof cmd !== 'object') return [];
	const suffix = (cmd as BashCommand).suffix;
	if (!Array.isArray(suffix)) return [];
	const flags: boolean[] = [];
	for (const s of suffix) {
		if (!isBashWord(s)) continue;
		const expansion = (s as { expansion?: unknown }).expansion;
		if (!Array.isArray(expansion) || expansion.length === 0) {
			flags.push(false);
			continue;
		}
		// isBashWord guarantees a string text.
		const text = s.text;
		// A command or arithmetic substitution anywhere in the word.
		const hasSubstitution = /\$\(|`/.test(text);
		// `$@`, `$*`, `${@...}`, `${*...}`, `${A[@]}`, `${A[*]}`, `${!P@}`,
		// `${!A[@]}`, `${#A[@]}`, or any `[@]`/`[*]` (over-matching is safe).
		const hasListExpansion =
			/\$\{?[!#]?[A-Za-z0-9_]*(?:\[[@*]\]|@|\*)/.test(text) ||
			/\$\{?[!#]?[@*]|\[[@*]\]/.test(text);
		if (hasSubstitution || hasListExpansion) {
			flags.push(true);
			continue;
		}
		// Quoting state before each character of the raw word text.
		const quotedAt: boolean[] = [];
		let state: 'none' | 'single' | 'double' = 'none';
		for (let c = 0; c < text.length; c++) {
			const ch = text[c];
			quotedAt[c] = state !== 'none';
			if (state === 'single') {
				if (ch === "'") state = 'none';
			} else if (ch === '\\') {
				quotedAt[c + 1] = true;
				c++;
			} else if (ch === '"') {
				state = state === 'double' ? 'none' : 'double';
			} else if (ch === "'" && state === 'none') {
				state = 'single';
			}
		}
		flags.push(
			expansion.some((e) => {
				const start = (e as { loc?: { start?: unknown } }).loc?.start;
				return typeof start !== 'number' || quotedAt[start] !== true;
			}),
		);
	}
	return flags;
}

/** Get the prefix from a command node. */
function _getPrefixWords(cmd: unknown): string[] {
	if (!cmd || typeof cmd !== 'object') return [];
	const c = cmd as BashCommand;
	const prefix = c.prefix;
	if (!Array.isArray(prefix)) return [];
	return prefix.map((p) => wordText(p) ?? '');
}

/**
 * Get redirections array from a command node.
 * Redirections can be:
 *  1. In a dedicated `redirections` property (compound commands like Subshell)
 *  2. Inline in `suffix` array (simple commands like `echo foo > bar`)
 *  3. Inline in `prefix` array
 */
function getRedirections(cmd: unknown): BashRedirect[] {
	if (!cmd || typeof cmd !== 'object') return [];
	const c = cmd as BashCommand | BashCompoundList | BashSubshell;

	// Dedicated redirections array (compound commands)
	if (Array.isArray(c.redirections)) {
		return c.redirections as BashRedirect[];
	}

	// Collect Redirect nodes from suffix and prefix arrays (simple commands)
	const results: BashRedirect[] = [];
	const suffix = (c as BashCommand).suffix;
	const prefix = (c as BashCommand).prefix;

	if (Array.isArray(suffix)) {
		for (const item of suffix) {
			if (isRedirectNode(item)) results.push(item);
		}
	}
	if (Array.isArray(prefix)) {
		for (const item of prefix) {
			if (isRedirectNode(item)) results.push(item);
		}
	}

	return results;
}

/** Check if a node is a Redirect node. */
function isRedirectNode(node: unknown): node is BashRedirect {
	return !!(
		node &&
		typeof node === 'object' &&
		(node as BashRedirect).type === 'Redirect'
	);
}

/**
 * Convert an operator token to a human-readable string.
 * Note: bash-parser uses lowercase token names (e.g. 'great', 'dgreat').
 */
function operatorLabel(op: unknown): string {
	if (!op || typeof op !== 'object') return 'unknown';
	const o = op as BashOperator;
	const opType = o.type?.toUpperCase();
	switch (opType) {
		case 'GREAT':
			return '>';
		case 'DGREAT':
			return '>>';
		case 'CLOBBER':
			return '>|';
		case 'LESS':
			return '<';
		case 'DLESS':
			return '<<';
		case 'DLESSDASH':
			return '<<-';
		case 'LESSAND':
			return '<&';
		case 'GREATAND':
			return '>&';
		case 'LESSGREAT':
			return '<>';
		default:
			return opType || 'unknown';
	}
}

/** Extract path from a redirect file node, or null if it cannot be determined. */
function extractRedirectPath(fileNode: unknown): string | null {
	const text = wordText(fileNode);
	if (!text) return null;
	return text;
}

/**
 * Check if a path is a null/sink device (not a real write target).
 *
 * Matched on the literal word before any resolution, so only the exact
 * absolute device path is exempt: a relative `dev/null`, a `$VAR/dev/null`,
 * or a traversal through it (`/dev/null/../x`) is still a write target. The
 * same helper covers `tee`, `dd of=`, and every redirect site below, so a
 * `2>/dev/null` is treated exactly like `tee /dev/null`.
 */
function isNullDevice(path: string): boolean {
	return (
		path === '/dev/null' || path === '/dev/zero' || path === '/dev/urandom'
	);
}

/**
 * Whether a redirect target word is a sink device as bash reads it. The
 * parser decodes C escapes inside quotes, so `>'/dev/nul\154'` parses to
 * `/dev/null` while bash writes the literal file `/dev/nul\154`. The word is
 * exempt only when its source text, after bash quote removal and WITHOUT
 * escape decoding, is the device path (`"/dev/null"`, `'/dev/null'` and
 * `/dev/nul''l` are). Without source text the word is not exempt (fail-safe).
 */
function isNullDeviceWord(word: unknown, path: string): boolean {
	if (!isNullDevice(path) || !word || typeof word !== 'object') return false;
	const raw = RAW_WORD_TEXT.get(word);
	// Defensive guard: through the public API every redirect word gets a
	// source slice (annotateRawWordText runs on the whole AST before any
	// detector, and bash-parser gives every Word an insertLOC range), so
	// `raw === undefined` is not reachable today. It must stay fail-safe (not
	// exempt): a parser change that drops or mis-anchors loc data would
	// otherwise let the decoded text alone exempt `>'/dev/nul\154'`.
	return raw !== undefined && isNullDevice(scanQuoting(raw).dequoted);
}

/** Check if a string is purely numeric (used to filter truncate size args). */
function isNumeric(s: string): boolean {
	return /^\d+$/.test(s);
}

/**
 * The redirect write targets of one redirect node, brace-aware (#3491 W8).
 * Shared by the detection walk (detectRedirects) and the resolver walk's
 * redirect site (getWritesFromRedirectNode) so both walks emit the same
 * expanded branch set — the dedupe keys pair and every branch resolves at
 * its tracked context. A destination whose brace shape is a real-but-refused
 * expansion emits a single null-path write carrying the SOURCE word
 * (`dynamicSourceWord`): the gate's existing dynamic-target block denies it
 * (fail-closed), because bash writes more files than any literal reading of
 * the word.
 *
 * Final-critic F-2 ground truth (executed bash 5.x): a redirect operand
 * expanding to MULTIPLE words is an "ambiguous redirect" — bash writes
 * NOTHING (`echo x > src/{a,b}` → rc=1, no file; same inside procsub
 * bodies); a SINGLE-branch expansion (`f{1..1}`) is one word and writes.
 * This site keeps the conservative over-approximation on purpose: emit
 * every branch as a judged write (deny when any branch escapes, admit when
 * all are in scope — a superset of bash's no-write) rather than modeling
 * the refusal, so a shape that could write is never admitted because the
 * model believed the shell would reject it.
 */
function redirectWriteTargets(
	fileNode: unknown,
	path: string | null,
	opLabel: string,
): WriteTarget[] {
	const expansion =
		path === null
			? ({ kind: 'none' } as BraceDestinationExpansion)
			: expandBraceDestinations(fileNode, path);
	if (expansion.kind === 'dynamic') {
		return [
			{
				category: 'redirect',
				operator: opLabel,
				path: null,
				...(path !== null ? { dynamicSourceWord: path } : {}),
			},
		];
	}
	const targets = expansion.kind === 'branches' ? expansion.branches : [path];
	const out: WriteTarget[] = [];
	for (const target of targets) {
		if (target !== null) {
			// A branch IS the post-expansion operand text, so the plain sink
			// check is exact (an expanded `/dev/null` branch is the device
			// path bash passes). The unexpanded path keeps the stricter
			// raw-source check (parser escape decoding).
			if (expansion.kind === 'branches' && isNullDevice(target)) continue;
			if (expansion.kind === 'none' && isNullDeviceWord(fileNode, target)) {
				continue;
			}
		}
		out.push({ category: 'redirect', operator: opLabel, path: target });
	}
	return out;
}

/** `>&1` copies an output descriptor and `>&-` closes one; neither names a file. */
function isNonFileGreatAndTarget(path: string | null): boolean {
	return path !== null && (isNumeric(path) || path === '-');
}

// ---------------------------------------------------------------------------
// Detection functions per category
// ---------------------------------------------------------------------------

/**
 * Detect write-effect redirections on a command (>, >>, <<, etc.).
 * Handles:
 *  1. Redirect nodes in the dedicated `redirections` array (compound commands)
 *  2. Redirect nodes inline in `suffix`/`prefix` arrays (simple commands)
 *  3. Here-doc markers (dless/dlessdash Word tokens in suffix — bash-parser
 *     represents `cmd << MARKER` as a Word in suffix, not a Redirect node)
 */
function detectRedirects(cmd: unknown): WriteTarget[] {
	const results: WriteTarget[] = [];

	// Detect here-doc markers FIRST (they appear before redirect in suffix for `cmd << EOF > out.txt`)
	results.push(...detectHereDocMarkers(cmd));

	const redirections = getRedirections(cmd);

	for (const redirect of redirections) {
		if (!redirect || typeof redirect !== 'object') continue;
		const r = redirect as BashRedirect;
		const opNode = r.op;
		if (!opNode || typeof opNode !== 'object') continue;

		const opType = opNode.type?.toUpperCase();

		if (!opType || !REDIRECT_ALL_WRITE_TOKENS.has(opType)) continue;

		const fileNode = r.file;
		const path = extractRedirectPath(fileNode);
		const opLabel = operatorLabel(opNode);

		if (
			REDIRECT_WRITE_TOKENS.has(opType) ||
			(REDIRECT_GREATAND_TOKENS.has(opType) && !isNonFileGreatAndTarget(path))
		) {
			// #3491 W8: brace-expanded destinations emit one write per branch
			// (a sink-device branch — quoted or expanded — is not a target).
			for (const write of redirectWriteTargets(fileNode, path, opLabel)) {
				results.push(write);
			}
		} else if (REDIRECT_HERE_TOKENS.has(opType)) {
			results.push({ category: 'here_doc', operator: opLabel, path });
		}
	}

	return results;
}

/**
 * Detect here-doc markers that appear as Word tokens with type 'dless' or 'dlessdash'
 * in the suffix of a command (inline form, not a separate Redirect node).
 */
function detectHereDocMarkers(cmd: unknown): WriteTarget[] {
	const results: WriteTarget[] = [];
	if (!cmd || typeof cmd !== 'object') return results;
	const c = cmd as BashCommand;

	const suffix = c.suffix;
	if (!Array.isArray(suffix)) return results;

	for (const item of suffix) {
		if (!item || typeof item !== 'object') continue;
		// Here-doc marker: type is 'dless' or 'dlessdash', text is '<<' or '<<-'
		if (isHereDocMarker(item)) {
			results.push({
				category: 'here_doc',
				operator: item.text === '<<-' ? '<<-' : '<<',
				path: null, // marker is not a file path
			});
		}
	}

	return results;
}

/** Type guard: check if a node is a here-doc marker. */
function isHereDocMarker(node: unknown): node is BashHereDocMarker {
	if (!node || typeof node !== 'object') return false;
	const n = node as BashHereDocMarker;
	const type = n.type?.toLowerCase();
	return type === 'dless' || type === 'dlessdash';
}

/** Detect builtin write commands: cp, mv, install, ln, truncate, dd. */
/**
 * #3591 (Fix 6, shared two-pass rm flag parse): GNU getopt permutation
 * semantics for `rm` token lists — options may appear AFTER operands, so a
 * leading-token-only flag read misses `rm foo -rf ../../outside`. Pass 1
 * collects EVERY option token anywhere before the `--` separator and
 * classifies the recursive/forced ones (`r`/`R`/`f`/`F` short-cluster
 * members, exact `--recursive`/`--force` long options — GNU long-option
 * abbreviations like `--rec` are a disclosed pre-existing residual); pass 2
 * extracts every remaining token (non-option tokens before `--`, all tokens
 * after it) as targets. `tokens` EXCLUDE the verb word. Shared by the
 * detector's non-destructive rm arm (detectBuiltinWrites) and
 * `dcExtractRecursiveRmTargets` so both layers classify identically.
 */
export function parseRmOptionTokens(tokens: readonly string[]): {
	destructive: boolean;
	targetIndices: number[];
} {
	// PR #3615 feedback PRR-002: both feeds into this parse are the
	// quote-removed / escape-decoded words bash hands rm — the detector arm
	// passes AST words (bash-parser quote removal) and dcExtractRecursiveRmTargets
	// decodes its raw segment tokens at the boundary (dcDecodeShellWord). A
	// quoted destructive flag (`rm "-rf" ../../outside`) and an escape-decoded
	// one (`rm \-rf ../outside`) therefore classify identically on both
	// layers; a word whose LITERAL text still starts with a dash here is a
	// real option, and a word still carrying quote characters is a real
	// filename character (bash quote removal is already done upstream).
	// Fidelity bound: the boundary decode covers pair quotes and backslash
	// escapes only — ANSI-C `$'…'` / locale `$"…"` words are NOT decoded
	// (bash-parser rejects them, so the write gate's parse-error deny is
	// the backstop for those spellings).
	// Pass 1: option tokens anywhere before `--`, classified.
	let destructive = false;
	let separatorIndex = tokens.length;
	for (let i = 0; i < tokens.length; i += 1) {
		const token = tokens[i];
		if (token === undefined) break;
		if (token === '--') {
			separatorIndex = i;
			break;
		}
		if (!token.startsWith('-') || token === '-') continue;
		if (token === '--recursive' || token === '--force') {
			destructive = true;
			continue;
		}
		if (!token.startsWith('--') && /[rRfF]/.test(token.slice(1))) {
			destructive = true;
		}
	}
	// Pass 2: the remaining tokens are targets. A bare `-` is an operand
	// (stdin), never an option.
	const targetIndices: number[] = [];
	for (let i = 0; i < tokens.length; i += 1) {
		const token = tokens[i];
		if (token === undefined) break;
		if (i === separatorIndex) continue;
		if (
			i < separatorIndex &&
			token.startsWith('-') &&
			token !== '-' &&
			token !== '--'
		) {
			continue;
		}
		targetIndices.push(i);
	}
	return { destructive, targetIndices };
}

function detectBuiltinWrites(cmd: unknown): WriteTarget[] {
	const results: WriteTarget[] = [];
	const name = getCommandName(cmd);
	if (!name) return results;

	// #3474: classify through the canonical command model so versioned,
	// path-qualified, and execution-wrapped spellings cannot sidestep the
	// builtin-write detectors (the emitted operator keeps the raw name).
	// dd and tee are handled below ahead of the set check, so they join the
	// gate explicitly.
	const leaf = detectorCommandLeaf(cmd);
	const lowerName =
		detectorSetMember(leaf, BUILTIN_WRITE_COMMANDS) ??
		(leaf === 'dd' || leaf === 'tee' || leaf === 'env' ? leaf : null);
	if (!lowerName) return results;

	// #3485 (PRR-008): dedupe on the RESOLVED real command as spelled — not
	// the raw first word (a transparent wrapper would key every wrapped write
	// the same: `env cp a b; env mv c b`) and not the lowercased leaf (bash is
	// case-sensitive; collapsing `rmdir` and `RMDIR` dedupes away a real write
	// that runs in its own `cd` context).
	const dedupeOperator = detectorCommandRawLeaf(cmd);

	// dd with of= flag
	if (lowerName === 'dd') {
		// #3569 core: the operand window is the WRAPPER-CONSUMED token tail
		// (#3485 PRR-006 pattern, finally adopted by tee/dd) — under a
		// wrapper prefix (`sudo -D src tee a`, `env -C src tee ok.txt`) the
		// raw suffix carries every wrapper word, fabricating targets
		// (`ws	ee`, `ws\src`) resolved at the parent cwd. The suffix NODES
		// index past the same consumed prefix (word/node arrays are
		// index-aligned by construction); a consumed count beyond the node
		// array withdraws fail-closed instead of emitting a fabricated
		// target.
		const ddParts = detectorCommandPartsFromWordsBounded(
			getCommandName(cmd),
			getSuffixWords(cmd),
		);
		const ddAllWords = getSuffixWords(cmd);
		const ddAllNodes = getSuffixNodes(cmd);
		const ddConsumed = ddAllWords.length - ddParts.rest.length;
		const suffixWords = ddParts.rest;
		const suffixNodes =
			ddConsumed >= 0 && ddConsumed <= ddAllNodes.length
				? ddAllNodes.slice(ddConsumed)
				: [];
		if (ddParts.depthExceeded) {
			results.push({
				category: 'builtin_write',
				operator: 'dd of=',
				path: null,
				unresolvedContext: true,
			});
			return results;
		}
		if (ddConsumed < 0 || ddConsumed > ddAllNodes.length) {
			results.push({
				category: 'builtin_write',
				operator: 'dd of=',
				path: null,
				unresolvedContext: true,
			});
			return results;
		}
		for (let w = 0; w < suffixWords.length; w++) {
			const word = suffixWords[w];
			// Reviewer F-f (pre-existing, exposed by the F-02 hardening): a
			// quoted `of=` word carrying an expansion (`"of=$D/src/f"`)
			// failed the raw startsWith gate and emitted nothing — bash
			// writes through the expanded value. Emit the dynamic refusal
			// for the expansion-bearing spelling.
			let bare = word;
			if (
				bare.length >= 2 &&
				((bare.startsWith("'") && bare.endsWith("'")) ||
					(bare.startsWith('"') && bare.endsWith('"')))
			) {
				bare = bare.slice(1, -1);
			}
			const ofWord = bare.startsWith('of=') ? bare : word;
			if (!ofWord.startsWith('of=')) continue;
			if (isDynamicPath(ofWord.slice(3))) {
				results.push({
					category: 'builtin_write',
					operator: 'dd of=',
					path: null,
					unresolvedContext: true,
					dynamicSourceWord: ofWord,
				});
				continue;
			}
			// #3491 W8: brace regions in the `of=` VALUE expand — `dd
			// of='src/{a,../x}'` writes both branch files. Bash keeps only
			// the LAST expanded `of=` (final-critic GT), which can itself be
			// the escaping branch — emitting every branch is the conservative
			// superset that always covers it.
			pushExpandedDestination(
				results,
				suffixNodes[w],
				word,
				3,
				(path) =>
					path && !isNullDevice(path)
						? { category: 'builtin_write', operator: 'dd of=', path }
						: null,
				// F-1: the refusal write is UNCONDITIONAL — emit('') returns
				// null here (falsy-path test) and must not gate it.
				() => ({
					category: 'builtin_write',
					operator: 'dd of=',
					path: null,
					dynamicSourceWord: word,
				}),
				// #3568 F-02 opt-in: the of= word is the anchor token the
				// strip was written for.
				true,
			);
		}
		return results;
	}

	// tee writes to every positional (non-flag) argument; -a means append (still a write).
	// After a '--' end-of-flags sentinel, all remaining tokens are positional even if they
	// start with '-' (e.g. tee -- -dashed-filename).
	if (lowerName === 'tee') {
		// #3569 core: wrapper-consumed operand window (see the dd branch
		// above for the full rationale — the #3485 PRR-006 pattern).
		const teeParts = detectorCommandPartsFromWordsBounded(
			getCommandName(cmd),
			getSuffixWords(cmd),
		);
		const teeAllWords = getSuffixWords(cmd);
		const teeAllNodes = getSuffixNodes(cmd);
		const teeConsumed = teeAllWords.length - teeParts.rest.length;
		const suffixWords = teeParts.rest;
		const suffixNodes =
			teeConsumed >= 0 && teeConsumed <= teeAllNodes.length
				? teeAllNodes.slice(teeConsumed)
				: [];
		if (teeParts.depthExceeded) {
			results.push({
				category: 'builtin_write',
				operator: 'tee',
				path: null,
				unresolvedContext: true,
			});
			return results;
		}
		if (teeConsumed < 0 || teeConsumed > teeAllNodes.length) {
			results.push({
				category: 'builtin_write',
				operator: 'tee',
				path: null,
				unresolvedContext: true,
			});
			return results;
		}
		// #3572 N-29 completion (merged): the wrapper-consumed window above
		// already starts the operand slice at the RESOLVED leaf word, so the
		// loop begins at 0 of the sliced arrays (N-29's bogus verb-word
		// target cannot occur).
		const teeStart = 0;
		let pastDoubleDash = false;
		for (let w = teeStart; w < suffixWords.length; w++) {
			const word = suffixWords[w];
			if (word === '--') {
				pastDoubleDash = true;
				continue;
			}
			if (!pastDoubleDash && word.startsWith('-')) continue;
			// #3491 W8: a braced positional expands — `tee src/{a,../../x}`
			// writes every branch (bash-EXACT multi-write, final-critic GT).
			pushExpandedDestination(
				results,
				suffixNodes[w],
				word,
				0,
				(path) =>
					path && !isNullDevice(path)
						? { category: 'builtin_write', operator: 'tee', path }
						: null,
				// F-1: the refusal write is UNCONDITIONAL — emit('') returns
				// null here (falsy-path test) and must not gate it.
				() => ({
					category: 'builtin_write',
					operator: 'tee',
					path: null,
					dynamicSourceWord: word,
				}),
				// #3568 F-02 opt-in: the positional word is the anchor token
				// the strip was written for.
				true,
			);
		}
		return results;
	}

	if (lowerName === 'env') {
		// #3572 N-29: GNU env -S/--split-string RE-PARSES its payload as a
		// command line (argv split) — `env -S 'rm -rf /important'` RUNS the
		// payload. The words after -S are the effective command: run the
		// full builtin-write scan on the reconstructed line (recursive; the
		// payload may itself carry another env/wrapper).
		const suffixWords = getSuffixWords(cmd);
		for (let w = 0; w < suffixWords.length; w++) {
			const word = suffixWords[w] ?? '';
			// #3572 review (delta): GNU getopt also accepts the GLUED long form
			// `--split-string=VALUE` — the payload rode in the flag token and
			// was silently consumed as an env argument.
			const gluedSplit =
				word.startsWith('--split-string=') && word.length > 15
					? word.slice('--split-string='.length)
					: undefined;
			if (
				word !== '-S' &&
				word !== '--split-string' &&
				gluedSplit === undefined
			)
				continue;
			const payload = gluedSplit ?? suffixWords[w + 1];
			if (payload === undefined || payload.trim() === '') break;
			// Glued form: the payload is INSIDE the token (no next word).
			const glued = gluedSplit !== undefined;
			const postStart = glued ? w + 1 : w + 2;
			const splitWords: string[] = [];
			{
				let cur = '';
				let hasWord = false;
				const pushW = () => {
					if (hasWord) {
						splitWords.push(cur);
						cur = '';
						hasWord = false;
					}
				};
				let si = 0;
				while (si < payload.length) {
					const c = payload[si];
					if (c === "'") {
						hasWord = true;
						si += 1;
						while (si < payload.length && payload[si] !== "'") {
							cur += payload[si];
							si += 1;
						}
						si += 1;
						continue;
					}
					if (c === '"') {
						hasWord = true;
						si += 1;
						while (si < payload.length && payload[si] !== '"') {
							cur += payload[si];
							si += 1;
						}
						si += 1;
						continue;
					}
					if (c === '\\' && si + 1 < payload.length) {
						cur += payload[si + 1];
						si += 2;
						hasWord = true;
						continue;
					}
					if (/\s/.test(c)) {
						pushW();
						si += 1;
						continue;
					}
					cur += c;
					hasWord = true;
					si += 1;
				}
				pushW();
			}
			if (
				splitWords.some(
					(x: string) =>
						x === '-S' ||
						x === '--split-string' ||
						x.startsWith('--split-string='),
				)
			) {
				// Nested split-string: the payload re-parses again at execution
				// time and the reconstruction cannot model it — emit the
				// unconditional dynamic refusal (null path) so the gate DENIES
				// instead of silently classifying the command as write-free.
				results.push({
					category: 'redirect',
					operator: 'env -S',
					path: null,
					unresolvedContext: true,
				});
				return results;
			}
			// The argv re-parse expands payload words at execution time; a
			// second -S in the ORIGINAL argv splices after this one and is
			// equally beyond the model. Both are the unconditional refusal.
			const dynamicPayload =
				splitWords.some((x: string) => isDynamicPath(x)) ||
				suffixWords
					.slice(postStart)
					.some(
						(x) =>
							x === '-S' ||
							x === '--split-string' ||
							x.startsWith('--split-string='),
					);
			if (dynamicPayload) {
				results.push({
					category: 'redirect',
					operator: 'env -S',
					path: null,
					unresolvedContext: true,
				});
				return results;
			}
			// Reconstruct the effective env argv (`env` + the pre-flags + the
			// spliced payload words + the post words) and re-enter the FULL
			// detector family: the string-level scanner's leaf gate misses the
			// special-cased tee/dd/env verbs, so a `env -S 'tee …'` payload
			// was classified write-free. Payload words are re-SERIALIZED with
			// quote grouping intact (the review Critical: a bare-space join
			// destroyed the `sh -c "script"` grouping the shell-wrapper walk
			// depends on).
			const shQuotePayload = (word: string): string =>
				`'${word.replace(/'/g, `'\\''`)}'`;
			const serializedPayload = splitWords
				.map((word) =>
					/^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : shQuotePayload(word),
				)
				.join(' ');
			const reconstructed = [
				'env',
				...suffixWords.slice(0, w),
				serializedPayload,
				...suffixWords.slice(postStart),
			].join(' ');
			for (const write of detectPosixWrites(reconstructed).writes) {
				// The union-back merge drops unwrapped-twin interpreter_eval
				// capability markers (they would false-block safe
				// `bash -c "echo hello"` re-classifications) — but HERE the
				// marker is the ONLY signal the payload exists, so convert it
				// to the unconditional dynamic refusal, which survives every
				// merge filter and denies fail-closed.
				if (write.category === 'interpreter_eval' && write.path === null) {
					results.push({
						category: 'redirect',
						operator: 'env -S',
						path: null,
						unresolvedContext: true,
					});
				} else {
					results.push(write);
				}
			}
			return results;
		}
	}

	if (!BUILTIN_WRITE_COMMANDS.has(lowerName)) return results;

	// `rmdir /s [/q] <path>` is a cmd.exe destructive form.  Let the
	// destructive-command guard evaluate its target containment instead of
	// feeding it through the POSIX write-authority gate used by `bash` calls
	// — but ONLY when the guard will actually evaluate the shape: the RAW
	// (quote-preserving) suffix words are parsed with the same cmd.exe
	// grammar the guard uses, and the tag is withdrawn only when the
	// recursion switch is really present.  A quoted `"/s"` is a PATH per
	// cmd.exe and a `/q` alone never recurses — dropping those left the
	// rmdir with NO checking layer at all (PR #3499 review, PRR-005); the
	// ordinary POSIX write path must scope-check the operands instead.
	const rawWords = rawSuffixWords(cmd);
	if (
		lowerName === 'rmdir' &&
		rawWords !== null &&
		dcParseWindowsRecursiveDelete(rawWords.join(' ')).fires
	) {
		return results;
	}

	// #3569 4.5 r2: the suffix window for EVERY remaining builtin-write arm
	// is the WRAPPER-CONSUMED token tail (#3485 PRR-006, generalized from
	// tee/dd): under a wrapper prefix (`sudo -D src truncate a`,
	// `env -C src rmdir x`, `command sed -i …`) the raw suffix carries every
	// wrapper word, fabricating targets (`ws\truncate`, `ws\src`) resolved
	// at the parent cwd. Wrapper consumption happens per leaf via
	// detectorCommandLeaf above; the window aligns with it. A depth refusal
	// or an impossible consumed count withdraws fail-closed.
	const suffixWindowParts = detectorCommandPartsFromWordsBounded(
		getCommandName(cmd),
		getSuffixWords(cmd),
	);
	const suffixWindowAllWords = getSuffixWords(cmd);
	const suffixWindowAllNodes = getSuffixNodes(cmd);
	const suffixWindowConsumed =
		suffixWindowAllWords.length - suffixWindowParts.rest.length;
	if (
		suffixWindowParts.depthExceeded ||
		suffixWindowConsumed < 0 ||
		suffixWindowConsumed > suffixWindowAllNodes.length
	) {
		results.push({
			category: 'builtin_write',
			operator: dedupeOperator,
			path: null,
			unresolvedContext: true,
		});
		return results;
	}
	const suffixWords = suffixWindowParts.rest;
	const suffixNodes = suffixWindowAllNodes.slice(suffixWindowConsumed);

	// #3591 Fix 6a: dedicated POSIX rm arm — scope containment modeled on
	// the multi-operand rmdir arm (NOT the generic last-operand cp/mv
	// destination arm): a NON-destructive rm (flagless, or non-destructive
	// flags like -i/-I/-v/-d) deletes EVERY operand, so each literal
	// non-option operand is emitted as its own scope-checked write target
	// (pushExpandedDestination — braces expand per branch; `--` ends the
	// option region per the shared two-pass parse, which also consumes
	// GNU-permutation options after operands). A recursive/forced shape
	// (any r/R/f/F cluster member or --recursive/--force, at ANY position)
	// emits NOTHING here: the destructive arm (tool-before layer order —
	// checkDestructiveCommand before checkShellWriteScope) owns flagged
	// shapes and denies first, so the .swarm message pins and the
	// extractor's flagless-null pin keep their current carriers.
	if (lowerName === 'rm') {
		const rmParse = parseRmOptionTokens(suffixWords);
		if (rmParse.destructive) return results;
		for (const idx of rmParse.targetIndices) {
			const word = suffixWords[idx];
			if (word === undefined || word === '') continue;
			pushExpandedDestination(
				results,
				suffixNodes[idx],
				word,
				0,
				(path) => ({
					category: 'builtin_write',
					operator: dedupeOperator,
					path,
				}),
				() => ({
					category: 'builtin_write',
					operator: dedupeOperator,
					path: null,
					dynamicSourceWord: word,
				}),
			);
		}
		return results;
	}

	// A quoted, backslash-escaped or expanded operand (`"a"`, `a\b`, `$D`)
	// never keeps this tag: detectPosixWrites withdraws it from any line that
	// is not a PLAIN_COMMAND_LINE, so the parsed word is the path the shell
	// passes to rmdir.
	if (
		lowerName === 'rmdir' &&
		suffixWords.length === 1 &&
		isBareRmdirOperand(suffixWords[0])
	) {
		results.push({
			category: 'builtin_write',
			// #3485 (PRR-008): the resolved real command as spelled (see the
			// dedupeOperator comment above), not the raw first word.
			operator: dedupeOperator,
			path: suffixWords[0],
			emptyDirectoryRemoval: true,
		});
		return results;
	}

	if (lowerName === 'touch') {
		// #3568 parallel-review F-01: POSIX `touch FILE...` creates/updates
		// EVERY named operand — each non-flag operand is a write. touch's
		// option vocabulary is date/reference flags whose values consume the
		// next word only in their long `--TIME=` glued forms; short clusters
		// (`-c`, `-acm`) never take a separate value word, so a plain
		// startsWith('-') skip is the conservative operand scan (an
		// option-shaped PATH after `--` is honored via the same convention
		// as truncate/rmdir).
		let endOfOptions = false;
		// Transparent prefixes (command/exec) leave their own name in the
		// suffix words — skip everything up to and including the leaf verb
		// (basename match: path-qualified leaves like /usr/bin/touch) so the
		// wrapper/verb words are never judged as operands.
		let start = 0;
		for (let w = 0; w < suffixWords.length; w++) {
			if (basenameAnySep(suffixWords[w] ?? '') === 'touch') {
				start = w + 1;
				break;
			}
		}
		for (let w = start; w < suffixWords.length; w++) {
			const word = suffixWords[w];
			if (!endOfOptions && word === '--') {
				endOfOptions = true;
				continue;
			}
			// Reviewer F-a: -d/-t/-r (short, separate value) and the long
			// --date/--reference/--time forms consume the NEXT word as the
			// value — a date string or reference file must not be judged as
			// a write target.
			if (
				!endOfOptions &&
				/^-[^-]*[dtr]$/.test(word) &&
				w + 1 < suffixWords.length
			) {
				w += 1;
				continue;
			}
			if (
				!endOfOptions &&
				/^(--date|--reference|--time)$/.test(word) &&
				w + 1 < suffixWords.length
			) {
				w += 1;
				continue;
			}
			if (endOfOptions || !word.startsWith('-')) {
				pushExpandedDestination(
					results,
					suffixNodes[w],
					word,
					0,
					(path) => ({
						category: 'builtin_write',
						operator: dedupeOperator,
						path,
					}),
					() => ({
						category: 'builtin_write',
						operator: dedupeOperator,
						path: null,
						dynamicSourceWord: word,
					}),
				);
			}
		}
		return results;
	}

	if (lowerName === 'truncate') {
		// POSIX `truncate FILE...` truncates EVERY named file (#3503): report
		// each non-flag, non-size operand — the old first-word-and-break loop
		// left every later operand outside the scope gate. The size exclusion
		// is purely numeric (`isNumeric`); suffixed sizes (`10M`, `2G`) are
		// reported too — an over-report (fail-closed), matching the pre-#3503
		// first-word behavior for that shape.
		let endOfOptions = false;
		for (let w = 0; w < suffixWords.length; w++) {
			const word = suffixWords[w];
			if (!endOfOptions && word === '--') {
				endOfOptions = true;
				continue;
			}
			// After `--`, operands are file names even when purely numeric
			// (coreutils): the numeric size exclusion applies only to the
			// pre-`--` option region (#3512 final-critic residual).
			if (endOfOptions || (!word.startsWith('-') && !isNumeric(word))) {
				// #3491 W8: a braced operand expands to one write per branch
				// (truncate FILE... truncates EVERY operand — bash-EXACT).
				pushExpandedDestination(
					results,
					suffixNodes[w],
					word,
					0,
					(path) => ({
						category: 'builtin_write',
						operator: 'truncate',
						path,
					}),
					() => ({
						category: 'builtin_write',
						operator: 'truncate',
						path: null,
						dynamicSourceWord: word,
					}),
				);
			}
		}
	} else if (lowerName === 'rmdir') {
		// POSIX `rmdir dir...` removes EVERY operand (#3503): report each
		// non-flag operand as its own write target. No emptyDirectoryRemoval
		// tag here — the bare-single exemption above only ever fires for a
		// one-operand literal, so multi-target (and non-bare single) forms
		// keep the ordinary declared-scope check, exactly like today's
		// last-operand emission. `--` ends option parsing (coreutils): a
		// `-`-prefixed word after it is a path, not a flag (#3512 review P-6;
		// the tee branch models the same convention).
		let endOfOptions = false;
		for (let w = 0; w < suffixWords.length; w++) {
			const word = suffixWords[w];
			if (!endOfOptions && word === '--') {
				endOfOptions = true;
				continue;
			}
			if (endOfOptions || !word.startsWith('-')) {
				// #3491 W8: a braced operand expands to one write per branch
				// (rmdir dir... removes EVERY operand — bash-EXACT; no branch
				// ever carries the emptyDirectoryRemoval tag — a braced
				// operand is not a bare literal).
				pushExpandedDestination(
					results,
					suffixNodes[w],
					word,
					0,
					(path) => ({
						category: 'builtin_write',
						operator: dedupeOperator,
						path,
					}),
					() => ({
						category: 'builtin_write',
						operator: dedupeOperator,
						path: null,
						dynamicSourceWord: word,
					}),
				);
			}
		}
	} else {
		// #3568 review PRR-009: `-t DEST` / `--target-directory=DEST` moves
		// the DESTINATION to the flag's value — every operand is a SOURCE
		// and bash writes DEST/<basename>. The old last-operand rule judged
		// `cp -t ../../esc src/a` on `src/a` (in scope) while bash wrote
		// outside. Emit DEST as a write too (a conservative superset: bash
		// writes DEST/<basename>, which is inside DEST, so the containment
		// verdict is the same).
		for (let w = 0; w < suffixWords.length; w++) {
			const flagWord = suffixWords[w] ?? '';
			let dest: string | null = null;
			if (
				(flagWord === '-t' || flagWord === '--target-directory') &&
				w + 1 < suffixWords.length
			) {
				dest = suffixWords[w + 1] ?? null;
			} else if (flagWord.startsWith('--target-directory=')) {
				dest = flagWord.slice('--target-directory='.length);
			} else if (flagWord.startsWith('-') && !flagWord.startsWith('--')) {
				// Reviewer F-d: GNU cp accepts the ATTACHED short value
				// (`-t../../esc`) — when `t` is NOT the final cluster char the
				// value rides inside the token; when `t` IS final the value is
				// the next word (the `-vt` cluster form).
				const tIdx = flagWord.indexOf('t', 1);
				if (tIdx === flagWord.length - 1 && w + 1 < suffixWords.length) {
					dest = suffixWords[w + 1] ?? null;
				} else if (tIdx !== -1 && tIdx < flagWord.length - 1) {
					dest = flagWord.slice(tIdx + 1);
				}
			}
			if (dest !== null && dest !== '') {
				pushExpandedDestination(
					results,
					suffixNodes[w + 1] ?? suffixNodes[w],
					dest,
					0,
					(path) => ({
						category: 'builtin_write',
						operator: dedupeOperator,
						path,
					}),
					() => ({
						category: 'builtin_write',
						operator: dedupeOperator,
						path: null,
						dynamicSourceWord: dest ?? flagWord,
					}),
				);
			}
		}
		// cp, mv, install, ln — last non-flag argument is the destination (written file)
		for (let i = suffixWords.length - 1; i >= 0; i--) {
			const word = suffixWords[i];
			if (!word.startsWith('-')) {
				// #3491 W8: a braced destination expands. Bash REFUSES a
				// ≥2-branch cp/mv destination ("target is not a directory",
				// no write — final-critic GT); emitting every branch is the
				// deliberate conservative over-approximation (deny when any
				// branch escapes, admit when all are in scope).
				pushExpandedDestination(
					results,
					suffixNodes[i],
					word,
					0,
					(path) => ({
						category: 'builtin_write',
						operator: dedupeOperator,
						path,
					}),
					() => ({
						category: 'builtin_write',
						operator: dedupeOperator,
						path: null,
						dynamicSourceWord: word,
					}),
				);
				break;
			}
		}
	}

	return results;
}

/**
 * Whether a word is shaped like a sed script rather than a path: a single
 * command with an address or a negation (`1d`, `$d`, `1,3p`, `$!d`, `!d`,
 * `3q`), a word with no `/`, `\` or `:`, not starting with `.`, that holds
 * a command separator or block (`N;P;D`, `1d;$d`), or an `s` / `y` command with any
 * delimiter (`s/a/b/g`, `s|a|b|`, `y/ab/xy/`). A bare letter (`p`, `d`,
 * `P`, `f`) is ambiguous with a file name and counts as a path, the
 * fail-safe direction. A word with `;`, `{` or `}` that also has a `/` or a
 * leading `.` (`/opt/a;b`, `../{a}`, `.env;x`) is a path, and so is one
 * that has a `\` or a `:` (win32 separators and drive prefixes). A word
 * with a `..` path component (components split on `/` and on `\`, which is
 * a separator on win32) or a drive-absolute prefix (`C:\`, `C:/`) is
 * always a path, whatever its shape: GNU sed reads `s-x-/../../victim` or
 * `s-x-\..\..\victim` after `-i ''` as a file, and it can name a file
 * outside the root, so `sed -i '' 's-x-/../../victim' f` reports both
 * words (the fail-safe direction). A backslash that is not next to a `..`
 * component (`s/\t/ /`, `s/a\/b/c/`, `s/\(a\)/\1/`) keeps an `s` / `y`
 * word a script. The only use is choosing the BSD
 * reading of a detached `-i` suffix, and the caller applies it only to a
 * pure literal word (no parameter, command or arithmetic expansion, no
 * brace expansion, no glob character); any other word is always reported.
 * The residual is a literal file named like a sed script with no `..`
 * component: an addressed command (`1d`, `$d`, `3q`, `$!d`), a word with
 * `;`, `{` or `}` and no `/`, `\` or `:`, or an `s` / `y` command (`s-a-b-g`,
 * `y,ab,xy,`). It can be taken for that script; a literal relative name
 * without a `..` component stays under the shell's current directory.
 */
function looksLikeSedScript(w: string): boolean {
	// The drive-absolute test decides only `s` / `y` words (`s:/a:/b:`,
	// `y:/:_:` name drive S: or Y: on win32); a `;`/`{`/`}` word with a drive
	// prefix (`C:\Temp\x;y`) is already refused by the `\`/`:` test below.
	// A `:`-delimited script whose pattern starts with `/`
	// (`s:/usr/local:/opt:g`) is therefore reported: a fail-safe over-report.
	if (hasParentComponent(w) || /^[A-Za-z]:[\\/]/.test(w)) return false;
	return (
		/^(?:(?:[0-9]+|\$)(?:,(?:[0-9]+|\$))?!?|!)[a-zA-Z=]$/.test(w) ||
		// On win32 `\` is a path separator and `C:` a drive prefix, so a word
		// with `;`, `{` or `}` that holds a `\` or a `:` (`x;\a\b`,
		// `\\srv\share\x;y`, `C:\Temp\x;y`, `D:x;y`) is a path, like one that
		// holds a `/`. A label script (`:a;N;ba`) in this slot is reported too.
		(/[;{}]/.test(w) && !/[\\/:]/.test(w) && !w.startsWith('.')) ||
		/^s([^A-Za-z0-9\s\\])(?:\\.|(?!\1)[^\\])*\1(?:\\.|(?!\1)[^\\])*\1[gpiImMe0-9]*$/.test(
			w,
		) ||
		/^y([^A-Za-z0-9\s\\])(?:\\.|(?!\1)[^\\])*\1(?:\\.|(?!\1)[^\\])*\1$/.test(w)
	);
}

/**
 * Whether a word has a `..` path component. Components are split on `/`
 * and on `\`: on win32 (Git Bash, MSYS) a backslash is a path separator, so
 * `s-x-\..\..\v` names a file two levels up there. The `\` split applies on
 * every platform (the detector does not know the host shell), so a BSD-slot
 * script with unescaped dots before an escaped slash (`'s/..\/lib/x/'`,
 * `'s/..\/..\/utils/@utils/g'`) is read as a path and reported: a
 * fail-closed over-block (follow-up: make the backslash rule platform-aware).
 * The GNU, `-e` and `.bak` slots are not affected.
 */
function hasParentComponent(w: string): boolean {
	return w.split(/[\\/]/).includes('..');
}

/** Detect in-place editing: sed -i, perl -i, awk -i. */
function detectInplaceEdit(cmd: unknown): WriteTarget[] {
	const results: WriteTarget[] = [];
	const name = getCommandName(cmd);
	if (!name) return results;

	const leaf = detectorCommandLeaf(cmd);
	const lowerName = detectorSetMember(leaf, INPLACE_EDIT_COMMANDS);
	if (!lowerName) return [];

	// #3569 4.5 r2: wrapper-consumed suffix window (#3485 PRR-006,
	// generalized) — `sudo -D src sed -i s/a/b/ f` must not read the wrapper
	// words as the script/operand window. Impossible consumption withdraws.
	const inplaceParts = detectorCommandPartsFromWordsBounded(
		getCommandName(cmd),
		getSuffixWords(cmd),
	);
	if (inplaceParts.depthExceeded) return results;
	const inplaceAll = getSuffixWords(cmd);
	const inplaceConsumed = inplaceAll.length - inplaceParts.rest.length;
	if (inplaceConsumed < 0 || inplaceConsumed > getSuffixNodes(cmd).length) {
		return results;
	}
	const suffixWords = inplaceParts.rest;

	// Look for -i flag
	// sed also takes the long form `--in-place[=SUFFIX]` and any unambiguous
	// abbreviation of it (`--in`, `--in-pl=.bak`); an abbreviation is not a
	// modelled option, so it is reported and every positional with it.
	const hasInplaceFlag = suffixWords.some((word) => {
		if (lowerName === 'sed') {
			return (
				(word.startsWith('-i') && word.length > 1) ||
				/^--i(?:n(?:-(?:p(?:l(?:a(?:c(?:e)?)?)?)?)?)?)?(?:=|$)/.test(word)
			);
		}
		return word === '-i' || word.startsWith('-i');
	});

	if (!hasInplaceFlag) return [];

	// Find the file argument: the first word that is neither a flag, a flag's
	// argument, nor the script.
	const scriptPattern = /^[ssy]\/.*\/[gim]*$/;
	const quotedScriptPattern = /^["'].*["']$/; // a word that kept its quotes
	// A word shaped like an `s///` or `y///` script with no `..` path
	// component, split on `/` and `\` (a word with one, `s/../../etc/g` or
	// `s/..\..\x/g`, is a path: D-001).
	const isScriptShaped = (w: string): boolean =>
		scriptPattern.test(w) && !hasParentComponent(w);
	// Whether a positional word is dropped as a script rather than reported
	// as a file. A word that kept its quotes has an expansion (the parser
	// drops the quotes of a word without one); it is dropped only when the
	// text inside the quotes is itself script-shaped and the word stays one
	// word (`"s/$a/$b/"`). A quoted dynamic word that is not script-shaped
	// (`"$FILE"`, `"${D}"`, `"$D/x"`) is a file and is reported, and so is
	// one that can become several words (`"$@"`, `"$(cmd)"`).
	const isScriptWord = (i: number): boolean => {
		const w = suffixWords[i];
		if (quotedScriptPattern.test(w)) {
			return (
				unquotedExpansionFlags[i] !== true && isScriptShaped(w.slice(1, -1))
			);
		}
		return isScriptShaped(w);
	};
	// Flags that consume the next word as their argument, per command. sed's
	// `-E` is a bare switch (extended regex); perl's `-E` is a script like `-e`.
	const flagArgs =
		lowerName === 'sed'
			? new Set(['-e', '-f', '--expression', '--file'])
			: lowerName === 'perl'
				? new Set(['-e', '-E'])
				: new Set(['-f', '-e', '-v', '-F']);
	// perl bundles a run of argument-less switches before a script flag:
	// `-pe`, `-lne`, `-wpe`, `-0777ne`. `i` is never part of the run, because
	// it takes the rest of the word as a backup suffix (`-pie` is `-p -i`
	// with suffix `e`). Both patterns share the same switch class.
	const combinedFlagArgs = /^-[0-9AacSlnpstTuUwWX]+[eE]$/;
	const perlAttachedScript = /^-[0-9AacSlnpstTuUwWX]*[eE]./;
	// GNU sed lets bare switches bundle with `-e`/`-f`: `-ne`, `-Ee`, `-nf`,
	// `-be`. Like perl, `i` stays out: GNU sed reads `-ie` as `-i` with
	// suffix `e`. The switch class is sed's argument-less short options.
	const sedScriptBundle = /^-[nrEszub]*[ef]$/;
	const sedAttachedScript = /^-[nrEszub]*[ef]./;
	const consumesNext = (w: string): boolean =>
		flagArgs.has(w) ||
		(lowerName === 'sed' && sedScriptBundle.test(w)) ||
		(lowerName === 'perl' && combinedFlagArgs.test(w));
	// Whether `w` supplies the script, detached (`-e X`) or attached
	// (`-e1d`, `-e's/a/b/'`, `-fs.sed`, `--file=p.awk`, `-pe1`). gawk takes
	// program files with `-f` and program text with `-e`/`--source`.
	const suppliesScript = (w: string): boolean => {
		if (lowerName === 'awk') {
			return (
				w === '-f' ||
				w === '-e' ||
				/^-[fe]./.test(w) ||
				w.startsWith('--file=') ||
				w.startsWith('--source=')
			);
		}
		if (lowerName === 'sed') {
			return (
				consumesNext(w) ||
				sedAttachedScript.test(w) ||
				/^--(?:expression|file)=/.test(w)
			);
		}
		return consumesNext(w) || perlAttachedScript.test(w);
	};
	// Whether the script is supplied by a flag. If so, the word after a bare
	// `-i` is never the script; if not, it is (GNU sed, perl) or it is a BSD
	// detached backup suffix with the script right after it. Only options
	// count: after `--` a word like `-e/../x` is an operand, and a word an
	// option consumes (`awk -v`, `-F`, `-i`) is that option's argument.
	// #3569 4.5 r3 (reviewer Critical): the flag/node arrays are
	// index-parallel to the RAW suffix — slice them by the same
	// wrapper-consumed count so every positional lookup aligns with the
	// consumed-tail window (misaligned, a chdir wrapper's brace script was
	// consumed as one word and its file branches dropped: `env -C src sed -i
	// {s/a/b/,../../outside} y` ADMITTED while bash edited ../../outside).
	const expansionFlags =
		getSuffixWordExpansionFlags(cmd).slice(inplaceConsumed);
	const unquotedExpansionFlags =
		getSuffixWordUnquotedExpansionFlags(cmd).slice(inplaceConsumed);
	// The GNU script slot (the first positional with no script flag) holds
	// one script only if the word stays one word. A parameter, command or
	// arithmetic expansion can field-split (`S='1d ../../x'; sed -i $S f`)
	// and a brace expansion multiplies (`sed -i {1d,../../v} f`): the first
	// resulting word is the script and the rest are files. Such a word is
	// never consumed as the script; it is reported (blocked as a dynamic
	// target or resolved as a path). Glob characters are left out on purpose:
	// regex scripts (`'/^\s*$/d'`) carry them and the parser drops quotes.
	// Only a plain double-quoted parameter expansion (`"$S"`, `"${S}"`,
	// `"${S:-a b}"`, `"s/$a/$b/"`) is taken to stay one word. Any word with an
	// unquoted expansion, a command or arithmetic substitution (`$(`, `$((`,
	// a backtick, quoted or not) or a list expansion (`$@`, `$*`, `${A[@]}`,
	// `${A[*]}`, quoted or not) is treated as splitting
	// (getSuffixWordUnquotedExpansionFlags). A brace expansion counts only
	// when its braces and separator are outside quotes and backslash escapes
	// (`'{gsub(/\t/," ")}1'` and `'{print $1,$2}'` are one word each); a word
	// whose source text is not trusted is judged on its parsed text.
	const suffixNodes = (
		Array.isArray((cmd as BashCommand).suffix)
			? ((cmd as BashCommand).suffix as unknown[])
			: []
	)
		.filter((s) => wordText(s) !== null)
		.slice(inplaceConsumed);
	const mayExpandToSeveralWords = (i: number): boolean =>
		unquotedExpansionFlags[i] === true ||
		hasUnquotedBraceExpansion(suffixNodes[i], suffixWords[i]);
	// The same holds for an option word: `-e$X`, `-n$X`, `-i$X`, `-f$X`,
	// `--expression=$X` or `-e{1d,x}` can split into several options,
	// scripts and files at run time. Such a flag word never supplies or
	// consumes a script, never consumes an option argument, and is reported
	// as a (dynamic) candidate; with one present, no word at all is taken
	// for the implicit script, so every positional is reported (isOpaqueFlag).
	// Option words the picker models, per command. Every other option word
	// (a GNU long-option abbreviation such as `--expr=`, `--e=`, `--sourc=`; a
	// bundle with a letter not listed here such as perl `-fpe...`, `-pde...`
	// or awk `-be...`; an option such as awk `-W`, `-E`, `-b`, `-M`) may take
	// an argument, supply the script, or both. Treating it as an
	// argument-less switch would let the picker take the real file for the
	// implicit script and report nothing. It is handled like an expanding
	// flag word instead: reported as a candidate, never supplying or
	// consuming a script, and no later word is taken for the implicit script
	// or the awk program (see isOpaqueFlag).
	const isKnownOption = (w: string): boolean => {
		if (w === '-' || w === '--') return true;
		if (lowerName === 'sed') {
			return (
				// argument-less switches, alone or bundled: -n -r -E -s -z -u -b
				/^-[nrEszub]+$/.test(w) ||
				// -e/-f with the script detached or attached, after switches
				/^-[nrEszub]*[ef]/.test(w) ||
				// -l N or -lN, after switches
				/^-[nrEszub]*l/.test(w) ||
				// -i and -i<suffix>
				/^-i/.test(w) ||
				SED_LONG_SWITCHES.has(w) ||
				/^--(?:expression|file|line-length|in-place)(?:=|$)/.test(w)
			);
		}
		if (lowerName === 'perl') {
			return (
				// argument-less switches, optionally ending in -e/-E and its script
				/^-[0-9AacSlnpstTuUwWX]*(?:[eE].*)?$/.test(w) ||
				/^-i/.test(w) ||
				/^-I./.test(w)
			);
		}
		return (
			// -f -e -v -F -i -l, argument detached or attached
			/^-[fevFil]/.test(w) ||
			/^-[PcrSVh]$/.test(w) ||
			AWK_LONG_SWITCHES.has(w) ||
			/^--(?:file|source|lint)=/.test(w)
		);
	};
	// A flag word whose meaning the picker cannot pin down: one that may
	// expand to several words, or an option it does not model. Only options
	// count, so only words before `--` are checked by the callers.
	const isOpaqueFlag = (i: number): boolean =>
		suffixWords[i].startsWith('-') &&
		(mayExpandToSeveralWords(i) || !isKnownOption(suffixWords[i]));
	// GNU sed options that take a detached argument but never the script:
	// `-l N` (also bundled, `-nl N`) and `--line-length N`. The argument is
	// neither the script nor a file.
	const sedOptionArg = (w: string): boolean =>
		lowerName === 'sed' && (/^-[nrEszub]*l$/.test(w) || w === '--line-length');
	// The detached argument of an option (`-e X`, `-f X`, `-l N`,
	// `--expression X`, awk `-v`/`-F`/`-i X`, perl `-e X`) is normally
	// skipped as that option's argument. If it may expand to several words
	// (`X='1d ../../v'; sed -e $X -i f` runs `sed -e 1d ../../v -i f`), the
	// extra words are files: such an argument is reported as a (dynamic)
	// candidate, the option does not count as supplying the script, and no
	// word is taken for the implicit script.
	const takesDetachedArg = (w: string): boolean =>
		consumesNext(w) || sedOptionArg(w) || (lowerName === 'awk' && w === '-i');
	// Every detached option argument, found in one left-to-right scan the way
	// getopt reads the words: an option that takes an argument consumes the
	// next word whatever it looks like (`awk -F -f '{...}' f` sets FS to
	// `-f`; the program is `{...}`). A consumed argument is never parsed again
	// as an option, a flag, the script or the awk program, in any scan below.
	//
	// A detached argument also splits when it holds a glob that the shell
	// expands (`sed -i --file ../[ab].sed src/a.ts` runs sed with the script
	// file ../a.sed and the files ../b.sed and src/a.ts). The argument of a
	// file-taking option (sed `-f`/`--file`, awk `-f`/`-i`) splits on any `*`,
	// `?` or `[`; any other argument (a script, `-l N`, awk `-v`/`-F`) only on
	// one outside quotes and backslash escapes, so `sed -i -e 's/a*/b/' f` is
	// unaffected. The GNU and BSD script slots keep their own rule (a glob
	// there is not treated as splitting).
	//
	// GNU sed permutes its arguments, so options are read across the whole
	// command until `--`. perl and gawk stop reading options at the first
	// operand (the script or program, or the first file once `-e`/`-f`
	// supplied it): every later word, including one that starts with `-`,
	// is an operand and is reported as a file (`awk -i inplace '{print}' f
	// -v ../v` edits f, a file named -v and ../v).
	const fileArgOption = (w: string): boolean =>
		(lowerName === 'sed' && (/^-[nrEszub]*f$/.test(w) || w === '--file')) ||
		(lowerName === 'awk' && (w === '-f' || w === '-i'));
	const detachedArgMaySplit = (option: string, i: number): boolean =>
		mayExpandToSeveralWords(i) ||
		(fileArgOption(option)
			? /[*?[]/.test(suffixWords[i])
			: hasUnquotedGlob(suffixNodes[i]));
	const permutes = lowerName === 'sed';
	let operandsFrom = suffixWords.length;
	const optionArgs = new Set<number>();
	const expandingOptionArgs = new Set<number>();
	for (let i = 0; i < suffixWords.length; i++) {
		const w = suffixWords[i];
		if (w === '--') {
			if (!permutes) operandsFrom = i + 1;
			break;
		}
		if (!w.startsWith('-')) {
			if (!permutes) {
				operandsFrom = i;
				break;
			}
			continue;
		}
		// perl and awk: an opaque flag word (an option the picker does not
		// model, or one that may expand) may take the next words or end the
		// options (gawk `-E file`), so option parsing stops after it and every
		// later word is reported as an operand.
		if (isOpaqueFlag(i)) {
			if (!permutes) {
				operandsFrom = i + 1;
				break;
			}
			continue;
		}
		if (!takesDetachedArg(w)) continue;
		if (i + 1 < suffixWords.length) {
			optionArgs.add(i + 1);
			if (detachedArgMaySplit(w, i + 1)) {
				expandingOptionArgs.add(i + 1);
				// perl and awk: the extra words of a split argument are operands,
				// so every later word is one too (`awk -f ../[ab].awk -v f`).
				if (!permutes) {
					operandsFrom = i + 2;
					break;
				}
			}
		}
		i++;
	}
	// Whether word i sits where an option can (perl and awk: before the
	// first operand; sed: anywhere before `--`, checked by the callers).
	const inOptionArea = (i: number): boolean => i < operandsFrom;
	let hasExplicitScript = false;
	for (let i = 0; i < suffixWords.length && inOptionArea(i); i++) {
		if (optionArgs.has(i)) continue;
		const w = suffixWords[i];
		if (w === '--') break;
		if (!w.startsWith('-') || isOpaqueFlag(i)) continue;
		if (expandingOptionArgs.has(i + 1)) {
			i++;
			continue;
		}
		if (suppliesScript(w)) {
			hasExplicitScript = true;
			break;
		}
		if (consumesNext(w) || (lowerName === 'awk' && w === '-i')) i++;
	}
	const skipIndices = new Set<number>();
	// Only BSD sed takes a detached backup suffix (`sed -i '' X f`,
	// `sed -i .bak X f`). perl never does: `perl -i ./s.pl f` runs ./s.pl on f.
	const isDetachedSuffix = (w: string | undefined): w is string =>
		lowerName === 'sed' && w !== undefined && (w === '' || w.startsWith('.'));
	// Index of the first word at or after `from` that is not a switch and not
	// `--`; that word is where an implicit script (or a BSD suffix) sits.
	// `sed -i -n 1d f`, `sed -i -- 1d f`: the switches between are skipped
	// as flags by the main loop; none of them consumes a word, or
	// hasExplicitScript would be true.
	// A word after the BSD script slot that is a plausible file: not empty,
	// not filtered as a script below, and not shaped like a sed script.
	// The BSD reading applies only to a pure literal script word. A word with
	// a parameter, command or arithmetic expansion (`$D`, `${D}`, `$(pwd)`),
	// a brace expansion (`{..,a}`, `{1..3}`) or a glob character (`*`, `?`,
	// `[`) becomes something else before sed sees it, possibly an absolute
	// path or a path with `..`, so it is never taken for the script. The
	// parser drops quotes, so brace and glob characters count even when they
	// were quoted (the fail-safe direction).
	const isLiteralWord = (i: number): boolean =>
		expansionFlags[i] !== true &&
		!/[*?[]/.test(suffixWords[i]) &&
		!/\{[^{}]*(?:,|\.\.)[^{}]*\}/.test(suffixWords[i]);
	const isLiteralSedScript = (i: number): boolean =>
		isLiteralWord(i) && looksLikeSedScript(suffixWords[i]);
	const isReportableWord = (i: number): boolean =>
		suffixWords[i] !== '' && !isScriptWord(i) && !isLiteralSedScript(i);
	const firstPositionalFrom = (from: number): number => {
		let j = from;
		while (
			j < suffixWords.length &&
			((inOptionArea(j) && suffixWords[j].startsWith('-')) || optionArgs.has(j))
		)
			j++;
		return j;
	};
	// Consume the implicit script starting at `from`. Only the first in-place
	// flag places the script; a repeated `-i` (`sed -i 1d -i f`) neither moves
	// it nor rescans the switch run, which made a long run of `-i` flags
	// quadratic.
	//
	// After a bare `-i`, BSD sed reads `'' SCRIPT FILE` (`.bak SCRIPT FILE`)
	// as suffix, script, file, while GNU sed reads the same words as script
	// and files: `sed -n -i '' f` runs the empty script and truncates f, and
	// `sed -i '' /etc/passwd x -n` edits /etc/passwd. The BSD reading (the
	// word after the suffix is skipped as the script) is taken only when that
	// word is shaped like a sed script and a reportable file still follows
	// it; otherwise the suffix word is the GNU script and every later
	// positional is reported as a file. A word with a `..` path component is
	// never taken for the script, and neither is a word with an expansion, a
	// brace expansion or a glob character (`$D`, `${D}`, `$(pwd)`, `{..,a}`,
	// `.?`): the BSD reading applies only to pure literal words. The residual
	// is a literal file named like a sed script with no `..` component (`1d`,
	// `$d` single-quoted, `N;P;D`, `s-a-b-g`) in that one slot: it is taken
	// for the BSD script and not reported. A bare-letter BSD script
	// (`sed -i '' d f`) is over-reported (`d` and `f`). An attached suffix
	// (`-i.bak`) leaves no room for a detached one.
	// The end of the options: the first `--` that is not an option's argument.
	const dashDash = suffixWords.findIndex(
		(w, i) => w === '--' && !optionArgs.has(i) && inOptionArea(i),
	);
	// An opaque flag word (one that may expand, or an option the picker does
	// not model) can supply the script itself, so with one present no word
	// is taken for the implicit script (sed, perl) or the program (awk), so
	// every positional is a reported candidate.
	const hasOpaqueFlag = suffixWords.some(
		(_w, i) =>
			(dashDash < 0 || i < dashDash) &&
			inOptionArea(i) &&
			!optionArgs.has(i) &&
			isOpaqueFlag(i),
	);
	let implicitScriptPlaced = hasOpaqueFlag || expandingOptionArgs.size > 0;
	// GNU sed permutes its arguments, so with no script flag the script is
	// the first positional word even when it comes before the in-place flag:
	// `sed 1d -i f` and `sed s/a/b/ -i ../x` edit f and ../x. That word is
	// the script, no later word is, and every other positional is a file.
	// A word that can become several words (mayExpandToSeveralWords) is not
	// consumed as the script in this slot either; it is reported. Scanning
	// stops at the first in-place flag (whose own script slot is handled by
	// consumeImplicitScript) or at `--`.
	if (lowerName === 'sed' && !hasExplicitScript && !implicitScriptPlaced) {
		for (let i = 0; i < suffixWords.length; i++) {
			if (optionArgs.has(i)) continue;
			const w = suffixWords[i];
			if (w === '--' || w.startsWith('-i') || w.startsWith('--in-place')) break;
			if (w.startsWith('-')) continue;
			if (!mayExpandToSeveralWords(i)) skipIndices.add(i);
			implicitScriptPlaced = true;
			break;
		}
	}
	const consumeImplicitScript = (from: number, bareInplace: boolean): void => {
		if (implicitScriptPlaced) return;
		implicitScriptPlaced = true;
		const j = firstPositionalFrom(from);
		if (j >= suffixWords.length || mayExpandToSeveralWords(j)) return;
		skipIndices.add(j);
		if (!bareInplace || !isDetachedSuffix(suffixWords[j])) return;
		const k = firstPositionalFrom(j + 1);
		if (k >= suffixWords.length || !isLiteralSedScript(k)) {
			return;
		}
		for (let m = firstPositionalFrom(k + 1); m < suffixWords.length; ) {
			if (isReportableWord(m)) {
				skipIndices.add(k);
				return;
			}
			m = firstPositionalFrom(m + 1);
		}
	};
	// With a script flag, GNU sed reads the word after a bare `-i` as a file
	// (`sed -e X -i ../x f` edits ../x and f) while BSD sed reads it as a
	// backup suffix (`sed -i .bak -e X f`). Only a conventional backup suffix
	// (`.bak`, `.orig`, `.old`, `.save`, `.backup`, `.swp`, `.~`, or a temp-file
	// suffix) is
	// taken as the BSD suffix; it is reported as the file only when nothing
	// else is left. Any other dot-word (`.env`, `./x`, `../x`, `.a/b`) is a
	// file. Without a script flag a dot-word in that slot is GNU's script,
	// which sed rejects (`.` is not a command), so nothing is written there.
	const isConventionalBackupSuffix = (w: string | undefined): w is string =>
		isDetachedSuffix(w) &&
		!w.includes('/') &&
		/^\.(?:bak|orig|old|save|backup|tmp|swp|~)$/i.test(w);
	let dotWordAfterBareInplace: string | null = null;
	let pastDoubleDash = false;
	let awkProgramSeen = false;
	for (let i = 0; i < suffixWords.length; i++) {
		const word = suffixWords[i];
		// A detached option argument is that option's argument and nothing
		// else; one that may expand is reported (see expandingOptionArgs).
		if (optionArgs.has(i)) {
			if (!expandingOptionArgs.has(i)) skipIndices.add(i);
			continue;
		}
		if (!pastDoubleDash && word === '--' && inOptionArea(i)) {
			skipIndices.add(i);
			pastDoubleDash = true;
			continue;
		}
		if (!pastDoubleDash && inOptionArea(i) && word.startsWith('-')) {
			// An opaque flag word is reported (see isOpaqueFlag).
			if (isOpaqueFlag(i)) continue;
			// A flag is never the file.
			skipIndices.add(i);
			const next = suffixWords[i + 1];
			if (
				lowerName === 'sed' &&
				(word === '--in-place' || word.startsWith('--in-place='))
			) {
				// GNU sed's long in-place flag. It takes no detached suffix (BSD
				// sed has no long form), so the next positional word is the script
				// unless a script flag supplied it: `sed --in-place 1d f`.
				if (!hasExplicitScript) consumeImplicitScript(i + 1, false);
				continue;
			}
			if (word === '-i') {
				if (next === undefined) continue;
				if (lowerName === 'awk') {
					// gawk `-i <library>`
					if (!expandingOptionArgs.has(i + 1)) skipIndices.add(i + 1);
				} else if (!hasExplicitScript) {
					consumeImplicitScript(i + 1, true);
				} else if (isConventionalBackupSuffix(next)) {
					// An empty BSD suffix (`-i ''`) needs no handling here: the
					// candidate filter below never reports an empty word.
					skipIndices.add(i + 1);
					dotWordAfterBareInplace = next;
				}
				continue;
			}
			if (/^-i.+/.test(word)) {
				// Attached backup suffix (`-i.bak`, `-ibak`) or gawk `-iinplace`:
				// the flag is complete. For sed/perl without a script flag the
				// next positional word is the script; for awk the program is
				// found by the positional rule below.
				if (lowerName !== 'awk' && !hasExplicitScript) {
					consumeImplicitScript(i + 1, false);
				}
				continue;
			}
			if (consumesNext(word) || sedOptionArg(word)) {
				if (next !== undefined && !expandingOptionArgs.has(i + 1)) {
					skipIndices.add(i + 1);
				}
			}
			continue;
		}
		if (skipIndices.has(i)) continue;
		// (An option argument never reaches this point: the optionArgs branch
		// at the top of the loop skips or reports it.)
		if (lowerName === 'awk') {
			// The first positional word is the program unless `-f`/`-e`
			// supplied it, or an opaque flag word or an option argument that may
			// split (`-f ../[ab].awk`, `-v $X`) may have supplied it or shifted
			// it. #3569 4.5 r4/r5 (reviewer Critical): a word that may expand
			// to several words (`{1,../../outside}` — the first branch is the
			// program, the REST are files) is NEVER consumed as the program,
			// AND it still SATISFIES the program slot (mirroring the sed/perl
			// guard's implicitScriptPlaced): the next positional must not be
			// eaten as a phantom program (`awk -i inplace {src,src/a}
			// ../outside` used to drop ../outside entirely).
			if (
				!hasExplicitScript &&
				!hasOpaqueFlag &&
				expandingOptionArgs.size === 0 &&
				!awkProgramSeen
			) {
				awkProgramSeen = true;
				if (!mayExpandToSeveralWords(i)) {
					skipIndices.add(i);
				}
			}
			continue;
		}
		if (isScriptWord(i)) skipIndices.add(i);
	}

	// The first word that is NOT skipped is the file argument.
	const candidates = suffixWords
		.map((word, i) => ({ word, i }))
		.filter(({ word, i }) => word !== '' && !skipIndices.has(i));
	if (candidates.length === 0 && dotWordAfterBareInplace !== null) {
		candidates.push({ word: dotWordAfterBareInplace, i: -1 });
	}

	if (candidates.length > 0) {
		// GNU sed, perl -i and gawk -i inplace edit every remaining word as a
		// file, so each one is reported in word order; reporting a single chosen
		// one would let any other edited file (`sed -i -e 1d '../{a}' src/a.ts`,
		// `perl -i -pe X src/a.ts /etc/passwd`) escape the check. A non-file awk
		// operand (`var=val`) is reported too (fail-safe over-report).
		// #3491 closure F-1 (AC9, the ABSORB record 08a:55-60): each
		// destination word routes through the W8 brace engine — bash expands
		// `sed -i s/a/b/ src/{a,../esc}` into TWO file operands and sed edits
		// EVERY one (ground truth), so per-branch emission is bash-exact;
		// refusal classes land on the existing unconditional dynamic() path.
		for (const { word, i } of candidates) {
			pushExpandedDestination(
				results,
				i >= 0 ? suffixNodes[i] : undefined,
				word,
				0,
				(path) => ({
					category: 'inplace_edit',
					operator: `${lowerName} -i`,
					path,
				}),
				() => ({
					category: 'inplace_edit',
					operator: `${lowerName} -i`,
					path: null,
					dynamicSourceWord: word,
				}),
			);
		}
	}

	return results;
}

/**
 * #3474: classify a pipeline whose LAST command is a stdin-fed interpreter
 * (bare, or with the explicit `-` stdin flag) and whose OTHER commands are
 * all literal `echo`/`printf` producers (no expansion children, no
 * redirects): the piped literal text IS the interpreter's program, so the
 * pipeline is an inline eval. A `< file` stdin redirect on the interpreter
 * overrides the pipe (script-path carve-out, #1901/#1902). Dynamic producers
 * (`grep`, command substitution) are deliberately OUT — their output is
 * data-dependent, closer to the script-path class (maintainer ruling,
 * issue comment 6434171372). Shared by BOTH walkers so the emitted write
 * pairs with its tracked cwd in resolveWriteTargets.
 */
function classifyPipeStdinEval(node: unknown): WriteTarget | null {
	if (!node || typeof node !== 'object') return null;
	const pipeline = node as { type?: string; commands?: unknown };
	if (pipeline.type !== 'Pipeline' || !Array.isArray(pipeline.commands)) {
		return null;
	}
	if (pipeline.commands.length < 2) return null;
	// #impl-review r1 F3: the interpreter may sit at ANY position ≥1 —
	// `echo CODE | python | cat` still executes the piped program. The
	// commands BEFORE it must all be literal echo/printf producers; the
	// commands AFTER it consume its output and are irrelevant.
	for (let pos = pipeline.commands.length - 1; pos >= 1; pos--) {
		const evalWrite = classifyPipeStdinEvalAt(node, pos);
		if (evalWrite) return evalWrite;
	}
	return null;
}

function classifyPipeStdinEvalAt(
	node: unknown,
	pos: number,
): WriteTarget | null {
	const pipeline = node as { type?: string; commands?: unknown };
	if (!Array.isArray(pipeline.commands)) return null;
	const last = pipeline.commands[pos];
	const canonical = detectorSetMember(
		detectorCommandLeaf(last),
		INTERPRETER_EVAL_COMMANDS,
	);
	if (!canonical || canonical === 'eval') return null;
	// Interpreter must be stdin-fed from the pipe: no arguments at all, or
	// exactly the explicit stdin flag `-`. Anything else is the script-file
	// or flag form (carve-out). #3485 (PRR-006): the shape check must use the
	// WRAPPER-CONSUMED token tail — the raw suffix of `env python` still holds
	// the wrapper word and would defeat the wrapper-aware leaf lookup above.
	// #3491 W7: deno's stdin shape is `run -` (`deno run -` reads the module
	// from stdin; source: deno CLI docs — explicit disposition per the plan
	// critic, this IS a stdin-eval shape).
	const { leaf: _leaf, rest } = detectorCommandPartsFromWords(
		getCommandName(last),
		getSuffixWords(last),
	);
	const stdinShapeOk =
		rest.length === 0 ||
		(rest.length === 1 && rest[0] === '-') ||
		(canonical === 'deno' &&
			rest.length >= 2 &&
			rest[0] === 'run' &&
			rest[rest.length - 1] === '-' &&
			// #3572 review N-06: argument-less run flags between `run` and the
			// stdin `-` (`deno run -A -` — the write-capable allow-all form)
			// are the SAME stdin-eval shape; each dash word is argument-less
			// by the disclosed carve-out (a value-taking flag puts a non-dash
			// word in the walk, which fails this check and keeps the disclosed
			// no-classification disposition for that spelling).
			rest.slice(1, -1).every((word) => word.startsWith('-')));
	if (!stdinShapeOk) {
		return null;
	}
	// A stdin redirect on the interpreter overrides the pipe (`< file`,
	// `<< heredoc`: bash-parser types LESS/HEREDOC on the redirect's op node;
	// simple commands carry redirects inside suffix/prefix, so use the
	// shared accessor).
	for (const r of getRedirections(last)) {
		const opType = (r as { op?: { type?: unknown } }).op?.type;
		if (typeof opType === 'string' && /LESS|HEREDOC/i.test(opType)) {
			return null;
		}
	}
	// #3485 (PRR-009): a heredoc overrides the pipe as well, and bash-parser
	// carries `<<` as a suffix WORD node (type dless) that getSuffixWords
	// skips — check the raw suffix nodes.
	const rawSuffixNodes = (last as { suffix?: unknown }).suffix;
	if (Array.isArray(rawSuffixNodes)) {
		for (const node of rawSuffixNodes) {
			if (
				node &&
				typeof node === 'object' &&
				(node as { type?: unknown }).type === 'dless'
			) {
				return null;
			}
		}
	}
	// Every producer before the interpreter must be a literal echo/printf.
	for (let i = 0; i < pos; i++) {
		const producer = pipeline.commands[i];
		const leaf = detectorCommandLeaf(producer);
		if (leaf !== 'echo' && leaf !== 'printf') return null;
		const expansions = getSuffixWordExpansionFlags(producer);
		const words = getSuffixWords(producer);
		for (let w = 0; w < words.length; w++) {
			if (w < expansions.length && expansions[w]) return null;
		}
		// #3485 (PRR-011): simple commands carry redirects inside
		// suffix/prefix — use the shared accessor, not the (absent)
		// `.redirections` field.
		if (getRedirections(producer).length > 0) {
			return null;
		}
	}
	return {
		category: 'interpreter_eval',
		operator: `${canonical} [eval stdin]`,
		path: null,
		capability: true,
	};
}

/**
 * Depth-first walk emitting classifyPipeStdinEval's writes in the same
 * order collectWritesWithNodes visits Pipeline nodes.
 */
function collectPipeStdinEvals(node: unknown, out: WriteTarget[]): void {
	if (!node || typeof node !== 'object') return;
	if (Array.isArray(node)) {
		for (const child of node) collectPipeStdinEvals(child, out);
		return;
	}
	// #3485 (PRR-003): POST-ORDER — descend first, classify after, exactly
	// matching collectWritesWithNodes' Pipeline emission (children, then the
	// pipeline's own stdin-eval). A pre-order walk inverted the occurrence
	// pairing for nested pipelines (outer classified before inner here but
	// after it in the resolve walker), crossing the #N suffix↔context pairing.
	for (const value of Object.values(node)) {
		if (value && typeof value === 'object') collectPipeStdinEvals(value, out);
	}
	const candidate = classifyPipeStdinEval(node);
	if (candidate) out.push(candidate);
}

/**
 * #3491 W4 fix-round-2..5: the sh-family invocation-flag walk (shared by
 * detectInterpreterEval here and the dc shell-wrapper extractor in
 * destructive-command.ts — both consume QUOTE-REMOVED word lists). The final
 * critic ground-truthed that `-c` was only recognized as the FIRST token
 * after the shell name: `sh -xc 'echo x > ../x'`, `bash -lc`, `dash -xc`,
 * `env sh -xc`, `/bin/sh -xc` all ADMITTED while real bash executes the
 * payload. The walk follows the sh getopt grammar instead, complete over
 * four dimensions (all ground-truthed on bash 5.3.9):
 *
 * 1. WHICH letters are options: short flags may be CLUSTERED (`-xc`, `-lc`,
 *    `-eo`, `-ceu`); every member letter must be KNOWN — argument-less
 *    members walk on, arg-taking members are counted. A cluster carrying
 *    TWO OR MORE arg-taking members (`-oc`, `-co`, `-cc`) or any unknown
 *    letter is deny-on-uncertainty — as is the tail-glued `-c'code'`
 *    spelling (rc=1 invalid bash; the glued text lands as member letters).
 * 2. WHERE arg-taking members draw arguments: o/O take the next standalone
 *    word VERBATIM as their optname (dash-led/empty ⇒ bash errors rc=2 ⇒
 *    'uncertain'; `bash -oc pipefail 'code'` runs the code — o→pipefail;
 *    `bash -opipefail -c 'code'` is rc=2 — o took `-c` as its optname).
 *    The cluster tail is NEVER an argument.
 * 3. WHICH word `c` selects (fix-round-5): `c` does NOT grab the next word
 *    verbatim — option parsing CONTINUES past it, and the command string is
 *    the FIRST NON-OPTION word (`bash -c '-e' 'echo x > t1'` rc=0 executes
 *    the second word; `bash -c -x 'code'` runs with xtrace; `bash -c -c
 *    'code'` and `bash -c '-c' 'code'` run the code — a repeated c just
 *    re-flags; `bash -c -o pipefail 'code'`, `bash -c +o pipefail 'code'`
 *    run the code). A pending c with NO non-option word is 'uncertain'
 *    (bash: -c requires an argument). Words after the payload are $0/$1…
 *    and are never scanned.
 * 4. `--` handling: `--` (and a lone `-`) ends option parsing (`sh -c --
 *    'code'` runs; `bash -c - 'code'` runs). With a pending c the FIRST
 *    operand after the terminator is the command string, flag-shaped or
 *    not (`bash -c -- '-e' 'code'` is rc=127 — bash ran '-e'); without one
 *    it is the script-file operand.
 *
 * Long flags are recognized only BEFORE short-option parsing starts (bash's
 * own usage line: "[GNU long option] [option] …"): after a short/+ cluster
 * or terminator, a `--word` is a short cluster whose leading '-' letter is
 * invalid — bash errors rc=2 (`bash -c --rcfile /dev/null 'code'`) ⇒
 * 'uncertain'.
 *
 * Any token the walk cannot classify yields 'uncertain' — consumers must
 * fail closed on it, never admit (deny-on-uncertainty).
 */
export type ShellCommandFlagWalk =
	| { kind: 'payload'; payload: string }
	| { kind: 'script' }
	| { kind: 'uncertain' };

/** Argument-less short flag members (sh/bash/dash/zsh/ksh invocation union;
 * covers bash 5.x's `-abefhkmnptuvxBCEHPT` + invocation-only `-ilrsD`). */
const SHELL_ARGLESS_SHORT_FLAGS = new Set([...'abefhiklmnprstuvxBCDEHPTV']);
/** bash argument-less long invocation flags (dash/zsh share the common ones;
 * enumerated from bash 5.x's own usage dump). */
const SHELL_ARGLESS_LONG_FLAGS = new Set([
	'--debug',
	'--debugger',
	'--dump-po-strings',
	'--dump-strings',
	'--help',
	'--login',
	'--noediting',
	'--noprofile',
	'--norc',
	'--posix',
	'--pretty-print',
	'--protected',
	'--restricted',
	'--verbose',
	'--version',
	'--wordexp',
]);
/** bash arg-taking long invocation flags (`--init-file FILE`, `--rcfile FILE`). */
const SHELL_ARG_TAKING_LONG_FLAGS = new Set(['--init-file', '--rcfile']);

/**
 * Scan one option cluster's member letters (#3491 W4 fix-round-4): every
 * member must be a KNOWN option letter — argument-less members walk on,
 * argument-taking members are COUNTED. The cluster tail is NEVER an
 * argument: bash assigns every arg-taking letter's argument from the
 * FOLLOWING standalone words in order (ground truth, re-verified locally on
 * bash 5.3.9: `bash -oc pipefail 'code'` runs the code — o→pipefail,
 * c→payload; `bash -opipefail -c 'code'` is rc=2 — the glued letters parsed
 * as options and o took the next word `-c` as its optname).
 */
function scanShellOptionCluster(
	members: string,
	argTaking: readonly string[],
):
	| { kind: 'none' }
	| { kind: 'single'; member: string }
	| { kind: 'multi' }
	| { kind: 'unknown' } {
	let count = 0;
	let member = '';
	for (const ch of members) {
		if (argTaking.includes(ch)) {
			count += 1;
			member = ch;
			continue;
		}
		if (!SHELL_ARGLESS_SHORT_FLAGS.has(ch)) return { kind: 'unknown' };
	}
	if (count === 0) return { kind: 'none' };
	if (count > 1) return { kind: 'multi' };
	return { kind: 'single', member };
}

export function walkShellCommandFlags(
	words: readonly string[],
): ShellCommandFlagWalk {
	let i = 0;
	// #3491 W4 fix-round-5: a seen `c` option does not grab a word — it marks
	// that the command string is the FIRST NON-OPTION word, found wherever
	// option parsing ends (after further option words, or at the `--`/`-`
	// terminator). Long flags are recognized only before short parsing starts.
	let payloadPending = false;
	let shortParsingStarted = false;
	while (i < words.length) {
		const token = words[i];
		if (token === undefined) break;
		if (token === '--' || token === '-') {
			// The terminator ends option parsing; every remaining word is an
			// operand. With a pending c the FIRST one is the command string,
			// flag-shaped or not; without one it is the script-file operand.
			if (payloadPending) {
				const payload = words[i + 1];
				return payload === undefined
					? { kind: 'uncertain' }
					: { kind: 'payload', payload };
			}
			return { kind: 'script' };
		}
		if (token.startsWith('--') && !shortParsingStarted) {
			// Long-option phase (bash's usage: "[GNU long option] [option] …").
			const eq = token.indexOf('=');
			const head = eq === -1 ? token : token.slice(0, eq);
			if (SHELL_ARG_TAKING_LONG_FLAGS.has(head)) {
				if (eq === -1) {
					const arg = words[i + 1];
					if (arg === undefined) return { kind: 'uncertain' };
					i += 2;
				} else {
					i += 1;
				}
				continue;
			}
			if (SHELL_ARGLESS_LONG_FLAGS.has(head)) {
				i += 1;
				continue;
			}
			return { kind: 'uncertain' };
		}
		if ((token.startsWith('-') || token.startsWith('+')) && token.length > 1) {
			// Short/+ cluster phase. A `--word` that lands here (short parsing
			// already started) carries an invalid '-' member letter — bash
			// errors rc=2 — deny-on-uncertainty via the scan's unknown path.
			shortParsingStarted = true;
			const argTaking = token.startsWith('-') ? ['c', 'o', 'O'] : ['o', 'O'];
			const scan = scanShellOptionCluster(token.slice(1), argTaking);
			if (scan.kind === 'unknown' || scan.kind === 'multi') {
				return { kind: 'uncertain' };
			}
			if (scan.kind === 'none') {
				i += 1;
				continue;
			}
			if (scan.member === 'c') {
				// Dimension 3: option parsing CONTINUES past c; the payload is
				// the first non-option word (a repeated c just re-flags).
				payloadPending = true;
				i += 1;
				continue;
			}
			// o / O optname, next standalone word VERBATIM: a dash-led or
			// empty word is not a valid option name — bash errors rc=2 there.
			const optname = words[i + 1];
			if (optname === undefined || optname === '' || optname.startsWith('-')) {
				return { kind: 'uncertain' };
			}
			i += 2;
			continue;
		}
		// A non-option word: with a pending c it is the command string (the
		// first non-option word); otherwise it is the script-file operand.
		if (payloadPending) return { kind: 'payload', payload: token };
		return { kind: 'script' };
	}
	// A pending c with no non-option word: bash rejects (-c requires an
	// argument) — deny-on-uncertainty.
	return payloadPending ? { kind: 'uncertain' } : { kind: 'script' };
}

// ============================================================================
// Per-interpreter eval cluster grammars (#3491 W7)
// ============================================================================

/**
 * One interpreter's short-option cluster grammar for inline-eval detection
 * (#3491 W7). Members are grouped by arity exactly as the interpreter's own
 * getopt consumes them:
 * - `argless` — flag members that take no argument.
 * - `argTakingNext` — the FIRST such member in a token either is last (its
 *   argument is the FOLLOWING word, consumed verbatim — dash-led or not) or
 *   swallows the token TAIL as its attached argument.
 * - `optionalAttachedOnly` — members whose optional argument rides ONLY
 *   inside the token (`perl -d:Name`, `-i.bak`, `-0777`); as the last member
 *   with no tail they consume NO next word.
 * - `evalMembers` — the members whose argument is INLINE CODE (python c;
 *   perl e/E per perlrun; ruby e — n/p are loop PREFIXES, not eval).
 * - `leadingVersionSelector` — the py(1) launcher accepts one leading
 *   `-3`/`-3.12` version selector before python's own options.
 *
 * An UNKNOWN member is benign no-run, not deny-on-uncertainty: every one of
 * these interpreters rejects the whole invocation with "unknown option"
 * (ground-truthed locally on python 3.11 / perl 5.36; ruby(1) documents the
 * same behavior for invalid options) — nothing executes, so classifying an
 * eval would fabricate a block of a command that never ran.
 */
interface InterpreterClusterGrammar {
	argless: ReadonlySet<string>;
	argTakingNext: ReadonlySet<string>;
	optionalAttachedOnly: ReadonlySet<string>;
	evalMembers: ReadonlySet<string>;
	longArgless?: ReadonlySet<string>;
	leadingVersionSelector?: boolean;
}

/**
 * python(1) (3.11 manual, verified by execution): argless b B d E i I O q s
 * S u v V x; -c CODE (eval); -W/-X consume their argument (glued or next);
 * -m runs an INSTALLED module — deliberately NOT eval (issue #1902);
 * --check-hash-based-pycs=OPT takes an argument; --help/--version are
 * argument-less. The py(1) launcher (Windows) prepends one version selector.
 */
const PYTHON_CLUSTER_GRAMMAR: InterpreterClusterGrammar = {
	argless: new Set([...'bBdEiIOqsSuVvx']),
	argTakingNext: new Set([...'cWXm']),
	optionalAttachedOnly: new Set(),
	evalMembers: new Set([...'c']),
	longArgless: new Set(['--help', '--version', '--check-hash-based-pycs']),
	leadingVersionSelector: true,
};

/**
 * perlrun (perl 5.36, verified by execution): argless a c h l n p s S t T u
 * U v w W X; e/E take their program GLUED or as the NEXT word (eval);
 * F/I/m/M likewise consume the next word; d/D/V/0/i/x/C carry optional
 * ATTACHED-only arguments (`-d:Name`, `-i.bak`); `--` ends options.
 */
const PERL_CLUSTER_GRAMMAR: InterpreterClusterGrammar = {
	argless: new Set([...'achlnpsStUv', ...'wWX']),
	argTakingNext: new Set([...'eEFImM']),
	optionalAttachedOnly: new Set([...'dDV0ixC']),
	evalMembers: new Set([...'eE']),
};

/**
 * ruby(1) (doc-sourced; ruby is not installed on this host): argless a c l
 * n p s S v w; e takes its program glued or next (eval); F/I/r/E consume
 * their argument; W/0/i/x carry optional attached arguments; -r REQUIRES a
 * library (not eval); -E selects an ENCODING (not eval — unlike perl's -E).
 */
const RUBY_CLUSTER_GRAMMAR: InterpreterClusterGrammar = {
	argless: new Set([...'aclnpsSvw']),
	argTakingNext: new Set([...'eFIrE']),
	optionalAttachedOnly: new Set([...'W0ix']),
	evalMembers: new Set([...'e']),
};

/**
 * deno global flags that may precede a subcommand WITHOUT an argument
 * (deno CLI docs; `deno help`): -q/--quiet, --unstable, --no-check,
 * --check, --no-config, --no-remote, --no-lock, --cached-only, -h/--help,
 * --version.
 */
const DENO_GLOBAL_ARGLESS_FLAGS = new Set([
	'-q',
	'--quiet',
	'--unstable',
	'--no-check',
	'--check',
	'--no-config',
	'--no-remote',
	'--no-lock',
	'--cached-only',
	'-h',
	'--help',
	'--version',
]);

/**
 * Scan an interpreter's argument words for an inline-code eval member
 * (#3491 W7). Returns true when the invocation evaluates inline code.
 */
function scanInterpreterEvalCluster(
	grammar: InterpreterClusterGrammar,
	words: readonly string[],
): boolean {
	let i = 0;
	if (grammar.leadingVersionSelector && /^-\d(\.\d+)?$/.test(words[0] ?? '')) {
		i += 1;
	}
	while (i < words.length) {
		const token = words[i];
		if (token === undefined) break;
		if (token === '--' || token === '-') {
			// End of the interpreter's options: a script file or argv follows —
			// the eval member's code word was already consumed with its flag.
			return false;
		}
		if (token.startsWith('--')) {
			const head = token.split('=')[0] ?? token;
			if (grammar.argTakingNext.has(head.slice(2) ?? '')) {
				// Long arg-taking member: glued `--flag=ARG` or spaced.
				if (token.includes('=')) {
					i += 1;
					continue;
				}
				i += 2; // flag + its argument word
				continue;
			}
			if (grammar.longArgless?.has(token) || grammar.longArgless?.has(head)) {
				i += 1;
				continue;
			}
			// Unknown long option: the interpreter errors out and nothing runs.
			return false;
		}
		if (token.startsWith('-') && token.length > 1) {
			const members = token.slice(1);
			let sawEval = false;
			let resolved: 'argless' | 'next' | 'attached' | 'unknown' = 'argless';
			for (let m = 0; m < members.length; m++) {
				const ch = members[m];
				if (ch === undefined) break;
				if (grammar.argTakingNext.has(ch)) {
					resolved = m === members.length - 1 ? 'next' : 'attached';
					sawEval = grammar.evalMembers.has(ch);
					break;
				}
				if (grammar.optionalAttachedOnly.has(ch)) {
					// Optional attached-only member. Two tail shapes (perl 5.36
					// ground truth): `-0` consumes ONLY its attached octal DIGIT
					// run and later chars are MORE members (`-0777pe1` = -0 777,
					// -p, -e '1' — eval); every other member (`-i.bak`, `-d:Name`,
					// `-CSD`) consumes the WHOLE token tail, and as the final
					// member it consumes nothing further.
					resolved = 'argless';
					if (ch === '0') {
						while (
							m + 1 < members.length &&
							/[0-7]/.test(members[m + 1] ?? '')
						) {
							m += 1;
						}
						continue;
					}
					if (m !== members.length - 1) break; // tail consumed
					continue;
				}
				if (grammar.argless.has(ch)) continue;
				resolved = 'unknown';
				break;
			}
			if (resolved === 'unknown') return false; // unknown option: nothing runs
			if (sawEval) return true;
			i += 1;
			if (resolved === 'next') i += 1; // the argument word
			continue;
		}
		// First non-option word: the script-file operand.
		return false;
	}
	return false;
}

/**
 * Detect interpreter eval: python -c, node -e, bun -e, ruby -e, perl -e, php -r.
 * These are flagged as potential write effects because inline code can write files.
 */
function detectInterpreterEval(cmd: unknown): WriteTarget[] {
	const results: WriteTarget[] = [];
	const name = getCommandName(cmd);
	if (!name) return results;

	// Issue #3343: classify through the canonical spelling so versioned
	// (`python3.11`), path-qualified (`/usr/bin/python3`), and
	// env/command/exec-wrapped (`env python -c`) invocations cannot sidestep
	// interpreter_eval detection. The emitted operator keeps the RAW first
	// command word so diagnostics stay faithful to the invocation.
	const canonical = canonicalInterpreterName(cmd);
	if (!canonical) return [];

	const suffixWords = getSuffixWords(cmd);

	const evalFlags: Record<string, string[]> = {
		node: ['-e', '-p', '-pe'],
		bun: ['-e', '-p', '-pe'],
		php: ['-r', '-R', '-F'],
	};
	if (canonical === 'eval') {
		results.push({
			category: 'interpreter_eval',
			operator: 'eval',
			path: null,
			capability: true,
		});
		return results;
	}

	// #3491 W4 fix-round-2: the SHELL family classifies through the shared
	// invocation-flag walk (walkShellCommandFlags) — `-c` may be a CLUSTER
	// member (`bash -lc 'code'`) or follow other arg-consuming flags
	// (`bash -eo pipefail -c 'code'`), and only the words AFTER the
	// interpreter verb (through the env/command/exec wrapper chain) are its
	// own arguments. A 'script' outcome (a script-file operand, or `--`)
	// carries no inline payload; an 'uncertain' outcome (an unknown flag of
	// unknowable arity) is deny-on-uncertainty — it classifies as an eval so
	// the gate routes or denies, never admits.
	const SHELL_FLAG_WALK_CANONICALS = new Set([
		'bash',
		'sh',
		'dash',
		'zsh',
		'ksh',
	]);
	// #3491 W7: python/perl/ruby decompose their getopt CLUSTERS through
	// per-interpreter grammars (see scanInterpreterEvalCluster) — `python
	// -Bc CODE`, `perl -pe CODE`, `ruby -ne CODE` run inline code that the
	// positional matcher below never saw.
	const CLUSTER_GRAMMAR_CANONICALS = new Set([
		'python',
		'python3',
		'python2',
		'py',
		'perl',
		'ruby',
	]);
	if (SHELL_FLAG_WALK_CANONICALS.has(canonical)) {
		const words = [name, ...suffixWords];
		const interpreterIndex = canonicalInterpreterAt(words);
		const shellArgs =
			interpreterIndex >= 0 ? words.slice(interpreterIndex + 1) : suffixWords;
		const walk = walkShellCommandFlags(shellArgs);
		if (walk.kind === 'script') return results;
	} else if (canonical === 'deno') {
		// #3491 W7: deno evaluates ONLY at subcommand position — `deno eval
		// CODE` (and `deno eval -p CODE`; flags after the subcommand do not
		// remove the eval). NO --eval alias exists (source: deno CLI docs,
		// `deno help eval`; deno is not installed on this host). `deno run
		// script.ts` is a script-file run (carve-out parity with `python
		// script.py`); the `deno run -` stdin shape classifies in
		// classifyPipeStdinEval. A small set of documented argument-less
		// GLOBAL flags may precede the subcommand. #3491 closure F-2 +
		// closure round 2: a leading DASH-WORD RUN that reaches `eval`
		// (`deno --no-prompt eval CODE`, `deno --no-prompt --unstable-kv
		// eval CODE`, `deno --unstable-kv --no-check eval CODE`) is
		// deny-on-uncertainty — the W3 pattern, no flag-set enumeration:
		// every word up to the subcommand is argument-less, so the
		// subcommand is `eval` whatever the unknown flags mean. A NON-DASH
		// word inside the run is a flag argument (`deno --config x eval
		// CODE`): the subcommand position is unknowable and the disclosed
		// no-classification disposition stands (fragment Known-edges).
		const words = [name, ...suffixWords];
		const interpreterIndex = canonicalInterpreterAt(words);
		const args =
			interpreterIndex >= 0 ? words.slice(interpreterIndex + 1) : suffixWords;
		let sub = 0;
		while (
			sub < args.length &&
			DENO_GLOBAL_ARGLESS_FLAGS.has(args[sub] ?? '')
		) {
			sub += 1;
		}
		const headWord = args[sub];
		if (headWord !== 'eval') {
			let evalThroughDashRun = false;
			if (headWord?.startsWith('-')) {
				let sawUnknownFlag = false;
				for (let j = sub; j < args.length; j += 1) {
					const runWord = args[j];
					if (runWord === 'eval') {
						evalThroughDashRun = sawUnknownFlag;
						break;
					}
					// A non-dash word ends the run: it is some flag's argument,
					// the subcommand position is unknowable — keep the disclosed
					// no-classification disposition.
					if (runWord === undefined || !runWord.startsWith('-')) break;
					if (!DENO_GLOBAL_ARGLESS_FLAGS.has(runWord)) sawUnknownFlag = true;
				}
			}
			if (!evalThroughDashRun) return results;
		}
	} else if (CLUSTER_GRAMMAR_CANONICALS.has(canonical)) {
		const words = [name, ...suffixWords];
		const interpreterIndex = canonicalInterpreterAt(words);
		const args =
			interpreterIndex >= 0 ? words.slice(interpreterIndex + 1) : suffixWords;
		const grammar =
			canonical === 'perl'
				? PERL_CLUSTER_GRAMMAR
				: canonical === 'ruby'
					? RUBY_CLUSTER_GRAMMAR
					: PYTHON_CLUSTER_GRAMMAR;
		if (!scanInterpreterEvalCluster(grammar, args)) return results;
	} else {
		const relevantFlags = evalFlags[canonical] ?? [];
		// Match exact flag (-c), equals-glued (-c=CODE), or directly-glued (-cCODE / -c'code')
		const hasEvalFlag = suffixWords.some((word) =>
			relevantFlags.some(
				(f) => word === f || (word.startsWith(f) && word.length > f.length),
			),
		);
		if (!hasEvalFlag) return results;
	}

	// Interpreter eval is a write effect even without a specific file target.
	// capability marks the inspectable inline-code class the gate routes
	// through declared scope / file authority (#1902/#3347).
	results.push({
		category: 'interpreter_eval',
		operator: `${name} [eval]`,
		path: null,
		capability: true,
	});

	return results;
}

/** Detect network downloaders: curl -o, wget -O, scp. */
function detectNetworkDownloaders(cmd: unknown): WriteTarget[] {
	const results: WriteTarget[] = [];
	const name = getCommandName(cmd);
	if (!name) return results;

	const leaf = detectorCommandLeaf(cmd);
	const lowerName = detectorSetMember(leaf, NETWORK_DOWNLOAD_COMMANDS);
	if (!lowerName) return [];

	const suffixWords = getSuffixWords(cmd);
	// #3491 closure F-1: curl's -o/--output destination routes through the
	// W8 brace engine (per-branch emission; refusal → dynamic). The suffix
	// NODES carry the raw word slices the engine needs. #3491 closure round
	// 2: wget's -O destination shares the emitter (curl parity), and every
	// LITERAL destination emission in this family passes the brace-list
	// backstop below.
	const suffixNodes = (
		Array.isArray((cmd as BashCommand).suffix)
			? ((cmd as BashCommand).suffix as unknown[])
			: []
	).filter((s) => wordText(s) !== null);
	const downloadOutputEmit = (
		out: WriteTarget[],
		node: unknown,
		text: string,
		rawSkip: number,
		operator: string,
	): void => {
		pushExpandedDestination(
			out,
			node,
			text,
			rawSkip,
			(path) => ({
				category: 'network_download',
				operator,
				path,
			}),
			() => ({
				category: 'network_download',
				operator,
				path: null,
				dynamicSourceWord: text,
			}),
		);
	};
	// #3491 closure round 2 — the class-closing backstop: a destination word
	// carrying an UNQUOTED brace list that did not pass through the W8
	// engine must NEVER be emitted as a literal (isDynamicPath has no brace
	// check — #3491's own root-cause line). Emit the dynamic() refusal
	// instead: a null-path write whose dynamicSourceWord is the source word.
	const pushLiteralDestination = (
		out: WriteTarget[],
		node: unknown,
		word: string,
		operator: string,
	): void => {
		if (hasUnquotedBraceExpansion(node, word)) {
			out.push({
				category: 'network_download',
				operator,
				path: null,
				dynamicSourceWord: word,
			});
			return;
		}
		out.push({ category: 'network_download', operator, path: word });
	};

	if (lowerName === 'curl') {
		for (let i = 0; i < suffixWords.length; i++) {
			const word = suffixWords[i];
			if (word === '-o' && i + 1 < suffixWords.length) {
				const path = suffixWords[i + 1];
				if (!path.startsWith('-')) {
					downloadOutputEmit(results, suffixNodes[i + 1], path, 0, 'curl -o');
				}
			} else if (word.startsWith('-o') && word.length > 2) {
				downloadOutputEmit(results, suffixNodes[i], word, 2, 'curl -o');
			} else if (word === '--output' && i + 1 < suffixWords.length) {
				const path = suffixWords[i + 1];
				if (!path.startsWith('-')) {
					downloadOutputEmit(results, suffixNodes[i + 1], path, 0, 'curl -o');
				}
			} else if (word.startsWith('--output=') && word.length > 9) {
				downloadOutputEmit(results, suffixNodes[i], word, 9, 'curl -o');
			}
		}
	} else if (lowerName === 'wget') {
		// #3491 closure round 2: wget -O routes through the engine like curl.
		// The GLUED form expands to two -O spellings (bash ground truth) and
		// GNU getopt FILE-option semantics keep the LAST — which can be the
		// escaping branch (wget(1), doc-sourced: no wget binary on this
		// host); per-branch emission covers it. The SPACED form's second
		// branch is a URL in real wget (curl-parity over-approx, disclosed).
		for (let i = 0; i < suffixWords.length; i++) {
			const word = suffixWords[i];
			if (word === '-O' && i + 1 < suffixWords.length) {
				const path = suffixWords[i + 1];
				if (!path.startsWith('-')) {
					downloadOutputEmit(results, suffixNodes[i + 1], path, 0, 'wget -O');
				}
			} else if (word.startsWith('-O') && word.length > 2) {
				downloadOutputEmit(results, suffixNodes[i], word, 2, 'wget -O');
			}
		}
	} else if (lowerName === 'scp') {
		// #3569 residual 2: model scp's real operand grammar instead of the
		// historical backward "first path-like word" scan. `scp SRC... DST`:
		// the LAST operand is the destination. A destination containing `:`
		// before its first `/` is REMOTE (upload — no local write); a local
		// destination is the write target; earlier operands (remote
		// `host:path` sources or local sources) are NEVER write targets (the
		// old scan fabricated `ws\host:f` from a remote SOURCE). Zero or one
		// operand is a usage error on real scp (verified against the
		// installed OpenSSH binary: prints usage, transfers nothing) — emit
		// nothing. A destination word carrying an unquoted brace region keeps
		// the #3491 closure-round-2 refusal shape (the withdrawal
		// pushLiteralDestination emits — pinned by
		// guardrails-shell-write-brace-sites-3491). Option table per the
		// installed scp usage output: argument-taking standalone flags
		// (-c -D -F -i -J -l -o -P -S -X) consume one word; anything else
		// dash-led is argument-less; `--` ends options. An unknown long
		// flag with a glued value fails closed (unresolvedContext
		// withdrawal), never misclassified as an operand.
		const SCP_ARG_TAKING = new Set([
			'-c',
			'-D',
			'-F',
			'-i',
			'-J',
			'-l',
			'-o',
			'-P',
			'-S',
			'-X',
		]);
		const operands: Array<{ node: unknown; word: string }> = [];
		let pastEndOfOptions = false;
		let withdrawal: { word: string } | null = null;
		for (let i = 0; i < suffixWords.length; i++) {
			const word = suffixWords[i];
			if (word === undefined) break;
			if (!pastEndOfOptions && word === '--') {
				pastEndOfOptions = true;
				continue;
			}
			if (!pastEndOfOptions && word.startsWith('--')) {
				// Long options: no arg-taking long form ships without a short
				// form; a glued-value long flag is unmodelled — deny-on-
				// uncertainty. Bare long flags are argument-less.
				if (word.includes('=')) {
					withdrawal = { word };
					break;
				}
				continue;
			}
			if (
				!pastEndOfOptions &&
				word.startsWith('-') &&
				word.length > 1 &&
				!/^[A-Za-z]:[\\/]/.test(word)
			) {
				const letters = word.slice(1);
				// Glued value forms (-P2222) are valid only when the leading
				// letter is arg-taking; otherwise the cluster is
				// argument-less short flags.
				if (letters.length > 1 && SCP_ARG_TAKING.has(`-${letters[0]}`)) {
					continue;
				}
				if (SCP_ARG_TAKING.has(word)) {
					// The flag's argument word is consumed, never an operand.
					i += 1;
					continue;
				}
				continue;
			}
			operands.push({ node: suffixNodes[i], word });
		}
		if (withdrawal) {
			results.push({
				category: 'network_download',
				operator: 'scp',
				path: null,
				unresolvedContext: true,
				dynamicSourceWord: withdrawal.word,
			});
		} else if (operands.length >= 2) {
			const last = operands[operands.length - 1];
			if (last !== undefined) {
				const braceShaped = hasUnquotedBraceExpansion(last.node, last.word);
				if (braceShaped) {
					// Keep the #3491 refusal byte-shape: the brace expands
					// into multiple operands the static model cannot resolve.
					pushLiteralDestination(results, last.node, last.word, 'scp');
				} else {
					const colonAt = last.word.indexOf(':');
					const slashAt = last.word.indexOf('/');
					// #3590 PRR-004 (feedback round): a drive-RELATIVE
					// spelling (`C:dest`, no separator after the colon) is a
					// Windows LOCAL destination — the drive-letter guard
					// covers both the separated and bare-colon forms so the
					// word is never silently classified remote (fail-closed:
					// a spurious local target over-blocks, a dropped one
					// hides the write).
					const isRemote =
						colonAt !== -1 &&
						(slashAt === -1 || colonAt < slashAt) &&
						!/^[A-Za-z]:/.test(last.word);
					if (!isRemote) {
						// Local destination — the write target (catches plain
						// relative spellings like `src/../esc` the old
						// path-like tests missed).
						results.push({
							category: 'network_download',
							operator: 'scp',
							path: last.word,
						});
					}
					// Remote destination: upload — no local write; emit
					// nothing for it or for any source operand.
				}
			}
		}
		// 0-1 operands: usage error, nothing transfers — no write emitted.
	}

	return results;
}

/** Detect archive extraction: tar -x, unzip, gunzip. */
function detectArchiveExtract(cmd: unknown): WriteTarget[] {
	const results: WriteTarget[] = [];
	const name = getCommandName(cmd);
	if (!name) return results;

	const leaf = detectorCommandLeaf(cmd);
	const lowerName = detectorSetMember(leaf, ARCHIVE_EXTRACT_COMMANDS);
	if (!lowerName) return [];

	const suffixWords = getSuffixWords(cmd);

	if (lowerName === 'tar') {
		// tar extraction: flag contains 'x' (--extract / -x / -xz / -xvf, etc.)
		const hasExtractFlag = suffixWords.some((word) => {
			if (word === '--extract' || word === '--get') return true;
			if (word.startsWith('-') && word.includes('x')) return true;
			return false;
		});
		if (hasExtractFlag) {
			// Find archive name: last non-flag arg OR --file=VALUE
			for (let i = suffixWords.length - 1; i >= 0; i--) {
				const word = suffixWords[i];
				if (!word.startsWith('-')) {
					results.push({
						category: 'archive_extract',
						operator: 'tar -x',
						path: word,
					});
					break;
				}
				if (word.startsWith('--file=') && word.length > 7) {
					results.push({
						category: 'archive_extract',
						operator: 'tar -x',
						path: word.slice(7),
					});
					break;
				}
			}
		}
	} else if (lowerName === 'unzip') {
		// Flag the archive name (last non-flag arg)
		for (let i = suffixWords.length - 1; i >= 0; i--) {
			const word = suffixWords[i];
			if (!word.startsWith('-')) {
				results.push({
					category: 'archive_extract',
					operator: 'unzip',
					path: word,
				});
				break;
			}
		}
	} else if (
		lowerName === 'gunzip' ||
		lowerName === 'gzip' ||
		lowerName === 'bzip2' ||
		lowerName === 'xz' ||
		lowerName === '7z' ||
		lowerName === 'rar'
	) {
		const hasDecompressFlag =
			suffixWords.includes('-d') || suffixWords.includes('--decompress');
		if (hasDecompressFlag || lowerName === 'gunzip') {
			for (let i = suffixWords.length - 1; i >= 0; i--) {
				const word = suffixWords[i];
				if (!word.startsWith('-')) {
					results.push({
						category: 'archive_extract',
						operator: `${name} [decompress]`,
						path: word,
					});
					break;
				}
			}
		}
	}

	return results;
}

/** Detect git destructive operations: git checkout --, git restore, git reset --hard, git clean -fd. */
/**
 * #3120 LEG 3b: patch-application write vectors.
 *
 * `git apply` and GNU `patch` modify the files named INSIDE a patch, so the
 * detector reports a `patch_apply` write carrying the literal patch-file
 * operands (`patchSources`); the gate extracts the real targets from the
 * patch content at authorization time (both diff endpoints, so a
 * rename/delete of a protected preimage cannot hide behind the postimage;
 * `/dev/null` endpoints excluded; `-p<n>` strip honored).
 *
 * Closed option sets (#3120 critic rounds 2-4): anything unrecognized —
 * including target-rewriting forms (`--directory`, `-d`, `-o`, `-r`, backup
 * options) and index-writing modes (`--cached`, `--index`, `--3way`) —
 * yields a write with NO patch sources, which the gate fails closed.
 * `patch` without an explicit `-p<n>` also carries no sources: GNU patch
 * then selects candidate basenames itself (executed proof, plan critic
 * round 2), so no static target can be trusted.
 */
// #3120 4.5 review rounds 1-2: git GLOBAL options ahead of a subcommand
// (`git -C . apply`, `git --no-pager checkout …`, `git -c k=v …`, `git -p
// apply …`) do not change the write semantics, and execution wrappers
// (`env git …`, `command git …`) resolve through
// detectorCommandPartsFromWords. Returns the wrapper-consumed words with the
// git global options skipped, so the subcommand sits at index 0.
//
// UNRECOGNIZED PREFIX (4.5 rounds 2-5): the skip sets cover the COMMON
// documented globals, NOT every one git accepts (executed proofs:
// `git --attr-source=<t> status` runs clean attached; `--attr-source HEAD
// checkout -- f` runs clean space-form). Enumeration cannot be complete,
// and a space-form value can swallow the subcommand position (round 5
// fail-open), so an unlisted dash-token ahead of the subcommand sets
// `prefixUncertain` WITHOUT advancing past it: the write detectors SCAN
// EVERY REMAINING TOKEN for a write verb (apply/checkout/restore/reset/
// clean) and fail closed on any hit — real write (blocked correctly) or an
// option value (an over-block, the safe direction); no write verb anywhere
// → the command stays clean, so read-only commands never false-block
// behind globals we have not enumerated.
function gitSubcommandWords(cmd: unknown): {
	leaf: string;
	words: string[];
	prefixUncertain: boolean;
} {
	const parts = detectorCommandPartsFromWords(
		getCommandName(cmd),
		getSuffixWords(cmd),
	);
	const suffixWords = parts.rest;
	const gitGlobalsWithValue = new Set([
		'-C',
		'-c',
		'--git-dir',
		'--work-tree',
		'--namespace',
		'--exec-path',
		'--super-prefix',
		'--config-env',
	]);
	const gitFlagGlobals = new Set([
		'--no-pager',
		'--paginate',
		'--bare',
		'--literal-pathspecs',
		'--no-optional-locks',
		'--no-replace-objects',
		'--noglob-pathspecs',
		'--icase-pathspecs',
		'--no-advice',
		'--no-lazy-fetch',
		'--glob-pathspecs',
		// Informational/terminating globals (4.5 round 3): git accepts these
		// ahead of a subcommand and exits 0 without running anything.
		'--version',
		'--help',
		'--html-path',
		'--man-path',
		'--info-path',
	]);
	let cursor = 0;
	let prefixUncertain = false;
	while (cursor < suffixWords.length) {
		const token = suffixWords[cursor];
		if (token === '-p' || token === '-P' || token === '-v' || token === '-h') {
			cursor += 1;
			continue;
		}
		if (gitFlagGlobals.has(token)) {
			cursor += 1;
			continue;
		}
		const valueGlobal = [...gitGlobalsWithValue].find(
			(g) => token === g || token.startsWith(`${g}=`),
		);
		if (valueGlobal) {
			cursor += token.includes('=') ? 1 : 2;
			continue;
		}
		if (token.startsWith('-')) {
			// Unrecognized global: the subcommand position is uncertain (a
			// space-form value could swallow it). Keep the words FROM the
			// unknown token; the write detectors scan them all for write
			// verbs and fail closed on any hit, while commands with no
			// write verb stay clean.
			prefixUncertain = true;
		}
		break;
	}
	return {
		leaf: parts.leaf,
		words: suffixWords.slice(cursor),
		prefixUncertain,
	};
}

function detectPatchApply(cmd: unknown): WriteTarget[] {
	const results: WriteTarget[] = [];
	const resolved = gitSubcommandWords(cmd);
	const leaf = resolved.leaf;
	if (leaf !== 'git' && leaf !== 'patch') return results;
	const suffixWords =
		leaf === 'git'
			? resolved.words
			: detectorCommandPartsFromWords(getCommandName(cmd), getSuffixWords(cmd))
					.rest;
	if (leaf === 'git' && resolved.prefixUncertain) {
		// #3120 4.5 rounds 2-5: a write verb ANYWHERE behind an unrecognized
		// global prefix fails closed — the operand grammar cannot be trusted
		// (round-5 executed fail-open: `git --attr-source HEAD checkout --
		// f` restored a file while a first-non-dash rule read HEAD as the
		// subcommand). GNU patch has no global-prefix grammar, so the check
		// is git-only.
		if (suffixWords.some((w) => w.toLowerCase() === 'apply')) {
			results.push({
				category: 'patch_apply',
				operator: 'git (unresolved global prefix)',
				path: null,
			});
		}
		return results;
	}
	if (suffixWords.length === 0) return results;

	const isGit = leaf === 'git';
	if (isGit && suffixWords[0]?.toLowerCase() !== 'apply') return results;
	const words = isGit ? suffixWords.slice(1) : suffixWords;
	const GIT_APPLY_OK = /^-(?:p\d+|q|R)$|^--(?:check|quiet|stat|reverse)$/;
	const PATCH_OK = /^--(?:batch|quiet|force)$|^-(?:s|f|q)$|^--F\d+$/;
	const KNOWN_UNSUPPORTED = new Set([
		'--3way',
		'--index',
		'--cached',
		'--directory',
		'--unsafe-paths',
		'--exclude',
		'--include',
		'-d',
		'-o',
		'-r',
		'-b',
		'-B',
		'-V',
		'-Z',
		'-T',
		'--output',
		'--reject-file',
		'--backup',
		'--suffix',
		'--version-control',
	]);

	const sources: string[] = [];
	let strip = isGit ? 1 : -1;
	for (const word of words) {
		if (word === '--') continue;
		if (word.startsWith('-')) {
			const pMatch = /^-p(\d+)$/.exec(word);
			if (pMatch) {
				strip = Number.parseInt(pMatch[1], 10);
				continue;
			}
			const ok = isGit ? GIT_APPLY_OK.test(word) : PATCH_OK.test(word);
			if (!ok || KNOWN_UNSUPPORTED.has(word)) {
				// Unrecognized or known-unsupported (target-rewriting /
				// index-writing) option: fail closed rather than guess.
				results.push({
					category: 'patch_apply',
					operator: `${isGit ? 'git apply' : 'patch'} (unsupported option)`,
					path: null,
				});
				return results;
			}
			continue;
		}
		sources.push(word);
	}

	if (isGit) {
		// git apply: default strip level 1; patch operands are readable files.
		results.push({
			category: 'patch_apply',
			operator: 'git apply',
			path: null,
			patchSources: sources,
			patchStrip: strip,
		});
		return results;
	}

	// GNU patch: an EXPLICIT -p<n> is required for static target resolution
	// (no `-p` selects candidate basenames dynamically — fail closed).
	const hasExplicitP = words.some((w) => /^-p\d+$/.test(w));
	if (!hasExplicitP) {
		results.push({
			category: 'patch_apply',
			operator: 'patch (no explicit -p)',
			path: null,
		});
		return results;
	}
	// Stdin form (`patch -p1 < fix.diff`): the input redirection names the
	// patch file; a positional operand wins when both appear.
	const fromStdinRedirect = getInputRedirectPaths(cmd);
	const patchFiles = sources.length > 0 ? sources : fromStdinRedirect;
	results.push({
		category: 'patch_apply',
		operator: 'patch',
		path: null,
		patchSources: patchFiles,
		patchStrip: strip,
	});
	return results;
}

/** Input (`<`) redirection file words of a command node, literal only. */
function getInputRedirectPaths(cmd: unknown): string[] {
	const out: string[] = [];
	for (const redirect of getRedirections(cmd)) {
		if (!redirect || typeof redirect !== 'object') continue;
		const opType = (
			redirect as { op?: { type?: string } }
		).op?.type?.toUpperCase();
		if (opType !== 'LESS') continue;
		const fileNode = (redirect as { file?: unknown }).file;
		const text = extractRedirectPath(fileNode);
		if (text !== null) out.push(text);
	}
	return out;
}

/**
 * #3120 LEG 3c: `rsync <src>… <dest>` writes under the destination operand.
 * The destination (last positional after flags and their values) is reported
 * as the write target — parity with the existing `cp` last-operand treatment
 * (directory-content enrichment is a disclosed boundary shared with cp -r).
 */
function detectRsyncWrites(cmd: unknown): WriteTarget[] {
	const results: WriteTarget[] = [];
	const leaf = detectorCommandLeaf(cmd);
	if (leaf !== 'rsync') return results;
	const suffixWords = getSuffixWords(cmd);
	if (suffixWords.length === 0) return results;

	const flagsWithValue = new Set([
		'-e',
		'--exclude-from',
		'--include-from',
		'--files-from',
		'--rsync-path',
		'--suffix',
		'--backup-dir',
		'--out-format',
		'--log-file',
		'--password-file',
		'--chmod',
		'--outbuf',
		'--max-size',
		'--min-size',
		'--block-size',
		// #3120 4.5 review round: filter options take a separate value; an
		// unlisted trailing filter was previously judged as the destination.
		'--exclude',
		'--include',
		'--filter',
	]);
	const positionals: string[] = [];
	let skipNext = false;
	for (const word of suffixWords) {
		if (skipNext) {
			skipNext = false;
			continue;
		}
		if (flagsWithValue.has(word)) {
			skipNext = true;
			continue;
		}
		if (word === '--') continue;
		if (word.startsWith('-')) continue;
		positionals.push(word);
	}
	if (positionals.length < 2) {
		// No source/destination pair (rsync errors) — nothing to authorize.
		return results;
	}
	const dest = positionals[positionals.length - 1];
	results.push({ category: 'builtin_write', operator: 'rsync', path: dest });
	return results;
}

function detectGitDestructive(cmd: unknown): WriteTarget[] {
	const results: WriteTarget[] = [];
	// #3120 4.5 review round 1: wrapper- and git-global-option-aware
	// subcommand resolution (`env git checkout …`, `git -C . checkout …`
	// are the same write as the bare subcommand form).
	const gitResolution = gitSubcommandWords(cmd);
	const leaf = gitResolution.leaf;
	const suffixWords = gitResolution.words;
	if (leaf !== GIT_COMMAND) return [];
	if (gitResolution.prefixUncertain) {
		// #3120 4.5 rounds 2-5: a write verb anywhere behind an unrecognized
		// global prefix fails closed; no write verb → the command stays
		// clean (read-only commands never false-block).
		const WRITE_VERBS = new Set(['checkout', 'restore', 'reset', 'clean']);
		if (suffixWords.some((w) => WRITE_VERBS.has(w.toLowerCase()))) {
			return [
				{
					category: 'git_destructive',
					operator: 'git (unresolved global prefix)',
					path: null,
				},
			];
		}
		return [];
	}
	if (suffixWords.length === 0) return [];

	const first = suffixWords[0].toLowerCase();

	if (first === 'checkout') {
		// git checkout -- <path> OR git checkout -- .
		const dashDashIdx = suffixWords.indexOf('--');
		if (dashDashIdx !== -1 && dashDashIdx + 1 < suffixWords.length) {
			const path = suffixWords[dashDashIdx + 1];
			const op = path === '.' ? 'git checkout -- .' : 'git checkout --';
			results.push({ category: 'git_destructive', operator: op, path });
		} else if (dashDashIdx === -1) {
			// #3120 LEG 3a: `git checkout <ref> <pathspec>…` (no `--`) restores
			// the pathspec operands from the ref — a path-limited write the
			// authority layer must judge. Branch operations (`-b`/`-B`/`--orphan`,
			// and a lone <ref> with no pathspec) stay undetected: they are not
			// path-limited restores.
			const checkoutFlagsWithValue = new Set([
				'-b',
				'-B',
				'-t',
				'--track',
				'--conflict',
				'--orphan',
				'--pathspec-from-file',
				'--snapshot',
			]);
			const branchCreation = checkoutFlagsWithValue.has(suffixWords[1] ?? '');
			const positionals: string[] = [];
			let skipNext = false;
			for (let i = 1; i < suffixWords.length; i += 1) {
				const word = suffixWords[i];
				if (skipNext) {
					skipNext = false;
					continue;
				}
				if (checkoutFlagsWithValue.has(word)) {
					skipNext = true;
					continue;
				}
				if (word.startsWith('-')) continue;
				positionals.push(word);
			}
			if (!branchCreation && positionals.length >= 2) {
				// First positional is the ref; the rest are pathspecs.
				for (let i = 1; i < positionals.length; i += 1) {
					results.push({
						category: 'git_destructive',
						operator: 'git checkout <ref>',
						path: positionals[i],
					});
				}
			}
		}
	} else if (first === 'restore') {
		// git restore [--hard] [--force] <path>
		const hasHard = suffixWords.some(
			(w) =>
				w === '--hard' || w === '-H' || (w.startsWith('-') && w.includes('H')),
		);
		const hasForce = suffixWords.some(
			(w) =>
				w === '--force' || w === '-f' || (w.startsWith('-') && w.includes('f')),
		);
		if (hasHard || hasForce) {
			const dashDashIdx = suffixWords.indexOf('--');
			if (dashDashIdx !== -1 && dashDashIdx + 1 < suffixWords.length) {
				results.push({
					category: 'git_destructive',
					operator: 'git restore',
					path: suffixWords[dashDashIdx + 1],
				});
			} else {
				// git restore without path = whole repo
				results.push({
					category: 'git_destructive',
					operator: 'git restore',
					path: null,
				});
			}
		}
	} else if (first === 'reset') {
		// git reset --hard OR git reset --hard HEAD
		const hasHard = suffixWords.some(
			(w) =>
				w === '--hard' || w === '-H' || (w.startsWith('-') && w.includes('H')),
		);
		if (hasHard) {
			results.push({
				category: 'git_destructive',
				operator: 'git reset --hard',
				path: null,
			});
		}
	} else if (first === 'clean') {
		// git clean -fd — combined flags like -fd, -f -d, --force -d
		// For combined flags, check if the flag string CONTAINS the flag letter, not just startsWith
		// Skip if -n/--dry-run is present
		const hasDryRun = suffixWords.some(
			(w) =>
				w === '-n' ||
				w === '--dry-run' ||
				(w.startsWith('-') && w.includes('n')),
		);
		if (hasDryRun) return results;

		const hasForce = suffixWords.some(
			(w) =>
				w === '-f' || w === '--force' || (w.startsWith('-') && w.includes('f')),
		);
		const hasDir = suffixWords.some(
			(w) =>
				w === '-d' || w === '--dir' || (w.startsWith('-') && w.includes('d')),
		);
		if (hasForce && hasDir) {
			results.push({
				category: 'git_destructive',
				operator: 'git clean -fd',
				path: null,
			});
		}
	}

	return results;
}

// ---------------------------------------------------------------------------
// Windows shell detection — regex heuristics
// ---------------------------------------------------------------------------

/**
 * Split a Windows command string into individual commands by pipe (|) and
 * logical separators (&&, ||). Does not split on && inside quoted strings.
 */
function splitWindowsCommands(
	command: string,
	shell: 'powershell' | 'cmd',
): string[] {
	const commands: string[] = [];
	let current = '';
	let inSingleQuote = false;
	let inDoubleQuote = false;
	let parenDepth = 0;

	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (shell === 'powershell' && ch === "'" && !inDoubleQuote) {
			inSingleQuote = !inSingleQuote;
		} else if (ch === '"' && !inSingleQuote) {
			inDoubleQuote = !inDoubleQuote;
		} else if (ch === '(' && !inSingleQuote && !inDoubleQuote) {
			parenDepth++;
		} else if (ch === ')' && !inSingleQuote && !inDoubleQuote) {
			parenDepth--;
		}

		// The unwrap path (#1778/#3099) rejoins de-wrapped segments with
		// newlines; without this branch the head-anchored cmd matchers cannot
		// see a `cmd /c copy ...` fragment hidden after the first segment
		// (#3099 round-4 Critical 1).
		if (ch === '\n' && !inSingleQuote && !inDoubleQuote && parenDepth === 0) {
			if (current.trim()) commands.push(current.trim());
			current = '';
			continue;
		}

		// PowerShell script blocks and statement separators are command
		// boundaries. Splitting braces themselves is intentional: leaving the
		// opening brace attached makes the anchored cmdlet matcher miss writes in
		// `{ Set-Content outside.txt }`. Expressions containing braces are handled
		// conservatively as smaller command fragments.
		if (
			shell === 'powershell' &&
			(ch === ';' || ch === '{' || ch === '}') &&
			!inSingleQuote &&
			!inDoubleQuote &&
			parenDepth === 0
		) {
			if (current.trim()) commands.push(current.trim());
			current = '';
			continue;
		}

		// Split on | (pipe) when not in quotes or parens
		if (ch === '|' && !inSingleQuote && !inDoubleQuote && parenDepth === 0) {
			if (current.trim()) commands.push(current.trim());
			current = '';
			continue;
		}

		// Split on && or || when not in quotes or parens
		if (
			(ch === '&' || ch === '|') &&
			i + 1 < command.length &&
			command[i + 1] === ch &&
			!inSingleQuote &&
			!inDoubleQuote &&
			parenDepth === 0
		) {
			if (current.trim()) commands.push(current.trim());
			commands.push(ch === '&' ? '&&' : '||');
			current = '';
			i++; // skip next char
			continue;
		}

		// Split on single & when not in quotes or parens and not part of &&
		if (ch === '&' && !inSingleQuote && !inDoubleQuote && parenDepth === 0) {
			// In cmd.exe, `n>&m` duplicates a file descriptor.  The ampersand is
			// part of the redirection grammar, not a command separator.  Keep it
			// attached so the redirection scanner can distinguish `2>&1` from a
			// write such as `2>output.txt`.
			if (command[i - 1] === '>') {
				current += ch;
				continue;
			}
			// Check this is NOT the first char of && (already handled above)
			if (!(i + 1 < command.length && command[i + 1] === '&')) {
				if (current.trim()) commands.push(current.trim());
				current = '';
				continue;
			}
		}

		current += ch;
	}

	if (current.trim()) commands.push(current.trim());
	return commands.filter((c) => c !== '&&' && c !== '||');
}

// ---------------------------------------------------------------------------
// PowerShell detection
// ---------------------------------------------------------------------------

/** PowerShell cmdlets that write to files. */
const _PS_WRITE_CMDLETS = new Set([
	'Out-File',
	'Set-Content',
	'Add-Content',
	'Clear-Content',
	'Copy-Item',
	'Move-Item',
	'Remove-Item',
	'Invoke-WebRequest',
	'Start-Process',
]);

/**
 * Scan PowerShell redirections without requiring whitespace around the
 * operator.  PowerShell accepts `Get-Process>out.txt` and stream-specific
 * forms such as `tool 2>err.txt`; the old whitespace-dependent regex treated
 * those commands as read-only.  Numeric `n>&m` is stream duplication, not a
 * file write. Missing or unterminated targets are represented as unresolved;
 * dynamic tokens are retained for the shared resolver to reject fail-closed.
 */
function detectPowerShellRedirects(command: string): WriteTarget[] {
	const results: WriteTarget[] = [];
	let inSingleQuote = false;
	let inDoubleQuote = false;

	const isBoundary = (character: string | undefined): boolean =>
		character === undefined || /[\s;|&()]/.test(character);

	for (let index = 0; index < command.length; index++) {
		const character = command[index];

		if (inSingleQuote) {
			if (character === "'") {
				// PowerShell escapes an apostrophe in a single-quoted string as `''`.
				if (command[index + 1] === "'") {
					index++;
				} else {
					inSingleQuote = false;
				}
			}
			continue;
		}
		if (inDoubleQuote) {
			// PowerShell uses backtick, rather than backslash, for string escapes.
			if (character === '`' && index + 1 < command.length) {
				index++;
				continue;
			}
			if (character === '"') inDoubleQuote = false;
			continue;
		}
		if (character === "'") {
			inSingleQuote = true;
			continue;
		}
		if (character === '"') {
			inDoubleQuote = true;
			continue;
		}
		// A caret-escaped `>` (`^>`) is a literal in cmd (caret escapes the
		// next character) and not a valid redirection operator in PowerShell
		// (`^>` is not in the operator grammar), so neither grammar writes a
		// file there. This scanner runs on cmd-shaped fragments too (the
		// #3099 dual-detector union), so it must honor the cmd escape.
		if (character === '>' && command[index - 1] === '^') continue;
		if (character !== '>') continue;

		const operator = command[index + 1] === '>' ? '>>' : '>';
		let cursor = index + operator.length;
		while (/\s/.test(command[cursor] ?? '')) cursor++;

		// `2>&1` is stream duplication.  Unlike CMD, PowerShell's stream
		// descriptors are an intentional part of normal error handling.
		if (command[cursor] === '&') {
			cursor++;
			while (/\s/.test(command[cursor] ?? '')) cursor++;
			const descriptorStart = cursor;
			while (/\d/.test(command[cursor] ?? '')) cursor++;
			const descriptor = command.slice(descriptorStart, cursor);
			if (descriptor && isBoundary(command[cursor])) {
				index = Math.max(index, cursor - 1);
				continue;
			}
			results.push({ category: 'redirect', operator, path: null });
			index = Math.max(index, cursor - 1);
			continue;
		}

		let pathValue: string | null = null;
		if (cursor < command.length) {
			const quote = command[cursor];
			if (quote === '"' || quote === "'") {
				cursor++;
				const pathStart = cursor;
				let closed = false;
				while (cursor < command.length) {
					if (quote === '"' && command[cursor] === '`') {
						cursor += 2;
						continue;
					}
					if (command[cursor] === quote) {
						if (quote === "'" && command[cursor + 1] === "'") {
							cursor += 2;
							continue;
						}
						pathValue = command.slice(pathStart, cursor);
						cursor++;
						closed = true;
						break;
					}
					cursor++;
				}
				if (!closed) pathValue = null;
			} else {
				const pathStart = cursor;
				while (
					cursor < command.length &&
					!/\s|[;|&()<>]/.test(command[cursor] ?? '')
				) {
					cursor++;
				}
				if (cursor > pathStart) pathValue = command.slice(pathStart, cursor);
			}
		}

		results.push({ category: 'redirect', operator, path: pathValue });
		index = Math.max(index, cursor - 1);
	}

	// A malformed quoted command is not safe to classify as read-only.  It may
	// also have concealed a redirection, so surface an unresolved target.
	if (inSingleQuote || inDoubleQuote) {
		results.push({ category: 'redirect', operator: '>', path: null });
	}

	return results;
}

/**
 * Detect write operations in a single PowerShell command string using regex.
 * Handles cmdlets, aliases, and redirection operators.
 */
function detectPowerShellWrites(command: string): WriteTarget[] {
	const results: WriteTarget[] = [];
	const trimmed = command.trim();
	if (!trimmed) return results;

	// Encoded PowerShell payloads cannot be inspected without executing or
	// decoding an untrusted script. Treat the invocation as an unresolved write
	// effect so scope validation fails closed. Cover the documented switch and
	// the common unique-prefix aliases accepted by PowerShell (`-e`, `-ec`,
	// `-enc`).
	if (
		/^(?:powershell|pwsh)(?:\.exe)?\s+/i.test(trimmed) &&
		/(?:^|\s)-(?:e|ec|enc|encodedcommand)(?=\s|=|$)/i.test(trimmed)
	) {
		results.push({
			// opaque interpreter_eval class: no capability flag, blanket-blocked
			category: 'interpreter_eval',
			operator: 'PowerShell -EncodedCommand',
			path: null,
		});
		return results;
	}

	// Strip -Command wrapper to get inner PowerShell command
	// Handle: powershell -Command "...", powershell -C "...", and any
	// preceding switches (`powershell -NoProfile -Command "…"` — PRR-009:
	// the authority ladder declares Windows for the switch form, so the
	// strip must unwrap it too or the payload is invisible).
	let innerCommand = trimmed;
	const cmdMatch = trimmed.match(
		new RegExp(`${PS_STRIP_PREFIX.source}(.*)$`, 'i'),
	);
	if (cmdMatch) {
		innerCommand = cmdMatch[1].trim();
		// Strip outer quotes if present
		if (
			(innerCommand.startsWith('"') && innerCommand.endsWith('"')) ||
			(innerCommand.startsWith("'") && innerCommand.endsWith("'"))
		) {
			innerCommand = innerCommand.slice(1, -1);
		}
	}

	// Changing the working directory makes relative paths in the same compound
	// command impossible to resolve without executing PowerShell. Report an
	// unresolved write effect so callers fail closed instead of resolving a
	// later path against the original workspace root.
	if (
		/(?:^|[;{}|&])\s*(?:Set-Location|Push-Location|Pop-Location|cd|chdir|sl)\b/i.test(
			innerCommand,
		)
	) {
		results.push({
			category: 'builtin_write',
			operator: 'working-directory mutation',
			path: null,
		});
	}

	// Executable/parenthesized script blocks can keep their braces inside a
	// larger expression (for example `& ({ Set-Content ../outside.txt ... })`),
	// so splitWindowsCommands cannot expose the cmdlet as a fragment anchored at
	// the start. Treat any write cmdlet nested behind a grouping delimiter as an
	// unresolved write effect; static resolution cannot safely determine the
	// invocation context or working directory.
	if (
		/[({]\s*(?:Out-File|Set-Content|Add-Content|Clear-Content|Copy-Item|Move-Item|Remove-Item)\b/i.test(
			innerCommand,
		)
	) {
		results.push({
			// opaque interpreter_eval class: no capability flag, blanket-blocked
			category: 'interpreter_eval',
			operator: 'nested PowerShell script block',
			path: null,
		});
	}

	// The call operator and Invoke-Expression can execute a command held in a
	// string or variable. Its eventual write targets are not statically
	// recoverable, so report an unresolved effect instead of treating a dynamic
	// invocation such as `& 'Set-Content' outside.txt x` as read-only.
	if (
		/(?:^|[;|])\s*&\s*(?:['"$({]|\S+\s*\()/i.test(innerCommand) ||
		/(?:^|[;|])\s*(?:Invoke-Expression|IEX)\b/i.test(innerCommand)
	) {
		results.push({
			// opaque interpreter_eval class: no capability flag, blanket-blocked
			category: 'interpreter_eval',
			operator: 'dynamic PowerShell invocation',
			path: null,
		});
	}

	results.push(...detectPowerShellRedirects(innerCommand));

	// Start-Process is handled by detectInteractiveSession — do not double-detect here

	// Detect Invoke-WebRequest (or its curl alias) with -OutFile or -o
	const iwrMatch = trimmed.match(
		/^(?:Invoke-WebRequest|curl)\s.*?(?:-OutFile\s+(\S+)|-o\s+(\S+))/i,
	);
	if (iwrMatch) {
		const path = iwrMatch[1] || iwrMatch[2];
		if (path) {
			results.push({
				category: 'network_download',
				operator: 'Invoke-WebRequest -OutFile',
				path,
			});
		}
	}

	// Detect file-writing cmdlets: Out-File, Set-Content, Add-Content, Clear-Content
	function detectPsContentCmdlet(cmd: string): WriteTarget[] {
		const cmdletMatch = cmd.match(
			/^(Out-File|Set-Content|Add-Content|Clear-Content)\b/i,
		);
		if (!cmdletMatch) return [];
		const cmdletName = cmdletMatch[1];
		const rest = cmd.slice(cmdletMatch[0].length).trim();

		// Strategy:
		// 1. First try to extract path from -Path, -FilePath, or -LiteralPath flags explicitly
		// 2. Fall back to first non-flag positional argument
		// 3. Strip surrounding quotes from extracted path

		// Match -Path <value>, -FilePath <value>, -LiteralPath <value> (value may be quoted)
		// Quoted strings must be matched BEFORE \S+ to handle paths with spaces correctly
		const pathFlagMatch = rest.match(
			/(?:-Path|-FilePath|-LiteralPath)\s+((?:"[^"]*"|'[^']*'|[^,\s]+)(?:\s*,\s*(?:"[^"]*"|'[^']*'|[^,\s]+))*)/i,
		);
		if (pathFlagMatch) {
			const paths = pathFlagMatch[1]
				.split(/\s*,\s*/)
				.map((value) => value.replace(/^(["'])|(["'])$/g, ''));
			return paths.map((path) => ({
				category: 'redirect',
				operator: cmdletName,
				path: path || null,
			}));
		}
		// #3539 closure F-3: colon-glued `-Path:Value` binds identically in
		// real PowerShell 5.1 (executed ground truth: Set-Content -Path:f
		// writes f) — the left keeps value-taking semantics, the right IS
		// the value, so the write arm reads the SAME target the spaced form
		// names instead of falling through to the content positional.
		const pathFlagGluedMatch = rest.match(
			/-(?:Path|FilePath|LiteralPath):((?:"[^"]*"|'[^']*'|[^,\s]+))/i,
		);
		if (pathFlagGluedMatch) {
			const path = pathFlagGluedMatch[1].replace(/^(["'])|(["'])$/g, '');
			return [{ category: 'redirect', operator: cmdletName, path }];
		}
		if (/(?:-Path|-FilePath|-LiteralPath)(?:\s|:|$)/i.test(rest)) {
			return [{ category: 'redirect', operator: cmdletName, path: null }];
		}

		// No explicit path flag — fall back to first non-flag positional argument
		// Tokens: quoted strings, words not starting with -, or flags
		const tokens = rest.match(/(?:[^\s"-]+|"[^"]*"|'[^']*'|-[^\s]+)/g) ?? [];
		for (const token of tokens) {
			// Skip flags (tokens starting with -)
			if (token.startsWith('-')) continue;
			// This is a positional argument — treat it as the path
			const path = token.replace(/^["']|["']$/g, '');
			return [{ category: 'redirect', operator: cmdletName, path }];
		}

		return [];
	}

	results.push(...detectPsContentCmdlet(innerCommand));

	// Also detect content cmdlets that appear AFTER a pipe
	// e.g., "echo hello | Out-File path" or "echo data | Set-Content file.txt"
	const pipeContentMatch = innerCommand.match(
		/\|\s*(Out-File|Set-Content|Add-Content|Clear-Content)\b\s*(.*)$/i,
	);
	if (pipeContentMatch) {
		const cmdletName = pipeContentMatch[1];
		const afterCmdlet = pipeContentMatch[2].trim();
		// Extract path: first non-flag token
		const tokens =
			afterCmdlet.match(/(?:[^\s"-]+|"[^"]*"|'[^']*'|-[^\s]+)/g) ?? [];
		for (const token of tokens) {
			if (token.startsWith('-')) continue;
			const path = token.replace(/^["']|["']$/g, '');
			if (path) {
				results.push({ category: 'redirect', operator: cmdletName, path });
				break;
			}
		}
	}

	// Detect Copy-Item, Move-Item, Remove-Item (file-manipulation cmdlets)
	// Destination is the LAST positional argument (not the first)
	// Handle: Copy-Item src dst, Copy-Item -Path src -Destination dst, Copy-Item -Recurse src dst
	function detectPsFileOp(cmd: string): WriteTarget | null {
		const opMatch = cmd.match(/^(Copy-Item|Move-Item|Remove-Item)\b/i);
		if (!opMatch) return null;
		const cmdletName = opMatch[1];
		const rest = cmd.slice(opMatch[0].length).trim();

		// Check for -Destination flag first (takes precedence)
		const destFlagMatch = rest.match(/-Destination\s+(\S+|"[^"]+"|'[^']+')/i);
		if (destFlagMatch) {
			const path = destFlagMatch[1].replace(/^["']|["']$/g, '');
			return { category: 'builtin_write', operator: cmdletName, path };
		}

		// Collect all positional arguments (words not starting with -)
		// Also track the VALUE of -Path/-LiteralPath since that IS the path for file ops
		const tokens: string[] = [];
		// Flags that take a value (next non-flag token is the value)
		const flagTakingValue = new Set([
			'-Path',
			'-LiteralPath',
			'-Exclude',
			'-Include',
			'-Filter',
		]);
		// Flags that are standalone switches (don't consume next token)
		const switchFlags = new Set([
			'-Recurse',
			'-Force',
			'-Confirm',
			'-WhatIf',
			'-PassThru',
			'-Verbose',
			'-Debug',
		]);
		const parts = rest.match(/(?:[^\s"-]+|"[^"]*"|'[^']*'|-[^\s]+)/g) ?? [];
		// #3539 closure F-3: lowercase views for the colon-glued comparison
		// (PowerShell flags are case-insensitive).
		const flagTakingValueLower = new Set(
			[...flagTakingValue].map((f) => f.toLowerCase()),
		);
		let i = 0;
		while (i < parts.length) {
			const part = parts[i];
			// #3539 closure F-3: colon-glued `-Path:Value` (real PowerShell
			// binds it; executed ground truth) — the left keeps value-taking
			// semantics and the right IS the value. Only FLAG tokens split
			// (a value like C:\x never starts with '-').
			const colonAt = part.startsWith('-') ? part.indexOf(':') : -1;
			if (colonAt !== -1) {
				const head = part.slice(0, colonAt).toLowerCase();
				const glued = part.slice(colonAt + 1).replace(/^["']|["']$/g, '');
				if (flagTakingValueLower.has(head)) {
					if (glued) tokens.push(glued);
					i++;
					continue;
				}
				// Any other flag-shaped token (switch or unknown) consumes
				// nothing further.
				i++;
				continue;
			}
			if (flagTakingValue.has(part) && i + 1 < parts.length) {
				// Flag takes value — capture the value as a potential path
				const value = parts[i + 1];
				if (!value.startsWith('-')) {
					tokens.push(value);
				}
				i += 2; // skip flag and its value
			} else if (switchFlags.has(part)) {
				i++; // skip flag only
			} else if (part.startsWith('-')) {
				i++; // skip unknown flag
			} else {
				tokens.push(part);
				i++;
			}
		}

		// Destination is the last positional argument
		if (tokens.length >= 2) {
			const path = tokens[tokens.length - 1].replace(/^["']|["']$/g, '');
			return { category: 'builtin_write', operator: cmdletName, path };
		} else if (tokens.length === 1) {
			// Single arg — could be the destination if no source given (e.g., Remove-Item dir)
			const path = tokens[0].replace(/^["']|["']$/g, '');
			return { category: 'builtin_write', operator: cmdletName, path };
		}

		return null;
	}

	// Detect New-Item (issue #3099 R3).
	//
	// Token-walked rather than regex-over-the-remainder: a regex matched `-Path`
	// inside a quoted `-Value` payload and resolved an in-scope decoy while the
	// real target escaped. Flags compare case-insensitively (PowerShell
	// semantics). `-Force` and friends are SWITCHES (consume nothing);
	// `-ItemType`/`-Value`/`-Description` consume their value without ever
	// becoming the target. Target resolution, in order:
	//   1. `-Path`/`-LiteralPath` AND `-Name` present -> their composition
	//      (PowerShell composes them; any fixed precedence admits one decoy
	//      ordering);
	//   2. exactly one of them -> its value;
	//   3. otherwise the first remaining non-flag positional;
	//   4. none -> a null-path write so the null-path branch fails closed.
	function detectPsNewItem(cmd: string): WriteTarget | null {
		const opMatch = cmd.match(/^(?:New-Item|ni)\b/i);
		if (!opMatch) return null;
		const rest = cmd.slice(opMatch[0].length).trim();

		const SWITCH_FLAGS = new Set(['-force', '-confirm', '-whatif']);
		const VALUE_FLAGS = new Set(['-itemtype', '-value', '-description']);
		const PATH_FLAGS = new Set(['-path', '-literalpath']);

		const tokens = rest.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
		const unquote = (value: string) => value.replace(/^["']|["']$/g, '');

		let pathValue: string | null = null;
		let nameValue: string | null = null;
		let positional: string | null = null;
		for (let i = 0; i < tokens.length; i += 1) {
			const token = tokens[i];
			let flag = token.toLowerCase();
			let gluedValue: string | null = null;
			// #3539 closure F-3: colon-glued `-Path:Value` (real PowerShell
			// binds it; executed ground truth) — the left keeps value-taking
			// semantics, the right IS the value. Only FLAG tokens split.
			if (token.startsWith('-')) {
				const colonAt = token.indexOf(':');
				if (colonAt !== -1) {
					flag = token.slice(0, colonAt).toLowerCase();
					gluedValue = unquote(token.slice(colonAt + 1));
				}
			}
			if (PATH_FLAGS.has(flag)) {
				pathValue = gluedValue ?? unquote(tokens[i + 1] ?? '');
				if (gluedValue === null) i += 1;
				continue;
			}
			if (flag === '-name') {
				nameValue = gluedValue ?? unquote(tokens[i + 1] ?? '');
				if (gluedValue === null) i += 1;
				continue;
			}
			if (VALUE_FLAGS.has(flag)) {
				if (gluedValue === null) i += 1; // consume the value; never a target
				continue;
			}
			if (SWITCH_FLAGS.has(flag)) continue;
			if (flag.startsWith('-')) continue; // unknown flag: consume nothing
			if (positional === null) positional = unquote(token);
		}

		const basePath = (pathValue ?? positional)?.replace(/\/+$/, '') ?? null;
		if (basePath !== null && nameValue) {
			const base = basePath;
			return {
				category: 'builtin_write',
				operator: 'New-Item',
				path: base ? `${base}/${nameValue}` : nameValue,
			};
		}
		if (pathValue) {
			return {
				category: 'builtin_write',
				operator: 'New-Item',
				path: pathValue,
			};
		}
		if (positional) {
			return {
				category: 'builtin_write',
				operator: 'New-Item',
				path: positional,
			};
		}
		if (nameValue) {
			return {
				category: 'builtin_write',
				operator: 'New-Item',
				path: nameValue,
			};
		}
		return {
			category: 'builtin_write',
			operator: 'New-Item',
			path: null,
		};
	}

	const fileOp = detectPsFileOp(innerCommand) ?? detectPsNewItem(innerCommand);
	if (fileOp) {
		results.push(fileOp);
	}

	// Also detect file operations that appear AFTER a pipe
	// e.g., "Get-Content file.txt | Copy-Item -Destination dest.txt"
	const pipeFileOpMatch = innerCommand.match(
		/\|\s*(Copy-Item|Move-Item)\b\s*(.*)$/i,
	);
	if (pipeFileOpMatch) {
		const cmdletName = pipeFileOpMatch[1];
		const afterCmdlet = pipeFileOpMatch[2].trim();
		// Extract destination from -Destination flag or last positional arg
		const destFlagMatch = afterCmdlet.match(
			/-Destination\s+(\S+|"[^"]+"|'[^']+')/i,
		);
		if (destFlagMatch) {
			const path = destFlagMatch[1].replace(/^["']|["']$/g, '');
			results.push({ category: 'builtin_write', operator: cmdletName, path });
		} else {
			// Last non-flag token as destination
			const tokens =
				afterCmdlet.match(/(?:[^\s"-]+|"[^"]*"|'[^']*'|-[^\s]+)/g) ?? [];
			const nonFlagTokens = tokens.filter(
				(t) => !t.startsWith('-') && t.length > 0,
			);
			if (nonFlagTokens.length > 0) {
				const path = nonFlagTokens[nonFlagTokens.length - 1].replace(
					/^["']|["']$/g,
					'',
				);
				results.push({ category: 'builtin_write', operator: cmdletName, path });
			}
		}
	}

	return results;
}

// ---------------------------------------------------------------------------
// cmd.exe detection
// ---------------------------------------------------------------------------

/** cmd.exe builtins that write to files. */
const _CMD_WRITE_BUILTINS = new Set([
	'copy',
	'move',
	'type',
	'del',
	'rd',
	'md',
	'ren',
]);

/** cmd.exe switches that may appear in a copy/move command. */
const _CMD_COPY_MOVE_SWITCHES = new Set([
	'/a',
	'/b',
	'/d',
	'/f',
	'/n',
	'/v',
	'/y',
	'/-y',
	'/z',
]);

/** Tokenize cmd.exe arguments while retaining spaces inside quoted paths. */
function tokenizeCmdArguments(command: string): string[] {
	const tokens: string[] = [];
	let current = '';
	let inDoubleQuote = false;
	for (let index = 0; index < command.length; index++) {
		const character = command[index];
		if (character === '^' && !inDoubleQuote) {
			if (index + 1 < command.length) current += command[++index];
			continue;
		}
		if (character === '"') {
			inDoubleQuote = !inDoubleQuote;
			continue;
		}
		if (/\s/.test(character) && !inDoubleQuote) {
			if (current) {
				tokens.push(current);
				current = '';
			}
			continue;
		}
		current += character;
	}
	if (current) tokens.push(current);
	return tokens;
}

/**
 * Scan cmd.exe redirections without requiring whitespace around the operator.
 *
 * cmd.exe accepts all of these forms:
 *   echo x>file.txt
 *   echo x>>file.txt
 *   echo x 2>file.txt
 *   echo x 2>>file.txt
 *
 * `n>&m` is descriptor duplication when `m` is numeric and does not write a
 * file.  A non-numeric or missing destination after `>&` is deliberately
 * represented as an unresolved write so callers fail closed.
 */
function detectCmdRedirects(command: string): WriteTarget[] {
	const results: WriteTarget[] = [];
	let inDoubleQuote = false;

	const isTokenBoundary = (character: string | undefined): boolean =>
		character === undefined || /[;\s&|()]/.test(character);

	for (let index = 0; index < command.length; index++) {
		const character = command[index];

		// Caret escapes the following character in cmd.exe.  Do not interpret an
		// escaped `>` as a redirection operator.
		if (character === '^' && !inDoubleQuote) {
			index++;
			continue;
		}
		if (character === '"') {
			inDoubleQuote = !inDoubleQuote;
			continue;
		}
		if (inDoubleQuote || character !== '>') continue;

		const operator = command[index + 1] === '>' ? '>>' : '>';
		const targetStart = index + operator.length;
		let cursor = targetStart;
		while (/\s/.test(command[cursor] ?? '')) cursor++;

		// `>&1` / `2>&1` merges descriptors and is not a file write.  For
		// `>&name`, however, the destination is not statically verifiable.
		if (command[cursor] === '&') {
			cursor++;
			while (/\s/.test(command[cursor] ?? '')) cursor++;
			const descriptorStart = cursor;
			while (/\d/.test(command[cursor] ?? '')) cursor++;
			const descriptor = command.slice(descriptorStart, cursor);
			if (descriptor && isTokenBoundary(command[cursor])) {
				index = Math.max(index, cursor - 1);
				continue;
			}
			results.push({ category: 'redirect', operator, path: null });
			index = Math.max(index, cursor - 1);
			continue;
		}

		let pathValue: string | null = null;
		if (cursor < command.length) {
			const quote = command[cursor];
			if (quote === '"') {
				const closingQuote = command.indexOf(quote, cursor + 1);
				if (closingQuote !== -1) {
					pathValue = command.slice(cursor + 1, closingQuote);
					cursor = closingQuote + 1;
				}
			} else {
				const pathStart = cursor;
				while (
					cursor < command.length &&
					!/[\s&|()<>]/.test(command[cursor] ?? '')
				) {
					cursor++;
				}
				if (cursor > pathStart) pathValue = command.slice(pathStart, cursor);
			}
		}

		results.push({ category: 'redirect', operator, path: pathValue });
		index = Math.max(index, cursor - 1);
	}

	// An unmatched quote makes the command grammar unresolved.  Surface a
	// null-path write so scope validation rejects it instead of treating the
	// malformed command as read-only.
	if (inDoubleQuote) {
		results.push({ category: 'redirect', operator: '>', path: null });
	}

	return results;
}

/**
 * Detect write operations in a single cmd.exe command string using regex.
 * Handles builtins and redirection operators.
 */
function detectCmdWrites(command: string): WriteTarget[] {
	const results: WriteTarget[] = [];
	const trimmed = command.trim();
	if (!trimmed) return results;

	// Strip cmd.exe wrapper to get inner command
	// Handle: cmd /c "...", cmd /k "...", cmd /c "copy src dst", cmd.exe /c "..."
	let innerCommand = trimmed;
	// Switch-tolerant strip (#3145 PRR-002): `cmd /d /s /c "…"` must unwrap
	// like bare `cmd /c "…"` or the copy/move matchers never see the verb.
	const cmdWrapperMatch = trimmed.match(
		new RegExp(`${CMD_STRIP_PREFIX.source}(.*)$`, 'i'),
	);
	if (cmdWrapperMatch) {
		innerCommand = cmdWrapperMatch[1].trim();
		// Strip outer quotes if present (handles cmd /c "copy file.txt dest.txt")
		if (
			(innerCommand.startsWith('"') && innerCommand.endsWith('"')) ||
			(innerCommand.startsWith("'") && innerCommand.endsWith("'"))
		) {
			innerCommand = innerCommand.slice(1, -1);
		}
	}

	// CMD can launch PowerShell as a nested interpreter. Reuse the PowerShell
	// detector for a command-position wrapper so encoded payloads and nested
	// writes are not silently classified as read-only by the CMD detector.
	if (/^(?:powershell|pwsh)(?:\.exe)?\s+/i.test(innerCommand)) {
		results.push(...detectPowerShellWrites(innerCommand));
	}

	// Scan all redirections, including adjacent operators and descriptor forms.
	// The scanner emits `path: null` for an unresolved destination so callers
	// cannot accidentally treat an ambiguous redirection as read-only.
	results.push(...detectCmdRedirects(innerCommand));

	// Detect copy builtin: copy source dest (handles if exist pattern)
	function detectCmdCopy(cmd: string): WriteTarget | null {
		const commandMatch = cmd.match(
			new RegExp(`^${CMD_BUILTIN_PREFIX.source}copy(?=\\s|$)`, 'i'),
		);
		if (commandMatch) {
			const start = (commandMatch.index ?? 0) + commandMatch[0].length;
			const positional = tokenizeCmdArguments(cmd.slice(start)).filter(
				(token) => !_CMD_COPY_MOVE_SWITCHES.has(token.toLowerCase()),
			);
			if (positional.length < 2) return null;
			const dest = positional[positional.length - 1];
			return { category: 'builtin_write', operator: 'copy', path: dest };
		}
		return null;
	}

	// Detect move builtin: move source dest
	function detectCmdMove(cmd: string): WriteTarget | null {
		const commandMatch = cmd.match(
			new RegExp(`^${CMD_BUILTIN_PREFIX.source}move(?=\\s|$)`, 'i'),
		);
		if (commandMatch) {
			const start = (commandMatch.index ?? 0) + commandMatch[0].length;
			const positional = tokenizeCmdArguments(cmd.slice(start)).filter(
				(token) => !_CMD_COPY_MOVE_SWITCHES.has(token.toLowerCase()),
			);
			if (positional.length < 2) return null;
			const dest = positional[positional.length - 1];
			return { category: 'builtin_write', operator: 'move', path: dest };
		}
		return null;
	}

	const copyResult = detectCmdCopy(innerCommand);
	if (copyResult) results.push(copyResult);

	const moveResult = detectCmdMove(innerCommand);
	if (moveResult) results.push(moveResult);

	// Detect ren builtin: ren oldname newname
	const renMatch = innerCommand.match(
		/^ren\s+(\S+|"[^"]+"|'[^']+')\s+(\S+|"[^"]+"|'[^']+')/i,
	);
	if (renMatch) {
		const dest = (renMatch[2] || '').replace(/^["']|["']$/g, '');
		if (dest) {
			results.push({ category: 'builtin_write', operator: 'ren', path: dest });
		}
	}

	// Detect del builtin: del file (handles flags like /f /q before path)
	function detectCmdDel(cmd: string): WriteTarget | null {
		const delMatch = cmd.match(/^del\s+/i);
		if (!delMatch) return null;
		const rest = cmd.slice(delMatch[0].length).trim();
		// Split into tokens, then skip any token starting with /
		const rawTokens = rest.match(/(\/?[^\s]+|"[^"]*"|'[^']*')/g) ?? [];
		const tokens = rawTokens.filter((t) => !t.startsWith('/'));
		if (tokens.length > 0) {
			const path = tokens[0].replace(/^["']|["']$/g, '');
			return { category: 'builtin_write', operator: 'del', path };
		}
		return null;
	}

	const delResult = detectCmdDel(innerCommand);
	if (delResult) {
		results.push(delResult);
	}

	// Detect type builtin: type file (displays file content — read, not write, but
	// we note it for completeness; type itself is read-only)
	// Note: type is read-only, so we don't flag it as write

	// Detect rd (remove directory): rd /s /q path
	const rdMatch = innerCommand.match(/^rd\s+(?:\/s\s+|\/q\s+)*(\S+)/i);
	if (rdMatch) {
		const path = rdMatch[1].replace(/^["']|["']$/g, '');
		if (!path.startsWith('/')) {
			results.push({ category: 'builtin_write', operator: 'rd', path });
		}
	}

	// Detect md (make directory): md path
	const mdMatch = trimmed.match(/^md\s+(\S+)/i);
	if (mdMatch) {
		const path = mdMatch[1].replace(/^["']|["']$/g, '');
		if (!path.startsWith('/')) {
			results.push({ category: 'builtin_write', operator: 'md', path });
		}
	}

	return results;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Interactive / session tool detection
// ---------------------------------------------------------------------------

/**
 * Detect interactive/session tools that should be denied regardless of scope.
 *
 * These tools create persistent sessions or run commands repeatedly in a way
 * that is inherently open-ended and cannot be bounded safely.
 *
 * @param command - A shell command string
 * @param shell - The shell type: 'posix', 'powershell', or 'cmd'
 * @returns true if the command uses an interactive/session tool
 */
export function detectInteractiveSession(
	command: string,
	shell: 'posix' | 'powershell' | 'cmd',
): boolean {
	if (!command || typeof command !== 'string') return false;

	const trimmed = command.trim();

	if (shell === 'posix') {
		const lower = trimmed.toLowerCase();
		// watch — runs command repeatedly (infinite loop by default)
		if (/^watch(\s|$)/.test(lower)) return true;
		// screen — terminal multiplexer, creates persistent session
		if (/^screen(\s|$)/.test(lower)) return true;
		// tmux: deny if bare (starts tmux server) or new-session subcommand
		// Allow: attach-session, list-sessions, kill-session, etc.
		if (/^tmux(\s+new-session(\s+.*)?)?$/.test(lower)) return true;
	} else if (shell === 'powershell') {
		// Start-Process — launches new process, can create persistent sessions
		if (/^Start-Process\s/i.test(trimmed)) return true;
	}

	return false;
}

/**
 * Parse a POSIX shell command and detect all file-system write operations.
 *
 * Detects:
 * - Redirection operators: >, >>, >|, <<, <<- (here-docs)
 * - Write-effect builtins: cp, mv, install, ln, truncate, dd (of=), tee
 * - In-place editors: sed -i, perl -i, awk -i
 * - Interpreter eval: python -c, node -e, bun -e, ruby -e, perl -e, php -r
 * - Network downloaders: curl -o, wget -O, scp
 * - Archive extraction: tar -x, unzip, gunzip
 * - Git destructive: git checkout --, git restore, git reset --hard, git clean -fd
 *
 * @param command - A POSIX shell command string
 * @returns WriteAnalysis with array of detected write targets; hasWrites is false when array is empty
 */
export function detectPosixWrites(
	command: string,
	procsubRecursionDepth = 0,
): WriteAnalysis {
	if (!command || typeof command !== 'string') {
		return { writes: [], hasWrites: false };
	}
	// Reviewer F-b: the procsub body recursion re-masks/re-parses its
	// remaining body per level (super-linear in nesting depth — 28KB at
	// 4000 levels measured 17.4s vs 6ms base). Beyond the bound the nested
	// content fails CLOSED (the caller marks body writes unresolved).
	if (procsubRecursionDepth > 8) {
		return {
			writes: [],
			hasWrites: false,
			parseError: true,
		};
	}
	if (unsafeShellCommandTextReason(command)) {
		return {
			writes: [
				{
					// opaque interpreter_eval class: no capability flag,
					// blanket-blocked
					category: 'interpreter_eval',
					operator: 'unsafe command text',
					path: null,
				},
			],
			hasWrites: true,
			parseError: true,
		};
	}

	let ast: unknown;
	let parseFailed = false;
	try {
		ast = parse(command, { mode: 'posix', insertLOC: true });
		annotateRawWordText(ast, command);
	} catch {
		// Parser failed — treat as parse error (fail-closed)
		parseFailed = true;
	}

	const allWrites: WriteTarget[] = [];
	// Stays false (no empty-directory-removal tag survives) unless the parsed
	// command is proven cwd-neutral below.
	let cwdNeutral = false;
	// #3491 W3: any leaf whose wrapper chain exceeds the paranoid bound fails
	// closed through the additive analysis flag (consumed by the gate and
	// explain before every no-write early return).
	let unwrapDepthExceeded = false;

	if (!parseFailed && ast && typeof ast === 'object') {
		const leafCommands: BashNode[] = [];
		collectLeafCommands(ast as BashNode, leafCommands);
		cwdNeutral = leafCommands.every(isCwdNeutralLeaf);

		for (const cmd of leafCommands) {
			// Plain loop-push (not spread): a detector result can be
			// operand-proportional (rmdir/truncate with adversarial operand
			// counts), and the JS engine's spread-arity limit must not be the
			// thing that bounds it (#3512 review N-2, final-critic round 1).
			for (const write of detectRedirects(cmd)) allWrites.push(write);
			for (const write of detectBuiltinWrites(cmd)) allWrites.push(write);
			for (const write of detectInplaceEdit(cmd)) allWrites.push(write);
			for (const write of detectInterpreterEval(cmd)) allWrites.push(write);
			for (const write of detectLauncherWrites(cmd)) allWrites.push(write);
			for (const write of detectNetworkDownloaders(cmd)) allWrites.push(write);
			for (const write of detectArchiveExtract(cmd)) allWrites.push(write);
			for (const write of detectGitDestructive(cmd)) allWrites.push(write);
			for (const write of detectPatchApply(cmd)) allWrites.push(write);
			for (const write of detectRsyncWrites(cmd)) allWrites.push(write);
			if (
				detectorCommandPartsFromWordsBounded(
					getCommandName(cmd),
					getSuffixWords(cmd),
				).depthExceeded
			) {
				unwrapDepthExceeded = true;
			}
		}

		// #3474: stdin-fed interpreters behind literal pipe producers
		// (echo/printf | python). Emitted AFTER the leaf pass, in the same
		// depth-first pipeline order the collectWritesWithNodes emission
		// uses, so occurrence suffixes pair across the two walkers. The
		// `[eval stdin]` operator never collides with the leaf pass's
		// `[eval]` operator.
		collectPipeStdinEvals(ast as BashNode, allWrites);

		// #3491 closure round 4 — the isDynamicPath class-closing CHOKEPOINT
		// (the issue's own root-cause line: "isDynamicPath has no brace
		// check"). A POSIX-detected write whose literal path still carries a
		// brace-list region never went through the W8 engine — bash would
		// have expanded an UNQUOTED brace word before the tool ever saw it,
		// so a surviving brace region means the emitter read the word
		// literally (archive-decompress, rsync, git checkout/restore, and
		// any future site). Refuse it as a dynamic write (null path +
		// dynamicSourceWord) instead of emitting the literal: the gate
		// denies, fail-closed. POSIX-scoped BY CONSTRUCTION — this pass
		// lives in detectPosixWrites; detectWindowsWrites never sees it, so
		// a literal PowerShell/cmd `{a,b}` filename keeps its literal
		// handling (the preferred carve-out). QUOTE-AWARE: only a word whose
		// RAW slice the W8 engine itself WOULD expand seeds the refusal set;
		// a PURE-quoted literal brace filename never does, so it keeps its
		// literal path by construction. #3491 final corner (round 5): NO
		// same-text shadow exemption — when a command carries BOTH the
		// unquoted and the quoted spelling of one brace text, the unquoted
		// word's write still refuses (the quoted twin must not launder it).
		// Refusal is wholesale for non-engine'd brace destination words:
		// benign in-scope ones (gunzip -d src/{a,b}.gz) fail closed too
		// (fragment Known-edges); engine'd sites emit brace-free branch
		// texts, so the chokepoint is a no-op for them.
		const unquotedBraceTexts = new Set<string>();
		for (const leaf of leafCommands) {
			const leafSuffix = (leaf as BashCommand).suffix;
			if (!Array.isArray(leafSuffix)) continue;
			for (const node of leafSuffix) {
				if (!isBashWord(node)) continue;
				const raw = RAW_WORD_TEXT.get(node);
				const text = wordText(node);
				if (raw === undefined || text === null) continue;
				if (!BRACE_EXPANSION.test(text)) continue;
				if (expandBraceRaw(raw).kind !== 'none') {
					unquotedBraceTexts.add(text);
				}
			}
		}
		if (unquotedBraceTexts.size > 0) {
			for (let w = 0; w < allWrites.length; w++) {
				const write = allWrites[w];
				if (
					write.path !== null &&
					BRACE_EXPANSION.test(write.path) &&
					unquotedBraceTexts.has(write.path)
				) {
					allWrites[w] = {
						...write,
						path: null,
						dynamicSourceWord: write.path,
					};
				}
			}
		}
	}

	// #3539 W5 (RC-5): on a parse failure, first try to MASK every balanced
	// unquoted `>(…)`/`<(…)` span and parse the RESIDUAL. When that fully
	// succeeds (≥1 span masked, residual parses clean, every masked body
	// analyzed below, no ambiguity), the OUTER writes come from the normal
	// AST detectors on the residual — the laundered second write of the
	// partial-detector era is visible again — and the residual is returned
	// as `residualCommand` so the gate's resolver tracks cd context for
	// those outer writes. The masked INNER writes come from the shared
	// per-stage scan on each span body; they resolve at the starting cwd
	// unless their body or outer prefix carries a directory change, in
	// which case they withdraw (`unresolvedContext`, v4 constraint 6).
	// Anything less than full success keeps the fail-closed parseError —
	// now unconditionally (a partial-detector find no longer clears it).
	let forceParseError = false;
	let residualCommand: string | undefined;
	if (parseFailed) {
		const masked = maskProcSubSpans(command);
		let maskedOk = false;
		if (masked !== null) {
			// The residual carries no unquoted procsub span (every one was
			// masked), so this recursion cannot re-enter the masking branch;
			// a residual that still fails to parse keeps the parseError.
			const residualAnalysis = detectPosixWrites(masked.residual);
			if (residualAnalysis.parseError !== true) {
				maskedOk = true;
				unwrapDepthExceeded =
					unwrapDepthExceeded || residualAnalysis.unwrapDepthExceeded === true;
				// Outer writes: the normal AST detector result on the
				// residual. Placeholders are inert `/dev/null` operands —
				// suppressed by the existing sink-device exemption inside
				// BOTH the detection and resolver walks, so nothing is
				// removed post-hoc and occurrence numbering is unaffected
				// (v4 constraint 7).
				for (const write of residualAnalysis.writes) {
					allWrites.push(write);
				}
				// Inner writes: the shared per-stage scan per masked body —
				// for BOTH operators (`<(cat > f)` runs its body too). A
				// body or outer prefix with a directory-selection word
				// withdraws every write of that span (fail-closed): the
				// body's landing is not statically knowable.
				for (const span of masked.spans) {
					const withdraw = procsubContextWithdraws(
						masked.residual.slice(0, span.residualPlaceholderStart),
						span.body,
					);
					// #3568 review PRR-001 (parallel-review F-01): the
					// per-stage scan recognised only the builtin set plus
					// simple redirects, so tee/dd/curl/sed -i/python/rsync/
					// archive bodies and nested `<(` spans were invisible and
					// the span admitted while base parse-denied it. The body
					// is an inner POSIX command line — run the FULL detector
					// family on it (the recursion's own masking handles
					// nested spans, closing PRR-003's nested-`<(` hiding;
					// `;`-torn and `&&`-joined operands parse natively). A
					// body that fails to parse leaves every write unresolved
					// (fail-closed), and the read-only `<(ls)` admit is
					// preserved because a write-free body emits nothing.
					const bodyAnalysis = detectPosixWrites(
						span.body,
						procsubRecursionDepth + 1,
					);
					// Reviewer delta (Critical): the depth cap returns
					// {writes:[], parseError:true} — consulting the flag only
					// over body WRITES dropped it wholesale when the list was
					// empty, so a depth-9 nested escaping write escaped the
					// gate entirely. An empty body analysis past the cap is
					// the fail-closed signal itself: emit the null-path write.
					if (
						bodyAnalysis.parseError === true &&
						bodyAnalysis.writes.length === 0
					) {
						allWrites.push({
							category: 'redirect',
							operator: '>',
							path: null,
							unresolvedContext: true,
							dynamicSourceWord: span.body.slice(0, 80),
						});
					}
					for (const write of bodyAnalysis.writes) {
						allWrites.push(
							(withdraw || bodyAnalysis.parseError === true) &&
								write.unresolvedContext !== true
								? { ...write, unresolvedContext: true }
								: write,
						);
					}
				}
				residualCommand = masked.residual;
			}
		}
		if (maskedOk) {
			parseFailed = false;
		} else {
			// Legacy no-mask fallback: whole-command regex scan only. Its
			// partial success NEVER clears the parse error anymore — that
			// clearing was the RC-5 laundering defect. Every write it finds
			// is still emitted (a cd-context line withdraws them, #3518 P-3)
			// so the analysis stays informative, but the gate rejects the
			// line on the parse error regardless.
			forceParseError = true;
			const procSubWrites = detectProcessSubstitutionWrites(command);
			// #3518 P-3: the fallback has no AST, so a `cd` earlier in the
			// same line cannot move its tracked context — every write it
			// emits would silently resolve at the STARTING cwd while real
			// bash writes at the post-cd directory. Withdraw such writes
			// (`unresolvedContext`) so the resolver nulls them and the gate
			// denies, fail-closed.
			const cdContext = PROCSUB_CD_CONTEXT.test(command);
			// Plain loop (not spread-push): adversarial operand counts must
			// not hit the engine's spread-arity limit (#3512 review N-2).
			for (const write of procSubWrites) {
				allWrites.push(
					cdContext && write.unresolvedContext !== true
						? { ...write, unresolvedContext: true }
						: write,
				);
			}
		}
	}

	// Deduplicate by (category, operator, path) to avoid double-counting —
	// but every nth duplicate occurrence SURVIVES with an occurrence-suffixed
	// operator (`#2`, `#3`, …). #3347 introduced the suffix for capability
	// evals (same-interpreter occurrences across `cd` boundaries each need
	// routing at their own working directory); #3518 P-4 widened it to every
	// duplicate: a same-literal write pair separated by a `cd` resolves each
	// occurrence at its own tracked context instead of collapsing onto the
	// first occurrence's resolution. The suffix stays unique through the
	// resolution and merge dedupe layers that key on the same triple — both
	// AST walks traverse in the same order, so the suffixes pair up across
	// the two passes. Same-cwd duplicates resolve identically either way, so
	// the widening only adds per-occurrence precision.
	const seen = new Set<string>();
	const occurrence = new Map<string, number>();
	const collidingKeys = new Set<string>();
	let writes: WriteTarget[] = [];
	for (const wt of allWrites) {
		const key = buildDedupeKey(wt.category, wt.operator, wt.path);
		if (seen.has(key)) {
			collidingKeys.add(key);
			const n = (occurrence.get(key) ?? 1) + 1;
			occurrence.set(key, n);
			writes.push({ ...wt, operator: `${wt.operator} #${n}` });
			continue;
		}
		seen.add(key);
		writes.push(wt);
	}

	// PR #3456 (F-2): a colliding key may name writes run under different
	// working directories, so EVERY occurrence of a colliding key — including
	// the #3518 occurrence-suffixed survivors — is demoted (the tag would
	// authorize a directory the gate cannot pin to this occurrence).
	const baseDedupeKey = (wt: WriteTarget): string =>
		buildDedupeKey(wt.category, wt.operator.replace(/ #[0-9]+$/, ''), wt.path);
	writes = writes.map((wt) =>
		wt.emptyDirectoryRemoval === true && collidingKeys.has(baseDedupeKey(wt))
			? withoutEmptyDirectoryRemoval(wt)
			: wt,
	);

	// PR #3456 closeout (issue #3450): an empty-directory-removal tag survives
	// only on a PLAIN_COMMAND_LINE, which cannot hold a comment, a quote, an
	// escape, an expansion or code that bash evaluates at run time
	// (fail-closed: anything else gets the ordinary declared-scope check).
	if (!PLAIN_COMMAND_LINE.test(command)) {
		writes = writes.map(withoutEmptyDirectoryRemoval);
	}

	// PR #3456 closeout (issue #3450): the gate checks a tagged write at the
	// path resolveWriteTargets computes, and that cwd tracking does not model
	// every way a line can change directory (`true && cd ../o; rmdir a`,
	// `pushd`, `builtin cd`, `trap`, `source`, `.`, ...). A tag therefore
	// survives only when every command in the line is a CWD_NEUTRAL_COMMANDS
	// name, so the directory a write resolves against is the directory bash
	// runs it in (fail-closed: anything else gets the ordinary declared-scope
	// check).
	if (!cwdNeutral) {
		writes = writes.map(withoutEmptyDirectoryRemoval);
	}

	return {
		writes,
		hasWrites: writes.length > 0,
		// #3539 W5: the legacy fallback's parseError is now unconditional —
		// a partial-detector find no longer clears the fail-closed flag.
		parseError:
			forceParseError || (parseFailed && writes.length === 0)
				? true
				: undefined,
		residualCommand,
		unwrapDepthExceeded: unwrapDepthExceeded || undefined,
	};
}

/**
 * The only characters a command line may hold for an empty-directory-removal
 * tag to survive (detectPosixWrites): ASCII letters, digits, space, tab,
 * newline and `_ . / - = & | ; < >`. Nothing else: no `$`, backtick, quote,
 * backslash, parenthesis, brace, bracket, `*`, `?`, `~`, `!`, `#`, `%`, `+`,
 * `,`, `:`, `@`, carriage return or non-ASCII character. On such a line, by
 * construction and whatever the parser makes of it:
 * - no expansion or evaluation context can appear: no parameter, command,
 *   arithmetic or bash 5.3 `${ cmd; }` substitution, no `test -v` array
 *   subscript, no quoted code that bash evaluates at run time, and no
 *   expansion inside a here-document body;
 * - every word is literal, so a parsed word (a command name, an rmdir
 *   operand) is exactly the text the shell uses: no quote or backslash can
 *   make bash-parser and the shell read it differently;
 * - no function can be defined (`f() ...` needs parentheses, and
 *   bash-parser reads `function f ...` as a command named `function`), and
 *   no subshell, brace group or `case` can appear;
 * - no comment can start: bash starts one only at a word start, so
 *   `rmdir d#/x` removes the one directory `d#/x` while the tokenizer here
 *   reads operand `d` plus a comment (PR #3456 review F-3).
 * Every other line simply gets the ordinary declared-scope check
 * (fail-closed): the exemption is a convenience for plain lines such as
 * `rmdir dir` or `rmdir a 2>/dev/null || true`.
 */
const PLAIN_COMMAND_LINE = /^[A-Za-z0-9 \t\n_./=&|;<>-]*$/;

/**
 * Commands that cannot change the shell's working directory, so a line built
 * only from them runs every `rmdir` in the directory the line started in.
 * This is the whole allowlist for keeping an empty-directory-removal tag
 * (detectPosixWrites). Matching is exact and case-sensitive: `RMDIR` is not
 * `rmdir` here. Everything else, including `cd`, `pushd`, `popd`, `builtin`,
 * `command`, `eval`, `exec`, `source`, `.`, `trap`, `alias`, `function` and
 * the name of any function, withdraws the tag, and the write gets the
 * ordinary declared-scope check.
 */
const CWD_NEUTRAL_COMMANDS: ReadonlySet<string> = new Set([
	'rmdir',
	'mkdir',
	'echo',
	'true',
	'false',
	'test',
]);

/**
 * The container node types collectLeafCommands pushes and then descends into
 * on a PLAIN_COMMAND_LINE: `if`, `while`, `until` and `for` statements and
 * their CompoundList clauses and bodies. They run nothing themselves; their
 * commands are judged as their own leaves. Any other node type that is not a
 * Command counts as not cwd-neutral (fail-closed default). No Subshell,
 * Case or Function node can occur on a plain line (each needs a
 * parenthesis), so the default and the parenthesis exclusion in
 * PLAIN_COMMAND_LINE each cover those forms for the other. A brace group
 * parses as a CompoundList and is kept off a plain line only by the `{` and
 * `}` exclusions.
 */
const CWD_TRANSPARENT_NODE_TYPES: ReadonlySet<string> = new Set([
	'CompoundList',
	'If',
	'While',
	'Until',
	'For',
]);

/**
 * Whether one entry of the collectLeafCommands list is cwd-neutral: a
 * CWD_TRANSPARENT_NODE_TYPES container, a command named by a
 * CWD_NEUTRAL_COMMANDS word, or a command with no name whose prefix holds
 * only assignments and redirections (`FOO=1`, `>x`). A nameless command
 * whose prefix holds anything else, such as the bare here-document marker
 * bash-parser leaves when it drops the delimiter word (`FOO=1 <<E; rmdir a`),
 * is not.
 */
function isCwdNeutralLeaf(node: BashNode): boolean {
	if (node.type !== 'Command') {
		return CWD_TRANSPARENT_NODE_TYPES.has(node.type);
	}
	const name = getCommandName(node);
	if (name !== null) return CWD_NEUTRAL_COMMANDS.has(name);
	const prefix: unknown = (node as BashCommand).prefix ?? [];
	return (
		Array.isArray(prefix) &&
		prefix.every((entry: unknown) => {
			if (!entry || typeof entry !== 'object') return false;
			const type = (entry as { type?: unknown }).type;
			return type === 'AssignmentWord' || type === 'Redirect';
		})
	);
}

/**
 * #3474: inline-code flags per canonical interpreter under Windows grammar.
 * Mirrors the POSIX eval-flag table in detectInterpreterEval (shells
 * excluded: `-c`/`-Command` wrapper forms are unwrapped by the dc layer).
 */
const WINDOWS_INTERPRETER_EVAL_FLAGS: ReadonlyMap<string, readonly string[]> =
	new Map(
		Object.entries({
			python: ['-c'],
			python3: ['-c'],
			python2: ['-c'],
			py: ['-c'],
			node: ['-e', '--eval', '-p', '--print'],
			bun: ['-e'],
			ruby: ['-e'],
			perl: ['-e', '-E'],
			php: ['-r', '-R', '-F'],
		}) as [string, readonly string[]][],
	);

/**
 * Recognize a leading interpreter with an inline-code flag in a
 * Windows-grammar fragment and emit the capability-eval write (path null —
 * the gate authorizes the eval's working directory, here the command's
 * STARTING directory via the resolveWriteTargets fallback, conservative for
 * every proper declared scope because the start is the workspace root).
 */
function detectWindowsInterpreterEval(fragment: string): WriteTarget[] {
	const tokens = fragment.trim().split(/\s+/);
	if (tokens.length < 2) return [];
	// #3485 (PRR-018): strip surrounding quotes so quoted exe paths
	// ("C:\\Program Files\\...\\python.exe") basename correctly.
	const leaf = basenameAnySep(tokens[0].replace(/^["']+|["']+$/g, ''));
	const canonical = detectorSetMember(
		leaf,
		new Set(WINDOWS_INTERPRETER_EVAL_FLAGS.keys()),
	);
	if (!canonical) return [];
	const flags = WINDOWS_INTERPRETER_EVAL_FLAGS.get(canonical) ?? [];
	for (let i = 1; i < tokens.length; i++) {
		const token = tokens[i];
		// #3485 (PRR-018): glued spellings (`python -ccode`) execute inline
		// code exactly like the spaced/`=` forms.
		if (
			flags.some(
				(flag) =>
					token === flag ||
					token.startsWith(`${flag}=`) ||
					(token.startsWith(flag) && token.length > flag.length),
			)
		) {
			return [
				{
					category: 'interpreter_eval',
					operator: `${tokens[0]} [eval]`,
					path: null,
					capability: true,
				},
			];
		}
	}
	return [];
}

/**
 * Parse a Windows shell command (PowerShell or cmd.exe) and detect all
 * file-system write operations using regex heuristics.
 *
 * Detects:
 * - Redirection operators: >, >>
 * - PowerShell cmdlets: Out-File, Set-Content, Add-Content, Clear-Content,
 *   Copy-Item, Move-Item, Remove-Item, Invoke-WebRequest (-OutFile), Start-Process
 * - PowerShell aliases: echo, write (when used with redirection)
 * - cmd.exe builtins: copy, move, ren, del, rd, md
 * - cmd.exe redirections: >, >>
 * - cmd.exe echo/set with redirection
 *
 * @param command - A Windows shell command string
 * @param shell - Either 'powershell' or 'cmd'
 * @returns WriteAnalysis with array of detected write targets; hasWrites is false when array is empty
 */
export function detectWindowsWrites(
	command: string,
	shell: 'powershell' | 'cmd',
): WriteAnalysis {
	if (!command || typeof command !== 'string') {
		return { writes: [], hasWrites: false };
	}
	if (unsafeShellCommandTextReason(command)) {
		return {
			writes: [
				{
					// opaque interpreter_eval class: no capability flag,
					// blanket-blocked
					category: 'interpreter_eval',
					operator: 'unsafe command text',
					path: null,
				},
			],
			hasWrites: true,
			parseError: true,
		};
	}

	try {
		// Split compound commands (pipelines, &&, ||)
		const subCommands = splitWindowsCommands(command, shell);
		const allWrites: WriteTarget[] = [];

		// #3474: interpreter evals are grammar-independent — a
		// backslash path-qualified interpreter with an inline-code flag is an
		// eval under either Windows grammar. The operator uses the RAW
		// leading word in exactly the POSIX `${name} [eval]` format so a
		// spelling both grammars classify collapses to ONE dedupe key and the
		// Windows row inherits the POSIX walker's tracked context instead of
		// overriding it (plan-critic r2 B5).
		for (const subCmd of subCommands) {
			allWrites.push(...detectWindowsInterpreterEval(subCmd));
		}

		// Issue #3099: BOTH sub-detectors run on EVERY fragment — never one or
		// the other. Switching on `shell` lost a family: `copy`, `move`, `ren`,
		// `del`, `rd` and `md` are cmd builtins whose rules live only in
		// detectCmdWrites, yet `copy a b | Get-Content x` is PowerShell-shaped
		// (Get-Content) and so was routed to the PowerShell detector alone.
		// Running both per fragment also PRESERVES the fragment split, which a
		// whole-string union would lose: the file-op matchers are start-anchored,
		// so `Get-ChildItem .; Remove-Item OUTSIDE.md` only reports its write
		// because splitting isolates `Remove-Item OUTSIDE.md`.
		for (const subCmd of subCommands) {
			const psWrites = detectPowerShellWrites(subCmd);
			// The working-directory-mutation sentinel is PowerShell-semantics
			// fail-closed; under cmd authority it fires on ordinary cmd chains
			// base admitted (`cd src && echo hi`) with a null path the gate
			// words as a false substitution diagnostic. Emit it only when
			// PowerShell is the declared executor (#3099 round-4 Important 1);
			// real writes still union on both routes.
			const psFiltered =
				shell === 'powershell'
					? psWrites
					: psWrites.filter((w) => w.operator !== 'working-directory mutation');
			allWrites.push(...psFiltered);
			const cmdWrites = detectCmdWrites(subCmd);
			// Single quotes delimit strings in PowerShell but are literal
			// characters in cmd, so the cmd redirect scanner phantoms a write
			// for any PowerShell string literal containing `>`
			// (`Write-Output 'a > b'` → `b'`). Under PowerShell authority the
			// PowerShell scanner is the redirect authority (correct PS quoting,
			// incl. `''` escapes and unclosed-literal fail-closed); keep the cmd
			// side's file-op families — the reason the #3099 union exists — and
			// drop only its redirect rows. Under cmd authority single quotes are
			// genuinely literal, so nothing is filtered there.
			const cmdFiltered =
				shell === 'powershell'
					? cmdWrites.filter((w) => w.category !== 'redirect')
					: cmdWrites;
			allWrites.push(...cmdFiltered);
		}

		// Deduplicate by (category, operator, path), collapsing QUOTE
		// VARIANTS (#3145 CI round): the cmd-redirect scanner's single-quote
		// blind spot can emit the same target twice — `Get-Process>'a.md'`
		// yields `a.md` (PowerShell detector) plus `'a.md'` (literal quotes,
		// cmd scanner). A quoted variant that strips back to an
		// already-seen clean path is an artifact of the other grammar's
		// quoting, not a distinct target; genuinely different paths never
		// match after stripping and both survive.
		const stripQuotes = (p: string | null | undefined) =>
			p === null || p === undefined
				? p
				: p.replace(/^['"]+/, '').replace(/['"]+$/, '');
		const seen = new Set<string>();
		const seenStripped: Array<{
			category: string;
			operator: string;
			path: string | null;
		}> = [];
		const occurrence = new Map<string, number>();
		const writes: WriteTarget[] = [];
		for (const wt of allWrites) {
			const key = buildDedupeKey(wt.category, wt.operator, wt.path);
			// #3347/#3474 parity: a capability interpreter_eval repeated across
			// fragments keeps EVERY occurrence with an occurrence-suffixed
			// operator (`… [eval] #2`), mirroring the POSIX dedupe — the
			// Windows dedupe used to drop them, hiding later evals.
			if (seen.has(key)) {
				if (wt.capability !== true || wt.category !== 'interpreter_eval') {
					continue;
				}
				const n = (occurrence.get(key) ?? 1) + 1;
				occurrence.set(key, n);
				writes.push({ ...wt, operator: `${wt.operator} #${n}` });
				continue;
			}
			const stripped = stripQuotes(wt.path);
			if (stripped !== wt.path) {
				const artifact = seenStripped.some(
					(other) =>
						other.category === wt.category &&
						other.operator === wt.operator &&
						stripQuotes(other.path) === stripped,
				);
				if (artifact) continue;
			}
			seen.add(key);
			seenStripped.push({
				category: wt.category,
				operator: wt.operator,
				path: wt.path,
			});
			writes.push(wt);
		}

		return { writes, hasWrites: writes.length > 0 };
	} catch {
		return { writes: [], hasWrites: false, parseError: true };
	}
}

// ---------------------------------------------------------------------------
// Path resolution for write targets
// ---------------------------------------------------------------------------

/**
 * Returns true if the path string contains dynamic elements that cannot be
 * statically resolved: environment variables ($VAR or ${VAR}) or command
 * substitution ($(cmd) or `cmd`).
 */
function isDynamicPath(pathText: string | null): boolean {
	if (pathText === null || pathText === undefined) return false;
	// $VAR or ${VAR}
	if (/\$[A-Za-z_][A-Za-z0-9_]*/.test(pathText)) return true;
	if (/\$\{[^}]+\}/.test(pathText)) return true;
	// %VAR% is cmd.exe environment-variable expansion.
	if (/%[A-Za-z_][A-Za-z0-9_]*%/.test(pathText)) return true;
	// $(cmd)
	if (/\$\([^)]+\)/.test(pathText)) return true;
	// `cmd` (backtick command substitution)
	if (/`[^`]+`/.test(pathText)) return true;
	// Tilde expansion is resolved by the shell, not by the static resolver.
	if (/^~(?:[^/\\\s]*)?(?:[/\\]|$)/.test(pathText)) return true;
	// cmd.exe batch parameters and modifiers (for example %~dp0, %1, %*).
	if (/%~[A-Za-z]*(?:\d+|\*)/.test(pathText)) return true;
	if (/%(?:\d+|\*)/.test(pathText)) return true;
	return false;
}

/**
 * Resolve a single path against a cwd using POSIX semantics (path.posix.resolve).
 * Returns null if path is null or contains dynamic elements.
 *
 * NOTE: This function expects cwd to be a POSIX-style absolute path (forward slashes,
 * no drive letter). On Windows, callers must normalize the cwd to POSIX format
 * (e.g., C:\Users\foo → /c/Users/foo) before calling this function, or use
 * path.posix.resolve with a POSIX-normalized cwd.
 */
function resolvePath(pathText: string | null, cwd: string): string | null {
	if (pathText === null) return null;
	if (isDynamicPath(pathText)) return null;
	// Use platform-appropriate resolution: Windows paths (drive letter or backslash)
	// need win32 resolution; POSIX paths use posix resolution.
	const isWindowsPath = /^[a-zA-Z]:[\\\\/]/.test(cwd) || cwd.includes('\\');
	if (isWindowsPath) {
		return path.win32.resolve(cwd, pathText);
	}
	const normalizedRelativeWindowsPath =
		!path.posix.isAbsolute(pathText) && !/^[a-zA-Z]:[\\/]/.test(pathText)
			? pathText.replace(/\\/g, '/')
			: pathText;
	return path.posix.resolve(cwd, normalizedRelativeWindowsPath);
}

/**
 * #3491 W1: the sole directory-state model threaded through both resolution
 * walks (tracked and pessimistic). It carries everything a shell keeps for
 * directory selection — the current directory, the previous directory
 * (`cd -`), and the pushd stack — plus the walk's withdrawal flag. A
 * transition the static model cannot resolve (dynamic cd operand, `cd -`
 * with no modeled prior, HOME/OLDPWD reassignment, stack misuse, control-flow
 * divergence over the COMPLETE state) sets `withdrawn`, and every write the
 * walk collects afterwards is marked `unresolvedContext` (the proven #3518
 * P-3 fail-closed channel: the resolver nulls it and the gate denies).
 */
interface DirectoryState {
	cwd: string;
	prevCwd: string | null;
	dirStack: string[];
	withdrawn: boolean;
	/** Text-level per-command facts (evaluated once per walk on the raw line). */
	homeReassigned: boolean;
	oldpwdReassigned: boolean;
}

function cloneDirectoryState(state: DirectoryState): DirectoryState {
	return {
		cwd: state.cwd,
		prevCwd: state.prevCwd,
		dirStack: [...state.dirStack],
		withdrawn: state.withdrawn,
		homeReassigned: state.homeReassigned,
		oldpwdReassigned: state.oldpwdReassigned,
	};
}

/**
 * Divergence comparison over the COMPLETE directory state (v4 constraint 3):
 * cwd, prevCwd, the pushd stack AND the withdrawal flag must all agree for
 * two candidate outcomes to merge; any disagreement is a divergence the walk
 * cannot enumerate. (#3567 review PRR-001: a withdrawn candidate has NOT
 * "already failed closed where it was collected" for LATER siblings — the
 * If/Case/loop merges used this equality to treat a withdrawn-only branch as
 * a no-op, so a dynamic `cd $D` inside a branch never propagated the
 * withdrawal to writes that follow the construct. Withdrawal is divergence.)
 */
function directoryStatesEqual(a: DirectoryState, b: DirectoryState): boolean {
	if (a.withdrawn !== b.withdrawn) return false;
	if (a.cwd !== b.cwd || a.prevCwd !== b.prevCwd) return false;
	if (a.dirStack.length !== b.dirStack.length) return false;
	for (let i = 0; i < a.dirStack.length; i += 1) {
		if (a.dirStack[i] !== b.dirStack[i]) return false;
	}
	return true;
}

/** Adopt another state's complete directory selection into `target`. */
function adoptDirectoryState(
	target: DirectoryState,
	source: DirectoryState,
): void {
	target.cwd = source.cwd;
	target.prevCwd = source.prevCwd;
	target.dirStack = [...source.dirStack];
	target.withdrawn = target.withdrawn || source.withdrawn;
}

/**
 * A parsed directory-selection command: cd/pushd/popd with its first operand
 * word (quote-removed text) or null when the verb carries no operand.
 */
interface DirectoryCommand {
	verb: 'cd' | 'pushd' | 'popd';
	operand: string | null;
}

/**
 * Parse a Command/SimpleCommand node as a cd/pushd/popd invocation.
 *
 * `cd` skips its option words (`-L`, `-P`, either cluster order, `--`) before
 * the operand — the positive word forms `cd -P src` / `cd -- src` track their
 * real landing instead of the historical accident of resolving a directory
 * literally named `-P`. `pushd`/`popd` take no transparent options here; any
 * dash word stays the operand and is classified (and withdrawn) downstream.
 */
function parseDirectoryCommand(cmd: unknown): DirectoryCommand | null {
	if (!cmd || typeof cmd !== 'object') return null;
	const c = cmd as BashCommand;
	if (c.type !== 'SimpleCommand' && c.type !== 'Command') return null;
	const name = c.name;
	if (!name || typeof name !== 'object') return null;
	const n = name as BashWord;
	if (n.type !== 'Word') return null;
	const text = n.text;
	if (text !== 'cd' && text !== 'pushd' && text !== 'popd') return null;
	const suffix = c.suffix;
	if (!Array.isArray(suffix)) return { verb: text, operand: null };
	let index = 0;
	if (text === 'cd') {
		while (index < suffix.length) {
			const word = suffix[index];
			if (!isBashWord(word)) break;
			const wordText = word.text;
			if (wordText === '--') {
				index += 1;
				break;
			}
			if (/^-[LP]+$/.test(wordText)) {
				index += 1;
				continue;
			}
			break;
		}
	}
	for (let i = index; i < suffix.length; i += 1) {
		const word = suffix[i];
		if (!isBashWord(word)) continue;
		return { verb: text, operand: word.text };
	}
	return { verb: text, operand: null };
}

/**
 * Move the state to an absolute landing under the mode's proof rules and
 * update prevCwd exactly like the shell (only a directory change that
 * actually happened updates OLDPWD). Returns true when the cwd moved.
 */
function landDirectoryState(
	state: DirectoryState,
	landing: string,
	cdMode: 'gate' | 'gate-skip' | 'succeed',
): boolean {
	if (cdMode === 'gate') {
		let isDirectory = false;
		try {
			isDirectory =
				statSync(landing, { throwIfNoEntry: false })?.isDirectory() === true;
		} catch {
			isDirectory = false;
		}
		if (!isDirectory) return false;
	}
	if (landing === state.cwd) {
		// #3567 review PRR-006: bash still refreshes OLDPWD when `cd` lands on
		// the CURRENT directory (`cd .` from /a makes OLDPWD=/a, so a later
		// `cd -` returns to /a — not to whatever OLDPWD held before). The old
		// early-return skipped that refresh, so `cd ..; cd .; cd -` modeled a
		// stale previous directory and judged the following write at a landing
		// bash never used. Same-directory cd/pushd/popd now model the refresh.
		state.prevCwd = state.cwd;
		return false;
	}
	state.prevCwd = state.cwd;
	state.cwd = landing;
	return true;
}

/** The shell's HOME landing for bare `cd` / `cd ~` / `cd ~/x` (#3491 W1). */
function homeLanding(rest: string): string {
	const home = os.homedir();
	if (rest === '') return home;
	const resolved = resolvePath(rest, home);
	return resolved === null ? path.join(home, rest) : resolved;
}

/**
 * Apply one directory-selection command to the walk state (#3491 W1).
 * Returns true when the node WAS a cd/pushd/popd (the caller then skips the
 * ordinary command walk — cd itself produces no writes).
 *
 * Word forms:
 * - bare `cd`, `cd ~`, `cd ~/x`: land at $HOME — unless the raw line
 *   reassigns HOME (any segment or a command prefix), which is withdrawn
 *   (inherited-$HOME truth is unavailable statically).
 * - `cd -`: land at prevCwd; prevCwd === null (no modeled prior cd, including
 *   a line that reassigns OLDPWD) ⇒ withdraw.
 * - dynamic operand ($VAR, $(…), backticks): WITHDRAW — the historical
 *   literal-append could land inside a broad declared scope (fail-open, plan
 *   critic r2/r3).
 * - `pushd <dir>`: push current onto dirStack (cap 32; overflow withdraws)
 *   with cd semantics for the operand; bare `pushd` swaps the top two;
 *   `pushd ±N` / `pushd -n` / any option word withdraws.
 * - `popd`: pop to the restored cwd (prevCwd updates like every
 *   directory-changing op); empty stack or `popd ±N` / `-n` withdraws.
 */
function applyDirectoryTransition(
	state: DirectoryState,
	cmd: unknown,
	cdMode: 'gate' | 'gate-skip' | 'succeed',
): boolean {
	const parsed = parseDirectoryCommand(cmd);
	if (!parsed) return false;
	// 'gate-skip' (the tracked walk inside a conditional right branch): model
	// the SKIP landing — the command never ran, so it neither moves the state
	// nor withdraws it (#3485 PRR-001 skip contract).
	if (cdMode === 'gate-skip') return true;
	const operand = parsed.operand;
	if (parsed.verb === 'popd') {
		if (operand !== null) {
			state.withdrawn = true;
			return true;
		}
		if (state.dirStack.length < 1) {
			state.withdrawn = true;
			return true;
		}
		const restored = state.dirStack.shift();
		if (restored === undefined) {
			state.withdrawn = true;
			return true;
		}
		state.prevCwd = state.cwd;
		state.cwd = restored;
		return true;
	}
	if (parsed.verb === 'pushd') {
		if (operand === null) {
			// Bare pushd: exchange the current directory with the stack top.
			if (state.dirStack.length < 1) {
				state.withdrawn = true;
				return true;
			}
			const oldCwd = state.cwd;
			state.cwd = state.dirStack[0];
			state.dirStack[0] = oldCwd;
			state.prevCwd = oldCwd;
			return true;
		}
		if (/^[+-]\d+$/.test(operand) || operand.startsWith('-')) {
			// pushd ±N rotates the stack; pushd -n pushes without cd — neither
			// is modeled ⇒ withdraw (fail-closed).
			state.withdrawn = true;
			return true;
		}
		if (operand === '-' || isDynamicPath(operand)) {
			state.withdrawn = true;
			return true;
		}
		let landing: string | null;
		let isTilde = false;
		if (operand === '~' || operand.startsWith('~/')) {
			if (state.homeReassigned) {
				state.withdrawn = true;
				return true;
			}
			landing = homeLanding(operand === '~' ? '' : operand.slice(2));
			isTilde = true;
		} else {
			landing = resolvePath(operand, state.cwd);
		}
		if (landing === null) {
			state.withdrawn = true;
			return true;
		}
		if (cdMode === 'succeed' && !isTilde) {
			landing = resolveBashCdTarget(operand, state.cwd, landing);
		}
		const oldCwd = state.cwd;
		if (landDirectoryState(state, landing, cdMode)) {
			if (state.dirStack.length >= 32) {
				state.withdrawn = true;
				return true;
			}
			state.dirStack.unshift(oldCwd);
		}
		return true;
	}
	// cd
	if (operand === null || operand === '~' || operand.startsWith('~/')) {
		if (state.homeReassigned) {
			state.withdrawn = true;
			return true;
		}
		landDirectoryState(
			state,
			homeLanding(operand === null || operand === '~' ? '' : operand.slice(2)),
			cdMode,
		);
		return true;
	}
	if (operand === '-') {
		if (state.prevCwd === null || state.oldpwdReassigned) {
			state.withdrawn = true;
			return true;
		}
		landDirectoryState(state, state.prevCwd, cdMode);
		return true;
	}
	if (isDynamicPath(operand)) {
		state.withdrawn = true;
		return true;
	}
	const resolved = resolvePath(operand, state.cwd);
	if (resolved === null) {
		state.withdrawn = true;
		return true;
	}
	const landing =
		cdMode === 'succeed'
			? resolveBashCdTarget(operand, state.cwd, resolved)
			: resolved;
	landDirectoryState(state, landing, cdMode);
	return true;
}

/**
 * Collect all write targets from a command node, including their context cwd,
 * in the same order as `collectLeafCommands` traversal.
 *
 * Returns pairs of (write target, context cwd) for path resolution.
 */
interface WriteWithNode {
	write: WriteTarget;
	context: string;
}

/**
 * Walk a node and collect writes with their source nodes, in the same order
 * as `collectLeafCommands` so we can match writes by position.
 */
/**
 * Shared cd-tracking landing core for literal operands (#3530 feedback,
 * folded into applyDirectoryTransition): 'gate' mode moves ONLY when analysis
 * can prove the target is an existing directory (#3518 P-2); 'succeed' mode
 * tracks the directory bash WOULD select — Git Bash MSYS drive mapping for
 * `/x/...` spellings (plain win32 resolution maps `/e/a` to the CURRENT
 * drive, not drive E:), then the ordinary analyzer resolution.
 */

/**
 * The directory Git Bash would select for a cd target — the pessimistic
 * ('succeed') landing. MSYS drive rule: a POSIX-absolute path whose first
 * segment is a single drive letter names THAT drive (`/e/a` -> `E:\a`);
 * plain win32 resolution of such a path names the CURRENT drive instead.
 * Everything else falls back to the analyzer resolution.
 */
function resolveBashCdTarget(
	cdTarget: string,
	current: string,
	analyzerResolved: string,
): string {
	const driveForm = /^\/([a-zA-Z])(?=\/|$)(.*)$/.exec(cdTarget);
	if (driveForm) {
		const rest = driveForm[2];
		return `${driveForm[1].toUpperCase()}:${rest === '' ? '\\' : rest}`;
	}
	return analyzerResolved || path.posix.resolve(current, cdTarget);
}

/**
 * Bash-truth (#3567 review P-F5): a function CALL executes its body in the
 * CURRENT shell, so the body's relative directory transitions land relative
 * to the CALL-TIME cwd — which the definition-time walk cannot know. A call
 * to a function whose body contains any cd/pushd/popd therefore withdraws
 * (fail-closed). The table is built once per walk from the command's own
 * Function-definition nodes.
 */
function bashFunctionBodyHasDirectoryTransition(node: unknown): boolean {
	if (!node || typeof node !== 'object') return false;
	const n = node as Record<string, unknown>;
	if (
		(n.type === 'SimpleCommand' || n.type === 'Command') &&
		n.name !== null &&
		typeof n.name === 'object'
	) {
		const name = n.name as Record<string, unknown>;
		if (name.type === 'Word' && typeof name.text === 'string') {
			const text = name.text;
			if (text === 'cd' || text === 'pushd' || text === 'popd') return true;
		}
	}
	for (const value of Object.values(n)) {
		if (Array.isArray(value)) {
			for (const item of value) {
				if (bashFunctionBodyHasDirectoryTransition(item)) return true;
			}
		} else if (value && typeof value === 'object') {
			if (bashFunctionBodyHasDirectoryTransition(value)) return true;
		}
	}
	return false;
}

/**
 * Pre-build the function-name → body-has-directory-transition table from a
 * command AST (#3567 review P-F5). Bash runs a function body in the CURRENT
 * shell at CALL time, so a call to a transition-bearing function withdraws
 * (the call-time landing is unknowable from the definition). A call that
 * textually precedes its definition is a bash runtime error — withdrawal
 * stays fail-closed there too. The table CLOSES OVER the call graph
 * (reviewer revision): a body that CALLS another defined function inherits
 * that function's transition status transitively (`g(){ cd ..; }; f(){ g;
 * }; f` must withdraw like the direct call).
 */
function collectFunctionTransitions(
	node: unknown,
	into: Map<string, boolean>,
): void {
	const direct = new Map<string, boolean>();
	const calls = new Map<string, string[]>();
	const walk = (n: unknown): void => {
		if (!n || typeof n !== 'object') return;
		const rec = n as Record<string, unknown>;
		if (rec.type === 'Function') {
			const rawName = rec.name;
			const nameText =
				typeof rawName === 'string'
					? rawName
					: typeof rawName === 'object' &&
							rawName !== null &&
							typeof (rawName as Record<string, unknown>).text === 'string'
						? (rawName as Record<string, unknown>).text
						: undefined;
			if (typeof nameText === 'string' && nameText !== '' && rec.body) {
				direct.set(nameText, bashFunctionBodyHasDirectoryTransition(rec.body));
				calls.set(nameText, bashFunctionBodyCallNames(rec.body));
			}
		}
		for (const value of Object.values(rec)) {
			if (Array.isArray(value)) {
				for (const item of value) walk(item);
			} else if (value && typeof value === 'object') {
				walk(value);
			}
		}
	};
	walk(node);
	// Fixpoint closure over the call graph (bounded by the table size).
	let changed = true;
	while (changed) {
		changed = false;
		for (const [name, isDirect] of direct) {
			if (isDirect || into.get(name) === true) continue;
			const callees = calls.get(name) ?? [];
			const transitive = callees.some(
				(callee) => direct.get(callee) === true || into.get(callee) === true,
			);
			if (transitive) {
				into.set(name, true);
				changed = true;
			}
		}
	}
	for (const [name, isDirect] of direct) {
		if (isDirect && into.get(name) !== true) into.set(name, true);
	}
}

/** Command words a function body invokes (for the call-graph closure). */
function bashFunctionBodyCallNames(node: unknown): string[] {
	const names: string[] = [];
	const walk = (n: unknown): void => {
		if (!n || typeof n !== 'object') return;
		const rec = n as Record<string, unknown>;
		if (
			(rec.type === 'SimpleCommand' || rec.type === 'Command') &&
			rec.name !== null &&
			typeof rec.name === 'object'
		) {
			const name = rec.name as Record<string, unknown>;
			if (typeof name.text === 'string' && name.text !== '') {
				names.push(name.text);
			}
		}
		for (const value of Object.values(rec)) {
			if (Array.isArray(value)) {
				for (const item of value) walk(item);
			} else if (value && typeof value === 'object') {
				walk(value);
			}
		}
	};
	walk(node);
	return names;
}

function collectWritesWithNodes(
	node: BashNode,
	out: WriteWithNode[],
	state: DirectoryState,
	andSharedStack = true,
	cdMode: 'gate' | 'gate-skip' | 'succeed' = 'gate',
	functionsTable: Map<string, boolean>,
	/**
	 * #3586 Fix 1: whether the analyzed command contains ANY
	 * dynamic-execution family member (eval/exec/source/./command/builtin/
	 * trap/alias/unalias/shopt/set/history/fc/enable/mapfile/readarray) —
	 * computed by a PRE-PASS over the full AST (see
	 * {@link astHasDynamicExecutionFamily}) so LATER siblings count against
	 * an EARLIER loop's arm-(a) exemption (an `eval`/`trap`/`alias` after
	 * the loop can redefine `continue`/`break` behavior inside it).
	 */
	familyDynamic: boolean,
): void {
	if (!node || typeof node !== 'object') return;

	// #3485 (PRR-004): a $(...) substitution body executes at the CURRENT
	// working directory — descend so writes/evals inside it pair with their
	// true location instead of falling back to the starting cwd. #3491 W1
	// (v4 constraint): the body runs in a SUBSHELL, so it descends on a
	// deep COPY of the state — its directory mutations must not leak to the
	// parent (bash-true), while its writes still resolve at the entry cwd.
	// Handled before the typed switch: bash-parser's node union does not
	// declare this type.
	if ((node as unknown as { type?: unknown }).type === 'CommandExpansion') {
		const inner = (node as unknown as { commandAST?: unknown }).commandAST;
		if (inner)
			collectWritesWithNodes(
				inner as BashNode,
				out,
				cloneDirectoryState(state),
				andSharedStack,
				cdMode,

				functionsTable,
				familyDynamic,
			);
		return;
	}

	switch (node.type) {
		case 'Script': {
			if (Array.isArray(node.commands)) {
				for (const cmd of node.commands) {
					collectWritesWithNodes(
						cmd,
						out,
						state,
						andSharedStack,
						cdMode,
						functionsTable,
						familyDynamic,
					);
				}
			}
			break;
		}

		case 'Subshell': {
			// POSIX subshell: (...) spawns a child shell process. Any cd inside only
			// affects the child's cwd — the parent state is unchanged (#3491 W1:
			// the WHOLE state object is copied, not just the cwd — prevCwd and the
			// pushd stack are child-local too).
			// Collect writes from the subshell's redirections (if redirect is ON the subshell)
			const subshellRedirs = node.redirections;
			if (Array.isArray(subshellRedirs)) {
				for (const redirect of subshellRedirs) {
					const writesFromRedirect = getWritesFromRedirectNode(
						redirect,
						state.cwd,
					);
					for (const w of writesFromRedirect) {
						pushWriteWithState(out, w, state);
					}
				}
			}

			// Recurse into the subshell's list with a COPY of the state so
			// cd mutations inside the subshell do not leak to the parent.
			if (node.list) {
				collectWritesWithNodes(
					node.list,
					out,
					cloneDirectoryState(state),
					andSharedStack,
					cdMode,

					functionsTable,
					familyDynamic,
				);
			}
			break;
		}

		case 'CompoundList': {
			// Process each command in sequence, updating the state as we go.
			if (Array.isArray(node.commands)) {
				for (const cmd of node.commands) {
					// Apply the directory transition ONCE here and do NOT recurse
					// into a cd/pushd/popd command: the Command case applies it
					// again, so recursing double-applies it and resolves later
					// sibling writes against a path the shell never writes
					// (#3099 round-4 Critical 3). cd/pushd/popd themselves
					// produce no writes.
					if (applyDirectoryTransition(state, cmd, cdMode)) continue;
					// Use the current (possibly mutated) state so cd changes propagate
					collectWritesWithNodes(
						cmd,
						out,
						state,
						andSharedStack,
						cdMode,
						functionsTable,
						familyDynamic,
					);
				}
			}
			break;
		}

		case 'Sequence': {
			if (Array.isArray(node.commands)) {
				for (const cmd of node.commands) {
					collectWritesWithNodes(
						cmd,
						out,
						state,
						andSharedStack,
						cdMode,
						functionsTable,
						familyDynamic,
					);
				}
			}
			break;
		}

		case 'Pipeline': {
			// #3491 W1 (v4 constraint 2): pipeline components run as child
			// processes of a noninteractive shell — they descend on ISOLATED
			// state copies, so a component's cd can never mutate the parent
			// state. The parent state is preserved across the pipeline; when
			// any component DID mutate its copy's directory selection, the
			// real shell's post-pipeline cwd is unknowable (each component's
			// cwd change is lost in its child process, but the line also
			// cannot be proven equivalent to no-change) — belt-and-braces:
			// withdraw later writes.
			if (Array.isArray(node.commands)) {
				let componentMutatedDirectory = false;
				for (const cmd of node.commands) {
					const componentState = cloneDirectoryState(state);
					collectWritesWithNodes(
						cmd,
						out,
						componentState,
						andSharedStack,
						cdMode,

						functionsTable,
						familyDynamic,
					);
					if (!directoryStatesEqual(componentState, state)) {
						componentMutatedDirectory = true;
					}
				}
				if (componentMutatedDirectory) {
					state.withdrawn = true;
				}
				// #3474: the stdin-eval write belongs to the pipeline as a
				// whole; emitted after the children so both walkers list the
				// pipe-evals in the same relative order.
				const pipeEval = classifyPipeStdinEval(node);
				if (pipeEval) pushWriteWithState(out, pipeEval, state);
			}
			break;
		}

		case 'LogicalExpression': {
			// LogicalExpression (&& or ||) — same semantics as And/Or.
			// #3491 W1 (v4 constraint 1): each operator carries BOTH outcomes
			// explicitly — left-success/right-executed AND
			// left-failure/right-skip — via the dual walk: the TRACKED pass
			// models the SKIP landing (right branch on gate-skip, cds
			// unapplied), the PESSIMISTIC pass models the EXECUTION landing
			// (right branch on its own state copy with succeed, then adopted).
			// A write after the chain resolves under EVERY candidate post-chain
			// state (the gate requires every emitted entry to pass).
			//
			// #3474: for `&&` the tracked pass joins the SHARED state — a chain's
			// middle `cd` (left-associative: And(a, And(b, c)) walks b on a fresh
			// discarded state) previously never reached c's resolution, so
			// `cd src && cd .. && echo x > escape.txt` resolved the target at src
			// (in scope) and admitted an out-of-scope write. For `||` the right
			// branch may be SKIPPED (left succeeded) while later siblings still
			// run, so the right branch always walks a COPY (a skipped `cd` must
			// never reach later siblings — plan-critic r2 B4).
			const andChain =
				(node as unknown as { op?: string }).op === 'and' &&
				(node as unknown as { type?: string }).type !== 'Or';
			const isOr =
				(node as unknown as { op?: string }).op === 'or' ||
				(node as unknown as { type?: string }).type === 'Or';
			// #3567 review PRR-012: `||` has TWO bash outcomes — left SUCCEEDED
			// (right skipped) and left FAILED (right executes from the PRE-LEFT
			// state, left's directory effects rolled back). Capture the pre-left
			// state before the left walk so the right branch can be modeled on
			// both candidates.
			const preLeft = isOr ? cloneDirectoryState(state) : null;
			if (node.left) {
				collectWritesWithNodes(
					node.left,
					out,
					state,
					andSharedStack,
					cdMode,
					functionsTable,
					familyDynamic,
				);
				// Capture the COMPLETE state AFTER left has been processed (cd may
				// have modified it).
				const leftState = cloneDirectoryState(state);
				// Process right with potentially updated context from left
				if (node.right) {
					const rightCdMode = cdMode === 'succeed' ? 'succeed' : 'gate-skip';
					if (andChain && andSharedStack) {
						collectWritesWithNodes(
							node.right,
							out,
							state,
							andSharedStack,
							rightCdMode,
							functionsTable,
							familyDynamic,
						);
					} else if (isOr) {
						// Two candidates: RIGHT SKIPPED (left succeeded — later
						// siblings keep the post-left state, the #3485 skip
						// contract) and RIGHT EXECUTES from the pre-left state
						// with the current pass's cd mode (left failed — bash
						// only runs the right operand when the left one failed,
						// so left's cds never applied). Agreement over the
						// complete state (incl. withdrawal) adopts the common
						// landing; disagreement withdraws (v4 constraint 3).
						const skipState = cloneDirectoryState(leftState);
						const execState = cloneDirectoryState(preLeft!);
						collectWritesWithNodes(
							node.right,
							out,
							execState,
							andSharedStack,
							cdMode,

							functionsTable,
							familyDynamic,
						);
						if (directoryStatesEqual(skipState, execState)) {
							adoptDirectoryState(state, execState);
						} else {
							state.withdrawn = true;
						}
					} else {
						collectWritesWithNodes(
							node.right,
							out,
							leftState,
							andSharedStack,
							rightCdMode,
							functionsTable,
							familyDynamic,
						);
						// #3530 dual-resolution: adopt the EXECUTION landing (and its
						// withdrawal flag) into the pessimistic walk's state.
						if (cdMode === 'succeed') {
							adoptDirectoryState(state, leftState);
						}
					}
				}
			}
			break;
		}

		case 'And':
		case 'Or': {
			// #3474: And shares the state (see LogicalExpression); Or keeps the
			// fresh state (a skipped || branch's cd must not move later siblings).
			const isOrType = node.type === 'Or';
			const preLeftType = isOrType ? cloneDirectoryState(state) : null;
			if (node.left) {
				collectWritesWithNodes(
					node.left,
					out,
					state,
					andSharedStack,
					cdMode,
					functionsTable,
					familyDynamic,
				);
				const leftState = cloneDirectoryState(state);
				if (node.right) {
					const rightCdMode = cdMode === 'succeed' ? 'succeed' : 'gate-skip';
					if (node.type === 'And' && andSharedStack) {
						collectWritesWithNodes(
							node.right,
							out,
							state,
							andSharedStack,
							rightCdMode,
							functionsTable,
							familyDynamic,
						);
					} else if (isOrType) {
						// #3567 review PRR-012: two bash outcomes for `||` — right
						// SKIPPED (left succeeded, post-left state) and right
						// EXECUTES from the PRE-LEFT state (left failed, its cds
						// rolled back). Agreement adopts the common landing;
						// disagreement withdraws (see the LogicalExpression arm
						// for the full contract).
						const skipState = cloneDirectoryState(leftState);
						const execState = cloneDirectoryState(preLeftType!);
						collectWritesWithNodes(
							node.right,
							out,
							execState,
							andSharedStack,
							cdMode,

							functionsTable,
							familyDynamic,
						);
						if (directoryStatesEqual(skipState, execState)) {
							adoptDirectoryState(state, execState);
						} else {
							state.withdrawn = true;
						}
					} else {
						collectWritesWithNodes(
							node.right,
							out,
							leftState,
							andSharedStack,
							rightCdMode,
							functionsTable,
							familyDynamic,
						);
						if (cdMode === 'succeed') {
							adoptDirectoryState(state, leftState);
						}
					}
				}
			}
			break;
		}

		// Issue #3099 R4: mirror the clause cases added to collectLeafCommands.
		// These bodies run in the CURRENT shell, so their writes share the walk
		// state — only Subshell (and, per #3491 W1, CommandExpansion and
		// pipeline components) isolate. The compound node's own redirections
		// are read explicitly (the leaf walker pushes the node for
		// detectRedirects; this walker's out holds write+context pairs, so it
		// emits them at the same traversal position).
		//
		// #3491 W1 (v3 item 3 + v4 constraint 3): control-flow bodies walk on
		// per-branch COPIES; the post-construct state is the conservative merge
		// — divergence over the COMPLETE state (cwd+prevCwd+dirStack) WITHDRAWS
		// later writes instead of fabricating a merge. If-without-else gains
		// the implicit no-body outcome; Case gains the no-match outcome.
		case 'If': {
			if (Array.isArray(node.redirections)) {
				for (const redirect of node.redirections) {
					for (const w of getWritesFromRedirectNode(redirect, state.cwd)) {
						pushWriteWithState(out, w, state);
					}
				}
			}
			// The clause runs exactly once, in the current shell — its directory
			// effects persist to the branch bodies and past the if.
			if (node.clause) {
				collectWritesWithNodes(
					node.clause,
					out,
					state,
					andSharedStack,
					cdMode,
					functionsTable,
					familyDynamic,
				);
			}
			// then/else each descend on a COPY from the post-clause state.
			const outcomes: DirectoryState[] = [];
			if (node.then) {
				const thenState = cloneDirectoryState(state);
				collectWritesWithNodes(
					node.then,
					out,
					thenState,
					andSharedStack,
					cdMode,

					functionsTable,
					familyDynamic,
				);
				outcomes.push(thenState);
			}
			if (node.else) {
				const elseState = cloneDirectoryState(state);
				collectWritesWithNodes(
					node.else,
					out,
					elseState,
					andSharedStack,
					cdMode,

					functionsTable,
					familyDynamic,
				);
				outcomes.push(elseState);
			}
			// Implicit no-body outcome ONLY when else is absent (#3567 review
			// PRR-011): with an else clause, bash runs exactly one of the two
			// bodies — the unconditional no-body push fabricated a third
			// outcome that made determinate post-if writes (`if true; then cd
			// src; else cd src; fi; echo x > src/f`) diverge and over-deny.
			if (!node.else) {
				outcomes.push(cloneDirectoryState(state));
			}
			if (
				outcomes.every((candidate) => directoryStatesEqual(candidate, state))
			) {
				break;
			}
			if (
				outcomes.every((candidate) =>
					directoryStatesEqual(candidate, outcomes[0]),
				)
			) {
				adoptDirectoryState(state, outcomes[0]);
				break;
			}
			state.withdrawn = true;
			break;
		}

		case 'While':
		case 'Until': {
			if (Array.isArray(node.redirections)) {
				for (const redirect of node.redirections) {
					for (const w of getWritesFromRedirectNode(redirect, state.cwd)) {
						pushWriteWithState(out, w, state);
					}
				}
			}
			// #3586 Fix 1: the loop-level redirects above apply ONCE at loop
			// entry (bash applies the compound command's redirections before
			// the first iteration), but every write collected from HERE on is
			// iteration-carried — the clause re-executes per iteration in the
			// current shell, so its writes are as loop-carried as body writes.
			// Capture the slice start BEFORE the clause walk so a post-walk
			// divergence can retroactively withdraw every write the loop
			// collected (clause AND body): pushWriteWithState only sees the
			// withdrawal flag AT PUSH TIME, and iteration 2+ runs at landing
			// directories the single modeled pass never enumerated.
			const sliceStart = out.length;
			// #3586 Fix 1, review round 4.5 finding 2: the fixpoint compares
			// against the loop's ENTRY state, snapshotted BEFORE the clause
			// walk — the clause re-executes every iteration in the current
			// shell, so a clause-resident cd drifts the per-iteration starting
			// directory in a way a body-vs-post-clause comparison can never
			// see (`cd src/sub; i=0; while cd ..; [ "$i" -lt 2 ]; do
			// i=$((i+1)); echo x > f; done` — the body is idempotent against
			// the POST-clause state, yet real bash writes src/f and then
			// the escaping workspace-root f). One full iteration = clause AND
			// body; the landing must equal the PRE-clause entry for
			// idempotence.
			const entryState = cloneDirectoryState(state);
			// The clause runs (at least once) in the current shell — walk its
			// effects on the parent state so body writes pair with the true
			// first-iteration context.
			if (node.clause) {
				collectWritesWithNodes(
					node.clause,
					out,
					state,
					andSharedStack,
					cdMode,
					functionsTable,
					familyDynamic,
				);
			}
			if (node.do) {
				// One full body iteration on a COPY: the loop's post-state is
				// accepted ONLY on a full-state fixpoint (one full iteration —
				// clause AND body — lands back at the loop's PRE-clause entry
				// state, idempotent across iterations); anything else
				// withdraws (v4 constraint 3).
				const bodyState = cloneDirectoryState(state);
				collectWritesWithNodes(
					node.do,
					out,
					bodyState,
					andSharedStack,
					cdMode,
					functionsTable,
					familyDynamic,
				);
				if (!directoryStatesEqual(bodyState, entryState)) {
					state.withdrawn = true;
					// #3586 Fix 1 (END-STATE after 14 plan-critic rounds): the
					// landing ≠ the entry state, so the single modeled pass did
					// NOT enumerate every directory a later iteration writes
					// from. Withdraw the whole captured slice fail-closed —
					// buildResolution nulls each unresolvedContext write and
					// the gate denies. NO break-based exemption exists: the
					// ambient environment (a BASH_ENV startup file or an
					// exported BASH_FUNC_* definition) can redefine `break`
					// entirely outside the analyzed command text, so no
					// command-text condition on a break node is sound.
					markWritesUnresolvedFrom(out, sliceStart);
				}
			}
			break;
		}

		case 'For': {
			if (Array.isArray(node.redirections)) {
				for (const redirect of node.redirections) {
					for (const w of getWritesFromRedirectNode(redirect, state.cwd)) {
						pushWriteWithState(out, w, state);
					}
				}
			}
			// #3586 Fix 1: same slice capture as While/Until (a For has no
			// clause — the capture starts at the body walk).
			const sliceStart = out.length;
			if (node.do) {
				// Same fixpoint contract as While/Until (v4 constraint 3).
				const bodyState = cloneDirectoryState(state);
				collectWritesWithNodes(
					node.do,
					out,
					bodyState,
					andSharedStack,
					cdMode,
					functionsTable,
					familyDynamic,
				);
				if (!directoryStatesEqual(bodyState, state)) {
					state.withdrawn = true;
					// #3586 Fix 1 arm (a) — the SINGLE exemption: a For whose
					// word list is ONE fully-literal word immune to every
					// word-producing expansion, in a command with no
					// dynamic-execution family member anywhere, expands to
					// exactly ONE item — exactly one iteration runs and the
					// single modeled pass enumerated every write the loop
					// performs (ambient BASH_ENV/BASH_FUNC_* redefinition can
					// change break/continue BEHAVIOR but cannot APPEND items
					// to a literal one-word list — r12 execution).
					if (!forWordListIsSingleLiteralWord(node) || familyDynamic) {
						markWritesUnresolvedFrom(out, sliceStart);
					}
				}
			}
			break;
		}

		case 'Case': {
			if (Array.isArray(node.redirections)) {
				for (const redirect of node.redirections) {
					for (const w of getWritesFromRedirectNode(redirect, state.cwd)) {
						pushWriteWithState(out, w, state);
					}
				}
			}
			// Each branch descends on a copy of the clause-entry state; the
			// no-match outcome keeps the entry state. `;&`/`;;&` fall-through
			// never reaches this walker — bash-parser fails to parse those
			// forms, so the parse-failure fallback (fail-closed) governs them.
			const outcomes: DirectoryState[] = [cloneDirectoryState(state)];
			if (Array.isArray(node.cases)) {
				for (const entry of node.cases) {
					if (entry?.body) {
						const bodyState = cloneDirectoryState(state);
						collectWritesWithNodes(
							entry.body,
							out,
							bodyState,
							andSharedStack,
							cdMode,

							functionsTable,
							familyDynamic,
						);
						outcomes.push(bodyState);
					}
				}
			}
			if (
				outcomes.every((candidate) => directoryStatesEqual(candidate, state))
			) {
				break;
			}
			if (
				outcomes.every((candidate) =>
					directoryStatesEqual(candidate, outcomes[0]),
				)
			) {
				adoptDirectoryState(state, outcomes[0]);
				break;
			}
			state.withdrawn = true;
			break;
		}

		case 'Function': {
			if (Array.isArray(node.redirections)) {
				for (const redirect of node.redirections) {
					for (const w of getWritesFromRedirectNode(redirect, state.cwd)) {
						pushWriteWithState(out, w, state);
					}
				}
			}
			if (node.body) {
				// A function DEFINITION does not execute the body — walk it on a
				// DISCARDED copy so its writes stay visible while none of its
				// directory effects (or withdrawals) propagate (v3 item 3).
				// #3567 review PRR-002: the discarded copy previously ZEROED the
				// inherited withdrawal — a dynamic `cd $V` before the definition
				// let the body's writes collect as RESOLVED at the definition-
				// time cwd, while bash runs the body at CALL time (cd $V unset ⇒
				// bare-cd HOME), outside every modeled landing. The copy now
				// inherits the flag, so body writes carry unresolvedContext.
				const bodyState = cloneDirectoryState(state);
				collectWritesWithNodes(
					node.body,
					out,
					bodyState,
					andSharedStack,
					cdMode,
					functionsTable,
					familyDynamic,
				);
			}
			break;
		}

		case 'Command':
		case 'SimpleCommand': {
			// #3567 review P-F5: a CALL to a function whose body contains a
			// directory transition executes that body in the CURRENT shell at
			// call time — the call-time landing is unknowable at the walk, so
			// the call withdraws (fail-closed). Own redirects still collect at
			// the current state (bash truth).
			const fnNameNode = (node as unknown as { name?: unknown }).name as
				| Record<string, unknown>
				| string
				| undefined;
			const fnNameText =
				typeof fnNameNode === 'string'
					? fnNameNode
					: typeof fnNameNode?.text === 'string'
						? fnNameNode.text
						: undefined;
			if (fnNameText !== undefined && functionsTable.get(fnNameText) === true) {
				state.withdrawn = true;
			}

			// Directory-selection commands (cd/pushd/popd, all word forms):
			// apply the transition and stop — they produce no writes. #3530:
			// the tracked walk ('gate') treats an unprovable cd as failed; the
			// pessimistic walk ('succeed') tracks the bash-true success landing;
			// #3491 W1: the unresolvable word forms WITHDRAW instead of
			// guessing. Both landings reach the gate through the existing
			// tracked/pessimistic divergence, and the gate requires EVERY entry
			// to pass.
			if (applyDirectoryTransition(state, node, cdMode)) {
				return;
			}

			// Collect writes from this command's redirections
			const writesFromRedirs = getWritesFromCommandRedirs(node, state.cwd);
			for (const w of writesFromRedirs) {
				pushWriteWithState(out, w, state);
			}

			// Collect writes from builtin commands, inplace editors, etc.
			const builtinWrites = detectBuiltinWrites(node);
			for (const w of builtinWrites) {
				pushWriteWithState(out, w, state);
			}

			const inplaceWrites = detectInplaceEdit(node);
			for (const w of inplaceWrites) {
				pushWriteWithState(out, w, state);
			}

			const interpreterWrites = detectInterpreterEval(node);
			for (const w of interpreterWrites) {
				pushWriteWithState(out, w, state);
			}

			// #3491 W3: launcher-owned write targets (sudo -e operands, GNU
			// time -o FILE) resolve at their per-occurrence tracked cwd too.
			const launcherWrites = detectLauncherWrites(node);
			for (const w of launcherWrites) {
				pushWriteWithState(out, w, state);
			}

			const networkWrites = detectNetworkDownloaders(node);
			for (const w of networkWrites) {
				pushWriteWithState(out, w, state);
			}

			const archiveWrites = detectArchiveExtract(node);
			for (const w of archiveWrites) {
				pushWriteWithState(out, w, state);
			}

			const gitWrites = detectGitDestructive(node);
			for (const w of gitWrites) {
				pushWriteWithState(out, w, state);
			}

			// #3120: the patch/rsync vectors register on the resolution walk
			// too, so a `cd` before them resolves at the tracked directory.
			const patchWrites = detectPatchApply(node);
			for (const w of patchWrites) {
				pushWriteWithState(out, w, state);
			}

			const rsyncWrites = detectRsyncWrites(node);
			for (const w of rsyncWrites) {
				pushWriteWithState(out, w, state);
			}

			break;
		}
	}
}

/**
 * #3586 Fix 1: retroactively mark every write collected from `start` onward
 * as `unresolvedContext` — the fail-closed sink for a loop whose one-pass
 * landing diverged from its entry state (pushWriteWithState can only see the
 * withdrawal flag at PUSH time; this closes the already-pushed slice the
 * post-walk divergence retroactively invalidates). Idempotent per write.
 */
function markWritesUnresolvedFrom(out: WriteWithNode[], start: number): void {
	for (let i = start; i < out.length; i += 1) {
		const entry = out[i];
		if (entry === undefined) continue;
		if (entry.write.unresolvedContext !== true) {
			entry.write = { ...entry.write, unresolvedContext: true };
		}
	}
}

/**
 * #3586 Fix 1 arm (a): whether a For node's word list is a SINGLE word that
 * is fully literal AND immune to every word-producing expansion — no
 * unquoted glob characters (`*?[`), no tilde, no parameter/command/
 * arithmetic expansion (the parser records those in expansion[]), no
 * unquoted brace expansion, and no `!` character (history expansion can
 * replace one literal word with several at runtime). Such a list expands to
 * exactly one item, so the loop runs exactly one iteration. Fails closed on
 * every doubt (multi-word lists, missing raw source text, empty words).
 */
function forWordListIsSingleLiteralWord(node: unknown): boolean {
	const wordlist = (node as { wordlist?: unknown }).wordlist;
	if (!Array.isArray(wordlist) || wordlist.length !== 1) return false;
	const word = wordlist[0];
	if (!word || typeof word !== 'object') return false;
	// The parser records every parameter/command/arithmetic expansion on the
	// word node — any entry can change the word's runtime value.
	const expansion = (word as { expansion?: unknown }).expansion;
	if (Array.isArray(expansion) && expansion.length > 0) return false;
	const text = (word as { text?: unknown }).text;
	if (typeof text !== 'string' || text === '') return false;
	// PR #3615 feedback PRR-004: hasUnquotedBraceExpansion runs a quadratic
	// regex over the raw word text, and a for-list word is attacker-controlled
	// command text on the per-call hot path — cap the length and treat an
	// oversized word as expansion-bearing (denies the exemption, fail closed)
	// instead of feeding it to the quadratic scan.
	if (text.length > 4096) return false;
	// `!` anywhere (history expansion multiplies words when histexpand is on)
	// and `~` anywhere (tilde expansion) both disqualify — conservative on
	// the exemption, which is the deny direction.
	if (text.includes('!') || text.includes('~')) return false;
	// Unquoted glob characters and unquoted brace expansion both produce
	// multiple items from one AST word; both helpers fail-safe (treat the
	// word as expansion-bearing) when the raw source projection is missing.
	if (hasUnquotedGlob(word)) return false;
	if (hasUnquotedBraceExpansion(word, text)) return false;
	return true;
}

/**
 * #3586 Fix 1: the dynamic-execution family (plan-critic r5 set) — commands
 * that can change how OTHER words in the same command string execute at
 * runtime (redefining break/continue behavior, installing traps, expanding
 * aliases, manufacturing words). Any member ANYWHERE in the analyzed command
 * (including siblings visited AFTER a given loop — hence the pre-pass)
 * disqualifies every For-loop arm-(a) exemption in that command.
 */
const DYNAMIC_EXECUTION_FAMILY = new Set([
	'eval',
	'exec',
	'source',
	'.',
	'command',
	'builtin',
	'trap',
	'alias',
	'unalias',
	'shopt',
	'set',
	'history',
	'fc',
	'enable',
	'mapfile',
	'readarray',
]);

/**
 * #3586 Fix 1 PRE-PASS: walk the whole AST and report whether ANY Command
 * node's canonicalized name (quote-removed word text, basename-normalized so
 * path-qualified spellings like `/usr/bin/eval` count) is a
 * dynamic-execution family member. Pure function of the AST — computed once
 * per walk root and threaded through {@link collectWritesWithNodes}.
 */
function astHasDynamicExecutionFamily(root: unknown): boolean {
	if (!root || typeof root !== 'object') return false;
	const stack: unknown[] = [root];
	while (stack.length > 0) {
		const n = stack.pop();
		if (!n || typeof n !== 'object') continue;
		if ((n as { type?: unknown }).type === 'Command') {
			const nameNode = (n as { name?: unknown }).name;
			const nameText =
				nameNode && typeof nameNode === 'object'
					? (nameNode as { text?: unknown }).text
					: undefined;
			if (typeof nameText === 'string' && nameText !== '') {
				const canonical = basenameAnySep(nameText);
				if (DYNAMIC_EXECUTION_FAMILY.has(canonical)) return true;
			}
		}
		for (const value of Object.values(n)) {
			if (Array.isArray(value)) {
				for (const item of value) stack.push(item);
			} else if (value && typeof value === 'object') {
				stack.push(value);
			}
		}
	}
	return false;
}

/**
 * Push one collected write with its walk state's context (#3491 W1): once the
 * state has withdrawn (an unresolvable directory transition upstream), every
 * later write the walk collects is marked `unresolvedContext` — the resolver
 * nulls it and the gate denies (fail-closed).
 */
function pushWriteWithState(
	out: WriteWithNode[],
	write: WriteTarget,
	state: DirectoryState,
): void {
	out.push({
		write:
			state.withdrawn && write.unresolvedContext !== true
				? { ...write, unresolvedContext: true }
				: write,
		context: state.cwd,
	});
}

/**
 * Extract write targets from a redirect node, resolving against the given context.
 */
function getWritesFromRedirectNode(
	redirect: unknown,
	_context: string,
): WriteTarget[] {
	if (!redirect || typeof redirect !== 'object') return [];
	const r = redirect as BashRedirect;
	const opNode = r.op;
	if (!opNode || typeof opNode !== 'object') return [];

	const opType = opNode.type?.toUpperCase();
	if (!opType || !REDIRECT_ALL_WRITE_TOKENS.has(opType)) return [];

	const fileNode = r.file;
	const path = extractRedirectPath(fileNode);
	const opLabel = operatorLabel(opNode);

	if (
		REDIRECT_WRITE_TOKENS.has(opType) ||
		(REDIRECT_GREATAND_TOKENS.has(opType) && !isNonFileGreatAndTarget(path))
	) {
		// detectPosixWrites never reports a sink-device redirect, but the
		// Windows detectors do (`2>/dev/null` from detectWindowsWrites) and
		// their callers resolve those writes here too. Collecting one would
		// resolve it against the POSIX cd tracker's context, which for a
		// Windows cwd is a mangled path that can sit on another drive; left
		// out, it falls back to the caller's cwd like any unmatched write.
		// #3491 W8: brace-aware emission identical to the detection walk's
		// (redirectWriteTargets — which also drops sink-device branches) so
		// the branch sets pair across the walks.
		return redirectWriteTargets(fileNode, path, opLabel);
	} else if (REDIRECT_HERE_TOKENS.has(opType)) {
		return [{ category: 'here_doc', operator: opLabel, path }];
	}
	return [];
}

/**
 * Extract write targets from a command node's redirections (suffix/prefix arrays).
 */
function getWritesFromCommandRedirs(
	cmd: unknown,
	context: string,
): WriteTarget[] {
	if (!cmd || typeof cmd !== 'object') return [];
	const c = cmd as BashCommand;
	const results: WriteTarget[] = [];

	// Also detect here-doc markers first
	results.push(...detectHereDocMarkers(cmd));

	const suffix = c.suffix;
	const prefix = c.prefix;

	if (Array.isArray(suffix)) {
		for (const item of suffix) {
			if (isRedirectNode(item)) {
				const writes = getWritesFromRedirectNode(item, context);
				results.push(...writes);
			}
		}
	}
	if (Array.isArray(prefix)) {
		for (const item of prefix) {
			if (isRedirectNode(item)) {
				const writes = getWritesFromRedirectNode(item, context);
				results.push(...writes);
			}
		}
	}

	return results;
}

/**
 * Resolve write targets from a POSIX shell command against a given cwd,
 * tracking directory changes through subshell `cd` commands.
 *
 * This function is pure: it does not modify any external state.
 *
 * @param command - A POSIX shell command string (e.g., "(cd /tmp && echo x > file)")
 * @param cwd - The starting current working directory (e.g., "/home/user")
 * @returns Array of ResolvedWriteTarget with resolved absolute paths
 */
// #3120 LEG 3b: extract the write targets a patch text names — BOTH diff
// endpoints of every file header (`--- a/x` preimage and `+++ b/x`
// postimage; a rename/delete mutates the preimage even when only the
// postimage appears — plan-critic round-1 executed proof), `/dev/null`
// excluded, with the invocation's `-p<n>` strip level applied to each
// endpoint. Returns undefined when the text is not decodable as a unified
// diff (no headers at all): resolution then fails closed instead of
// guessing.
// Unquote a git C-style quoted path ("caf\303\251.txt"): handles the
// escapes git itself emits (\\, \", and \ooo octal) plus the common
// whitespace forms; ANY other escape fails closed (undefined) rather than
// guessing. Returns undefined for non-quoted input shapes it cannot verify.
function unquoteGitPath(quoted: string): string | undefined {
	if (quoted.length < 2 || !quoted.startsWith('"') || !quoted.endsWith('"')) {
		return undefined;
	}
	const inner = quoted.slice(1, -1);
	// #3396 feedback (reviewer F7): git quotes emit octal escapes per BYTE of
	// the path's UTF-8 encoding, so escapes accumulate into a byte buffer that
	// is decoded once as UTF-8 — a Latin-1 per-escape decode turns `\303\251`
	// (é) into mojibake and misses the file being written. Undecodable
	// sequences fail closed (undefined).
	const bytes: number[] = [];
	for (let i = 0; i < inner.length; i += 1) {
		const ch = inner[i];
		if (ch !== '\\') {
			for (const b of Buffer.from(ch, 'utf8')) bytes.push(b);
			continue;
		}
		const next = inner[i + 1];
		if (next === '\\' || next === '"') {
			for (const b of Buffer.from(next, 'utf8')) bytes.push(b);
			i += 1;
			continue;
		}
		const octal = /^([0-7]{1,3})/.exec(inner.slice(i + 1));
		if (octal) {
			const value = Number.parseInt(octal[1], 8);
			if (value > 0xff) return undefined;
			bytes.push(value);
			i += octal[1].length;
			continue;
		}
		if (next === 't' || next === 'n' || next === 'r') {
			bytes.push(next === 't' ? 0x09 : next === 'n' ? 0x0a : 0x0d);
			i += 1;
			continue;
		}
		return undefined;
	}
	const decoded = Buffer.from(bytes).toString('utf8');
	if (decoded.includes('\uFFFD')) return undefined;
	return decoded;
}

// Strip the -p<n> prefix from one diff endpoint. Over-deep strip (level >=
// component count) fails closed: git apply would error or write nothing, so
// there is no real target to authorize.
function stripPatchEndpoint(raw: string, strip: number): string | undefined {
	if (raw === '/dev/null') return undefined;
	const components = raw.split('/');
	const level = Math.max(0, strip);
	if (components.length <= level) return undefined;
	const stripped = components.slice(level).join('/');
	return stripped && stripped !== '.' ? stripped : undefined;
}

function extractPatchTargets(
	patchText: string,
	strip: number,
): string[] | undefined {
	const targets = new Set<string>();
	let sawHeader = false;
	const addEndpoint = (raw: string): boolean => {
		const stripped = stripPatchEndpoint(raw, strip);
		// undefined: /dev/null (no target) OR over-deep strip (fail closed).
		if (stripped === undefined) return raw !== '/dev/null';
		if (stripped) targets.add(stripped);
		return false;
	};
	for (const rawLine of patchText.split(/\r\n|\n/)) {
		// #3120 4.5 rounds: git rename/copy sections carry their paths on
		// `diff --git a/X b/Y` and `rename from/to` lines with NO ---/+++
		// headers, so a mixed patch's rename destination must be judged too
		// (executed bypass: rename into .secretscanignore created the file
		// unjudged). Header paths are tab-terminated when git appends a
		// timestamp, so capture the tab-free run, not \S+ (space paths).
		if (rawLine.startsWith('diff --git ')) {
			sawHeader = true;
			// #3396 feedback (reviewer F7, rounds 2-3): git quotes EACH name
			// independently. Under the default core.quotePath=true a rename
			// crossing the ASCII↔non-ASCII boundary emits a MIXED header
			// (`diff --git "a/caf\303\251.txt" b/plain.txt` — round-3 R3-1,
			// executed real-git probe), and space paths stay unquoted
			// entirely (`diff --git a/new file.txt b/new file.txt` — round-2
			// R2-1). All four quoting combinations parse: split on the
			// ` b/` boundary (git's parse order; lazy a-side, greedy
			// b-side) and unquote each side only when quoted; undecodable
			// quoted forms fail closed.
			const bothQuoted =
				/^diff --git ("(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*")$/.exec(rawLine);
			const aQuoted = /^diff --git ("(?:[^"\\]|\\.)*") (b\/.*)$/.exec(rawLine);
			const bQuoted = /^diff --git (a\/.+?) ("(?:[^"\\]|\\.)*")$/.exec(rawLine);
			const plain = /^diff --git a\/(.+?) b\/(.+)$/.exec(rawLine);
			let aEndpoint: string | undefined;
			let bEndpoint: string | undefined;
			if (bothQuoted) {
				aEndpoint = unquoteGitPath(bothQuoted[1]);
				bEndpoint = unquoteGitPath(bothQuoted[2]);
			} else if (aQuoted) {
				aEndpoint = unquoteGitPath(aQuoted[1]);
				bEndpoint = aQuoted[2];
			} else if (bQuoted) {
				aEndpoint = bQuoted[1];
				bEndpoint = unquoteGitPath(bQuoted[2]);
			} else {
				aEndpoint = plain ? `a/${plain[1]}` : undefined;
				bEndpoint = plain ? `b/${plain[2]}` : undefined;
			}
			if (aEndpoint === undefined || bEndpoint === undefined) return undefined;
			if (addEndpoint(aEndpoint)) return undefined;
			if (addEndpoint(bEndpoint)) return undefined;
			continue;
		}
		if (
			rawLine.startsWith('rename from ') ||
			rawLine.startsWith('rename to ')
		) {
			sawHeader = true;
			const word =
				/^(?:rename (?:from|to)) (?:("(?:[^"\\]|\\.)+")|([^\t].*?))(?:\t.*)?$/.exec(
					rawLine,
				);
			if (!word) return undefined;
			const raw = word[1] ? unquoteGitPath(word[1]) : (word[2] as string);
			if (raw === undefined) return undefined;
			// rename lines are repo-root-relative already; never re-strip.
			if (raw && raw !== '.') targets.add(raw);
			continue;
		}
		const pre = /^--- (?:("(?:[^"\\]|\\.)+")|([^\t].*?))(?:\t.*)?$/.exec(
			rawLine,
		);
		const post = /^\+\+\+ (?:("(?:[^"\\]|\\.)+")|([^\t].*?))(?:\t.*)?$/.exec(
			rawLine,
		);
		const match = pre ?? post;
		if (!match) continue;
		sawHeader = true;
		const raw = match[1] ? unquoteGitPath(match[1]) : (match[2] as string);
		if (raw === undefined) return undefined;
		if (addEndpoint(raw)) return undefined;
	}
	return sawHeader ? [...targets] : undefined;
}

// #3120: expand a patch_apply write into one resolved write per target named
// inside its patch files, read (bounded, 512KB — the readBoundedText posture)
// at the write's tracked working directory. Empty sources (stdin patch /
// unsupported option — the detector's closed set) and unreadable or
// undecodable patches yield a single null-path entry so the live gate fails
// closed; they are never silently allowed.
function expandPatchApplyWrite(
	original: WriteTarget,
	context: string,
	rootDir: string,
): ResolvedWriteTarget[] {
	const unresolvable: ResolvedWriteTarget = {
		original,
		resolvedPath: null,
		resolved: false,
	};
	const sources = original.patchSources ?? [];
	if (sources.length === 0) return [unresolvable];
	const strip = original.patchStrip ?? 1;
	const entries: ResolvedWriteTarget[] = [];
	const seen = new Set<string>();
	for (const source of sources) {
		const patchPath = path.resolve(context, source);
		let text: string | undefined;
		try {
			const st = statSync(patchPath);
			if (st.isFile() && st.size <= 512 * 1024) {
				text = readFileSync(patchPath, 'utf8');
			}
		} catch {
			text = undefined;
		}
		const extracted = text ? extractPatchTargets(text, strip) : undefined;
		if (extracted === undefined) return [unresolvable];
		for (const target of extracted) {
			// #3120 4.5 review round: `git apply` resolves patch-internal
			// paths work-tree-ROOT-relative (silently ignoring paths that do
			// not carry the cwd prefix) while GNU `patch` is cwd-relative.
			// Judge BOTH landings — dual emission is the same fail-safe
			// direction the pessimistic map uses for cd-ambiguous writes.
			for (const landing of new Set([context, rootDir])) {
				const resolvedPath = resolvePath(target, landing);
				if (resolvedPath === null || seen.has(resolvedPath)) continue;
				seen.add(resolvedPath);
				entries.push({ original, resolvedPath, resolved: true });
			}
		}
	}
	return entries.length > 0 ? entries : [unresolvable];
}

export function resolveWriteTargets(
	command: string,
	writes: WriteTarget[],
	cwd: string,
): ResolvedWriteTarget[] {
	if (!writes || writes.length === 0) return [];
	if (!command || typeof command !== 'string') {
		// Fall back to resolving against provided cwd without subshell tracking
		return writes.map((original) => ({
			original,
			resolvedPath: resolvePath(original.path, cwd),
			resolved: original.path !== null && !isDynamicPath(original.path),
			...(original.capability === true &&
			original.category === 'interpreter_eval'
				? { evalDirectory: cwd }
				: {}),
		}));
	}

	let ast: unknown;
	try {
		ast = parse(command, { mode: 'posix', insertLOC: true });
		annotateRawWordText(ast, command);
	} catch {
		ast = null;
	}
	if (!ast || typeof ast !== 'object') {
		return writes.map((original) => ({
			original,
			// #3518 P-1/P-3: a withdrawn (unresolvedContext) write resolves to
			// a null path on EVERY return path — the live gate rejects on
			// resolvedPath === null (fail-closed), never on a fragment or the
			// starting cwd.
			resolvedPath:
				original.unresolvedContext === true
					? null
					: resolvePath(original.path, cwd),
			resolved:
				original.unresolvedContext !== true &&
				original.path !== null &&
				!isDynamicPath(original.path),
			...(original.capability === true &&
			original.category === 'interpreter_eval'
				? { evalDirectory: cwd }
				: {}),
		}));
	}

	// Walk the AST and collect writes WITH their context nodes, in order —
	// twice (PRR-001/#3485): the TRACKED pass shares the directory state
	// through && right branches (a succeeding chain's cd moves later
	// siblings), and the PESSIMISTIC pass walks with base semantics (fresh
	// state per && right branch) because a left operand that FAILS at runtime
	// skips the right branch entirely, so its cd never executes. A write whose
	// two resolutions diverge is emitted once per resolution; the gate requires
	// EVERY entry to pass, so a shape that could land at either location is
	// admitted only when both landings are authorized.
	// #3491 W1: both walks thread the sole DirectoryState model (cwd, prevCwd,
	// pushd stack, withdrawal flag). The HOME/OLDPWD reassignment facts are
	// text-level per-line checks — inherited $HOME/$OLDPWD truth is
	// unavailable statically, so a line that reassigns either withdraws the
	// word forms that depend on it (bare cd / cd ~ / cd -).
	const homeReassigned = /(^|[\s;(&|])HOME=/.test(command);
	const oldpwdReassigned = /(^|[\s;(&|])OLDPWD=/.test(command);
	// #3567 review P-F5: pre-build the function-transition table for this
	// command so function CALLS withdraw when their body moves directories.
	const functionsTable = new Map<string, boolean>();
	collectFunctionTransitions(ast, functionsTable);
	// #3586 Fix 1: the dynamic-execution family PRE-PASS — one whole-AST scan
	// before either walk, so later siblings count against an earlier loop's
	// arm-(a) exemption (both walks consume the same flag).
	const familyDynamic = astHasDynamicExecutionFamily(ast);
	const trackedNodes: WriteWithNode[] = [];
	collectWritesWithNodes(
		ast as BashNode,
		trackedNodes,
		{
			cwd,
			prevCwd: null,
			dirStack: [],
			withdrawn: false,
			homeReassigned,
			oldpwdReassigned,
		},
		true,
		'gate',
		functionsTable,
		familyDynamic,
	);
	// A fresh state: the tracked walk MUTATES the state it is given, so the
	// pessimistic pass must not inherit it.
	const pessimisticNodes: WriteWithNode[] = [];
	collectWritesWithNodes(
		ast as BashNode,
		pessimisticNodes,
		{
			cwd,
			prevCwd: null,
			dirStack: [],
			withdrawn: false,
			homeReassigned,
			oldpwdReassigned,
		},
		false,
		'succeed',
		functionsTable,
		familyDynamic,
	);

	// Deduplicate walks the same way detectPosixWrites does — including the
	// occurrence rename (#3347 for capability evals, widened to EVERY
	// duplicate by #3518 P-4: the nth occurrence here carries the same
	// suffixed operator as the nth occurrence there, so the map pairs each
	// occurrence with ITS OWN tracked context — a same-literal write after a
	// `cd` is judged at the directory it actually runs in) AND the
	// emptyDirectoryRemoval collision demotion (PR #3456 review F-2: a key
	// seen more than once — here or in the caller's `writes` — may name
	// writes run under different working directories, so any write with a
	// colliding base key is demoted by the return mapping below).
	const buildResolution = (nodes: WriteWithNode[]) => {
		const seen = new Set<string>();
		const occurrence = new Map<string, number>();
		const colliding = new Set<string>();
		const deduplicated: WriteWithNode[] = [];
		for (const wwn of nodes) {
			const key = buildDedupeKey(
				wwn.write.category,
				wwn.write.operator,
				wwn.write.path,
			);
			if (seen.has(key)) {
				colliding.add(key);
				const n = (occurrence.get(key) ?? 1) + 1;
				occurrence.set(key, n);
				deduplicated.push({
					write: { ...wwn.write, operator: `${wwn.write.operator} #${n}` },
					context: wwn.context,
				});
				continue;
			}
			seen.add(key);
			deduplicated.push(wwn);
		}
		const map = new Map<
			string,
			{
				resolvedPath: string | null;
				resolved: boolean;
				evalDirectory?: string;
				writeContext?: string;
				unresolved?: true;
			}
		>();
		for (const { write, context } of deduplicated) {
			// #3491 W1: a withdrawn (unresolvedContext) write nulls out on
			// EVERY return path — the live gate rejects on resolvedPath ===
			// null (fail-closed), never on a fragment or the starting cwd.
			const unresolved = write.unresolvedContext === true;
			const resolvedPath = unresolved ? null : resolvePath(write.path, context);
			const resolved =
				!unresolved && write.path !== null && !isDynamicPath(write.path);
			const key = buildDedupeKey(write.category, write.operator, write.path);
			// A capability eval has no static target; the working directory it
			// runs at (tracked through any `cd`) IS what the gate authorizes
			// against (#1902/#3347). An UNRESOLVED capability eval carries no
			// evalDirectory at all — the gate must deny it BEFORE any
			// `evalDirectory ?? shellDirectory` fallback (#3491 W1 wiring).
			const evalDirectory =
				write.capability === true &&
				write.category === 'interpreter_eval' &&
				!unresolved
					? context
					: undefined;
			// #3120: a patch_apply write's literal patch-file operands resolve
			// at the tracked working directory; the gate reads the patches
			// there to extract the real targets.
			const writeContext =
				write.category === 'patch_apply' ? context : undefined;
			map.set(key, {
				resolvedPath,
				resolved,
				evalDirectory,
				writeContext,
				...(unresolved ? { unresolved: true } : {}),
			});
		}
		return { map, colliding };
	};

	const { map: resolvedMap, colliding: collidingKeys } =
		buildResolution(trackedNodes);
	const { map: pessimisticMap } = buildResolution(pessimisticNodes);
	const inputKeys = new Set<string>();
	for (const write of writes) {
		const key = buildDedupeKey(write.category, write.operator, write.path);
		if (inputKeys.has(key)) collidingKeys.add(key);
		inputKeys.add(key);
	}

	// Map the input writes to their resolved paths. A write whose pessimistic
	// resolution diverges from the tracked one emits an ADDITIONAL entry so
	// the gate enforces both possible landings (PRR-001: `false && cd src; …`
	// must also be judged at the workspace root, where real bash lands it).
	return writes.flatMap((input) => {
		const key = buildDedupeKey(input.category, input.operator, input.path);
		const original = collidingKeys.has(key)
			? withoutEmptyDirectoryRemoval(input)
			: input;
		// #3120: a patch_apply write's real targets live inside its patch
		// files — expand them here (one resolved write per target) so the
		// gate's authority loop judges every named path; unresolvable patches
		// collapse to the null-path entry the gate blocks on.
		if (original.category === 'patch_apply') {
			const trackedContext = resolvedMap.get(key)?.writeContext;
			return expandPatchApplyWrite(
				original,
				trackedContext ?? resolvedMap.get(key)?.evalDirectory ?? cwd,
				cwd,
			);
		}
		const buildEntry = (resolved: {
			resolvedPath: string | null;
			resolved: boolean;
			evalDirectory?: string;
			writeContext?: string;
			unresolved?: true;
		}): ResolvedWriteTarget => ({
			original,
			resolvedPath: resolved.resolvedPath,
			resolved: resolved.resolved,
			...(resolved.evalDirectory !== undefined
				? { evalDirectory: resolved.evalDirectory }
				: {}),
			...(resolved.writeContext !== undefined
				? { writeContext: resolved.writeContext }
				: {}),
			...(resolved.unresolved === true ? { unresolved: true } : {}),
		});
		const entries: ResolvedWriteTarget[] = [];
		const tracked = resolvedMap.get(key);
		if (tracked) {
			entries.push(buildEntry(tracked));
			const pessimistic = pessimisticMap.get(key);
			if (
				pessimistic &&
				(pessimistic.resolvedPath !== tracked.resolvedPath ||
					pessimistic.evalDirectory !== tracked.evalDirectory)
			) {
				entries.push(buildEntry(pessimistic));
			}
			return entries;
		}
		// Fallback: couldn't find this write in the detected set — the eval
		// working directory degrades to the starting cwd. A withdrawn
		// (#3518 unresolvedContext) write nulls out here too, exactly like
		// the parse-failure branch above.
		return [
			{
				original,
				resolvedPath:
					original.unresolvedContext === true
						? null
						: resolvePath(original.path, cwd),
				resolved:
					original.unresolvedContext !== true &&
					original.path !== null &&
					!isDynamicPath(original.path),
				...(original.capability === true &&
				original.category === 'interpreter_eval'
					? { evalDirectory: cwd }
					: {}),
			},
		];
	});
}
