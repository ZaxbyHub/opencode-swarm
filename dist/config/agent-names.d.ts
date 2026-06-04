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
export declare const QA_AGENTS: readonly ["reviewer", "critic", "critic_oversight"];
export declare const PIPELINE_AGENTS: readonly ["explorer", "coder", "test_engineer"];
export declare const ORCHESTRATOR_NAME: "architect";
export declare const ALL_SUBAGENT_NAMES: readonly ["sme", "docs", "docs_design", "designer", "critic_sounding_board", "critic_drift_verifier", "critic_hallucination_verifier", "critic_architecture_supervisor", "curator_init", "curator_phase", "council_generalist", "council_skeptic", "council_domain_expert", "skill_improver", "spec_writer", "reviewer", "critic", "critic_oversight", "explorer", "coder", "test_engineer"];
export declare const ALL_AGENT_NAMES: readonly ["architect", "sme", "docs", "docs_design", "designer", "critic_sounding_board", "critic_drift_verifier", "critic_hallucination_verifier", "critic_architecture_supervisor", "curator_init", "curator_phase", "council_generalist", "council_skeptic", "council_domain_expert", "skill_improver", "spec_writer", "reviewer", "critic", "critic_oversight", "explorer", "coder", "test_engineer"];
export type QAAgentName = (typeof QA_AGENTS)[number];
export type PipelineAgentName = (typeof PIPELINE_AGENTS)[number];
export type AgentName = (typeof ALL_AGENT_NAMES)[number];
