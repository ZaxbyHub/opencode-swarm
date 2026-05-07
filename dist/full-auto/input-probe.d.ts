/**
 * Full-Auto v2 prompt-injection scanner for tool output.
 *
 * The probe inspects the textual content returned by a tool (web_search,
 * webfetch, fetch, doc_extract, search, evidence dumps, etc.) and detects
 * the most common prompt-injection / exfiltration shapes. It is intentionally
 * pattern-based and conservative: false positives produce a warning but do
 * not block work by themselves; an injection warning combined with a
 * subsequent risky action escalates to the critic.
 */
export type FullAutoInputWarningCategory = 'instruction_override' | 'system_role_override' | 'credential_request' | 'exfiltration_request' | 'guardrail_disable_request' | 'curl_pipe_shell' | 'untrusted_run_command';
export interface FullAutoInputWarning {
    category: FullAutoInputWarningCategory;
    matched: string;
    excerpt: string;
}
export interface FullAutoInputProbeResult {
    hasWarning: boolean;
    warnings: FullAutoInputWarning[];
}
export declare function probeFullAutoInput(text: string): FullAutoInputProbeResult;
export declare function shouldEscalateAfterWarning(toolName: string, commandOrUrl: string | undefined): boolean;
