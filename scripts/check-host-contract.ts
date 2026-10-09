#!/usr/bin/env bun
/**
 * Issue #2902 (Workstream I, slot I5) — host-contract drift check.
 *
 * Compares the #2526 guidance-carrier fixture's pinned converter shape
 * (`tests/helpers/host-contract-v1_18_3.ts`, distilled from
 * anomalyco/opencode `packages/opencode/src/session/message-v2.ts`) against
 * the REAL host source at the version users actually install (npm-latest of
 * `@opencode-ai/plugin`, or an explicit `--tag`), independent of this repo's
 * lockfile pin. Before this check existed, the only tripwires asserted the
 * lockfile pin, so a host release that changed the converter structure landed
 * silently (audit finding D4).
 *
 * Dual-axis verdict (issue-tracer trace 2902, plan-critic round 2):
 *   - structural axis (pass/fail): the canonical statement list of the
 *     `for (const msg of input)` loop — parts-length guard, role branches,
 *     absence of a role-split else — must match the committed corpus
 *     (`tests/fixtures/host/expected-structure.json`).
 *   - textual axis (advisory): the normalized loop text may drift (new part
 *     handling inside branches, reformatting) without failing the check; the
 *     drift is reported as a notice so the corpus can be refreshed.
 *
 * Output tokens (pinned by the frozen acceptance checks C1-C4):
 *   `host-contract: tag=<tag>` | `host-contract: source=<path>`  (first)
 *   `host-contract: structural-digest=<sha256-hex>`             (always, post-extraction)
 *   `result=STRUCTURE_MATCH`      exit 0 — statements match
 *   `result=TEXTUAL_DRIFT_ONLY`   exit 0 — additionally printed when the
 *                                 normalized text differs from the corpus
 *   `result=STRUCTURAL_DRIFT`     exit 1 — preceded by one
 *                                 `structural drift: added=[...] removed=[...]`
 *                                 line and a unified diff of the statement lists
 *   `result=SOURCE_NOT_FOUND`     exit 1 — host source unfetchable, or the
 *                                 converter loop anchor is absent (a moved or
 *                                 renamed host file is a FAILURE, never a pass)
 *   `result=CORPUS_INVALID`       exit 1 — the pinned corpus failed to parse or
 *                                 shape-check (fail loudly with a reason)
 *
 * Exit codes: 0 structure intact (with or without textual drift), 1 structural
 * drift, source not found, or corpus invalid, 2 usage error.
 *
 * Subprocess discipline (AGENTS.md invariant 3): every child is array-form
 * `spawnSync` with explicit cwd, `stdin: 'ignore'`, a timeout, a bounded
 * output buffer, and synchronous semantics (no orphaned children). Network
 * access is `fetch` + `AbortController` with a bounded timeout, mirroring
 * `scripts/drift-check.ts` `defaultFetchLatestVersion`.
 *
 * Usage:
 *   bun scripts/check-host-contract.ts                      # npm-latest tag, live fetch
 *   bun scripts/check-host-contract.ts --tag v1.18.33       # explicit host tag
 *   bun scripts/check-host-contract.ts --source <path>      # offline mode
 *   ... --route-on-drift [--dry-run]                        # tracking-issue routing
 *   bun scripts/check-host-contract.ts --emit-expected <host-source> [--as-tag vX.Y.Z] [--as-commit <sha>]
 *                                                           # regenerate the corpus from a source file
 *                                                           # (<host-source> is the INPUT; the corpus
 *                                                           #  path is fixed; provenance flags MUST
 *                                                           #  describe the source when it is not the
 *                                                           #  pinned v1.18.3 excerpt)
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import { readBounded, readBoundedResult } from './lib/read-bounded';

// Re-exported for existing importers (tests); the implementation is shared with
// scripts/drift-check.ts.
export { readBounded };

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOST_REPO = 'ZaxbyHub/opencode-swarm'; // routing target (this repo)
const HOST_SOURCE_REPO = 'anomalyco/opencode'; // the OpenCode host
const HOST_SOURCE_FILE = 'packages/opencode/src/session/message-v2.ts';
const EXPECTED_PATH = path.join(REPO_ROOT, 'tests/fixtures/host/expected-structure.json');
// The dist-tags endpoint is a few KiB. The full packument it replaced grew
// past 27 MB with snapshot/dev tags, overran the bounded read, and made every
// run resolve no tag (SOURCE_NOT_FOUND) with nothing wrong on the host side.
export const NPM_DIST_TAGS_URL =
	'https://registry.npmjs.org/-/package/@opencode-ai/plugin/dist-tags';
const NPM_DIST_TAGS_MAX_BYTES = 64 * 1024;
const RAW_SOURCE = (tag: string) =>
	`https://raw.githubusercontent.com/${HOST_SOURCE_REPO}/${tag}/${HOST_SOURCE_FILE}`;
const TRACKING_TITLE_PREFIX = 'Host contract drift: message-v2.ts';
const FETCH_TIMEOUT_MS = 20_000;
const GH_TIMEOUT_MS = 30_000;
const GH_MAX_BUFFER = 1_000_000;
const REPORT_DIFF_LIMIT = 40;

export interface HostLoopExtraction {
	/** Canonical statement ids of the converter loop, in source order. */
	statements: string[];
	/** sha256 hex of the newline-joined statement list. */
	structuralDigest: string;
	/**
	 * Printer-normalized text of the whole `toModelMessagesEffect` export
	 * statement (comments removed, formatting canonicalized). The textual
	 * axis covers the entire converter function, not just the loop: the loop
	 * alone is byte-stable across v1.18.3 → v1.18.33 (md5-verified in the
	 * #2902 trace), while the function genuinely drifted (the
	 * `supportsMediaInToolResult` Bedrock expansion, v1.18.33 line 151).
	 */
	normalizedText: string;
}

