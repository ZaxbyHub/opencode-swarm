#!/usr/bin/env bun
/**
 * Core event store usage gate — issue #2039's anti-bypass ratchet:
 *
 *   "A CI/static check prevents new direct events.jsonl full reads and
 *    unregistered appends outside approved seams."
 *
 * RULE: after grepping every `src/**\/*.ts` file for the literal
 * `events.jsonl` (comments stripped first), every remaining mention must be
 * allowlisted below with a reason class. New producers/readers of the core
 * event bus must go through `src/events/core-events.ts` (the append seam +
 * bounded reads + authority queries); growing this allowlist is a visible
 * review-time action.
 *
 * Reason classes:
 *   seam           — the store module itself
 *   lifecycle      — archive/clean/reset ownership of the files
 *   archive-reader — reads ARCHIVED copies (immutable validated cuts)
 *   prompt-doc     — prompt/help/output TEXT mentioning the stream (no I/O)
 *
 * Escape hatch: CORE_EVENTS_USAGE_ENFORCE=0|false|no|off soft-warns (same
 * convention as TEST_CAP_ENFORCE / FRAGMENT_CHECK_ENFORCE).
 *
 * Portability: TypeScript + Bun only (no new Bash gates — issue #2078).
 * Pure logic is exported for unit tests.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export const CORE_EVENTS_FILE = 'src/events/core-events.ts';

/**
 * Allowed mentions of the literal `events.jsonl` in non-comment source.
 * Keys are repo-root-relative posix paths. Grow ONLY with a reason a
 * reviewer can check — the default answer for new code is the seam.
 */
export const CORE_EVENTS_MENTION_ALLOWLIST: Readonly<
	Record<
		string,
		{ reason: string; cls: 'seam' | 'lifecycle' | 'archive-reader' | 'prompt-doc' }
	>
> = Object.freeze({
	'src/events/core-events.ts': {
		reason: 'the bounded core event store and append seam itself (issue #2039)',
		cls: 'seam',
	},
	'src/commands/close.ts': {
		reason: 'archive/clean lifecycle ownership of events.jsonl and events-authority-index.json',
		cls: 'lifecycle',
	},
	'src/commands/reset.ts': {
		reason: 'reset lifecycle ownership of events.jsonl and events-authority-index.json',
		cls: 'lifecycle',
	},
	'src/services/session-reflection.ts': {
		reason: 'reads ARCHIVED events.jsonl copies (immutable validated cuts) with a bounded, symlink-guarded fallback read',
		cls: 'archive-reader',
	},
	'src/agents/architect.ts': {
		reason: 'agent prompt template references the event stream name (documentation text, no I/O)',
		cls: 'prompt-doc',
	},
	'src/agents/explorer.ts': {
		reason: 'agent prompt template references the event stream name (documentation text, no I/O)',
		cls: 'prompt-doc',
	},
	'src/commands/abort-pr-workflow.ts': {
		reason: 'user-facing help/output strings describing where the audit trail lives (documentation text, no I/O)',
		cls: 'prompt-doc',
	},
	'src/commands/approve-plan-critic.ts': {
		reason: 'user-facing help/output strings describing where the audit event lands (documentation text, no I/O)',
		cls: 'prompt-doc',
	},
	'src/commands/registry.ts': {
		reason: 'command help strings describing audit-trail locations (documentation text, no I/O)',
		cls: 'prompt-doc',
	},
	'src/tools/abort-pr-workflow.ts': {
		reason: 'tool description/help strings describing where the audit trail lives (documentation text, no I/O)',
		cls: 'prompt-doc',
	},
	'src/tools/approve-plan-critic.ts': {
		reason: 'tool description/help strings describing where the audit event lands (documentation text, no I/O)',
		cls: 'prompt-doc',
	},
	'src/services/diagnose-service.ts': {
		reason: 'user-facing diagnostic output strings naming the checked store (the reads themselves go through the seam API)',
		cls: 'prompt-doc',
	},
});

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

/** Matches `events.jsonl` as a standalone path component — preceded by a
 *  path separator, quote, whitespace, or start-of-line, but NOT by an
 *  identifier character (knowledge-events.jsonl, outcome-events.jsonl and
 *  reward-events.jsonl are different stores and must not match). */
export const EVENTS_LITERAL = /(^|[^A-Za-z0-9_-])events\.jsonl/;

export interface UsageViolation {
	file: string;
	line: number;
	text: string;
}

export function findViolations(
	sources: ReadonlyArray<{ file: string; source: string }>,
	allowlist: Readonly<Record<string, unknown>> = CORE_EVENTS_MENTION_ALLOWLIST,
): UsageViolation[] {
	const violations: UsageViolation[] = [];
	for (const { file, source } of sources) {
		if (allowlist[file] !== undefined) continue;
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
			if (EVENTS_LITERAL.test(lines[idx]!)) {
				violations.push({
					file,
					line: idx + 1,
					text: lines[idx]!.trim().slice(0, 120),
				});
			}
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
export function collectCoreEventsUsageErrors(): string[] {
	const root = process.cwd();
	const files = collectSrcFiles(root);
	const sources = files.map((file) => ({
		file: path.relative(root, file).split(path.sep).join('/'),
		source: fs.readFileSync(file, 'utf-8'),
	}));
	return findViolations(sources).map(
		(v) => `${v.file}:${v.line}: unregistered events.jsonl mention — ${v.text}`,
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
			`[check-core-events-usage] OK — no unregistered events.jsonl mentions in ${sources.length} src files`,
		);
		return 0;
	}
	console.error(
		'[check-core-events-usage] VIOLATION — direct events.jsonl mentions outside the approved seam:',
	);
	for (const v of violations) {
		console.error(`  ${v.file}:${v.line}: ${v.text}`);
	}
	console.error(
		'[check-core-events-usage] route reads/appends through src/events/core-events.ts, or add a reviewed allowlist entry with a reason class.',
	);
	if (!resolveEnforce(process.env.CORE_EVENTS_USAGE_ENFORCE)) {
		console.error('[check-core-events-usage] CORE_EVENTS_USAGE_ENFORCE=0 — soft-warn only');
		return 0;
	}
	return 1;
}

if (import.meta.main) {
	process.exitCode = main();
}
