#!/usr/bin/env bun
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGit as runGitBase } from './gate-utils';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_PATH);
const SCRIPT_REPO_FALLBACK = path.resolve(SCRIPT_DIR, '..');
const GIT_TIMEOUT_MS = 30_000;

const LEGACY_EXEMPTS = new Set([
	'src/tools/create-tool.ts',
	'src/tools/test-runner.ts',
	'src/tools/resolve-working-directory.ts',
	'src/tools/save-plan.ts',
	'src/tools/sbom-generate.ts',
	'src/hooks/guardrails.ts',
	'src/hooks/guardrails/file-authority.ts',
	'src/hooks/guardrails/helpers.ts',
	'src/hooks/guardrails/index.ts',
	'src/hooks/scope-guard.ts',
]);

const KNOWLEDGE_DEDUP_SCOPE = [
	'src/tools/knowledge-*.ts',
	'src/hooks/knowledge-*.ts',
	'src/hooks/curator.ts',
	'src/hooks/micro-reflector.ts',
	'src/knowledge/*.ts',
	'src/learning/*.ts',
	'src/services/recommendation-ledger.ts',
	'src/consensus/*.ts',
] as const;

/** Quarantine list files that require OWNER/EXPIRY metadata on active entries (#2477). */
export const QUARANTINE_LIST_FILES = [
	'scripts/ci/quarantined-tests.txt',
	'scripts/ci/quarantined-tests-windows.txt',
	'scripts/ci/quarantined-tests-macos.txt',
	'scripts/ci/quarantined-integration-tests.txt',
] as const;

/**
 * How far past EXPIRY an entry may sit before the check hard-fails. Inside the
 * grace window the entry only warns, so a legitimate "still waiting on the
 * retirement criterion" entry needs one small renewal PR, not an emergency.
 */
const QUARANTINE_EXPIRY_GRACE_DAYS = 14;

const BASE_BRANCH_CANDIDATES = [
	'origin/main',
	'origin/master',
	'main',
	'master',
] as const;

interface GitResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export interface CheckResult {
	messages: string[];
	stderrMessages?: string[];
	violations: number;
}

async function runGit(args: string[], cwd: string): Promise<GitResult> {
	try {
		return await runGitBase(args, cwd, GIT_TIMEOUT_MS);
	} catch {
		return { exitCode: 1, stdout: '', stderr: '' };
	}
}

export async function resolveRepoRoot(
	startDir: string = process.cwd(),
): Promise<string> {
	for (const candidate of [startDir, SCRIPT_REPO_FALLBACK]) {
		const top = await runGit(['rev-parse', '--show-toplevel'], candidate);
		if (top.exitCode !== 0) continue;
		const trimmed = top.stdout.trim();
		if (trimmed.length > 0) {
			return path.resolve(trimmed);
		}
	}
	return SCRIPT_REPO_FALLBACK;
}

function toPosixRelative(root: string, file: string): string {
	return path.relative(root, file).replace(/\\/g, '/');
}

function listFiles(
	dir: string,
	options?: { extensions?: string[]; excludeDirs?: ReadonlySet<string> },
): string[] {
	if (!fs.existsSync(dir)) {
		return [];
	}
	const extensions = options?.extensions ?? [];
	const excludeDirs = options?.excludeDirs ?? new Set<string>();
	const out: string[] = [];
	const stack = [dir];
	while (stack.length > 0) {
		const current = stack.pop()!;
		const entries = fs
			.readdirSync(current, { withFileTypes: true })
			.sort((a, b) => a.name.localeCompare(b.name));
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) {
				if (!excludeDirs.has(entry.name)) {
					stack.push(full);
				}
				continue;
			}
			if (
				extensions.length === 0 ||
				extensions.some((ext) => entry.name.endsWith(ext))
			) {
				out.push(full);
			}
		}
	}
	out.sort((a, b) => a.localeCompare(b));
	return out;
}

