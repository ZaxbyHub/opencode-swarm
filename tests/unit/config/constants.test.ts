import { describe, expect, it } from 'bun:test';
import {
	AGENT_TOOL_MAP,
	ALL_AGENT_NAMES,
	ALL_SUBAGENT_NAMES,
	CLAUDE_CODE_NATIVE_COMMANDS,
	DEFAULT_MODELS,
	EXTERNAL_SKILL_AGENT_TOOL_MAP,
	isQAAgent,
	isSubagent,
	MEMORY_AGENT_TOOL_MAP,
	ORCHESTRATOR_NAME,
	PIPELINE_AGENTS,
	QA_AGENTS,
} from '../../../src/config/constants';
import { TOOL_NAMES } from '../../../src/tools/tool-names';

describe('constants.ts', () => {
	describe('QA_AGENTS', () => {
		it('contains reviewer, critic, and critic_oversight (3 total)', () => {
			expect(QA_AGENTS).toContain('reviewer');
			expect(QA_AGENTS).toContain('critic');
			expect(QA_AGENTS).toContain('critic_oversight');
			expect(QA_AGENTS).toHaveLength(3);
		});
	});

	describe('PIPELINE_AGENTS', () => {
		it('contains exactly explorer, coder, and test_engineer', () => {
			expect(PIPELINE_AGENTS).toEqual(['explorer', 'coder', 'test_engineer']);
			expect(PIPELINE_AGENTS).toHaveLength(3);
		});
	});

	describe('ALL_SUBAGENT_NAMES', () => {
		it('contains all 22 subagents (sme + researcher + docs + critics + curators + council + qa + pipeline)', () => {
			// v6.1: added docs (default enabled) and designer (opt-in); v6.34: added critic_sounding_board; v6.36.0: added critic_drift_verifier; v6.42.1: added curator_init + curator_phase; v6.x.x: added critic_oversight; v7.0.2: council_member/moderator → council_generalist/skeptic/domain_expert; feat: +researcher
			expect(ALL_SUBAGENT_NAMES).toContain('sme');
			expect(ALL_SUBAGENT_NAMES).toContain('researcher');
			expect(ALL_SUBAGENT_NAMES).toContain('docs');
			expect(ALL_SUBAGENT_NAMES).toContain('docs_design');
			expect(ALL_SUBAGENT_NAMES).toContain('designer');
			expect(ALL_SUBAGENT_NAMES).toContain('critic_sounding_board');
			expect(ALL_SUBAGENT_NAMES).toContain('critic_drift_verifier');
			expect(ALL_SUBAGENT_NAMES).toContain('critic_hallucination_verifier');
			expect(ALL_SUBAGENT_NAMES).toContain('curator_init');
			expect(ALL_SUBAGENT_NAMES).toContain('curator_phase');
			expect(ALL_SUBAGENT_NAMES).toContain('reviewer');
			expect(ALL_SUBAGENT_NAMES).toContain('critic');
			expect(ALL_SUBAGENT_NAMES).toContain('critic_oversight');
			expect(ALL_SUBAGENT_NAMES).toContain('explorer');
			expect(ALL_SUBAGENT_NAMES).toContain('coder');
			expect(ALL_SUBAGENT_NAMES).toContain('test_engineer');
			expect(ALL_SUBAGENT_NAMES).toContain('council_generalist');
			expect(ALL_SUBAGENT_NAMES).toContain('council_skeptic');
			expect(ALL_SUBAGENT_NAMES).toContain('council_domain_expert');
			expect(ALL_SUBAGENT_NAMES).toContain('skill_improver');
			expect(ALL_SUBAGENT_NAMES).toContain('spec_writer');
			expect(ALL_SUBAGENT_NAMES).toContain('critic_architecture_supervisor');
			expect(ALL_SUBAGENT_NAMES).toHaveLength(22);
		});
	});

	describe('ALL_AGENT_NAMES', () => {
		it('contains architect + all 22 subagents = 23 total', () => {
			// v6.1: added docs and designer; v6.34: added critic_sounding_board; v6.36.0: added critic_drift_verifier; v6.42.1: added curator_init + curator_phase; v6.x.x: added critic_oversight; v6.72.x: added critic_hallucination_verifier; v7.0.2: council_member/moderator → council_generalist/skeptic/domain_expert; v7.10.0: +skill_improver +spec_writer; feat: +researcher
			// architect must be first — it is the orchestrator and must be listed before all subagents
			expect(ALL_AGENT_NAMES[0]).toBe('architect');
			// All subagents must be present
			for (const name of ALL_SUBAGENT_NAMES) {
				expect(ALL_AGENT_NAMES).toContain(name);
			}
			expect(ALL_AGENT_NAMES).toHaveLength(23);
		});
	});

	describe('ORCHESTRATOR_NAME', () => {
		it("is 'architect'", () => {
			expect(ORCHESTRATOR_NAME).toBe('architect');
		});
	});

	describe('isQAAgent()', () => {
		it('returns true for reviewer and critic', () => {
			expect(isQAAgent('reviewer')).toBe(true);
			expect(isQAAgent('critic')).toBe(true);
		});

		it('returns false for non-QA agents', () => {
			expect(isQAAgent('coder')).toBe(false);
			expect(isQAAgent('explorer')).toBe(false);
			expect(isQAAgent('architect')).toBe(false);
			expect(isQAAgent('sme')).toBe(false);
			expect(isQAAgent('test_engineer')).toBe(false);
		});
	});

	describe('isSubagent()', () => {
		it('returns true for all 21 subagent names', () => {
			expect(isSubagent('sme')).toBe(true);
			expect(isSubagent('docs')).toBe(true);
			expect(isSubagent('docs_design')).toBe(true);
			expect(isSubagent('designer')).toBe(true);
			expect(isSubagent('critic_sounding_board')).toBe(true);
			expect(isSubagent('critic_drift_verifier')).toBe(true);
			expect(isSubagent('critic_hallucination_verifier')).toBe(true);
			expect(isSubagent('critic_architecture_supervisor')).toBe(true);
			expect(isSubagent('curator_init')).toBe(true);
			expect(isSubagent('curator_phase')).toBe(true);
			expect(isSubagent('reviewer')).toBe(true);
			expect(isSubagent('critic')).toBe(true);
			expect(isSubagent('critic_oversight')).toBe(true);
			expect(isSubagent('explorer')).toBe(true);
			expect(isSubagent('coder')).toBe(true);
			expect(isSubagent('test_engineer')).toBe(true);
			expect(isSubagent('council_generalist')).toBe(true);
			expect(isSubagent('council_skeptic')).toBe(true);
			expect(isSubagent('council_domain_expert')).toBe(true);
			expect(isSubagent('skill_improver')).toBe(true);
			expect(isSubagent('spec_writer')).toBe(true);
		});

		it('returns false for architect', () => {
			expect(isSubagent('architect')).toBe(false);
		});

		it('returns false for arbitrary strings', () => {
			expect(isSubagent('unknown')).toBe(false);
			expect(isSubagent('')).toBe(false);
			expect(isSubagent('fake_agent')).toBe(false);
		});
	});

	describe('DEFAULT_MODELS', () => {
		it('has entries for all agents in ALL_AGENT_NAMES', () => {
			// v6.14: architect intentionally omitted from DEFAULT_MODELS (inherits OpenCode UI selection)
			// v7.0.2: council_generalist/skeptic/domain_expert intentionally omitted — they source models
			// from agents.reviewer/critic/sme config entries, not their own DEFAULT_MODELS key
			const NO_DEFAULT_MODEL = new Set([
				'architect',
				'council_generalist',
				'council_skeptic',
				'council_domain_expert',
			]);
			for (const agent of ALL_AGENT_NAMES) {
				if (NO_DEFAULT_MODEL.has(agent)) continue;
				expect(DEFAULT_MODELS).toHaveProperty(agent);
				expect(typeof DEFAULT_MODELS[agent]).toBe('string');
			}
		});

		it('has a default fallback entry', () => {
			expect(DEFAULT_MODELS).toHaveProperty('default');
			expect(typeof DEFAULT_MODELS.default).toBe('string');
		});

		it('all values are non-empty strings', () => {
			for (const [agent, model] of Object.entries(DEFAULT_MODELS)) {
				expect(typeof model).toBe('string');
				expect(model.length).toBeGreaterThan(0);
			}
		});

		it('has exactly 20 entries (subagents + default, no architect or council role-agents)', () => {
			// v6.14: architect removed; v6.36.0: +critic_drift_verifier; v6.42.1: +curator_init/phase; v6.x.x: +critic_oversight; v6.72.x: +critic_hallucination_verifier; v7.0.2: council_member/moderator removed (council agents use reviewer/critic/sme model keys instead); v7.10.0: +skill_improver +spec_writer; #893: +critic_architecture_supervisor; feat: +researcher
			expect(Object.keys(DEFAULT_MODELS)).toHaveLength(20);
		});
	});

	describe('AGENT_TOOL_MAP registry coherence', () => {
		it('every tool in TOOL_NAMES is assigned to a default or opt-in agent map', () => {
			const assignedTools = new Set<string>();
			for (const tools of Object.values(AGENT_TOOL_MAP)) {
				for (const tool of tools) assignedTools.add(tool);
			}
			for (const tools of Object.values(MEMORY_AGENT_TOOL_MAP)) {
				for (const tool of tools) assignedTools.add(tool);
			}
			for (const tools of Object.values(EXTERNAL_SKILL_AGENT_TOOL_MAP)) {
				if (tools) for (const tool of tools) assignedTools.add(tool);
			}
			for (const tool of TOOL_NAMES) {
				expect(assignedTools.has(tool)).toBe(true);
			}
		});
	});

	describe('CLAUDE_CODE_NATIVE_COMMANDS', () => {
		it('includes plan and reset (known conflicting CC commands)', () => {
			expect(CLAUDE_CODE_NATIVE_COMMANDS.has('plan')).toBe(true);
			expect(CLAUDE_CODE_NATIVE_COMMANDS.has('reset')).toBe(true);
		});

		it('includes known documented CC built-in commands', () => {
			// Critical commands that must always be present
			const requiredCommands = [
				'clear',
				'compact',
				'config',
				'diff',
				'doctor',
				'export',
				'help',
				'init',
				'memory',
				'model',
				'plan',
				'reset',
				'status',
				'review',
				'security-review',
				'agents',
				'history',
				'checkpoint',
				'rewind',
				'undo',
				'rename',
				'resume',
				'fork',
				'permissions',
				'plugin',
			];
			for (const cmd of requiredCommands) {
				expect(CLAUDE_CODE_NATIVE_COMMANDS.has(cmd)).toBe(true);
			}
		});

		it('is a frozen ReadonlySet', () => {
			const size = CLAUDE_CODE_NATIVE_COMMANDS.size;
			expect(() =>
				(CLAUDE_CODE_NATIVE_COMMANDS as Set<string>).add('test'),
			).toThrow();
			// Verify size unchanged after attempted mutation
			expect(CLAUDE_CODE_NATIVE_COMMANDS.size).toBe(size);
		});

		it('has at least 80 entries (comprehensive command coverage)', () => {
			expect(CLAUDE_CODE_NATIVE_COMMANDS.size).toBeGreaterThanOrEqual(80);
		});

		it('does not contain undefined (sanity check)', () => {
			expect(
				CLAUDE_CODE_NATIVE_COMMANDS.has(undefined as unknown as string),
			).toBe(false);
		});
	});
});
