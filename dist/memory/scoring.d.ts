import type { MemoryRecord, MemoryScopeRef, RecallRequest, RecallResultItem } from './types';
export interface RecallScoringDiagnostics {
    candidateCount: number;
    preScoredFilteredCount: number;
    scoredCount: number;
    returnedCount: number;
    noSignalCount: number;
    belowThresholdCount: number;
}
export declare function sameScope(a: MemoryScopeRef, b: MemoryScopeRef): boolean;
export declare function scopeAllowed(recordScope: MemoryScopeRef, allowedScopes: MemoryScopeRef[]): boolean;
export declare function scoreMemoryRecord(record: MemoryRecord, request: RecallRequest): RecallResultItem | null;
export declare function scoreMemoryRecords(records: MemoryRecord[], request: RecallRequest): RecallResultItem[];
export declare function scoreMemoryRecordsWithDiagnostics(records: MemoryRecord[], request: RecallRequest): {
    items: RecallResultItem[];
    diagnostics: RecallScoringDiagnostics;
};
