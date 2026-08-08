#!/usr/bin/env bun
/**
 * CI enforcement for issue #2063 E2 — "runtime-surfaced agent guidance
 * referencing resources absent from installed deployments" ratchet.
 *
 * The plugin ships as a built `dist/` bundle plus a small set of skill
 * markdown files (see `package.json#files`); the `src/` tree is NEVER part of
 * an installed deployment. When a thrown gate error, an advisory, an agent
 * system prompt, or a shipped skill tells an agent to go read (or fix)
 * `src/some/file.ts` as remediation, that instruction is unfollowable at
 * runtime and misdirects recovery (issue #2063 root cause class T).
 *
 * This script scans three runtime-surfaced text surfaces for `src/`-style
 * path references and enforces a checked-in baseline ratchet
 * (`scripts/runtime-src-refs-baseline.json`):
 *
 *   (a) String/template literal content inside `throw new Error(` and
 *       `pushAdvisory(` call expressions under `src/hooks/` and `src/tools/`.
 *       Comments elsewhere in the file are not scanned — only the call's
 *       argument span — so descriptive `// see src/foo.ts` comments outside
 *       the thrown/pushed text never false-positive.
 *   (b) Agent system-prompt content in `src/agents/*.ts` (top-level files
 *       only). `//` line comments and `/* *\/` block comments are stripped
 *       before scanning so code comments referencing `src/` paths (a normal,
 *       legitimate pattern in this repo) do not false-positive.
 *   (c) Shipped agent-facing skill files: `.opencode/skills/<name>/SKILL.md`
 *       for exactly the skill names listed in `package.json#files`. Skills
 *       not shipped (e.g. `.opencode/skills/generated/**`) are out of scope —
 *       they never reach an installed deployment. The `.claude/skills/**`
 *       mirrors are covered TRANSITIVELY: `bun run drift:check` already
 *       enforces byte-identity between the `.opencode` and `.claude` skill
 *       trees, so a `.opencode` skill passing this scan implies its `.claude`
 *       mirror is identical — no separate `.claude` scan is needed here.
 *
 * Baseline ratchet semantics (keyed by (file, match) — NEVER line numbers, so
 * incidental line-number churn never invalidates the baseline):
 *   - Every entry has exactly one category: `illustrative-example` (a
 *     `src/foo.ts`-style placeholder in worked-example text),
 *     `repo-development` (a skill whose audience is opencode-swarm
 *     contributors developing THIS repo, where a real `src/` path is
 *     legitimate), or `provenance` (a residual descriptive reference).
 *   - `instructional-pointer` (an agent is told to go read/fix a `src/` file
 *     as remediation for a runtime problem) is a BANNED category. It must
 *     never be baselined — fix the misdirection at the source instead.
 *   - The scanner FAILS (exit 1) when: (1) a found reference is not in the
 *     baseline; (2) a baseline entry matches nothing in the current tree
 *     (stale-entry check — the baseline cannot rot); (3) a baseline entry
 *     declares `instructional-pointer` or any category outside the allowed
 *     set.
 *
 * Usage: bun run scripts/check-runtime-src-refs.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'..',
);
const BASELINE_PATH = path.join(
	REPO_ROOT,
	'scripts',
	'runtime-src-refs-baseline.json',
);

export const ALLOWED_CATEGORIES = [
	'illustrative-example',
	'repo-development',
	'provenance',
] as const;
export type AllowedCategory = (typeof ALLOWED_CATEGORIES)[number];

/** Category values that are explicitly banned from the baseline. */
export const BANNED_CATEGORIES = ['instructional-pointer'] as const;

export interface BaselineEntry {
	file: string;
	match: string;
	category: string;
	justification: string;
}

export interface Finding {
	file: string;
	match: string;
}

/**
 * The `src/`-path-reference regex. Requires a recognized source-file
 * extension (`.ts`, `.js`, `.md`) so that incidental text like a bare
 * "src/" directory mention or a markdown URL fragment ending mid-path never
 * matches — only what looks like an actual repo-relative file reference.
 */
export const SRC_REF_PATTERN = /\bsrc\/[a-z][a-z0-9_/-]*\.(?:ts|js|md)\b/g;

/** Normalize a filesystem path to forward slashes for cross-platform keys. */
export function toPosixPath(p: string): string {
	return p.split(path.sep).join('/');
}

