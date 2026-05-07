/**
 * Full-Auto v2 pre-tool permission hook.
 *
 * Runs in `tool.execute.before` AFTER guardrails / scope-guard / delegation-gate
 * so it adds an additional decision layer rather than replacing those checks.
 *
 * Behavior:
 *   - If Full-Auto is not enabled in the resolved config, no-op.
 *   - If the durable run-state is `paused` or `terminated`, block any
 *     write-like, shell, network, plan-mutation, phase-completion, or
 *     subagent-delegation tool with a clear message instructing the user to
 *     re-enable Full-Auto.
 *   - Otherwise classify the tool action via `classifyFullAutoToolAction`:
 *       * allow            — increment counters and continue.
 *       * deny             — record denial; throw a structured denial error so
 *                            the agent receives a recoverable signal.
 *       * escalate_critic  — call the shared oversight dispatcher; allow if
 *                            APPROVED/ANSWER, deny if NEEDS_REVISION/REJECTED/
 *                            BLOCKED, terminate if ESCALATE_TO_HUMAN.
 *       * escalate_human   — terminate Full-Auto run.
 *       * pause            — pause Full-Auto run and block.
 *
 *   - When a denial is recorded, also evaluate denial thresholds and pause
 *     or terminate per `full_auto.denials.on_limit`.
 */
import type { PluginConfig } from '../config';
export interface FullAutoPermissionHookOptions {
    config: PluginConfig;
    directory: string;
}
export declare function createFullAutoPermissionHook(options: FullAutoPermissionHookOptions): {
    toolBefore: (input: {
        tool: string;
        sessionID: string;
        callID: string;
    }, output: {
        args: unknown;
    }) => Promise<void>;
};
