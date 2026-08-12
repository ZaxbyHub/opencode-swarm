import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createArchitectAgent } from '../../../src/agents/architect';

const read = (path: string): string =>
	readFileSync(join(process.cwd(), path), 'utf-8');

const mirroredSkills = [
	'brainstorm',
	'specify',
	'plan',
	'issue-ingest',
] as const;

const legacyContextProtocols = [
	'Pending QA Gate Selection',
	'Pending Parallelization Config',
	'Task Completion Commit Policy',
] as const;

describe('QA gate pre-plan bootstrap protocol (#2145)', () => {
	for (const skill of mirroredSkills) {
		test(`${skill} OpenCode and Claude mirrors are byte-identical`, () => {
			expect(read(`.opencode/skills/${skill}/SKILL.md`)).toBe(
				read(`.claude/skills/${skill}/SKILL.md`),
			);
		});
	}

	test('Claude EXECUTE adapter stays thin and delegates to the canonical execute protocol', () => {
		const adapter = read('.claude/skills/execute/SKILL.md');
		const canonical = read('.opencode/skills/execute/SKILL.md');

		expect(adapter).toContain('../../../.opencode/skills/execute/SKILL.md');
		expect(adapter).toContain('source of truth');
		expect(adapter).not.toContain(
			'plan.execution_profile.commit_after_each_completed_task',
		);
		expect(canonical).toContain(
			'plan.execution_profile.commit_after_each_completed_task',
		);
		expect(canonical).toMatch(/checkpoint[\s\S]*fail[\s\S]*advisory/i);
	});

	test('operative skills and architect prompt contain no legacy context staging', () => {
		const operative = [
			...mirroredSkills.map((skill) =>
				read(`.opencode/skills/${skill}/SKILL.md`),
			),
			createArchitectAgent('test-model').config.prompt!,
			read('.opencode/skills/execute/SKILL.md'),
			read('.claude/skills/execute/SKILL.md'),
		].join('\n');

		for (const legacy of legacyContextProtocols) {
			expect(operative).not.toContain(legacy);
		}
	});

	test('SPECIFY, BRAINSTORM, and issue ingest defer all four choices to PLAN', () => {
		for (const skill of ['specify', 'brainstorm', 'issue-ingest'] as const) {
			const content = read(`.opencode/skills/${skill}/SKILL.md`);
			expect(content).toMatch(/defer[\s\S]*MODE: PLAN/i);
			expect(content).toMatch(/exact plan identity/i);
		}
	});

	test('both BRAINSTORM mirrors transition through authoritative save_plan only', () => {
		for (const runner of ['.opencode', '.claude'] as const) {
			const content = read(`${runner}/skills/brainstorm/SKILL.md`);
			const transition = content.slice(
				content.indexOf('Phase 7: TRANSITION'),
				content.indexOf('BRAINSTORM RULES:'),
			);

			expect(transition).toContain('authoritative ledger-backed `save_plan`');
			expect(transition).toContain('never write `.swarm/plan.md` directly');
			expect(transition).not.toContain('write plan.md');
		}
	});

	test('release notes name the exact task-completion checkpoint action', () => {
		const releaseNote = read('docs/releases/pending/2145-qa-gate-bootstrap.md');
		const commitFrequencyReleaseNote = read(
			'docs/releases/pending/task-completion-commit-frequency.md',
		);

		expect(releaseNote).toContain('`save_task_completion` checkpoint action');
		expect(releaseNote).toContain('adopt_legacy_binding_only');
		expect(commitFrequencyReleaseNote).toContain(
			'`checkpoint({ action: "save_task_completion", task_id: "<task-id>" })`',
		);
		expect(commitFrequencyReleaseNote).not.toContain('`checkpoint save`');
		expect(releaseNote).not.toMatch(
			/checkpoint creation happens only after task completion and\s+pre-commit gates,/,
		);
	});

	test('PLAN freezes identity and persists gates before the first save', () => {
		const content = read('.opencode/skills/plan/SKILL.md');
		const bootstrap = content.slice(
			content.indexOf('QA AND EXECUTION PROFILE BOOTSTRAP'),
			content.indexOf('TRACEABILITY CHECK'),
		);

		expect(bootstrap).toContain('swarm_id');
		expect(bootstrap).toContain('plan_title');
		expect(bootstrap).toContain('set_qa_gates');
		expect(bootstrap).toContain('adopt_legacy_binding_only');
		expect(bootstrap).toContain('execution_profile');
		expect(bootstrap).toContain('commit_after_each_completed_task');
		expect(bootstrap.indexOf('set_qa_gates')).toBeLessThan(
			bootstrap.indexOf('\nsave_plan({'),
		);
		expect(bootstrap).toMatch(/persisted[\s\S]*critic_pre_plan/i);
	});

	test('authoritative PLAN surfaces forbid direct context and derived-plan writes', () => {
		const surfaces = [
			read('.opencode/skills/plan/SKILL.md'),
			read('.claude/skills/plan/SKILL.md'),
			createArchitectAgent('test-model').config.prompt!,
			read('references/qa-gate-gates-body.md'),
			read('scripts/sync-qa-gate-skills.ts'),
			read('tests/helpers/skill-content-registry.ts'),
		].join('\n');

		expect(surfaces).not.toContain(
			'TASK: Write the implementation plan to .swarm/plan.md',
		);
		expect(surfaces).not.toContain('Also create .swarm/context.md with:');
		expect(read('.opencode/skills/plan/SKILL.md')).toMatch(
			/save_plan[^]*unavailable[^]*STOP[^]*Never ask a coder to hand-write/i,
		);
	});

	test('LOOP auto mode persists explicit balanced defaults without pausing', () => {
		const content = read('.opencode/skills/plan/SKILL.md');
		expect(content).toMatch(
			/MODE: LOOP[\s\S]*autonomy=auto[\s\S]*balanced-speed defaults[\s\S]*set_qa_gates/i,
		);
	});

	test('execute reads durable commit policy and treats checkpoint errors as advisory', () => {
		const content = read('.opencode/skills/execute/SKILL.md');
		expect(content).toContain(
			'plan.execution_profile.commit_after_each_completed_task',
		);
		expect(content).toContain(
			'checkpoint({ action: "save_task_completion", task_id: "<task-id>" })',
		);
		expect(content).toMatch(/after[\s\S]*PRE-COMMIT RULE/i);
		expect(content).toMatch(/idempotent:\s*true[\s\S]*idempotent/i);
		expect(content).toMatch(/checkpoint[\s\S]*fail[\s\S]*advisory/i);
	});
});
