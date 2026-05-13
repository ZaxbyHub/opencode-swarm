import type { AgentDefinition } from '../agents/index.js';
declare function levenshteinDistance(a: string, b: string): number;
declare function findSimilarCommands(query: string): string[];
declare function buildDetailedHelp(commandName: string, entry: CommandEntry): string;
export declare function handleHelpCommand(ctx: CommandContext): Promise<string>;
export type CommandContext = {
    directory: string;
    args: string[];
    sessionID: string;
    agents: Record<string, AgentDefinition>;
};
export type CommandResult = Promise<string>;
export type CommandCategory = 'core' | 'agent' | 'config' | 'diagnostics' | 'utility';
export type CommandEntry = {
    handler: (ctx: CommandContext) => CommandResult;
    /** Human-readable description shown in /swarm help and CLI --help */
    description: string;
    /** If true, this command is only accessible as a sub-key of a parent command */
    subcommandOf?: string;
    /**
     * 2-3 line behavioral summary: what the command does step-by-step,
     * side effects, and safety guarantees.
     */
    details?: string;
    /**
     * Documents flags and positional arguments. Format: flags comma-separated with
     * double-dash prefix, positional args in angle brackets.
     * Example: args: '--dry-run, --confirm, <phase-number>'
     */
    args?: string;
    /** Functional category for organization and filtering */
    category?: CommandCategory;
    /** Canonical command name this entry redirects to */
    aliasOf?: string;
    /** Whether this entry is deprecated — prefer aliasOf target instead */
    deprecated?: boolean;
    /** If set, this command shares a name with a Claude Code built-in slash command */
    clashesWithNativeCcCommand?: string;
};
export declare const COMMAND_REGISTRY: {
    readonly 'acknowledge-spec-drift': {
        readonly handler: (ctx: CommandContext) => Promise<string>;
        readonly description: "Acknowledge that the spec has drifted from the plan and suppress further warnings";
        readonly args: "";
        readonly category: "diagnostics";
    };
    readonly status: {
        readonly handler: (ctx: CommandContext) => Promise<string>;
        readonly description: "Show current swarm state";
        readonly category: "core";
        readonly clashesWithNativeCcCommand: "/status";
    };
    readonly 'show-plan': {
        readonly handler: (ctx: CommandContext) => Promise<string>;
        readonly description: "Show current plan (optionally filter by phase number)";
        readonly category: "core";
        readonly args: "[phase-number]";
    };
    readonly plan: {
        readonly handler: (ctx: CommandContext) => Promise<string>;
        readonly description: "Show current plan (deprecated alias for /swarm show-plan)";
        readonly category: "core";
        readonly clashesWithNativeCcCommand: "/plan";
        readonly aliasOf: "show-plan";
        readonly deprecated: true;
    };
    readonly agents: {
        readonly handler: (ctx: CommandContext) => Promise<string>;
        readonly description: "List registered agents";
        readonly category: "core";
        readonly clashesWithNativeCcCommand: "/agents";
    };
    readonly help: {
        readonly handler: (ctx: CommandContext) => Promise<string>;
        readonly description: "Show help for swarm commands";
        readonly category: "core";
        readonly args: "[command]";
        readonly details: "Without argument, shows full command listing. With argument, shows detailed help for a specific command.";
    };
    readonly history: {
        readonly handler: (ctx: CommandContext) => Promise<string>;
        readonly description: "Show completed phases summary";
        readonly category: "utility";
        readonly clashesWithNativeCcCommand: "/history";
    };
    readonly config: {
        readonly handler: (ctx: CommandContext) => Promise<string>;
        readonly description: "Show current resolved configuration";
        readonly category: "config";
        readonly clashesWithNativeCcCommand: "/config";
    };
    readonly 'config doctor': {
        readonly handler: (ctx: CommandContext) => Promise<string>;
        readonly description: "Run config doctor checks";
        readonly subcommandOf: "config";
        readonly category: "diagnostics";
    };
    readonly 'config-doctor': {
        readonly handler: (ctx: CommandContext) => Promise<string>;
        readonly description: "Run config doctor checks";
        readonly subcommandOf: "config";
        readonly category: "diagnostics";
        readonly aliasOf: "config doctor";
        readonly deprecated: true;
    };
    readonly 'doctor tools': {
        readonly handler: (ctx: CommandContext) => Promise<string>;
        readonly description: "Run tool registration coherence check";
        readonly category: "diagnostics";
    };
    readonly diagnose: {
        readonly handler: (ctx: CommandContext) => Promise<string>;
        readonly description: "Run health check on swarm state";
        readonly category: "diagnostics";
    };
    readonly diagnosis: {
        readonly handler: (ctx: CommandContext) => Promise<string>;
        readonly description: "Run health check on swarm state";
        readonly category: "diagnostics";
        readonly aliasOf: "diagnose";
        readonly deprecated: true;
    };
    readonly preflight: {
        readonly handler: (ctx: CommandContext) => Promise<string>;
        readonly description: "Run preflight automation checks";
        readonly category: "diagnostics";
    };
    readonly 'sync-plan': {
        readonly handler: (ctx: CommandContext) => Promise<string>;
        readonly description: "Ensure plan.json and plan.md are synced";
        readonly args: "";
        readonly category: "config";
    };
    readonly benchmark: {
        readonly handler: (ctx: CommandContext) => Promise<string>;
        readonly description: "Show performance metrics [--cumulative] [--ci-gate]";
        readonly args: "--cumulative, --ci-gate";
        readonly category: "diagnostics";
    };
    readonly export: {
        readonly handler: (ctx: CommandContext) => Promise<string>;
        readonly description: "Export plan and context as JSON";
        readonly args: "";
        readonly details: "Exports the current plan and context as JSON to stdout. Useful for piping to external tools or debugging swarm state.";
        readonly category: "utility";
        readonly clashesWithNativeCcCommand: "/export";
    };
    readonly evidence: {
        readonly handler: (ctx: CommandContext) => Promise<string>;
        readonly description: "Show evidence bundles [taskId]";
        readonly args: "<taskId>";
        readonly details: "Displays review results, test verdicts, and other evidence bundles for the given task ID (e.g., \"2.1\").";
        readonly category: "utility";
    };
    readonly 'evidence summary': {
        readonly handler: (ctx: CommandContext) => Promise<string>;
        readonly description: "Generate evidence summary with completion ratio and blockers";
        readonly subcommandOf: "evidence";
        readonly args: "";
        readonly details: "Generates a summary showing completion ratio across all tasks, lists blockers, and identifies missing evidence.";
        readonly category: "utility";
    };
    readonly 'evidence-summary': {
        readonly handler: (ctx: CommandContext) => Promise<string>;
        readonly description: "Generate evidence summary with completion ratio and blockers";
        readonly subcommandOf: "evidence";
        readonly args: "";
        readonly details: "Generates a summary showing completion ratio across all tasks, lists blockers, and identifies missing evidence.";
        readonly category: "utility";
        readonly aliasOf: "evidence summary";
        readonly deprecated: true;
    };
    readonly doctor: {
        readonly handler: (ctx: CommandContext) => Promise<string>;
        readonly description: "Run config doctor checks";
        readonly category: "diagnostics";
        readonly aliasOf: "config doctor";
        readonly deprecated: true;
        readonly clashesWithNativeCcCommand: "/doctor";
    };
    readonly info: {
        readonly handler: (ctx: CommandContext) => Promise<string>;
        readonly description: "Show current swarm state";
        readonly category: "core";
        readonly aliasOf: "status";
        readonly deprecated: true;
    };
    readonly 'list-agents': {
        readonly handler: (ctx: CommandContext) => Promise<string>;
        readonly description: "List registered agents";
        readonly category: "core";
        readonly aliasOf: "agents";
        readonly deprecated: true;
    };
    readonly health: {
        readonly handler: (ctx: CommandContext) => Promise<string>;
        readonly description: "Run health check on swarm state";
        readonly category: "diagnostics";
        readonly aliasOf: "diagnose";
        readonly deprecated: true;
    };
    readonly check: {
        readonly handler: (ctx: CommandContext) => Promise<string>;
        readonly description: "Run preflight automation checks";
        readonly category: "diagnostics";
        readonly aliasOf: "preflight";
        readonly deprecated: true;
    };
    readonly clear: {
        readonly handler: (ctx: CommandContext) => Promise<string>;
        readonly description: "Clear session state while preserving plan, evidence, and knowledge";
        readonly category: "utility";
        readonly aliasOf: "reset-session";
        readonly deprecated: true;
    };
    readonly archive: {
        readonly handler: (ctx: CommandContext) => Promise<string>;
        readonly description: "Archive old evidence bundles [--dry-run]";
        readonly details: "Archives evidence bundles older than max_age_days (config, default 90) or beyond max_bundles cap (config, default 1000). --dry-run previews which bundles would be archived without deleting them. Applies two-tier retention: age-based first, then count-based on oldest remaining.";
        readonly args: "--dry-run";
        readonly category: "utility";
    };
    readonly curate: {
        readonly handler: (ctx: CommandContext) => Promise<string>;
        readonly description: "Run knowledge curation and hive promotion review";
        readonly args: "";
        readonly category: "utility";
    };
    readonly 'dark-matter': {
        readonly handler: (ctx: CommandContext) => Promise<string>;
        readonly description: "Detect hidden file couplings via co-change NPMI analysis";
        readonly args: "--threshold <number>, --min-commits <number>";
        readonly category: "diagnostics";
    };
    readonly finalize: {
        readonly handler: (ctx: CommandContext) => Promise<string>;
        readonly description: "Use /swarm finalize to finalize the swarm project and archive evidence";
        readonly details: "Idempotent 4-stage terminal finalization: (1) finalize writes retrospectives for in-progress phases, (2) archive creates timestamped bundle of swarm artifacts and evidence, (3) clean removes active-state files for a clean slate, (4) align performs safe git ff-only to main. Resets agent sessions and delegation chains. Reads .swarm/close-lessons.md for explicit lessons and runs curation. Use --skill-review to run the quota-bounded skill_improver in proposal mode.";
        readonly args: "--prune-branches, --skill-review";
        readonly category: "core";
    };
    readonly close: {
        readonly handler: (ctx: CommandContext) => Promise<string>;
        readonly description: "Use /swarm close (deprecated alias) to finalize and archive swarm state";
        readonly details: "Deprecated alias for /swarm finalize. Preserved for backward compatibility.";
        readonly args: "--prune-branches, --skill-review";
        readonly category: "core";
        readonly aliasOf: "finalize";
        readonly deprecated: true;
    };
    readonly simulate: {
        readonly handler: (ctx: CommandContext) => Promise<string>;
        readonly description: "Dry-run hidden coupling analysis with configurable thresholds";
        readonly args: "--threshold <number>, --min-commits <number>";
        readonly category: "diagnostics";
    };
    readonly analyze: {
        readonly handler: (ctx: CommandContext) => Promise<string>;
        readonly description: "Analyze spec.md vs plan.md for requirement coverage gaps";
        readonly args: "";
        readonly category: "agent";
    };
    readonly clarify: {
        readonly handler: (ctx: CommandContext) => Promise<string>;
        readonly description: "Clarify and refine an existing feature specification";
        readonly args: "[description-text]";
        readonly category: "agent";
    };
    readonly specify: {
        readonly handler: (ctx: CommandContext) => Promise<string>;
        readonly description: "Generate or import a feature specification [description]";
        readonly args: "[description-text]";
        readonly category: "agent";
    };
    readonly brainstorm: {
        readonly handler: (ctx: CommandContext) => Promise<string>;
        readonly description: "Enter architect MODE: BRAINSTORM — structured seven-phase planning workflow [topic]";
        readonly args: "[topic-text]";
        readonly details: "Triggers the architect to run the brainstorm workflow: CONTEXT SCAN, single-question DIALOGUE, APPROACHES, DESIGN SECTIONS, SPEC WRITE + SELF-REVIEW, QA GATE SELECTION, TRANSITION. Use for new plans where requirements need to be drawn out before writing spec.md / plan.md.";
        readonly category: "agent";
    };
    readonly council: {
        readonly handler: (ctx: CommandContext) => Promise<string>;
        readonly description: "Enter architect MODE: COUNCIL — multi-model deliberation [question] [--preset <name>] [--spec-review]";
        readonly args: "<question> [--preset <name>] [--spec-review]";
        readonly details: string;
        readonly category: "agent";
    };
    readonly 'pr-review': {
        readonly handler: (ctx: CommandContext) => Promise<string>;
        readonly description: "Launch deep PR review with multi-lane analysis [url] [--council]";
        readonly args: "<pr-url|owner/repo#N|N> [--council]";
        readonly details: "Launches a structured PR review: reconstructs PR intent via obligation extraction cascade, runs 6 parallel explorer lanes (correctness, security, dependencies, docs-intent-vs-actual, tests, performance-architecture), validates findings through independent reviewer confirmation, applies critic challenge to HIGH/CRITICAL findings, synthesizes structured report. --council variant fires adversarial multi-model review. Supports full GitHub URL, owner/repo#N shorthand, or bare PR number (resolves against origin remote).";
        readonly category: "agent";
    };
    readonly 'deep-dive': {
        readonly handler: (ctx: CommandContext) => Promise<string>;
        readonly description: "Launch deep codebase audit with parallel explorer waves, dual reviewers, and critic challenge [scope]";
        readonly args: "<scope> [--profile standard|security|ux|architecture|full] [--max-explorers 1..8] [--json] [--skip-update] [--allow-dirty]";
        readonly details: "Runs a read-only deep audit of the specified scope using parallel explorer waves (8-file cap per mission, ~3500 line guardrail), always 2 parallel reviewers for verification, and sequential critic challenge on HIGH/CRITICAL findings. Profiles select explorer lanes: standard (5 lanes), security, ux, architecture, full (all 8 lanes). Emits a structured findings report without mutating source code.";
        readonly category: "agent";
    };
    readonly 'deep dive': {
        readonly handler: (ctx: CommandContext) => Promise<string>;
        readonly description: "Alias for /swarm deep-dive — launch deep codebase audit";
        readonly args: "<scope> [--profile standard|security|ux|architecture|full] [--max-explorers 1..8] [--json] [--skip-update] [--allow-dirty]";
        readonly category: "agent";
        readonly aliasOf: "deep-dive";
    };
    readonly issue: {
        readonly handler: (ctx: CommandContext) => Promise<string>;
        readonly description: "Ingest a GitHub issue into the swarm workflow [url] [--plan] [--trace] [--no-repro]";
        readonly args: "<issue-url|owner/repo#N|N> [--plan] [--trace] [--no-repro]";
        readonly details: "Triggers the architect to enter MODE: ISSUE_INGEST — ingests a GitHub issue, restructures it into a normalized intake note, localizes root cause through hypothesis-driven tracing, and outputs a resolution spec. --plan transitions to plan creation after spec generation. --trace runs the full fix-and-PR workflow (implies --plan). --no-repro skips the reproduction step. Supports full GitHub URL, owner/repo#N shorthand, or bare issue number (resolves against origin remote).";
        readonly category: "agent";
    };
    readonly 'qa-gates': {
        readonly handler: (ctx: CommandContext) => Promise<string>;
        readonly description: "View or modify QA gate profile for the current plan [enable|override <gate>...]";
        readonly args: "[show|enable|override] <gate>...";
        readonly details: "show: display spec-level, session-override, and effective QA gates for the current plan. enable: persist gate(s) into the locked-once profile (architect; rejected after critic approval lock). override: session-only ratchet-tighter enable. Valid gates: reviewer, test_engineer, council_mode, sme_enabled, critic_pre_plan, hallucination_guard, sast_enabled, mutation_test, council_general_review, drift_check.";
        readonly category: "config";
    };
    readonly promote: {
        readonly handler: (ctx: CommandContext) => Promise<string>;
        readonly description: "Manually promote lesson to hive knowledge";
        readonly details: "Promotes a lesson directly to hive knowledge (--category flag sets category) or references an existing swarm lesson by ID (--from-swarm). Validates lesson text before promotion. Either direct text or --from-swarm ID is required.";
        readonly args: "--category <category>, --from-swarm <lesson-id>, <lesson-text>";
        readonly category: "utility";
    };
    readonly reset: {
        readonly handler: (ctx: CommandContext) => Promise<string>;
        readonly description: "Clear swarm state files [--confirm]";
        readonly details: "DELETES plan.md, context.md, and summaries/ directory from .swarm/. Stops background automation and clears in-memory queues. SAFETY: requires --confirm flag — without it, displays a warning and tips to export first.";
        readonly args: "--confirm (required)";
        readonly category: "utility";
        readonly clashesWithNativeCcCommand: "/reset";
    };
    readonly 'reset-session': {
        readonly handler: (ctx: CommandContext) => Promise<string>;
        readonly description: "Clear session state while preserving plan, evidence, and knowledge";
        readonly details: "Deletes only .swarm/session/state.json and any other session files. Clears in-memory agent sessions and delegation chains. Preserves plan, evidence, and knowledge for cross-session continuity.";
        readonly args: "";
        readonly category: "utility";
    };
    readonly rollback: {
        readonly handler: (ctx: CommandContext) => Promise<string>;
        readonly description: "Restore swarm state to a checkpoint <phase>";
        readonly details: "Restores .swarm/ state by directly overwriting files from a checkpoint directory (checkpoints/phase-<N>). Writes rollback event to events.jsonl. Without phase argument, lists available checkpoints. Partial failures are reported but processing continues.";
        readonly args: "<phase-number>";
        readonly category: "utility";
    };
    readonly retrieve: {
        readonly handler: (ctx: CommandContext) => Promise<string>;
        readonly description: "Retrieve full output from a summary <id>";
        readonly args: "<summary-id>";
        readonly details: "Loads the full tool output that was previously summarized (referenced by IDs like S1, S2). Use when you need the complete output instead of the truncated summary.";
        readonly category: "utility";
    };
    readonly handoff: {
        readonly handler: (ctx: CommandContext) => Promise<string>;
        readonly description: "Prepare state for clean model switch (new session)";
        readonly args: "";
        readonly details: "Generates handoff.md with full session state snapshot, including plan progress, recent decisions, and agent delegation history. Prepended to the next session prompt for seamless model switches.";
        readonly category: "core";
    };
    readonly turbo: {
        readonly handler: (ctx: CommandContext) => Promise<string>;
        readonly description: "Toggle Turbo Mode strategy for the active session [on|off|lean|standard|status]";
        readonly args: "on, off, lean, standard, status";
        readonly details: string;
        readonly category: "utility";
    };
    readonly 'full-auto': {
        readonly handler: (ctx: CommandContext) => Promise<string>;
        readonly description: "Toggle Full-Auto Mode for the active session [on|off]";
        readonly args: "on, off";
        readonly details: "Toggles Full-Auto Mode which enables autonomous execution without confirmation prompts. When enabled, the architect proceeds through implementation steps automatically. Session-scoped — resets on new session. Use \"on\" or \"off\" to set explicitly, or toggle with no argument.";
        readonly category: "utility";
    };
    readonly 'write-retro': {
        readonly handler: (ctx: CommandContext) => Promise<string>;
        readonly description: "Write a retrospective evidence bundle for a completed phase <json>";
        readonly details: "Writes retrospective evidence bundle to .swarm/evidence/retro-{phase}/evidence.json. Required JSON: phase, summary, task_count, task_complexity, total_tool_calls, coder_revisions, reviewer_rejections, test_failures, security_findings, integration_issues. Optional: lessons_learned (max 5), top_rejection_reasons, task_id, metadata.";
        readonly args: "<json: {phase, summary, task_count, task_complexity, ...}>";
        readonly category: "utility";
    };
    readonly 'knowledge migrate': {
        readonly handler: (ctx: CommandContext) => Promise<string>;
        readonly description: "Migrate knowledge entries to the current format";
        readonly subcommandOf: "knowledge";
        readonly details: "One-time migration from .swarm/context.md SME cache to .swarm/knowledge.jsonl. Skips if sentinel file .swarm/.knowledge-migrated exists, if context.md is absent, or if context.md is empty. Reports entries migrated, dropped (validation/dedup), and total processed.";
        readonly args: "<directory>";
        readonly category: "utility";
    };
    readonly 'knowledge quarantine': {
        readonly handler: (ctx: CommandContext) => Promise<string>;
        readonly description: "Move a knowledge entry to quarantine <id> [reason]";
        readonly subcommandOf: "knowledge";
        readonly details: "Moves a knowledge entry to quarantine with optional reason string (defaults to \"Quarantined via /swarm knowledge quarantine command\"). Validates entry ID format (1-64 alphanumeric/hyphen/underscore). Quarantined entries are excluded from knowledge queries.";
        readonly args: "<entry-id> [reason]";
        readonly category: "utility";
    };
    readonly 'knowledge restore': {
        readonly handler: (ctx: CommandContext) => Promise<string>;
        readonly description: "Restore a quarantined knowledge entry <id>";
        readonly subcommandOf: "knowledge";
        readonly details: "Restores a quarantined knowledge entry back to the active knowledge store by ID. Validates entry ID format (1-64 alphanumeric/hyphen/underscore). Entry must currently be in quarantine state.";
        readonly args: "<entry-id>";
        readonly category: "utility";
    };
    readonly knowledge: {
        readonly handler: (ctx: CommandContext) => Promise<string>;
        readonly description: "List knowledge entries";
        readonly category: "utility";
    };
    readonly checkpoint: {
        readonly handler: (ctx: CommandContext) => Promise<string>;
        readonly description: "Manage project checkpoints [save|restore|delete|list] <label>";
        readonly details: "save: creates named snapshot of current .swarm/ state. restore: soft-resets to checkpoint by overwriting current .swarm/ files. delete: removes named checkpoint. list: shows all checkpoints with timestamps. All subcommands require a label except list.";
        readonly args: "<save|restore|delete|list> <label>";
        readonly category: "utility";
        readonly clashesWithNativeCcCommand: "/checkpoint";
    };
};
export type RegisteredCommand = keyof typeof COMMAND_REGISTRY;
export declare const VALID_COMMANDS: RegisteredCommand[];
/**
 * Validates alias configuration in COMMAND_REGISTRY.
 * Checks for:
 * - aliasOf pointing to an existing command
 * - circular alias chains (A → B → C → A)
 * - duplicate alias targets (multiple aliases for different commands) — logged as warning, not error
 */
export declare function validateAliases(): {
    valid: boolean;
    errors: string[];
    warnings: string[];
};
/**
 * DI seam for testability. Contains all test-mocked exports.
 * Internal calls should use _internals.fn() instead of fn() directly.
 */
export declare const _internals: {
    handleHelpCommand: typeof handleHelpCommand;
    validateAliases: typeof validateAliases;
    resolveCommand: typeof resolveCommand;
    levenshteinDistance: typeof levenshteinDistance;
    findSimilarCommands: typeof findSimilarCommands;
    buildDetailedHelp: typeof buildDetailedHelp;
};
/**
 * Resolves compound commands like "evidence summary" and "config doctor".
 * Tries a two-token compound key first, then falls back to a single-token key.
 * Returns a warning if the resolved command is a deprecated alias.
 */
export declare function resolveCommand(tokens: string[]): {
    entry: CommandEntry;
    remainingArgs: string[];
    key: string;
    warning?: string;
} | null;
export {};
