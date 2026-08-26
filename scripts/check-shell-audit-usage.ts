#!/usr/bin/env bun
/**
 * Shell-audit store usage gate — issue #2040's anti-bypass ratchet:
 *
 *   "An anti-regression check so new audit fields declare redaction/content
 *    class and new direct full-file readers are rejected."
 *
 * RULE: after grepping every `src/**\/*.ts` file for the literal
 * `shell-audit.jsonl` (comments stripped first), every remaining mention must
 * be allowlisted below with a reason class. New producers/readers of the
 * shell-audit store must go through `src/hooks/guardrails/shell-audit-store.ts`
 * (the append seam + bounded tail reads + finalize); growing this allowlist is
 * a visible review-time action.
 *
 * Reason classes:
 *   seam           — the store module itself
 *   lifecycle      — archive/clean/reset ownership of the files
 *   archive-reader — reads ARCHIVED copies (immutable validated cuts)
 *   prompt-doc     — prompt/help/output TEXT mentioning the stream (no I/O)
 *
 * Limitation (mirrors the #2039 PRR-029 note): this is a LITERAL-mention
 * ratchet. Source that constructs the path at runtime ('shell-audit' +
 * '.jsonl', fromCharCode, computed member access) is invisible to it —
 * bypassing requires deliberate intent and survives code review; the
 * allowlist edit is the visible control.
 *
 * Escape hatch: SHELL_AUDIT_USAGE_ENFORCE=0|false|no|off soft-warns (same
 * convention as TEST_CAP_ENFORCE / FRAGMENT_CHECK_ENFORCE /
 * CORE_EVENTS_USAGE_ENFORCE).
 *
 * Portability: TypeScript + Bun only (no new Bash gates — issue #2078).
 * Pure logic is exported for unit tests.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export const SHELL_AUDIT_STORE_FILE = 'src/hooks/guardrails/shell-audit-store.ts';

/**
 * Allowed mentions of the literal `shell-audit.jsonl` in non-comment source.
 * Keys are repo-root-relative posix paths. Grow ONLY with a reason a
 * reviewer can check — the default answer for new code is the seam.
 */
export const SHELL_AUDIT_MENTION_ALLOWLIST: Readonly<
	Record<
		string,
		{ reason: string; cls: 'seam' | 'lifecycle' | 'archive-reader' | 'prompt-doc' }
	>
> = Object.freeze({
	'src/hooks/guardrails/shell-audit-store.ts': {
		reason: 'the bounded shell-audit store and append seam itself (issue #2040)',
		cls: 'seam',
	},
});

/**
 * Allowed IMPORTERS of the shell-audit-store module (reviewer round R3):
 * the literal ratchet above cannot see a path constructed at runtime via
 * the exported `shellAuditFilePath`, so the store's import graph is itself
 * ratcheted — every src file importing from `shell-audit-store` must be
 * allowlisted with a reason a reviewer can check. New readers/writers must
 * go through the existing callers or grow this list visibly.
 */
export const SHELL_AUDIT_IMPORT_ALLOWLIST: Readonly<
	Record<string, { reason: string; cls: string }>
> = Object.freeze({
	'src/hooks/guardrails/shell-audit-store.ts': {
		reason: 'the store module itself',
		cls: 'seam',
	},
	'src/hooks/guardrails/audit-log.ts': {
		reason: 'the validated+redacted decision append seam — routes every write through appendShellAuditLineSync (issue #2040)',
		cls: 'seam-caller',
	},
	'src/services/guardrail-log-service.ts': {
		reason: 'the bounded diagnostic reader — routes reads through readShellAuditTail / getShellAuditFoldedSummary (issue #2040)',
		cls: 'seam-caller',
	},
	'src/commands/close.ts': {
		reason: 'close lifecycle ownership — finalizes the store before the session/ archive copy via finalizeShellAuditForClose (issue #2040)',
		cls: 'lifecycle',
	},
});

/** Matches an import of the store module (static or dynamic, .js optional). */
export const SHELL_AUDIT_IMPORT = /from\s+'[^']*shell-audit-store(?:\.js)?'|import\(\s*'[^']*shell-audit-store(?:\.js)?'\s*\)/;

/** Strip // line comments and /* block *\/ comments while preserving string
 *  literals verbatim (mentions inside strings and template literals COUNT —
 *  only true comment regions are removed). */
export function stripComments(source: string): string {
	let out = '';
	let i = 0;
	let state: 'code' | 'line' | 'block' | 'single' | 'double' | 'template' =
		'code';
	while (i < source.length) {
		const ch = source[i]!;
		const next = source[i + 1];
		switch (state) {
			case 'code': {
				if (ch === '/' && next === '/') {
					state = 'line';
					i += 2;
					continue;
				}
				if (ch === '/' && next === '*') {
					state = 'block';
					i += 2;
					continue;
				}
				if (ch === "'") {
					state = 'single';
					out += ch;
					i += 1;
					continue;
				}
				if (ch === '"') {
					state = 'double';
					out += ch;
					i += 1;
					continue;
				}
				if (ch === '`') {
					state = 'template';
					out += ch;
					i += 1;
					continue;
				}
				out += ch;
				i += 1;
				continue;
			}
			case 'line': {
				if (ch === '\n') {
					state = 'code';
					out += ch;
				}
				i += 1;
				continue;
			}
			case 'block': {
				if (ch === '*' && next === '/') {
					state = 'code';
					i += 2;
					continue;
				}
				i += 1;
				continue;
			}
			case 'single':
			case 'double':
			case 'template': {
				if (ch === '\\') {
					out += ch + (source[i + 1] ?? '');
					i += 2;
					continue;
				}
				const closer =
					state === 'single' ? "'" : state === 'double' ? '"' : '`';
				if (ch === closer) state = 'code';
				out += ch;
				i += 1;
				continue;
			}
		}
	}
	return out;
}

