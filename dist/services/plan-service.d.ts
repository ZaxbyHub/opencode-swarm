import { readSwarmFileAsync } from '../hooks/utils';
import { derivePlanMarkdown, loadPlanJsonOnly } from '../plan/manager';
/**
 * Test-only dependency-injection seam. Production code calls
 * `_internals.loadPlanJsonOnly(...)`, `_internals.derivePlanMarkdown(...)`,
 * and `_internals.readSwarmFileAsync(...)` so tests can replace the
 * functions on this object without touching the real module — `mock.module`
 * from `bun:test` leaks across files in Bun's shared test-runner process,
 * which would corrupt unrelated suites. Mutating this local object is
 * file-scoped and trivially restorable via `afterEach`.
 */
export declare const _internals: {
    loadPlanJsonOnly: typeof loadPlanJsonOnly;
    derivePlanMarkdown: typeof derivePlanMarkdown;
    readSwarmFileAsync: typeof readSwarmFileAsync;
};
/**
 * Structured plan data for a specific phase or full plan.
 */
export interface PlanData {
    hasPlan: boolean;
    fullMarkdown: string;
    requestedPhase: number | null;
    phaseMarkdown: string | null;
    errorMessage: string | null;
    isLegacy: boolean;
}
/**
 * Get plan data from the swarm directory.
 * Returns structured data for GUI, background flows, or commands.
 */
export declare function getPlanData(directory: string, phaseArg?: string | number): Promise<PlanData>;
/**
 * Format plan data as markdown for command output.
 */
export declare function formatPlanMarkdown(planData: PlanData): string;
/**
 * Handle plan command - delegates to service and formats output.
 * Kept for backward compatibility - thin adapter.
 */
export declare function handlePlanCommand(directory: string, args: string[]): Promise<string>;
