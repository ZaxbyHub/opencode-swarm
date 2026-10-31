/**
 * Destructive Command Protection Subsystem
 *
 * Cross-platform helpers for detecting and blocking destructive shell commands.
 * Extracted from guardrails.ts (FR-002) — pure mechanical extraction, zero
 * behavior change.
 *
 * Provides:
 *   - Command normalization (homoglyph collapsing, escape decoding)
 *   - Shell wrapper unwrapping (cmd /c, powershell -Command, bash -c, sudo, etc.)
 *   - Compound command segmentation (splitting on ;, &&, ||, |)
 *   - Target validation (vars, remote paths, filesystem roots, lstat ancestor walk)
 *   - Junction/symlink creation detection
 *   - Target extraction for Windows cmd.exe and PowerShell destructive commands
 */

import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { CMD_STRIP_PREFIX, PS_STRIP_PREFIX } from '../shell-executor-context';
import { BASH_BUILTIN_COMMANDS } from '../shell-write-detect';
import { dcIsSwitchClusterText } from './cmd-delete-grammar';

// ============================================================================
// Destructive-command constants
// ============================================================================

/** Maximum recursion depth for wrapper unwrapping */
const DC_MAX_UNWRAP_DEPTH = 5;

/**
 * Expanded safe-target allowlist for recursive delete operations.
 * These directory names are safe to delete recursively by name alone.
 * NOTE: Subdirectory paths like node_modules/.cache are NOT safe — the
 * check requires the target be exactly one of these bare names.
 */
export const DC_SAFE_TARGETS = new Set([
	'node_modules',
	'dist',
	'build',
	'coverage',
	'.next',
	'.turbo',
	'.cache',
	'.venv',
	'venv',
	'__pycache__',
	'target',
	'out',
	'.parcel-cache',
	'.svelte-kit',
	'.nuxt',
	'.output',
	'.angular',
	'.gradle',
	'vendor',
]);

/**
 * Path prefixes that are unconditionally blocked as destructive targets.
 * These represent filesystem roots and critical system directories.
 */
const DC_BLOCKED_ABSOLUTE_PREFIXES: readonly string[] = [
	// POSIX roots
	'/root',
	'/home',
	'/Users',
	'/etc',
	'/var',
	'/usr',
	'/opt',
	'/bin',
	'/sbin',
	'/lib',
	'/boot',
	'/proc',
	'/sys',
	'/dev',
	'/run',
	'/System',
	'/Library',
	'/Applications',
	// Windows roots (drive letters)
	'C:\\Windows',
	'C:\\Users',
	'C:\\Program Files',
	'C:\\ProgramData',
	'C:/Windows',
	'C:/Users',
	'C:/Program Files',
	'C:/ProgramData',
];

/** Filesystem roots that are always blocked outright */
const DC_FS_ROOTS = new Set(['/', 'C:\\', 'C:/', 'D:\\', 'D:/', 'E:\\', 'E:/']);

/** Path prefixes indicating a remote or network filesystem (best-effort) */
const DC_REMOTE_PREFIXES: readonly string[] = [
	'\\\\', // UNC paths e.g. \\server\share
	'/Volumes/', // macOS external/network volumes
	'/net/', // autofs network paths
	'/nfs/', // explicit NFS mounts
	'/smb/', // Samba mounts
	'/run/user/', // user session mounts
];

// ============================================================================
// Destructive-command functions
// ============================================================================

/**
 * Normalize a command string for pattern matching:
 * 1. Unicode NFKC normalize (collapses homoglyphs)
 * 2. Detect evasion techniques that exist only to defeat scanners
 *
 * When an evasion technique is detected, the decoded form is returned so
 * that pattern matching can still fire on it. Only fails-closed when the
 * evasion wraps a form we cannot safely decode.
 */
