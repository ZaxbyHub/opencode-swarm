#!/usr/bin/env bun
/**
 * FR-002 / issue #1746 item 3 — skill-content pre-push check.
 *
 * Detects when a changed skill file breaks a test assertion that uses toContain
 * or toMatch to verify exact phrases from that skill.  Breakage only surfaces in
 * CI today; this check surfaces it locally before push.
 *
 * Detects broken assertions by:
 *   1. Getting changed skill files from the working tree, or from the CI PR
 *      merge-base range when the checkout is already committed
 *   2. Finding test files that assert phrases from those skill files
 *   3. Extracting the toContain/toMatch assertion strings
 *   4. Verifying each phrase is still present in the new skill content
 *
 * Exit codes:
 *   0 — no broken assertions (or no skill files changed)
 *   1 — one or more broken assertions found
 *
 * Usage: bun run scripts/check-skill-assertions.ts
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'..',
);

const GLOB_OPENCODE = '.opencode/skills';
const GLOB_CLAUDE = '.claude/skills';
const SKILL_GLOB_PATTERNS = [
	'.opencode/skills/**/*.md',
	'.claude/skills/**/*.md',
];

/** Result of checking a single broken assertion. */
export interface BrokenAssertion {
	testFile: string;
	line: number;
	skillFile: string;
	phrase: string;
	/** Kind of assertion that was checked. 'toContain' = literal substring; 'toMatch' = compiled-regex; 'malformed-regex' = toMatch whose pattern failed to compile. */
	assertionKind: 'toContain' | 'toMatch' | 'malformed-regex';
}

/** All findings from a run. */
export interface SkillAssertionResult {
	changedSkillFiles: string[];
	brokenAssertions: BrokenAssertion[];
}

/** Subprocess timeout in ms for git commands. */
const GIT_TIMEOUT_MS = 15_000;

/**
 * Spawn a git command and return stdout as a string.
 * Follows Invariant 3 (subprocess safety): array-form args, explicit cwd,
 * stdin:'ignore', timeout, bounded stdout, kill in finally.
 */
async function gitStdout(
	args: string[],
	cwd: string,
): Promise<string> {
	const proc = spawn('git', args, {
		stdin: 'ignore',
		cwd,
		timeout: GIT_TIMEOUT_MS,
	});
	let stdout = '';
	for await (const chunk of proc.stdout) {
		stdout += new TextDecoder().decode(chunk);
	}
	let stderr = '';
	for await (const chunk of proc.stderr) {
		stderr += new TextDecoder().decode(chunk);
	}
	const code = await new Promise<number>((resolve) => {
		proc.on('close', resolve);
	});
	if (proc.killed) {
		// Already logged below; return empty to avoid cascading failures
		return '';
	}
	if (code !== 0 && stdout.trim() === '') {
		console.error(`git ${args.join(' ')} exited ${code}: ${stderr.trim()}`);
	}
	proc.kill();
	return stdout;
}

/**
 * Return the list of skill files that differ from HEAD in the working tree.
 * Only returns files under .opencode/skills/ and .claude/skills/.
 */
async function getChangedSkillFiles(cwd: string): Promise<string[]> {
	let stdout = await gitStdout(
		['diff', '--name-only', 'HEAD'],
		cwd,
	);

	// A CI checkout is normally clean, so inspect the PR commit range when
	// GitHub exposes its base branch. Keep the working-tree diff as the local
	// pre-push behavior and fall back silently when the base ref is unavailable.
	if (!stdout.trim() && process.env.GITHUB_BASE_REF) {
		for (const baseRef of [
			`origin/${process.env.GITHUB_BASE_REF}`,
			process.env.GITHUB_BASE_REF,
		]) {
			const mergeBase = await gitStdout(['merge-base', 'HEAD', baseRef], cwd);
			if (!mergeBase.trim()) continue;
			stdout = await gitStdout(
				['diff', '--name-only', `${mergeBase.trim()}..HEAD`],
				cwd,
			);
			break;
		}
	}
	const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
	return lines.filter((file) => {
		const rel = path.relative(cwd, path.join(cwd, file)).replace(/\\/g, '/');
		return (
			rel.startsWith('.opencode/skills/') ||
			rel.startsWith('.claude/skills/')
		) && rel.endsWith('.md');
	});
}

/**
 * Find test files that reference a given skill file (by slug or full path).
 * Scans tests/unit/** and tests/integration/** for toContain/toMatch assertions
 * that mention the skill file path or slug.
 */
