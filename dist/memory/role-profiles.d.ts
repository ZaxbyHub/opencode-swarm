import type { MemoryKind } from './types';
export interface MemoryRecallProfile {
    kinds: MemoryKind[];
    maxItems: number;
    tokenBudget: number;
}
export declare const MEMORY_RECALL_PROFILES: {
    readonly architect: {
        readonly kinds: ["project_fact", "architecture_decision", "repo_convention", "failure_pattern", "security_note"];
        readonly maxItems: 10;
        readonly tokenBudget: 1600;
    };
    readonly sme: {
        readonly kinds: ["api_finding", "code_pattern", "repo_convention", "failure_pattern", "evidence"];
        readonly maxItems: 8;
        readonly tokenBudget: 1200;
    };
    readonly coder: {
        readonly kinds: ["architecture_decision", "repo_convention", "code_pattern", "test_pattern", "failure_pattern"];
        readonly maxItems: 8;
        readonly tokenBudget: 1200;
    };
    readonly qa: {
        readonly kinds: ["test_pattern", "failure_pattern", "repo_convention", "security_note"];
        readonly maxItems: 8;
        readonly tokenBudget: 1200;
    };
    readonly security: {
        readonly kinds: ["security_note", "architecture_decision", "repo_convention", "evidence"];
        readonly maxItems: 8;
        readonly tokenBudget: 1200;
    };
    readonly curator: {
        readonly kinds: ["project_fact", "architecture_decision", "repo_convention", "api_finding", "code_pattern", "test_pattern", "failure_pattern", "security_note", "evidence"];
        readonly maxItems: 20;
        readonly tokenBudget: 3000;
    };
};
export type MemoryRecallProfileName = keyof typeof MEMORY_RECALL_PROFILES;
export declare function resolveMemoryRecallProfile(agentRole: string | undefined): MemoryRecallProfile;
export declare function normalizeMemoryAgentRole(agentRole: string | undefined): MemoryRecallProfileName;
