/**
 * Agent prompt template helpers.
 *
 * `{{KEY}}` placeholders in agent prompt strings are substituted with values
 * from a `ProjectContext` resolved at session-init time by the hand-rolled
 * `.replace()` chains in `src/agents/index.ts` (Chain B) and
 * `src/agents/architect.ts` (Chain A). `assertNoUnresolvedPlaceholders` is the
 * post-substitution safety net that guarantees a typo never leaks a raw
 * `{{KEY}}` to the model — it runs over each agent's FINAL prompt at the
 * pinned call site `src/index.ts:initializeOpenCodeSwarm` immediately before
 * `getAgentConfigs(...)` (see the `withTimeout(2000ms)` wrapping there to
 * honor invariant 1 — plugin init bounded + fail-open).
 *
 * Phase 4b of language-agnostic plugin work.
 */

/**
 * Variables available for substitution into agent prompts. Every prompt's
 * `{{KEY}}` placeholders must be a key of this interface. New variables go
 * here AND in `buildProjectContext` in `src/index.ts`.
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
export const UNRESOLVED = 'unresolved (run /swarm preflight)';

/** Empty `ProjectContext` — used by fail-open paths and tests. */
export function emptyProjectContext(): ProjectContext {
	return {
		PROJECT_LANGUAGE: UNRESOLVED,
		PROJECT_FRAMEWORK: UNRESOLVED,
		BUILD_CMD: UNRESOLVED,
		TEST_CMD: UNRESOLVED,
		LINT_CMD: UNRESOLVED,
		ENTRY_POINTS: UNRESOLVED,
		CODER_CONSTRAINTS: '',
		TEST_CONSTRAINTS: '',
		REVIEWER_CHECKLIST: '',
		PROJECT_CONTEXT_SECONDARY_LANGUAGES: '',
	};
}

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
export function escapeForTemplate(s: string): string {
	return s.replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}

/**
 * Post-substitution safety net for the hand-rolled `.replace()` chains that
 * assemble each agent's FINAL system prompt (Chain A in
 * `src/agents/architect.ts` and Chain B in `src/agents/index.ts`). Neither
 * chain validated for leftover placeholders, so a renamed, mistyped, or
 * newly-added `{{KEY}}` could leak raw template text straight to the model
 * with no error. This asserts — over the fully-substituted prompt — that no
 * `{{KEY}}` survived, applied at the reachable production call site (see
 * `src/agents/index.ts`, immediately before `getAgentConfigs`).
 *
 * The scan uses the character class `[A-Z_]+`. It MUST NOT be broadened to
 * `[^}]+`, `.*?`, or similar: `src/agents/architect.ts` contains a literal
 * `` `{{...}}` `` in instructional prose (teaching the architect what an
 * unresolved field looks like). The dots in `...` are not in `[A-Z_]`, so this
 * guard never matches that prose. A broader class WOULD match it and
 * false-throw during agent init. The trailing `g` flag only enumerates every
 * offender for the error message; it does not widen what counts as a
 * placeholder.
 *
 * @throws if any `{{KEY}}` placeholder remains, naming the offending key(s)
 *   and the agent whose prompt they were found in.
 */
export function assertNoUnresolvedPlaceholders(
	prompt: string,
	agentName: string,
): void {
	const placeholderRegex = /\{\{[A-Z_]+\}\}/g;
	const leftover = [...new Set(prompt.match(placeholderRegex) ?? [])];
	if (leftover.length > 0) {
		throw new Error(
			`assertNoUnresolvedPlaceholders: unresolved placeholder(s) ` +
				`${leftover.join(', ')} in the "${agentName}" agent prompt. A ` +
				'substitution chain (Chain A in src/agents/architect.ts or Chain B ' +
				'in src/agents/index.ts) failed to replace it, or a placeholder was ' +
				'added without a matching substitution. Add the substitution or fix ' +
				'the typo in the prompt.',
		);
	}
}

/**
 * Convert an array of constraint strings into a bulleted block ready for
 * inclusion in an agent prompt via `{{CODER_CONSTRAINTS}}` etc.
 * Each item is escaped for template-literal safety.
 */
export function bulletList(items: readonly string[]): string {
	if (items.length === 0) return '';
	return items.map((s) => `- ${escapeForTemplate(s)}`).join('\n');
}
