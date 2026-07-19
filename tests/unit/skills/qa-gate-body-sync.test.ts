import { describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const SKILL_PAIRS = [
	{
		name: 'brainstorm',
		paths: [
			'.claude/skills/brainstorm/SKILL.md',
			'.opencode/skills/brainstorm/SKILL.md',
		],
	},
	{
		name: 'specify',
		paths: [
			'.claude/skills/specify/SKILL.md',
			'.opencode/skills/specify/SKILL.md',
		],
	},
	{
		name: 'plan',
		paths: ['.claude/skills/plan/SKILL.md', '.opencode/skills/plan/SKILL.md'],
	},
];

const BEGIN_MARKER = '<!-- BEGIN QA_GATE_BODY -->';
const END_MARKER = '<!-- END QA_GATE_BODY -->';

describe('qa-gate-body sync (task 3.3 — #1690)', () => {
	test('references/qa-gate-gates-body.md exists', () => {
		expect(existsSync('references/qa-gate-gates-body.md')).toBe(true);
	});

	test('scripts/sync-qa-gate-skills.ts exists', () => {
		expect(existsSync('scripts/sync-qa-gate-skills.ts')).toBe(true);
	});

	for (const pair of SKILL_PAIRS) {
		test(`${pair.name} skill files contain QA_GATE_BODY markers`, () => {
			for (const p of pair.paths) {
				const content = readFileSync(p, 'utf-8');
				expect(content).toContain(BEGIN_MARKER);
				expect(content).toContain(END_MARKER);
			}
		});

		test(`${pair.name} mirror pair is byte-identical`, () => {
			const a = readFileSync(pair.paths[0], 'utf-8');
			const b = readFileSync(pair.paths[1], 'utf-8');
			expect(a).toBe(b);
		});

		test(`${pair.name} canonical body content is reachable via markers`, () => {
			const content = readFileSync(pair.paths[0], 'utf-8');
			const beginIdx = content.indexOf(BEGIN_MARKER);
			const endIdx = content.indexOf(END_MARKER);
			expect(beginIdx).toBeGreaterThan(-1);
			expect(endIdx).toBeGreaterThan(beginIdx);
			const block = content.slice(beginIdx + BEGIN_MARKER.length, endIdx);
			// 11 gates must all appear in the canonical block
			expect(block).toContain('- reviewer');
			expect(block).toContain('- test_engineer');
			expect(block).toContain('- sme_enabled');
			expect(block).toContain('- critic_pre_plan');
			expect(block).toContain('- sast_enabled');
			expect(block).toContain('- council_mode');
			expect(block).toContain('- hallucination_guard');
			expect(block).toContain('- mutation_test');
			expect(block).toContain('- phase_council');
			expect(block).toContain('- drift_check');
			expect(block).toContain('- final_council');
			// 3 shared sub-items
			expect(block).toContain('Parallel coders');
			expect(block).toContain('Commit frequency');
			expect(block).toContain('auto_proceed');
		});
	}

	test('scripts/sync-qa-gate-skills.ts is idempotent (running twice produces byte-identical result)', () => {
		// Snapshot all 6 SKILL.md files
		const snapshotBefore = SKILL_PAIRS.flatMap((p) =>
			p.paths.map((path) => ({ path, content: readFileSync(path, 'utf-8') })),
		);

		// Run sync once
		execSync('bun run scripts/sync-qa-gate-skills.ts', { stdio: 'pipe' });

		const snapshotAfterRun1 = SKILL_PAIRS.flatMap((p) =>
			p.paths.map((path) => ({ path, content: readFileSync(path, 'utf-8') })),
		);

		// Run sync again
		execSync('bun run scripts/sync-qa-gate-skills.ts', { stdio: 'pipe' });

		const snapshotAfterRun2 = SKILL_PAIRS.flatMap((p) =>
			p.paths.map((path) => ({ path, content: readFileSync(path, 'utf-8') })),
		);

		// First run should match original
		for (let i = 0; i < snapshotBefore.length; i++) {
			expect(snapshotAfterRun1[i].content).toBe(snapshotBefore[i].content);
		}
		// Second run should match first run (idempotent)
		for (let i = 0; i < snapshotAfterRun1.length; i++) {
			expect(snapshotAfterRun2[i].content).toBe(snapshotAfterRun1[i].content);
		}
	});
});
