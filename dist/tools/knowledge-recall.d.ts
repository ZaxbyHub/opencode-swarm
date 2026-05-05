import { createSwarmTool } from './create-tool.js';
export declare const knowledge_recall: ReturnType<typeof createSwarmTool>;
/**
 * DI seam for testability. Contains all test-mocked exports.
 * Internal calls should use _internals.fn() instead of fn() directly.
 */
export declare const _internals: {
    knowledge_recall: typeof knowledge_recall;
};
