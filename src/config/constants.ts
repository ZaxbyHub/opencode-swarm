import type { ToolName } from '../tools/tool-names';
import { TOOL_NAME_SET } from '../tools/tool-names';
export const QA_AGENTS = ['reviewer', 'critic', 'critic_oversight'] as const;

export const PIPELINE_AGENTS = ['explorer', 'coder', 'test_engineer'] as const;

export const ORCHESTRATOR_NAME = 'architect' as const;

export const ALL_SUBAGENT_NAMES = [
	'sme',
	'docs',
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

// Opencode built-in native agents — not part of the swarm workflow.
// These agents are managed entirely by opencode's own permission system and
// must be exempted from swarm guardrails (authority checks, circuit breaker, etc.).
export const OPENCODE_NATIVE_AGENTS = new Set([
	'build',
	'plan',
	'general',
	'explore',
	'compaction',
	'title',
	'summary',
] as const);

/**
 * Claude Code built-in slash commands (without leading slash).
 * Used by the cc-command-intercept hook to detect accidental CC command invocations
 * inside swarm agent message streams.
 *
 * Source: https://code.claude.com/docs/en/commands (verified April 2026)
 * Keep in sync with Claude Code releases. When adding a command here, check
 * src/commands/conflict-registry.ts and update CLAUDE_CODE_CONFLICTS if the
 * command also matches a swarm subcommand.
 */
function freezeSet<T>(items: readonly T[]): ReadonlySet<T> {
	const set = new Set(items);
	const proxy = new Proxy(set, {
		get(target, prop) {
			if (prop === 'add' || prop === 'delete' || prop === 'clear') {
				return () => {
					throw new TypeError('CLAUDE_CODE_NATIVE_COMMANDS is readonly');
				};
			}
			// Wrap forEach to prevent exposing the raw Set as callback's 3rd arg
			if (prop === 'forEach') {
				return (
					callback: (value: T, key: T, set: ReadonlySet<T>) => void,
					thisArg?: unknown,
				) => {
					const wrapped = (v: T, k: T) =>
						callback.call(thisArg ?? (undefined as unknown), v, k, proxy);
					return set.forEach(wrapped);
				};
			}
			const value = Reflect.get(target, prop);
			return typeof value === 'function' ? value.bind(target) : value;
		},
		set() {
			throw new TypeError('CLAUDE_CODE_NATIVE_COMMANDS is readonly');
		},
		deleteProperty() {
			throw new TypeError('CLAUDE_CODE_NATIVE_COMMANDS is readonly');
		},
		defineProperty() {
			throw new TypeError('CLAUDE_CODE_NATIVE_COMMANDS is readonly');
		},
		setPrototypeOf() {
			throw new TypeError('CLAUDE_CODE_NATIVE_COMMANDS is readonly');
		},
	});
	return proxy;
}

export const CLAUDE_CODE_NATIVE_COMMANDS: ReadonlySet<string> = freezeSet([
	// Session management
	'clear',
	'new',
	'reset', // aliases for /clear
	'resume',
	'continue', // alias for /resume
	'exit',
	'quit', // aliases
	'compact',
	'fork',
	'branch', // alias for /fork
	'undo',
	'checkpoint',
	'rewind', // aliases for /rewind
	'rename',
	// Diagnostics & info
	'doctor',
	'help',
	'status',
	'statusline',
	'cost',
	'usage', // aliases
	'stats',
	'context',
	'debug',
	'insights',
	'recap',
	'release-notes',
	'heapdump',
	'powerup',
	// Config & settings
	'config',
	'settings', // aliases
	'model',
	'effort',
	'fast',
	'theme',
	'color',
	'keybindings',
	'privacy-settings',
	'init',
	'focus',
	'sandbox',
	'terminal-setup',
	// Permissions & security
	'permissions',
	'allowed-tools', // aliases
	'security-review',
	'fewer-permission-prompts', // skill
	// Plugins & integrations
	'plugin',
	'reload-plugins',
	'hooks',
	'mcp',
	'ide',
	'chrome',
	'desktop',
	'app', // alias for /desktop
	'mobile',
	'ios',
	'android', // aliases for /mobile
	'remote-control',
	'rc', // aliases
	'remote-env',
	'login',
	'logout',
	// Skills & workflows
	'review',
	'pr-comments',
	'agents',
	'batch', // skill
	'loop',
	'proactive', // alias for /loop
	'claude-api', // skill
	'schedule',
	'routines', // alias for /schedule
	'autofix-pr',
	// Plan & execution
	'plan',
	'diff',
	'export',
	'copy',
	'feedback',
	'bug', // aliases
	'btw',
	'add-dir',
	// Memory & knowledge
	'memory',
	'skills',
	'upgrade',
	'vim',
	'voice',
	'extra-usage',
	'install-github-app',
	'install-slack-app',
	'passes',
	'setup-bedrock',
	'install', // alias
	'tasks',
	'history',
	'term',
	'teleport',
	'ultrareview',
	'ultraplan',
	'web-setup',
	'setup-vertex',
	'tui',
	'simplify',
	'summary',
	'stickers',
	'tp', // alias for /teleport
	'team-onboarding',
	'bashes', // alias for /tasks
]);

// Type definitions
export type QAAgentName = (typeof QA_AGENTS)[number];
export type PipelineAgentName = (typeof PIPELINE_AGENTS)[number];
export type AgentName = (typeof ALL_AGENT_NAMES)[number];

// Tool permissions by agent - architect gets all tools, others capped at 15
export const AGENT_TOOL_MAP: Record<AgentName, ToolName[]> = {
	architect: [
		'checkpoint',
		'check_gate_status',
		'completion_verify',
		'complexity_hotspots',
		'submit_council_verdicts',
		'submit_phase_council_verdicts',
		'declare_council_criteria',
		'detect_domains',
		'evidence_check',
		'extract_code_blocks',
		'gitingest',
		'imports',
		'knowledge_query',
		'lint',
		'diff',
		'diff_summary',
		'pkg_audit',
		'pre_check_batch',
		'quality_budget',
		'retrieve_summary',
		'save_plan',
		'search',
		'batch_symbols',
		'schema_drift',
		'secretscan',
		'symbols',
		'test_runner',
		'test_impact',
		'mutation_test',
		'generate_mutants',
		'write_mutation_evidence',
		'todo_extract',
		'update_task_status',
		'lint_spec',
		'write_retro',
		'write_drift_evidence',
		'write_hallucination_evidence',
		'declare_scope',
		'sast_scan',
		'sbom_generate',
		'build_check',
		'syntax_check',
		'placeholder_scan',
		'phase_complete',
		'doc_scan',
		'doc_extract',
		'curator_analyze',
		'knowledge_add',
		'knowledge_recall',
		'knowledge_remove',
		'co_change_analyzer',
		'suggest_patch',
		'repo_map',
		'get_qa_gate_profile',
		'set_qa_gates',
		'convene_general_council',
		'web_search',
		'write_final_council_evidence',
		'skill_generate',
		'skill_list',
		'skill_apply',
		'skill_inspect',
		'skill_improve',
		'knowledge_ack',
		'summarize_work',
		'write_architecture_supervisor_evidence',
		'swarm_command',
		'lean_turbo_plan_lanes',
		'lean_turbo_acquire_locks',
		'lean_turbo_runner_status',
		'lean_turbo_review',
		'lean_turbo_run_phase',
		'lean_turbo_status',
	],
	explorer: [
		'complexity_hotspots',
		'detect_domains',
		'extract_code_blocks',
		'gitingest',
		'imports',
		'retrieve_summary',
		'schema_drift',
		'search',
		'batch_symbols',
		'symbols',
		'todo_extract',
		'doc_scan',
		'knowledge_recall',
		'repo_map',
		'summarize_work',
		'swarm_command',
	],
	coder: [
		'diff',
		'imports',
		'lint',
		'symbols',
		'extract_code_blocks',
		'retrieve_summary',
		'search',
		'build_check',
		'syntax_check',
		'knowledge_add',
		'knowledge_recall',
		'repo_map',
		'summarize_work',
		'swarm_command',
	],
	test_engineer: [
		'test_runner',
		'test_impact',
		'mutation_test',
		'diff',
		'symbols',
		'extract_code_blocks',
		'retrieve_summary',
		'imports',
		'complexity_hotspots',
		'pkg_audit',
		'build_check',
		'syntax_check',
		'search',
		'summarize_work',
		'swarm_command',
	],
	sme: [
		'complexity_hotspots',
		'detect_domains',
		'extract_code_blocks',
		'imports',
		'retrieve_summary',
		'schema_drift',
		'search',
		'symbols',
		'knowledge_recall',
		'summarize_work',
		'swarm_command',
	],
	reviewer: [
		'diff',
		'diff_summary',
		'imports',
		'lint',
		'pkg_audit',
		'pre_check_batch',
		'secretscan',
		'symbols',
		'complexity_hotspots',
		'retrieve_summary',
		'extract_code_blocks',
		'test_runner',
		'test_impact',
		'sast_scan',
		'placeholder_scan',
		'knowledge_recall',
		'search',
		'batch_symbols',
		'suggest_patch',
		'repo_map',
		'swarm_command',
	],
	critic: [
		'complexity_hotspots',
		'detect_domains',
		'imports',
		'retrieve_summary',
		'symbols',
		'knowledge_recall',
		'req_coverage',
		'get_approved_plan',
		'repo_map',
		'swarm_command',
	],
	critic_sounding_board: [
		'complexity_hotspots',
		'detect_domains',
		'imports',
		'retrieve_summary',
		'symbols',
		'knowledge_recall',
		'req_coverage',
		'repo_map',
	],
	critic_drift_verifier: [
		'complexity_hotspots',
		'detect_domains',
		'imports',
		'retrieve_summary',
		'symbols',
		'knowledge_recall',
		'req_coverage',
		'get_approved_plan',
		'repo_map',
	],
	critic_hallucination_verifier: [
		'complexity_hotspots',
		'detect_domains',
		'imports',
		'retrieve_summary',
		'symbols',
		'batch_symbols',
		'search',
		'pkg_audit',
		'knowledge_recall',
		'req_coverage',
		'repo_map',
	],
	critic_architecture_supervisor: [
		// Summary-only review (issue #893): reads compressed summaries and knowledge,
		// emits a verdict. Read-only — never writes, edits, or patches.
		'retrieve_summary',
		'knowledge_recall',
		'repo_map',
	],
	critic_oversight: [
		// Read-only verification tools only. critic_oversight must never write,
		// edit, patch, or mutate plan/evidence/gates — its output is a verdict.
		'diff',
		'diff_summary',
		'evidence_check',
		'check_gate_status',
		'completion_verify',
		'get_approved_plan',
		'req_coverage',
		'test_impact',
		'pkg_audit',
		'secretscan',
		'sast_scan',
		'repo_map',
		'retrieve_summary',
		'knowledge_recall',
		'symbols',
		'batch_symbols',
		'search',
		'imports',
		'complexity_hotspots',
		'detect_domains',
	],
	docs: [
		'detect_domains',
		'extract_code_blocks',
		'gitingest',
		'imports',
		'retrieve_summary',
		'schema_drift',
		'search',
		'symbols',
		'todo_extract',
		'knowledge_recall',
		'summarize_work',
		'swarm_command',
	],
	designer: [
		'extract_code_blocks',
		'retrieve_summary',
		'search',
		'symbols',
		'knowledge_recall',
		'summarize_work',
		'swarm_command',
	],
	// Curator agents are read-only analysis roles.
	curator_init: ['knowledge_recall'],
	curator_phase: ['knowledge_recall'],
	// General Council agents — synthesis-only voices that reason from the
	// architect-supplied RESEARCH CONTEXT block. No tools at all: web_search
	// is owned by the architect (one curated pre-search pass for all three
	// agents), and synthesis is the architect's responsibility post-tool.
	council_generalist: [],
	council_skeptic: [],
	council_domain_expert: [],
	// v2: skill_improver — reviews knowledge/skills/spec/architect-prompt under
	// daily quota. Default mode is proposal-only (no source mutation). May draft
	// SKILL.md proposals when explicitly invoked with mode='draft_skills'.
	skill_improver: [
		'knowledge_recall',
		'knowledge_query',
		'skill_list',
		'skill_inspect',
		'skill_generate',
		'skill_improve',
		'search',
		'doc_scan',
		'doc_extract',
		'web_search',
	],
	// v2: spec_writer — independent agent for authoring .swarm/spec.md. Has
	// read tools and the safe spec_write tool only.
	spec_writer: [
		'search',
		'knowledge_recall',
		'knowledge_query',
		'doc_scan',
		'doc_extract',
		'req_coverage',
		'lint_spec',
		'retrieve_summary',
		'symbols',
		'extract_code_blocks',
		'spec_write',
	],
};

export const MEMORY_TOOL_NAMES = [
	'swarm_memory_recall',
	'swarm_memory_propose',
] as const satisfies readonly ToolName[];

export const MEMORY_AGENT_TOOL_MAP: Partial<Record<AgentName, ToolName[]>> = {
	architect: ['swarm_memory_recall', 'swarm_memory_propose'],
	explorer: ['swarm_memory_recall', 'swarm_memory_propose'],
	coder: ['swarm_memory_recall', 'swarm_memory_propose'],
	reviewer: ['swarm_memory_recall'],
	test_engineer: ['swarm_memory_recall', 'swarm_memory_propose'],
	sme: ['swarm_memory_recall', 'swarm_memory_propose'],
	critic: ['swarm_memory_recall'],
	critic_sounding_board: ['swarm_memory_recall'],
	critic_drift_verifier: ['swarm_memory_recall'],
	critic_hallucination_verifier: ['swarm_memory_recall'],
	critic_architecture_supervisor: ['swarm_memory_recall'],
	docs: ['swarm_memory_recall', 'swarm_memory_propose'],
	designer: ['swarm_memory_recall', 'swarm_memory_propose'],
	curator_init: ['swarm_memory_recall'],
	curator_phase: ['swarm_memory_recall'],
	skill_improver: ['swarm_memory_recall', 'swarm_memory_propose'],
	spec_writer: ['swarm_memory_recall', 'swarm_memory_propose'],
};

/**
 * Human-readable descriptions for tools shown in the architect Available Tools block.
 * Used to generate the Available Tools section of the architect prompt at construction time.
 */
/**
 * Canonical set of tool names that write/modify file contents.
 * Used by scope-guard.ts and guardrails.ts to detect write operations.
 * NOTE: bash/shell tools are intentionally excluded — bash commands are opaque
 * to static scope analysis. Post-hoc detection via guardrails diff-scope provides secondary coverage.
 */
export const WRITE_TOOL_NAMES = [
	'write',
	'edit',
	'patch',
	'apply_patch',
	'create_file',
	'insert',
	'replace',
	'append',
	'prepend',
] as const;

export type WriteToolName = (typeof WRITE_TOOL_NAMES)[number];

export const TOOL_DESCRIPTIONS: Partial<Record<ToolName, string>> = {
	symbols: 'code symbol search',
	checkpoint: 'state snapshots',
	diff: 'structured git diff with contract change detection',
	diff_summary:
		'filter classified AST changes by category, risk level, or file for reviewer drill-down',
	imports: 'dependency audit',
	lint: 'code quality',
	placeholder_scan: 'todo and FIXME comment detection',
	secretscan: 'secret detection',
	sast_scan: 'static analysis security scan',
	syntax_check: 'syntax validation',
	test_runner: 'auto-detect and run tests',
	test_impact:
		'identify test files impacted by changed source files via import analysis',
	mutation_test:
		'executes pre-generated mutation patches against tests, evaluates kill rate against quality gate thresholds',
	generate_mutants:
		'generate LLM-based mutation testing patches for source files; returns MutationPatch[] for direct consumption by the mutation_test tool',
	write_mutation_evidence:
		'write mutation gate evidence for a completed phase; normalizes PASS/WARN/FAIL/SKIP verdicts and writes .swarm/evidence/{phase}/mutation-gate.json',
	pkg_audit: 'dependency vulnerability scan — npm/pip/cargo',
	complexity_hotspots: 'git churn × complexity risk map',
	schema_drift: 'OpenAPI spec vs route drift',
	todo_extract: 'structured TODO/FIXME extraction',
	evidence_check: 'verify task evidence completeness',
	sbom_generate: 'SBOM generation for dependency inventory',
	build_check: 'build verification',
	quality_budget: 'code quality budget check',
	pre_check_batch:
		'parallel verification: lint:check + secretscan + sast_scan + quality_budget',
	update_task_status: 'mark tasks complete, track phase progress',
	write_retro:
		'document phase retrospectives via phase_complete workflow, capture lessons learned',
	write_drift_evidence:
		'write drift verification evidence for a completed phase',
	write_hallucination_evidence:
		'write hallucination verification evidence for a completed phase',
	write_final_council_evidence:
		'write final council evidence for project completion',
	declare_scope: 'declare file scope for next coder delegation',
	phase_complete: 'mark a phase as complete and track dispatched agents',
	save_plan: 'save a structured implementation plan',
	doc_scan: 'scan project documentation files and build an index manifest',
	doc_extract: 'extract actionable constraints from project documentation',
	curator_analyze:
		'run curator phase analysis and optionally apply knowledge recommendations',
	knowledge_add: 'store a new lesson in the knowledge base',
	knowledge_recall: 'search the knowledge base for relevant past decisions',
	knowledge_remove:
		'delete an outdated swarm knowledge entry by ID (swarm tier only)',
	knowledge_query: 'query swarm or hive knowledge with optional filters',
	co_change_analyzer: 'detect hidden couplings by analyzing git history',
	check_gate_status: 'check the gate status of a specific task',
	completion_verify: 'verify completed tasks have required evidence',
	submit_council_verdicts:
		'submit pre-collected council member verdicts for synthesis (architect MUST dispatch critic/reviewer/sme/test_engineer/explorer as Agent tasks first; this tool synthesizes only, it does not contact members)',
	submit_phase_council_verdicts:
		'submit pre-collected phase-level council member verdicts for holistic phase synthesis (architect MUST dispatch all 5 council members with phase-scoped context first; this tool synthesizes only, it does not contact members)',
	declare_council_criteria:
		'pre-declare acceptance criteria for a task before the coder starts work; criteria are read back during council evaluation',
	detect_domains: 'detect which SME domains are relevant for a given text',
	summarize_work:
		'emit a short structured summary of completed work (key decisions, assumptions, risks, constraints) at task completion; rolls up per phase for architecture-supervisor review. Advisory, never blocks.',
	write_architecture_supervisor_evidence:
		'persist the architecture supervisor verdict for a phase (architect MUST dispatch critic_architecture_supervisor first and collect its JSON verdict; this tool persists only, it does not contact the supervisor)',
	extract_code_blocks:
		'extract code blocks from text content and save them to files',
	gitingest: 'fetch a GitHub repository full content via gitingest.com',
	retrieve_summary: 'retrieve the full content of a stored tool output summary',
	search:
		'Workspace-scoped ripgrep-style text search with structured JSON output. Supports literal and regex modes, glob filtering, and result limits. NOTE: This is text search, not structural AST search — use symbols and imports tools for structural queries.',
	web_search:
		'External web search (Tavily or Brave) for architect-driven council research. Returns titled results with snippets and URLs. Config-gated on council.general.enabled; requires a search API key. Used by the architect in MODE: COUNCIL to gather a RESEARCH CONTEXT before dispatching council agents.',
	convene_general_council:
		'Synthesize responses from a multi-model General Council. Accepts parallel member responses (Round 1, optionally Round 2), detects disagreements, and returns consensus points, persisting disagreements, and a structured synthesis. Architect-only. Config-gated on council.general.enabled.',
	batch_symbols:
		'Batched symbol extraction across multiple files. Returns per-file symbol summaries with isolated error handling.',
	suggest_patch:
		'Reviewer-safe structured patch suggestion tool. Produces context-anchored patch artifacts without file modification. Returns structured diagnostics on context mismatch.',
	lint_spec: 'validate .swarm/spec.md format and required fields',
	get_approved_plan:
		'retrieve the last critic-approved immutable plan snapshot for baseline drift comparison',
	repo_map:
		'query the repo code graph: importers, dependencies, blast radius, and localization context for structural awareness before refactoring',
	get_qa_gate_profile:
		'retrieve the QA gate profile for the current plan: gates (reviewer, test_engineer, sme_enabled, critic_pre_plan, sast_enabled, council_mode, hallucination_guard, mutation_test, council_general_review, drift_check, final_council), lock state, and profile hash. Read-only.',
	set_qa_gates:
		'configure the QA gate profile for the current plan. Architect-only. Ratchet-tighter only — rejected once the profile is locked after critic approval. Supports: reviewer, test_engineer, sme_enabled, critic_pre_plan, sast_enabled, council_mode, hallucination_guard, mutation_test, council_general_review, drift_check, final_council.',
	req_coverage:
		'query requirement coverage status for tracked functional requirements',
	skill_generate: 'compile knowledge entries into a structured SKILL.md draft',
	skill_list: 'list generated skill files and their status',
	skill_apply: 'activate a draft skill proposal',
	skill_inspect: 'inspect the content and source entries of a skill file',
	skill_improve: 'run the skill_improver agent to review and refine skills',
	spec_write: 'author or update .swarm/spec.md for the current project',
	knowledge_ack:
		'record an explicit KNOWLEDGE_APPLIED/IGNORED/VIOLATED acknowledgment',
	swarm_memory_recall:
		'recall scoped Swarm memory for the current repository as untrusted background',
	swarm_memory_propose:
		'create a pending Swarm memory proposal; does not write durable memory directly',
	swarm_command:
		'run supported /swarm commands through the canonical command registry',
	lean_turbo_plan_lanes:
		'partition phase tasks into parallel lanes based on file-scope conflicts for Lean Turbo execution',
	lean_turbo_acquire_locks:
		'acquire file locks for all files in a lane (all-or-nothing) before lane execution',
	lean_turbo_runner_status:
		'read Lean Turbo run state from .swarm/turbo-state.json',
	lean_turbo_review:
		'dispatch a read-only reviewer agent to evaluate a completed Lean Turbo phase',
	lean_turbo_run_phase:
		'Execute a phase using Lean Turbo parallel lane execution. ' +
		'Plans lanes, acquires file locks, and dispatches coder agents concurrently. ' +
		'Use when Lean Turbo is active and you want to execute all tasks in a phase in parallel lanes.',
	lean_turbo_status:
		'returns Lean Turbo configuration and active status for the current session',
};

// Runtime validation: ensure all tool names in AGENT_TOOL_MAP are registered
for (const [agentName, tools] of Object.entries(AGENT_TOOL_MAP)) {
	const invalidTools = tools.filter(
		(tool) => !TOOL_NAME_SET.has(tool as ToolName),
	);
	if (invalidTools.length > 0) {
		throw new Error(
			`Agent '${agentName}' has invalid tool names: [${invalidTools.join(', ')}]. ` +
				`All tools must be registered in TOOL_NAME_SET.`,
		);
	}
}

// Default models for each agent/category
// v6.14: switched to free OpenCode Zen models; architect key intentionally
// omitted so it inherits the OpenCode UI model selection.
export const DEFAULT_MODELS: Record<string, string> = {
	// Explorer — fast read-heavy analysis
	explorer: 'opencode/big-pickle',

	// Pipeline agents — differentiated models for writing vs reviewing
	coder: 'opencode/minimax-m2.5-free',
	reviewer: 'opencode/big-pickle',
	test_engineer: 'opencode/gpt-5-nano',

	// SME, Critic variants, Docs, Designer — reasoning/general tasks
	sme: 'opencode/big-pickle',
	critic: 'opencode/big-pickle',
	critic_sounding_board: 'opencode/gpt-5-nano',
	critic_drift_verifier: 'opencode/gpt-5-nano',
	critic_hallucination_verifier: 'opencode/gpt-5-nano',
	critic_oversight: 'opencode/gpt-5-nano',
	// Architecture supervisor is the expensive cross-task reviewer — inherits the
	// critic model at runtime; this entry mirrors that for config/doc completeness.
	critic_architecture_supervisor: 'opencode/big-pickle',
	docs: 'opencode/big-pickle',
	designer: 'opencode/big-pickle',

	// Curator agents — lightweight read-only analysis (same model family as explorer)
	curator_init: 'opencode/gpt-5-nano',
	curator_phase: 'opencode/gpt-5-nano',

	// v2: Skill improver — defaults to a strong reasoning model, but is gated
	// behind skill_improver.enabled and a daily quota (issue #629).
	skill_improver: 'opencode/big-pickle',

	// v2: Spec writer — independent from architect so users can run a
	// high-capability model on spec while keeping architect cheaper.
	spec_writer: 'opencode/big-pickle',

	// Fallback
	default: 'opencode/big-pickle',
};

// Full agent configuration with model and fallback_models chains.
// Used by install() and writeProjectConfigIfMissing() to populate default configs.
// General Council agents (council_generalist, council_skeptic, council_domain_expert)
// derive their models from reviewer/critic/sme entries and don't need separate entries.
export const DEFAULT_AGENT_CONFIGS: Record<
	string,
	{ model: string; fallback_models: string[] }
> = {
	coder: {
		model: 'opencode/minimax-m2.5-free',
		fallback_models: ['opencode/gpt-5-nano', 'opencode/big-pickle'],
	},
	reviewer: {
		model: 'opencode/big-pickle',
		fallback_models: ['opencode/gpt-5-nano', 'opencode/big-pickle'],
	},
	test_engineer: {
		model: 'opencode/gpt-5-nano',
		fallback_models: ['opencode/big-pickle'],
	},
	explorer: {
		model: 'opencode/big-pickle',
		fallback_models: ['opencode/gpt-5-nano', 'opencode/big-pickle'],
	},
	sme: {
		model: 'opencode/big-pickle',
		fallback_models: ['opencode/gpt-5-nano', 'opencode/big-pickle'],
	},
	critic: {
		model: 'opencode/big-pickle',
		fallback_models: ['opencode/gpt-5-nano', 'opencode/big-pickle'],
	},
	docs: {
		model: 'opencode/big-pickle',
		fallback_models: ['opencode/gpt-5-nano', 'opencode/big-pickle'],
	},
	designer: {
		model: 'opencode/big-pickle',
		fallback_models: ['opencode/gpt-5-nano', 'opencode/big-pickle'],
	},
	critic_sounding_board: {
		model: 'opencode/gpt-5-nano',
		fallback_models: ['opencode/big-pickle'],
	},
	critic_drift_verifier: {
		model: 'opencode/gpt-5-nano',
		fallback_models: ['opencode/big-pickle'],
	},
	critic_hallucination_verifier: {
		model: 'opencode/gpt-5-nano',
		fallback_models: ['opencode/big-pickle'],
	},
	critic_oversight: {
		model: 'opencode/gpt-5-nano',
		fallback_models: ['opencode/big-pickle'],
	},
	critic_architecture_supervisor: {
		model: 'opencode/big-pickle',
		fallback_models: ['opencode/gpt-5-nano'],
	},
	curator_init: {
		model: 'opencode/gpt-5-nano',
		fallback_models: ['opencode/big-pickle'],
	},
	curator_phase: {
		model: 'opencode/gpt-5-nano',
		fallback_models: ['opencode/big-pickle'],
	},
	skill_improver: {
		model: 'opencode/big-pickle',
		fallback_models: ['opencode/gpt-5-nano'],
	},
	spec_writer: {
		model: 'opencode/big-pickle',
		fallback_models: ['opencode/gpt-5-nano'],
	},
};

// Check if agent is in QA category
export function isQAAgent(name: string): name is QAAgentName {
	return (QA_AGENTS as readonly string[]).includes(name);
}

// Check if agent is a subagent
export function isSubagent(name: string): boolean {
	return (ALL_SUBAGENT_NAMES as readonly string[]).includes(name);
}

import { deepMerge } from '../utils/merge';
import type { LeanTurboConfig, ScoringConfig } from './schema';

// Default scoring configuration
export const DEFAULT_SCORING_CONFIG: ScoringConfig = {
	enabled: false,
	max_candidates: 100,
	weights: {
		phase: 1.0,
		current_task: 2.0,
		blocked_task: 1.5,
		recent_failure: 2.5,
		recent_success: 0.5,
		evidence_presence: 1.0,
		decision_recency: 1.5,
		dependency_proximity: 1.0,
	},
	decision_decay: {
		mode: 'exponential',
		half_life_hours: 24,
	},
	token_ratios: {
		prose: 0.25,
		code: 0.4,
		markdown: 0.3,
		json: 0.35,
	},
};

/**
 * Resolve scoring configuration by deep-merging user config with defaults.
 * Missing scoring block → use defaults; partial weights → merge with defaults.
 *
 * @param userConfig - Optional user-provided scoring configuration
 * @returns The effective scoring configuration with all defaults applied
 */
export function resolveScoringConfig(
	userConfig?: ScoringConfig,
): ScoringConfig {
	if (!userConfig) {
		return DEFAULT_SCORING_CONFIG;
	}

	// Deep merge user config with defaults
	const merged = deepMerge(
		DEFAULT_SCORING_CONFIG as Record<string, unknown>,
		userConfig as Record<string, unknown>,
	);

	return merged as ScoringConfig;
}

/**
 * Model ID substrings that identify low-capability models.
 * If a model's ID contains any of these substrings (case-insensitive),
 * it is considered a low-capability model.
 */
export const LOW_CAPABILITY_MODELS = ['mini', 'nano', 'small', 'free'] as const;

/**
 * Returns true if the given modelId contains any LOW_CAPABILITY_MODELS substring
 * (case-insensitive comparison).
 *
 * @param modelId - The model ID to check
 * @returns true if the model is considered low capability, false otherwise
 */
export function isLowCapabilityModel(modelId: string): boolean {
	const lower = (modelId || '').toLowerCase();
	return LOW_CAPABILITY_MODELS.some((substr) => lower.includes(substr));
}

export const SLOP_DETECTOR_DEFAULTS = {
	enabled: true,
	classThreshold: 3,
	commentStripThreshold: 5,
	diffLineThreshold: 200,
} as const;

export const INCREMENTAL_VERIFY_DEFAULTS = {
	enabled: true,
	command: null,
	timeoutMs: 30000,
	triggerAgents: ['coder'],
} as const;

export const COMPACTION_DEFAULTS = {
	enabled: true,
	observationThreshold: 40,
	reflectionThreshold: 60,
	emergencyThreshold: 80,
	preserveLastNTurns: 5,
} as const;

// Banner messages for architect prompt
export const TURBO_MODE_BANNER = `## 🚀 TURBO MODE ACTIVE

**Speed optimization enabled for this session.**

While Turbo Mode is active:
- **Stage A gates** (lint, imports, pre_check_batch) are still REQUIRED for ALL tasks
- **Tier 3 tasks** (security-sensitive files matching: architect*.ts, delegation*.ts, guardrails*.ts, adversarial*.ts, sanitiz*.ts, auth*, permission*, crypto*, secret*, security) still require FULL review (Stage B)
- **Tier 0-2 tasks** can skip Stage B (reviewer, test_engineer) to speed up execution
- **Phase completion gates** (completion-verify and drift verification gate) are automatically bypassed — phase_complete will succeed without drift verification evidence when turbo is active. Note: turbo bypass is session-scoped; one session's turbo does not affect other sessions.

Classification still determines the pipeline:
- TIER 0 (metadata): lint + diff only — no change
- TIER 1 (docs): Stage A + reviewer — no change
- TIER 2 (standard code): Stage A + reviewer + test_engineer — CAN SKIP Stage B with turboMode
- TIER 3 (critical): Stage A + 2x reviewer + 2x test_engineer — Stage B REQUIRED (no turbo bypass)

Do NOT skip Stage A gates. Do NOT skip Stage B for TIER 3.
`;

export const FULL_AUTO_BANNER = `## ⚡ FULL-AUTO MODE ACTIVE

You are operating without a human in the loop. All escalations route to the Autonomous Oversight Critic instead of a user.

Behavioral changes:
- TIER 3 escalations go to the critic, not a human. Frame your questions technically, not conversationally.
- Phase completion approval comes from the critic. Ensure all evidence is written before requesting.
- The critic defaults to REJECT. Do not attempt to pressure, negotiate, or shortcut. Complete the evidence trail.
- If the critic returns ESCALATE_TO_HUMAN, the session will pause or terminate. Only the critic can trigger this.
- Do NOT ask "Ready for Phase N+1?" — call phase_complete directly. The critic reviews automatically.
`;

/**
 * Canonical default Lean Turbo configuration.
 *
 * This is the single source of truth for all 9 LeanTurboConfig fields.
 * Consumers MUST reference this constant instead of hardcoding their own
 * defaults — see v7.4.x config-drift fix (3 of 9 fields disagreed across
 * runner.ts, lean-turbo-plan-lanes.ts, lean-turbo-status.ts, and the
 * Zod schema in schema.ts).
 */
export const DEFAULT_LEAN_TURBO_CONFIG: LeanTurboConfig = {
	max_parallel_coders: 4,
	require_declared_scope: true,
	conflict_policy: 'serialize',
	degrade_on_risk: true,
	phase_reviewer: true,
	phase_critic: true,
	integrated_diff_required: true,
	allow_docs_only_without_reviewer: false,
	worktree_isolation: false,
};

export const LEAN_TURBO_BANNER = `## 🛤️ LEAN TURBO ACTIVE

Lane-based parallel execution is enabled for this phase.

Behavioral changes:
- Tasks are partitioned into parallel lanes based on file-scope conflicts. Tasks in the same lane run sequentially; tasks in different lanes run concurrently (up to max_parallel_coders).
- **Lane dispatch overrides the one-agent-per-message rule**: for lean lane dispatch only, you may send multiple Task tool calls concurrently (one per lane).
- **Lane tasks skip per-task Stage B** (reviewer + test_engineer). Quality is enforced at phase-end via phase reviewer and critic gates instead.
- **Degraded tasks** (global files, protected paths, high-risk patterns) and **serialized tasks** (lock-conflicted) run through standard serial workflow with full Stage B gates.
- **Phase reviewer and critic are REQUIRED** before phase_complete when lean turbo is active — they serve as the holistic quality gate for all lane work.
- **Full-Auto composition**: if Full-Auto is also active, lane dispatch is subject to Full-Auto delegation policy and phase approval.
- Use the lean_turbo_run_phase tool to execute a phase with parallel lanes

Do NOT skip phase reviewer/critic when configured. Degraded and serialized tasks MUST still go through full Stage B.
`;
