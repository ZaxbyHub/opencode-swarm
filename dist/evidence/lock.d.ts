/**
 * Evidence write-lock helper (PR 1 — dark foundation).
 *
 * Wraps every evidence read-modify-write path with a proper-lockfile-backed
 * exclusive lock so that concurrent writers cannot interleave their
 * read-compute-write cycles.  The underlying temp-file-plus-rename atomic
 * write is preserved; this lock adds a coordinating layer on top.
 *
 * Telemetry events emitted:
 *   evidence_lock_acquired   — lock obtained, fn executing
 *   evidence_lock_contended  — lock busy, backing off before retry
 *   evidence_lock_stale_recovered — stale lock detected and recovered by proper-lockfile
 *   (timeout path emits nothing extra; EvidenceLockTimeoutError is thrown instead)
 */
export declare class EvidenceLockTimeoutError extends Error {
    readonly directory: string;
    readonly evidencePath: string;
    readonly agent: string;
    readonly taskId: string;
    constructor(directory: string, evidencePath: string, agent: string, taskId: string, timeoutMs: number);
}
/**
 * Acquire an exclusive evidence lock, execute `fn`, then release the lock.
 *
 * Retries with exponential backoff until `evidenceLockTimeoutMs` elapses,
 * then throws `EvidenceLockTimeoutError`.  Always releases the lock in a
 * `finally` block even if `fn` throws.
 *
 * @param directory    Project root directory
 * @param evidencePath Relative path of the evidence file to lock
 * @param agent        Acquiring agent name (for diagnostics)
 * @param taskId       Task identifier (for diagnostics)
 * @param fn           Callback that performs the read-modify-write
 * @param timeoutMs    Maximum wait time before EvidenceLockTimeoutError (default 60 000)
 */
export declare function withEvidenceLock<T>(directory: string, evidencePath: string, agent: string, taskId: string, fn: () => Promise<T>, timeoutMs?: number): Promise<T>;
