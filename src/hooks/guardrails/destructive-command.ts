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
import * as os from 'node:os';
import * as path from 'node:path';
import { sanitizeDiagnosticText } from '../../scope/path-identity';
import { CMD_STRIP_PREFIX, PS_STRIP_PREFIX } from '../shell-executor-context';
import {
	BASH_BUILTIN_COMMANDS,
	expandBraceRaw,
	longFlagTakesArg,
	parseRmOptionTokens,
	SUDO_ARG_TAKING_SHORT,
	SUDO_LONG_ARG_TAKING,
	walkLauncherOptions,
	walkShellCommandFlags,
} from '../shell-write-detect';
import { dcIsSwitchClusterText } from './cmd-delete-grammar';

// ============================================================================
// Destructive-command constants
// ============================================================================

/**
 * Paranoid absolute bound for the string unwrap chain (#3491 W3). The old
 * fixed DC_MAX_UNWRAP_DEPTH=5 stopped SILENTLY with the verb unreached
 * (`sudo`x6 admitted a wrapped `rm -rf`); the loop is now cursor-bounded
 * (every iteration strips at least the wrapper word) with this absolute
 * backstop, whose exceedance FAILS CLOSED through
 * {@link dcUnwrapWrappersBounded}'s additive depthExceeded flag (consulted
 * by the gate and the explain mirror before every no-write early return).
 */
export const DC_UNWRAP_PARANOID_BOUND = 64;

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
// Shared shell word machinery (#3491 W2/W4)
// ============================================================================

/**
 * Quote-aware shell word splitter with bash quote-removal (#3491 W4): splits
 * on unquoted whitespace and returns each word's quote-removed text. Single
 * quotes are fully literal; double quotes honor backslash escapes;
 * backslash outside quotes escapes the next character; adjacent quoted and
 * unquoted spans CONCATENATE into one word (`'a'\''b'` is one word, not
 * three — the same-kind quote-concat shape that defeated the old
 * positional-blind payload regex). An unterminated quote extends the current
 * word to the end of the input (the conservative reading).
 */
export function shellSplitWords(input: string): string[] {
	const words: string[] = [];
	let current = '';
	let hasWord = false;
	const pushWord = () => {
		if (hasWord) {
			words.push(current);
			current = '';
			hasWord = false;
		}
	};
	let i = 0;
	while (i < input.length) {
		const ch = input[i];
		if (ch === "'") {
			hasWord = true;
			i += 1;
			while (i < input.length && input[i] !== "'") {
				current += input[i];
				i += 1;
			}
			i += 1; // closing quote (or end of input)
			continue;
		}
		if (ch === '"') {
			hasWord = true;
			i += 1;
			while (i < input.length && input[i] !== '"') {
				if (
					input[i] === '\\' &&
					i + 1 < input.length &&
					'"\\$`'.includes(input[i + 1])
				) {
					current += input[i + 1];
					i += 2;
					continue;
				}
				current += input[i];
				i += 1;
			}
			i += 1;
			continue;
		}
		if (ch === '\\') {
			hasWord = true;
			if (i + 1 < input.length) {
				current += input[i + 1];
				i += 2;
				continue;
			}
			i += 1;
			continue;
		}
		if (/\s/.test(ch)) {
			pushWord();
			i += 1;
			continue;
		}
		current += ch;
		hasWord = true;
		i += 1;
	}
	pushWord();
	return words;
}

/**
 * Offset-aware sibling of {@link shellSplitWords} (#3491 W3): each word
 * carries the index where it starts in the RAW input. The launcher strip
 * must return the RAW TAIL SLICE — not a re-serialized quote-removed word
 * list — because quote removal is lossy for Windows grammar analysis
 * (`C:\target` dequotes to `C:target` in bash, but the destructive arm
 * judges the raw text under the cmd.exe grammar where the backslash form is
 * the real target spelling).
 */
export function shellSplitWordsWithOffsets(
	input: string,
): Array<{ word: string; start: number; raw: string }> {
	const out: Array<{ word: string; start: number; raw: string }> = [];
	let current = '';
	let hasWord = false;
	let wordStart = -1;
	const pushWord = (rawEnd: number) => {
		if (hasWord) {
			out.push({
				word: current,
				start: wordStart,
				raw: input.slice(wordStart, rawEnd),
			});
			current = '';
			hasWord = false;
		}
	};
	let i = 0;
	while (i < input.length) {
		const ch = input[i];
		if (ch === "'") {
			if (!hasWord) wordStart = i;
			hasWord = true;
			i += 1;
			while (i < input.length && input[i] !== "'") {
				current += input[i];
				i += 1;
			}
			i += 1;
			continue;
		}
		if (ch === '"') {
			if (!hasWord) wordStart = i;
			hasWord = true;
			i += 1;
			while (i < input.length && input[i] !== '"') {
				if (
					input[i] === '\\' &&
					i + 1 < input.length &&
					'"\\$`'.includes(input[i + 1])
				) {
					current += input[i + 1];
					i += 2;
					continue;
				}
				current += input[i];
				i += 1;
			}
			i += 1;
			continue;
		}
		if (ch === '\\') {
			if (!hasWord) wordStart = i;
			hasWord = true;
			if (i + 1 < input.length) {
				current += input[i + 1];
				i += 2;
				continue;
			}
			i += 1;
			continue;
		}
		if (/\s/.test(ch)) {
			pushWord(i);
			i += 1;
			continue;
		}
		if (!hasWord) wordStart = i;
		current += ch;
		hasWord = true;
		i += 1;
	}
	pushWord(input.length);
	return out;
}

/**
 * Serialize one word for safe re-emission into a generated shell command:
 * POSIX single-quote serialization (every `'` becomes `'\''`), so a DIR
 * operand containing spaces, `#`, quotes, or any other metacharacter
 * round-trips as the SAME single word the shell originally parsed
 * (#3491 W2).
 */
export function shSingleQuote(word: string): string {
	return `'${word.replace(/'/g, `'\\''`)}'`;
}

/** Serialize a word list back into one safe shell command string. */
function shSerializeWords(words: string[]): string {
	// Words without any shell metacharacter round-trip unquoted; everything
	// else (spaces, quotes, globs, expansions, redirection characters) is
	// single-quoted. Keeping plain words bare preserves the wrapper-verb
	// spellings (`sh -c`, `rm -rf`) for the legacy re-unwrap pass.
	return words
		.map((w) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(w) ? w : shSingleQuote(w)))
		.join(' ');
}

// ============================================================================
// Verb-word normalization (#3539 W6)
// ============================================================================

/**
 * PR #3615 feedback PRR-002: decode ONE raw segment token into the word bash
 * actually hands the executable — matching quote pairs removed (single
 * quotes literal-inner, double quotes honoring backslash escapes) and
 * backslash escapes honored outside quotes — so the DC extractor's
 * quote-PRESERVING token feed classifies OPTIONS identically to the
 * detector's quote-removed AST-word feed. The decoded word is for OPTION
 * CLASSIFICATION ONLY: brace handling (braceBorne / expandBraceRaw) stays
 * on the RAW token, whose quote/escape context is what #3569 4.5 review
 * pinned (a QUOTED brace `rm -f 'src/{a,b}'` stays literal because bash
 * quote removal hides the braces from expansion before the braces are
 * ever seen).
 */
export function dcDecodeShellWord(token: string): string {
	let out = '';
	let i = 0;
	while (i < token.length) {
		const ch = token[i];
		if (ch === "'") {
			// Single quotes: everything to the closing quote is literal.
			const end = token.indexOf("'", i + 1);
			if (end === -1) {
				out += token.slice(i + 1);
				break;
			}
			out += token.slice(i + 1, end);
			i = end + 1;
			continue;
		}
		if (ch === '"') {
			// Double quotes: backslash escapes only $ ` " \ newline.
			i += 1;
			while (i < token.length) {
				const c = token[i];
				if (
					c === '\\' &&
					i + 1 < token.length &&
					'$`"\\\n'.includes(token[i + 1])
				) {
					out += token[i + 1];
					i += 2;
					continue;
				}
				if (c === '"') {
					i += 1;
					break;
				}
				out += c;
				i += 1;
			}
			continue;
		}
		if (ch === '\\' && i + 1 < token.length) {
			out += token[i + 1];
			i += 2;
			continue;
		}
		out += ch;
		i += 1;
	}
	return out;
}

/**
 * Normalize ONE command word to the verb name bash/PowerShell would resolve
 * (#3539 W6 / RC-6): matched-quote removal plus backslash-escape removal for
 * POSIX spellings (`\rm`, `"rm"`, `'\''rm'`-style), and basename extraction
 * ONLY for ABSOLUTE path-qualified spellings — win32 spellings (drive letter
 * or backslash separator, e.g. `C:\Windows\system32\rmdir.exe`,
 * `C:/Windows/system32/rmdir.exe`) case-INSENSITIVE with an optional
 * extension; POSIX forward-slash absolutes (`/bin/rm`) case-SENSITIVE
 * (`/bin/RM` stays unmatched). RELATIVE spellings (`./rm`, `../rm`) are NOT
 * normalized — they name project-local programs, not the system verbs.
 *
 * Order matters: a win32 absolute spelling is detected BEFORE backslash
 * dequoting (a drive-led word's backslashes are path separators, not bash
 * escapes — dequoting first would collapse `C:\Windows` to `C:Windows`).
 */
export function dcNormalizeVerbWord(word: string): string {
	let w = word;
	// Strip up to two matched surrounding quote pairs (`"rm"`, `"'\''rm'"'`).
	for (let i = 0; i < 2; i++) {
		if (
			w.length >= 2 &&
			((w.startsWith("'") && w.endsWith("'")) ||
				(w.startsWith('"') && w.endsWith('"')))
		) {
			w = w.slice(1, -1);
			continue;
		}
		break;
	}
	if (/^([A-Za-z]:[\\/]|\\\\)/.test(w) || w.startsWith('\\')) {
		// Win32 absolute (drive-led, UNC, or backslash-root): separators are
		// literal, comparison case-insensitive, `.exe` optional.
		const base = w.split(/[\\/]/).filter(Boolean).pop() ?? w;
		return base.replace(/\.[Ee][Xx][Ee]$/, '').toLowerCase();
	}
	if (w.startsWith('/')) {
		// POSIX absolute: case-SENSITIVE basename (no extension stripping —
		// `rm.exe` on POSIX is a different file).
		return w.split('/').filter(Boolean).pop() ?? w;
	}
	// Bare or relative: POSIX backslash-escape removal only (`\rm` → `rm`).
	return w.replace(/\\(.)/g, '$1');
}

/**
 * Match a segment's leading verb word against a lowercase verb list
 * (#3539 W6): tolerant of the #3518 P-5 leading paren/whitespace forms, the
 * verb compared through {@link dcNormalizeVerbWord}. Returns the normalized
 * verb and the remainder of the segment (starting after the raw verb word).
 */
