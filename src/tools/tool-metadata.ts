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
import { type AgentName, ALL_AGENT_NAMES } from '../config/agent-names';

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
export const TOOL_METADATA = {
	diff: {
		description: 'structured git diff with contract change detection',
		agents: [
			'architect',
			'reviewer',
			'critic_oversight',
			'coder',
			'test_engineer',
		],
	},
	diff_summary: {
		description:
			'filter classified AST changes by category, risk level, or file for reviewer drill-down',
		agents: ['architect', 'reviewer', 'critic_oversight'],
	},
	syntax_check: {
		description: 'syntax validation',
		agents: ['architect', 'coder', 'test_engineer'],
	},
	placeholder_scan: {
		description: 'todo and FIXME comment detection',
		agents: ['architect', 'reviewer'],
	},
	imports: {
		description: 'dependency audit',
		agents: [
			'architect',
			'sme',
			'docs',
			'docs_design',
			'critic_sounding_board',
			'critic_drift_verifier',
			'critic_hallucination_verifier',
			'reviewer',
			'critic',
			'critic_oversight',
			'explorer',
			'coder',
			'test_engineer',
		],
	},
	lint: {
		description: 'code quality',
		agents: ['architect', 'reviewer', 'coder'],
	},
	secretscan: {
		description: 'secret detection',
		agents: ['architect', 'reviewer', 'critic_oversight'],
	},
	sast_scan: {
		description: 'static analysis security scan',
		agents: ['architect', 'reviewer', 'critic_oversight'],
	},
	build_check: {
		description: 'build verification',
		agents: ['architect', 'coder', 'test_engineer'],
	},
	pre_check_batch: {
		description:
			'parallel verification: lint:check + secretscan + sast_scan + quality_budget',
		agents: ['architect', 'reviewer'],
	},
	quality_budget: {
		description: 'code quality budget check',
		agents: ['architect'],
	},
	symbols: {
		description: 'code symbol search',
		agents: [
			'architect',
			'sme',
			'docs',
			'docs_design',
			'designer',
			'critic_sounding_board',
			'critic_drift_verifier',
			'critic_hallucination_verifier',
			'spec_writer',
			'reviewer',
			'critic',
			'critic_oversight',
			'explorer',
			'coder',
			'test_engineer',
		],
	},
	complexity_hotspots: {
		description: 'git churn × complexity risk map',
		agents: [
			'architect',
			'sme',
			'critic_sounding_board',
			'critic_drift_verifier',
			'critic_hallucination_verifier',
			'reviewer',
			'critic',
			'critic_oversight',
			'explorer',
			'test_engineer',
		],
	},
	schema_drift: {
		description: 'OpenAPI spec vs route drift',
		agents: ['architect', 'sme', 'docs', 'explorer'],
	},
	todo_extract: {
		description: 'structured TODO/FIXME extraction',
		agents: ['architect', 'docs', 'explorer'],
	},
	evidence_check: {
		description: 'verify task evidence completeness',
		agents: ['architect', 'critic_oversight'],
	},
	check_gate_status: {
		description: 'check the gate status of a specific task',
		agents: ['architect', 'critic_oversight'],
	},
	completion_verify: {
		description: 'verify completed tasks have required evidence',
		agents: ['architect', 'critic_oversight'],
	},
	submit_council_verdicts: {
		description:
			'submit pre-collected council member verdicts for synthesis (architect MUST dispatch critic/reviewer/sme/test_engineer/explorer as Agent tasks first; this tool synthesizes only, it does not contact members)',
		agents: ['architect'],
	},
	submit_phase_council_verdicts: {
		description:
			'submit pre-collected phase-level council member verdicts for holistic phase synthesis (architect MUST dispatch all 5 council members with phase-scoped context first; this tool synthesizes only, it does not contact members)',
		agents: ['architect'],
	},
	declare_council_criteria: {
		description:
			'pre-declare acceptance criteria for a task before the coder starts work; criteria are read back during council evaluation',
		agents: ['architect'],
	},
	sbom_generate: {
		description: 'SBOM generation for dependency inventory',
		agents: ['architect'],
	},
	checkpoint: {
		description: 'state snapshots',
		agents: ['architect'],
	},
	pkg_audit: {
		description: 'dependency vulnerability scan — npm/pip/cargo',
		agents: [
			'architect',
			'critic_hallucination_verifier',
			'reviewer',
			'critic_oversight',
			'test_engineer',
		],
	},
	test_runner: {
		description: 'auto-detect and run tests',
		agents: ['architect', 'reviewer', 'test_engineer'],
	},
	test_impact: {
		description:
			'identify test files impacted by changed source files via import analysis',
		agents: ['architect', 'reviewer', 'critic_oversight', 'test_engineer'],
	},
	mutation_test: {
		description:
			'executes pre-generated mutation patches against tests, evaluates kill rate against quality gate thresholds',
		agents: ['architect', 'test_engineer'],
	},
	generate_mutants: {
		description:
			'generate LLM-based mutation testing patches for source files; returns MutationPatch[] for direct consumption by the mutation_test tool',
		agents: ['architect'],
	},
	detect_domains: {
		description: 'detect which SME domains are relevant for a given text',
		agents: [
			'architect',
			'sme',
			'docs',
			'docs_design',
			'critic_sounding_board',
			'critic_drift_verifier',
			'critic_hallucination_verifier',
			'critic',
			'critic_oversight',
			'explorer',
		],
	},
	gitingest: {
		description: 'fetch a GitHub repository full content via gitingest.com',
		agents: ['architect', 'docs', 'explorer'],
	},
	retrieve_summary: {
		description: 'retrieve the full content of a stored tool output summary',
		agents: [
			'architect',
			'sme',
			'docs',
			'docs_design',
			'designer',
			'critic_sounding_board',
			'critic_drift_verifier',
			'critic_hallucination_verifier',
			'critic_architecture_supervisor',
			'spec_writer',
			'reviewer',
			'critic',
			'critic_oversight',
			'explorer',
			'coder',
			'test_engineer',
		],
	},
	extract_code_blocks: {
		description: 'extract code blocks from text content and save them to files',
		agents: [
			'architect',
			'sme',
			'docs',
			'docs_design',
			'designer',
			'spec_writer',
			'reviewer',
			'explorer',
			'coder',
			'test_engineer',
		],
	},
	phase_complete: {
		description: 'mark a phase as complete and track dispatched agents',
		agents: ['architect'],
	},
	save_plan: {
		description: 'save a structured implementation plan',
		agents: ['architect'],
	},
	update_task_status: {
		description: 'mark tasks complete, track phase progress',
		agents: ['architect'],
	},
	lint_spec: {
		description: 'validate .swarm/spec.md format and required fields',
		agents: ['architect', 'spec_writer'],
	},
	write_retro: {
		description:
			'document phase retrospectives via phase_complete workflow, capture lessons learned',
		agents: ['architect'],
	},
	write_drift_evidence: {
		description: 'write drift verification evidence for a completed phase',
		agents: ['architect'],
	},
	write_hallucination_evidence: {
		description:
			'write hallucination verification evidence for a completed phase',
		agents: ['architect'],
	},
	write_mutation_evidence: {
		description:
			'write mutation gate evidence for a completed phase; normalizes PASS/WARN/FAIL/SKIP verdicts and writes .swarm/evidence/{phase}/mutation-gate.json',
		agents: ['architect'],
	},
	declare_scope: {
		description: 'declare file scope for next coder delegation',
		agents: ['architect'],
	},
	knowledge_query: {
		description: 'query swarm or hive knowledge with optional filters',
		agents: ['architect', 'skill_improver', 'spec_writer'],
	},
	doc_scan: {
		description: 'scan project documentation files and build an index manifest',
		agents: [
			'architect',
			'docs_design',
			'skill_improver',
			'spec_writer',
			'explorer',
		],
	},
	doc_extract: {
		description: 'extract actionable constraints from project documentation',
		agents: ['architect', 'docs_design', 'skill_improver', 'spec_writer'],
	},
	curator_analyze: {
		description:
			'run curator phase analysis and optionally apply knowledge recommendations',
		agents: ['architect'],
	},
	knowledge_add: {
		description: 'store a new lesson in the knowledge base',
		agents: ['architect', 'coder'],
	},
	knowledge_recall: {
		description: 'search the knowledge base for relevant past decisions',
		agents: [
			'architect',
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
			'skill_improver',
			'spec_writer',
			'reviewer',
			'critic',
			'critic_oversight',
			'explorer',
			'coder',
			'test_engineer',
		],
	},
	knowledge_remove: {
		description:
			'delete an outdated swarm knowledge entry by ID (swarm tier only)',
		agents: ['architect'],
	},
	co_change_analyzer: {
		description: 'detect hidden couplings by analyzing git history',
		agents: ['architect'],
	},
	search: {
		description:
			'Workspace-scoped ripgrep-style text search with structured JSON output. Supports literal and regex modes, glob filtering, and result limits. NOTE: This is text search, not structural AST search — use symbols and imports tools for structural queries.',
		agents: [
			'architect',
			'sme',
			'docs',
			'docs_design',
			'designer',
			'critic_hallucination_verifier',
			'skill_improver',
			'spec_writer',
			'reviewer',
			'critic_oversight',
			'explorer',
			'coder',
			'test_engineer',
		],
	},
	batch_symbols: {
		description:
			'Batched symbol extraction across multiple files. Returns per-file symbol summaries with isolated error handling.',
		agents: [
			'architect',
			'critic_hallucination_verifier',
			'reviewer',
			'critic_oversight',
			'explorer',
		],
	},
	suggest_patch: {
		description:
			'Reviewer-safe structured patch suggestion tool. Produces context-anchored patch artifacts without file modification. Returns structured diagnostics on context mismatch.',
		agents: ['architect', 'reviewer'],
	},
	req_coverage: {
		description:
			'query requirement coverage status for tracked functional requirements',
		agents: [
			'critic_sounding_board',
			'critic_drift_verifier',
			'critic_hallucination_verifier',
			'spec_writer',
			'critic',
			'critic_oversight',
		],
	},
	get_approved_plan: {
		description:
			'retrieve the last critic-approved immutable plan snapshot for baseline drift comparison',
		agents: ['critic_drift_verifier', 'critic', 'critic_oversight'],
	},
	repo_map: {
		description:
			'query the repo code graph: importers, dependencies, blast radius, and localization context for structural awareness before refactoring',
		agents: [
			'architect',
			'critic_sounding_board',
			'critic_drift_verifier',
			'critic_hallucination_verifier',
			'critic_architecture_supervisor',
			'reviewer',
			'critic',
			'critic_oversight',
			'explorer',
			'coder',
		],
	},
	get_qa_gate_profile: {
		description:
			'retrieve the QA gate profile for the current plan: gates (reviewer, test_engineer, sme_enabled, critic_pre_plan, sast_enabled, council_mode, hallucination_guard, mutation_test, council_general_review, drift_check, final_council), lock state, and profile hash. Read-only.',
		agents: ['architect'],
	},
	set_qa_gates: {
		description:
			'configure the QA gate profile for the current plan. Architect-only. Ratchet-tighter only — rejected once the profile is locked after critic approval. Supports: reviewer, test_engineer, sme_enabled, critic_pre_plan, sast_enabled, council_mode, hallucination_guard, mutation_test, council_general_review, drift_check, final_council.',
		agents: ['architect'],
	},
	web_search: {
		description:
			'External web search (Tavily or Brave) for architect-driven council research. Returns titled results with snippets and URLs. Config-gated on council.general.enabled; requires a search API key. Used by the architect in MODE: COUNCIL to gather a RESEARCH CONTEXT before dispatching council agents.',
		agents: ['architect', 'skill_improver'],
	},
	convene_general_council: {
		description:
			'Synthesize responses from a multi-model General Council. Accepts parallel member responses (Round 1, optionally Round 2), detects disagreements, and returns consensus points, persisting disagreements, and a structured synthesis. Architect-only. Config-gated on council.general.enabled.',
		agents: ['architect'],
	},
	write_final_council_evidence: {
		description: 'write final council evidence for project completion',
		agents: ['architect'],
	},
	skill_generate: {
		description: 'compile knowledge entries into a structured SKILL.md draft',
		agents: ['architect', 'skill_improver'],
	},
	skill_list: {
		description: 'list generated skill files and their status',
		agents: ['architect', 'skill_improver'],
	},
	skill_apply: {
		description: 'activate a draft skill proposal',
		agents: ['architect'],
	},
	skill_inspect: {
		description: 'inspect the content and source entries of a skill file',
		agents: ['architect', 'skill_improver'],
	},
	skill_regenerate: {
		description:
			'regenerate an active skill by re-clustering its source knowledge entries and updating the SKILL.md in place',
		agents: ['architect'],
	},
	skill_retire: {
		description:
			'retire a generated skill by adding a retired.marker file; retired skills are excluded from scoring and injection',
		agents: ['architect'],
	},
	skill_improve: {
		description: 'run the skill_improver agent to review and refine skills',
		agents: ['architect', 'skill_improver'],
	},
	spec_write: {
		description: 'author or update .swarm/spec.md for the current project',
		agents: ['spec_writer'],
	},
	knowledge_ack: {
		description:
			'record an explicit KNOWLEDGE_APPLIED/IGNORED/VIOLATED acknowledgment',
		agents: ['architect'],
	},
	knowledge_receipt: {
		description:
			'file a receipt for retrieved knowledge (applied/ignored/contradicted + new lessons), recorded as immutable knowledge events',
		agents: ['architect', 'coder'],
	},
	knowledge_archive: {
		description:
			'archive (default), quarantine, or purge a swarm knowledge entry by ID with an immutable audit tombstone; purge requires an admin flag',
		agents: ['architect'],
	},
	swarm_memory_recall: {
		description:
			'recall scoped Swarm memory for the current repository as untrusted background',
		agents: [],
	},
	swarm_memory_propose: {
		description:
			'create a pending Swarm memory proposal; does not write durable memory directly',
		agents: [],
	},
	swarm_command: {
		description:
			'run supported /swarm commands through the canonical command registry',
		agents: [
			'architect',
			'sme',
			'docs',
			'docs_design',
			'designer',
			'reviewer',
			'critic',
			'explorer',
			'coder',
			'test_engineer',
		],
	},
	summarize_work: {
		description:
			'emit a short structured summary of completed work (key decisions, assumptions, risks, constraints) at task completion; rolls up per phase for architecture-supervisor review. Advisory, never blocks.',
		agents: [
			'architect',
			'sme',
			'docs',
			'docs_design',
			'designer',
			'explorer',
			'coder',
			'test_engineer',
		],
	},
	write_architecture_supervisor_evidence: {
		description:
			'persist the architecture supervisor verdict for a phase (architect MUST dispatch critic_architecture_supervisor first and collect its JSON verdict; this tool persists only, it does not contact the supervisor)',
		agents: ['architect'],
	},
	lean_turbo_plan_lanes: {
		description:
			'partition phase tasks into parallel lanes based on file-scope conflicts for Lean Turbo execution',
		agents: ['architect'],
	},
	lean_turbo_acquire_locks: {
		description:
			'acquire file locks for all files in a lane (all-or-nothing) before lane execution',
		agents: ['architect'],
	},
	lean_turbo_runner_status: {
		description: 'read Lean Turbo run state from .swarm/turbo-state.json',
		agents: ['architect'],
	},
	lean_turbo_review: {
		description:
			'dispatch a read-only reviewer agent to evaluate a completed Lean Turbo phase',
		agents: ['architect'],
	},
	lean_turbo_run_phase: {
		description:
			'Execute a phase using Lean Turbo parallel lane execution. Plans lanes, acquires file locks, and dispatches coder agents concurrently. Use when Lean Turbo is active and you want to execute all tasks in a phase in parallel lanes.',
		agents: ['architect'],
	},
	lean_turbo_status: {
		description:
			'returns Lean Turbo configuration and active status for the current session',
		agents: ['architect'],
	},
} satisfies Record<string, ToolMeta>;

