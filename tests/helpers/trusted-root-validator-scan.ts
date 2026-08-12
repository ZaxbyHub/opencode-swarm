/**
 * Scanner machinery for the "relative-input validator applied to a trusted
 * absolute root" guardrail (issue #1619 follow-up).
 *
 * THE RECURRENCE CLASS. `validateDirectory` (src/utils/path-security.ts) is the
 * validator for UNTRUSTED, RELATIVE sub-path input: it rejects every absolute
 * path by design. `validateProjectDirectory` (same module) is its trust-model
 * counterpart for the TRUSTED, always-absolute project root the plugin host
 * injects (`ctx.directory`, or the documented `process.cwd()` fallback).
 *
 * Handing a project root to `validateDirectory` therefore throws on EVERY real
 * invocation. That is not loud: every such call site in this repo sits behind a
 * debug-gated `warn(...)` catch, so the feature silently disappears and nothing
 * surfaces to the user. `getContextBudgetReport`, `formatBudgetWarning` and all
 * four `run-memory` entry points shipped dead this way. This scan makes the
 * next instance a red test instead of a dead feature.
 *
 * TWO RULES, both needed:
 *
 *   RULE M (misapplication, negative): in any `src/**.ts` that imports
 *     `validateDirectory` from a `path-security` module, a SINGLE-ARGUMENT
 *     call `validateDirectory(<arg>)` whose argument names or derives from a
 *     project directory is a violation.
 *
 *   RULE P (positive): the entry points that take a trusted project root must
 *     still validate THAT root. A future "fix" that deletes the call outright
 *     would sail through a negative-only scan, so RULE P pins each guarded
 *     function to a `validateProjectDirectory(<param>)` call inside its own
 *     body, where `<param>` is the parameter the registry row names and is
 *     checked to be a real declared parameter of that function. Tightened
 *     2026-08-10 (#1619 round 6): the rule previously accepted ANY
 *     `validateProjectDirectory(` call in the body, so validating an unrelated
 *     local would have satisfied it while the trusted root went unchecked.
 *
 * FALSE-POSITIVE DISCRIMINATORS (each is load-bearing, not defensive padding):
 *
 *   - IMPORT-AWARE. `src/tools/pre-check-batch.ts:170` defines its OWN local
 *     `validateDirectory(dir, workspaceDir)` and calls it at :682 and :1110
 *     with a project-directory-ish first argument. It does not import from
 *     path-security, so RULE M never looks at it. A bare name scan would fire
 *     on it every time.
 *   - ARITY. The local helper above takes two arguments; the path-security one
 *     takes exactly one. Requiring a single argument is a second, independent
 *     discriminator, so neither check alone carries the whole burden.
 *   - COMMENTS BLANKED. Prose describing the rule (including this docblock's
 *     own examples, and the justification comments at the six fixed sites) can
 *     neither satisfy nor trip either rule.
 *   - DEFINITION SITE EXEMPT. `src/utils/path-security.ts` declares and
 *     re-exports both functions; it is not a call site.
 *
 * KNOWN LIMITATION (measured, not assumed): RULE M matches on the argument's
 * SPELLING. A trusted root passed under an unrecognised name (`d`, `where`) is
 * invisible to it. That is why RULE P exists — the functions that actually take
 * a root are pinned positively, so the blind spot cannot silently swallow the
 * exact regression this guardrail is about. Audited 2026-08-10: after the fix,
 * `validateDirectory` has ZERO production call sites in `src/`, so RULE M is
 * currently a pure forward-looking ratchet and RULE P carries the live
 * assertions.
 *
 * The assertions live in
 * tests/unit/build/trusted-root-validator-scan.test.ts. Split out of that file
 * to match the local precedent (tests/helpers/swarm-write-cache-scan.ts) and
 * keep both under the FR-006 500-line cap.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const SRC_DIR = join(REPO_ROOT, 'src');

/** The module that owns both validators; its own body is not a call site. */
const VALIDATOR_MODULE = join('src', 'utils', 'path-security.ts');

/**
 * Identifiers that name (or destructure to) a project root in this codebase.
 * Drawn from the real parameter and field names in use: `createSwarmTool`
 * injects `ctx.directory`, hooks thread it through as `directory`, and the
 * documented CLI/test fallback is `process.cwd()`.
 */