export function dcSegmentVerbMatch(
	segment: string,
	verbs: readonly string[],
	caseInsensitive = true,
): { verb: string; rest: string } | null {
	const lead = /^(?:[({\s])*/.exec(segment);
	const start = lead ? lead[0].length : 0;
	const wordMatch = /\S+/.exec(segment.slice(start));
	if (!wordMatch) return null;
	const raw = wordMatch[0];
	if (!raw) return null;
	const verb = dcNormalizeVerbWord(raw);
	let cmp = caseInsensitive ? verb.toLowerCase() : verb;
	if (!cmp) return null;
	if (!verbs.includes(cmp)) {
		// The cmd.exe gate arms historically matched an optional `.exe`
		// suffix (`rmdir(?:\.exe)?`); keep that for BARE spellings — Git Bash
		// resolves `del.exe`/`rm.exe` to the same programs (ground truth:
		// `rm.exe FILE` deletes). The strip also applies to POSIX-absolute
		// basenames (`/bin/rm.exe` → `rm`): dcNormalizeVerbWord strips the
		// extension only for WIN32 absolutes, so this fallback re-adds it
		// for the POSIX spellings — an over-match in the DENY direction,
		// deliberately accepted (comment and code agree per the #3539
		// review).
		const stripped = cmp.replace(/\.[Ee][Xx][Ee]$/, '');
		if (!stripped || !verbs.includes(stripped)) return null;
		cmp = stripped;
	}
	return { verb: cmp, rest: segment.slice(start + raw.length) };
}

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
	// #3570: a pair whose FIRST quote is backslash-ESCAPED can never be an
	// empty-string splice — in POSIX shell an odd-length backslash run before
	// a quote means the quote is a literal (escaped) character, so the pair is
	// part of the standard '\'' embed-a-quote idiom (close, escaped quote,
	// reopen). Collapsing such pairs corrupted nested `sh -c` chains: the
	// splice '\'' degraded to '\' and the downstream unwrap truncated the
	// payload to its first word (executed probe: `sh -c 'sh -c "sh -c
	// '\''rm -rf ../../outside'\''"'` normalized to a bare `rm` and admitted
	// through the real gate while real bash executed the full payload). An
	// EVEN-length backslash run (e.g. \\'' — escaped backslash, then a real
	// empty pair) still collapses. This step runs on raw pre-parse text, so
	// the parity rule is the correct state-independent discriminator here.
	s = collapseUnescapedQuotePairs(s, '"');
	s = collapseUnescapedQuotePairs(s, "'");

	return s;
}

/**
 * #3570: collapse adjacent `qq` pairs EXCEPT pairs whose first quote is
 * preceded by an odd number of consecutive backslashes (an escaped literal
 * quote — the `'\''` splice family). Implemented with an index-walking
 * replacer instead of a variable-length lookbehind (engine-portable).
 */
function collapseUnescapedQuotePairs(s: string, quote: string): string {
	let out = '';
	let i = 0;
	while (i < s.length) {
		if (s[i] === quote && s[i + 1] === quote) {
			// Count the backslash run immediately before this pair's first quote.
			let run = 0;
			let j = i - 1;
			while (j >= 0 && s[j] === '\\') {
				run += 1;
				j -= 1;
			}
			if (run % 2 === 1) {
				// Escaped quote — keep both characters verbatim.
				out += s[i] + (s[i + 1] ?? '');
				i += 2;
				continue;
			}
			// Real empty-string splice — drop the pair.
			i += 2;
			continue;
		}
		out += s[i];
		i += 1;
	}
	return out;
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
	// write inside it).
	// #3491 W4: the payload is the single quote-removed word the `-c` flag
	// selects (sh's argv[2] contract — the FIRST NON-OPTION word: option
	// parsing CONTINUES past -c, `bash -c '-e' 'code'` runs the second word,
	// and `--`/`-` hand the next operand to the command string; the tail
	// letters are MORE OPTIONS, and bash has NO tail-glued payload spelling —
	// `bash -c'code'` is rc=1 invalid option, fix-round-3 ground truth),
	// extracted by the shared tokenizer — a trailing positional (`sh -c
	// 'payload' sh`) and same-kind quote concatenation (`'\''`) used to
	// defeat the anchored regex and hide every write inside the payload.
	// Words after the payload are $0/$1… and are NEVER scanned as commands.
	// #3491 W4 fix-round-2/4/5: `-c` is honored as a CLUSTER member (`sh -xc`,
	// `bash -lc`, `dash -xc`, `bash -ceu`) or after other arg-consuming flags
	// (`bash -eo pipefail -c`, `bash -c -o pipefail 'code'` — o/O take their
	// next word verbatim; c selects the first non-option word) — via the
	// shared walkShellCommandFlags walk, and the head may be path-qualified
	// (`/bin/sh`). The old anchored `-c`-first regex ADMITTED every cluster
	// spelling while real bash executes the payload (final critic,
	// ground-truthed). An 'uncertain' walk (unknown flag, glued argument,
	// ambiguous multi-arg-taking cluster, long flag after short parsing,
	// pending -c with no operand) keeps the RAW text — no wrapper layer
	// hides the spelling from the detector, and detectInterpreterEval fires
	// on the same uncertainty. A 'script' outcome (script-file operand or
	// `--` without a pending -c) is not a payload wrapper and falls through
	// to the remaining unwrap rules.
	const shellHead = /^(\S+)\s+([\s\S]+)$/i.exec(t);
	if (shellHead) {
		const shellBase = basenameAnySepLike(shellHead[1]);
		if (
			shellBase === 'bash' ||
			shellBase === 'sh' ||
			shellBase === 'zsh' ||
			shellBase === 'dash'
		) {
			const walk = walkShellCommandFlags(shellSplitWords(shellHead[2]));
			if (walk.kind === 'payload' && walk.payload.trim() !== '') {
				return walk.payload;
			}
			if (walk.kind === 'uncertain') return t;
		} else if (shellBase === 'fish') {
			// fish does not cluster flags and spells the payload only as the
			// plain `-c` token: keep exactly that historical contract (now
			// with a path-qualified head); any other fish shape falls through.
			const fishWords = shellSplitWords(shellHead[2]);
			if (fishWords[0] === '-c' && fishWords.length > 1) {
				const payload = fishWords[1];
				if (payload !== undefined && payload.trim() !== '') return payload;
			}
		}
	}

	// eval 'inner' / eval "inner" / eval inner — the POSIX builtin executes its
	// argument as a command, so it must be unwrapped like other wrappers or a
	// destructive/write command hidden inside `eval` slips past every matcher
	// (issue #1778 H3). Case-insensitive for obfuscation parity.
	const evalMatch = /^eval\s+(.+)$/is.exec(t);
	if (evalMatch) return evalMatch[1].replace(/^["']|["']$/g, '').trim();

	// sudo / env VAR=val / time / nohup / nice: strip the leading word plus
	// the launcher's OWN option region (#3491 W3 — per-manual grammar from
	// the shared walkLauncherOptions table; the old bare-word regexes left
	// option words in verb position: `sudo -u root rmdir …` analyzed `-u`).
	// Case-insensitive: SUDO, TIME, NOHUP, NICE are valid spellings. Benign
	// query forms (sudo -l/-v/-V, bare-option no-run shapes) return null —
	// no unwrap, nothing executes; deny-on-uncertainty shapes return the
	// potential execution tail so every detector sees it (the gate ALSO
	// denies through dcAnalyzeLauncherUncertainty).
	// #3343: the env strip must consume env's OWN flags before the payload —
	// argument-less flags (-i, --ignore-environment, any short flag), arg-taking
	// flags WITH their separate argument (-u/-U/-C/-S/--split-string + one
	// word), and VAR=VALUE assignments — or `env -u FOO python -c …` unwraps
	// to `-u FOO python -c …`, whose `-u` command word detects no writes, and
	// the gate would evaluate the (worse) unwrapped analysis instead of the
	// primary one (impl-review r3 finding 2).
	const envPrefix =
		/^env(?:\s+(?:[A-Za-z_][A-Za-z0-9_]*=\S+|(?:-[i0vVh]*[uUCSaP]|--u(?:n(?:s(?:e(?:t)?)?)?)?|--c(?:h(?:d(?:i(?:r)?)?)?)?|--a(?:r(?:g(?:v(?:0)?)?)?)?|--s(?:p(?:l(?:i(?:t(?:-(?:s(?:t(?:r(?:i(?:n(?:g)?)?)?)?)?)?)?)?)?)?)?|--e(?:n(?:v(?:0(?:-(?:f(?:r(?:o(?:m)?)?)?)?)?)?)?)?)\s+\S+|-\S+|--[A-Za-z][A-Za-z0-9-]*))*\s+(.+)$/is;
	// #3572 N-29: env -S/--split-string RE-PARSES its payload as a command
	// line — consuming `-S <payload>` as flag-args MANGLED the detection
	// command and hid the whole payload family from both arms. Walk env's
	// words (quote-aware), splice the -S payload words in place of the
	// flag, and unwrap to the reconstructed command.
	const envWords = shellSplitWords(t);
	if (
		envWords.length > 0 &&
		basenameAnySepLike(envWords[0] as string) === 'env'
	) {
		let cursor = 1;
		let spliced = false;
		while (cursor < envWords.length) {
			const token = envWords[cursor] as string;
			if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
				cursor += 1;
				continue;
			}
			// #3572 review (delta): the GLUED `--split-string=VALUE` long form
			// is GNU-getopt-legal and was silently consumed as an env flag.
			const gluedSplit =
				token.startsWith('--split-string=') && token.length > 15
					? token.slice('--split-string='.length)
					: undefined;
			if (
				token === '-S' ||
				token === '--split-string' ||
				gluedSplit !== undefined
			) {
				const payload = gluedSplit ?? envWords[cursor + 1];
				if (payload === undefined) break;
				const splitWords = shellSplitWords(payload);
				if (
					splitWords.some(
						(x) =>
							x === '-S' ||
							x === '--split-string' ||
							x.startsWith('--split-string='),
					)
				) {
					break; // nested split-string: keep the raw text (fail closed)
				}
				if (gluedSplit !== undefined) {
					// The payload is INSIDE the token: splice the serialized
					// words and drop only the flag token itself.
					envWords.splice(cursor, 1, shSerializeWords(splitWords));
				} else {
					// Review Critical: a bare-space join destroyed the
					// `sh -c "script"` quote grouping the shell-wrapper walk
					// depends on — splice the serialized form instead.
					envWords.splice(cursor, 2, shSerializeWords(splitWords));
				}
				spliced = true;
				// Do NOT advance cursor: the spliced payload words are
				// re-examined in place (the payload may itself start with
				// env flags or another wrapper).
				continue;
			}
			if (token.startsWith('--') && token.includes('=') && token.length > 3) {
				cursor += 1;
				continue;
			}
			if (token.startsWith('-') && token !== '-') {
				cursor += 1;
				if (
					/^-[i0vVh]*[uUCSaP]$/i.test(token) &&
					cursor < envWords.length &&
					!/^[A-Za-z_][A-Za-z0-9_]*=/.test(envWords[cursor] as string)
				) {
					cursor += 1;
				}
				continue;
			}
			break;
		}
		if (spliced) {
			const tail = envWords.slice(cursor).join(' ');
			if (tail.trim() !== '') return tail.trim();
		}
	}
	// #3475/#3474: execution-form launcher and process-modifier prefixes.
	// `command -v`/`-V` (standalone or glued into a short cluster) are QUERY
	// forms and are deliberately NOT unwrapped — unwrapping would fabricate a
	// write out of a read-only lookup (plan-critic r2 B3); the same
	// execution-only rule the detector-level canonical walk applies.
	const launcherInner = dcStripExecutionLauncher(t);
	const prefixMatch =
		dcStripLauncherWrapper(t) ??
		envPrefix.exec(t) ??
		(launcherInner !== null && launcherInner !== ''
			? [t, launcherInner]
			: null);
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
 * Strip one launcher wrapper layer (#3491 W3) through the shared per-manual
 * option table (walkLauncherOptions): sudo(8)/time (bash-keyword vs GNU
 * binary by spelling)/nice/nohup. Returns `[original, inner]` (regex-match
 * shape) when an execution tail exists — on deny-on-uncertainty the tail is
 * the REMAINING words after the unknown option ("every remaining word is a
 * potential execution tail") — and null for benign/query forms (sudo -l/-v/
 * -V alone, option-only no-run shapes, sudo -e whose operands are
 * write-class, not an execution tail).
 */
function dcStripLauncherWrapper(t: string): [string, string] | null {
	// Offset-aware split: the returned tail is the RAW text slice from the
	// first execution-tail word — byte-identical to the legacy regex's `(.+)`
	// capture, so Windows backslash spellings survive to the cmd/PS grammar
	// arms (quote-removed re-serialization would mangle `C:\target`).
	const words = shellSplitWordsWithOffsets(t);
	const first = words[0];
	if (first === undefined) return null;
	const walk = walkLauncherOptions(
		first.word,
		words.slice(1).map((w) => w.word),
		first.raw,
	);
	if (walk === null) return null;
	if (walk.kind === 'inner') {
		// #3572 N-02: GNU `time -o FILE` keeps the segment WHOLE here —
		// unwrapping to the timed tail would drop the launcher context the
		// cd-tracking model uses to resolve relative operands (`cd src &&
		// /usr/bin/time -o ok.txt true` would resolve ok.txt at the workspace
		// ROOT instead of the tracked src/). The timed command is instead
		// surfaced to the destructive arms by {@link dcLauncherTimedTail},
		// which the gate pushes as an extra 'uncertain' occurrence.
		if (walk.timeOutputFile !== undefined) return null;
		const tail = words[1 + walk.innerIndex];
		if (tail === undefined) return null;
		return [t, t.slice(tail.start).trim()];
	}
	if (walk.kind === 'uncertain') {
		const tail = words[1 + walk.tailIndex];
		if (tail === undefined) return null;
		return [t, t.slice(tail.start).trim()];
	}
	return null;
}

/**
 * Count consecutive `sh -c` shell layers in a command chain (#3570) using
 * WORD-RECURSING extraction: every level's payload is the quote-removed
 * word the `-c` flag selects, so same-kind quote concatenation and
 * alternating quote kinds cannot degrade the count across levels the way
 * the iterative text unwrap does. Returns the layer count (the withdrawal
 * decision itself compares the iterative product's token shape, not this
 * walk's payload).
 */
function dcShellChainAnalysis(text: string): {
	layers: number;
} {
	let layers = 0;
	let cur = text.trim();
	for (let hop = 0; hop < 8; hop++) {
		// Tokenize the WHOLE current level first: the head may itself be
		// quoted (`'sh'`) and a raw-span payload always is — matching on the
		// quote-removed word keeps the count faithful at every level.
		const toks = shellSplitWordsWithOffsets(cur);
		if (toks.length === 0) break;
		const headTok = toks[0];
		if (
			!headTok ||
			!['bash', 'sh', 'zsh', 'dash'].includes(basenameAnySepLike(headTok.word))
		) {
			break;
		}
		const walk = walkShellCommandFlags(toks.slice(1).map((t) => t.word));
		if (walk.kind !== 'payload' || walk.payload.trim() === '') break;
		// Map the payload word back to its token (first whose quote-removed
		// word equals the payload — the walk selects the first non-option
		// word, so index order preserves the mapping) and recurse on the
		// WORD: a nested chain rides inside ONE quoted argument, so the next
		// level's `sh -c` head is visible only after quote removal. Re-parse
		// degradation can only UNDERCOUNT layers (degraded text stops looking
		// shell-shaped), which falls through to the unwrap's own verdicts —
		// it can never over-deny.
		const tok = toks.slice(1).find((t) => t.word === walk.payload);
		if (!tok) break;
		layers += 1;
		cur = tok.word;
	}
	return { layers };
}

/** #3570: three or more nested `sh -c` layers is the withdrawal-review
 * threshold — such a chain withdraws fail-closed only when its iterative
 * unwrap product contains NO LITERAL SPACE (the truncation signature);
 * multi-token products keep their normal verdicts (levels 1-2 always
 * do). */
const DC_SH_C_WITHDRAW_LAYERS = 3;
/** Human-readable label for the withdrawal threshold (deny message). */
export const DC_SH_C_WITHDRAW_LAYERS_LABEL = '3';

/**
 * Recursively unwrap all shell wrappers (#3491 W3): cursor-bounded loop (no
 * fixed cap — every iteration consumes at least the wrapper word, so `sudo`x6
 * and `command`x14 reach their verbs) with the paranoid absolute bound
 * {@link DC_UNWRAP_PARANOID_BOUND}, whose exceedance is reported through the
 * additive `depthExceeded` flag the gate and explain consult BEFORE any
 * no-write early return (fail closed). The legacy string signature is kept
 * for every existing caller.
 *
 * #3570 (4.5 r3 narrowing): a chain nesting >= 3 `sh -c` layers withdraws
 * ONLY on the truncation signature — the iterative unwrap's product
 * contains no literal space (`shCWithdrawal: true`; same-kind and
 * 4-level quote structures degrade this way). Multi-token products keep
 * normal verdicts: escaping payloads reach the verb arms and deny naming
 * the real target, and in-scope 3-level writes ADMIT. Levels 1-2 are
 * untouched.
 */
export function dcUnwrapWrappersBounded(cmd: string): {
	command: string;
	depthExceeded: boolean;
	shCWithdrawal?: boolean;
} {
	const chain = dcShellChainAnalysis(cmd);
	const iterative = dcUnwrapWrappersIterative(cmd);
	if (iterative.boundExceeded) {
		return { command: iterative.command, depthExceeded: true };
	}
	if (
		chain.layers >= DC_SH_C_WITHDRAW_LAYERS &&
		!iterative.command.trim().includes(' ')
	) {
		// 4.5 r2 narrowing (reviewer-proven): withdraw ONLY the truncation
		// signature — the iterative product collapsed to a SINGLE token
		// while a real multi-word payload hides inside the chain. Chains
		// whose iterative product kept their tokens keep normal verdicts:
		// escaping payloads reach the verb arms (deny on the real target)
		// and in-scope 3-level writes ADMIT.
		return { command: cmd.trim(), depthExceeded: true, shCWithdrawal: true };
	}
	return { command: iterative.command, depthExceeded: false };
}

/** The legacy iterative unwrap loop (paranoid bound reported, no sh-c logic). */
function dcUnwrapWrappersIterative(cmd: string): {
	command: string;
	boundExceeded: boolean;
} {
	let current = cmd.trim();
	for (let depth = 0; ; depth++) {
		if (depth >= DC_UNWRAP_PARANOID_BOUND) {
			return { command: current, boundExceeded: true };
		}
		const inner = dcStripOneWrapper(current);
		if (inner === null || inner === current) break;
		current = inner.trim();
	}
	return { command: current, boundExceeded: false };
}

/**
 * Legacy string form of {@link dcUnwrapWrappersBounded} (depth flag dropped).
 */
export function dcUnwrapWrappers(cmd: string): string {
	return dcUnwrapWrappersBounded(cmd).command;
}

/**
 * #3572 N-02: when a GNU `time -o FILE` launcher holds a segment, the strip
 * side keeps the segment whole ({@link dcStripLauncherWrapper} returns null —
 * unwrapping would erase the cd-tracking context that resolves the -o target
 * and the timed command's relative operands), so the timed command text is
 * invisible to every verb-anchored destructive arm. This helper surfaces that
 * tail (`time -o ok.txt rm -rf ../out` → `rm -rf ../out`) so the gate can
 * push it as an additional 'uncertain' occurrence — the same role as the
 * procsub span-body push. Returns null when the segment holds no timed tail.
 */
export function dcLauncherTimedTail(segment: string): string | null {
	const words = shellSplitWordsWithOffsets(segment);
	const head = words[0];
	if (head === undefined) return null;
	const walk = walkLauncherOptions(
		head.word,
		words.slice(1).map((w) => w.word),
		head.raw,
	);
	if (
		walk !== null &&
		walk.kind === 'inner' &&
		walk.timeOutputFile !== undefined
	) {
		const tail = words[1 + walk.innerIndex];
		if (tail === undefined) return null;
		return segment.slice(tail.start).trim();
	}
	return null;
}

/**
 * Deny-on-uncertainty report for launcher segments (#3491 W3): any segment
 * whose sudo/time/nice/nohup option region contains an UNKNOWN option with a
 * remaining execution tail, or an interactive `sudo -i`/`-s` with no command
 * word. The gate (destructive arm AND write path) and the explain mirror
 * consult this and deny — the advisory alone was ruled insufficient by the
 * plan critic; the recorded decision is deny-on-uncertainty.
 */
export function dcAnalyzeLauncherUncertainty(command: string): {
	deny: boolean;
	reason: string;
} {
	for (const segment of dcSplitSegments(command)) {
		// #3572 review N-25: the uncertainty channel must see THROUGH the
		// transparent env/command/builtin/exec heads it also strips elsewhere
		// — `env -i sudo -i` skipped the channel while its bare twin denied.
		// Unwrap only those transparent heads (bounded), then walk.
		let seg = segment;
		// #3572 review (delta): the hop bound is the shared paranoid unwrap
		// bound — 8 transparent heads were machine-generatable and left
		// `env`×9 + `sudo -i` admitted; beyond this bound the shared
		// dcUnwrapWrappersBounded depthExceeded channel denies anyway.
		for (let hop = 0; hop < DC_UNWRAP_PARANOID_BOUND; hop += 1) {
			const probe = shellSplitWordsWithOffsets(seg);
			const probeHead = probe[0];
			if (probeHead === undefined) break;
			const probeBase = basenameAnySepLike(probeHead.word);
			if (
				probeBase !== 'env' &&
				probeBase !== 'command' &&
				probeBase !== 'builtin' &&
				probeBase !== 'exec'
			) {
				break;
			}
			const inner = dcStripOneWrapper(seg);
			if (inner === null || inner === seg) break;
			seg = inner.trim();
		}
		const words = shellSplitWordsWithOffsets(seg);
		const head = words[0];
		if (head === undefined) continue;
		// #3588 item 2 (Fix 3): a launcher walk whose execution tail HEADS
		// with another launcher is re-walked in a bounded loop — mirroring the
		// detector's hop loop (Fix 2) on the deny channel. `sudo sudo -i`,
		// `sudo FOO=bar sudo -i`, `nice sudo -i` and `nice sudo -z true`
		// previously stopped at the outer 'inner' outcome and never reached
		// the inner deny. Each hop consumes at least the tail head word, so
		// the DC_UNWRAP_PARANOID_BOUND loop is structurally terminating; a
		// NON-launcher tail head stops the re-walk (transparent env/command/
		// builtin/exec heads were already stripped above).
		let hopWords = words;
		let hopHead = head;
		for (let hop = 0; hop < DC_UNWRAP_PARANOID_BOUND; hop += 1) {
			const walk = walkLauncherOptions(
				hopHead.word,
				hopWords.slice(1).map((w) => w.word),
				hopHead.raw,
			);
			if (walk === null) break;
			// #3491 closure F-5(d): `hopHead` is an offset-splitter entry —
			// render its WORD, not the object (the critic's `[object Object]`
			// defect).
			if (walk.kind === 'interactive') {
				return {
					deny: true,
					// #3572 review N-26: the launcher word is untrusted source
					// text — sanitize control characters and bound its length
					// before it reaches the operator-facing denial (and the
					// explain mirror).
					reason: `BLOCKED: launcher "${sanitizeDiagnosticText(hopHead.word, 160)}" opens an interactive shell (-i/-s) that cannot be statically inspected`,
				};
			}
			if (walk.kind === 'uncertain' && walk.tailIndex < hopWords.length - 1) {
				return {
					deny: true,
					// #3572 review N-26: same untrusted-word channel as above.
					reason: `BLOCKED: launcher "${sanitizeDiagnosticText(hopHead.word, 160)}" carries an unrecognized option — every remaining word is a potential execution tail (deny-on-uncertainty)`,
				};
			}
			if (walk.kind !== 'inner') break;
			const tailHead = hopWords[1 + walk.innerIndex];
			if (tailHead === undefined) break;
			const tailBase = basenameAnySepLike(tailHead.word);
			if (
				tailBase !== 'sudo' &&
				tailBase !== 'time' &&
				tailBase !== 'nice' &&
				tailBase !== 'nohup'
			) {
				break;
			}
			hopWords = hopWords.slice(1 + walk.innerIndex);
			hopHead = hopWords[0] ?? tailHead;
		}
	}
	return { deny: false, reason: '' };
}

// ============================================================================
// Child-scoped chdir wrapper transform (#3491 W2)
// ============================================================================

/** Rewrite/nesting bound for the chdir transform (mirrors DC_MAX_UNWRAP_DEPTH). */
const DC_CHDIR_REWRITE_MAX_DEPTH = 5;

/**
 * File-target redirect operator WORDS (fd-prefixed N>/N>>, clobber >|,
 * stdout+stderr &>/&>>, read-write <>, plain >/>>) as the wrapper-rewrite
 * redirect hoist recognizes them.
 */
const DC_FILE_REDIRECT_OP = /^(?:\d*(?:>|>>|>\|)|<>|&>|&>>)$/;

/** Payload text GNU env -S would expand or unescape at run time. */
const DC_ENV_SPLIT_DYNAMIC = /[$`\\]/;

/**
 * #3616 D5: env flags that provably cannot change the working directory or
 * re-split the command line — the ONLY flags the launcher peel in
 * matchChdirWrapperSegment may step over (`-u`/`--unset` consume one word).
 * Everything else (`-C`, `-S`, `--chdir`, `--split-string`, clusters, BSD
 * `-P`, unknown flags) keeps `env` as the chdir-wrapper head.
 */
const ENV_PEELABLE_FLAGS = new Set([
	// No lone `-` here: it is env's -i alias, and the walk in
	// matchEnvChdir consumes it (keeping env as the head so the command
	// after it is re-emitted for judgment).
	'--',
	'-i',
	'--ignore-environment',
	'-0',
	'--null',
	'-v',
	'--debug',
	'-u',
	'--unset',
]);

/** env short flags whose argument may ride INSIDE the token (`-Cdir`). */
const ENV_SHORT_ARG_CHARS = new Set(['u', 'U', 'C', 'S', 'a', 'P']);

/**
 * A chdir-bearing wrapper segment match (#3491 W2): `env [-flags] -C DIR
 * cmd…` (including the GNU `-S`/`--split-string` form whose split argv
 * carries a `-C`) or `sudo [-D DIR | --chdir DIR | --chdir=DIR] cmd…`.
 *
 * - `static`: DIR is a literal, serializable directory; `innerWords` are the
 *   quote-removed words of the wrapped command.
 * - `uncertain`: DIR is expansion-bearing or dynamic ($VAR, ${…}, ~,
 *   backticks, $(…), globs, %VAR%) — NEVER serialized; the caller withdraws.
 * - `failClosed`: DIR is empty or contains NUL, or the wrapper shape is too
 *   ambiguous to model — the caller fails closed.
 * - null: not a chdir-bearing wrapper segment (legacy unwrap path).
 */
type DcChdirMatch =
	| {
			kind: 'static';
			dir: string;
			innerWords: string[];
			/**
			 * #3572 delta: the pre-serialized inner subshell text when the
			 * first inner word must keep a NON-PLAIN spelling (the nested
			 * GNU `time` word is emitted quoted so the re-detection selects
			 * the binary grammar instead of the bash keyword) — shSerializeWords
			 * would double-escape it.
			 */
			chdirInnerText?: string;
	  }
	| { kind: 'uncertain'; innerWords: string[] }
	| { kind: 'failClosed' }
	| null;

/** Word starts with `~` or holds any expansion/glob construct. */
function dcIsDynamicChdirOperand(dir: string): boolean {
	if (dir.startsWith('~')) return true;
	if (/[$`]/.test(dir)) return true;
	if (/[*?[\]]/.test(dir)) return true;
	if (/%[^%\s]+%/.test(dir)) return true;
	return false;
}

/** Basename of a possibly path-qualified, possibly .exe-suffixed spelling. */
function basenameAnySepLike(word: string): string {
	const base = word.split(/[\\/]/).pop() ?? word;
	return base.replace(/\.exe$/i, '').toLowerCase();
}

/**
 * Match one chdir-bearing env/sudo wrapper segment. The env walk mirrors the
 * envPrefix/envFlag grammar: VAR=VALUE assignments, argument-less flags,
 * arg-taking flags with their separate argument, attached `-C<dir>` /
 * `--chdir=<dir>` spellings, and the `-S`/`--split-string` payload whose
 * GNU-split argv is scanned for the chdir. The sudo walk models ONLY the
 * -D/--chdir chdir options — any other dash option bails to null (its arity
 * table is the W3 launcher workstream).
 */
function matchChdirWrapperSegment(segment: string): DcChdirMatch {
	const trimmed = segment.trim();
	if (trimmed === '') return null;
	const words = shellSplitWords(trimmed);
	if (words.length === 0) return null;
	// #3567 review P-F3: an unquoted $(...) command substitution SPLITS into
	// fragments (the quote-removal tokenizer is not a shell grammar), so the
	// wrapper walk would consume `$(git` as a literal DIR and serialize a
	// mangled rewrite the parser then rejects. Fail closed instead — the
	// operand is dynamic and the existing uncertain channel is stricter.
	// Reviewer revision: fail closed ONLY for a mangled `$(`-headed word in
	// the FLAG REGION (before the first plain word) — a substitution in the
	// WRAPPED COMMAND's own arguments (`env -C src echo $(date) > out`) is
	// ordinary shell and must keep flowing (the hoisted redirect resolves it).
	let head = basenameAnySepLike(words[0]);
	// #3616 D5 (item 5): a launcher prefix (time/nice/nohup — and env, whose
	// own flags/assignments are peeled with the same grammar as the env walk)
	// hides the chdir-bearing head from the rewrite. Peel one launcher word
	// at a time and RETRY: `time sudo -D /etc tee …` must reach
	// matchSudoChdir exactly like its plain twin. A `bash -c "sudo -D …"`
	// payload reaches this function as the unquoted inner text (the
	// preprocessing splices the payload as a parenthesized subshell), so the
	// same retry covers it. Bounded: each peel consumes at least one word.
	const peeledHead = dcPeelLauncherWords(words, true);
	if (peeledHead === null) return null;
	head = peeledHead;
	if (head !== 'env' && head !== 'sudo') return null;
	// Flag-region scan runs ONLY for wrapper heads — the nested re-walk of a
	// rewritten payload must never see this check (a $() argument there is
	// ordinary shell).
	const firstPlainWord = (() => {
		for (let idx = 1; idx < words.length; idx += 1) {
			const w = words[idx] as string;
			if (w.startsWith('-')) continue;
			if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) continue;
			if (w.startsWith('$(') || w.startsWith('`')) continue;
			return idx;
		}
		return words.length;
	})();
	// Backticks mangle the same way $() fragments do (the tokenizer consumes
	// the backtick as a quote char), so a backtick-headed flag-region word
	// fails closed alongside the $() case (final-critic round).
	if (
		words
			.slice(1, firstPlainWord)
			.some((w) => w.startsWith('$(') || w.startsWith('`'))
	) {
		return { kind: 'failClosed' };
	}
	if (head === 'env') return matchEnvChdir(words);
	return matchSudoChdir(words);
}

/**
 * #3616 (final-critic round 3 (a)): peel leading launcher words — time/
 * nice/nohup (their flags; nice -n consumes one word) and env (assignments
 * plus the provably chdir-free flag whitelist) — MUTATING `words` down to
 * the first non-launcher head. Returns the new head's basename, or null
 * when the peel consumed everything. `stopAtEnvFlags` keeps the historical
 * matchChdirWrapperSegment behavior of STOPPING with env as the head on a
 * non-peelable env flag (env is then the chdir wrapper and must be judged);
 * when false (the shell-payload site) the env flag region is simply stepped
 * over because the SHELL, not env, is what we are looking for.
 */
function dcPeelLauncherWords(
	words: string[],
	stopAtEnvFlags: boolean,
): string | null {
	for (;;) {
		const head = basenameAnySepLike(words[0] ?? '');
		if (
			head === 'time' ||
			head === 'nice' ||
			head === 'nohup' ||
			head === 'env'
		) {
			let next = 1;
			if (head === 'time' || head === 'nice' || head === 'nohup') {
				while (next < words.length && (words[next] as string).startsWith('-')) {
					next += 1;
					if (head === 'nice' && (words[next - 1] as string) === '-n')
						next += 1;
				}
			} else {
				while (next < words.length) {
					const w = words[next] as string;
					if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
						next += 1;
						continue;
					}
					if (!w.startsWith('-')) break;
					if (ENV_PEELABLE_FLAGS.has(w) || w.startsWith('--unset=')) {
						next += 1;
						if (w === '-u' || w === '--unset') next += 1;
						continue;
					}
					if (stopAtEnvFlags) return head; // env stays the head
					break;
				}
			}
			if (next >= words.length) return null;
			words.splice(0, next);
			continue;
		}
		// #3616 (review r15 finding 2): at the SHELL-PAYLOAD site only
		// (stopAtEnvFlags false — the chdir matcher keeps routing sudo to
		// matchSudoChdir), a non-chdir sudo prefix is transparent: peel
		// sudo's own option region so `sudo sh -c "sudo -i tee x"` reaches
		// the shell head. Reached only when the chdir matcher already
		// returned null, so a -D/-i sudo never lands here.
		if (head === 'sudo' && !stopAtEnvFlags) {
			const w = walkLauncherOptions(words[0] ?? '', words.slice(1));
			if (w !== null && w.kind === 'inner') {
				words.splice(0, 1 + w.innerIndex);
				continue;
			}
			return null;
		}
		return head;
	}
}

