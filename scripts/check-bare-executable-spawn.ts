#!/usr/bin/env bun
/**
 * Issue #2236 (F8b) — recurrence guardrail for the "bare-executable-name
 * spawn" hardening class, rung 1 on the guardrail ladder (static-analysis
 * rule). Written in TypeScript, not Bash, per the `check:gate-portability`
 * ratchet (issue #2078): a Bash-only gate cannot be run by a Windows
 * contributor. Mirrors the structure, injectable-root, `_internals` seam,
 * and exit-code conventions of `check-event-contract.ts` / `check-tool-
 * registration.ts` / `check-gate-portability.ts`.
 *
 * Defect class: a call site that spawns `'git'`, `'gh'`, `'sandbox-exec'`, or
 * `'bwrap'` by BARE NAME (rather than through a resolved absolute path) is
 * vulnerable to the ENOENT-under-posix_spawn class this issue's fix (F0-F5)
 * addresses at the `bun-compat.ts` chokepoint. This gate does not fix any one
 * call site — it prevents a NEW bare-name spawn from being reintroduced once
 * the sibling lane's resolver migration lands.
 *
 * Predicate (critic-approved, verbatim from 07-approved-plan.md F8b), with
 * ONE documented deviation from the literal text — see EXECUTABLE_PROPERTY
 * below. A call expression is flagged when the executable argument is a
 * string literal in {git, gh, sandbox-exec, bwrap} AND that argument is
 * either:
 *   1. the first positional argument of a call whose callee name is in
 *      {spawnSync, spawn, execFile, execFileSync, exec, bunSpawn,
 *      runExternalTool} — e.g. `spawnSync('git', args, opts)`;
 *   2. the first element of a first-argument array literal of such a call —
 *      e.g. `bunSpawn(['git', ...args], opts)`;
 *   3. an `executable:` property of an object-literal argument of ANY call
 *      (deliberately NOT callee-restricted — see below).
 *
 * `sameStringArray(check.command, ['git', 'diff', '--check'])` at
 * `src/hooks/pr-workflow-gate.ts:3358` is excluded STRUCTURALLY: its callee
 * is not in the spawn family (forms 1/2), and it passes no object-literal
 * argument (form 3). No allowlist entry is needed or wanted.
 *
 * DEVIATION FROM THE LITERAL PLAN TEXT: the plan's formal predicate states
 * form 3 shares the same callee restriction as forms 1/2. Applied literally,
 * that MISSES two of the plan's own six mandatory sites — `src/mutation/
 * engine.ts:304` and `:387` call a local `runner` variable (typed
 * `MutationCommandRunner`, defaulting to `runExternalTool` but not literally
 * named that at the call site), not a name in the spawn-family set. The
 * plan's six-site enumeration is the better evidence of intent: it is used to
 * JUSTIFY form 3's existence ("without it these six go unguarded"), so form 3
 * is implemented callee-independently, keyed on the `executable` property
 * name itself as the discriminator. This is safe: an exhaustive repo grep for
 * `executable:\s*['"](git|gh|sandbox-exec|bwrap)['"]` found exactly six
 * matches, all six of which are the mandatory sites — zero unrelated hits.
 * Forms 1/2 keep the callee restriction; broadening those too would flag the
 * `sameStringArray` array-comparison this gate must NOT flag. Reported to the
 * requesting lane for critic re-confirmation.
 *
 * Parsing: real AST parse via the `typescript` compiler API (already a
 * devDependency, resolvable from `bun run scripts/*.ts` — verified against a
 * `bun install --frozen-lockfile` CI install, not `--production`). Chosen
 * over regex/text scanning (the pattern used by `check-event-contract.ts` /
 * `check-tool-registration.ts` for simpler single-declaration targets)
 * because call-expression argument shapes are not reliably regex-scannable:
 * multi-line calls, type-position text that LOOKS like a call
 * (`spawnSync: (args...) => ...`, seen at `src/git/branch.ts:78` and
 * `src/commands/_shared/url-security.ts:21`), nested template literals, and
 * comments mentioning a callee name would all produce false positives or
 * false negatives under a hand-rolled tokenizer.
 *
 * Scope: `src/**\/*.ts`, excluding `*.test.ts`. Exactly one resolver module
 * is allowlisted (RESOLVER_ALLOWLIST below) — a single named constant, not a
 * growable exemption file. Expected match count is zero outside it.
 *
 * Usage: bun run check:bare-spawn
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

/** Forms 1/2 only. Form 3 (executable: property) is callee-independent. */
export const SPAWN_FAMILY: ReadonlySet<string> = new Set([
	'spawnSync',
	'spawn',
	'execFile',
	'execFileSync',
	'exec',
	'bunSpawn',
	'runExternalTool',
]);