export interface CheckOutcome {
	exitCode: number;
	lines: string[];
	tag: string | null;
	sourcePath: string | null;
	structuralDigest: string | null;
	routed: string[];
}

export interface ExpectedStructure {
	pinnedTag: string;
	pinnedCommit: string;
	hostFile: string;
	statements: string[];
	structuralDigest: string;
	normalizedExcerpt: string;
}

type GhResult = { ok: boolean; stdout: string; error?: string };

/** Max bytes accepted for a fetched host source / registry document. */
const MAX_SOURCE_BYTES = 10_000_000;

/**
 * A tag is interpolated into a raw.githubusercontent.com URL path, so it must be
 * a single conservative path segment: alphanumeric start, then letters, digits
 * and `. + _ -`. Rejects `..`, `/`, `\`, `?`, `#`, whitespace and empty input.
 */
const SAFE_TAG = /^[0-9A-Za-z][0-9A-Za-z.+_-]*$/;
export function isSafeNpmTag(tag: unknown): tag is string {
	return typeof tag === 'string' && tag.length <= 128 && SAFE_TAG.test(tag) && !tag.includes('..');
}

/**
 * Resolve npm `latest` for @opencode-ai/plugin; '' on any failure. The exit
 * contract is unchanged (an empty tag becomes `result=SOURCE_NOT_FOUND`); a
 * one-line reason goes to stderr so a failed run is diagnosable.
 */
