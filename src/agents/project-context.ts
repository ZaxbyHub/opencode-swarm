/**
 * Build a `ProjectContext` for agent prompt template substitution.
 *
 * Called from `src/index.ts:initializeOpenCodeSwarm` immediately before
 * `getAgentConfigs(...)` (Phase 4b of the language-agnostic plugin work).
 * Wrapped in `withTimeout(2000ms)` by the caller; on timeout or any
 * failure, the caller falls open to `emptyProjectContext()` per
 * Invariant 1 (plugin init bounded + fail-open).
 *
 * Imported lazily by the caller via `await import('./agents/project-context')`
 * to keep the dispatch import graph off the synchronous init prelude.
 *
 * Invariant 1 budget — Phase 4b NOTE:
 * This module DOES NOT spawn subprocesses on the session-init critical
 * path. The full `LanguageBackend.selectTestFramework` /
 * `selectBuildCommand` hooks call `isCommandAvailable` (which spawns
 * `where`/`which` and can take 200–500ms per call on Windows). Even with
 * the 2000ms `withTimeout` wrapper, multiple sequential spawns
 * (typically 3–5 per buildProjectContext call) easily push `server()`
 * past the 400ms Invariant 1 deadline asserted by
 * `scripts/repro-704.mjs:TIMING_DEADLINE_MS`.
 *
 * The architect prompt's `TEST_CMD` / `BUILD_CMD` / `LINT_CMD` values are
 * HINTS for the LLM. If the user doesn't have the named binary installed,
 * the actual test-runner / build-runner tool will surface a clear error
 * at invocation time — there is no correctness regression from skipping
 * the PATH probe at session init.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { LanguageBackend } from '../lang/backend';
import { pickBackend, pickedProfiles } from '../lang/dispatch';
import {
	bulletList,
	emptyProjectContext,
	type ProjectContext,
	UNRESOLVED,
} from './template';

/**
 * Wall-clock budget for the session-init language-backend resolution step.
 * Caller (`src/index.ts:initializeOpenCodeSwarm`) wraps `buildProjectContext`
 * in `withTimeout(LANG_BACKEND_DETECTION_TIMEOUT_MS)`. Exceeding the budget
 * fails open with `null` so the manifest still returns to the OpenCode
 * plugin host (Invariant 1).
 */
export const LANG_BACKEND_DETECTION_TIMEOUT_MS = 300;

const _internals: {
	pickBackend: typeof pickBackend;
	pickedProfiles: typeof pickedProfiles;
} = {
	pickBackend,
	pickedProfiles,
};
export { _internals };

/**
 * Probe whether a detect pattern matches a file in `directory`. Honors
 * simple `*.ext` and `?` globs so lint entries whose detect is e.g.
 * `*.csproj` resolve correctly. Same shape as
 * `default-backend.ts:detectFileExists` — duplicated here to avoid the
 * circular import and to keep the session-init path independent of the
 * spawn-bearing default-backend module.
 */
function detectFileExists(directory: string, pattern: string): boolean {
	if (pattern.includes('*') || pattern.includes('?')) {
		try {
			const files = fs.readdirSync(directory);
			const regex = new RegExp(
				`^${pattern.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.')}$`,
			);
			return files.some((f) => regex.test(f));
		} catch {
			return false;
		}
	}
	try {
		fs.accessSync(path.join(directory, pattern));
		return true;
	} catch {
		return false;
	}
}

/**
 * Heuristic for JS/TS projects: honor `package.json#scripts.test` as a
 * strong signal that overrides config-file probing. Pre-Phase-4b the
 * legacy detector and the TypeScript backend's `selectTestFramework`
 * both read scripts.test first; that smarts must persist in the
 * spawn-free fast path used at session init. Returns the matching
 * profile framework's `cmd` when scripts.test resolves to a known
 * runner. Reads package.json synchronously (no spawn).
 */
function selectTestCommandFromScriptsTest(
	backend: LanguageBackend,
	directory: string,
): string | null {
	let pkgRaw: string;
	try {
		pkgRaw = fs.readFileSync(path.join(directory, 'package.json'), 'utf-8');
	} catch {
		return null;
	}
	let pkg: { scripts?: { test?: string } };
	try {
		pkg = JSON.parse(pkgRaw);
	} catch {
		return null;
	}
	const script = pkg.scripts?.test;
	if (!script) return null;
	let fwName: string | null = null;
	if (script.includes('vitest')) fwName = 'vitest';
	else if (script.includes('jest')) fwName = 'jest';
	else if (script.includes('mocha')) fwName = 'mocha';
	else if (script.includes('bun test')) fwName = 'bun:test';
	if (!fwName) return null;
	const fw = backend.test.frameworks.find((f) => f.name === fwName);
	return fw ? fw.cmd : null;
}

/**
 * Pick the highest-priority test framework whose detect file is present
 * in `directory`. NO `isCommandAvailable` check — see module docstring on
 * why session-init must not spawn subprocesses. Returns the framework's
 * declared `cmd` string verbatim.
 *
 * For JS/TS projects, checks `package.json#scripts.test` first as a
 * strong signal (mirrors legacy behavior and the TypeScript backend's
 * own `selectTestFramework` flow).
 */
