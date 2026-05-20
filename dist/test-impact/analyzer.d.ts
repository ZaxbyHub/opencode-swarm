export interface TestImpactResult {
    impactedTests: string[];
    unrelatedTests: string[];
    untestedFiles: string[];
    impactMap: Record<string, string[]>;
    budgetExceeded?: boolean;
}
declare function normalizePath(p: string): string;
declare function isCacheStale(impactMap: Record<string, string[]>, generatedAtMs: number): boolean;
declare function resolveRelativeImport(fromDir: string, importPath: string): string | null;
/**
 * Test-only: clear the go-module memoization cache. Production code
 * should never need this — the cache is per-call-graph scoped, but tests
 * that reuse the same tempDir benefit from a fresh start.
 */
declare function _clearGoModuleCache(): void;
declare function findTestFilesSync(cwd: string): string[];
declare function extractImports(content: string): string[];
declare function buildImpactMapInternal(cwd: string): Promise<Record<string, string[]>>;
export declare const _internals: {
    normalizePath: typeof normalizePath;
    isCacheStale: typeof isCacheStale;
    resolveRelativeImport: typeof resolveRelativeImport;
    findTestFilesSync: typeof findTestFilesSync;
    extractImports: typeof extractImports;
    buildImpactMapInternal: typeof buildImpactMapInternal;
    buildImpactMap: typeof buildImpactMap;
    loadImpactMap: typeof loadImpactMap;
    saveImpactMap: typeof saveImpactMap;
    analyzeImpact: typeof analyzeImpact;
    _clearGoModuleCache: typeof _clearGoModuleCache;
};
export declare function buildImpactMap(cwd: string): Promise<Record<string, string[]>>;
export interface LoadImpactMapOptions {
    /** If true and cache is stale, return the stale map instead of rebuilding.
     *  Use for estimation-only reads where slight staleness is acceptable. */
    skipRebuild?: boolean;
}
export declare function loadImpactMap(cwd: string, options?: LoadImpactMapOptions): Promise<Record<string, string[]>>;
declare function saveImpactMap(cwd: string, impactMap: Record<string, string[]>): Promise<void>;
export declare function analyzeImpact(changedFiles: string[], cwd: string, budget?: number): Promise<TestImpactResult>;
export {};
