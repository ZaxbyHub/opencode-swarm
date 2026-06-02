import type { DocDriftReport } from './curator-types.js';
/** Return mtime in ms for a path, or null if it does not exist / cannot stat. */
declare function mtimeMsOrNull(absPath: string): number | null;
/**
 * Resolve a project-relative anchor path safely under `directory`. Returns null
 * if the anchor escapes the project root (defense against `..`/absolute paths
 * in a hand-edited traceability.json).
 */
declare function resolveAnchorWithin(directory: string, anchor: string): string | null;
/**
 * Run the deterministic design-doc drift check for a phase.
 *
 * @param directory  project root
 * @param phase      phase number
 * @param outDir     design-doc output directory (project-relative, e.g. "docs")
 * @returns the written DocDriftReport, or null if the check failed (fail-open).
 */
export declare function runDesignDocDriftCheck(directory: string, phase: number, outDir: string): Promise<DocDriftReport | null>;
export declare const _internals: {
    mtimeMsOrNull: typeof mtimeMsOrNull;
    resolveAnchorWithin: typeof resolveAnchorWithin;
    DESIGN_DOC_FILES: Record<string, string>;
};
export {};