function findTestFilesReferencingSkill(
	skillFile: string,
	cwd: string,
): string[] {
	const slug = path.basename(path.dirname(skillFile)); // e.g. "brainstorm"
	const skillRel = skillFile.replace(/\\/g, '/'); // normalized
	const referringTests: string[] = [];

	const searchRoots = ['tests/unit', 'tests/integration'];
	for (const root of searchRoots) {
		const fullRoot = path.join(cwd, root);
		if (!fs.existsSync(fullRoot)) continue;
		scanDirForReferences(fullRoot, skillRel, slug, referringTests);
	}
	return [...new Set(referringTests)];
}

function scanDirForReferences(
	dir: string,
	skillRel: string,
	slug: string,
	out: string[],
): void {
	const entries = fs.readdirSync(dir, { withFileTypes: true });
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			// Skip node_modules, .git, and the detector's own test directory (FR-003):
			// the skill-assertion detector must not scan its own test files.
			if (
				entry.name === 'node_modules' ||
				entry.name === '.git' ||
				entry.name === 'scripts'
			)
				continue;
			scanDirForReferences(full, skillRel, slug, out);
		} else if (entry.isFile() && entry.name.endsWith('.test.ts')) {
		if (fs.readFileSync(full, 'utf-8').includes(slug)) {
				out.push(full);
			}
		}
	}
}

/**
 * Parse a JavaScript regex literal starting at index `start` (which must point
 * at the opening `/`). Properly handles escaped slashes and character classes.
 * Returns { source, flags } on success, or { malformed: true, source, flags }
 * if the literal is unterminated.
 */
function parseRegexLiteral(s: string, start: number): { source: string; flags: string } | { malformed: true; source: string; flags: string } {
	if (s[start] !== '/') return { malformed: true, source: '', flags: '' };
	let i = start + 1;
	let inClass = false;
	while (i < s.length) {
		const ch = s[i]!;
		if (ch === '\\') {
			i += 2;
			continue;
		}
		if (ch === '[') {
			inClass = true;
		} else if (ch === ']' && inClass) {
			inClass = false;
		} else if (ch === '/' && !inClass) {
			const source = s.slice(start + 1, i);
			let j = i + 1;
			while (j < s.length && /[A-Za-z]/.test(s[j]!)) j++;
			return { source, flags: s.slice(i + 1, j) };
		}
		i++;
	}
	return { malformed: true, source: s.slice(start + 1), flags: '' };
}

/**
 * Extract the phrase from a .toMatch(...) argument on a given line.
 * Handles three forms: /regex/, "string", 'string'.
 * Returns { phrase, flags, kind } where kind is 'toMatch' or 'malformed-regex'.
 * flags is the regex flags string (e.g. "i" for case-insensitive); empty for string forms.
 */
function extractToMatchPhrase(
	line: string,
	startIdx: number,
): { phrase: string; flags: string; kind: 'toMatch' | 'malformed-regex' } | null {
	// Skip past '(' and any whitespace before the argument
	let i = startIdx + 1;
	while (i < line.length && /\s/.test(line[i]!)) i++;
	if (i >= line.length) return null;

	const ch = line[i]!;

	// Regex literal: /
	if (ch === '/') {
		const result = parseRegexLiteral(line, i);
		if (!result) return null;
		if ('malformed' in result && result.malformed) {
			return { phrase: result.source, flags: result.flags, kind: 'malformed-regex' };
		}
		return { phrase: result.source, flags: result.flags, kind: 'toMatch' };
	}

	// Double-quoted string
	if (ch === '"') {
		let j = i + 1;
		while (j < line.length) {
			const c = line[j]!;
			if (c === '\\' && j + 1 < line.length) {
				j += 2;
				continue;
			}
			if (c === '"') {
				return { phrase: line.slice(i + 1, j), flags: '', kind: 'toMatch' };
			}
			j++;
		}
		return null;
	}

	// Single-quoted string
	if (ch === "'") {
		let j = i + 1;
		while (j < line.length) {
			const c = line[j]!;
			if (c === '\\' && j + 1 < line.length) {
				j += 2;
				continue;
			}
			if (c === "'") {
				return { phrase: line.slice(i + 1, j), flags: '', kind: 'toMatch' };
			}
			j++;
		}
		return null;
	}

	return null;
}