function matchEnvChdir(words: string[]): DcChdirMatch {
	let cursor = 1;
	let dir: string | undefined;
	// Set when the walk consumed a lone `-` (the -i alias) — see the
	// no-chdir exit for why the command must then be re-emitted.
	let dashAliasConsumed = false;
	// GNU/BSD env: a lone `-` is the obsolete spelling of `-i` (an option,
	// not the command word — executed ground truth: `env -S '-' CMD` runs
	// CMD with the environment cleared). Translate it when re-emitting
	// option words so downstream peels only ever see canonical flags.
	const dashAlias = (w: string): string => (w === '-' ? '-i' : w);
	// #3616 F1 (final-critic round 2): GNU env (and BSD -S) splits the
	// -S/--split-string payload into argv and processes those words as its
	// own arguments in place of the option — for EVERY spelling (exact
	// separate/glued, unambiguous abbreviation, cluster-last, glued cluster
	// `-SPAYLOAD`). Each spelling recurses through this one path; a nested
	// split spelling inside a payload fails closed. A chdir captured BEFORE
	// the split option carries into the payload walk. When no chdir is found
	// the split is an argv SPLICE (env's getopt stops at the first
	// non-option word, so words after a payload command are that command's
	// arguments):
	// - with NOTHING after the split option, the canonical single-argument
	//   form `env -S 'P'` is exact for any payload — the write detector's own
	//   env arm splits it as literal argv (a payload `>` stays a literal
	//   argument, exactly as env passes it) and refuses dynamic payload
	//   words — so a non-canonical spelling is rewritten to it;
	// - with words AFTER it, a literal payload is spliced into the plain form
	//   `env PRE… PAYLOAD-WORDS… POST…` — `env -S '' CMD…` IS `env CMD…`, and
	//   `env -S sh -c SCRIPT` IS `env sh -c SCRIPT` — so the ordinary env
	//   walk judges the command; a payload env would EXPAND or unescape at
	//   run time (`$`, backtick, backslash), or one carrying a literal
	//   redirect-operator word, cannot be spliced faithfully and fails
	//   closed.
	// Words before the split option (assignments, flags) are preserved in
	// every rewrite so text-level scans still see them.
	const recurseSplit = (
		payload: string,
		restIndex: number,
		canonical: boolean,
	): DcChdirMatch => {
		const splitWords = shellSplitWords(payload);
		// Only env's own option region (before the command word) can carry
		// a nested split spelling; the wrapped command's flags are its own.
		for (const w of splitWords) {
			if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) continue;
			if (!w.startsWith('-') || w === '-') break;
			if (w === '--') break;
			if (w.startsWith('--s') || /^-[A-Za-z0-9]*S/.test(w)) {
				return { kind: 'failClosed' };
			}
		}
		const after = words.slice(restIndex);
		const pre = words.slice(1, cursor);
		const carried = dir !== undefined ? ['-C', dir] : [];
		const inner = matchEnvChdir(['env', ...carried, ...splitWords, ...after]);
		if (inner !== null) return inner;
		if (after.length === 0) {
			// Nothing follows the split option: the canonical single-argument
			// form is exact for any payload (the detector arm splits it as
			// literal argv and refuses dynamic words).
			if (canonical || splitWords.length === 0) return null;
			return {
				kind: 'static',
				dir: '.',
				innerWords: ['env', ...pre.map(dashAlias), '-S', payload],
			};
		}
		// Words follow the split option: argv splice. A payload env would
		// expand/unescape, or one carrying a literal redirect-operator word
		// (which the redirect hoist could not tell from a real redirect),
		// cannot be represented — fail closed.
		if (
			DC_ENV_SPLIT_DYNAMIC.test(payload) ||
			splitWords.some((w) => DC_FILE_REDIRECT_OP.test(w))
		) {
			return { kind: 'failClosed' };
		}
		// Let this same walk find where the command starts (a forced `-C .`
		// makes it return the command words, or null when nothing runs), and
		// emit `env ASSIGNMENTS… COMMAND…`: env's own option words — `-`
		// (the `-i` alias), `--`, `-u NAME`, … — are consumed here and never
		// re-emitted, so no downstream wrapper peel has to step over them.
		// Assignments are kept so text-level scans still see them.
		const merged = [...splitWords, ...after];
		const forced = matchEnvChdir(['env', '-C', '.', ...merged]);
		if (forced === null) return null; // nothing runs
		if (forced.kind !== 'static' || forced.dir !== '.') return forced;
		const command = forced.innerWords;
		const optionRegion = merged.slice(0, merged.length - command.length);
		if (
			command.length > merged.length ||
			command.some((w, i) => w !== merged[optionRegion.length + i])
		) {
			return { kind: 'failClosed' };
		}
		return {
			kind: 'static',
			dir: '.',
			innerWords: [
				'env',
				...[...pre, ...optionRegion].filter((w) =>
					/^[A-Za-z_][A-Za-z0-9_]*=/.test(w),
				),
				...command,
			],
		};
	};
	while (cursor < words.length) {
		const token = words[cursor];
		if (token === undefined) break;
		if (token === '-') {
			// The -i alias (see dashAlias): an option, never the command.
			dashAliasConsumed = true;
			cursor += 1;
			continue;
		}
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
			cursor += 1;
			continue;
		}
		if (token.startsWith('--')) {
			if (token === '--chdir') {
				const arg = words[cursor + 1];
				if (arg === undefined) return { kind: 'failClosed' };
				dir = arg;
				cursor += 2;
				continue;
			}
			const glued = /^--chdir=(.*)$/.exec(token);
			if (glued) {
				dir = glued[1];
				cursor += 1;
				continue;
			}
			if (token === '--split-string') {
				const arg = words[cursor + 1];
				if (arg === undefined) return { kind: 'failClosed' };
				return recurseSplit(arg, cursor + 2, false);
			}
			// Other long flags: arg-taking when unambiguously abbreviating one
			// (mirrors envFlagConsumesNextWord); otherwise argument-less.
			const argTaking = [
				'--unset',
				'--chdir',
				'--split-string',
				'--argv0',
				'--env0-from',
			];
			// #3567 review P-R1: GNU env resolves abbreviations (`--c`,
			// `--ch`, `--chd`…) and accepts a GLUED value (`--ch=DIR`); the
			// old walk consumed both shapes without capturing the directory,
			// so `env --ch src cmd` chdir'd outside the model.
			const eq = token.indexOf('=');
			if (eq > 2) {
				const abbrev = `--${token.slice(2, eq)}`;
				const gluedMatch = argTaking.filter((flag) => flag.startsWith(abbrev));
				if (
					abbrev.length >= 3 &&
					gluedMatch.length === 1 &&
					gluedMatch[0] === '--chdir'
				) {
					dir = token.slice(eq + 1);
					cursor += 1;
					continue;
				}
				if (
					abbrev.length >= 3 &&
					gluedMatch.length === 1 &&
					gluedMatch[0] === '--split-string'
				) {
					// `--split-string=P` and abbreviations `--split=P`/`--spl=P`.
					return recurseSplit(token.slice(eq + 1), cursor + 1, false);
				}
				if (abbrev.length >= 3 && gluedMatch.length === 1) {
					cursor += 1;
					continue;
				}
			}
			const unambiguous = argTaking.filter((flag) => flag.startsWith(token));
			if (token.length >= 3 && unambiguous.length === 1) {
				if (unambiguous[0] === '--chdir') {
					const arg = words[cursor + 1];
					if (arg === undefined) return { kind: 'failClosed' };
					dir = arg;
				}
				if (unambiguous[0] === '--split-string') {
					// Separate-argument abbreviation `--split P` / `--s P`.
					const arg = words[cursor + 1];
					if (arg === undefined) return { kind: 'failClosed' };
					return recurseSplit(arg, cursor + 2, false);
				}
				cursor += 2;
				continue;
			}
			cursor += 1;
			continue;
		}
		if (token.startsWith('-') && token !== '-') {
			if (token === '-C') {
				const arg = words[cursor + 1];
				if (arg === undefined) return { kind: 'failClosed' };
				dir = arg;
				cursor += 2;
				continue;
			}
			const glued = /^-C(.+)$/.exec(token);
			if (glued) {
				dir = glued[1];
				cursor += 1;
				continue;
			}
			const chars = token.slice(1).split('');
			const firstArgIndex = chars.findIndex((c) => ENV_SHORT_ARG_CHARS.has(c));
			if (
				firstArgIndex !== -1 &&
				chars.slice(0, firstArgIndex).every((c) => 'i0vVh'.includes(c))
			) {
				// Cluster whose FIRST arg-taking member either is last (its
				// argument is the NEXT word) or swallows the token's tail.
				if (firstArgIndex === chars.length - 1) {
					const arg = words[cursor + 1];
					if (arg === undefined) return { kind: 'failClosed' };
					if (chars[firstArgIndex] === 'S') {
						return recurseSplit(arg, cursor + 2, token === '-S');
					}
					if (chars[firstArgIndex] === 'C') dir = arg;
					cursor += 2;
					continue;
				}
				if (chars[firstArgIndex] === 'S') {
					// Glued cluster payload: `-SPAYLOAD` / `-iSPAYLOAD`.
					return recurseSplit(
						chars.slice(firstArgIndex + 1).join(''),
						cursor + 1,
						false,
					);
				}
				if (chars[firstArgIndex] === 'C') {
					dir = chars.slice(firstArgIndex + 1).join('');
				}
				cursor += 1;
				continue;
			}
			cursor += 1;
			continue;
		}
		break; // the command word
	}
	const rest = words.slice(cursor);
	// A split payload with no chdir needs no rewrite: the detector's own
	// env walk already analyzes it (`env -S 'tee ../x'` is denied at base),
	// and env passes payload text such as `>` through as literal argv.
	if (dir === undefined) {
		// #3616 (review round 8, pre-existing): when the walk consumed a
		// lone `-` (env's -i alias) the legacy envPrefix peel cannot step
		// over it, so the post-`-` command was never judged (`env -u X -
		// sh -c "echo x > ../x"` ADMITTED while real env writes). Re-emit
		// the command the same way the split splice does: env's own option
		// words are dropped (detection-neutral), assignments are kept.
		if (!dashAliasConsumed || rest.length === 0) return null;
		// #3616 (review round 10): a bare `time` command word must keep a
		// NON-PLAIN spelling in the rewrite — unquoted, it re-enters the
		// bash-keyword grammar at the subshell start and the unwrap consumes
		// `-o FILE` as the timed command. Emitted quoted (the #3572 nested-
		// time precedent), the GNU binary grammar analyzes the payload while
		// the dash-aware original analysis still emits the launcher write.
		if (rest[0] === 'time') {
			return {
				kind: 'static',
				dir: '.',
				innerWords: rest,
				chdirInnerText: `${shSingleQuote(rest[0])} ${shSerializeWords(
					rest.slice(1),
				)}`,
			};
		}
		return {
			kind: 'static',
			dir: '.',
			innerWords: [
				'env',
				...words
					.slice(1, cursor)
					.filter((w) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w)),
				...rest,
			],
		};
	}
	if (dir === '' || dir.includes('\0')) return { kind: 'failClosed' };
	if (rest.length === 0) {
		// Chdir with no command: nothing runs — not a wrapper to rewrite.
		return null;
	}
	if (dcIsDynamicChdirOperand(dir)) {
		return { kind: 'uncertain', innerWords: rest };
	}
	return { kind: 'static', dir, innerWords: rest };
}

