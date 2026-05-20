import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Architect Prompt Regression Tests — Task 3.3
 *
 * Verifies that the architect prompt contains critical security/regression rules
 * that were added to prevent common failure modes:
 *
 * 1. SCOPE DISCIPLINE rule: declare_scope must be called BEFORE every coder delegation
 * 2. Anti-bash-bypass rule: bash workarounds for file writes are banned
 * 3. Anti-eval rule: interpreter eval for writes is banned
 *
 * These rules are load-bearing invariants. If any are missing, the architect can
 * be tricked into bypassing scope guards or write-authority checks.
 */

const ARCHITECT_SOURCE = readFileSync(
	join(process.cwd(), 'src', 'agents', 'architect.ts'),
	'utf-8',
);

describe('architect prompt — critical rules regression (Task 3.3)', () => {
	describe('1. SCOPE DISCIPLINE rule', () => {
		test('prompt contains text requiring declare_scope BEFORE every coder delegation', () => {
			// The prompt MUST contain an explicit SCOPE DISCIPLINE rule with "declare_scope" and "BEFORE"
			// in the same directive context. This ensures the architect calls declare_scope before
			// every coder delegation, not just at the first one.
			const hasDeclareScopeBefore =
				/SCOPE DISCIPLINE.{0,200}declare_scope.{0,200}BEFORE.{0,100}coder/i.test(
					ARCHITECT_SOURCE,
				);
			expect(hasDeclareScopeBefore).toBe(true);
		});

		test('prompt contains PRE-DELEGATION SCOPE CALL requirement', () => {
			// A separate explicit rule reinforces that declare_scope is required BEFORE coder
			// delegation, not optional.
			const hasPreDelegationRule = /PRE-DELEGATION SCOPE CALL/i.test(
				ARCHITECT_SOURCE,
			);
			expect(hasPreDelegationRule).toBe(true);
		});

		test('prompt explains declare_scope persists to disk for cross-process delegation', () => {
			// The architect must understand that declare_scope writes to .swarm/scopes/ and
			// survives cross-process delegation — without this, the architect may skip it
			// thinking it's purely in-memory.
			const hasPersistenceExplanation =
				/\.swarm\/scopes\/scope-/.test(ARCHITECT_SOURCE) &&
				/taskId/.test(ARCHITECT_SOURCE);
			expect(hasPersistenceExplanation).toBe(true);
		});
	});

	describe('2. Anti-bash-bypass rule', () => {
		test('prompt bans eval/bash/sh subshell for file writes', () => {
			// The prompt MUST contain text banning "eval, bash -c, sh -c, a subshell,
			// or a heredoc-to-file redirect" for file writes. These are bash workarounds
			// that bypass the tool-scoped write-authority check.
			const hasBashBypassBan =
				/Never wrap a file write in eval,? bash -c,? sh -c,? a subshell,? or a heredoc-to-file redirect/i.test(
					ARCHITECT_SOURCE,
				);
			expect(hasBashBypassBan).toBe(true);
		});

		test('prompt bans mv/cp-then-rm file-move bypasses', () => {
			// File-move operations (mv, Move-Item, cp-then-rm) are also banned as they
			// can be used to bypass blocked destructive commands under .swarm/.
			const hasMoveBypassBan =
				/mv,? Move-Item,? move,? ren,? Rename-Item,? or cp-then-rm chains/i.test(
					ARCHITECT_SOURCE,
				);
			expect(hasMoveBypassBan).toBe(true);
		});
	});

	describe('3. Anti-eval rule', () => {
		test('prompt bans interpreter eval for bypassing write blocks', () => {
			// The prompt MUST contain text banning "bash, sed, echo, cat, tee, dd, or any
			// interpreter eval" to bypass write blocks. This prevents the architect from
			// suggesting python -c, node -e, bun -e, ruby -e, etc.
			const hasInterpreterEvalBan =
				/Do NOT instruct the coder to use bash,? sed,? echo,? cat,? tee,? dd,? or any interpreter eval/i.test(
					ARCHITECT_SOURCE,
				);
			expect(hasInterpreterEvalBan).toBe(true);
		});

		test('prompt explicitly names interpreter eval variants (python -c, node -e, bun -e, ruby -e)', () => {
			// The specific interpreter eval forms must be called out so the architect
			// cannot claim ignorance about python -c or node -e style bypasses.
			const hasNamedInterpreters =
				/python -c,? node -e,? bun -e,? ruby -e/.test(ARCHITECT_SOURCE);
			expect(hasNamedInterpreters).toBe(true);
		});
	});
});
