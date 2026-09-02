#!/usr/bin/env bun
/**
 * Issue #2349 (Phase 4.2 rung 3) — recurrence guardrail for the
 * "error-channel value read only for a boolean side-condition" defect class.
 *
 * Defect class: a host/library ERROR CHANNEL (a `.error` / `.errors` /
 * `.failure` member access) is read ONLY to answer a boolean question
 * (`=== undefined`, `!== undefined`, `== null`, `!= null`, `Boolean(...)`,
 * `!!...`) and the VALUE itself is discarded — nothing downstream can learn
 * WHY something failed. The instance fixed for #2349 was in
 * `src/tools/dispatch-lanes.ts`. This script prevents the class from
 * recurring elsewhere in `src/`.
 *
 * Written in TypeScript against the `typescript` compiler API (already a
 * devDependency), mirroring `check-bare-executable-spawn.ts`'s structure,
 * `_internals` DI seam, and exit-code conventions — a real AST walk avoids
 * the false positives/negatives a regex-only scan would produce on
 * multi-line conditions, optional chaining, and type-position text that
 * merely LOOKS like a member access.
 *
 * Predicate: a `PropertyAccessExpression` whose property name is `error`,
 * `errors`, or `failure` (e.g. `output.error`, `result?.errors`) is flagged
 * when its immediate parent is:
 *   1. a `BinaryExpression` with operator `===`/`!==`/`==`/`!=` where the
 *      OTHER operand is the `undefined` identifier or the `null` literal;
 *   2. a `CallExpression` whose callee is the `Boolean` identifier and the
 *      access is (one of) its argument(s);
 *   3. a double-negation (`!!expr`) — i.e. a `PrefixUnaryExpression` `!`
 *      whose own parent is also a `PrefixUnaryExpression` `!`.
 *
 * A flagged access is only a VIOLATION when the exact same identifier chain
 * (matched by source text, e.g. `"output.error"`) does not appear ANYWHERE
 * else inside the enclosing function body (nearest `ts.isFunctionLike`
 * ancestor, or the whole file for top-level code) OUTSIDE of other
 * boolean-only-position accesses of the same chain. In other words: every
 * occurrence of the chain in the function is a boolean-only read — none of
 * them forward the value anywhere. If the same chain is also read for its
 * VALUE somewhere else in the function (e.g. logged, stored, returned), the
 * access is not flagged — the value is not being discarded.
 *
 * Known limitation (documented, not silently swallowed): this is a
 * source-TEXT match on the chain (`node.getText()`), not a data-flow/alias
 * analysis. `const err = output.error; if (err) ...` is NOT caught (the
 * discard happens once removed from the member access) — out of scope for
 * this rung. A `catch (e) { ... }` block that discards `e` WITHOUT ever
 * accessing `e.error`/`e.message` etc. is also NOT caught — no member access
 * exists for the scanner to find. Both are believed rarer/lower-severity
 * than the direct-boolean-read shape #2349 exhibited; escalate to a rung-4
 * (data-flow) check if evidence of recurrence in those shapes appears.
 *
 * Allowlist ratchet (mirrors `scripts/mock-allowlist.txt` +
 * `bun run check:invariants` Check 4): `scripts/error-channel-discard-allowlist.txt`,
 * one `path:chainText` entry per line, `#` comments allowed, `# APPROVED-NEW:`
 * marker convention for reviewer visibility on new entries. Unlike
 * `check-runtime-src-refs.ts`'s baseline, this is NOT stale-entry-enforced
 * (same as mock-allowlist.txt) — an allowlist entry that stops matching
 * (e.g. because the code was fixed) is simply inert, not an error.
 *
 * Escape hatch: ERROR_CHANNEL_DISCARD_ENFORCE=0|false|no|off soft-warns
 * instead of hard-failing (mirrors TEST_CAP_ENFORCE's truth table — unset or
 * any other value enforces).
 *
 * Usage: bun run check:error-channel-discard
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'..',
);
const SRC_DIR = path.join(REPO_ROOT, 'src');
const ALLOWLIST_PATH = path.join(
	REPO_ROOT,
	'scripts',
	'error-channel-discard-allowlist.txt',
);

/** Member-expression property names treated as error channels. */
export const FLAGGED_PROPS: ReadonlySet<string> = new Set([
	'error',
	'errors',
	'failure',
]);

const EQ_NEQ_OPERATORS: ReadonlySet<ts.SyntaxKind> = new Set([
	ts.SyntaxKind.EqualsEqualsEqualsToken,
	ts.SyntaxKind.ExclamationEqualsEqualsToken,
	ts.SyntaxKind.EqualsEqualsToken,
	ts.SyntaxKind.ExclamationEqualsToken,
]);

