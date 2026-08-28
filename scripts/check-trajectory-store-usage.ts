#!/usr/bin/env bun
/**
 * Trajectory-store usage gate — issue #2041's anti-bypass ratchet (mirrors
 * `scripts/check-shell-audit-usage.ts`, issue #2040):
 *
 * RULE 1 (import graph): every `src/**\/*.ts` file importing the session
 * trajectory store must be allowlisted below with a reason a reviewer can
 * check. New producers/readers must go through `src/prm/trajectory-store.ts`
 * (the locked append seam + bounded tail reads + compaction); growing this
 * allowlist is a visible review-time action.
 *
 * RULE 2 (literal mention): every non-comment mention of the `'trajectories'`
 * path literal (the `.swarm/trajectories/` directory segment) must likewise
 * be allowlisted — a raw `path.join(directory, '.swarm', 'trajectories')`
 * bypasses the store's bounded readers, which is exactly the "no unbounded
 * reader" clause of issue #2041's full-resolution contract.
 *
 * Reason classes:
 *   seam      — the store module itself
 *   caller    — routes every read/write through the store's exported seam
 *   enumerator — the documented read-only session lister (corpus)
 *   lifecycle — reset/init registration ownership
 *
 * Limitation (same as the #2040 ratchet): this is a LITERAL-mention ratchet.
 * Source that constructs the path at runtime (fromCharCode, computed member
 * access) is invisible to it — bypassing requires deliberate intent and
 * survives code review; the allowlist edit is the visible control.
 *
 * Escape hatch: TRAJECTORY_STORE_USAGE_ENFORCE=0|false|no|off soft-warns (same
 * convention as SHELL_AUDIT_USAGE_ENFORCE).
 *
 * Portability: TypeScript + Bun only (no new Bash gates — issue #2078). Pure
 * logic is exported for unit tests.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Allowed IMPORTERS of the trajectory-store module. Grow ONLY with a reason a
 * reviewer can check — the default answer for new code is the seam.
 */
export const TRAJECTORY_STORE_IMPORT_ALLOWLIST: Readonly<
	Record<string, { reason: string; cls: string }>
> = Object.freeze({
	'src/prm/trajectory-store.ts': {
		reason: 'the bounded session-trajectory store and append seam itself (issue #2041)',
		cls: 'seam',
	},
	'src/prm/index.ts': {
		reason: 'PRM facade — cold-start reads via readTrajectoryWithCoverage, debounced cleanup scheduling, cache clear (issue #2041)',
		cls: 'caller',
	},
	'src/hooks/trajectory-logger.ts': {
		reason: 'production append caller — routes every session-trajectory write through appendTrajectoryEntry and seeds steps via getCurrentStep (issue #2041)',
		cls: 'caller',
	},
	'src/state.ts': {
		reason: 'reset lifecycle — clears the composite-keyed in-memory cache (issue #2041)',
		cls: 'lifecycle',
	},
	'src/consensus/corpus.ts': {
		reason: 'consensus reader — bounded readTrajectory + checkpoint coverage; documented read-only session enumerator (issue #2041)',
		cls: 'caller',
	},
	'src/index.ts': {
		reason: 'init lifecycle — registers the one bounded post-resolution cleanup pass (issue #2041)',
		cls: 'lifecycle',
	},
});

/**
 * Allowed non-comment mentions of the `'trajectories'` directory literal.
 */
export const TRAJECTORY_MENTION_ALLOWLIST: Readonly<
	Record<string, { reason: string; cls: string }>
> = Object.freeze({
	'src/prm/trajectory-store.ts': {
		reason: 'the bounded store and its cleanup sweep own the directory (issue #2041)',
		cls: 'seam',
	},
	'src/consensus/corpus.ts': {
		reason: 'listTrajectorySessions — the documented read-only enumerator (single readdir, no entry reads; see corpus.ts:367-376)',
		cls: 'enumerator',
	},
});

/** Matches an import of the store module (static or dynamic, .js optional,
 *  both quote styles — mirrors the #2040 ratchet's RC-5/MS-1 lesson). */
