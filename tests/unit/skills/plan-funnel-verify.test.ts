import { beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SKILL_OPENCODE = join(process.cwd(), '.opencode/skills/plan/SKILL.md');
const SKILL_CLAUDE = join(process.cwd(), '.claude/skills/plan/SKILL.md');

describe('plan SKILL.md Clarification Funnel verification', () => {
	let opencodeContent: string;
	let claudeContent: string;

	beforeAll(() => {
		opencodeContent = readFileSync(SKILL_OPENCODE, 'utf-8');
		claudeContent = readFileSync(SKILL_CLAUDE, 'utf-8');
	});

	test('files exist and are non-empty', () => {
		expect(opencodeContent.length).toBeGreaterThan(0);
		expect(claudeContent.length).toBeGreaterThan(0);
	});

	test('1 — contains "CLARIFICATION FUNNEL (pre-save_plan)" heading', () => {
		expect(opencodeContent).toContain('CLARIFICATION FUNNEL (pre-save_plan)');
		expect(claudeContent).toContain('CLARIFICATION FUNNEL (pre-save_plan)');
	});

	test('2 — all four stages present', () => {
		expect(opencodeContent).toContain(
			'#### Stage 1: Inventory All Material Uncertainties',
		);
		expect(opencodeContent).toContain(
			'#### Stage 2: Classify Each Uncertainty',
		);
		expect(opencodeContent).toContain(
			'#### Stage 3: Consult Critic Sounding Board Before User Escalation',
		);
		expect(opencodeContent).toContain(
			'#### Stage 4: Surface User Decision Packet',
		);
	});

	test('3 — all five classification categories present', () => {
		expect(opencodeContent).toContain('self_resolved');
		expect(opencodeContent).toContain('critic_resolved');
		expect(opencodeContent).toContain('research_needed');
		expect(opencodeContent).toContain('user_decision');
		expect(opencodeContent).toContain('deferred_nonblocking');
	});

	test('4 — all four critic outcomes present with SoundingBoardVerdict mapping', () => {
		// Anchor to the Stage 3 section to verify structured mapping exists
		const stage3Start = opencodeContent.indexOf(
			'#### Stage 3: Consult Critic Sounding Board',
		);
		const stage4Start = opencodeContent.indexOf(
			'#### Stage 4: Surface User Decision Packet',
		);
		expect(stage3Start).toBeGreaterThan(-1);
		expect(stage4Start).toBeGreaterThan(stage3Start);
		const stage3Section = opencodeContent.slice(stage3Start, stage4Start);

		expect(stage3Section).toContain('UNNECESSARY');
		expect(stage3Section).toContain('RESOLVE');
		expect(stage3Section).toContain('REPHRASE');
		expect(stage3Section).toContain('APPROVED');
		expect(stage3Section).toContain('SoundingBoardVerdict');
		expect(stage3Section).toContain('DROP');
		expect(stage3Section).toContain('ASK_USER');
	});

	test('4b — overconfidence guard present in Stage 3', () => {
		const stage3Start = opencodeContent.indexOf(
			'#### Stage 3: Consult Critic Sounding Board',
		);
		const stage4Start = opencodeContent.indexOf(
			'#### Stage 4: Surface User Decision Packet',
		);
		const stage3Section = opencodeContent.slice(stage3Start, stage4Start);
		expect(stage3Section).toContain('Overconfidence guard');
	});

	test('5 — "Always-Surface Categories" section present', () => {
		expect(opencodeContent).toContain('#### Always-Surface Categories');
	});

	test('6 — "Assumptions Recording" section present', () => {
		expect(opencodeContent).toContain('#### Assumptions Recording');
	});

	test('7 — funnel section appears BEFORE save_plan tool section', () => {
		const funnelIdx = opencodeContent.indexOf(
			'### CLARIFICATION FUNNEL (pre-save_plan)',
		);
		const saveIdx = opencodeContent.indexOf('Use the `save_plan` tool');
		expect(funnelIdx).toBeGreaterThan(0);
		expect(saveIdx).toBeGreaterThan(0);
		expect(funnelIdx).toBeLessThan(saveIdx);
	});

	test('8 — mirror parity: .claude version is byte-identical to .opencode version', () => {
		expect(claudeContent).toBe(opencodeContent);
	});
});
