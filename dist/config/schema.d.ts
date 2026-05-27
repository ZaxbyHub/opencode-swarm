import { z } from 'zod';
import { type AgentName } from './constants';
/**
 * Test-only dependency-injection seam — see `gitignore-warning.ts:_internals`
 * for the rationale (`mock.module` from `bun:test` leaks across files in
 * Bun's shared test-runner process). Mutating this local object is
 * file-scoped and trivially restorable via `afterEach`.
 */
export declare const _internals: {
    stripKnownSwarmPrefix: typeof stripKnownSwarmPrefix;
    getCanonicalAgentRole: typeof getCanonicalAgentRole;
    resolveGuardrailsConfig: typeof resolveGuardrailsConfig;
};
/**
 * Type guard: returns true when `role` is a canonical agent role recognized
 * by the plugin (e.g. "architect", "coder", "critic_oversight"). User-defined
 * swarm IDs must NOT be treated as canonical roles.
 */
export declare function isKnownCanonicalRole(role: string): role is AgentName;
/**
 * Extract the canonical agent role from a generated agent name, using
 * suffix-based matching with longest-suffix-wins.
 *
 * Generated agent names have the shape `<arbitrary user-defined swarm ID>
 * <separator> <canonical role>`. The swarm ID is opaque to the plugin —
 * it can be anything the user configures (e.g. `banana`, `acme-prod`,
 * `customer123`). Only the canonical role suffix is plugin-defined.
 *
 * Behavior:
 *   - If `agentName` is itself a canonical role, return it unchanged.
 *   - Else, find the longest canonical role `R` such that `agentName`
 *     ends with `<sep><R>` for some separator in {"_", "-", " "}; return `R`.
 *   - Else, return `agentName` unchanged (caller can detect "no role found"
 *     by comparing the result to `agentName`, or by passing the result
 *     through `isKnownCanonicalRole`).
 *
 * Optional `generatedAgentNames` argument: when supplied (e.g. from
 * `getAgentConfigs` output at plugin init), the function ONLY infers a role
 * for names actually present in that registry. Bare user-supplied strings
 * like `not_an_architect` are NOT treated as roles unless they appear in
 * the generated-name set. Callers that need this strict behavior should
 * use `resolveGeneratedAgentRole` instead.
 *
 * Case-insensitive on the input; the returned role is the canonical
 * lowercase form from `ALL_AGENT_NAMES`.
 */
export declare function getCanonicalAgentRole(agentName: string, generatedAgentNames?: Iterable<string>): AgentName | string;
/**
 * Strict variant of {@link getCanonicalAgentRole}: only infers a canonical
 * role when the agent name is actually present in the supplied generated-
 * name registry, OR is itself a canonical role. Use this from callers that
 * must avoid treating arbitrary user-supplied strings as roles.
 */
export declare function resolveGeneratedAgentRole(agentName: string, generatedAgentNames: Iterable<string>): AgentName | string;
/**
 * Backward-compatible alias for {@link getCanonicalAgentRole}. The previous
 * implementation stripped a hardcoded list of "known swarm prefixes" from
 * the front of the agent name. That approach was wrong by design: swarm
 * IDs are arbitrary user-defined strings — the plugin cannot enumerate
 * them. The new implementation does suffix-based canonical role extraction
 * (see `getCanonicalAgentRole`) which works for ANY user-defined swarm ID.
 *
 * Existing tests that pass `synthetic_reviewer` / `mega_architect` /
 * `cloud_critic_oversight` / etc. continue to pass because those names
 * end with `<sep><canonical role>`, which is exactly what the suffix
 * extractor matches.
 */
