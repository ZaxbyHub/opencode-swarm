import { validateProjectRoot } from '../evidence/manager.js';
export type TestRunResult = 'pass' | 'fail' | 'skip';
export interface TestRunRecord {
    timestamp: string;
    taskId: string;
    testFile: string;
    testName: string;
    result: TestRunResult;
    durationMs: number;
    errorMessage?: string;
    stackPrefix?: string;
    changedFiles: string[];
}
export declare function batchAppendTestRuns(records: TestRunRecord[], workingDir?: string): void;
export declare function appendTestRun(record: TestRunRecord, workingDir?: string): void;
export declare function getTestHistory(testFile: string, workingDir?: string): TestRunRecord[];
export declare function getAllHistory(workingDir?: string): TestRunRecord[];
/**
 * DI seam for testability. Contains functions that tests may override.
 */
export declare const _internals: {
    validateProjectRoot: typeof validateProjectRoot;
};
