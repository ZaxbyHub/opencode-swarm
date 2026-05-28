/**
 * STRUCTURAL + SMOKE TESTS for Architect and Critic agents.
 * These tests verify STRUCTURE, not exact prompt content.
 * Removed: all expect(prompt).toContain() exact string assertions.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createArchitectAgent } from '../../../src/agents/architect';
import { createCriticAgent } from '../../../src/agents/critic';

const PLAN_SKILL = readFileSync(
	join(process.cwd(), '.opencode/skills/plan/SKILL.md'),
	'utf-8',
);
const EXECUTE_SKILL = readFileSync(
	join(process.cwd(), '.opencode/skills/execute/SKILL.md'),
	'utf-8',
);
const SPECIFY_SKILL = readFileSync(
	join(process.cwd(), '.opencode/skills/specify/SKILL.md'),
	'utf-8',
);
const CLARIFY_SPEC_SKILL = readFileSync(
	join(process.cwd(), '.opencode/skills/clarify-spec/SKILL.md'),
	'utf-8',
);
const DISCOVER_SKILL = readFileSync(
	join(process.cwd(), '.opencode/skills/discover/SKILL.md'),
	'utf-8',
);
const CRITIC_GATE_SKILL = readFileSync(
	join(process.cwd(), '.opencode/skills/critic-gate/SKILL.md'),
	'utf-8',
);
const PHASE_WRAP_SKILL = readFileSync(
	join(process.cwd(), '.opencode/skills/phase-wrap/SKILL.md'),
	'utf-8',
);

// ==========================================
// ARCHITECT AGENT - SMOKE TESTS
// ==========================================

describe('Architect Agent - Creation & Basic Shape', () => {
	const agent = createArchitectAgent('test-model');

	it('returns a config object with prompt', () => {
		expect(agent).toBeDefined();
		expect(typeof agent).toBe('object');
		expect(agent.config).toBeDefined();
		expect(typeof agent.config.prompt).toBe('string');
	});

	it('prompt is substantial (>1000 chars)', () => {
		expect(agent.config.prompt!.length).toBeGreaterThan(1000);
	});
});

describe('Architect Agent - Major Section Headers', () => {
	const p = createArchitectAgent('test-model').config.prompt!;

	it('has IDENTITY, RULES, DELEGATION FORMAT, WORKFLOW, SLASH COMMANDS', () => {
		expect(p.indexOf('## IDENTITY')).toBeGreaterThan(-1);
		expect(p.indexOf('## RULES')).toBeGreaterThan(-1);
		expect(p.indexOf('## DELEGATION FORMAT')).toBeGreaterThan(-1);
		expect(p.indexOf('## WORKFLOW')).toBeGreaterThan(-1);
		expect(p.indexOf('## SLASH COMMANDS')).toBeGreaterThan(-1);
	});
});

describe('Architect Agent - All MODE Sections', () => {
	const p = createArchitectAgent('test-model').config.prompt!;

	const modes = [
		'### MODE: SPECIFY',
		'### MODE: CLARIFY-SPEC',
		'### MODE: RESUME',
		'### MODE: PLAN',
		'### MODE: CRITIC-GATE',
		'### MODE: EXECUTE',
		'### MODE: PHASE-WRAP',
	];

	modes.forEach((mode) => {
		it(`has ${mode}`, () => expect(p.indexOf(mode)).toBeGreaterThan(-1));
	});

	it('MODE sections appear in correct order', () => {
		const positions = modes.map((m) => p.indexOf(m));
		for (let i = 1; i < positions.length; i++) {
			expect(positions[i]).toBeGreaterThan(positions[i - 1]);
		}
	});
});

describe('Architect Agent - Key Structural Elements', () => {
	const p = createArchitectAgent('test-model').config.prompt!;

	it('NAMESPACE RULE before Rule 1', () => {
		expect(p.indexOf('NAMESPACE RULE')).toBeLessThan(p.indexOf('1. DELEGATE'));
	});

	it('TIERED QA GATE with STAGE A and STAGE B', () => {
		expect(p.indexOf('TIERED QA GATE')).toBeGreaterThan(-1);
		expect(p.indexOf('STAGE A: AUTOMATED TOOL GATES')).toBeGreaterThan(-1);
		expect(p.indexOf('STAGE B: AGENT REVIEW GATES')).toBeGreaterThan(-1);
		expect(p.indexOf('STAGE A: AUTOMATED TOOL GATES')).toBeLessThan(
			p.indexOf('STAGE B: AGENT REVIEW GATES'),
		);
	});

	it('HARD STOP in CRITIC-GATE', () => {
		const idx = p.indexOf('### MODE: CRITIC-GATE');
		expect(idx).toBeGreaterThan(-1);
		expect(CRITIC_GATE_SKILL).toContain('HARD STOP');
	});

	it('TASK COMPLETION GATE in EXECUTE', () => {
		const idx = p.indexOf('### MODE: EXECUTE');
		expect(p.indexOf('TASK COMPLETION GATE', idx)).toBeGreaterThan(idx);
	});

	it('RETROSPECTIVE TRACKING, RETRY PROTOCOL, FAILURE COUNTING', () => {
		expect(p.indexOf('RETROSPECTIVE TRACKING')).toBeGreaterThan(-1);
		expect((p + EXECUTE_SKILL).indexOf('RETRY PROTOCOL')).toBeGreaterThan(-1);
		expect(p.indexOf('FAILURE COUNTING')).toBeGreaterThan(-1);
	});

	it("ARCHITECT CODING BOUNDARIES with YOUR TOOLS and CODER'S TOOLS", () => {
		expect(p.indexOf('ARCHITECT CODING BOUNDARIES')).toBeGreaterThan(-1);
		expect(p.indexOf('YOUR TOOLS:')).toBeGreaterThan(-1);
		expect(p.indexOf("CODER'S TOOLS:")).toBeGreaterThan(-1);
	});

	it('CATASTROPHIC VIOLATION CHECK', () => {
		expect(PHASE_WRAP_SKILL).toContain('CATASTROPHIC VIOLATION CHECK');
	});

	it('EXPLICIT COMMAND OVERRIDE with priority 0', () => {
		expect(p.indexOf('EXPLICIT COMMAND OVERRIDE')).toBeGreaterThan(-1);
		expect(p.indexOf('priority 0')).toBeGreaterThan(-1);
	});

	it('SPEC GATE in PLAN mode', () => {
		const planIdx = p.indexOf('### MODE: PLAN');
		expect(planIdx).toBeGreaterThan(-1);
		expect(PLAN_SKILL.indexOf('SPEC GATE')).toBeGreaterThan(-1);
	});

	it('PLAN INGESTION DETECTION and STALE SPEC DETECTION', () => {
		expect(PLAN_SKILL.indexOf('PLAN INGESTION DETECTION')).toBeGreaterThan(-1);
		expect(PLAN_SKILL.indexOf('STALE SPEC DETECTION')).toBeGreaterThan(-1);
	});
});

describe('Architect Agent - Phase 5 EXECUTE Structure', () => {
	const p = createArchitectAgent('test-model').config.prompt!;

	it('EXECUTE before PHASE-WRAP with pre_check_batch', () => {
		const execIdx = p.indexOf('### MODE: EXECUTE');
		const wrapIdx = p.indexOf('### MODE: PHASE-WRAP');
		const section = p.slice(execIdx, wrapIdx) + EXECUTE_SKILL;
		expect(execIdx).toBeGreaterThan(-1);
		expect(wrapIdx).toBeGreaterThan(execIdx);
		expect(section).toContain('pre_check_batch');
	});

	it('references reviewer, security gate, and configured retry limit', () => {
		const execIdx = p.indexOf('### MODE: EXECUTE');
		const wrapIdx = p.indexOf('### MODE: PHASE-WRAP');
		const section = p.slice(execIdx, wrapIdx) + EXECUTE_SKILL;
		expect(section).toContain("the active swarm's reviewer agent");
		expect(section).toMatch(/Security gate|security.*gate/i);
		expect(section).toContain('configured QA retry limit');
	});

	it('has step 5b and reviewer step', () => {
		const execIdx = p.indexOf('### MODE: EXECUTE');
		const wrapIdx = p.indexOf('### MODE: PHASE-WRAP');
		const section = p.slice(execIdx, wrapIdx) + EXECUTE_SKILL;
		expect(section).toContain('5b.');
		expect(section).toMatch(/5j\.|reviewer/i);
	});
});

describe('Architect Agent - Phase 6 PHASE-WRAP Structure', () => {
	const p = createArchitectAgent('test-model').config.prompt!;

	it('has PHASE-WRAP section with 5.5, retrospective, CATASTROPHIC VIOLATION CHECK', () => {
		const idx = p.indexOf('### MODE: PHASE-WRAP');
		expect(idx).toBeGreaterThan(-1);
		expect(PHASE_WRAP_SKILL).toContain('5.5.');
		expect(PHASE_WRAP_SKILL).toMatch(/write.*retro|retrospective/i);
		expect(PHASE_WRAP_SKILL).toContain('CATASTROPHIC VIOLATION CHECK');
	});
});

describe('Architect Agent - Agent Delegation Patterns', () => {
	const p = createArchitectAgent('test-model').config.prompt!;

	it('uses {{AGENT_PREFIX}} pattern for reviewer, critic, coder, test_engineer', () => {
		expect(p).toContain('{{AGENT_PREFIX}}');
		expect(p).toContain('{{AGENT_PREFIX}}reviewer');
		expect(p).toContain('{{AGENT_PREFIX}}critic');
		expect(p).toContain('{{AGENT_PREFIX}}coder');
		expect(p).toContain('{{AGENT_PREFIX}}test_engineer');
	});

	it('DELEGATION FORMAT contains agent prefix pattern', () => {
		const idx = p.indexOf('## DELEGATION FORMAT');
		const next = p.indexOf('\n## ', idx + 1);
		const section = p.slice(idx, next > 0 ? next : idx + 1000);
		expect(section).toContain('{{AGENT_PREFIX}}');
	});
});

describe('Architect Agent - Tool References', () => {
	const p = createArchitectAgent('test-model').config.prompt!;

	it('references Available Tools, lint, diff, update_task_status, write_retro', () => {
		expect(p).toContain('Available Tools:');
		expect(p).toMatch(/lint|eslint|biome/i);
		expect(p).toContain('diff');
		expect(p).toContain('update_task_status');
		expect(p).toContain('write_retro');
	});
});

describe('Architect Agent - QA Gate and Anti-Rationalization', () => {
	const p = createArchitectAgent('test-model').config.prompt!;

	it('Rule 7 area with gates_passed condition', () => {
		expect(p.indexOf('7.')).toBeGreaterThan(-1);
		expect(p).toContain('gates_passed');
	});

	it('ARCHITECT CODING BOUNDARIES section is substantial', () => {
		const idx = p.indexOf('ARCHITECT CODING BOUNDARIES');
		const next = p.indexOf('\n## ', idx + 1);
		const section = p.slice(idx, next > 0 ? next : idx + 2000);
		expect(section.length).toBeGreaterThan(100);
	});

	it('uses {{QA_RETRY_LIMIT}} variable', () => {
		expect(p).toContain('{{QA_RETRY_LIMIT}}');
	});
});

describe('Architect Agent - MODE: DISCOVER Structure', () => {
	const p = createArchitectAgent('test-model').config.prompt!;

	it('has DISCOVER section with governance reference', () => {
		const idx = p.indexOf('### MODE: DISCOVER');
		expect(idx).toBeGreaterThan(-1);
		expect(DISCOVER_SKILL).toContain('governance');
	});
});

describe('Architect Agent - MODE: SPECIFY Structure', () => {
	const p = createArchitectAgent('test-model').config.prompt!;

	it('has SPECIFY with FR-, SC-, spec-archive, ARCHIVE FIRST', () => {
		const idx = p.indexOf('### MODE: SPECIFY');
		expect(idx).toBeGreaterThan(-1);
		expect(SPECIFY_SKILL).toContain('FR-');
		expect(SPECIFY_SKILL).toContain('SC-');
		expect(SPECIFY_SKILL).toContain('.swarm/spec-archive');
		expect(SPECIFY_SKILL).toContain('ARCHIVE FIRST');
	});
});

describe('Architect Agent - MODE: CLARIFY-SPEC Structure', () => {
	const p = createArchitectAgent('test-model').config.prompt!;

	it('has CLARIFY-SPEC with [NEEDS CLARIFICATION] markers', () => {
		const idx = p.indexOf('### MODE: CLARIFY-SPEC');
		expect(idx).toBeGreaterThan(-1);
		expect(CLARIFY_SPEC_SKILL).toContain('[NEEDS CLARIFICATION]');
	});
});

describe('Architect Agent - STALE SPEC DETECTION', () => {
	const p = createArchitectAgent('test-model').config.prompt!;

	it('has STALE SPEC DETECTION with 3 numbered options', () => {
		expect(p).toContain('file:.opencode/skills/plan/SKILL.md');
		const idx = PLAN_SKILL.indexOf('STALE SPEC DETECTION');
		const proceedIdx = PLAN_SKILL.indexOf('proceed with spec:', idx);
		const section = PLAN_SKILL.slice(
			idx,
			proceedIdx > 0 ? proceedIdx + 100 : idx + 600,
		);
		const count = (section.match(/^\s*\d+\.\s+\*\*/gm) || []).length;
		expect(count).toBe(3);
	});
});