/**
 * Find every match of SRC_REF_PATTERN in `text`, returning the matched
 * strings (may contain duplicates — callers dedupe via a Set when building
 * a (file, match) key set).
 */
export function findSrcRefs(text: string): string[] {
	const matches: string[] = [];
	const re = new RegExp(SRC_REF_PATTERN.source, 'g');
	let m: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
	while ((m = re.exec(text)) !== null) {
		matches.push(m[0]);
	}
	return matches;
}

// ---------------------------------------------------------------------------
// Surface (a): throw new Error(...) / pushAdvisory(...) call argument spans
// under src/hooks/ and src/tools/.
// ---------------------------------------------------------------------------

/**
 * Extract the raw text of every call-argument span for calls matching
 * `calleePattern` (a regex whose match ends immediately before the opening
 * `(`, e.g. `/\bthrow\s+new\s+Error\s*\(/g` or `/\bpushAdvisory\s*\(/g`).
 * Balances parens while tracking (naively) whether we're inside a
 * string/template literal, so a `)` inside a string doesn't prematurely
 * close the span. Bounded by file size; no recursion.
 */
export function extractCallArgSpans(
	source: string,
	calleePattern: RegExp,
): string[] {
	const spans: string[] = [];
	const re = new RegExp(calleePattern.source, 'g');
	let m: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
	while ((m = re.exec(source)) !== null) {
		const start = m.index + m[0].length;
		let depth = 1;
		let i = start;
		let inStr: string | null = null;
		while (i < source.length && depth > 0) {
			const ch = source[i];
			if (inStr) {
				if (ch === '\\') {
					i += 2;
					continue;
				}
				if (ch === inStr) inStr = null;
			} else {
				if (ch === '"' || ch === "'" || ch === '`') {
					inStr = ch;
				} else if (ch === '(') {
					depth++;
				} else if (ch === ')') {
					depth--;
				}
			}
			i++;
		}
		spans.push(source.slice(start, Math.max(start, i - 1)));
	}
	return spans;
}

const THROW_NEW_ERROR_PATTERN = /\bthrow\s+new\s+Error\s*\(/;
const PUSH_ADVISORY_PATTERN = /\bpushAdvisory\s*\(/;

/**
 * Scan a single source file's throw/pushAdvisory call-argument spans and
 * return every distinct src/-ref match found within them.
 */
export function scanThrowAndAdvisorySpans(source: string): string[] {
	const spans = [
		...extractCallArgSpans(source, THROW_NEW_ERROR_PATTERN),
		...extractCallArgSpans(source, PUSH_ADVISORY_PATTERN),
	];
	const matches: string[] = [];
	for (const span of spans) {
		matches.push(...findSrcRefs(span));
	}
	return matches;
}

// ---------------------------------------------------------------------------
// Surface (b): src/agents/*.ts prompt content (comments stripped).
// ---------------------------------------------------------------------------

/**
 * Strip `//` line comments and `/* *\/` block comments from `source`. This
 * is a line-oriented heuristic (not a full tokenizer): it does not attempt
 * to distinguish `//`/`/*` occurring inside a string or template literal
 * from a real comment. That's an acceptable trade-off here because agent
 * prompt files in this repo do not embed literal `//` or `/* *\/` sequences
 * in prompt text, and the goal is only to avoid flagging genuine source-code
 * comments (a normal, legitimate `src/`-reference pattern) as prompt content.
 */
export function stripJsComments(source: string): string {
	const lines = source.split('\n');
	const kept: string[] = [];
	let inBlockComment = false;
	for (let line of lines) {
		if (inBlockComment) {
			const endIdx = line.indexOf('*/');
			if (endIdx === -1) {
				continue;
			}
			line = line.slice(endIdx + 2);
			inBlockComment = false;
		}
		const blockStart = line.indexOf('/*');
		if (blockStart !== -1) {
			const blockEnd = line.indexOf('*/', blockStart + 2);
			if (blockEnd === -1) {
				line = line.slice(0, blockStart);
				inBlockComment = true;
			} else {
				line = line.slice(0, blockStart) + line.slice(blockEnd + 2);
			}
		}
		const lineCommentIdx = line.indexOf('//');
		if (lineCommentIdx !== -1) {
			line = line.slice(0, lineCommentIdx);
		}
		kept.push(line);
	}
	return kept.join('\n');
}

/**
 * Scan an `src/agents/*.ts` file's comment-stripped content for src/-ref
 * matches. Scans the whole file (not just template-literal spans) because,
 * once comments are stripped, the file content is dominated by prompt
 * template literals and small amounts of scaffolding code; scanning the
 * comment-stripped whole file is the pragmatic approach the plan calls for.
 */
export function scanAgentPromptFile(source: string): string[] {
	return findSrcRefs(stripJsComments(source));
}

// ---------------------------------------------------------------------------
// Surface (c): shipped skill files.
// ---------------------------------------------------------------------------

/**
 * Derive the set of shipped `.opencode/skills/<name>` skill names from
 * `package.json#files`.
 */
export function deriveShippedSkillNames(packageJson: {
	files?: string[];
}): string[] {
	const files = packageJson.files ?? [];
	const names: string[] = [];
	for (const entry of files) {
		const prefix = '.opencode/skills/';
		if (!entry.startsWith(prefix)) continue;
		const rest = entry.slice(prefix.length);
		const segment = rest.split('/')[0];
		if (segment) names.push(segment);
	}
	return names;
}

// ---------------------------------------------------------------------------
// File-tree walking.
// ---------------------------------------------------------------------------

function* walkFiles(dir: string, extensions: string[]): Generator<string> {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (entry.name === 'node_modules' || entry.name === 'dist') continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			yield* walkFiles(full, extensions);
		} else if (
			entry.isFile() &&
			extensions.some((ext) => entry.name.endsWith(ext))
		) {
			yield full;
		}
	}
}

