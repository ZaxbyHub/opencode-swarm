/**
 * Issue #1984 — the Step 8 allowedPrefix block reason must be ACTIONABLE.
 *
 * Before the fix, a write blocked by the allowedPrefix check returned:
 *   `Path <path> not in allowed list for <agent>`
 * with zero hint about what WOULD be allowed. Non-coder write-capable agents
 * (test_engineer / docs / designer / critic) therefore could not self-correct
 * and looped on filename guessing, burning tokens.
 *
 * After the fix, the reason appends the agent's own effective positive allow
 * patterns (exact paths, prefixes, globs, and case-sensitive globs as separate
 * categories) plus a deny-precedence caveat. The original phrase is preserved so
 * legacy substring/regex assertions stay green.
 *
 * SECURITY surface verified here: the hint discloses ONLY the current agent's
 * positive permissions — never another agent's rules, blocked rules, or universal
 * deny prefixes.
 */

import { describe, expect, test } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	type AuthorityConfig,
	type GuardrailsConfig,
	GuardrailsConfigSchema,
} from '../../../src/config/schema';
import { checkFileAuthority } from '../../../src/hooks/guardrails';

const TEST_CWD = path.join(os.tmpdir(), 'issue-1984-project');

function isDenied(
	result: ReturnType<typeof checkFileAuthority>,
): result is { allowed: false; reason: string; zone?: string } {
	return !result.allowed;
}