export function dcNormalizeCommand(cmd: string): string {
	// Step 1: NFKC — collapses Unicode fullwidth letters and homoglyphs
	let s = cmd.normalize('NFKC');

	// Step 2: PowerShell backtick escapes — PS uses ` as escape char inside strings.
	// `r`m`d`i`r decodes to rmdir; R`e`m`o`v`e`-`I`t`e`m decodes to Remove-Item.
	// In PS, backtick before ANY character produces that character (e.g. `- is just -).
	// Strip all backtick-char pairs so pattern matching fires on the decoded form.
	s = s.replace(/`(.)/g, '$1');

	// Step 3: cmd.exe caret escapes — ^r^m^d^i^r decodes to rmdir.
	// Carets outside quoted strings are escape characters; collapse all
	// caret-letter sequences. `/` is included: cmd decodes `^/` to `/`
	// (`rmdir ^/^s zzz` is `rmdir /s zzz` — verified against real cmd.exe),
	// so a caret-escaped recursion switch must normalize like a literal one.
	s = s.replace(/\^([a-zA-Z0-9 /])/g, '$1');

	// Step 4: quote-splicing evasion e.g. r""m""dir or R''e''m''o''v''e''-''I''t''e''m
	// Collapse both doubled double-quotes and doubled single-quotes (PS single-quote splice).
	s = s.replace(/""/g, '');
	s = s.replace(/''/g, '');

	return s;
}

/**
 * Execution-form launcher / process-modifier inner command (#3474/#3475).
 *
 * Recognized and unwrapped: `command [-p] CMD…` (execution form only),
 * `builtin CMD…`, `exec [-c|-l] [-a NAME] CMD…`, `timeout [OPTIONS]
 * DURATION CMD…` (own options `--foreground`, `--preserve-status`,
 * `-k/--kill-after DUR`, `-s/--signal SIG`, `=`-glued forms, then one
 * DURATION token), and `stdbuf [-i|-o|-e MODE|--input/--output/--error
 * MODE]… [--] CMD…` (both glued and spaced modes). `command -v` / `-V`
 * (standalone or glued) are QUERY forms and return null — they never
 * execute CMD, so unwrapping them would fabricate a write out of a lookup.
 */
function dcStripExecutionLauncher(t: string): string | null {
	// #3485 (PRR-005): hostile oversized input must not cost quadratic strip
	// time — the option loops below scan a bounded prefix (8 KB). Real
	// launcher option regions are far shorter; anything longer degrades to
	// same-as-base non-detection instead of a multi-second stall. The quote-
	// payload arms (-c/encoded/ps) below run on the FULL string (linear).
	const scanCap = 8192;
	const bounded = t.length > scanCap;
	const head = bounded ? t.slice(0, scanCap) : t;
	const tail = bounded ? t.slice(scanCap) : '';
	const withTail = (inner: string | null): string | null => {
		if (inner === null) return null;
		const joined = `${inner}${tail}`.trim();
		return joined || null;
	};

	const cm = /^command\s+(.*)$/is.exec(head);
	if (cm) {
		let rest = cm[1];
		// #3485 (PRR-015): glued `-pp` clusters are legal bash (getopt).
		while (/^-p+\s+/i.test(rest)) rest = rest.replace(/^-p+\s+/i, '');
		if (/^-[pvP]*[vV](?:\s|$)/.test(rest)) return null;
		// `--` ends command's options; the wrapped command follows
		// (impl-review r1 F2: `command -- rmdir ../x` executes rmdir).
		if (/^--\s+/.test(rest)) rest = rest.replace(/^--\s+/, '');
		return withTail(rest.trim() || null);
	}
	const bm = /^builtin\s+(.+)$/is.exec(head);
	if (bm) {
		// #3485 (PRR-015): `builtin CMD` executes CMD only when CMD is a real
		// shell builtin — for anything external (`builtin rm …`) bash errors
		// "not a shell builtin" and runs nothing, so unwrapping would
		// fabricate destructive/write detections of commands that never ran.
		const rest = bm[1].replace(/^--\s+/, '');
		const wrapped = rest.split(/\s+/)[0] ?? '';
		const leaf =
			wrapped
				.split(/[\\/]/)
				.pop()
				?.replace(/\.exe$/i, '')
				.toLowerCase() ?? '';
		if (!BASH_BUILTIN_COMMANDS.has(leaf)) return null;
		return withTail(rest.trim() || null);
	}
	const em = /^exec\s+(.+)$/is.exec(head);
	if (em) {
		let rest = em[1];
		for (;;) {
			if (/^--\s+/.test(rest)) {
				rest = rest.replace(/^--\s+/, '');
				break;
			}
			// #3485 (PRR-015): glued clusters (`-cl`, `-lc`) and attached
			// `-aNAME` execute the wrapped command (bash internal_getopt).
			if (/^-[cl]+\s+/i.test(rest)) {
				rest = rest.replace(/^-[cl]+\s+/i, '');
				continue;
			}
			if (/^-a\S+\s+/i.test(rest)) {
				rest = rest.replace(/^-a\S+\s+/i, '');
				continue;
			}
			if (/^-a\s+\S+\s+/i.test(rest)) {
				rest = rest.replace(/^-a\s+\S+\s+/i, '');
				continue;
			}
			break;
		}
		return withTail(rest.trim() || null);
	}
	const tm = /^timeout\s+(.+)$/is.exec(head);
	if (tm) {
		let rest = tm[1];
		for (;;) {
			let stripped = true;
			if (/^--foreground\s+/i.test(rest))
				rest = rest.replace(/^--foreground\s+/i, '');
			else if (/^--preserve-status\s+/i.test(rest))
				rest = rest.replace(/^--preserve-status\s+/i, '');
			else if (/^--kill-after=\S+\s+/i.test(rest))
				rest = rest.replace(/^--kill-after=\S+\s+/i, '');
			else if (/^--signal=\S+\s+/i.test(rest))
				rest = rest.replace(/^--signal=\S+\s+/i, '');
			else if (/^--verbose\s+/i.test(rest))
				rest = rest.replace(/^--verbose\s+/i, '');
			// #3485 (PRR-015): glued attached-arg shorts (`-sKILL`, `-k5`)
			// execute the wrapped command exactly like the spaced forms.
			else if (/^-[sk]\S+\s+/i.test(rest))
				rest = rest.replace(/^-[sk]\S+\s+/i, '');
			else if (/^-k\s+\S+\s+/i.test(rest))
				rest = rest.replace(/^-k\s+\S+\s+/i, '');
			else if (/^-s\s+\S+\s+/i.test(rest))
				rest = rest.replace(/^-s\s+\S+\s+/i, '');
			else if (/^--kill-after\s+\S+\s+/i.test(rest))
				rest = rest.replace(/^--kill-after\s+\S+\s+/i, '');
			else if (/^--signal\s+\S+\s+/i.test(rest))
				rest = rest.replace(/^--signal\s+\S+\s+/i, '');
			else if (/^-(?:v)\s+/i.test(rest)) rest = rest.replace(/^-(?:v)\s+/i, '');
			// `--` before the DURATION ends timeout's options (`timeout -- 5
			// CMD`); a `--` AFTER the duration is NOT consumed — GNU timeout
			// then fails to exec `--`, so nothing runs (verified).
			else if (/^--\s+/.test(rest)) rest = rest.replace(/^--\s+/, '');
			else stripped = false;
			if (!stripped) break;
		}
		// No /i on the SUFFIX: real GNU timeout rejects uppercase suffixes
		// (`5M` → invalid interval, rc 125, nothing runs — unwrapping
		// fabricated a detection of a command that never ran, PRR-015). The
		// duration itself is strtod grammar and IS case-insensitive where GNU
		// accepts it (probed on real GNU coreutils, EXT-2 M7): `1e3`/`.5`/
		// `+5`/`5e-1` all run the wrapped command (rc 0), and
		// `inf`/`INF`/`infinity` mean "no time limit" and run it (rc 124 —
		// EXT-01). `nan` is rejected (rc 125, nothing runs) and stays
		// unwrapped.
		const dm =
			/^[+-]?(?:(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[iI][nN][fF](?:[iI][nN][iI][tT][yY])?)[smhd]?\s+(.+)$/.exec(
				rest,
			);
		return dm ? withTail(dm[1].trim()) : null;
	}
	const sm = /^stdbuf\s+(.+)$/is.exec(head);
	if (sm) {
		let rest = sm[1];
		for (;;) {
			let m = /^-[ioe](?:[= ]?\S+)?(?:\s+|$)/i.exec(rest);
			if (m) {
				rest = rest.slice(m[0].length);
				continue;
			}
			m = /^--(?:input|output|error)(?:[= ]?\S+)?(?:\s+|$)/i.exec(rest);
			if (m) {
				rest = rest.slice(m[0].length);
				continue;
			}
			if (/^--\s+/.test(rest)) {
				rest = rest.replace(/^--\s+/, '');
				break;
			}
			break;
		}
		return withTail(rest.trim() || null);
	}
	return null;
}

