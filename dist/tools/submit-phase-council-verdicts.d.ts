import type { tool } from '@opencode-ai/plugin';
import { z } from 'zod';
export declare const ArgsSchema: z.ZodObject<{
    phaseNumber: z.ZodNumber;
    swarmId: z.ZodString;
    phaseSummary: z.ZodString;
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
    working_directory: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const submit_phase_council_verdicts: ReturnType<typeof tool>;
