/**
 * Full-Auto Intercept Hook
 *
 * Intercepts architect messages in full-auto mode and triggers autonomous oversight
 * when the architect outputs escalation patterns (questions, phase completion prompts).
 *
 * This hook runs as a chat.message transform — it inspects the architect's output
 * and injects the critic's autonomous oversight response when escalation is detected.
 */
import type { PluginConfig } from '../config';
import { type ParsedCriticResponse } from '../full-auto/critic-response-parser';
interface MessageWithParts {
    info: {
        role: string;
        agent?: string;
        sessionID?: string;
        [key: string]: unknown;
    };
    parts: Array<{
        type: string;
        text?: string;
        [key: string]: unknown;
    }>;
}
/**
 * Result from critic dispatch — used to inject verdict into message stream.
 */
interface CriticDispatchResult extends ParsedCriticResponse {
}
/**
 * Parses the critic's structured text response into a CriticDispatchResult.
 * The critic response format is:
 *   VERDICT: APPROVED | NEEDS_REVISION | ...
 *   REASONING: [text with possible multi-line content]
 *   EVIDENCE_CHECKED: [list]
 *   ANTI_PATTERNS_DETECTED: [list or "none"]
 *   ESCALATION_NEEDED: YES | NO
 */
export declare function parseCriticResponse(rawResponse: string): CriticDispatchResult;
/**
 * Injects the critic's verdict as an assistant message after the architect's message.
 * This makes the verdict visible in the chat without modifying the architect's output.
 *
 * Verdict handling:
 * - ANSWER: injects critic's reasoning as the assistant's answer
 * - ESCALATE_TO_HUMAN: triggers escalation (handled separately)
 * - APPROVED / NEEDS_REVISION / REJECTED / BLOCKED / REPHRASE: injects verdict message
 */
export declare function injectVerdictIntoMessages(messages: MessageWithParts[], architectIndex: number, criticResult: CriticDispatchResult, escalationType: 'phase_completion' | 'question', oversightAgentName: string): void;
/**
 * Handles critic dispatch and writes the auto_oversight event after the critic responds.
 *
 * This function encapsulates the critic invocation and event writing flow.
 * The critic response is awaited before writing the event to events.jsonl.
 */
export declare function dispatchCriticAndWriteEvent(directory: string, architectOutput: string, criticContext: string, criticModel: string, escalationType: 'phase_completion' | 'question', interactionCount: number, deadlockCount: number, oversightAgentName: string, sessionID?: string): Promise<CriticDispatchResult>;
/**
 * Creates the full-auto intercept hook factory.
 *
 * This hook intercepts architect messages in full-auto mode and triggers
 * autonomous oversight when escalation patterns are detected.
 *
 * @param config - Plugin configuration containing full_auto settings
 * @param directory - Working directory from plugin init context
 * @returns Hook object with messagesTransform function
 */
export declare function createFullAutoInterceptHook(config: PluginConfig, directory: string): {
    messagesTransform: (input: Record<string, never>, output: {
        messages?: MessageWithParts[];
    }) => Promise<void>;
};
export {};
