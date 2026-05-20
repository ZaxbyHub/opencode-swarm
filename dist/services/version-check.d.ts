interface VersionCheckCache {
    checkedAt: number;
    npmLatest: string | null;
}
export declare function readVersionCache(): VersionCheckCache | null;
/**
 * Compare two semver-ish version strings. Returns 1 if `a > b`, -1 if `a < b`,
 * 0 if equal. Treats prerelease tags as lower than the release. Pure function.
 */
export declare function compareVersions(a: string, b: string): number;
/**
 * Schedule a one-shot, fully detached version check. Returns immediately.
 * Emits a deferred warning via `emitWarning` when a newer version is found.
 *
 * @param runningVersion The version of the currently-loaded plugin.
 * @param emitWarning Callback used to surface the staleness notice.
 * @param now Time source — overridable for tests.
 * @param fetchImpl Fetcher — overridable for tests.
 */
export declare function scheduleVersionCheck(runningVersion: string, emitWarning: (msg: string) => void, options?: {
    now?: () => number;
    fetchImpl?: (signal: AbortSignal) => Promise<string | null>;
}): void;
/**
 * Test-only: reset the in-process latch so a subsequent schedule call runs.
 */
export declare function _resetVersionCheckLatchForTests(): void;
export {};
