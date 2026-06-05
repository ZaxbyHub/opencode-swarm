import { describe, expect, it } from 'bun:test';
import {
	type CouncilWorkflowConfig,
	createArchitectAgent,
} from '../../../src/agents/architect';

/**
 * Part 3 — Architect prompt wiring for the Work Complete Council.
 *
 * Asserts that:
 *  - When council.enabled=true, the four-phase workflow block renders into
 *    the architect prompt with the expected headings, phase labels, tool
 *    names, all five member roles, and REJECT/maxRounds escalation text.
 *  - When council.enabled=false OR the council key is absent, none of the
 *    council-specific strings appear.
 *  - The rendered prompt is byte-for-byte identical between the
 *    council-absent path and the council.enabled=false path (non-regression).
 */
describe('Architect prompt — Work Complete Council workflow block', () => {
	// Sentinel phrases that are UNIQUE to the council workflow block. These
	// were chosen to NOT overlap with the auto-generated tool-description list,
	// so they truly identify the block itself. Keep in sync with buildCouncilWorkflow().
	const COUNCIL_SENTINELS = [
		'## COUNCIL WORKFLOW (submit_phase_council_verdicts)',
		'WHEN TO RUN COUNCIL',
		'STEP 1 — DISPATCH',
		'STEP 3 — CALL submit_phase_council_verdicts',
		'STEP 5 — ACT on the verdict',
		'ANTI-PATTERNS',
		'ROUND 2 DELIBERATION',
		'Retry protocol',
		'hallucinated APIs',
	];

	describe('council.enabled === true', () => {
		const agent = createArchitectAgent(
			'test-model',
			undefined,
			undefined,
			undefined,
			{ enabled: true },
		);
		const prompt = agent.config.prompt!;

		it('includes a Council section heading (case-insensitive match)', () => {
			expect(prompt.toLowerCase()).toContain('council');
			// And specifically the dedicated section header
			expect(prompt).toContain('## COUNCIL WORKFLOW');
		});

		it('includes WHEN TO RUN COUNCIL section and STEP 1..STEP 5', () => {
			expect(prompt).toContain('WHEN TO RUN COUNCIL');
			expect(prompt).toContain('STEP 1');
			expect(prompt).toContain('STEP 2');
			expect(prompt).toContain('STEP 3');
			expect(prompt).toContain('STEP 4');
			expect(prompt).toContain('STEP 5');
		});

		it('includes both council tool names', () => {
			expect(prompt).toContain('declare_council_criteria');
			expect(prompt).toContain('submit_council_verdicts');
		});

		it('does NOT contain the old tool name (pre-rename "convene" + underscore + "council")', () => {
			// Constructed string so the literal old identifier never appears in
			// source — keeps the zero-tolerance grep clean.
			const oldToolName = ['convene', 'council'].join('_');
			expect(prompt).not.toContain(oldToolName);
		});

		it('contains the anti-bypass critical guardrail', () => {
			expect(prompt).toContain('does NOT run council members');
		});

		it('references membersAbsent as the anti-hallucination signal', () => {
			expect(prompt).toContain('membersAbsent');
		});

		it('mentions the explorer member (5th member)', () => {
			// "explorer" should appear in the council STEP 1 member bullet list.
			// Use a token specific to the council block to avoid matching
			// unrelated mentions of explorer elsewhere in the prompt.
			expect(prompt).toContain('explorer');
			// Tighter — explorer appears in the five-member dispatch list next
			// to slop-hunting responsibilities.
			expect(prompt).toMatch(
				/explorer[\s\S]{0,200}slop|lazy implementations|hallucinated APIs/i,
			);
		});

		it('describes REJECT as blocking and escalating via maxRounds', () => {
			expect(prompt).toContain('REJECT');
			expect(prompt).toContain('Block advancement');
			expect(prompt).toContain('maxRounds');
			expect(prompt).toMatch(/surface.*unifiedFeedbackMd.*HALT/is);
		});

		it('does not contain the old "supplements — does NOT replace" wording', () => {
			expect(prompt).not.toContain('supplements — does NOT replace');
		});

		it('contains the ADDITIONAL verification layer wording inside the council block', () => {
			// Council is "ADDITIONAL" verification layer, NOT a replacement for Stage B
			expect(prompt).toContain('ADDITIONAL verification layer');
			expect(prompt).toContain('Stage B');
			expect(prompt).toContain('Stage A');
			expect(prompt).toContain('pre_check_batch');
		});

		it('does NOT contain REPLACES Stage B wording anywhere in the prompt', () => {
			// "council REPLACES Stage B" is wrong - but "council never replaces Stage B" is correct
			// So we check for the specific pattern "council REPLACES Stage B" (with REPLACES as a verb)
			expect(prompt).not.toMatch(/council\s+REPLACES\s+Stage\s+B/i);
			// Also check lowercase variant
			expect(prompt).not.toMatch(/council\s+replaces\s+Stage\s+B/);
		});

		it('contains the ANTI-PATTERNS section listing 5 council bypass violations', () => {
			expect(prompt).toContain('ANTI-PATTERNS');
			// Five bullet violations.
			const antiPatternMatches = prompt.match(/✗/g) ?? [];
			expect(antiPatternMatches.length).toBeGreaterThanOrEqual(5);
		});

		it('contains the ROUND 2 DELIBERATION rule', () => {
			expect(prompt).toContain('ROUND 2 DELIBERATION');
		});

		it('requires re-dispatch of all absent members after insufficient_quorum', () => {
			expect(prompt).toMatch(/dispatch ALL absent members.*single parallel batch/i);
		});

		it('requires prior-round dissenters to be re-dispatched', () => {
			expect(prompt).toMatch(
				/every prior-round\s+dissenter[\s\S]*re-dispatched/i,
			);
		});

		describe('critic dispatch includes approved-plan baseline and drift analysis', () => {
			it('contains get_approved_plan in the critic dispatch text', () => {
				expect(prompt).toContain('get_approved_plan');
			});

			it('contains baseline or approved-plan in the critic dispatch', () => {
				// At least one of these approved-plan baseline terms should appear
				// near the critic dispatch line
				expect(prompt).toMatch(
					/critic[\s\S]{0,300}(?:baseline|approved-plan)/i,
				);
			});

			it('contains spec-intent drift language in the critic dispatch', () => {
				// The critic line should reference spec-intent drift analysis
				expect(prompt).toMatch(
					/critic[\s\S]{0,300}spec.?intent.*drift|drift.*spec.?intent/i,
				);
			});
		});
	});

	describe('council.enabled === false', () => {
		const agent = createArchitectAgent(
			'test-model',
			undefined,
			undefined,
			undefined,
			{ enabled: false },
		);
		const prompt = agent.config.prompt!;

		it('does not contain any council-specific sentinel strings', () => {
			for (const s of COUNCIL_SENTINELS) {
				expect(prompt).not.toContain(s);
			}
		});

		it('does not leave the {{COUNCIL_WORKFLOW}} placeholder unexpanded', () => {
			expect(prompt).not.toContain('{{COUNCIL_WORKFLOW}}');
		});

		it('YOUR TOOLS does not contain submit_council_verdicts or declare_council_criteria', () => {
			const yourToolsLine = prompt.match(/YOUR TOOLS:\s*(.+?)(?:\n|$)/)?.[1];
			expect(yourToolsLine).toBeDefined();
			expect(yourToolsLine).not.toContain('submit_council_verdicts');
			expect(yourToolsLine).not.toContain('declare_council_criteria');
		});

		it('Available Tools does not contain submit_council_verdicts or declare_council_criteria', () => {
			const availableToolsLine = prompt.match(
				/Available Tools:\s*([\s\S]*?)(?:\n##|$)/,
			)?.[1];
			expect(availableToolsLine).toBeDefined();
			expect(availableToolsLine).not.toContain('submit_council_verdicts');
			expect(availableToolsLine).not.toContain('declare_council_criteria');
		});
	});

	describe('council config key absent entirely', () => {
		const agent = createArchitectAgent(
			'test-model',
			undefined,
			undefined,
			undefined,
			undefined,
		);
		const prompt = agent.config.prompt!;

		it('does not contain any council-specific sentinel strings', () => {
			for (const s of COUNCIL_SENTINELS) {
				expect(prompt).not.toContain(s);
			}
		});

		it('does not leave the {{COUNCIL_WORKFLOW}} placeholder unexpanded', () => {
			expect(prompt).not.toContain('{{COUNCIL_WORKFLOW}}');
		});
	});

	describe('critic_oversight is outside council scope', () => {
		const agent = createArchitectAgent(
			'test-model',
			undefined,
			undefined,
			undefined,
			{ enabled: true },
		);
		const prompt = agent.config.prompt!;

		it('council workflow block does not reference critic_oversight', () => {
			// The council workflow dispatches a plan_critic (council critic) for
			// live plan-review. The full-auto intercept uses a separate
			// critic_oversight agent that operates outside council scope.
			// Verifying the council block does not mention critic_oversight
			// confirms these are separate dispatch paths.
			expect(prompt).not.toContain('critic_oversight');
		});

		it('council workflow block does not reference AUTONOMOUS_OVERSIGHT', () => {
			// The autonomous oversight path is a distinct full-auto intercept,
			// not part of the council workflow. The council block should be
			// silent about autonomous oversight.
			expect(prompt).not.toContain('AUTONOMOUS_OVERSIGHT');
		});

		it('critic dispatch in council block refers to council critic (not critic_oversight)', () => {
			// The council dispatches a single "critic" member for live plan-review
			// with approved-baseline comparison (get_approved_plan). This is distinct
			// from critic_oversight which is used by full-auto intercept.
			// Confirms council and autonomous oversight are separate critic paths.
			expect(prompt).toMatch(/- `critic`\s*—/);
		});
	});

	describe('non-regression byte-equivalence', () => {
		it('council=false and council=absent produce byte-identical prompts', () => {
			const disabled = createArchitectAgent(
				'test-model',
				undefined,
				undefined,
				undefined,
				{ enabled: false } satisfies CouncilWorkflowConfig,
			).config.prompt!;

			const absent = createArchitectAgent(
				'test-model',
				undefined,
				undefined,
				undefined,
				undefined,
			).config.prompt!;

			expect(disabled).toBe(absent);
		});

		it('council=absent is byte-identical to pre-council no-arg call', () => {
			// No-arg call should match absent-council call — proves that adding
			// the council parameter introduced zero observable change when the
			// feature is off.
			const noArg = createArchitectAgent('test-model').config.prompt!;
			const absent = createArchitectAgent(
				'test-model',
				undefined,
				undefined,
				undefined,
				undefined,
			).config.prompt!;

			expect(noArg).toBe(absent);
		});
	});

	describe('council_mode rewrite — ADDITIONAL gate semantics + phase-level council (post-patch)', () => {
		// These tests verify the council_mode prompt rewrite:
		// 1. Council is "ADDITIONAL" gate at PHASE LEVEL, not a replacement for Stage B
		// 2. PHASE COUNCIL section added for phase-level holistic review
		// Stage B parallel dispatch is covered through createAgents() in
		// architect-parallelization-config.test.ts, where the PARALLELIZATION
		// CONFIG placeholder is actually expanded.

		describe('Council is ADDITIONAL gate at PHASE LEVEL (not replacement)', () => {
			const agent = createArchitectAgent(
				'test-model',
				undefined,
				undefined,
				undefined,
				{ enabled: true },
			);
			const prompt = agent.config.prompt!;

			it('contains "ADDITIONAL gate at PHASE LEVEL" or similar wording', () => {
				// Council runs as an ADDITIONAL gate at PHASE LEVEL
				expect(prompt).toMatch(
					/ADDITIONAL.*gate.*PHASE LEVEL|ADDITIONAL verification layer/i,
				);
			});

			it('contains "council never replaces Stage B" or equivalent', () => {
				// Stage B always runs per-task — council never replaces it
				expect(prompt).toMatch(
					/council.*never.*replace.*Stage B|Stage B.*always.*runs.*per-task/i,
				);
			});

			it('contains "Stage B always runs per-task"', () => {
				expect(prompt).toContain('Stage B always runs per-task');
			});

			it('does NOT claim council replaces Stage B', () => {
				// Must not say "council REPLACES Stage B" - but "council never replaces" is fine
				expect(prompt).not.toMatch(/council\s+replaces\s+Stage\s+B/i);
				// Also check for "replaces it" in context of Stage B
				expect(prompt).not.toMatch(/replaces\s+it.*Stage\s+B/i);
			});
		});

		describe('PHASE COUNCIL section for phase-level holistic review', () => {
			const agent = createArchitectAgent(
				'test-model',
				undefined,
				undefined,
				undefined,
				{ enabled: true },
			);
			const prompt = agent.config.prompt!;

			it('contains "PHASE COUNCIL" section header', () => {
				expect(prompt).toContain('PHASE COUNCIL');
			});

			it('contains "phase-level council" or "phase council" description', () => {
				expect(prompt).toMatch(/phase.level.*council|phase council/i);
			});

			it('mentions phase_complete in context of council', () => {
				// Phase council convenes at phase_complete time
				expect(prompt).toMatch(
					/phase_complete.*council|council.*phase_complete/i,
				);
			});

			it('describes cross-cutting concerns review', () => {
				// Phase council focuses on CROSS-CUTTING concerns only
				expect(prompt).toMatch(/cross.cutting.*concerns|CROSS.CUTTING/i);
			});

			it('describes phase dossier assembly step', () => {
				expect(prompt).toContain('Phase Dossier Assembly');
			});

			it('describes council dispatch workflow', () => {
				expect(prompt).toMatch(/Council Dispatch|Dispatch.*council/i);
			});
		});

		describe('PHASE COUNCIL absent when council disabled', () => {
			const agent = createArchitectAgent(
				'test-model',
				undefined,
				undefined,
				undefined,
				{ enabled: false },
			);
			const prompt = agent.config.prompt!;

			it('does NOT contain PHASE COUNCIL section', () => {
				expect(prompt).not.toContain('PHASE COUNCIL');
			});
		});

		describe('buildCouncilWorkflow function behavior', () => {
			const { buildCouncilWorkflow } = require('../../../src/agents/architect');

			it('returns empty string when council is undefined', () => {
				const result = buildCouncilWorkflow(undefined);
				expect(result).toBe('');
			});

			it('returns empty string when council.enabled is false', () => {
				const result = buildCouncilWorkflow({ enabled: false });
				expect(result).toBe('');
			});

			it('returns non-empty string when council.enabled is true', () => {
				const result = buildCouncilWorkflow({ enabled: true });
				expect(result).not.toBe('');
			});

			it('returns string containing PHASE COUNCIL when council enabled', () => {
				const result = buildCouncilWorkflow({ enabled: true });
				expect(result).toContain('PHASE COUNCIL');
			});

			it('returns string containing ADDITIONAL verification layer', () => {
				const result = buildCouncilWorkflow({ enabled: true });
				expect(result).toMatch(
					/ADDITIONAL.*verification layer|verification layer.*ADDITIONAL/i,
				);
			});

			it('returns string containing Stage B ALWAYS runs per-task', () => {
				const result = buildCouncilWorkflow({ enabled: true });
				// The actual text uses uppercase ALWAYS
				expect(result).toMatch(/Stage B.*ALWAYS\s+runs\s+per-task/i);
			});
		});

		describe('template variables preserved in prompt', () => {
			const agent = createArchitectAgent(
				'test-model',
				undefined,
				undefined,
				undefined,
				{ enabled: true },
			);
			const prompt = agent.config.prompt!;

			it('contains {{AGENT_PREFIX}} placeholder', () => {
				// AGENT_PREFIX should appear in the prompt multiple times
				expect(prompt).toContain('{{AGENT_PREFIX}}');
			});

			it('renders agent names after template substitution', () => {
				// The prompt should contain actual agent prefix references like "reviewer" after substitution
				expect(prompt).toContain('reviewer');
				expect(prompt).toContain('test_engineer');
			});

			it('does NOT leave {{COUNCIL_WORKFLOW}} unexpanded when council enabled', () => {
				// COUNCIL_WORKFLOW should be replaced with the actual council block
				expect(prompt).not.toContain('{{COUNCIL_WORKFLOW}}');
				// And should contain the actual council content
				expect(prompt).toContain('## COUNCIL WORKFLOW');
			});
		});

		describe('no skip Stage B entries language', () => {
			const agent = createArchitectAgent(
				'test-model',
				undefined,
				undefined,
				undefined,
				{ enabled: true },
			);
			const prompt = agent.config.prompt!;

			it('does NOT contain "skip Stage B" language anywhere', () => {
				expect(prompt).not.toMatch(/skip.*Stage B|Stage B.*skip/i);
			});

			it('does NOT contain "bypass Stage B" language anywhere', () => {
				expect(prompt).not.toMatch(/bypass.*Stage B|Stage B.*bypass/i);
			});
		});
	});
});
