/**
 * Write final council evidence for the project-scoped final council gate.
 *
 * The final council is not General Council mode. It accepts the same
 * five-member CouncilMemberVerdict objects used by phase council, synthesized
 * at completed-project scope.
 */
import type { ToolDefinition } from '@opencode-ai/plugin/tool';
import { z } from 'zod';
import { loadPluginConfig } from '../config/loader';
import { synthesizeFinalCouncilAdvisory } from '../council/council-service';
import type { CouncilMemberVerdict } from '../council/types';
import { validateSwarmPath } from '../hooks/utils';
import { loadPlan } from '../plan/manager.js';
import { derivePlanId } from '../plan/utils.js';
export declare const ArgsSchema: z.ZodObject<{
    phase: z.ZodNumber;
    projectSummary: z.ZodString;
    roundNumber: z.ZodOptional<z.ZodNumber>;
    verdicts: z.ZodArray<z.ZodObject<{
        agent: z.ZodEnum<{
            reviewer: "reviewer";
            test_engineer: "test_engineer";
            explorer: "explorer";
            sme: "sme";
            critic: "critic";
        }>;
        verdict: z.ZodEnum<{
            APPROVE: "APPROVE";
            REJECT: "REJECT";
            CONCERNS: "CONCERNS";
        }>;
        confidence: z.ZodNumber;
        findings: z.ZodArray<z.ZodObject<{
            severity: z.ZodEnum<{
                HIGH: "HIGH";
                MEDIUM: "MEDIUM";
                LOW: "LOW";
            }>;
            category: z.ZodString;
            location: z.ZodString;
            detail: z.ZodString;
            evidence: z.ZodString;
        }, z.core.$strip>>;
        criteriaAssessed: z.ZodArray<z.ZodString>;
        criteriaUnmet: z.ZodArray<z.ZodString>;
        durationMs: z.ZodNumber;
    }, z.core.$strip>>;
}, z.core.$strip>;
/**
 * Arguments for the write_final_council_evidence tool.
 */
export interface WriteFinalCouncilEvidenceArgs {
    /** The phase number for the final council verdict */
    phase: number;
    /** Summary of the completed project being reviewed */
    projectSummary: string;
    /** 1-indexed final council round number */
    roundNumber?: number;
    /** Collected verdicts from critic, reviewer, sme, test_engineer, explorer */
    verdicts: CouncilMemberVerdict[];
}
export declare const _internals: {
    loadPluginConfig: typeof loadPluginConfig;
    synthesizeFinalCouncilAdvisory: typeof synthesizeFinalCouncilAdvisory;
    loadPlan: typeof loadPlan;
    derivePlanId: typeof derivePlanId;
    validateSwarmPath: typeof validateSwarmPath;
};
/**
 * Execute the write_final_council_evidence tool.
 * Validates input, synthesizes project-scoped council evidence, and writes it.
 */
export declare function executeWriteFinalCouncilEvidence(args: unknown, directory: string): Promise<string>;
/**
 * Tool definition for write_final_council_evidence.
 */
export declare const write_final_council_evidence: ToolDefinition;