/**
 * Finds all string-literal regions (single-quoted, double-quoted, template)
 * in a given line. Each region is { start, end } where end is the closing
 * quote/backtick position (inclusive).
 */
function findStringRegions(line: string): Array<{ start: number; end: number }> {
	const regions: Array<{ start: number; end: number }> = [];
	let i = 0;
	while (i < line.length) {
		const ch = line[i]!;
		if (ch === '\\') {
			i += 2;
			continue;
		}
		if (ch === '"' || ch === "'") {
			const quote = ch;
			const start = i;
			i++;
			while (i < line.length) {
				if (line[i] === '\\') {
					i += 2;
					continue;
				}
				if (line[i] === quote) {
					regions.push({ start, end: i });
					i++;
					break;
				}
				i++;
			}
		} else if (ch === '`') {
			const start = i;
			i++;
			while (i < line.length && line[i] !== '`') {
				if (line[i] === '\\') {
					i += 2;
					continue;
				}
				if (line[i] === '$' && line[i + 1] === '{') {
					// Template expression — skip to matching }
					i += 2;
					let depth = 1;
					while (i < line.length && depth > 0) {
						if (line[i] === '{') depth++;
						else if (line[i] === '}') depth--;
						i++;
					}
				} else {
					i++;
				}
			}
			if (i < line.length) {
				regions.push({ start, end: i });
				i++;
			}
		} else {
			i++;
		}
	}
	return regions;
}

/**
 * Returns true if position `pos` in `line` falls inside a string literal
 * (single-quoted, double-quoted, or template literal). Used by extractAssertions
 * to skip phrases from fixture strings that merely look like assertions (FR-003).
 */
function isInsideStringLiteral(line: string, pos: number): boolean {
	const regions = findStringRegions(line);
	for (const reg of regions) {
		// Check: start <= pos <= end (pos is within the string literal)
		if (reg.start <= pos && pos <= reg.end) return true;
	}
	return false;
}

/**
 * Extract toContain and toMatch assertion phrases from a test file.
 * Returns an array of { line, phrase, kind } for each assertion found.
 */
