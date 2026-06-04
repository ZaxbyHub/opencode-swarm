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
import { applyPatch } from './apply-patch';
import { batch_symbols } from './batch-symbols';
import { build_check } from './build-check';
import { check_gate_status } from './check-gate-status';
import { checkpoint } from './checkpoint';
import { co_change_analyzer } from './co-change-analyzer';
import { completion_verify } from './completion-verify';
import { complexity_hotspots } from './complexity-hotspots';
import { submit_council_verdicts } from './convene-council';
import { convene_general_council } from './convene-general-council';
import { curator_analyze } from './curator-analyze';
import { declare_council_criteria } from './declare-council-criteria';
import { declare_scope } from './declare-scope';
import { diff } from './diff';
import { diff_summary } from './diff-summary';
import { doc_extract, doc_scan } from './doc-scan';
import { detect_domains } from './domain-detector';
import { evidence_check } from './evidence-check';
import { extract_code_blocks } from './file-extractor';
import { generate_mutants } from './generate-mutants';
import { get_approved_plan } from './get-approved-plan';
import { get_qa_gate_profile } from './get-qa-gate-profile';
import { gitingest } from './gitingest';
import { imports } from './imports';
import { knowledge_ack } from './knowledge-ack';
import { knowledge_add } from './knowledge-add';
import { knowledge_archive } from './knowledge-archive';
import { knowledge_query } from './knowledge-query';
import { knowledge_recall } from './knowledge-recall';
import { knowledge_receipt } from './knowledge-receipt';
import { knowledge_remove } from './knowledge-remove';
import { lean_turbo_acquire_locks } from './lean-turbo-acquire-locks';
import { lean_turbo_plan_lanes } from './lean-turbo-plan-lanes';
import { lean_turbo_review } from './lean-turbo-review';
import { lean_turbo_run_phase } from './lean-turbo-run-phase';
import { lean_turbo_runner_status } from './lean-turbo-runner-status';
import { lean_turbo_status } from './lean-turbo-status';
import { lint } from './lint';
import { lint_spec } from './lint-spec';
import { mutation_test } from './mutation-test';
import { phase_complete } from './phase-complete';
import { pkg_audit } from './pkg-audit';
import { placeholder_scan } from './placeholder-scan';
import { pre_check_batch } from './pre-check-batch';
import { quality_budget } from './quality-budget';
import { repo_map } from './repo-map';
import { req_coverage } from './req-coverage';
import { retrieve_summary } from './retrieve-summary';
import { sast_scan } from './sast-scan';
import { save_plan } from './save-plan';
import { sbom_generate } from './sbom-generate';
import { schema_drift } from './schema-drift';
import { search } from './search';
import { secretscan } from './secretscan';
import { set_qa_gates } from './set-qa-gates';
import { skill_apply } from './skill-apply';
import { skill_generate } from './skill-generate';
import { skill_improve } from './skill-improve';
import { skill_inspect } from './skill-inspect';
import { skill_list } from './skill-list';
import { skill_regenerate } from './skill-regenerate';
import { skill_retire } from './skill-retire';
import { spec_write } from './spec-write';
import { submit_phase_council_verdicts } from './submit-phase-council-verdicts';
import { suggestPatch } from './suggest-patch';
import { summarize_work } from './summarize-work';
import { swarm_command } from './swarm-command';
import { swarm_memory_propose } from './swarm-memory-propose';
import { swarm_memory_recall } from './swarm-memory-recall';
import { symbols } from './symbols';
import { syntax_check } from './syntax-check';
import { test_impact } from './test-impact';
import { test_runner } from './test-runner';
import { todo_extract } from './todo-extract';
import type { ToolName } from './tool-metadata';
import { update_task_status } from './update-task-status';
import { web_search } from './web-search';
import { write_architecture_supervisor_evidence } from './write-architecture-supervisor-evidence';
import { write_drift_evidence } from './write-drift-evidence';
import { write_final_council_evidence } from './write-final-council-evidence';
import { write_hallucination_evidence } from './write-hallucination-evidence';
import { write_mutation_evidence } from './write-mutation-evidence';
import { write_retro } from './write-retro';

/**
 * Identity helper: enforces an exhaustive `ToolName -> thunk` map via the
 * constraint while widening emitted value types to `() => ToolDefinition` (keeps
 * dist/*.d.ts portable - avoids TS2742 from each handler's zod generics).
 */