export const FLAGGED_EXECUTABLES: ReadonlySet<string> = new Set([
	'git',
	'gh',
	'sandbox-exec',
	'bwrap',
]);

/**
 * The single resolver module permitted to spawn these bare names directly —
 * it IS the resolver (issue #2236, sibling lane). A single named constant,
 * not a growable exemption file: adding a second path here requires editing
 * this comment, which is the point. Paths are repo-relative, `/`-separated.
 * Existence is NOT asserted (unlike `check-gate-portability.ts`'s stale-
 * baseline arm) because this module is mid-creation by a sibling lane at the
 * time this gate is authored; asserting existence here would make an
 * unrelated lane's sequencing block this one's CI wiring.
 */
export const RESOLVER_ALLOWLIST: readonly string[] = [
	'src/utils/git-executable.ts',
];

export type ViolationForm =
	| 'first-arg'
	| 'array-first-element'
	| 'executable-property';

export interface BareSpawnViolation {
	file: string;
	line: number;
	form: ViolationForm;
	executable: string;
	snippet: string;
}

function calleeName(expr: ts.LeftHandSideExpression): string | undefined {
	if (ts.isIdentifier(expr)) return expr.text;
	if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
	return undefined;
}

function isExecutableProperty(prop: ts.ObjectLiteralElementLike): boolean {
	if (!ts.isPropertyAssignment(prop)) return false;
	if (ts.isIdentifier(prop.name)) return prop.name.text === 'executable';
	if (ts.isStringLiteral(prop.name)) return prop.name.text === 'executable';
	return false;
}

/**
 * Pure AST scan of one file's source text. No filesystem access — directly
 * unit-testable with fixture strings, deterministic regardless of sibling
 * lanes' refactor progress.
 */
export function scanSourceForBareSpawn(
	relPath: string,
	source: string,
): BareSpawnViolation[] {
	const sf = ts.createSourceFile(
		relPath,
		source,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);
	const sourceLines = source.split('\n');
	const violations: BareSpawnViolation[] = [];

	function lineOf(pos: number): number {
		return sf.getLineAndCharacterOfPosition(pos).line + 1;
	}
	function snippetAt(pos: number): string {
		return (sourceLines[lineOf(pos) - 1] ?? '').trim();
	}

	function visit(node: ts.Node): void {
		if (ts.isCallExpression(node)) {
			const name = calleeName(node.expression);
			const args = node.arguments;

			// Forms 1/2: callee-restricted.
			if (name !== undefined && SPAWN_FAMILY.has(name) && args.length > 0) {
				const first = args[0];
				if (
					first &&
					ts.isStringLiteralLike(first) &&
					FLAGGED_EXECUTABLES.has(first.text)
				) {
					violations.push({
						file: relPath,
						line: lineOf(first.getStart(sf)),
						form: 'first-arg',
						executable: first.text,
						snippet: snippetAt(first.getStart(sf)),
					});
				} else if (
					first &&
					ts.isArrayLiteralExpression(first) &&
					first.elements.length > 0
				) {
					const el = first.elements[0];
					if (
						el &&
						ts.isStringLiteralLike(el) &&
						FLAGGED_EXECUTABLES.has(el.text)
					) {
						violations.push({
							file: relPath,
							line: lineOf(el.getStart(sf)),
							form: 'array-first-element',
							executable: el.text,
							snippet: snippetAt(el.getStart(sf)),
						});
					}
				}
			}

			// Form 3: callee-independent — see the DEVIATION note atop this file.
			for (const arg of args) {
				if (!ts.isObjectLiteralExpression(arg)) continue;
				for (const prop of arg.properties) {
					if (!isExecutableProperty(prop)) continue;
					const init = (prop as ts.PropertyAssignment).initializer;
					if (ts.isStringLiteralLike(init) && FLAGGED_EXECUTABLES.has(init.text)) {
						violations.push({
							file: relPath,
							line: lineOf(init.getStart(sf)),
							form: 'executable-property',
							executable: init.text,
							snippet: snippetAt(init.getStart(sf)),
						});
					}
				}
			}
		}
		ts.forEachChild(node, visit);
	}

	visit(sf);
	return violations;
}

