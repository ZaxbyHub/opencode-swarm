/**
 * Shared Helper Functions — Guardrails
 *
 * Extracted from tool-before.ts (task 1.4 / FR-005).
 * Contains pure utility functions used by the toolBefore handler
 * and potentially other guardrails submodules.
 */

import * as path from 'node:path';
import { WRITE_TOOL_NAMES } from '../../config/constants';
import { classifyFile } from '../../context/zone-classifier';
import { isPathWithinDeclaredScope } from '../../scope/path-identity';
import {
	findRedactableTokenSpans,
	JWS_REDACTION_LABEL,
} from '../../utils/jws-redaction';
import { normalizeToolName } from '../normalize-tool-name';
import { getGlobMatcher } from './file-authority';

// ---- Constants ----

/**
 * Known verifier/linter config file glob patterns for config-zone logging.
 * Matches patterns from architect's blockedGlobs that represent config files.
 */
const KNOWN_VERIFIER_CONFIG_GLOBS = [
	'**/oxlintrc*',
	'**/.oxlintrc*',
	'**/.eslintrc*',
	'**/eslint.config.*',
	'**/.prettierrc*',
	'**/prettier.config.*',
	'**/biome.jsonc',
	'**/.secretscanignore',
	'**/.golangci*',
] as const;

// ---- Helper functions ----

/**
 * Checks if a file path is a config file either via zone classification
 * or by matching known verifier config glob patterns.
 */
export function isConfigFilePath(
	filePath: string,
	cwd: string,
	extraGlobs?: readonly string[],
): boolean {
	const normalized = path
		.relative(path.resolve(cwd), path.resolve(cwd, filePath))
		.replace(/\\/g, '/');

	const { zone } = classifyFile(normalized);
	if (zone === 'config') {
		return true;
	}

	const allGlobs =
		extraGlobs && extraGlobs.length > 0
			? [...KNOWN_VERIFIER_CONFIG_GLOBS, ...extraGlobs]
			: KNOWN_VERIFIER_CONFIG_GLOBS;
	for (const glob of allGlobs) {
		const matcher = getGlobMatcher(glob);
		if (matcher(normalized)) {
			return true;
		}
	}

	return false;
}

/**
 * Detects if a tool is a write-class tool that modifies file contents.
 */
export function isWriteTool(toolName: string): boolean {
	const normalized = normalizeToolName(toolName);
	return (WRITE_TOOL_NAMES as readonly string[]).includes(normalized);
}

/**
 * Detects if a file path is outside the .swarm/ directory.
 */
export function isOutsideSwarmDir(
	filePath: string,
	directory: string,
): boolean {
	if (!filePath) return false;
	const swarmDir = path.resolve(directory, '.swarm');
	const resolved = path.resolve(directory, filePath);
	const relative = path.relative(swarmDir, resolved);
	return relative.startsWith('..') || path.isAbsolute(relative);
}

/**
 * Detects if a file path is source code (not docs, config, or metadata).
 */