function matchSudoChdir(words: string[]): DcChdirMatch {
	// #3491 W3: the sudo walk now models the FULL option table
	// (walkLauncherOptions) — every other option (-u/-g/-p/-E/…) is consumed
	// with the right arity while -D/--chdir is captured, instead of bailing
	// to the legacy unwrap on the first non-chdir option.
	const head = words[0];
	if (head === undefined) return null;
	const walk = walkLauncherOptions(head, words.slice(1));
	// #3616 (review r15 finding 3): `-i` followed by a shell-looking word
	// classifies as kind 'interactive' (no innerIndex), so the login arm
	// below never sees `sudo -i sh -c 'tee x'`. For that shape run the
	// same withdrawal scan over the raw words (flags skipped; only when a
	// login flag is actually present — `-s` alone maps to 'inner' or
	// benign and must keep its cwd semantics).
	const interactiveTail = (() => {
		if (walk !== null && walk.kind === 'interactive') {
			const hasLoginFlag = words.slice(1).some((w) => {
				if (w === '-i' || w === '--login') return true;
				if (typeof w !== 'string' || !w.startsWith('-') || w.startsWith('--'))
					return false;
				return w.slice(1).includes('i');
			});
			if (hasLoginFlag) return words.slice(1);
		}
		return null;
	})();
	if (walk === null || (walk.kind !== 'inner' && interactiveTail === null))
		return null;
	const dir = walk.kind === 'inner' ? walk.sudoChdir : undefined;
	if (dir === undefined) {
		// #3616 (final-critic round 4 (e)): a LOGIN sudo (`-i`/`--login`)
		// chdirs to the target user's home — unresolvable statically — so a
		// write-bearing tail with a RELATIVE operand must withdraw fail-closed
		// HERE (the shared funnel for direct, launcher-prefixed, env-peeled and
		// shell-payload spellings), or the legacy unwrap strips the sudo words
		// and the detector's D6 withdrawal can never fire (`sh -c "sudo -i
		// tee src/ok"` spliced to `( tee src/ok )`). No-write tails, `-s`
		// tails, and absolute-only tails stay null so the C6 controls keep
		// their exact verdicts.
		if (walk.kind === 'inner' && walk.loginShell === true) {
			const tail = words.slice(1 + (walk.innerIndex ?? 0));
			// Mirrors the detector's D6 set (BUILTIN_WRITE_COMMANDS + tee/dd)
			// — keep in sync with shell-write-detect's loginWriteWords.
			const loginWriteWords = new Set([
				'rm',
				'mv',
				'cp',
				'ln',
				'touch',
				'unlink',
				'rmdir',
				'tee',
				'dd',
				'truncate',
				'install',
			]);
			// A tail word may be a quote-stripped multi-word payload
			// (`tee ../x` from sh -c 'tee ../x') — classify by its FIRST
			// token. A nested shell head (`sudo -i sh -c 'tee …'`) is
			// write-bearing when its payload word is.
			const isShellHeadWord = (word: string): boolean => {
				const tok = word.split(/\s+/)[0] ?? word;
				return (
					tok === 'sh' ||
					tok === 'bash' ||
					tok === 'zsh' ||
					tok === 'dash' ||
					tok.startsWith('ksh')
				);
			};
			const wordBearsWrite = (word: string): boolean => {
				const tok = word.split(/\s+/)[0] ?? word;
				if (loginWriteWords.has(basenameAnySepLike(tok))) return true;
				return /\S?>\S?/.test(word); // glued or bare redirect
			};
			const hasWriteVector = tail.some((word, idx) => {
				if (typeof word !== 'string') return false;
				if (isShellHeadWord(word)) {
					// `sh -c <payload>`: ANY payload is write-bearing
					// (review r16 finding 2) — a compound payload
					// ('cd src && tee ok', 'env tee x') hides the write
					// behind a non-write first token, so the safe
					// direction is unconditional withdrawal; a no-write
					// payload over-denies, disclosed. The payload is
					// located with the SHARED shell flag walk, not a
					// literal next-word `-c` — clustered (`sh -ec`) and
					// ordered (`sh -e -c`) spellings select the same
					// payload (review r17 finding 3).
					const shellWalk = walkShellCommandFlags(tail.slice(idx + 1));
					return (
						shellWalk.kind === 'payload' &&
						typeof shellWalk.payload === 'string'
					);
				}
				if (wordBearsWrite(word)) return true;
				if (idx > 0 && /^[0-9]?>>?$/.test(tail[idx - 1] ?? '')) return true;
				return false;
			});
			// #3616 final-critic round 5: a NESTED GNU time inner word
			// (`sudo -i time -o src/t.txt true`) hides the write in the
			// walk's timeOutputFile — the tail starts past `-o FILE` and
			// carries no write word, so a RELATIVE report file under the
			// login home escaped the withdrawal here too (absolute keeps
			// the ordinary judged path).
			const nestedTimeFile =
				typeof walk.timeOutputFile === 'string' && walk.timeOutputFile !== ''
					? walk.timeOutputFile
					: null;
			const nestedTimeFileRelative =
				nestedTimeFile !== null &&
				!nestedTimeFile.startsWith('/') &&
				!nestedTimeFile.startsWith('~/') &&
				nestedTimeFile !== '~' &&
				!/^[A-Za-z]:[\\/]/.test(nestedTimeFile);
			// Relative-OPERAND check (review r15 finding 4): the command
			// word (idx 0) and flags never count; for the multi-operand
			// copiers only the LAST operand (the write target) counts.
			const copiers = new Set(['cp', 'mv', 'install', 'ln']);
			const isRelativeWord = (word: string): boolean =>
				!word.startsWith('/') &&
				!word.startsWith('~/') &&
				word !== '~' &&
				!/^[A-Za-z]:[\\/]/.test(word) &&
				!word.startsWith('-');
			const commandWord = (tail[0] ?? '').split(/\s+/)[0] ?? '';
			const operandWords = tail
				.slice(1)
				.filter((w) => typeof w === 'string' && !w.startsWith('-'));
			const relevantOperands = copiers.has(basenameAnySepLike(commandWord))
				? operandWords.slice(-1)
				: operandWords;
			const hasRelativeOperand = relevantOperands.some(
				(w) => typeof w === 'string' && isRelativeWord(w),
			);
			if (
				(hasWriteVector || nestedTimeFileRelative) &&
				(hasRelativeOperand || nestedTimeFileRelative) &&
				tail.length > 0
			) {
				return { kind: 'uncertain', innerWords: tail };
			}
		}
		// interactive login tail (finding 3): the same withdrawal scan over
		// the raw words; flags are skipped so `-i` itself never counts as
		// the command word or an operand.
		if (interactiveTail !== null) {
			const tail = interactiveTail;
			const loginWriteWords = new Set([
				'rm',
				'mv',
				'cp',
				'ln',
				'touch',
				'unlink',
				'rmdir',
				'tee',
				'dd',
				'truncate',
				'install',
			]);
			const isShellHeadWord = (word: string): boolean => {
				const tok = word.split(/\s+/)[0] ?? word;
				return (
					tok === 'sh' ||
					tok === 'bash' ||
					tok === 'zsh' ||
					tok === 'dash' ||
					tok.startsWith('ksh')
				);
			};
			const wordBearsWrite = (word: string): boolean => {
				const tok = word.split(/\s+/)[0] ?? word;
				if (loginWriteWords.has(basenameAnySepLike(tok))) return true;
				return /\S?>\S?/.test(word);
			};
			const nonFlag = tail.filter(
				(w) => typeof w === 'string' && !w.startsWith('-'),
			) as string[];
			const hasWriteVector = tail.some((word, idx) => {
				if (typeof word !== 'string' || word.startsWith('-')) return false;
				if (isShellHeadWord(word)) {
					// `sh -c <payload>`: ANY payload is write-bearing
					// (review r16 finding 2) — a compound payload hides
					// the write behind a non-write first token; the safe
					// direction is unconditional withdrawal (a no-write
					// payload over-denies, disclosed). The payload is
					// located with the SHARED shell flag walk so clustered
					// (`sh -ec`) and ordered (`sh -e -c`) spellings select
					// the same payload (review r17 finding 3).
					const shellWalk = walkShellCommandFlags(tail.slice(idx + 1));
					return (
						shellWalk.kind === 'payload' &&
						typeof shellWalk.payload === 'string'
					);
				}
				if (wordBearsWrite(word)) return true;
				if (idx > 0 && /^[0-9]?>>?$/.test(tail[idx - 1] ?? '')) return true;
				return false;
			});
			// The first non-flag word is sudo's COMMAND; operands are the
			// rest (flags skipped, so `-c` never counts).
			const operands = nonFlag.slice(1);
			const hasRelativeOperand = operands.some(
				(w) =>
					!w.startsWith('/') &&
					!w.startsWith('~/') &&
					w !== '~' &&
					!/^[A-Za-z]:[\\/]/.test(w),
			);
			if (hasWriteVector && hasRelativeOperand && operands.length > 0) {
				// innerWords keeps the raw tail FROM THE COMMAND WORD (sudo's
				// own option region skipped) so the serialized `sh -c
				// '<payload>'` survives for detection. The skip consumes
				// EXACTLY what the detector's walkSudoOptions consumes —
				// from the SHARED tables via longFlagTakesArg (exact long
				// names, `=`-glued values, GNU unambiguous prefix
				// abbreviations like `--use root`) and the getopt short
				// cluster rule (the first arg-taking member either is last
				// and takes the next word — `-Eu root` — or swallows the
				// token tail) — never a mirrored list that can drift
				// (review r17 finding 2).
				let start = 0;
				while (start < tail.length) {
					const w = tail[start];
					if (typeof w !== 'string') break;
					// Assignments are interspersed with sudo's options
					// (parse_args.c:284, pinned by the 3572 feedback suite):
					// consume the run and RESUME the option walk — stopping
					// HERE would serialize the option word into command
					// position (`FOO=bar --user root sh -c …` parses `--user`
					// as the command), hiding the write (review r18).
					if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
						start += 1;
						continue;
					}
					if (!w.startsWith('-')) break;
					if (w === '--') {
						start += 1;
						break;
					}
					if (w.startsWith('--')) {
						const arg = longFlagTakesArg(w, SUDO_LONG_ARG_TAKING);
						start += arg.takes && !arg.glued ? 2 : 1;
						continue;
					}
					if (w.length > 1) {
						const members = w.slice(1);
						let skipNext = false;
						for (let m = 0; m < members.length; m++) {
							const ch = members[m];
							if (ch === undefined) break;
							if (SUDO_ARG_TAKING_SHORT.has(ch)) {
								skipNext = m === members.length - 1;
								break;
							}
						}
						start += skipNext ? 2 : 1;
						continue;
					}
					start += 1;
				}
				const inner = tail.slice(start);
				if (inner.length > 0) {
					return { kind: 'uncertain', innerWords: inner };
				}
			}
		}
		return null;
	}
	if (dir === '' || dir.includes('\0')) return { kind: 'failClosed' };
	if (walk.kind !== 'inner') return null; // -D path needs the inner walk
	// #3572 delta: a NESTED GNU `time -o` outcome carries chdirTailIndex —
	// the word index the rewritten subshell must slice from (the `time`
	// word, keeping the timed launcher and its -o operand INSIDE the child
	// cwd); the plain innerIndex points past it at the timed command, which
	// dropped the -o write from the rewrite and falsely denied
	// `sudo -D src time -o ok.txt true`.
	const rest = words.slice(1 + (walk.chdirTailIndex ?? walk.innerIndex));
	if (rest.length === 0) {
		// -D with no command: nothing runs.
		return null;
	}
	if (dcIsDynamicChdirOperand(dir)) {
		return { kind: 'uncertain', innerWords: rest };
	}
	if (walk.chdirTailIndex !== undefined) {
		// The nested time word is bash-QUOTED in the rewritten subshell: a
		// bare `time` at the subshell pipeline start would re-enter the
		// bash-KEYWORD grammar (-o is not a keyword flag) and the -o write
		// would vanish from the re-detection (the union-back then regained
		// the root-resolved emission and falsely denied). Quoted spellings
		// select the GNU grammar (N-03 raw-spelling routing). The inner text
		// is built here because shSerializeWords would double-escape the
		// already-quoted word.
		return {
			kind: 'static',
			dir,
			innerWords: rest,
			chdirInnerText: `${shSingleQuote(rest[0])} ${shSerializeWords(rest.slice(1))}`,
		};
	}
	return { kind: 'static', dir, innerWords: rest };
}

