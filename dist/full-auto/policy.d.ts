export type FullAutoActionTier = 'safe' | 'local' | 'medium' | 'high';
export type FullAutoDecision = {
    action: 'allow';
    reason: string;
    tier: 'safe' | 'local';
} | {
    action: 'deny';
    reason: string;
    code: string;
    recoverable: boolean;
} | {
    action: 'escalate_critic';
    reason: string;
    risk: 'medium' | 'high';
    context: Record<string, unknown>;
} | {
    action: 'escalate_human';
    reason: string;
    code: string;
} | {
    action: 'pause';
    reason: string;
    code: string;
};
export interface FullAutoPolicyConfig {
    enabled?: boolean;
    mode?: 'assisted' | 'supervised' | 'strict';
    permission_policy?: {
        enabled?: boolean;
        trusted_roots?: string[];
        trusted_domains?: string[];
        protected_paths?: string[];
        allow_defaults?: boolean;
    };
    oversight?: {
        on_high_risk_action?: boolean;
        on_task_completion?: boolean;
    };
}
export interface FullAutoClassifierInput {
    sessionID: string;
    agentName?: string;
    normalizedAgentName?: string;
    toolName: string;
    args: Record<string, unknown> | undefined;
    directory: string;
    workingDirectory?: string;
    declaredScope?: string[] | null;
    currentTaskID?: string | null;
    currentPhase?: number;
    planSummary?: string;
    changedFiles?: string[];
    fullAutoConfig: FullAutoPolicyConfig | undefined;
}
export declare function isReadOnlyTool(toolName: string): boolean;
export declare function isWriteLikeTool(toolName: string): boolean;
export declare function isSubagentDelegation(toolName: string, args: Record<string, unknown> | undefined): boolean;
export declare function isProtectedPath(filePath: string, config: FullAutoPolicyConfig | undefined): boolean;
export declare function classifyPathRisk(filePath: string, context: {
    directory: string;
    declaredScope?: string[] | null;
}): {
    withinProjectRoot: boolean;
    withinDeclaredScope: boolean | null;
    protected: boolean;
    highRiskBuild: boolean;
};
export declare function classifyCommandRisk(command: string, _cwd: string, _context: {
    directory: string;
}): {
    decision: 'allow' | 'deny' | 'escalate_critic';
    reason: string;
};
export declare function classifyFullAutoToolAction(input: FullAutoClassifierInput): FullAutoDecision;
export interface StructuredDenial {
    full_auto_denial: true;
    tool?: string;
    code: string;
    reason: string;
    recoverable: boolean;
    guidance: string;
}
export declare function buildStructuredDenial(decision: Extract<FullAutoDecision, {
    action: 'deny';
}>, tool?: string): StructuredDenial;
