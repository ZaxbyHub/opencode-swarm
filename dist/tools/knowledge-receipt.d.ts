/**
 * knowledge_receipt — the strong successor to knowledge_ack.
 *
 * An agent files a single receipt summarizing how it considered the knowledge
 * surfaced by a retrieval (referenced by `trace_id`): which entries were
 * applied, which were ignored (with a reason), which were contradicted by
 * current evidence (with a proposed remediation), and any new lessons learned.
 *
 * Each applied/ignored/contradicted item becomes one immutable event in
 * `.swarm/knowledge-events.jsonl`. New lessons are persisted through the normal
 * knowledge_add validation/dedup path. When a retrieval surfaced nothing
 * relevant, the receipt can set `no_relevant_knowledge: true` — the point is to
 * force explicit consideration, not fake usage.
 */
import { createSwarmTool } from './create-tool.js';
export declare const knowledge_receipt: ReturnType<typeof createSwarmTool>;
export declare const _internals: {
    knowledge_receipt: typeof knowledge_receipt;
};