/**
 * The withdrawal-form synthetic cd operand (#3491 W2, fix-round-1 F-1): a
 * single-quoted word the directory-state walk classifies as a DYNAMIC cd
 * operand (`isDynamicPath` — it contains `$…`), so the walk withdraws
 * UNCONDITIONALLY. The first round used `cd -`, whose withdrawal depended on
 * no prior cd having modeled OLDPWD — a preceding `cd src`/`pushd src` made
 * the synthetic `cd -` LAND at OLDPWD and resolve the wrapped writes there
 * (fail-open). Never a real directory: this text exists only inside the
 * generated detection command.
 */
const DC_UNRESOLVED_CHDIR_OPERAND = '$__swarm_unresolved_chdir';

/**
 * The additive structured wrapper-preprocessing result (#3491 W2): the
 * detection command with every chdir-bearing wrapper segment rewritten as a
 * CORRECTLY QUOTED subshell `( cd -- 'DIR' && <re-unwrapped inner> )`, and
 * every other wrapper segment unwrapped exactly as the legacy
 * `dcSplitSegments`+`dcUnwrapWrappers` pipeline did. The subshell form is
 * bash-true for env/sudo child cwd: the wrapped command's writes resolve
 * under the child directory while following siblings stay at the parent
 * directory. A dynamic DIR is never serialized — the segment rewrites to
 * the withdrawal form `( cd '<DC_UNRESOLVED_CHDIR_OPERAND>' && <inner> )`,
 * whose synthetic dynamic operand withdraws every inner write
 * UNCONDITIONALLY (fail-closed, independent of any modeled prevCwd).
 * Nested chdir wrappers compose as nested subshells, so relative child
 * cwds resolve against the parent child cwd.
 */
