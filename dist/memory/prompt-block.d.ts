import type { RecallBundle, RecallResultItem } from './types';
export declare function buildRecallPromptBlock(items: RecallResultItem[], tokenBudget: number): {
    promptBlock: string;
    tokenEstimate: number;
    items: RecallResultItem[];
};
export declare function toRecallBundle(input: {
    id: string;
    query: string;
    generatedAt: string;
    items: RecallResultItem[];
    tokenBudget: number;
}): RecallBundle;
