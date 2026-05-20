/**
 * Submit Council Verdicts — architect-only tool.
 *
 * Accepts pre-collected parallel verdicts from critic, reviewer, sme,
 * test_engineer, and explorer, then synthesizes them into a veto-aware
 * overall verdict with required fixes and a single unified feedback document.
 *
 * PREREQUISITE: The architect must dispatch each council member as a separate
 * Agent task and collect the resulting CouncilMemberVerdict objects BEFORE
 * calling this tool. This tool performs synthesis only — it does NOT dispatch,
 * invoke, or contact council members.
 *
 * Config-gated (council.enabled must be true) and architect-only via
 * AGENT_TOOL_MAP. Follows the check-gate-status.ts pattern.
 */
import type { tool } from '@opencode-ai/plugin';
import { z } from 'zod';
export declare const ArgsSchema: z.ZodObject<{
    taskId: z.ZodString;
    swarmId: z.ZodString;
    roundNumber: z.ZodDefault<z.ZodNumber>;
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
    working_directory: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const submit_council_verdicts: ReturnType<typeof tool>;
