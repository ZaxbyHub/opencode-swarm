import { type MemoryRecallProfile } from './role-profiles';
import type { MemoryKind, MemoryScopeRef } from './types';
export interface MemoryRecallPlannerInput {
    userGoal: string;
    runId: string;
    agentRole: string;
    agentId: string;
    agentTask: string;
    projectId?: string;
    repoId?: string;
    repoRoot?: string;
    touchedFiles?: string[];
    currentPlanSummary?: string;
}
export interface MemoryRecallPlan {
    query: string;
    scopes: MemoryScopeRef[];
    kinds: MemoryKind[];
    maxItems: number;
    tokenBudget: number;
}
export interface BuildMemoryRecallPlanOptions {
    scopes?: MemoryScopeRef[];
    profile?: MemoryRecallProfile;
}
export declare function buildMemoryRecallPlan(input: MemoryRecallPlannerInput, options?: BuildMemoryRecallPlanOptions): MemoryRecallPlan;