export async function resolveNpmLatestTag(
	fetchImpl: typeof fetch = fetch,
	warn: (line: string) => void = (line) => console.error(line),
): Promise<string> {
	const fail = (reason: string): string => {
		warn(`host-contract: npm latest-tag unresolved: ${reason}`);
		return '';
	};
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const res = await fetchImpl(NPM_DIST_TAGS_URL, { signal: controller.signal });
		if (!res.ok) return fail(`HTTP ${res.status}`);
		const body = await readBoundedResult(res, NPM_DIST_TAGS_MAX_BYTES);
		if (!body.ok) {
			return fail(
				body.reason === 'oversize'
					? `response over ${NPM_DIST_TAGS_MAX_BYTES} bytes`
					: 'response unreadable',
			);
		}
		let tags: { latest?: unknown };
		try {
			tags = JSON.parse(body.text) as { latest?: unknown };
		} catch {
			return fail('response is not valid JSON');
		}
		if (typeof tags?.latest !== 'string' || tags.latest === '') {
			return fail('no string `latest` dist-tag');
		}
		if (!isSafeNpmTag(tags.latest)) return fail('`latest` is not a safe version tag');
		return tags.latest;
	} catch (error) {
		return fail(
			controller.signal.aborted
				? `timed out after ${FETCH_TIMEOUT_MS}ms`
				: `request failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	} finally {
		clearTimeout(timer);
	}
}

async function defaultFetchHostSource(tag: string): Promise<string | null> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const res = await fetch(RAW_SOURCE(tag), { signal: controller.signal });
		if (!res.ok) return null;
		return await readBounded(res, MAX_SOURCE_BYTES);
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

function defaultRunGh(args: string[]): GhResult {
	const proc = spawnSync('gh', args, {
		cwd: REPO_ROOT,
		stdio: ['ignore', 'pipe', 'pipe'],
		timeout: GH_TIMEOUT_MS,
		maxBuffer: GH_MAX_BUFFER,
		encoding: 'utf8',
	});
	if (proc.error) return { ok: false, stdout: '', error: String(proc.error) };
	if (proc.status !== 0) return { ok: false, stdout: proc.stdout ?? '', error: `gh exited ${proc.status}` };
	return { ok: true, stdout: proc.stdout ?? '' };
}

/** DI seam per AGENTS.md invariant 7 (preferred over `mock.module`). */
export const _internals = {
	resolveLatestTag: (): Promise<string> => resolveNpmLatestTag(),
	fetchHostSource: defaultFetchHostSource,
	runGh: defaultRunGh,
	/** Corpus location, injectable so tests never touch the committed file. */
	expectedPath: EXPECTED_PATH,
};

/** Property-access chain text (e.g. `msg.parts.length`), or null. */
function chainText(expr: ts.Expression): string | null {
	if (!ts.isPropertyAccessExpression(expr)) return null;
	const parts: string[] = [];
	let node: ts.Expression = expr;
	while (ts.isPropertyAccessExpression(node)) {
		parts.unshift(node.name.text);
		node = node.expression;
	}
	if (!ts.isIdentifier(node)) return null;
	parts.unshift(node.text);
	return parts.join('.');
}

function isNumericZero(expr: ts.Expression): boolean {
	return expr.kind === ts.SyntaxKind.NumericLiteral && (expr as ts.NumericLiteral).text === '0';
}

/** First statement of a block, or the statement itself when not braced. */
function soleStatement(stmt: ts.Statement): ts.Statement | null {
	if (ts.isBlock(stmt)) {
		return stmt.statements.length === 1 ? stmt.statements[0] : null;
	}
	return stmt;
}

function isPartsGuard(stmt: ts.Statement): boolean {
	if (!ts.isIfStatement(stmt)) return false;
	if (!ts.isBinaryExpression(stmt.expression)) return false;
	if (stmt.expression.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken) return false;
	// Either operand order: `msg.parts.length === 0` and `0 === msg.parts.length`
	// are the same guard (the role branches already accept both orders).
	const { left, right } = stmt.expression;
	const chainIsPartsLength = (expr: ts.Expression): boolean => chainText(expr) === 'msg.parts.length';
	const matches = (chainIsPartsLength(left) && isNumericZero(right)) || (isNumericZero(left) && chainIsPartsLength(right));
	if (!matches) return false;
	return soleStatement(stmt.thenStatement)?.kind === ts.SyntaxKind.ContinueStatement;
}

/**
 * The role literal of a top-level `if (msg.info.role === "<role>")` branch
 * (either operand order), or null when the statement is not a role branch.
 */
function roleBranchRole(stmt: ts.Statement): string | null {
	if (!ts.isIfStatement(stmt)) return null;
	if (!ts.isBinaryExpression(stmt.expression)) return null;
	if (stmt.expression.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken) return null;
	const { left, right } = stmt.expression;
	if (chainText(left) === 'msg.info.role' && ts.isStringLiteral(right)) return right.text;
	if (chainText(right) === 'msg.info.role' && ts.isStringLiteral(left)) return left.text;
	return null;
}

function normalizedNodeText(node: ts.Node, sourceFile: ts.SourceFile): string {
	const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed, removeComments: true });
	return printer.printNode(ts.EmitHint.Unspecified, node, sourceFile);
}

/**
 * Extract the converter loop's structural statement list and normalized text.
 * Returns null when the anchor (`for (const msg of input)`) is absent —
 * callers must treat that as SOURCE_NOT_FOUND, never as a pass.
 */
export function extractHostLoop(source: string): HostLoopExtraction | null {
	const sourceFile = ts.createSourceFile('message-v2.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	let loop: ts.ForOfStatement | undefined;
	function visit(node: ts.Node): void {
		if (loop) return;
		if (ts.isForOfStatement(node)) {
			const init = node.initializer;
			const declaresMsg =
				ts.isVariableDeclarationList(init) &&
				init.declarations.length === 1 &&
				ts.isIdentifier(init.declarations[0].name) &&
				init.declarations[0].name.text === 'msg';
			const iteratesInput = ts.isIdentifier(node.expression) && node.expression.text === 'input';
			if (declaresMsg && iteratesInput) {
				loop = node;
				return;
			}
		}
		ts.forEachChild(node, visit);
	}
	visit(sourceFile);
	if (!loop) return null;
	const body = loop.statement;
	if (!ts.isBlock(body)) return null;

	const statements: string[] = ['loop-head: for-of msg input'];
	// NOTE: IfStatement exposes the else branch as `elseStatement` in the
	// installed TypeScript (5.9.x); there is no `elseClause` property.
	const hasElse = (stmt: ts.IfStatement): boolean => stmt.elseStatement !== undefined;
	for (const stmt of body.statements) {
		if (isPartsGuard(stmt)) {
			statements.push('parts-guard: parts-length-0 continue');
			continue;
		}
		const role = roleBranchRole(stmt);
		if (role !== null && ts.isIfStatement(stmt)) {
			statements.push(`branch: ${role}`);
			if (hasElse(stmt)) statements.push('else-default: present');
			continue;
		}
		if (ts.isIfStatement(stmt) && hasElse(stmt)) {
			statements.push('else-default: present');
			continue;
		}
		statements.push(`extra-statement: ${ts.SyntaxKind[stmt.kind]}`);
	}
	if (!statements.some((s) => s.startsWith('else-default: '))) {
		statements.push('else-default: absent');
	}
	const joined = statements.join('\n');
	// Textual axis: the enclosing top-level statement is the whole
	// `export const toModelMessagesEffect = ...` export (in both full host
	// files and whole-function excerpt fixtures), so the advisory comparison
	// covers the entire converter function.
	let enclosing: ts.Node = loop;
	while (enclosing.parent && !ts.isSourceFile(enclosing.parent)) {
		enclosing = enclosing.parent;
	}
	return {
		statements,
		structuralDigest: createHash('sha256').update(joined).digest('hex'),
		normalizedText: normalizedNodeText(enclosing, sourceFile),
	};
}

function unifiedDiff(expected: string[], actual: string[]): string[] {
	const lines: string[] = ['--- expected statements', '+++ actual statements'];
	const max = Math.max(expected.length, actual.length);
	for (let i = 0; i < max; i++) {
		const e = expected[i];
		const a = actual[i];
		if (e === a) continue;
		if (e !== undefined) lines.push(`-${e}`);
		if (a !== undefined) lines.push(`+${a}`);
	}
	return lines;
}

/**
 * Load + shape-check the pinned corpus. Throws a tagged error the caller
 * converts to `result=CORPUS_INVALID` so a malformed or truncated corpus
 * fails loudly with a reason instead of an opaque TypeError (and never
 * silently passes).
 */
function loadExpectedChecked(): ExpectedStructure {
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(_internals.expectedPath, 'utf8'));
	} catch (error) {
		throw new Error(`corpus is not valid JSON: ${String(error)}`);
	}
	const corpus = parsed as Partial<ExpectedStructure>;
	if (!Array.isArray(corpus.statements) || corpus.statements.some((s) => typeof s !== 'string')) {
		throw new Error('corpus field statements is missing or not a string array');
	}
	if (typeof corpus.normalizedExcerpt !== 'string') {
		throw new Error('corpus field normalizedExcerpt is missing or not a string');
	}
	if (typeof corpus.pinnedTag !== 'string' || typeof corpus.pinnedCommit !== 'string') {
		throw new Error('corpus fields pinnedTag/pinnedCommit are missing or not strings');
	}
	return corpus as ExpectedStructure;
}

/** Cap the stdout drift summary so a pathological statement list cannot flood logs. */
function summarizeList(items: string[]): string {
	const capped = items.slice(0, REPORT_DIFF_LIMIT);
	const suffix = items.length > REPORT_DIFF_LIMIT ? `, …(+${items.length - REPORT_DIFF_LIMIT} more)` : '';
	return `${capped.join(', ')}${suffix}`;
}

function driftReport(tag: string, digest: string, added: string[], removed: string[], diff: string[]): string {
	return [
		`Host contract drift: message-v2.ts @ ${tag}`,
		'',
		'The OpenCode host converter loop (`toModelMessagesEffect` in',
		`\`${HOST_SOURCE_FILE}\`) no longer matches the structural shape pinned by`,
		'tests/helpers/host-contract-v1_18_3.ts (issue #2526). Plugin guidance',
		'delivery may be affected — re-verify the fixture and the #2526 carrier',
		'contract against this host version, then regenerate the corpus with:',
		'  bun scripts/check-host-contract.ts --emit-expected <host-source>',
		'',
		`structural-digest=${digest}`,
		`structural drift: added=[${added.join(', ')}] removed=[${removed.join(', ')}]`,
		'',
		...diff.slice(0, REPORT_DIFF_LIMIT),
	]
		.join('\n')
		.slice(0, 6000);
}

