/**
 * Inline char/token formula gate (#2107 §1 / #1616).
 *
 * Production source must not contain NEW inline char-to-token (or
 * token-to-char) estimation formulas. Every conversion routes through the
 * canonical estimator in src/hooks/utils.ts (estimateTokens /
 * estimateTokensFromCharCount / estimateCharsForTokens). The detector is
 * line-scoped and code-shaped: a line is flagged only when it contains a Math
 * rounding call AND a known conversion ratio AND a token/char context token.
 * File-level exemptions below each carry a justification and are the complete
 * allowlist.
 *
 * Standalone script (NOT a Check inside scripts/check-invariants.ts):
 * check-invariants.ts is the frozen TS port of the archived #2094 bash gate
 * and its stdout must stay byte-identical to that archive for the
 * legacy-oracle parity test (tests/unit/scripts/
 * check-bash-gates-legacy-oracle.test.ts). A NEW check appended to it would
 * break that parity on every bash-available platform, so this gate ships
 * separately — same convention as the #1976 advisory-push check, which the
 * archive also owns as its own script.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRepoRoot } from './check-invariants';

const SCRIPT_PATH = fileURLToPath(import.meta.url);

interface CheckResult {
	messages: string[];
	violations: number;
}

function toPosixRelative(root: string, file: string): string {
	return path.relative(root, file).replace(/\\/g, '/');
}

function listFiles(
	dir: string,
	options: { extensions: string[]; excludeDirs: Set<string> },
): string[] {
	const out: string[] = [];
	const walk = (current: string): void => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(current, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (options.excludeDirs.has(entry.name) && entry.isDirectory()) continue;
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) {
				walk(full);
			} else if (options.extensions.some((ext) => entry.name.endsWith(ext))) {
				out.push(full);
			}
		}
	};
	walk(dir);
	return out;
}

function readText(file: string): string {
	return fs.readFileSync(file, 'utf-8');
}

const CANONICAL_TOKEN_ESTIMATOR_MODULE = 'src/hooks/utils.ts';

const INLINE_TOKEN_FORMULA_ALLOWLIST: ReadonlyArray<{
	file: string;
	reason: string;
}> = [
	{
		file: 'src/hooks/context-usage.ts',
		reason: 'binary serialization-size heuristic in estimateToolInputCharacters '
			+ '(byteLength * 4 worst-case JSON-escaped char cost) — NOT a char→token '
			+ 'estimation; the module otherwise imports the canonical estimator.',
	},
	{
		file: 'src/background/lane-output-store.ts',
		reason: 'lane-output head/tail CHAR-budget split (Math.ceil/floor of budget/2 '
			+ 'around line 242) — a truncation-policy halving, not a char↔token '
			+ 'conversion.',
	},
	{
		file: 'src/consensus/miner.ts',
		reason: 'consensus excerpt sizing (maxExcerptChars * 2 clamped by a char cap '
			+ 'around line 457) — a domain excerpt policy, not a char↔token conversion.',
	},
	{
		file: 'src/hooks/knowledge-injector.ts',
		reason: 'three-regime injection-budget scaling (maxInjectChars * 0.5 / * 0.25 '
			+ 'around lines 1013–1014: half/quarter budget by context headroom) — a '
			+ 'budget policy on an already-char-denominated budget, not a char↔token '
			+ 'conversion; every actual token estimate in the module imports the '
			+ 'canonical helpers.',
	},
];

const TOKEN_FORMULA_RATIO_RE =
	/(?:0\.33|0\.25|0\.5(?!\d)|\/\s*3\.5|\/\s*0\.33|\/\s*[234](?![\d.])|\*\s*[234](?![\d.]))/;
const TOKEN_FORMULA_CONTEXT_RE = /[Tt]oken|[Cc]har/;
const TOKEN_FORMULA_SHAPE_RE = /Math\.(?:ceil|floor|max|min)\s*\(/;

/** Pure detector over one file's lines (exported for unit tests). */
export function findInlineTokenFormulaViolations(
	rel: string,
	lines: readonly string[],
): Array<{ lineNo: number; line: string }> {
	if (rel === CANONICAL_TOKEN_ESTIMATOR_MODULE) return [];
	if (
		INLINE_TOKEN_FORMULA_ALLOWLIST.some((entry) => entry.file === rel)
	) {
		return [];
	}
	const hits: Array<{ lineNo: number; line: string }> = [];
	lines.forEach((line, index) => {
		// Cheap pre-filters first.
		if (!TOKEN_FORMULA_CONTEXT_RE.test(line)) return;
		if (!TOKEN_FORMULA_SHAPE_RE.test(line)) return;
		if (!TOKEN_FORMULA_RATIO_RE.test(line)) return;
		hits.push({ lineNo: index + 1, line });
	});
	return hits;
}

export function checkInlineTokenFormula(repoRoot: string): CheckResult {
	const messages = [
		'=== Inline char/token formula gate: no conversions outside the canonical estimator (#1616/#2107) ===',
	];
	let violationFiles = 0;
	const details: string[] = [];
	const files = listFiles(path.join(repoRoot, 'src'), {
		extensions: ['.ts'],
		excludeDirs: new Set(['dist', 'node_modules', '__tests__']),
	});
	for (const file of files) {
		const rel = toPosixRelative(repoRoot, file);
		if (rel.endsWith('.test.ts') || rel.endsWith('.d.ts')) {
			continue;
		}
		const lines = readText(file).split(/\r?\n/);
		const violations = findInlineTokenFormulaViolations(rel, lines);
		if (violations.length === 0) continue;
		violationFiles++;
		for (const hit of violations) {
			details.push(`  ${rel}:${hit.lineNo}:${hit.line.trim()}`);
		}
	}
	if (violationFiles > 0) {
		messages.push(
			'ERROR: inline char/token conversion formula(s) found. All char↔token',
		);
		messages.push(
			'       math must route through src/hooks/utils.ts (estimateTokens,',
		);
		messages.push(
			'       estimateTokensFromCharCount, estimateCharsForTokens).',
		);
		messages.push(`Violations:\n${details.join('\n')}`);
		return { messages, violations: 1 };
	}
	messages.push(
		`OK — ${INLINE_TOKEN_FORMULA_ALLOWLIST.length} justified allowlist entr${INLINE_TOKEN_FORMULA_ALLOWLIST.length === 1 ? 'y' : 'ies'}; no inline formulas.`,
	);
	return { messages, violations: 0 };
}

export async function main(startDir: string = process.cwd()): Promise<number> {
	const repoRoot = await resolveRepoRoot(startDir);
	const result = checkInlineTokenFormula(repoRoot);
	for (const line of result.messages) {
		console.log(line);
	}
	if (result.violations > 0) {
		return 1;
	}
	return 0;
}

const isDirectRun =
	typeof process.argv[1] === 'string' &&
	path.resolve(process.argv[1]) === path.resolve(SCRIPT_PATH);

if (isDirectRun) {
	void main()
		.then((exitCode) => {
			process.exit(exitCode);
		})
		.catch((error) => {
			throw error;
		});
}
