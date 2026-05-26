import { type MemoryConfig } from './config';
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
    }) => Pick<MemoryGateway, 'isEnabled' | 'deriveAllowedScopes' | 'recall' | 'propose'> & Partial<Pick<MemoryGateway, 'applyCuratorDecision' | 'dispose'>>;
    appendRunLog?: typeof appendMemoryRunLog;
}
export interface MemoryLifecycleHooks {
    messagesTransform(input: unknown, output: unknown): Promise<void>;
    toolAfter(input: unknown, output: unknown): Promise<void>;
}
export declare function createMemoryLifecycleHooks(options: MemoryLifecycleHookOptions): MemoryLifecycleHooks;
declare function messagesContainRecall(messages: unknown[]): boolean;
declare function compactText(text: string): string;
export type { ProposeMemoryInput, MemoryKind };
export declare const _test_exports: {
    compactText: typeof compactText;
    messagesContainRecall: typeof messagesContainRecall;
};