interface RouteOptions {
	tag: string;
	digest: string;
	added: string[];
	removed: string[];
	diff: string[];
	dryRun: boolean;
}

function routeDrift(options: RouteOptions): string[] {
	const actions: string[] = [];
	// Honor GH_REPO when the environment provides it (workflow exports
	// github.repository); default to the upstream repo so local runs and
	// forks still route deterministically (forks fail closed against the
	// upstream with 403 rather than silently writing nowhere).
	const repo = process.env.GH_REPO && process.env.GH_REPO.trim() !== '' ? process.env.GH_REPO.trim() : HOST_REPO;
	const report = driftReport(options.tag, options.digest, options.added, options.removed, options.diff);
	const list = _internals.runGh([
		'issue',
		'list',
		'--repo',
		repo,
		'--state',
		'open',
		'--json',
		'number,title,author',
		'--limit',
		'500',
	]);
	if (!list.ok) {
		actions.push(`host-contract: ROUTE-FAILED gh issue list: ${list.error ?? 'unknown error'} (no issue created)`);
		return actions;
	}
	let existing: { number: number; title: string; author?: { login?: string } }[] = [];
	try {
		existing = JSON.parse(list.stdout) as { number: number; title: string; author?: { login?: string } }[];
	} catch (error) {
		actions.push(`host-contract: ROUTE-FAILED gh issue list output: ${String(error)} (no issue created)`);
		return actions;
	}
	// Only adopt tracking issues this workflow itself created (github-actions[bot]
	// identity via GITHUB_TOKEN) — a human- or third-party-bot-titled issue must
	// never absorb drift comments.
	const match = existing.find(
		(issue) => issue.title.startsWith(TRACKING_TITLE_PREFIX) && issue.author?.login === 'github-actions[bot]',
	);
	if (match) {
		const args = ['issue', 'comment', String(match.number), '--repo', repo, '--body', report];
		if (options.dryRun) {
			actions.push(`host-contract: dry-run gh ${args.join(' ').slice(0, 120)}...`);
			return actions;
		}
		const res = _internals.runGh(args);
		actions.push(
			res.ok
				? `host-contract: routed drift to existing issue #${match.number}`
				: `host-contract: gh issue comment failed: ${res.error ?? 'unknown error'} (verdict unchanged)`,
		);
		return actions;
	}
	const title = `${TRACKING_TITLE_PREFIX} @ ${options.tag}`;
	const args = ['issue', 'create', '--repo', repo, '--title', title, '--body', report, '--label', 'area:ci'];
	if (options.dryRun) {
		actions.push(`host-contract: dry-run gh ${args.join(' ').slice(0, 120)}...`);
		return actions;
	}
	const res = _internals.runGh(args);
	actions.push(
		res.ok
			? 'host-contract: opened tracking issue'
			: `host-contract: gh issue create failed: ${res.error ?? 'unknown error'} (verdict unchanged)`,
	);
	return actions;
}

