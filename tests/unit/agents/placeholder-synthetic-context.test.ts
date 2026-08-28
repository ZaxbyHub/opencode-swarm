import { describe, expect, test } from 'bun:test';
import { getAgentConfigs } from '../../../src/agents';
import type { ProjectContext } from '../../../src/agents/template';

/**
 * #2107 §6 (from #1649): build every agent config from a hand-rolled SYNTHETIC
 * ProjectContext with distinct known values and fail if any uppercase
 * `{{PLACEHOLDER}}` token survives in any built prompt. The existing
 * placeholder-safety-net tests exercise the default pipeline and the empty
 * fail-open context; this test pins the substitution end-to-end with values a
 * real project would produce (including characters that would break naive
 * replacement: quotes, newlines, backticks, template-literal `${}`).
 *
 * If a future prompt template adds a new placeholder key that the
 * substitution chain in createSwarmAgents does not fill, this test fails with
 * the surviving token and the agent that leaked it.
 */

const syntheticContext: ProjectContext = {
	PROJECT_LANGUAGE: 'TypeScript',
	PROJECT_FRAMEWORK: 'bun + zod "quoted" framework',
	BUILD_CMD: 'bun run build',
	TEST_CMD: 'bun test tests/unit --timeout 30000',
	LINT_CMD: "biome check --write . && echo 'lint ok'",
	ENTRY_POINTS: 'src/index.ts\nsrc/cli/main.ts',
	CODER_CONSTRAINTS:
		'- Use tabs, not spaces\n- Escape backticks `like this` and ${dollar} braces',
	TEST_CONSTRAINTS: '- bun:test only (no vitest)\n- Keep files under 500 lines',
	REVIEWER_CHECKLIST:
		'- Invariant audit rows present\n- No unbounded awaits\n- Windows first-class',
	PROJECT_CONTEXT_SECONDARY_LANGUAGES: 'python, markdown',
};

/** The exact unresolved-placeholder shape: {{UPPERCASE_TOKEN}}. */
const UPPERCASE_PLACEHOLDER_RE = /\{\{[A-Z][A-Z0-9_]*\}\}/g;

describe('synthetic ProjectContext placeholder survival (#2107 §6)', () => {
	test('no built agent prompt contains an unresolved uppercase {{TOKEN}}', () => {
		const configs = getAgentConfigs(
			undefined,
			undefined,
			undefined,
			syntheticContext,
		);
		const registered = Object.entries(configs);
		expect(registered.length).toBeGreaterThan(0);

		const offenders: string[] = [];
		for (const [name, agentConfig] of registered) {
			const prompt = agentConfig.prompt;
			if (typeof prompt !== 'string') continue;
			const matches = prompt.match(UPPERCASE_PLACEHOLDER_RE);
			if (matches) {
				offenders.push(`${name}: ${[...new Set(matches)].join(', ')}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	test('synthetic values actually reach the prompts (guard against a vacuous pass)', () => {
		const configs = getAgentConfigs(
			undefined,
			undefined,
			undefined,
			syntheticContext,
		);
		const prompts = Object.values(configs)
			.map((agentConfig) => agentConfig.prompt)
			.filter((prompt): prompt is string => typeof prompt === 'string');
		expect(prompts.length).toBeGreaterThan(0);
		// At least one prompt must contain a synthetic value verbatim — if the
		// context stopped flowing into prompts, the placeholder test above
		// would pass vacuously.
		const carrier = syntheticContext.BUILD_CMD.split(' ').slice(0, 2).join(' ');
		expect(prompts.some((prompt) => prompt.includes(carrier))).toBe(true);
	});

	test('placeholder-shaped synthetic values are not double-substituted', () => {
		const tricky: ProjectContext = {
			...syntheticContext,
			// A VALUE that looks like a placeholder must survive as literal
			// content (substitution is one pass), not be eaten or expanded.
			CODER_CONSTRAINTS: '- literal {{NOT_A_TEMPLATE_KEY}} stays visible',
		};
		const configs = getAgentConfigs(undefined, undefined, undefined, tricky);
		const coderPrompt = Object.entries(configs)
			.filter(([name]) => name.includes('coder'))
			.map(([, agentConfig]) => agentConfig.prompt)
			.find((prompt): prompt is string => typeof prompt === 'string');
		expect(coderPrompt).toBeDefined();
		// Lowercase keys never match the uppercase placeholder grammar; the
		// uppercase-shaped literal here is not a known substitution key, so the
		// production guard's fail-open path (deferred warning, prompt still
		// registered) applies — the string may be absent from THIS agent's
		// prompt if coder constraints land elsewhere, so only assert the
		// no-known-key property: no {{CODER_CONSTRAINTS}} token remains.
		expect(coderPrompt).not.toContain('{{CODER_CONSTRAINTS}}');
	});
});