function extractAssertions(
	testFile: string,
): Array<{ line: number; phrase: string; flags: string; kind: 'toContain' | 'toMatch' | 'malformed-regex' }> {
	const content = fs.readFileSync(testFile, 'utf-8');
	const lines = content.split('\n');
	const results: Array<{ line: number; phrase: string; flags: string; kind: 'toContain' | 'toMatch' | 'malformed-regex' }> = [];

	// toContain: captures the string content inside the parentheses
	const toContainRe = /\.toContain\s*\(\s*(['"`])((?:[^'"`\\]|\\.)*)\1\s*\)/g;

	// Regex to detect negated assertions — lines where .not precedes toContain/toMatch
	// in any chained form. A negated assertion never constitutes evidence that a
	// phrase must be present and must be skipped (FR-001).
	const negatedAssertionRe =
		/\.not\.(?:\w+(?:\.\w+)*\.)?\s*(?:toContain|toMatch)\s*\(/;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		// Skip lines with negated .not.toContain / .not.toMatch
		if (negatedAssertionRe.test(line)) continue;
		// toContain
		let m: RegExpExecArray | null;
		while ((m = toContainRe.exec(line)) !== null) {
			// Skip matches inside string literals (FR-003): phrases inside
			// fixture template strings must not be treated as real assertions.
			if (isInsideStringLiteral(line, m.index)) continue;
			// m[1] is the quote char, m[2] is the content between quotes
			const phrase = m[2] ?? '';
			if (phrase) {
				results.push({ line: i + 1, phrase, flags: '', kind: 'toContain' });
			}
		}
		toContainRe.lastIndex = 0;

		// toMatch: find each .toMatch( occurrence and extract the phrase
		// using the escape-aware parser (parseRegexLiteral for /regex/, string
		// extraction for "string" and 'string')
		const toMatchCallRe = /\.toMatch\s*\(/g;
		while ((m = toMatchCallRe.exec(line)) !== null) {
			// Skip matches inside string literals (FR-003)
			if (isInsideStringLiteral(line, m.index)) continue;
			const openParenIdx = m.index + m[0]!.length - 1; // position of '('
			const result = extractToMatchPhrase(line, openParenIdx);
			if (result) {
				results.push({ line: i + 1, phrase: result.phrase, flags: result.flags, kind: result.kind });
			}
		}
		toMatchCallRe.lastIndex = 0;
	}

	return results;
}

/**
 * Check assertions in a test file against the current content of a skill file.
 *
 * Scoping rule: only check an assertion if it is (a) chained off the variable
 * that was assigned from a readFileSync call that loaded THIS skill file, or
 * (b) explicitly attributed to the skill via a comment like `// skill-assertion:`.
 *
 * This prevents false positives when a test file mentions the skill slug in an
 * import/require but also has unrelated toContain/toMatch assertions.
 */
function checkAssertionsAgainstSkill(
	testFile: string,
	skillFile: string,
	skillContent: string,
): BrokenAssertion[] {
	const slug = path.basename(path.dirname(skillFile));
	const fileContent = fs.readFileSync(testFile, 'utf-8');
	const lines = fileContent.split('\n');

	// ---------------------------------------------------------------------------
	// Step 1: Track variables assigned from a readFileSync call that loaded this
	//         skill file.  These are ALWAYS valid skill variables — no confirmation needed.
	//         Handles multi-line calls with nested parentheses.
	// ---------------------------------------------------------------------------
	// skillVariables from PASS 1 (direct readFileSync): always confirmed
	const confirmedSkillVariables = new Map<string, true>();

	// Match: const <var> = readFileSync(  — then find the matching close paren
	// by counting depth.  This correctly handles nested join(process.cwd(), ...).
	const fnCallRe =
		/\bconst\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*(?:readFileSync|readFile|syncRead)\s*\(/g;

	let fnMatch: RegExpExecArray | null;
	while ((fnMatch = fnCallRe.exec(fileContent)) !== null) {
		const varName = fnMatch[1]!;
		const callStart = fnMatch.index + fnMatch[0].length; // position after "readFileSync("

		// Find the matching closing parenthesis by counting depth.
		let depth = 1;
		let i = callStart;
		while (i < fileContent.length && depth > 0) {
			const ch = fileContent[i]!;
			if (ch === '(') depth++;
			else if (ch === ')') depth--;
			i++;
		}
		const callBody = fileContent.slice(callStart, i - 1); // exclude the closing ')'

		// Extract every string literal in the call body and pick the one that
		// looks like an .md file path. Handle escapes inside the literal.
		// For `readFileSync(join(process.cwd(), '.claude/skills/...'))`, the
		// path is the only string ending in '.md'.
		const allStringsRe = /(['"`])((?:[^'"`\\]|\\.)*)\1/g;
		let filePath: string | null = null;
		let m: RegExpExecArray | null;
		while ((m = allStringsRe.exec(callBody)) !== null) {
			const candidate = m[2]!;
			if (candidate.endsWith('.md')) {
				filePath = candidate;
			}
		}
		if (filePath === null) continue;
		if (referencesSkillPath(filePath, slug) && filePath.endsWith('.md')) {
			// Direct readFileSync: always a valid skill variable
			confirmedSkillVariables.set(varName, true);
		}
	}

	// ---------------------------------------------------------------------------
	// Step 2: Track variables assigned from a path-expression that contains the slug.
	//         These are NOT direct readFileSync calls (e.g. const PATH = join(...)).
	//         We detect them and then check if readFileSync is later called with
	//         that variable as the first argument (PASS 3 confirmation).
	// ---------------------------------------------------------------------------
	// Path-expression variables need confirmation: collect them separately first.
	const pathExprVariables = new Map<string, true>();

	// Match: const <var> = <expression> where expression contains the slug path.
	// Covers: join(...), resolve(...), path.join(...), path.resolve(...).
	// Supports bare imports: `import { join } from 'node:path'` → join(...) (not path.join)
	const pathExprRe =
		/\bconst\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*(?:path\.)?(?:join|resolve)\s*\(/g;

	while ((fnMatch = pathExprRe.exec(fileContent)) !== null) {
		const varName = fnMatch[1]!;
		const callStart = fnMatch.index + fnMatch[0].length;
		// Extract call body: everything between the outer '(' and its matching ')'.
		// Track depth with proper string-literal awareness: quotes do NOT affect depth.
		let depth = 1;
		let i = callStart;
		let inString: "'" | '"' | '`' | null = null;
		while (i < fileContent.length && depth > 0) {
			const ch = fileContent[i]!;
			if (inString) {
				// Inside a string — only the matching close quote exits the string
				if (ch === inString && fileContent[i - 1] !== '\\') {
					inString = null;
				}
			} else if (ch === "'" || ch === '"' || ch === '`') {
				inString = ch;
			} else if (ch === '(') {
				depth++;
			} else if (ch === ')') {
				depth--;
			}
			i++;
		}
		// i is now one past the closing ')'; slice excludes it: [callStart, i-1]
		const callBody = fileContent.slice(callStart, i - 1);
		if (referencesSkillPath(callBody, slug)) {
			pathExprVariables.set(varName, true);
		}
	}

	// Also detect string-concatenation or template-literal path assignments:
	// const <var> = `<slug-path>` or const <var> = '<slug-path>' + ...
	const litPathRe =
		/\bconst\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*(?:[`'"])((?:[^`'\\]|\\.)*`|[^`'"]+[`'"])\s*\+/g;
	while ((fnMatch = litPathRe.exec(fileContent)) !== null) {
		const varName = fnMatch[1]!;
		const rhs = fnMatch[2] ?? '';
		if (referencesSkillPath(rhs, slug)) {
			pathExprVariables.set(varName, true);
		}
	}

	// ---------------------------------------------------------------------------
	// Step 3: Confirm path-expression variables by verifying readFileSync(variable) exists.
	//         Pass 1 variables (direct readFileSync) are already confirmed.
	// ---------------------------------------------------------------------------
	const readFileSyncArgRe =
		/\b(?:readFileSync|readFile|syncRead)\s*\(\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*,/g;

	while ((fnMatch = readFileSyncArgRe.exec(fileContent)) !== null) {
		const varName = fnMatch[1]!;
		// Only confirm if this variable was set as a path-expression variable in Step 2
		if (pathExprVariables.has(varName)) {
			confirmedSkillVariables.set(varName, true);
		}
	}

	// Also detect: const <resultVar> = readFileSync(<pathVar>, ...) where <pathVar>
	// is a confirmed path-expression variable. The result variable is then also
	// considered a skill variable (it holds the same skill content).
	const readResultRe =
		/\bconst\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*(?:readFileSync|readFile|syncRead)\s*\(\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*,/g;

	while ((fnMatch = readResultRe.exec(fileContent)) !== null) {
		const resultVar = fnMatch[1]!;
		const pathVar = fnMatch[2]!;
		// If the path argument is a confirmed path-expression variable, the result
		// variable also holds skill content and is eligible for assertion checking.
		if (confirmedSkillVariables.has(pathVar)) {
			confirmedSkillVariables.set(resultVar, true);
		}
	}

	// If no confirmed skill variables, nothing to check
	if (confirmedSkillVariables.size === 0) {
		return [];
	}

	// ---------------------------------------------------------------------------
	// Step 4: For each extracted assertion, verify it targets a confirmed skill variable.
	// ---------------------------------------------------------------------------
	const skillVarNames = [...confirmedSkillVariables.keys()];
	const skillExpectRe = new RegExp(
		`expect\\s*\\(\\s*(?:${skillVarNames.map(escapeRegExp).join('|')})(?:\\s*\\.\\w+\\s*)*\\s*\\)\\s*\\.(?:toContain|toMatch)\\s*\\(`,
	);

	const broken: BrokenAssertion[] = [];
	const assertions = extractAssertions(testFile);

	for (const { line: assertionLine, phrase, flags, kind } of assertions) {
		// FR-004: attribute an assertion to a skill only when the EXACT assertion
		// line itself (not a ±2 window) chains off a confirmed skill variable.
		// Window-based proximity is never sufficient.
		const lineIdx = assertionLine - 1;
		const exactLine = lines[lineIdx] ?? '';

		if (!skillExpectRe.test(exactLine)) continue;

		// Evaluate the assertion based on its kind:
		// - toContain: literal substring check
		// - toMatch: compiled-regex check (phrase is a regex source)
		// - malformed-regex: directly a broken assertion (parseRegexLiteral already determined it couldn't compile)
		if (kind === 'malformed-regex') {
			broken.push({
				testFile,
				line: assertionLine,
				skillFile,
				phrase,
				assertionKind: 'malformed-regex',
			});
		} else if (kind === 'toMatch') {
			try {
				// eslint-disable-next-line no-new
				new RegExp(phrase, flags); // validate compilation with flags
				if (!new RegExp(phrase, flags).test(skillContent)) {
					broken.push({
						testFile,
						line: assertionLine,
						skillFile,
						phrase,
						assertionKind: 'toMatch',
					});
				}
			} catch {
				// Malformed regex source — treat as broken assertion
				broken.push({
					testFile,
					line: assertionLine,
					skillFile,
					phrase,
					assertionKind: 'malformed-regex',
				});
			}
		} else {
			// toContain: literal substring check
			if (!skillContent.includes(phrase)) {
				broken.push({
					testFile,
					line: assertionLine,
					skillFile,
					phrase,
					assertionKind: 'toContain',
				});
			}
		}
	}

	return broken;
}

/** Escape special RegExp characters in a string. */
function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * True if `text` references skill `slug` via an actual `skills/<slug>` path
 * segment or a `'skills', '<slug>'`-style multi-arg join/resolve call — not
 * merely as a bare substring. A bare-substring match (`text.includes(slug)`)
 * false-positives whenever a slug collides with an unrelated common
 * substring: slug "swarm" matches the ubiquitous runtime directory
 * `.swarm/` (e.g. `.swarm/close-summary.md`), which is not the skill file
 * `.claude/skills/swarm/SKILL.md` at all.
 */
function referencesSkillPath(text: string, slug: string): boolean {
	const escapedSlug = escapeRegExp(slug);
	const normalized = text.replace(/\\/g, '/');
	if (new RegExp(`skills/${escapedSlug}(?:/|$)`).test(normalized)) return true;
	if (new RegExp(`skills['"\`]\\s*,\\s*['"\`]${escapedSlug}['"\`]`).test(text)) {
		return true;
	}
	return false;
}

/**
 * Main entry point: find changed skill files and check their assertions.
 * Exported for reuse by drift-check.ts; does NOT call process.exit.
 */
export async function checkSkillAssertions(
	cwd: string = REPO_ROOT,
): Promise<SkillAssertionResult> {
	const changed = await getChangedSkillFiles(cwd);

	if (changed.length === 0) {
		return { changedSkillFiles: [], brokenAssertions: [] };
	}

	const brokenAssertions: BrokenAssertion[] = [];

	for (const skillFile of changed) {
		const fullPath = path.join(cwd, skillFile);
		if (!fs.existsSync(fullPath)) continue;

		const skillContent = fs.readFileSync(fullPath, 'utf-8');
		const referencingTests = findTestFilesReferencingSkill(skillFile, cwd);

		for (const testFile of referencingTests) {
			const broken = checkAssertionsAgainstSkill(
				testFile,
				skillFile,
				skillContent,
			);
			brokenAssertions.push(...broken);
		}
	}

	return { changedSkillFiles: changed, brokenAssertions };
}

/**
 * Format broken assertions as GitHub Actions annotations + human-readable lines.
 */
export function formatBrokenAssertions(
	result: SkillAssertionResult,
): string[] {
	const lines: string[] = [];

	if (result.brokenAssertions.length === 0) {
		return lines;
	}

	for (const b of result.brokenAssertions) {
		const msg =
			`[skill-assertion] "${b.phrase}" — assertion in ${b.testFile}:${b.line} ` +
			`references "${b.skillFile}" but phrase is no longer present`;
		lines.push(`::notice file=${b.testFile},line=${b.line}::${msg}`);
	}

	return lines;
}

async function main(): Promise<void> {
	const start = Date.now();
	const result = await checkSkillAssertions(REPO_ROOT);
	const elapsed = Date.now() - start;

	if (result.brokenAssertions.length > 0) {
		console.error(
			`\nskill-assertions: ${result.brokenAssertions.length} broken assertion(s) found in ${result.changedSkillFiles.join(', ')}`,
		);
		for (const line of formatBrokenAssertions(result)) {
			console.log(line);
		}
		console.error(
			`\nskill-assertions: check completed in ${elapsed}ms (advisory)`,
		);
		// FR-006: exit 0 by default (advisory, non-blocking). Set
		// SKILL_ASSERTIONS_STRICT=1 to opt into hard-fail behavior.
		if (process.env.SKILL_ASSERTIONS_STRICT === '1') {
			process.exit(1);
		}
	}

	if (result.changedSkillFiles.length > 0) {
		console.log(
			`skill-assertions: ${result.changedSkillFiles.length} skill file(s) changed — ${result.brokenAssertions.length} broken assertion(s) (${elapsed}ms)`,
		);
	} else {
		console.log('skill-assertions: no skill files changed — nothing to check');
	}
}

if (import.meta.main) {
	main();
}
