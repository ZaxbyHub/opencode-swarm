/**
 * AgentRunContext — typed per-run state container.
 *
 * Holds the subset of swarmState used by run-scoped orchestration:
 *   activeToolCalls, activeAgent, delegationChains, agentSessions,
 *   environmentProfiles, and a shared reference to process-global toolAggregates.
 *
 * The default context preserves existing single-run behavior. Distinct contexts
 * remain available for dispatcher-slot isolation as the standard parallel path
 * grows beyond current task and Stage B gate coordination.
 *
 * Generic type parameters let state.ts bind concrete internal types without
 * creating a circular import.
 */
export class AgentRunContext<
	TToolCall = unknown,
	TToolAgg = unknown,
	TDelegation = unknown,
	TSession = unknown,
	TEnvProfile = unknown,
> {
	readonly runId: string;

	// Per-run isolated maps
	readonly activeToolCalls: Map<string, TToolCall>;
	readonly activeAgent: Map<string, string>;
	readonly delegationChains: Map<string, TDelegation[]>;
	readonly agentSessions: Map<string, TSession>;
	readonly environmentProfiles: Map<string, TEnvProfile>;

	// Process-global reference — intentionally shared across all run contexts
	readonly toolAggregates: Map<string, TToolAgg>;

	constructor(runId: string, toolAggregates: Map<string, TToolAgg>) {
		this.runId = runId;
		this.activeToolCalls = new Map();
		this.activeAgent = new Map();
		this.delegationChains = new Map();
		this.agentSessions = new Map();
		this.environmentProfiles = new Map();
		this.toolAggregates = toolAggregates;
	}
}
