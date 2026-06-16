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
	docs_design: ['swarm_memory_recall', 'swarm_memory_propose'],
	designer: ['swarm_memory_recall', 'swarm_memory_propose'],
	curator_init: ['swarm_memory_recall'],
	curator_phase: ['swarm_memory_recall'],
	curator_postmortem: ['swarm_memory_recall'],
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
	researcher: 'opencode/big-pickle',
	critic: 'opencode/big-pickle',
	critic_sounding_board: 'opencode/gpt-5-nano',
	critic_drift_verifier: 'opencode/gpt-5-nano',
	critic_hallucination_verifier: 'opencode/gpt-5-nano',
	critic_oversight: 'opencode/gpt-5-nano',
	// Architecture supervisor is the expensive cross-task reviewer — inherits the
	// critic model at runtime; this entry mirrors that for config/doc completeness.
	critic_architecture_supervisor: 'opencode/big-pickle',
	docs: 'opencode/big-pickle',
	docs_design: 'opencode/big-pickle',
	designer: 'opencode/big-pickle',

	// Curator agents — lightweight read-only analysis (same model family as explorer)
	curator_init: 'opencode/gpt-5-nano',
	curator_phase: 'opencode/gpt-5-nano',
	curator_postmortem: 'opencode/gpt-5-nano',

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
	researcher: {
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
	docs_design: {
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
	curator_postmortem: {
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

export const AUTO_PROCEED_BANNER = `## ⏭️ AUTO-PROCEED STATUS

Auto-proceed controls whether the architect advances to the next phase automatically (skipping the "Ready for Phase N+1?" confirmation).

Behavioral rules:
- Session override (set via /swarm auto-proceed on|off) wins over the plan default.
- If neither is set, auto-proceed defaults to OFF and the architect asks before advancing.
- Full-auto mode (critic oversight) is independent — it has its own auto-advance mechanism.
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
	worktree_isolation: false,
	merge_strategy: 'merge' as const,
	worktree_dir: undefined,
};

export const DEFAULT_WORKTREE_ISOLATION_CONFIG: WorktreeIsolationConfig = {
	policy: 'auto',
	merge_strategy: 'merge',
	worktree_dir: undefined,
	deps_strategy: 'skip',
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