function defineHandlers<T extends Record<ToolName, () => ToolDefinition>>(
	handlers: T,
): { [K in keyof T]: () => ToolDefinition } {
	// The constraint enforces an exhaustive ToolName -> thunk map; the cast widens
	// each thunk's specific (zod-generic) return to ToolDefinition for a portable
	// declaration (TS cannot auto-prove the generic mapped assignment here).
	return handlers as { [K in keyof T]: () => ToolDefinition };
}

export const TOOL_MANIFEST = defineHandlers({
	diff: () => diff,
	diff_summary: () => diff_summary,
	syntax_check: () => syntax_check,
	placeholder_scan: () => placeholder_scan,
	imports: () => imports,
	lint: () => lint,
	secretscan: () => secretscan,
	sast_scan: () => sast_scan,
	build_check: () => build_check,
	pre_check_batch: () => pre_check_batch,
	quality_budget: () => quality_budget,
	symbols: () => symbols,
	complexity_hotspots: () => complexity_hotspots,
	schema_drift: () => schema_drift,
	todo_extract: () => todo_extract,
	evidence_check: () => evidence_check,
	check_gate_status: () => check_gate_status,
	completion_verify: () => completion_verify,
	submit_council_verdicts: () => submit_council_verdicts,
	submit_phase_council_verdicts: () => submit_phase_council_verdicts,
	declare_council_criteria: () => declare_council_criteria,
	sbom_generate: () => sbom_generate,
	checkpoint: () => checkpoint,
	pkg_audit: () => pkg_audit,
	test_runner: () => test_runner,
	test_impact: () => test_impact,
	mutation_test: () => mutation_test,
	generate_mutants: () => generate_mutants,
	detect_domains: () => detect_domains,
	gitingest: () => gitingest,
	retrieve_summary: () => retrieve_summary,
	extract_code_blocks: () => extract_code_blocks,
	phase_complete: () => phase_complete,
	save_plan: () => save_plan,
	update_task_status: () => update_task_status,
	lint_spec: () => lint_spec,
	write_retro: () => write_retro,
	write_drift_evidence: () => write_drift_evidence,
	write_hallucination_evidence: () => write_hallucination_evidence,
	write_mutation_evidence: () => write_mutation_evidence,
	declare_scope: () => declare_scope,
	knowledge_query: () => knowledge_query,
	doc_scan: () => doc_scan,
	doc_extract: () => doc_extract,
	curator_analyze: () => curator_analyze,
	knowledge_add: () => knowledge_add,
	knowledge_recall: () => knowledge_recall,
	knowledge_remove: () => knowledge_remove,
	co_change_analyzer: () => co_change_analyzer,
	search: () => search,
	batch_symbols: () => batch_symbols,
	suggest_patch: () => suggestPatch,
	req_coverage: () => req_coverage,
	get_approved_plan: () => get_approved_plan,
	repo_map: () => repo_map,
	get_qa_gate_profile: () => get_qa_gate_profile,
	set_qa_gates: () => set_qa_gates,
	web_search: () => web_search,
	convene_general_council: () => convene_general_council,
	write_final_council_evidence: () => write_final_council_evidence,
	skill_generate: () => skill_generate,
	skill_list: () => skill_list,
	skill_apply: () => skill_apply,
	skill_inspect: () => skill_inspect,
	skill_regenerate: () => skill_regenerate,
	skill_retire: () => skill_retire,
	skill_improve: () => skill_improve,
	spec_write: () => spec_write,
	knowledge_ack: () => knowledge_ack,
	knowledge_receipt: () => knowledge_receipt,
	knowledge_archive: () => knowledge_archive,
	swarm_memory_recall: () => swarm_memory_recall,
	swarm_memory_propose: () => swarm_memory_propose,
	swarm_command: () => swarm_command,
	summarize_work: () => summarize_work,
	write_architecture_supervisor_evidence: () =>
		write_architecture_supervisor_evidence,
	lean_turbo_plan_lanes: () => lean_turbo_plan_lanes,
	lean_turbo_acquire_locks: () => lean_turbo_acquire_locks,
	lean_turbo_runner_status: () => lean_turbo_runner_status,
	lean_turbo_review: () => lean_turbo_review,
	lean_turbo_run_phase: () => lean_turbo_run_phase,
	lean_turbo_status: () => lean_turbo_status,
	apply_patch: () => applyPatch,
});