export interface CheckOptions {
	tag?: string;
	source?: string;
	routeOnDrift?: boolean;
	dryRun?: boolean;
}

export async function runCheck(options: CheckOptions): Promise<CheckOutcome> {
	const lines: string[] = [];
	const routed: string[] = [];
	let tag: string | null = null;
	let sourcePath: string | null = null;

	if (options.tag && options.source) {
		return { exitCode: 2, lines: ['host-contract: --tag and --source are mutually exclusive'], tag: null, sourcePath: null, structuralDigest: null, routed };
	}

	let source: string | null = null;
	if (options.source) {
		sourcePath = options.source;
		lines.push(`host-contract: source=${options.source}`);
		try {
			source = fs.readFileSync(path.resolve(REPO_ROOT, options.source), 'utf8');
		} catch (error) {
			lines.push(`host-contract: cannot read source: ${String(error)}`);
			lines.push('result=SOURCE_NOT_FOUND');
			return { exitCode: 1, lines, tag, sourcePath, structuralDigest: null, routed };
		}
	} else {
		tag = options.tag && options.tag.trim() !== '' ? options.tag.trim() : await _internals.resolveLatestTag();
		if (!isSafeNpmTag(tag)) {
			if (tag) console.error('host-contract: refusing unsafe tag for source URL');
			lines.push('host-contract: could not resolve npm-latest tag for @opencode-ai/plugin');
			lines.push('result=SOURCE_NOT_FOUND');
			return { exitCode: 1, lines, tag: null, sourcePath: null, structuralDigest: null, routed };
		}
		// npm versions are bare (`1.18.33`); the host repo tags are `v`-prefixed.
		if (!tag.startsWith('v')) tag = `v${tag}`;
		lines.push(`host-contract: tag=${tag}`);
		source = await _internals.fetchHostSource(tag);
		if (source === null) {
			lines.push(`host-contract: could not fetch ${HOST_SOURCE_FILE} at ${tag} (moved, renamed, or network failure)`);
			lines.push('result=SOURCE_NOT_FOUND');
			return { exitCode: 1, lines, tag, sourcePath, structuralDigest: null, routed };
		}
	}

	const extraction = extractHostLoop(source);
	if (!extraction) {
		lines.push(`host-contract: converter loop anchor 'for (const msg of input)' not found in ${HOST_SOURCE_FILE}`);
		lines.push('result=SOURCE_NOT_FOUND');
		return { exitCode: 1, lines, tag, sourcePath, structuralDigest: null, routed };
	}
	lines.push(`host-contract: structural-digest=${extraction.structuralDigest}`);

	let expected: ExpectedStructure;
	try {
		expected = loadExpectedChecked();
	} catch (error) {
		lines.push(`host-contract: pinned corpus invalid (${String(error instanceof Error ? error.message : error)})`);
		lines.push('result=CORPUS_INVALID');
		return { exitCode: 1, lines, tag, sourcePath, structuralDigest: extraction.structuralDigest, routed };
	}
	if (extraction.statements.join('\n') !== expected.statements.join('\n')) {
		const actualSet = new Set(extraction.statements);
		const expectedSet = new Set(expected.statements);
		const added = extraction.statements.filter((s) => !expectedSet.has(s));
		const removed = expected.statements.filter((s) => !actualSet.has(s));
		if (added.length === 0 && removed.length === 0) {
			lines.push('structural drift: added=[] removed=[] (statement order changed)');
		} else {
			lines.push(`structural drift: added=[${summarizeList(added)}] removed=[${summarizeList(removed)}]`);
		}
		const diff = unifiedDiff(expected.statements, extraction.statements);
		const diffCapped = diff.slice(0, REPORT_DIFF_LIMIT);
		if (diff.length > REPORT_DIFF_LIMIT) diffCapped.push(`… (+${diff.length - REPORT_DIFF_LIMIT} more changed statements)`);
		lines.push(...diffCapped);
		lines.push(`host-contract: pinned corpus ${expected.pinnedTag} (${expected.pinnedCommit.slice(0, 12)})`);
		lines.push('result=STRUCTURAL_DRIFT');
		if (options.routeOnDrift) {
			routed.push(
				...routeDrift({
					tag: tag ?? options.source ?? 'local',
					digest: extraction.structuralDigest,
					added,
					removed,
					diff,
					dryRun: options.dryRun ?? false,
				}),
			);
		}
		lines.push(...routed);
		return { exitCode: 1, lines, tag, sourcePath, structuralDigest: extraction.structuralDigest, routed };
	}

	lines.push('result=STRUCTURE_MATCH');
	if (extraction.normalizedText !== expected.normalizedExcerpt) {
		lines.push('host-contract: textual-only drift vs pinned excerpt (structure unchanged)');
		lines.push('host-contract: refresh the pinned corpus with: bun scripts/check-host-contract.ts --emit-expected <host-source excerpt>');
		lines.push('result=TEXTUAL_DRIFT_ONLY');
	}
	return { exitCode: 0, lines, tag, sourcePath, structuralDigest: extraction.structuralDigest, routed };
}