/** Union type of all valid tool names (the metadata keys). */
export type ToolName = keyof typeof TOOL_METADATA;

// Compile-time guard: every tool name must be snake_case (no camelCase).
type AssertSnakeCase<T extends string> =
	T extends `${string}${Uppercase<string>}${string}` ? never : T;
type _ToolNamesSnakeCaseCheck = AssertSnakeCase<ToolName>;

/** Readonly array of all tool names, in metadata declaration order. */
export const TOOL_NAMES: readonly ToolName[] = Object.keys(
	TOOL_METADATA,
) as ToolName[];

/** Set for O(1) tool name validation. */
export const TOOL_NAME_SET: ReadonlySet<ToolName> = new Set(TOOL_NAMES);

/** Human-readable descriptions, keyed by tool name. */
export const TOOL_DESCRIPTIONS: Partial<Record<ToolName, string>> =
	Object.fromEntries(
		Object.entries(TOOL_METADATA).map(([name, meta]) => [
			name,
			meta.description,
		]),
	) as Record<ToolName, string>;

/**
 * Default tool permissions per agent, inverted from each tool's `agents` list.
 * All agent names are initialized (agents with no tools keep an empty array, e.g.
 * the council members). Tools with `agents: []` (the memory tools) stay OUT of
 * this map and are applied only via MEMORY_AGENT_TOOL_MAP.
 */
export const AGENT_TOOL_MAP: Record<AgentName, ToolName[]> = (() => {
	const map = Object.fromEntries(
		ALL_AGENT_NAMES.map((agent) => [agent, [] as ToolName[]]),
	) as Record<AgentName, ToolName[]>;
	for (const [name, meta] of Object.entries(TOOL_METADATA)) {
		for (const agent of meta.agents) {
			map[agent].push(name as ToolName);
		}
	}
	return map;
})();