export function isSourceCodePath(filePath: string): boolean {
	if (!filePath) return false;
	const normalized = filePath.replace(/\\/g, '/');
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
 */
export function hasTraversalSegments(filePath: string): boolean {
	if (!filePath) return false;
	const normalized = filePath.replace(/\\/g, '/');
	return (
		normalized.startsWith('..') ||
		normalized.includes('/../') ||
		normalized.endsWith('/..')
	);
}

/**
 * Check if a file path is within declared scope entries.
 * Handles both exact matches and directory containment.
 */
export function isInDeclaredScope(
	filePath: string,
	scopeEntries: string[],
	cwd?: string,
): boolean {
	return isPathWithinDeclaredScope(filePath, scopeEntries, cwd);
}

/**
 * Redacts sensitive values from a shell command string before audit logging.
 *
 * Covers env-var assignments (POSIX/PowerShell `$env:`/cmd `set`), CLI flags
 * (sensitive names, both `=`-joined and space-separated), Bearer/Basic auth,
 * `-H` header flags, URL credentials (`scheme://user:pass@host`), well-known
 * token VALUE shapes (OpenAI/GitHub/AWS/Slack/Google — content-based, so they
 * fire regardless of the surrounding flag name), and long base64-like payload
 * runs (≥80 chars with mixed case + digit — the encoded-wrapper/heredoc
 * minimization class from issue #2040; plain hex SHAs and short payloads are
 * deliberately NOT matched). Sensitive values are consumed through closing
 * quotes when quoted (`KEY="two words"` redacts the whole value, not just the
 * first word). UNC profile material (`\\server\share\user\…`) is minimized
 * like the other home-profile families.
 *
 * Deterministic: identical inputs always redact identically (correlation via
 * the audit `commandHash` relies on it). No pattern retains any reversible
 * secret material.
 */
/**
 * Cf (format) and Default_Ignorable code points: bytes that render as
 * NOTHING. A byte from either class inside a bare credential token splits it
 * past every `\b`-anchored bare shape (#3730 — the display site gained this
 * deletion view in the #3165/#3705 work; the shell mirror mirrors it here).
 * Deletion is the correct transform for this class: unlike visible bytes,
 * removing an invisible byte cannot change what the reader sees — and the
 * deletion happens only in the MATCHING view, never in the output.
 */
const ZERO_WIDTH_FILL_RE = /\p{Cf}|\p{Default_Ignorable_Code_Point}/u;

/**
 * Bare well-known token VALUE shapes for the shell audit site (#3730: the
 * sequential .replace chain is replaced by the two-view union sweep below;
 * pattern order preserves the chain's first-arm-owns label semantics —
 * the anthropic/openrouter shapes run BEFORE the openai shape so
 * `sk-ant-api03-…` keeps its provider label). Mirrors
 * BARE_TOKEN_VALUE_PATTERNS at the display site; the parity corpus
 * (invocation-failure-bare-tokens-3165 + the #3730/#3736 suites) pins both
 * sites against the same fixtures so they cannot drift.
 */
const SHELL_BARE_TOKEN_VALUE_PATTERNS: ReadonlyArray<{
	label: string;
	re: RegExp;
	/** #3712: optional post-match class guard (the base64 arm requires
	 * upper+lower+digit on the matched run so hex-only digests stay visible). */
	guard?: (match: string) => boolean;
}> = [
	{ label: '[REDACTED:anthropic]', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
	{ label: '[REDACTED:openrouter]', re: /\bsk-or-[A-Za-z0-9_-]{20,}/g },
	{ label: '[REDACTED:openai]', re: /\bsk-[A-Za-z0-9_-]{20,}/g },
	{
		label: '[REDACTED:github]',
		re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
	},
	{ label: '[REDACTED:github]', re: /\bgithub_pat_[A-Za-z0-9_]{22,}/g },
	{ label: '[REDACTED:aws]', re: /\bAKIA[0-9A-Z]{16}\b/g },
	{ label: '[REDACTED:slack]', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
	{ label: '[REDACTED:google]', re: /\bAIza[A-Za-z0-9_-]{30,}/g },
	{ label: '[REDACTED:google]', re: /\bGOCSPX-[A-Za-z0-9_-]{20,}/g },
	{ label: '[REDACTED:google]', re: /\bya29\.[A-Za-z0-9_-]{20,}/g },
	{ label: '[REDACTED:groq]', re: /\bgsk_[A-Za-z0-9]{20,}/g },
	// #3710 review: the PAYLOAD segment is any base64url run, not only a JSON
	// object — an empty claims object encodes as `e30`, not `eyJ`.
	{
		label: '[REDACTED:jwt]',
		re: /\beyJ[A-Za-z0-9_-]{10,1024}\.[A-Za-z0-9_-]{1,}\.[A-Za-z0-9_-]{10,}/g,
	},
	// #3712 F-013: base64 credential arm — ≥80-char mixed-class run (the
	// guard keeps hex-only SHA digests, uppercase-hex runs, and sub-80
	// payloads visible).
	{
		label: '[REDACTED:base64]',
		re: /[A-Za-z0-9+/]{80,}={0,2}/g,
		guard: (match) =>
			/[A-Z]/.test(match) && /[a-z]/.test(match) && /[0-9]/.test(match),
	},
	// #3712 azure CONTEXTUAL arm: connection-string `AccountKey=<base64>`
	// material — the WHOLE span collapses to the bare family placeholder
	// (no `AccountKey=` residue: a residue form is itself re-matchable KV
	// shape). Bare 32-hex Azure OpenAI keys are deliberately NOT patterned:
	// they are indistinguishable from hex digests that must stay visible
	// (disclosed bound, #3712 AC3).
	{ label: '[REDACTED:azure]', re: /\bAccountKey=[A-Za-z0-9+/]{20,}={0,2}/gi },
];

export function redactShellCommand(cmd: string): string {
	if (typeof cmd !== 'string') return '';
	let out = cmd
		.replace(/\/home\/[^/\s"']+/g, '~')
		.replace(/[A-Za-z]:\\Users\\[^\\\s"']+/gi, '~')
		.replace(/\/Users\/[^/\s"']+/g, '~')
		// UNC profile/share material inside command strings: \\server\share\user\… -> ~
		.replace(/\\\\[^\\\s"']+\\[^\\\s"']+\\[^\\\s"']+(?:\\[^\s"']*)?/g, '~');

	// URL credentials: scheme://user:password@host -> scheme://user:[REDACTED]@host
	// The scheme prefix is bounded ({0,32}) so a long non-URL token cannot make
	// the class scan quadratic before the `://` anchor fails (review round:
	// unbounded scheme + lookahead forms benchmarked 6.5-14 s/100 KB).
	out = out.replace(
		/([a-zA-Z][a-zA-Z0-9+.-]{0,32}:\/\/[^\s"'@/]+):([^@\s"'/]+)@/g,
		'$1:[REDACTED]@',
	);

	// Quoted values are consumed through the closing quote so multiword
	// secrets (`KEY="two words"`) are fully minimized, not just their first
	// word (non-capturing so `$1` stays the variable name).
	const VALUE = String.raw`(?:"[^"]*"|'[^']*'|\S+)`;

	// Name prefixes are bounded ({0,64}) to keep the case-insensitive class
	// scan from going quadratic on long non-matching runs (same review round).
	out = out.replace(
		new RegExp(
			String.raw`\b([A-Z_]{0,64}(?:TOKEN|SECRET|PASSWORD|PASSWD|API[_]?KEY|APIKEY|AUTH|CREDENTIAL|PRIVATE[_]?KEY|ACCESS[_]?KEY|_KEY)[A-Z_0-9]{0,64})\s*=\s*` +
				VALUE,
			'gi',
		),
		'$1=[REDACTED]',
	);

	// PowerShell env assignment (sensitive names only — matches the POSIX
	// pattern's scope): $env:KEY="value" / $env:KEY='v' / $env:KEY=v
	out = out.replace(
		new RegExp(
			String.raw`(\$env:[A-Za-z_][A-Za-z_0-9]{0,64}(?:TOKEN|SECRET|PASSWORD|PASSWD|API[_]?KEY|APIKEY|AUTH|CREDENTIAL|PRIVATE[_]?KEY|ACCESS[_]?KEY|_KEY)[A-Za-z_0-9]{0,64})(\s*=\s*)` +
				VALUE,
			'gi',
		),
		'$1=[REDACTED]',
	);

	// cmd.exe / command.com env assignment: set KEY=value (sensitive names only)
	out = out.replace(
		new RegExp(
			String.raw`\b(set|SET)(\s+"?)([A-Za-z_][A-Za-z_0-9]{0,64}(?:TOKEN|SECRET|PASSWORD|PASSWD|API[_]?KEY|APIKEY|AUTH|CREDENTIAL|PRIVATE[_]?KEY|ACCESS[_]?KEY|_KEY)[A-Za-z_0-9]{0,64})(=?)(\s+)` +
				VALUE,
			'gi',
		),
		'$1$2$3=[REDACTED]',
	);

	// #3743: the two dash-flag arms are bounded ({0,64} around the keyword,
	// same convention as the KV arm above) — the unbounded classes made the
	// case-insensitive scan quadratic on long dash runs (~4.9-7.4 s per
	// redactShellCommand call at 20k dashes; bounded is linear).
	out = out.replace(
		/--([a-zA-Z-]{0,64}(?:token|secret|password|passwd|api[_-]?key|apikey|auth|credential|private[_-]?key|access[_-]?key)[a-zA-Z-]{0,64})=(\S+)/gi,
		'--$1=[REDACTED]',
	);

	out = out.replace(
		/(--[a-zA-Z-]{0,64}(?:token|secret|password|passwd|api[_-]?key|apikey|auth|credential|private[_-]?key|access[_-]?key)[a-zA-Z-]{0,64})(\s+)(?!--)(\S+)/gi,
		'$1$2[REDACTED]',
	);

	out = out.replace(
		/\b(Bearer|Basic)\s+[A-Za-z0-9+/=._-]{4,}/gi,
		'$1 [REDACTED]',
	);

	out = out.replace(
		/(-H\s+['"]?(?:Authorization|X-API-Key|X-Auth-Token|[A-Za-z][A-Za-z-]*-(?:key|token|secret|auth|credential)):\s*)([^'">\s][^'">\n]*)(['"]?)/gi,
		'$1[REDACTED]$3',
	);

	// #3730/#3736: bare well-known token VALUE shapes, matched on a two-view
	// UNION so a Cf/DI zero-width byte inside a token can no longer split it
	// past redaction (the display site's mechanism — see
	// sanitizeFailureEvidenceDisplay). Pass A is the RAW text: every match the
	// old sequential chain found stays a candidate (head-dominance). Pass B is
	// the Cf/DI-deletion condensed view (fill tolerance), mapped back to
	// original offsets. JWS spans from src/utils/jws-redaction.ts join both
	// passes WITHOUT pre-pass dominance, matching the display site's
	// leftmost-longest selection. Disclosed behavior change on glued
	// compositions (`sk-abc-<JWT>`): the old shell pre-pass labeled the token
	// `sk-abc-[REDACTED:jwt]`; both sites now select the leftmost-longest
	// family span (`[REDACTED:openai]`, consuming the prefix fragment —
	// strictly MORE redaction; pinned by the #3730/#3736 suites at both
	// sites). Benign Cf/DI bytes OUTSIDE any token survive byte-identical:
	// the condensed view exists only for matching, never for output.
	const condensedChars: string[] = [];
	const condensedToOriginal: number[] = [];
	let zwCursor = 0;
	for (const char of out) {
		if (!ZERO_WIDTH_FILL_RE.test(char)) {
			condensedChars.push(char);
			// One map entry per UTF-16 CODE UNIT (not per code point):
			// matchAll's match.index counts code units, so a map indexed by
			// code-point position misaligns every span after a kept astral
			// character (emoji/CJK-ext) and maps a token ending at the input
			// end past the array (NaN end -> slice(NaN) appends the whole
			// cleartext string). Each unit carries its OWN absolute offset
			// (zwCursor + unit) so a span END lookup (map[lastUnit]+1) lands
			// after the full astral char instead of splitting the surrogate
			// pair (#3743 implementation review); matches always start/end
			// on char boundaries.
			for (let unit = 0; unit < char.length; unit += 1) {
				condensedToOriginal.push(zwCursor + unit);
			}
		}
		zwCursor += char.length;
	}
	const condensed = condensedChars.join('');
	const bareMatches: Array<{ label: string; start: number; end: number }> = [];
	const collectBareMatches = (text: string, map: number[] | null) => {
		for (const { label, re, guard } of SHELL_BARE_TOKEN_VALUE_PATTERNS) {
			re.lastIndex = 0;
			for (const match of text.matchAll(re)) {
				if (guard && !guard(match[0])) continue;
				bareMatches.push({
					label,
					start:
						map === null ? (match.index ?? 0) : (map[match.index ?? 0] ?? 0),
					end:
						map === null
							? (match.index ?? 0) + match[0].length
							: (map[(match.index ?? 0) + match[0].length - 1] ?? 0) + 1,
				});
			}
		}
		// #3736: eyJ-anchored spans (widened shapes) plus non-overlapping
		// standard-base64 dotted-token spans — the combined producer drops a
		// generic span that overlaps an eyJ span (mid-token generic starts
		// would otherwise glue adjacent tokens through the extend rule).
		for (const span of findRedactableTokenSpans(text)) {
			bareMatches.push({
				label: JWS_REDACTION_LABEL,
				start: map === null ? span.start : (map[span.start] ?? span.start),
				end: map === null ? span.end : (map[span.end - 1] ?? span.end - 1) + 1,
			});
		}
	};
	collectBareMatches(out, null);
	collectBareMatches(condensed, condensedToOriginal);
	if (bareMatches.length > 0) {
		// Leftmost-longest greedy selection over the union: maximal
		// non-overlapping coverage. Identical spans from both passes dedupe;
		// a longer overlapping span EXTENDS the covered interval (keeps the
		// earlier start and its label), so output never shows LESS redaction
		// than the sequential chain produced. Left-to-right list build, then
		// a right-to-left splice keeps offsets valid.
		bareMatches.sort((a, b) => a.start - b.start || b.end - a.end);
		const selected: typeof bareMatches = [];
		for (const match of bareMatches) {
			const last = selected[selected.length - 1];
			if (last === undefined || match.start >= last.end) {
				selected.push(match);
			} else if (match.end > last.end) {
				last.end = match.end;
			}
		}
		let swept = '';
		let spliceCursor = 0;
		for (const match of selected) {
			if (match.start < spliceCursor) continue; // contained in an earlier span
			swept += out.slice(spliceCursor, match.start) + match.label;
			spliceCursor = match.end;
		}
		swept += out.slice(spliceCursor);
		out = swept;
	}

	return out;
}
