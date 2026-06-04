/**
 * Canonical agent-name registry — a DEPENDENCY-FREE leaf module.
 *
 * Extracted from constants.ts (#507) so the tool manifest can derive
 * `AGENT_TOOL_MAP` from these names without importing constants.ts (which sits
 * downstream of the manifest in the module graph). This module must import
 * NOTHING — keeping it a leaf is what prevents the manifest↔constants init cycle.
 *
 * constants.ts re-exports every symbol here, so existing
 * `import { ALL_AGENT_NAMES } from '../config/constants'` call sites are unchanged.
 */

export const QA_AGENTS = ['reviewer', 'critic', 'critic_oversight'] as const;

export const PIPELINE_AGENTS = ['explorer', 'coder', 'test_engineer'] as const;

export const ORCHESTRATOR_NAME = 'architect' as const;

export const ALL_SUBAGENT_NAMES = [
	'sme',
	'docs',
	'docs_design',
	'designer',
	'critic_sounding_board',
	'critic_drift_verifier',
	'critic_hallucination_verifier',
	'critic_architecture_supervisor',
	'curator_init',
	'curator_phase',
	'council_generalist',
	'council_skeptic',
	'council_domain_expert',
	'skill_improver',
	'spec_writer',
	...QA_AGENTS,
	...PIPELINE_AGENTS,
] as const;

export const ALL_AGENT_NAMES = [
	ORCHESTRATOR_NAME,
	...ALL_SUBAGENT_NAMES,
] as const;

export type QAAgentName = (typeof QA_AGENTS)[number];
export type PipelineAgentName = (typeof PIPELINE_AGENTS)[number];
export type AgentName = (typeof ALL_AGENT_NAMES)[number];
