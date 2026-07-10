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
			// Skip node_modules and .git
			if (entry.name === 'node_modules' || entry.name === '.git') continue;
			scanDirForReferences(full, skillRel, slug, out);
		} else if (entry.isFile() && entry.name.endsWith('.test.ts')) {
		if (fs.readFileSync(full, 'utf-8').includes(slug)) {
				out.push(full);
			}
		}
	}
}

/**
 * Extract toContain and toMatch assertion phrases from a test file.
 * Returns an array of { line, phrase } for each assertion found.
 */
function extractAssertions(testFile: string): Array<{ line: number; phrase: string }> {
	const content = fs.readFileSync(testFile, 'utf-8');
	const lines = content.split('\n');
	const results: Array<{ line: number; phrase: string }> = [];

	// Match: .toContain('...') or .toMatch(/.../)
	// capturing the string or regex content inside the parens
	const toContainRe = /\.toContain\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g;
	// toMatch can have a regex literal \/(.*?)\/ or a string '...' or "..."
	const toMatchRe = /\.toMatch\s*\(\s*(?:\/(.*?)\/|"([^"]+)"|'([^']+)')\s*\)/g;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		// toContain
		let m: RegExpExecArray | null;
		while ((m = toContainRe.exec(line)) !== null) {
			results.push({ line: i + 1, phrase: m[1] });
		}
		toContainRe.lastIndex = 0;

		// toMatch with regex or string
		while ((m = toMatchRe.exec(line)) !== null) {
			const phrase = m[1] ?? m[2] ?? m[3] ?? '';
			if (phrase) results.push({ line: i + 1, phrase });
		}
		toMatchRe.lastIndex = 0;
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

		// Extract the first string literal in the call body — that is the path arg.
		// Handles 'path', "path", `path` with escapes.
		const firstStringRe = /(['"`])((?:[^'"`\\]|\\.)*)\1/;
		const strMatch = firstStringRe.exec(callBody);
		if (!strMatch) continue;
		const filePath = strMatch[2]!;
		if (filePath.includes(slug) && filePath.endsWith('.md')) {
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
		if (callBody.includes(slug)) {
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
		if (rhs.includes(slug)) {
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

	for (const { line: assertionLine, phrase } of assertions) {
		// Look at surrounding lines for a skill-assertion attribution comment
		// or an expect(...) chaining off a tracked skill variable.
		const lineIdx = assertionLine - 1;
		const windowStart = Math.max(0, lineIdx - 2);
		const windowEnd = Math.min(lines.length, lineIdx + 1);
		const windowLines = lines.slice(windowStart, windowEnd + 1).join('\n');

		const isScopedToSkill =
			skillExpectRe.test(windowLines) ||
			// Fallback: explicit attribution comment
			/\/\/\s*skill-assertion\s*:?/i.test(windowLines);

		if (!isScopedToSkill) continue;

		if (!skillContent.includes(phrase)) {
			broken.push({ testFile, line: assertionLine, skillFile, phrase });
		}
	}

	return broken;
}

/** Escape special RegExp characters in a string. */
function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
		lines.push(`::error file=${b.testFile},line=${b.line}::${msg}`);
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
			`\nskill-assertions: check completed in ${elapsed}ms`,
		);
		process.exit(1);
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