describe('Issue #1984: actionable allowedPrefix block reason', () => {
	describe('built-in agents surface their own allow patterns', () => {
		test('test_engineer: shows prefixes, ordinary globs, AND case-sensitive globs separately', () => {
			// The exact path from the issue report. The reporter had to read plugin
			// source to learn that **/*.test.* is the matching glob.
			const result = checkFileAuthority(
				'test_engineer',
				'phpr-mcp/test-build.mjs',
				TEST_CWD,
			);
			expect(result.allowed).toBe(false);
			if (isDenied(result)) {
				expect(result.code).toBe('AUTHORITY_POLICY_DENY');
				expect(result.reason).toContain(
					'path is not in allowed list for this role.',
				);
				// Allowed prefixes from DEFAULT_AGENT_AUTHORITY_RULES.test_engineer.
				expect(result.reason).toContain(
					'Allowed prefixes: tests/, test/, .swarm/evidence/',
				);
				// The exact glob the reporter needed — proves the message is now
				// actionable without reading source.
				expect(result.reason).toContain('**/*.test.*');
				expect(result.reason).toContain('**/*.spec.*');
				// Ordinary and case-sensitive globs are SEPARATE categories (critic
				// item 2): merging would mislead an agent into wrong-case filenames
				// (e.g. contest.java matching *Test.java).
				expect(result.reason).toContain('Allowed globs:');
				expect(result.reason).toContain('Allowed case-sensitive globs:');
				expect(result.reason).toContain('*Test.java');
				// Deny-precedence caveat (critic item 4).
				expect(result.reason).toContain('still apply');
			}
		});

		test('test_engineer: the renamed (allowed) path is NOT blocked', () => {
			// Sanity: the workaround from the issue still resolves to allowed.
			const result = checkFileAuthority(
				'test_engineer',
				'phpr-mcp/test-build.test.mjs',
				TEST_CWD,
			);
			expect(result.allowed).toBe(true);
		});

		test('docs: shows its own prefixes + ordinary globs; no case-sensitive label', () => {
			const result = checkFileAuthority('docs', 'src/foo.ts', TEST_CWD);
			expect(result.allowed).toBe(false);
			if (isDenied(result)) {
				expect(result.reason).toContain(
					'Allowed prefixes: docs/, .swarm/outputs/',
				);
				expect(result.reason).toContain('**/docs/**');
				// Use a word-boundary regex so `**/*.md` is not silently satisfied by
				// `**/*.mdx`/`**/*.mdoc` sharing the same prefix (reviewer nit 1).
				expect(result.reason).toMatch(/(?:^|, )\*\*\/\*\.md(?!x|oc)/);
				// docs has no case-sensitive globs, so that category is omitted.
				expect(result.reason).not.toContain('Allowed case-sensitive globs:');
			}
		});

		test('designer: shows the same shape as docs', () => {
			const result = checkFileAuthority('designer', 'src/x.ts', TEST_CWD);
			expect(result.allowed).toBe(false);
			if (isDenied(result)) {
				expect(result.reason).toContain(
					'Allowed prefixes: docs/, .swarm/outputs/',
				);
				expect(result.reason).toMatch(/(?:^|, )\*\*\/\*\.md(?!x|oc)/);
			}
		});

		test('critic: globs render (none) when the rule has none', () => {
			// critic allowedPrefix=['.swarm/evidence/'] only, no globs.
			const result = checkFileAuthority('critic', 'src/foo.ts', TEST_CWD);
			expect(result.allowed).toBe(false);
			if (isDenied(result)) {
				expect(result.reason).toContain('Allowed prefixes: .swarm/evidence/');
				expect(result.reason).toContain('Allowed globs: (none)');
			}
		});

		test('negative: a readOnly block (Step 1) does NOT append the allowed hint', () => {
			// Reviewer nit 4: the helper is only called from the Step 8 return
			// sites. A readOnly agent is blocked at Step 1 with its own distinct
			// reason and must never receive the allowed-pattern hint.
			const result = checkFileAuthority('explorer', 'src/foo.ts', TEST_CWD);
			expect(result.allowed).toBe(false);
			if (isDenied(result)) {
				expect(result.reason).toContain('read-only');
				expect(result.reason).not.toContain('Allowed prefixes:');
				expect(result.reason).not.toContain('Allowed globs:');
			}
		});

		test('negative: an unknown agent does NOT receive the allowed hint', () => {
			// The unknown-agent guard returns before Step 8; the hint must not
			// appear (there are no resolved rules to disclose).
			const result = checkFileAuthority(
				'totally_unknown_role',
				'src/foo.ts',
				TEST_CWD,
			);
			expect(result.allowed).toBe(false);
			if (isDenied(result)) {
				expect(result.reason).toContain('Unknown agent');
				expect(result.reason).not.toContain('Allowed prefixes:');
			}
		});
	});

	describe('both Step 8 branches (non-empty and empty allowedPrefix)', () => {
		test('explicit allowedPrefix: [] with a glob renders "(none)" prefixes and the glob', () => {
			// Covers the `else if` branch at file-authority.ts where allowedPrefix
			// is an explicit empty array (deny-all-by-prefix). The glob is still the
			// actionable signal.
			const cfg: AuthorityConfig = {
				enabled: true,
				rules: {
					custom_globonly: {
						allowedPrefix: [],
						allowedGlobs: ['**/*.test.*'],
					},
				},
			};
			const result = checkFileAuthority(
				'custom_globonly',
				'src/x.txt',
				TEST_CWD,
				cfg,
			);
			expect(result.allowed).toBe(false);
			if (isDenied(result)) {
				expect(result.reason).toContain('Allowed prefixes: (none)');
				expect(result.reason).toContain('**/*.test.*');
			}
		});

		test('explicit allowedPrefix: [] with NO globs renders (none) for both', () => {
			const cfg: AuthorityConfig = {
				enabled: true,
				rules: { custom_denyall: { allowedPrefix: [] } },
			};
			const result = checkFileAuthority(
				'custom_denyall',
				'out/x.txt',
				TEST_CWD,
				cfg,
			);
			expect(result.allowed).toBe(false);
			if (isDenied(result)) {
				expect(result.reason).toContain('Allowed prefixes: (none)');
				expect(result.reason).toContain('Allowed globs: (none)');
			}
		});

		test('allowedExact renders its own category before prefixes', () => {
			// A custom rule with both allowedExact and allowedPrefix: the hint
			// must surface the exact-path compliance channel (critic item 1).
			const cfg: AuthorityConfig = {
				enabled: true,
				rules: {
					custom_exact: {
						allowedPrefix: ['src/'],
						allowedExact: ['config/secret.txt'],
					},
				},
			};
			const result = checkFileAuthority(
				'custom_exact',
				'other.txt',
				TEST_CWD,
				cfg,
			);
			expect(result.allowed).toBe(false);
			if (isDenied(result)) {
				expect(result.reason).toContain('Allowed exact paths:');
				expect(result.reason).toContain('config/secret.txt');
				expect(result.reason).toContain('Allowed prefixes: src/');
				// The exact-paths category must precede prefixes (matches the
				// DENY-first evaluation order / push order in the helper).
				// Reviewer nit 2: assert the ordering, not just presence.
				const exactIdx = result.reason.indexOf('Allowed exact paths:');
				const prefixIdx = result.reason.indexOf('Allowed prefixes:');
				expect(exactIdx).toBeGreaterThan(-1);
				expect(prefixIdx).toBeGreaterThan(-1);
				expect(exactIdx).toBeLessThan(prefixIdx);
			}
		});

		test('an agent with ONLY allowedCaseSensitiveGlobs renders just that category', () => {
			// Reviewer nit 3: lock the invariant that the case-sensitive category
			// is still emitted when it is the ONLY allow field present (helper
			// must not gate it on other categories being non-empty).
			const cfg: AuthorityConfig = {
				enabled: true,
				rules: {
					custom_cs: {
						allowedPrefix: [],
						allowedCaseSensitiveGlobs: ['*Test.java'],
					},
				},
			};
			const result = checkFileAuthority(
				'custom_cs',
				'src/x.txt',
				TEST_CWD,
				cfg,
			);
			expect(result.allowed).toBe(false);
			if (isDenied(result)) {
				expect(result.reason).toContain('Allowed prefixes: (none)');
				expect(result.reason).toContain('Allowed globs: (none)');
				expect(result.reason).toContain('Allowed case-sensitive globs:');
				expect(result.reason).toContain('*Test.java');
			}
		});
	});

	describe('truncation guard (bounded message)', () => {
		test('more than 20 entries in a category get an accurate omitted-count tail', () => {
			// Per-category cap of 20 keeps the surfaced WRITE BLOCKED message
			// bounded. Every built-in rule fits (max 15); only pathological custom
			// configs truncate.
			const manyGlobs = Array.from({ length: 25 }, (_, i) => `**/g${i}.ext`);
			const cfg: AuthorityConfig = {
				enabled: true,
				rules: {
					custom_many: {
						allowedPrefix: [],
						allowedGlobs: manyGlobs,
					},
				},
			};
			const result = checkFileAuthority(
				'custom_many',
				'out/x.txt',
				TEST_CWD,
				cfg,
			);
			expect(result.allowed).toBe(false);
			if (isDenied(result)) {
				// First 20 shown.
				expect(result.reason).toContain('**/g19.ext');
				// 21st omitted with accurate count.
				expect(result.reason).toContain('… (+5 more)');
				expect(result.reason).not.toContain('**/g20.ext');
				expect(result.reason).not.toContain('**/g24.ext');
			}
		});

		test('exactly 20 entries render in full with no truncation tail', () => {
			const globs = Array.from({ length: 20 }, (_, i) => `**/h${i}.ext`);
			const cfg: AuthorityConfig = {
				enabled: true,
				rules: { custom_twenty: { allowedPrefix: [], allowedGlobs: globs } },
			};
			const result = checkFileAuthority(
				'custom_twenty',
				'out/x.txt',
				TEST_CWD,
				cfg,
			);
			expect(result.allowed).toBe(false);
			if (isDenied(result)) {
				expect(result.reason).toContain('**/h19.ext');
				expect(result.reason).not.toContain('… (+');
			}
		});
	});

	describe('security: no cross-agent or deny-rule leakage', () => {
		test("a blocked agent does NOT see another agent's allow patterns", () => {
			// Two custom agents with distinct globs. A block for agentA must only
			// reveal agentA's own patterns, never agentB's.
			const cfg: AuthorityConfig = {
				enabled: true,
				rules: {
					agent_a: {
						allowedPrefix: ['a-src/'],
						allowedGlobs: ['**/*.a.test.*'],
					},
					agent_b: {
						allowedPrefix: ['b-src/'],
						allowedGlobs: ['**/*.b.test.*'],
					},
				},
			};
			const result = checkFileAuthority(
				'agent_a',
				'elsewhere/x.txt',
				TEST_CWD,
				cfg,
			);
			expect(result.allowed).toBe(false);
			if (isDenied(result)) {
				expect(result.reason).toContain('a-src/');
				expect(result.reason).toContain('**/*.a.test.*');
				// agentB's patterns must NOT leak into agentA's reason.
				expect(result.reason).not.toContain('b-src/');
				expect(result.reason).not.toContain('**/*.b.test.*');
			}
		});

		test('the hint never discloses blocked* rules or universal deny prefixes', () => {
			// Even when the rule has blocked fields configured, only the positive
			// allow surface is disclosed (the caveat names them generically).
			const cfg: AuthorityConfig = {
				enabled: true,
				rules: {
					custom_with_blocks: {
						allowedPrefix: ['ok/'],
						blockedExact: ['.swarm/secret.txt'],
						blockedPrefix: ['forbidden/'],
						blockedGlobs: ['**/*.bin'],
						blockedZones: ['generated'],
					},
				},
			};
			const result = checkFileAuthority(
				'custom_with_blocks',
				'elsewhere/x.txt',
				TEST_CWD,
				cfg,
			);
			expect(result.allowed).toBe(false);
			if (isDenied(result)) {
				expect(result.reason).toContain('Allowed prefixes: ok/');
				// Concrete blocked values never appear (only the generic caveat).
				expect(result.reason).not.toContain('.swarm/secret.txt');
				expect(result.reason).not.toContain('forbidden/');
				expect(result.reason).not.toContain('**/*.bin');
			}
		});
	});
});

