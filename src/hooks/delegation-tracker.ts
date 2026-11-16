/**
 * Delegation Tracker Hook
 *
 * Tracks agent delegation by monitoring chat.message events with agent fields.
 * Updates the active agent map and optionally logs delegation chain entries.
 */

import { ORCHESTRATOR_NAME } from '../config/constants';
import type { PluginConfig } from '../config/schema';
import { stripKnownSwarmPrefix } from '../config/schema';
import type { DelegationEntry } from '../state';
import {
	beginInvocation,
	ensureAgentSession,
	getPrimaryOwner,
	recordPhaseAgentDispatch,
	recordPrimaryOwner,
	swarmState,
	updateAgentEventTime,
} from '../state';

export type { DelegationReason } from '../state';

/**
 * Creates the chat.message hook for delegation tracking.
 *
 * `directory` (issue #2667) is the plugin instance's project root captured at
 * hook construction — chat.message inputs carry no directory. Sessions created
 * here are ownership-stamped for that project so another project's hydration
 * can never evict them.
 */
export function createDelegationTrackerHook(
	config: PluginConfig,
	guardrailsEnabled = true,
	directory?: string,
): (
	input: { sessionID: string; agent?: string },
	output: Record<string, unknown>,
) => Promise<void> {
	return async (
		input: { sessionID: string; agent?: string },
		_output: Record<string, unknown>,
	): Promise<void> => {
		const now = Date.now();

		// If no agent is specified, the session's PRIMARY owner is taking over on
		// a new turn. That is the architect for swarm sessions (the historical
		// default and the identity-stuck repair pinned by
		// tests/integration/architect-identity-stuck.test.ts) and the recorded
		// native agent (build/plan/general) for non-swarm sessions (#3320).
		// This is also a verified invocation boundary: fatal non-transient stops
		// belong to the prior turn and must not poison the corrected turn.
		if (!input.agent || input.agent === '') {
			// #3320 review round (PRR-005): with auto_select_architect enabled an
			// agent-less turn IS the default (architect) agent taking over — a
			// PRIMARY-owner observation per the issue's AC11. Without this re-arm
			// a single native turn would pin the owner to that native agent
			// forever in this mode (the agent-less branch only reads the record).
			const autoSelect = config.auto_select_architect;
			if (
				autoSelect === true ||
				(typeof autoSelect === 'string' && autoSelect.trim() !== '')
			) {
				recordPrimaryOwner(input.sessionID, ORCHESTRATOR_NAME);
			}
			const owner = getPrimaryOwner(input.sessionID) ?? ORCHESTRATOR_NAME;
			const session = ensureAgentSession(input.sessionID, owner, directory);
			session.delegationActive = false;
			swarmState.activeAgent.set(input.sessionID, owner);
			updateAgentEventTime(input.sessionID);
			if (guardrailsEnabled) {
				beginInvocation(input.sessionID, owner);
			}
			return;
		}

		const agentName = input.agent;

		// #3320: a named agent taking the session is a PRIMARY-owner observation
		// when it is the architect or a non-swarm agent (the recorder ignores
		// swarm subagent names on its own).
		recordPrimaryOwner(input.sessionID, agentName);

		// Get the previous agent for this session
		const previousAgent = swarmState.activeAgent.get(input.sessionID);

		// Update the active agent
		swarmState.activeAgent.set(input.sessionID, agentName);

		// Determine if this is an architect (after stripping prefix)
		// Architect-prefixed names like "mega_architect" are treated as architect
		const strippedAgent = stripKnownSwarmPrefix(agentName);
		const isArchitect = strippedAgent === ORCHESTRATOR_NAME;

		// Ensure guardrail session exists with correct agent name
		// This prevents the race condition where tool.execute.before fires
		// before chat.message, causing sessions to be created with 'unknown'
		const session = ensureAgentSession(input.sessionID, agentName, directory);

		// Set delegationActive: false for architect, true for subagents
		// This ensures stale detection works correctly for both cases
		session.delegationActive = !isArchitect;
		if (!isArchitect) {
			session.lastDelegationReason = 'normal_delegation';
		}

		// Record agent dispatch for phase completion tracking
		recordPhaseAgentDispatch(input.sessionID, agentName);

		// Start a new invocation boundary for every agent. Architect remains
		// budget-unlimited (beginInvocation returns null), but still needs fresh
		// non-transient circuit and tool-correlation state for a corrected turn.
		// CRITICAL: Always call beginInvocation, even if same agent as previous
		// (handles architect → coder → architect → coder re-invocation pattern)
		if (guardrailsEnabled) {
			beginInvocation(input.sessionID, agentName);
		}

		const delegationTrackerEnabled = config?.hooks?.delegation_tracker === true;
		const delegationGateEnabled = config?.hooks?.delegation_gate !== false;

		// If delegation tracking is enabled and agent has changed, log the delegation
		if (
			(delegationTrackerEnabled || delegationGateEnabled) &&
			previousAgent &&
			previousAgent !== agentName
		) {
			// Create a delegation entry
			const entry: DelegationEntry = {
				from: previousAgent,
				to: agentName,
				timestamp: now,
			};

			// Get or create the delegation chain for this session
			if (!swarmState.delegationChains.has(input.sessionID)) {
				swarmState.delegationChains.set(input.sessionID, []);
			}

			// Push the entry to the chain
			const chain = swarmState.delegationChains.get(input.sessionID);
			chain?.push(entry);

			// Increment pending events counter (only when explicit tracking is enabled)
			if (delegationTrackerEnabled) {
				swarmState.pendingEvents++;
			}
		}
	};
}
