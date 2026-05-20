/**
 * Check gate status tool - read-only tool for querying task gate status.
 * Reads .swarm/evidence/{taskId}.json and returns structured JSON describing
 * which gates have passed, which are missing, and overall task status.
 */
import type { tool } from '@opencode-ai/plugin';
export declare const check_gate_status: ReturnType<typeof tool>;
