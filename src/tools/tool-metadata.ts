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
 * Cross-checked with ./manifest.ts: that file registers handlers via
 * `defineHandlers<T extends Record<ToolName, () => ToolDefinition>>` with
 * `ToolName = keyof typeof TOOL_METADATA`, so adding a tool here without wiring a
 * handler there (or vice versa) is a COMPILE error - the dead-tools bug class
 * stays impossible.
 */
import { type AgentName, ALL_AGENT_NAMES } from '../config/agent-names';

/** A tool's registration metadata. All fields required so a missing one is a compile error. */
export interface ToolMeta {
	/** Human-readable description surfaced to agents (TOOL_DESCRIPTIONS). */
	description: string;
	/** Agents granted this tool by default (inverted into AGENT_TOOL_MAP). Empty = overlay-only. */
	agents: AgentName[];
	/** Explicit PR-workflow capability. Omitted tools remain fail-closed. */
	prWorkflow?: {
		modes: Array<'PR_REVIEW' | 'PR_FEEDBACK'>;
		capability: 'observe' | 'validate';
	};
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
			'critic_finding_validator',
			'critic_oversight',
			'coder',
			'test_engineer',
		],
		prWorkflow: {
			modes: ['PR_REVIEW', 'PR_FEEDBACK'],
			capability: 'observe',
		},
	},
	diff_summary: {
		description:
			'filter classified AST changes by category, risk level, or file for reviewer drill-down',
		agents: [
			'architect',
			'reviewer',
			'critic_finding_validator',
			'critic_oversight',
		],
		prWorkflow: {
			modes: ['PR_REVIEW', 'PR_FEEDBACK'],
			capability: 'observe',
		},
	},
	syntax_check: {
		description:
			'check syntax of source files using tree-sitter parsers across multiple languages, returning per-file errors',
		agents: ['architect', 'coder', 'test_engineer'],
		prWorkflow: {
			modes: ['PR_REVIEW'],
			capability: 'validate',
		},
	},
	placeholder_scan: {
		description: 'todo and FIXME comment detection',
		agents: ['architect', 'reviewer', 'critic_finding_validator'],
		prWorkflow: {
			modes: ['PR_REVIEW', 'PR_FEEDBACK'],
			capability: 'observe',
		},
	},
	imports: {
		description:
			'find all consumers that import from a given file — use before refactoring shared modules to avoid breaking unseen dependents',
		agents: [
			'architect',
			'sme',
			'researcher',
			'docs',
			'docs_design',
			'critic_sounding_board',
			'critic_drift_verifier',
			'critic_hallucination_verifier',
			'reviewer',
			'critic_finding_validator',
			'critic',
			'coder',
			'test_engineer',
		],
		prWorkflow: {
			modes: ['PR_REVIEW', 'PR_FEEDBACK'],
			capability: 'observe',
		},
	},
	lint: {
		description:
			'run project linter in check or fix mode; supports biome, eslint, ruff, clippy, and more, returns structured results',
		agents: ['architect', 'reviewer', 'critic_finding_validator', 'coder'],
		prWorkflow: {
			modes: ['PR_REVIEW'],
			capability: 'validate',
		},
	},
	secretscan: {
		description:
			'scan for secrets (API keys, tokens, passwords) via regex and entropy; returns redacted previews, excludes common dirs',
		agents: [
			'architect',
			'reviewer',
			'critic_finding_validator',
			'critic_oversight',
		],
		prWorkflow: {
			modes: ['PR_REVIEW'],
			capability: 'validate',
		},
	},
	sast_scan: {
		description: 'static analysis security scan',
		agents: [
			'architect',
			'reviewer',
			'critic_finding_validator',
			'critic_oversight',
		],
		prWorkflow: {
			modes: ['PR_REVIEW'],
			capability: 'validate',
		},
	},
	build_check: {
		description:
			'discover and run build, typecheck, and test commands for various project ecosystems in the working directory',
		agents: ['architect', 'coder', 'test_engineer'],
	},
	pre_check_batch: {
		description:
			'parallel verification: lint:check + secretscan + sast_scan + quality_budget',
		agents: ['architect', 'reviewer', 'critic_finding_validator'],
	},
	quality_budget: {
		description: 'code quality budget check',
		agents: ['architect'],
		prWorkflow: {
			modes: ['PR_REVIEW'],
			capability: 'validate',
		},
	},
	symbols: {
		description:
			'extract exported symbols (functions, classes, interfaces, types) from source files; supports TypeScript, JavaScript, and Python',
		agents: [
			'architect',
			'sme',
			'researcher',
			'docs',
			'docs_design',
			'designer',
			'critic_sounding_board',
			'critic_drift_verifier',
			'critic_hallucination_verifier',
			'spec_writer',
			'reviewer',
			'critic_finding_validator',
			'critic',
			'coder',
			'test_engineer',
		],
	},
	complexity_hotspots: {
		description: 'git churn × complexity risk map',
		agents: [
			'architect',
			'sme',
			'researcher',
			'critic_sounding_board',
			'critic_drift_verifier',
			'critic_hallucination_verifier',
			'reviewer',
			'critic_finding_validator',
			'critic',
			'critic_oversight',
			'explorer',
			'test_engineer',
		],
	},
	schema_drift: {
		description: 'OpenAPI spec vs route drift',
		agents: ['architect', 'sme', 'researcher', 'docs', 'explorer'],
		prWorkflow: {
			modes: ['PR_REVIEW', 'PR_FEEDBACK'],
			capability: 'observe',
		},
	},
	todo_extract: {
		description: 'structured TODO/FIXME extraction',
		agents: ['architect', 'researcher', 'docs', 'explorer'],
		prWorkflow: {
			modes: ['PR_REVIEW', 'PR_FEEDBACK'],
			capability: 'observe',
		},
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
	complete_pr_workflow: {
		description:
			'validate terminal PR workflow evidence and clear its durable session gate',
		agents: ['architect'],
	},
	abort_pr_workflow: {
		description:
			'abort an unrecoverable PR_REVIEW/PR_FEEDBACK mechanical gate and clear its durable session state',
		agents: ['architect'],
	},
	authorize_pr_review_reentry: {
		description:
			'issue a one-use, identity-bound reviewer/test_engineer re-entry authorization for the active PR_REVIEW workflow (issue #2383)',
		agents: ['architect'],
	},
	submit_pr_review_result: {
		description:
			'submit one child-bound typed result for an active PR-review base or micro discovery lane',
		agents: [],
		prWorkflow: { modes: ['PR_REVIEW'], capability: 'validate' },
	},
	approve_plan_critic: {
		description:
			'record a MANUAL plan_critic_gate approval snapshot to unblock the ratchet-tighter critic_pre_plan execution gate when the critic already returned APPROVED but the mechanical recorder failed to persist it (issue #2012), or as the sanctioned recovery for a bookkeeping-grade hashed-field repair under the critic-gate PLAN FREEZE rule (the reason must state which case applies)',
		agents: ['architect'],
	},
	prepare_pr_workflow_checkout: {
		description:
			'prepare an auditable PR workflow checkout or restore its exact original branch/HEAD and preserved stash after terminal cleanup',
		agents: ['architect'],
	},
	invalidate_pr_feedback_publication: {
		description:
			'invalidate the armed PR_FEEDBACK publication generation so approved content can change, superseding every content-dependent approval and reopening the exact scoped rework + fresh-review path (issue #2108)',
		agents: ['architect'],
	},
	record_implementation_review: {
		description:
			'record fresh-context reviewer + critic APPROVE verdicts for the implementation diff so the /swarm issue --trace workflow can satisfy its review gate before commit-pr handoff',
		agents: ['architect'],
	},
	record_issue_publication: {
		description:
			'record a publication receipt so the /swarm issue --trace workflow reaches its terminal published state after the PR is created/updated',
		agents: ['architect'],
	},
	record_issue_reproduction: {
		description:
			'record the reproduction outcome for the current traced issue so the /swarm issue --trace workflow can satisfy its reproduction gate and transition to PLAN',
		agents: ['architect'],
	},
	record_recurrence_sweep: {
		description:
			'record the recurrence sweep (defect class, predicates, hit dispositions, guardrail proof) so the /swarm issue --trace workflow can satisfy its recurrence gate before commit-pr handoff',
		agents: ['architect'],
	},
	rebind_pr_feedback_head: {
		description:
			'rebind a PR_FEEDBACK workflow to a new verified remote PR head after merge/rebase/conflict repair, invalidating ancestry-bound receipts so the mechanical ladder re-runs',
		agents: ['architect'],
	},
	run_pr_feedback_stage_a: {
		description:
			'execute and persist mandatory PR-feedback Stage A checks on a content-bound revision',
		agents: ['architect'],
	},
	submit_council_verdicts: {
		description:
			'submit pre-collected council member verdicts for synthesis (architect MUST dispatch critic/reviewer/sme/test_engineer/explorer as Agent tasks first; this tool synthesizes only, it does not contact members)',
		agents: [],
	},
	submit_phase_council_verdicts: {
		description:
			'submit pre-collected phase-level council member verdicts for holistic phase synthesis (architect MUST dispatch all 5 council members with phase-scoped context first; this tool synthesizes only, it does not contact members)',
		agents: [],
	},
	declare_council_criteria: {
		description:
			'pre-declare acceptance criteria for a task before the coder starts work; criteria are read back during council evaluation',
		agents: [],
	},
	sbom_generate: {
		description: 'SBOM generation for dependency inventory',
		agents: ['architect'],
	},
	checkpoint: {
		description:
			'create named git checkpoints for save, restore, and delete — use before risky operations to enable rollback',
		agents: ['architect'],
	},
	pkg_audit: {
		description: 'dependency vulnerability scan — npm/pip/cargo',
		agents: [
			'architect',
			'critic_hallucination_verifier',
			'reviewer',
			'critic_finding_validator',
			'critic_oversight',
			'test_engineer',
		],
		prWorkflow: {
			modes: ['PR_REVIEW'],
			capability: 'validate',
		},
	},
	parse_lane_candidates: {
		description:
			'Parse [CANDIDATE] rows from a dispatch_lanes or collect_lane_results artifact (by output_ref), produce structured records with provenance, optionally persist to a per-batch sidecar JSONL. Pure-parser variant exists as internal module.',
		agents: ['architect'],
	},
	plan_conflict_check: {
		description:
			'read-only advisory check (#1656): compute a pairwise file-conflict matrix for N proposed parallel task groups using declared scopes and optional git co-change; returns a verdict (all_disjoint / conflicts_present / unknown_scopes), per-pair evidence, and a suggested serialization order. Writes nothing — the execution gate independently recomputes the verdict inline at dispatch time via the same helper. Call BEFORE attempting parallel dispatch to confirm disjointness.',
		agents: ['architect'],
	},
	write_pr_review_trigger_eval: {
		description:
			'persist the complete PR-review trigger evaluation with exact-set validation, dispatch provenance, and live merge-base verification',
		agents: ['architect'],
	},
	write_pr_review_artifact: {
		description:
			'persist schema-validated PR-review findings checkpoints and exact actionable feedback handoffs under the active run',
		agents: ['architect'],
	},
	prepare_pr_feedback_scope: {
		description:
			'prepare an exact file scope for one PR-feedback coder Task after immutable feedback verification settles',
		agents: ['architect'],
	},
	test_runner: {
		description: 'auto-detect and run tests',
		agents: [
			'architect',
			'reviewer',
			'critic_finding_validator',
			'test_engineer',
		],
		prWorkflow: {
			modes: ['PR_REVIEW'],
			capability: 'validate',
		},
	},
	test_impact: {
		description:
			'identify test files impacted by changed source files via import analysis',
		agents: [
			'architect',
			'reviewer',
			'critic_finding_validator',
			'critic_oversight',
			'test_engineer',
		],
		prWorkflow: {
			modes: ['PR_REVIEW', 'PR_FEEDBACK'],
			capability: 'observe',
		},
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
	git_blame: {
		description:
			'per-line git blame metadata: sha, author, date, summary for each line in a file',
		agents: ['reviewer', 'critic_finding_validator', 'explorer', 'architect'],
		prWorkflow: {
			modes: ['PR_REVIEW', 'PR_FEEDBACK'],
			capability: 'observe',
		},
	},
	gitingest: {
		description: 'fetch a GitHub repository full content via gitingest.com',
		agents: ['architect', 'docs', 'explorer'],
		prWorkflow: {
			modes: ['PR_REVIEW', 'PR_FEEDBACK'],
			capability: 'observe',
		},
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
			'critic_finding_validator',
			'critic',
			'coder',
			'test_engineer',
		],
		// Safe to gate-allow: read-only retrieval of a stored summary artifact.
		// Necessary: the summarizer advertises this tool as the recovery path for
		// truncated outputs, so it must remain reachable during PR workflows.
		prWorkflow: {
			modes: ['PR_REVIEW', 'PR_FEEDBACK'],
			capability: 'observe',
		},
	},
	retrieve_lane_output: {
		description:
			'retrieve paged full dispatch lane output by output_ref; use before consuming truncated lane previews or routing candidates from lane results',
		agents: ['architect'],
		prWorkflow: {
			modes: ['PR_REVIEW', 'PR_FEEDBACK'],
			capability: 'observe',
		},
	},
	extract_code_blocks: {
		description: 'extract code blocks from text content and save them to files',
		// Write-capable NON-orchestrator roles only (issue #1778 C1). Read-only
		// lane roles (explorer, sme, reviewer) must not hold a file-writing tool;
		// architect is a delegating orchestrator that writes nothing directly, so
		// it must not hold a WRITE_TOOL_NAMES member either (capability-drift-guard
		// invariant: no write tool in AGENT_TOOL_MAP.architect).
		agents: [
			'docs',
			'docs_design',
			'designer',
			'spec_writer',
			'coder',
			'test_engineer',
		],
	},
	phase_complete: {
		description:
			'preflight every applicable phase gate, report all blockers, and atomically commit a current passing snapshot',
		agents: ['architect'],
	},
	run_phase_review: {
		description:
			'run the bounded phase-final review engine and persist complete content-addressed review evidence',
		agents: ['architect'],
	},
	repair_gate_evidence: {
		description:
			'quarantine corrupt exact-task gate evidence and install a fresh blocked generation that requires every gate to rerun',
		agents: ['architect'],
	},
	repair_knowledge_receipt_ledger: {
		description:
			'validate or repair authoritative knowledge receipts, preserve corrupt authority in bounded quarantine, and require scoped re-evaluation',
		agents: ['architect'],
	},
	record_directive_override: {
		description:
			'record an audited architect override for identified critical-directive violations without bypassing unreadable authority',
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
	consensus_mine: {
		// Rendered into the architect system prompt, so it must not imply a single
		// artifact. Naming only the report was false: the run also prunes its own
		// older reports and appends to the shared recommendation dedup ledger,
		// whose root is `resolveKnowledgeStoreDir` — under a knowledge-link pointer
		// that ledger write lands in the shared cohort root, outside this project.
		description:
			'mine cross-run consensus from existing .swarm evidence into an immutable proposals-only report; also deletes its own reports past consensus.report_retention, appends to the shared recommendation dedup ledger (in the shared cohort root, outside this project, when a knowledge link is active), and mirrors proposals into pending swarm-memory proposals when memory is enabled',
		// The curator phase/postmortem roles are the consumers of cross-run
		// evidence; `curator` itself is NOT an AgentName (see
		// src/config/agent-names.ts) and using it here would be a compile error.
		agents: ['architect', 'curator_phase', 'curator_postmortem'],
		// `prWorkflow` is deliberately omitted: omitted tools are fail-closed in
		// PR_REVIEW / PR_FEEDBACK, which is the correct posture for a tool that
		// writes .swarm state during a review-only workflow.
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
			'critic_finding_validator',
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
	context_status: {
		description:
			'report current context-window headroom for the active session — returns tokens-used, usageSource (provider|estimated), model-limit with provenance (modelLimitSource: host|override|provider_cap|native|fallback; modelLimitResolution: user_provider_model|user_model|user_default|live_model_limit|static_provider_cap|static_native|static_default; fallbackActive: true when the denominator came from a static table or the flat 128k default — treat headroom as uncertain), usage-percent, threshold-state (none/warn/critical), model name, and provider. Pure read-only: no state mutation, no warning injection. Works whether context_budget.enabled is true or false.',
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
			'critic_finding_validator',
			'critic_oversight',
			'explorer',
			'coder',
			'test_engineer',
			'researcher',
		],
	},
	ast_grep: {
		description:
			'Read-only structural AST search using ast-grep patterns with optional language and glob filters. Use for syntax-aware code pattern searches; does not rewrite files.',
		agents: [
			'architect',
			'sme',
			'docs',
			'docs_design',
			'critic_hallucination_verifier',
			'spec_writer',
			'explorer',
			'coder',
			'test_engineer',
			'researcher',
		],
	},
	actionlint_scan: {
		description:
			'Run actionlint against GitHub Actions workflow YAML files with structured findings. Resolves actionlint lazily and does not modify files.',
		agents: ['architect', 'test_engineer'],
		prWorkflow: {
			modes: ['PR_REVIEW'],
			capability: 'validate',
		},
	},
	osv_scan: {
		description:
			'Run OSV-Scanner against a workspace path and return structured dependency vulnerability findings. Resolves osv-scanner lazily and does not modify files.',
		agents: ['architect', 'test_engineer'],
		prWorkflow: {
			modes: ['PR_REVIEW'],
			capability: 'validate',
		},
	},
	gh_evidence: {
		description:
			'Fetch bounded GitHub pull request or issue metadata through gh for review and CI evidence. Resolves gh lazily and is read-only.',
		agents: ['architect', 'researcher'],
		prWorkflow: {
			modes: ['PR_REVIEW', 'PR_FEEDBACK'],
			capability: 'observe',
		},
	},
	pr_workflow_status: {
		description:
			'Read-only architect observation of local git state (HEAD, branch, clean/dirty with a bounded changed-file list, remotes) plus a session-pinned PR workflow gate summary and the PR_FEEDBACK publication-generation section (state, attempts, invalidation reason, recovery guidance). Use to observe state under the fail-closed PR_REVIEW/PR_FEEDBACK gate. Never executes PR-controlled scripts and never reads another session gate.',
		agents: ['architect'],
		prWorkflow: {
			modes: ['PR_REVIEW', 'PR_FEEDBACK'],
			capability: 'observe',
		},
	},
	batch_symbols: {
		description:
			'Batched symbol extraction across multiple files. Returns per-file symbol summaries with isolated error handling.',
		agents: [
			'architect',
			'critic_hallucination_verifier',
			'reviewer',
			'critic_finding_validator',
			'critic_oversight',
			'explorer',
		],
	},
	suggest_patch: {
		description:
			'Reviewer-safe structured patch suggestion tool. Produces context-anchored patch artifacts without file modification. Returns structured diagnostics on context mismatch.',
		agents: ['architect', 'reviewer', 'critic_finding_validator'],
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
			'query the repo code graph: importers, dependencies, blast radius, localization, ontology facts, package boundaries, and heuristic preflight packets before refactoring; ontology findings are advisory, not formal proofs',
		agents: [
			'architect',
			'critic_sounding_board',
			'critic_drift_verifier',
			'critic_hallucination_verifier',
			'critic_architecture_supervisor',
			'reviewer',
			'critic_finding_validator',
			'critic',
			'critic_oversight',
			'explorer',
			'coder',
		],
		prWorkflow: {
			modes: ['PR_REVIEW', 'PR_FEEDBACK'],
			capability: 'observe',
		},
	},
	get_qa_gate_profile: {
		description:
			'retrieve the QA gate profile for the current or exact future plan identity: gates (reviewer, test_engineer, sme_enabled, critic_pre_plan, sast_enabled, council_mode, hallucination_guard, mutation_test, phase_council, drift_check, final_council), lock state, and profile hash. Read-only and never creates state.',
		agents: ['architect'],
	},
	set_qa_gates: {
		description:
			'configure the QA gate profile for the current plan or bootstrap an exact future plan with swarm_id and plan_title. Architect-only. The initial selection may set explicit true/false values over defaults; later changes are ratchet-tighter and rejected once locked after critic approval. Supports: reviewer, test_engineer, sme_enabled, critic_pre_plan, sast_enabled, council_mode, hallucination_guard, mutation_test, phase_council, drift_check, final_council, plus adopt_legacy_binding_only for exact-binding recovery without mutating gates.',
		agents: ['architect'],
	},
	web_search: {
		description:
			'External web search (Tavily or Brave) for architect-driven council research, SME domain research, researcher auto-research, and skill-improver research. Returns titled results with snippets, URLs, normalized query metadata, temporal intent, freshness, and removed stale years. Config-gated on council.general.enabled in the resolved config: global ~/.config/opencode/opencode-swarm.json, then project .opencode/opencode-swarm.json overrides. Requires a search API key. Used by the architect in MODE: COUNCIL to gather a RESEARCH CONTEXT before dispatching council agents, by SME for opt-in external skill/source evaluation, and by the researcher agent for multi-source auto-research.',
		agents: ['sme', 'researcher', 'skill_improver'],
	},
	web_fetch: {
		description:
			'Fetch the readable text of a single http(s) URL (architect-only). Returns decoded page text, document title, final URL after redirects, and an evidence reference. Reads primary sources that web_search only surfaces as snippets. Config-gated on council.general.enabled. Blocks private/loopback/link-local/metadata addresses (re-validated and re-pinned across redirects); enforces timeout and body size cap.',
		agents: [],
	},
	convene_general_council: {
		description:
			'Synthesize responses from a multi-model General Council. Accepts parallel member responses (Round 1, optionally Round 2), detects disagreements, and returns consensus points, persisting disagreements, and a structured synthesis. Architect-only. Config-gated on council.general.enabled in the resolved config: global ~/.config/opencode/opencode-swarm.json, then project .opencode/opencode-swarm.json overrides.',
		agents: [],
	},
	write_final_council_evidence: {
		description:
			'Persist project-scoped final council evidence to .swarm/evidence/final-council.json. PREREQUISITE: dispatch critic, reviewer, sme, test_engineer, and explorer as project-scoped Agent tasks and collect their CouncilMemberVerdict JSON — this tool synthesizes only. Rejects on insufficient quorum or CONCERNS with unresolved requiredFixes; normalizes verdicts to approved/concerns/rejected. Architect-only.',
		agents: [],
	},
	skill_generate: {
		description: 'compile knowledge entries into a structured SKILL.md draft',
		// 'architect' is intentionally omitted here; added via SKILL_AGENT_TOOL_MAP when skills.enabled === true (FR-004).
		agents: ['skill_improver'],
	},
	skill_list: {
		description: 'list generated skill files and their status',
		// 'architect' is intentionally omitted here; added via SKILL_AGENT_TOOL_MAP when skills.enabled === true (FR-004).
		agents: ['skill_improver'],
	},
	skill_apply: {
		description: 'activate a draft skill proposal',
		// 'architect' is intentionally omitted here; added via SKILL_AGENT_TOOL_MAP when skills.enabled === true (FR-004).
		agents: [],
	},
	skill_inspect: {
		description: 'inspect the content and source entries of a skill file',
		// 'architect' is intentionally omitted here; added via SKILL_AGENT_TOOL_MAP when skills.enabled === true (FR-004).
		agents: ['skill_improver'],
	},
	run_stale_reconciliation: {
		description:
			'reconcile skills against the knowledge store: mark skills stale when source knowledge is archived or deleted, or clear stale markers',
		agents: ['architect'],
	},
	skill_regenerate: {
		description:
			'regenerate an active skill by re-clustering its source knowledge entries and updating the SKILL.md in place',
		// 'architect' is intentionally omitted here; added via SKILL_AGENT_TOOL_MAP when skills.enabled === true (FR-004).
		agents: [],
	},
	skill_retire: {
		description:
			'retire a generated skill by adding a retired.marker file; retired skills are excluded from scoring and injection',
		// 'architect' is intentionally omitted here; added via SKILL_AGENT_TOOL_MAP when skills.enabled === true (FR-004).
		agents: [],
	},
	skill_improve: {
		description: 'run the skill_improver agent to review and refine skills',
		// 'architect' is intentionally omitted here; added via SKILL_AGENT_TOOL_MAP when skills.enabled === true (FR-004).
		agents: ['skill_improver'],
	},
	spec_write: {
		description: 'author or update .swarm/spec.md for the current project',
		agents: ['spec_writer'],
	},
	knowledge_receipt: {
		description:
			'file a receipt for retrieved knowledge (applied/ignored/contradicted + new lessons), recorded as immutable knowledge events',
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
			'critic_finding_validator',
			'critic',
			'coder',
			'test_engineer',
		],
	},
	knowledge_archive: {
		description:
			'archive (default), quarantine, or purge a swarm or hive knowledge entry by ID with an immutable audit tombstone; purge requires an admin flag',
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
	swarm_memory_outcome: {
		description:
			'record useful, dead-end, or corrected outcomes and, when enabled, synchronously refresh deterministic memory lessons',
		agents: [],
	},
	swarm_command: {
		description:
			'run supported /swarm commands through the canonical command registry',
		agents: [
			'architect',
			'sme',
			'researcher',
			'docs',
			'docs_design',
			'designer',
			'reviewer',
			'critic_finding_validator',
			'critic',
			'explorer',
			'coder',
			'test_engineer',
		],
	},
	dispatch_lanes: {
		description:
			'dispatch read-only exploration/review lanes concurrently and BLOCK until all finish; prefer dispatch_lanes_async for non-blocking dispatch, use this only when promptAsync is unavailable',
		agents: ['architect'],
	},
	dispatch_lanes_async: {
		description:
			'launch read-only advisory lanes non-blockingly and return a batch id plus lane session handles immediately so you can keep working; launch_timeout_ms is only a promptAsync acceptance budget, not a lane runtime timeout; poll incrementally with collect_lane_results (wait omitted or false) while doing independent investigation, or join with wait: true when you need all results',
		agents: ['architect'],
	},
	collect_lane_results: {
		description:
			'collect or poll results for a dispatch_lanes_async batch; a pure OBSERVER that never cancels or terminalizes child work unless you explicitly pass cancel_pending. Supports both non-blocking polling (wait omitted or false) and blocking join (wait: true). The wait budget bounds the observer call only — its expiry never kills a lane and is not evidence a lane died, so do not abort the workflow because a collection expired; poll again, cancel explicitly, or rely on the presumed-stale backstop. Any unsettled lane is reported in pending_lanes (batch_id, lane_id, stored status, output_ref when present) regardless of include_pending; busy/retry lanes are not timed out just because they run for a long time. Does not advance workflow gates. Inline output for a settled lane is delivered only once: later polls of the same lane set output_omitted_repeat: true and omit output, but still include output_ref for recovery via retrieve_lane_output.',
		agents: ['architect'],
	},
	summarize_work: {
		description:
			'emit a short structured summary of completed work (key decisions, assumptions, risks, constraints) at task completion; rolls up per phase for architecture-supervisor review. Advisory, never blocks.',
		agents: [
			'architect',
			'sme',
			'researcher',
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
		agents: [],
	},
	lean_turbo_acquire_locks: {
		description:
			'acquire file locks for all files in a lane (all-or-nothing) before lane execution',
		agents: [],
	},
	lean_turbo_runner_status: {
		description: 'read Lean Turbo run state from .swarm/turbo-state.json',
		agents: [],
	},
	lean_turbo_review: {
		description:
			'dispatch a read-only reviewer agent to evaluate a completed Lean Turbo phase',
		agents: [],
	},
	lean_turbo_run_phase: {
		description:
			'Execute a phase using Lean Turbo parallel lane execution. Plans lanes, acquires file locks, and dispatches coder agents concurrently. Use when Lean Turbo is active and you want to execute all tasks in a phase in parallel lanes.',
		agents: [],
	},
	lean_turbo_status: {
		description:
			'returns Lean Turbo configuration and active status for the current session',
		agents: [],
	},
	swarm_apply_patch: {
		description:
			'Apply a unified diff patch to workspace files with exact context matching, atomic writes, and path validation. Use standard unified diff format only — does NOT support *** Begin Patch / *** Update File payloads (use native apply_patch for those).',
		agents: ['coder', 'test_engineer'],
	},
	external_skill_discover: {
		description:
			'Discover external skill candidates from configured sources. Returns a disabled message when external_skills.curation_enabled is false.',
		agents: [],
	},
	external_skill_list: {
		description:
			'List external skill candidates in the quarantine store. Returns a disabled message when external_skills.curation_enabled is false.',
		agents: [],
	},
	external_skill_inspect: {
		description:
			'Inspect a specific external skill candidate by ID. Returns a disabled message when external_skills.curation_enabled is false.',
		agents: [],
	},
	external_skill_promote: {
		description:
			'Promote a validated external skill candidate to an active generated skill. Returns a disabled message when external_skills.curation_enabled is false.',
		agents: [],
	},
	external_skill_reject: {
		description:
			'Reject an external skill candidate after evaluation. Returns a disabled message when external_skills.curation_enabled is false.',
		agents: [],
	},
	external_skill_delete: {
		description:
			'Delete an external skill candidate from the quarantine store. Returns a disabled message when external_skills.curation_enabled is false.',
		agents: [],
	},
	external_skill_revoke: {
		description:
			'Revoke a previously promoted external skill. Returns a disabled message when external_skills.curation_enabled is false.',
		agents: [],
	},
	epic_decide_phase: {
		description:
			'Compute the Epic Mode verdict for a phase WITHOUT dispatching coders. Runs preflight + calibration + the three gates (p-threshold, hot-module, greenfield), persists the decision, and returns the verdict so the architect can dispatch waves via the visible Task tool (promote) or fall back to per-task serial (demote). Pair with `epic_plan_waves` to get the wave plan when promoted. Use when /swarm epic is on for the session.',
		agents: ['architect'],
	},
	epic_plan_waves: {
		description:
			"Partition a phase's pending tasks into ordered concurrent waves for Epic Mode dispatch. " +
			'A wave is a set of tasks with mutually disjoint declared scopes and all dependencies satisfied by prior waves. ' +
			'Returns `{ waves: [{ waveId, taskIds, files }, ...], serializedTasks, degradedTasks }`. ' +
			'For each wave in order, the architect dispatches one `Task(subagent_type="coder", ...)` per `taskId` — all in one assistant message — so the wave runs concurrently and each coder appears as a visible subagent. ' +
			'Wait for the wave to finish before dispatching the next. ' +
			'Pair with `epic_decide_phase` (called first; this tool is only relevant on a `promote` verdict). ' +
			'Preflight reject reasons: `no-plan`, `no-phase`, `phase-empty`, `phase-already-complete`, `scopes-missing` (call `declare_scope` for `missingScopes`), `git-failed` (transient — retry), `planner-error`.',
		agents: ['architect'],
	},
	epic_record_divergence: {
		description:
			"After every `update_task_status(completed)`, record the task's declared-vs-actual divergence to .swarm/epic/divergence.jsonl. Feeds Epic Mode's self-calibration loop (Capability D). Best-effort: never blocks.",
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

export function getPrWorkflowToolCapability(
	toolName: string,
	mode: 'PR_REVIEW' | 'PR_FEEDBACK',
): 'observe' | 'validate' | null {
	const metadata = (TOOL_METADATA as Record<string, ToolMeta>)[toolName];
	if (!metadata?.prWorkflow?.modes.includes(mode)) return null;
	return metadata.prWorkflow.capability;
}

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
 * the council members). Tools with `agents: []` stay OUT of this default map
 * and are applied only via opt-in maps such as MEMORY_AGENT_TOOL_MAP or
 * GENERAL_COUNCIL_AGENT_TOOL_MAP.
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
