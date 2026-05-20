/**
 * Agent prompt template renderer.
 *
 * Replaces `{{KEY}}` placeholders in agent prompt strings with values from
 * a `ProjectContext` resolved at session-init time. Strict by design:
 * unknown placeholders raise (caught at build time by
 * `tests/unit/agents/template-substitution.test.ts`), so a typo never
 * leaks to the model.
 *
 * Phase 4b of language-agnostic plugin work. Pinned call site is
 * `src/index.ts:initializeOpenCodeSwarm` immediately before
 * `getAgentConfigs(...)` — see the `withTimeout(2000ms)` wrapping there
 * to honor invariant 1 (plugin init bounded + fail-open).
 */
/**
 * Variables available for substitution into agent prompts. Every prompt's
 * `{{KEY}}` placeholders must be a key of this interface; the renderer
 * rejects unknown placeholders. New variables go here AND in
 * `buildProjectContext` in `src/index.ts`.
 */
export interface ProjectContext {
    PROJECT_LANGUAGE: string;
    PROJECT_FRAMEWORK: string;
    BUILD_CMD: string;
    TEST_CMD: string;
    LINT_CMD: string;
    ENTRY_POINTS: string;
    /**
     * Per-language coder constraint bullets (already escaped for inclusion
     * in a TypeScript template literal — see `escapeForTemplate`).
     */
    CODER_CONSTRAINTS: string;
    /** Per-language test-writing constraint bullets. */
    TEST_CONSTRAINTS: string;
    /** Per-language reviewer-checklist bullets. */
    REVIEWER_CHECKLIST: string;
    /**
     * When backend detection finds multiple equal-tier languages, this is
     * a comma-separated list of the runner-up language ids; empty string
     * when only one language is detected.
     */
    PROJECT_CONTEXT_SECONDARY_LANGUAGES: string;
}
/**
 * Sentinel substituted into placeholders when the backend cannot resolve
 * a value (no manifest, binary missing, detection timed out). The
 * architect prompt's existing DISCOVER mode handles this — same contract
 * as today, but the trigger is now a literal sentinel string rather than
 * a templating leak.
 */
export declare const UNRESOLVED = "unresolved (run /swarm preflight)";
/** Empty `ProjectContext` — used by fail-open paths and tests. */
export declare function emptyProjectContext(): ProjectContext;
/**
 * Escape a string for safe inclusion inside a TypeScript template literal.
 * Specifically:
 *   - Backticks `` ` `` become `` \` `` (otherwise terminate the literal).
 *   - `${` becomes `\${` (otherwise begins an interpolation).
 *   - Backslashes are preserved as-is (template literals don't double-escape
 *     them when read at runtime — only at parse time, which we're past).
 *
 * See `.claude/skills/engineering-conventions/SKILL.md` "Agent prompt
 * strings — escaping pitfalls" for context. Profile-author-supplied
 * constraint strings (e.g. `LanguageProfile.prompts.coderConstraints`)
 * routinely contain backticks (when describing code idioms like `bun:test`).
 * The renderer auto-escapes them so a profile author can't accidentally
 * break agent compilation.
 */
export declare function escapeForTemplate(s: string): string;
/**
 * Render `prompt` with `vars`. Replaces every `{{KEY}}` whose KEY is a
 * documented `ProjectContext` field. Unknown placeholders raise.
 *
 * The renderer is intentionally simple — single-pass, no nesting, no
 * conditionals, no loops. Agent prompts that need conditional sections
 * should pre-compute a string variable in `buildProjectContext` and
 * substitute it as a single placeholder.
 */
export declare function renderPrompt(prompt: string, vars: ProjectContext): string;
/**
 * Convert an array of constraint strings into a bulleted block ready for
 * inclusion in an agent prompt via `{{CODER_CONSTRAINTS}}` etc.
 * Each item is escaped for template-literal safety.
 */
export declare function bulletList(items: readonly string[]): string;
