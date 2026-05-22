import type { TestRunRecord } from './history-store.js';
export type FailureClassification = 'new_regression' | 'pre_existing' | 'flaky' | 'unknown';
export interface ClassifiedFailure {
    testFile: string;
    testName: string;
    classification: FailureClassification;
    errorMessage?: string;
    stackPrefix?: string;
    durationMs: number;
    confidence: number;
}
export interface FailureCluster {
    clusterId: string;
    rootCause: string;
    stackPrefix?: string;
    errorMessage?: string;
    failures: ClassifiedFailure[];
    classification: FailureClassification;
    affectedTestFiles: string[];
}
export declare function classifyFailure(currentResult: TestRunRecord, history: TestRunRecord[]): ClassifiedFailure;
export declare function clusterFailures(failures: ClassifiedFailure[]): FailureCluster[];
export declare function classifyAndCluster(testResults: TestRunRecord[], history: TestRunRecord[]): {
    classified: ClassifiedFailure[];
    clusters: FailureCluster[];
};
