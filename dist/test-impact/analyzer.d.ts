export interface TestImpactResult {
    impactedTests: string[];
    unrelatedTests: string[];
    untestedFiles: string[];
    impactMap: Record<string, string[]>;
}
declare function normalizePath(p: string): string;
declare function isCacheStale(impactMap: Record<string, string[]>, generatedAtMs: number): boolean;
declare function resolveRelativeImport(fromDir: string, importPath: string): string | null;
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
};
export declare function buildImpactMap(cwd: string): Promise<Record<string, string[]>>;
export declare function loadImpactMap(cwd: string): Promise<Record<string, string[]>>;
declare function saveImpactMap(cwd: string, impactMap: Record<string, string[]>): Promise<void>;
export declare function analyzeImpact(changedFiles: string[], cwd: string): Promise<TestImpactResult>;
export {};