export interface DcWrapperPreprocess {
	/** Preprocessed command (segments joined by '\n' when anything changed). */
	command: string;
	/** True when any segment was rewritten or unwrapped (the didUnwrap flag). */
	changed: boolean;
	/** True when at least one chdir subshell rewrite happened. */
	rewrote: boolean;
	/** True when a rewrite used the withdrawal form (dynamic DIR). */
	uncertain: boolean;
	/** True when a static DIR was empty/NUL or the shape was unmodellable. */
	failClosed: boolean;
}

function preprocessWrapperText(
	text: string,
	depth: number,
): {
	text: string;
	rewrote: boolean;
	uncertain: boolean;
	failClosed: boolean;
} | null {
	if (depth >= DC_CHDIR_REWRITE_MAX_DEPTH) {
		return { text, rewrote: false, uncertain: false, failClosed: true };
	}
	const match = matchChdirWrapperSegment(text);
	if (match === null) return null;
	if (match.kind === 'failClosed') {
		return { text, rewrote: false, uncertain: false, failClosed: true };
	}
	// #3567 review PRR-008: bash opens a wrapper segment's OWN redirects in
	// the PARENT cwd (`env -C src echo x > f` writes f at the wrapper's
	// caller directory), but serializing the payload as words quoted the
	// `>` operator so the redirect vanished from the rewritten AST and the
	// union-back restored it resolved at the starting cwd. Hoist top-level
	// `>` / `>>` word pairs OUT of the subshell so the rewritten command
	// carries the redirect where bash applies it (the tracked cwd).
	const payloadWords: string[] = [];
	const hoistedRedirects: string[] = [];
	{
		const words = match.innerWords;
		// File-target redirect operators (fd-prefixed N>/N>>, clobber >|,
		// stdout+stderr &>/&>>, read-write <>, and the plain >/>> pair). An
		// fd-DUPLICATION target (2>&1) is not a file and stays inside — bash
		// dups the descriptor, nothing is written.
		const FILE_REDIRECT_OP = DC_FILE_REDIRECT_OP;
		const FD_DUP_TARGET = /^&\d+$/;
		let i = 0;
		while (i < words.length) {
			const w = words[i] as string;
			if (
				FILE_REDIRECT_OP.test(w) &&
				i + 1 < words.length &&
				!FD_DUP_TARGET.test(words[i + 1] as string)
			) {
				hoistedRedirects.push(`${w} ${shSingleQuote(words[i + 1] as string)}`);
				i += 2;
				continue;
			}
			payloadWords.push(w);
			i += 1;
		}
	}
	// #3572 delta: a nested GNU `time` inner word carries a PRE-SERIALIZED
	// inner text (the word is quoted so both the re-detection and the
	// legacy unwrap select the GNU grammar — bare `time` at the subshell
	// pipeline start re-enters the keyword grammar and the unwrap consumes
	// `-o FILE` as the timed command, dropping the write from the rewrite).
	const chdirInnerText =
		match.kind === 'static' ? match.chdirInnerText : undefined;
	const innerRaw = chdirInnerText ?? shSerializeWords(payloadWords);
	const nested = preprocessWrapperText(innerRaw, depth + 1);
	const inner =
		nested !== null
			? nested
			: (() => {
					// #3616 (final-critic round 3 (a)): the inner text may itself
					// be a (launcher-prefixed) shell wrapper whose payload carries
					// a chdir (`'time' sh -c 'env -C .. tee x'` from the dash
					// rewrite). The legacy unwrap strips the wrapper and DISCARDS
					// the chdir — route through the shell-payload recursion first.
					// The recursion's flags ride along (review r17 question 1):
					// a withdrawal inside the payload keeps its `uncertain` on
					// this result, not just the sentinel text.
					const spliced = dcShellPayloadRewrite(
						innerRaw,
						dcUnwrapWrappers(innerRaw),
						depth + 1,
					);
					return {
						text: spliced.text ?? dcUnwrapWrappers(innerRaw),
						rewrote: false,
						uncertain: spliced.uncertain,
						failClosed: spliced.failClosed,
					};
				})();
	const hoistSuffix =
		hoistedRedirects.length > 0 ? ` ${hoistedRedirects.join(' ')}` : '';
	if (match.kind === 'uncertain') {
		return {
			text: `( cd ${shSingleQuote(DC_UNRESOLVED_CHDIR_OPERAND)} && ${inner.text} )${hoistSuffix}`,
			rewrote: true,
			uncertain: true,
			failClosed: inner.failClosed,
		};
	}
	return {
		text: `( cd -- ${shSingleQuote(match.dir)} && ${inner.text} )${hoistSuffix}`,
		rewrote: true,
		uncertain: inner.uncertain,
		failClosed: inner.failClosed,
	};
}

/**
 * Preprocess a command for write-path detection (#3491 W2). Segment order is
 * preserved; only changed commands differ from the input.
 */
/**
 * #3616 (final-critic round 3 (a)): when `text` is a (possibly launcher-
 * prefixed) shell -c wrapper whose flag walk yields a payload, rewrite it as
 * the parenthesized subshell `( <payload analysis> )` — recursing
 * preprocessWrapperText on the ONE-LEVEL payload so a chdir-bearing wrapper
 * inside it (sudo -D / env -C) is rewritten instead of discarded by the
 * legacy unwrap. Returns text null when text is not such a wrapper;
 * `fallback` is the legacy-unwrapped text used when the payload itself has
 * no chdir match (byte-identical to the pre-#3616 behavior). The payload
 * recursion's `uncertain`/`failClosed` flags ride along (review r17,
 * question 1) — a withdrawal inside the payload must reach the caller's
 * DcWrapperPreprocess flags instead of surviving only as the sentinel text.
 */
function dcShellPayloadRewrite(
	text: string,
	fallback: string,
	depth: number,
): { text: string | null; uncertain: boolean; failClosed: boolean } {
	const words = shellSplitWords(text);
	const shellHead = dcPeelLauncherWords(words, false);
	const isShellHead =
		shellHead === 'bash' ||
		shellHead === 'sh' ||
		shellHead === 'zsh' ||
		shellHead === 'dash' ||
		(shellHead ?? '').startsWith('ksh');
	if (!isShellHead) return { text: null, uncertain: false, failClosed: false };
	const payloadWords = words.slice(1);
	const walk = walkShellCommandFlags(payloadWords);
	if (walk.kind !== 'payload')
		return { text: null, uncertain: false, failClosed: false };
	const payloadResult = preprocessWrapperText(walk.payload, depth);
	return {
		text: `( ${payloadResult === null ? fallback : payloadResult.text} )`,
		uncertain: payloadResult?.uncertain ?? false,
		failClosed: payloadResult?.failClosed ?? false,
	};
}

export function dcPreprocessWrappers(command: string): DcWrapperPreprocess {
	const segments = dcSplitSegments(command);
	const processed: string[] = [];
	let changed = false;
	let rewrote = false;
	let uncertain = false;
	let failClosed = false;
	for (const segment of segments) {
		const result = preprocessWrapperText(segment, 0);
		if (result === null) {
			const unwrapped = dcUnwrapWrappers(segment);
			if (unwrapped !== segment) {
				changed = true;
				// Final-critic round (P-B write path): the payload of a shell
				// -c wrapper runs in a CHILD shell — splice it as a
				// parenthesized subshell so its inner `cd` cannot move the
				// parent walk state (`bash -c 'cd src'; echo x > f` must
				// resolve f at the session cwd, never at src).
				// #3616 (final-critic round 3 (a)): a launcher prefix
				// (time/nice/nohup/env) hides the shell head — peel it with
				// the same grammar before the shell check, so
				// `time bash -c "sudo -D /etc tee x"` reaches the payload
				// recursion too instead of unwrapping to a chdir-less text.
				// The peel MUTATES a copy; what remains after the head is the
				// shell's flag region + payload.
				const peeledWords = shellSplitWords(segment);
				const shellHead = dcPeelLauncherWords(peeledWords, false);
				const isShellHead =
					shellHead === 'bash' ||
					shellHead === 'sh' ||
					shellHead === 'zsh' ||
					shellHead === 'dash' ||
					(shellHead ?? '').startsWith('ksh');
				const payloadWordsSource = peeledWords.slice(1);
				if (
					isShellHead &&
					walkShellCommandFlags(payloadWordsSource).kind === 'payload'
				) {
					// #3616 D5 (item 5): the payload itself may carry a
					// chdir-bearing wrapper (bash -c "sudo -D /etc tee x") —
					// recurse on the ONE-LEVEL payload (the segment's own
					// quote-stripped argument), not on `unwrapped` (the full
					// unwrap already discarded the sudo -D chdir).
					const walk = walkShellCommandFlags(payloadWordsSource);
					const payloadText = walk.kind === 'payload' ? walk.payload : '';
					const payloadResult = preprocessWrapperText(payloadText, 1);
					const payloadInner =
						payloadResult === null ? unwrapped : payloadResult.text;
					// Review r17 question 1: OR the payload recursion's flags
					// into the aggregate — the withdrawal used to survive only
					// as sentinel text in the pushed string, so callers gating
					// on `.uncertain` missed it.
					uncertain = uncertain || (payloadResult?.uncertain ?? false);
					failClosed = failClosed || (payloadResult?.failClosed ?? false);
					processed.push(`( ${payloadInner} )`);
					continue;
				}
			}
			processed.push(unwrapped);
			continue;
		}
		changed = true;
		rewrote = rewrote || result.rewrote;
		uncertain = uncertain || result.uncertain;
		failClosed = failClosed || result.failClosed;
		processed.push(result.text);
	}
	if (!changed) {
		return {
			command,
			changed: false,
			rewrote: false,
			uncertain: false,
			failClosed: false,
		};
	}
	return {
		command: processed.join('\n'),
		changed: true,
		rewrote,
		uncertain,
		failClosed,
	};
}

/** One destructive-arm segment with its evolving directory context. */
export interface DcDestructiveSegmentContext {
	segment: string;
	/**
	 * The absolute directory this segment's path operands resolve against.
	 * null: the session workspace directory (base behavior).
	 * 'uncertain': the child cwd is unresolvable (dynamic/expansion DIR or an
	 * unrepresentable inner mutation) — relocate targets to the escaping
	 * sentinel so any destructive pattern denies (fail-closed).
	 */
	resolveFrom: string | 'uncertain' | null;
}

/** The escaping sentinel for uncertain child cwds (never inside a workspace). */
const DC_UNRESOLVED_CHDIR_SENTINEL = '../__swarm_unresolved_chdir__';

/**
 * Relocate one destructive target operand from a wrapper's child cwd to a
 * session-root-relative form (#3491 W2), so the shared delete evaluator
 * (which resolves AND contains against the session root) judges the target
 * where the wrapped command actually runs. Escaping landings keep their
 * `../…` form and deny as outside-workspace; an uncertain cwd lands every
 * target on the sentinel (outside any workspace).
 */
export function dcRelocateDestructiveTarget(
	target: string,
	resolveFrom: string | 'uncertain' | null,
	sessionRoot: string,
): string {
	if (resolveFrom === null) return target;
	if (resolveFrom === 'uncertain') {
		return `${DC_UNRESOLVED_CHDIR_SENTINEL}/${target.replace(/^[./\\]+/, '')}`;
	}
	const absolute = path.resolve(resolveFrom, target);
	const relative = path.relative(path.resolve(sessionRoot), absolute);
	if (relative === '') return '.';
	return relative.replace(/\\/g, '/');
}

