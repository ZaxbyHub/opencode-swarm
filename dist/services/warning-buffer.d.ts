/**
 * Bounded buffer for deferred non-critical init warnings.
 * Populated during plugin startup when quiet:true; replayed in /swarm diagnose.
 * Extracted from index.ts so agents/index.ts and diagnose-service.ts can
 * share the buffer without creating a circular dependency.
 * Max 50 entries to prevent memory growth.
 */
export declare const deferredWarnings: string[];
export declare function addDeferredWarning(warning: string): void;