/** Matches `shell-audit.jsonl` as a standalone path component — preceded by a
 *  path separator, quote, whitespace, or start-of-line, but NOT by an
 *  identifier character or hyphen (so `shell-audit-store.ts` module paths do
 *  not match). */
export const SHELL_AUDIT_LITERAL = /(^|[^A-Za-z0-9_-])shell-audit\.jsonl/;

export interface UsageViolation {
	file: string;
	line: number;
	text: string;
}

export function findViolations(
	sources: ReadonlyArray<{ file: string; source: string }>,
	allowlist: Readonly<Record<string, unknown>> = SHELL_AUDIT_MENTION_ALLOWLIST,
	importAllowlist: Readonly<Record<string, unknown>> = SHELL_AUDIT_IMPORT_ALLOWLIST,
): UsageViolation[] {
	const violations: UsageViolation[] = [];
	for (const { file, source } of sources) {
		if (allowlist[file] === undefined) {
			const stripped = stripComments(source);
			const lines = stripped.split('\n');
			for (let idx = 0; idx < lines.length; idx += 1) {
				const trimmedLine = lines[idx]!.trimStart();
				// JSDoc-body lines and line comments are not code mentions. This
				// second pass keeps the gate fail-closed for CODE even when the
				// string-state machine mis-tracks on regex literals.
				if (trimmedLine.startsWith('*') || trimmedLine.startsWith('//')) {
					continue;
				}
				if (SHELL_AUDIT_LITERAL.test(lines[idx]!)) {
					violations.push({
						file,
						line: idx + 1,
						text: `unregistered shell-audit.jsonl mention — ${lines[idx]!
							.trim()
							.slice(0, 120)}`,
					});
				}
			}
		}
		// Import-graph ratchet (reviewer round R3): constructing the store path
		// at runtime via the exported helpers is invisible to the literal
		// ratchet, so any NEW importer of the store module must be allowlisted.
		if (
			importAllowlist[file] === undefined &&
			SHELL_AUDIT_IMPORT.test(stripComments(source))
		) {
			violations.push({
				file,
				line: 0,
				text: 'imports the shell-audit store module outside the approved caller set',
			});
		}
	}
	return violations;
}

function collectSrcFiles(root: string): string[] {
	const out: string[] = [];
	const walk = (dir: string): void => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				// In-tree tests (src/__tests__) legitimately construct raw store
				// fixtures; the gate governs production code only.
				if (entry.name === '__tests__') continue;
				walk(full);
			} else if (entry.isFile() && entry.name.endsWith('.ts')) {
				out.push(full);
			}
		}
	};
	walk(path.join(root, 'src'));
	return out;
}

function resolveEnforce(value: string | undefined): boolean {
	if (value === undefined) return true;
	return !['0', 'false', 'no', 'off'].includes(value.toLowerCase());
}

/** Drift-check integration: collect violations as human-readable strings. */
export function collectShellAuditUsageErrors(): string[] {
	const root = process.cwd();
	const files = collectSrcFiles(root);
	const sources = files.map((file) => ({
		file: path.relative(root, file).split(path.sep).join('/'),
		source: fs.readFileSync(file, 'utf-8'),
	}));
	return findViolations(sources).map(
		(v) =>
			`${v.file}${v.line > 0 ? `:${v.line}` : ''}: ${v.text}`,
	);
}

function main(): number {
	const root = process.cwd();
	const files = collectSrcFiles(root);
	const sources = files.map((file) => ({
		file: path.relative(root, file).split(path.sep).join('/'),
		source: fs.readFileSync(file, 'utf-8'),
	}));
	const violations = findViolations(sources);
	if (violations.length === 0) {
		console.log(
			`[check-shell-audit-usage] OK — no unregistered shell-audit.jsonl mentions in ${sources.length} src files`,
		);
		return 0;
	}
	console.error(
		'[check-shell-audit-usage] VIOLATION — direct shell-audit.jsonl mentions or store-module imports outside the approved seam:',
	);
	for (const v of violations) {
		console.error(
			`  ${v.file}${v.line > 0 ? `:${v.line}` : ''}: ${v.text}`,
		);
	}
	console.error(
		'[check-shell-audit-usage] route reads/appends through src/hooks/guardrails/shell-audit-store.ts, or add a reviewed allowlist entry with a reason class.',
	);
	if (!resolveEnforce(process.env.SHELL_AUDIT_USAGE_ENFORCE)) {
		console.error('[check-shell-audit-usage] SHELL_AUDIT_USAGE_ENFORCE=0 — soft-warn only');
		return 0;
	}
	return 1;
}

if (import.meta.main) {
	process.exitCode = main();
}
