import type { MemoryConfig } from './config';
import type { MemoryGateway, ProposeMemoryInput } from './gateway';
import { appendMemoryRunLog } from './run-log';
import type { MemoryKind } from './types';
export interface MemoryLifecycleHookOptions {
    directory: string;
    config?: Partial<MemoryConfig>;
    getActiveAgentName?: (sessionID: string | undefined) => string | undefined;
    createGateway?: (context: {
        directory: string;
        sessionID?: string;
        agentRole?: string;
        agentId?: string;
        runId?: string;
    }, options: {
        config?: Partial<MemoryConfig>;
    }) => Pick<MemoryGateway, 'isEnabled' | 'deriveAllowedScopes' | 'recall' | 'propose'>;
    appendRunLog?: typeof appendMemoryRunLog;
}
export interface MemoryLifecycleHooks {
    messagesTransform(input: unknown, output: unknown): Promise<void>;
    toolAfter(input: unknown, output: unknown): Promise<void>;
}
export declare function createMemoryLifecycleHooks(options: MemoryLifecycleHookOptions): MemoryLifecycleHooks;
export type { ProposeMemoryInput, MemoryKind };