export const TRAJECTORY_STORE_IMPORT =
	/from\s+['"][^'"]*trajectory-store(?:\.js)?['"]|import\(\s*['"][^'"]*trajectory-store(?:\.js)?['"]\s*\)/;

/** Matches the `trajectories` directory segment as a string literal. */
export const TRAJECTORY_LITERAL = /['"`]trajectories['"`]/;

export interface UsageViolation {
	file: string;
	line: number;
	text: string;
}

/** Strip // line comments and block comments while preserving string literals
 *  verbatim (mentions inside strings COUNT — only comments are removed).
 *  Delegates the semantics to a compact local copy rather than importing the
 *  shell-audit gate (scripts stay independently runnable; behavior identical). */
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

export function findViolations(
	sources: ReadonlyArray<{ file: string; source: string }>,
	importAllowlist: Readonly<Record<string, unknown>> = TRAJECTORY_STORE_IMPORT_ALLOWLIST,
	mentionAllowlist: Readonly<Record<string, unknown>> = TRAJECTORY_MENTION_ALLOWLIST,
): UsageViolation[] {
	const violations: UsageViolation[] = [];
	for (const { file, source } of sources) {
		const stripped = stripComments(source);
		// RULE 1: import graph. Any file NOT on the import allowlist that
		// imports the store is a violation.
		if (
			importAllowlist[file] === undefined &&
			TRAJECTORY_STORE_IMPORT.test(stripped)
		) {
			violations.push({
				file,
				line: 0,
				text: 'imports the trajectory store module outside the approved caller set',
			});
		}
		// RULE 2: raw path-literal mention. Guarded ONLY by the mention
		// allowlist — deliberately NOT nested under RULE 1, otherwise the
		// import-allowlisted production callers (the files most likely to
		// introduce a raw .swarm/trajectories read) would be exempt from the
		// literal ratchet (maintainer review #2395, finding 1).
		if (mentionAllowlist[file] === undefined) {
			const lines = stripped.split('\n');
			for (let idx = 0; idx < lines.length; idx += 1) {
				const trimmedLine = lines[idx]!.trimStart();
				// JSDoc-body lines and line comments are not code mentions.
				if (
					trimmedLine.startsWith('*') ||
					trimmedLine.startsWith('//')
				) {
					continue;
				}
				if (TRAJECTORY_LITERAL.test(lines[idx]!)) {
					violations.push({
						file,
						line: idx + 1,
						text: `unregistered 'trajectories' path-literal mention — ${lines[idx]!
							.trim()
							.slice(0, 120)}`,
					});
				}
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
export function collectTrajectoryStoreUsageErrors(): string[] {
	const root = process.cwd();
	const files = collectSrcFiles(root);
	const sources = files.map((file) => ({
		file: path.relative(root, file).split(path.sep).join('/'),
		source: fs.readFileSync(file, 'utf-8'),
	}));
	return findViolations(sources).map(
		(v) => `${v.file}${v.line > 0 ? `:${v.line}` : ''}: ${v.text}`,
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
			`[check-trajectory-store-usage] OK — no unregistered trajectory-store imports or 'trajectories' path literals in ${sources.length} src files`,
		);
		return 0;
	}
	console.error(
		'[check-trajectory-store-usage] VIOLATION — trajectory-store imports or raw trajectories/ path literals outside the approved seam:',
	);
	for (const v of violations) {
		console.error(
			`  ${v.file}${v.line > 0 ? `:${v.line}` : ''}: ${v.text}`,
		);
	}
	console.error(
		'[check-trajectory-store-usage] route reads/appends through src/prm/trajectory-store.ts, or add a reviewed allowlist entry with a reason class.',
	);
	if (!resolveEnforce(process.env.TRAJECTORY_STORE_USAGE_ENFORCE)) {
		console.error('[check-trajectory-store-usage] TRAJECTORY_STORE_USAGE_ENFORCE=0 — soft-warn only');
		return 0;
	}
	return 1;
}

if (import.meta.main) {
	process.exitCode = main();
}
