/**
 * Skill-improver daily-quota tracker.
 *
 * State file: .swarm/skill-improver-quota.json
 * Counts every LLM-credentialed call by the skill_improver agent.
 * The window is configurable: 'utc' (default) resets at 00:00 UTC; 'local'
 * resets at the host's local midnight.
 */
export type QuotaWindow = 'utc' | 'local';
export interface QuotaState {
    /** YYYY-MM-DD in the chosen window */
    date: string;
    calls_used: number;
    max_calls: number;
    last_run_at?: string;
    window: QuotaWindow;
}
export declare function resolveQuotaPath(directory: string): string;
export declare function todayKey(window: QuotaWindow, now?: Date): string;
export interface QuotaCheckOptions {
    maxCalls: number;
    window: QuotaWindow;
    now?: Date;
}
export interface QuotaCheckResult {
    allowed: boolean;
    state: QuotaState;
    reason?: string;
}
/** Read the quota state, rolling over the day if needed. Does not increment. */
export declare function getQuotaState(directory: string, opts: QuotaCheckOptions): Promise<QuotaState>;
/**
 * Atomically reserve `nCalls` quota slots, holding a directory-level lockfile
 * for the read-modify-write so parallel skill_improve invocations cannot
 * lost-update each other. Returns { allowed: false } and leaves state
 * unchanged if the reservation would exceed max_calls.
 */
export declare function reserveQuota(directory: string, opts: QuotaCheckOptions & {
    nCalls: number;
}): Promise<QuotaCheckResult>;
/**
 * Release `nCalls` previously-reserved quota slots. Floors at zero. Used by
 * the skill_improver service when an LLM call fails BEFORE any network I/O
 * (e.g. delegate construction error, no client wired). Once network I/O has
 * begun, the slot stays consumed — see runSkillImprover for the policy.
 */
export declare function releaseQuota(directory: string, opts: QuotaCheckOptions & {
    nCalls: number;
}): Promise<QuotaState>;
export declare const _internals: {
    resolveQuotaPath: typeof resolveQuotaPath;
    todayKey: typeof todayKey;
    getQuotaState: typeof getQuotaState;
    reserveQuota: typeof reserveQuota;
    releaseQuota: typeof releaseQuota;
    LOCK_ACQUIRE_TIMEOUT_MS: number;
};
