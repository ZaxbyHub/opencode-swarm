/**
 * Context Capsule Injection Hook
 *
 * Intercepts architect-to-agent delegations and injects a role-specific
 * Context Capsule into the delegated agent's system message. The capsule
 * provides file summaries, read policies, and task context so the agent
 * can begin work with focused, relevant context.
 *
 * This hook is part of the Context Map feature (issue #1104, FR-005).
 * It is **opt-in** — disabled by default. Enable via config:
 *
 *   context_map: { enabled: true }
 *
 * Uses the `_internals` DI seam pattern so tests can override external
 * dependencies without `mock.module` (which leaks across files in Bun's
 * shared test-runner process).
 *
 * All functions accept an explicit `directory` parameter (Invariant 4).
 * No `process.cwd()` usage. Never throws — wraps everything in try/catch.
 * No `bun:` imports — Node-ESM-loadable (Invariant 2).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { PluginConfig } from '../config/index.js';
import { buildCapsule } from '../context-map/capsule-builder.js';
import { saveCapsule } from '../context-map/capsule-persistence.js';
import type { TelemetryEntry } from '../context-map/telemetry.js';
import { recordTelemetry } from '../context-map/telemetry.js';
import type { AgentSessionState } from '../state.js';
import { swarmState } from '../state.js';
import type {
	AgentRole,
	CapsuleDelegationReason,
} from '../types/context-capsule.js';

// ---------------------------------------------------------------------------
// Delegation reason resolution
// ---------------------------------------------------------------------------

/**
 * Map session state to a CapsuleDelegationReason.
 *
 * Infers the delegation reason from the agent role and task workflow state.
 * Uses `taskWorkflowStates` to detect whether this is a re-delegation after
 * a reviewer rejection or test failure. Falls back to 'new_task' for
 * initial delegations where the task is still at 'idle' or 'coder_delegated'.
 *
 * Note: `lastDelegationReason` is not used because the delegation tracker
 * overwrites it to 'normal_delegation' before this hook runs.
 * `lastGateFailure` is not used because it tracks automated tool failures,
 * not agent rejection — its tool name is always the automated tool (diff,
 * lint, pre_check_batch), never 'reviewer' or 'test_engineer'.
 */
function resolveCapsuleDelegationReason(
	session: AgentSessionState | undefined,
	agentRole: string,
	taskId: string,
): CapsuleDelegationReason {
	// Critics always get critic_plan_review
	if (agentRole === 'critic') return 'critic_plan_review';

	if (!session) return 'new_task';

	// Infer from task workflow state — if the task has already progressed
	// past coder_delegated, this is a re-delegation after a gate failure
	const workflowState = session.taskWorkflowStates?.get(taskId);
	if (workflowState === 'tests_run') return 'test_failure_fix';
	if (workflowState === 'reviewer_run') return 'reviewer_rejection_fix';

	return 'new_task';
}

// ---------------------------------------------------------------------------
// Task goal extraction
// ---------------------------------------------------------------------------

/**
 * Extract the task description (goal) from plan.json for a given task ID.
 *
 * Reads `.swarm/plan.json` synchronously and searches the phases[].tasks[]
 * array for a matching task ID. Returns the task description, or '' if not
 * found or on any error. Never throws.
 */
function extractTaskGoal(taskId: string, directory: string): string {
	try {
		const planPath = path.join(directory, '.swarm', 'plan.json');
		const raw = fs.readFileSync(planPath, 'utf-8');
		const plan = JSON.parse(raw) as {
			phases?: Array<{
				tasks?: Array<{ id?: string; description?: string }>;
			}>;
		};
		if (!Array.isArray(plan.phases)) return '';
		for (const phase of plan.phases) {
			if (!Array.isArray(phase.tasks)) continue;
			for (const task of phase.tasks) {
				if (task.id === taskId && typeof task.description === 'string') {
					return task.description;
				}
			}
		}
		return '';
	} catch {
		return '';
	}
}

// ---------------------------------------------------------------------------
// DI seam — tests override these without touching real modules
// ---------------------------------------------------------------------------

/**
 * Test-only dependency-injection seam. Production code calls through this
 * object so tests can replace the underlying implementations without
 * `mock.module`. Mutating this object is file-scoped and trivially
 * restorable via `afterEach`.
 */