const PROJECT_DIR_NAMES = [
	'directory',
	'dir',
	'projectDir',
	'projectDirectory',
	'projectRoot',
	'workspaceDir',
	'workspaceDirectory',
	'workspaceRoot',
	'workingDir',
	'workingDirectory',
	'rootDir',
	'root',
	'baseDir',
	'cwd',
];

/**
 * True when `arg` names or derives from a project root: a bare identifier from
 * the list above (any casing prefix such as `swarmDirectory` counts), a member
 * access ending in one of them (`ctx.directory`, `input.workingDirectory`), or
 * a `process.cwd()` / `resolveWorkingDirectory(...)` result.
 */
export function looksLikeProjectDirectory(arg: string): boolean {
	const expr = arg.trim();
	if (expr === '') return false;
	if (/^process\s*\.\s*cwd\s*\(\s*\)$/.test(expr)) return true;
	// Take the final member-access segment: `ctx.directory` -> `directory`.
	const tail = expr.split('.').pop()?.trim() ?? '';
	// Strip a trailing non-null assertion / optional marker.
	const bare = tail.replace(/[!?]+$/, '');
	if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(bare)) return false;
	const lower = bare.toLowerCase();
	return PROJECT_DIR_NAMES.some((name) => {
		const n = name.toLowerCase();
		// Exact match, or a suffix match on a compound identifier
		// (`swarmDirectory`, `effectiveWorkspaceDir`, `_directory`).
		return lower === n || lower.endsWith(n);
	});
}

/**
 * Blank out comment bodies while preserving every newline, so reported line
 * numbers still match the real file and prose can neither satisfy nor trip a
 * rule. String and template literals are preserved — import specifiers live in
 * them.
 */
export function blankComments(source: string): string {
	let out = '';
	let i = 0;
	type Mode = 'code' | 'line' | 'block' | 'single' | 'double' | 'template';
	let mode: Mode = 'code';
	while (i < source.length) {
		const ch = source[i] as string;
		const next = source[i + 1];
		if (mode === 'code') {
			if (ch === '/' && next === '/') {
				mode = 'line';
				out += '  ';
				i += 2;
				continue;
			}
			if (ch === '/' && next === '*') {
				mode = 'block';
				out += '  ';
				i += 2;
				continue;
			}
			if (ch === "'") mode = 'single';
			else if (ch === '"') mode = 'double';
			else if (ch === '`') mode = 'template';
			out += ch;
			i++;
			continue;
		}
		if (mode === 'line') {
			if (ch === '\n') {
				mode = 'code';
				out += ch;
			} else out += ' ';
			i++;
			continue;
		}
		if (mode === 'block') {
			if (ch === '*' && next === '/') {
				mode = 'code';
				out += '  ';
				i += 2;
				continue;
			}
			out += ch === '\n' ? '\n' : ' ';
			i++;
			continue;
		}
		// Inside a string/template: copy verbatim, honouring escapes.
		if (ch === '\\') {
			out += ch + (next ?? '');
			i += 2;
			continue;
		}
		if (
			(mode === 'single' && ch === "'") ||
			(mode === 'double' && ch === '"') ||
			(mode === 'template' && ch === '`')
		) {
			mode = 'code';
		}
		out += ch;
		i++;
	}
	return out;
}

function listSourceFiles(): string[] {
	const entries = readdirSync(SRC_DIR, { recursive: true }) as string[];
	return entries
		.map((rel) => rel.split('\\').join('/'))
		.filter((rel) => rel.endsWith('.ts'))
		.filter((rel) => !rel.endsWith('.test.ts') && !rel.endsWith('.spec.ts'))
		.filter((rel) => !rel.includes('__tests__/'))
		.map((rel) => join('src', rel));
}

/** True when `source` imports `validateDirectory` from a path-security module. */
export function importsPathSecurityValidateDirectory(source: string): boolean {
	for (const match of source.matchAll(
		/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g,
	)) {
		const names = match[1] as string;
		const specifier = match[2] as string;
		if (!/path-security(?:\.js)?$/.test(specifier)) continue;
		if (/\bvalidateDirectory\b/.test(names)) return true;
	}
	return false;
}

/**
 * Split a call's argument list at top-level commas, respecting nesting and
 * string literals. Returns null when the parens are unbalanced.
 * `openParenIndex` must point at the '(' itself.
 */
