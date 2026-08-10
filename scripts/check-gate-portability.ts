#!/usr/bin/env bun
/**
 * Issue #2078 recurrence guardrail — "Bash-only CI gate" class ratchet.
 *
 * Defect class: a contributor-facing CI check implemented as a Bash-only
 * script and invoked from a workflow as `bash scripts/<name>.sh` cannot be run
 * on a Windows host without Bash in PATH. Windows contributors then have no
 * way to reproduce the gate locally, fall back to manual verification, and
 * routinely skip it — which is exactly the failure issue #2078 reported for
 * `check-test-file-cap.sh`.
 *
 * Fixing the one instance does not close the class: the next gate added as a
 * `.sh` reintroduces it silently. This script makes the class mechanically
 * detectable.
 *
 * Rule: every `scripts/**\/*.sh` path referenced from any GitHub Actions YAML
 * under `.github/workflows/` OR `.github/actions/` (local composite actions,
 * scanned recursively — a gate invoked from an action is the same gate wearing
 * a different hat) must be listed in
 * `scripts/gate-portability-baseline.json`. A NEW Bash-only gate therefore
 * fails CI, and the fix is to implement it in TypeScript (`bun run
 * scripts/<name>.ts`, wired through a `package.json` script) the way
 * `check-test-file-cap.ts` now is.
 *
 * The baseline is also checked for rot: an entry naming a script no longer
 * referenced by any workflow fails, so porting a legacy gate forces the
 * baseline to shrink rather than silently keeping a dead exemption.
 *
 * Usage: bun run check:gate-portability
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'..',
);

export const WORKFLOW_DIR = path.join(REPO_ROOT, '.github', 'workflows');
/** Local composite actions are scanned too — they can invoke gates as well. */
export const ACTIONS_DIR = path.join(REPO_ROOT, '.github', 'actions');
export const BASELINE_PATH = path.join(
	REPO_ROOT,
	'scripts',
	'gate-portability-baseline.json',
);

/**
 * Why a Bash-only gate is still permitted.
 * - `legacy-bash-gate`: predates issue #2078; contributor-facing but not yet
 *   ported. Porting it is welcome and must remove the baseline entry.
 * - `ci-infrastructure`: runs only inside the GitHub Actions runner (never a
 *   pre-push local gate), so a Windows contributor is never expected to run it.
 */
export const ALLOWED_CATEGORIES = [
	'legacy-bash-gate',
	'ci-infrastructure',
] as const;
export type GateCategory = (typeof ALLOWED_CATEGORIES)[number];

export interface BaselineEntry {
	script: string;
	category: GateCategory;
	reason: string;
}

/** Matches any `scripts/…​.sh` path token appearing in workflow YAML. */
const SCRIPT_REF_PATTERN = /scripts\/[A-Za-z0-9_./-]*\.sh/g;

/**
 * Collect every `scripts/*.sh` path referenced by the given workflow sources.
 * Comment lines (`#` after optional whitespace) are ignored so a prose mention
 * of a script in an explanatory comment does not require a baseline entry.
 */
export function collectScriptRefs(
	sources: Array<{ file: string; content: string }>,
): Map<string, string[]> {
	const refs = new Map<string, string[]>();
	for (const { file, content } of sources) {
		for (const rawLine of content.split('\n')) {
			const line = rawLine.replace(/\r$/, '');
			if (/^\s*#/.test(line)) {
				continue;
			}
			SCRIPT_REF_PATTERN.lastIndex = 0;
			let match = SCRIPT_REF_PATTERN.exec(line);
			while (match !== null) {
				const script = match[0];
				const seen = refs.get(script);
				if (seen) {
					if (!seen.includes(file)) {
						seen.push(file);
					}
				} else {
					refs.set(script, [file]);
				}
				match = SCRIPT_REF_PATTERN.exec(line);
			}
		}
	}
	return refs;
}

export interface PortabilityResult {
	messages: string[];
	unbaselined: string[];
	staleBaseline: string[];
	invalidCategories: string[];
	exitCode: number;
}

