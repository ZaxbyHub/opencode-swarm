import type { MemoryRecord, MemoryScopeRef, RecallRequest, RecallResultItem } from './types';
export declare function sameScope(a: MemoryScopeRef, b: MemoryScopeRef): boolean;
export declare function scopeAllowed(recordScope: MemoryScopeRef, allowedScopes: MemoryScopeRef[]): boolean;
export declare function scoreMemoryRecord(record: MemoryRecord, request: RecallRequest): RecallResultItem | null;
export declare function scoreMemoryRecords(records: MemoryRecord[], request: RecallRequest): RecallResultItem[];