export function splitCallArguments(
	source: string,
	openParenIndex: number,
): string[] | null {
	let depth = 0;
	let current = '';
	const args: string[] = [];
	let quote: string | null = null;
	for (let i = openParenIndex; i < source.length; i++) {
		const ch = source[i] as string;
		if (quote) {
			current += ch;
			if (ch === '\\') {
				current += source[i + 1] ?? '';
				i++;
			} else if (ch === quote) quote = null;
			continue;
		}
		if (ch === "'" || ch === '"' || ch === '`') {
			quote = ch;
			current += ch;
			continue;
		}
		if (ch === '(' || ch === '[' || ch === '{') {
			depth++;
			if (depth === 1) continue; // skip the opening paren itself
			current += ch;
			continue;
		}
		if (ch === ')' || ch === ']' || ch === '}') {
			depth--;
			if (depth === 0) {
				if (current.trim() !== '') args.push(current.trim());
				return args;
			}
			current += ch;
			continue;
		}
		if (ch === ',' && depth === 1) {
			args.push(current.trim());
			current = '';
			continue;
		}
		current += ch;
	}
	return null; // unbalanced
}

export interface Violation {
	file: string;
	line: number;
	rule: 'M' | 'P';
	detail: string;
}

function lineOf(source: string, index: number): number {
	return source.slice(0, index).split('\n').length;
}

