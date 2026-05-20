import type { Plan } from '../config/plan-schema';
/**
 * Computes SHA-256 hex hash of `.swarm/spec.md` content in the given directory.
 * Returns null if the file does not exist (does NOT throw).
 */
export declare function computeSpecHash(directory: string): Promise<string | null>;
/**
 * Determines if the spec file has changed since the plan was saved.
 * Plans created before this feature (no specHash) are exempt from staleness checks.
 */
export declare function isSpecStale(directory: string, plan: Plan): Promise<{
    stale: boolean;
    reason?: string;
    currentHash?: string | null;
}>;
/**
 * DI seam for testability. Contains all test-mocked exports.
 * Internal calls should use _internals.fn() instead of fn() directly.
 */
export declare const _internals: {
    computeSpecHash: typeof computeSpecHash;
    isSpecStale: typeof isSpecStale;
};
