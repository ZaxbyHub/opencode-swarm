import { z } from 'zod';
import type { CuratorMemoryDecision, ProposeMemoryInput } from '../memory';
export declare const AgentOutputMemorySchema: z.ZodObject<{
    memoryProposals: z.ZodOptional<z.ZodArray<z.ZodObject<{
        operation: z.ZodEnum<{
            ignore: "ignore";
            add: "add";
            delete: "delete";
            update: "update";
            merge: "merge";
            supersede: "supersede";
        }>;
        kind: z.ZodOptional<z.ZodEnum<{
            evidence: "evidence";
            todo: "todo";
            user_preference: "user_preference";
            project_fact: "project_fact";
            architecture_decision: "architecture_decision";
            repo_convention: "repo_convention";
            api_finding: "api_finding";
            code_pattern: "code_pattern";
            test_pattern: "test_pattern";
            failure_pattern: "failure_pattern";
            security_note: "security_note";
            scratch: "scratch";
        }>>;
        text: z.ZodOptional<z.ZodString>;
        targetMemoryId: z.ZodOptional<z.ZodString>;
        relatedMemoryIds: z.ZodOptional<z.ZodArray<z.ZodString>>;
        rationale: z.ZodString;
        evidenceRefs: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$strict>>>;
}, z.core.$loose>;
export declare const CuratorOutputMemoryDecisionSchema: z.ZodObject<{
    curatorMemoryDecisions: z.ZodOptional<z.ZodArray<z.ZodType<CuratorMemoryDecision, unknown, z.core.$ZodTypeInternals<CuratorMemoryDecision, unknown>>>>;
}, z.core.$loose>;
export interface ExtractedAgentMemoryProposals {
    proposals: ProposeMemoryInput[];
    error?: string;
}
export interface ExtractedCuratorMemoryDecisions {
    decisions: CuratorMemoryDecision[];
    error?: string;
}
export declare function extractMemoryProposalsFromAgentOutput(outputText: string): ExtractedAgentMemoryProposals;
export declare function extractCuratorMemoryDecisionsFromAgentOutput(outputText: string): ExtractedCuratorMemoryDecisions;