function selectTestCommandFast(
	backend: LanguageBackend,
	directory: string,
): string | null {
	const fromScripts = selectTestCommandFromScriptsTest(backend, directory);
	if (fromScripts !== null) return fromScripts;
	const sorted = [...backend.test.frameworks].sort(
		(a, b) => b.priority - a.priority,
	);
	for (const fw of sorted) {
		if (!detectFileExists(directory, fw.detect)) continue;
		return fw.cmd;
	}
	return null;
}

/**
 * Pick the highest-priority build command whose detect file (if specified)
 * is present. NO subprocess spawn.
 */
function selectBuildCommandFast(
	backend: LanguageBackend,
	directory: string,
): string | null {
	const sorted = [...backend.build.commands].sort(
		(a, b) => b.priority - a.priority,
	);
	for (const cmd of sorted) {
		if (cmd.detectFile && !detectFileExists(directory, cmd.detectFile)) {
			continue;
		}
		return cmd.cmd;
	}
	return null;
}

/**
 * Pick the highest-priority linter whose detect file is present. NO
 * subprocess spawn. Honors glob detect patterns per `detectFileExists`.
 */
function selectLintCommand(
	backend: LanguageBackend,
	directory: string,
): string | null {
	const sorted = [...backend.lint.linters].sort(
		(a, b) => b.priority - a.priority,
	);
	for (const lint of sorted) {
		if (!detectFileExists(directory, lint.detect)) continue;
		return lint.cmd;
	}
	return null;
}

/**
 * Resolve the `ProjectContext` for `directory`. Uses `pickBackend` to find
 * the dominant language, then queries the backend's PROFILE DATA (not its
 * spawn-bearing hooks) for build/test/lint commands. Calls the optional
 * `selectFramework` and `selectEntryPoints` hooks because those are
 * filesystem-only (no spawn) per the backend purity invariant.
 *
 * Per-backend constraint blocks (coder/test/reviewer) come from
 * `backend.prompts` — pure data.
 *
 * Returns `null` (caller substitutes `emptyProjectContext()`) when no
 * backend is detected — the architect's existing DISCOVER mode handles
 * the resulting `unresolved` sentinel placeholders.
 */
export async function buildProjectContext(
	directory: string,
): Promise<ProjectContext | null> {
	const backend = await _internals.pickBackend(directory);
	if (!backend) return null;

	const ctx: ProjectContext = emptyProjectContext();
	ctx.PROJECT_LANGUAGE = backend.displayName;

	const buildCmd = selectBuildCommandFast(backend, directory);
	if (buildCmd) ctx.BUILD_CMD = buildCmd;

	const testCmd = selectTestCommandFast(backend, directory);
	if (testCmd) ctx.TEST_CMD = testCmd;

	const lintCmd = selectLintCommand(backend, directory);
	if (lintCmd) ctx.LINT_CMD = lintCmd;

	// selectFramework / selectEntryPoints — these are filesystem-only
	// (read package.json / pyproject / go.mod) and run in parallel to
	// keep the critical path tight.
	const [frameworkSel, entryPoints] = await Promise.all([
		backend.selectFramework
			? backend.selectFramework(directory).catch(() => null)
			: Promise.resolve(null),
		backend.selectEntryPoints
			? backend.selectEntryPoints(directory).catch(() => [])
			: Promise.resolve<string[]>([]),
	]);
	if (frameworkSel) ctx.PROJECT_FRAMEWORK = frameworkSel.name;
	if (entryPoints.length > 0) ctx.ENTRY_POINTS = entryPoints.join(', ');

	// Per-language prompt blocks. Bulleted, escaped for template-literal
	// safety. Defaults to empty string (not the UNRESOLVED sentinel) when
	// the profile has no constraints, so the rendered prompt has no
	// fake-bullet noise.
	if (backend.prompts.coderConstraints.length > 0) {
		ctx.CODER_CONSTRAINTS = bulletList(backend.prompts.coderConstraints);
	}
	if (
		backend.prompts.testConstraints &&
		backend.prompts.testConstraints.length > 0
	) {
		ctx.TEST_CONSTRAINTS = bulletList(backend.prompts.testConstraints);
	}
	if (backend.prompts.reviewerChecklist.length > 0) {
		ctx.REVIEWER_CHECKLIST = bulletList(backend.prompts.reviewerChecklist);
	}

	// Secondary languages: reuse the ranked list pickBackend already cached
	// (B1 fix from PR #825 adversarial review — avoids a second
	// detectProjectLanguages call on the 300ms critical path).
	const profiles = _internals.pickedProfiles(directory);
	if (profiles.length > 1) {
		ctx.PROJECT_CONTEXT_SECONDARY_LANGUAGES = profiles
			.slice(1)
			.map((p) => p.id)
			.join(', ');
	}

	void UNRESOLVED;

	return ctx;
}