export const _internals = {
	buildCapsule,
	recordTelemetry,
	saveCapsule,
	getActiveAgent: (sessionID: string): string | undefined =>
		swarmState.activeAgent.get(sessionID),
	getSession: (sessionID: string): AgentSessionState | undefined =>
		swarmState.agentSessions.get(sessionID),
	getCurrentTaskId: (sessionID: string): string | null => {
		const session = swarmState.agentSessions.get(sessionID);
		return session?.currentTaskId ?? null;
	},
	readScopeFile: (taskId: string, dir: string): string[] => {
		try {
			const scopePath = path.join(
				dir,
				'.swarm',
				'scopes',
				`scope-${taskId}.json`,
			);
			const raw = fs.readFileSync(scopePath, 'utf-8');
			const parsed = JSON.parse(raw) as { files?: string[] };
			return Array.isArray(parsed.files) ? parsed.files : [];
		} catch {
			return [];
		}
	},
	resolveCapsuleDelegationReason,
	extractTaskGoal,
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** OpenCode native agents that should never receive capsule injection. */
const OPENCODE_NATIVE_AGENTS = new Set([
	'build',
	'plan',
	'general',
	'explore',
	'compaction',
	'title',
	'summary',
] as const);

/** Valid agent roles for capsule generation. */
const VALID_AGENT_ROLES = new Set<string>([
	'coder',
	'reviewer',
	'critic',
	'test_engineer',
	'sme',
]);

// ---------------------------------------------------------------------------
// Role extraction
// ---------------------------------------------------------------------------

/**
 * Extract a canonical agent role from a potentially prefixed agent name.
 *
 * Matches against known capsule-compatible roles by checking if the agent
 * name equals or ends with a valid role (preceded by underscore). This
 * correctly handles compound role names like "test_engineer".
 *
 * Returns `undefined` if the agent is an architect, an OpenCode native agent,
 * or an unrecognized role.
 */
function extractCapsuleRole(agentName: string): string | undefined {
	const normalized = agentName.toLowerCase();

	// Skip architects and OpenCode native agents
	if (
		normalized === 'architect' ||
		OPENCODE_NATIVE_AGENTS.has(normalized as never)
	) {
		return undefined;
	}

	// Try matching against known roles (handles compound names like test_engineer)
	for (const role of VALID_AGENT_ROLES) {
		if (normalized === role || normalized.endsWith(`_${role}`)) {
			return role;
		}
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Hook factory
// ---------------------------------------------------------------------------

/**
 * Creates the context capsule injection hook.
 *
 * When `context_map.enabled === true`, this hook intercepts system message
 * transforms for delegated agent sessions and injects a role-specific
 * Context Capsule containing file summaries and read policies.
 *
 * When disabled (the default), returns an empty hook object — zero overhead.
 */
export function createContextCapsuleInjectHook(
	config: PluginConfig,
	directory: string,
): Record<string, unknown> {
	const enabled = config.context_map?.enabled === true;

	if (!enabled) {
		return {};
	}

	return {
		'experimental.chat.system.transform': async (
			_input: { sessionID?: string },
			output: { system: string[] },
		): Promise<void> => {
			try {
				await injectCapsule(_input, output, config, directory);
			} catch {
				// Hook must never throw — swallow all errors silently
			}
		},
	};
}

// ---------------------------------------------------------------------------
// Injection logic
// ---------------------------------------------------------------------------

async function injectCapsule(
	input: { sessionID?: string },
	output: { system: string[] },
	config: PluginConfig,
	directory: string,
): Promise<void> {
	const sessionID = input.sessionID;
	if (!sessionID) return;

	// Resolve active agent for this session
	const agentName = _internals.getActiveAgent(sessionID);
	if (!agentName) return;

	// Extract a capsule-compatible role — skip if unrecognized or architect
	const role = extractCapsuleRole(agentName);
	if (!role) return;

	// Get current task ID from session state
	const taskId = _internals.getCurrentTaskId(sessionID);
	const effectiveTaskId = taskId ?? 'unknown';

	// Get file scope from the scope file
	const files = _internals.readScopeFile(effectiveTaskId, directory);
	if (files.length === 0) return;

	// Build the capsule
	const maxTokens = config.context_map?.max_capsule_tokens;
	const delegationReason = _internals.resolveCapsuleDelegationReason(
		_internals.getSession(sessionID),
		role,
		effectiveTaskId,
	);
	const taskGoal = _internals.extractTaskGoal(effectiveTaskId, directory);
	const { capsule, metadata } = _internals.buildCapsule({
		task_id: effectiveTaskId,
		agent_role: role as AgentRole,
		delegation_reason: delegationReason,
		files_in_scope: files,
		task_goal: taskGoal,
		directory,
		max_capsule_tokens: maxTokens,
		mode: config.context_map?.mode,
		invalidate_on_hash_change: config.context_map?.invalidate_on_hash_change,
		agent_profiles: config.context_map?.agent_profiles,
	});

	// Only inject if capsule has meaningful content
	if (!capsule.content.trim()) return;

	output.system.push(capsule.content);

	// Persist capsule for debugging/inspection
	try {
		_internals.saveCapsule(capsule, directory);
	} catch {
		// Persistence failure must never break the hook
	}

	// Record telemetry — never throws on failure
	const telemetryEntry: TelemetryEntry = {
		timestamp: new Date().toISOString(),
		task_id: effectiveTaskId,
		agent_role: role,
		delegation_reason: capsule.delegation_reason,
		token_estimate: metadata.token_estimate,
		cache_hits: metadata.cache_hits,
		cache_misses: metadata.cache_misses,
		stale_entries: metadata.stale_entries,
		recommended_reads: metadata.recommended_reads.length,
		skipped_reads: metadata.skipped_reads.length,
		success: metadata.success,
	};

	try {
		_internals.recordTelemetry(telemetryEntry, directory);
	} catch {
		// Telemetry failure must never break the hook
	}
}
