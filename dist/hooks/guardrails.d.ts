/**
 * Guardrails Hook Module
 *
 * Circuit breaker for runaway LLM agents. Monitors tool usage via OpenCode Plugin API hooks
 * and implements two-layer protection:
 * - Layer 1 (Soft Warning @ warning_threshold): Sets warning flag for messagesTransform to inject warning
 * - Layer 2 (Hard Block @ 100%): Throws error in toolBefore to block further calls, injects STOP message
 */
import * as path from 'node:path';
import { type AuthorityConfig, type GuardrailsConfig } from '../config/schema';
import { type FileZone } from '../context/zone-classifier';
/**
 * Issue #853 Layer B: tools that are structurally blocked while
 * `.swarm/spec-staleness.json` exists. Every blocked tool mutates plan
 * state (save_plan, update_task_status, phase_complete) or proceeds with
 * lean-turbo execution (lean_turbo_run_phase, lean_turbo_acquire_locks).
 * The architect must run /swarm clarify or /swarm acknowledge-spec-drift
 * before any of these will succeed.
 *
 * Read tools (get_approved_plan, lint_spec, set_qa_gates, convene_*,
 * lean_turbo_plan_lanes, lean_turbo_runner_status, lean_turbo_review) are
 * intentionally NOT blocked — drift surfacing should not block exploration.
 */
export declare const SPEC_DRIFT_BLOCKED_TOOLS: Set<string>;
/**
 * Throw SPEC_DRIFT_BLOCK if the tool is on the block-list and the
 * spec-staleness marker file exists. Layer B is structural (not a
 * retryable error) — deterministic disk read every call, no cache, so
 * /swarm acknowledge-spec-drift (which removes the marker) is reflected
 * immediately on the next tool call.
 */
export declare function enforceSpecDriftGate(directory: string | undefined, toolName: string): void;
/**
 * Retrieves stored input args for a given callID.
 * Used by other hooks (e.g., delegation-gate) to access tool input args.
 * @param callID The callID to look up
 * @returns The stored args or undefined if not found
 */
export declare function getStoredInputArgs(callID: string): unknown | undefined;
/**
 * Stores input args for a given callID.
 * Used by guardrails toolBefore hook; may be used by other hooks if needed.
 * @param callID The callID to store args under
 * @param args The tool input args to store
 */
export declare function setStoredInputArgs(callID: string, args: unknown): void;
/**
 * Deletes stored input args for a given callID (cleanup after retrieval).
 * @param callID The callID to delete
 */
export declare function deleteStoredInputArgs(callID: string): void;
/**
 * Redacts sensitive values from a shell command string before audit logging.
 * Covers env-var assignments, CLI flags, Bearer/Basic auth, and -H header flags.
 * Conservative: only redacts patterns with well-known secret-bearing names.
 * Export allows unit testing without spinning up a full hooks factory.
 */
export declare function redactShellCommand(cmd: string): string;
/**
 * Creates guardrails hooks for circuit breaker protection
 * @param directory Working directory from plugin init context (required)
 * @param directoryOrConfig Guardrails configuration object (when passed as second arg, replaces legacy config param)
 * @param config Guardrails configuration (optional)
 * @returns Tool before/after hooks and messages transform hook
 */
export declare function createGuardrailsHooks(directory: string, directoryOrConfig?: string | GuardrailsConfig, config?: GuardrailsConfig, authorityConfig?: AuthorityConfig): {
    toolBefore: (input: {
        tool: string;
        sessionID: string;
        callID: string;
    }, output: {
        args: unknown;
    }) => Promise<void>;
    toolAfter: (input: {
        tool: string;
        sessionID: string;
        callID: string;
        args?: Record<string, unknown>;
    }, output: {
        title: string;
        output: string;
        metadata: unknown;
    }) => Promise<void>;
    messagesTransform: (input: Record<string, never>, output: {
        messages?: Array<{
            info: {
                role: string;
                agent?: string;
                sessionID?: string;
            };
            parts: Array<{
                type: string;
                text?: string;
                [key: string]: unknown;
            }>;
        }>;
    }) => Promise<void>;
};
/**
 * Hashes tool arguments for repetition detection
 * @param args Tool arguments to hash
 * @returns Numeric hash (0 if hashing fails)
 */