// ─── toolBefore integration: the surfaced WRITE BLOCKED carries the hint ─────
//
// This block verifies the fix end-to-end through the hook layer (not just the
// pure function), proving the LLM-facing thrown error contains the appended
// hint. Models the write-lstat-authority.test.ts toolBefore pattern.

describe('Issue #1984: toolBefore surfaces the actionable hint', () => {
	test('docs write blocked via toolBefore throws an error carrying the allowed hint', async () => {
		const { createGuardrailsHooks } = await import(
			'../../../src/hooks/guardrails'
		);
		const { ensureAgentSession, swarmState, beginInvocation, resetSwarmState } =
			await import('../../../src/state');
		const { AuthorityConfigSchema } = await import(
			'../../../src/config/schema'
		);
		const fs = await import('node:fs/promises');
		const osMod = await import('node:os');
		const pathMod = await import('node:path');

		// realpath so macOS /tmp → /private/tmp doesn't cause path mismatches.
		const dir = await fs.realpath(
			await fs.mkdtemp(pathMod.join(osMod.tmpdir(), 'issue1984-hook-')),
		);
		const originalCwd = process.cwd();
		process.chdir(dir);
		resetSwarmState();
		try {
			const cfg = GuardrailsConfigSchema.parse({
				enabled: true,
			}) as GuardrailsConfig;
			const authority = AuthorityConfigSchema.parse({}) as AuthorityConfig;
			const hooks = createGuardrailsHooks(dir, undefined, cfg, authority);

			const id = 'docs-hint';
			ensureAgentSession(id, 'docs');
			swarmState.activeAgent.set(id, 'docs');
			beginInvocation(id, 'docs');

			// docs writing to src/ is blocked; the thrown error must carry the
			// actionable hint so the agent sees it in the tool rejection.
			await expect(
				hooks.toolBefore(
					{ tool: 'write', sessionID: id, callID: 'hint1' },
					{ args: { filePath: 'src/foo.ts' } },
				),
			).rejects.toThrow(
				/path is not in allowed list for this role\..*Allowed prefixes: docs\/, \.swarm\/outputs\//,
			);
		} finally {
			process.chdir(originalCwd);
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
