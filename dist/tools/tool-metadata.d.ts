/**
 * Tool METADATA - the single source of truth for every tool's name, description,
 * and default agents. Handler wiring lives in ./manifest.ts.
 *
 * This module imports NO tool handler modules. That is deliberate: constants.ts
 * and tool-names.ts (and a few tool modules, e.g. completion-verify) derive from
 * here, and they are transitively imported by tool modules. If this file imported
 * the handler-bearing manifest, every constants.ts consumer would pull all 82 tool
 * modules and form an init cycle (#507 CI finding). Keeping metadata handler-free
 * makes the module graph acyclic.
 *
 * Cross-checked with ./manifest.ts: that file does
 * `satisfies Record<ToolName, () => ToolDefinition>` with `ToolName = keyof typeof
 * TOOL_METADATA`, so adding a tool here without wiring a handler there (or vice
 * versa) is a COMPILE error - the dead-tools bug class stays impossible.
 */
import { type AgentName } from '../config/agent-names';
/** A tool's registration metadata. All fields required so a missing one is a compile error. */
export interface ToolMeta {
    /** Human-readable description surfaced to agents (TOOL_DESCRIPTIONS). */
    description: string;
    /** Agents granted this tool by default (inverted into AGENT_TOOL_MAP). Empty = overlay-only. */
    agents: AgentName[];
}
/**
 * The registry metadata. Keys are the canonical tool names; `ToolName` derives
 * from them (the keys ARE the name set).
 */
