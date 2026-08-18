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

		test('prompt explains the identity-bound scope authorization contract', () => {
			// The architect must understand that declare_scope writes to .swarm/scopes/ and
			// survives cross-process delegation — without this, the architect may skip it
			// thinking it's purely in-memory.
			const hasBindingExplanation =
				/exact workspace, plan generation, task, parent session, and Task call/.test(
					ARCHITECT_SOURCE,
				) && /taskId/.test(ARCHITECT_SOURCE);
			expect(hasBindingExplanation).toBe(true);
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

	describe('4. PREFERRED AGGREGATOR — pre_check_batch guidance', () => {
		test('prompt contains PREFERRED AGGREGATOR directive', () => {
			// The prompt MUST contain an explicit "PREFERRED AGGREGATOR" directive
			// directing agents to use pre_check_batch over running lint, secretscan,
			// sast_scan, and quality_budget individually.
			const hasPreferredAggregator = /PREFERRED AGGREGATOR/i.test(
				ARCHITECT_SOURCE,
			);
			expect(hasPreferredAggregator).toBe(true);
		});

		test('prompt references pre_check_batch as the recommended post-implementation verification approach', () => {
			// The PREFERRED AGGREGATOR text must reference pre_check_batch explicitly
			// as the recommended way to run lint:check + secretscan + sast_scan +
			// quality_budget in parallel.
			const mentionsPreCheckBatch =
				/pre_check_batch.{0,300}lint.{0,50}secretscan.{0,50}sast_scan.{0,50}quality_budget/i.test(
					ARCHITECT_SOURCE,
				) ||
				(/pre_check_batch/i.test(ARCHITECT_SOURCE) &&
					/PREFERRED AGGREGATOR/i.test(ARCHITECT_SOURCE));
			expect(mentionsPreCheckBatch).toBe(true);
		});

		test('prompt describes pre_check_batch as running tools in PARALLEL', () => {
			// The guidance must convey that pre_check_batch runs tools concurrently
			// (up to 4 concurrent) so agents understand the performance benefit.
			const describesParallel =
				/pre_check_batch.{0,100}PARALLEL/i.test(ARCHITECT_SOURCE) ||
				/PARALLEL.{0,100}pre_check_batch/i.test(ARCHITECT_SOURCE);
			expect(describesParallel).toBe(true);
		});

		test('prompt clarifies pre_check_batch does NOT expose capture_baseline, changed_files scoping, or per-tool severity_threshold', () => {
			expect(ARCHITECT_SOURCE).toMatch(/does NOT expose capture_baseline/);
			expect(ARCHITECT_SOURCE).toMatch(/call sast_scan or secretscan directly/);
		});
	});

	describe('5. full-auto delegation clarity (#2207)', () => {
		test('prompt states full-auto never delegates or executes — architect retains delegation duty', () => {
			// #2207: with full-auto enabled, the architect hallucinated an autonomous
			// "full-auto controller" that would take over delegation, announced a
			// handoff, and made no tool calls — stalling the workflow. The prompt must
			// explicitly state full-auto is only a critic gate and the architect MUST
			// still dispatch tasks itself in every mode.
			expect(ARCHITECT_SOURCE).toMatch(
				/full-auto \(a critic gate that intercepts phase completions and high-risk actions/i,
			);
			expect(ARCHITECT_SOURCE).toMatch(
				/full-auto never plans, delegates, or executes; the architect retains ALL delegation duty/i,
			);
			expect(ARCHITECT_SOURCE).toMatch(
				/you MUST immediately dispatch that phase's tasks to coder yourself/i,
			);
			expect(ARCHITECT_SOURCE).toMatch(
				/it gates quality; it never replaces architect delegation/i,
			);
		});

		test('the ambiguous "autonomous cross-phase oversight" phrasing is gone from every prompt-reach surface', () => {
			// #2207 final-critic finding: the phrase previously also lived in the
			// /swarm loop command `details` (src/commands/registry.ts), which
			// buildSlashCommandsList() renders into the architect prompt via the
			// {{SLASH_COMMANDS}} placeholder — so the source-file grep alone could
			// not prove the RENDERED prompt is clean. Pin every surface that
			// reaches the prompt: the architect prompt source, the command
			// registry rendered into it, AND the loop skill the MODE: LOOP block
			// orders loaded at runtime (its content enters the conversation).
			expect(ARCHITECT_SOURCE).not.toContain(
				'autonomous cross-phase oversight',
			);
			const registrySource = readFileSync(
				join(process.cwd(), 'src', 'commands', 'registry.ts'),
				'utf-8',
			);
			expect(registrySource).not.toContain('autonomous cross-phase oversight');
			const loopSkillSource = readFileSync(
				join(process.cwd(), '.opencode', 'skills', 'loop', 'SKILL.md'),
				'utf-8',
			);
			expect(loopSkillSource).not.toContain('autonomous cross-phase oversight');
			// Positive pin on the corrected loop-skill wording. Patterns are
			// single-line because the skill file hard-wraps mid-phrase.
			expect(loopSkillSource).toMatch(
				/intercepts phase completions and high-risk actions for review/,
			);
			expect(loopSkillSource).toMatch(
				/never plans, delegates, or executes; the architect retains ALL delegation/,
			);
		});
	});
});
