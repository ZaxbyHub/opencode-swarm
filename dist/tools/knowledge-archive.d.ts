/**
 * knowledge_archive — archival-by-default removal with audit tombstones.
 *
 * Unlike knowledge_remove (which hard-deletes a swarm entry), this tool defaults
 * to a reversible status transition and always appends an immutable `archived`
 * event to `.swarm/knowledge-events.jsonl` recording the actor, reason, evidence,
 * and previous status.
 *
 * Modes:
 *  - 'archive'    (default): set status='archived' — TTL-exempt, hidden from recall.
 *  - 'quarantine':           set status='quarantined' — suspected-bad, hidden from recall.
 *  - 'purge':                hard-delete the JSONL line. Requires allow_purge:true.
 */
import { createSwarmTool } from './create-tool.js';
export declare const knowledge_archive: ReturnType<typeof createSwarmTool>;
export declare const _internals: {
    knowledge_archive: typeof knowledge_archive;
};
