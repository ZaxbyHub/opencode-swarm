import type { tool } from '@opencode-ai/plugin';
interface CompletedTask {
    taskId: string;
    taskName: string;
}
export declare function parseCompletedTasks(planContent: string): CompletedTask[];
export declare const evidence_check: ReturnType<typeof tool>;
export {};