function readText(file: string): string {
	return fs.readFileSync(file, 'utf-8');
}

function stripCommentOnlyMentions(content: string): string {
	return content
		.split(/\r?\n/)
		.map((line) => {
			let stripped = line.replace(/\/\/.*$/, '');
			if (/^\s*\*/.test(stripped)) {
				stripped = '';
			}
			stripped = stripped.replace(/\/\*.*\*\//g, '');
			return stripped;
		})
		.join('\n');
}

export function normalizeMockTarget(target: string): string {
	if (target.startsWith('node:')) {
		return target;
	}
	let normalized = target.replace(/^(?:\.\.\/)+/, '').replace(/^(?:\.\/)+/, '');
	while (normalized.includes('/../')) {
		normalized = normalized.replace(/[^/]+\/\.\.\//, '');
	}
	normalized = normalized.replace(/^src\//, '').replace(/\.js$/, '');
	return `src/${normalized}`;
}

function loadAllowlistEntries(allowlistFile: string): string[] {
	return readText(allowlistFile)
		.replace(/\r/g, '')
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith('#'));
}

function countPatternMatches(source: string, pattern: RegExp): number {
	let count = 0;
	pattern.lastIndex = 0;
	let match = pattern.exec(source);
	while (match) {
		count++;
		match = pattern.exec(source);
	}
	return count;
}

function extractMockTargets(source: string): string[] {
	const targets: string[] = [];
	const targetPattern =
		/mock\.module\(\s*'([^']+)'|mock\.module\(\s*"([^"]+)"/g;
	let match = targetPattern.exec(source);
	while (match) {
		const target = match[1] ?? match[2];
		if (target) {
			targets.push(target);
		}
		match = targetPattern.exec(source);
	}
	return targets;
}

export function resolveEnforce(raw: string | undefined): boolean {
	if (raw === undefined) {
		return true;
	}
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

export async function resolveBaseBranch(
	repoRoot: string,
): Promise<string | null> {
	for (const branch of BASE_BRANCH_CANDIDATES) {
		if ((await runGit(['rev-parse', branch], repoRoot)).exitCode === 0) {
			return branch;
		}
	}
	return null;
}

export function checkSubprocessTimeout(repoRoot: string): CheckResult {
	const messages = ['=== Check 1: Subprocess timeout required (advisory) ==='];
	let timeoutWarnings = 0;
	const files = listFiles(path.join(repoRoot, 'src'), {
		extensions: ['.ts'],
		excludeDirs: new Set(['node_modules', 'dist']),
	});
	for (const file of files) {
		const rel = toPosixRelative(repoRoot, file);
		if (
			rel.endsWith('.test.ts') ||
			rel.endsWith('.d.ts') ||
			path.basename(file) === 'bun-compat.ts'
		) {
			continue;
		}
		const content = readText(file);
		if (!/\bspawnSync\(|\bspawn\(/.test(content)) {
			continue;
		}
		if (!/(timeout:|timeoutMs)/.test(content)) {
			messages.push(
				`WARNING: ${rel} uses spawn/spawnSync but has no timeout property in file`,
			);
			timeoutWarnings++;
		}
	}
	if (timeoutWarnings > 0) {
		messages.push(
			`  (${timeoutWarnings} file(s) have spawn/spawnSync but no timeout — advisory, not blocking)`,
		);
	}
	return { messages, violations: 0 };
}

export function checkProcessCwdBan(repoRoot: string): CheckResult {
	const messages = ['=== Check 2: process.cwd() ban in tools/hooks ==='];
	let violations = 0;
	const files = [
		...listFiles(path.join(repoRoot, 'src', 'tools'), {
			extensions: ['.ts'],
			excludeDirs: new Set(['node_modules', 'dist']),
		}),
		...listFiles(path.join(repoRoot, 'src', 'hooks'), {
			extensions: ['.ts'],
			excludeDirs: new Set(['node_modules', 'dist']),
		}),
	].sort((a, b) => a.localeCompare(b));
	for (const file of files) {
		const rel = toPosixRelative(repoRoot, file);
		if (rel.endsWith('.test.ts') || LEGACY_EXEMPTS.has(rel)) {
			continue;
		}
		const content = readText(file);
		if (!content.includes('process.cwd()')) {
			continue;
		}
		if (!stripCommentOnlyMentions(content).includes('process.cwd()')) {
			continue;
		}
		messages.push(
			`ERROR: ${rel} uses process.cwd() — tools must use ctx.directory via resolveWorkingDirectory`,
		);
		violations++;
	}
	return { messages, violations };
}

export function checkMockAllowlist(repoRoot: string): CheckResult {
	const messages = ['=== Check 3: mock.module allowlist ==='];
	let violations = 0;
	const allowlistFile = path.join(repoRoot, 'scripts', 'mock-allowlist.txt');
	if (!fs.existsSync(allowlistFile)) {
		const stderrMessages = [
			`ERROR: ${allowlistFile.replace(/\\/g, '/')} not found — mock.module allowlist is required for Check 3`,
			`       Run: scripts/generate-mock-allowlist.sh to regenerate, or manually add targets to ${allowlistFile.replace(/\\/g, '/')}`,
		];
		return { messages, stderrMessages, violations: 1 };
	}

	const allowlist = new Set(loadAllowlistEntries(allowlistFile));
	const files = [
		...listFiles(path.join(repoRoot, 'tests'), {
			extensions: ['.ts'],
			excludeDirs: new Set(['node_modules', 'dist']),
		}),
		...listFiles(path.join(repoRoot, 'src'), {
			extensions: ['.ts'],
			excludeDirs: new Set(['node_modules', 'dist']),
		}),
	]
		.filter((file) => file.endsWith('.test.ts'))
		.sort((a, b) => a.localeCompare(b));

	for (const file of files) {
		const rel = toPosixRelative(repoRoot, file);
		const activeLines = readText(file)
			.split(/\r?\n/)
			.filter(
				(line) =>
					/mock\.module\(/.test(line) &&
					!/^\s*\/\//.test(line) &&
					!/^\s*\*/.test(line),
			)
			.join('\n');
		if (activeLines.length === 0) {
			continue;
		}
		const callCount = countPatternMatches(activeLines, /mock\.module\(/g);
		const targets = extractMockTargets(activeLines);
		if (callCount !== targets.length) {
			messages.push(
				`ERROR: ${rel} has ${callCount} mock.module call(s) but only ${targets.length} target(s) extracted.`,
			);
			messages.push(
				'       Multiline mock.module calls (target on a separate line from mock.module()) are not supported.',
			);
			messages.push(
				"       Rewrite to single-line format: mock.module('target', () => ({ ... }))",
			);
			messages.push(
				'       The allowlist check cannot validate targets it cannot extract.',
			);
			violations++;
			continue;
		}

		for (const target of targets) {
			const normalized = normalizeMockTarget(target);
			if (allowlist.has(normalized)) {
				continue;
			}
			messages.push(
				`ERROR: ${rel} mocks '${target}' (normalized: '${normalized}') — not in allowlist.`,
			);
			messages.push(
				'       Use _internals DI seam, or run: scripts/generate-mock-allowlist.sh',
			);
			violations++;
		}
	}

	return { messages, violations };
}

export async function checkMockAllowlistGrowth(
	repoRoot: string,
): Promise<CheckResult> {
	const messages = [
		'',
		'=== Check 4: mock.module allowlist growth ratchet (issue #1666) ===',
	];
	let violations = 0;
	const allowlistFile = path.join(repoRoot, 'scripts', 'mock-allowlist.txt');
	if (!fs.existsSync(allowlistFile)) {
		messages.push(
			`NOTE: ${allowlistFile.replace(/\\/g, '/')} not found — Check 4 skipped (Check 3 already flagged this).`,
		);
		return { messages, violations };
	}

	const baseBranch = await resolveBaseBranch(repoRoot);
	if (!baseBranch) {
		messages.push(
			'NOTE: no base branch found (no PR context) — skipping Check 4 (non-blocking).',
		);
		messages.push(
			'      Run from a checkout with origin/main fetched to enable the growth ratchet.',
		);
		return { messages, violations };
	}

	const headEntries = loadAllowlistEntries(allowlistFile);
	const baseShow = await runGit(
		['show', `${baseBranch}:scripts/mock-allowlist.txt`],
		repoRoot,
	);
	const baseEntries =
		baseShow.exitCode === 0
			? baseShow.stdout
					.replace(/\r/g, '')
					.split('\n')
					.map((line) => line.trim())
					.filter((line) => line.length > 0 && !line.startsWith('#'))
			: [];
	const baseSet = new Set(baseEntries);
	const addedEntries = headEntries.filter((entry) => !baseSet.has(entry));
	const approvedMarkers = readText(allowlistFile)
		.split(/\r?\n/)
		.filter((line) => /^#[ \t]*APPROVED-NEW:[ \t]*/.test(line))
		.map((line) =>
			normalizeMockTarget(
				line
					.replace(/^#[ \t]*APPROVED-NEW:[ \t]*/, '')
					.replace(/[ \t]*$/, ''),
			),
		);
	const approvedSet = new Set(approvedMarkers);
	const enforce = resolveEnforce(process.env.MOCK_ALLOWLIST_ENFORCE);
	let ratchetViolations = 0;

	for (const added of addedEntries) {
		if (approvedSet.has(added)) {
			continue;
		}
		messages.push(
			`ERROR (ratchet): new mock target '${added}' added to scripts/mock-allowlist.txt without approval.`,
		);
		messages.push(`       Add a standalone marker line:  # APPROVED-NEW: ${added}`);
		messages.push(
			'       OR remove the target and use the _internals DI seam instead (AGENTS.md invariant 7).',
		);
		ratchetViolations++;
		if (enforce) {
			violations++;
		}
	}

	messages.push(
		`Base entries: ${baseEntries.length} | Head entries: ${headEntries.length} | Added in this PR: ${addedEntries.length} | Approved-new markers found: ${approvedMarkers.length} | Unapproved: ${ratchetViolations}`,
	);
	if (ratchetViolations > 0 && !enforce) {
		messages.push('MOCK_ALLOWLIST_ENFORCE is off — soft-warn (non-blocking).');
	}
	return { messages, violations };
}

function isCommentLine(line: string): boolean {
	return /^[ \t]*(\/\/|\*|\/\*)/.test(line);
}

function codeOf(line: string): string {
	return line.replace(/\/\/.*$/, '');
}

function squash(line: string): string {
	return line.replace(/[ \t]/g, '');
}

function hasDedup(text: string): boolean {
	return (
		text.includes('newSet') ||
		text.includes('.has(') ||
		text.includes('dedupeCapped')
	);
}

export function detectKnowledgeSliceViolations(
	relPath: string,
	source: string,
): string[] {
	const lines = source.split(/\r?\n/);
	const hits: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (isCommentLine(lines[i])) continue;
		const anchor = codeOf(lines[i]);
		if (!anchor.includes('.slice(')) continue;
		let joined = anchor;
		let taken = 0;
		for (let k = i + 1; k < lines.length && taken < 3; k++) {
			if (isCommentLine(lines[k])) continue;
			const piece = squash(codeOf(lines[k]));
			if (piece === '') continue;
			joined += piece;
			taken++;
		}
		joined = squash(joined).replace(/,\)/g, ')');
		if (!joined.includes('.slice(0,20)')) continue;
		let recv = joined;
		taken = 0;
		for (let k = i - 1; k >= 0 && taken < 6; k--) {
			if (isCommentLine(lines[k])) continue;
			const piece = squash(codeOf(lines[k]));
			if (piece === '') continue;
			taken++;
			recv = piece + recv;
		}
		if (hasDedup(recv)) continue;
		hits.push(`${relPath}:${i + 1}:${lines[i]}`);
	}
	return hits;
}

export function detectKnowledgeAccumulatorViolations(
	relPath: string,
	source: string,
): string[] {
	const lines = source.split(/\r?\n/);
	const hits: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (isCommentLine(lines[i])) continue;
		const decl = codeOf(lines[i]);
		if (!/(^|[^A-Za-z0-9_$])(const|let)[ \t]/.test(decl)) continue;
		if (!/:[ \t]*string\[\][ \t]*=[ \t]*\[\]/.test(decl)) continue;
		let name = decl.replace(/^[ \t]*/, '').replace(/^(const|let)[ \t]+/, '');
		name = name.replace(/[ \t]*:.*$/, '');
		if (name === '') continue;

		let dedup = false;
		let taken = 0;
		for (let k = i - 1; k >= 0 && taken < 5; k--) {
			if (isCommentLine(lines[k])) continue;
			const piece = squash(codeOf(lines[k]));
			if (piece === '') continue;
			taken++;
			if (hasDedup(piece)) dedup = true;
		}

		let cappedLineIndex = -1;
		taken = 0;
		for (let k = i + 1; k < lines.length && taken < 30; k++) {
			if (isCommentLine(lines[k])) continue;
			const piece = squash(codeOf(lines[k]));
			if (piece === '') continue;
			taken++;
			if (hasDedup(piece)) dedup = true;
			if (cappedLineIndex === -1 && piece.includes(`${name}.length>=`)) {
				let joined = piece;
				let inner = 0;
				for (let m = k + 1; m < lines.length && inner < 2; m++) {
					if (isCommentLine(lines[m])) continue;
					const next = squash(codeOf(lines[m]));
					if (next === '') continue;
					joined += next;
					inner++;
				}
				if (joined.includes('break')) {
					cappedLineIndex = k;
				}
			}
		}

		if (cappedLineIndex >= 0 && !dedup) {
			hits.push(
				`${relPath}:${cappedLineIndex + 1}:${lines[cappedLineIndex]}`,
			);
		}
	}
	return hits;
}

function escapeRegex(text: string): string {
	return text.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

export function expandScopePattern(repoRoot: string, pattern: string): string[] {
	const absPattern = path.join(repoRoot, ...pattern.split('/'));
	if (!pattern.includes('*')) {
		return fs.existsSync(absPattern) ? [absPattern] : [];
	}
	const dir = path.dirname(absPattern);
	if (!fs.existsSync(dir)) {
		return [];
	}
	const base = path.basename(pattern);
	const regex = new RegExp(`^${escapeRegex(base).replace(/\*/g, '.*')}$`);
	return fs
		.readdirSync(dir, { withFileTypes: true })
		.filter((entry) => entry.isFile() && regex.test(entry.name))
		.map((entry) => path.join(dir, entry.name))
		.sort((a, b) => a.localeCompare(b));
}

export function checkKnowledgeDedupGuardrail(repoRoot: string): CheckResult {
	const messages = [
		'',
		'=== Check 5: knowledge array dedup guardrail (issue #1821 Lane 0b) ===',
	];
	let violations = 0;
	let sliceViolations = 0;
	let sliceScanned = 0;

	const expanded = KNOWLEDGE_DEDUP_SCOPE.map((pattern) => ({
		pattern,
		matches: expandScopePattern(repoRoot, pattern).filter(
			(file) => !file.endsWith('.test.ts'),
		),
	}));
	const resolvedCount = expanded.reduce(
		(count, entry) => count + entry.matches.length,
		0,
	);

	if (resolvedCount === 0) {
		messages.push(
			'NOTE: no Check 5 scope entry resolved — not an opencode-swarm source',
		);
		messages.push(
			'      checkout (no knowledge surface present). Skipping (non-blocking).',
		);
		messages.push(`Scope: ${KNOWLEDGE_DEDUP_SCOPE.join(' ')}`);
		messages.push('Files scanned: 0');
		messages.push(
			'Unguarded positional caps: 0 (expected 0 — no exempt list by design)',
		);
		return { messages, violations };
	}

	for (const { pattern, matches } of expanded) {
		if (matches.length === 0) {
			messages.push(`ERROR: Check 5 scope entry '${pattern}' resolved to no file.`);
			messages.push(
				'       The guardrail would silently scan less than it claims.',
			);
			messages.push(
				'       Update KNOWLEDGE_DEDUP_SCOPE in scripts/check-invariants.ts after the rename/deletion.',
			);
			violations++;
			continue;
		}
		for (const file of matches) {
			sliceScanned++;
			const rel = toPosixRelative(repoRoot, file);
			const source = readText(file);
			for (const hit of detectKnowledgeSliceViolations(rel, source)) {
				messages.push(`ERROR: ${hit}`);
				messages.push(
					'       Positional .slice(0, 20) with no dedup on a knowledge array field.',
				);
				messages.push(
					'       Use dedupeCapped(values, { cap: 20 }) from src/hooks/knowledge-store.ts',
				);
				messages.push(
					'       (add itemMaxChars when the site also truncates each item).',
				);
				sliceViolations++;
				violations++;
			}
			for (const hit of detectKnowledgeAccumulatorViolations(rel, source)) {
				messages.push(`ERROR: ${hit}`);
				messages.push(
					'       Capped string[] accumulator with no dedup — a run of duplicates',
				);
				messages.push(
					'       evicts distinct values off the end (truncate-then-dedupe).',
				);
				messages.push(
					'       Dedupe BEFORE the cap: use dedupeCapped() from',
				);
				messages.push(
					'       src/hooks/knowledge-store.ts, or guard the push with a seen Set.',
				);
				sliceViolations++;
				violations++;
			}
		}
	}

	messages.push(`Scope: ${KNOWLEDGE_DEDUP_SCOPE.join(' ')}`);
	messages.push(`Files scanned: ${sliceScanned}`);
	messages.push(
		`Unguarded positional caps: ${sliceViolations} (expected 0 — no exempt list by design)`,
	);
	return { messages, violations };
}

export function checkRawAdvisoryPush(repoRoot: string): CheckResult {
	const helper = 'src/utils/advisory-queue.ts';
	// The duplicate heading is intentionally preserved for byte-identical
	// stdout parity with the pre-port Bash owner (issue #2094).
	const messages = [
		'=== Check: no raw pendingAdvisoryMessages.push outside src/utils/advisory-queue.ts (issue #1976) ===',
	];
	let violationFiles = 0;
	const details: string[] = [];
	const files = listFiles(path.join(repoRoot, 'src'), {
		extensions: ['.ts'],
		excludeDirs: new Set(['dist', 'node_modules', '__tests__']),
	});
	for (const file of files) {
		const rel = toPosixRelative(repoRoot, file);
		if (
			rel === helper ||
			rel.endsWith('.test.ts') ||
			rel.endsWith('.adversarial.test.ts')
		) {
			continue;
		}
		const lines = readText(file).split(/\r?\n/);
		const matches = lines
			.map((line, index) => ({ line, lineNo: index + 1 }))
			.filter(({ line }) =>
				/pendingAdvisoryMessages[ \t]*([?!][ \t]*)?\.[ \t]*push[ \t]*\(/.test(
					line,
				),
			);
		if (matches.length === 0) {
			continue;
		}
		violationFiles++;
		for (const match of matches) {
			details.push(`  ${rel}:${match.lineNo}:${match.line}`);
		}
	}

	if (violationFiles > 0) {
		messages.push(
			'ERROR: found direct pendingAdvisoryMessages.push() call(s) outside the shared',
		);
		messages.push(
			'       advisory-queue helper. Route every advisory push through',
		);
		messages.push(
			'       pushAdvisory(session, message, opts?) (src/utils/advisory-queue.ts) so the',
		);
		messages.push(
			'       queue gets dedupe + length cap by construction.',
		);
		messages.push(`Violations:\n${details.join('\n')}`);
		messages.push('');
		messages.push('To fix: replace');
		messages.push('    session.pendingAdvisoryMessages ??= [];');
		messages.push('    session.pendingAdvisoryMessages.push(msg);');
		messages.push('with');
		messages.push('    pushAdvisory(session, msg);');
		return { messages, violations: 1 };
	}

	messages.push('OK — all advisory pushes route through pushAdvisory().');
	return { messages, violations: 0 };
}

/**
 * Check 7 (issue #2477): every ACTIVE quarantine entry carries structured
 * OWNER and EXPIRY metadata in its comment block. Grammar:
 *
 *   # OWNER: <owner> — <issue ref / context>
 *   # EXPIRY: YYYY-MM-DD — <retirement criterion>
 *   <repo-relative test path>
 *
 * Missing OWNER/EXPIRY is a violation. An EXPIRY in the past warns inside the
 * 14-day grace window and fails beyond it (dates compared in UTC).
 */
export function checkQuarantineMetadata(
	repoRoot: string,
	now: Date = new Date(),
): CheckResult {
	const messages = [
		'=== Check 7: quarantine entries carry OWNER + EXPIRY metadata (issue #2477) ===',
	];
	let violations = 0;
	const ownerPattern = /^#\s*OWNER:\s*(\S.*)$/;
	const expiryPattern = /^#\s*EXPIRY:\s*(\d{4})-(\d{2})-(\d{2})\b/;
	const expiryLoosePattern = /^#\s*EXPIRY:\s*(\S.*)$/;

	for (const listRel of QUARANTINE_LIST_FILES) {
		const listFile = path.join(repoRoot, listRel);
		if (!fs.existsSync(listFile)) {
			messages.push(
				`ERROR: ${listRel} not found — the quarantine list file is required.`,
			);
			violations += 1;
			continue;
		}
		const lines = readText(listFile).split(/\r?\n/);
		for (let index = 0; index < lines.length; index += 1) {
			const line = lines[index];
			if (line.trim() === '' || line.trimStart().startsWith('#')) {
				continue;
			}
			const entry = line.trim();
			// Walk upward through the contiguous comment block above the path.
			let owner: string | null = null;
			let expiry: string | null = null;
			let expiryMalformed: string | null = null;
			for (let up = index - 1; up >= 0; up -= 1) {
				const above = lines[up];
				if (above.trim() === '' || !above.trimStart().startsWith('#')) {
					break;
				}
				const ownerMatch = above.match(ownerPattern);
				if (ownerMatch) {
					owner = ownerMatch[1].trim();
				}
				const expiryMatch = above.match(expiryPattern);
				if (expiryMatch) {
					expiry = `${expiryMatch[1]}-${expiryMatch[2]}-${expiryMatch[3]}`;
				}
				const expiryLoose = above.match(expiryLoosePattern);
				if (
					expiryLoose &&
					!expiryPattern.test(above) &&
					expiryMalformed === null
				) {
					// Captured regardless of whether a valid EXPIRY was already
					// seen (the walk runs upward, so a valid line below a
					// malformed one must not hide the malformed line — it is
					// reported as a warning when a valid date wins, review
					// F-006/api-001).
					expiryMalformed = expiryLoose[1].trim();
				}
			}
			if (owner === null) {
				messages.push(
					`ERROR: ${listRel} entry '${entry}' has no '# OWNER:' line in its comment block.`,
				);
				violations += 1;
			}
			if (expiryMalformed !== null && expiry !== null) {
				// A malformed EXPIRY line coexisting with a later valid one is
				// not an error (the valid date wins), but it must not vanish
				// silently (review F-006/api-001).
				messages.push(
					`WARNING: ${listRel} entry '${entry}' has a malformed '# EXPIRY:' line ('${expiryMalformed}') that is ignored in favor of the valid '${expiry}'.`,
				);
			}
			if (expiryMalformed !== null && expiry === null) {
				messages.push(
					`ERROR: ${listRel} entry '${entry}' has a malformed '# EXPIRY:' line (expected '# EXPIRY: YYYY-MM-DD — <criterion>'; got '${expiryMalformed}').`,
				);
				violations += 1;
			} else if (expiry === null) {
				messages.push(
					`ERROR: ${listRel} entry '${entry}' has no '# EXPIRY:' line in its comment block.`,
				);
				violations += 1;
			} else {
				const expiryUtc = Date.UTC(
					Number(expiry.slice(0, 4)),
					Number(expiry.slice(5, 7)) - 1,
					Number(expiry.slice(8, 10)),
				);
				const nowUtc = Date.UTC(
					now.getUTCFullYear(),
					now.getUTCMonth(),
					now.getUTCDate(),
				);
				const daysPast = Math.floor(
					(nowUtc - expiryUtc) / (24 * 60 * 60 * 1000),
				);
				if (daysPast > QUARANTINE_EXPIRY_GRACE_DAYS) {
					messages.push(
						`ERROR: ${listRel} entry '${entry}' expired ${expiry} (${daysPast} days ago, beyond the ${QUARANTINE_EXPIRY_GRACE_DAYS}-day grace window) — retire it or renew the EXPIRY with an updated criterion.`,
					);
					violations += 1;
				} else if (daysPast > 0) {
					messages.push(
						`WARNING: ${listRel} entry '${entry}' expired ${expiry} (${daysPast} day(s) ago, inside the grace window) — renew or retire before the grace window closes.`,
					);
				}
			}
		}
	}
	if (violations === 0) {
		messages.push('All active quarantine entries carry OWNER + EXPIRY metadata.');
	}
	return { messages, violations };
}

export async function main(startDir: string = process.cwd()): Promise<number> {
	const repoRoot = await resolveRepoRoot(startDir);
	let violations = 0;
	const advisory = checkRawAdvisoryPush(repoRoot);
	const outputs: CheckResult[] = [
		checkSubprocessTimeout(repoRoot),
		checkProcessCwdBan(repoRoot),
		checkMockAllowlist(repoRoot),
		await checkMockAllowlistGrowth(repoRoot),
		checkKnowledgeDedupGuardrail(repoRoot),
		{
			messages: [
				'=== Check 6: no raw pendingAdvisoryMessages.push outside the helper (issue #1976) ===',
				...advisory.messages,
			],
			violations: advisory.violations,
		},
		checkQuarantineMetadata(repoRoot),
	];

	for (const output of outputs) {
		violations += output.violations;
		for (const line of output.messages) {
			console.log(line);
		}
		for (const line of output.stderrMessages ?? []) {
			console.error(line);
		}
	}

	console.log('');
	console.log('=== Summary ===');
	console.log('Checks run: 1 (subprocess timeout, advisory) | 2 (process.cwd ban) |');
	console.log(
		'            3 (mock.module allowlist) | 4 (allowlist growth ratchet) |',
	);
	console.log(
		'            5 (knowledge array dedup guardrail) | 6 (advisory-injection ratchet) |',
	);
	console.log('            7 (quarantine OWNER/EXPIRY metadata)');
	if (violations > 0) {
		console.log(`${violations} invariant violation(s) found.`);
		return 1;
	}

	console.log('All engineering invariant checks passed.');
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