describe('Architect Agent - PHASE-WRAP 5.5 drift-check', () => {
	const p = createArchitectAgent('test-model').config.prompt!;

	it('has 5.5 with DRIFT-CHECK', () => {
		const idx = p.indexOf('### MODE: PHASE-WRAP');
		expect(idx).toBeGreaterThan(-1);
		expect(PHASE_WRAP_SKILL).toContain('5.5.');
		expect(PHASE_WRAP_SKILL).toContain('DRIFT-CHECK');
	});
});

// ==========================================
// CRITIC AGENT - SMOKE TESTS
// ==========================================

describe('Critic Agent - Creation & Basic Shape', () => {
	const agent = createCriticAgent('test-model');

	it('returns a config object with prompt', () => {
		expect(agent).toBeDefined();
		expect(typeof agent).toBe('object');
		expect(agent.config).toBeDefined();
		expect(typeof agent.config.prompt).toBe('string');
	});

	it('prompt is substantial', () => {
		expect(agent.config.prompt!.length).toBeGreaterThan(100);
	});
});

describe('Critic Agent - Major Sections', () => {
	const p = createCriticAgent('test-model').config.prompt!;

	it('has PRESSURE IMMUNITY, IDENTITY, REVIEW CHECKLIST', () => {
		expect(p.indexOf('## PRESSURE IMMUNITY')).toBeGreaterThan(-1);
		expect(p.indexOf('## IDENTITY')).toBeGreaterThan(-1);
		expect(p.indexOf('## REVIEW CHECKLIST')).toBeGreaterThan(-1);
	});
});

describe('Critic Agent - Task Atomicity', () => {
	const p = createCriticAgent('test-model').config.prompt!;

	it('has Task Atomicity mentioning files', () => {
		const idx = p.indexOf('Task Atomicity');
		const next = p.indexOf('\n## ', idx + 1);
		const section = p.slice(idx, next > 0 ? next : idx + 500);
		expect(idx).toBeGreaterThan(-1);
		expect(section).toMatch(/2\+?\s*files?|\btwo.*files?/i);
	});
});

describe('Critic Agent - Review Structure', () => {
	const p = createCriticAgent('test-model').config.prompt!;

	it('has PLAN REVIEW output format with PASS/CONCERN', () => {
		expect(p).toContain('PLAN REVIEW');
		expect(p).toContain('REVIEW CHECKLIST');
		expect(p).toContain('PASS');
		expect(p).toContain('CONCERN');
	});
});