/**
 * ERROR_CHANNEL_DISCARD_ENFORCE truth table (mirrors
 * check-test-file-cap.ts's resolveEnforce): unset, or any value other than
 * 0/false/no/off, → hard-fail (default enforce). 0/false/no/off → soft-warn.
 */
export function resolveEnforce(raw: string | undefined): boolean {
	if (raw === undefined) return true;
	switch (raw.toLowerCase()) {
		case '0':
		case 'false':
		case 'no':
		case 'off':
			return false;
		default:
			return true;
	}
}

/**
 * True when `node` (a flagged PropertyAccessExpression) sits in a
 * boolean-only-position per the predicate documented atop this file.
 */
export function isBooleanOnlyPosition(node: ts.PropertyAccessExpression): boolean {
	const parent = node.parent;
	if (!parent) return false;

	if (ts.isBinaryExpression(parent) && EQ_NEQ_OPERATORS.has(parent.operatorToken.kind)) {
		const other = parent.left === node ? parent.right : parent.left;
		if (ts.isIdentifier(other) && other.text === 'undefined') return true;
		if (other.kind === ts.SyntaxKind.NullKeyword) return true;
		return false;
	}

	if (
		ts.isCallExpression(parent) &&
		ts.isIdentifier(parent.expression) &&
		parent.expression.text === 'Boolean' &&
		parent.arguments.includes(node)
	) {
		return true;
	}

	if (
		ts.isPrefixUnaryExpression(parent) &&
		parent.operator === ts.SyntaxKind.ExclamationToken &&
		parent.operand === node
	) {
		const grandparent = parent.parent;
		if (
			grandparent &&
			ts.isPrefixUnaryExpression(grandparent) &&
			grandparent.operator === ts.SyntaxKind.ExclamationToken &&
			grandparent.operand === parent
		) {
			return true;
		}
	}

	return false;
}

export interface ErrorChannelDiscardViolation {
	file: string;
	line: number;
	chainText: string;
	snippet: string;
}

/**
 * Pure AST scan of one file's source text. No filesystem access — directly
 * unit-testable with fixture strings.
 */
export function scanSourceForErrorChannelDiscard(
	relPath: string,
	source: string,
): ErrorChannelDiscardViolation[] {
	const sf = ts.createSourceFile(
		relPath,
		source,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);
	const sourceLines = source.split('\n');

	function lineOf(pos: number): number {
		return sf.getLineAndCharacterOfPosition(pos).line + 1;
	}
	function snippetAt(pos: number): string {
		return (sourceLines[lineOf(pos) - 1] ?? '').trim();
	}

	// scope -> chainText -> total occurrence count of that exact chain text
	// anywhere (boolean-position or not) inside the scope.
	const allAccessCounts = new Map<ts.Node, Map<string, number>>();
	// scope -> chainText -> { count of boolean-position occurrences, first line }
	const candidateCounts = new Map<
		ts.Node,
		Map<
			string,
			{ count: number; line: number; snippet: string; chainText: string }
		>
	>();

	function scopeOf(node: ts.Node): ts.Node {
		return ts.findAncestor(node, ts.isFunctionLike) ?? sf;
	}

	function visit(node: ts.Node): void {
		if (ts.isPropertyAccessExpression(node) && FLAGGED_PROPS.has(node.name.text)) {
			const scope = scopeOf(node);
			const chainText = node.getText(sf);
			// Normalize optional-chaining `?.` to `.` for identity comparison:
			// `x?.error` and `x.error` are the SAME chain. A common real pattern
			// is `if (x?.error != null) { ... use(x.error) ... }` — the boolean
			// guard uses optional chaining but the forwarded read (now provably
			// non-nullish) does not; without normalizing, that would
			// false-positive as a discard.
			const chainKey = chainText.replace(/\?\./g, '.');

			let allMap = allAccessCounts.get(scope);
			if (!allMap) {
				allMap = new Map();
				allAccessCounts.set(scope, allMap);
			}
			allMap.set(chainKey, (allMap.get(chainKey) ?? 0) + 1);

			if (isBooleanOnlyPosition(node)) {
				let candMap = candidateCounts.get(scope);
				if (!candMap) {
					candMap = new Map();
					candidateCounts.set(scope, candMap);
				}
				const existing = candMap.get(chainKey);
				if (existing) {
					existing.count++;
				} else {
					candMap.set(chainKey, {
						count: 1,
						line: lineOf(node.getStart(sf)),
						snippet: snippetAt(node.getStart(sf)),
						chainText,
					});
				}
			}
		}
		ts.forEachChild(node, visit);
	}

	visit(sf);

	const violations: ErrorChannelDiscardViolation[] = [];
	for (const [scope, candMap] of candidateCounts) {
		const allMap = allAccessCounts.get(scope) ?? new Map<string, number>();
		for (const [chainKey, info] of candMap) {
			const totalCount = allMap.get(chainKey) ?? 0;
			// Flag only when EVERY occurrence of this chain (normalized) in the
			// enclosing scope is a boolean-only-position read — i.e. the value is
			// never forwarded anywhere else in the function.
			if (totalCount === info.count) {
				violations.push({
					file: relPath,
					line: info.line,
					chainText: info.chainText,
					snippet: info.snippet,
				});
			}
		}
	}

	violations.sort((a, b) => a.line - b.line);
	return violations;
}