export declare const TOOL_METADATA: {
    diff: {
        description: string;
        agents: ("reviewer" | "test_engineer" | "coder" | "critic_oversight" | "architect")[];
    };
    diff_summary: {
        description: string;
        agents: ("reviewer" | "critic_oversight" | "architect")[];
    };
    syntax_check: {
        description: string;
        agents: ("test_engineer" | "coder" | "architect")[];
    };
    placeholder_scan: {
        description: string;
        agents: ("reviewer" | "architect")[];
    };
    imports: {
        description: string;
        agents: ("reviewer" | "test_engineer" | "coder" | "docs" | "explorer" | "sme" | "critic" | "critic_oversight" | "architect" | "docs_design" | "critic_sounding_board" | "critic_drift_verifier" | "critic_hallucination_verifier")[];
    };
    lint: {
        description: string;
        agents: ("reviewer" | "coder" | "architect")[];
    };
    secretscan: {
        description: string;
        agents: ("reviewer" | "critic_oversight" | "architect")[];
    };
    sast_scan: {
        description: string;
        agents: ("reviewer" | "critic_oversight" | "architect")[];
    };
    build_check: {
        description: string;
        agents: ("test_engineer" | "coder" | "architect")[];
    };
    pre_check_batch: {
        description: string;
        agents: ("reviewer" | "architect")[];
    };
    quality_budget: {
        description: string;
        agents: "architect"[];
    };
    symbols: {
        description: string;
        agents: ("reviewer" | "test_engineer" | "coder" | "docs" | "designer" | "explorer" | "sme" | "critic" | "critic_oversight" | "architect" | "docs_design" | "critic_sounding_board" | "critic_drift_verifier" | "critic_hallucination_verifier" | "spec_writer")[];
    };
    complexity_hotspots: {
        description: string;
        agents: ("reviewer" | "test_engineer" | "explorer" | "sme" | "critic" | "critic_oversight" | "architect" | "critic_sounding_board" | "critic_drift_verifier" | "critic_hallucination_verifier")[];
    };
    schema_drift: {
        description: string;
        agents: ("docs" | "explorer" | "sme" | "architect")[];
    };
    todo_extract: {
        description: string;
        agents: ("docs" | "explorer" | "architect")[];
    };
    evidence_check: {
        description: string;
        agents: ("critic_oversight" | "architect")[];
    };
    check_gate_status: {
        description: string;
        agents: ("critic_oversight" | "architect")[];
    };
    completion_verify: {
        description: string;
        agents: ("critic_oversight" | "architect")[];
    };
    submit_council_verdicts: {
        description: string;
        agents: "architect"[];
    };
    submit_phase_council_verdicts: {
        description: string;
        agents: "architect"[];
    };
    declare_council_criteria: {
        description: string;
        agents: "architect"[];
    };
    sbom_generate: {
        description: string;
        agents: "architect"[];
    };
    checkpoint: {
        description: string;
        agents: "architect"[];
    };
    pkg_audit: {
        description: string;
        agents: ("reviewer" | "test_engineer" | "critic_oversight" | "architect" | "critic_hallucination_verifier")[];
    };
    test_runner: {
        description: string;
        agents: ("reviewer" | "test_engineer" | "architect")[];
    };
    test_impact: {
        description: string;
        agents: ("reviewer" | "test_engineer" | "critic_oversight" | "architect")[];
    };
    mutation_test: {
        description: string;
        agents: ("test_engineer" | "architect")[];
    };
    generate_mutants: {
        description: string;
        agents: "architect"[];
    };
    detect_domains: {
        description: string;
        agents: ("docs" | "explorer" | "sme" | "critic" | "critic_oversight" | "architect" | "docs_design" | "critic_sounding_board" | "critic_drift_verifier" | "critic_hallucination_verifier")[];
    };
    gitingest: {
        description: string;
        agents: ("docs" | "explorer" | "architect")[];
    };
    retrieve_summary: {
        description: string;
        agents: ("reviewer" | "test_engineer" | "coder" | "docs" | "designer" | "explorer" | "sme" | "critic" | "critic_oversight" | "architect" | "docs_design" | "critic_sounding_board" | "critic_drift_verifier" | "critic_hallucination_verifier" | "critic_architecture_supervisor" | "spec_writer")[];
    };
    extract_code_blocks: {
        description: string;
        agents: ("reviewer" | "test_engineer" | "coder" | "docs" | "designer" | "explorer" | "sme" | "architect" | "docs_design" | "spec_writer")[];
    };
    phase_complete: {
        description: string;
        agents: "architect"[];
    };
    save_plan: {
        description: string;
        agents: "architect"[];
    };
    update_task_status: {
        description: string;
        agents: "architect"[];
    };
    lint_spec: {
        description: string;
        agents: ("architect" | "spec_writer")[];
    };
    write_retro: {
        description: string;
        agents: "architect"[];
    };
    write_drift_evidence: {
        description: string;
        agents: "architect"[];
    };
    write_hallucination_evidence: {
        description: string;
        agents: "architect"[];
    };
    write_mutation_evidence: {
        description: string;
        agents: "architect"[];
    };
    declare_scope: {
        description: string;
        agents: "architect"[];
    };
    knowledge_query: {
        description: string;
        agents: ("architect" | "skill_improver" | "spec_writer")[];
    };
    doc_scan: {
        description: string;
        agents: ("explorer" | "architect" | "docs_design" | "skill_improver" | "spec_writer")[];
    };
    doc_extract: {
        description: string;
        agents: ("architect" | "docs_design" | "skill_improver" | "spec_writer")[];
    };
    curator_analyze: {
        description: string;
        agents: "architect"[];
    };
    knowledge_add: {
        description: string;
        agents: ("coder" | "architect")[];
    };
    knowledge_recall: {
        description: string;
        agents: ("reviewer" | "test_engineer" | "coder" | "docs" | "designer" | "explorer" | "sme" | "critic" | "critic_oversight" | "architect" | "docs_design" | "critic_sounding_board" | "critic_drift_verifier" | "critic_hallucination_verifier" | "critic_architecture_supervisor" | "curator_init" | "curator_phase" | "skill_improver" | "spec_writer")[];
    };
    knowledge_remove: {
        description: string;
        agents: "architect"[];
    };
    co_change_analyzer: {
        description: string;
        agents: "architect"[];
    };
    search: {
        description: string;
        agents: ("reviewer" | "test_engineer" | "coder" | "docs" | "designer" | "explorer" | "sme" | "critic_oversight" | "architect" | "docs_design" | "critic_hallucination_verifier" | "skill_improver" | "spec_writer")[];
    };
    batch_symbols: {
        description: string;
        agents: ("reviewer" | "explorer" | "critic_oversight" | "architect" | "critic_hallucination_verifier")[];
    };
    suggest_patch: {
        description: string;
        agents: ("reviewer" | "architect")[];
    };
    req_coverage: {
        description: string;
        agents: ("critic" | "critic_oversight" | "critic_sounding_board" | "critic_drift_verifier" | "critic_hallucination_verifier" | "spec_writer")[];
    };
    get_approved_plan: {
        description: string;
        agents: ("critic" | "critic_oversight" | "critic_drift_verifier")[];
    };
    repo_map: {
        description: string;
        agents: ("reviewer" | "coder" | "explorer" | "critic" | "critic_oversight" | "architect" | "critic_sounding_board" | "critic_drift_verifier" | "critic_hallucination_verifier" | "critic_architecture_supervisor")[];
    };
    get_qa_gate_profile: {
        description: string;
        agents: "architect"[];
    };
    set_qa_gates: {
        description: string;
        agents: "architect"[];
    };
    web_search: {
        description: string;
        agents: ("architect" | "skill_improver")[];
    };
    convene_general_council: {
        description: string;
        agents: "architect"[];
    };
    write_final_council_evidence: {
        description: string;
        agents: "architect"[];
    };
    skill_generate: {
        description: string;
        agents: ("architect" | "skill_improver")[];
    };
    skill_list: {
        description: string;
        agents: ("architect" | "skill_improver")[];
    };
    skill_apply: {
        description: string;
        agents: "architect"[];
    };
    skill_inspect: {
        description: string;
        agents: ("architect" | "skill_improver")[];
    };
    skill_regenerate: {
        description: string;
        agents: "architect"[];
    };
    skill_retire: {
        description: string;
        agents: "architect"[];
    };
    skill_improve: {
        description: string;
        agents: ("architect" | "skill_improver")[];
    };
    spec_write: {
        description: string;
        agents: "spec_writer"[];
    };
    knowledge_ack: {
        description: string;
        agents: "architect"[];
    };
    knowledge_receipt: {
        description: string;
        agents: ("coder" | "architect")[];
    };
    knowledge_archive: {
        description: string;
        agents: "architect"[];
    };
    swarm_memory_recall: {
        description: string;
        agents: never[];
    };
    swarm_memory_propose: {
        description: string;
        agents: never[];
    };
    swarm_command: {
        description: string;
        agents: ("reviewer" | "test_engineer" | "coder" | "docs" | "designer" | "explorer" | "sme" | "critic" | "architect" | "docs_design")[];
    };
    summarize_work: {
        description: string;
        agents: ("test_engineer" | "coder" | "docs" | "designer" | "explorer" | "sme" | "architect" | "docs_design")[];
    };
    write_architecture_supervisor_evidence: {
        description: string;
        agents: "architect"[];
    };
    lean_turbo_plan_lanes: {
        description: string;
        agents: "architect"[];
    };
    lean_turbo_acquire_locks: {
        description: string;
        agents: "architect"[];
    };
    lean_turbo_runner_status: {
        description: string;
        agents: "architect"[];
    };
    lean_turbo_review: {
        description: string;
        agents: "architect"[];
    };
    lean_turbo_run_phase: {
        description: string;
        agents: "architect"[];
    };
    lean_turbo_status: {
        description: string;
        agents: "architect"[];
    };
    apply_patch: {
        description: string;
        agents: "coder"[];
    };
};
/** Union type of all valid tool names (the metadata keys). */
export type ToolName = keyof typeof TOOL_METADATA;
/** Readonly array of all tool names, in metadata declaration order. */
export declare const TOOL_NAMES: readonly ToolName[];
/** Set for O(1) tool name validation. */
export declare const TOOL_NAME_SET: ReadonlySet<ToolName>;
/** Human-readable descriptions, keyed by tool name. */
export declare const TOOL_DESCRIPTIONS: Partial<Record<ToolName, string>>;
/**
 * Default tool permissions per agent, inverted from each tool's `agents` list.
 * All agent names are initialized (agents with no tools keep an empty array, e.g.
 * the council members). Tools with `agents: []` (the memory tools) stay OUT of
 * this map and are applied only via MEMORY_AGENT_TOOL_MAP.
 */
export declare const AGENT_TOOL_MAP: Record<AgentName, ToolName[]>;
