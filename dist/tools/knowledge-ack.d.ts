/**
 * knowledge_ack — Architect-facing tool to record an explicit acknowledgment
 * outcome for an injected knowledge directive.
 *
 * The same outcome can also be expressed inline in chat with markers like
 *   KNOWLEDGE_APPLIED: <id>
 *   KNOWLEDGE_IGNORED: <id> reason=<reason>
 * but this tool gives a deterministic, auditable surface that doesn't depend
 * on chat-text scanning.
 */
import { createSwarmTool } from './create-tool.js';
export declare const knowledge_ack: ReturnType<typeof createSwarmTool>;
export declare const _internals: {
    knowledge_ack: typeof knowledge_ack;
};
