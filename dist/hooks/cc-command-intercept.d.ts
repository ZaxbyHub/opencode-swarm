/**
 * CC Command Intercept Hook
 *
 * Runtime message pipeline hook that detects bare Claude Code commands in agent
 * messages and performs safe interventions:
 *  - CRITICAL destructive (/reset, /clear): hard-blocks via output mutation
 *  - CRITICAL non-destructive (/plan): soft-corrects to /swarm plan
 *  - HIGH severity: advisory log only, no text modification
 *
 * Designed for <5ms execution on 10k-token messages via simple regex/string ops.
 * Idempotent: skips text already annotated with [CC_COMMAND_INTERCEPT].
 */
import { type ConflictSeverity } from '../commands/conflict-registry';
export interface CcInterceptConfig {
    /** Severities to process (default: ['CRITICAL', 'HIGH']) */
    intercept: ConflictSeverity[];
    /** Whether to hard-block CRITICAL destructive commands (default: true) */
    blockDestructive: boolean;
    /** Whether to log intercept events (default: true) */
    logIntercepts: boolean;
}
interface MessageWithParts {
    info: {
        role: string;
        agent?: string;
        sessionID?: string;
        [key: string]: unknown;
    };
    parts: Array<{
        type: string;
        text?: string;
        [key: string]: unknown;
    }>;
}
/**
 * Creates a messagesTransform hook that intercepts bare CC commands.
 *
 * @param config - Optional configuration overrides
 * @returns Hook object with messagesTransform function
 */
export declare function createCcCommandInterceptHook(config?: Partial<CcInterceptConfig>): {
    messagesTransform: (input: Record<string, never>, output: {
        messages?: MessageWithParts[];
    }) => Promise<void>;
};
export {};