/** RULE M over one file. `relPath` is repo-relative with OS separators. */
export function scanFileForMisapplication(
	relPath: string,
	rawSource: string,
): Violation[] {
	if (relPath.endsWith(VALIDATOR_MODULE)) return [];
	const source = blankComments(rawSource);
	if (!importsPathSecurityValidateDirectory(source)) return [];

	const violations: Violation[] = [];
	// Bare `validateDirectory(` and `_internals.validateDirectory(`, but not an
	// identifier that merely ENDS with the name (`assertValidateDirectory`).
	const callRe = /(?<![A-Za-z0-9_$])validateDirectory\s*\(/g;
	for (const match of source.matchAll(callRe)) {
		const openParen = source.indexOf('(', match.index as number);
		const args = splitCallArguments(source, openParen);
		if (args === null) continue; // unbalanced — cannot judge, do not guess
		if (args.length !== 1) continue; // local 2-arg helpers are a different function
		const arg = args[0] as string;
		if (!looksLikeProjectDirectory(arg)) continue;
		violations.push({
			file: relPath.split('\\').join('/'),
			line: lineOf(source, match.index as number),
			rule: 'M',
			detail:
				`validateDirectory(${arg}) — validateDirectory rejects ALL absolute paths ` +
				`(it guards untrusted RELATIVE sub-paths). A trusted project root is always ` +
				`absolute, so this throws on every real invocation. Use validateProjectDirectory(${arg}).`,
		});
	}
	return violations;
}

export function scanTreeForMisapplication(): Violation[] {
	return listSourceFiles().flatMap((rel) =>
		scanFileForMisapplication(rel, readFileSync(join(REPO_ROOT, rel), 'utf-8')),
	);
}

/**
 * Entry points that receive a TRUSTED, absolute project root and must validate
 * it with `validateProjectDirectory`. Hand-maintained on purpose: adding a row
 * is the deliberate act of declaring "this function takes a project root", and
 * RULE P then holds it to that forever.
 */
export const GUARDED_ENTRY_POINTS: ReadonlyArray<{
	file: string;
	fn: string;
	/**
	 * The PARAMETER carrying the trusted root. RULE P requires
	 * `validateProjectDirectory(<param>)` specifically, and requires `<param>` to
	 * be a declared parameter of `fn` — added in #1619 round 6, because before
	 * that the rule accepted ANY `validateProjectDirectory(` call in the body,
	 * so validating an unrelated local would have satisfied it while the actual
	 * root went unchecked.
	 */
	param: string;
}> = [
	{
		file: 'src/services/context-budget-service.ts',
		fn: 'getContextBudgetReport',
		param: 'directory',
	},
	{
		file: 'src/services/context-budget-service.ts',
		fn: 'formatBudgetWarning',
		param: 'directory',
	},
	{
		file: 'src/services/run-memory.ts',
		fn: 'recordOutcome',
		param: 'directory',
	},
	{
		file: 'src/services/run-memory.ts',
		fn: 'getTaskHistory',
		param: 'directory',
	},
	{
		file: 'src/services/run-memory.ts',
		fn: 'getRunMemorySummary',
		param: 'directory',
	},
	// `recordTaskAttempt` (added by #2119) is deliberately absent: it takes a
	// root but validates transitively, delegating every filesystem touch to
	// `getTaskHistory` and `recordOutcome`, both of which are rows above. Adding
	// a row for it would demand a redundant direct call.
];

/**
 * Declared parameter names of a top-level `function <fnName>(`, or null when the
 * declaration is absent. Only the leading identifier of each parameter is taken,
 * so `directory: string` yields `directory` and a destructured parameter yields
 * an empty entry that can never match a registry row.
 */
export function extractFunctionParams(
	source: string,
	fnName: string,
): string[] | null {
	const declRe = new RegExp(
		`(?:export\\s+)?(?:async\\s+)?function\\s+${fnName}\\s*\\(`,
	);
	const match = declRe.exec(source);
	if (!match) return null;
	const open = (match.index as number) + match[0].length - 1;
	let depth = 0;
	for (let i = open; i < source.length; i++) {
		const ch = source[i];
		if (ch === '(') depth++;
		else if (ch === ')') {
			depth--;
			if (depth === 0) {
				return source
					.slice(open + 1, i)
					.split(',')
					.map((raw) => /^\s*([A-Za-z0-9_$]+)/.exec(raw)?.[1] ?? '')
					.filter((name) => name.length > 0);
			}
		}
	}
	return null;
}

/**
 * Extract a top-level function's body by brace balance. Returns null when the
 * declaration is absent — RULE P treats that as a violation (a renamed or
 * deleted entry point must be re-declared here, not silently dropped).
 */
export function extractFunctionBody(
	source: string,
	fnName: string,
): string | null {
	const declRe = new RegExp(
		`(?:export\\s+)?(?:async\\s+)?function\\s+${fnName}\\s*\\(`,
		'g',
	);
	const match = declRe.exec(source);
	if (!match) return null;
	const bodyStart = source.indexOf(
		'{',
		(match.index as number) + match[0].length,
	);
	if (bodyStart === -1) return null;
	let depth = 0;
	for (let i = bodyStart; i < source.length; i++) {
		const ch = source[i];
		if (ch === '{') depth++;
		else if (ch === '}') {
			depth--;
			if (depth === 0) return source.slice(bodyStart, i + 1);
		}
	}
	return null;
}

/** RULE P over the declared entry points. */
export function scanGuardedEntryPoints(): Violation[] {
	const violations: Violation[] = [];
	const cache = new Map<string, string>();
	for (const { file, fn, param } of GUARDED_ENTRY_POINTS) {
		let source = cache.get(file);
		if (source === undefined) {
			source = blankComments(readFileSync(join(REPO_ROOT, file), 'utf-8'));
			cache.set(file, source);
		}
		const body = extractFunctionBody(source, fn);
		if (body === null) {
			violations.push({
				file,
				line: 1,
				rule: 'P',
				detail: `declared guarded entry point ${fn}() was not found — if it was renamed or removed, update GUARDED_ENTRY_POINTS.`,
			});
			continue;
		}
		const line = lineOf(source, source.indexOf(body));
		const params = extractFunctionParams(source, fn);
		if (params === null || !params.includes(param)) {
			violations.push({
				file,
				line,
				rule: 'P',
				detail: `GUARDED_ENTRY_POINTS declares '${param}' as ${fn}()'s trusted-root parameter, but ${fn}() has no such parameter (found: ${params?.join(', ') ?? '<unparsed>'}). Update the row to name the real parameter.`,
			});
			continue;
		}
		// Either spelling satisfies the rule: `validateWorkspaceRoot` is a thin
		// delegate to `validateProjectDirectory` (src/utils/path-security.ts), so
		// both enforce the identical contract. Two names exist because #2119 and
		// #1619 fixed the same misapplication concurrently; the delegate is kept
		// so the merged name stays greppable rather than churning every caller.
		const validatesRoot = new RegExp(
			`(?<![A-Za-z0-9_$])(?:validateProjectDirectory|validateWorkspaceRoot)\\s*\\(\\s*${param}\\s*[,)]`,
		).test(body);
		if (!validatesRoot) {
			violations.push({
				file,
				line,
				rule: 'P',
				detail: `${fn}() takes a trusted project root in '${param}' but never calls validateProjectDirectory(${param}) or validateWorkspaceRoot(${param}) — an empty or relative root would resolve .swarm/ against the host process cwd (invariant 4). Validating some OTHER value does not satisfy this rule.`,
			});
		}
	}
	return violations;
}

/** Exposed so the assertions can prove the scanner actually reads source. */
export function countSourceFiles(): number {
	return listSourceFiles().length;
}
