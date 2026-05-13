/**
 * AgentRunContext — typed per-run state container.
 *
 * Holds the subset of swarmState needed for future per-run isolation:
 *   activeToolCalls, activeAgent, delegationChains, agentSessions,
 *   environmentProfiles, and a shared reference to process-global toolAggregates.
 *
 * PR 1 (dark foundation): the class exists and is instantiated for the default
 * single-run path only.  No runtime behavior is changed.
 * PR 2 will wire distinct contexts to parallel dispatcher slots.
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
