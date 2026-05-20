/**
 * LanguageBackend — behavior-bearing extension of LanguageProfile.
 *
 * `LanguageProfile` (in `./profiles.ts`) is a passive data record: it
 * declares which build commands, test frameworks, linters etc. exist for a
 * language, but does not know how to run them. A `LanguageBackend` adds
 * optional behavior hooks. Every hook has a registry-driven default in
 * `./default-backend.ts`, so a backend that overrides nothing still works.
 *
 * Invariant boundaries (per AGENTS.md):
 *   - Backends NEVER spawn subprocesses. They return command-arrays only.
 *     The single spawn site stays in `src/tools/test-runner.ts` (and the
 *     existing helpers in `src/build/discovery.ts:isCommandAvailable`),
 *     each of which already satisfies invariant 3 (cwd, stdin: 'ignore',
 *     timeout, bounded stdio, killable). This rule is enforced by
 *     `tests/unit/lang/backend-purity.test.ts`.
 *   - Backends do no top-level `bun:` imports and no direct `Bun.*` calls
 *     (invariant 2 — runtime portability). Same purity test enforces this.
 *
 * Extension model: a new language is a single new file under
 * `src/lang/backends/<id>.ts` plus one import line in
 * `src/lang/backends/index.ts`. The default backend handles everything the
 * new file does not override.
 */

import type { LanguageProfile } from './profiles';

/**
 * Selected test framework for a project, including the concrete spawn argv
 * and explicit cwd. Returned by `LanguageBackend.selectTestFramework`.
 */
export interface TestFrameworkSelection {
	/** Framework id matching one of LanguageProfile.test.frameworks[*].name. */
	name: string;
	/**
	 * Spawn-arg array. Never includes shell metacharacters or relies on shell
	 * interpretation — passed directly to `bunSpawn(cmd, ...)`. Backends that
	 * cannot avoid a shell-mediated invocation (e.g. PowerShell `-EncodedCommand`)
	 * still produce an array; the array's first element is the binary and the
	 * rest are individual arguments.
	 */
	cmd: string[];
	/** Explicit cwd for the spawn (invariant 3). */
	cwd: string;
	/** Human-readable note: "package.json scripts.test", "Cargo.toml", etc. */
	detectedVia: string;
	/**
	 * When true, the `files` argument to `buildTestCommand` is ignored — the
	 * framework runs all tests in the project by default (e.g. cargo test,
	 * go test ./..., swift test). Per-file selection is the framework's
	 * concern, not the backend's.
	 */
	filesIgnored?: boolean;
}

/**
 * Structured summary of a test run. The default backend returns only
 * exit-code-driven `ok` and the raw streams; richer parsing is opt-in per
 * backend (e.g. the TypeScript backend parses bun:test JSON output).
 */
export interface TestRunSummary {
	ok: boolean;
	raw: {
		stdout: string;
		stderr: string;
		exitCode: number;
	};
	passed?: number;
	failed?: number;
	skipped?: number;
	durationMs?: number;
	/**
	 * Total tests reported by the framework. When undefined the caller may
	 * compute `passed + failed + skipped`.
	 */
	total?: number;
	/**
	 * Coverage percentage parsed from the framework's output. Optional —
	 * frameworks without a uniform coverage-line format (mocha, go-test,
	 * etc.) leave this undefined.
	 */
	coveragePercent?: number;
}

/**
 * Scope strings used by the test-runner tool. Re-exported here so backends
 * can accept them in `buildTestCommand` without a circular import back to
 * `src/tools/test-runner.ts`.
 */
export type TestScope = 'all' | 'convention' | 'graph' | 'impact';

/**
 * Options influencing build-command construction. Backends may ignore
 * unrecognized opts; the default backend honors all of these.
 */
export interface BuildTestCommandOpts {
	scope?: TestScope;
	coverage?: boolean;
}

/**
 * Selected web/UI framework for a project (PROJECT_FRAMEWORK template
 * variable). Best-effort detection — backends return null when no
 * framework signal is available, and the architect's prompt then ships
 * with the `unresolved (run /swarm preflight)` sentinel.
 */
export interface FrameworkSelection {
	/** Display name, e.g. "react", "vue", "django", "gin". */
	name: string;
	/** Human-readable note describing what evidence supports this. */
	detectedVia: string;
}

/**
 * Selected build command for a project.
 */