export interface EmitOptions {
	/** Provenance recorded in the corpus — MUST describe the source being emitted. */
	asTag?: string;
	asCommit?: string;
}

function emitExpected(sourcePath: string, options: EmitOptions = {}): number {
	const source = fs.readFileSync(path.resolve(REPO_ROOT, sourcePath), 'utf8');
	const extraction = extractHostLoop(source);
	if (!extraction) {
		console.error(`host-contract: converter loop anchor not found in ${sourcePath}`);
		return 1;
	}
	const corpus: ExpectedStructure = {
		// Provenance MUST be supplied when regenerating from anything other
		// than the pinned v1.18.3 source — a corpus that lies about its origin
		// poisons every later drift report (PRR-015).
		pinnedTag: options.asTag ?? 'v1.18.3',
		pinnedCommit: options.asCommit ?? '127bdb30784d508cc556c71a0f32b508a3061517',
		hostFile: HOST_SOURCE_FILE,
		statements: extraction.statements,
		structuralDigest: extraction.structuralDigest,
		normalizedExcerpt: extraction.normalizedText,
	};
	fs.writeFileSync(_internals.expectedPath, `${JSON.stringify(corpus, null, '\t')}\n`);
	console.log(`host-contract: wrote ${path.relative(REPO_ROOT, _internals.expectedPath)} (digest ${extraction.structuralDigest})`);
	return 0;
}