// ---------------------------------------------------------------------------
// Top-level collection.
// ---------------------------------------------------------------------------

/**
 * Run all three scan surfaces over the repo rooted at `repoRoot` and return
 * every (file, match) finding, deduplicated. `file` is a repo-relative,
 * forward-slash-normalized path.
 */
export function collectFindings(repoRoot: string): Finding[] {
	const seen = new Set<string>();
	const findings: Finding[] = [];

	const add = (absFile: string, match: string): void => {
		const relFile = toPosixPath(path.relative(repoRoot, absFile));
		const key = `${relFile}\0${match}`;
		if (seen.has(key)) return;
		seen.add(key);
		findings.push({ file: relFile, match });
	};

	// (a) throw new Error(...) / pushAdvisory(...) under src/hooks/ + src/tools/.
	for (const dir of ['src/hooks', 'src/tools']) {
		const absDir = path.join(repoRoot, dir);
		for (const file of walkFiles(absDir, ['.ts'])) {
			if (file.endsWith('.test.ts')) continue;
			const source = fs.readFileSync(file, 'utf-8');
			for (const match of scanThrowAndAdvisorySpans(source)) {
				add(file, match);
			}
		}
	}

	// (b) src/agents/*.ts (top-level files only, no recursion into subdirs —
	// there are none today, but this stays scoped to the plan's spec).
	const agentsDir = path.join(repoRoot, 'src', 'agents');
	let agentEntries: fs.Dirent[] = [];
	try {
		agentEntries = fs.readdirSync(agentsDir, { withFileTypes: true });
	} catch {
		agentEntries = [];
	}
	for (const entry of agentEntries) {
		if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
		if (entry.name.endsWith('.test.ts')) continue;
		const file = path.join(agentsDir, entry.name);
		const source = fs.readFileSync(file, 'utf-8');
		for (const match of scanAgentPromptFile(source)) {
			add(file, match);
		}
	}

	// (c) shipped skill files.
	const packageJsonPath = path.join(repoRoot, 'package.json');
	const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
	const skillNames = deriveShippedSkillNames(packageJson);
	for (const name of skillNames) {
		const skillFile = path.join(
			repoRoot,
			'.opencode',
			'skills',
			name,
			'SKILL.md',
		);
		if (!fs.existsSync(skillFile)) continue;
		const source = fs.readFileSync(skillFile, 'utf-8');
		for (const match of findSrcRefs(source)) {
			add(skillFile, match);
		}
	}

	return findings;
}

// ---------------------------------------------------------------------------
// Baseline loading + comparison.
// ---------------------------------------------------------------------------

