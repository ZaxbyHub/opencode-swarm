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
		expect(planSkill).toMatch(/Use the `save_plan` tool/);
	});

	it('26. MODE:PLAN section includes swarm_id as required parameter', () => {
		expect(prompt).toContain('swarm_id');
		expect(planSkill).toMatch(/`swarm_id`: The swarm identifier/);
	});

	it('27. MODE:PLAN section includes fallback delegation pattern', () => {
		expect(prompt).toContain('If `save_plan` is unavailable');
		expect(planSkill).toContain(
			"delegate plan writing to the active swarm's coder agent",
		);
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

	it('29. MODE:PLAN section includes context.md creation instruction', () => {
		expect(planSkill).toContain('Also create .swarm/context.md');
		expect(planSkill).toContain(
			'decisions made, patterns identified, SME cache entries, and relevant file map',
		);
	});

	it('30. MODE:PLAN section includes save_plan example call', () => {
		expect(planSkill).toContain('Example call:');
		expect(planSkill).toMatch(
			/save_plan\(\{\s*title: "My Real Project",\s*swarm_id: "mega",/,
		);
	});
});