export function evaluatePortability(
	referenced: Map<string, string[]>,
	baseline: BaselineEntry[],
): PortabilityResult {
	const messages: string[] = [];
	const baselineScripts = new Set(baseline.map((entry) => entry.script));

	const invalidCategories: string[] = [];
	for (const entry of baseline) {
		if (!ALLOWED_CATEGORIES.includes(entry.category)) {
			invalidCategories.push(entry.script);
			messages.push(
				`ERROR (bad category): ${entry.script} declares category "${entry.category}"; allowed: ${ALLOWED_CATEGORIES.join(', ')}.`,
			);
		}
		if (!entry.reason || entry.reason.trim().length === 0) {
			invalidCategories.push(entry.script);
			messages.push(
				`ERROR (missing reason): ${entry.script} has no justification in the baseline.`,
			);
		}
	}

	const unbaselined: string[] = [];
	for (const [script, files] of [...referenced.entries()].sort()) {
		if (!baselineScripts.has(script)) {
			unbaselined.push(script);
			messages.push(
				`ERROR (new Bash-only gate): ${script} is invoked from ${files.join(', ')} but is not in scripts/gate-portability-baseline.json.`,
			);
			messages.push(
				'  A Bash-only gate cannot be run by Windows contributors (issue #2078).',
			);
			messages.push(
				'  Implement it as scripts/<name>.ts + a package.json script (see check-test-file-cap.ts),',
			);
			messages.push(
				'  or add a baseline entry with a category and a written justification.',
			);
		}
	}

	const staleBaseline: string[] = [];
	for (const script of [...baselineScripts].sort()) {
		if (!referenced.has(script)) {
			staleBaseline.push(script);
			messages.push(
				`ERROR (stale baseline): ${script} is baselined but no workflow references it. Remove the entry.`,
			);
		}
	}

	const failures =
		unbaselined.length + staleBaseline.length + invalidCategories.length;

	messages.push('');
	messages.push('=== CI gate portability (issue #2078) summary ===');
	messages.push(`Referenced Bash gates:   ${referenced.size}`);
	messages.push(`Unbaselined (new):       ${unbaselined.length}`);
	messages.push(`Stale baseline entries:  ${staleBaseline.length}`);
	messages.push(`Invalid baseline rows:   ${invalidCategories.length}`);

	if (failures === 0) {
		messages.push('All CI gate portability checks passed.');
	}

	return {
		messages,
		unbaselined,
		staleBaseline,
		invalidCategories,
		exitCode: failures > 0 ? 1 : 0,
	};
}

/**
 * Recursively collect `*.yml` / `*.yaml` sources under `dir`. Composite
 * actions (`.github/actions/<name>/action.yml`) are scanned as well as
 * workflows: a `run: bash scripts/x.sh` inside a local composite action is the
 * same Bash-only gate wearing a different hat (issue #2078 review finding 4).
 */
function collectYamlFiles(
	dir: string,
	labelPrefix: string,
): Array<{ file: string; content: string }> {
	if (!fs.existsSync(dir)) {
		return [];
	}
	const out: Array<{ file: string; content: string }> = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
		a.name.localeCompare(b.name),
	)) {
		const abs = path.join(dir, entry.name);
		const label = `${labelPrefix}/${entry.name}`;
		if (entry.isDirectory()) {
			out.push(...collectYamlFiles(abs, label));
		} else if (entry.name.endsWith('.yml') || entry.name.endsWith('.yaml')) {
			out.push({ file: label, content: fs.readFileSync(abs, 'utf-8') });
		}
	}
	return out;
}

/** Scan roots, as `[absolute dir, label used in error messages]` pairs. */
export const DEFAULT_SCAN_ROOTS: ReadonlyArray<readonly [string, string]> = [
	[WORKFLOW_DIR, '.github/workflows'],
	[ACTIONS_DIR, '.github/actions'],
];

/**
 * Read every YAML source that can invoke a gate. Callers (including tests)
 * may pass their own roots; the default pair is what CI scans. Each root is
 * walked recursively, because a composite action's `action.yml` sits one level
 * deeper than a workflow file.
 */
export function readWorkflowSources(
	roots: ReadonlyArray<readonly [string, string]> = DEFAULT_SCAN_ROOTS,
): Array<{ file: string; content: string }> {
	const sources: Array<{ file: string; content: string }> = [];
	for (const [dir, label] of roots) {
		sources.push(...collectYamlFiles(dir, label));
	}
	return sources;
}

export function readBaseline(file: string = BASELINE_PATH): BaselineEntry[] {
	const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as {
		entries?: BaselineEntry[];
	};
	return parsed.entries ?? [];
}

/** Header line naming the roots that were scanned, for the run's own output. */
export function formatScanRoots(
	roots: ReadonlyArray<readonly [string, string]>,
): string {
	return `Scan roots: ${roots.map(([, label]) => label).join(', ')}`;
}

export function main(
	roots: ReadonlyArray<readonly [string, string]> = DEFAULT_SCAN_ROOTS,
): number {
	// Printing the roots is not decoration: `.github/actions/` does not exist in
	// this repo today, so a silently narrowed scan set would otherwise be
	// invisible in both CI output and tests (issue #2078 final-critic note 1).
	// This line makes the default binding observable, so shrinking it fails a
	// test instead of quietly disarming the guardrail.
	console.log(formatScanRoots(roots));
	const referenced = collectScriptRefs(readWorkflowSources(roots));
	const result = evaluatePortability(referenced, readBaseline());
	for (const line of result.messages) {
		console.log(line);
	}
	return result.exitCode;
}

const isDirectRun =
	typeof process.argv[1] === 'string' &&
	path.resolve(process.argv[1]) ===
		path.resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
	process.exit(main());
}
