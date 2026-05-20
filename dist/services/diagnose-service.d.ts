/**
 * A single health check result.
 */
export interface HealthCheck {
    name: string;
    status: '✅' | '❌' | '⚠️' | '⬜';
    detail: string;
}
/**
 * Structured diagnose data returned by the diagnose service.
 */
export interface DiagnoseData {
    checks: HealthCheck[];
    passCount: number;
    totalCount: number;
    allPassed: boolean;
}
/**
 * Resolve the grammar WASM directory from an arbitrary module directory.
 * Exported for unit testing — callers should not pass import.meta.url directly.
 *
 * Rules:
 *   - Dev source  (ends with /src/services): go up one level → src/lang/grammars
 *   - CLI bundle  (ends with /cli):           go up one level → dist/lang/grammars
 *   - Main bundle (everything else):          stay put        → dist/lang/grammars
 */
export declare function resolveGrammarDir(thisDir: string): string;
/**
 * Get diagnose data from the swarm directory.
 * Returns structured health checks for GUI, background flows, or commands.
 */
export declare function getDiagnoseData(directory: string): Promise<DiagnoseData>;
/**
 * Format diagnose data as markdown for command output.
 */
export declare function formatDiagnoseMarkdown(diagnose: DiagnoseData): string;
/**
 * Handle diagnose command - delegates to service and formats output.
 * Kept for backward compatibility - thin adapter.
 */
export declare function handleDiagnoseCommand(directory: string, _args: string[]): Promise<string>;