function usage(): number {
	console.error('usage: bun scripts/check-host-contract.ts [--tag vX.Y.Z | --source <path>] [--route-on-drift] [--dry-run]');
	console.error('       bun scripts/check-host-contract.ts --emit-expected <host-source> [--as-tag vX.Y.Z] [--as-commit <sha>]   # <host-source> is the INPUT to extract from; the corpus path is fixed');
	return 2;
}

export async function main(argv: string[]): Promise<number> {
	let tag = '';
	let source = '';
	let routeOnDrift = false;
	let dryRun = false;
	let emitPath = '';
	let asTag = '';
	let asCommit = '';
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		switch (arg) {
			case '--tag': {
				const next = argv[++i];
				if (next === undefined) return usage();
				tag = next;
				break;
			}
			case '--source': {
				const next = argv[++i];
				if (next === undefined) return usage();
				source = next;
				break;
			}
			case '--route-on-drift':
				routeOnDrift = true;
				break;
			case '--dry-run':
				dryRun = true;
				break;
			case '--emit-expected': {
				const next = argv[++i];
				if (next === undefined) return usage();
				emitPath = next;
				break;
			}
			case '--as-tag': {
				const next = argv[++i];
				if (next === undefined) return usage();
				asTag = next;
				break;
			}
			case '--as-commit': {
				const next = argv[++i];
				if (next === undefined) return usage();
				asCommit = next;
				break;
			}
			default:
				return usage();
		}
	}
	if (emitPath) {
		if (tag || source || routeOnDrift || dryRun) return usage();
		return emitExpected(emitPath, { asTag: asTag || undefined, asCommit: asCommit || undefined });
	}
	if (asTag || asCommit) return usage();
	const outcome = await runCheck({ tag, source, routeOnDrift, dryRun });
	for (const line of outcome.lines) console.log(line);
	return outcome.exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main(process.argv.slice(2))
		.then((code) => process.exit(code))
		.catch((error) => {
			console.error(`host-contract: unexpected error ${String(error)}`);
			process.exit(1);
		});
}