/**
 * Strip one layer of a shell wrapper from a command string.
 * Returns the inner command if a wrapper was found, null otherwise.
 *
 * Handles:
 *   - cmd /c "..."  cmd /k "..."
 *   - powershell -Command "..." / -c "..." / -EncodedCommand <b64> / -enc <b64>
 *   - pwsh -Command / -c / -EncodedCommand / -enc
 *   - bash -c "..." / sh -c / zsh -c
 *   - sudo <...> / env VAR=val <...> / time <...> / nohup <...>
 *   - wsl -e ... / wsl -- ... / wsl.exe -e ...
 *   - PowerShell & { ... } script blocks
 *   - PowerShell iex / Invoke-Expression <...>
 *   - call <...> (batch)
 */
export function dcStripOneWrapper(cmd: string): string | null {
	const t = cmd.trim();

	// cmd.exe wrappers: cmd /c "inner" or cmd /k "inner" — case-insensitive
	// (CMD, cmd, Cmd). Switch-tolerant (#3145 PRR-002): `cmd /d /s /c "…"`
	// must unwrap like bare `cmd /c "…"` or switch-form writes slip past
	// every destructive matcher.
	const cmdExeMatch = new RegExp(
		`${CMD_STRIP_PREFIX.source}"?(.*?)"?\\s*$`,
		'is',
	).exec(t);
	if (cmdExeMatch) return cmdExeMatch[1].trim();

	// PowerShell -Command / -c variants — case-insensitive (POWERSHELL,
	// powershell, pwsh, PWSH). Switch-tolerant (#3145): `powershell
	// -NoProfile -Command "…"` must unwrap like the bare form or the
	// destructive matchers never see the payload.
	const psCommandMatch = new RegExp(
		`${PS_STRIP_PREFIX.source}(.+)$`,
		'is',
	).exec(t);
	if (psCommandMatch)
		return psCommandMatch[1].replace(/^["']|["']$/g, '').trim();

	// PowerShell -EncodedCommand / -enc (base64): decode and return
	const psEncMatch =
		/^(?:powershell|pwsh)(?:\.exe)?\s+(?:-(?:EncodedCommand|encodedcommand|enc|e)\s+)([A-Za-z0-9+/=]+)\s*$/.exec(
			t,
		);
	if (psEncMatch) {
		try {
			const decoded = Buffer.from(psEncMatch[1], 'base64').toString('utf16le');
			return decoded.trim();
		} catch {
			// Cannot decode — fail closed by returning the original (pattern match will see -EncodedCommand)
			return t;
		}
	}

	// bash/sh/zsh -c "inner" — case-insensitive for consistency with other wrappers.
	// #3475: single-quoted payloads unwrap identically to double-quoted ones
	// (a `'...'`-quoted -c argument used to survive unwrapped, hiding every
	// write inside it). Inner quotes of the OTHER kind survive by construction;
	// the lazy third alternative keeps the historical unquoted-payload path.
	const shellMatch =
		/^(?:bash|sh|zsh|dash|fish)(?:\.exe)?\s+-c\s+(?:"([^"]*)"|'([^']*)'|"?(.*?)"?)\s*$/is.exec(
			t,
		);
	if (shellMatch) {
		const inner = shellMatch[1] ?? shellMatch[2] ?? shellMatch[3];
		return inner.trim();
	}

	// eval 'inner' / eval "inner" / eval inner — the POSIX builtin executes its
	// argument as a command, so it must be unwrapped like other wrappers or a
	// destructive/write command hidden inside `eval` slips past every matcher
	// (issue #1778 H3). Case-insensitive for obfuscation parity.
	const evalMatch = /^eval\s+(.+)$/is.exec(t);
	if (evalMatch) return evalMatch[1].replace(/^["']|["']$/g, '').trim();

	// sudo / env VAR=val / time / nohup / nice -n N: strip leading word + optional args
	// Case-insensitive: SUDO, TIME, NOHUP are valid in encoded/obfuscated commands.
	// #3343: the env strip must consume env's OWN flags before the payload —
	// argument-less flags (-i, --ignore-environment, any short flag), arg-taking
	// flags WITH their separate argument (-u/-U/-C/-S/--split-string + one
	// word), and VAR=VALUE assignments — or `env -u FOO python -c …` unwraps
	// to `-u FOO python -c …`, whose `-u` command word detects no writes, and
	// the gate would evaluate the (worse) unwrapped analysis instead of the
	// primary one (impl-review r3 finding 2).
	const envPrefix =
		/^env(?:\s+(?:[A-Za-z_][A-Za-z0-9_]*=\S+|(?:-[i0vVh]*[uUCSaP]|--u(?:n(?:s(?:e(?:t)?)?)?)?|--c(?:h(?:d(?:i(?:r)?)?)?)?|--a(?:r(?:g(?:v(?:0)?)?)?)?|--s(?:p(?:l(?:i(?:t(?:-(?:s(?:t(?:r(?:i(?:n(?:g)?)?)?)?)?)?)?)?)?)?)?|--e(?:n(?:v(?:0(?:-(?:f(?:r(?:o(?:m)?)?)?)?)?)?)?)?)\s+\S+|-\S+|--[A-Za-z][A-Za-z0-9-]*))*\s+(.+)$/is;
	// #3475/#3474: execution-form launcher and process-modifier prefixes.
	// `command -v`/`-V` (standalone or glued into a short cluster) are QUERY
	// forms and are deliberately NOT unwrapped — unwrapping would fabricate a
	// write out of a read-only lookup (plan-critic r2 B3); the same
	// execution-only rule the detector-level canonical walk applies.
	const launcherInner = dcStripExecutionLauncher(t);
	const prefixMatch =
		/^(?:sudo|time|nohup)\s+(.+)$/is.exec(t) ??
		envPrefix.exec(t) ??
		(launcherInner !== null && launcherInner !== ''
			? [t, launcherInner]
			: null) ??
		/^nice\s+(?:-n\s+\d+\s+)?(.+)$/is.exec(t);
	if (prefixMatch) return prefixMatch[1].trim();

	// WSL cross-OS bridge: wsl -e ... / wsl -- ... / wsl.exe -e ...
	// Case-insensitive: WSL.EXE is commonly written uppercase on Windows.
	// These execute commands in the Linux subsystem — paths like /mnt/c/ map to C:\
	const wslMatch = /^wsl(?:\.exe)?\s+(?:-e|--)\s+(.+)$/is.exec(t);
	if (wslMatch) return wslMatch[1].trim();

	// PowerShell script block: & { ... } or & { ... } ; & { ... }
	const scriptBlockMatch = /^&\s*\{(.+)\}$/s.exec(t);
	if (scriptBlockMatch) return scriptBlockMatch[1].trim();

	// PowerShell Invoke-Expression / iex
	const iexMatch = /^(?:Invoke-Expression|iex)\s+(.+)$/is.exec(t);
	if (iexMatch) return iexMatch[1].replace(/^["'`]|["'`]$/g, '').trim();

	// PowerShell Invoke-Command -ScriptBlock { ... }
	const invokeCommandMatch =
		/^Invoke-Command\s+.*-ScriptBlock\s*\{(.+)\}$/is.exec(t);
	if (invokeCommandMatch) return invokeCommandMatch[1].trim();

	// batch: call <command>
	const callMatch = /^call\s+(.+)$/is.exec(t);
	if (callMatch) return callMatch[1].trim();

	return null;
}

/**
 * Recursively unwrap all shell wrappers up to DC_MAX_UNWRAP_DEPTH.
 * Returns the innermost unwrapped command.
 */
export function dcUnwrapWrappers(cmd: string): string {
	let current = cmd.trim();
	for (let depth = 0; depth < DC_MAX_UNWRAP_DEPTH; depth++) {
		const inner = dcStripOneWrapper(current);
		if (inner === null || inner === current) break;
		current = inner.trim();
	}
	return current;
}

/**
 * Split a compound command into individual segments, splitting on:
 *   ; && || | newlines
 * Respects double-quoted strings (does not split inside quotes).
 * Returns array of trimmed non-empty segments.
 */
export function dcSplitSegments(cmd: string): string[] {
	const segments: string[] = [];
	let current = '';
	let inDoubleQuote = false;
	let inSingleQuote = false;

	for (let i = 0; i < cmd.length; i++) {
		const ch = cmd[i];
		const next = cmd[i + 1];

		if (ch === '"' && !inSingleQuote) {
			inDoubleQuote = !inDoubleQuote;
			current += ch;
			continue;
		}
		if (ch === "'" && !inDoubleQuote) {
			inSingleQuote = !inSingleQuote;
			current += ch;
			continue;
		}

		if (!inDoubleQuote && !inSingleQuote) {
			// Check for && or ||
			if ((ch === '&' && next === '&') || (ch === '|' && next === '|')) {
				segments.push(current.trim());
				current = '';
				i++; // skip second char
				continue;
			}
			// Single | (pipe) or ; or newline
			if (ch === '|' || ch === ';' || ch === '\n' || ch === '\r') {
				segments.push(current.trim());
				current = '';
				continue;
			}
			// Single & (background / command separator) — but NOT part of `&&`
			// (handled above) and NOT a POSIX fd-duplication redirect
			// (`2>&1`, `>&`, `&>`). Splitting an fd-redirect would corrupt the
			// command and make the guard reject legitimate commands, while a
			// destructive command after a lone `&` must NOT evade the
			// `^`-anchored matchers (issue #1778 H3).
			if (ch === '&' && next !== '&') {
				const prev = cmd[i - 1];
				const isFdRedirect = prev === '>' || next === '>';
				if (!isFdRedirect) {
					segments.push(current.trim());
					current = '';
					continue;
				}
			}
		}
		current += ch;
	}
	if (current.trim()) segments.push(current.trim());
	return segments.filter((s) => s.length > 0);
}

/**
 * Extract targets from an `rm` command whose leading option set requests
 * recursive or forced deletion. Accepts stacked short flags and long flags in
 * any leading order. Quoted targets remain one token. Returns null when the
 * segment is not a destructive rm form.
 */
export function dcExtractRecursiveRmTargets(segment: string): string[] | null {
	const tokens = segment.match(/"(?:[^"\\]|\\.)*"|'[^']*'|\S+/g) ?? [];
	// #3518 P-5 (class, final-critic round 1): tolerate leading
	// open-parens/braces — a parenthesized segment runs the same rm in a
	// POSIX subshell, whether the paren GLUES to the verb (`(rm`) or stands
	// alone (`( rm`). Drop standalone delimiter tokens, then strip a glued
	// prefix from what remains; a token that normalizes empty fails closed.
	while (
		tokens.length > 0 &&
		tokens[0] !== undefined &&
		/^[({\s]*$/.test(tokens[0]) &&
		tokens[0].length > 0
	) {
		tokens.shift();
	}
	if (tokens.length > 0 && tokens[0] !== undefined) {
		tokens[0] = tokens[0].replace(/^[({\s]+/, '');
	}
	if (tokens.length < 2 || tokens[0] !== 'rm') return null;

	let destructive = false;
	let index = 1;
	for (; index < tokens.length; index++) {
		const token = tokens[index];
		if (token === '--') {
			index++;
			break;
		}
		if (!token.startsWith('-') || token === '-') break;
		if (token === '--recursive' || token === '--force') destructive = true;
		if (!token.startsWith('--') && /[rRfF]/.test(token.slice(1))) {
			destructive = true;
		}
	}
	if (!destructive) return null;

	return tokens
		.slice(index)
		.map((target) => target.replace(/^(["'])|(["'])$/g, ''));
}

/**
 * Returns true if a path string contains unexpanded environment variable
 * references that we cannot resolve at check time.
 */
export function dcHasUnresolvableVars(p: string): boolean {
	// %VAR% (cmd.exe), $VAR or ${VAR} or $env:VAR (PS/bash)
	return /(%[A-Za-z_][A-Za-z0-9_]*%|\$\{?[A-Za-z_]|\$env:)/i.test(p);
}

/**
 * Returns true if the path looks like a remote/network filesystem path.
 */
export function dcIsRemotePath(p: string): boolean {
	return DC_REMOTE_PREFIXES.some((pfx) => p.startsWith(pfx));
}

/**
 * Walk from target path up to (but not beyond) cwd using synchronous lstat,
 * checking each ancestor for symlinks, junctions, or reparse points.
 *
 * Returns a block reason string if a suspicious ancestor is found, null otherwise.
 * Skips silently on ENOENT (target does not exist — nothing to delete).
 * Fails closed on unexpected lstat errors.
 */
export function dcLstatAncestorWalk(
	targetPath: string,
	cwd: string,
): string | null {
	// Normalize separators to the platform convention
	const normalizedTarget = path.resolve(cwd, targetPath);
	const normalizedCwd = path.resolve(cwd);

	// Collect ancestor chain from target up to (and including) cwd
	const ancestors: string[] = [];
	let current = normalizedTarget;
	while (true) {
		const rel = path.relative(normalizedCwd, current);
		if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel))
			break;
		ancestors.push(current);
		if (rel === '') break;
		const parent = path.dirname(current);
		if (parent === current) break; // filesystem root
		current = parent;
	}

	for (const ancestor of ancestors) {
		let stat: ReturnType<typeof fsSync.lstatSync> | null = null;
		try {
			stat = fsSync.lstatSync(ancestor);
		} catch (err: unknown) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code === 'ENOENT') {
				// Target does not exist — nothing to delete at this point
				// Continue upward: a missing leaf may still sit below an existing
				// symlink/junction ancestor (issue #2096).
				continue;
			}
			// Unexpected error (EPERM, EACCES, etc.) — fail closed
			return `lstat failed on "${ancestor}": ${String(err)} — refusing to allow destructive operation on unverifiable path`;
		}

		if (stat.isSymbolicLink()) {
			return `BLOCKED: "${ancestor}" is a symlink/junction — deleting recursively through it would destroy the link target. Use platform-specific junction deletion (fsutil reparsepoint delete, Remove-Item without -Recurse) instead.`;
		}
	}

	return null; // all clear
}

/**
 * Given a set of raw target strings from a destructive command, apply:
 * 1. Unresolvable-var check (fail closed)
 * 2. Safe-target allowlist check (allow through)
 * 3. Remote filesystem check (block)
 * 4. Unconditional system-path block
 * 5. lstat ancestor walk (block on symlink/junction in chain)
 *
 * Returns a block reason string or null if targets are acceptable.
 */
export function dcValidateTargets(
	targets: string[],
	cwd: string,
): string | null {
	for (const raw of targets) {
		const t = raw.trim().replace(/^["']|["']$/g, '');
		if (!t || t === '.') continue;

		// Check for unexpanded vars — fail closed (cannot verify safety)
		if (dcHasUnresolvableVars(t)) {
			return `BLOCKED: Destructive command targets path with unexpanded variable "${t}" — cannot verify safety. Resolve variables before using destructive operations.`;
		}

		// Check remote filesystem prefixes
		if (dcIsRemotePath(t)) {
			return `BLOCKED: Destructive command targets remote/network filesystem path "${t}" — refusing to execute remote destructive operations.`;
		}

		// UNC path \\server\share or extended \\?\
		if (/^\\\\/.test(t)) {
			return `BLOCKED: Destructive command targets UNC path "${t}" — UNC paths in destructive operations are not allowed.`;
		}

		// lstat ancestor walk: MUST run before safe-target allowlist.
		// An LLM can create a junction named "node_modules" (or "dist", etc.) pointing to
		// important data, then run "rm -rf node_modules". Without this check, the safe-target
		// allowlist would permit the deletion — this is the K2.6 incident mechanism replayed
		// with a safe-named junction.
		const filesystemTarget = t.replace(/[\\/]+/g, path.sep);
		const lstatBlock = dcLstatAncestorWalk(filesystemTarget, cwd);
		if (lstatBlock) return lstatBlock;

		// Safe bare-name targets (after lstat confirms no junction/symlink): skip path checks
		const basename = path.basename(filesystemTarget);
		if (dcPathComponents(t).length === 1 && DC_SAFE_TARGETS.has(basename)) {
			continue; // Allowed — lstat confirmed no junction/symlink in ancestor chain
		}

		// Filesystem roots — unconditional block
		if (DC_FS_ROOTS.has(t) || DC_FS_ROOTS.has(t.replace(/\//g, '\\'))) {
			return `BLOCKED: Destructive command targets filesystem root "${t}"`;
		}

		// Absolute path: check against blocked system prefixes
		if (path.isAbsolute(t) || /^[A-Za-z]:/.test(t)) {
			for (const blocked of DC_BLOCKED_ABSOLUTE_PREFIXES) {
				if (t.startsWith(blocked)) {
					return `BLOCKED: Destructive command targets system path "${t}" which is under protected prefix "${blocked}"`;
				}
			}
		}
	}
	return null;
}

export interface DcVerifiedScope {
	bindingId: string;
	generationId: string;
	files: string[];
}

export type DcRecursiveDeleteDecision =
	| {
			allowed: true;
			kind: 'bare-safe-artifact' | 'scoped-nested-safe-artifact';
			targets: string[];
	  }
	| {
			allowed: false;
			code:
				| 'DESTRUCTIVE_TARGET_INVALID'
				| 'DESTRUCTIVE_TARGET_PROTECTED'
				| 'DESTRUCTIVE_TARGET_OUTSIDE_WORKSPACE'
				| 'DESTRUCTIVE_TARGET_NOT_SAFE_ARTIFACT'
				| 'DESTRUCTIVE_TARGET_SCOPE_REQUIRED'
				| 'DESTRUCTIVE_TARGET_OUT_OF_SCOPE';
			reason: string;
	  };

function dcIsUntrustedCodePoint(codePoint: number): boolean {
	return (
		codePoint <= 0x1f ||
		(codePoint >= 0x7f && codePoint <= 0x9f) ||
		(codePoint >= 0x202a && codePoint <= 0x202e) ||
		(codePoint >= 0x2066 && codePoint <= 0x2069)
	);
}

function dcHasUntrustedText(value: string): boolean {
	return Array.from(value).some((character) =>
		dcIsUntrustedCodePoint(character.codePointAt(0) ?? 0),
	);
}

function dcSafeDiagnosticValue(value: string): string {
	return value
		.split('')
		.map((character) =>
			dcIsUntrustedCodePoint(character.codePointAt(0) ?? 0) ? '?' : character,
		)
		.join('')
		.slice(0, 512);
}

function dcPathComponents(value: string): string[] {
	return value.replace(/\\/g, '/').split('/').filter(Boolean);
}

function dcComponentEquals(left: string, right: string): boolean {
	return process.platform === 'win32'
		? left.toLowerCase() === right.toLowerCase()
		: left === right;
}

function dcScopeContains(scopeEntry: string, target: string): boolean {
	const normalize = (value: string): string => {
		const normalized = path.posix
			.normalize(value.replace(/\\/g, '/'))
			.replace(/^\.\//, '')
			.replace(/\/$/, '');
		return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
	};
	const scope = normalize(scopeEntry);
	const candidate = normalize(target);
	return candidate === scope || candidate.startsWith(`${scope}/`);
}

/**
 * Evaluate recursive-delete targets as one atomic set.
 *
 * Bare safe artifact names remain statically allowable after common target
 * validation. Nested targets require an allowlisted final component and a
 * resolver-produced active binding identity covering the target. Arbitrary
 * in-scope directories are never exempt, and `.git`/`.swarm` are protected at
 * every depth.
 */
export function dcEvaluateRecursiveDeleteTargets(input: {
	targets: string[];
	cwd: string;
	verifiedScope?: DcVerifiedScope;
}): DcRecursiveDeleteDecision {
	if (input.targets.length === 0) {
		return {
			allowed: false,
			code: 'DESTRUCTIVE_TARGET_INVALID',
			reason: 'BLOCKED: Recursive delete has no statically verifiable target.',
		};
	}

	const commonBlock = dcValidateTargets(input.targets, input.cwd);
	if (commonBlock) {
		return {
			allowed: false,
			code: 'DESTRUCTIVE_TARGET_INVALID',
			reason: commonBlock,
		};
	}

	const normalizedTargets: string[] = [];
	let hasNested = false;
	for (const raw of input.targets) {
		const target = raw.trim().replace(/^['"]|['"]$/g, '');
		const safeTarget = dcSafeDiagnosticValue(target);
		if (
			!target ||
			target === '.' ||
			dcHasUntrustedText(target) ||
			dcPathComponents(target).includes('..')
		) {
			return {
				allowed: false,
				code: 'DESTRUCTIVE_TARGET_INVALID',
				reason: `BLOCKED: Recursive delete target "${safeTarget}" is empty, the workspace root, contains traversal, or contains control characters.`,
			};
		}

		const components = dcPathComponents(target);
		if (
			components.some(
				(component) =>
					dcComponentEquals(component, '.git') ||
					dcComponentEquals(component, '.swarm'),
			)
		) {
			return {
				allowed: false,
				code: 'DESTRUCTIVE_TARGET_PROTECTED',
				reason: `BLOCKED: Recursive delete target "${safeTarget}" contains protected .git or .swarm state.`,
			};
		}

		// Shell syntax can carry either slash on every host (cmd commands may be
		// inspected on POSIX and POSIX forms on Windows). Normalize both before
		// filesystem operations so security decisions are host-independent.
		const filesystemTarget = target.replace(/[\\/]+/g, path.sep);
		const resolved = path.resolve(input.cwd, filesystemTarget);
		const relative = path.relative(path.resolve(input.cwd), resolved);
		if (
			relative === '' ||
			relative === '..' ||
			relative.startsWith(`..${path.sep}`) ||
			path.isAbsolute(relative)
		) {
			return {
				allowed: false,
				code: 'DESTRUCTIVE_TARGET_OUTSIDE_WORKSPACE',
				reason: `BLOCKED: Recursive delete target "${safeTarget}" is not strictly contained by the workspace.`,
			};
		}

		const basename = path.basename(resolved);
		if (!DC_SAFE_TARGETS.has(basename)) {
			return {
				allowed: false,
				code: 'DESTRUCTIVE_TARGET_NOT_SAFE_ARTIFACT',
				reason: `BLOCKED: Recursive delete target "${safeTarget}" is not an allowlisted build/cache artifact.`,
			};
		}

		const normalizedRelative = relative.replace(/\\/g, '/');
		const isBare = components.length === 1;
		if (!isBare) {
			hasNested = true;
			if (
				!input.verifiedScope?.bindingId ||
				!input.verifiedScope.generationId
			) {
				return {
					allowed: false,
					code: 'DESTRUCTIVE_TARGET_SCOPE_REQUIRED',
					reason: `BLOCKED: Nested safe artifact "${safeTarget}" requires a verified active coder scope binding.`,
				};
			}
			if (
				!input.verifiedScope.files.some((entry) =>
					dcScopeContains(entry, normalizedRelative),
				)
			) {
				return {
					allowed: false,
					code: 'DESTRUCTIVE_TARGET_OUT_OF_SCOPE',
					reason: `BLOCKED: Nested safe artifact "${safeTarget}" is outside the verified active coder scope.`,
				};
			}
		}
		normalizedTargets.push(normalizedRelative);
	}

	return {
		allowed: true,
		kind: hasNested ? 'scoped-nested-safe-artifact' : 'bare-safe-artifact',
		targets: normalizedTargets,
	};
}

/**
 * Detect Windows junction or symlink CREATION commands.
 * Junction creation followed by recursive deletion of the junction is the
 * exact mechanism of the K2.6 data-loss incident.
 * Block junction/symlink creation where the target resolves outside cwd.
 *
 * Patterns covered:
 *   mklink /J <link> <target>
 *   mklink /D <link> <target>
 *   New-Item -ItemType Junction -Path <link> -Target <target>
 *   New-Item -ItemType SymbolicLink -Path <link> -Target <target>
 *   ln -s <target> <link>  (when target is outside cwd)
 */
export function dcCheckJunctionCreation(
	segment: string,
	cwd: string,
): string | null {
	// mklink /J or /D (cmd.exe)
	const mklinkMatch =
		/^mklink(?:\.exe)?\s+\/[JjDd]\s+"?([^"\s]+)"?\s+"?([^"\s]+)"?/i.exec(
			segment,
		);
	if (mklinkMatch) {
		const target = mklinkMatch[2].trim();
		if (!dcHasUnresolvableVars(target)) {
			const resolved = path.resolve(cwd, target);
			const rel = path.relative(cwd, resolved);
			if (rel.startsWith('..') || path.isAbsolute(rel)) {
				return `BLOCKED: Junction/symlink creation targeting path outside working directory: mklink target "${target}" resolves to "${resolved}" which is outside "${cwd}". Creating junctions to external paths and then deleting them recursively can destroy data.`;
			}
		}
		return null; // target is inside cwd — allow
	}

	// New-Item -ItemType Junction|SymbolicLink (PowerShell)
	// Parameters are order-independent in PS, so check for -ItemType and -Target independently.
	const newItemTypeMatch =
		/New-Item\b.*-ItemType\s+(?:Junction|SymbolicLink|HardLink)\b/i.test(
			segment,
		);
	const newItemTargetMatch = /-Target\s+"?([^"\s;]+)"?/i.exec(segment);
	const newItemMatch = newItemTypeMatch ? newItemTargetMatch : null;
	if (newItemMatch) {
		const target = newItemMatch[1].trim();
		if (!dcHasUnresolvableVars(target)) {
			const resolved = path.resolve(cwd, target);
			const rel = path.relative(cwd, resolved);
			if (rel.startsWith('..') || path.isAbsolute(rel)) {
				return `BLOCKED: Junction/symlink creation targeting path outside working directory: New-Item target "${target}" resolves to "${resolved}" which is outside "${cwd}". This pattern caused the K2.6 data-loss incident.`;
			}
		}
		return null;
	}

	// ln -s <target> (POSIX symlink; block if target resolves outside cwd)
	// Both absolute and relative targets are checked: ln -s ../sensitive dist escapes cwd.
	const lnMatch =
		/^ln\s+(?:-[sfnv]*s[sfnv]*|-s)\s+"?([^"\s]+)"?(?:\s+"?[^"\s]+"?)?\s*$/.exec(
			segment,
		);
	if (lnMatch) {
		const target = lnMatch[1].trim();
		if (!dcHasUnresolvableVars(target)) {
			const resolved = path.resolve(cwd, target);
			const rel = path.relative(cwd, resolved);
			if (rel.startsWith('..') || path.isAbsolute(rel)) {
				return `BLOCKED: Symlink creation targeting path outside working directory: ln -s target "${target}" resolves to "${resolved}" which is outside "${cwd}". Symlinks to external paths combined with recursive deletion can destroy data.`;
			}
		}
		return null;
	}

	return null;
}

export {
	dcIsSwitchClusterText,
	dcParseWindowsRecursiveDelete,
} from './cmd-delete-grammar';

/**
 * Whether a whitespace-delimited cmd.exe argument behaves like a switch
 * cluster (issue #3495): a leading `/` followed by switch text where EVERY
 * slash-separated segment is 1–2 ASCII letters — `/s`, `/S`, `/q`, `/s/q`,
 * `/sq`, `/qs`. Path-like tokens never qualify: `/share` and `/src/old`
 * carry multi-letter segments, and a quoted token (`"/s"`, `"a/share/b"`)
 * does not start with `/`. Verified against real cmd.exe: a quoted `"/s"`
 * is treated as a path, and `/sq` is rejected by cmd itself ("Parameter
 * format not correct"), so classifying these clusters as switches is at
 * worst fail-closed parity. Grammar text lives in ./cmd-delete-grammar.
 */
export function dcIsWindowsSwitchCluster(token: string): boolean {
	if (!/^\/[A-Za-z]/.test(token)) return false;
	return dcIsSwitchClusterText(token.slice(1));
}

/**
 * Extract candidate target paths from a destructive PowerShell command.
 * Handles both `Remove-Item <path> -Recurse` and `Remove-Item -Recurse <path>` orderings.
 */
export function dcExtractPowerShellTargets(segment: string): string[] {
	// Strip the leading verb. #3518 P-5 (class): leading open-parens/
	// whitespace tolerated — `(Remove-Item x -Recurse)` runs the same cmdlet.
	const verbMatch =
		/^(?:[({\s])*(?:Remove-Item|ri|rm|rmdir|del|erase|rd)\s+/i.exec(segment);
	if (!verbMatch) return [];
	const rest = segment.slice(verbMatch[0].length);

	// Tokenize remainder; quoted strings count as one token
	const tokens: string[] = rest.match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? [];

	const targets: string[] = [];
	// Flags that consume the next token as a value
	const valueFlags = new Set([
		'-literalpath',
		'-path',
		'-filter',
		'-include',
		'-exclude',
		'-lp', // alias for -LiteralPath in PS 7+
	]);
	let skipNext = false;
	for (const tok of tokens) {
		if (skipNext) {
			skipNext = false;
			continue;
		}
		if (tok.startsWith('-')) {
			// Switch-like flags: -Recurse, -Force, -ErrorAction, -WhatIf etc.
			if (valueFlags.has(tok.toLowerCase())) {
				skipNext = true; // next token is the flag's value (a path) — capture it
				// Don't push here; the *next* token IS the target path
				// Re-enter loop with skipNext=false to capture it
				const idx = tokens.indexOf(tok);
				if (idx !== -1 && idx + 1 < tokens.length) {
					const val = tokens[idx + 1].replace(/^["']|["']$/g, '');
					if (val) targets.push(val);
					skipNext = true; // skip the value token on next iteration
				}
			}
			// else: plain switch flag like -Recurse, -Force — skip
		} else {
			// Non-flag positional argument → path target
			const cleaned = tok.replace(/^["']|["']$/g, '');
			if (cleaned) targets.push(cleaned);
		}
	}
	return targets;
}