/**
 * Evolve a text-level directory context across one sub-segment of a
 * rewritten wrapper's inner command (#3491 W2): literal cd/pushd operands
 * move the context; every word form the W1 AST rules resolve specially
 * (bare cd, `~`, `cd -`, dynamic operands, popd, stack forms) degrades to
 * 'uncertain' — deny-on-uncertainty is the sanctioned direction for
 * destructive evaluation.
 */
function evolveTextDirectoryCwd(
	subSegment: string,
	cwd: string,
): string | 'uncertain' {
	// #3567 review PRR-005: the 'uncertain' marker is a STATE, never a
	// directory — the old code let `path.resolve('uncertain', operand)`
	// fabricate a real directory named "uncertain" and silently re-admit
	// writes after an unresolvable cd. Stickiness keeps every later segment
	// on the sentinel (fail-closed).
	if (cwd === 'uncertain') return 'uncertain';
	const words = shellSplitWords(subSegment);
	if (words.length === 0) return cwd;
	const head = words[0];
	if (head !== 'cd' && head !== 'pushd' && head !== 'popd') return cwd;
	const operand = words[1];
	if (operand === undefined || operand === '-' || operand.startsWith('-')) {
		return 'uncertain';
	}
	if (operand === '~' || operand.startsWith('~/')) {
		// #3567 review PRR-009: align the destructive-arm text model with the
		// W1 word-form grammar — `~`/`~/x` resolve to the same HOME landing
		// the write arm tracks instead of degrading to uncertain (the
		// over-block made wrapped destructive commands deny while the write
		// arm admitted the identical shape).
		const home = os.homedir();
		return path.resolve(home, operand === '~' ? '' : operand.slice(2));
	}
	if (dcIsDynamicChdirOperand(operand)) {
		return 'uncertain';
	}
	return path.resolve(cwd, operand);
}

function expandChdirInnerSegments(
	innerText: string,
	resolveFrom: string | 'uncertain',
	out: DcDestructiveSegmentContext[],
	depth = 0,
): void {
	// #3567 review PRR-004: bound the nested-wrapper recursion (the sibling
	// write path caps at DC_CHDIR_REWRITE_MAX_DEPTH); the old unbounded
	// expansion re-tokenized per level and measured 11s at 5,000 nested
	// `env -C` hops — a hot-path availability hazard. Past the cap the
	// remaining text degrades to the escaping sentinel (fail-closed).
	if (depth > DC_CHDIR_REWRITE_MAX_DEPTH) {
		out.push({
			segment: dcUnwrapWrappers(innerText),
			resolveFrom: 'uncertain',
		});
		return;
	}
	if (resolveFrom === 'uncertain') {
		// The context is already unresolvable: every sub-segment evaluates on
		// the sentinel.
		for (const sub of dcSplitSegments(dcUnwrapWrappers(innerText))) {
			out.push({ segment: sub, resolveFrom: 'uncertain' });
		}
		return;
	}
	const nested = matchChdirWrapperSegment(innerText);
	if (nested !== null) {
		if (nested.kind !== 'static') {
			// failClosed and uncertain nested wrappers both degrade the whole
			// inner context to the sentinel (failClosed carries no words).
			const innerWords = nested.kind === 'uncertain' ? nested.innerWords : [];
			expandChdirInnerSegments(
				shSerializeWords(innerWords),
				'uncertain',
				out,
				depth + 1,
			);
			return;
		}
		// Relative child cwds compose against the parent child cwd.
		expandChdirInnerSegments(
			shSerializeWords(nested.innerWords),
			path.resolve(resolveFrom, nested.dir),
			out,
			depth + 1,
		);
		return;
	}
	let current: string | 'uncertain' = resolveFrom;
	for (const sub of dcSplitSegments(dcUnwrapWrappers(innerText))) {
		out.push({ segment: sub, resolveFrom: current });
		current = evolveTextDirectoryCwd(sub, current);
	}
}

/**
 * Expand a command's chdir-bearing wrapper segments into destructive-arm
 * segments carrying an EVOLVING per-segment directory context (#3491 W2):
 * the wrapped command's rm/rmdir/del targets are relocated from the CHILD
 * cwd (and from the tracked evolution of any inner cd) to session-root
 * relative forms, so containment and safe-artifact judgment happen against
 * the real workspace. An unresolvable context (dynamic/expansion DIR, or an
 * inner directory mutation the W1 word-form rules cannot represent)
 * relocates to the escaping sentinel — any destructive pattern then denies.
 */