export interface BuildCommandSelection {
	/** Display name matching `LanguageProfile.build.commands[*].name`. */
	name: string;
	/** Spawn-arg array. Same constraints as TestFrameworkSelection.cmd. */
	cmd: string[];
	/** Explicit cwd. */
	cwd: string;
	/** Human-readable note: "Cargo.toml", "package.json#scripts.build", etc. */
	detectedVia: string;
}

/**
 * The behavior surface for a language. Every method is optional; the
 * default-backend implementation in `./default-backend.ts` provides
 * registry-driven fallbacks that work for most languages out of the box.
 */
export interface LanguageBackend extends LanguageProfile {
	/**
	 * Stronger signal than extension matching alone. Default behavior
	 * (provided by the default backend) checks that any of
	 * `profile.build.detectFiles` is present in `dir`. A backend may override
	 * to add language-specific heuristics (e.g. the TypeScript backend reads
	 * `package.json#scripts.test` to confirm a test runner is configured).
	 */
	detectProject?(dir: string): Promise<boolean>;

	/**
	 * Pick the highest-priority test framework whose detect file exists in
	 * `dir` AND whose binary is on PATH. Returns `null` if no framework is
	 * configured + available. Default behavior consults
	 * `profile.test.frameworks` sorted by priority and uses
	 * `isCommandAvailable` from `src/build/discovery.ts`.
	 */
	selectTestFramework?(dir: string): Promise<TestFrameworkSelection | null>;

	/**
	 * Build the spawn argv for a given framework + file list. Default
	 * behavior implements the full 14-framework legacy switch from
	 * `src/tools/test-runner.ts` (coverage flags, scope-dependent file
	 * inclusion, platform-specific python/python3, pester -EncodedCommand,
	 * gradle wrapper detection, ctest build-dir detection, dart/flutter
	 * selection, bundle/rspec detection, minitest require_relative).
	 * Backends with non-trivial language-specific shape override this.
	 *
	 * Returns `null` when the framework is unknown to this backend; callers
	 * (test-runner dispatch) treat that as "no test command available".
	 */
	buildTestCommand?(
		framework: string,
		files: string[],
		dir: string,
		opts?: BuildTestCommandOpts,
	): string[] | null;

	/**
	 * Parse stdout/stderr into a structured summary. Default behavior
	 * returns only `{ ok: exitCode === 0, raw: { stdout, stderr, exitCode } }`
	 * — no regex, no framework-specific assumptions. Backends that want
	 * pass/fail counts (e.g. the TypeScript backend's bun:test JSON parser)
	 * override this.
	 */
	parseTestOutput?(
		framework: string,
		stdout: string,
		stderr: string,
		exitCode: number,
	): TestRunSummary;

	/**
	 * Map a source file to candidate test files (convention scope). Default
	 * behavior: swap `src/` ↔ `tests/` and the extension to one of the
	 * profile's test-file conventions. Returns the candidate paths sorted by
	 * likelihood.
	 */
	testFilesFor?(sourceFile: string, dir: string): Promise<string[]>;

	/**
	 * Extract import paths from a source file (graph/impact scope). Default
	 * behavior: returns `[]` — the analyzer falls back to convention scope
	 * with an explicit "graph scope unavailable for {lang}" notice. Backends
	 * with import-graph support (TypeScript, Python, Go in this phase set)
	 * override this.
	 */
	extractImports?(sourceFile: string, source: string): string[];

	/**
	 * Pick the build command for this project. Default behavior consults
	 * `profile.build.commands` sorted by priority + binary-on-PATH check.
	 */
	selectBuildCommand?(dir: string): Promise<BuildCommandSelection | null>;

	/**
	 * Detect the dominant web/UI framework in this project (React, Django,
	 * Gin, etc.) for the architect's PROJECT_FRAMEWORK template variable.
	 * Returns null when no framework signal is present — the default
	 * backend's implementation looks for common framework manifest fields
	 * (package.json deps, requirements.txt entries, go.mod requires).
	 */
	selectFramework?(dir: string): Promise<FrameworkSelection | null>;

	/**
	 * Identify primary entry-point files for this project (ENTRY_POINTS
	 * template variable). Default behavior: read profile-specific manifests
	 * (package.json `main`/`bin`, pyproject `[project.scripts]`, go.mod
	 * + main.go, etc.). Returns absolute or repo-relative paths sorted by
	 * confidence. Empty list maps to the sentinel.
	 */
	selectEntryPoints?(dir: string): Promise<string[]>;
}