/**
 * `_internals` DI seam (AGENTS.md invariant 7, mirroring
 * `check-event-contract.ts`'s FB-011 lesson): extracting `scanSourceForBareSpawn`
 * makes its CONDITIONS testable but leaves the per-file loop's CALL SITE
 * unprotected unless the loop goes through this seam. A test stubs
 * `_internals.scanSourceForBareSpawn` and asserts it is invoked once per
 * scanned file, so disconnecting the loop from the scanner is a red test
 * rather than a silent green.
 */
export const _internals = { scanSourceForBareSpawn };

/** Recursively yield every `.ts` file under `dir`, sorted for determinism. */
function* walkTsFiles(dir: string): Generator<string> {
	let entries: fs.Dirent[];
	try {
		entries = fs
			.readdirSync(dir, { withFileTypes: true })
			.sort((a, b) => a.name.localeCompare(b.name));
	} catch {
		return;
	}
	for (const entry of entries) {
		if (entry.name === 'node_modules' || entry.name === 'dist') continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			yield* walkTsFiles(full);
		} else if (entry.isFile() && entry.name.endsWith('.ts')) {
			yield full;
		}
	}
}

export interface CollectResult {
	errors: string[];
	scannedFiles: number;
	skippedAllowlisted: number;
}

function formatViolation(v: BareSpawnViolation): string {
	const formLabel =
		v.form === 'first-arg'
			? 'first positional argument'
			: v.form === 'array-first-element'
				? 'first element of the first-argument array literal'
				: '"executable:" property of an options object literal';
	return (
		`${v.file}:${v.line}: bare-name spawn of '${v.executable}' as the ${formLabel}. ` +
		`Route through ${RESOLVER_ALLOWLIST[0]}'s resolver instead of spawning a bare name. ` +
		`Line: ${v.snippet}`
	);
}

/**
 * Pure collector: scans `src/**\/*.ts` (excluding `*.test.ts` and the
 * resolver allowlist) for bare-name spawn call sites. Injectable root so
 * tests can point it at a fixture directory instead of the live repo.
 */
export function collectBareSpawnErrors(root: string = REPO_ROOT): CollectResult {
	const srcDir = path.join(root, 'src');
	const errors: string[] = [];
	let scannedFiles = 0;
	let skippedAllowlisted = 0;

	for (const file of walkTsFiles(srcDir)) {
		if (file.endsWith('.test.ts')) continue;
		const rel = path.relative(root, file).replace(/\\/g, '/');
		if (RESOLVER_ALLOWLIST.includes(rel)) {
			skippedAllowlisted++;
			continue;
		}
		scannedFiles++;
		const source = fs.readFileSync(file, 'utf-8');
		const violations = _internals.scanSourceForBareSpawn(rel, source);
		for (const v of violations) errors.push(formatViolation(v));
	}

	return { errors, scannedFiles, skippedAllowlisted };
}

export function main(root: string = REPO_ROOT): number {
	const result = collectBareSpawnErrors(root);
	console.log(
		`Scanned ${result.scannedFiles} file(s) under src/ (${result.skippedAllowlisted} allowlisted).`,
	);
	if (result.errors.length > 0) {
		console.error('\nBare-executable-spawn check FAILED:\n');
		for (const e of result.errors) console.error(`  - ${e}`);
		console.error(
			`\n${result.errors.length} violation(s). Every call to ` +
				`${[...SPAWN_FAMILY].join(', ')} (or any call passing an ` +
				`"executable:" options property) must not spawn a bare ` +
				`${[...FLAGGED_EXECUTABLES].join('/')} literal outside ` +
				`${RESOLVER_ALLOWLIST[0]}. Resolve the executable to an absolute path first.`,
		);
		return 1;
	}
	console.log(
		'Bare-executable-spawn check passed: no bare {git, gh, sandbox-exec, bwrap} ' +
			`spawn call sites outside ${RESOLVER_ALLOWLIST[0]}.`,
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
