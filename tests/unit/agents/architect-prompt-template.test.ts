import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createArchitectAgent } from '../../../src/agents/architect';

describe('architect-prompt-template: task 11.1 verification tests', () => {
	let prompt: string;
	const planSkill = readFileSync(
		join(process.cwd(), '.opencode/skills/plan/SKILL.md'),
		'utf-8',
	);

	it('should create architect agent and extract prompt', () => {
		const agent = createArchitectAgent('gpt-4');
		expect(agent).toBeDefined();
		expect(agent.config).toBeDefined();
		expect(agent.config.prompt).toBeDefined();
		prompt = agent.config.prompt!;
	});

	it('1. ARCHITECT_PROMPT string exists and is non-empty', () => {
		expect(prompt).toBeDefined();
		expect(typeof prompt).toBe('string');
		expect(prompt.length).toBeGreaterThan(0);
	});

	it('2. ARCHITECT_PROMPT does NOT contain "[Project]" as a template placeholder', () => {
		// Check that [Project] does not appear as an actual placeholder (like "# [Project]" or as a standalone field)
		// The warning line mentions "[Project]" as an example of what NOT to use, so we check for actual usage
		expect(prompt).not.toMatch(/# \[Project\]/);
		expect(prompt).not.toMatch(/Project: \[Project\]/);
		expect(prompt).not.toMatch(/Project: "\[Project\]"/);
	});

	it('3. ARCHITECT_PROMPT does NOT contain "[task]" as a template placeholder in task lines', () => {
		// The warning line contains "[task]" as an example of what NOT to write
		// So we check that the old task line format does not appear
		// Check: task lines don't use [task] as a placeholder
		expect(prompt).not.toMatch(/- \[x\] \d+\.\d+: \[task\]/);
		expect(prompt).not.toMatch(/- \[ \] \d+\.\d+: \[task\]/);
		expect(prompt).not.toMatch(/TASK: \[task\]/);
	});

	it('4. ARCHITECT_PROMPT does NOT contain "[date]" as a template placeholder in the Phase line', () => {
		// Check that "Phase: [N] | Updated: [date]" pattern does NOT exist in the template
		// The warning line mentions "[date]" as an example, so we check for actual template usage
		expect(prompt).not.toContain('Updated: [date]');
	});

	it('5. ARCHITECT_PROMPT does NOT contain "Phase: [N]" as a template placeholder', () => {
		// Check that Phase: [N] pattern does NOT appear as a placeholder in the template
		// Check for the old format in the Phase line
		expect(prompt).not.toMatch(/Phase: \[N\] \|/);
	});

	it('6. ARCHITECT_PROMPT still contains "[COMPLETE]" (valid format token)', () => {
		expect(prompt).toContain('[COMPLETE]');
	});

	it('7. ARCHITECT_PROMPT still contains "[IN PROGRESS]" (valid format token)', () => {
		expect(prompt).toContain('[IN PROGRESS]');
	});

	it('8. ARCHITECT_PROMPT still contains "[BLOCKED]" (valid format token)', () => {
		expect(prompt).toContain('[BLOCKED]');
	});

	it('9. ARCHITECT_PROMPT still contains "[SMALL]" (valid format token)', () => {
		expect(prompt).toContain('[SMALL]');
	});

	it('10. ARCHITECT_PROMPT still contains "[MEDIUM]" (valid format token)', () => {
		expect(prompt).toContain('[MEDIUM]');
	});

	it('11. ARCHITECT_PROMPT still contains "[LARGE]" (valid format token)', () => {
		expect(prompt).toContain('[LARGE]');
	});

	it('12. ARCHITECT_PROMPT contains "⚠️" (the warning was added)', () => {
		expect(prompt).toContain('⚠️');
	});

	it('13. ARCHITECT_PROMPT contains "{{SWARM_ID}}" (template var preserved)', () => {
		expect(prompt).toContain('{{SWARM_ID}}');
	});

	it('14. ARCHITECT_PROMPT contains "<real project name" (new angle-bracket slot)', () => {
		expect(prompt).toContain('<real project name');
	});

	it('15. ARCHITECT_PROMPT contains angle-bracket slots (comprehensive check)', () => {
		// Check for various angle-bracket placeholders mentioned in the specs
		expect(prompt).toContain('<real project name');
		expect(prompt).toContain("<today's date in ISO format");
		expect(prompt).toContain('<current phase number');
		expect(prompt).toContain('<descriptive phase name');
		expect(prompt).toContain('<specific completed task description');
		expect(prompt).toContain('<specific task description');
		expect(prompt).toContain('<reason for blockage');
		expect(prompt).toContain('<specific technical decision');
		expect(prompt).toContain('<rationale for the decision');
		expect(prompt).toContain('<domain name');
		expect(prompt).toContain('<specific guidance');
		expect(prompt).toContain('<pattern name');
		expect(prompt).toContain('<how and when to use it');
	});

	it('16. createArchitectAgent returns an object with a prompt string property', () => {
		const agent = createArchitectAgent('gpt-4');
		expect(agent.config).toBeDefined();
		expect(agent.config.prompt).toBeDefined();
		expect(typeof agent.config.prompt).toBe('string');
	});

	it('17. The FILES section contains ".swarm/plan.md"', () => {
		expect(prompt).toContain('.swarm/plan.md:');
	});

	it('18. The FILES section contains ".swarm/context.md"', () => {
		expect(prompt).toContain('.swarm/context.md:');
	});

	it('19. Valid checkbox tokens are preserved: [x] and [ ]', () => {
		expect(prompt).toContain('[x]');
		expect(prompt).toContain('[ ]');
	});

	it('20. Warning line mentions specific old bracket placeholders', () => {
		// The warning should mention the old placeholders as examples of what NOT to write
		expect(prompt).toContain('NEVER write literal bracket-placeholder text');
		expect(prompt).toContain('"[task]"');
		expect(prompt).toContain('"[Project]"');
	});

	it('21. Checkpoint line uses current phase format', () => {
		// The FILES section should show the correct format with angle brackets
		expect(prompt).toContain('Phase: <current phase number>');
	});

	it('22. Task descriptions use angle-bracket format', () => {
		// Check that task lines use angle brackets, not square brackets
		expect(prompt).toMatch(/- \[x\] \d+\.\d+: <[^>]+>/);
	});

	it('23. Status tags are used correctly in template examples', () => {
		// The template examples should show [COMPLETE], [IN PROGRESS], [BLOCKED]
		const lines = prompt.split('\n');
		const phaseHeaders = lines.filter((line) => line.includes('## Phase'));

		expect(phaseHeaders.some((h) => h.includes('[COMPLETE]'))).toBe(true);
		expect(phaseHeaders.some((h) => h.includes('[IN PROGRESS]'))).toBe(true);
	});

	it('24. AGENT_PREFIX template variable is preserved', () => {
		expect(prompt).toContain('{{AGENT_PREFIX}}');
	});

	// MODE:PLAN update verification tests
	it('25. MODE:PLAN section includes save_plan tool usage', () => {
		expect(prompt).toContain('save_plan');
		expect(planSkill).toContain(
			'QA AND EXECUTION PROFILE BOOTSTRAP (before first `save_plan`)',
		);
	});

	it('26. MODE:PLAN section includes swarm_id as required parameter', () => {
		expect(prompt).toContain('swarm_id');
		expect(planSkill).toMatch(/`swarm_id`: The swarm identifier/);
	});

	it('27. MODE:PLAN fails closed when save_plan is unavailable', () => {
		expect(prompt).toContain(
			'If the authoritative ledger-backed `save_plan` tool is unavailable, STOP and report the blocker.',
		);
		expect(prompt).toContain('Never delegate or directly hand-write');
		expect(planSkill).toContain(
			'If the authoritative ledger-backed `save_plan` tool is unavailable, STOP and report the blocker.',
		);
		expect(planSkill).not.toContain(
			"delegate plan writing to the active swarm's coder agent",
		);
		expect(planSkill).toContain('Never ask a coder to hand-write');
	});

	it('28. MODE:PLAN section does NOT contain old direct instruction "Create .swarm/plan.md"', () => {
		// Check that the old instruction pattern does not exist
		expect(prompt).not.toMatch(/^Create .swarm\/plan\.md$/m);
		// The FILES section still mentions .swarm/plan.md which is fine
		// So we verify that the MODE:PLAN section does not start with that instruction
		const modePlanMatch = prompt.match(
			/### MODE: PLAN\s*\n([\s\S]*?)(?=### MODE:|$)/,
		);
		if (modePlanMatch) {
			const modePlanSection = modePlanMatch[1];
			expect(modePlanSection).not.toMatch(/^Create .swarm\/plan\.md/m);
		}
	});

	it('29. MODE:PLAN forbids direct context.md writes', () => {
		expect(planSkill).toContain(
			'Do not create or hand-edit `.swarm/context.md` as part of PLAN.',
		);
		expect(planSkill).not.toContain('Also create .swarm/context.md');
		expect(planSkill).not.toMatch(
			/recorded as explicit assumptions in `.swarm\/context\.md`/,
		);
	});

	it('30. MODE:PLAN section includes exact-identity save_plan call', () => {
		expect(planSkill).toMatch(
			/save_plan\(\{\s*title: <exact plan_title>,\s*swarm_id: <exact swarm_id>,/,
		);
	});

	// ACCEPTANCE field resolution verification tests (issue #1687 task 2.1)
	it('31. ARCHITECT_PROMPT documents ACCEPTANCE FIELD RESOLUTION instructions', () => {
		expect(prompt).toContain('ACCEPTANCE FIELD RESOLUTION');
	});

	it("32. ACCEPTANCE FIELD RESOLUTION instructs reading the task's fr_refs", () => {
		expect(prompt).toContain('fr_refs');
	});

	it('33. ACCEPTANCE FIELD RESOLUTION requires verbatim/byte-for-byte FR text, all mapped FRs concatenated', () => {
		expect(prompt).toContain('byte-for-byte');
		expect(prompt).toContain('no summarizing or paraphrasing');
		expect(prompt).toContain(
			'concatenate all of them when a task maps to more than one',
		);
	});

	it('34. ACCEPTANCE FIELD RESOLUTION requires a task-derived restatement when fr_refs is absent, and ACCEPTANCE is never empty', () => {
		expect(prompt).toContain(
			'if `fr_refs` is empty or absent, populate ACCEPTANCE with a task-derived one-line restatement',
		);
		expect(prompt).toContain('ACCEPTANCE must never be empty');
	});

	it('35. Coder delegation example no longer instructs omitting ACCEPTANCE when unmapped (old M15 wording removed)', () => {
		expect(prompt).not.toContain(
			'Omit the field entirely when the task has no structured acceptance criteria',
		);
	});

	// Reviewer ACCEPTANCE field verification tests (issue #1687 task 2.2)
	it('36. ACCEPTANCE FIELD RESOLUTION explicitly covers reviewer delegations, not just coder', () => {
		const resolutionIndex = prompt.indexOf('ACCEPTANCE FIELD RESOLUTION');
		expect(resolutionIndex).toBeGreaterThan(-1);
		const resolutionLine = prompt.slice(resolutionIndex, resolutionIndex + 200);
		expect(resolutionLine).toContain('{{AGENT_PREFIX}}reviewer');
	});

	it('37. reviewer delegation example includes an ACCEPTANCE field matching the coder delegation', () => {
		const reviewerExampleIndex = prompt.indexOf(
			'TASK: Review login validation',
		);
		expect(reviewerExampleIndex).toBeGreaterThan(-1);
		const reviewerExampleEnd = prompt.indexOf(
			'{{AGENT_PREFIX}}test_engineer',
			reviewerExampleIndex,
		);
		const reviewerExample = prompt.slice(
			reviewerExampleIndex,
			reviewerExampleEnd,
		);
		expect(reviewerExample).toContain('ACCEPTANCE:');
	});

	it('38. reviewer delegation example OUTPUT includes ACCEPTANCE_SATISFACTION', () => {
		const reviewerExampleIndex = prompt.indexOf(
			'TASK: Review login validation',
		);
		const reviewerExampleEnd = prompt.indexOf(
			'{{AGENT_PREFIX}}test_engineer',
			reviewerExampleIndex,
		);
		const reviewerExample = prompt.slice(
			reviewerExampleIndex,
			reviewerExampleEnd,
		);
		expect(reviewerExample).toContain('ACCEPTANCE_SATISFACTION');
	});

	// architect-acceptance-criteria: concrete (non-placeholder) examples +
	// plan-task/delegation disambiguation. The #1687 examples used abstract
	// placeholder brackets which licensed omission; these guard against a
	// return to that shape.
	it('39. coder delegation example ACCEPTANCE line is concrete (not the old placeholder)', () => {
		const coderExampleIndex = prompt.indexOf(
			'TASK: Add input validation to login',
		);
		expect(coderExampleIndex).toBeGreaterThan(-1);
		const coderExampleEnd = prompt.indexOf(
			'{{AGENT_PREFIX}}reviewer',
			coderExampleIndex,
		);
		const coderExample = prompt.slice(coderExampleIndex, coderExampleEnd);
		expect(coderExample).toContain('ACCEPTANCE: FR-');
		// Forbid the old placeholder shape verbatim (regression guard).
		expect(coderExample).not.toContain(
			'ACCEPTANCE: [copied verbatim from spec.md',
		);
	});

	it('40. reviewer delegation example ACCEPTANCE line is concrete (not the old placeholder)', () => {
		const reviewerExampleIndex = prompt.indexOf(
			'TASK: Review login validation',
		);
		expect(reviewerExampleIndex).toBeGreaterThan(-1);
		const reviewerExampleEnd = prompt.indexOf(
			'{{AGENT_PREFIX}}test_engineer',
			reviewerExampleIndex,
		);
		const reviewerExample = prompt.slice(
			reviewerExampleIndex,
			reviewerExampleEnd,
		);
		expect(reviewerExample).toContain('ACCEPTANCE: FR-');
		expect(reviewerExample).not.toContain(
			'ACCEPTANCE: [copied verbatim from spec.md',
		);
	});

	it('41. ACCEPTANCE FIELD RESOLUTION disambiguates plan-task acceptance from delegation ACCEPTANCE', () => {
		// The plan-task `acceptance` field is a different concept from the
		// per-delegation ACCEPTANCE: line. Without disambiguation the architect
		// can conflate "I wrote acceptance on the plan task" with "the
		// delegation prompt has its own ACCEPTANCE: line."
		expect(prompt).toContain(
			'plan-task `acceptance` field is a different thing',
		);
	});
});