/**
 * `_internals` DI seam (mirrors check-bare-executable-spawn.ts): a test can
 * stub `_internals.scanSourceForErrorChannelDiscard` and assert it is
 * invoked once per scanned file, so the per-file loop can't silently
 * disconnect from the scanner.
 *
 * `readdirSync` is also seamed (PR #2363 review) so a test can force a
 * traversal failure deterministically. Real filesystem permission tricks
 * (`chmod 000`) are not portable across this repo's macOS/Linux/Windows CI
 * matrix — Windows does not enforce POSIX directory-read permission bits the
 * same way — so DI is the only way to exercise this path on every OS.
 */
export const _internals = {
	scanSourceForErrorChannelDiscard,
	readdirSync: fs.readdirSync,
};

/**
 * Error codes that indicate a momentarily busy filesystem (an AV scanner or
 * search indexer holding a directory handle) rather than a genuinely
 * unreadable subtree. Retried with backoff before being recorded as a real
 * failure — see `readDirWithRetry`.
 */
const TRANSIENT_READDIR_ERROR_CODES = new Set([
	'EBUSY',
	'EMFILE',
	'ENFILE',
	'EPERM',
]);
const TRANSIENT_READDIR_RETRY_DELAYS_MS = [20, 60, 150];

function syncSleep(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * PR #2363 closeout review: the original single-attempt `readdirSync` fails
 * the whole (now CI-wired, 3-OS-matrix) gate closed on ANY thrown error,
 * including transient ones — an AV scanner or search indexer holding a
 * directory handle throws EBUSY/EPERM/EMFILE/ENFILE on Windows with enough
 * frequency to have produced an observed 1-in-9 flake in this exact test
 * suite during review. Retrying transient codes with short backoff before
 * giving up preserves the fail-closed intent (a genuinely unreadable
 * subtree, e.g. real permission denial or a broken symlink, still fails
 * after retries exhaust) without making a repo-wide ratchet hostage to a
 * momentary OS-level lock.
 */
function readDirWithRetry(dir: string): fs.Dirent[] {
	let lastErr: unknown;
	for (let attempt = 0; attempt <= TRANSIENT_READDIR_RETRY_DELAYS_MS.length; attempt++) {
		try {
			return _internals.readdirSync(dir, { withFileTypes: true });
		} catch (err) {
			lastErr = err;
			const code =
				err && typeof err === 'object' && 'code' in err
					? String((err as { code: unknown }).code)
					: undefined;
			if (
				!code ||
				!TRANSIENT_READDIR_ERROR_CODES.has(code) ||
				attempt === TRANSIENT_READDIR_RETRY_DELAYS_MS.length
			) {
				throw err;
			}
			syncSleep(TRANSIENT_READDIR_RETRY_DELAYS_MS[attempt]);
		}
	}
	throw lastErr;
}

/**
 * Recursively yield every `.ts` file under `dir`, sorted for determinism.
 *
 * PR #2363 review: an unreadable subtree (permissions, a broken symlink)
 * previously vanished silently — `readdirSync` failures were swallowed and
 * the walk just yielded fewer files, so a partial scan could still exit 0.
 * `unreadableDirs` is a caller-owned accumulator; every failed directory is
 * recorded on it so the caller can fail the check closed instead of
 * reporting "no violations found" over files that were never scanned.
 */
function* walkTsFiles(
	dir: string,
	unreadableDirs: string[],
): Generator<string> {
	let entries: fs.Dirent[];
	try {
		entries = readDirWithRetry(dir).sort((a, b) =>
			a.name.localeCompare(b.name),
		);
	} catch (err) {
		unreadableDirs.push(
			`${dir}: ${err instanceof Error ? err.message : String(err)}`,
		);
		return;
	}
	for (const entry of entries) {
		if (entry.name === 'node_modules' || entry.name === 'dist') continue;
		if (entry.name === '__tests__') continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			yield* walkTsFiles(full, unreadableDirs);
		} else if (entry.isFile() && entry.name.endsWith('.ts')) {
			yield full;
		}
	}
}