export function loadBaseline(baselinePath: string): BaselineEntry[] {
	if (!fs.existsSync(baselinePath)) return [];
	const raw = fs.readFileSync(baselinePath, 'utf-8');
	const parsed = JSON.parse(raw);
	if (!Array.isArray(parsed)) {
		throw new Error(`Baseline file ${baselinePath} must be a JSON array.`);
	}
	return parsed as BaselineEntry[];
}

export function baselineKey(file: string, match: string): string {
	return `${toPosixPath(file)}\0${match}`;
}

export interface CheckResult {
	/** Findings present in the tree but absent from the baseline. */
	nonBaselineFindings: Finding[];
	/** Baseline entries that matched nothing in the current tree. */
	staleEntries: BaselineEntry[];
	/** Baseline entries using a banned or unrecognized category. */
	bannedCategoryEntries: BaselineEntry[];
}

/**
 * Pure comparison function: given the current findings and the baseline,
 * compute every kind of violation. Exported so the CI drift checker (or
 * tests) can reuse this without re-scanning the filesystem.
 */
export function checkAgainstBaseline(
	findings: Finding[],
	baseline: BaselineEntry[],
): CheckResult {
	const baselineByKey = new Map<string, BaselineEntry>();
	for (const entry of baseline) {
		baselineByKey.set(baselineKey(entry.file, entry.match), entry);
	}

	const findingKeys = new Set(
		findings.map((f) => baselineKey(f.file, f.match)),
	);

	const nonBaselineFindings = findings.filter(
		(f) => !baselineByKey.has(baselineKey(f.file, f.match)),
	);

	const staleEntries = baseline.filter(
		(entry) => !findingKeys.has(baselineKey(entry.file, entry.match)),
	);

	const allowedCategorySet = new Set<string>(ALLOWED_CATEGORIES);
	const bannedCategoryEntries = baseline.filter(
		(entry) => !allowedCategorySet.has(entry.category),
	);

	return { nonBaselineFindings, staleEntries, bannedCategoryEntries };
}

// ---------------------------------------------------------------------------
// CLI entry point.
// ---------------------------------------------------------------------------

function main(): void {
	const findings = collectFindings(REPO_ROOT);
	const baseline = loadBaseline(BASELINE_PATH);
	const result = checkAgainstBaseline(findings, baseline);

	const hasViolations =
		result.nonBaselineFindings.length > 0 ||
		result.staleEntries.length > 0 ||
		result.bannedCategoryEntries.length > 0;

	if (!hasViolations) {
		console.log(
			`Runtime src/ ref check passed: ${findings.length} reference(s) scanned, ` +
				`all covered by the ${baseline.length}-entry baseline, no banned categories.`,
		);
		return;
	}

	console.error('Runtime src/ ref check FAILED:\n');

	if (result.nonBaselineFindings.length > 0) {
		console.error(
			`${result.nonBaselineFindings.length} reference(s) not in the baseline:`,
		);
		for (const f of result.nonBaselineFindings) {
			console.error(`  - ${f.file}: "${f.match}"`);
		}
		console.error(
			'  Fix the misdirection at the source (preferred), or if the reference is a ' +
				'genuinely accepted illustrative-example / repo-development / provenance ' +
				'reference, add a justified entry to scripts/runtime-src-refs-baseline.json.\n',
		);
	}

	if (result.staleEntries.length > 0) {
		console.error(
			`${result.staleEntries.length} baseline entrie(s) match nothing in the current tree (stale):`,
		);
		for (const e of result.staleEntries) {
			console.error(`  - ${e.file}: "${e.match}"`);
		}
		console.error(
			'  Remove the stale entry from scripts/runtime-src-refs-baseline.json.\n',
		);
	}

	if (result.bannedCategoryEntries.length > 0) {
		console.error(
			`${result.bannedCategoryEntries.length} baseline entrie(s) use a banned or unrecognized category:`,
		);
		for (const e of result.bannedCategoryEntries) {
			console.error(`  - ${e.file}: "${e.match}" (category: "${e.category}")`);
		}
		console.error(
			'  "instructional-pointer" (an agent is told to go read/fix a src/ file as ' +
				'remediation) is banned outright — fix the misdirection, never baseline it. ' +
				`Allowed categories: ${ALLOWED_CATEGORIES.join(', ')}.\n`,
		);
	}

	process.exit(1);
}

if (import.meta.main) {
	main();
}
