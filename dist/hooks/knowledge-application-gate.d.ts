/**
 * Runtime wiring for the knowledge application contract.
 *
 * Two integration points:
 *
 *   1. `experimental.chat.messages.transform` — scans the latest
 *      architect-authored message for `KNOWLEDGE_APPLIED|IGNORED|VIOLATED`
 *      markers and records them via `recordAcknowledgmentDeduped`. This
 *      runs BEFORE the architect's next tool call so the toolBefore gate
 *      sees the ack.
 *
 *   2. `tool.execute.before` (FAIL-CLOSED chain at src/index.ts) — when a
 *      high-risk tool fires and the calling agent is the architect,
 *      consults `swarmState.currentCriticalShownIds` and the audit log to
 *      assemble the set of critical directives that have been shown but
 *      not acknowledged. In `mode: 'enforce'` it THROWS to block the
 *      action (per the FAIL-CLOSED contract — `output.error` is NOT a
 *      write API at toolBefore time). In `mode: 'warn'` it appends to
 *      `events.jsonl` and lets the action proceed.
 *
 * Tools considered high-risk:
 *   - save_plan
 *   - update_task_status
 *   - phase_complete
 *   - Task (delegations to coder/reviewer/test_engineer/sme/docs/designer)
 *
 * Non-architect agents are never gated.
 */
import { type KnowledgeApplicationConfig } from './knowledge-application.js';
import type { MessageWithParts } from './knowledge-types.js';
/** Tools that require knowledge-directive acknowledgment before execution. */
export declare const HIGH_RISK_TOOLS: Set<string>;
export interface GateInput {
    tool: unknown;
    agent?: unknown;
    sessionID?: unknown;
}
/**
 * Pre-tool gate. Throws when the architect attempts a high-risk action with
 * an unacknowledged critical directive in `enforce` mode. Always returns in
 * `warn` mode (with a side-effect events.jsonl write).
 */
export declare function knowledgeApplicationGateBefore(directory: string, input: GateInput, config: KnowledgeApplicationConfig): Promise<void>;
declare function writeWarnEvent(directory: string, record: Record<string, unknown>): Promise<void>;
/**
 * Compose into `experimental.chat.messages.transform`. Scans the most recent
 * `role: 'user'`-shaped architect message for ack markers (per
 * `full-auto-intercept.ts` pattern: architect outputs appear as user role)
 * and records each via `recordAcknowledgmentDeduped`. Best-effort: never
 * throws; never mutates the messages array.
 */
export declare function knowledgeApplicationTransformScan(directory: string, output: {
    messages?: MessageWithParts[];
}, sessionID?: string): Promise<void>;
export declare const _internals: {
    knowledgeApplicationGateBefore: typeof knowledgeApplicationGateBefore;
    knowledgeApplicationTransformScan: typeof knowledgeApplicationTransformScan;
    HIGH_RISK_TOOLS: Set<string>;
    writeWarnEvent: typeof writeWarnEvent;
};
export {};
