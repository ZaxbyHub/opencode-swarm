/**
 * Central registry of all tool names used by the swarm.
 * Used for constants and agent setup references.
 */
/** Union type of all valid tool names */
export type ToolName = 'diff' | 'diff_summary' | 'syntax_check' | 'placeholder_scan' | 'imports' | 'lint' | 'secretscan' | 'sast_scan' | 'build_check' | 'pre_check_batch' | 'quality_budget' | 'symbols' | 'complexity_hotspots' | 'schema_drift' | 'todo_extract' | 'evidence_check' | 'check_gate_status' | 'completion_verify' | 'submit_council_verdicts' | 'submit_phase_council_verdicts' | 'declare_council_criteria' | 'sbom_generate' | 'checkpoint' | 'pkg_audit' | 'test_runner' | 'test_impact' | 'mutation_test' | 'generate_mutants' | 'detect_domains' | 'gitingest' | 'retrieve_summary' | 'extract_code_blocks' | 'phase_complete' | 'save_plan' | 'update_task_status' | 'lint_spec' | 'write_retro' | 'write_drift_evidence' | 'write_hallucination_evidence' | 'write_mutation_evidence' | 'declare_scope' | 'knowledge_query' | 'doc_scan' | 'doc_extract' | 'curator_analyze' | 'knowledge_add' | 'knowledge_recall' | 'knowledge_remove' | 'co_change_analyzer' | 'search' | 'batch_symbols' | 'suggest_patch' | 'req_coverage' | 'get_approved_plan' | 'repo_map' | 'get_qa_gate_profile' | 'set_qa_gates' | 'web_search' | 'convene_general_council' | 'write_final_council_evidence' | 'skill_generate' | 'skill_list' | 'skill_apply' | 'skill_inspect' | 'skill_improve' | 'spec_write' | 'knowledge_ack' | 'swarm_memory_recall' | 'swarm_memory_propose' | 'swarm_command' | 'lean_turbo_plan_lanes' | 'lean_turbo_acquire_locks' | 'lean_turbo_runner_status' | 'lean_turbo_review' | 'lean_turbo_run_phase' | 'lean_turbo_status';
/** Readonly array of all tool names */
export declare const TOOL_NAMES: readonly ToolName[];
/** Set for O(1) tool name validation */
export declare const TOOL_NAME_SET: ReadonlySet<ToolName>;
