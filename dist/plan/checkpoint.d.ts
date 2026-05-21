/**
 * Checkpoint artifact writer.
 * Writes SWARM_PLAN.md and SWARM_PLAN.json inside .swarm/.
 * Export-only — not a live runtime source of truth.
 * Called on: save_plan, phase completion, /swarm close.
 * NOT called on every task update.
 */
import * as fs from 'node:fs';
import { type Plan } from '../config/plan-schema';
/**
 * Write SWARM_PLAN.json and SWARM_PLAN.md inside the .swarm/ directory under the project root.
 * Non-blocking: logs a warning on failure but never throws.
 * @param directory - The working directory (project root)
 */
export declare function writeCheckpoint(directory: string): Promise<void>;
/**
 * Result of an importCheckpoint operation.
 */
export interface ImportCheckpointResult {
    success: boolean;
    plan?: Plan;
    error?: string;
}
/**
 * Import a checkpoint from .swarm/SWARM_PLAN.json (with backward-compat fallback to project root).
 * Validates the checkpoint against PlanSchema, persists it as the live plan
 * via savePlan, and appends a 'plan_rebuilt' ledger event.
 *
 * @param directory - The working directory (project root)
 * @param source - Optional source identifier for the ledger event (defaults to 'external_reseed')
 * @returns ImportCheckpointResult indicating success or failure with error message
 */
export declare function importCheckpoint(directory: string, source?: string): Promise<ImportCheckpointResult>;
export declare const _internals: {
    writeCheckpoint: typeof writeCheckpoint;
    importCheckpoint: typeof importCheckpoint;
    existsSyncForCleanup: typeof fs.existsSync;
    unlinkSyncForCleanup: typeof fs.unlinkSync;
};