export function dcExpandDestructiveSegments(
	command: string,
	baseCwd: string,
): DcDestructiveSegmentContext[] {
	const out: DcDestructiveSegmentContext[] = [];
	for (const segment of dcSplitSegments(command)) {
		const match = matchChdirWrapperSegment(segment);
		if (match === null) {
			out.push({ segment, resolveFrom: null });
			continue;
		}
		if (match.kind === 'failClosed') {
			out.push({ segment: '', resolveFrom: 'uncertain' });
			continue;
		}
		if (match.kind === 'uncertain') {
			expandChdirInnerSegments(
				shSerializeWords(match.innerWords),
				'uncertain',
				out,
			);
			continue;
		}
		expandChdirInnerSegments(
			match.chdirInnerText ?? shSerializeWords(match.innerWords),
			path.resolve(baseCwd, match.dir),
			out,
		);
	}
	return out;
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

		// #3567 review P-A (backslash-quote desync): bash honors backslash
		// escapes OUTSIDE single quotes, and before `"` / `\` inside double
		// quotes — the old scanner toggled quote state on the escaped
		// character, so `echo '; rm -rf ../dist; echo '` desynced into one
		// phantom quoted segment and the destructive arm never saw the rm.
		if (!inSingleQuote && ch === '\\' && next !== undefined) {
			current += ch + next;
			i += 1;
			continue;
		}
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
			// A `|` preceded by `>` is the CLOBBER redirect `>|`, not a pipe —
			// splitting there desynced the wrapper rewrite (`( … )` + bare
			// `src/f`) and admitted the out-of-workspace write at the session
			// cwd (final-critic round). No manual i bump: the loop's own i++
			// must stay the only advance or the following space is swallowed.
			if (ch === '|' && cmd[i - 1] === '>') {
				current += ch;
				continue;
			}
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
 * #3567 review PRR-003: report the first segment whose shell-family launcher
 * (`bash`/`sh`/`zsh`/`dash`, path-qualified spellings included) carries a
 * flag cluster the W4 walk cannot model. Ground truth: `bash -oc pipefail
 * 'payload'` EXECUTES the payload (the option cluster does not disable it),
 * but the uncertain walk leaves the payload invisible to every verb-anchored
 * destructive arm — the gate now denies on that uncertainty instead of
 * admitting an uninspectable tail. Returns null when no segment is affected.
 */
export function dcShellFlagClusterUncertain(command: string): string | null {
	for (const segment of dcSplitSegments(command)) {
		// Transparent execution prefixes do not change the payload semantics
		// (`env bash -oc …` still runs the payload) — unwrap them before the
		// head check or the deny channel is one spelling away from bypass.
		let text = segment;
		for (let i = 0; i < 8; i += 1) {
			const m = /^(?:command|exec|env)\s+/i.exec(text);
			if (!m) break;
			text = text.slice(m[0].length);
		}
		const head = /^(\S+)\s+([\s\S]+)$/.exec(text);
		if (!head) continue;
		const base = basenameAnySepLike(head[1] as string);
		const isShellFamily =
			base === 'bash' ||
			base === 'sh' ||
			base === 'zsh' ||
			base === 'dash' ||
			base === 'ksh' ||
			base.startsWith('ksh');
		if (!isShellFamily) continue;
		const walk = walkShellCommandFlags(shellSplitWords(head[2] as string));
		if (walk.kind === 'uncertain') return segment;
	}
	return null;
}

/**
 * #3567 review P-B: a MULTI-statement `sh -c` payload runs in a child shell
 * whose inner `cd` re-bases every LATER payload statement on a directory the
 * destructive arm cannot track (`bash -c 'cd ..; rm -rf x'` deletes the
 * PARENT's parent — the spliced-into-parent model judged `x` at the session
 * cwd). Returns true when the segment is a shell-family `-c` invocation
 * whose payload splits into more than one statement; its segments must be
 * evaluated with an uncertain child-cwd context (fail-closed).
 */
export function dcShellPayloadRunsIsolated(segment: string): boolean {
	const head = /^(\S+)\s+([\s\S]+)$/.exec(segment);
	if (!head) return false;
	const base = basenameAnySepLike(head[1] as string);
	if (base !== 'bash' && base !== 'sh' && base !== 'zsh' && base !== 'dash') {
		return false;
	}
	const walk = walkShellCommandFlags(shellSplitWords(head[2] as string));
	if (walk.kind !== 'payload' || walk.payload.trim() === '') return false;
	return dcSplitSegments(walk.payload).length > 1;
}

/**
 * Extract targets from an `rm` command whose leading option set requests
 * recursive or forced deletion. Accepts stacked short flags and long flags in
 * any leading order. Quoted targets remain one token. Returns null when the
 * segment is not a destructive rm form.
 */
export function dcExtractRecursiveRmTargets(segment: string): string[] | null {
	const tokens: string[] =
		segment.match(/"(?:[^"\\]|\\.)*"|'[^']*'|\S+/g) ?? [];
	// #3518 P-5 (class, final-critic round 1): tolerate leading
	// open-parens/braces — a parenthesized segment runs the same rm in a
	// POSIX subshell, whether the paren GLUES to the verb (`(rm`) or stands
	// alone (`( rm`). Index-based scan (parallel-review A5: token.shift() in
	// a while loop is quadratic on Node for delimiter-flooded segments —
	// 160k tokens ~24s; an index cursor is linear) — drop standalone
	// delimiter tokens, then strip a glued prefix from what remains.
	let start = 0;
	while (
		start < tokens.length &&
		tokens[start] !== undefined &&
		tokens[start].length > 0 &&
		/^[({\s]*$/.test(tokens[start])
	) {
		start += 1;
	}
	if (start < tokens.length && tokens[start] !== undefined) {
		tokens[start] = tokens[start].replace(/^[({\s]+/, '');
	}
	const verbTokens = tokens.slice(start);
	// #3539 W6 (RC-6): the verb is the command word bash actually resolves —
	// quote-removed / escape-decoded / basename-normalized for ABSOLUTE
	// path-qualified spellings (`\rm`, `"rm"`, `/bin/rm`,
	// `C:\Windows\system32\rm.exe`); `./rm` stays a project-local program.
	// Case-sensitive (POSIX `rm`): `RM` and `/bin/RM` do not match.
	// #3539 W6 review advisory 2: a trailing `.exe` (case-insensitive) is
	// stripped from the normalized verb — on Git Bash the bare `rm.exe` IS rm
	// (ground truth: `rm.exe FILE` deletes), and `/bin/rm.exe` matching rm is
	// the same over-match in the deny direction; `RM.exe` / `/bin/RM.exe`
	// keep their case and stay unmatched.
	const normalizedRmVerb = dcNormalizeVerbWord(verbTokens[0] ?? '').replace(
		/\.[Ee][Xx][Ee]$/,
		'',
	);
	if (verbTokens.length < 2 || normalizedRmVerb !== 'rm') {
		return null;
	}
	tokens.length = 0;
	tokens.push(...verbTokens);

	// PRR-010: a trailing `)` stays glued to the LAST operand of a
	// parenthesized segment (`(rm -rf dist)` extracted `dist)`), so strip
	// trailing close-paren delimiters and drop standalone delimiter tokens —
	// the allowlisted safe form `(rm -rf dist)` must extract `dist`, and the
	// blocked reason for `(rm -rf ../../outside)` must name the real target.
	// #3569 residual 1: `}` is NOT stripped — a trailing brace is
	// brace-expansion syntax (`rm -f src/{a,../esc}` used to extract the
	// mangled `src/{a,../esc`) and must survive to the expansion step below;
	// a stray unmatched `}` is a literal filename character for bash and
	// judging it verbatim is the faithful behavior.
	for (let i = 1; i < tokens.length; i += 1) {
		tokens[i] = tokens[i].replace(/[)]+$/, '');
	}
	const delimStripped = tokens.filter((t) => t.length > 0);
	tokens.length = 0;
	tokens.push(...delimStripped);
	if (
		tokens.length < 2 ||
		dcNormalizeVerbWord(tokens[0] ?? '').replace(/\.[Ee][Xx][Ee]$/, '') !== 'rm'
	)
		return null;

	// PR #3615 feedback PRR-002 (delta round): decode the operand/option
	// tokens into the words bash hands rm — matching quote pairs removed and
	// backslash escapes honored — SOLELY for the option/target
	// classification. The DECODED array feeds parseRmOptionTokens so a
	// quoted destructive flag (`rm "-rf" x`, `rm '-rf' x`) and an
	// escape-decoded one (`rm \-rf x`) classify identically to the
	// detector's quote-removed AST words (previously: an option to the
	// detector, a target to this extractor — no layer owned the shape and
	// the protected-.git, filesystem-root, and allowlist guards were all
	// defeated). The RAW tokens stay authoritative for brace handling:
	// expandBraceRaw is quote-aware (#3569 4.5 review — a QUOTED brace
	// `rm -f 'src/{a,b}'` stays literal because bash quote-removal hides
	// the braces from expansion), and decoding first would destroy that
	// context (delta-review round 2: benign quoted in-scope literal deletes
	// flipped ADMIT → DENY). The verb word stays normalized through
	// dcNormalizeVerbWord (basename/.exe handling) above.
	const decodedTokens = tokens.map((token) =>
		token === undefined ? token : dcDecodeShellWord(token),
	);

	// #3591 ABSORB (Fix 6b): GNU getopt permutation — options may appear
	// AFTER operands, so the old leading-token-only flag read missed
	// `rm foo -rf ../../outside` (returned null while `rm -rf foo
	// ../../outside` extracted both targets). Two-pass parse shared with the
	// detector's non-destructive rm arm (parseRmOptionTokens): pass 1
	// collects ALL option tokens anywhere before `--` and classifies the
	// recursive/forced ones; pass 2 extracts every remaining token as a
	// target. A late-flag rm is therefore treated as recursive
	// (fail-closed). No POSIXLY_CORRECT detection (fail-closed per the
	// #3591 ABSORB decision).
	const rmParse = parseRmOptionTokens(decodedTokens.slice(1));
	const destructive = rmParse.destructive;
	const rmTargetTokens = rmParse.targetIndices.map(
		(idx) => tokens[idx + 1] ?? '',
	);
	// #3569 residual 1: a target word carrying an unquoted brace region is
	// destructive REGARDLESS of the recursive/forced flag state — real bash
	// expands `src/{a,../esc}` and deletes BOTH branches (no -r/-f needed),
	// and the flagless spelling is exactly the reported evasion. A flagless
	// rm with only literal single targets keeps today's behavior (a
	// different, separately-tracked coverage class).
	if (!destructive) {
		const braceBorne = rmTargetTokens.some(
			(t) => expandBraceRaw(t).kind !== 'none',
		);
		if (!braceBorne) return null;
	}

	// #3569 residual 1 + W8 parity: expand brace regions on the target words
	// (ALL branches — the conservative superset; an escaping branch denies).
	// A dynamic/refused expansion (nested braces, ranges beyond the cap,
	// expansion-bearing branches) withdraws fail-closed via the synthetic
	// marker target — dcEvaluateRecursiveDeleteTargets rejects the marker
	// prefix UNCONDITIONALLY (PRR-001: evaluated as an ordinary path it was
	// scope-contingent, admitting workspace-escaping deletes under a
	// marker-covering scope).
	const out: string[] = [];
	for (const target of rmTargetTokens) {
		// #3569 4.5 review: expand on the RAW token — expandBraceRaw is
		// quote-aware, so a QUOTED brace (`rm -f 'src/{a,b}'`) stays LITERAL
		// (bash-true); dequoting first wrongly expanded quoted literals.
		const expansion = expandBraceRaw(target);
		if (expansion.kind === 'branches') {
			out.push(...expansion.branches);
		} else if (expansion.kind === 'dynamic') {
			out.push(`__swarm_brace_refusal__/${target}`);
		} else {
			out.push(target.replace(/^(["'])|(["'])$/g, ''));
		}
	}
	return out;
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
			return `lstat failed on "${dcSafeDiagnosticValue(ancestor)}": ${dcSafeDiagnosticValue(String(err))} — refusing to allow destructive operation on unverifiable path`;
		}

		if (stat.isSymbolicLink()) {
			return `BLOCKED: "${dcSafeDiagnosticValue(ancestor)}" is a symlink/junction — deleting recursively through it would destroy the link target. Use platform-specific junction deletion (fsutil reparsepoint delete, Remove-Item without -Recurse) instead.`;
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
			return `BLOCKED: Destructive command targets path with unexpanded variable "${dcSafeDiagnosticValue(t, 160)}" — cannot verify safety. Resolve variables before using destructive operations.`;
		}

		// Check remote filesystem prefixes
		if (dcIsRemotePath(t)) {
			return `BLOCKED: Destructive command targets remote/network filesystem path "${dcSafeDiagnosticValue(t)}" — refusing to execute remote destructive operations.`;
		}

		// UNC path \\server\share or extended \\?\
		if (/^\\\\/.test(t)) {
			return `BLOCKED: Destructive command targets UNC path "${dcSafeDiagnosticValue(t)}" — UNC paths in destructive operations are not allowed.`;
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
			return `BLOCKED: Destructive command targets filesystem root "${dcSafeDiagnosticValue(t)}"`;
		}

		// Absolute path: check against blocked system prefixes
		if (path.isAbsolute(t) || /^[A-Za-z]:/.test(t)) {
			for (const blocked of DC_BLOCKED_ABSOLUTE_PREFIXES) {
				if (t.startsWith(blocked)) {
					return `BLOCKED: Destructive command targets system path "${dcSafeDiagnosticValue(t)}" which is under protected prefix "${dcSafeDiagnosticValue(blocked)}"`;
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

function dcPathComponents(value: string): string[] {
	return value.replace(/\\/g, '/').split('/').filter(Boolean);
}

/**
 * #3616 D13: bounded, control-neutralized diagnostic rendering DELEGATES to the
 * canonical sanitizeDiagnosticText (code-point-safe truncation; the canonical
 * also neutralizes the bidi marks the old local scanner missed). The local
 * `?`-replacement semantics are preserved via the canonical's own replacement;
 * no separate sanitizer implementation remains in this module.
 */
function dcSafeDiagnosticValue(value: string, maxLength = 512): string {
	return sanitizeDiagnosticText(value, maxLength);
}

/**
 * #3616 D11: platform-parameterized protected-component compare. darwin folds
 * case (macOS default filesystems are case-insensitive; on case-sensitive
 * volumes this only over-denies — fail-closed). Other platforms stay exact.
 * dcComponentEquals delegates with process.platform so the production call
 * sites inherit the platform behavior; the exported form exists for the seam.
 */
export function dcProtectedComponentEqualsForPlatform(
	platform: NodeJS.Platform,
): (left: string, right: string) => boolean {
	if (platform === 'win32' || platform === 'darwin') {
		return (left: string, right: string) =>
			left.toLowerCase() === right.toLowerCase();
	}
	return (left: string, right: string) => left === right;
}

function dcComponentEquals(left: string, right: string): boolean {
	return dcProtectedComponentEqualsForPlatform(process.platform)(left, right);
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

	// #3590 feedback (PRR-001, swarm-pr-review + 2-pass critic): the
	// synthetic refusal marker from the brace-expansion refusal path is a
	// SIGNAL, never a real filename — but evaluated as an ordinary
	// workspace-relative target its token basename passed DC_SAFE_TARGETS
	// and a scope entry covering the marker prefix passed containment, so
	// `rm -rf {a..c}/node_modules` was ADMITTED (base denied; real bash
	// deletes workspace-escaping directories) with the audit trail showing
	// only the synthetic token. Reject the prefix UNCONDITIONALLY, before
	// scope/basename evaluation — fail closed regardless of scope.
	for (const target of input.targets) {
		if (target.includes('__swarm_brace_refusal__/')) {
			return {
				allowed: false,
				code: 'DESTRUCTIVE_TARGET_INVALID',
				reason:
					'BLOCKED: Recursive delete target carries an unresolvable brace expansion (refused dynamically, not a resolvable filename).',
			};
		}
	}

	// #3591 ABSORB (Fix 6c): TWO-PHASE evaluation. Phase 1 runs the
	// pre-allowlist checks (per-target traversal/invalid, then protected
	// .git/.swarm components, then workspace containment — the CURRENT
	// per-target order) over EVERY target FIRST; phase 2 evaluates the
	// allowlist and nested-scope rules over the survivors. Both
	// `rm -rf foo ../../outside` and `rm foo -rf ../../outside` (the GNU
	// permutation form Fix 6b now extracts) then fail phase 1 on
	// ../../outside and the denial NAMES the escaping target instead of the
	// first non-allowlisted operand.
	interface PhaseOneTarget {
		target: string;
		safeTarget: string;
		components: string[];
		resolved: string;
		relative: string;
	}
	const survivors: PhaseOneTarget[] = [];
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

		survivors.push({ target, safeTarget, components, resolved, relative });
	}

	const normalizedTargets: string[] = [];
	let hasNested = false;
	for (const { safeTarget, components, resolved, relative } of survivors) {
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
	// mklink /J or /D (cmd.exe) — #3539 W6: normalized verb word (`\mklink`,
	// `"mklink"`, `C:\Windows\system32\mklink.exe` reach the arm).
	const mklinkHead = dcSegmentVerbMatch(segment, ['mklink']);
	const mklinkMatch = mklinkHead
		? /^\s*\/[JjDd]\s+"?([^"\s]+)"?\s+"?([^"\s]+)"?/.exec(mklinkHead.rest)
		: null;
	if (mklinkMatch) {
		const target = mklinkMatch[2].trim();
		if (!dcHasUnresolvableVars(target)) {
			const resolved = path.resolve(cwd, target);
			const rel = path.relative(cwd, resolved);
			if (rel.startsWith('..') || path.isAbsolute(rel)) {
				return `BLOCKED: Junction/symlink creation targeting path outside working directory: mklink target "${dcSafeDiagnosticValue(target)}" resolves to "${dcSafeDiagnosticValue(resolved)}" which is outside "${dcSafeDiagnosticValue(cwd)}". Creating junctions to external paths and then deleting them recursively can destroy data.`;
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
				return `BLOCKED: Junction/symlink creation targeting path outside working directory: New-Item target "${dcSafeDiagnosticValue(target)}" resolves to "${dcSafeDiagnosticValue(resolved)}" which is outside "${dcSafeDiagnosticValue(cwd)}". This pattern caused the K2.6 data-loss incident.`;
			}
		}
		return null;
	}

	// ln -s <target> (POSIX symlink; block if target resolves outside cwd)
	// Both absolute and relative targets are checked: ln -s ../sensitive dist escapes cwd.
	// #3539 W6: normalized verb word (`\ln`, `"ln"`, `/bin/ln` reach the arm).
	const lnHead = dcSegmentVerbMatch(segment, ['ln'], false);
	const lnMatch = lnHead
		? /^\s+(?:-[sfnv]*s[sfnv]*|-s)\s+"?([^"\s]+)"?(?:\s+"?[^"\s]+"?)?\s*$/.exec(
				lnHead.rest,
			)
		: null;
	if (lnMatch) {
		const target = lnMatch[1].trim();
		if (!dcHasUnresolvableVars(target)) {
			const resolved = path.resolve(cwd, target);
			const rel = path.relative(cwd, resolved);
			if (rel.startsWith('..') || path.isAbsolute(rel)) {
				return `BLOCKED: Symlink creation targeting path outside working directory: ln -s target "${dcSafeDiagnosticValue(target)}" resolves to "${dcSafeDiagnosticValue(resolved)}" which is outside "${dcSafeDiagnosticValue(cwd)}". Symlinks to external paths combined with recursive deletion can destroy data.`;
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
 *
 * #3539 W6 (RC-7): the parameter walk is INDEX-BASED (the old loop consumed
 * tokens through a for-of while looking the SAME token up again with
 * `tokens.indexOf(tok)` — a repeated `-Path` bound its value to the FIRST
 * occurrence's index, so every repeat after the first dropped its target)
 * and colon-glued `-Param:Value` parameters split (`-Path:/etc` is ONE
 * token real PowerShell 5.1 binds as flag+value; the left side keeps its
 * value-taking semantics and the right side IS the value). The verb word is
 * matched through dcNormalizeVerbWord (quoted/escaped/path-qualified
 * spellings resolve to the cmdlet).
 */
export function dcExtractPowerShellTargets(segment: string): string[] {
	const stripQuotes = (p: string): string => p.replace(/^["']|["']$/g, '');
	const head = dcSegmentVerbMatch(segment, [
		'remove-item',
		'ri',
		'rm',
		'rmdir',
		'del',
		'erase',
		'rd',
	]);
	if (!head) return [];

	// Tokenize remainder; quoted strings count as one token
	const tokens: string[] = head.rest.match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? [];

	const targets: string[] = [];
	// Flags that consume a VALUE (space-separated next token, or the glued
	// colon right side).
	const valueFlags = new Set([
		'-literalpath',
		'-path',
		'-filter',
		'-include',
		'-exclude',
		'-lp', // alias for -LiteralPath in PS 7+
	]);
	// Boolean switch parameters whose glued right side is an expression
	// (`-Recurse:$true`), never a path — dropped, not extracted.
	const switchFlags = new Set([
		'-recurse',
		'-force',
		'-confirm',
		'-whatif',
		'-passthru',
		'-verbose',
		'-debug',
		'-hidden',
		'-erroraction',
		'-warningaction',
		'-informationaction',
	]);
	for (let i = 0; i < tokens.length; i++) {
		const tok = tokens[i];
		if (tok === undefined) break;
		if (!tok.startsWith('-')) {
			// Non-flag positional argument → path target
			const cleaned = stripQuotes(tok);
			if (cleaned) targets.push(cleaned);
			continue;
		}
		// Colon-glued `-Param:Value` split: the left keeps its flag
		// semantics, the right is the bound value.
		let flagName = tok.toLowerCase();
		let gluedValue: string | null = null;
		const colon = tok.indexOf(':');
		if (colon !== -1) {
			flagName = tok.slice(0, colon).toLowerCase();
			gluedValue = tok.slice(colon + 1);
		}
		if (valueFlags.has(flagName)) {
			if (gluedValue !== null) {
				const val = stripQuotes(gluedValue);
				if (val) targets.push(val);
				continue;
			}
			const next = tokens[i + 1];
			if (next !== undefined) {
				const val = stripQuotes(next);
				if (val) targets.push(val);
				i++; // the value token is consumed
			}
			continue;
		}
		if (switchFlags.has(flagName)) {
			// A glued boolean expression (-Recurse:$true) is not a path.
			continue;
		}
		// Unknown flag: a glued right side extracts fail-closed (parity with
		// the space-separated positional push); a spaced next word falls
		// through to the positional branch on the next iteration.
		if (gluedValue !== null && gluedValue !== '') {
			targets.push(stripQuotes(gluedValue));
		}
	}
	return targets;
}
