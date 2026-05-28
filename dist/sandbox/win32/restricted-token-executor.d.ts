/**
 * Backwards-compatibility re-export.
 *
 * The implementation has moved to restricted-environment-executor.ts to
 * clarify that this is environment scrubbing, not real token restriction.
 * The native sandbox runner (swarm-sandbox-runner.exe) provides true
 * OS-level isolation via runner-client.ts.
 */
export { _internals, WindowsSandboxExecutor, } from './restricted-environment-executor';