export declare function stripKnownSwarmPrefix(agentName: string): string;
export declare const AgentOverrideConfigSchema: z.ZodObject<{
    model: z.ZodOptional<z.ZodString>;
    variant: z.ZodOptional<z.ZodString>;
    temperature: z.ZodOptional<z.ZodNumber>;
    disabled: z.ZodOptional<z.ZodBoolean>;
    fallback_models: z.ZodOptional<z.ZodArray<z.ZodString>>;
}, z.core.$strip>;
export type AgentOverrideConfig = z.infer<typeof AgentOverrideConfigSchema>;
export declare const SwarmConfigSchema: z.ZodObject<{
    name: z.ZodOptional<z.ZodString>;
    agents: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
        model: z.ZodOptional<z.ZodString>;
        variant: z.ZodOptional<z.ZodString>;
        temperature: z.ZodOptional<z.ZodNumber>;
        disabled: z.ZodOptional<z.ZodBoolean>;
        fallback_models: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$strip>>>;
}, z.core.$strip>;
export type SwarmConfig = z.infer<typeof SwarmConfigSchema>;
export declare const HooksConfigSchema: z.ZodObject<{
    system_enhancer: z.ZodDefault<z.ZodBoolean>;
    compaction: z.ZodDefault<z.ZodBoolean>;
    agent_activity: z.ZodDefault<z.ZodBoolean>;
    delegation_tracker: z.ZodDefault<z.ZodBoolean>;
    agent_awareness_max_chars: z.ZodDefault<z.ZodNumber>;
    delegation_gate: z.ZodDefault<z.ZodBoolean>;
    delegation_max_chars: z.ZodDefault<z.ZodNumber>;
}, z.core.$strip>;
export type HooksConfig = z.infer<typeof HooksConfigSchema>;
export declare const ScoringWeightsSchema: z.ZodObject<{
    phase: z.ZodDefault<z.ZodNumber>;
    current_task: z.ZodDefault<z.ZodNumber>;
    blocked_task: z.ZodDefault<z.ZodNumber>;
    recent_failure: z.ZodDefault<z.ZodNumber>;
    recent_success: z.ZodDefault<z.ZodNumber>;
    evidence_presence: z.ZodDefault<z.ZodNumber>;
    decision_recency: z.ZodDefault<z.ZodNumber>;
    dependency_proximity: z.ZodDefault<z.ZodNumber>;
}, z.core.$strip>;
export type ScoringWeights = z.infer<typeof ScoringWeightsSchema>;
export declare const DecisionDecaySchema: z.ZodObject<{
    mode: z.ZodDefault<z.ZodEnum<{
        linear: "linear";
        exponential: "exponential";
    }>>;
    half_life_hours: z.ZodDefault<z.ZodNumber>;
}, z.core.$strip>;
export type DecisionDecay = z.infer<typeof DecisionDecaySchema>;
export declare const TokenRatiosSchema: z.ZodObject<{
    prose: z.ZodDefault<z.ZodNumber>;
    code: z.ZodDefault<z.ZodNumber>;
    markdown: z.ZodDefault<z.ZodNumber>;
    json: z.ZodDefault<z.ZodNumber>;
}, z.core.$strip>;
export type TokenRatios = z.infer<typeof TokenRatiosSchema>;
export declare const ScoringConfigSchema: z.ZodObject<{
    enabled: z.ZodDefault<z.ZodBoolean>;
    max_candidates: z.ZodDefault<z.ZodNumber>;
    weights: z.ZodOptional<z.ZodObject<{
        phase: z.ZodDefault<z.ZodNumber>;
        current_task: z.ZodDefault<z.ZodNumber>;
        blocked_task: z.ZodDefault<z.ZodNumber>;
        recent_failure: z.ZodDefault<z.ZodNumber>;
        recent_success: z.ZodDefault<z.ZodNumber>;
        evidence_presence: z.ZodDefault<z.ZodNumber>;
        decision_recency: z.ZodDefault<z.ZodNumber>;
        dependency_proximity: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strip>>;
    decision_decay: z.ZodOptional<z.ZodObject<{
        mode: z.ZodDefault<z.ZodEnum<{
            linear: "linear";
            exponential: "exponential";
        }>>;
        half_life_hours: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strip>>;
    token_ratios: z.ZodOptional<z.ZodObject<{
        prose: z.ZodDefault<z.ZodNumber>;
        code: z.ZodDefault<z.ZodNumber>;
        markdown: z.ZodDefault<z.ZodNumber>;
        json: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type ScoringConfig = z.infer<typeof ScoringConfigSchema>;
export declare const ContextBudgetConfigSchema: z.ZodObject<{
    enabled: z.ZodDefault<z.ZodBoolean>;
    warn_threshold: z.ZodDefault<z.ZodNumber>;
    critical_threshold: z.ZodDefault<z.ZodNumber>;
    model_limits: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodNumber>>;
    max_injection_tokens: z.ZodDefault<z.ZodNumber>;
    tracked_agents: z.ZodDefault<z.ZodArray<z.ZodString>>;
    scoring: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        max_candidates: z.ZodDefault<z.ZodNumber>;
        weights: z.ZodOptional<z.ZodObject<{
            phase: z.ZodDefault<z.ZodNumber>;
            current_task: z.ZodDefault<z.ZodNumber>;
            blocked_task: z.ZodDefault<z.ZodNumber>;
            recent_failure: z.ZodDefault<z.ZodNumber>;
            recent_success: z.ZodDefault<z.ZodNumber>;
            evidence_presence: z.ZodDefault<z.ZodNumber>;
            decision_recency: z.ZodDefault<z.ZodNumber>;
            dependency_proximity: z.ZodDefault<z.ZodNumber>;
        }, z.core.$strip>>;
        decision_decay: z.ZodOptional<z.ZodObject<{
            mode: z.ZodDefault<z.ZodEnum<{
                linear: "linear";
                exponential: "exponential";
            }>>;
            half_life_hours: z.ZodDefault<z.ZodNumber>;
        }, z.core.$strip>>;
        token_ratios: z.ZodOptional<z.ZodObject<{
            prose: z.ZodDefault<z.ZodNumber>;
            code: z.ZodDefault<z.ZodNumber>;
            markdown: z.ZodDefault<z.ZodNumber>;
            json: z.ZodDefault<z.ZodNumber>;
        }, z.core.$strip>>;
    }, z.core.$strip>>;
    enforce: z.ZodDefault<z.ZodBoolean>;
    prune_target: z.ZodDefault<z.ZodNumber>;
    preserve_last_n_turns: z.ZodDefault<z.ZodNumber>;
    recent_window: z.ZodDefault<z.ZodNumber>;
    enforce_on_agent_switch: z.ZodDefault<z.ZodBoolean>;
    tool_output_mask_threshold: z.ZodDefault<z.ZodNumber>;
}, z.core.$strip>;
export type ContextBudgetConfig = z.infer<typeof ContextBudgetConfigSchema>;
export declare const EvidenceConfigSchema: z.ZodObject<{
    enabled: z.ZodDefault<z.ZodBoolean>;
    max_age_days: z.ZodDefault<z.ZodNumber>;
    max_bundles: z.ZodDefault<z.ZodNumber>;
    auto_archive: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strip>;
export type EvidenceConfig = z.infer<typeof EvidenceConfigSchema>;
export declare const GateFeatureSchema: z.ZodObject<{
    enabled: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strip>;
export type GateFeature = z.infer<typeof GateFeatureSchema>;
export declare const PlaceholderScanConfigSchema: z.ZodObject<{
    enabled: z.ZodDefault<z.ZodBoolean>;
    deny_patterns: z.ZodDefault<z.ZodArray<z.ZodString>>;
    allow_globs: z.ZodDefault<z.ZodArray<z.ZodString>>;
    max_allowed_findings: z.ZodDefault<z.ZodNumber>;
}, z.core.$strip>;
export type PlaceholderScanConfig = z.infer<typeof PlaceholderScanConfigSchema>;
export declare const QualityBudgetConfigSchema: z.ZodObject<{
    enabled: z.ZodDefault<z.ZodBoolean>;
    max_complexity_delta: z.ZodDefault<z.ZodNumber>;
    max_public_api_delta: z.ZodDefault<z.ZodNumber>;
    max_duplication_ratio: z.ZodDefault<z.ZodNumber>;
    min_test_to_code_ratio: z.ZodDefault<z.ZodNumber>;
    enforce_on_globs: z.ZodDefault<z.ZodArray<z.ZodString>>;
    exclude_globs: z.ZodDefault<z.ZodArray<z.ZodString>>;
}, z.core.$strip>;
export type QualityBudgetConfig = z.infer<typeof QualityBudgetConfigSchema>;
export declare const GateConfigSchema: z.ZodObject<{
    syntax_check: z.ZodDefault<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
    }, z.core.$strip>>;
    placeholder_scan: z.ZodDefault<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        deny_patterns: z.ZodDefault<z.ZodArray<z.ZodString>>;
        allow_globs: z.ZodDefault<z.ZodArray<z.ZodString>>;
        max_allowed_findings: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strip>>;
    sast_scan: z.ZodDefault<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
    }, z.core.$strip>>;
    sbom_generate: z.ZodDefault<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
    }, z.core.$strip>>;
    build_check: z.ZodDefault<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
    }, z.core.$strip>>;
    quality_budget: z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        max_complexity_delta: z.ZodDefault<z.ZodNumber>;
        max_public_api_delta: z.ZodDefault<z.ZodNumber>;
        max_duplication_ratio: z.ZodDefault<z.ZodNumber>;
        min_test_to_code_ratio: z.ZodDefault<z.ZodNumber>;
        enforce_on_globs: z.ZodDefault<z.ZodArray<z.ZodString>>;
        exclude_globs: z.ZodDefault<z.ZodArray<z.ZodString>>;
    }, z.core.$strip>;
}, z.core.$strip>;
export type GateConfig = z.infer<typeof GateConfigSchema>;
export declare const PipelineConfigSchema: z.ZodObject<{
    parallel_precheck: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strip>;
export type PipelineConfig = z.infer<typeof PipelineConfigSchema>;
export declare const PhaseCompleteConfigSchema: z.ZodObject<{
    enabled: z.ZodDefault<z.ZodBoolean>;
    required_agents: z.ZodDefault<z.ZodArray<z.ZodEnum<{
        reviewer: "reviewer";
        test_engineer: "test_engineer";
        coder: "coder";
    }>>>;
    require_docs: z.ZodDefault<z.ZodBoolean>;
    policy: z.ZodDefault<z.ZodEnum<{
        enforce: "enforce";
        warn: "warn";
    }>>;
    regression_sweep: z.ZodOptional<z.ZodObject<{
        enforce: z.ZodDefault<z.ZodBoolean>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type PhaseCompleteConfig = z.infer<typeof PhaseCompleteConfigSchema>;
export declare const SummaryConfigSchema: z.ZodObject<{
    enabled: z.ZodDefault<z.ZodBoolean>;
    threshold_bytes: z.ZodDefault<z.ZodNumber>;
    max_summary_chars: z.ZodDefault<z.ZodNumber>;
    max_stored_bytes: z.ZodDefault<z.ZodNumber>;
    retention_days: z.ZodDefault<z.ZodNumber>;
    exempt_tools: z.ZodDefault<z.ZodArray<z.ZodString>>;
}, z.core.$strip>;
export type SummaryConfig = z.infer<typeof SummaryConfigSchema>;
export declare const ReviewPassesConfigSchema: z.ZodObject<{
    always_security_review: z.ZodDefault<z.ZodBoolean>;
    security_globs: z.ZodDefault<z.ZodArray<z.ZodString>>;
}, z.core.$strip>;
export type ReviewPassesConfig = z.infer<typeof ReviewPassesConfigSchema>;
export declare const AdversarialDetectionConfigSchema: z.ZodObject<{
    enabled: z.ZodDefault<z.ZodBoolean>;
    policy: z.ZodDefault<z.ZodEnum<{
        ignore: "ignore";
        gate: "gate";
        warn: "warn";
    }>>;
    pairs: z.ZodDefault<z.ZodArray<z.ZodTuple<[z.ZodString, z.ZodString], null>>>;
}, z.core.$strip>;
export type AdversarialDetectionConfig = z.infer<typeof AdversarialDetectionConfigSchema>;
export type AdversarialTestingConfig = {
    enabled: boolean;
    scope: 'all' | 'security-only';
};
export declare const AdversarialTestingConfigSchema: z.ZodType<AdversarialTestingConfig>;
export declare const IntegrationAnalysisConfigSchema: z.ZodObject<{
    enabled: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strip>;
export type IntegrationAnalysisConfig = z.infer<typeof IntegrationAnalysisConfigSchema>;
export declare const DocsConfigSchema: z.ZodObject<{
    enabled: z.ZodDefault<z.ZodBoolean>;
    doc_patterns: z.ZodDefault<z.ZodArray<z.ZodString>>;
}, z.core.$strip>;
export type DocsConfig = z.infer<typeof DocsConfigSchema>;
export declare const UIReviewConfigSchema: z.ZodObject<{
    enabled: z.ZodDefault<z.ZodBoolean>;
    trigger_paths: z.ZodDefault<z.ZodArray<z.ZodString>>;
    trigger_keywords: z.ZodDefault<z.ZodArray<z.ZodString>>;
}, z.core.$strip>;
export type UIReviewConfig = z.infer<typeof UIReviewConfigSchema>;
export declare const CompactionAdvisoryConfigSchema: z.ZodObject<{
    enabled: z.ZodDefault<z.ZodBoolean>;
    thresholds: z.ZodDefault<z.ZodArray<z.ZodNumber>>;
    message: z.ZodDefault<z.ZodString>;
}, z.core.$strip>;
export type CompactionAdvisoryConfig = z.infer<typeof CompactionAdvisoryConfigSchema>;
export declare const LintConfigSchema: z.ZodObject<{
    enabled: z.ZodDefault<z.ZodBoolean>;
    mode: z.ZodDefault<z.ZodEnum<{
        check: "check";
        fix: "fix";
    }>>;
    linter: z.ZodDefault<z.ZodEnum<{
        biome: "biome";
        eslint: "eslint";
        auto: "auto";
    }>>;
    patterns: z.ZodDefault<z.ZodArray<z.ZodString>>;
    exclude: z.ZodDefault<z.ZodArray<z.ZodString>>;
}, z.core.$strip>;
export type LintConfig = z.infer<typeof LintConfigSchema>;
export declare const SecretscanConfigSchema: z.ZodObject<{
    enabled: z.ZodDefault<z.ZodBoolean>;
    patterns: z.ZodDefault<z.ZodArray<z.ZodString>>;
    exclude: z.ZodDefault<z.ZodArray<z.ZodString>>;
    extensions: z.ZodDefault<z.ZodArray<z.ZodString>>;
}, z.core.$strip>;
export type SecretscanConfig = z.infer<typeof SecretscanConfigSchema>;
export declare const GuardrailsProfileSchema: z.ZodObject<{
    max_tool_calls: z.ZodOptional<z.ZodNumber>;
    max_duration_minutes: z.ZodOptional<z.ZodNumber>;
    max_repetitions: z.ZodOptional<z.ZodNumber>;
    max_consecutive_errors: z.ZodOptional<z.ZodNumber>;
    warning_threshold: z.ZodOptional<z.ZodNumber>;
    idle_timeout_minutes: z.ZodOptional<z.ZodNumber>;
    max_transient_retries: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
export type GuardrailsProfile = z.infer<typeof GuardrailsProfileSchema>;
export declare const DEFAULT_AGENT_PROFILES: Record<string, GuardrailsProfile>;
/** @deprecated Use DEFAULT_AGENT_PROFILES.architect instead */
export declare const DEFAULT_ARCHITECT_PROFILE: {
    max_tool_calls?: number | undefined;
    max_duration_minutes?: number | undefined;
    max_repetitions?: number | undefined;
    max_consecutive_errors?: number | undefined;
    warning_threshold?: number | undefined;
    idle_timeout_minutes?: number | undefined;
    max_transient_retries?: number | undefined;
};
export declare const GuardrailsConfigSchema: z.ZodObject<{
    enabled: z.ZodDefault<z.ZodBoolean>;
    max_tool_calls: z.ZodDefault<z.ZodNumber>;
    max_duration_minutes: z.ZodDefault<z.ZodNumber>;
    max_repetitions: z.ZodDefault<z.ZodNumber>;
    max_consecutive_errors: z.ZodDefault<z.ZodNumber>;
    max_transient_retries: z.ZodDefault<z.ZodNumber>;
    warning_threshold: z.ZodDefault<z.ZodNumber>;
    idle_timeout_minutes: z.ZodDefault<z.ZodNumber>;
    no_op_warning_threshold: z.ZodDefault<z.ZodNumber>;
    max_coder_revisions: z.ZodDefault<z.ZodNumber>;
    runaway_output_max_turns: z.ZodDefault<z.ZodNumber>;
    qa_gates: z.ZodOptional<z.ZodObject<{
        required_tools: z.ZodDefault<z.ZodArray<z.ZodString>>;
        require_reviewer_test_engineer: z.ZodDefault<z.ZodBoolean>;
    }, z.core.$strip>>;
    profiles: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
        max_tool_calls: z.ZodOptional<z.ZodNumber>;
        max_duration_minutes: z.ZodOptional<z.ZodNumber>;
        max_repetitions: z.ZodOptional<z.ZodNumber>;
        max_consecutive_errors: z.ZodOptional<z.ZodNumber>;
        warning_threshold: z.ZodOptional<z.ZodNumber>;
        idle_timeout_minutes: z.ZodOptional<z.ZodNumber>;
        max_transient_retries: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>>;
    block_destructive_commands: z.ZodDefault<z.ZodBoolean>;
    interpreter_allowed_agents: z.ZodOptional<z.ZodArray<z.ZodString>>;
    shell_audit_log: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strip>;
export type GuardrailsConfig = z.infer<typeof GuardrailsConfigSchema>;
export declare const WatchdogConfigSchema: z.ZodObject<{
    scope_guard: z.ZodDefault<z.ZodBoolean>;
    skip_in_turbo: z.ZodDefault<z.ZodBoolean>;
    delegation_ledger: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strip>;
export type WatchdogConfig = z.infer<typeof WatchdogConfigSchema>;
export declare const SelfReviewConfigSchema: z.ZodObject<{
    enabled: z.ZodDefault<z.ZodBoolean>;
    skip_in_turbo: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strip>;
export type SelfReviewConfig = z.infer<typeof SelfReviewConfigSchema>;
/**
 * Resolves guardrails configuration for a specific agent.
 *
 * Resolution order (later values override earlier):
 * 1. Base config values
 * 2. Built-in agent profile defaults from DEFAULT_AGENT_PROFILES (known agents only)
 * 3. User profile overrides - checks in order:
 *    a. config.profiles[originalAgentName] (e.g., 'paid_coder')
 *    b. config.profiles[canonicalName] (e.g., 'coder')
 *
 * For prefixed agent names (e.g., 'local_coder'), strips prefixes using stripKnownSwarmPrefix.
 * Unknown agent names get base config + user profile (NOT architect defaults - prevents bypass).
 *
 * @param config - The base guardrails configuration
 * @param agentName - Optional agent name to resolve profile for
 * @returns Resolved configuration object
 */
export declare function resolveGuardrailsConfig(config: GuardrailsConfig, agentName?: string): GuardrailsConfig;
export declare const ToolFilterConfigSchema: z.ZodObject<{
    enabled: z.ZodDefault<z.ZodBoolean>;
    overrides: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodArray<z.ZodString>>>;
}, z.core.$strip>;
export type ToolFilterConfig = z.infer<typeof ToolFilterConfigSchema>;
export declare const PlanCursorConfigSchema: z.ZodObject<{
    enabled: z.ZodDefault<z.ZodBoolean>;
    max_tokens: z.ZodDefault<z.ZodNumber>;
    lookahead_tasks: z.ZodDefault<z.ZodNumber>;
}, z.core.$strip>;
export type PlanCursorConfig = z.infer<typeof PlanCursorConfigSchema>;
export declare const CheckpointConfigSchema: z.ZodObject<{
    enabled: z.ZodDefault<z.ZodBoolean>;
    auto_checkpoint_threshold: z.ZodDefault<z.ZodNumber>;
    allow_empty_commits: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strict>;
export type CheckpointConfig = z.infer<typeof CheckpointConfigSchema>;
export declare const AutomationModeSchema: z.ZodEnum<{
    auto: "auto";
    manual: "manual";
    hybrid: "hybrid";
}>;
export type AutomationMode = z.infer<typeof AutomationModeSchema>;
export declare const AutomationCapabilitiesSchema: z.ZodObject<{
    plan_sync: z.ZodDefault<z.ZodBoolean>;
    phase_preflight: z.ZodDefault<z.ZodBoolean>;
    config_doctor_on_startup: z.ZodDefault<z.ZodBoolean>;
    config_doctor_autofix: z.ZodDefault<z.ZodBoolean>;
    evidence_auto_summaries: z.ZodDefault<z.ZodBoolean>;
    decision_drift_detection: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strip>;
export type AutomationCapabilities = z.infer<typeof AutomationCapabilitiesSchema>;
declare const AutomationConfigSchemaBase: z.ZodObject<{
    mode: z.ZodDefault<z.ZodEnum<{
        auto: "auto";
        manual: "manual";
        hybrid: "hybrid";
    }>>;
    capabilities: z.ZodDefault<z.ZodObject<{
        plan_sync: z.ZodDefault<z.ZodBoolean>;
        phase_preflight: z.ZodDefault<z.ZodBoolean>;
        config_doctor_on_startup: z.ZodDefault<z.ZodBoolean>;
        config_doctor_autofix: z.ZodDefault<z.ZodBoolean>;
        evidence_auto_summaries: z.ZodDefault<z.ZodBoolean>;
        decision_drift_detection: z.ZodDefault<z.ZodBoolean>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type AutomationConfig = z.infer<typeof AutomationConfigSchemaBase>;
export declare const AutomationConfigSchema: z.ZodType<AutomationConfig>;
export declare const KnowledgeConfigSchema: z.ZodObject<{
    enabled: z.ZodDefault<z.ZodBoolean>;
    swarm_max_entries: z.ZodDefault<z.ZodNumber>;
    hive_max_entries: z.ZodDefault<z.ZodNumber>;
    auto_promote_days: z.ZodDefault<z.ZodNumber>;
    max_inject_count: z.ZodDefault<z.ZodNumber>;
    inject_char_budget: z.ZodDefault<z.ZodNumber>;
    context_budget_threshold: z.ZodOptional<z.ZodNumber>;
    max_lesson_display_chars: z.ZodDefault<z.ZodNumber>;
    dedup_threshold: z.ZodDefault<z.ZodNumber>;
    scope_filter: z.ZodDefault<z.ZodArray<z.ZodString>>;
    hive_enabled: z.ZodDefault<z.ZodBoolean>;
    rejected_max_entries: z.ZodDefault<z.ZodNumber>;
    validation_enabled: z.ZodDefault<z.ZodBoolean>;
    evergreen_confidence: z.ZodDefault<z.ZodNumber>;
    evergreen_utility: z.ZodDefault<z.ZodNumber>;
    low_utility_threshold: z.ZodDefault<z.ZodNumber>;
    min_retrievals_for_utility: z.ZodDefault<z.ZodNumber>;
    schema_version: z.ZodDefault<z.ZodNumber>;
    directive_min_confidence: z.ZodDefault<z.ZodNumber>;
    same_project_weight: z.ZodDefault<z.ZodNumber>;
    cross_project_weight: z.ZodDefault<z.ZodNumber>;
    min_encounter_score: z.ZodDefault<z.ZodNumber>;
    initial_encounter_score: z.ZodDefault<z.ZodNumber>;
    encounter_increment: z.ZodDefault<z.ZodNumber>;
    max_encounter_score: z.ZodDefault<z.ZodNumber>;
    default_max_phases: z.ZodDefault<z.ZodNumber>;
    todo_max_phases: z.ZodDefault<z.ZodNumber>;
    sweep_enabled: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strip>;
export type KnowledgeConfig = z.infer<typeof KnowledgeConfigSchema>;
export declare const MemoryConfigSchema: z.ZodObject<{
    enabled: z.ZodDefault<z.ZodBoolean>;
    provider: z.ZodDefault<z.ZodEnum<{
        "local-jsonl": "local-jsonl";
        sqlite: "sqlite";
    }>>;
    storageDir: z.ZodDefault<z.ZodString>;
    sqlite: z.ZodDefault<z.ZodObject<{
        path: z.ZodDefault<z.ZodString>;
        busyTimeoutMs: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strip>>;
    recall: z.ZodDefault<z.ZodObject<{
        defaultMaxItems: z.ZodDefault<z.ZodNumber>;
        defaultTokenBudget: z.ZodDefault<z.ZodNumber>;
        minScore: z.ZodDefault<z.ZodNumber>;
        injection: z.ZodDefault<z.ZodObject<{
            enabled: z.ZodDefault<z.ZodBoolean>;
            minScore: z.ZodDefault<z.ZodNumber>;
            requireQuerySignal: z.ZodDefault<z.ZodBoolean>;
            maxItems: z.ZodDefault<z.ZodNumber>;
            tokenBudget: z.ZodDefault<z.ZodNumber>;
        }, z.core.$strip>>;
    }, z.core.$strip>>;
    writes: z.ZodDefault<z.ZodObject<{
        mode: z.ZodDefault<z.ZodLiteral<"propose">>;
    }, z.core.$strip>>;
    redaction: z.ZodDefault<z.ZodObject<{
        rejectDurableSecrets: z.ZodDefault<z.ZodBoolean>;
    }, z.core.$strip>>;
    maintenance: z.ZodDefault<z.ZodObject<{
        lowUtilityMaxConfidence: z.ZodDefault<z.ZodNumber>;
        lowUtilityMinAgeDays: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strip>>;
    hardDelete: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strip>;
export type MemoryConfig = z.infer<typeof MemoryConfigSchema>;
export declare const CuratorConfigSchema: z.ZodObject<{
    enabled: z.ZodDefault<z.ZodBoolean>;
    init_enabled: z.ZodDefault<z.ZodBoolean>;
    phase_enabled: z.ZodDefault<z.ZodBoolean>;
    max_summary_tokens: z.ZodDefault<z.ZodNumber>;
    min_knowledge_confidence: z.ZodDefault<z.ZodNumber>;
    compliance_report: z.ZodDefault<z.ZodBoolean>;
    suppress_warnings: z.ZodDefault<z.ZodBoolean>;
    drift_inject_max_chars: z.ZodDefault<z.ZodNumber>;
    llm_timeout_ms: z.ZodDefault<z.ZodNumber>;
    skill_generation_enabled: z.ZodDefault<z.ZodBoolean>;
    skill_generation_mode: z.ZodDefault<z.ZodEnum<{
        draft: "draft";
        active: "active";
    }>>;
    min_skill_confidence: z.ZodDefault<z.ZodNumber>;
    min_skill_confirmations: z.ZodDefault<z.ZodNumber>;
}, z.core.$strip>;
export type CuratorConfig = z.infer<typeof CuratorConfigSchema>;
/**
 * Architectural supervision (issue #893): hierarchical summary review. Agents emit
 * short structured summaries (summarize_work) that roll up per phase; an expensive
 * read-only critic (critic_architecture_supervisor) reviews the compressed summaries to
 * catch cross-task contradictions, drift, and repeated failure loops. The agent itself
 * is configured via the normal critic override flow; this block configures the feature
 * and the cheap aggregation pass (not an agent model).
 */
export declare const ArchitecturalSupervisionConfigSchema: z.ZodObject<{
    enabled: z.ZodDefault<z.ZodBoolean>;
    mode: z.ZodDefault<z.ZodEnum<{
        gate: "gate";
        advisory: "advisory";
    }>>;
    run_on: z.ZodDefault<z.ZodEnum<{
        phase_complete: "phase_complete";
    }>>;
    summary_model: z.ZodOptional<z.ZodString>;
    max_agent_summary_words: z.ZodDefault<z.ZodNumber>;
    max_phase_summary_words: z.ZodDefault<z.ZodNumber>;
    allow_concerns_to_complete: z.ZodDefault<z.ZodBoolean>;
    persist_knowledge_recommendations: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strip>;
export type ArchitecturalSupervisionConfig = z.infer<typeof ArchitecturalSupervisionConfigSchema>;
export declare const KnowledgeApplicationConfigSchema: z.ZodObject<{
    enabled: z.ZodDefault<z.ZodBoolean>;
    mode: z.ZodDefault<z.ZodEnum<{
        enforce: "enforce";
        warn: "warn";
    }>>;
    min_confidence: z.ZodDefault<z.ZodNumber>;
    critical_requires_ack: z.ZodDefault<z.ZodBoolean>;
    require_skill_refs: z.ZodDefault<z.ZodBoolean>;
    high_risk_tools: z.ZodDefault<z.ZodArray<z.ZodString>>;
}, z.core.$strip>;
export type KnowledgeApplicationConfig = z.infer<typeof KnowledgeApplicationConfigSchema>;
export declare const SkillImproverConfigSchema: z.ZodObject<{
    enabled: z.ZodDefault<z.ZodBoolean>;
    model: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    fallback_models: z.ZodDefault<z.ZodArray<z.ZodString>>;
    max_calls_per_day: z.ZodDefault<z.ZodNumber>;
    trigger: z.ZodDefault<z.ZodEnum<{
        manual: "manual";
        scheduled: "scheduled";
    }>>;
    targets: z.ZodDefault<z.ZodArray<z.ZodEnum<{
        skills: "skills";
        spec: "spec";
        architect_prompt: "architect_prompt";
        knowledge: "knowledge";
    }>>>;
    write_mode: z.ZodDefault<z.ZodEnum<{
        proposal: "proposal";
        draft_skills: "draft_skills";
    }>>;
    require_user_approval: z.ZodDefault<z.ZodBoolean>;
    quota_window: z.ZodDefault<z.ZodEnum<{
        utc: "utc";
        local: "local";
    }>>;
    allow_deterministic_fallback: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strip>;
export type SkillImproverConfig = z.infer<typeof SkillImproverConfigSchema>;
export declare const SpecWriterConfigSchema: z.ZodObject<{
    enabled: z.ZodDefault<z.ZodBoolean>;
    model: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    fallback_models: z.ZodDefault<z.ZodArray<z.ZodString>>;
    allow_spec_write: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strip>;
export type SpecWriterConfig = z.infer<typeof SpecWriterConfigSchema>;
export declare const SlopDetectorConfigSchema: z.ZodObject<{
    enabled: z.ZodDefault<z.ZodBoolean>;
    classThreshold: z.ZodDefault<z.ZodNumber>;
    commentStripThreshold: z.ZodDefault<z.ZodNumber>;
    diffLineThreshold: z.ZodDefault<z.ZodNumber>;
    importHygieneThreshold: z.ZodDefault<z.ZodNumber>;
}, z.core.$strip>;
export type SlopDetectorConfig = z.infer<typeof SlopDetectorConfigSchema>;
export declare const IncrementalVerifyConfigSchema: z.ZodObject<{
    enabled: z.ZodDefault<z.ZodBoolean>;
    command: z.ZodDefault<z.ZodNullable<z.ZodUnion<readonly [z.ZodString, z.ZodArray<z.ZodString>]>>>;
    timeoutMs: z.ZodDefault<z.ZodNumber>;
    triggerAgents: z.ZodDefault<z.ZodArray<z.ZodString>>;
}, z.core.$strip>;
export type IncrementalVerifyConfig = z.infer<typeof IncrementalVerifyConfigSchema>;
export declare const CompactionConfigSchema: z.ZodObject<{
    enabled: z.ZodDefault<z.ZodBoolean>;
    observationThreshold: z.ZodDefault<z.ZodNumber>;
    reflectionThreshold: z.ZodDefault<z.ZodNumber>;
    emergencyThreshold: z.ZodDefault<z.ZodNumber>;
    preserveLastNTurns: z.ZodDefault<z.ZodNumber>;
}, z.core.$strip>;
export type CompactionConfig = z.infer<typeof CompactionConfigSchema>;
export declare const PrmConfigSchema: z.ZodObject<{
    enabled: z.ZodDefault<z.ZodBoolean>;
    pattern_thresholds: z.ZodDefault<z.ZodObject<{
        repetition_loop: z.ZodDefault<z.ZodNumber>;
        ping_pong: z.ZodDefault<z.ZodNumber>;
        expansion_drift: z.ZodDefault<z.ZodNumber>;
        stuck_on_test: z.ZodDefault<z.ZodNumber>;
        context_thrash: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strip>>;
    max_trajectory_lines: z.ZodDefault<z.ZodNumber>;
    escalation_enabled: z.ZodDefault<z.ZodBoolean>;
    detection_timeout_ms: z.ZodDefault<z.ZodNumber>;
}, z.core.$strip>;
export type PrmConfig = z.infer<typeof PrmConfigSchema>;
export declare const AgentAuthorityRuleSchema: z.ZodObject<{
    readOnly: z.ZodOptional<z.ZodBoolean>;
    blockedExact: z.ZodOptional<z.ZodArray<z.ZodString>>;
    allowedExact: z.ZodOptional<z.ZodArray<z.ZodString>>;
    blockedPrefix: z.ZodOptional<z.ZodArray<z.ZodString>>;
    allowedPrefix: z.ZodOptional<z.ZodArray<z.ZodString>>;
    blockedZones: z.ZodOptional<z.ZodArray<z.ZodEnum<{
        docs: "docs";
        production: "production";
        test: "test";
        config: "config";
        generated: "generated";
        build: "build";
    }>>>;
    blockedGlobs: z.ZodOptional<z.ZodArray<z.ZodString>>;
    allowedGlobs: z.ZodOptional<z.ZodArray<z.ZodString>>;
}, z.core.$strip>;
export type AgentAuthorityRule = z.infer<typeof AgentAuthorityRuleSchema>;
export declare const AuthorityConfigSchema: z.ZodObject<{
    enabled: z.ZodDefault<z.ZodBoolean>;
    rules: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodObject<{
        readOnly: z.ZodOptional<z.ZodBoolean>;
        blockedExact: z.ZodOptional<z.ZodArray<z.ZodString>>;
        allowedExact: z.ZodOptional<z.ZodArray<z.ZodString>>;
        blockedPrefix: z.ZodOptional<z.ZodArray<z.ZodString>>;
        allowedPrefix: z.ZodOptional<z.ZodArray<z.ZodString>>;
        blockedZones: z.ZodOptional<z.ZodArray<z.ZodEnum<{
            docs: "docs";
            production: "production";
            test: "test";
            config: "config";
            generated: "generated";
            build: "build";
        }>>>;
        blockedGlobs: z.ZodOptional<z.ZodArray<z.ZodString>>;
        allowedGlobs: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$strip>>>;
    universal_deny_prefixes: z.ZodDefault<z.ZodArray<z.ZodString>>;
    verifier_config_paths: z.ZodOptional<z.ZodArray<z.ZodString>>;
}, z.core.$strip>;
export type AuthorityConfig = z.infer<typeof AuthorityConfigSchema>;
export declare const GeneralCouncilConfigSchema: z.ZodObject<{
    enabled: z.ZodDefault<z.ZodBoolean>;
    searchProvider: z.ZodDefault<z.ZodEnum<{
        tavily: "tavily";
        brave: "brave";
    }>>;
    searchApiKey: z.ZodOptional<z.ZodString>;
    members: z.ZodDefault<z.ZodArray<z.ZodObject<{
        memberId: z.ZodString;
        model: z.ZodString;
        role: z.ZodEnum<{
            generalist: "generalist";
            skeptic: "skeptic";
            domain_expert: "domain_expert";
            devil_advocate: "devil_advocate";
            synthesizer: "synthesizer";
        }>;
        persona: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>>;
    presets: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodArray<z.ZodObject<{
        memberId: z.ZodString;
        model: z.ZodString;
        role: z.ZodEnum<{
            generalist: "generalist";
            skeptic: "skeptic";
            domain_expert: "domain_expert";
            devil_advocate: "devil_advocate";
            synthesizer: "synthesizer";
        }>;
        persona: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>>>;
    deliberate: z.ZodDefault<z.ZodBoolean>;
    moderator: z.ZodDefault<z.ZodBoolean>;
    moderatorModel: z.ZodOptional<z.ZodString>;
    maxSourcesPerMember: z.ZodDefault<z.ZodNumber>;
}, z.core.$strict>;
export type GeneralCouncilConfig = z.infer<typeof GeneralCouncilConfigSchema>;
export declare const CouncilConfigSchema: z.ZodObject<{
    enabled: z.ZodDefault<z.ZodBoolean>;
    maxRounds: z.ZodDefault<z.ZodNumber>;
    parallelTimeoutMs: z.ZodDefault<z.ZodNumber>;
    vetoPriority: z.ZodDefault<z.ZodBoolean>;
    requireAllMembers: z.ZodDefault<z.ZodBoolean>;
    minimumMembers: z.ZodDefault<z.ZodNumber>;
    escalateOnMaxRounds: z.ZodOptional<z.ZodString>;
    phaseConcernsAllowComplete: z.ZodDefault<z.ZodBoolean>;
    general: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        searchProvider: z.ZodDefault<z.ZodEnum<{
            tavily: "tavily";
            brave: "brave";
        }>>;
        searchApiKey: z.ZodOptional<z.ZodString>;
        members: z.ZodDefault<z.ZodArray<z.ZodObject<{
            memberId: z.ZodString;
            model: z.ZodString;
            role: z.ZodEnum<{
                generalist: "generalist";
                skeptic: "skeptic";
                domain_expert: "domain_expert";
                devil_advocate: "devil_advocate";
                synthesizer: "synthesizer";
            }>;
            persona: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>>;
        presets: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodArray<z.ZodObject<{
            memberId: z.ZodString;
            model: z.ZodString;
            role: z.ZodEnum<{
                generalist: "generalist";
                skeptic: "skeptic";
                domain_expert: "domain_expert";
                devil_advocate: "devil_advocate";
                synthesizer: "synthesizer";
            }>;
            persona: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>>>;
        deliberate: z.ZodDefault<z.ZodBoolean>;
        moderator: z.ZodDefault<z.ZodBoolean>;
        moderatorModel: z.ZodOptional<z.ZodString>;
        maxSourcesPerMember: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type CouncilConfig = z.infer<typeof CouncilConfigSchema>;
export declare const ParallelizationConfigSchema: z.ZodObject<{
    enabled: z.ZodDefault<z.ZodBoolean>;
    maxConcurrentTasks: z.ZodDefault<z.ZodNumber>;
    evidenceLockTimeoutMs: z.ZodDefault<z.ZodNumber>;
    max_coders: z.ZodDefault<z.ZodNumber>;
    max_reviewers: z.ZodDefault<z.ZodNumber>;
}, z.core.$strip>;
export type ParallelizationConfig = z.infer<typeof ParallelizationConfigSchema>;
export declare const LeanTurboConfigSchema: z.ZodObject<{
    max_parallel_coders: z.ZodDefault<z.ZodNumber>;
    require_declared_scope: z.ZodDefault<z.ZodBoolean>;
    conflict_policy: z.ZodDefault<z.ZodEnum<{
        serialize: "serialize";
        degrade: "degrade";
    }>>;
    degrade_on_risk: z.ZodDefault<z.ZodBoolean>;
    phase_reviewer: z.ZodDefault<z.ZodBoolean>;
    phase_critic: z.ZodDefault<z.ZodBoolean>;
    integrated_diff_required: z.ZodDefault<z.ZodBoolean>;
    allow_docs_only_without_reviewer: z.ZodDefault<z.ZodBoolean>;
    worktree_isolation: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strip>;
export type LeanTurboConfig = z.infer<typeof LeanTurboConfigSchema>;
export declare const StandardTurboConfigSchema: z.ZodObject<{
    strategy: z.ZodLiteral<"standard">;
    lean: z.ZodOptional<z.ZodObject<{
        max_parallel_coders: z.ZodDefault<z.ZodNumber>;
        require_declared_scope: z.ZodDefault<z.ZodBoolean>;
        conflict_policy: z.ZodDefault<z.ZodEnum<{
            serialize: "serialize";
            degrade: "degrade";
        }>>;
        degrade_on_risk: z.ZodDefault<z.ZodBoolean>;
        phase_reviewer: z.ZodDefault<z.ZodBoolean>;
        phase_critic: z.ZodDefault<z.ZodBoolean>;
        integrated_diff_required: z.ZodDefault<z.ZodBoolean>;
        allow_docs_only_without_reviewer: z.ZodDefault<z.ZodBoolean>;
        worktree_isolation: z.ZodDefault<z.ZodBoolean>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const LeanTurboStrategyConfigSchema: z.ZodObject<{
    strategy: z.ZodLiteral<"lean">;
    lean: z.ZodObject<{
        max_parallel_coders: z.ZodDefault<z.ZodNumber>;
        require_declared_scope: z.ZodDefault<z.ZodBoolean>;
        conflict_policy: z.ZodDefault<z.ZodEnum<{
            serialize: "serialize";
            degrade: "degrade";
        }>>;
        degrade_on_risk: z.ZodDefault<z.ZodBoolean>;
        phase_reviewer: z.ZodDefault<z.ZodBoolean>;
        phase_critic: z.ZodDefault<z.ZodBoolean>;
        integrated_diff_required: z.ZodDefault<z.ZodBoolean>;
        allow_docs_only_without_reviewer: z.ZodDefault<z.ZodBoolean>;
        worktree_isolation: z.ZodDefault<z.ZodBoolean>;
    }, z.core.$strip>;
}, z.core.$strip>;
export declare const TurboConfigSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    strategy: z.ZodLiteral<"standard">;
    lean: z.ZodOptional<z.ZodObject<{
        max_parallel_coders: z.ZodDefault<z.ZodNumber>;
        require_declared_scope: z.ZodDefault<z.ZodBoolean>;
        conflict_policy: z.ZodDefault<z.ZodEnum<{
            serialize: "serialize";
            degrade: "degrade";
        }>>;
        degrade_on_risk: z.ZodDefault<z.ZodBoolean>;
        phase_reviewer: z.ZodDefault<z.ZodBoolean>;
        phase_critic: z.ZodDefault<z.ZodBoolean>;
        integrated_diff_required: z.ZodDefault<z.ZodBoolean>;
        allow_docs_only_without_reviewer: z.ZodDefault<z.ZodBoolean>;
        worktree_isolation: z.ZodDefault<z.ZodBoolean>;
    }, z.core.$strip>>;
}, z.core.$strip>, z.ZodObject<{
    strategy: z.ZodLiteral<"lean">;
    lean: z.ZodObject<{
        max_parallel_coders: z.ZodDefault<z.ZodNumber>;
        require_declared_scope: z.ZodDefault<z.ZodBoolean>;
        conflict_policy: z.ZodDefault<z.ZodEnum<{
            serialize: "serialize";
            degrade: "degrade";
        }>>;
        degrade_on_risk: z.ZodDefault<z.ZodBoolean>;
        phase_reviewer: z.ZodDefault<z.ZodBoolean>;
        phase_critic: z.ZodDefault<z.ZodBoolean>;
        integrated_diff_required: z.ZodDefault<z.ZodBoolean>;
        allow_docs_only_without_reviewer: z.ZodDefault<z.ZodBoolean>;
        worktree_isolation: z.ZodDefault<z.ZodBoolean>;
    }, z.core.$strip>;
}, z.core.$strip>], "strategy">;
export type TurboConfig = z.infer<typeof TurboConfigSchema>;
export declare const PluginConfigSchema: z.ZodObject<{
    agents: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
        model: z.ZodOptional<z.ZodString>;
        variant: z.ZodOptional<z.ZodString>;
        temperature: z.ZodOptional<z.ZodNumber>;
        disabled: z.ZodOptional<z.ZodBoolean>;
        fallback_models: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$strip>>>;
    default_agent: z.ZodPipe<z.ZodOptional<z.ZodString>, z.ZodTransform<string | undefined, string | undefined>>;
    auto_select_architect: z.ZodPipe<z.ZodOptional<z.ZodUnion<readonly [z.ZodBoolean, z.ZodString]>>, z.ZodTransform<string | boolean | undefined, string | boolean | undefined>>;
    swarms: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
        name: z.ZodOptional<z.ZodString>;
        agents: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
            model: z.ZodOptional<z.ZodString>;
            variant: z.ZodOptional<z.ZodString>;
            temperature: z.ZodOptional<z.ZodNumber>;
            disabled: z.ZodOptional<z.ZodBoolean>;
            fallback_models: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strip>>>;
    }, z.core.$strip>>>;
    max_iterations: z.ZodDefault<z.ZodNumber>;
    pipeline: z.ZodOptional<z.ZodObject<{
        parallel_precheck: z.ZodDefault<z.ZodBoolean>;
    }, z.core.$strip>>;
    phase_complete: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        required_agents: z.ZodDefault<z.ZodArray<z.ZodEnum<{
            reviewer: "reviewer";
            test_engineer: "test_engineer";
            coder: "coder";
        }>>>;
        require_docs: z.ZodDefault<z.ZodBoolean>;
        policy: z.ZodDefault<z.ZodEnum<{
            enforce: "enforce";
            warn: "warn";
        }>>;
        regression_sweep: z.ZodOptional<z.ZodObject<{
            enforce: z.ZodDefault<z.ZodBoolean>;
        }, z.core.$strip>>;
    }, z.core.$strip>>;
    qa_retry_limit: z.ZodDefault<z.ZodNumber>;
    execution_mode: z.ZodDefault<z.ZodEnum<{
        strict: "strict";
        balanced: "balanced";
        fast: "fast";
    }>>;
    inject_phase_reminders: z.ZodDefault<z.ZodBoolean>;
    hooks: z.ZodOptional<z.ZodObject<{
        system_enhancer: z.ZodDefault<z.ZodBoolean>;
        compaction: z.ZodDefault<z.ZodBoolean>;
        agent_activity: z.ZodDefault<z.ZodBoolean>;
        delegation_tracker: z.ZodDefault<z.ZodBoolean>;
        agent_awareness_max_chars: z.ZodDefault<z.ZodNumber>;
        delegation_gate: z.ZodDefault<z.ZodBoolean>;
        delegation_max_chars: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strip>>;
    gates: z.ZodOptional<z.ZodObject<{
        syntax_check: z.ZodDefault<z.ZodObject<{
            enabled: z.ZodDefault<z.ZodBoolean>;
        }, z.core.$strip>>;
        placeholder_scan: z.ZodDefault<z.ZodObject<{
            enabled: z.ZodDefault<z.ZodBoolean>;
            deny_patterns: z.ZodDefault<z.ZodArray<z.ZodString>>;
            allow_globs: z.ZodDefault<z.ZodArray<z.ZodString>>;
            max_allowed_findings: z.ZodDefault<z.ZodNumber>;
        }, z.core.$strip>>;
        sast_scan: z.ZodDefault<z.ZodObject<{
            enabled: z.ZodDefault<z.ZodBoolean>;
        }, z.core.$strip>>;
        sbom_generate: z.ZodDefault<z.ZodObject<{
            enabled: z.ZodDefault<z.ZodBoolean>;
        }, z.core.$strip>>;
        build_check: z.ZodDefault<z.ZodObject<{
            enabled: z.ZodDefault<z.ZodBoolean>;
        }, z.core.$strip>>;
        quality_budget: z.ZodObject<{
            enabled: z.ZodDefault<z.ZodBoolean>;
            max_complexity_delta: z.ZodDefault<z.ZodNumber>;
            max_public_api_delta: z.ZodDefault<z.ZodNumber>;
            max_duplication_ratio: z.ZodDefault<z.ZodNumber>;
            min_test_to_code_ratio: z.ZodDefault<z.ZodNumber>;
            enforce_on_globs: z.ZodDefault<z.ZodArray<z.ZodString>>;
            exclude_globs: z.ZodDefault<z.ZodArray<z.ZodString>>;
        }, z.core.$strip>;
    }, z.core.$strip>>;
    context_budget: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        warn_threshold: z.ZodDefault<z.ZodNumber>;
        critical_threshold: z.ZodDefault<z.ZodNumber>;
        model_limits: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodNumber>>;
        max_injection_tokens: z.ZodDefault<z.ZodNumber>;
        tracked_agents: z.ZodDefault<z.ZodArray<z.ZodString>>;
        scoring: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodDefault<z.ZodBoolean>;
            max_candidates: z.ZodDefault<z.ZodNumber>;
            weights: z.ZodOptional<z.ZodObject<{
                phase: z.ZodDefault<z.ZodNumber>;
                current_task: z.ZodDefault<z.ZodNumber>;
                blocked_task: z.ZodDefault<z.ZodNumber>;
                recent_failure: z.ZodDefault<z.ZodNumber>;
                recent_success: z.ZodDefault<z.ZodNumber>;
                evidence_presence: z.ZodDefault<z.ZodNumber>;
                decision_recency: z.ZodDefault<z.ZodNumber>;
                dependency_proximity: z.ZodDefault<z.ZodNumber>;
            }, z.core.$strip>>;
            decision_decay: z.ZodOptional<z.ZodObject<{
                mode: z.ZodDefault<z.ZodEnum<{
                    linear: "linear";
                    exponential: "exponential";
                }>>;
                half_life_hours: z.ZodDefault<z.ZodNumber>;
            }, z.core.$strip>>;
            token_ratios: z.ZodOptional<z.ZodObject<{
                prose: z.ZodDefault<z.ZodNumber>;
                code: z.ZodDefault<z.ZodNumber>;
                markdown: z.ZodDefault<z.ZodNumber>;
                json: z.ZodDefault<z.ZodNumber>;
            }, z.core.$strip>>;
        }, z.core.$strip>>;
        enforce: z.ZodDefault<z.ZodBoolean>;
        prune_target: z.ZodDefault<z.ZodNumber>;
        preserve_last_n_turns: z.ZodDefault<z.ZodNumber>;
        recent_window: z.ZodDefault<z.ZodNumber>;
        enforce_on_agent_switch: z.ZodDefault<z.ZodBoolean>;
        tool_output_mask_threshold: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strip>>;
    guardrails: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        max_tool_calls: z.ZodDefault<z.ZodNumber>;
        max_duration_minutes: z.ZodDefault<z.ZodNumber>;
        max_repetitions: z.ZodDefault<z.ZodNumber>;
        max_consecutive_errors: z.ZodDefault<z.ZodNumber>;
        max_transient_retries: z.ZodDefault<z.ZodNumber>;
        warning_threshold: z.ZodDefault<z.ZodNumber>;
        idle_timeout_minutes: z.ZodDefault<z.ZodNumber>;
        no_op_warning_threshold: z.ZodDefault<z.ZodNumber>;
        max_coder_revisions: z.ZodDefault<z.ZodNumber>;
        runaway_output_max_turns: z.ZodDefault<z.ZodNumber>;
        qa_gates: z.ZodOptional<z.ZodObject<{
            required_tools: z.ZodDefault<z.ZodArray<z.ZodString>>;
            require_reviewer_test_engineer: z.ZodDefault<z.ZodBoolean>;
        }, z.core.$strip>>;
        profiles: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
            max_tool_calls: z.ZodOptional<z.ZodNumber>;
            max_duration_minutes: z.ZodOptional<z.ZodNumber>;
            max_repetitions: z.ZodOptional<z.ZodNumber>;
            max_consecutive_errors: z.ZodOptional<z.ZodNumber>;
            warning_threshold: z.ZodOptional<z.ZodNumber>;
            idle_timeout_minutes: z.ZodOptional<z.ZodNumber>;
            max_transient_retries: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strip>>>;
        block_destructive_commands: z.ZodDefault<z.ZodBoolean>;
        interpreter_allowed_agents: z.ZodOptional<z.ZodArray<z.ZodString>>;
        shell_audit_log: z.ZodDefault<z.ZodBoolean>;
    }, z.core.$strip>>;
    watchdog: z.ZodOptional<z.ZodObject<{
        scope_guard: z.ZodDefault<z.ZodBoolean>;
        skip_in_turbo: z.ZodDefault<z.ZodBoolean>;
        delegation_ledger: z.ZodDefault<z.ZodBoolean>;
    }, z.core.$strip>>;
    self_review: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        skip_in_turbo: z.ZodDefault<z.ZodBoolean>;
    }, z.core.$strip>>;
    tool_filter: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        overrides: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodArray<z.ZodString>>>;
    }, z.core.$strip>>;
    authority: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        rules: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodObject<{
            readOnly: z.ZodOptional<z.ZodBoolean>;
            blockedExact: z.ZodOptional<z.ZodArray<z.ZodString>>;
            allowedExact: z.ZodOptional<z.ZodArray<z.ZodString>>;
            blockedPrefix: z.ZodOptional<z.ZodArray<z.ZodString>>;
            allowedPrefix: z.ZodOptional<z.ZodArray<z.ZodString>>;
            blockedZones: z.ZodOptional<z.ZodArray<z.ZodEnum<{
                docs: "docs";
                production: "production";
                test: "test";
                config: "config";
                generated: "generated";
                build: "build";
            }>>>;
            blockedGlobs: z.ZodOptional<z.ZodArray<z.ZodString>>;
            allowedGlobs: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strip>>>;
        universal_deny_prefixes: z.ZodDefault<z.ZodArray<z.ZodString>>;
        verifier_config_paths: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$strip>>;
    plan_cursor: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        max_tokens: z.ZodDefault<z.ZodNumber>;
        lookahead_tasks: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strip>>;
    evidence: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        max_age_days: z.ZodDefault<z.ZodNumber>;
        max_bundles: z.ZodDefault<z.ZodNumber>;
        auto_archive: z.ZodDefault<z.ZodBoolean>;
    }, z.core.$strip>>;
    summaries: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        threshold_bytes: z.ZodDefault<z.ZodNumber>;
        max_summary_chars: z.ZodDefault<z.ZodNumber>;
        max_stored_bytes: z.ZodDefault<z.ZodNumber>;
        retention_days: z.ZodDefault<z.ZodNumber>;
        exempt_tools: z.ZodDefault<z.ZodArray<z.ZodString>>;
    }, z.core.$strip>>;
    review_passes: z.ZodOptional<z.ZodObject<{
        always_security_review: z.ZodDefault<z.ZodBoolean>;
        security_globs: z.ZodDefault<z.ZodArray<z.ZodString>>;
    }, z.core.$strip>>;
    adversarial_detection: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        policy: z.ZodDefault<z.ZodEnum<{
            ignore: "ignore";
            gate: "gate";
            warn: "warn";
        }>>;
        pairs: z.ZodDefault<z.ZodArray<z.ZodTuple<[z.ZodString, z.ZodString], null>>>;
    }, z.core.$strip>>;
    adversarial_testing: z.ZodOptional<z.ZodType<AdversarialTestingConfig, unknown, z.core.$ZodTypeInternals<AdversarialTestingConfig, unknown>>>;
    integration_analysis: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
    }, z.core.$strip>>;
    docs: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        doc_patterns: z.ZodDefault<z.ZodArray<z.ZodString>>;
    }, z.core.$strip>>;
    ui_review: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        trigger_paths: z.ZodDefault<z.ZodArray<z.ZodString>>;
        trigger_keywords: z.ZodDefault<z.ZodArray<z.ZodString>>;
    }, z.core.$strip>>;
    compaction_advisory: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        thresholds: z.ZodDefault<z.ZodArray<z.ZodNumber>>;
        message: z.ZodDefault<z.ZodString>;
    }, z.core.$strip>>;
    lint: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        mode: z.ZodDefault<z.ZodEnum<{
            check: "check";
            fix: "fix";
        }>>;
        linter: z.ZodDefault<z.ZodEnum<{
            biome: "biome";
            eslint: "eslint";
            auto: "auto";
        }>>;
        patterns: z.ZodDefault<z.ZodArray<z.ZodString>>;
        exclude: z.ZodDefault<z.ZodArray<z.ZodString>>;
    }, z.core.$strip>>;
    secretscan: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        patterns: z.ZodDefault<z.ZodArray<z.ZodString>>;
        exclude: z.ZodDefault<z.ZodArray<z.ZodString>>;
        extensions: z.ZodDefault<z.ZodArray<z.ZodString>>;
    }, z.core.$strip>>;
    checkpoint: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        auto_checkpoint_threshold: z.ZodDefault<z.ZodNumber>;
        allow_empty_commits: z.ZodDefault<z.ZodBoolean>;
    }, z.core.$strict>>;
    automation: z.ZodOptional<z.ZodType<{
        mode: "auto" | "manual" | "hybrid";
        capabilities: {
            plan_sync: boolean;
            phase_preflight: boolean;
            config_doctor_on_startup: boolean;
            config_doctor_autofix: boolean;
            evidence_auto_summaries: boolean;
            decision_drift_detection: boolean;
        };
    }, unknown, z.core.$ZodTypeInternals<{
        mode: "auto" | "manual" | "hybrid";
        capabilities: {
            plan_sync: boolean;
            phase_preflight: boolean;
            config_doctor_on_startup: boolean;
            config_doctor_autofix: boolean;
            evidence_auto_summaries: boolean;
            decision_drift_detection: boolean;
        };
    }, unknown>>>;
    knowledge: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        swarm_max_entries: z.ZodDefault<z.ZodNumber>;
        hive_max_entries: z.ZodDefault<z.ZodNumber>;
        auto_promote_days: z.ZodDefault<z.ZodNumber>;
        max_inject_count: z.ZodDefault<z.ZodNumber>;
        inject_char_budget: z.ZodDefault<z.ZodNumber>;
        context_budget_threshold: z.ZodOptional<z.ZodNumber>;
        max_lesson_display_chars: z.ZodDefault<z.ZodNumber>;
        dedup_threshold: z.ZodDefault<z.ZodNumber>;
        scope_filter: z.ZodDefault<z.ZodArray<z.ZodString>>;
        hive_enabled: z.ZodDefault<z.ZodBoolean>;
        rejected_max_entries: z.ZodDefault<z.ZodNumber>;
        validation_enabled: z.ZodDefault<z.ZodBoolean>;
        evergreen_confidence: z.ZodDefault<z.ZodNumber>;
        evergreen_utility: z.ZodDefault<z.ZodNumber>;
        low_utility_threshold: z.ZodDefault<z.ZodNumber>;
        min_retrievals_for_utility: z.ZodDefault<z.ZodNumber>;
        schema_version: z.ZodDefault<z.ZodNumber>;
        directive_min_confidence: z.ZodDefault<z.ZodNumber>;
        same_project_weight: z.ZodDefault<z.ZodNumber>;
        cross_project_weight: z.ZodDefault<z.ZodNumber>;
        min_encounter_score: z.ZodDefault<z.ZodNumber>;
        initial_encounter_score: z.ZodDefault<z.ZodNumber>;
        encounter_increment: z.ZodDefault<z.ZodNumber>;
        max_encounter_score: z.ZodDefault<z.ZodNumber>;
        default_max_phases: z.ZodDefault<z.ZodNumber>;
        todo_max_phases: z.ZodDefault<z.ZodNumber>;
        sweep_enabled: z.ZodDefault<z.ZodBoolean>;
    }, z.core.$strip>>;
    memory: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        provider: z.ZodDefault<z.ZodEnum<{
            "local-jsonl": "local-jsonl";
            sqlite: "sqlite";
        }>>;
        storageDir: z.ZodDefault<z.ZodString>;
        sqlite: z.ZodDefault<z.ZodObject<{
            path: z.ZodDefault<z.ZodString>;
            busyTimeoutMs: z.ZodDefault<z.ZodNumber>;
        }, z.core.$strip>>;
        recall: z.ZodDefault<z.ZodObject<{
            defaultMaxItems: z.ZodDefault<z.ZodNumber>;
            defaultTokenBudget: z.ZodDefault<z.ZodNumber>;
            minScore: z.ZodDefault<z.ZodNumber>;
            injection: z.ZodDefault<z.ZodObject<{
                enabled: z.ZodDefault<z.ZodBoolean>;
                minScore: z.ZodDefault<z.ZodNumber>;
                requireQuerySignal: z.ZodDefault<z.ZodBoolean>;
                maxItems: z.ZodDefault<z.ZodNumber>;
                tokenBudget: z.ZodDefault<z.ZodNumber>;
            }, z.core.$strip>>;
        }, z.core.$strip>>;
        writes: z.ZodDefault<z.ZodObject<{
            mode: z.ZodDefault<z.ZodLiteral<"propose">>;
        }, z.core.$strip>>;
        redaction: z.ZodDefault<z.ZodObject<{
            rejectDurableSecrets: z.ZodDefault<z.ZodBoolean>;
        }, z.core.$strip>>;
        maintenance: z.ZodDefault<z.ZodObject<{
            lowUtilityMaxConfidence: z.ZodDefault<z.ZodNumber>;
            lowUtilityMinAgeDays: z.ZodDefault<z.ZodNumber>;
        }, z.core.$strip>>;
        hardDelete: z.ZodDefault<z.ZodBoolean>;
    }, z.core.$strip>>;
    curator: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        init_enabled: z.ZodDefault<z.ZodBoolean>;
        phase_enabled: z.ZodDefault<z.ZodBoolean>;
        max_summary_tokens: z.ZodDefault<z.ZodNumber>;
        min_knowledge_confidence: z.ZodDefault<z.ZodNumber>;
        compliance_report: z.ZodDefault<z.ZodBoolean>;
        suppress_warnings: z.ZodDefault<z.ZodBoolean>;
        drift_inject_max_chars: z.ZodDefault<z.ZodNumber>;
        llm_timeout_ms: z.ZodDefault<z.ZodNumber>;
        skill_generation_enabled: z.ZodDefault<z.ZodBoolean>;
        skill_generation_mode: z.ZodDefault<z.ZodEnum<{
            draft: "draft";
            active: "active";
        }>>;
        min_skill_confidence: z.ZodDefault<z.ZodNumber>;
        min_skill_confirmations: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strip>>;
    architectural_supervision: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        mode: z.ZodDefault<z.ZodEnum<{
            gate: "gate";
            advisory: "advisory";
        }>>;
        run_on: z.ZodDefault<z.ZodEnum<{
            phase_complete: "phase_complete";
        }>>;
        summary_model: z.ZodOptional<z.ZodString>;
        max_agent_summary_words: z.ZodDefault<z.ZodNumber>;
        max_phase_summary_words: z.ZodDefault<z.ZodNumber>;
        allow_concerns_to_complete: z.ZodDefault<z.ZodBoolean>;
        persist_knowledge_recommendations: z.ZodDefault<z.ZodBoolean>;
    }, z.core.$strip>>;
    knowledge_application: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        mode: z.ZodDefault<z.ZodEnum<{
            enforce: "enforce";
            warn: "warn";
        }>>;
        min_confidence: z.ZodDefault<z.ZodNumber>;
        critical_requires_ack: z.ZodDefault<z.ZodBoolean>;
        require_skill_refs: z.ZodDefault<z.ZodBoolean>;
        high_risk_tools: z.ZodDefault<z.ZodArray<z.ZodString>>;
    }, z.core.$strip>>;
    skill_improver: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        model: z.ZodDefault<z.ZodNullable<z.ZodString>>;
        fallback_models: z.ZodDefault<z.ZodArray<z.ZodString>>;
        max_calls_per_day: z.ZodDefault<z.ZodNumber>;
        trigger: z.ZodDefault<z.ZodEnum<{
            manual: "manual";
            scheduled: "scheduled";
        }>>;
        targets: z.ZodDefault<z.ZodArray<z.ZodEnum<{
            skills: "skills";
            spec: "spec";
            architect_prompt: "architect_prompt";
            knowledge: "knowledge";
        }>>>;
        write_mode: z.ZodDefault<z.ZodEnum<{
            proposal: "proposal";
            draft_skills: "draft_skills";
        }>>;
        require_user_approval: z.ZodDefault<z.ZodBoolean>;
        quota_window: z.ZodDefault<z.ZodEnum<{
            utc: "utc";
            local: "local";
        }>>;
        allow_deterministic_fallback: z.ZodDefault<z.ZodBoolean>;
    }, z.core.$strip>>;
    spec_writer: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        model: z.ZodDefault<z.ZodNullable<z.ZodString>>;
        fallback_models: z.ZodDefault<z.ZodArray<z.ZodString>>;
        allow_spec_write: z.ZodDefault<z.ZodBoolean>;
    }, z.core.$strip>>;
    tool_output: z.ZodOptional<z.ZodObject<{
        truncation_enabled: z.ZodDefault<z.ZodBoolean>;
        max_lines: z.ZodDefault<z.ZodNumber>;
        per_tool: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodNumber>>;
        truncation_tools: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$strip>>;
    slop_detector: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        classThreshold: z.ZodDefault<z.ZodNumber>;
        commentStripThreshold: z.ZodDefault<z.ZodNumber>;
        diffLineThreshold: z.ZodDefault<z.ZodNumber>;
        importHygieneThreshold: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strip>>;
    todo_gate: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        max_high_priority: z.ZodDefault<z.ZodNumber>;
        block_on_threshold: z.ZodDefault<z.ZodBoolean>;
    }, z.core.$strip>>;
    incremental_verify: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        command: z.ZodDefault<z.ZodNullable<z.ZodUnion<readonly [z.ZodString, z.ZodArray<z.ZodString>]>>>;
        timeoutMs: z.ZodDefault<z.ZodNumber>;
        triggerAgents: z.ZodDefault<z.ZodArray<z.ZodString>>;
    }, z.core.$strip>>;
    compaction_service: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        observationThreshold: z.ZodDefault<z.ZodNumber>;
        reflectionThreshold: z.ZodDefault<z.ZodNumber>;
        emergencyThreshold: z.ZodDefault<z.ZodNumber>;
        preserveLastNTurns: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strip>>;
    prm: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        pattern_thresholds: z.ZodDefault<z.ZodObject<{
            repetition_loop: z.ZodDefault<z.ZodNumber>;
            ping_pong: z.ZodDefault<z.ZodNumber>;
            expansion_drift: z.ZodDefault<z.ZodNumber>;
            stuck_on_test: z.ZodDefault<z.ZodNumber>;
            context_thrash: z.ZodDefault<z.ZodNumber>;
        }, z.core.$strip>>;
        max_trajectory_lines: z.ZodDefault<z.ZodNumber>;
        escalation_enabled: z.ZodDefault<z.ZodBoolean>;
        detection_timeout_ms: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strip>>;
    council: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        maxRounds: z.ZodDefault<z.ZodNumber>;
        parallelTimeoutMs: z.ZodDefault<z.ZodNumber>;
        vetoPriority: z.ZodDefault<z.ZodBoolean>;
        requireAllMembers: z.ZodDefault<z.ZodBoolean>;
        minimumMembers: z.ZodDefault<z.ZodNumber>;
        escalateOnMaxRounds: z.ZodOptional<z.ZodString>;
        phaseConcernsAllowComplete: z.ZodDefault<z.ZodBoolean>;
        general: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodDefault<z.ZodBoolean>;
            searchProvider: z.ZodDefault<z.ZodEnum<{
                tavily: "tavily";
                brave: "brave";
            }>>;
            searchApiKey: z.ZodOptional<z.ZodString>;
            members: z.ZodDefault<z.ZodArray<z.ZodObject<{
                memberId: z.ZodString;
                model: z.ZodString;
                role: z.ZodEnum<{
                    generalist: "generalist";
                    skeptic: "skeptic";
                    domain_expert: "domain_expert";
                    devil_advocate: "devil_advocate";
                    synthesizer: "synthesizer";
                }>;
                persona: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>>;
            presets: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodArray<z.ZodObject<{
                memberId: z.ZodString;
                model: z.ZodString;
                role: z.ZodEnum<{
                    generalist: "generalist";
                    skeptic: "skeptic";
                    domain_expert: "domain_expert";
                    devil_advocate: "devil_advocate";
                    synthesizer: "synthesizer";
                }>;
                persona: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>>>;
            deliberate: z.ZodDefault<z.ZodBoolean>;
            moderator: z.ZodDefault<z.ZodBoolean>;
            moderatorModel: z.ZodOptional<z.ZodString>;
            maxSourcesPerMember: z.ZodDefault<z.ZodNumber>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    parallelization: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        maxConcurrentTasks: z.ZodDefault<z.ZodNumber>;
        evidenceLockTimeoutMs: z.ZodDefault<z.ZodNumber>;
        max_coders: z.ZodDefault<z.ZodNumber>;
        max_reviewers: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strip>>;
    turbo: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
        strategy: z.ZodLiteral<"standard">;
        lean: z.ZodOptional<z.ZodObject<{
            max_parallel_coders: z.ZodDefault<z.ZodNumber>;
            require_declared_scope: z.ZodDefault<z.ZodBoolean>;
            conflict_policy: z.ZodDefault<z.ZodEnum<{
                serialize: "serialize";
                degrade: "degrade";
            }>>;
            degrade_on_risk: z.ZodDefault<z.ZodBoolean>;
            phase_reviewer: z.ZodDefault<z.ZodBoolean>;
            phase_critic: z.ZodDefault<z.ZodBoolean>;
            integrated_diff_required: z.ZodDefault<z.ZodBoolean>;
            allow_docs_only_without_reviewer: z.ZodDefault<z.ZodBoolean>;
            worktree_isolation: z.ZodDefault<z.ZodBoolean>;
        }, z.core.$strip>>;
    }, z.core.$strip>, z.ZodObject<{
        strategy: z.ZodLiteral<"lean">;
        lean: z.ZodObject<{
            max_parallel_coders: z.ZodDefault<z.ZodNumber>;
            require_declared_scope: z.ZodDefault<z.ZodBoolean>;
            conflict_policy: z.ZodDefault<z.ZodEnum<{
                serialize: "serialize";
                degrade: "degrade";
            }>>;
            degrade_on_risk: z.ZodDefault<z.ZodBoolean>;
            phase_reviewer: z.ZodDefault<z.ZodBoolean>;
            phase_critic: z.ZodDefault<z.ZodBoolean>;
            integrated_diff_required: z.ZodDefault<z.ZodBoolean>;
            allow_docs_only_without_reviewer: z.ZodDefault<z.ZodBoolean>;
            worktree_isolation: z.ZodDefault<z.ZodBoolean>;
        }, z.core.$strip>;
    }, z.core.$strip>], "strategy">>;
    turbo_mode: z.ZodOptional<z.ZodDefault<z.ZodBoolean>>;
    quiet: z.ZodOptional<z.ZodDefault<z.ZodBoolean>>;
    version_check: z.ZodOptional<z.ZodDefault<z.ZodBoolean>>;
    full_auto: z.ZodDefault<z.ZodOptional<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        critic_model: z.ZodOptional<z.ZodString>;
        max_interactions_per_phase: z.ZodDefault<z.ZodNumber>;
        deadlock_threshold: z.ZodDefault<z.ZodNumber>;
        escalation_mode: z.ZodDefault<z.ZodEnum<{
            pause: "pause";
            terminate: "terminate";
        }>>;
        mode: z.ZodDefault<z.ZodEnum<{
            strict: "strict";
            assisted: "assisted";
            supervised: "supervised";
        }>>;
        fail_closed: z.ZodDefault<z.ZodBoolean>;
        permission_policy: z.ZodDefault<z.ZodObject<{
            enabled: z.ZodDefault<z.ZodBoolean>;
            trusted_roots: z.ZodDefault<z.ZodArray<z.ZodString>>;
            trusted_domains: z.ZodDefault<z.ZodArray<z.ZodString>>;
            protected_paths: z.ZodDefault<z.ZodArray<z.ZodString>>;
            allow_defaults: z.ZodDefault<z.ZodBoolean>;
        }, z.core.$strip>>;
        denials: z.ZodDefault<z.ZodObject<{
            max_consecutive: z.ZodDefault<z.ZodNumber>;
            max_total: z.ZodDefault<z.ZodNumber>;
            on_limit: z.ZodDefault<z.ZodEnum<{
                pause: "pause";
                terminate: "terminate";
            }>>;
        }, z.core.$strip>>;
        oversight: z.ZodDefault<z.ZodObject<{
            on_plan_change: z.ZodDefault<z.ZodBoolean>;
            on_task_completion: z.ZodDefault<z.ZodBoolean>;
            on_phase_boundary: z.ZodDefault<z.ZodBoolean>;
            on_high_risk_action: z.ZodDefault<z.ZodBoolean>;
            on_subagent_return_warning: z.ZodDefault<z.ZodBoolean>;
            every_tool_calls: z.ZodDefault<z.ZodNumber>;
            every_architect_turns: z.ZodDefault<z.ZodNumber>;
            every_minutes: z.ZodDefault<z.ZodNumber>;
        }, z.core.$strip>>;
    }, z.core.$strip>>>;
}, z.core.$strip>;
export type PluginConfig = z.infer<typeof PluginConfigSchema>;
export type { AgentName, PipelineAgentName, QAAgentName, } from './constants';