/** Loads the flat allowlist set: non-comment, non-blank, trimmed lines. */
export function loadAllowlist(allowlistPath: string): Set<string> {
	if (!fs.existsSync(allowlistPath)) return new Set();
	const raw = fs.readFileSync(allowlistPath, 'utf-8');
	const entries = new Set<string>();
	for (const rawLine of raw.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith('#')) continue;
		entries.add(line);
	}
	return entries;
}

export function allowlistKey(file: string, chainText: string): string {
	return `${file.replace(/\\/g, '/')}:${chainText}`;
}

export interface CollectResult {
	errors: string[];
	scannedFiles: number;
	allowlistedSkipped: number;
}

function formatViolation(v: ErrorChannelDiscardViolation): string {
	return (
		`${v.file}:${v.line}: "${v.chainText}" (an error-channel value) is read only for a boolean ` +
		`side-condition and its value is discarded — nothing downstream can learn WHY it failed. ` +
		`Forward the value (log/store/attach a bounded reason) instead of collapsing it to a boolean, ` +
		`or if this is a deliberate pre-existing/out-of-scope case, add ` +
		`"${allowlistKey(v.file, v.chainText)}" to scripts/error-channel-discard-allowlist.txt with a ` +
		`justification comment. Line: ${v.snippet}`
	);
}

/**
 * Pure collector: scans `src/**\/*.ts` (excluding `*.test.ts` and
 * `__tests__/`) for error-channel-discard violations. Injectable root so
 * tests can point it at a fixture directory instead of the live repo.
 */
export function collectErrorChannelDiscardErrors(
	root: string = REPO_ROOT,
): CollectResult {
	const srcDir = path.join(root, 'src');
	const allowlist = loadAllowlist(
		root === REPO_ROOT
			? ALLOWLIST_PATH
			: path.join(root, 'scripts', 'error-channel-discard-allowlist.txt'),
	);
	const errors: string[] = [];
	let scannedFiles = 0;
	let allowlistedSkipped = 0;
	const unreadableDirs: string[] = [];

	for (const file of walkTsFiles(srcDir, unreadableDirs)) {
		if (file.endsWith('.test.ts')) continue;
		const rel = path.relative(root, file).replace(/\\/g, '/');
		scannedFiles++;
		const source = fs.readFileSync(file, 'utf-8');
		const violations = _internals.scanSourceForErrorChannelDiscard(rel, source);
		for (const v of violations) {
			if (allowlist.has(allowlistKey(v.file, v.chainText))) {
				allowlistedSkipped++;
				continue;
			}
			errors.push(formatViolation(v));
		}
	}

	// PR #2363 review: fail closed on an incomplete scan. A partial traversal
	// must never be reported as "no violations found" — that would be a green
	// result the check never actually earned.
	for (const failure of unreadableDirs) {
		errors.push(
			`INCOMPLETE SCAN: directory unreadable, contents not checked: ${failure}`,
		);
	}

	return { errors, scannedFiles, allowlistedSkipped };
}

export function main(root: string = REPO_ROOT): number {
	const enforce = resolveEnforce(process.env.ERROR_CHANNEL_DISCARD_ENFORCE);
	const result = collectErrorChannelDiscardErrors(root);
	console.log(
		`Scanned ${result.scannedFiles} file(s) under src/ (${result.allowlistedSkipped} allowlisted hit(s) skipped).`,
	);
	if (result.errors.length > 0) {
		console.error('\nError-channel-discard check FAILED:\n');
		for (const e of result.errors) console.error(`  - ${e}`);
		console.error(`\n${result.errors.length} violation(s).`);
		if (!enforce) {
			console.error(
				'ERROR_CHANNEL_DISCARD_ENFORCE is off — soft-warn (non-blocking).',
			);
			return 0;
		}
		return 1;
	}
	console.log(
		'Error-channel-discard check passed: no undocumented boolean-only error-channel reads found.',
	);
	return 0;
}

const isDirectRun =
	typeof process.argv[1] === 'string' &&
	path.resolve(process.argv[1]) ===
		path.resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
	process.exit(main());
}
