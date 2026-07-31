/**
 * Recurrence guardrail for issue #1927 (and the #1896/#1905 class).
 *
 * Defect class: an opt-in / production `client.session.prompt(...)` model-dispatch
 * site that calls the provider directly without wrapping the call in
 * `dispatchWithModelFallback`, so a quota/rate-limit error fails the stage
 * instead of failing over to the role's configured `fallback_models` chain.
 *
 * This test enumerates every production `.session.prompt(` dispatch site under
 * `src/` and asserts each one either (a) also references
 * `dispatchWithModelFallback` (it is failover-wrapped), or (b) is on an explicit
 * allowlist with a recorded reason. A NEW dispatch site added without failover
 * and without an allowlist entry fails this test — catching the silent return of
 * the class by machinery rather than vigilance.
 *
 * When a genuinely same-model-only or no-role dispatch site is added, add it to
 * ALLOWLIST below WITH a reason. Do not add a site here to silence a real gap:
 * the correct fix for an opt-in role dispatch is to wrap it in failover.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const SRC_DIR = join(REPO_ROOT, 'src');

const SESSION_PROMPT_RE = /\.session\.prompt\(/;
// A site "does model failover" if it resolves the fallback chain via
// `resolveFallbackModel` — the shared resolver used by BOTH failover
// primitives: `dispatchWithModelFallback` (reviewer/runner/auto-review/
// integration/curator/skill-improver) and the inline fallback-advancer loop
// (full-auto oversight sites). Either marker counts as wired.
const FAILOVER_MARKERS = ['dispatchWithModelFallback', 'resolveFallbackModel'];

/**
 * Sites that intentionally dispatch without model failover. Each entry MUST
 * carry a reason. Keyed by the src-relative path (posix separators).
 */
const ALLOWLIST: Record<string, string> = {
	// The failover helper itself — only a doc comment mentions session.prompt.
	'src/utils/model-dispatch-fallback.ts':
		'the failover helper; no direct dispatch (doc comment only)',
	// Issue #1927 "out of scope (already handled)": benchmark dispatch is
	// intentionally same-model-retry-only to preserve benchmark attribution.
	'src/evaluation/model-dispatcher.ts':
		'#1927 out-of-scope: same-model-retry-only to preserve benchmark attribution',
	// Shared low-level primitive: callers pass an already-resolved model and own
	// fallback policy. Review callers wrap it with dispatchWithModelFallback;
	// evaluation callers intentionally use bounded same-model retry.
	'src/evaluation/ephemeral-agent-dispatcher.ts':
		'policy-free primitive: callers own fallback or same-model retry policy',
	// Issue #1927 "out of scope": generateMutants dispatches with agent:undefined
	// (no role/chain), so resolveFallbackModel cannot resolve a target; the
	// existing graceful `return []` is the correct opt-in-tool behavior.
	'src/mutation/generator.ts':
		'#1927 out-of-scope: agent:undefined, no role/chain; graceful return [] is correct',
};

function listSourceFiles(): string[] {
	const entries = readdirSync(SRC_DIR, { recursive: true }) as string[];
	return entries
		.filter((rel) => rel.endsWith('.ts'))
		.filter((rel) => !rel.endsWith('.test.ts') && !rel.endsWith('.spec.ts'))
		.map((rel) => `src/${rel.split('\\').join('/')}`);
}

/** True when a file's contents represent an unwired dispatch site. */
function isUnwiredDispatch(relPath: string, contents: string): boolean {
	if (!SESSION_PROMPT_RE.test(contents)) return false; // not a dispatch site
	if (FAILOVER_MARKERS.some((m) => contents.includes(m))) return false; // wired
	if (relPath in ALLOWLIST) return false; // explicitly allowlisted
	return true;
}

describe('model-dispatch failover coverage (#1927 recurrence guardrail)', () => {
	test('every production client.session.prompt site is failover-wrapped or allowlisted', () => {
		const unwired: string[] = [];
		for (const rel of listSourceFiles()) {
			const contents = readFileSync(join(REPO_ROOT, rel), 'utf-8');
			if (isUnwiredDispatch(rel, contents)) unwired.push(rel);
		}
		expect(
			unwired,
			`Unwired model-dispatch site(s) found — wrap the client.session.prompt call in ` +
				`dispatchWithModelFallback (see src/hooks/curator-llm-factory.ts) or, if the site ` +
				`is genuinely same-model-only / has no role chain, add it to ALLOWLIST with a reason:\n` +
				unwired.join('\n'),
		).toEqual([]);
	});

	test('the two #1927 target sites are wired for failover (positive coverage)', () => {
		for (const rel of [
			'src/hooks/curator-llm-factory.ts',
			'src/hooks/skill-improver-llm-factory.ts',
		]) {
			const contents = readFileSync(join(REPO_ROOT, rel), 'utf-8');
			expect(SESSION_PROMPT_RE.test(contents)).toBe(true);
			expect(contents.includes('dispatchWithModelFallback')).toBe(true);
			expect(isUnwiredDispatch(rel, contents)).toBe(false);
		}
	});

	test('the guardrail bites: a synthetic unwired dispatch site is flagged', () => {
		// Prove the detector catches the class: a file that dispatches via
		// client.session.prompt but neither wraps failover nor is allowlisted.
		const synthetic =
			'export async function dispatchThing(client) {\n' +
			'  return client.session.prompt({ body: { agent, parts } });\n' +
			'}\n';
		expect(isUnwiredDispatch('src/fake/new-dispatch.ts', synthetic)).toBe(true);
		// And it does NOT flag the same site once failover is added...
		expect(
			isUnwiredDispatch(
				'src/fake/new-dispatch.ts',
				`${synthetic}// uses ${FAILOVER_MARKERS[0]}`,
			),
		).toBe(false);
		// ...nor when it is explicitly allowlisted.
		expect(
			isUnwiredDispatch('src/utils/model-dispatch-fallback.ts', synthetic),
		).toBe(false);
	});
});
