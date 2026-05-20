/**
 * Caller identification for spec-drift acknowledgment audit trail.
 * Previously hardcoded as 'architect' — see issue #890, where the architect
 * could shell out to `bunx opencode-swarm run acknowledge-spec-drift` and
 * the resulting event mis-attributed the action. Callers now pass an
 * explicit actor so events.jsonl can distinguish the legitimate paths
 * ('user' from chat slash command, 'cli' from a real terminal) from any
 * unidentified caller ('unknown'). The Bash guardrail
 * (`src/hooks/guardrails.ts` section 23) blocks the agent-shell bypass at
 * the runtime layer; this parameter exists for forensic clarity.
 */
export type SpecDriftAcknowledgedBy = 'user' | 'cli' | 'unknown';
/**
 * Handle /swarm acknowledge-spec-drift command
 * Acknowledges and clears a previously detected spec drift staleness warning
 */
export declare function handleAcknowledgeSpecDriftCommand(directory: string, _args: string[], acknowledgedBy?: SpecDriftAcknowledgedBy): Promise<string>;
