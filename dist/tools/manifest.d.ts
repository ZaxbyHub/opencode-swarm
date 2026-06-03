/**
 * Tool manifest - HANDLER wiring for every tool. The registration METADATA
 * (names, descriptions, agents) lives in ./tool-metadata.ts.
 *
 * The `defineHandlers` helper below constrains its argument to
 * `Record<ToolName, () => ToolDefinition>` (ToolName = keyof typeof TOOL_METADATA),
 * which makes this map exhaustive: every metadata entry MUST have a handler here,
 * or it is a COMPILE error. That, plus the required fields in ToolMeta, keeps the
 * dead-tools bug class impossible while the two files stay decoupled (this one
 * imports handlers; metadata imports none). A stray handler key (no metadata) is
 * caught at runtime by scripts/check-tool-registration.ts.
 *
 * Handlers are stored as lazy thunks (`() => tool`) so this object never reads a
 * handler binding during module evaluation - safe inside import cycles. Resolve
 * via buildPluginToolObject (src/tools/plugin-registration.ts), never at module
 * top level. swarm_command uses its static (no-DI) handler here; the real
 * dependency-injected instance is applied in buildPluginToolObject.
 *
 * Adding a tool: add a ./tool-metadata.ts entry AND a handler here (both compile-
 * checked). Async-init tools would need a factory + async consumers, conflicting
 * with the synchronous bounded plugin-init contract (AGENTS.md #1); runtime-
 * conditional tools would need a `runtime` field + a buildPluginToolObject filter.
 * Neither is implemented (no current tool needs them). Not tree-shakeable.
 */
import type { ToolDefinition } from '@opencode-ai/plugin/tool';
export declare const TOOL_MANIFEST: {
    diff: () => ToolDefinition;
    diff_summary: () => ToolDefinition;
    syntax_check: () => ToolDefinition;
    placeholder_scan: () => ToolDefinition;
    imports: () => ToolDefinition;
    lint: () => ToolDefinition;
    secretscan: () => ToolDefinition;
    sast_scan: () => ToolDefinition;
    build_check: () => ToolDefinition;
    pre_check_batch: () => ToolDefinition;
    quality_budget: () => ToolDefinition;
    symbols: () => ToolDefinition;
    complexity_hotspots: () => ToolDefinition;
    schema_drift: () => ToolDefinition;
    todo_extract: () => ToolDefinition;
    evidence_check: () => ToolDefinition;
    check_gate_status: () => ToolDefinition;
    completion_verify: () => ToolDefinition;
    submit_council_verdicts: () => ToolDefinition;
    submit_phase_council_verdicts: () => ToolDefinition;
    declare_council_criteria: () => ToolDefinition;
    sbom_generate: () => ToolDefinition;
    checkpoint: () => ToolDefinition;
    pkg_audit: () => ToolDefinition;
    test_runner: () => ToolDefinition;
    test_impact: () => ToolDefinition;
    mutation_test: () => ToolDefinition;
    generate_mutants: () => ToolDefinition;
    detect_domains: () => ToolDefinition;
    gitingest: () => ToolDefinition;
    retrieve_summary: () => ToolDefinition;
    extract_code_blocks: () => ToolDefinition;
    phase_complete: () => ToolDefinition;
    save_plan: () => ToolDefinition;
    update_task_status: () => ToolDefinition;
    lint_spec: () => ToolDefinition;
    write_retro: () => ToolDefinition;
    write_drift_evidence: () => ToolDefinition;
    write_hallucination_evidence: () => ToolDefinition;
    write_mutation_evidence: () => ToolDefinition;
    declare_scope: () => ToolDefinition;
    knowledge_query: () => ToolDefinition;
    doc_scan: () => ToolDefinition;
    doc_extract: () => ToolDefinition;
    curator_analyze: () => ToolDefinition;
    knowledge_add: () => ToolDefinition;
    knowledge_recall: () => ToolDefinition;
    knowledge_remove: () => ToolDefinition;
    co_change_analyzer: () => ToolDefinition;
    search: () => ToolDefinition;
    batch_symbols: () => ToolDefinition;
    suggest_patch: () => ToolDefinition;
    req_coverage: () => ToolDefinition;
    get_approved_plan: () => ToolDefinition;
    repo_map: () => ToolDefinition;
    get_qa_gate_profile: () => ToolDefinition;
    set_qa_gates: () => ToolDefinition;
    web_search: () => ToolDefinition;
    convene_general_council: () => ToolDefinition;
    write_final_council_evidence: () => ToolDefinition;
    skill_generate: () => ToolDefinition;
    skill_list: () => ToolDefinition;
    skill_apply: () => ToolDefinition;
    skill_inspect: () => ToolDefinition;
    skill_regenerate: () => ToolDefinition;
    skill_retire: () => ToolDefinition;
    skill_improve: () => ToolDefinition;
    spec_write: () => ToolDefinition;
    knowledge_ack: () => ToolDefinition;
    knowledge_receipt: () => ToolDefinition;
    knowledge_archive: () => ToolDefinition;
    swarm_memory_recall: () => ToolDefinition;
    swarm_memory_propose: () => ToolDefinition;
    swarm_command: () => ToolDefinition;
    summarize_work: () => ToolDefinition;
    write_architecture_supervisor_evidence: () => ToolDefinition;
    lean_turbo_plan_lanes: () => ToolDefinition;
    lean_turbo_acquire_locks: () => ToolDefinition;
    lean_turbo_runner_status: () => ToolDefinition;
    lean_turbo_review: () => ToolDefinition;
    lean_turbo_run_phase: () => ToolDefinition;
    lean_turbo_status: () => ToolDefinition;
};
