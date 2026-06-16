import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createArchitectAgent } from '../../../src/agents/architect';

describe('architect prompt: declare_scope instruction at every coder delegation site (#493)', () => {
	const prompt = createArchitectAgent(
		'gpt-4',
		undefined,
		undefined,
		undefined,
		undefined,
		{
			enabled: true,
		},
	).config.prompt!;
	const executeSkill = readFileSync(
		join(process.cwd(), '.opencode/skills/execute/SKILL.md'),
		'utf-8',
	);

	it('ARCHITECT_PROMPT mentions declare_scope (canonical Rule 1a check)', () => {
		expect(prompt).toContain('declare_scope');
		expect(prompt).toMatch(/SCOPE DISCIPLINE[\s\S]*declare_scope/);
	});

	it('Rule 3 delegation site has a declare_scope reminder', () => {
		const start = prompt.indexOf('3. ONE task per');
		const end = prompt.indexOf('4. ARCHITECT CODING BOUNDARIES');
		expect(start).toBeGreaterThan(-1);
		expect(end).toBeGreaterThan(start);
		const slice = prompt.slice(start, end);
		expect(slice).toContain('declare_scope');
	});

	it('Rule 4 self-coding fallback has a declare_scope reminder', () => {
		const start = prompt.indexOf('4. ARCHITECT CODING BOUNDARIES');
		const end = prompt.indexOf('5. NEVER store your swarm identity');
		expect(start).toBeGreaterThan(-1);
		expect(end).toBeGreaterThan(start);
		const slice = prompt.slice(start, end);
		expect(slice).toContain('declare_scope');
	});

	it('Rule 9 UI/UX gate has a declare_scope reminder', () => {
		const start = prompt.indexOf('**UI/UX DESIGN GATE**');
		const end = prompt.indexOf('**RETROSPECTIVE TRACKING**');
		expect(start).toBeGreaterThan(-1);
		expect(end).toBeGreaterThan(start);
		const slice = prompt.slice(start, end);
		expect(slice).toContain('declare_scope');
	});

	it('DELEGATION FORMAT coder example is preceded by a declare_scope reminder', () => {
		const anchor = prompt.indexOf('TASK: Add input validation to login');
		expect(anchor).toBeGreaterThan(-1);
		const preceding = prompt.slice(Math.max(0, anchor - 500), anchor);
		expect(preceding).toContain('declare_scope');
	});

	it('MODE: PLAN save_plan fallback mentions declare_scope', () => {
		const start = prompt.indexOf('If `save_plan` is unavailable');
		expect(start).toBeGreaterThan(-1);
		const slice = prompt.slice(start, start + 800);
		expect(slice).toContain('declare_scope');
	});

	it('MODE: EXECUTE Step 5b is preceded by a declare_scope pre-step', () => {
		const start = executeSkill.indexOf('5a-bis');
		const end = executeSkill.indexOf('5b. {{AGENT_PREFIX}}coder - Implement');
		expect(start).toBeGreaterThan(-1);
		expect(end).toBeGreaterThan(start);
		const slice = executeSkill.slice(start, end);
		expect(slice).toContain('declare_scope');
	});

	it('MODE: EXECUTE RETRY PROTOCOL gate-failure path has a declare_scope reminder', () => {
		const start = executeSkill.indexOf('RIGHT response to gate failure');
		expect(start).toBeGreaterThan(-1);
		const slice = executeSkill.slice(start, start + 800);
		expect(slice).toContain('declare_scope');
	});

	it('every declare_scope instruction clause uses imperative language (no advisory hedges)', () => {
		// Enforce imperative framing on each declare_scope instruction. The check
		// isolates the 120-char window centered on each `declare_scope` mention so
		// it catches hedging in the instruction itself without false-matching
		// unrelated advisory language that happens to appear elsewhere on a long
		// paragraph-style line.
		const hedges = [
			/\bconsider\b/i,
			/\bmight\b/i,
			/\bshould probably\b/i,
			/\bif you like\b/i,
		];
		const indices: number[] = [];
		let searchFrom = 0;
		while (true) {
			const next = prompt.indexOf('declare_scope', searchFrom);
			if (next === -1) break;
			indices.push(next);
			searchFrom = next + 1;
		}
		expect(indices.length).toBeGreaterThanOrEqual(8);
		for (const idx of indices) {
			const window = prompt.slice(
				Math.max(0, idx - 60),
				Math.min(prompt.length, idx + 60),
			);
			for (const hedge of hedges) {
				expect(window).not.toMatch(hedge);
			}
		}
	});

	it('declare_scope is mentioned at least 9 times in the prompt', () => {
		const matches = prompt.match(/declare_scope/g) ?? [];
		expect(matches.length).toBeGreaterThanOrEqual(9);
	});

	it('Rule 1a SCOPE DISCIPLINE covers test_engineer write delegations', () => {
		const start = prompt.indexOf('1a. SCOPE DISCIPLINE');
		expect(start).toBeGreaterThan(-1);
		const end = prompt.indexOf('2. ONE agent per message');
		expect(end).toBeGreaterThan(start);
		const slice = prompt.slice(start, end);
		expect(slice).toContain('test_engineer');
		expect(slice).toContain('declare_scope');
	});

	it('Rule 3b covers test_engineer pre-delegation scope call', () => {
		const start = prompt.indexOf('3b.');
		expect(start).toBeGreaterThan(-1);
		const slice = prompt.slice(start, start + 600);
		expect(slice).toContain('test_engineer');
		expect(slice).toContain('declare_scope');
	});
});
