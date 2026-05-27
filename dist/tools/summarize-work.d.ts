/**
 * summarize_work — agents call this at task completion to emit a short structured
 * summary of what they did (issue #893). Stored as a `note` evidence entry; rolled up
 * per-phase and reviewed by the architecture-supervisor critic. Advisory: never blocks.
 */
import type { tool } from '@opencode-ai/plugin';
export declare const summarize_work: ReturnType<typeof tool>;
