export interface ParsedCriticResponse {
    verdict: string;
    reasoning: string;
    evidenceChecked: string[];
    antiPatternsDetected: string[];
    escalationNeeded: boolean;
    rawResponse: string;
}
interface ParseCriticResponseOptions {
    validVerdicts?: readonly string[];
    onUnknownVerdict?: (value: string) => void;
}
/**
 * Parses a structured critic response into a `ParsedCriticResponse`.
 *
 * Expected format (one field per line, value may span multiple lines until the next field):
 *   VERDICT: <value>
 *   REASONING: <text>
 *   EVIDENCE_CHECKED: <comma-separated list or "none">
 *   ANTI_PATTERNS_DETECTED: <comma-separated list or "none">
 *   ESCALATION_NEEDED: YES | NO
 *
 * @param rawResponse - The raw text response from the critic agent.
 * @param options.validVerdicts - Override the default verdict allowlist. Unknown verdicts
 *   (those not in this list) default to `NEEDS_REVISION` and trigger `onUnknownVerdict`.
 * @param options.onUnknownVerdict - Called with the raw verdict string when it is not
 *   in `validVerdicts`. Use for logging or metrics. Does not affect parsing outcome.
 */
export declare function parseCriticResponseFields(rawResponse: string, options?: ParseCriticResponseOptions): ParsedCriticResponse;
export {};
