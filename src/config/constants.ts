import type { ToolName } from '../tools/tool-names';
import type { AgentName, QAAgentName } from './agent-names';
// Agent names moved to a dependency-free leaf (#507) so the tool manifest can
// derive AGENT_TOOL_MAP without an init cycle. Imported for in-file use and
// re-exported so existing `from '../config/constants'` call sites are unchanged.
import { ALL_SUBAGENT_NAMES, QA_AGENTS } from './agent-names';

// AGENT_TOOL_MAP and TOOL_DESCRIPTIONS are DERIVED in (and re-exported from) the
// HANDLER-FREE tool-metadata module — NOT the handler-bearing manifest. This is
// what keeps constants.ts (imported by tool modules) out of an init cycle with
// the tool handlers. See src/tools/tool-metadata.ts.
export { AGENT_TOOL_MAP, TOOL_DESCRIPTIONS } from '../tools/tool-metadata';
export type { AgentName, PipelineAgentName, QAAgentName } from './agent-names';
export {
	ALL_AGENT_NAMES,
	ALL_SUBAGENT_NAMES,
	ORCHESTRATOR_NAME,
	PIPELINE_AGENTS,
	QA_AGENTS,
} from './agent-names';

// (SKILL_AGENT_TOOL_MAP and SKILL_TOOL_NAMES are defined below and exported at end of file.)

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
function freezeSet<T>(
	items: readonly T[],
	name = 'CLAUDE_CODE_NATIVE_COMMANDS',
): ReadonlySet<T> {
	const set = new Set(items);
	const proxy = new Proxy(set, {
		get(target, prop) {
			if (prop === 'add' || prop === 'delete' || prop === 'clear') {
				return () => {
					throw new TypeError(`${name} is readonly`);
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
			throw new TypeError(`${name} is readonly`);
		},
		deleteProperty() {
			throw new TypeError(`${name} is readonly`);
		},
		defineProperty() {
			throw new TypeError(`${name} is readonly`);
		},
		setPrototypeOf() {
			throw new TypeError(`${name} is readonly`);
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

/**
 * OpenCode built-in slash commands (without leading slash). Used by
 * tests/unit/skills/claude-slug-collision-guard.test.ts to assert that no
 * repo-shipped native skill slug in `.opencode/skills/` or `.claude/skills/`
 * shadows one of OpenCode's own `/<slug>` commands (the host exposes every
 * native skill directory as a slash command, so e.g. a `plan` skill dir would
 * shadow OpenCode's built-in `/plan` plan mode — issue #2388/#2493).
 *
 * Hand-curated mirror of OpenCode's built-in slash commands — must be
 * reviewed when bumping @opencode-ai/* dependencies (no programmatic oracle
 * exists; issue #2493).
 */
export const OPENCODE_NATIVE_COMMANDS: ReadonlySet<string> = freezeSet(
	[
		'plan',
		'new',
		'share',
		'clear',
		'undo',
		'redo',
		'compact',
		'export',
		'help',
		'exit',
		'models',
		'themes',
		'edit',
		'resume',
		'copy',
		'log',
		'messages',
		'summary',
		'tree',
		'session',
	],
	'OPENCODE_NATIVE_COMMANDS',
);

export const MEMORY_TOOL_NAMES = [
	'swarm_memory_recall',
	'swarm_memory_propose',
	'swarm_memory_outcome',
] as const satisfies readonly ToolName[];

export const MEMORY_AGENT_TOOL_MAP: Partial<Record<AgentName, ToolName[]>> = {
	architect: [
		'swarm_memory_recall',
		'swarm_memory_propose',
		'swarm_memory_outcome',
	],
	explorer: [
		'swarm_memory_recall',
		'swarm_memory_propose',
		'swarm_memory_outcome',
	],
	coder: [
		'swarm_memory_recall',
		'swarm_memory_propose',
		'swarm_memory_outcome',
	],
	reviewer: ['swarm_memory_recall', 'swarm_memory_outcome'],
	test_engineer: ['swarm_memory_recall', 'swarm_memory_propose'],
	sme: ['swarm_memory_recall', 'swarm_memory_propose'],
	critic: ['swarm_memory_recall', 'swarm_memory_outcome'],
	critic_sounding_board: ['swarm_memory_recall'],
	critic_drift_verifier: ['swarm_memory_recall'],
	critic_hallucination_verifier: ['swarm_memory_recall'],
	critic_architecture_supervisor: ['swarm_memory_recall'],
	critic_finding_validator: ['swarm_memory_recall'],
	docs: ['swarm_memory_recall', 'swarm_memory_propose'],
	docs_design: ['swarm_memory_recall', 'swarm_memory_propose'],
	designer: ['swarm_memory_recall', 'swarm_memory_propose'],
	curator_init: ['swarm_memory_recall'],
	curator_phase: ['swarm_memory_recall'],
	curator_postmortem: ['swarm_memory_recall'],
	curator_consolidation: ['swarm_memory_recall'],
	skill_improver: ['swarm_memory_recall', 'swarm_memory_propose'],
	spec_writer: ['swarm_memory_recall', 'swarm_memory_propose'],
};

// ---------------------------------------------------------------------------
// External skill curation tools — opt-in, gated by external_skills.curation_enabled
// ---------------------------------------------------------------------------

export const EXTERNAL_SKILL_TOOL_NAMES = [
	'external_skill_discover',
	'external_skill_list',
	'external_skill_inspect',
	'external_skill_promote',
	'external_skill_reject',
	'external_skill_delete',
	'external_skill_revoke',
] as const satisfies readonly ToolName[];

export const EXTERNAL_SKILL_AGENT_TOOL_MAP: Partial<
	Record<AgentName, ToolName[]>
> = {
	architect: [...EXTERNAL_SKILL_TOOL_NAMES],
};

// ---------------------------------------------------------------------------
// Council tools — opt-in, gated by council.enabled (QA council modes)
// ---------------------------------------------------------------------------

export const COUNCIL_TOOL_NAMES = [
	'submit_council_verdicts',
	'submit_phase_council_verdicts',
	'declare_council_criteria',
	'write_final_council_evidence',
] as const satisfies readonly ToolName[];

export const COUNCIL_AGENT_TOOL_MAP: Partial<Record<AgentName, ToolName[]>> = {
	architect: [...COUNCIL_TOOL_NAMES],
};

// ---------------------------------------------------------------------------
// General council tools — opt-in, gated by council.general.enabled (research/synthesis)
// ---------------------------------------------------------------------------

export const GENERAL_COUNCIL_TOOL_NAMES = [
	'convene_general_council',
	'web_search',
	'web_fetch',
] as const satisfies readonly ToolName[];

export const GENERAL_COUNCIL_AGENT_TOOL_MAP: Partial<
	Record<AgentName, ToolName[]>
> = {
	architect: [...GENERAL_COUNCIL_TOOL_NAMES],
};

// ---------------------------------------------------------------------------
// Lean Turbo tools — opt-in, gated by turbo config block presence
// ---------------------------------------------------------------------------

export const TURBO_TOOL_NAMES = [
	'lean_turbo_plan_lanes',
	'lean_turbo_acquire_locks',
	'lean_turbo_runner_status',
	'lean_turbo_review',
	'lean_turbo_critic',
	'lean_turbo_run_phase',
	'lean_turbo_status',
] as const satisfies readonly ToolName[];

export const TURBO_AGENT_TOOL_MAP: Partial<Record<AgentName, ToolName[]>> = {
	architect: [...TURBO_TOOL_NAMES],
};

// ---------------------------------------------------------------------------
// Epic Mode tools — opt-in, gated by epic.mode.enabled === true
// ---------------------------------------------------------------------------

/**
 * Every Epic Mode tool. They stay registered in the plugin (TOOL_METADATA +
 * TOOL_MANIFEST + barrel) but carry `agents: []`, so no agent sees them
 * unless `epic.mode.enabled === true`, in which case they are merged
 * into the architect's tool set at every opt-in merge site
 * (`getAgentConfigs`, the architect prompt tool lists, the full-auto
 * capability derivation).
 */
export const EPIC_TOOL_NAMES = [
	'epic_next_wave',
	'epic_phase_review',
] as const satisfies readonly ToolName[];

export const EPIC_AGENT_TOOL_MAP: Partial<Record<AgentName, ToolName[]>> = {
	architect: [...EPIC_TOOL_NAMES],
};

// ---------------------------------------------------------------------------
// Skill-management tools — opt-in, gated by skills.enabled (FR-004)
// ---------------------------------------------------------------------------

export const SKILL_TOOL_NAMES = [
	'skill_generate',
	'skill_list',
	'skill_apply',
	'skill_inspect',
	'skill_regenerate',
	'skill_retire',
	'skill_improve',
] as const satisfies readonly ToolName[];

export const SKILL_AGENT_TOOL_MAP: Partial<Record<AgentName, ToolName[]>> = {
	architect: [...SKILL_TOOL_NAMES],
};

// ---------------------------------------------------------------------------
// PR-review child settlement — runtime overlay for bound discovery lanes only
// ---------------------------------------------------------------------------

export const PR_REVIEW_CHILD_TOOL_NAMES = [
	'submit_pr_review_result',
] as const satisfies readonly ToolName[];

/**
 * This map documents the role ownership required by the registry invariant.
 * It is deliberately consumed only by dispatch_lanes' base/micro child tool
 * overlay; merging it into ordinary agent configs would expose the submission
 * capability outside an exact controller-bound delegation.
 */
export const PR_REVIEW_CHILD_AGENT_TOOL_MAP: Partial<
	Record<AgentName, ToolName[]>
> = {
	explorer: [...PR_REVIEW_CHILD_TOOL_NAMES],
};

/**
 * Human-readable descriptions for tools shown in the architect Available Tools block.
 * Used to generate the Available Tools section of the architect prompt at construction time.
 */
/**
 * Canonical set of tool names that write/modify file contents.
 * Used by scope-guard.ts and guardrails.ts to detect write operations.
 * NOTE: bash/shell tools are intentionally excluded from this direct-write set.
 * Their detected write targets are analyzed separately by shell-write-detect before
 * execution; an unresolvable detected target fails closed instead of gaining authority here.
 */
export const WRITE_TOOL_NAMES = [
	'write',
	'edit',
	'patch',
	'apply_patch',
	'swarm_apply_patch',
	'create_file',
	'insert',
	'replace',
	'append',
	'prepend',
	// extract_code_blocks writes files parsed from LLM content; it is a
	// workflow-mutating write tool (issue #1778 C1), not a read-only helper.
	'extract_code_blocks',
] as const;

export type WriteToolName = (typeof WRITE_TOOL_NAMES)[number];

/**
 * Single source of truth for tools that must NEVER have their output rewritten
 * by the tool-output summarizer (tool-summarizer.ts) or the context-budget
 * tool-output masker (context-budget.ts). Two independent admission reasons:
 *
 *   (a) Retrieval tools (`retrieve_summary`, `retrieve_lane_output`, `task`,
 *       `read`) — rewriting their output would destroy the recovery mechanism
 *       itself, creating a retrieval loop where the summary/artifact gets
 *       summarized again.
 *   (b) Ref-carrying lane tools (`dispatch_lanes`, `dispatch_lanes_async`,
 *       `collect_lane_results`, `parse_lane_candidates`) — their payloads are
 *       already self-bounding AND carry the `output_ref`/structured rows that
 *       the PR-workflow gate requires to settle lanes. Rewriting them to a
 *       type-signature summary destroys the rows and the refs, so the gate
 *       can never settle and the model cannot recover.
 *
 * This list is a FLOOR, not a default: every consumer must treat these tool
 * names as always exempt regardless of operator-supplied `exempt_tools`
 * config — an operator narrowing `exempt_tools` must never be able to strip
 * this floor.
 */
export const SUMMARIZER_EXEMPT_TOOL_NAMES = [
	'retrieve_summary',
	'retrieve_lane_output',
	'task',
	'read',
	'dispatch_lanes',
	'dispatch_lanes_async',
	'collect_lane_results',
	'parse_lane_candidates',
] as const;

// Default models for each agent/category
// v6.14: switched to free OpenCode Zen models; architect key intentionally
// omitted so it inherits the OpenCode UI model selection.
// v7.189 (#3022): rotated off opencode/minimax-m2.5-free and opencode/gpt-5-nano
// (both dropped from the zen keyless roster — `Model unavailable` at first
// delegation). New ids verified keyless-live 2026-10-02 on @opencode/cli 2.0.21
// (see tests/fixtures/opencode-zen-keyless-roster.json + the roster-guard test
// for the refresh procedure).
export const DEFAULT_MODELS: Record<string, string> = {
	// Explorer — fast read-heavy analysis
	explorer: 'opencode/big-pickle',

	// Pipeline agents — differentiated models for writing vs reviewing
	coder: 'opencode/nemotron-3-ultra-free',
	reviewer: 'opencode/big-pickle',
	test_engineer: 'opencode/mimo-v2.6-flash-free',

	// SME, Critic variants, Docs, Designer — reasoning/general tasks
	sme: 'opencode/big-pickle',
	researcher: 'opencode/big-pickle',
	critic: 'opencode/big-pickle',
	critic_sounding_board: 'opencode/mimo-v2.6-flash-free',
	critic_drift_verifier: 'opencode/mimo-v2.6-flash-free',
	critic_hallucination_verifier: 'opencode/mimo-v2.6-flash-free',
	critic_oversight: 'opencode/mimo-v2.6-flash-free',
	// Architecture supervisor is the expensive cross-task reviewer — inherits the
	// critic model at runtime; this entry mirrors that for config/doc completeness.
	critic_architecture_supervisor: 'opencode/big-pickle',
	critic_finding_validator: 'opencode/big-pickle',
	docs: 'opencode/big-pickle',
	docs_design: 'opencode/big-pickle',
	designer: 'opencode/big-pickle',

	// Curator agents — lightweight read-only analysis (same model family as explorer)
	curator_init: 'opencode/mimo-v2.6-flash-free',
	curator_phase: 'opencode/mimo-v2.6-flash-free',
	curator_postmortem: 'opencode/mimo-v2.6-flash-free',
	curator_consolidation: 'opencode/mimo-v2.6-flash-free',

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
// Used by install() to populate default configs.
// General Council agents (council_generalist, council_skeptic, council_domain_expert)
// derive their models from reviewer/critic/sme entries and don't need separate entries.
export const DEFAULT_AGENT_CONFIGS: Record<
	string,
	{ model: string; fallback_models: string[] }
> = {
	coder: {
		model: 'opencode/nemotron-3-ultra-free',
		fallback_models: ['opencode/mimo-v2.6-flash-free', 'opencode/big-pickle'],
	},
	reviewer: {
		model: 'opencode/big-pickle',
		fallback_models: ['opencode/mimo-v2.6-flash-free', 'opencode/big-pickle'],
	},
	test_engineer: {
		model: 'opencode/mimo-v2.6-flash-free',
		fallback_models: ['opencode/big-pickle'],
	},
	explorer: {
		model: 'opencode/big-pickle',
		fallback_models: ['opencode/mimo-v2.6-flash-free', 'opencode/big-pickle'],
	},
	sme: {
		model: 'opencode/big-pickle',
		fallback_models: ['opencode/mimo-v2.6-flash-free', 'opencode/big-pickle'],
	},
	researcher: {
		model: 'opencode/big-pickle',
		fallback_models: ['opencode/mimo-v2.6-flash-free', 'opencode/big-pickle'],
	},
	critic: {
		model: 'opencode/big-pickle',
		fallback_models: ['opencode/mimo-v2.6-flash-free', 'opencode/big-pickle'],
	},
	docs: {
		model: 'opencode/big-pickle',
		fallback_models: ['opencode/mimo-v2.6-flash-free', 'opencode/big-pickle'],
	},
	docs_design: {
		model: 'opencode/big-pickle',
		fallback_models: ['opencode/mimo-v2.6-flash-free', 'opencode/big-pickle'],
	},
	designer: {
		model: 'opencode/big-pickle',
		fallback_models: ['opencode/mimo-v2.6-flash-free', 'opencode/big-pickle'],
	},
	critic_sounding_board: {
		model: 'opencode/mimo-v2.6-flash-free',
		fallback_models: ['opencode/big-pickle'],
	},
	critic_drift_verifier: {
		model: 'opencode/mimo-v2.6-flash-free',
		fallback_models: ['opencode/big-pickle'],
	},
	critic_hallucination_verifier: {
		model: 'opencode/mimo-v2.6-flash-free',
		fallback_models: ['opencode/big-pickle'],
	},
	critic_oversight: {
		model: 'opencode/mimo-v2.6-flash-free',
		fallback_models: ['opencode/big-pickle'],
	},
	critic_architecture_supervisor: {
		model: 'opencode/big-pickle',
		fallback_models: ['opencode/mimo-v2.6-flash-free'],
	},
	critic_finding_validator: {
		model: 'opencode/big-pickle',
		fallback_models: ['opencode/mimo-v2.6-flash-free'],
	},
	curator_init: {
		model: 'opencode/mimo-v2.6-flash-free',
		fallback_models: ['opencode/big-pickle'],
	},
	curator_phase: {
		model: 'opencode/mimo-v2.6-flash-free',
		fallback_models: ['opencode/big-pickle'],
	},
	curator_postmortem: {
		model: 'opencode/mimo-v2.6-flash-free',
		fallback_models: ['opencode/big-pickle'],
	},
	curator_consolidation: {
		model: 'opencode/mimo-v2.6-flash-free',
		fallback_models: ['opencode/big-pickle'],
	},
	skill_improver: {
		model: 'opencode/big-pickle',
		fallback_models: ['opencode/mimo-v2.6-flash-free'],
	},
	spec_writer: {
		model: 'opencode/big-pickle',
		fallback_models: ['opencode/mimo-v2.6-flash-free'],
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
import type {
	LeanTurboConfig,
	ScoringConfig,
	WorktreeIsolationConfig,
} from './schema';

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

/** Unified injection budget is now configured only at the top level (context_budget.unified_injection_tokens). */
export const KNOWLEDGE_UNIFIED_INJECTION_TOKENS_DEFAULT: number | null = null;

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
- **Stage B** (reviewer + test_engineer) is NOT bypassed by Turbo: \`update_task_status(completed)\` applies the same Stage B rule whether or not Turbo is active, so a task needs Stage B exactly when it would without Turbo
- **Tier 3 tasks** (security-sensitive files matching: architect*.ts, delegation*.ts, guardrails*.ts, adversarial*.ts, sanitiz*.ts, security*.ts; exact basenames: auth, authenticate, authentication, authorization, permission(s), crypto, secret(s), secretscan; keyword prefixes: auth-*, permission-*, crypto-*, secret-*, security-*; or files under auth/, security/, crypto/, permission/, secret/ directories) also keep the coder re-dispatch block until Stage A passes; other tasks whose planned files_touched are known may be re-dispatched to the coder before Stage A (a task with unknown or empty files_touched keeps the block)
- **Phase completion gates** (Gates 1–5: completion-verify, drift-verifier, hallucination-guard, mutation-gate, phase-council) are automatically bypassed by phase_complete's gate table (\`src/tools/phase-complete.ts\`) when turbo is active; Gate 5b (architecture-supervisor), Gate 6 (final-council), and Gate 7 (full-auto) remain enforced. Note: turbo bypass is session-scoped; one session's turbo does not affect other sessions.

Classification still determines the pipeline:
- TIER 0 (metadata): lint + diff only — no change
- TIER 1 (docs): Stage A + reviewer — no change
- TIER 2 (standard code): Stage A + reviewer + test_engineer — no change
- TIER 3 (critical): Stage A + 2x reviewer + 2x test_engineer — no change

Do NOT skip Stage A or Stage B gates.
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

export const AUTO_PROCEED_BANNER = `## ⏭️ AUTO-PROCEED STATUS

Auto-proceed controls whether the architect advances to the next phase automatically (skipping the "Ready for Phase N+1?" confirmation).

Behavioral rules:
- Session override (set via /swarm auto-proceed on|off) wins over the plan default.
- If neither is set, auto-proceed defaults to OFF and the architect asks before advancing.
- Full-auto mode (critic oversight) is independent — while active it suppresses the "Ready for Phase N+1?" confirmation itself (it never delegates tasks or runs phases for you); the auto_proceed setting adds nothing on top.
- autoProceedNudgeDone prevents the FR-004 first-boundary nudge from re-firing in this session.

To toggle at runtime: call swarm_command({ command: "auto-proceed", args: ["on"|"off"] }) from the architect.
`;

/**
 * Canonical default Lean Turbo configuration.

 *
 * This is the single source of truth for all LeanTurboConfig fields.
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
	worktree_isolation: true,
	merge_strategy: 'merge' as const,
	worktree_dir: undefined,
	deps_strategy: 'skip' as const,
	runtime_isolation: {
		enabled: false,
		port_stride: 1,
	},
};

/**
 * Directory name of the DD-6 default swarm-managed worktree base, created as a
 * child of the project root (`<project>/.swarm-worktrees`) — moved inside the
 * project by issue #2527 (the pre-#2527 parent-level default was shared by
 * every sibling checkout and enabled cross-project reclamation destruction);
 * a start-time migration moves owned legacy-base lanes into the project.
 *
 * Single source of truth shared by `resolveWorktreeBaseDir` in
 * `src/worktree/core.ts` (which BUILDS lane paths) and
 * `src/config/lane-context.ts` (which RECOGNISES a lane path after the fact,
 * from inside the lane's own OpenCode instance). Those two must never drift: if
 * creation and recognition disagree, a lane instance silently fails to be
 * identified as a lane and falls back to unscoped permission behaviour.
 *
 * It lives in this leaf constants module rather than in `src/worktree/core.ts`
 * so that the init-path-safe lane modules can share it without pulling the
 * worktree lifecycle module into the plugin entry's import graph
 * (AGENTS.md invariant 1; enforced by
 * `tests/unit/turbo/lean/init-safety.test.ts`).
 */
export const SWARM_WORKTREE_DIR_NAME = '.swarm-worktrees';

export const DEFAULT_WORKTREE_ISOLATION_CONFIG: WorktreeIsolationConfig = {
	policy: 'auto',
	merge_strategy: 'merge',
	worktree_dir: undefined,
	deps_strategy: 'skip',
	lane_permissions: 'scoped_allow',
	serialization_release_after_dispatches: 5,
	serialization_release_after_ms: 60_000,
	// Issue #2599: mirrors WorktreeIsolationConfigSchema's
	// session_create_timeout_ms default (alignment pinned by
	// tests/unit/config/worktree-session-create-timeout.test.ts).
	session_create_timeout_ms: 30_000,
	runtime_isolation: {
		enabled: false,
		port_stride: 1,
	},
};

export const LEAN_TURBO_BANNER = `## 🛤️ LEAN TURBO ACTIVE

Lane-based parallel execution is enabled for this phase.

Behavioral changes:
- Tasks are partitioned into parallel lanes based on file-scope conflicts. Tasks in the same lane run sequentially; tasks in different lanes run concurrently (up to max_parallel_coders).
- **Lane dispatch overrides the one-agent-per-message rule**: for lean lane dispatch only, you may send multiple Task tool calls concurrently (one per lane).
- **Lane tasks still need per-task Stage B** (reviewer + test_engineer) before \`update_task_status(completed)\`; the phase reviewer and critic add a holistic gate at phase end.
- **Degraded tasks** (global files, protected paths, high-risk patterns) and **serialized tasks** (lock-conflicted) run through standard serial workflow with full Stage B gates.
- **Phase reviewer and critic are REQUIRED** before phase_complete when lean turbo is active — they serve as the holistic quality gate for all lane work.
- **Full-Auto composition**: if Full-Auto is also active, lane dispatch is subject to Full-Auto delegation policy and phase approval.
- Use the lean_turbo_run_phase tool to execute a phase with parallel lanes

Do NOT skip phase reviewer/critic when configured. Every task, in a lane or not, MUST still go through full Stage B.
`;

export const EPIC_MODE_BANNER = `## 🧭 EPIC MODE ACTIVE — an epic is open for this plan

**⛔ THE USER ALWAYS COMES FIRST — this overrides everything below.** The user can message you at ANY time, including mid-wave while coders are running or retrying. The instant a user message arrives — a question, a slash command, a comment, anything — STOP advancing the flow: no dispatch, no retry, no further tool call. Answer them directly, in plain conversation, first — ignoring the user is the worst failure mode here. Then resume; if mid-wave, tell them the state ("3.1 and 3.2 are still running; I'll continue once I've answered you") rather than going silent.

**An open epic ≠ start.** The user opened it with \`/swarm epic start\`; until they ask for execution ("start phase N", "run task X", "continue"): do nothing. On \`/swarm epic *\` and any slash status/config command: call the named tool ONCE, surface its output VERBATIM, then stop. Don't infer intent — if unsure, ASK. Only the user opens or closes an epic. Epic enables neither Turbo nor Lean.

**Talk to the user as you work.** Once they ask you to run the plan, say a sentence before each step about what you're doing and why — never go silent and tool-only.

### How to run it: call \`epic_next_wave\` and do exactly what its \`status\` says

It plans every wave, closes finished waves, and keeps phases in order. Never plan waves yourself; never call \`lean_turbo_run_phase\` / \`lean_turbo_plan_lanes\`.
- \`dispatch\` → follow its \`instructions\`: one \`Task\` per \`taskId\`, ALL in ONE message; per task Stage A (\`pre_check_batch\`) → Stage B (\`reviewer\` + \`test_engineer\`) → \`update_task_status(completed)\`; then call \`epic_next_wave\` again.
- \`declare-scopes\` → \`declare_scope\` once per listed \`taskId\` (start from \`suggestedFiles\`), then call again.
- \`in-progress\` → finish the listed tasks, then call again.
- \`blocked\` → relay \`message\` to the user and apply its remedy.
- \`phase-ready-for-review\` → \`epic_phase_review(phase)\` ONCE (phase reviewer, then critic). Both APPROVED → your normal PHASE-WRAP (phase-wrap skill: docs agent, \`write_retro\`, …) → \`phase_complete\` → \`epic_next_wave\`; otherwise add each fix as a NEW pending task of that phase (\`save_plan\`) and call \`epic_next_wave\` (it runs them as a fix wave), then re-run it. Never re-dispatch a coder outside a wave.
- \`epic-complete\` → tell the user to close the epic with \`/swarm epic close\`.
- \`refused\` → relay \`message\`; run tasks per-task serially.

Per-task QA (Stage A + Stage B) is NEVER waived in Epic. Audit (no architect needed): \`/swarm epic status | learning\`.
`;