export declare function hashArgs(args: unknown): number;
/** A record of an agent attesting to (resolving/suppressing/deferring) a finding. */
export interface AttestationRecord {
    findingId: string;
    agent: string;
    attestation: string;
    action: 'resolve' | 'suppress' | 'defer';
    timestamp: string;
}
/**
 * Validates that an attestation string meets the minimum length requirement.
 */
export declare function validateAttestation(attestation: string, _findingId: string, _agent: string, _action: 'resolve' | 'suppress' | 'defer'): {
    valid: true;
} | {
    valid: false;
    reason: string;
};
/**
 * Appends an attestation record to `.swarm/evidence/attestations.jsonl`.
 */
export declare function recordAttestation(dir: string, record: AttestationRecord): Promise<void>;
/**
 * Validates an attestation and, on success, records it; on failure, logs a rejection event.
 */
export declare function validateAndRecordAttestation(dir: string, findingId: string, agent: string, attestation: string, action: 'resolve' | 'suppress' | 'defer'): Promise<{
    valid: true;
} | {
    valid: false;
    reason: string;
}>;
/**
 * Clears all guardrails caches.
 * Use this for test isolation or when guardrails config reloads at runtime.
 */
export declare function clearGuardrailsCaches(): void;
type AgentRule = {
    readOnly?: boolean;
    blockedExact?: string[];
    allowedExact?: string[];
    blockedPrefix?: string[];
    allowedPrefix?: string[];
    blockedZones?: FileZone[];
    blockedGlobs?: string[];
    allowedGlobs?: string[];
};
export declare const DEFAULT_AGENT_AUTHORITY_RULES: Record<string, AgentRule>;
/**
 * Checks whether a write target path (or any ancestor strictly inside cwd)
 * is a symlink. Writing through a symlink can redirect the write to a
 * location outside the working directory, bypassing scope containment.
 *
 * The walk stops at cwd — cwd itself is NOT lstat'd. A user's chosen
 * working directory may legitimately be reached via a symlink (e.g.,
 * macOS's /tmp → /private/tmp), and that symlink does not constitute a
 * redirect *within* the workspace. Only attacker-plantable symlinks
 * BELOW cwd are relevant to this guard.
 *
 * ENOENT on any node in the chain is allowed — the file/dir doesn't exist yet.
 * Any other lstat error (EPERM, EACCES, ENAMETOOLONG, …) fails closed:
 * an unverifiable ancestor must not be written through, even if the OS
 * would eventually reject the write. Defense-in-depth over optimism.
 *
 * @returns A block reason string if a symlink is detected, null if all clear.
 */
export declare function checkWriteTargetForSymlink(targetPath: string, cwd: string): string | null;
/**
 * Returns true when `targetAbsolute` and `cwdAbsolute` resolve to different
 * filesystem roots. On POSIX this is always false (single root `/`); on
 * Windows it is true when the two paths sit on different drive letters or
 * different UNC roots — the symptom Codex flagged on PR #501, where
 * `path.relative('C:\\repo', 'D:\\secret.txt')` returns the absolute
 * `'D:\\secret.txt'` and slips past `startsWith('../')` containment.
 *
 * Exposed (and accepts an injectable `pathLib`) so the cross-drive guard
 * is falsifiable on Linux CI without depending on a Windows runner: tests
 * pass `path.win32` / `path.posix` directly.
 */
export declare function isOnDifferentFilesystemRoot(targetAbsolute: string, cwdAbsolute: string, pathLib?: Pick<typeof path, 'parse'>): boolean;
/**
 * Checks whether the given agent is authorised to write to the given file path.
 */
export declare function checkFileAuthority(agentName: string, filePath: string, cwd: string, authorityConfig?: AuthorityConfig, options?: {
    declaredScope?: string[] | null;
}): {
    allowed: true;
} | {
    allowed: false;
    reason: string;
    zone?: FileZone;
};
export {};
