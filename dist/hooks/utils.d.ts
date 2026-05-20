/**
 * Shared hook utilities for OpenCode Swarm
 *
 * This module provides common utilities for working with hooks,
 * including error handling, handler composition, file I/O, and
 * token estimation for swarm-related operations.
 */
/**
 * Test-only dependency-injection seam. Production code calls
 * `_internals.<fn>(...)` so tests can replace the function on this object
 * without touching the real module — `mock.module` from `bun:test` leaks
 * across files in Bun's shared test-runner process, which would corrupt
 * unrelated suites. Mutating this local object is file-scoped and
 * trivially restorable via `afterEach`.
 */
export declare const _internals: {
    safeHook: typeof safeHook;
    composeHandlers: typeof composeHandlers;
    validateSwarmPath: typeof validateSwarmPath;
    readSwarmFileAsync: typeof readSwarmFileAsync;
};
export declare function safeHook<I, O>(fn: (input: I, output: O) => Promise<void>): (input: I, output: O) => Promise<void>;
/**
 * `composeHandlers` runs handlers sequentially, wrapping EACH handler in
 * `safeHook` so any thrown error is downgraded to a warning. Use this for
 * advisory / telemetry / observer hooks where a failure must not block
 * tool execution.
 *
 * **DO NOT use this for fail-closed security or policy hooks.** A fail-closed
 * hook MUST propagate its throws to the host so the tool call is rejected;
 * wrapping it in `safeHook` silently disables the policy. For fail-closed
 * hooks, use `composeBlockingHandlers` (or, as the existing
 * `tool.execute.before` chain in `src/index.ts` does, call them directly
 * with raw `await`).
 *
 * Reference: AGENTS.md invariant 11 + Full-Auto v2 fail-closed contract.
 */
export declare function composeHandlers<I, O>(...fns: Array<(input: I, output: O) => Promise<void>>): (input: I, output: O) => Promise<void>;
/**
 * `composeBlockingHandlers` runs handlers sequentially WITHOUT `safeHook`,
 * so any thrown error propagates to the caller and stops the chain.
 *
 * Use this for fail-closed security / policy hooks at `tool.execute.before`,
 * including:
 *   - guardrails authority enforcement
 *   - scope-guard
 *   - delegation-gate (reviewer gate)
 *   - Full-Auto v2 outbound delegation guard (`createFullAutoDelegationHook`)
 *   - Full-Auto v2 permission policy (`createFullAutoPermissionHook`)
 *
 * Semantic contract:
 *   - Handlers run in registration order.
 *   - The first thrown error stops execution and propagates unchanged.
 *   - Later handlers are NOT called after a throw.
 *   - The host (OpenCode) interprets the propagated throw as a tool
 *     rejection and surfaces it to the calling agent.
 *
 * Companion regression tests live at
 * `tests/unit/hooks/hook-composition.test.ts` to lock this semantics in
 * place — silently swallowing a Full-Auto denial would be a runtime
 * fail-open and is a critical regression.
 */
export declare function composeBlockingHandlers<I, O>(...fns: Array<(input: I, output: O) => Promise<void>>): (input: I, output: O) => Promise<void>;
/**
 * Validates that a filename is safe to use within the .swarm directory
 *
 * @param directory - The base directory containing the .swarm folder
 * @param filename - The filename to validate
 * @returns The resolved absolute path if validation passes
 * @throws Error if the filename is invalid or attempts path traversal
 */
export declare function validateSwarmPath(directory: string, filename: string): string;
export declare function readSwarmFileAsync(directory: string, filename: string): Promise<string | null>;
export declare function estimateTokens(text: string): number;
